// packages/plugin-appmsg/src/manifest.reconnect.test.ts
// 单一重连协调器端到端测试（施工单 2026-07-04 003 硬切换 + 反馈"必改"第二轮）。
//
// 覆盖（反馈"测试必须补"清单）：
//   1. 首次失败 → 5 秒后自动重试；
//   2. 等待 5 秒期间锁定 → 取消 timer，状态稳定回 idle；
//   3. 切 key / 切 provider 时旧 in-flight 结果作废；
//   4. 远端断线（`onStateChange` 通知 + handle 不在 bound）→ 自动
//      重新进入 5 秒循环；
//   5. 结构性不可连接时 `inspectLocalDb().state === "idle"`，即使之
//      前有 lastError 残留。
//
// 测试策略：直接测 `createReconnectCoordinator` 函数，不通过
// `appmsgPlatformPlugin.setup` 入口（manifest 内部自己 new AppMsgCoreImpl
// 且依赖真实 vault.withPrivateKey，无法直接替换）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import type {
  ActiveMessageProviderSnapshot,
  AppMsgCore,
  AppMsgConnectOutcome,
  AppMsgLocalDbSnapshot,
  KeyspaceService,
  MessageProvider,
  MessageProviderHandle,
  MessageProviderOperations,
  MessageProviderRegistry,
  ProviderListResult,
  ProviderOnlineResult,
  ProviderSendResult,
  VaultService,
  AppMsgMessage,
  VaultStatus
} from "@keymaster/contracts";
import {
  createReconnectCoordinator
} from "./reconnectCoordinator.js";

const OWNER = "02aaaa".padEnd(66, "a");
const OWNER_B = "02bbbb".padEnd(66, "b");

/* ============== mock 服务 ============== */

interface FakeVault {
  service: VaultService;
  setStatus(s: VaultStatus): void;
}
function makeFakeVault(): FakeVault {
  let statusValue: VaultStatus = "unlocked";
  const statusHandlers = new Set<(s: VaultStatus) => void>();
  const v: VaultService = {
    status: () => statusValue,
    onStatusChange: (h: (s: VaultStatus) => void) => {
      statusHandlers.add(h);
      return () => {
        statusHandlers.delete(h);
      };
    }
  } as unknown as VaultService;
  return {
    service: v,
    setStatus(s) {
      statusValue = s;
      for (const h of statusHandlers) h(s);
    }
  };
}

interface FakeKeyspace extends KeyspaceService {
  setActiveHex(h: string | null): void;
  fireActiveChange(): void;
}
function makeFakeKeyspace(): FakeKeyspace {
  let activeHex: string | null = OWNER;
  const activeHandlers = new Set<(s: { activePublicKeyHex?: string }) => void>();
  return {
    active: () => ({ activePublicKeyHex: activeHex ?? undefined }),
    onActiveChange: (h: (s: { activePublicKeyHex?: string }) => void) => {
      activeHandlers.add(h);
      return () => {
        activeHandlers.delete(h);
      };
    },
    getKey: async (x: string) =>
      x === activeHex
        ? { publicKeyHex: x, label: "x", capabilities: [], createdAt: "" }
        : undefined,
    listKeys: async () => [],
    setActive: async (h: string) => {
      activeHex = h;
      for (const fn of activeHandlers) fn({ activePublicKeyHex: h });
    },
    requireActiveKey: () => {
      throw new Error("no active key");
    },
    prepareDeleteKey: async () => undefined,
    deleteKey: async () => undefined,
    isInitializing: () => false,
    onInitializationChange: () => () => undefined,
    openKeyStorage: async () => ({}) as never,
    registerPluginStorage: () => undefined,
    listPluginStorages: () => [],
    setActiveHex(h: string | null) {
      activeHex = h;
      for (const fn of activeHandlers) fn({ activePublicKeyHex: h ?? undefined });
    },
    fireActiveChange() {
      for (const fn of activeHandlers) fn({ activePublicKeyHex: activeHex ?? undefined });
    }
  } as unknown as FakeKeyspace;
}

interface FakeProvider {
  provider: MessageProvider;
  setBindShouldFail(v: boolean): void;
  setHandleState(s: "bound" | "closed"): void;
  triggerRemoteClose(): void;
  closeHandlers: Set<() => void>;
  currentHandle: MessageProviderOperations | null;
  bindCalls: number;
}
function makeFakeProvider(id: string): FakeProvider {
  let shouldFail = false;
  let handleState: "bound" | "closed" = "bound";
  const closeHandlers = new Set<() => void>();
  let currentHandle: MessageProviderOperations | null = null;
  let bindCalls = 0;
  const off = vi.fn();
  const handle: MessageProviderOperations = {
    state: () => handleState,
    close: () => {
      handleState = "closed";
    },
    sendMessage: async () => ({ messageId: "m", insertedAtMs: 0 } as ProviderSendResult),
    listMessages: async () => ({ items: [], hasMore: false } as ProviderListResult),
    getMessage: async () => null as AppMsgMessage | null,
    subscribeMessages: () => off,
    checkOnline: async () => ({}) as ProviderOnlineResult,
    onClose: (h: () => void) => {
      closeHandlers.add(h);
      return () => closeHandlers.delete(h);
    }
  } as unknown as MessageProviderOperations;
  const provider: MessageProvider = {
    id,
    displayName: id,
    bind: async () => {
      bindCalls += 1;
      if (shouldFail) {
        throw new Error("bind failed");
      }
      currentHandle = handle;
      handleState = "bound";
      return handle as MessageProviderHandle;
    },
    shutdown: async () => undefined,
    health: () => ({ isHealthy: true, lastError: null, lastConnectedAtMs: 0 }),
    checkOnline: async () => ({})
  };
  return {
    provider,
    setBindShouldFail: (v) => {
      shouldFail = v;
    },
    setHandleState: (s) => {
      handleState = s;
    },
    triggerRemoteClose() {
      handleState = "closed";
      for (const h of closeHandlers) h();
    },
    closeHandlers,
    get currentHandle() {
      return currentHandle;
    },
    get bindCalls() {
      return bindCalls;
    }
  };
}

interface FakeCore {
  core: AppMsgCore;
  setOutcome(o: AppMsgConnectOutcome): void;
  setHangConnect(v: boolean): void;
  setSnapshot(s: AppMsgLocalDbSnapshot): void;
  setConnectionState(s: "open" | "closed" | "idle"): void;
  simulateRemoteDisconnect(): void;
  fireStateChange(): void;
  setNextReconnectAtMsValue(v: number | null): void;
  inspectLocalDb: () => AppMsgLocalDbSnapshot;
  onStateChangeImpl: (handler: () => void) => () => void;
  onStateChangeListeners: Set<() => void>;
  onActiveChangeImpl: (handler: () => void) => () => void;
  onActiveChangeFire(): void;
  connectCount: number;
  /**
   * 协调器结构代次计数器。协调器在 onStructuralChange 入口 ++。
   * fake core **不**自增——它**只**在 caller 端 await 后自检 epoch
   * 是否仍等于 caller 调用时记录的 epoch；不是的话 fake 模拟 "caller
   * 端把结果视为 stale"——但**实际**上 fake core 不会返回 stale 之外
   * 的特殊值，stale 是 caller 自己决定的。
   */
  callerEpoch: number;
  /** caller 端 cummulative epoch 改变次数（用于 stale 模拟）。 */
  callerEpochChangedCount: number;
  callConnect: (owner: string, epoch?: number) => Promise<AppMsgConnectOutcome>;
  callConnectStartedCount: number;
  /**
   * 反馈"必改"第三轮：测试可以**强制**让所有 deferred 的 callConnect
   * 用指定 outcome 同步 resolve，**不**等 setImmediate 触发。配合
   * `await new Promise(setImmediate)` 在测试代码里推进 macrotask。
   */
  resolveDeferredImmediately(o?: AppMsgConnectOutcome): void;
  /**
   * 反馈"必改"第六轮：强制 settle 当前所有 pending 的
   * `connectForOwner` promise。**仅**用于测试 cleanup（afterEach）——
   * fake core 之外的任何地方都不应该需要它。整组测试一起跑时若有某条
   * 测试在 `coord.awaitInFlight()` 之前 / 之后忘了 drain，调一次
   * `drainAll()` 就能**确定**让残留 deferred resolver 走完，避免
   * pending Promise 把 vitest worker 拖住不退出。
   *
   * 实现上等同于 `resolveDeferredImmediately()`——区别在语义上 draint
   * 作为 cleanup hook，resolveDeferredImmediately 是 happy path 测试
   * 主动驱动。
   */
  drainAll(): void;
}
/**
 * 反馈"必改"第六轮：把每次 `makeFakeCore` 的产物登记起来，让
 * `afterEach` 一定能拿到所有 fake core 并调 `drainAll()`。避免某条
 * 测试遗漏了显式 await/drain 时残留 pending deferred resolver。
 */
const activeFakeCores = new Set<FakeCore>();

function makeFakeCore(provider: FakeProvider, keyspace: FakeKeyspace): FakeCore {
  const stateChangeListeners = new Set<() => void>();
  const onActiveChangeListeners = new Set<() => void>();
  let outcome: AppMsgConnectOutcome = { kind: "connected" };
  let snap: AppMsgLocalDbSnapshot = {
    state: "idle",
    ownerPublicKeyHex: null,
    lastInsertedAtMs: 0,
    lastError: null,
    nextReconnectAtMs: null
  };
  let nextReconnectAtMs: number | null = null;
  let connectCount = 0;
  let callConnectStartedCount = 0;
  let hangConnect = false;
  let callerEpoch = 0;
  let callerEpochChangedCount = 0;
  // 反馈"必改"第三轮：把"hanging 队列"换成"setImmediate 推迟"——
  // callConnect 立即返回 setImmediate-deferred promise，让协调器
  // 看到 in-flight 状态直到下一轮 macrotask。**不**依赖 fake timer。
  const deferredResolvers: Array<(o: AppMsgConnectOutcome) => void> = [];

  const finishConnect = (o: AppMsgConnectOutcome, owner: string): void => {
    if (o.kind === "connected") {
      // 反馈"必改"第三轮：按 outcome 直接写 state=open，不依赖
      // provider.currentHandle。
      snap = {
        ...snap,
        state: "open",
        ownerPublicKeyHex: owner,
        lastError: null,
        nextReconnectAtMs: null
      };
    } else if (o.kind === "structurallyOffline") {
      snap = {
        ...snap,
        state: "idle",
        ownerPublicKeyHex: null,
        lastError: `structurallyOffline: ${o.reason}`,
        nextReconnectAtMs: null
      };
    } else if (o.kind === "retryableFailure") {
      snap = {
        ...snap,
        state: "closed",
        ownerPublicKeyHex: null,
        lastError: o.reason,
        nextReconnectAtMs: nextReconnectAtMs
      };
    }
    for (const l of stateChangeListeners) l();
  };

  const callConnect = async (
    owner: string,
    _callerEpochParam?: number
  ): Promise<AppMsgConnectOutcome> => {
    connectCount += 1;
    callConnectStartedCount += 1;
    if (hangConnect) {
      return await new Promise<AppMsgConnectOutcome>(() => undefined);
    }
    // setImmediate 推迟 resolve——给协调器留出"in-flight 期间结构变化"
    // 的窗口。**注意**：
    //   - setImmediate 是 macrotask，不是 microtask；
    //   - 测试**不**用 fake timer，避免 setImmediate 推进异常；
    //   - 测试**不**调 fakeCore.setOutcome 多次——setImmediate 触发
    //     时取最新 outcome。
    return new Promise<AppMsgConnectOutcome>((resolve) => {
      deferredResolvers.push((finalO) => {
        finishConnect(finalO, owner);
        resolve(finalO);
      });
      // 用 `Promise.resolve().then(...)` 推迟到 microtask——**不**依赖
      // fake timer（fake timer 不会拦截 microtask）。测试用
      // `await Promise.resolve()` 推进 microtask 即可。
      Promise.resolve().then(() => {
        const currentOutcome = outcome;
        while (deferredResolvers.length > 0) {
          const r = deferredResolvers.shift()!;
          r(currentOutcome);
        }
      });
    });
  };
  const providers = (): MessageProviderRegistry =>
    ({
      active: () => provider.provider,
      activeSnapshot: () => ({
        providerId: provider.provider.id,
        displayName: provider.provider.displayName,
        isHealthy: true,
        lastError: null
      }) as ActiveMessageProviderSnapshot,
      list: () => [provider.provider],
      setActive: async () => undefined,
      register: () => undefined,
      onActiveChange: (h: () => void) => {
        onActiveChangeListeners.add(h);
        return () => onActiveChangeListeners.delete(h);
      }
    }) as unknown as MessageProviderRegistry;
  const appmsgCore: AppMsgCore = {
    connectForOwner: callConnect,
    disconnect: async () => {
      snap = {
        ...snap,
        state: "idle",
        ownerPublicKeyHex: null,
        nextReconnectAtMs: null
      };
      for (const l of stateChangeListeners) l();
    },
    inspectLocalDb: () => snap,
    onStateChange: (h: () => void) => {
      stateChangeListeners.add(h);
      return () => stateChangeListeners.delete(h);
    },
    markStructurallyOffline: () => {
      // fake 不清 lastError——保留 outcome 留下的真实失败原因便于
      // 协调器 / UI 诊断。state 仍收到 idle。
      snap = {
        ...snap,
        state: "idle",
        ownerPublicKeyHex: null,
        nextReconnectAtMs: null
      };
      for (const l of stateChangeListeners) l();
    },
    setNextReconnectAtMs: (v: number | null) => {
      nextReconnectAtMs = v;
      snap = { ...snap, nextReconnectAtMs: v };
      for (const l of stateChangeListeners) l();
    },
    getNextReconnectAtMs: () => nextReconnectAtMs,
    currentHandle: () => provider.currentHandle,
    providers,
    keyspace
  } as unknown as AppMsgCore;
  const fireStateChange = (): void => {
    for (const l of stateChangeListeners) l();
  };
  const setConnectionState = (state: "open" | "closed" | "idle"): void => {
    const ownerPublicKeyHex =
      state === "idle"
        ? null
        : (snap.ownerPublicKeyHex ?? keyspace.active().activePublicKeyHex ?? null);
    snap = {
      ...snap,
      state,
      ownerPublicKeyHex,
      lastError: state === "open" ? null : snap.lastError,
      nextReconnectAtMs: state === "open" ? null : snap.nextReconnectAtMs
    };
  };
  const simulateRemoteDisconnect = (): void => {
    provider.setHandleState("closed");
    setConnectionState("closed");
    snap = {
      ...snap,
      lastError: "connection closed by remote"
    };
    fireStateChange();
  };
  const fakeCoreObj: FakeCore = {
    core: appmsgCore,
    setOutcome: (o: AppMsgConnectOutcome) => {
      outcome = o;
    },
    setHangConnect: (v: boolean) => {
      hangConnect = v;
    },
    setSnapshot: (s) => {
      snap = s;
    },
    setConnectionState,
    simulateRemoteDisconnect,
    fireStateChange,
    setNextReconnectAtMsValue: (v) => {
      nextReconnectAtMs = v;
    },
    inspectLocalDb: () => snap,
    onStateChangeImpl: (h) => {
      stateChangeListeners.add(h);
      return () => stateChangeListeners.delete(h);
    },
    onStateChangeListeners: stateChangeListeners,
    onActiveChangeImpl: (h) => {
      onActiveChangeListeners.add(h);
      return () => onActiveChangeListeners.delete(h);
    },
    onActiveChangeFire() {
      for (const l of onActiveChangeListeners) l();
    },
    get connectCount() {
      return connectCount;
    },
    get callConnectStartedCount() {
      return callConnectStartedCount;
    },
    get callerEpoch() {
      return callerEpoch;
    },
    set callerEpoch(v: number) {
      if (v !== callerEpoch) {
        callerEpochChangedCount += 1;
      }
      callerEpoch = v;
    },
    get callerEpochChangedCount() {
      return callerEpochChangedCount;
    },
    resolveDeferredImmediately: (o?: AppMsgConnectOutcome) => {
      const finalO = o ?? outcome;
      while (deferredResolvers.length > 0) {
        const r = deferredResolvers.shift()!;
        r(finalO);
      }
    },
    drainAll() {
      // 等同于 `resolveDeferredImmediately()` 但语义上 read 为 cleanup
      // hook。afterEach 调用，避免整组测试一起跑时某条测试遗漏 drain
      // 把 vitest worker hang。
      const finalO = outcome;
      while (deferredResolvers.length > 0) {
        const r = deferredResolvers.shift()!;
        r(finalO);
      }
    },
    callConnect
  };
  const fakeCore = fakeCoreObj as unknown as FakeCore;
  activeFakeCores.add(fakeCore);
  return fakeCore;
}

/* ============== 测试 ============== */

describe("createReconnectCoordinator", () => {
  // 默认 real timer——5s 重试相关测试**自己**切换到 fake timer。
  // in-flight 测试用 process.nextTick 推进，依赖 real timer。
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(async () => {
    // 反馈"必改"第六轮：整组测试一起跑时整 vitest worker 会因为
    // 残留异步句柄/未 drain 的 fake core pending promise 不退出——
    // 这里四步配合处理：
    //
    //   1. 强制清掉所有注册过的 fake core 残留 deferred resolver——
    //      让 pending 的 `connectForOwner` promise 全部 settle。
    //      若这条之前 IIFE 还在等 `await core.connectForOwner(...)`，
    //      pending IIFE 此时会被推进，attempt 的 finally 跑完，
    //      `inFlightConnect` 被 finally 自然置 null（即便
    //      `coord.dispose()` 已经先把 `inFlightConnect` 清掉了）。
    for (const fc of activeFakeCores) {
      try {
        fc.drainAll();
      } catch {
        // cleanup 路径上 swallow 异常，避免影响 afterEach 后续 cleanup。
      }
    }
    activeFakeCores.clear();
    //
    //   2. 清掉可能残留的 fake timer handle——主要是 fake timer 测试
    //      期间 `coord.scheduleReconnect` 排了 5s timer 后测试结束时
    //      未及时 advance。`vi.useRealTimers()` 会再清扫一次。
    try {
      vi.clearAllTimers();
    } catch {
      // 不让 vitest 内部异常阻断 cleanup 后续步骤。
    }
    try {
      vi.useRealTimers();
    } catch {
      // 同上。
    }
    //
    //   3. 把 await chain 排出的 microtask 让出一次——
    //      `drainAll` 已经把 pending resolver 同步 settle，await
    //      让 drainAll 的 .then(...) callback 队列过一次，避免
    //      vitest worker 视角上还有 pending microtask 残留。
    await Promise.resolve();
  });

  // fake timer 组：凡是推进 5 秒重试 / timer 清理 / dispose 的测试，
  // 都必须在各自 `it(...)` 开头显式 `vi.useFakeTimers()`。
  it("首次失败后固定 5 秒再试一次，直到成功", async () => {
    // 5s 重试依赖 fake timer。
    vi.useFakeTimers();
    const vault = makeFakeVault();
    const keyspace = makeFakeKeyspace();
    const provider = makeFakeProvider("hubmsg");
    const fakeCore = makeFakeCore(provider, keyspace);
    fakeCore.setOutcome({ kind: "retryableFailure", reason: "boom" });
    const coord = createReconnectCoordinator({
      core: fakeCore.core,
      vault: vault.service,
      keyspace,
      logger: { info: vi.fn(), warn: vi.fn() }
    });
    // 等首次 attempt 走完（fake core 同步 + 一轮 microtask）。
    await coord.awaitInFlight();
    // setup 阶段首次 attempt。
    expect(fakeCore.connectCount).toBe(1);
    expect(fakeCore.inspectLocalDb().nextReconnectAtMs).not.toBeNull();
    // 5s 后第二次 attempt。
    fakeCore.setOutcome({ kind: "connected" });
    vi.advanceTimersByTime(5000);
    await coord.awaitInFlight();
    expect(fakeCore.connectCount).toBe(2);
    expect(fakeCore.inspectLocalDb().nextReconnectAtMs).toBeNull();
    coord.dispose();
  });

  it("等待 5 秒期间锁定：取消 timer，state 稳定回 idle", async () => {
    vi.useFakeTimers();
    const vault = makeFakeVault();
    const keyspace = makeFakeKeyspace();
    const provider = makeFakeProvider("hubmsg");
    const fakeCore = makeFakeCore(provider, keyspace);
    fakeCore.setOutcome({ kind: "retryableFailure", reason: "boom" });
    const coord = createReconnectCoordinator({
      core: fakeCore.core,
      vault: vault.service,
      keyspace,
      logger: { info: vi.fn(), warn: vi.fn() }
    });
    await coord.awaitInFlight();
    expect(fakeCore.connectCount).toBe(1);
    expect(fakeCore.inspectLocalDb().nextReconnectAtMs).not.toBeNull();
    // 等待期间锁定 → 结构性离线。structuralConnectable 拦截，不会再调
    // core.connectForOwner，所以 connectCount 仍为 1。
    vault.setStatus("locked");
    await coord.awaitInFlight();
    expect(fakeCore.inspectLocalDb().state).toBe("idle");
    expect(fakeCore.inspectLocalDb().nextReconnectAtMs).toBeNull();
    // 推 5s，timer 已清，无重试。
    vi.advanceTimersByTime(10_000);
    expect(fakeCore.connectCount).toBe(1);
    coord.dispose();
  });

  it("构造期 keyspace 立即回放 + locked 同步完成，不应留下幽灵 in-flight", async () => {
    const vault = makeFakeVault();
    vault.setStatus("locked");
    const keyspace = makeFakeKeyspace();
    const provider = makeFakeProvider("hubmsg");
    const fakeCore = makeFakeCore(provider, keyspace);
    const warn = vi.fn();
    const coord = createReconnectCoordinator({
      core: fakeCore.core,
      vault: vault.service,
      keyspace,
      logger: { info: vi.fn(), warn }
    });

    keyspace.fireActiveChange();
    await Promise.resolve();

    const mismatchEvents = warn.mock.calls
      .map((call) => call[0] as { event?: string })
      .filter((entry) => entry?.event === "appmsg.connect.inflight_meta_mismatch");
    expect(mismatchEvents).toHaveLength(0);
    expect(coord.hasPendingTimer).toBe(false);
    coord.dispose();
  });

  it("切 active key 触发新 attempt（旧 in-flight 结果作废）", async () => {
    const vault = makeFakeVault();
    const keyspace = makeFakeKeyspace();
    const provider = makeFakeProvider("hubmsg");
    const fakeCore = makeFakeCore(provider, keyspace);
    fakeCore.setOutcome({ kind: "connected" });
    const coord = createReconnectCoordinator({
      core: fakeCore.core,
      vault: vault.service,
      keyspace,
      logger: { info: vi.fn(), warn: vi.fn() }
    });
    await coord.awaitInFlight();
    expect(fakeCore.connectCount).toBe(1);
    // 切 key → 协调器重新 attempt。
    keyspace.setActiveHex(OWNER_B);
    await coord.awaitInFlight();
    expect(fakeCore.connectCount).toBe(2);
    coord.dispose();
  });

  it("切 active provider 触发新一轮 attempt（旧的 waiting timer 失效）", async () => {
    vi.useFakeTimers();
    const vault = makeFakeVault();
    const keyspace = makeFakeKeyspace();
    const provider = makeFakeProvider("hubmsg");
    const fakeCore = makeFakeCore(provider, keyspace);
    fakeCore.setOutcome({ kind: "retryableFailure", reason: "boom" });
    const coord = createReconnectCoordinator({
      core: fakeCore.core,
      vault: vault.service,
      keyspace,
      logger: { info: vi.fn(), warn: vi.fn() }
    });
    await coord.awaitInFlight();
    const firstNextAt = fakeCore.inspectLocalDb().nextReconnectAtMs!;
    // 切 provider：fake timer 下时间不前进，先 advance 1ms 让新 nextAt 更大。
    vi.advanceTimersByTime(1);
    fakeCore.onActiveChangeFire();
    await coord.awaitInFlight();
    const secondNextAt = fakeCore.inspectLocalDb().nextReconnectAtMs!;
    expect(secondNextAt).toBeGreaterThan(firstNextAt);
    coord.dispose();
  });

  it("远端断线后自动再次进入 5 秒循环", async () => {
    vi.useFakeTimers();
    const vault = makeFakeVault();
    const keyspace = makeFakeKeyspace();
    const provider = makeFakeProvider("hubmsg");
    const fakeCore = makeFakeCore(provider, keyspace);
    fakeCore.setOutcome({ kind: "connected" });
    const coord = createReconnectCoordinator({
      core: fakeCore.core,
      vault: vault.service,
      keyspace,
      logger: { info: vi.fn(), warn: vi.fn() }
    });
    await coord.awaitInFlight();
    expect(fakeCore.connectCount).toBe(1);
    // 模拟远端断线：fake core helper 同时产出
    // `inspectLocalDb().state: open -> closed` 与 state change 事件。
    fakeCore.simulateRemoteDisconnect();
    // 协调器应识别"刚 bound → 不在 bound"，排 5s timer。
    expect(fakeCore.inspectLocalDb().nextReconnectAtMs).not.toBeNull();
    // 5s 后 attemptConnect 第二次。
    fakeCore.setOutcome({ kind: "connected" });
    vi.advanceTimersByTime(5000);
    await coord.awaitInFlight();
    expect(fakeCore.connectCount).toBe(2);
    coord.dispose();
  });

  it("无 active key：结构性不可连接，state 稳定 idle，timer 不排", async () => {
    vi.useFakeTimers();
    const vault = makeFakeVault();
    const keyspace = makeFakeKeyspace();
    const provider = makeFakeProvider("hubmsg");
    const fakeCore = makeFakeCore(provider, keyspace);
    // keyspace active = null 必须在 createReconnectCoordinator 之前设，
    // 否则 setup 首次 attempt 会在 structuralConnectable 阶段就拦下。
    // 但这里需要的是"keyspace.onActiveChange 事件"的覆盖，所以反过来：
    // 先让协调器起来（看到 active = OWNER），再切到 null。
    const coord = createReconnectCoordinator({
      core: fakeCore.core,
      vault: vault.service,
      keyspace,
      logger: { info: vi.fn(), warn: vi.fn() }
    });
    await coord.awaitInFlight();
    // 切到 null → 协调器识别"无 active key" → 结构性离线。
    keyspace.setActiveHex(null);
    await coord.awaitInFlight();
    expect(fakeCore.inspectLocalDb().state).toBe("idle");
    expect(fakeCore.inspectLocalDb().nextReconnectAtMs).toBeNull();
    vi.advanceTimersByTime(10_000);
    // setup 1 次（成功 connectForOwner） + 切 key 1 次（structuralConnectable
    // 拦截，**不**调 connectForOwner）= 1。
    expect(fakeCore.connectCount).toBe(1);
    expect(coord.hasPendingTimer).toBe(false);
    coord.dispose();
  });

  it("vault locked 后无重试", async () => {
    vi.useFakeTimers();
    const vault = makeFakeVault();
    const keyspace = makeFakeKeyspace();
    const provider = makeFakeProvider("hubmsg");
    const fakeCore = makeFakeCore(provider, keyspace);
    const coord = createReconnectCoordinator({
      core: fakeCore.core,
      vault: vault.service,
      keyspace,
      logger: { info: vi.fn(), warn: vi.fn() }
    });
    await coord.awaitInFlight();
    vault.setStatus("locked");
    await coord.awaitInFlight();
    expect(fakeCore.inspectLocalDb().state).toBe("idle");
    vi.advanceTimersByTime(10_000);
    // setup 1 次（成功） + vault.locked 1 次（structuralConnectable 拦
    // 截，**不**调 connectForOwner）= 1。
    expect(fakeCore.connectCount).toBe(1);
    coord.dispose();
  });

  it("dispose() 清 timer 并解所有订阅", async () => {
    vi.useFakeTimers();
    const vault = makeFakeVault();
    const keyspace = makeFakeKeyspace();
    const provider = makeFakeProvider("hubmsg");
    const fakeCore = makeFakeCore(provider, keyspace);
    fakeCore.setOutcome({ kind: "retryableFailure", reason: "boom" });
    const coord = createReconnectCoordinator({
      core: fakeCore.core,
      vault: vault.service,
      keyspace,
      logger: { info: vi.fn(), warn: vi.fn() }
    });
    await coord.awaitInFlight();
    expect(coord.hasPendingTimer).toBe(true);
    coord.dispose();
    expect(coord.hasPendingTimer).toBe(false);
    // dispose 后再推 5s，不应再 attempt。
    const before = fakeCore.connectCount;
    vi.advanceTimersByTime(10_000);
    expect(fakeCore.connectCount).toBe(before);
  });

  it("同一结构代次下：首次 retryableFailure，5 秒后第二次尝试不应变 stale（callerEpoch 解耦修复）", async () => {
    // 反馈"必改"第二轮：旧实现把 callerEpoch 当必须等于 connectEpoch
    // 的 token，导致同一代次下的 5 秒重试全部变 stale。本测试用协调
    // 器 + fake core 验证新设计下同一 callerEpoch 反复调用是合法的。
    vi.useFakeTimers();
    const vault = makeFakeVault();
    const keyspace = makeFakeKeyspace();
    const provider = makeFakeProvider("hubmsg");
    const fakeCore = makeFakeCore(provider, keyspace);
    fakeCore.setOutcome({ kind: "retryableFailure", reason: "boom" });
    const coord = createReconnectCoordinator({
      core: fakeCore.core,
      vault: vault.service,
      keyspace,
      logger: { info: vi.fn(), warn: vi.fn() }
    });
    await coord.awaitInFlight();
    expect(fakeCore.connectCount).toBe(1);
    expect(fakeCore.inspectLocalDb().nextReconnectAtMs).not.toBeNull();
    // 5s 后第二次 attempt：fake core 不应把 callerEpoch 当作强制等
    // 值检查——同一代次下继续走完 outcome 路径，connectCount 增加。
    fakeCore.setOutcome({ kind: "connected" });
    vi.advanceTimersByTime(5000);
    await coord.awaitInFlight();
    expect(fakeCore.connectCount).toBe(2);
    expect(fakeCore.inspectLocalDb().nextReconnectAtMs).toBeNull();
    coord.dispose();
  });

  it("local_db_unavailable：不应排 5 秒重试，state 稳定 idle", async () => {
    // 反馈"必改"第二轮：appmsgCore 新增 local_db_unavailable 分支
    // 后，协调器收到该 outcome 必须走"结构性离线"路径——不排 5 秒
    // timer，不重试。
    vi.useFakeTimers();
    const vault = makeFakeVault();
    const keyspace = makeFakeKeyspace();
    const provider = makeFakeProvider("hubmsg");
    const fakeCore = makeFakeCore(provider, keyspace);
    fakeCore.setOutcome({
      kind: "structurallyOffline",
      reason: "local_db_unavailable"
    });
    const coord = createReconnectCoordinator({
      core: fakeCore.core,
      vault: vault.service,
      keyspace,
      logger: { info: vi.fn(), warn: vi.fn() }
    });
    await coord.awaitInFlight();
    // structuralConnectable ok + outcome=structurallyOffline：
    // 协调器用 outcome.reason 记录真实失败原因，进入结构性离线。
    expect(fakeCore.inspectLocalDb().state).toBe("idle");
    expect(fakeCore.inspectLocalDb().nextReconnectAtMs).toBeNull();
    // 不应排 timer。
    expect(coord.hasPendingTimer).toBe(false);
    // 推 10s，connectCount 不增加（除了 setup 初始那次）。
    vi.advanceTimersByTime(10_000);
    expect(fakeCore.connectCount).toBe(1);
    coord.dispose();
  });

  it("no_signer 失败：reason 真实保留，不被结构条件覆盖", async () => {
    // 反馈"必改"第二轮：协调器在 structurallyOffline 分支应尊重
    // outcome.reason，不硬编码为 `no_active_provider`。
    const vault = makeFakeVault();
    const keyspace = makeFakeKeyspace();
    const provider = makeFakeProvider("hubmsg");
    const fakeCore = makeFakeCore(provider, keyspace);
    fakeCore.setOutcome({ kind: "structurallyOffline", reason: "no_signer" });
    const coord = createReconnectCoordinator({
      core: fakeCore.core,
      vault: vault.service,
      keyspace,
      logger: { info: vi.fn(), warn: vi.fn() }
    });
    await coord.awaitInFlight();
    expect(fakeCore.inspectLocalDb().lastError).toMatch(/no_signer/);
    expect(coord.hasPendingTimer).toBe(false);
    coord.dispose();
  });

  // real timer + microtask 组：覆盖 in-flight 竞态。
  // 这些测试依赖 `Promise.resolve()` 推进，不应写 `advanceTimersByTime(...)`。
  it("in-flight 中途切换 active key：旧 attempt 完成后自动补发新 attempt", async () => {
    // 反馈"必改"第三轮 + 第四轮：旧实现下若结构变化发生在 in-flight 中途，
    // 协调器会把新结构条件吞掉（attemptConnect 直接 return 旧 promise，
    // 旧 attempt 完成后没人再跑一次 attempt）。新实现下 attempt 的
    // finally 块检测 `pendingEpoch >= myEpoch` 自动补发。
    //
    // fake core 的 callConnect 用 `Promise.resolve().then(...)` 推迟
    // resolve。fake timer 不影响 microtask。
    const vault = makeFakeVault();
    const keyspace = makeFakeKeyspace();
    const provider = makeFakeProvider("hubmsg");
    const fakeCore = makeFakeCore(provider, keyspace);
    fakeCore.setOutcome({ kind: "connected" });
    const coord = createReconnectCoordinator({
      core: fakeCore.core,
      vault: vault.service,
      keyspace,
      logger: { info: vi.fn(), warn: vi.fn() }
    });
    // attempt 1 已发起，callConnect 在 microtask 推迟。
    expect(fakeCore.callConnectStartedCount).toBe(1);
    // in-flight 期间切 active key → 记录 pendingEpoch（最新代次）。
    keyspace.setActiveHex(OWNER_B);
    expect(fakeCore.callConnectStartedCount).toBe(1);
    // 推进 microtask：让 fake core 的 callConnect 跑 deferred resolver
    // → attempt 1 IIFE 继续 → callerEpoch 自检 → return → finally
    // 检测 pendingEpoch ≥ myEpoch → 立刻重 attemptConnect → attempt 2
    // 调 callConnect（同步进 callConnectStartedCount=2）。
    await vi.waitFor(() => {
      expect(fakeCore.callConnectStartedCount).toBe(2);
    });
    // 让 attempt 2 走完。
    fakeCore.resolveDeferredImmediately({ kind: "connected" });
    await coord.awaitInFlight();
    expect(fakeCore.connectCount).toBe(2);
    expect(fakeCore.inspectLocalDb().state).toBe("open");
    coord.dispose();
  });

  it("in-flight 中途 vault locked → unlocked：旧 attempt 完成后自动补发新 attempt", async () => {
    // 反馈"必改"第五轮：vault 状态切换发生在 in-flight 中途，旧 attempt
    // 完成后必须能再起一次，否则结构条件变化后连接不会自动跟上。
    //
    // 关键测试点：
    //   1. in-flight 期间 vault.locked → onStructuralChange 把
    //      pendingEpoch 入队；
    //   2. attempt 1 完成 → finally 消费 pendingEpoch → 调
    //      `reconcileQueuedEpoch(2)`；此时 vault=locked →
    //      structuralConnectable !ok → **不** attempt（return）。
    //      callConnectStartedCount 仍 1。
    //   3. vault.unlocked → onStructuralChange 走 inFlightConnect===null
    //      分支 → 调 `reconcileQueuedEpoch(epoch)` → structuralConnectable
    //      ok → void attemptConnect() → 同步进 callConnect，
    //      callConnectStartedCount 立刻变 2。
    //
    // 注意：第五轮新增的 `reconcileQueuedEpoch` 把"应该立刻 attempt
    // 还是等待"集中到小函数——而不是让 attempt IIFE 自己完成
    // `goStructurallyOffline` 之后又判 pendingEpoch。这样旧版本
    // "locked 补发那次 attempt IIFE 命中 locked 路径结束"被显式阻止：
    // 真正驱动下一次 attempt 的是 unlocked 事件本身。
    //
    // callConnectStartedCount 的断言（同步在 vault.unlocked 后立刻 +1）
    // 是关键——若 `reconcileQueuedEpoch` 没正确把 unlocked 路径起 attempt，
    // 这个断言会失败。
    //
    // fake core 的 callConnect 用 `Promise.resolve().then(...)` 推迟
    // resolve。fake timer 不影响 microtask。
    const vault = makeFakeVault();
    const keyspace = makeFakeKeyspace();
    const provider = makeFakeProvider("hubmsg");
    const fakeCore = makeFakeCore(provider, keyspace);
    fakeCore.setOutcome({ kind: "connected" });
    const coord = createReconnectCoordinator({
      core: fakeCore.core,
      vault: vault.service,
      keyspace,
      logger: { info: vi.fn(), warn: vi.fn() }
    });
    expect(fakeCore.callConnectStartedCount).toBe(1);
    // in-flight 期间 vault 锁定 → onStructuralChange 记录 pendingEpoch。
    vault.setStatus("locked");
    expect(fakeCore.callConnectStartedCount).toBe(1);
    // 推进 microtask：fake core 的 callConnect 跑 deferred →
    // attempt 1 IIFE continue → callerEpoch 自检 → return → finally
    // 检测 pendingEpoch ≥ myEpoch → 立刻 attemptConnect → attempt 2
    // 进入（structuralConnectable 拦截 → 同步 goStructurallyOffline
    // → **不**入队 pendingEpoch → **不**调 callConnect）→
    // inFlightConnect=null。
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // attempt 2 不调 callConnect，所以 callConnectStartedCount 仍 1。
    expect(fakeCore.callConnectStartedCount).toBe(1);
    // 再解锁 → attempt 3 进 callConnect。
    vault.setStatus("unlocked");
    // 协调器 unlock 触发 onStructuralChange → inFlightConnect=null
    // → attemptConnect → attempt 3 IIFE 同步到 callConnect 入口。
    // ++callConnectStartedCount 同步完成。
    await vi.waitFor(() => {
      expect(fakeCore.callConnectStartedCount).toBe(2);
    });
    // 让 attempt 3 走完。
    fakeCore.resolveDeferredImmediately({ kind: "connected" });
    await coord.awaitInFlight();
    expect(fakeCore.connectCount).toBe(2);
    expect(fakeCore.inspectLocalDb().state).toBe("open");
    coord.dispose();
  });

  it("in-flight 期间连续两次结构变化（locked → unlocked），必须按最新一次结构条件落实一次新 attempt", async () => {
    // 反馈"必改"第四轮关键场景：旧布尔 `pendingStructuralKick` 在
    // "locked" 补发那次之后会把后续 "unlocked" 的补发吞掉。本测试用
    // 连续两次结构变化（间隔在同一 in-flight 期间内）验证**最新一次**
    // 才会被采纳——更早的"locked"补发其实只是路过，最终 attempt 必须
    // 是按"unlocked"那条新结构条件发起的。
    //
    // 时序：
    //   1. setup：unlocked → attempt 1 in-flight；
    //   2. in-flight：vault.locked → onStructuralChange 记录
    //      pendingEpoch = epoch1；
    //   3. in-flight：vault.unlocked → onStructuralChange 把
    //      pendingEpoch **覆盖**为 epoch2（必须采纳 unlocked 的代次）；
    //   4. attempt 1 完成 → finally 看到 pendingEpoch ≥ myEpoch →
    //      补发 attempt 2 → 这时 vault.unlocked，structuralConnectable
    //      ok → callConnect → callConnectStartedCount=2；
    //   5. 最终 attempt 2 拿到 connected → state=open。
    //
    // 关键断言必须用 callConnectStartedCount 而非 state：
    //   - callConnectStartedCount 必须在 vault.unlocked 后**同步** +1；
    //   - 但**不**能在 vault.locked 后同步 +1（locked 期间
    //     structuralConnectable 拦截）。
    const vault = makeFakeVault();
    const keyspace = makeFakeKeyspace();
    const provider = makeFakeProvider("hubmsg");
    const fakeCore = makeFakeCore(provider, keyspace);
    fakeCore.setOutcome({ kind: "connected" });
    const coord = createReconnectCoordinator({
      core: fakeCore.core,
      vault: vault.service,
      keyspace,
      logger: { info: vi.fn(), warn: vi.fn() }
    });
    // attempt 1 in-flight.
    expect(fakeCore.callConnectStartedCount).toBe(1);
    // 第一次结构变化：vault.locked（在 attempt 1 in-flight 期间）。
    vault.setStatus("locked");
    // pendingEpoch 已记录但仍 in-flight，不应同步进 callConnect。
    expect(fakeCore.callConnectStartedCount).toBe(1);
    // 第二次结构变化：vault.unlocked 仍然在 attempt 1 in-flight 期间。
    // 关键：这次要把 pendingEpoch **覆盖**到最新的 unlocked 代次。
    vault.setStatus("unlocked");
    // 仍然 in-flight（unlocked 事件期间 attempt 1 还没完成）。
    expect(fakeCore.callConnectStartedCount).toBe(1);
    // 推进 microtask：fake core 跑 deferred → attempt 1 IIFE 推完
    // → callerEpoch 自检 → return → finally 检测 pendingEpoch ≥ myEpoch
    // → 补发 attempt 2 → 这次 vault.unlocked，structuralConnectable ok
    // → 调 callConnect → callConnectStartedCount=2（同步）。
    await vi.waitFor(() => {
      expect(fakeCore.callConnectStartedCount).toBe(2);
    });
    // 让 attempt 2 走完。
    fakeCore.resolveDeferredImmediately({ kind: "connected" });
    await coord.awaitInFlight();
    expect(fakeCore.connectCount).toBe(2);
    expect(fakeCore.inspectLocalDb().state).toBe("open");
    coord.dispose();
  });

  it("旧 in-flight 卡住超时后，最新 unlocked pending 必须被消费并立即起新 attempt", async () => {
    vi.useFakeTimers();
    const vault = makeFakeVault();
    const keyspace = makeFakeKeyspace();
    const provider = makeFakeProvider("hubmsg");
    const fakeCore = makeFakeCore(provider, keyspace);
    fakeCore.setOutcome({ kind: "connected" });
    fakeCore.setHangConnect(true);
    const coord = createReconnectCoordinator({
      core: fakeCore.core,
      vault: vault.service,
      keyspace,
      logger: { info: vi.fn(), warn: vi.fn() }
    });
    expect(fakeCore.callConnectStartedCount).toBe(1);

    vault.setStatus("locked");
    vault.setStatus("unlocked");
    expect(fakeCore.callConnectStartedCount).toBe(1);

    // 让超时 watchdog 释放旧 in-flight。第二次 attempt 不再挂住。
    fakeCore.setHangConnect(false);
    await vi.advanceTimersByTimeAsync(15001);
    await Promise.resolve();
    await Promise.resolve();

    expect(fakeCore.callConnectStartedCount).toBe(2);
    await coord.awaitInFlight();
    expect(fakeCore.inspectLocalDb().state).toBe("open");
    coord.dispose();
  });

  it("旧 attempt finally 不得清掉新 attempt 的元信息", async () => {
    const vault = makeFakeVault();
    const keyspace = makeFakeKeyspace();
    const provider = makeFakeProvider("hubmsg");
    const fakeCore = makeFakeCore(provider, keyspace);
    const info = vi.fn();
    const warn = vi.fn();
    fakeCore.setOutcome({ kind: "connected" });
    const coord = createReconnectCoordinator({
      core: fakeCore.core,
      vault: vault.service,
      keyspace,
      logger: { info, warn }
    });

    // attempt 1 在 setup 期间已进入 callConnect。把 hang 打开，使
    // attempt 2 在 finally 补发后保持 in-flight，便于观察其元信息是否
    // 会被 attempt 1 的 cleanup 误清掉。
    expect(fakeCore.callConnectStartedCount).toBe(1);
    fakeCore.setHangConnect(true);

    vault.setStatus("locked");
    vault.setStatus("unlocked");

    await vi.waitFor(() => {
      expect(fakeCore.callConnectStartedCount).toBe(2);
    });

    keyspace.fireActiveChange();

    const pendingSetEvents = info.mock.calls
      .map((call) => call[0] as { event?: string; data?: Record<string, unknown> })
      .filter((entry) => entry?.event === "appmsg.connect.pending.set");
    const lastPendingSet = pendingSetEvents.at(-1);

    expect(lastPendingSet).toBeTruthy();
    expect(lastPendingSet?.data?.attemptId).toEqual(expect.any(String));
    expect(lastPendingSet?.data?.attemptId).not.toBe("");
    expect(lastPendingSet?.data?.attemptStage).toEqual(expect.any(String));
    expect(lastPendingSet?.data?.attemptStage).not.toBe("");

    const mismatchEvents = warn.mock.calls
      .map((call) => call[0] as { event?: string })
      .filter((entry) => entry?.event === "appmsg.connect.inflight_meta_mismatch");
    expect(mismatchEvents).toHaveLength(0);

    coord.dispose();
  });

  it("in-flight 期间 provider 切换两次，只采用最后一个 provider 触发新 attempt", async () => {
    // 反馈"必改"第四轮第二条：in-flight 期间 provider 切换两次（都
    // 走 onStructuralChange），必须只采用最后一个。本测试通过 fake
    // core 的 `onActiveChangeFire()` 模拟"同一 active provider
    // 又被切了一次"的事件流，验证 attempt 的补发永远只补发最后一次。
    //
    // 时序：
    //   1. setup：provider = hubmsg（默认）→ attempt 1 in-flight；
    //   2. in-flight：fire provider 切换事件 #1 →
    //      onStructuralChange 记录 pendingEpoch = epoch1；
    //   3. in-flight：fire provider 切换事件 #2 →
    //      pendingEpoch **覆盖**为 epoch2（采纳最新的）；
    //   4. attempt 1 完成 → finally → 补发 attempt 2 →
    //      structuralConnectable ok → 调 callConnect。
    //
    // fake core 不验 ownerPublicKeyHex 区分 provider（callConnect
    // 只看 outcome），所以这里只测"callConnectStartedCount 是否
    // 同步进 2"——证明补发确实发生，而不是被某一次旧事件吞掉。
    const vault = makeFakeVault();
    const keyspace = makeFakeKeyspace();
    const provider = makeFakeProvider("hubmsg");
    const fakeCore = makeFakeCore(provider, keyspace);
    fakeCore.setOutcome({ kind: "connected" });
    const coord = createReconnectCoordinator({
      core: fakeCore.core,
      vault: vault.service,
      keyspace,
      logger: { info: vi.fn(), warn: vi.fn() }
    });
    expect(fakeCore.callConnectStartedCount).toBe(1);
    // 第一次 provider 切换（in-flight 期间，pendingEpoch 入队）。
    fakeCore.onActiveChangeFire();
    expect(fakeCore.callConnectStartedCount).toBe(1);
    // 第二次 provider 切换（仍 in-flight）—— pendingEpoch 必须被**覆盖**
    // 到最新值，不能吞掉。
    fakeCore.onActiveChangeFire();
    expect(fakeCore.callConnectStartedCount).toBe(1);
    // 推进 microtask：attempt 1 完成 → finally → 补发 attempt 2 →
    // 进入 callConnect（count=2，同步）。
    await vi.waitFor(() => {
      expect(fakeCore.callConnectStartedCount).toBe(2);
    });
    fakeCore.resolveDeferredImmediately({ kind: "connected" });
    await coord.awaitInFlight();
    expect(fakeCore.connectCount).toBe(2);
    expect(fakeCore.inspectLocalDb().state).toBe("open");
    coord.dispose();
  });

});
