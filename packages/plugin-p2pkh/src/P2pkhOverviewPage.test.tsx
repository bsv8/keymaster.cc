// packages/plugin-p2pkh/src/P2pkhOverviewPage.test.tsx
// 硬切换 003（2026-06-19）总览页单测：
//   - 初始渲染：active key 已有 resource 但 recent_sync 未写入时，
//     "最近同步"列显示 "未同步"。
//   - 触发 recentSyncStatus 从 syncing -> ok 时，页面必须重新读取
//     recent_sync 真值，"最近同步"从 "未同步" 切换为时间戳。
//
// 设计缘由：
//   - 不依赖 indexedDB / WOC；用 vi.fn 构造的 fake service 控制
//     listRecentSyncStates / onRecentSyncStatusChange 的返回值。
//   - 真实挂在 PluginHostProvider 下：useCapability / useI18n / useLocale
//     走 runtime 真实路径，确保订阅链路（setVersion 之后 load 真的会被
//     重新调用）确实触发，而不是绕过 React 生命周期。

// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { PluginHostProvider, createPluginHost } from "@keymaster/runtime";
import type { KeyspaceService, ActiveKeyState } from "@keymaster/contracts";
import type {
  P2pkhBackfillState,
  P2pkhKeyResource,
  P2pkhRecentSyncState,
  P2pkhService
} from "./p2pkhContracts.js";
import { P2pkhOverviewPage } from "./pages/P2pkhOverviewPage.js";

const PUBLIC_KEY_HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function makeResource(): P2pkhKeyResource {
  return {
    resourceId: "p2pkh:main",
    keyId: "k1",
    publicKeyHash: PUBLIC_KEY_HASH,
    label: "test-key",
    address: "addr-main",
    network: "main",
    createdAt: "2024-01-01T00:00:00.000Z",
    generation: 0
  };
}

interface FakeService {
  service: P2pkhService;
  /** 直接 push recent 状态变化的 helper。 */
  emitRecent: (s: P2pkhRecentSyncState | null) => void;
  /** 直接 push backfill 状态变化的 helper。 */
  emitBackfill: (s: P2pkhRecentSyncState | null) => void;
  /** 修改 listRecentSyncStates 即将返回的值。 */
  setRecentState: (s: P2pkhRecentSyncState[]) => void;
  setResources: (r: P2pkhKeyResource[]) => void;
  setBackfillStates: (b: P2pkhBackfillState[]) => void;
  recentStatusCalls: Array<"idle" | "syncing" | "ok" | "failed">;
  backfillStatusCalls: Array<"idle" | "syncing" | "ok" | "failed">;
}

function makeFakeService(): FakeService {
  type TaskStatus = "idle" | "syncing" | "ok" | "failed";
  const recentListeners = new Set<(s: TaskStatus) => void>();
  const backfillListeners = new Set<(s: TaskStatus) => void>();
  let recentTaskStatus: TaskStatus = "idle";
  let backfillTaskStatus: TaskStatus = "idle";
  let resources: P2pkhKeyResource[] = [makeResource()];
  let recentState: P2pkhRecentSyncState[] = [];
  let backfillStates: P2pkhBackfillState[] = [];
  const recentStatusCalls: TaskStatus[] = [];
  const backfillStatusCalls: TaskStatus[] = [];
  const fake = {
    syncStatus: () => {
      if (recentTaskStatus === "syncing" || backfillTaskStatus === "syncing") return "syncing" as TaskStatus;
      if (recentTaskStatus === "failed" || backfillTaskStatus === "failed") return "failed" as TaskStatus;
      return "idle" as TaskStatus;
    },
    onSyncStatusChange: (_h: (s: TaskStatus) => void) => () => undefined,
    recentSyncStatus: () => recentTaskStatus,
    backfillStatus: () => backfillTaskStatus,
    onRecentSyncStatusChange: (h: (s: TaskStatus) => void) => {
      recentListeners.add(h);
      return () => recentListeners.delete(h);
    },
    onBackfillStatusChange: (h: (s: TaskStatus) => void) => {
      backfillListeners.add(h);
      return () => backfillListeners.delete(h);
    },
    listResources: vi.fn(async () => resources),
    listBackfillStates: vi.fn(async () => backfillStates),
    listRecentSyncStates: vi.fn(async () => recentState),
    listUtxos: vi.fn(async () => []),
    listHistory: vi.fn(async () => []),
    listLocalSubmissions: vi.fn(async () => []),
    listLocalInputClaims: vi.fn(async () => []),
    getAssetBalance: vi.fn(async () => ({ total: 0 })),
    getResourceBalance: vi.fn(async () => ({ total: 0 })),
    triggerRecentSync: vi.fn(async () => undefined),
    triggerHistoryBackfill: vi.fn(async () => undefined),
    pauseHistoryBackfill: vi.fn(async () => undefined),
    resumeHistoryBackfill: () => undefined,
    getGlobalSettings: () => ({ includeTestnet: false }),
    onGlobalSettingsChange: () => () => undefined,
    applyGlobalSettings: vi.fn(async () => undefined),
    allocateUtxos: vi.fn(async () => { throw new Error("not used in this test"); }),
    prepareTransfer: vi.fn(async () => { throw new Error("not used in this test"); }),
    submitTransfer: vi.fn(async () => { throw new Error("not used in this test"); }),
    onKeyImported: vi.fn(async () => undefined),
    onKeyRemoved: vi.fn(async () => undefined),
    onVaultLocked: async () => undefined,
    onVaultUnlocked: vi.fn(async () => undefined),
    rehydrate: vi.fn(async () => undefined),
    dispose: () => undefined
  } as unknown as P2pkhService;
  return {
    service: fake,
    emitRecent(s) {
      // 模拟一次"syncing -> ok"完整转换，触发页面订阅侧的 reload。
      recentTaskStatus = "syncing";
      recentStatusCalls.push("syncing");
      for (const l of recentListeners) l("syncing");
      const next: TaskStatus = s === null ? "idle" : "ok";
      recentTaskStatus = next;
      recentStatusCalls.push(next);
      for (const l of recentListeners) l(next);
    },
    emitBackfill(s) {
      backfillTaskStatus = "syncing";
      backfillStatusCalls.push("syncing");
      for (const l of backfillListeners) l("syncing");
      const next: TaskStatus = s === null ? "idle" : "ok";
      backfillTaskStatus = next;
      backfillStatusCalls.push(next);
      for (const l of backfillListeners) l(next);
    },
    setRecentState(s) { recentState = s; },
    setResources(r) { resources = r; },
    setBackfillStates(b) { backfillStates = b; },
    recentStatusCalls,
    backfillStatusCalls
  };
}

function makeFakeKeyspace(): KeyspaceService {
  const active: ActiveKeyState = { activePublicKeyHash: PUBLIC_KEY_HASH };
  const listeners = new Set<(s: ActiveKeyState) => void>();
  return {
    listKeys: async () => [],
    getKey: async () => undefined,
    active: () => active,
    setActive: async () => undefined,
    requireActiveKey: () => ({
      keyId: "k1",
      publicKeyHex: "00",
      publicKeyHash: PUBLIC_KEY_HASH,
      label: "test",
      capabilities: ["p2pkh"],
      createdAt: "2024-01-01T00:00:00.000Z",
      identityStatus: "ready" as const
    }),
    onActiveChange: (h: (s: ActiveKeyState) => void) => {
      listeners.add(h);
      return () => listeners.delete(h);
    },
    openKeyStorage: async () => {
      throw new Error("not used in this test");
    },
    registerPluginStorage: () => undefined,
    listPluginStorages: () => [],
    prepareDeleteKey: async () => undefined,
    deleteKey: async () => undefined,
    deleteKeyById: async () => undefined,
    isInitializing: () => false,
    onInitializationChange: () => () => undefined,
    attachBackgroundService: () => undefined
  };
}

describe("P2pkhOverviewPage - 硬切换 003 真刷新", () => {
  beforeEach(() => {
    // localStorage in jsdom is fine, but reset settings between tests.
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows 未同步 initially, switches to timestamp after recentSyncStatus completes", async () => {
    const fake = makeFakeService();
    const keyspace = makeFakeKeyspace();
    const host = createPluginHost({ disableConfigPersistence: true });
    host.provide<P2pkhService>("p2pkh.service", fake.service);
    host.provide<KeyspaceService>("keyspace.service", keyspace);

    render(
      <PluginHostProvider host={host}>
        <P2pkhOverviewPage />
      </PluginHostProvider>
    );

    // 初始：resource 行已渲染，但 recentSync 为空 -> "未同步"。
    await waitFor(() => {
      expect(screen.getByText("test-key")).toBeTruthy();
    });
    expect(screen.getAllByText("未同步").length).toBeGreaterThan(0);

    // 模拟 recent-sync 任务跑完：listRecentSyncStates 即将返回带时间戳。
    const ts = "2024-06-19T10:00:00.000Z";
    fake.setRecentState([{
      resourceId: "p2pkh:main",
      recentConfirmedTxids: [],
      lastCheckedAt: ts,
      lastSuccessAt: ts
    }]);

    // 触发 recentSyncStatus syncing -> ok：页面必须订阅这个事件并 reload。
    await act(async () => {
      fake.emitRecent({ resourceId: "p2pkh:main", recentConfirmedTxids: [], lastSuccessAt: ts, lastCheckedAt: ts });
    });

    // 等待列表重新读取 recent_sync 后，"未同步"应该消失。
    await waitFor(() => {
      expect(screen.queryAllByText("未同步").length).toBe(0);
    }, { timeout: 1500 });
    // listRecentSyncStates 至少被调用两次（initial load + reload after status change）。
    expect((fake.service.listRecentSyncStates as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("reloads on backfillStatus completion even if recent is already done (concurrent task)", async () => {
    // 硬切换 003 收尾：recent + backfill 并发时，第二个任务完成时聚合
    // status 已经离开 syncing，但 per-task 订阅仍应触发 reload。
    const fake = makeFakeService();
    const keyspace = makeFakeKeyspace();
    const host = createPluginHost({ disableConfigPersistence: true });
    host.provide<P2pkhService>("p2pkh.service", fake.service);
    host.provide<KeyspaceService>("keyspace.service", keyspace);

    // backfill state 在 first load 后已经有数据。
    fake.setBackfillStates([
      {
        resourceId: "p2pkh:main",
        status: "running",
        anchorTxids: [],
        pagesSynced: 1,
        recordsSynced: 10,
        revision: 1,
        updatedAt: "2024-06-19T10:00:00.000Z"
      }
    ]);

    render(
      <PluginHostProvider host={host}>
        <P2pkhOverviewPage />
      </PluginHostProvider>
    );
    await waitFor(() => {
      expect(screen.getByText("test-key")).toBeTruthy();
    });
    const beforeCalls = (fake.service.listBackfillStates as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

    // 先把 recent 跑完（reload 一次）。
    await act(async () => {
      fake.emitRecent({ resourceId: "p2pkh:main", recentConfirmedTxids: [], lastSuccessAt: "2024-06-19T11:00:00.000Z" });
    });
    // 然后 backfill 跑完（应该再 reload 一次）。
    fake.setBackfillStates([
      {
        resourceId: "p2pkh:main",
        status: "complete",
        anchorTxids: [],
        pagesSynced: 5,
        recordsSynced: 50,
        revision: 5,
        updatedAt: "2024-06-19T11:00:00.000Z"
      }
    ]);
    await act(async () => {
      fake.emitBackfill({ resourceId: "p2pkh:main", recentConfirmedTxids: [], lastSuccessAt: "2024-06-19T11:00:00.000Z" });
    });
    await new Promise((r) => setTimeout(r, 50));

    const afterCalls = (fake.service.listBackfillStates as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    // 至少比 beforeCalls 多 2（recent reload + backfill reload）。
    expect(afterCalls).toBeGreaterThanOrEqual(beforeCalls + 2);
  });
});