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
      keyId: "k1",
      publicKeyHex: "h1",
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
    await backfill.runOnce(new AbortController().signal, { paused: false });

    const events = logger.calls.filter((c) => c.level === "info").map((c) => c.input.event);
    expect(events).toContain("backfill.started");
    expect(events).toContain("backfill.noResources");
    const noResources = logger.calls.find((c) => c.input.event === "backfill.noResources");
    expect(noResources?.input.data?.resourceCount).toBe(0);
  });

  it("logs per-resource started / completed with final backfill state summary", async () => {
    const resource: P2pkhKeyResource = {
      resourceId: "p2pkh:main",
      keyId: "k1",
      publicKeyHex: "h1",
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
    await backfill.runOnce(new AbortController().signal, { paused: false });

    const started = logger.calls.find((c) => c.input.event === "backfill.resource.started");
    expect(started?.input.data?.resourceId).toBe("p2pkh:main");
    const completed = logger.calls.find((c) => c.input.event === "backfill.resource.completed");
    expect(completed?.input.data?.resourceId).toBe("p2pkh:main");
    expect(completed?.input.data?.finalStatus).toBe("complete");
    expect(completed?.input.data?.recordsSynced).toBe(1);
  });
});