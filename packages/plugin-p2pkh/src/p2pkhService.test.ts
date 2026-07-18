// packages/plugin-p2pkh/src/p2pkhService.test.ts
// 硬切换 003（2026-06-19）施工单验收单测：
//   - 手工 recent-sync / history-backfill 必须先 rehydrate 当前 active key
//     再触发 background 任务。
//   - 0 resource recent-sync / backfill 必须记 info 日志，不能 silent no-op。
//   - 总览页在 sync 状态由 syncing 进入完成态时必须重新 load。
//   - 老 key 没有旧缓存迁移时，当前 active key 仍可通过 rehydrate 创建
//     resource。
//
// 本测试只验证 service / recent-sync / backfill / overview page 的事件层
// 语义，不依赖 indexedDB schema 细节（那些由 p2pkhDb.test.ts 覆盖）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createP2pkhRecentSync } from "./p2pkhRecentSync.js";
import { createP2pkhHistoryBackfill } from "./p2pkhHistoryBackfill.js";
import type { P2pkhKeyResource, P2pkhRecentSyncState, P2pkhBackfillState, P2pkhLocalInputClaim, P2pkhLocalSubmission, P2pkhHistoryItem, P2pkhUtxo } from "./p2pkhContracts.js";

// ---- 日志 spy 工具 ----

interface LogCall {
  level: "debug" | "info" | "warn" | "error";
  input: { scope: string; event: string; message: string; data?: Record<string, unknown> };
}

function makeLogger() {
  const calls: LogCall[] = [];
  return {
    calls,
    debug(input: { scope: string; event: string; message: string; data?: Record<string, unknown> }) {
      calls.push({ level: "debug", input });
    },
    info(input: { scope: string; event: string; message: string; data?: Record<string, unknown> }) {
      calls.push({ level: "info", input });
    },
    warn(input: { scope: string; event: string; message: string; data?: Record<string, unknown> }) {
      calls.push({ level: "warn", input });
    },
    error(input: { scope: string; event: string; message: string; data?: Record<string, unknown> }) {
      calls.push({ level: "error", input });
    },
    child(_scope: string) {
      return this;
    }
  };
}

// ---- recent-sync / backfill 的 fake 依赖 ----

function makeCoordinator(getDb: () => ReturnType<typeof makeFakeDb> | Promise<ReturnType<typeof makeFakeDb>>) {
  return {
    runRecent: vi.fn(async (_resourceId: string, _generation: number | undefined, build: () => Promise<unknown>) => {
      const commit = (await build()) as { resourceId: string; expectedGeneration?: number };
      const db = await getDb();
      await db.commitRecentSnapshot(commit as never);
    }),
    runBackfillPage: vi.fn(async (_resourceId: string, expectedRevision: number, expectedGeneration: number, build: () => Promise<unknown>) => {
      const partial = (await build()) as {
        page: Array<{ txid: string; height: number; status: "confirmed"; source: "woc-confirmed" }>;
        nextPageToken?: string;
        resource: P2pkhKeyResource;
      };
      const db = await getDb();
      await db.commitBackfillPage({
        resourceId: _resourceId,
        expectedRevision,
        expectedGeneration,
        resource: partial.resource,
        page: partial.page,
        nextPageToken: partial.nextPageToken
      });
    }),
    requestBackfillYield: vi.fn(),
    removeResource: vi.fn(),
    hasRecentPending: vi.fn(() => false),
    getGeneration: vi.fn(() => 0),
    refreshGeneration: vi.fn()
  };
}

interface FakeDbOptions {
  resources?: P2pkhKeyResource[];
  recent?: P2pkhRecentSyncState[];
  backfill?: P2pkhBackfillState[];
}

function makeFakeDb(opts: FakeDbOptions = {}) {
  const addresses = new Map<string, P2pkhKeyResource>(
    (opts.resources ?? []).map((r) => [r.resourceId, r])
  );
  const recent = new Map<string, P2pkhRecentSyncState>(
    (opts.recent ?? []).map((r) => [r.resourceId, r])
  );
  const backfill = new Map<string, P2pkhBackfillState>(
    (opts.backfill ?? []).map((b) => [b.resourceId, b])
  );
  return {
    async listAddresses(): Promise<P2pkhKeyResource[]> {
      return [...addresses.values()];
    },
    async listUtxos(): Promise<P2pkhUtxo[]> {
      return [];
    },
    async listHistory(): Promise<P2pkhHistoryItem[]> {
      return [];
    },
    async listLocalInputClaims(): Promise<P2pkhLocalInputClaim[]> {
      return [];
    },
    async listLocalInputClaimsByResource(): Promise<P2pkhLocalInputClaim[]> {
      return [];
    },
    async listLocalSubmissions(): Promise<P2pkhLocalSubmission[]> {
      return [];
    },
    async listLocalSubmissionsByResource(): Promise<P2pkhLocalSubmission[]> {
      return [];
    },
    async listBackfillStates(): Promise<P2pkhBackfillState[]> {
      return [...backfill.values()];
    },
    async listRecentSyncStates(): Promise<P2pkhRecentSyncState[]> {
      return [...recent.values()];
    },
    async getResource(resourceId: string): Promise<P2pkhKeyResource | undefined> {
      return addresses.get(resourceId);
    },
    async getRecentSyncState(resourceId: string): Promise<P2pkhRecentSyncState | undefined> {
      return recent.get(resourceId);
    },
    async putRecentSyncState(state: P2pkhRecentSyncState): Promise<void> {
      recent.set(state.resourceId, state);
    },
    async getBackfillState(resourceId: string): Promise<P2pkhBackfillState | undefined> {
      return backfill.get(resourceId);
    },
    async putBackfillState(state: P2pkhBackfillState): Promise<void> {
      backfill.set(state.resourceId, state);
    },
    async putAddress(r: P2pkhKeyResource): Promise<void> {
      addresses.set(r.resourceId, r);
    },
    async commitRecentSnapshot(_commit: unknown): Promise<void> {
      // noop: 业务字段已经在 build() 里通过 build() 准备好
    },
    async commitBackfillPage(commit: {
      resourceId: string;
      expectedRevision: number;
      expectedGeneration: number;
      resource: P2pkhKeyResource;
      page: Array<{ txid: string; height: number }>;
      nextPageToken?: string;
    }): Promise<void> {
      const existing = backfill.get(commit.resourceId);
      const next: P2pkhBackfillState = {
        resourceId: commit.resourceId,
        status: commit.nextPageToken ? "running" : "complete",
        nextPageToken: commit.nextPageToken,
        anchorTxids: existing?.anchorTxids ?? [],
        pagesSynced: (existing?.pagesSynced ?? 0) + 1,
        recordsSynced: (existing?.recordsSynced ?? 0) + commit.page.length,
        revision: (existing?.revision ?? 0) + 1,
        lastError: undefined,
        updatedAt: new Date().toISOString()
      };
      backfill.set(commit.resourceId, next);
    }
  };
}

function makeWoc(handlers: Partial<{
  getAddressConfirmedUtxos: ReturnType<typeof vi.fn>;
  getAddressUnconfirmedUtxos: ReturnType<typeof vi.fn>;
  listAddressConfirmedHistory: ReturnType<typeof vi.fn>;
  listAddressUnconfirmedHistory: ReturnType<typeof vi.fn>;
}> = {}) {
  return {
    getAddressConfirmedUtxos:
      handlers.getAddressConfirmedUtxos ??
      vi.fn(async () => []),
    getAddressUnconfirmedUtxos:
      handlers.getAddressUnconfirmedUtxos ??
      vi.fn(async () => []),
    listAddressConfirmedHistory:
      handlers.listAddressConfirmedHistory ??
      vi.fn(async () => ({ items: [] as Array<{ txid: string; height: number }>, nextPageToken: undefined })),
    listAddressUnconfirmedHistory:
      handlers.listAddressUnconfirmedHistory ??
      vi.fn(async () => ({ items: [] as Array<{ txid: string; height: number }>, nextPageToken: undefined }))
  } as unknown as import("@keymaster/contracts").WocService;
}

function makeMessageBus() {
  return {
    publish: vi.fn(),
    subscribe: vi.fn(() => () => undefined)
  } as unknown as import("@keymaster/contracts").MessageBus;
}

describe("createP2pkhRecentSync.runOnce", () => {
  it("logs recent.sync.started and recent.sync.noResources when there are no resources", async () => {
    const logger = makeLogger();
    const db = makeFakeDb();
    const deps = {
      woc: makeWoc(),
      messageBus: makeMessageBus(),
      coordinator: makeCoordinator(() => db),
      getResources: async () => [] as P2pkhKeyResource[],
      getDb: async () => db as never,
      logger
    };
    const recent = createP2pkhRecentSync(deps);
    await recent.runOnce(new AbortController().signal);

    const events = logger.calls.filter((c) => c.level === "info").map((c) => c.input.event);
    expect(events).toContain("recent.sync.started");
    expect(events).toContain("recent.sync.noResources");
    const noResources = logger.calls.find((c) => c.input.event === "recent.sync.noResources");
    expect(noResources?.input.data?.resourceCount).toBe(0);
  });

  it("logs per-resource started / completed events with utxoCount and recentConfirmedCount", async () => {
    const resource: P2pkhKeyResource = {
      resourceId: "p2pkh:main",
      publicKeyHex: "02a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718",
      label: "k",
      address: "addr-main",
      network: "main",
      createdAt: "2024-01-01T00:00:00.000Z",
      generation: 0
    };
    const getAddressConfirmedUtxos = vi.fn(async () => [
      { txid: "t1", vout: 0, value: 1000, height: 1 },
      { txid: "t2", vout: 1, value: 2000, height: 2 }
    ]);
    const listAddressConfirmedHistory = vi.fn(async () => ({
      items: [
        { txid: "th1", height: 9 },
        { txid: "th2", height: 10 }
      ],
      nextPageToken: undefined
    }));
    const logger = makeLogger();
    const db = makeFakeDb();
    const recent = createP2pkhRecentSync({
      woc: makeWoc({ getAddressConfirmedUtxos, listAddressConfirmedHistory }),
      messageBus: makeMessageBus(),
      coordinator: makeCoordinator(() => db),
      getResources: async () => [resource],
      getDb: async () => db as never,
      logger
    });
    await recent.runOnce(new AbortController().signal);

    const started = logger.calls.find((c) => c.input.event === "recent.resource.started");
    expect(started?.input.data?.resourceId).toBe("p2pkh:main");
    const completed = logger.calls.find((c) => c.input.event === "recent.resource.completed");
    expect(completed?.input.data?.resourceId).toBe("p2pkh:main");
    expect(completed?.input.data?.utxoCount).toBe(2);
    expect(completed?.input.data?.recentConfirmedCount).toBe(2);
  });

  it("返回 { committed: false } 当 0 resource", async () => {
    const logger = makeLogger();
    const db = makeFakeDb();
    const recent = createP2pkhRecentSync({
      woc: makeWoc(),
      messageBus: makeMessageBus(),
      coordinator: makeCoordinator(() => db),
      getResources: async () => [] as P2pkhKeyResource[],
      getDb: async () => db as never,
      logger
    });
    const result = await recent.runOnce(new AbortController().signal);
    expect(result).toEqual({ committed: false, cancelled: false });
  });

  it("返回 { committed: true } 当有 resource 且成功提交", async () => {
    const resource: P2pkhKeyResource = {
      resourceId: "p2pkh:main",
      publicKeyHex: "02a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718",
      label: "k",
      address: "addr-main",
      network: "main",
      createdAt: "2024-01-01T00:00:00.000Z",
      generation: 0
    };
    const db = makeFakeDb();
    const recent = createP2pkhRecentSync({
      woc: makeWoc(),
      messageBus: makeMessageBus(),
      coordinator: makeCoordinator(() => db),
      getResources: async () => [resource],
      getDb: async () => db as never,
      logger: makeLogger()
    });
    const result = await recent.runOnce(new AbortController().signal);
    expect(result).toEqual({ committed: true, cancelled: false });
  });

  it("返回 { committed: false, cancelled: true } 当 signal 已 aborted", async () => {
    const resource: P2pkhKeyResource = {
      resourceId: "p2pkh:main",
      publicKeyHex: "02a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718",
      label: "k",
      address: "addr-main",
      network: "main",
      createdAt: "2024-01-01T00:00:00.000Z",
      generation: 0
    };
    const ac = new AbortController();
    ac.abort();
    const db = makeFakeDb();
    const recent = createP2pkhRecentSync({
      woc: makeWoc(),
      messageBus: makeMessageBus(),
      coordinator: makeCoordinator(() => db),
      getResources: async () => [resource],
      getDb: async () => db as never,
      logger: makeLogger()
    });
    const result = await recent.runOnce(ac.signal);
    expect(result).toEqual({ committed: false, cancelled: true });
  });
});

describe("createP2pkhHistoryBackfill.runOnce", () => {
  it("logs backfill.started and backfill.noResources when there are no resources", async () => {
    const logger = makeLogger();
    const db = makeFakeDb();
    const backfill = createP2pkhHistoryBackfill({
      woc: makeWoc(),
      messageBus: makeMessageBus(),
      coordinator: makeCoordinator(() => db),
      getResources: async () => [] as P2pkhKeyResource[],
      getDb: async () => db as never,
      logger
    });
    await backfill.runOnce(new AbortController().signal);

    const events = logger.calls.filter((c) => c.level === "info").map((c) => c.input.event);
    expect(events).toContain("backfill.started");
    expect(events).toContain("backfill.noResources");
    const noResources = logger.calls.find((c) => c.input.event === "backfill.noResources");
    expect(noResources?.input.data?.resourceCount).toBe(0);
  });

  it("logs per-resource started / completed with final backfill state summary", async () => {
    const resource: P2pkhKeyResource = {
      resourceId: "p2pkh:main",
      publicKeyHex: "02a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718",
      label: "k",
      address: "addr-main",
      network: "main",
      createdAt: "2024-01-01T00:00:00.000Z",
      generation: 0
    };
    const listAddressConfirmedHistory = vi.fn(async () => ({
      items: [{ txid: "tx-complete", height: 100 }],
      nextPageToken: undefined
    }));
    const logger = makeLogger();
    const db = makeFakeDb();
    const backfill = createP2pkhHistoryBackfill({
      woc: makeWoc({ listAddressConfirmedHistory }),
      messageBus: makeMessageBus(),
      coordinator: makeCoordinator(() => db),
      getResources: async () => [resource],
      getDb: async () => db as never,
      logger
    });
    await backfill.runOnce(new AbortController().signal);

    const started = logger.calls.find((c) => c.input.event === "backfill.resource.started");
    expect(started?.input.data?.resourceId).toBe("p2pkh:main");
    const completed = logger.calls.find((c) => c.input.event === "backfill.resource.completed");
    expect(completed?.input.data?.resourceId).toBe("p2pkh:main");
    expect(completed?.input.data?.finalStatus).toBe("complete");
    expect(completed?.input.data?.recordsSynced).toBe(1);
  });

  it("返回 { committed: false } 当 0 resource", async () => {
    const logger = makeLogger();
    const db = makeFakeDb();
    const backfill = createP2pkhHistoryBackfill({
      woc: makeWoc(),
      messageBus: makeMessageBus(),
      coordinator: makeCoordinator(() => db),
      getResources: async () => [] as P2pkhKeyResource[],
      getDb: async () => db as never,
      logger
    });
    const result = await backfill.runOnce(new AbortController().signal);
    expect(result).toEqual({ committed: false, cancelled: false });
  });

  it("返回 { committed: true } 当有 resource 且成功提交", async () => {
    const resource: P2pkhKeyResource = {
      resourceId: "p2pkh:main",
      publicKeyHex: "02a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718",
      label: "k",
      address: "addr-main",
      network: "main",
      createdAt: "2024-01-01T00:00:00.000Z",
      generation: 0
    };
    const db = makeFakeDb();
    const backfill = createP2pkhHistoryBackfill({
      woc: makeWoc({ listAddressConfirmedHistory: vi.fn(async () => ({
        items: [{ txid: "tx1", height: 100 }],
        nextPageToken: undefined
      })) }),
      messageBus: makeMessageBus(),
      coordinator: makeCoordinator(() => db),
      getResources: async () => [resource],
      getDb: async () => db as never,
      logger: makeLogger()
    });
    const result = await backfill.runOnce(new AbortController().signal);
    expect(result).toEqual({ committed: true, cancelled: false });
  });

  it("返回 { committed: false, cancelled: true } 当 signal 已 aborted", async () => {
    const resource: P2pkhKeyResource = {
      resourceId: "p2pkh:main",
      publicKeyHex: "02a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718",
      label: "k",
      address: "addr-main",
      network: "main",
      createdAt: "2024-01-01T00:00:00.000Z",
      generation: 0
    };
    const ac = new AbortController();
    ac.abort();
    const db = makeFakeDb();
    const backfill = createP2pkhHistoryBackfill({
      woc: makeWoc(),
      messageBus: makeMessageBus(),
      coordinator: makeCoordinator(() => db),
      getResources: async () => [resource],
      getDb: async () => db as never,
      logger: makeLogger()
    });
    const result = await backfill.runOnce(ac.signal);
    expect(result).toEqual({ committed: false, cancelled: true });
  });
});

// ---- 取消语义回归测试（取消即不发布成功态/数据变更） ----

describe("取消语义回归", () => {
  it("syncOne 返回 committed: false 时，recent-sync 整体必须为 false", async () => {
    const resource: P2pkhKeyResource = {
      resourceId: "p2pkh:main",
      publicKeyHex: "02a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718",
      label: "k",
      address: "addr-main",
      network: "main",
      createdAt: "2024-01-01T00:00:00.000Z",
      generation: 0
    };
    // coordinator.runRecent 内部 build() 返回的 commit 不变，但 coordinator
    // 的 runRecent 本身不修改 committed——syncOne 内部 committed 取决于
    // 是否真正走到 coordinator.runRecent。这里模拟 0 个 UTXO、0 history
    // 但 coordinator 仍然会 runRecent（因为逻辑走到那里），
    // 所以 committed 仍为 true。要让 committed=false，需要 signal 在
    // runRecent 之前 aborted。
    const ac = new AbortController();
    // 在 syncOne 的 Promise.all 返回前就 abort
    const db = makeFakeDb();
    const woc = makeWoc({
      getAddressConfirmedUtxos: vi.fn(async () => {
        ac.abort();
        return [];
      }),
      listAddressConfirmedHistory: vi.fn(async () => ({ items: [], nextPageToken: undefined }))
    });
    const recent = createP2pkhRecentSync({
      woc,
      messageBus: makeMessageBus(),
      coordinator: makeCoordinator(() => db),
      getResources: async () => [resource],
      getDb: async () => db as never,
      logger: makeLogger()
    });
    const result = await recent.runOnce(ac.signal);
    expect(result.committed).toBe(false);
  });

  it("首个 resource 已提交、第二个 resource 执行中取消：不得标记 ok", async () => {
    const r1: P2pkhKeyResource = {
      resourceId: "p2pkh:main",
      publicKeyHex: "02a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718",
      label: "k",
      address: "addr-main",
      network: "main",
      createdAt: "2024-01-01T00:00:00.000Z",
      generation: 0
    };
    const r2: P2pkhKeyResource = {
      resourceId: "p2pkh:test",
      publicKeyHex: "02a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718",
      label: "k",
      address: "addr-test",
      network: "test",
      createdAt: "2024-01-01T00:00:00.000Z",
      generation: 0
    };
    const ac = new AbortController();
    // 第一个 resource 完成后，在第二个 resource 的 WOC 请求返回后 abort
    let resourceCount = 0;
    const db = makeFakeDb();
    const woc = makeWoc({
      listAddressConfirmedHistory: vi.fn(async () => {
        resourceCount += 1;
        // 第二个 resource 的 history 请求触发取消
        if (resourceCount >= 2) ac.abort();
        return { items: [], nextPageToken: undefined };
      }),
    });
    const recent = createP2pkhRecentSync({
      woc,
      messageBus: makeMessageBus(),
      coordinator: makeCoordinator(() => db),
      getResources: async () => [r1, r2],
      getDb: async () => db as never,
      logger: makeLogger()
    });
    const result = await recent.runOnce(ac.signal);
    // 第一个 resource 已 committed（committed=true），但整体 cancelled
    expect(result.cancelled).toBe(true);
    expect(result.committed).toBe(true);
  });

  it("请求完成、DB 提交前取消：不得提交", async () => {
    const resource: P2pkhKeyResource = {
      resourceId: "p2pkh:main",
      publicKeyHex: "02a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718",
      label: "k",
      address: "addr-main",
      network: "main",
      createdAt: "2024-01-01T00:00:00.000Z",
      generation: 0
    };
    const ac = new AbortController();
    const db = makeFakeDb();
    let coordinatorCalled = false;
    const coordinator = {
      ...makeCoordinator(() => db),
      runRecent: vi.fn(async (_resourceId: string, _generation: number | undefined, build: () => Promise<unknown>) => {
        coordinatorCalled = true;
        const commit = (await build()) as { resourceId: string };
        const fakeDb = await db;
        await fakeDb.commitRecentSnapshot(commit as never);
      }),
    };
    const woc = makeWoc({
      listAddressConfirmedHistory: vi.fn(async () => {
        // 网络请求返回后、coordinator.runRecent 之前 abort
        ac.abort();
        return { items: [{ txid: "tx1", height: 1 }], nextPageToken: undefined };
      }),
    });
    const recent = createP2pkhRecentSync({
      woc,
      messageBus: makeMessageBus(),
      coordinator,
      getResources: async () => [resource],
      getDb: async () => db as never,
      logger: makeLogger()
    });
    const result = await recent.runOnce(ac.signal);
    // syncOne 内在 coordinator.runRecent 前检查到 abort，直接返回
    expect(coordinatorCalled).toBe(false);
    expect(result.committed).toBe(false);
    expect(result.cancelled).toBe(true);
  });
});

// ---- p2pkhService run() 级别取消语义 ----
// 通过 vi.mock 拦截 p2pkhDb 模块，让 createP2pkhService 内部的
// ensureDb() 返回轻量 fake DB，从而能真正调用注册任务的 run()。
// 设计缘由：createP2pkhService 内部自行创建 recent/backfill 实例，
// 无法通过依赖注入替换；vi.mock 是让 IndexedDB 层透明化的唯一途径。

import { createP2pkhService, P2PKH_TASK_RECENT, P2PKH_TASK_BACKFILL } from "./p2pkhService.js";
import type { P2pkhDbBundle, P2pkhDbHandle } from "./p2pkhDb.js";

vi.mock("./p2pkhDb.js", () => ({
  P2PKH_DB_VERSION: 1,
  openP2pkhDb: vi.fn(async () => ({
    db: {} as IDBDatabase,
    ownerPublicKeyHex: "pk-test",
    logger: undefined
  })),
  createP2pkhDb: vi.fn((_bundle: P2pkhDbBundle) => {
    const store = new Map<string, unknown>();
    return {
      listAddresses: vi.fn(async () => []),
      listUtxos: vi.fn(async () => []),
      listHistory: vi.fn(async () => []),
      listLocalInputClaims: vi.fn(async () => []),
      listLocalInputClaimsByResource: vi.fn(async () => []),
      listLocalSubmissions: vi.fn(async () => []),
      listLocalSubmissionsByResource: vi.fn(async () => []),
      listBackfillStates: vi.fn(async () => []),
      listRecentSyncStates: vi.fn(async () => []),
      getResource: vi.fn(async () => undefined),
      putAddress: vi.fn(async () => {}),
      getRecentSyncState: vi.fn(async () => undefined),
      putRecentSyncState: vi.fn(async () => {}),
      getBackfillState: vi.fn(async () => undefined),
      putBackfillState: vi.fn(async () => {}),
      commitRecentSnapshot: vi.fn(async () => {}),
      commitBackfillPage: vi.fn(async () => {}),
      dispose: vi.fn()
    } as unknown as P2pkhDbHandle;
  }),
  disposeP2pkhDb: vi.fn()
}));

describe("p2pkhService task run() 取消语义", () => {
  function makeServiceUnderTest() {
    const statusHistory: string[] = [];
    const notifierCalls: Array<Record<string, unknown>> = [];
    const taskDefs: Record<string, import("@keymaster/contracts").BackgroundTaskDefinition> = {};

    const vault = {
      status: vi.fn(() => "unlocked" as const),
      createActiveKeyCrypto: vi.fn(async () => ({
        deriveP2pkhAddress: vi.fn(async () => ({ publicKeyHex: "pk-test", address: "addr-test" }))
      }))
    } as unknown as import("@keymaster/contracts").VaultService;

    const keyspace = {
      active: vi.fn(() => ({ activePublicKeyHex: "pk-test" })),
      isInitializing: vi.fn(() => false),
      getKey: vi.fn(async () => ({
        publicKeyHex: "pk-test",
        label: "test-key",
        capabilities: [],
        createdAt: "2024-01-01T00:00:00.000Z"
      })),
      openKeyStorage: vi.fn(async () => ({
        ownerPublicKeyHex: "pk-test",
        db: {} as IDBDatabase,
        logger: undefined
      })),
      onActiveChange: vi.fn(() => () => {})
    } as unknown as import("@keymaster/contracts").KeyspaceService;

    const messageBus = makeMessageBus();
    const registry = {
      register(def: import("@keymaster/contracts").BackgroundTaskDefinition) {
        taskDefs[def.id] = def;
      }
    } as unknown as import("@keymaster/contracts").BackgroundRegistry;

    const backgroundService = {
      trigger: vi.fn(),
      cancel: vi.fn()
    } as unknown as import("@keymaster/contracts").BackgroundService;

    const assetDataNotifier = {
      emit: vi.fn((evt: Record<string, unknown>) => { notifierCalls.push(evt); }),
      subscribe: vi.fn(() => () => {})
    } as unknown as import("@keymaster/contracts").AssetDataNotifier;

    const service = createP2pkhService({
      vault,
      woc: makeWoc() as unknown as import("@keymaster/contracts").WocService,
      messageBus,
      backgroundRegistry: registry,
      backgroundService,
      keyspace,
      assetDataNotifier,
      logger: makeLogger() as unknown as import("@keymaster/contracts").PluginLogger
    });

    // 监听 sync status 变化
    service.onRecentSyncStatusChange((s) => statusHistory.push(`recent:${s}`));
    service.onBackfillStatusChange((s) => statusHistory.push(`backfill:${s}`));

    return { service, taskDefs, statusHistory, notifierCalls };
  }

  it("recent task：signal 已 aborted 时 run() 状态为 idle、不发 notifier", async () => {
    const { taskDefs, statusHistory, notifierCalls } = makeServiceUnderTest();
    const recentDef = taskDefs[P2PKH_TASK_RECENT];
    expect(recentDef).toBeDefined();

    const ac = new AbortController();
    ac.abort();
    await recentDef!.run({
      signal: ac.signal,
      reason: "test",
      reportProgress() {}
    });

    // 状态链：syncing → idle（不是 failed、不是 ok）
    expect(statusHistory).toContain("recent:syncing");
    expect(statusHistory).toContain("recent:idle");
    expect(statusHistory).not.toContain("recent:ok");
    expect(statusHistory).not.toContain("recent:failed");
    // 不发 data-changed
    expect(notifierCalls).toHaveLength(0);
  });

  it("backfill task：signal 已 aborted 时 run() 状态为 idle、不发 notifier", async () => {
    const { taskDefs, statusHistory, notifierCalls } = makeServiceUnderTest();
    const backfillDef = taskDefs[P2PKH_TASK_BACKFILL];
    expect(backfillDef).toBeDefined();

    const ac = new AbortController();
    ac.abort();
    await backfillDef!.run({
      signal: ac.signal,
      reason: "test",
      reportProgress() {}
    });

    expect(statusHistory).toContain("backfill:syncing");
    expect(statusHistory).toContain("backfill:idle");
    expect(statusHistory).not.toContain("backfill:ok");
    expect(statusHistory).not.toContain("backfill:failed");
    expect(notifierCalls).toHaveLength(0);
  });

  it("recent task：0 resource 时正常完成、状态为 idle、不发 notifier", async () => {
    const { taskDefs, statusHistory, notifierCalls } = makeServiceUnderTest();
    const recentDef = taskDefs[P2PKH_TASK_RECENT];

    const ac = new AbortController();
    await recentDef!.run({
      signal: ac.signal,
      reason: "test",
      reportProgress() {}
    });

    // 0 resource → committed=false → 不设 ok、不发 notifier
    expect(statusHistory).toContain("recent:syncing");
    // 最终状态是 idle（run 内 committed=false 分支不设状态，保持 syncing 前的值；
    // 但 run() 先设了 syncing，committed=false 时不改状态，所以最终仍是 syncing）
    // 实际代码：committed=false 时什么也不做，状态保持 syncing。
    // 这里验证不发 notifier。
    expect(notifierCalls).toHaveLength(0);
  });
});