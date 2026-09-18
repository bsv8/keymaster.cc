// apps/web/src/keymasterSessionCoordinatorClient.ts
// Keymaster Session Coordinator Client Transport
//
// 设计缘由（施工单 002）：
//   - 版本化 URL、port 生命周期、hello 重连
//   - requestId pending map、epoch cache、subscription event 分发
//   - port 断开仅拒绝本 tab pending request，不发全局 lock

import type {
  SessionEpoch,
  CoordinatorVaultStatus,
  CoordinatorClientRequest,
  CoordinatorTopicEvent,
  CoordinatorBootstrapSnapshot,
  CoordinatorAuthorityRecovery,
  CoordinatorConnectionState,
  CoordinatorTopic,
  CoordinatorCommandResult,
  CoordinatorValueResult,
  CoordinatorTransportFailure,
  CoordinatorCryptoOperation,
  CoordinatorCryptoResult,
  CoordinatorBackgroundSyncSettings,
  CoordinatorTaskSnapshot,
  CoordinatorVaultOperation,
  CoordinatorVaultOperationResultFor,
  CoordinatorSubscribeTopicsResult,
  SessionCoordinatorClient,
  CoordinatorStorageControl,
  CoordinatorStorageData,
  P2pkhProviderRegistrySnapshot,
  P2pkhNetworkProviderSelection,
  CoordinatorSatOperation,
  CoordinatorChannelOperation,
  ContactPresenceMap,
  CoordinatorWorkerUnitStateEvent,
  CoordinatorSessionBinding,
  StorageBootstrapState,
} from "@keymaster/contracts";
import {
  COORDINATOR_RPC_CAPABILITY,
  COORDINATOR_TOPIC_STREAM_CAPABILITY,
  COORDINATOR_LOCAL_STORAGE_RPC_CAPABILITY,
} from "@keymaster/contracts";
import type {
  CoordinatorRpcRequest,
  CoordinatorRpcResponse,
  CoordinatorRpcResponseForRequest,
  CoordinatorRpcRequestFromClient,
  CoordinatorSessionOpenRequest,
  CoordinatorSessionCloseRequest,
  CoordinatorLocalStorageRequest,
  CoordinatorLocalStorageResponse,
  CoordinatorClientCommandRequest,
  P2pkhProviderConfig,
} from "@keymaster/contracts";
import type {
  CoordinatorOwnerStorageData,
  CoordinatorPlatformStorageData,
  StorageBindingCoordinatorClient,
  StorageOwnerGrant,
  StoragePlatformGrant
} from "@keymaster/contracts/storage-internal";
import { parseCoordinatorResponseFor, toCoordinatorRpcRequest } from "@keymaster/contracts";
import { createDeviceRecordRepository, createIndexedDbBucketProvider, defaultDeviceStorage, ensureSessionId, readSession, StorageRuntimeError, writeSession } from "@keymaster/platform-storage/coordinator";
import {
  connectSharedWorker,
  definePlugin,
  WebLoomError,
  type HandlerCallContext,
  type RuntimeDrainResult,
  type RuntimeHandle,
  type RuntimePluginDefinition,
  type WindowApp,
  type PluginIntentCommand,
  type PluginIntentSnapshot,
  type PluginIntentSubmissionResult,
} from "webloom-framework";
import * as WebLoomFramework from "webloom-framework";
import coordinatorWorkerUrl from "./keymasterSessionCoordinator.worker.ts?sharedworker&url";

/**
 * SharedWorker 的共享边界必须与设备引导 profile 一致：同一个 profile
 * 的多个 tab 继续共享 Coordinator，而不同的 Chromium storage context
 * 不能因为 URL 相同而互相污染首次初始化状态。
 */

/**
 * 旧 registry 包可能没有浏览器运行锁。不能把未知 runtimeLock 字段传给它
 * 再假设已经安全；生产页面先检查当前 WebLoom 包的能力标记，旧包直接拒绝连接。
 * 单测使用显式的 WebLoom testing 入口，不需要依赖 registry 包版本。
 */
function hasWebLoomRuntimeLock(): boolean {
  return typeof Reflect.get(WebLoomFramework as object, "WEBLOOM_RUNTIME_LOCK_PREFIX") === "string";
}

function isTestBuild(): boolean {
  return (import.meta as ImportMeta & { env?: { MODE?: string } }).env?.MODE === "test";
}

function runtimeLockUserMessage(snapshot: unknown): string | undefined {
  const code = snapshot && typeof snapshot === "object"
    ? (snapshot as { errorCode?: unknown }).errorCode
    : undefined;
  if (code === "runtime_lock_conflict") return "检测到另一个 Keymaster Runtime 正在运行。请刷新或关闭所有 Keymaster 页面后重新打开。";
  if (code === "runtime_lock_unavailable") return "当前浏览器不支持 Keymaster 运行锁，无法安全启动 Coordinator。请使用支持 Web Locks 的浏览器。";
  return undefined;
}

/** 为同一浏览器分配稳定的 SharedWorker 名称片段；身份来自 keymaster.session。 */
async function ensureCoordinatorWorkerProfileId(): Promise<string | undefined> {
  try {
    return ensureSessionId(defaultDeviceStorage());
  } catch {
    return undefined;
  }
}

// ============================================================
// 1. Client Types
// ============================================================

export interface CoordinatorClientOptions {
  workerName?: string;
  workerUrl?: string;
  clientId?: string;
  requestTimeoutMs?: number;
  reconnectIntervalMs?: number;
}

export interface RecoverableCoordinatorDiagnostic {
  kind: string;
  status: string;
  message: string;
  sessionEpoch: SessionEpoch;
  connected: boolean;
}

type EventListener<T> = (event: T) => void;

type CoordinatorDispatchStatus = "not-dispatched" | "unknown";
type CoordinatorSendError = Error & {
  dispatchStatus?: CoordinatorDispatchStatus;
  /** 请求在本页面 DTO 校验阶段失败，尚未进入 Runtime。 */
  requestValidation?: boolean;
};

export type { CoordinatorConnectionState };

function sameCoordinatorSessionBinding(left: CoordinatorSessionBinding | null | undefined, right: CoordinatorSessionBinding | null | undefined): boolean {
  return left !== null && left !== undefined && right !== null && right !== undefined
    && left.peerGeneration === right.peerGeneration
    && left.sessionEpoch === right.sessionEpoch
    && left.leaseId === right.leaseId;
}

function coordinatorKindMayHaveSideEffects(kind: CoordinatorClientRequest["kind"]): boolean {
  switch (kind) {
    case "contacts.presence.snapshot":
    case "plugin.intent.snapshot":
    case "p2pkh.providers.get":
    case "p2pkh.provider-config.get":
      return false;
    default:
      // Commands such as background.run-now, grants, storage mutations and
      // protocol operations can duplicate work if an unknown transport error
      // is retried. Keep them non-retryable unless dispatch is known absent.
      return true;
  }
}

function requiredCoordinatorOperationResult<T>(response: { operationResult?: T }, kind: string): T {
  if (!Object.prototype.hasOwnProperty.call(response, "operationResult")) {
    throw new Error(`Coordinator ${kind} response omitted operationResult`);
  }
  return response.operationResult as T;
}

function coordinatorSendError(message: string, dispatchStatus: CoordinatorDispatchStatus): CoordinatorSendError {
  const error = new Error(message) as CoordinatorSendError;
  error.dispatchStatus = dispatchStatus;
  return error;
}

let fallbackIdentifierCounter = 0;
function randomIdentifierSuffix(): string {
  try {
    return Array.from(crypto.getRandomValues(new Uint32Array(2)), (value) => value.toString(36)).join("");
  } catch {
    fallbackIdentifierCounter += 1;
    return fallbackIdentifierCounter.toString(36);
  }
}

/**
 * 真实 Chromium 生命周期回归用的 Window bridge barrier。
 *
 * 它只存在于 E2E 构建会导入的测试 hook 路径：下一次反向 LocalStorage
 * capability 到达页面后先报告 started，再等待测试显式 release。等待故意
 * 不读取 AbortSignal，用来制造“页面已经撤权但旧 Worker 结果仍迟到”的
 * 真实 MessagePort 时序；生产构建不会安装或调用这个 seam。
 */
export interface CoordinatorTestBridgeBarrier {
  readonly started: Promise<void>;
  /** 真实 Window handler 返回后 resolve；用于证明 late response 已完成清理。 */
  readonly completed: Promise<void>;
  release(): void;
}

let coordinatorTestBridgeBarrier: {
  readonly started: Promise<void>;
  readonly released: Promise<void>;
  readonly complete: () => void;
  readonly start: () => void;
  readonly release: () => void;
} | undefined;

/** 仅供 lifecycleE2E hook 使用；普通应用代码不得调用。 */
export function __testArmCoordinatorBridgeBarrier(): CoordinatorTestBridgeBarrier {
  if (coordinatorTestBridgeBarrier) throw new Error("Coordinator bridge test barrier is already armed");
  let start!: () => void;
  let release!: () => void;
  let complete!: () => void;
  const started = new Promise<void>((resolve) => { start = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const completed = new Promise<void>((resolve) => { complete = resolve; });
  coordinatorTestBridgeBarrier = { started, released, complete, start, release };
  return Object.freeze({
    started,
    completed,
    release: () => {
      coordinatorTestBridgeBarrier = undefined;
      release();
    },
  });
}

// ============================================================
// 2. Coordinator Client
// ============================================================

export class KeymasterSessionCoordinatorClient implements SessionCoordinatorClient, StorageBindingCoordinatorClient {
  /** WebLoom RuntimeHandle；Coordinator 所有方向均复用其 typed transport。 */
  private runtimeHandle: RuntimeHandle | null = null;
  private removeRuntimeSubscription: (() => void) | undefined;
  /** 页面 WindowApp 必须先于 SharedWorker 连接建立并保持到重连结束。 */
  private windowApp: WindowApp | null = null;
  /** 页面端维护的当前 Coordinator 本地 I/O 租约；不进入任何 wire DTO。 */
  private localStorageBridgeLease: { bucketId?: string; leaseId: string; bucketGeneration: number } | null = null;
  /** Worker 在 session.open 提交后发放的完整 peer/session fencing binding。 */
  private sessionBinding: CoordinatorSessionBinding | null = null;
  /** session.open 期间 Worker 可能先反向调用 Window bridge；先暂存其 binding。 */
  private pendingSessionBinding: CoordinatorSessionBinding | null = null;
  /** 当前 peer 的 typed topic stream；重连/撤销后永久失效。 */
  private topicSubscription: import("webloom-framework").StreamSubscription<CoordinatorTopicEvent> | null = null;
  private clientId: string;
  private workerName?: string;
  private workerUrl?: string;
  private requestTimeoutMs: number;
  private reconnectIntervalMs: number;

  private bootstrapSnapshotCache: CoordinatorBootstrapSnapshot = {
    authorityInstanceId: "authority:boot",
    sessionEpoch: "boot",
    vaultStatus: "booting",
    keyspaceGeneration: 0,
    taskSnapshots: [],
    scheduleSettings: { assetHoldingsIntervalMs: 900_000 },
    p2pkhProviders: undefined,
  };

  private eventListeners = new Map<string, Set<EventListener<CoordinatorTopicEvent>>>();
  private topicCaches = new Map<CoordinatorTopic, CoordinatorTopicEvent>();
  private sessionRevisionCache = -1;
  private backgroundSnapshotRevisionCache = -1;
  private assetDataRevisionCache = -1;
  private storageRevisionCache = -1;
  private msfileRevisionCache = -1;
  private p2pkhProviderRevisionCache = -1;
  private satRevisionCache = -1;
  private channelRevisionCache = -1;
  private contactsPresenceRevisionCache = -1;
  private pluginIntentRevisionCache = -1;
  private pluginIntentAuthorityInstanceId = "authority:boot";
  /**
   * Worker 单元事件可能先于同一 session.state 到达；先按 sessionEpoch
   * 暂存，避免为了丢弃旧世代而误丢当前世代的合法快照。集合有界，
   * 不把断线期间的事件变成长期缓存。
   */
  private pendingWorkerUnitEvents = new Map<SessionEpoch, CoordinatorWorkerUnitStateEvent>();
  private contactsPresenceOwnerPublicKeyHex: string | null = null;
  private contactsPresenceSnapshotCache: ContactPresenceMap = {};

  private isConnected = false;
  private connectionState: CoordinatorConnectionState = "recoverable";
  /** 页面生命周期结束后，连接尝试和自动重连都不得再次复活。 */
  private shutdownRequested = false;
  /** 使 disconnect() 能取消尚未完成的 connect/hello/subscription 链。 */
  private connectionAttempt = 0;
  /**
   * 当前 connect() 观察到的 Runtime/Worker 端连接失败。
   *
   * 结构化的 WebLoom runtime-error 会带自己的 message；而原始 SharedWorker
   * 脚本执行失败只会让 WebLoom 发出 disconnected；公共 Runtime API 不读取
   * 浏览器 JS ErrorEvent 文本。后者只能提供明确的可操作诊断，不能假装
   * 捕获到了浏览器的 JS exception 文本。
   */
  private observedConnectionFailure: Error | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private recoverableDiagnostics: RecoverableCoordinatorDiagnostic[] = [];

  constructor(options: CoordinatorClientOptions = {}) {
    // workerName 显式传入时由宿主完全控制；默认名称在 connect() 中按
    // localStorage profile 生成，使同一发布的多个 tab 仍共享，而独立
    // Chromium storage context 不会复用另一个 context 的 Worker 状态。
    this.workerName = options.workerName;
    this.workerUrl = options.workerUrl;
    this.clientId = options.clientId ?? this.generateClientId();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.reconnectIntervalMs = options.reconnectIntervalMs ?? 5_000;
  }

  /**
   * 绑定已经完成本地初始化的 WindowApp。必须在首次 connect() 之前调用；
   * 重连复用同一个 App，使反向 LocalStorage capability 的 handler 与其
   * 生命周期保持一致。
   */
  setWindowApp(app: WindowApp): void {
    if (this.windowApp && this.windowApp !== app) throw new Error("Coordinator client WindowApp cannot be replaced");
    this.windowApp = app;
    this.beginLocalStorageLease();
  }

  /** 页面端只提供 Coordinator 所需的一个 typed LocalStorage capability。 */
  createWindowStoragePlugin(): RuntimePluginDefinition {
    const client = this;
    return definePlugin({
      id: "keymaster.coordinator.local-storage",
      name: "Keymaster Coordinator LocalStorage",
      runtime: "window-main",
      unitId: "keymaster.coordinator.local-storage",
      provides: [COORDINATOR_LOCAL_STORAGE_RPC_CAPABILITY],
      startup: "required",
      defaultEnabled: true,
      canDisable: false,
      setup(ctx) {
        ctx.handle(COORDINATOR_LOCAL_STORAGE_RPC_CAPABILITY, (request, call) => client.handleLocalStorageCapabilityRequest(request, call));
      },
    });
  }

  // ============================================================
  // 3. Connection Management
  // ============================================================

  async connect(): Promise<void> {
    if (this.shutdownRequested) throw new Error("Coordinator client is shut down");
    if (this.isConnected) return;
    const windowApp = this.windowApp;
    if (!windowApp) throw new Error("Coordinator client requires a WindowApp before connect()");
    const attempt = ++this.connectionAttempt;
    this.connectionState = "starting";
    this.observedConnectionFailure = undefined;
    this.sessionBinding = null;
    this.pendingSessionBinding = null;

    try {
      if (!hasWebLoomRuntimeLock() && !isTestBuild()) {
        this.connectionState = "fatal";
        throw new Error("当前加载的 WebLoom 版本不支持浏览器运行锁，无法安全启动 Coordinator。请刷新页面并更新到包含 Web Locks 的版本；旧包不能无锁运行。");
      }
      // WebLoom 是唯一的物理连接与 call/stream transport。领域 client 只
      // 保留重连策略和产品状态缓存，不再读取或监听 Runtime 裸端口。
      const isDevelopment = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV === true;
      const workerUrl = new URL(
        this.workerUrl ?? coordinatorWorkerUrl,
        typeof globalThis.location?.href === "string" ? globalThis.location.href : import.meta.url,
      );
      const workerProfileId = !this.workerName && !this.workerUrl
        ? await ensureCoordinatorWorkerProfileId()
        : undefined;
      const workerName = this.workerName ?? (!this.workerUrl
        ? `${isDevelopment ? "keymaster-coordinator-dev" : "keymaster-coordinator"}:${workerProfileId ?? "default"}`
        : undefined);
      let runtimePublishedReady = false;
      const runtime = connectSharedWorker({
        id: "keymaster-coordinator",
        url: workerUrl,
        ...(workerName ? { name: workerName } : {}),
        defaultCallTimeoutMs: this.requestTimeoutMs,
        client: {
          app: windowApp,
          expose: [COORDINATOR_LOCAL_STORAGE_RPC_CAPABILITY],
        },
      });
      this.runtimeHandle = runtime;
      this.removeRuntimeSubscription?.();
      this.removeRuntimeSubscription = runtime.subscribe((snapshot) => {
        if (this.runtimeHandle !== runtime) return;
        if (snapshot.state === "ready") runtimePublishedReady = true;
        if (snapshot.state === "failed" || snapshot.state === "disconnected") {
          const lockMessage = runtimeLockUserMessage(snapshot);
          const message = lockMessage
            ?? `Coordinator Runtime ${snapshot.state}${snapshot.error ? `: ${snapshot.error}` : ""}`;
          this.observedConnectionFailure = snapshot.state === "disconnected" && !runtimePublishedReady
            ? new Error("Coordinator SharedWorker failed before publishing a ready Runtime snapshot; inspect the Worker console")
            : new Error(message);
          this.handleWorkerError(message);
        }
      });

      this.beginLocalStorageLease();
      this.isConnected = true;
      await this.sendHello();
      await this.subscribeTopicsAndReadBaselines(["session.state", "background.snapshot", "asset.data-changed", "storage.state", "p2pkh.providers", "msfile.state", "sat.events", "channel.events", "contacts.presence", "plugin.intent", "worker.units"]);

      if (this.shutdownRequested || attempt !== this.connectionAttempt || this.runtimeHandle !== runtime) {
        throw new Error("Coordinator connection attempt was cancelled");
      }

      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.connectionState = "ready";
    } catch (err) {
      // 只有明确出现新 attempt 才吞掉旧连接错误。
      if (attempt !== this.connectionAttempt) return;
      const observedFailure = this.observedConnectionFailure;
      this.isConnected = false;
      const fatal = (this.connectionState as CoordinatorConnectionState) === "fatal";
      if (!fatal) this.connectionState = "recoverable";
      this.removeRuntimeSubscription?.();
      this.removeRuntimeSubscription = undefined;
      const runtime = this.runtimeHandle;
      this.runtimeHandle = null;
      this.closeSessionBestEffort(runtime);
      if (runtime) void runtime.dispose("Coordinator connection attempt failed");
      this.topicSubscription?.cancel("Coordinator connection attempt failed");
      this.topicSubscription = null;
      if (!this.shutdownRequested && !fatal) this.scheduleReconnect();
      // Runtime 端已经给出结构化错误，或在 ready snapshot 前断线时已经
      // 生成可操作诊断，不能用随后 hello call 的 timeout 覆盖它。若只有
      // call 层错误，则保留原有错误。
      throw observedFailure ?? err;
    }
  }

  private disconnectInternal(closePortAfterMs: number | undefined): void {
    void closePortAfterMs;
    this.connectionAttempt += 1;
    this.topicSubscription?.cancel("Coordinator client disconnected");
    this.topicSubscription = null;
    this.removeRuntimeSubscription?.();
    this.removeRuntimeSubscription = undefined;
    const runtime = this.runtimeHandle;
    this.runtimeHandle = null;
    // Invoke session.close while the Runtime peer is still alive. The call is
    // deliberately best-effort: pagehide cannot await a promise, but invoking
    // the typed call before dispose gives WebLoom a chance to post the fence.
    this.closeSessionBestEffort(runtime);
    if (runtime) void runtime.dispose("Coordinator client disconnected");

    this.isConnected = false;
    this.connectionState = this.shutdownRequested ? "fatal" : "recoverable";
    this.disposeLocalStorageBridge();
    this.resetDisconnectedState();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  disconnect(): void {
    this.disconnectInternal(100);
  }

  /** 页面/Worker 永久销毁边界；与可重用的业务 disconnect 区分。 */
  shutdown(): void {
    if (this.shutdownRequested) return;
    this.shutdownRequested = true;
    // 这是页面/Worker 的永久生命周期边界，不是可重用的业务断线。
    // 不在这里定时 close 端口，给 unload 场景中的 disconnect 控制消息
    // 留出浏览器实现允许的投递机会。
    this.disconnectInternal(undefined);
  }

  private scheduleReconnect(): void {
    if (this.shutdownRequested) return;
    if (this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shutdownRequested) return;
      void this.connect().catch(() => {
        if (!this.shutdownRequested) this.scheduleReconnect();
      });
    }, this.reconnectIntervalMs);
  }

  // ============================================================
  // 4. Message Handling
  // ============================================================

  /** 将 typed RPC 的领域结果合并进产品快照；不再由 transport listener 调用。 */
  private applyCoordinatorResponse(response: CoordinatorRpcResponse, snapshot?: CoordinatorBootstrapSnapshot): void {
    this.bootstrapSnapshotCache.sessionEpoch = response.sessionEpoch;
    if (snapshot) {
      if (typeof snapshot.authorityInstanceId === "string" && snapshot.authorityInstanceId.length > 0) {
        this.adoptPluginIntentAuthority(snapshot.authorityInstanceId);
      }
      this.bootstrapSnapshotCache = {
        ...this.bootstrapSnapshotCache,
        ...snapshot,
        taskSnapshots: [...snapshot.taskSnapshots],
        ...(snapshot.coordinatorWorkerUnits
          ? { coordinatorWorkerUnits: snapshot.coordinatorWorkerUnits.map((unit) => ({ ...unit, serviceIds: [...unit.serviceIds], taskIds: [...unit.taskIds] })) }
          : {}),
      };
      if (this.localStorageBridgeLease) {
        // 首个桶刚由页面提交时，Worker 的快照还没有 Root，因此 storage
        // 事件中的空 bucket 不能清掉页面刚从目录建立的临时租约。
        if (snapshot.storageBucketId) {
          this.localStorageBridgeLease.bucketId = snapshot.storageBucketId;
          this.localStorageBridgeLease.bucketGeneration = snapshot.storageBucketGeneration ?? 0;
        } else if (!this.localStorageBridgeLease.bucketId) {
          this.localStorageBridgeLease.bucketGeneration = 0;
        }
      }
      if (snapshot.pluginIntent) this.cachePluginIntentSnapshot(snapshot.pluginIntent, snapshot.authorityInstanceId);
    }
  }

  private adoptPluginIntentAuthority(authorityInstanceId: string): void {
    if (!authorityInstanceId || authorityInstanceId === this.pluginIntentAuthorityInstanceId) return;
    this.pluginIntentAuthorityInstanceId = authorityInstanceId;
    this.pluginIntentRevisionCache = -1;
  }

  private cachePluginIntentSnapshot(snapshot: PluginIntentSnapshot, authorityInstanceId = this.pluginIntentAuthorityInstanceId): void {
    if (
      !snapshot
      || !Number.isSafeInteger(snapshot.revision)
      || snapshot.revision < 0
      || !snapshot.desiredEnabled
      || typeof snapshot.desiredEnabled !== "object"
      || Array.isArray(snapshot.desiredEnabled)
      || !snapshot.desiredRevision
      || typeof snapshot.desiredRevision !== "object"
      || Array.isArray(snapshot.desiredRevision)
    ) return;
    if (authorityInstanceId !== this.pluginIntentAuthorityInstanceId) return;
    if (snapshot.revision < this.pluginIntentRevisionCache) return;
    this.pluginIntentRevisionCache = snapshot.revision;
    this.bootstrapSnapshotCache = {
      ...this.bootstrapSnapshotCache,
      pluginIntent: {
        revision: snapshot.revision,
        desiredEnabled: { ...snapshot.desiredEnabled },
        desiredRevision: { ...snapshot.desiredRevision },
      },
    };
  }

  private deferWorkerUnitEvent(event: CoordinatorWorkerUnitStateEvent): void {
    const previous = this.pendingWorkerUnitEvents.get(event.sessionEpoch);
    if (!previous || event.workerUnitRevision > previous.workerUnitRevision) {
      this.pendingWorkerUnitEvents.set(event.sessionEpoch, event);
    }
    // 只保留极少数候选世代，防止失联或恶意乱序事件在页面内累积。
    while (this.pendingWorkerUnitEvents.size > 4) {
      const oldest = this.pendingWorkerUnitEvents.keys().next().value as SessionEpoch | undefined;
      if (oldest === undefined) break;
      this.pendingWorkerUnitEvents.delete(oldest);
    }
  }

  private handleWorkerError(message: string): void {
    this.isConnected = false;
    if (this.connectionState !== "fatal") this.connectionState = "recoverable";
    this.removeRuntimeSubscription?.();
    this.removeRuntimeSubscription = undefined;
    const runtime = this.runtimeHandle;
    this.runtimeHandle = null;
    this.closeSessionBestEffort(runtime);
    if (runtime) void runtime.dispose(message);
    this.topicSubscription?.cancel(message);
    this.topicSubscription = null;
    this.disposeLocalStorageBridge();
    this.resetDisconnectedState();
    this.clearDisconnectedAuthorityRecovery();
    if (!this.shutdownRequested) this.scheduleReconnect();
  }

  private resetDisconnectedState(): void {
    // Keep the last truthful bootstrap/topic cache for diagnostics and UI
    // continuity. New Runtime baselines are accepted after the revision
    // trackers below are reset, so cached data cannot authorize a request.
    this.sessionRevisionCache = -1;
    this.backgroundSnapshotRevisionCache = -1;
    this.assetDataRevisionCache = -1;
    this.storageRevisionCache = -1;
    this.msfileRevisionCache = -1;
    this.p2pkhProviderRevisionCache = -1;
    this.satRevisionCache = -1;
    this.channelRevisionCache = -1;
    this.contactsPresenceRevisionCache = -1;
    this.pluginIntentRevisionCache = -1;
    this.pendingWorkerUnitEvents.clear();
  }

  private clearDisconnectedAuthorityRecovery(): void {
    const { authorityRecovery: _authorityRecovery, ...safeSnapshot } = this.bootstrapSnapshotCache;
    this.bootstrapSnapshotCache = safeSnapshot;
  }

  // ============================================================
  // 5. RPC Methods
  // ============================================================

  private disposeLocalStorageBridge(): void {
    this.localStorageBridgeLease = null;
    this.sessionBinding = null;
    this.pendingSessionBinding = null;
  }

  /** 从 keymaster.session + keymaster.device.<ID> 组装 hello 绑定；不完整时返回 undefined。 */
  private readStorageBootstrapBinding(): StorageBootstrapState | undefined {
    try {
      const storage = defaultDeviceStorage();
      const session = readSession(storage);
      if (!session?.activeBucketId) return undefined;
      const record = createDeviceRecordRepository(storage).read(session.activeBucketId);
      if (!record) return undefined;
      return {
        selectedBackend: record.location.providerId,
        selectedProfileId: session.activeBucketId,
        selectedBucket: {
          bucketId: session.activeBucketId,
          backend: record.location.providerId,
          ...(record.displayName === undefined ? {} : { label: record.displayName }),
          deviceRecord: record,
          ...(session.keyDerivation === undefined ? {} : { keyDerivation: session.keyDerivation }),
        },
      };
    } catch {
      return undefined;
    }
  }

  private beginLocalStorageLease(): void {
    if (this.localStorageBridgeLease) return;
    let selectedBucketId: string | undefined;
    try {
      selectedBucketId = readSession(defaultDeviceStorage())?.activeBucketId;
    } catch {
      // 目录错误由实际 I/O 返回；这里不能把它伪装成一个合法桶。
    }
    this.localStorageBridgeLease = {
      ...(selectedBucketId ? { bucketId: selectedBucketId } : {}),
      leaseId: `local-storage-${randomIdentifierSuffix()}`,
      bucketGeneration: this.bootstrapSnapshotCache.storageBucketGeneration ?? (selectedBucketId ? 1 : 0)
    };
  }

  private async handleLocalStorageCapabilityRequest(
    request: CoordinatorLocalStorageRequest,
    call: HandlerCallContext,
  ): Promise<CoordinatorLocalStorageResponse> {
    const signal = call.signal;
    const lease = this.localStorageBridgeLease;
    if (!lease) throw new StorageRuntimeError("storage_forbidden", "Local storage bridge lease is unavailable");
    const requestBinding = request.peerGeneration !== undefined
      && request.sessionEpoch !== undefined
      && request.leaseId !== undefined
      ? {
          peerGeneration: request.peerGeneration,
          sessionEpoch: request.sessionEpoch,
          leaseId: request.leaseId,
        }
      : undefined;
    if (!requestBinding
      || !Number.isSafeInteger(requestBinding.peerGeneration)
      || requestBinding.peerGeneration < 1
      || requestBinding.sessionEpoch.length === 0
      || requestBinding.leaseId.length === 0) {
      throw new WebLoomError("service_reference_stale", "Local storage bridge request has no complete session binding", "execute");
    }
    if (requestBinding.leaseId !== lease.leaseId) {
      throw new WebLoomError("service_reference_stale", "Local storage bridge lease is stale", "execute");
    }
    if (this.sessionBinding && !sameCoordinatorSessionBinding(this.sessionBinding, requestBinding)) {
      throw new WebLoomError("service_reference_stale", "Local storage bridge session binding is stale", "execute");
    }
    if (this.sessionBinding === null) {
      if (this.pendingSessionBinding && !sameCoordinatorSessionBinding(this.pendingSessionBinding, requestBinding)) {
        throw new WebLoomError("service_reference_stale", "Local storage bridge pending binding changed", "execute");
      }
      this.pendingSessionBinding ??= requestBinding;
    }
    const bridgeBarrier = coordinatorTestBridgeBarrier;
    if (bridgeBarrier) {
      // Consume before awaiting so a second reverse call cannot join this
      // deliberately held request. The test release is the only completion
      // path; this models an AbortSignal-ignoring late browser callback.
      coordinatorTestBridgeBarrier = undefined;
      bridgeBarrier.start();
      await bridgeBarrier.released;
    }
    try {
      if (request.type === "device-record-list"
        || request.type === "device-record-get"
        || request.type === "device-record-put"
        || request.type === "device-record-delete"
        || request.type === "session-read"
        || request.type === "session-write") {
        if (signal.aborted) throw new StorageRuntimeError("storage_unavailable", "Storage operation was cancelled");
        const storage = defaultDeviceStorage();
        if (request.type === "session-read") {
          const session = readSession(storage);
          return session ? { type: "session", session } : { type: "session" };
        }
        if (request.type === "session-write") {
          writeSession(request.session, storage);
          return { type: "void" };
        }
        const repository = createDeviceRecordRepository(storage);
        if (request.type === "device-record-list") {
          const result = repository.list();
          return { type: "device-records", entries: result.entries, invalidKeys: result.invalidKeys };
        }
        if (request.type === "device-record-get") {
          const deviceRecord = repository.read(request.remoteStorageId);
          return deviceRecord ? { type: "device-record", record: deviceRecord } : { type: "device-record" };
        }
        if (request.type === "device-record-put") {
          repository.put(request.remoteStorageId, request.record, request.replace === undefined ? {} : { replace: request.replace });
          return { type: "void" };
        }
        repository.delete(request.remoteStorageId);
        return { type: "void" };
      }
      const isObjectRequest = request.type === "get"
        || request.type === "list"
        || request.type === "put"
        || request.type === "delete";
      if (!isObjectRequest) throw new StorageRuntimeError("storage_provider_error", "Local storage bridge request is invalid");
      // 初始设置/连接阶段 session 还没有 active 桶(lease.bucketId 为空)：
      // 此时 Worker 只能按未选桶的租约访问它正在创建/探测的命名空间。
      // 一旦 session 选中了桶,必须严格匹配,拒绝旧租约访问别的桶。
      if (lease.bucketId !== undefined && request.bucketId !== lease.bucketId) {
        throw new StorageRuntimeError("storage_forbidden", "Local storage bridge lease is no longer current");
      }
      // Local 桶的物理介质是 IndexedDB；页面是唯一执行点，Worker 只持
      // 有受 lease 保护的桥。设备记录与 session 仍走上面的 localStorage
      // 引导分支，两者不混用同一介质。
      const provider = createIndexedDbBucketProvider({ bucketId: request.bucketId });
      let response: CoordinatorLocalStorageResponse;
      try {
        if (request.type === "get") {
          response = { type: "object", object: await provider.get(request.path, { ...(request.ifMatch ? { ifMatch: request.ifMatch } : {}), signal }) };
        } else if (request.type === "list") {
          response = { type: "list", ...(await provider.list({ prefix: request.prefix, cursor: request.cursor, limit: request.limit, signal })) };
        } else if (request.type === "put") {
          response = { type: "write", ...(await provider.put(request.path, request.bytes, { ...request.condition, signal })) };
        } else {
          await provider.delete(request.path, { ...(request.ifMatch ? { ifMatch: request.ifMatch } : {}), signal });
          response = { type: "void" };
        }
      } finally {
        provider.dispose();
      }
      if (signal.aborted) throw new StorageRuntimeError("storage_unavailable", "Storage operation was cancelled");
      return response;
    } catch (error) {
      // WebLoom 只会在线上传递 WebLoomError.code；直接抛 StorageRuntimeError
      // 会退化成 handler_failed，使 Worker 丢失 storage_conflict 等 CAS 语义。
      if (error instanceof WebLoomError) throw error;
      if (error instanceof StorageRuntimeError) {
        throw new WebLoomError(error.code, "Local storage capability operation failed", "execute");
      }
      throw new StorageRuntimeError("storage_provider_error", error instanceof Error ? error.message : "Local storage bridge request failed");
    } finally {
      // 这个 resolve 只用于隔离 lifecycle E2E：它位于 handler 的 finally，
      // 因而比 release() 更强，证明迟到请求已经完成页面侧真实清理。
      bridgeBarrier?.complete();
    }
  }

  /** 当前 WebLoom SharedWorker 句柄；重连后旧句柄永不复用。 */
  getRuntimeHandle(): RuntimeHandle | undefined {
    return this.runtimeHandle ?? undefined;
  }

  /**
   * 先取消领域 topic stream，再等待 WebLoom Runtime 的 bounded close ack。
   *
   * topic stream 的 async iterator 必须先收到 cancel，Worker 才能结束其
   * provider execution slot；否则仅调用 Runtime.drain 会在 Worker 等待该
   * iterator 的 close 时进入 deadline。正式断线仍由 disconnect() 完成，
   * 此方法只给需要观察 close 结果的生命周期验收/宿主使用。
   */
  drainRuntime(timeoutMs?: number): Promise<RuntimeDrainResult | undefined> {
    const runtime = this.runtimeHandle;
    if (!runtime) return Promise.resolve(undefined);
    this.topicSubscription?.cancel("Coordinator Runtime drain requested");
    this.topicSubscription = null;
    return runtime.drain(timeoutMs);
  }

  private closeSessionBestEffort(runtime: RuntimeHandle | null): void {
    const lease = this.localStorageBridgeLease;
    const binding = this.sessionBinding;
    if (!runtime || !lease || !binding || binding.leaseId !== lease.leaseId) return;
    const request: CoordinatorSessionCloseRequest = {
      kind: "session.close",
      peerGeneration: binding.peerGeneration,
      sessionEpoch: binding.sessionEpoch,
      leaseId: binding.leaseId,
    };
    try {
      // Calling the typed capability synchronously queues the WebLoom call
      // before RuntimeHandle.dispose revokes this peer. Unload paths cannot
      // await the returned Promise, so the result is intentionally ignored.
      void runtime.capability(COORDINATOR_RPC_CAPABILITY).call(request, {
        operationId: `session-close:${this.clientId}:${randomIdentifierSuffix()}`,
        timeoutMs: Math.min(this.requestTimeoutMs, 2_000),
      }).catch(() => undefined);
    } catch {
      // Best effort only; physical Scope revoke remains the Worker fence.
    }
  }

  private async sendHello(): Promise<void> {
    const lease = this.localStorageBridgeLease;
    if (!lease) throw coordinatorSendError("Coordinator LocalStorage lease is unavailable", "not-dispatched");
    const storageBootstrapState = this.readStorageBootstrapBinding();
    const request: CoordinatorSessionOpenRequest = {
      kind: "session.open",
      leaseId: lease.leaseId,
      ...(storageBootstrapState === undefined ? {} : { storageBootstrapState }),
    };
    const response = await this.sendTypedRequest(request);
    if (response.ack.status !== "ok") {
      throw coordinatorSendError("Coordinator session.open was not accepted", "unknown");
    }
    const binding = requiredCoordinatorOperationResult(response, "session.open").sessionBinding;
    if (!binding || binding.leaseId !== lease.leaseId) {
      this.connectionState = "fatal";
      throw coordinatorSendError("Coordinator session.open returned an invalid session binding", "unknown");
    }
    if (this.pendingSessionBinding && !sameCoordinatorSessionBinding(this.pendingSessionBinding, binding)) {
      this.connectionState = "fatal";
      throw coordinatorSendError("Coordinator session.open binding disagrees with the Window bridge", "unknown");
    }
    this.sessionBinding = { ...binding };
    this.pendingSessionBinding = null;
    this.applyCoordinatorResponse(response, response.operationResult);
  }

  private async subscribeTopicsAndReadBaselines(topics: CoordinatorTopic[]): Promise<void> {
    const runtime = this.runtimeHandle;
    if (!runtime) throw coordinatorSendError("Coordinator Runtime is unavailable", "not-dispatched");
    this.topicSubscription?.cancel("Coordinator topic subscription replaced");
    const stream = runtime.capability(COORDINATOR_TOPIC_STREAM_CAPABILITY);
    const subscription = stream.subscribe({ topics }, {
      initialCredit: 16,
      timeoutMs: this.requestTimeoutMs,
      operationId: `coordinator-topics:${this.clientId}`,
      onNext: (event) => { this.applyTopicEvent(event); },
    });
    this.topicSubscription = subscription;
    // A typed stream parser can reject an item before onNext is invoked. Treat
    // that as a lost Coordinator boundary and clear all cached authority
    // state; otherwise a malformed event could leave the previous recovery
    // diagnostic visible indefinitely.
    void subscription.closed.catch((cause) => {
      if (this.topicSubscription !== subscription || !this.isConnected) return;
      this.handleWorkerError(`Coordinator topic stream failed${cause instanceof Error ? `: ${cause.message}` : ""}`);
    });
    await subscription.ready;
  }

  async unlock(password: string, publicKeyHex?: string): Promise<CoordinatorCommandResult> {
    const request: CoordinatorClientRequest = {
      kind: "unlock",
      clientId: this.clientId,
      requestId: this.generateRequestId(),
      password,
      publicKeyHex,
      expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch,
    };
    return this.requestCommand(request);
  }

  async lock(): Promise<CoordinatorCommandResult> {
    const request: CoordinatorClientRequest = {
      kind: "lock",
      clientId: this.clientId,
      requestId: this.generateRequestId(),
      expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch,
    };
    return this.requestCommand(request);
  }

  async activateKey(password: string, publicKeyHex: string): Promise<CoordinatorCommandResult> {
    const request: CoordinatorClientRequest = {
      kind: "activate-key",
      clientId: this.clientId,
      requestId: this.generateRequestId(),
      password,
      publicKeyHex,
      expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch,
    };
    return this.requestCommand(request);
  }

  async vaultOperation<O extends CoordinatorVaultOperation>(operation: O): Promise<CoordinatorValueResult<CoordinatorVaultOperationResultFor<O>>> {
    const request = { kind: "vault.operation" as const, clientId: this.clientId, requestId: this.generateRequestId(), operation, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch };
    try {
      const response = await this.sendRequest(request);
      if (response.ack.status !== "ok") return response.ack;
      return {
        status: "ok",
        value: requiredCoordinatorOperationResult<CoordinatorVaultOperationResultFor<O>>(response, request.kind),
        sessionEpoch: response.sessionEpoch,
      };
    } catch (cause) {
      return this.normalizeTransportFailure(request.kind, cause);
    }
  }

  async crypto(operation: CoordinatorCryptoOperation): Promise<{
    ack: CoordinatorCommandResult;
    result?: CoordinatorCryptoResult;
  }> {
    const request = {
      kind: "crypto",
      clientId: this.clientId,
      requestId: this.generateRequestId(),
      operation,
      expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch,
    } as const;
    try {
      const response = await this.sendRequest(request);
      if (response.ack.status !== "ok" || !response.cryptoResult) return { ack: response.ack };
      return { ack: response.ack, result: response.cryptoResult };
    } catch (cause) {
      return { ack: this.normalizeTransportFailure(request.kind, cause) };
    }
  }

  async backgroundRunNow(taskId: string): Promise<CoordinatorCommandResult> {
    const request: CoordinatorClientRequest = {
      kind: "background.run-now",
      clientId: this.clientId,
      requestId: this.generateRequestId(),
      taskId,
      expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch,
    };
    return this.requestCommand(request);
  }

  async backgroundTrigger(taskId: string, reason: string): Promise<CoordinatorCommandResult> {
    return this.requestCommand({ kind: "background.trigger", clientId: this.clientId, requestId: this.generateRequestId(), taskId, reason, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch });
  }

  async backgroundCancel(taskId: string): Promise<CoordinatorCommandResult> {
    const request: CoordinatorClientRequest = {
      kind: "background.cancel",
      clientId: this.clientId,
      requestId: this.generateRequestId(),
      taskId,
      expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch,
    };
    return this.requestCommand(request);
  }

  async backgroundCancelByKey(publicKeyHex: string): Promise<CoordinatorCommandResult> {
    return this.requestCommand({ kind: "background.cancel-by-key", clientId: this.clientId, requestId: this.generateRequestId(), publicKeyHex, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch });
  }

  async storageControl(control: CoordinatorStorageControl): Promise<import("@keymaster/contracts").CoordinatorValueResult<unknown>> {
    const request = { kind: "storage.control" as const, clientId: this.clientId, requestId: this.generateRequestId(), control, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch };
    // 首次初始化/接入已有桶包含 KDF、远端正则化和多轮条件写；这些事务的
    // 时长由 Worker 的恢复记录与页面重查保证，不能被通用 RPC 超时中断。
    const longRunning = control.type === "initial-setup"
      || control.type === "connect-existing-remote"
      || control.type === "initial-setup-cleanup"
      || control.type === "unlock-bucket"
      || control.type === "switch-bucket";
    try {
      const response = await this.sendRequest(request, longRunning ? 120_000 : undefined);
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: response.operationResult, sessionEpoch: response.sessionEpoch };
    } catch (cause) { return this.normalizeTransportFailure(request.kind, cause); }
  }

  /**
   * 首个桶由页面完成“快照先落地、目录后提交”后，SharedWorker 仍持有启动时
   * 的未选择状态。重发 hello 只替换公开桶身份与 Local I/O bridge，不重启
   * Worker，也不传递密码；随后的 unlock-bucket 才携带一次性密码。
   */
  async refreshStorageBootstrap(): Promise<void> {
    this.beginLocalStorageLease();
    await this.sendHello();
  }

  async storageGrant(context: import("@keymaster/contracts").OwnerAppStorageGrant): Promise<import("@keymaster/contracts").CoordinatorValueResult<string>> {
    const request = { kind: "storage.grant" as const, clientId: this.clientId, requestId: this.generateRequestId(), connectSessionId: context.connectSessionId, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch };
    try {
      const response = await this.sendRequest(request);
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: requiredCoordinatorOperationResult(response, request.kind), sessionEpoch: response.sessionEpoch };
    } catch (cause) { return this.normalizeTransportFailure(request.kind, cause); }
  }

  async storageData(data: CoordinatorStorageData, transfer: ArrayBuffer[] = [], signal?: AbortSignal): Promise<import("@keymaster/contracts").CoordinatorValueResult<unknown>> {
    const request = { kind: "storage.data" as const, clientId: this.clientId, requestId: this.generateRequestId(), data, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch };
    let onAbort: (() => void) | undefined;
    try {
      if (signal?.aborted) return { status: "transport-error", message: "Storage request cancelled", retryable: false };
      onAbort = () => { void this.storageCancel(request.requestId); };
      signal?.addEventListener("abort", onAbort, { once: true });
      const response = await this.sendRequest(request);
      if (signal?.aborted) return { status: "transport-error", message: "Storage request cancelled", retryable: false };
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: response.operationResult, sessionEpoch: response.sessionEpoch };
    } catch (cause) { return this.normalizeTransportFailure(request.kind, cause); }
    finally { if (onAbort) signal?.removeEventListener("abort", onAbort); }
  }

  async storageCancel(targetRequestId: string): Promise<CoordinatorCommandResult> {
    return this.requestCommand({ kind: "storage.cancel", clientId: this.clientId, requestId: this.generateRequestId(), targetRequestId });
  }

  async storageSessionAbort(connectSessionId: string): Promise<CoordinatorCommandResult> {
    return this.requestCommand({ kind: "storage.session.abort", clientId: this.clientId, requestId: this.generateRequestId(), connectSessionId, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch });
  }

  async storageBindOwner(input: { pluginId: string; declaration: import("@keymaster/contracts").PluginStorageDeclaration }): Promise<import("@keymaster/contracts").CoordinatorValueResult<StorageOwnerGrant>> {
    const request = { kind: "storage.owner.bind" as const, clientId: this.clientId, requestId: this.generateRequestId(), ...input, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch };
    try {
      const response = await this.sendRequest(request);
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: requiredCoordinatorOperationResult(response, request.kind), sessionEpoch: response.sessionEpoch };
    } catch (cause) { return this.normalizeTransportFailure(request.kind, cause); }
  }

  async storageBindPlatform(input: { pluginId: string; declaration: import("@keymaster/contracts").PluginStorageDeclaration }): Promise<import("@keymaster/contracts").CoordinatorValueResult<StoragePlatformGrant>> {
    const request = { kind: "storage.platform.bind" as const, clientId: this.clientId, requestId: this.generateRequestId(), ...input, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch };
    try {
      const response = await this.sendRequest(request);
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: requiredCoordinatorOperationResult(response, request.kind), sessionEpoch: response.sessionEpoch };
    } catch (cause) { return this.normalizeTransportFailure(request.kind, cause); }
  }

  async storageOwnerData(data: CoordinatorOwnerStorageData, transfer: ArrayBuffer[] = [], signal?: AbortSignal): Promise<import("@keymaster/contracts").CoordinatorValueResult<unknown>> {
    return this.sendInternalStorageData("storage.owner.data", data, transfer, signal);
  }

  async storagePlatformData(data: CoordinatorPlatformStorageData): Promise<import("@keymaster/contracts").CoordinatorValueResult<unknown>> {
    const request = { kind: "storage.platform.data" as const, clientId: this.clientId, requestId: this.generateRequestId(), data, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch };
    try {
      const response = await this.sendRequest(request);
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: response.operationResult, sessionEpoch: response.sessionEpoch };
    } catch (cause) { return this.normalizeTransportFailure(request.kind, cause); }
  }

  async storageDeleteOwner(ownerPublicKeyHex: string): Promise<import("@keymaster/contracts").CoordinatorValueResult<unknown>> {
    const request = { kind: "storage.owner.delete" as const, clientId: this.clientId, requestId: this.generateRequestId(), ownerPublicKeyHex, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch };
    try {
      const response = await this.sendRequest(request);
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: response.operationResult, sessionEpoch: response.sessionEpoch };
    } catch (cause) { return this.normalizeTransportFailure(request.kind, cause); }
  }

  private async sendInternalStorageData<K extends "storage.owner.data" | "storage.platform.data">(kind: K, data: K extends "storage.owner.data" ? CoordinatorOwnerStorageData : CoordinatorPlatformStorageData, transfer: ArrayBuffer[] = [], signal?: AbortSignal): Promise<import("@keymaster/contracts").CoordinatorValueResult<unknown>> {
    const requestId = this.generateRequestId();
    const request = { kind, clientId: this.clientId, requestId, data, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch } as Extract<CoordinatorClientCommandRequest, { kind: K }>;
    let onAbort: (() => void) | undefined;
    try {
      if (signal?.aborted) return { status: "transport-error", message: "Storage request cancelled", retryable: false };
      onAbort = () => { void this.storageCancel(requestId); };
      signal?.addEventListener("abort", onAbort, { once: true });
      const response = await this.sendRequest(request);
      if (signal?.aborted) return { status: "transport-error", message: "Storage request cancelled", retryable: false };
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: response.operationResult, sessionEpoch: response.sessionEpoch };
    } catch (cause) { return this.normalizeTransportFailure(kind, cause); }
    finally { if (onAbort) signal?.removeEventListener("abort", onAbort); }
  }

  async msfileControl(control: import("@keymaster/contracts").CoordinatorMsFileControl): Promise<import("@keymaster/contracts").CoordinatorValueResult<unknown>> {
    const request = { kind: "msfile.control" as const, clientId: this.clientId, requestId: this.generateRequestId(), control, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch };
    try {
      const response = await this.sendRequest(request);
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: response.operationResult, sessionEpoch: response.sessionEpoch };
    } catch (cause) { return this.normalizeTransportFailure(request.kind, cause); }
  }

  /** SatSubscription 所有页面调用都经过 Coordinator，避免每个 Tab 各自开 K-V/连接。 */
  async satOperation(operation: CoordinatorSatOperation, signal?: AbortSignal): Promise<import("@keymaster/contracts").CoordinatorValueResult<unknown>> {
    const request = { kind: "sat.operation" as const, clientId: this.clientId, requestId: this.generateRequestId(), operation, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch };
    let onAbort: (() => void) | undefined;
    try {
      if (signal?.aborted) return { status: "transport-error", message: "SatSubscription request cancelled", retryable: false };
      // 这里不尝试把业务 Wire 作为 transfer 发送。Uint8Array 的 structured
      // clone 会保留调用方 buffer，适合 retryCollect 的“原 Wire 不可变”语义。
      // Sat SPI/SSP 请求本身由 Window adapter 管理超时；这里的 signal 只
      // 防止调用方在回包后继续使用结果，不能用另一条 Sat RPC 冒充取消。
      onAbort = () => undefined;
      signal?.addEventListener("abort", onAbort, { once: true });
      const response = await this.sendRequest(request);
      if (signal?.aborted) return { status: "transport-error", message: "SatSubscription request cancelled", retryable: false };
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: response.operationResult, sessionEpoch: response.sessionEpoch };
    } catch (cause) { return this.normalizeTransportFailure(request.kind, cause); }
    finally { if (onAbort) signal?.removeEventListener("abort", onAbort); }
  }

  /** 所有 Channel publish/订阅请求的唯一 Coordinator RPC。 */
  async channelOperation(operation: CoordinatorChannelOperation, signal?: AbortSignal): Promise<import("@keymaster/contracts").CoordinatorValueResult<unknown>> {
    const request = { kind: "channel.operation" as const, clientId: this.clientId, requestId: this.generateRequestId(), operation, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch };
    let onAbort: (() => void) | undefined;
    try {
      if (signal?.aborted) return { status: "transport-error", message: "Channel request cancelled", retryable: false };
      // 取消不能只在页面侧丢弃结果：Coordinator 需要看到取消，才能中止
      // 尚未越过供应商边界的物理操作，并让旧 caller 的清理继续排在后面。
      // 若底层已经越过不可逆边界，Worker 仍会等待真实 Promise settle，
      // 不会把“本地取消”误当成远端写入已结束。
      onAbort = () => { void this.channelCancel(request.requestId); };
      signal?.addEventListener("abort", onAbort, { once: true });
      const response = await this.sendRequest(request);
      if (signal?.aborted) return { status: "transport-error", message: "Channel request cancelled", retryable: false };
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: response.operationResult, sessionEpoch: response.sessionEpoch };
    } catch (cause) { return this.normalizeTransportFailure(request.kind, cause); }
    finally { if (onAbort) signal?.removeEventListener("abort", onAbort); }
  }

  /** 只供 Channel 请求的 AbortSignal 使用；调用方不能指定其它端口。 */
  private async channelCancel(targetRequestId: string): Promise<CoordinatorCommandResult> {
    try {
      return await this.requestCommand({
        kind: "channel.cancel",
        clientId: this.clientId,
        requestId: this.generateRequestId(),
        targetRequestId
      });
    } catch {
      // 取消是最佳努力通知。原请求的最终结果仍按真实 I/O 边界处理，
      // 不能因为取消通知自身断线就伪造“已清理”。
      return { status: "error", message: "Channel cancellation transport failed" };
    }
  }

  /** 联系人 presence 的读取面只查询 Coordinator 内存/本地 K-V，不启动探测。 */
  async contactsPresenceSnapshot(): Promise<import("@keymaster/contracts").CoordinatorValueResult<ContactPresenceMap>> {
    const request = { kind: "contacts.presence.snapshot" as const, clientId: this.clientId, requestId: this.generateRequestId(), expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch };
    try {
      const response = await this.sendRequest(request);
      if (response.ack.status !== "ok") return response.ack;
      return {
        status: "ok",
        value: requiredCoordinatorOperationResult<ContactPresenceMap>(response, request.kind),
        sessionEpoch: response.sessionEpoch,
      };
    } catch (cause) { return this.normalizeTransportFailure(request.kind, cause); }
  }

  /** 读取 SharedWorker 唯一插件启停意图；这里的 snapshot 不等于运行实例状态。 */
  async pluginIntentSnapshot(): Promise<CoordinatorValueResult<PluginIntentSnapshot>> {
    const request = {
      kind: "plugin.intent.snapshot" as const,
      clientId: this.clientId,
      requestId: this.generateRequestId(),
    };
    try {
      const response = await this.sendRequest(request);
      if (response.ack.status !== "ok") return response.ack;
      const snapshot = requiredCoordinatorOperationResult(response, request.kind);
      this.cachePluginIntentSnapshot(snapshot);
      return { status: "ok", value: snapshot, sessionEpoch: response.sessionEpoch };
    } catch (cause) {
      return this.normalizeTransportFailure(request.kind, cause);
    }
  }

  /** 提交绝对启停意图；accepted/duplicate 只表示 Worker 已持久化。 */
  async pluginIntentSubmit(command: PluginIntentCommand): Promise<PluginIntentSubmissionResult> {
    const request = {
      kind: "plugin.intent.submit",
      clientId: this.clientId,
      requestId: this.generateRequestId(),
      command,
    } as const;
    try {
      const response = await this.sendRequest(request);
      if (response.ack.status !== "ok") {
        return {
          status: "transport-error",
          message: "message" in response.ack && typeof response.ack.message === "string"
            ? response.ack.message
            : `Coordinator rejected ${request.kind}`,
          retryable: response.ack.status !== "validation-error",
        };
      }
      const result = requiredCoordinatorOperationResult(response, request.kind);
      if ("snapshot" in result && result.snapshot) this.cachePluginIntentSnapshot(result.snapshot);
      return result;
    } catch (cause) {
      return this.normalizeTransportFailure(request.kind, cause);
    }
  }

  async msfileGrant(context: import("@keymaster/contracts").MsFileConnectAppContext): Promise<import("@keymaster/contracts").CoordinatorValueResult<string>> {
    // 审查修复：grant 与其他请求一样携带发起时的 epoch，供 worker 在
    // authoritative session 查询后复核（跨 lock/unlock/key switch 的请求被拒）。
    const request = { kind: "msfile.grant" as const, clientId: this.clientId, requestId: this.generateRequestId(), context, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch };
    try {
      const response = await this.sendRequest(request);
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: requiredCoordinatorOperationResult(response, request.kind), sessionEpoch: response.sessionEpoch };
    } catch (cause) { return this.normalizeTransportFailure(request.kind, cause); }
  }

  async msfileData(data: import("@keymaster/contracts").CoordinatorMsFileData, transfer: ArrayBuffer[] = [], signal?: AbortSignal): Promise<import("@keymaster/contracts").CoordinatorValueResult<unknown>> {
    const request = { kind: "msfile.data" as const, clientId: this.clientId, requestId: this.generateRequestId(), data, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch };
    let onAbort: (() => void) | undefined;
    try {
      if (signal?.aborted) return { status: "transport-error", message: "MSFile request cancelled", retryable: false };
      onAbort = () => { void this.msfileCancel(request.requestId); };
      signal?.addEventListener("abort", onAbort, { once: true });
      const response = await this.sendRequest(request);
      if (signal?.aborted) return { status: "transport-error", message: "MSFile request cancelled", retryable: false };
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: response.operationResult, sessionEpoch: response.sessionEpoch };
    } catch (cause) { return this.normalizeTransportFailure(request.kind, cause); }
    finally { if (onAbort) signal?.removeEventListener("abort", onAbort); }
  }

  async msfileCancel(targetRequestId: string): Promise<CoordinatorCommandResult> {
    return this.requestCommand({ kind: "msfile.cancel", clientId: this.clientId, requestId: this.generateRequestId(), targetRequestId });
  }

  async msfileSessionAbort(connectSessionId: string): Promise<CoordinatorCommandResult> {
    return this.requestCommand({ kind: "msfile.session.abort", clientId: this.clientId, requestId: this.generateRequestId(), connectSessionId, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch });
  }

  /** 申请公共 Window P2P executor lease（同一 epoch 仅一个）。 */
  async windowP2pExecutorAcquire(ownerPublicKeyHex: string, executorPort?: MessagePort): Promise<import("@keymaster/contracts").CoordinatorValueResult<import("@keymaster/contracts").WindowP2pExecutorLease>> {
    const request = { kind: "window-p2p.executor.acquire" as const, clientId: this.clientId, requestId: this.generateRequestId(), ownerPublicKeyHex, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch, ...(executorPort ? { executorPort } : {}) };
    try {
      const response = await this.sendRequest(request);
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: requiredCoordinatorOperationResult(response, request.kind), sessionEpoch: response.sessionEpoch };
    } catch (cause) { return this.normalizeTransportFailure(request.kind, cause); }
  }

  async windowP2pExecutorRelease(leaseId: string): Promise<CoordinatorCommandResult> {
    return this.requestCommand({ kind: "window-p2p.executor.release", clientId: this.clientId, requestId: this.generateRequestId(), leaseId });
  }

  /** 公共 P2P bridge 的 transferable 资源测试入口。 */
  async windowP2pExecutorSpikeTransfer(leaseId: string, expectedSessionEpoch: import("@keymaster/contracts").SessionEpoch, bytes: ArrayBuffer): Promise<import("@keymaster/contracts").CoordinatorValueResult<import("@keymaster/contracts").WindowP2pExecutorTransferResult>> {
    const request = { kind: "window-p2p.executor.spike.transfer" as const, clientId: this.clientId, requestId: this.generateRequestId(), leaseId, expectedSessionEpoch, bytes };
    try {
      const response = await this.sendRequest(request);
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: requiredCoordinatorOperationResult(response, request.kind), sessionEpoch: response.sessionEpoch };
    } catch (cause) { return this.normalizeTransportFailure(request.kind, cause); }
  }

  /** Window bridge RPC 1：由 Coordinator 构造标准 Noise 签名负载。 */
  async windowP2pExecutorSignNoiseStaticKey(input: Omit<import("@keymaster/contracts").WindowP2pNoiseSignRequest, "expectedSessionEpoch"> & { expectedSessionEpoch?: import("@keymaster/contracts").SessionEpoch }, signal?: AbortSignal): Promise<import("@keymaster/contracts").CoordinatorValueResult<import("@keymaster/contracts").WindowP2pIdentitySignResult>> {
    const noiseStaticPublicKey = input.noiseStaticPublicKey;
    const request = { kind: "window-p2p.executor.identity.sign-noise" as const, clientId: this.clientId, requestId: this.generateRequestId(), leaseId: input.leaseId, expectedSessionEpoch: input.expectedSessionEpoch ?? this.bootstrapSnapshotCache.sessionEpoch, noiseStaticPublicKey };
    let onAbort: (() => void) | undefined;
    try {
      if (signal?.aborted) return { status: "transport-error", message: "Noise signer request cancelled", retryable: false };
      onAbort = () => { void this.msfileCancel(request.requestId); };
      signal?.addEventListener("abort", onAbort, { once: true });
      const response = await this.sendRequest(request);
      if (signal?.aborted) return { status: "transport-error", message: "Noise signer request cancelled", retryable: false };
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: requiredCoordinatorOperationResult(response, request.kind), sessionEpoch: response.sessionEpoch };
    } catch (cause) { return this.normalizeTransportFailure(request.kind, cause); }
    finally { if (onAbort) signal?.removeEventListener("abort", onAbort); }
  }

  /** Window bridge RPC 2：由 Coordinator 构造标准 Signed Peer Record 负载。 */
  async windowP2pExecutorSignPeerRecord(input: Omit<import("@keymaster/contracts").WindowP2pPeerRecordSignRequest, "expectedSessionEpoch"> & { expectedSessionEpoch?: import("@keymaster/contracts").SessionEpoch }, signal?: AbortSignal): Promise<import("@keymaster/contracts").CoordinatorValueResult<import("@keymaster/contracts").WindowP2pIdentitySignResult>> {
    const request = { kind: "window-p2p.executor.identity.sign-peer-record" as const, clientId: this.clientId, requestId: this.generateRequestId(), leaseId: input.leaseId, expectedSessionEpoch: input.expectedSessionEpoch ?? this.bootstrapSnapshotCache.sessionEpoch, peerId: input.peerId, addresses: input.addresses, sequence: input.sequence };
    let onAbort: (() => void) | undefined;
    try {
      if (signal?.aborted) return { status: "transport-error", message: "Peer Record signer request cancelled", retryable: false };
      onAbort = () => { void this.msfileCancel(request.requestId); };
      signal?.addEventListener("abort", onAbort, { once: true });
      const response = await this.sendRequest(request);
      if (signal?.aborted) return { status: "transport-error", message: "Peer Record signer request cancelled", retryable: false };
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: requiredCoordinatorOperationResult(response, request.kind), sessionEpoch: response.sessionEpoch };
    } catch (cause) { return this.normalizeTransportFailure(request.kind, cause); }
    finally { if (onAbort) signal?.removeEventListener("abort", onAbort); }
  }

  async p2pkhProvidersGet(): Promise<import("@keymaster/contracts").CoordinatorValueResult<P2pkhProviderRegistrySnapshot>> {
    const request = { kind: "p2pkh.providers.get" as const, clientId: this.clientId, requestId: this.generateRequestId(), expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch };
    try {
      const response = await this.sendRequest(request);
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: requiredCoordinatorOperationResult(response, request.kind), sessionEpoch: response.sessionEpoch };
    } catch (cause) { return this.normalizeTransportFailure(request.kind, cause); }
  }

  async p2pkhProvidersUpdate(network: "main" | "test", selection: P2pkhNetworkProviderSelection, expectedGeneration: number): Promise<CoordinatorCommandResult> {
    return this.requestCommand({ kind: "p2pkh.providers.update", clientId: this.clientId, requestId: this.generateRequestId(), network, selection, expectedGeneration, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch });
  }

  async p2pkhSettingsUpdate(settings: { includeTestnet: boolean }): Promise<CoordinatorCommandResult> {
    return this.requestCommand({ kind: "p2pkh.settings.update", clientId: this.clientId, requestId: this.generateRequestId(), settings, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch });
  }

  async p2pkhProviderConfigGet(providerId: string): Promise<import("@keymaster/contracts").CoordinatorValueResult<P2pkhProviderConfig>> {
    const request = { kind: "p2pkh.provider-config.get" as const, clientId: this.clientId, requestId: this.generateRequestId(), providerId, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch };
    try {
      const response = await this.sendRequest(request);
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: requiredCoordinatorOperationResult(response, request.kind), sessionEpoch: response.sessionEpoch };
    } catch (cause) { return this.normalizeTransportFailure(request.kind, cause); }
  }

  async p2pkhProviderConfigUpdate(providerId: string, config: P2pkhProviderConfig): Promise<CoordinatorCommandResult> {
    return this.requestCommand({ kind: "p2pkh.provider-config.update", clientId: this.clientId, requestId: this.generateRequestId(), providerId, config, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch });
  }

  async p2pkhBroadcast(input: { ownerPublicKeyHex: string; network: "main" | "test"; submissionId: string; expectedProviderGeneration: number }): Promise<import("@keymaster/contracts").CoordinatorValueResult<unknown>> {
    const request = { kind: "p2pkh.broadcast" as const, clientId: this.clientId, requestId: this.generateRequestId(), ...input, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch };
    try {
      const response = await this.sendRequest(request);
      if (response.ack.status === "stale-epoch") return { status: "ok", value: { status: "not-dispatched", reason: "stale-session-epoch" }, sessionEpoch: response.sessionEpoch };
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: response.operationResult, sessionEpoch: response.sessionEpoch };
    } catch (cause) {
      const failure = this.normalizeTransportFailure(request.kind, cause);
      return failure.dispatchStatus === "not-dispatched"
        ? { status: "ok", value: { status: "not-dispatched", reason: "coordinator-not-dispatched" }, sessionEpoch: this.bootstrapSnapshotCache.sessionEpoch }
        : failure;
    }
  }

  async p2pkhRebroadcastAncestors(input: { ownerPublicKeyHex: string; network: "main" | "test"; submissionId: string; expectedProviderGeneration: number }): Promise<import("@keymaster/contracts").CoordinatorValueResult<unknown>> {
    const request = { kind: "p2pkh.rebroadcast-ancestors" as const, clientId: this.clientId, requestId: this.generateRequestId(), ...input, expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch };
    try {
      const response = await this.sendRequest(request);
      if (response.ack.status === "stale-epoch") return { status: "ok", value: { status: "not-dispatched", reason: "stale-session-epoch" }, sessionEpoch: response.sessionEpoch };
      if (response.ack.status !== "ok") return response.ack;
      return { status: "ok", value: response.operationResult, sessionEpoch: response.sessionEpoch };
    } catch (cause) {
      const failure = this.normalizeTransportFailure(request.kind, cause);
      return failure.dispatchStatus === "not-dispatched"
        ? { status: "ok", value: { status: "not-dispatched", reason: "coordinator-not-dispatched" }, sessionEpoch: this.bootstrapSnapshotCache.sessionEpoch }
        : failure;
    }
  }

  async backgroundSettingsUpdate(settings: CoordinatorBackgroundSyncSettings): Promise<CoordinatorCommandResult> {
    const request: CoordinatorClientRequest = {
      kind: "background.settings.update",
      clientId: this.clientId,
      requestId: this.generateRequestId(),
      settings,
      expectedSessionEpoch: this.bootstrapSnapshotCache.sessionEpoch,
    };
    return this.requestCommand(request);
  }

  sendActivity(): void {
    const runtime = this.runtimeHandle;
    if (!this.isConnected || !runtime) return;
    void runtime.capability(COORDINATOR_RPC_CAPABILITY).call(
      { kind: "session.activity" },
      { operationId: `activity:${this.clientId}:${Date.now()}`, timeoutMs: this.requestTimeoutMs },
    ).catch(() => undefined);
  }

  // ============================================================
  // 6. Request Management
  // ============================================================

  private normalizeTransportFailure(kind: CoordinatorClientRequest["kind"], cause: unknown): CoordinatorTransportFailure {
    if (cause && typeof cause === "object" && (cause as CoordinatorSendError).requestValidation === true) {
      const message = cause instanceof Error ? cause.message : "Coordinator request validation failed";
      this.reportRecoverableCoordinatorFailure(kind, cause);
      return { status: "transport-error", message, retryable: false, dispatchStatus: "not-dispatched" };
    }
    const dispatchStatus = (cause as { dispatchStatus?: CoordinatorDispatchStatus } | undefined)?.dispatchStatus ?? "unknown";
    const code = cause && typeof cause === "object" && typeof (cause as { code?: unknown }).code === "string"
      ? (cause as { code: string }).code
      : undefined;
    const staleOrRevoked = code === "service_reference_stale"
      || code === "service_revoked"
      || code === "transport_disconnected";
    // 远端 handler 抛出的业务错误（例如存储根尚未就绪时的 owner bind 失败）
    // 不是本连接断线：把它按普通失败返回给调用方，绝不销毁 Runtime/会话。
    // 否则一次可重试的业务失败会被升级成整条会话重建，窗口在此期间会
    // 回落锁定并让插件装配失败。
    if (code === "handler_failed" || code === "capability_unavailable") {
      this.reportRecoverableCoordinatorFailure(kind, cause);
      return {
        status: "transport-error",
        message: cause instanceof Error ? cause.message : "Coordinator remote operation failed",
        retryable: true,
        dispatchStatus: "unknown",
      };
    }
    if (this.connectionState !== "fatal") this.connectionState = "recoverable";
    this.isConnected = false;
    this.removeRuntimeSubscription?.();
    this.removeRuntimeSubscription = undefined;
    const runtime = this.runtimeHandle;
    this.runtimeHandle = null;
    this.closeSessionBestEffort(runtime);
    if (runtime) void runtime.dispose(`Coordinator request failed: ${kind}`);
    this.topicSubscription?.cancel(`Coordinator request failed: ${kind}`);
    this.topicSubscription = null;
    this.disposeLocalStorageBridge();
    this.resetDisconnectedState();
    // A transport failure is not evidence that the currently cached Worker
    // still owns the old authority. Keep ordinary non-sensitive continuity,
    // but remove recovery-required before UI or dangerous actions inspect it.
    this.clearDisconnectedAuthorityRecovery();
    if (!this.shutdownRequested && this.connectionState !== "fatal") this.scheduleReconnect();
    this.reportRecoverableCoordinatorFailure(kind, cause);
    const retryable = !staleOrRevoked
      && !(dispatchStatus === "unknown" && coordinatorKindMayHaveSideEffects(kind));
    return {
      status: "transport-error",
      message: staleOrRevoked ? "Coordinator session reference is stale or revoked" : "Coordinator connection lost",
      retryable,
      dispatchStatus,
    };
  }

  reportRecoverableCoordinatorFailure(kind: string, cause: unknown): void {
    const code = cause && typeof cause === "object" && typeof (cause as { code?: unknown }).code === "string"
      ? ` [${(cause as { code: string }).code}]`
      : "";
    const message = `${cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "Coordinator command failed"}${code}`;
    this.recoverableDiagnostics.push({ kind, status: "recoverable", message: message.slice(0, 200), sessionEpoch: this.bootstrapSnapshotCache.sessionEpoch, connected: this.isConnected });
    if (this.recoverableDiagnostics.length > 50) this.recoverableDiagnostics.shift();
  }

  getRecoverableDiagnostics(): RecoverableCoordinatorDiagnostic[] {
    return this.recoverableDiagnostics.map((diagnostic) => ({ ...diagnostic }));
  }

  /** The single boundary at which command transport failures become results. */
  private async requestCommand(request: CoordinatorClientCommandRequest): Promise<CoordinatorCommandResult> {
    try {
      const response = await this.sendRequest(request);
      return response.ack;
    } catch (cause) {
      return this.normalizeTransportFailure(request.kind, cause);
    }
  }

  private async sendRequest<R extends CoordinatorClientCommandRequest>(
    request: R,
    timeoutMs?: number,
  ): Promise<CoordinatorRpcResponseForRequest<CoordinatorRpcRequestFromClient<R>>> {
    let rpcRequest: CoordinatorRpcRequestFromClient<R>;
    try {
      rpcRequest = toCoordinatorRpcRequest(request);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const failure = coordinatorSendError(`Coordinator request validation failed: ${message}`, "not-dispatched");
      failure.requestValidation = true;
      throw failure;
    }
    return this.sendTypedRequest(rpcRequest, request.requestId, timeoutMs);
  }

  private async sendTypedRequest<R extends CoordinatorRpcRequest>(
    request: R,
    operationId = this.generateRequestId(),
    timeoutMs = this.requestTimeoutMs,
  ): Promise<CoordinatorRpcResponseForRequest<R>> {
    const runtime = this.runtimeHandle;
    if (!this.isConnected || !runtime) {
      throw coordinatorSendError("Not connected to Coordinator", "not-dispatched");
    }
    const attempt = this.connectionAttempt;
    try {
      const response = await runtime.capability(COORDINATOR_RPC_CAPABILITY).call(request, {
        operationId,
        timeoutMs,
      });
      if (this.runtimeHandle !== runtime || !this.isConnected || this.connectionAttempt !== attempt) {
        throw Object.assign(coordinatorSendError("Coordinator response belongs to a stale Runtime", "unknown"), { code: "service_reference_stale" });
      }
      const parsed = parseCoordinatorResponseFor(request, response);
      this.applyCoordinatorResponse(parsed);
      return parsed;
    } catch (error) {
      const failure = error instanceof Error ? error as CoordinatorSendError : coordinatorSendError(String(error), "unknown");
      failure.dispatchStatus ??= "unknown";
      throw failure;
    }
  }

  // ============================================================
  // 7. State Access
  // ============================================================

  getBootstrapSnapshot(): CoordinatorBootstrapSnapshot {
    return { ...this.bootstrapSnapshotCache };
  }

  getSessionEpoch(): SessionEpoch {
    return this.bootstrapSnapshotCache.sessionEpoch;
  }

  getVaultStatus(): CoordinatorVaultStatus {
    return this.bootstrapSnapshotCache.vaultStatus;
  }

  getActivePublicKeyHex(): string | undefined {
    return this.bootstrapSnapshotCache.activePublicKeyHex;
  }

  getKeyspaceGeneration(): number {
    return this.bootstrapSnapshotCache.keyspaceGeneration;
  }

  getTaskSnapshots(): CoordinatorTaskSnapshot[] {
    return [...this.bootstrapSnapshotCache.taskSnapshots];
  }

  getScheduleSettings(): CoordinatorBackgroundSyncSettings {
    return { ...this.bootstrapSnapshotCache.scheduleSettings };
  }

  getIsConnected(): boolean {
    return this.isConnected;
  }

  getConnectionState(): CoordinatorConnectionState {
    return this.connectionState;
  }

  /** 返回当前客户端缓存的 presence 快照副本，调用方不能修改 Coordinator 状态。 */
  getContactsPresenceSnapshot(): ContactPresenceMap {
    return Object.fromEntries(Object.entries(this.contactsPresenceSnapshotCache).map(([key, value]) => [key, { ...value }])) as ContactPresenceMap;
  }

  // ============================================================
  // 8. Event Listeners
  // ============================================================

  subscribeTopic(topic: CoordinatorTopic, listener: (event: any) => void): () => void {
    const key = topic as string;
    if (!this.eventListeners.has(key)) this.eventListeners.set(key, new Set());
    const listeners = this.eventListeners.get(key)!;
    const typedListener = listener as EventListener<CoordinatorTopicEvent>;
    listeners.add(typedListener);
    const baseline = this.topicCaches.get(topic);
    if (baseline) {
      try { typedListener(baseline); } catch { /* noop */ }
    }
    return () => { listeners.delete(typedListener); };
  }

  private applyTopicEvent(event: CoordinatorTopicEvent): void {
    if (!this.isValidTopicEvent(event)) {
      if (event && typeof event === "object" && "topic" in event && event.topic === "session.state") {
        this.resetDisconnectedState();
        // A malformed session projection must not leave the previous
        // recovery-required authority claim visible as if it were current.
        const { authorityRecovery: _authorityRecovery, ...safeSnapshot } = this.bootstrapSnapshotCache;
        this.bootstrapSnapshotCache = safeSnapshot;
      }
      this.reportRecoverableCoordinatorFailure("invalid-topic-event", new Error("Invalid Coordinator topic payload"));
      return;
    }
    if (event.topic === "worker.units" && event.sessionEpoch !== this.bootstrapSnapshotCache.sessionEpoch) {
      // Worker 的运行单元变更和 session.state 通过不同消息发送，不能假设
      // postMessage 到达顺序。暂存未来世代，等 session.state 先确认世代；
      // 旧世代随后不会再被应用到当前产品状态。
      this.deferWorkerUnitEvent(event);
      return;
    }
    const incomingRevision = this.getEventRevision(event);
    if (incomingRevision === undefined) return;
    if (incomingRevision <= this.getCachedTopicRevision(event.topic)) {
      if (event.topic === "session.state") {
        this.reportRecoverableCoordinatorFailure("stale-session-state", new Error("Discarded non-increasing session revision"));
      }
      return;
    }
    this.setTopicRevision(event);
    this.topicCaches.set(event.topic, event);
    if (event.type === "session.state.changed") {
      const previousSessionEpoch = this.bootstrapSnapshotCache.sessionEpoch;
      const sessionChanged = previousSessionEpoch !== event.sessionEpoch;
      // Session fields are committed as one replacement before any listener observes them.
      this.bootstrapSnapshotCache = {
        ...this.bootstrapSnapshotCache,
        sessionEpoch: event.sessionEpoch,
        vaultStatus: event.vaultStatus,
        activePublicKeyHex: event.activePublicKeyHex ?? undefined,
        selectedPublicKeyHex: event.selectedPublicKeyHex ?? undefined,
        keyspaceGeneration: event.keyspaceGeneration,
        authorityRecovery: event.authorityRecovery,
      };
      if (sessionChanged) {
        // 运行单元属于 session 世代；切换世代时先撤下旧快照，避免旧
        // Worker 实例在新 owner 页面上短暂显示为仍然 ready。
        this.topicCaches.delete("worker.units");
        this.bootstrapSnapshotCache = {
          ...this.bootstrapSnapshotCache,
          coordinatorWorkerUnits: [],
          coordinatorWorkerUnitSnapshotRevision: undefined,
        };
        for (const epoch of this.pendingWorkerUnitEvents.keys()) {
          if (epoch !== event.sessionEpoch) this.pendingWorkerUnitEvents.delete(epoch);
        }
        const pendingWorkerUnits = this.pendingWorkerUnitEvents.get(event.sessionEpoch);
        if (pendingWorkerUnits) {
          this.pendingWorkerUnitEvents.delete(event.sessionEpoch);
          // 递归调用只会处理已经验证过且 epoch 已切换到当前值的事件。
          this.applyTopicEvent(pendingWorkerUnits);
        }
      }
      const nextOwner = event.vaultStatus === "unlocked" ? event.activePublicKeyHex : null;
      if (nextOwner !== this.contactsPresenceOwnerPublicKeyHex) {
        this.contactsPresenceOwnerPublicKeyHex = nextOwner;
        this.contactsPresenceSnapshotCache = {};
      }
    } else if (event.type === "background.snapshot.changed") {
      // Background is a separate domain and must not advance Session identity.
      this.bootstrapSnapshotCache = { ...this.bootstrapSnapshotCache, taskSnapshots: [...event.snapshots] };
    } else if (event.topic === "storage.state") {
      this.bootstrapSnapshotCache = {
        ...this.bootstrapSnapshotCache,
        ...(event.bucketId ? { storageBucketId: event.bucketId } : { storageBucketId: undefined }),
        ...(event.bucketGeneration ? { storageBucketGeneration: event.bucketGeneration } : { storageBucketGeneration: undefined }),
      };
    } else if (event.type === "p2pkh.providers.changed") {
      this.bootstrapSnapshotCache = { ...this.bootstrapSnapshotCache, p2pkhProviders: event.snapshot };
    } else if (event.type === "coordinator.worker-units.changed") {
      this.bootstrapSnapshotCache = {
        ...this.bootstrapSnapshotCache,
        coordinatorWorkerUnits: event.units.map((unit) => ({ ...unit, serviceIds: [...unit.serviceIds], taskIds: [...unit.taskIds] })),
        coordinatorWorkerUnitSnapshotRevision: event.workerUnitRevision,
      };
    } else if (event.topic === "plugin.intent") {
      this.cachePluginIntentSnapshot(event.snapshot, event.authorityInstanceId);
    } else if (event.topic === "contacts.presence") {
      this.contactsPresenceOwnerPublicKeyHex = event.activePublicKeyHex;
      this.contactsPresenceSnapshotCache = Object.fromEntries(Object.entries(event.presence).map(([key, value]) => [key, { ...value }])) as ContactPresenceMap;
    }
    const listeners = this.eventListeners.get(event.topic);
    if (listeners) {
      for (const listener of listeners) {
        try { listener(event); } catch { /* noop */ }
      }
    }

  }

  private getCachedTopicRevision(topic: CoordinatorTopic): number {
    if (topic === "session.state") return this.sessionRevisionCache;
    if (topic === "background.snapshot") return this.backgroundSnapshotRevisionCache;
    if (topic === "storage.state") return this.storageRevisionCache;
    if (topic === "p2pkh.providers") return this.p2pkhProviderRevisionCache;
    if (topic === "msfile.state") return this.msfileRevisionCache;
    if (topic === "sat.events") return this.satRevisionCache;
    if (topic === "channel.events") return this.channelRevisionCache;
    if (topic === "contacts.presence") return this.contactsPresenceRevisionCache;
    if (topic === "plugin.intent") return this.pluginIntentRevisionCache;
    if (topic === "worker.units") return this.bootstrapSnapshotCache.coordinatorWorkerUnitSnapshotRevision ?? -1;
    return this.assetDataRevisionCache;
  }

  private getEventRevision(event: CoordinatorTopicEvent): number | undefined {
    if (event.topic === "session.state") return event.sessionRevision;
    if (event.topic === "background.snapshot") return event.backgroundSnapshotRevision;
    if (event.topic === "storage.state") return event.storageRevision;
    if (event.topic === "p2pkh.providers") return event.providerRevision;
    if (event.topic === "msfile.state") return event.msfileRevision;
    if (event.topic === "sat.events") return event.satRevision;
    if (event.topic === "channel.events") return event.channelRevision;
    if (event.topic === "contacts.presence") return event.presenceRevision;
    if (event.topic === "plugin.intent") return event.pluginIntentRevision;
    if (event.topic === "worker.units") return event.workerUnitRevision;
    return event.assetDataRevision;
  }

  private setTopicRevision(event: CoordinatorTopicEvent): void {
    if (event.topic === "session.state") this.sessionRevisionCache = event.sessionRevision;
    else if (event.topic === "background.snapshot") this.backgroundSnapshotRevisionCache = event.backgroundSnapshotRevision;
    else if (event.topic === "storage.state") this.storageRevisionCache = event.storageRevision;
    else if (event.topic === "p2pkh.providers") this.p2pkhProviderRevisionCache = event.providerRevision;
    else if (event.topic === "msfile.state") this.msfileRevisionCache = event.msfileRevision;
    else if (event.topic === "sat.events") this.satRevisionCache = event.satRevision;
    else if (event.topic === "channel.events") this.channelRevisionCache = event.channelRevision;
    else if (event.topic === "contacts.presence") this.contactsPresenceRevisionCache = event.presenceRevision;
    else if (event.topic === "plugin.intent") this.pluginIntentRevisionCache = event.pluginIntentRevision;
    else if (event.topic === "worker.units") this.bootstrapSnapshotCache.coordinatorWorkerUnitSnapshotRevision = event.workerUnitRevision;
    else this.assetDataRevisionCache = event.assetDataRevision;
  }

  private isValidTopicEvent(event: CoordinatorTopicEvent): boolean {
    if (!event || typeof event !== "object" || typeof event.topic !== "string" || typeof event.type !== "string" || typeof event.sessionEpoch !== "string") return false;
    if (event.topic === "session.state") {
      return event.type === "session.state.changed"
        && Number.isSafeInteger(event.sessionRevision)
        && event.sessionRevision >= 0
        && typeof event.cause === "string"
        && typeof event.vaultStatus === "string"
        && (typeof event.activePublicKeyHex === "string" || event.activePublicKeyHex === null)
        && Number.isSafeInteger(event.keyspaceGeneration)
        && event.keyspaceGeneration >= 0
        && (event.vaultStatus === "unlocked" || event.activePublicKeyHex === null)
        && (event.authorityRecovery === undefined || this.isValidAuthorityRecovery(event.authorityRecovery));
    }
    if (event.topic === "background.snapshot") return event.type === "background.snapshot.changed" && Number.isSafeInteger(event.backgroundSnapshotRevision) && Array.isArray(event.snapshots);
    if (event.topic === "storage.state") return event.type === "storage.state.changed"
      && Number.isSafeInteger(event.storageRevision)
      && event.storageRevision >= 0
      && (event.providerGeneration === null || Number.isSafeInteger(event.providerGeneration))
      && (event.bucketId === undefined || typeof event.bucketId === "string")
      && (event.bucketGeneration === undefined || (Number.isSafeInteger(event.bucketGeneration) && event.bucketGeneration > 0));
    if (event.topic === "p2pkh.providers") return event.type === "p2pkh.providers.changed" && Number.isSafeInteger(event.providerRevision) && event.providerRevision >= 0 && Boolean(event.snapshot);
    if (event.topic === "msfile.state") {
      return event.type === "msfile.state.changed"
        && Number.isSafeInteger(event.msfileRevision)
        && event.msfileRevision >= 0
        && Number.isSafeInteger(event.supplierGeneration)
        && Array.isArray(event.pendingApprovals);
    }
    if (event.topic === "sat.events") {
      return event.type === "sat.events.changed"
        && Number.isSafeInteger(event.satRevision)
        && event.satRevision >= 0
        && Boolean(event.event);
    }
    if (event.topic === "channel.events") {
      if (event.type === "channel.subscription.changed") {
        const status = event.subscriptionStatus as {
          channel?: unknown;
          phase?: unknown;
          errorCode?: unknown;
          errorMessage?: unknown;
          updatedAtMs?: unknown;
        } | undefined;
        const statuses = event.subscriptionStatuses as Array<{
          channel?: unknown;
          phase?: unknown;
          errorCode?: unknown;
          errorMessage?: unknown;
          updatedAtMs?: unknown;
        }> | undefined;
        const validStatus = status !== undefined
          && typeof status.channel === "string"
          && ["idle", "subscribing", "subscribed", "retrying", "blocked"].includes(String(status.phase))
          && (status.errorCode === null || ["config", "connect", "identity", "protocol", "balance", "unknown_result", "validation", "unavailable", "conflict"].includes(String(status.errorCode)))
          && (status.errorMessage === null || (typeof status.errorMessage === "string" && status.errorMessage.length <= 512))
          && typeof status.updatedAtMs === "number"
          && Number.isFinite(status.updatedAtMs);
        const validStatuses = Array.isArray(statuses)
          && statuses.length <= 2_048
          && statuses.every((snapshot) => snapshot !== null
            && typeof snapshot.channel === "string"
            && ["idle", "subscribing", "subscribed", "retrying", "blocked"].includes(String(snapshot.phase))
            && (snapshot.errorCode === null || ["config", "connect", "identity", "protocol", "balance", "unknown_result", "validation", "unavailable", "conflict"].includes(String(snapshot.errorCode)))
            && (snapshot.errorMessage === null || (typeof snapshot.errorMessage === "string" && snapshot.errorMessage.length <= 512))
            && typeof snapshot.updatedAtMs === "number"
            && Number.isFinite(snapshot.updatedAtMs));
        return Number.isSafeInteger(event.channelRevision)
          && event.channelRevision >= 0
          && (validStatus || validStatuses);
      }
      return event.type === "channel.message.received"
        && Number.isSafeInteger(event.channelRevision)
        && event.channelRevision >= 0
        && (!event.publicMessage || typeof event.publicMessage.channel === "string")
        && (!event.privateMessage || typeof event.privateMessage.channel === "string");
    }
    if (event.topic === "contacts.presence") {
      return event.type === "contacts.presence.changed"
        && Number.isSafeInteger(event.presenceRevision)
        && event.presenceRevision >= 0
        && (typeof event.activePublicKeyHex === "string" || event.activePublicKeyHex === null)
        && Boolean(event.presence)
        && !Array.isArray(event.presence);
    }
    if (event.topic === "plugin.intent") {
      return event.type === "plugin.intent.changed"
        && typeof event.authorityInstanceId === "string"
        && event.authorityInstanceId === this.bootstrapSnapshotCache.authorityInstanceId
        && Number.isSafeInteger(event.pluginIntentRevision)
        && event.pluginIntentRevision >= 0
        && Boolean(event.snapshot)
        && event.snapshot.revision === event.pluginIntentRevision
        && !Array.isArray(event.snapshot.desiredEnabled)
        && !Array.isArray(event.snapshot.desiredRevision);
    }
    if (event.topic === "worker.units") {
      const unitKeys = new Set<string>();
      return event.type === "coordinator.worker-units.changed"
        && typeof event.authorityInstanceId === "string"
        && event.authorityInstanceId === this.bootstrapSnapshotCache.authorityInstanceId
        && Number.isSafeInteger(event.workerUnitRevision)
        && event.workerUnitRevision >= 0
        && Array.isArray(event.units)
        && event.units.every((unit) => Boolean(unit)
          && typeof unit.productId === "string"
          && unit.productId.length > 0
          && typeof unit.unitId === "string"
          && unit.unitId.length > 0
          && unit.runtime === "shared-worker"
          && ["root", "storage", "owner-session", "connect-session"].includes(unit.scopeKind)
          && typeof unit.instanceId === "string"
          && unit.instanceId.length > 0
          && ["starting", "ready", "failed"].includes(unit.state)
          && Number.isSafeInteger(unit.snapshotRevision)
          && unit.snapshotRevision >= 0
          && Array.isArray(unit.serviceIds)
          && unit.serviceIds.every((serviceId) => typeof serviceId === "string" && serviceId.length > 0)
          && Array.isArray(unit.taskIds)
          && unit.taskIds.every((taskId) => typeof taskId === "string" && taskId.length > 0)
          && (unit.error === undefined || typeof unit.error === "string")
          && (["owner-session", "connect-session"].includes(unit.scopeKind)
            ? typeof unit.ownerPublicKeyHex === "string"
              && unit.ownerPublicKeyHex.length > 0
              && unit.sessionEpoch === event.sessionEpoch
            : unit.ownerPublicKeyHex === undefined && unit.sessionEpoch === undefined)
          && !unitKeys.has(`${unit.productId}\u0000${unit.unitId}`)
          && (unitKeys.add(`${unit.productId}\u0000${unit.unitId}`), true));
    }
    return event.type === "asset.data-changed" && Number.isSafeInteger(event.assetDataRevision);
  }

  /** 校验旧 Worker 仍持有最终 I/O 租约时发布的恢复诊断，避免不可信事件伪造接管状态。 */
  private isValidAuthorityRecovery(value: unknown): value is CoordinatorAuthorityRecovery {
    if (!value || typeof value !== "object") return false;
    const recovery = value as Partial<CoordinatorAuthorityRecovery>;
    const authorityBuildId = recovery.authorityBuildId;
    const activeIoLeaseCount = recovery.activeIoLeaseCount;
    const activeIoOperations = recovery.activeIoOperations;
    const handoverGeneration = recovery.handoverGeneration;
    return recovery.status === "recovery-required"
      && recovery.reason === "active-final-io-leases"
      && typeof authorityBuildId === "string"
      && authorityBuildId.length > 0
      && typeof activeIoLeaseCount === "number"
      && Number.isSafeInteger(activeIoLeaseCount)
      && activeIoLeaseCount > 0
      && Boolean(activeIoOperations)
      && typeof activeIoOperations === "object"
      && Number.isSafeInteger(activeIoOperations.read)
      && activeIoOperations.read >= 0
      && Number.isSafeInteger(activeIoOperations.write)
      && activeIoOperations.write >= 0
      && activeIoOperations.read + activeIoOperations.write === activeIoLeaseCount
      && typeof handoverGeneration === "number"
      && Number.isSafeInteger(handoverGeneration)
      && handoverGeneration >= 0;
  }

  // ============================================================
  // 9. Utility Methods
  // ============================================================

  private generateClientId(): string {
    return `client-${Date.now()}-${randomIdentifierSuffix()}`;
  }

  private generateRequestId(): string {
    return `req-${Date.now()}-${randomIdentifierSuffix()}`;
  }
}

// ============================================================
// 10. Factory Function
// ============================================================

export function createCoordinatorClient(options?: CoordinatorClientOptions): KeymasterSessionCoordinatorClient {
  return new KeymasterSessionCoordinatorClient(options);
}

// ============================================================
// 11. Singleton Instance
// ============================================================

let singletonClient: KeymasterSessionCoordinatorClient | null = null;

export function getCoordinatorClient(): KeymasterSessionCoordinatorClient {
  if (!singletonClient) {
    singletonClient = createCoordinatorClient();
  }
  return singletonClient;
}

export function __testResetCoordinatorClient(): void {
  if (singletonClient) {
    singletonClient.disconnect();
    singletonClient = null;
  }
}
