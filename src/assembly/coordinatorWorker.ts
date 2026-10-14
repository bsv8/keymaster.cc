import { createCoordinatorWorkerAuthority, type CoordinatorAuthorityRecord } from "../coordinator/workerAuthority.js";
import { VAULT_WORKER_WALLET_CONTROL_CAPABILITY, type VaultWorkerWalletControl } from "@keymaster/contracts";
import { createMsFileWorkerProjection } from "@keymaster/plugin-msfile/worker";
import { defineWorkerRequestRoute } from "@keymaster/contracts";
import { createStorageWorkerControl } from "@keymaster/platform-storage/worker";
import { createVaultWorkerOperations } from "@keymaster/plugin-vault/worker";
import { createVaultWalletWorker } from "@keymaster/plugin-vault/worker";
import { createStorageWorkerRoot } from "@keymaster/platform-storage/worker";
import { createMsFileWorkerRequests } from "@keymaster/plugin-msfile/worker";
import { createStorageWorkerRequests } from "@keymaster/platform-storage/worker";
import { createVaultWorkerKeys } from "@keymaster/plugin-vault/worker";
import { createChannelWorkerRuntime } from "@keymaster/plugin-sat-subscription/worker";
import { createWindowP2pWorkerRuntime } from "@keymaster/plugin-window-p2p/worker";
import { createVaultWorkerRuntime } from "@keymaster/plugin-vault/worker";
import { createStorageWorkerPlugin } from "@keymaster/platform-storage/worker";
import { createWindowP2pWorkerPlugin } from "@keymaster/plugin-window-p2p/worker";
import { createSatSubscriptionWorkerPlugin, createSatWorkerLifecycle, type SatWorkerRuntimeState } from "@keymaster/plugin-sat-subscription/worker";
import { createMsfileWorkerPlugin, createMsFileWorkerLifecycle } from "@keymaster/plugin-msfile/worker";
import { createP2pkhWorkerRuntime, createP2pkhWorkerOperations } from "@keymaster/plugin-p2pkh/worker";
import { createContactsWorkerRuntime } from "@keymaster/plugin-contacts/worker";
import { createWocWorkerRuntime } from "@keymaster/plugin-woc/worker";
import { createForumWorkerPlugin } from "@keymaster/plugin-forum/worker";
import { createTokenBsv21WorkerPlugin } from "@keymaster/plugin-token-bsv21/worker";
import { createTokenStasWorkerPlugin } from "@keymaster/plugin-token-stas/worker";
import { createCollectible1SatordinalsWorkerPlugin } from "@keymaster/plugin-collectible-1satordinals/worker";
import { WalletLockBarrier } from "../walletLockBarrier.js";

import { type NetworkIdentity } from "@keymaster/contracts";

import { createVaultBootstrapStorage } from "@keymaster/platform-storage/assembly";

import { createSatWorkerTransport } from "@keymaster/plugin-sat-subscription/coordinator";
import { createWorkerPresenceProjection } from "@keymaster/plugin-contacts/coordinator";
import { createWorkerAutoLock } from "@keymaster/plugin-vault/coordinator";
import { createWorkerBackgroundRuntime, type TaskRuntime } from "@keymaster/plugin-background/coordinator";
import { FORUM_WORKER_SERVICE_CAPABILITY, FORUM_WORKER_ATTACHMENT_CAPABILITY } from "@keymaster/contracts";

import { type WocWorkerBroadcastService, type WocServiceHandle } from "@keymaster/contracts";

import { isUnknownChannelPublishFailure } from "@keymaster/plugin-sat-subscription/coordinator";

import { createWorkerP2pkhSettings } from "@keymaster/plugin-p2pkh/coordinator";
import { createBitfsWorkerRuntime } from "@keymaster/plugin-msfile/coordinator";
import { createWorkerFundingRuntime } from "@keymaster/plugin-msfile/coordinator";

import { createKeyValueMaintenance } from "@keymaster/platform-storage/coordinator";

import { BUILTIN_PLUGIN_DEFINITIONS } from "@keymaster/contracts";
import { createWalletStateSource } from "@keymaster/plugin-vault/coordinator";
import { STORAGE_PRIVATE_BROWSE_CAPABILITY, type StorageBrowsePrivateCommand } from "@keymaster/platform-storage/assembly";
import { storagePrivateCapabilities } from "../assembly/storagePrivateCapabilities.js";
// src/keymasterSessionCoordinator.worker.ts
// Keymaster Session Coordinator SharedWorker
//
// 设计缘由（施工单 002）：
//   - 所有 Keymaster 主页面 tab 共享同一个 SharedWorker 中的 Vault 会话
//   - 私钥只在 Worker 内存中，永不离开
//   - 删除所有多 tab 竞争机制（leader 选举、BroadcastChannel 等）
//   - sessionEpoch 是每个异步操作的世代栅栏
//
// 关键约束：
//   - 不得 import React、页面 shell 或 plugin manifest
//   - 生产跨 realm 连接只由 WebLoom SharedWorker Runtime 接管
//   - Worker 重启后必为 locked，禁止恢复为 unlocked

import "../shims/buffer.js";

import type { SessionEpoch, CoordinatorVaultStatus, CoordinatorClientRequest as PublicCoordinatorClientRequest, CoordinatorResponse, CoordinatorTopicEvent, CoordinatorBootstrapSnapshot, CoordinatorTopic, CoordinatorBackgroundSyncSettings, CoordinatorTopicBaseline, AssetDataInvalidationEvent, SessionStateEvent, P2pkhTransactionBroadcastProvider, P2pkhUtxoSnapshotResult, CoordinatorSatStateEvent, CoordinatorContactsPresenceEvent, CoordinatorWorkerUnitStateEvent, CoordinatorWorkerUnitPublicSnapshot, CoordinatorAuthorityRecovery, CoordinatorRpcRequest, CoordinatorRpcResponse, CoordinatorRpcCommandRequest, CoordinatorSessionOpenRequest, CoordinatorSessionBinding, CoordinatorTopicSubscription, SnapshotStore, StorageSnapshotJsonCompatible, PluginStorageDeclaration } from "@keymaster/contracts";
/** 可信 Worker 入口内的命令联合；私有浏览不进入公共 transport parser。 */
type CoordinatorClientRequest = PublicCoordinatorClientRequest | StorageBrowsePrivateCommand;

import { CENTRAL_STORAGE_DECLARATIONS, SYSTEM_STORAGE_DECLARATIONS, deriveAppStorageName, coordinatorClientRequestFromRpc, parseCoordinatorResponseFor, isValidBackgroundSyncIntervalMs, BACKGROUND_TRIGGER_REASON, AUTO_LOCK_DEFAULT_TIMEOUT_MS, isValidAutoLockTimeoutMs, normalizeAutoLockTimeoutMs } from "@keymaster/contracts";
import { BUILTIN_PLUGIN_PRODUCT_ID_SET } from "@keymaster/contracts";

import { COORDINATOR_SERVICE_PROTOCOL_VERSION } from "@keymaster/contracts";
import {
  COORDINATOR_RPC_CAPABILITY,
  COORDINATOR_TOPIC_STREAM_CAPABILITY,
  COORDINATOR_OWNER_STORAGE_RPC_CAPABILITY,
  COORDINATOR_PLATFORM_STORAGE_RPC_CAPABILITY,
  COORDINATOR_CRYPTO_RPC_CAPABILITY,
} from "@keymaster/contracts";
import { MSFILE_READ_CONCURRENCY_RECOMMENDED, MSFILE_SELLER_SETTINGS_DEFAULT } from "@keymaster/contracts";
import { bytesToHex, installInsecureContextCryptoFallback, hexToBytes as cryptoHexToBytes, deriveP2pkhAddress } from "@keymaster/plugin-vault/coordinator";
// 不能通过 runtime barrel 导入：它 re-export React hooks，Vite 会把
// React Refresh 注入 SharedWorker，后者没有 window。
import { WebLoomError, definePlugin, startSharedWorkerApp, type HandlerCallContext, type PeerController } from "webloom-framework";
import { canCoalesceStorageActivity } from "../coordinator/storageActivityCoalescing.js";

import { type FinalIoAuditOperation } from "../coordinator/finalIoAudit.js";

import { type CoordinatorAuthorityLock } from "../coordinator/coordinatorAuthorityLock.js";
import {
  assertCoordinatorWorkerUnitCatalog,
  COORDINATOR_WORKER_UNIT_CATALOG,
  getCoordinatorWorkerUnitForTask,
} from "../coordinator/workerUnitCatalog.js";
import { createCoordinatorWorkerUnitRegistry } from "../coordinator/workerUnitRuntime.js";
import {
  COORDINATOR_TRANSPORT_UNIT_ID,
  describeUnitUnavailableForFramework,
  evaluateCoordinatorUnitAvailability,
  evaluateCoordinatorUnitConstructionPreconditions,
  evaluateCoordinatorUnitStartupPreconditions,
  isCoordinatorUnitUnavailableError,
  CoordinatorUnitUnavailableError,
  type CoordinatorUnitAvailabilityContext,
} from "../coordinator/workerUnitAvailability.js";
import { createWocService, registerWocP2pkhProviders } from "@keymaster/plugin-woc/coordinator";
import { p2pkhAddressToScriptHex } from "@keymaster/plugin-p2pkh/coordinator";
import { createP2pkhFileRepository, disposeP2pkhStateRepository, parseP2pkhTransaction } from "@keymaster/plugin-p2pkh/coordinator";

import type { BorrowedModuleFileStore, KeyValueStore, PlatformRootStore, WocService, BsvNetwork } from "@keymaster/contracts";

import type { StorageRuntimeController, AssetDataChangedEvent, WocUtxoResponse } from "@keymaster/contracts";
import { createScopedStorageClients, createStorageRpcHandlers, createWorkerStorageClients, createIndexedDbWalletStore, StorageRuntimeError } from "@keymaster/platform-storage/coordinator";

import { type WalletKeyRepository } from "@keymaster/plugin-vault/coordinator";
import type { StoragePrivateRootStore } from "@keymaster/platform-storage/coordinator";

// SharedWorker 的模块状态（包括 session epoch）会在下面初始化；先安装
// HTTP fallback，避免 insecure host 上的首个随机 ID 读取到缺失的 randomUUID。
installInsecureContextCryptoFallback();

let fallbackIdentifierCounter = 0;
function randomIdentifierSuffix(): string {
  try {
    return Array.from(crypto.getRandomValues(new Uint32Array(2)), (value) => value.toString(36)).join("");
  } catch {
    // Web Crypto 缺失时这里只提供进程内唯一性；生产启动会在更早的环境
    // 检查中失败，不能把这个回退当成安全随机源。
    fallbackIdentifierCounter += 1;
    return fallbackIdentifierCounter.toString(36);
  }
}

// MSFile runtime 真值在 Coordinator SharedWorker；transport 由 Window executor 注入。
import { type MsFileServiceImpl } from "@keymaster/plugin-msfile/coordinator";
import { createWindowP2pMsFileTransport } from "@keymaster/plugin-msfile/executor-transport";

// 施工单 2026-08-26/001：identity/signing 的 payload 与 Peer Record 编码必须来自
// bitcoin-libp2p；Worker 只持有 active private key 并做标准 DER 签名。
import { validatePublicKey } from "bitcoin-libp2p/identity";
// Channel 密码学和固定 inbox 路由只在 SharedWorker 调用；Window executor
// 只看 SSP wire，不会收到私钥或明文。

import { configureProtocolStorageRepository, getConnectSession as getAuthoritativeConnectSession, isVerifiedAppIdentitySnapshot } from "@keymaster/plugin-protocol/coordinator";
import { type SatDefaultNetwork, type SatSupplierConnection } from "@keymaster/plugin-sat-subscription/coordinator";

function decodePersisted(value: string): Uint8Array {
  return cryptoHexToBytes(value);
}

function snapshotRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new StorageRuntimeError("storage_provider_error", `${name} snapshot value is invalid`);
  }
  return value as Record<string, unknown>;
}

function validateCoordinatorSettingsSnapshot(value: unknown): CoordinatorSettingsSnapshot {
  const record = snapshotRecord(value, "Coordinator settings");
  // 兼容旧快照：只有 scheduleSettings；新快照可携带 autoLockTimeoutMs。
  // 旧快照缺字段时回落到缺省，而不是让 Worker 启动失败。
  const keys = Object.keys(record);
  const hasSchedule = Object.prototype.hasOwnProperty.call(record, "scheduleSettings");
  const hasAutoLock = Object.prototype.hasOwnProperty.call(record, "autoLockTimeoutMs");
  if (!hasSchedule || keys.some((k) => k !== "scheduleSettings" && k !== "autoLockTimeoutMs")) {
    throw new StorageRuntimeError("storage_provider_error", "Coordinator settings snapshot value is invalid");
  }
  const settings = snapshotRecord(record.scheduleSettings, "Coordinator schedule settings");
  // 兼容 2026-09-20 之前的旧形状（只有 assetHoldingsIntervalMs）：旧周期
  // 选项已废弃，直接回落到同步管理缺省，而不是让整个 Worker 启动失败。
  if (Object.prototype.hasOwnProperty.call(settings, "assetHoldingsIntervalMs")
    && !Object.prototype.hasOwnProperty.call(settings, "taskIntervals")) {
    return {
      scheduleSettings: { taskIntervals: {} },
      autoLockTimeoutMs: parsePersistedAutoLockTimeoutMs(record.autoLockTimeoutMs),
    };
  }
  if (Object.keys(settings).length !== 1 || !Object.prototype.hasOwnProperty.call(settings, "taskIntervals")) {
    throw new StorageRuntimeError("storage_provider_error", "Coordinator schedule settings are invalid");
  }
  const intervals = snapshotRecord(settings.taskIntervals, "Coordinator schedule taskIntervals");
  const taskIntervals: Record<string, number> = {};
  for (const [taskId, interval] of Object.entries(intervals)) {
    if (typeof taskId !== "string" || taskId.length === 0 || taskId.length > 128
      || !isValidBackgroundSyncIntervalMs(interval)) {
      throw new StorageRuntimeError("storage_provider_error", "Coordinator schedule settings are invalid");
    }
    taskIntervals[taskId] = interval;
  }
  return { scheduleSettings: { taskIntervals }, autoLockTimeoutMs: parsePersistedAutoLockTimeoutMs(record.autoLockTimeoutMs) };
}

function parsePersistedAutoLockTimeoutMs(value: unknown): number {
  if (value === undefined) return AUTO_LOCK_DEFAULT_TIMEOUT_MS;
  if (!isValidAutoLockTimeoutMs(value)) {
    throw new StorageRuntimeError("storage_provider_error", "Coordinator auto-lock settings are invalid");
  }
  return value as number;
}

interface CoordinatorRuntimeSettings {
  scheduleSettings: CoordinatorBackgroundSyncSettings;
  autoLockTimeoutMs: number;
  p2pkhProviderConfigs: Record<string, Record<string, unknown>>;
  p2pkhSettings: { bsvNetwork: "main" | "test" };
}
/** 桶级 Coordinator snapshot 持久化同步管理 + 自动锁；P2PKH 偏好归 owner 的 setting.json。 */
type CoordinatorSettingsSnapshot = Pick<CoordinatorRuntimeSettings, "scheduleSettings" | "autoLockTimeoutMs">;
function defaultCoordinatorRuntimeSettings(): CoordinatorRuntimeSettings {
  return {
    scheduleSettings: { taskIntervals: {} },
    autoLockTimeoutMs: AUTO_LOCK_DEFAULT_TIMEOUT_MS,
    p2pkhProviderConfigs: {},
    p2pkhSettings: { bsvNetwork: "main" },
  };
}
const coordinatorMeta: CoordinatorRuntimeSettings = defaultCoordinatorRuntimeSettings();

/** 每次 Worker 载入生成一次；Worker 重启后必须变化。 */

// 正式构建由 scripts/build-plugin-lifecycle.mjs 注入不可变 buildId。
// 本地开发/单测没有构建注入时才回退到模块 URL；该回退不能用于发布证据。
const COORDINATOR_BUILD_ID = import.meta.env.VITE_KEYMASTER_BUILD_ID ?? import.meta.url;
// 跨 Worker 的发布/回退由 Keymaster authority Web Lock 与部署交接协议控制；
// 这里仅保留协议字段，供本次 Worker 的内存 gate 和旧页面/旧授权迟到检查使用。
const COORDINATOR_UPGRADE_PROTOCOL_VERSION = COORDINATOR_SERVICE_PROTOCOL_VERSION;
const coordinatorAuthority = createCoordinatorWorkerAuthority({  
buildId: COORDINATOR_BUILD_ID, protocolVersion: COORDINATOR_UPGRADE_PROTOCOL_VERSION, identifierSuffix: randomIdentifierSuffix,
  session: () => ({ sessionEpoch: coordinatorState.sessionEpoch, runGeneration: coordinatorState.runGeneration, vaultStatus: coordinatorState.vaultStatus }), admission: { acquire: (exclusive, signal) => vaultWorkerKeys.migrationFence.acquire(exclusive, signal) },
});
const { makeCoordinatorAuthorityInstanceId, coordinatorUpgradeError, readCoordinatorAuthorityRecord, claimCoordinatorAuthority, scheduleCoordinatorAuthorityClaim, ensureCoordinatorAuthorityClaim, assertCoordinatorAuthorityCurrent, makeCoordinatorFinalIoLeaseId, acquireCoordinatorFinalIoLeaseExclusive, withCoordinatorSharedReadLeaseMutation, hasCurrentCoordinatorSharedReadLease, acquireCoordinatorFinalIoLease, ensureCoordinatorUpgradeSession, withCoordinatorFinalIoLease, withCoordinatorFinalIoLeaseAdmitted, closeCoordinatorUpgradeSession } = coordinatorAuthority;

/** 当前物理 Worker 持有的 Keymaster origin 级跨 Worker authority。 */

/** 兼容旧快照字段；新版不从业务 K-V 恢复旧 Worker 的临时租约。 */

let keyDeletionTail: Promise<void> = Promise.resolve();

let p2pkhWocService: ReturnType<typeof createWocService> | undefined;

/**
 * Worker 内唯一链高度读数（2026-09-26）。
 * 真值只来自节点 `/chain/info`；读取失败保留旧值并保持 available=true，
 * 首次成功之前为 available=false。消费者必须先看 available。
 */
const coordinatorTaskRegistrar: import("@keymaster/contracts").WorkerTaskRegistrar = {
  register: (task, assertActive) => backgroundWorkerRuntime.register(task, assertActive),
};
const wocWorkerRuntime = createWocWorkerRuntime({
  tasks: coordinatorTaskRegistrar,
  settings: () => coordinatorMeta.p2pkhProviderConfigs?.woc,
  queueChanged: snapshot => onWocQueueChanged(snapshot),
  publishHeight: chainHeight => { publishTopicEvent("chain.height", { type: "chain.height.changed", sessionEpoch: coordinatorState.sessionEpoch, chainHeight }); },
});
let testP2pkhBroadcastProvider: P2pkhTransactionBroadcastProvider | undefined;
/** 测试专用：替换快照 store 的 `unspent/all` 数据源，避免测试出网。 */
let testP2pkhUnspentAllProvider: ((network: "main" | "test", address: string) => Promise<WocUtxoResponse[]>) | undefined;
/** 测试专用：替换链高度读取源，避免单测出网。 */
let testChainHeightProvider: ((network: BsvNetwork) => Promise<number>) | undefined;
/** 测试专用：缩短 Worker 内中心广播服务的重试预算。 */
let testSatBroadcastRetryOverrides: { maxAttempts?: number; deadlineMs?: number; initialBackoffMs?: number; maxBackoffMs?: number } | undefined;
let testPersistCoordinatorSnapshotFailure = false;

/**
 * 测试专用：记录 Coordinator 两个中央快照在本 Worker 运行内的提交次数与
 * 最新 revision。它只统计真实提交成功的写入，因此可以断言“设置确实落到
 * IndexedDB 而不是只改了内存”。
 */
const testCoordinatorSnapshotMetrics = new Map<FinalIoAuditOperation, { revision: number; writes: number }>();

/** 读取某个中央快照的提交统计；未被提交过时 revision/writes 均为 0。 */
function snapshotWriteMetrics(operation: FinalIoAuditOperation): { revision: number; writes: number } {
  const current = testCoordinatorSnapshotMetrics.get(operation);
  return { revision: current?.revision ?? 0, writes: current?.writes ?? 0 };
}

// ============================================================
// 单钱包本地存储：正式装配点
// ============================================================

/** 唯一正式本地介质；生产路径只有这一个 IndexedDB 句柄。 */

const vaultWalletWorker = createVaultWalletWorker({
  session: () => ({ walletGeneration: coordinatorState.walletGeneration, sessionEpoch: coordinatorState.sessionEpoch, runGeneration: coordinatorState.runGeneration }),
  commit: patch => Object.assign(coordinatorState, patch),
  createStore: () => storageWorkerRoot.activity.wrap(createIndexedDbWalletStore()), bootstrapStorage: createVaultBootstrapStorage,
  unavailable: storageUnavailableError, network: bsvNetwork => { coordinatorMeta.p2pkhSettings = { bsvNetwork }; },
  transitions: { revokeGrants: revokeWalletGrants, establishSession: establishWalletSession, adoptUnlockedKey: input => vaultWorkerOperations.adoptUnlockedKey(input) },
  clearAppRoot: clearThirdPartyAppRoot,
  binding: {
    installRoot: () => installPlatformStorage(), loadSettings: () => loadCoordinatorMeta(), ensureStorage: () => ensureStorageRuntime(),
    ensureTasks: () => ensureCoordinatorTasksRegistered(), complete: cause => completeUnlockedBinding(cause), lock: reason => performGlobalLock(reason),
  },
});

const storageWorkerRoot = createStorageWorkerRoot({
  session: () => ({ walletGeneration: coordinatorState.walletGeneration, sessionEpoch: coordinatorState.sessionEpoch, runGeneration: coordinatorState.runGeneration, vaultStatus: coordinatorState.vaultStatus, activePublicKeyHex: coordinatorState.activePublicKeyHex }),
  wallet: {
    store: () => vaultWalletWorker.walletStore,
    async identity() { const file = await vaultWalletWorker.walletKeys?.read(); if (!file) throw new StorageRuntimeError("storage_identity_required", "Wallet network identity is unavailable"); return { bsvNetwork: file.document.bsvNetwork, publicKeyHex: file.document.publicKeyHex }; },
    label: () => vaultWalletWorker.walletKeys ? readWalletKeyLabel(vaultWalletWorker.walletKeys) : Promise.resolve(undefined),
    coldStart: () => vaultWalletWorker.storageColdStartState, lifecycleReady: () => Boolean(vaultWalletWorker.walletLifecycle),
  },
  async artifacts(root) {
    let settings: SnapshotStore<CoordinatorSettingsSnapshot> | undefined;
    let protocol: CoordinatorProtocolStorageStores | undefined;
    try {
      settings = await root.openPlatformSnapshot({ declaration: CENTRAL_STORAGE_DECLARATIONS.coordinatorSettings, validate: validateCoordinatorSettingsSnapshot });
      protocol = await openCoordinatorProtocolStorageStores(root);
      const ownedSettings = settings; const ownedProtocol = protocol;
      return {
        commit() {
          coordinatorSettingsSnapshot?.close(); configureProtocolStorageRepository(ownedProtocol);
          registerCoordinatorProtocolMaintenanceStores(ownedProtocol);
          coordinatorSettingsSnapshot = ownedSettings; coordinatorProtocolStores = ownedProtocol;
        },
        dispose() { closeCoordinatorProtocolStorageStores(ownedProtocol); ownedSettings.close(); },
      };
    } catch (error) { closeCoordinatorProtocolStorageStores(protocol); settings?.close(); throw error; }
  },
  io: execute => withCoordinatorFinalIoLease("write", undefined, execute, { allowLocalLock: true, auditOperation: "storage.retired-plugin-intent.cleanup" }),
  lifecycle: {
    ready() { const unit = coordinatorWorkerUnitRegistry.activate("storage.coordinator-worker"); coordinatorWorkerUnitRegistry.ready(unit.unitId, unit.instanceId); },
    stop() { const unit = coordinatorWorkerUnitRegistry.get("storage.coordinator-worker"); if (unit) stopCoordinatorWorkerUnit(unit.unitId, unit.instanceId); },
    reconcile: () => { void reconcileCoordinatorRuntime(); }, maintenance: () => scheduleCoordinatorKeyValueMaintenance(),
  },
  abortSession: id => storageWorkerRequests.revokeStorageSessionRequests(id),
  revokeRequests() { abortStorageRequests(); storageWorkerRequests.storageGrants.clear(); storageWorkerRequests.ownerStorageGrants.clear(); storageWorkerRequests.platformStorageGrants.clear(); },
  invalidateClients() { workerStorageClients.invalidateAll(); storageWorkerRequests.ownerStorageGrants.clear(); storageWorkerRequests.platformStorageGrants.clear(); },
  recover: peerId => resumeAfterStorageReady(peerId), assertAuthority: ensureCoordinatorAuthorityClaim,
  recovery: () => coordinatorAuthority.coordinatorAuthorityRecovery,
  publish: event => { publishTopicEvent("storage.state", event); },
});
function installPlatformStorage(...args: Parameters<typeof storageWorkerRoot.install>) { return storageWorkerRoot.install(...args); }
function emitStorageState(...args: Parameters<typeof storageWorkerRoot.emit>) { return storageWorkerRoot.emit(...args); }
function runStorageRecoveryOrchestrator(...args: Parameters<typeof storageWorkerRoot.recover>) { return storageWorkerRoot.recover(...args); }
function markStorageIoFailure(...args: Parameters<typeof storageWorkerRoot.failure>) { return storageWorkerRoot.failure(...args); }
function isStorageFailure(...args: Parameters<typeof storageWorkerRoot.isFailure>) { return storageWorkerRoot.isFailure(...args); }
function assertStorageDataAvailable(...args: Parameters<typeof storageWorkerRoot.assertAvailable>) { return storageWorkerRoot.assertAvailable(...args); }
function ensureStorageRuntime(_peerId?: string) { return storageWorkerRoot.ensure(); }
function coordinatorStorageStatus(...args: Parameters<typeof storageWorkerRoot.status>) { return storageWorkerRoot.status(...args); }
function releaseStorageRuntime(_reason: string) { return storageWorkerRoot.release(); }

const vaultWorkerKeys = createVaultWorkerKeys({
  session: () => ({ vaultStatus: coordinatorState.vaultStatus, sessionEpoch: coordinatorState.sessionEpoch, activePublicKeyHex: coordinatorState.activePublicKeyHex, runGeneration: coordinatorState.runGeneration }),
  storage: {
    ready: () => storageWorkerRoot.ready && Boolean(storageWorkerRoot.root), token: () => storageWorkerRoot.token,
    payments: () => workerStorageClients.platformFiles("vault", "payments"), unavailable: storageUnavailableError
  },
  lock: reason => performGlobalLock(reason), providerScope: () => vaultWorkerRuntime.providerScope(),
  allowUnscopedCrypto: () => testDomainUnitReadiness,
  io: { run: (operation, signal, execute, options) => withCoordinatorFinalIoLease(operation, signal, execute, { ...options, auditOperation: options.auditOperation }) },
});

/** 单钱包生命周期：冷启动、创建/导入、解锁、锁定、改密、改名、导出与重置。 */

/** 当前已装配的平台存储根；重置或 Worker 重启后重建。 */

/** Root 安装令牌；不能用 walletGeneration 代替，因为重置后可能复用世代值。 */

let coordinatorSettingsSnapshot: SnapshotStore<CoordinatorSettingsSnapshot> | undefined;
/** Protocol 的三个 platform-only purpose K-V。 */
interface CoordinatorProtocolStorageStores {
  durablePolicy: KeyValueStore;
  sessions: KeyValueStore;
  commandHistory: KeyValueStore;
}
let coordinatorProtocolStores: CoordinatorProtocolStorageStores | undefined;

let storageRootInstallationActive = false;
/** 冷启动只读结果；corrupt/unsupported 时进入明确错误界面，不静默建空钱包。 */

let coordinatorInitializationInProgress = false;
/** 仅供 Worker 测试 seam 使用；生产路径没有 active-key 密码缓存。 */
let testHarnessActivationSecret: string | undefined;

const vaultWorkerOperations = createVaultWorkerOperations({
  keys: vaultWorkerKeys, wallet: vaultWalletWorker,
  session: () => ({ vaultStatus: coordinatorState.vaultStatus, sessionEpoch: coordinatorState.sessionEpoch, runGeneration: coordinatorState.runGeneration, walletGeneration: coordinatorState.walletGeneration, activePublicKeyHex: coordinatorState.activePublicKeyHex }),
  commit: patch => Object.assign(coordinatorState, patch), cleanupPending: () => walletLockBarrier.snapshot(), peerRevoked: peerId => revokedCoordinatorPeerIds.has(peerId), newEpoch: generateEpoch,
  network: bsvNetwork => { coordinatorMeta.p2pkhSettings = { bsvNetwork }; }, publishWallet: () => workerWalletState.publish(), publishSession: cause => publishSessionState(cause), clearActivationCredential: () => { testHarnessActivationSecret = undefined; },
  storage: {
    token: () => storageWorkerRoot.token, hasRoot: () => Boolean(storageWorkerRoot.root), payments: () => workerStorageClients.platformFiles("vault", "payments"),
    revokeGrants: () => storageWorkerRequests.revokeStorageSessionGrants(), invalidateClients: () => workerStorageClients.invalidateAll(), unavailable: storageUnavailableError, failure: markStorageIoFailure, errorResponse: storageErrorResponse, changed: () => emitStorageState(), revokeBindingAndDrain: reason => revokeStorageBindingAndDrain(reason), discardBinding: () => discardCurrentPlatformStorageBinding()
  },
  binding: { installRoot: () => installPlatformStorage(), loadSettings: () => loadCoordinatorMeta(), ensureStorage: () => ensureStorageRuntime(), ensureTasks: () => ensureCoordinatorTasksRegistered(), complete: cause => completeUnlockedBinding(cause), lock: reason => performGlobalLock(reason) },
  io: { assertAuthority: () => assertCoordinatorAuthorityCurrent(), closeSession: reason => closeCoordinatorUpgradeSession(reason), run: (kind, signal, execute, options) => withCoordinatorFinalIoLease(kind, signal, execute, { ...options, auditOperation: options.auditOperation }) },
});

function registerCoordinatorProtocolMaintenanceStores(stores: CoordinatorProtocolStorageStores | undefined): void {
  if (!stores) return;
  registerCoordinatorKeyValueMaintenanceStore(stores.durablePolicy);
  registerCoordinatorKeyValueMaintenanceStore(stores.sessions);
  registerCoordinatorKeyValueMaintenanceStore(stores.commandHistory);
}

function unregisterCoordinatorProtocolMaintenanceStores(stores: CoordinatorProtocolStorageStores | undefined): void {
  if (!stores) return;
  unregisterCoordinatorKeyValueMaintenanceStore(stores.durablePolicy);
  unregisterCoordinatorKeyValueMaintenanceStore(stores.sessions);
  unregisterCoordinatorKeyValueMaintenanceStore(stores.commandHistory);
}

function closeCoordinatorProtocolStorageStores(stores: CoordinatorProtocolStorageStores | undefined): void {
  if (!stores) return;
  stores.durablePolicy.close();
  stores.sessions.close();
  stores.commandHistory.close();
}

let coordinatorWalletControl: VaultWorkerWalletControl | undefined;
function walletControl(): VaultWorkerWalletControl {
  if (testDomainUnitReadiness) return vaultWorkerOperations.walletControl;
  if (!coordinatorWalletControl) throw storageUnavailableError("Vault Worker control is unavailable");
  return coordinatorWalletControl;
}
const storageWorkerControl = createStorageWorkerControl({
  root: storageWorkerRoot, wallet: { coldStart: () => walletControl().coldStart(), persistence: () => walletControl().persistence(), closeHardware: () => walletControl().closeHardware(), execute: control => walletControl().execute(control) },
  session: () => ({ sessionEpoch: coordinatorState.sessionEpoch }), commit: patch => Object.assign(coordinatorState, patch), cleanupPending: () => walletLockBarrier.snapshot(), recoveryOperations: () => coordinatorAuthority.coordinatorAuthorityRecoveryOperationNames, unavailable: storageUnavailableError,
  lock: reason => performGlobalLock(reason), revokeBinding: reason => revokeStorageBindingAndDrain(reason), discardBinding: () => discardCurrentPlatformStorageBinding(), publishSession: cause => publishSessionState(cause),
  io: { run: (kind, signal, execute, options) => withCoordinatorFinalIoLease(kind, signal, execute, { ...options, auditOperation: options.auditOperation }) },
});

const storageWorkerRequests = createStorageWorkerRequests({
  session: () => ({ sessionEpoch: coordinatorState.sessionEpoch, walletGeneration: coordinatorState.walletGeneration, runGeneration: coordinatorState.runGeneration, vaultStatus: coordinatorState.vaultStatus, activePublicKeyHex: coordinatorState.activePublicKeyHex }),
  root: () => storageWorkerRoot.root, token: () => storageWorkerRoot.token, ready: () => storageWorkerRoot.ready,
  assertAvailable: assertStorageDataAvailable, unavailable: storageUnavailableError, ensureRuntime: ensureStorageRuntime,
  appSession: readProtocolConnectSession, appStorageName: resolveConnectAppStorageName, failure: markStorageIoFailure,
  admission: {
    open(peerId) { const state = coordinatorPeerState(peerId); return Boolean(state?.sessionOpen && state.status === "open" && state.peer.scope.state === "active" && state.sessionBinding && state.openCommitOrder !== undefined); },
    revoked: peerId => revokedCoordinatorPeerIds.has(peerId), response: disconnectedClientResponse,
  },
  io: { run: (operation, signal, execute, options) => withCoordinatorFinalIoLease(operation, signal, execute, { ...options, auditOperation: options.auditOperation }) },
  clearSecrets: request => storageWorkerControl.clearSecrets(request), errorResponse: storageErrorResponse,
  control: (...args) => storageWorkerControl.execute(...args),
});

const storageKeyValueMaintenance = createKeyValueMaintenance({ root: () => storageWorkerRoot.root, rootToken: () => storageWorkerRoot.token, isReady: () => storageWorkerRoot.ready, ownerGrants: () => storageWorkerRequests.ownerStorageGrants.values() });
const registerCoordinatorKeyValueMaintenanceStore = storageKeyValueMaintenance.register;
const unregisterCoordinatorKeyValueMaintenanceStore = storageKeyValueMaintenance.unregister;
const stopCoordinatorKeyValueMaintenance = storageKeyValueMaintenance.stop;
const scheduleCoordinatorKeyValueMaintenance = storageKeyValueMaintenance.schedule;

async function openCoordinatorProtocolStorageStores(root: PlatformRootStore): Promise<CoordinatorProtocolStorageStores> {
  const opened: KeyValueStore[] = [];
  try {
    const durablePolicy = await root.openPlatformStore({ declaration: CENTRAL_STORAGE_DECLARATIONS.protocolDurablePolicy });
    opened.push(durablePolicy);
    const sessions = await root.openPlatformStore({ declaration: CENTRAL_STORAGE_DECLARATIONS.protocolSessions });
    opened.push(sessions);
    const commandHistory = await root.openPlatformStore({ declaration: CENTRAL_STORAGE_DECLARATIONS.protocolCommandHistory });
    opened.push(commandHistory);
    return { durablePolicy, sessions, commandHistory };
  } catch (error) {
    for (const store of opened) store.close();
    throw error;
  }
}

interface CurrentPlatformStorageBinding {
  root?: StoragePrivateRootStore;
  rootToken?: object;
  settingsSnapshot?: SnapshotStore<CoordinatorSettingsSnapshot>;
  protocol?: CoordinatorProtocolStorageStores;
  runtime?: StorageRuntimeController & { dispose?: () => void };
}

function captureCurrentPlatformStorageBinding(): CurrentPlatformStorageBinding {
  return {
    root: storageWorkerRoot.root,
    rootToken: storageWorkerRoot.token,
    settingsSnapshot: coordinatorSettingsSnapshot,
    protocol: coordinatorProtocolStores,
    runtime: storageWorkerRoot.controller as (StorageRuntimeController & { dispose?: () => void }) | undefined,
  };
}

function replaceCoordinatorMeta(next: CoordinatorRuntimeSettings): void {
  const mutable = coordinatorMeta as unknown as Record<string, unknown>;
  for (const key of Object.keys(mutable)) {
    delete mutable[key];
  }
  Object.assign(coordinatorMeta, structuredClone(next));
  coordinatorMeta.scheduleSettings ??= { taskIntervals: {} };
  coordinatorMeta.scheduleSettings.taskIntervals ??= {};
  coordinatorMeta.autoLockTimeoutMs = normalizeAutoLockTimeoutMs(
    (next as Partial<CoordinatorRuntimeSettings>).autoLockTimeoutMs
  );
  coordinatorMeta.p2pkhSettings ??= { bsvNetwork: "main" };
  coordinatorMeta.p2pkhProviderConfigs ??= {};
}

function disposeCurrentPlatformStorageBinding(binding: CurrentPlatformStorageBinding): void {
  unregisterCoordinatorProtocolMaintenanceStores(binding.protocol);
  try { binding.runtime?.dispose?.(); } catch { /* best effort */ }
  binding.settingsSnapshot?.close();
  closeCoordinatorProtocolStorageStores(binding.protocol);
}

// ============================================================
// 9.5 Storage Browse (read-only)
// ============================================================

/** 撤销当前存储根：所有已发放句柄与迟到结果立即失效。 */
function discardCurrentPlatformStorageBinding(): void {
  void vaultWorkerKeys.hardwareConnections.close();
  stopCoordinatorKeyValueMaintenance();
  storageWorkerRequests.storageBrowseCoordinator.dropBinding();
  const binding = captureCurrentPlatformStorageBinding();
  workerStorageClients.invalidateAll();
  disposeCurrentPlatformStorageBinding(binding);
  storageWorkerRoot.root = undefined;
  storageWorkerRoot.token = undefined;
  coordinatorSettingsSnapshot = undefined;
  coordinatorProtocolStores = undefined;
  storageWorkerRoot.controller = undefined;
  storageWorkerRoot.ready = false;
}

async function loadCoordinatorMeta(): Promise<void> {
  const [settings] = await Promise.all([
    coordinatorSettingsSnapshot?.read(),
  ]);
  // 冷启动不再恢复 selected Key：正常启动一律进入锁定状态。
  const defaults = defaultCoordinatorRuntimeSettings();
  replaceCoordinatorMeta({
    ...defaults,
    ...(settings?.value ?? {}),
  });
  coordinatorState.scheduleSettings = coordinatorMeta.scheduleSettings;
  coordinatorState.autoLockTimeoutMs = coordinatorMeta.autoLockTimeoutMs;
}

async function writeCoordinatorSnapshot<T>(
  store: SnapshotStore<T> | undefined,
  value: StorageSnapshotJsonCompatible<T>,
  auditOperation: FinalIoAuditOperation,
): Promise<void> {
  if (!store) throw new Error("Coordinator storage has not been bootstrapped");
  if (testPersistCoordinatorSnapshotFailure) {
    testPersistCoordinatorSnapshotFailure = false;
    throw new Error("injected coordinator snapshot persist failure");
  }
  await withCoordinatorFinalIoLease("write", undefined, async () => {
    const current = await store.read();
    await store.write(value, { ifRevision: current?.revision ?? 0 });
    const metrics = testCoordinatorSnapshotMetrics.get(auditOperation)
      ?? { revision: 0, writes: 0 };
    testCoordinatorSnapshotMetrics.set(auditOperation, {
      revision: (current?.revision ?? 0) + 1,
      writes: metrics.writes + 1,
    });
  }, { auditOperation });
}

async function persistCoordinatorSettings(settings: CoordinatorSettingsSnapshot = {
  scheduleSettings: coordinatorMeta.scheduleSettings,
  autoLockTimeoutMs: coordinatorMeta.autoLockTimeoutMs,
}): Promise<void> {
  await writeCoordinatorSnapshot(coordinatorSettingsSnapshot, structuredClone(settings), "coordinator.settings.persist");
}

/** 业务 K-V CAS 冲突判断；只服务 bucket/profile 等业务状态，不用于运行锁。 */
function isStorageConflict(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  return code === "storage_conflict"
    || (error instanceof Error && /partition revision changed|concurrently|conflict/i.test(error.message));
}

let testStorageSessionResolver: ((sessionId: string) => Promise<{ sessionId: string; origin: string; networkIdentity?: import("@keymaster/contracts").NetworkIdentity; ownerPublicKeyHex?: string; appIdentity: import("@keymaster/contracts").OwnerAppStorageGrant["appIdentity"]; revokedAt: number | null } | null>) | undefined;

function isValidStorageIdentity(identity: unknown): identity is import("@keymaster/contracts").OwnerAppStorageGrant["appIdentity"] {
  return isVerifiedAppIdentitySnapshot(identity);
}

/**
 * 解析一个已验证 App 身份的平台登记存储名。
 *
 * 目录名只由验证身份派生：相同身份的 App 永远落进同一个 `apps/<name>/`，
 * 不同身份即使显示名称相同也得到不同目录。这样「同名不同身份」在没有任何
 * 显式登记记录时也不会共用目录，而显示名称或本地化变化不会移动已有目录。
 */
function resolveConnectAppStorageName(verifiedAppIdentity: { publisherPublicKeyHex: string; appId: string }): string {
  return deriveAppStorageName({
    publisherPublicKeyHex: verifiedAppIdentity.publisherPublicKeyHex,
    appId: verifiedAppIdentity.appId,
  });
}

/**
 * 第三方 App 文件 namespace 的声明形状。
 *
 * 它不在中央声明目录里：每个 App 的 moduleId 由验证身份派生，目录由平台
 * 登记的 appStorageName 决定。只有在需要「按 name 定位一个目录」（如单 App
 * 清理）而调用方尚未提供具体身份时，才使用这条中性坐标；
 * `buildWalletStorageRoot` 对 third-party-app 只读取 appStorageName，因此这里的
 * moduleId 不参与任何路径计算。
 */
const THIRD_PARTY_APP_FILES_DECLARATION = Object.freeze({
  moduleId: "third-party-app",
  purposeId: "",
  authority: "third-party-app",
  model: "files",
  schemaVersion: 1,
} satisfies PluginStorageDeclaration);

async function readProtocolConnectSession(identity: import("@keymaster/contracts").NetworkIdentity, origin: string): Promise<{ sessionId: string; origin: string; networkIdentity: import("@keymaster/contracts").NetworkIdentity; ownerPublicKeyHex: string; appIdentity: import("@keymaster/contracts").OwnerAppStorageGrant["appIdentity"]; revokedAt: number | null } | null> {
  if (testStorageSessionResolver) {
    const resolved = await testStorageSessionResolver(identity.publicKeyHex);
    return resolved && resolved.revokedAt === null && Boolean(resolved.sessionId && resolved.origin) && isValidStorageIdentity(resolved.appIdentity)
      ? { sessionId: resolved.sessionId, origin: resolved.origin, networkIdentity: resolved.networkIdentity!, ownerPublicKeyHex: resolved.ownerPublicKeyHex ?? "", appIdentity: resolved.appIdentity, revokedAt: null }
      : null;
  }
  const record = await getAuthoritativeConnectSession(identity, origin);
  return record && isValidStorageIdentity(record.appIdentity)
    ? { sessionId: record.sessionId, origin: record.origin, networkIdentity: record.networkIdentity, ownerPublicKeyHex: record.ownerPublicKeyHex, appIdentity: record.appIdentity, revokedAt: null }
    : null;
}

function normalizedCoordinatorOwner(): string | null {
  return coordinatorState.vaultStatus === "unlocked" && coordinatorState.activePublicKeyHex
    ? coordinatorState.activePublicKeyHex.trim().toLowerCase()
    : null;
}

/** 将 Worker 内唯一 Contacts 在线真值投影为页面可订阅的快照事件。 */
function publishCoordinatorContactsPresence(): void { contactsPresenceProjection.publish(); }

const walletLockBarrier = new WalletLockBarrier(() => publishSessionState("lock", lockRevocationPending));
let lockRevocationPending = false;
let globalLockRunning: Promise<void> | undefined;
let walletRevocationCleanup: Promise<void>[] | undefined;

function publishSessionState(cause: SessionStateEvent["cause"], deferCleanup = false): void {
  // 服务目录与 owner/session 可见性共享同一状态提交点。锁定、解锁、换
  // Key、Storage Root 重绑都会改变 identity；先同步撤权/旋转 exposure，
  // 再广播业务状态，避免页面看到已 unlocked 但仍持有旧 service proxy。
  if (!deferCleanup) reconcileCoordinatorSessionExposures();
  const state: SessionStateEvent = {
    topic: "session.state",
    type: "session.state.changed",
    cause,
    sessionRevision: 0,
    sessionEpoch: coordinatorState.sessionEpoch,
    vaultStatus: coordinatorState.vaultStatus,
    lockCleanup: walletLockBarrier.snapshot(),
    activePublicKeyHex: coordinatorState.vaultStatus === "unlocked" ? coordinatorState.activePublicKeyHex ?? null : null,
    ...(coordinatorState.vaultStatus === "unlocked" ? { activeKeyIdentity: vaultWorkerKeys.coordinatorActiveKeySummary() } : {}),
    runGeneration: coordinatorState.runGeneration,
    ...(coordinatorState.walletGeneration ? { walletGeneration: coordinatorState.walletGeneration } : {}),
    autoLockTimeoutMs: coordinatorMeta.autoLockTimeoutMs ?? AUTO_LOCK_DEFAULT_TIMEOUT_MS,
    ...(coordinatorAuthority.coordinatorAuthorityRecovery ? { authorityRecovery: coordinatorAuthority.coordinatorAuthorityRecovery } : {}),
  };
  publishTopicEvent("session.state", state);
  if (!deferCleanup) { workerWalletState.publish(); publishCoordinatorContactsPresence(); }
}

// ============================================================
// 1. Coordinator State
// ============================================================

interface CoordinatorState {
  /** 钱包身份世代；来自 `.keymaster/meta`，重置或重新初始化后改变。 */
  walletGeneration: string;
  sessionEpoch: SessionEpoch;
  /** Worker 运行世代；每次载入生成，Worker 重启后所有旧句柄失效。 */
  runGeneration: string;
  vaultStatus: CoordinatorVaultStatus;
  activePublicKeyHex?: string;
  scheduleSettings: CoordinatorBackgroundSyncSettings;
  autoLockTimeoutMs: number;
  autoLockDeadline?: number;
  lastActivityAt: number;
}

/** 重新生成运行世代；用于让所有已发放句柄立即 fail closed。 */
function rotateCoordinatorRunGeneration(): void {
  coordinatorState.runGeneration = crypto.randomUUID();
}

// Test-only seams keep worker ownership/dispatch tests independent from
// IndexedDB and platform K-V persistence.

/** 正在进行的存储请求；锁定/改密/重置必须等它们排空后再动数据。 */

/** 锁定期间未完成的旧绑定排空；下一次解锁必须先消费它。 */

function storageUnavailableError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "storage_unavailable" });
}

function storageConflictError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "storage_conflict" });
}

function isStorageConflictError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "storage_conflict");
}

/**
 * 撤销当前存储绑定的统一入口。
 *
 * 顺序固定为：推进绑定世代 → 撤销 grant、任务与 Connect 运行绑定 →
 * 拒绝新 I/O → 等待旧 I/O 排空。调用方在它返回之后才可以清空或改写数据。
 */
async function revokeStorageBindingAndDrain(reason: string): Promise<void> {
  // 先推进会话世代：已经拿到 wrapper 的旧请求会在完成后被
  // assertStorageBindingLive 拒绝，新请求从入口直接拒绝。
  coordinatorState.sessionEpoch = generateEpoch();
  closeCoordinatorUpgradeSession(`Storage binding revoked: ${reason}`);
  storageWorkerRequests.revokeStorageSessionGrants();
  releaseMsfileRuntime(reason);
  await releaseSatRuntime(reason);
  windowP2pWorkerRuntime.clearWindowP2pExecutorLeaseLocked();
  stopCoordinatorOwnerWorkerUnits();
  // 任务 completion 由自己的绑定栅栏收口；这里不等待一个可能永不响应
  // AbortSignal 的业务 task，存储排空才是数据变更前的硬门禁。
  if (coordinatorState.activePublicKeyHex) {
    void cancelTaskRuntimesByKey(vaultWorkerKeys.requireCoordinatorNetworkIdentity()).catch((error) => {
      console.warn("[coordinator] task cancellation deferred", error instanceof Error ? error.message : String(error));
    });
  }
  const drain = storageWorkerRequests.drainStorageBindingRequests();
  try {
    await drain;
  } catch (error) {
    storageWorkerRequests.rememberStorageBindingDrain(drain);
    throw error;
  }
}

const msfileWorkerProjection = createMsFileWorkerProjection({ session: () => ({ epoch: coordinatorState.sessionEpoch, unlocked: coordinatorState.vaultStatus === "unlocked" }), service: () => msfileWorkerLifecycle.service(), configChanged: () => windowP2pWorkerRuntime.syncWindowP2pExecutorConfig(), pump: () => msfileWorkerRequests.pumpMsfileDataWaiters(), publish: event => { publishTopicEvent("msfile.state", event); } });
function emitMsFileState() { msfileWorkerProjection.emitMsFileState(); }

const windowP2pWorkerRuntime = createWindowP2pWorkerRuntime({
  session: () => ({ vaultStatus: coordinatorState.vaultStatus, sessionEpoch: coordinatorState.sessionEpoch, activePublicKeyHex: coordinatorState.activePublicKeyHex }),
  configuration: () => msfileWorkerProjection.windowP2pExecutorConcurrencyConfig,
  admission: { disconnected: peerId => revokedCoordinatorPeerIds.has(peerId), response: disconnectedClientResponse },
  lifecycle: {
    activate() { const unit = activateCoordinatorOwnerWorkerUnit("window-p2p.coordinator-worker"); coordinatorWorkerUnitRegistry.ready(unit.unitId, unit.instanceId); },
    stop() { const unit = coordinatorWorkerUnitRegistry.get("window-p2p.coordinator-worker"); if (unit) stopCoordinatorWorkerUnit(unit.unitId, unit.instanceId); },
  },
  signing: {
    publicKey() {
      const owner = coordinatorState.activePublicKeyHex;
      if (!owner) throw new Error("Window P2P executor active key is unavailable");
      if (vaultWorkerKeys.activeKeyBackend === "hardware") vaultWorkerKeys.hardwareConnections.backend(); else vaultWorkerKeys.vaultKeySession.assert(owner);
      return validatePublicKey(cryptoHexToBytes(owner));
    },
    sign: (request, digest, owner, signal) => withCoordinatorFinalIoLease("write", signal,
      () => vaultWorkerKeys.activeKeyBackend === "hardware"
        ? vaultWorkerKeys.hardwareConnections.backend().signNetworkIdentity(request.kind === "window-p2p.executor.identity.sign-noise" ? "noise" : "peer-record",
          request.kind === "window-p2p.executor.identity.sign-noise" ? { staticKey: new Uint8Array(request.noiseStaticPublicKey) } : { sequence: request.sequence }, signal)
        : vaultWorkerKeys.authorizeSoftwareSignature(request.kind === "window-p2p.executor.identity.sign-noise" ? "identity.noise-proof" : "identity.peer-record",
          () => vaultWorkerKeys.vaultKeySession.signDigest(digest, "der", owner), signal, { digest: bytesToHex(digest) }),
      { auditOperation: "window-p2p.identity.sign", durableLease: false }),
  },
  inbound: { request: id => satIncomingHandlers.get(id), state: id => satConnectionStateHandlers.get(id), clearStates: () => satConnectionStateHandlers.clear() },
  events: {
    changed: () => emitMsFileState(),
    ready() {
      if (msfileBitfsRuntime.msfileSellerProtocolPort?.ready && coordinatorState.vaultStatus === "unlocked" && msfileWorkerLifecycle.service()) {
        msfileWorkerLifecycle.service()!.setSellerRuntimeStatus((msfileBitfsRuntime.msfileSellerSessionManager?.activeCount() ?? 0) > 0 ? "selling" : "ready");
        void drainMsfilePendingSellerHashRequests();
      }
    },
    revoked() {
      const seller = msfileBitfsRuntime.msfileSellerSessionManager;
      if (seller) {
        seller.clear();
        if (coordinatorState.vaultStatus === "unlocked" && msfileWorkerLifecycle.service() && msfileBitfsRuntime.msfileSellerProtocolPort?.ready) msfileWorkerLifecycle.service()!.setSellerRuntimeStatus("degraded");
      }
    },
    sellerEvent: (event, lease) => handleBitfsSellerStreamEvent(event, lease),
  },
});

/* ---------- MSFile runtime state（施工单 KMMF-005/006） ---------- */
let msfileWorkerChainAccess: (() => WocServiceHandle | undefined) | undefined;
let testMsfileRuntimeOverride: MsFileServiceImpl | undefined;
type MsFileRuntimeStores = import("@keymaster/plugin-msfile/worker").MsFileWorkerStores;
const msfileWorkerRequests = createMsFileWorkerRequests({
  session: () => ({ vaultStatus: coordinatorState.vaultStatus, sessionEpoch: coordinatorState.sessionEpoch, activePublicKeyHex: coordinatorState.activePublicKeyHex }),
  runtime: { current: () => msfileWorkerLifecycle.service(), ensure: () => ensureMsfileRuntime() },
  settings: () => msfileWorkerProjection.msfileReadConcurrencySettings, appSession: readProtocolConnectSession,
  changed: () => emitMsFileState(),
  available: () => isCoordinatorProductRegistered("msfile"), blocked: requestId => coordinatorProductBlockedResponse(requestId, "msfile"),
  admission: { revoked: peerId => revokedCoordinatorPeerIds.has(peerId), response: disconnectedClientResponse },
  identity: { cancelClient: peerId => windowP2pWorkerRuntime.cancelIdentityClient(peerId), cancel: (peerId, requestId) => windowP2pWorkerRuntime.cancelIdentityRequest(peerId, requestId) },
  control: { execute: (request, signal) => msfileBitfsRuntime.executeMsfileControl(request, signal), mutates: control => msfileBitfsRuntime.isMsfileMutationControl(control) },
  io: { run: (operation, signal, execute, options) => withCoordinatorFinalIoLease(operation, signal, execute, { ...options, auditOperation: options.auditOperation }) },
});

const msfileWorkerLifecycle = createMsFileWorkerLifecycle({
  assertAvailable() { assertCoordinatorUnitConstructible("msfile.coordinator-worker"); assertStorageDataAvailable(); },
  session: () => ({ unlocked: coordinatorState.vaultStatus === "unlocked", owner: coordinatorState.activePublicKeyHex, epoch: coordinatorState.sessionEpoch }),
  fixtureTransport: () => testDomainUnitReadiness ? windowP2pExecutorTransport : undefined,
  configureSeller: (service, owner, settings) => configureMsfileSellerRuntime(service, owner, settings),
  changed: () => emitMsFileState(),
  revokeOperations() {
    stopMsfileSellerRuntime();
    for (const pending of msfileWorkerRequests.msfileRequests.values()) pending.controller.abort();
    msfileWorkerRequests.msfileRequests.clear();
    for (const pending of windowP2pWorkerRuntime.windowP2pExecutorIdentityRequests.values()) pending.controller.abort();
    windowP2pWorkerRuntime.windowP2pExecutorIdentityRequests.clear();
    msfileWorkerRequests.msfileGrants.clear();
    msfileBitfsRuntime.revoke();
    msfileWorkerProjection.lastMsFileState = undefined;
  },
});

const msfileFundingRuntime = createWorkerFundingRuntime({
  session: () => ({ vaultStatus: coordinatorState.vaultStatus, activePublicKeyHex: coordinatorState.activePublicKeyHex, sessionEpoch: coordinatorState.sessionEpoch }),
  journalStore: () => createWorkerModuleFileStore("msfile", "bitfs-journal"),
  executor: (operation, signal?: AbortSignal) => testDomainUnitReadiness ? windowP2pWorkerRuntime.requestWindowP2pExecutorOperation(operation, signal) : msfileWorkerLifecycle.executor(operation, signal),
  ensureResources: ensureWorkerP2pkhResources,
  snapshots: () => p2pkhWorkerRuntime.snapshots(),
  readP2pkhSettings: async () => ({ ...await p2pkhSettingRepository().readSetting(), bsvNetwork: vaultWorkerKeys.requireCoordinatorNetworkIdentity().bsvNetwork }),
  maxFeeSatoshis: bitfsFundingMaxFeeSatoshis,
  deriveAddress: deriveP2pkhAddress,
  addressScript: p2pkhAddressToScriptHex,
  parseTransaction: parseP2pkhTransaction,
});
const msfileBitfsRuntime = createBitfsWorkerRuntime({
  requestPayment: async command => (await vaultWorkerKeys.currentWalletPayments()).handle(command),
  session: () => ({ vaultStatus: coordinatorState.vaultStatus, activePublicKeyHex: coordinatorState.activePublicKeyHex, sessionEpoch: coordinatorState.sessionEpoch, runGeneration: coordinatorState.runGeneration }),
  service: () => msfileWorkerLifecycle.service(),
  ensureService: () => ensureMsfileRuntime(),
  files: (purpose) => createWorkerModuleFileStore("msfile", purpose),
  woc: () => testDomainUnitReadiness ? p2pkhWocService : msfileWorkerLifecycle.chain(),
  p2pkhSettings: async () => ({ ...await p2pkhSettingRepository().readSetting(), bsvNetwork: vaultWorkerKeys.requireCoordinatorNetworkIdentity().bsvNetwork }),
  crypto: (owner) => vaultWorkerKeys.createWorkerActiveKeyCrypto(owner),
  blockHeight: readCoordinatorBitfsBlockHeight,
  executor: (operation, signal?: AbortSignal) => testDomainUnitReadiness ? windowP2pWorkerRuntime.requestWindowP2pExecutorOperation(operation, signal) : msfileWorkerLifecycle.executor(operation, signal),
  network: bitfsNetwork,
  availability: coordinatorUnitAvailability,
  subscribeAvailability: subscribeCoordinatorUnitAvailability,
  ensureResources: ensureWorkerP2pkhResources,
  snapshots: () => p2pkhWorkerRuntime.snapshots(),
  ensureChannel: () => ensureSatRuntime(),
  channel: () => satWorkerLifecycle.current(),
  buyerSubscriptions: async (runtime) => {
    const current = await ensureSatRuntime();
    if (current !== runtime) throw new Error("BitFS channel runtime changed");
    await channelWorkerRuntime.ensureMsfileBitfsBuyerSubscriptions(current);
  },
  sellerSubscriptions: async (runtime) => {
    const current = await ensureSatRuntime();
    if (current !== runtime) throw new Error("BitFS channel runtime changed");
    await channelWorkerRuntime.ensureMsfileBitfsSellerSubscriptions(current);
  },
  publishHashRequest: async (runtime, input, signal, prepared) => {
    const current = await ensureSatRuntime();
    if (current !== runtime) throw new Error("BitFS channel runtime changed");
    return channelWorkerRuntime.publishChannelHashRequest(current, input, signal, prepared);
  },
  unknownPublishFailure: isUnknownChannelPublishFailure,
  executorLease: () => windowP2pWorkerRuntime.windowP2pExecutorLease,
  resetAutoLock: resetAutoLockTimer,
  pauseAutoLock: () => {
    vaultAutoLock.pause();
    coordinatorState.autoLockDeadline = undefined;
  },
  allowLoopback: bitfsAllowsLoopbackWebsocket,
  isUnavailable: isCoordinatorUnitUnavailableError,
  publishPrivate: async (input) => {
    const current = await ensureSatRuntime();
    if (current !== input.runtime) throw new Error("BitFS channel runtime changed");
    return channelWorkerRuntime.publishPrivateEnvelope({ ...input, runtime: current });
  },
  funding: msfileFundingRuntime,
  parseTransaction: parseP2pkhTransaction,
  deriveAddress: deriveP2pkhAddress,
  addressScript: p2pkhAddressToScriptHex,
  maxFeeSatoshis: bitfsFundingMaxFeeSatoshis,
  diagnosticsEnabled: () => false,
  bytesToHex,
  hexToBytes: cryptoHexToBytes,
});
export const createMsfileBitfsBuyerTask = msfileBitfsRuntime.createMsfileBitfsBuyerTask;
const msfileBitfsBuyerRequests = msfileBitfsRuntime.msfileBitfsBuyerRequests;
const msfileBitfsBuyerOfferCounts = msfileBitfsRuntime.msfileBitfsBuyerOfferCounts;
const configureMsfileSellerRuntime = msfileBitfsRuntime.configureMsfileSellerRuntime;
const msfileBitfsBuyerTasks = msfileBitfsRuntime.msfileBitfsBuyerTasks;
const msfileBitfsBuyerPurchaseTails = msfileBitfsRuntime.msfileBitfsBuyerPurchaseTails;
const msfileBitfsWebRtcBuyerLinks = msfileBitfsRuntime.msfileBitfsWebRtcBuyerLinks;
const msfileBitfsWebRtcSellerLinks = msfileBitfsRuntime.msfileBitfsWebRtcSellerLinks;
const stopMsfileSellerRuntime = msfileBitfsRuntime.stopMsfileSellerRuntime;
const filterP2pkhSnapshotByBitfsFunds = msfileBitfsRuntime.filterP2pkhSnapshotByBitfsFunds;
const reconcileMsfileBitfsFundingInputs = msfileBitfsRuntime.reconcileMsfileBitfsFundingInputs;
const acceptMsfileBitfsWebRtcOffer = msfileBitfsRuntime.acceptMsfileBitfsWebRtcOffer;
const handleMsfileSellerHashRequest = msfileBitfsRuntime.handleMsfileSellerHashRequest;
const drainMsfilePendingSellerHashRequests = msfileBitfsRuntime.drainMsfilePendingSellerHashRequests;
const handleBitfsSellerStreamEvent = msfileBitfsRuntime.handleBitfsSellerStreamEvent;
const ensureMsfileBitfsBuyerRecovery = msfileBitfsRuntime.ensureMsfileBitfsBuyerRecovery;
const ensureMsfileBitfsBuyerTask = msfileBitfsRuntime.ensureMsfileBitfsBuyerTask;
const msfileBitfsBuyerDemandSnapshot = msfileBitfsRuntime.msfileBitfsBuyerDemandSnapshot;
const msfileBitfsBuyerTaskKey = msfileBitfsRuntime.msfileBitfsBuyerTaskKey;
const startMsfileBitfsBuyerPurchase = msfileBitfsRuntime.startMsfileBitfsBuyerPurchase;
const cancelMsfileBitfsBuyerPurchase = msfileBitfsRuntime.cancelMsfileBitfsBuyerPurchase;
const listMsfileBitfsBuyerTaskSnapshots = msfileBitfsRuntime.listMsfileBitfsBuyerTaskSnapshots;
const currentMsfileBitfsFundingLedger = msfileBitfsRuntime.currentMsfileBitfsFundingLedger;
const sellerKeepsVaultUnlocked = msfileBitfsRuntime.sellerKeepsVaultUnlocked;
export const prepareMsfileBitfsFundingSplit = msfileFundingRuntime.prepareSplit;
export const recoverMsfileBitfsFundingSplit = msfileFundingRuntime.recoverSplit;

/* ---------- SatSubscription runtime（唯一 owner：SharedWorker） ---------- */
const SAT_WINDOW_LANE_ID = "sat-subscription";

/** SS 与 BitFS 服务均从钱包身份取得网络；构建模式不决定业务网络。 */
function satDefaultNetwork(): SatDefaultNetwork {
  return vaultWorkerKeys.requireCoordinatorNetworkIdentity().bsvNetwork === "test" ? "testnet" : "mainnet";
}

type BitfsNetwork = "main" | "test";

function bitfsNetwork(): BitfsNetwork {
  return vaultWorkerKeys.requireCoordinatorNetworkIdentity().bsvNetwork;
}

async function readCoordinatorBitfsBlockHeight(network: BitfsNetwork): Promise<number> {
  const snapshot = wocWorkerRuntime.snapshot();
  if (!snapshot.available || snapshot.network !== network || !Number.isSafeInteger(snapshot.height) || snapshot.height < 0) {
    throw new Error(`BitFS ${network} 链高度尚未由统一同步任务提供`);
  }
  return snapshot.height;
}

function bitfsAllowsLoopbackWebsocket(): boolean {
  return import.meta.env.DEV === true || (bitfsNetwork() === "test" && import.meta.env.VITE_BITFS_ALLOW_LOOPBACK_WS === "true");
}

function bitfsFundingMaxFeeSatoshis(): number {
  const raw = import.meta.env.VITE_BITFS_MAX_FEE_SATOSHIS;
  if (raw === undefined || raw === "") return 10_000;
  if (!/^[1-9][0-9]{0,6}$/u.test(raw)) throw new Error("BitFS 手续费上限配置无效");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("BitFS 手续费上限配置无效");
  return value;
}
const satWorkerLifecycle = createSatWorkerLifecycle({
  assertAvailable: () => assertCoordinatorUnitConstructible("sat-subscription.coordinator-worker"),
  session: () => ({ unlocked: coordinatorState.vaultStatus === "unlocked", owner: coordinatorState.activePublicKeyHex, epoch: coordinatorState.sessionEpoch }),
  transport: () => satSubscriptionTransport, network: satDefaultNetwork,
  getP2pkh: () => testDomainUnitReadiness ? ensureSatP2pkhService() : null,
  incoming: event => channelWorkerRuntime.handleIncomingChannelPublish(event),
  async deriveAddress(owner, network, epoch) {
    const result = await withCoordinatorFinalIoLease("write", undefined,
      () => { vaultWorkerKeys.assertActiveWalletIdentity(owner, epoch); return vaultWorkerKeys.executeActiveWalletCrypto({ type: "deriveP2pkhAddress", network }); },
      { auditOperation: "sat.address.derive" });
    if (result.type !== "deriveP2pkhAddress") throw new Error("Failed to derive the owner payment address");
    return result.address;
  },
  releaseRelated: releaseSatRelatedResources,
});
let satRevision = 0;
let lastSatState: CoordinatorSatStateEvent | undefined;

/** 锁屏/切 owner 的远端 Sat 清理上限；安全边界不能依赖网络返回。 */

let channelRevision = 0;

const contactsWorkerRuntime = createContactsWorkerRuntime({ tasks: coordinatorTaskRegistrar, changed: () => publishCoordinatorContactsPresence() });

/** 以 connectionId 隔离入站 handler；supplierId 不是连接实例键。 */

/** Window lane 的连接状态事件；按 connectionId 和完整 fence 路由到当前 owner。 */

const { transport: satSubscriptionTransport, incomingHandlers: satIncomingHandlers, stateHandlers: satConnectionStateHandlers } = createSatWorkerTransport({
  operation: (operation, signal) => testDomainUnitReadiness ? windowP2pWorkerRuntime.satWindowLaneOperation(operation, signal) : satWorkerLifecycle.executor({type: "lane", laneId: "sat-subscription", operation}, signal),
  cancelInbound: (connectionId, reason) => windowP2pWorkerRuntime.cancelSatInboundHandlersForConnection(connectionId, reason),
});
interface SatWorkerConnection extends SatSupplierConnection {
  readonly state: "online" | "degraded" | "closed";
}

/** 两个 identity RPC 的取消句柄；不得与 MSFile 数据面混用。 */

async function ensureMsfileRuntime(expectedInstanceId?: string, boundStores?: MsFileRuntimeStores, assertScopeActive: () => void = () => undefined): Promise<MsFileServiceImpl> {
  assertCoordinatorUnitConstructible("msfile.coordinator-worker");
  assertStorageDataAvailable();
  if (testMsfileRuntimeOverride) return testMsfileRuntimeOverride;
  let stores = boundStores;
  if (!stores && testDomainUnitReadiness && coordinatorState.activePublicKeyHex) stores = {
    ownerPublicKeyHex: coordinatorState.activePublicKeyHex.trim().toLowerCase(),
    settings: createWorkerModuleFileStore("msfile", ""), appSettings: workerStorageClients.platformFiles("msfile", "app-settings"),
  };
  const runtime = await msfileWorkerLifecycle.ensure(stores, assertScopeActive);
  const unit = activateCoordinatorOwnerWorkerUnit("msfile.coordinator-worker", expectedInstanceId);
  coordinatorWorkerUnitRegistry.ready(unit.unitId, unit.instanceId);
  return runtime;
}

function emitSatState(event: import("@keymaster/contracts").CoordinatorSatEvent): void {
  satRevision += 1;
  const next: CoordinatorSatStateEvent = {
    topic: "sat.events",
    type: "sat.events.changed",
    satRevision,
    sessionEpoch: coordinatorState.sessionEpoch,
    event,
  };
  lastSatState = next;
  publishTopicEvent("sat.events", next);
}

async function ensureSatRuntime(expectedInstanceId?: string, storage?: BorrowedModuleFileStore, assertScopeActive: () => void = () => undefined): Promise<SatWorkerRuntimeState> {
  assertCoordinatorUnitConstructible("sat-subscription.coordinator-worker");
  const files = storage ?? (testDomainUnitReadiness ? createWorkerModuleFileStore("sat-subscription", "") : undefined);
  const runtime = await satWorkerLifecycle.ensure(files, assertScopeActive);
  const unit = activateCoordinatorOwnerWorkerUnit("sat-subscription.coordinator-worker", expectedInstanceId);
  coordinatorWorkerUnitRegistry.ready(unit.unitId, unit.instanceId);
  return runtime;
}

function releaseSatRelatedResources(reason: string): import("@keymaster/plugin-sat-subscription/worker").SatCleanupPhase[] {
  // 先取消仍在 handler 中等待的入站 Publish，再移除连接注册表。取消只
  // 释放 bridge Wire，不提前释放 handler slot；slot 要等真实 Promise settle，
  // 防止永不结束的旧 handler 在新 owner 中制造未受控并发。
  windowP2pWorkerRuntime.cancelSatInboundHandlers(undefined, `Sat runtime was released: ${reason}`);
  satIncomingHandlers.clear();
  const { starting: p2pkhStarting, protocolStarting } = workerTransferRuntime.release();
  resetP2pkhSettingsRuntime();
  lastSatState = undefined;
  const channelCleanup = channelWorkerRuntime.release();
  msfileBitfsRuntime.clearBuyerState();
  contactsWorkerRuntime.current()?.resetPresence?.();

  return [...channelCleanup, { label: "stale P2PKH start", run: async () => { await Promise.allSettled([p2pkhStarting, protocolStarting]); } }];
}

function releaseSatRuntime(reason: string): Promise<void> {
  const workerUnit = coordinatorWorkerUnitRegistry.get("sat-subscription.coordinator-worker");
  if (workerUnit) stopCoordinatorWorkerUnit(workerUnit.unitId, workerUnit.instanceId);
  return satWorkerLifecycle.release(reason);
}

function releaseMsfileRuntime(_reason: string): void {
  msfileWorkerLifecycle.revoke();
  const unit = coordinatorWorkerUnitRegistry.get("msfile.coordinator-worker");
  if (unit) stopCoordinatorWorkerUnit(unit.unitId, unit.instanceId);
}

function storageCoordinatorError(code: "storage_limit_exceeded" | "storage_unavailable", message: string = code): Error & { code: typeof code } {
  const error = new Error(message) as Error & { code: typeof code };
  error.code = code;
  return error;
}

function blockWorkerTasksForStorage(): void {
  backgroundWorkerRuntime.block("Storage unavailable");
  publishTopicEvent("background.snapshot", {
    type: "background.snapshot.changed",
    sessionEpoch: coordinatorState.sessionEpoch,
    snapshots: getTaskSnapshots(),
    scheduleSettings: coordinatorState.scheduleSettings
  });
}

/** 唯一 Key 的公开标签；KeyHold 未解锁时只读 meta 之外的公开字段。 */
async function readWalletKeyLabel(keys: WalletKeyRepository): Promise<string | undefined> {
  try {
    const file = await keys.read();
    return file ? file.document.label : undefined;
  } catch {
    return undefined;
  }
}

/** Storage 选定/解锁后统一恢复 Root、Vault metadata、runtime 与任务。 */
async function resumeAfterStorageReady(peerId?: string): Promise<boolean> {
  storageWorkerRoot.failed = false;
  storageWorkerRoot.ready = true;
  reconcileCoordinatorRuntime();
  if (coordinatorState.vaultStatus === "booting") {
    // 初始 initializeCoordinator 正在等待 bootstrapPlatformStorage；健康探测
    // 的 recovery finalize 不能再次启动一个嵌套 initialize，否则会互相等待。
    if (coordinatorInitializationInProgress) return false;
    coordinatorInitialization = initializeCoordinator(true, true, peerId);
    await coordinatorInitialization;
    return true;
  }
  await ensureStorageRuntime(peerId);
  await ensureCoordinatorTasksRegistered();
  for (const runtime of backgroundWorkerRuntime.taskRuntimes.values()) {
    if (runtime.state === "blocked" && runtime.blockedReason === "Storage unavailable") {
      runtime.state = "idle";
      runtime.blockedReason = undefined;
      scheduleRuntime(runtime);
      if (runtime.syncPolicy === "smart") armSmartSyncIfIdle();
    }
  }
  publishSessionState("bootstrap");
  emitStorageState();
  return true;
}

function abortStorageRequests(): void {
  for (const request of storageWorkerRequests.storageRequests.values()) request.controller.abort();
  storageWorkerRequests.storageRequests.clear();
}

type CoordinatorTaskRuntimeInput = Omit<TaskRuntime, "state" | "unitId" | "instanceId"> & {
  unitId?: string;
  /** 仅测试注册入口允许使用未迁移任务；生产任务必须先进入 Worker 单元目录。 */
  allowUncataloguedForTest?: boolean;
};

/**
 * 将领域任务定义装配成一个明确的 Coordinator Worker 运行单元实例。
 * 任务 id 只负责路由命令；unitId / instanceId 负责生命周期和迟到结果诊断。
 */
function createCoordinatorTaskRuntime(input: CoordinatorTaskRuntimeInput): TaskRuntime {
  const { allowUncataloguedForTest = false, ...runtimeInput } = input;
  const catalogUnit = getCoordinatorWorkerUnitForTask(runtimeInput.id);
  if (!catalogUnit && !allowUncataloguedForTest) {
    throw new Error(`Coordinator 生产任务 ${runtimeInput.id} 必须先登记 productId、unitId 和最终 I/O 审计入口`);
  }
  if (catalogUnit && catalogUnit.productId !== runtimeInput.pluginId) {
    throw new Error(`Coordinator task ${runtimeInput.id} 的 productId 与 Worker 单元目录不一致`);
  }
  if (catalogUnit && runtimeInput.unitId !== undefined && runtimeInput.unitId !== catalogUnit.unitId) {
    throw new Error(`Coordinator task ${runtimeInput.id} 使用了错误的 unitId`);
  }
  const unitId = runtimeInput.unitId ?? catalogUnit?.unitId ?? `${runtimeInput.pluginId}.coordinator-worker`;
  return {
    ...runtimeInput,
    unitId,
    instanceId: generateCoordinatorServiceId(`task:${unitId}`),
    state: "idle",
  };
}

assertCoordinatorWorkerUnitCatalog();

/**
 * 一个页面 peer 的有界 topic 队列。WebLoom provider 负责 wire credit；这里
 * 只负责在 baseline 与 live event 之间建立一个不会无限增长的领域队列。
 */
const COORDINATOR_TOPIC_QUEUE_LIMIT = 256;

interface CoordinatorTopicStreamQueue {
  readonly peerId: string;
  readonly topics: ReadonlySet<CoordinatorTopic>;
  readonly values: CoordinatorTopicEvent[];
  readonly waiters: Array<{
    resolve: (result: IteratorResult<CoordinatorTopicEvent>) => void;
    reject: (error: unknown) => void;
  }>;
  closed: boolean;
  error?: unknown;
}

function topicStreamOverflowError(): Error {
  return new WebLoomError("stream_overflow", "Coordinator topic stream queue overflow", "execute");
}

function createCoordinatorTopicStreamQueue(peerId: string, topics: readonly CoordinatorTopic[]): CoordinatorTopicStreamQueue {
  return {
    peerId,
    topics: new Set(topics),
    values: [],
    waiters: [],
    closed: false,
  };
}

function closeCoordinatorTopicStreamQueue(queue: CoordinatorTopicStreamQueue, error?: unknown): void {
  if (queue.closed) return;
  queue.closed = true;
  queue.error = error;
  const waiters = queue.waiters.splice(0);
  queue.values.length = 0;
  for (const waiter of waiters) {
    if (error !== undefined) waiter.reject(error);
    else waiter.resolve({ done: true, value: undefined });
  }
}

function enqueueCoordinatorTopicEvent(queue: CoordinatorTopicStreamQueue, event: CoordinatorTopicEvent): void {
  if (queue.closed || !queue.topics.has(event.topic)) return;
  const waiter = queue.waiters.shift();
  if (waiter) {
    waiter.resolve({ done: false, value: event });
    return;
  }
  if (canCoalesceStorageActivity(queue.values.at(-1), event)) {
    // A burst of file reads must not evict publication/session events merely
    // to report every intermediate read counter. Keep the latest adjacent
    // counter snapshot; authority changes and other topics keep their order.
    queue.values[queue.values.length - 1] = event;
    return;
  }
  if (queue.values.length >= COORDINATOR_TOPIC_QUEUE_LIMIT) {
    const counts: Partial<Record<CoordinatorTopic, number>> = {};
    for (const queued of queue.values) counts[queued.topic] = (counts[queued.topic] ?? 0) + 1;
    console.warn("[coordinator] Topic queue overflow", JSON.stringify(counts));
    closeCoordinatorTopicStreamQueue(queue, topicStreamOverflowError());
    return;
  }
  queue.values.push(event);
}

function takeCoordinatorTopicEvent(queue: CoordinatorTopicStreamQueue): Promise<IteratorResult<CoordinatorTopicEvent>> {
  if (queue.values.length > 0) {
    return Promise.resolve({ done: false, value: queue.values.shift()! });
  }
  if (queue.closed) {
    return queue.error === undefined
      ? Promise.resolve({ done: true, value: undefined })
      : Promise.reject(queue.error);
  }
  return new Promise<IteratorResult<CoordinatorTopicEvent>>((resolve, reject) => {
    queue.waiters.push({ resolve, reject });
  });
}

type CoordinatorPeerStatus = "active" | "open" | "closing" | "revoked";

interface CoordinatorBridgeRequest {
  readonly controller: AbortController;
  readonly settled: Promise<void>;
}

interface CoordinatorStorageIoOwner extends CoordinatorSessionBinding {
  readonly peerId: string;
  readonly commitOrder: number;
}

interface CoordinatorPeerState {
  readonly peer: PeerController;
  lastSeenAt: number;
  status: CoordinatorPeerStatus;
  sessionOpen: boolean;
  /** 每次 open/close/revoke 都推进；迟到的 await 结果不能重新开放旧 peer。 */
  sessionGeneration: number;
  /** 同一 peer 的 open/close/refresh 不能并行修改会话投影。 */
  sessionOperationTail: Promise<void>;
  topicStream?: CoordinatorTopicStreamQueue;
  serviceExposure?: { revoke(): void };
  /** 当前 owner/session 世代对应的 WebLoom service exposure；旋转后旧 proxy 必须失效。 */
  serviceExposureIdentity?: string;
  forumExposure?: { revoke(): void };
  forumExposureIdentity?: string;
  sessionBinding?: CoordinatorSessionBinding;
  openCommitOrder?: number;
  bridgeRequests: Set<CoordinatorBridgeRequest>;
  drainPromise?: Promise<void>;
}

/** WebLoom 0.5.0 endpoint 字段的领域侧窄投影；不把框架对象泄漏进持久化。 */
type CoordinatorPeerEndpointInfo = {
  readonly endpointState?: "active" | "closing" | "closed";
  readonly binding?: { readonly runtimeInstanceId: string; readonly connectionId: string };
};

/** WebLoom 连接 peer 注册表；Local I/O 只在 session.open 提交或物理撤权时切换。 */
const coordinatorPeers = new Map<string, CoordinatorPeerState>();
let storageIoOwner: CoordinatorStorageIoOwner | undefined;
let coordinatorSessionCommitOrder = 0;
/** 对外报告的 owner handoff 修订；即使 survivor 早于旧 owner 打开，也必须递增。 */
let coordinatorStorageIoHandoffRevision = 0;

interface CoordinatorSessionOpenAttempt {
  readonly state: CoordinatorPeerState;
  readonly peerId: string;
  readonly generation: number;
  readonly signal: AbortSignal;
  readonly binding: CoordinatorSessionBinding;
}

/**
 * Worker 初始化是全局共享的，但首次初始化期间的 LocalStorage I/O 仍
 * 必须临时绑定到发起 open 的真实 peer。它不是 sessionIoPeerId：只有
 * exposeGroup 成功后才会写入后者。
 */
let coordinatorOpeningSession: CoordinatorSessionOpenAttempt | undefined;
let coordinatorSessionOpenTail: Promise<void> = Promise.resolve();

function coordinatorPeerState(peerId: string): CoordinatorPeerState | undefined {
  return coordinatorPeers.get(peerId);
}

function requireCoordinatorPeer(call: HandlerCallContext): CoordinatorPeerState {
  const peerId = call.peer?.peerId;
  const state = peerId ? coordinatorPeerState(peerId) : undefined;
  if (!state || state.peer.scope.state !== "active") {
    throw Object.assign(new Error("Coordinator peer is unavailable"), { code: "transport_disconnected" });
  }
  state.lastSeenAt = Date.now();
  return state;
}

function requireCoordinatorSessionPeer(call: HandlerCallContext): CoordinatorPeerState {
  const state = requireCoordinatorPeer(call);
  if (!state.sessionOpen) {
    throw Object.assign(new Error("Coordinator session is not open"), { code: "service_unavailable" });
  }
  return state;
}

function coordinatorSessionStaleError(message = "Coordinator session open became stale"): Error & { code: string } {
  return Object.assign(new Error(message), { code: "service_reference_stale" });
}

function sameCoordinatorSessionBinding(left: CoordinatorSessionBinding | undefined, right: CoordinatorSessionBinding | undefined): boolean {
  return left !== undefined && right !== undefined
    && left.peerGeneration === right.peerGeneration
    && left.sessionEpoch === right.sessionEpoch
    && left.leaseId === right.leaseId;
}

function coordinatorSessionBinding(state: CoordinatorPeerState): CoordinatorSessionBinding | undefined {
  return state.sessionBinding === undefined ? undefined : { ...state.sessionBinding };
}

function assertCoordinatorBridgeFresh(
  state: CoordinatorPeerState,
  binding: CoordinatorSessionBinding,
  opening?: CoordinatorSessionOpenAttempt,
): void {
  const isOpening = opening !== undefined
    && opening.state === state
    && sameCoordinatorSessionBinding(opening.binding, binding)
    && coordinatorOpeningSession === opening;
  const isCommitted = state.sessionOpen
    && state.status === "open"
    && sameCoordinatorSessionBinding(state.sessionBinding, binding);
  if (state.peer.scope.state !== "active"
    || coordinatorPeers.get(state.peer.peerId) !== state
    || (!isOpening && !isCommitted)) {
    throw coordinatorSessionStaleError("Coordinator LocalStorage bridge session became stale");
  }
}

function assertCoordinatorSessionOpenFresh(attempt: CoordinatorSessionOpenAttempt): void {
  if (attempt.signal.aborted) throw coordinatorSessionStaleError("Coordinator session open was cancelled");
  if (coordinatorPeers.get(attempt.peerId) !== attempt.state
    || attempt.state.peer.scope.state !== "active"
    || attempt.state.sessionGeneration !== attempt.generation) {
    throw coordinatorSessionStaleError();
  }
}

function selectCoordinatorStorageIoOwner(): void {
  const candidates = [...coordinatorPeers.values()]
    .filter((candidate) => candidate.status === "open"
      && candidate.sessionOpen
      && candidate.peer.scope.state === "active"
      && candidate.sessionBinding !== undefined
      && candidate.openCommitOrder !== undefined)
    .sort((left, right) => (left.openCommitOrder! - right.openCommitOrder!));
  const selected = candidates[candidates.length - 1];
  storageIoOwner = selected?.sessionBinding === undefined || selected.openCommitOrder === undefined
    ? undefined
    : {
      ...selected.sessionBinding,
      peerId: selected.peer.peerId,
      commitOrder: ++coordinatorStorageIoHandoffRevision,
    };
  notifyCoordinatorStorageIoHandoff(storageIoOwner);
}

function abortCoordinatorPeerInflight(peerId: string): void {
  for (const [requestId, request] of storageWorkerRequests.storageRequests) {
    if (request.clientId === peerId) { request.controller.abort(); storageWorkerRequests.storageRequests.delete(requestId); }
  }
  for (const [requestId, request] of channelWorkerRuntime.channelRequests) {
    if (request.clientId === peerId) { request.controller.abort(); channelWorkerRuntime.channelRequests.delete(requestId); }
  }
  for (const [requestId, request] of msfileWorkerRequests.msfileRequests) {
    if (request.clientId === peerId) { request.controller.abort(); msfileWorkerRequests.msfileRequests.delete(requestId); }
  }
  for (const [requestId, request] of windowP2pWorkerRuntime.windowP2pExecutorIdentityRequests) {
    if (request.clientId === peerId) { request.controller.abort(); windowP2pWorkerRuntime.windowP2pExecutorIdentityRequests.delete(requestId); }
  }
  for (const [grantId, grant] of storageWorkerRequests.storageGrants) if (grant.clientId === peerId) storageWorkerRequests.storageGrants.delete(grantId);
  for (const [grantId, grant] of storageWorkerRequests.ownerStorageGrants) if (grant.clientId === peerId) storageWorkerRequests.ownerStorageGrants.delete(grantId);
  for (const [grantId, grant] of storageWorkerRequests.platformStorageGrants) if (grant.clientId === peerId) storageWorkerRequests.platformStorageGrants.delete(grantId);
  for (const [grantId, grant] of msfileWorkerRequests.msfileGrants) if (grant.clientId === peerId) msfileWorkerRequests.msfileGrants.delete(grantId);
  // 浏览授权是专属授权：peer 一旦脱离 committed session，它名下签发的授权当场作废，
  // 随后任何 browse 调用都只能得到「不可用」。
  storageWorkerRequests.storageBrowseCoordinator.revokeClient(peerId);
  const callers = channelWorkerRuntime.channelCallersByClient.get(peerId);
  channelWorkerRuntime.channelCallersByClient.delete(peerId);
  if (callers && channelWorkerRuntime.channelSubscriptionMux) {
    for (const callerId of callers) void channelWorkerRuntime.channelSubscriptionMux.release(callerId).catch(() => undefined);
  }
}

function drainCoordinatorPeer(state: CoordinatorPeerState): Promise<void> {
  const pending = [...state.bridgeRequests].map((request) => request.settled);
  const drain = Promise.allSettled(pending).then(() => {
    if (coordinatorPeers.get(state.peer.peerId) === state && state.status === "closing") {
      state.status = "active";
      state.drainPromise = undefined;
    }
  });
  state.drainPromise = drain;
  return drain;
}

/**
 * 关闭只先做同步 admission fence；反向 Window call 的真实 Promise 由
 * bridgeRequests 保留到 settle，再由 drain 完成。物理 peer revoke 会把
 * state 标为 revoked 并从注册表移除，页面主动 close 则保留 peer 以便
 * 同一个 Runtime 在必要时重新 open。
 */
function fenceCoordinatorPeerSession(
  state: CoordinatorPeerState,
  options: { physical: boolean; binding?: CoordinatorSessionBinding },
): boolean {
  if (state.status === "revoked") return false;
  const currentBinding = coordinatorSessionBinding(state);
  if (options.binding !== undefined && !sameCoordinatorSessionBinding(currentBinding, options.binding)) return false;
  void vaultWorkerKeys.hardwareConnections.closePeer(state.peer.peerId);
  state.sessionGeneration += 1;
  state.sessionOpen = false;
  state.status = options.physical ? "revoked" : "closing";
  state.sessionBinding = undefined;
  state.openCommitOrder = undefined;
  state.serviceExposure?.revoke();
  state.serviceExposure = undefined;
  state.serviceExposureIdentity = undefined;
  state.forumExposure?.revoke();
  state.forumExposure = undefined;
  state.forumExposureIdentity = undefined;
  if (state.topicStream) closeCoordinatorTopicStreamQueue(state.topicStream, coordinatorSessionStaleError("Coordinator topic stream was revoked"));
  state.topicStream = undefined;
  for (const pending of state.bridgeRequests) pending.controller.abort();
  abortCoordinatorPeerInflight(state.peer.peerId);

  if (storageIoOwner?.peerId === state.peer.peerId
    && currentBinding !== undefined
    && sameCoordinatorSessionBinding(storageIoOwner, currentBinding)) {
    storageIoOwner = undefined;
    selectCoordinatorStorageIoOwner();
  }
  if (options.physical) {
    coordinatorPeers.delete(state.peer.peerId);
    walletLockBarrier.remove(state.peer.peerId);
  }
  void drainCoordinatorPeer(state);
  return true;
}

function enqueueCoordinatorPeerSessionOperation<T>(state: CoordinatorPeerState, operation: () => Promise<T>): Promise<T> {
  const previous = state.sessionOperationTail;
  const current = previous.catch(() => undefined).then(operation);
  state.sessionOperationTail = current.then(() => undefined, () => undefined);
  return current;
}

function enqueueCoordinatorSessionInitialization<T>(operation: () => Promise<T>): Promise<T> {
  const previous = coordinatorSessionOpenTail;
  const current = previous.catch(() => undefined).then(operation);
  coordinatorSessionOpenTail = current.then(() => undefined, () => undefined);
  return current;
}

// ============================================================
// 2. Worker Global State
// ============================================================

const coordinatorState: CoordinatorState = {
  walletGeneration: "",
  sessionEpoch: generateEpoch(),
  runGeneration: makeCoordinatorAuthorityInstanceId(),
  vaultStatus: "booting",
  scheduleSettings: { taskIntervals: {} },
  autoLockTimeoutMs: AUTO_LOCK_DEFAULT_TIMEOUT_MS,
  lastActivityAt: Date.now(),
};

/**
 * 领域运行态表，同时是「单元自身是否已就绪」的唯一来源。
 *
 * 对外运行单元状态的唯一来源仍是 WebLoom Host：它拥有单元的启停与 Scope，并决定
 * `worker.units` 公开快照的枚举范围与 instanceId。这张表不生成公开快照，避免手工
 * Registry 伪装成 Runtime Host；但它持有领域句柄供任务与最终 I/O 清理使用，并且
 * 因为是就绪判定的唯一来源，必须与 Host 的 setup 顺序保持一致：每个插件的 setup
 * 钩子先 activate 再 ready，Host 之后才置 enabled。
 *
 * 「就绪判定只有一个来源」是硬约束，不是实现细节：判定里若再读 Host 状态，就必须
 * 同时订阅 Host 状态，否则会出现「判定翻成 ready 但没人被叫醒重判」的静默卡死。
 */
const coordinatorWorkerUnitRegistry = createCoordinatorWorkerUnitRegistry();
// 可用性变化是推式的：注册表一变就发布快照并推一次框架重判，不新增轮询。
// 单元就绪的每一条边沿都经过这里，因此订阅是完整的。
coordinatorWorkerUnitRegistry.onChange(() => {
  publishCoordinatorWorkerUnitSnapshot();
  scheduleCoordinatorRuntimeReconcile();
});

let coordinatorRuntimeApp: ReturnType<typeof startSharedWorkerApp> | undefined;
let coordinatorRuntimeUnitSnapshotRevision = 0;
const workerConsumers = new WeakMap<import("webloom-framework").PluginConsumer, import("webloom-framework").LifecycleScope>();
/** Domain fixtures explicitly drive registry readiness; browser production uses Host instances. */
let testDomainUnitReadiness = false;
type CoordinatorPeerHandoffNotifier = (peerId: string, handoffRevision?: number) => boolean;
let testCoordinatorPeerHandoffNotifier: CoordinatorPeerHandoffNotifier | undefined;

/**
 * 单元可用性判定的事实来源。
 *
 * 这里只提供无副作用读取：判定实现本身不轮询、不休眠、不猜超时；状态变化由
 * `coordinatorWorkerUnitRegistry.onChange` 推给订阅方重判。
 *
 * 「单元自身是否已就绪」只读运行态注册表，因此这四把尺子与注册表订阅构成完整的一组：
 * 每一条就绪边沿都来自注册表，也都会推给订阅方。Host 不参与就绪判定，只负责调度
 * 与枚举单元。
 */
function coordinatorUnitAvailabilityContext(): CoordinatorUnitAvailabilityContext {
  return {
    isUnitReady: (unitId) => coordinatorRuntimeUnitReady(unitId),
    isStorageReady: () => storageWorkerRoot.ready,
    isOwnerSessionAvailable: () => coordinatorState.vaultStatus === "unlocked" && Boolean(coordinatorState.activePublicKeyHex),
  };
}

/** Production readiness comes from the actual framework instance. The local
 * registry is only the domain fixture source when there is no Worker Host.
 */
function coordinatorRuntimeUnitReady(unitId: string): boolean {
  if (!coordinatorRuntimeApp || testDomainUnitReadiness) return coordinatorWorkerUnitRegistry.get(unitId)?.state === "ready";
  const state = coordinatorRuntimeApp.state();
  if (state.state === "failed" || state.state === "disposed") return false;
  return state.units.some(unit => unit.unitId === unitId && unit.state === "enabled" && Boolean(unit.instanceId));
}

function subscribeCoordinatorUnitAvailability(handler: () => void): () => void {
  const offDomain = coordinatorWorkerUnitRegistry.onChange(handler);
  const offRuntime = coordinatorRuntimeApp?.subscribe(handler);
  return () => { offDomain(); offRuntime?.(); };
}

/**
 * 单元当前完整可用性。公开快照投影与卖方等「现在能不能用」的判定都从这里取值。
 */
function coordinatorUnitAvailability(unitId: string) {
  return evaluateCoordinatorUnitAvailability(unitId, coordinatorUnitAvailabilityContext());
}

/**
 * 本地构造断言：不可用时抛带结构化原因的 `CoordinatorUnitUnavailableError`。
 *
 * 这是设计第 6 节「框架门与 Worker 本地判定合并为同一实现」的落点：`ensure*`
 * 不再手写「插件开? 解锁?」那一串检查，也不再 reconcile 一下祈祷它已就绪；不可用
 * 就如实报不可用。
 *
 * 断言的是**构造前置条件**（作用域就绪）。声明的依赖不参与：依赖是使用
 * 前置条件（卖方要收款运行时），不是 MSFile 运行对象的构造前置条件——依赖掉线时
 * 仍需处理业务设置与诊断。依赖由框架门（启动前置条件）与各能力自己的依赖门
 * （完整可用性）分别把关，三者共用 `workerUnitAvailability.ts` 同一份规则。
 */
function assertCoordinatorUnitConstructible(unitId: string): void {
  const availability = evaluateCoordinatorUnitConstructionPreconditions(unitId, coordinatorUnitAvailabilityContext());
  if (availability.state === "ready") return;
  throw new CoordinatorUnitUnavailableError(unitId, [...availability.reasons]);
}

/**
 * 领域 owner/session 交接完成后通知 WebLoom 当前物理 peer。
 *
 * WebLoom 只转发 handoff 事件，不解释 owner，也不参与 Keymaster 的
 * lease/epoch/CAS 决策。单测没有真实 SharedWorker Host 时跳过该通知。
 */
function notifyCoordinatorStorageIoHandoff(owner: CoordinatorStorageIoOwner | undefined): void {
  if (!owner) return;
  if (testCoordinatorPeerHandoffNotifier) {
    testCoordinatorPeerHandoffNotifier(owner.peerId, owner.commitOrder);
    return;
  }
  coordinatorRuntimeApp?.notifyPeerHandoff(owner.peerId, owner.commitOrder);
}

/**
 * 将 WebLoom Host 的 unit state 投影为 Keymaster 协议的领域快照。
 *
 * `state` 与 `reasons` 都取自同一个判定实现，二者不可能互相矛盾：Host 只会说
 * 「这个单元被调度起来了」，判定实现才回答「现在能不能用」。两者不一致时（例如
 * 框架仍认为 enabled 但 owner 会话已锁定）以判定实现为准——状态字段只回答
 * 「能不能用」。状态二值化：Host 的 `starting` 归入 `failed`，未就绪的细节由
 * `reasons` 承担。
 */
function coordinatorRuntimeUnitSnapshots(): CoordinatorWorkerUnitPublicSnapshot[] {
  const app = coordinatorRuntimeApp;
  // Host 尚未完成装配时 fail closed；公开协议不能退回到领域兼容表，
  // 否则首个 bootstrap 可能把手工 Registry 误报成已由 WebLoom 启动。
  if (!app) return [];
  const runtimeState = app.state();
  if (runtimeState.state === "failed" || runtimeState.state === "disposed") return [];
  const revision = Math.max(1, runtimeState.revision);
  coordinatorRuntimeUnitSnapshotRevision = Math.max(coordinatorRuntimeUnitSnapshotRevision, revision);
  const snapshots: CoordinatorWorkerUnitPublicSnapshot[] = [];
  for (const runtimeUnit of runtimeState.units) {
    const descriptor = COORDINATOR_WORKER_UNIT_CATALOG.find((candidate) => candidate.unitId === runtimeUnit.unitId);
    if (!descriptor || runtimeUnit.runtime !== "shared-worker") continue;
    if (runtimeUnit.state !== "enabled" && runtimeUnit.state !== "starting"
      && runtimeUnit.state !== "failed" && runtimeUnit.state !== "blocked") continue;
    const availability = coordinatorUnitAvailability(descriptor.unitId);
    snapshots.push({
      productId: descriptor.productId,
      unitId: descriptor.unitId,
      runtime: "shared-worker",
      scopeKind: descriptor.scopeKind,
      // 从未启动的单元没有实例标识，省略而不是编造（见契约字段说明）。
      ...(runtimeUnit.instanceId ? { instanceId: runtimeUnit.instanceId } : {}),
      state: availability.state,
      dependsOn: availability.dependsOn,
      reasons: availability.reasons.map((item) => ({ ...item })),
      snapshotRevision: revision,
      serviceIds: [...(descriptor.serviceIds ?? [])],
      taskIds: [...descriptor.taskIds],
      ...(descriptor.scopeKind === "owner-session" && coordinatorState.activePublicKeyHex
        ? { ownerPublicKeyHex: coordinatorState.activePublicKeyHex, sessionEpoch: coordinatorState.sessionEpoch }
        : {}),
    });
  }
  return snapshots;
}

function coordinatorRuntimeUnitRevision(): number {
  const revision = coordinatorRuntimeApp?.state().revision ?? 0;
  coordinatorRuntimeUnitSnapshotRevision = Math.max(coordinatorRuntimeUnitSnapshotRevision, revision, 1);
  return coordinatorRuntimeUnitSnapshotRevision;
}

/** 将 Host 实例身份回写到仍保留领域任务句柄的兼容表。 */
function synchronizeCoordinatorTaskUnitInstances(): void {
  const instances = new Map(
    coordinatorRuntimeUnitSnapshots().map((unit) => [unit.unitId, unit.instanceId] as const),
  );
  for (const runtime of backgroundWorkerRuntime.taskRuntimes.values()) {
    const instanceId = instances.get(runtime.unitId);
    if (instanceId) runtime.instanceId = instanceId;
  }
}

function reconcileCoordinatorRuntime(): Promise<void> {
  if (!coordinatorRuntimeApp) return Promise.resolve();
  return coordinatorRuntimeApp.reconcile().then(() => {
    synchronizeCoordinatorTaskUnitInstances();
  }).catch((error) => {
    console.warn("[coordinator] WebLoom runtime unit reconcile failed", error instanceof Error ? error.message : String(error));
  });
}

/**
 * 可用性变化推给框架门重判。
 *
 * 框架把有理由的单元置 `blocked` 之后只在 `reconcile()` 时重试；依赖可用性变化
 * 必须主动推一次，否则「依赖已经好了却没人再问一次」就等于退化成了轮询。
 *
 * 合并与去重都靠同一个标志位：reconcile 期间发生的所有变化被合并成一次，且标志
 * 在整段 reconcile 期间保持为真，因此不可能自激。这是去重，不是等待、休眠或定时器。
 */
let coordinatorRuntimeReconcileScheduled = false;
let coordinatorRuntimeReconcileRequested = false;

function scheduleCoordinatorRuntimeReconcile(): void {
  coordinatorRuntimeReconcileRequested = true;
  if (coordinatorRuntimeReconcileScheduled) return;
  coordinatorRuntimeReconcileScheduled = true;
  void Promise.resolve().then(async () => {
    try {
      do {
        coordinatorRuntimeReconcileRequested = false;
        await reconcileCoordinatorRuntime();
      } while (coordinatorRuntimeReconcileRequested);
    } finally {
      coordinatorRuntimeReconcileScheduled = false;
    }
  });
}

/** 发布 Worker 实际运行单元快照；Window 不再用静态声明猜测后台状态。 */
function publishCoordinatorWorkerUnitSnapshot(): void {
  publishTopicEvent("worker.units", {
    type: "coordinator.worker-units.changed",
    authorityInstanceId: coordinatorAuthority.coordinatorAuthorityInstanceId,
    workerUnitRevision: coordinatorRuntimeUnitRevision(),
    units: coordinatorRuntimeUnitSnapshots(),
  } satisfies Omit<CoordinatorWorkerUnitStateEvent, "topic" | "sessionEpoch">);
}

function currentOwnerWorkerUnitIdentity(): { ownerPublicKeyHex: string; sessionEpoch: SessionEpoch } {
  if (coordinatorState.vaultStatus !== "unlocked" || !coordinatorState.activePublicKeyHex) {
    throw new Error("Coordinator owner Worker unit requires an unlocked active owner");
  }
  return {
    ownerPublicKeyHex: coordinatorState.activePublicKeyHex,
    sessionEpoch: coordinatorState.sessionEpoch,
  };
}

/** owner-session 单元：旧世代占用先摘除,再以当前 owner/session 身份激活。 */
function activateOwnerSessionUnit(
  unitId: string,
  identity: ReturnType<typeof currentOwnerWorkerUnitIdentity>,
): ReturnType<typeof coordinatorWorkerUnitRegistry.activate> {
  const existing = coordinatorWorkerUnitRegistry.get(unitId);
  if (existing && (existing.ownerPublicKeyHex !== identity.ownerPublicKeyHex || existing.sessionEpoch !== identity.sessionEpoch)) {
    coordinatorWorkerUnitRegistry.stop(unitId, existing.instanceId);
  }
  return coordinatorWorkerUnitRegistry.activate(unitId, identity);
}

function activateCoordinatorOwnerWorkerUnit(
  unitId: string,
  instanceId?: string,
): ReturnType<typeof coordinatorWorkerUnitRegistry.activate> {
  const descriptor = COORDINATOR_WORKER_UNIT_CATALOG.find((unit) => unit.unitId === unitId);
  if (descriptor && !isCoordinatorProductRegistered(descriptor.productId)) {
    throw new Error(`Plugin unavailable: ${descriptor.productId}`);
  }
  if (instanceId === undefined && coordinatorRuntimeApp && !testDomainUnitReadiness) {
    const actual = coordinatorRuntimeApp.state().units.find(unit => unit.unitId === unitId && unit.state === "enabled");
    if (!actual?.instanceId) throw new Error(`Coordinator Worker unit is unavailable: ${unitId}`);
    instanceId = actual.instanceId;
  }
  const identity = currentOwnerWorkerUnitIdentity();
  const existing = coordinatorWorkerUnitRegistry.get(unitId);
  // The registry is only a compatibility table. A Host setup owns the real
  // instance identity, so discard an older compatibility entry before
  // binding the exact Host context instance。页面刷新/重新解锁后 session
  // 世代会前进，旧世代 owner-session 单元即使未被锁定也必须先摘除，
  // 否则 activate() 会以“已被其它 owner/session 占用”拒绝当前身份。
  if (existing && ((instanceId !== undefined && existing.instanceId !== instanceId)
    || existing.ownerPublicKeyHex !== identity.ownerPublicKeyHex
    || existing.sessionEpoch !== identity.sessionEpoch)) {
    coordinatorWorkerUnitRegistry.stop(unitId, existing.instanceId);
  }
  return coordinatorWorkerUnitRegistry.activate(unitId, {
    ...identity,
    ...(instanceId !== undefined ? { instanceId } : {}),
  });
}

function activateCoordinatorWorkerUnitForRuntime(
  unitId: string,
  instanceId: string,
): ReturnType<typeof coordinatorWorkerUnitRegistry.activate> {
  const descriptor = COORDINATOR_WORKER_UNIT_CATALOG.find((unit) => unit.unitId === unitId);
  if (!descriptor) throw new Error(`Coordinator Worker unit 未登记: ${unitId}`);
  if (descriptor.scopeKind === "owner-session") {
    return activateCoordinatorOwnerWorkerUnit(unitId, instanceId);
  }
  const existing = coordinatorWorkerUnitRegistry.get(unitId);
  if (existing && existing.instanceId !== instanceId) {
    coordinatorWorkerUnitRegistry.stop(unitId, existing.instanceId);
  }
  return coordinatorWorkerUnitRegistry.activate(unitId, { instanceId });
}

function stopCoordinatorWorkerUnit(unitId: string, instanceId?: string): void {
  coordinatorWorkerUnitRegistry.stop(unitId, instanceId);
}

/** 任务注册在 locked 阶段也会发生；真正进入 owner-session 时再绑定 unit instance。 */
function bindCoordinatorTaskUnitsToOwner(): void {
  if (coordinatorRuntimeApp && !testDomainUnitReadiness) { synchronizeCoordinatorTaskUnitInstances(); return; }
  if (coordinatorState.vaultStatus !== "unlocked" || !coordinatorState.activePublicKeyHex) return;
  const identity = currentOwnerWorkerUnitIdentity();
  const activated = new Map<string, ReturnType<typeof coordinatorWorkerUnitRegistry.activate>>();
  for (const runtime of backgroundWorkerRuntime.taskRuntimes.values()) {
    // 会话恢复可能发生在旧任务仍等待 Provider 返回期间。旧
    // completion 尚未结束时不能先发布一个新的 ready unit；否则快照会同时
    // 代表两个物理世代，下一次调度也可能与旧 I/O 重叠。旧 completion 的
    // finally 会在收尾后重新进入 scheduleRuntime，届时由 executeTask 懒加载
    // 新实例。
    if (runtime.completion) continue;
    const unit = getCoordinatorWorkerUnitForTask(runtime.id);
    if (!unit) continue;
    if (!isCoordinatorProductRegistered(unit.productId) || coordinatorTaskBlockedReason(runtime)) continue;
    let unitSnapshot = activated.get(unit.unitId);
    if (!unitSnapshot) {
      unitSnapshot = activateOwnerSessionUnit(unit.unitId, identity);
      unitSnapshot = coordinatorWorkerUnitRegistry.ready(unit.unitId, unitSnapshot.instanceId);
      activated.set(unit.unitId, unitSnapshot);
    }
    runtime.instanceId = unitSnapshot.instanceId;
  }
  // 这些服务由 registerCoordinatorTasks() 实际创建；它们没有独立周期
  // task，但仍必须和当前 owner 绑定，不能只依赖产品 manifest。
  for (const unitId of ["woc.coordinator-worker"] as const) {
    const serviceUnit = p2pkhWocService;
    if (!serviceUnit) continue;
    const productId = "woc";
    if (!isCoordinatorProductRegistered(productId)) continue;
    let unitSnapshot = activated.get(unitId);
    if (!unitSnapshot) {
      unitSnapshot = activateOwnerSessionUnit(unitId, identity);
      unitSnapshot = coordinatorWorkerUnitRegistry.ready(unitId, unitSnapshot.instanceId);
      activated.set(unitId, unitSnapshot);
    }
  }
}

/** 安全撤权同步摘除所有 owner-session 单元；异步领域清理随后自行收尾。 */
function stopCoordinatorOwnerWorkerUnits(): void {
  for (const snapshot of coordinatorWorkerUnitRegistry.snapshots()) {
    if (snapshot.scopeKind === "owner-session") stopCoordinatorWorkerUnit(snapshot.unitId, snapshot.instanceId);
  }
}

/** Vault 的私钥/WalletState 管理外壳属于 Worker root，随 Worker 重启而重建。 */
function activateCoordinatorRootWorkerUnits(): void {
  if (coordinatorRuntimeApp && !testDomainUnitReadiness) return;
  const vaultUnit = coordinatorWorkerUnitRegistry.activate("vault.coordinator-worker");
  if (vaultUnit.state !== "ready") {
    coordinatorWorkerUnitRegistry.ready(vaultUnit.unitId, vaultUnit.instanceId);
  }
}

/**
 * 在 Storage 已经可用的前提下补齐后台任务注册。
 *
 * 冷启动由 initializeCoordinatorInternal 注册；但“首次选择后端”时
 * bootstrapPlatformStorage 会以未选择状态提前返回，之后才由 initial-setup
 * 或接入已有桶的事务安装 Storage。如果这里不补一次，Worker 会一直没有
 * 后台任务（例如 p2pkh.transactions-sync），页面余额也就永远不会更新。
 */
async function ensureCoordinatorTasksRegistered(): Promise<void> {
  if (backgroundWorkerRuntime.taskRuntimes.size > 0) return;
  await registerCoordinatorTasks();
  activateCoordinatorRootWorkerUnits();
}

/** Worker 与 Host 共用的内置插件 -> 存储声明表。 */
const WORKER_SYSTEM_STORAGE_DECLARATIONS = SYSTEM_STORAGE_DECLARATIONS;

/**
 * Peer scope revoke 是生产连接的唯一断开/准入栅栏。
 *
 * 这里单独保留已经撤销的 peer 身份，是为了让仍在执行的领域 Promise
 * 在迟到 finally/await 边界上不能重新创建 grant 或发布结果。它不是一
 * 个端口注册表，也不承载连接消息。
 */
const revokedCoordinatorPeerIds = new Set<string>();

/**
 * 仅供 worker 单元测试收集领域事件；生产 Runtime 不读取或写入这张表。
 * 测试通过 `__testAttachPort` 注册 sink，不会把它伪装成 SharedWorker 端口。
 */
interface CoordinatorTestEventSink {
  readonly postMessage: (message: unknown, transfer?: ArrayBuffer[]) => void;
  readonly topics: Set<CoordinatorTopic>;
}
const coordinatorTestEventSinks = new Map<string, CoordinatorTestEventSink>();

let sessionRevision = 0;
let backgroundSnapshotRevision = 0;
let chainHeightRevision = 0;
let assetDataRevision = 0;
let contactsPresenceRevision = 0;
/** 统一主会话只保留一个自动锁定计时器；旧计时器不能跨解锁世代存活。 */
const vaultAutoLock = createWorkerAutoLock({
  session: () => coordinatorState,
  timeout: () => coordinatorMeta.autoLockTimeoutMs ?? coordinatorState.autoLockTimeoutMs,
  commitTimeout: timeout => { coordinatorMeta.autoLockTimeoutMs = timeout; coordinatorState.autoLockTimeoutMs = timeout; },
  deadline: () => coordinatorState.autoLockDeadline,
  commitDeadline: deadline => { coordinatorState.autoLockDeadline = deadline; },
  keepUnlocked: sellerKeepsVaultUnlocked,
  persistTimeout: autoLockTimeoutMs => persistCoordinatorSettings({ scheduleSettings: coordinatorMeta.scheduleSettings, autoLockTimeoutMs }),
  publishSettings: () => publishSessionState("autolock-settings"),
  lock: () => performGlobalLock("auto-lock-timeout"),
});
function resetAutoLockTimer(): void { vaultAutoLock.reset(); }
const handleAutolockSettingsUpdate = vaultAutoLock.update;
const contactsPresenceProjection = createWorkerPresenceProjection({
  admission: { available: () => isCoordinatorProductRegistered("contacts"), blocked: requestId => coordinatorProductBlockedResponse(requestId, "contacts") },
  service: () => contactsWorkerRuntime.current(),
  session: () => ({ owner: normalizedCoordinatorOwner(), epoch: coordinatorState.sessionEpoch }),
  publish: event => publishTopicEvent("contacts.presence", event) as CoordinatorContactsPresenceEvent,
});

/** Coordinator 真实任务的最终 I/O 审计入口；测试任务不进入生产台账。 */
const COORDINATOR_TASK_FINAL_IO_AUDIT: Readonly<Record<string, FinalIoAuditOperation>> = Object.fromEntries(
  COORDINATOR_WORKER_UNIT_CATALOG.flatMap((unit) => unit.finalIoAuditEntries.map((entry) => [entry.taskId, entry.operation] as const)),
);

/** 静态产品身份登记；不表示实例就绪，也不读取用户启停配置。 */
function isCoordinatorProductRegistered(pluginId: string): boolean {
  if (pluginId === "test") return true;
  if (!BUILTIN_PLUGIN_PRODUCT_ID_SET.has(pluginId)) return false;
  return true;
}

function coordinatorTaskBlockedReason(runtime: TaskRuntime): string | undefined {
  const unit = getCoordinatorWorkerUnitForTask(runtime.id);
  if (!unit) return undefined;
  // 调度/懒构造之前只检查真实依赖与作用域，不能要求自身已经 ready。
  const unavailable = describeUnitUnavailableForFramework(
    coordinatorRuntimeApp && !testDomainUnitReadiness
      ? evaluateCoordinatorUnitAvailability(unit.unitId, coordinatorUnitAvailabilityContext())
      : evaluateCoordinatorUnitStartupPreconditions(unit.unitId, coordinatorUnitAvailabilityContext()),
  );
  return unavailable ? `Runtime unavailable: ${unavailable}` : undefined;
}

function isRuntimeAvailabilityBlockedReason(reason: string | undefined): boolean {
  return typeof reason === "string" && reason.startsWith("Runtime unavailable: ");
}

/** Provider 重建后允许重新排程的可恢复阻塞；不是未知写入结果。 */
function isProviderAvailabilityBlockedReason(reason: string | undefined): boolean {
  return typeof reason === "string" && reason.startsWith("Broadcast provider is unavailable for ");
}

function coordinatorProductBlockedResponse(requestId: string, pluginId: string): CoordinatorResponse {
  return {
    requestId,
    sessionEpoch: coordinatorState.sessionEpoch,
    ack: {
      status: "blocked",
      reason: { key: "plugin.blocked.unavailable", fallback: `Plugin unavailable: ${pluginId}` },
    },
  };
}

// ============================================================
// 智能调度（2026-09-20）
// ============================================================
//
// 设计缘由：
//   - 资产余额（UTXO 快照）不再等固定周期：只要 WoC 队列空闲满 2 秒，
//     就刷新一次余额快照，把「所有闲暇时间」用来获取余额。
//   - 任何 WoC 请求开始都会打断计时；请求结束后重新从 0 计时 2 秒，
//     因此用户操作期间不会与后台同步抢队列。
//   - 其余同步任务由「同步管理」按各自间隔调度；间隔为 0 表示关闭。
//   - 解锁 / 初始化完成后立即同步一次。

/** 智能调度：WoC 队列空闲满 2 秒后刷新余额快照。 */
const backgroundWorkerRuntime = createWorkerBackgroundRuntime({
  createTaskRuntime: input => createCoordinatorTaskRuntime(input),
  state: () => ({ scheduleSettings: coordinatorState.scheduleSettings, vaultStatus: coordinatorState.vaultStatus, sessionEpoch: coordinatorState.sessionEpoch, runGeneration: coordinatorState.runGeneration, activePublicKeyHex: coordinatorState.activePublicKeyHex }),
  blockedReason: coordinatorTaskBlockedReason,
  isAvailabilityBlocked: isRuntimeAvailabilityBlockedReason,
  publish: event => { publishTopicEvent("background.snapshot", event); },
  queueSnapshot: () => (testDomainUnitReadiness ? p2pkhWocService : p2pkhWorkerRuntime.query())?.getQueueSnapshot(),
  activate: taskId => {
    const unit = getCoordinatorWorkerUnitForTask(taskId);
    if (!unit) return undefined;
    const instance = activateCoordinatorOwnerWorkerUnit(unit.unitId);
    return coordinatorWorkerUnitRegistry.ready(instance.unitId, instance.instanceId).instanceId;
  },
  runAudited: async (taskId, signal, run) => {
    const auditOperation = COORDINATOR_TASK_FINAL_IO_AUDIT[taskId];
    if (auditOperation) await withCoordinatorFinalIoLease("write", signal, run, { auditOperation });
    else await run(signal);
  },
  persistSettings: scheduleSettings => persistCoordinatorSettings({ scheduleSettings, autoLockTimeoutMs: coordinatorMeta.autoLockTimeoutMs ?? AUTO_LOCK_DEFAULT_TIMEOUT_MS }),
  commitSettings: settings => { coordinatorMeta.scheduleSettings = settings; coordinatorState.scheduleSettings = settings; },
});
const getTaskSnapshots = () => backgroundWorkerRuntime.snapshots();
const { managedIntervalFor, cancelSmartSyncIdleTimer, isWocQueueIdle, canArmSmartSync, armSmartSyncIdleTimer, onWocQueueChanged, armSmartSyncIfIdle, triggerSmartSync, triggerImmediateSync, scheduleRuntime, assertTaskFresh, resolveKeyScope, handleBackgroundRunNow, handleBackgroundTrigger, handleBackgroundCancelByKey, cancelTaskRuntimesByKey, handleBackgroundCancel, handleBackgroundSettingsUpdate, executeTask } = backgroundWorkerRuntime;

/** 归一化同步管理设置：只保留已登记任务与合法间隔，非法值直接丢弃。 */

function workerWalletSnapshot(): import("@keymaster/contracts").VaultLifecycleSnapshot {
  return {
    status: coordinatorState.vaultStatus === "fatal" ? "locked" : coordinatorState.vaultStatus,
    activePublicKeyHex: coordinatorState.vaultStatus === "unlocked" ? coordinatorState.activePublicKeyHex : undefined,
    activeKeyIdentity: coordinatorState.vaultStatus === "unlocked" ? vaultWorkerKeys.coordinatorActiveKeySummary() : undefined,
    sessionEpoch: coordinatorState.sessionEpoch, runGeneration: coordinatorState.runGeneration,
    walletGeneration: coordinatorState.walletGeneration, vaultLifecycleRevision: sessionRevision, lockCleanup: walletLockBarrier.snapshot()
  };
}
const workerWalletState = createWalletStateSource(workerWalletSnapshot);
// Only trusted Worker assembly and fixture tasks hold this private source.
const createWorkerWalletState = () => workerWalletState;

/** Worker 任务在 locked 首屏也要先注册；真实 owner 存储延迟到解锁后绑定。 */
/**
 * Worker 内置模块使用的文件根（model: "files"）。
 *
 * 逻辑路径由中央声明的 moduleId/purposeId 决定，没有 Owner 前缀也没有桶。
 * 句柄按四维绑定惰性重建：锁定、改密、重置、Worker 重启和 Root 换绑都会让
 * 旧绑定失效，并在下一次调用时重新打开。
 */
const workerStorageClients = createWorkerStorageClients({
  root: () => storageWorkerRoot.root,
  binding: storageWorkerRequests.currentCoordinatorStorageBinding,
  sameBinding: storageWorkerRequests.storageBindingsEqual,
  assertAvailable: assertStorageDataAvailable,
  assertLive: storageWorkerRequests.assertStorageBindingLive,
  beginRequest: storageWorkerRequests.beginStorageBindingRequest,
  declaration(moduleId, purposeId, model) {
    const declaration = SYSTEM_STORAGE_DECLARATIONS[moduleId]?.find(candidate => candidate.model === model && candidate.purposeId === purposeId);
    if (!declaration) throw new Error(`Unknown module storage declaration: ${moduleId}/${purposeId}/${model}`);
    return declaration;
  },
  unavailable: storageUnavailableError,
  withIoLease(operation, model, execute) {
    return model === "files"
      ? withCoordinatorFinalIoLease(operation, undefined, execute, { auditOperation: "storage.module.files", durableLease: operation === "write" })
      : withCoordinatorFinalIoLease(operation, undefined, execute, { auditOperation: "storage.owner.data", durableLease: operation === "write" });
  },
  onFailure: markStorageIoFailure,
  onInvalidate(moduleId) { if (moduleId === "p2pkh") disposeP2pkhStateRepository(); },
  registerMaintenance: storageKeyValueMaintenance.register,
  unregisterMaintenance: storageKeyValueMaintenance.unregister,
});
const createWorkerModuleFileStore = workerStorageClients.moduleFiles;
const createWorkerKeyValueStore = workerStorageClients.keyValue;

const workerStorageClientCapabilities = createScopedStorageClients({
  getActivePublicKeyHex: () => coordinatorState.activePublicKeyHex,
  getWalletGeneration: () => coordinatorState.walletGeneration,
  async openOwnerFileStore({ pluginId, declaration }) {
    const binding = storageWorkerRequests.currentCoordinatorStorageBinding();
    if (!binding) throw storageUnavailableError("Worker file binding is unavailable");
    // Scoped clients have verified the live consumer and its central declaration.
    // Platform-managed App settings must use the private platform file entry.
    const files = declaration.authority === "platform-only"
      ? workerStorageClients.platformFiles(pluginId, declaration.purposeId)
      : createWorkerModuleFileStore(pluginId, declaration.purposeId);
    return { ...files, ...declaration, model: "files" as const, ...binding, close: () => { } };
  },
  async openOwnerAppStore({ pluginId, declaration }) {
    const binding = storageWorkerRequests.currentCoordinatorStorageBinding();
    if (!binding) throw storageUnavailableError("Worker K-V binding is unavailable");
    const store = createWorkerKeyValueStore(pluginId, declaration.purposeId);
    return { ...store, ...binding };
  },
  async openPlatformStore() { throw storageUnavailableError("Worker public clients do not expose platform purposes"); },
  async clearStorageRoot() { throw storageUnavailableError("Worker public clients do not clear roots"); },
}, pluginId => BUILTIN_PLUGIN_DEFINITIONS.find(plugin => plugin.id === pluginId), (consumer, scope) => workerConsumers.get(consumer) === scope);

/**
 * P2PKH service 仍由现有 Coordinator broadcast pipeline 负责广播；Sat
 * 充值只注入一个内部 Coordinator facade，避免从 SharedWorker 再绕回页面。
 */
const p2pkhWorkerRuntime = createP2pkhWorkerRuntime({
  tasks: coordinatorTaskRegistrar,
  registerProviders: (registry, broadcast) => registerWocP2pkhProviders({ registry, woc: broadcast }),
  snapshotSource: createP2pkhSnapshotWocSource,
  resetSettings: () => p2pkhWorkerSettings.reset(),
  refresh: (signal, storage, assertActive) => refreshP2pkhUtxoSnapshots(signal, storage, assertActive),
  emit: (kinds, utxoSeqs) => { publishTopicEvent("asset.data-changed", { type: "asset.data-changed", providerId: "p2pkh", publicKeyHex: coordinatorState.activePublicKeyHex ?? "", kinds, ...(utxoSeqs ? { utxoSeqs } : {}) }); },
  transfer: {
    requestPayment: command => vaultWorkerOperations.executeVaultOperation({ type: "payment", command }) as Promise<import("@keymaster/contracts").JSONValue>,
    assertActive: () => {
      assertCoordinatorUnitConstructible("p2pkh.coordinator-worker");
      if (!testDomainUnitReadiness) { if (!p2pkhWorkerRuntime.binding()) throw new Error("P2PKH Worker instance is unavailable"); p2pkhWorkerRuntime.binding()!.assertActive(); }
    },
    session: () => ({ owner: coordinatorState.activePublicKeyHex, epoch: coordinatorState.sessionEpoch, unlocked: coordinatorState.vaultStatus === "unlocked" }),
    loadSettings: (owner) => loadP2pkhSettingForOwner(owner),
    settings: () => coordinatorMeta.p2pkhSettings,
    walletState: () => testDomainUnitReadiness ? createWorkerWalletState() : p2pkhWorkerRuntime.binding()!.walletState,
    storage: () => testDomainUnitReadiness ? createWorkerModuleFileStore("p2pkh", "") : p2pkhWorkerRuntime.binding()!.storage,
    crypto: (owner) => testDomainUnitReadiness ? vaultWorkerKeys.createWorkerActiveKeyCrypto(owner) : p2pkhWorkerRuntime.binding()!.crypto.createActiveKeyCrypto(owner),
    vaultStatus: () => coordinatorState.vaultStatus === "fatal" ? "locked" : coordinatorState.vaultStatus,
    snapshot: async (input, refresh) => {
      const request = { ...input, expectedSessionEpoch: coordinatorState.sessionEpoch, clientId: "sat-subscription", requestId: generateRequestId() };
      const response = refresh
        ? await handleP2pkhUtxosRefresh(request.requestId, { ...request, kind: "p2pkh.utxos.refresh" })
        : await handleP2pkhUtxosGet(request.requestId, { ...request, kind: "p2pkh.utxos.get" });
      return response.ack.status === "ok" ? { status: "ok", value: response.operationResult as P2pkhUtxoSnapshotResult, sessionEpoch: response.sessionEpoch } : response.ack;
    },
    broadcast: async (input) => {
      const request = { ...input, expectedSessionEpoch: coordinatorState.sessionEpoch, clientId: "sat-subscription", requestId: generateRequestId(), kind: "p2pkh.broadcast" as const };
      const response = await handleP2pkhBroadcast(request.requestId, request);
      return response.ack.status === "ok" ? { status: "ok", value: response.operationResult, sessionEpoch: response.sessionEpoch } : response.ack;
    },
    subscribeUtxo: listener => p2pkhWorkerRuntime.subscribeUtxoSeq(listener),
    query: () => p2pkhWorkerRuntime.query() ?? p2pkhWocService,
    retryOptions: () => testSatBroadcastRetryOverrides,
  },
});
const workerTransferRuntime = p2pkhWorkerRuntime.transfer;
const ensureSatP2pkhService = workerTransferRuntime.ensure;

/**
 * 快照 store 的 WoC 数据源包装。
 *
 * 生产路径原样委托给真实 WoC；测试可用 `__testSetP2pkhUnspentAllProvider`
 * 替换 `unspent/all`，让 Worker 侧的消费/重试链路不出网。
 */
function createP2pkhSnapshotWocSource(woc: WocService): WocService {
  return {
    getAddressUnspentAll: (network: "main" | "test", address: string, options?: import("@keymaster/contracts").WocRequestOptions) =>
      testP2pkhUnspentAllProvider
        ? testP2pkhUnspentAllProvider(network, address)
        : woc.getAddressUnspentAll(network, address, options),
    getTransactionObservation: (network: "main" | "test", txid: string, options?: import("@keymaster/contracts").WocRequestOptions) => woc.getTransactionObservation(network, txid, options),
  } as unknown as WocService;
}

function initializeCoordinatorP2pkhProviders(woc: WocService, broadcast: WocWorkerBroadcastService): void {
  p2pkhWorkerRuntime.initialize(woc, broadcast);
}

// ============================================================
// 3. Utility Functions
// ============================================================

let domainFixtureInstaller: (() => Promise<void>) | undefined;
async function registerCoordinatorTasks() {
  // 生产任务只由插件 setup 注册；领域夹具由独立的 testing graph 安装。
  await domainFixtureInstaller?.();
  bindCoordinatorTaskUnitsToOwner();
  for (const runtime of backgroundWorkerRuntime.taskRuntimes.values()) scheduleRuntime(runtime);
  publishTopicEvent("background.snapshot", { type: "background.snapshot.changed", sessionEpoch: coordinatorState.sessionEpoch, snapshots: getTaskSnapshots() });
  triggerImmediateSync(BACKGROUND_TRIGGER_REASON.INIT);
}

function generateEpoch(): SessionEpoch {
  return crypto.randomUUID();
}

function generateRequestId(): string {
  return `req-${Date.now()}-${randomIdentifierSuffix()}`;
}

function generateCoordinatorServiceId(prefix: string): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `${prefix}:${crypto.randomUUID()}`;
    }
  } catch {
    // 这类标识只在 Worker 内比较；没有 Web Crypto 时退回进程内唯一格式。
  }
  return `${prefix}:${Date.now().toString(36)}:${randomIdentifierSuffix()}`;
}

async function buildTopicBaselines(
  request: CoordinatorTopicSubscription,
): Promise<CoordinatorTopicBaseline[]> {
  await storageWorkerRoot.stateTail;

  const baselines: CoordinatorTopicBaseline[] = request.topics.flatMap((topic): CoordinatorTopicBaseline[] => {
    if (topic === "asset.data-changed") return [];
    if (topic === "chain.height") {
      // 链高度是公共链状态：新 Tab 拿到的 baseline 就是 Worker 当前读数；
      // 从未成功读取过时携带 available=false，而不是伪造高度 0。
      return [{
        topic,
        baselineRevision: chainHeightRevision,
        sessionEpoch: coordinatorState.sessionEpoch,
        snapshot: {
          topic: "chain.height" as const,
          type: "chain.height.changed" as const,
          chainHeightRevision,
          sessionEpoch: coordinatorState.sessionEpoch,
          chainHeight: wocWorkerRuntime.snapshot(),
        },
      }];
    }
    if (topic === "storage.state") {
      const baselineRevision = storageWorkerRoot.revision;
      // Subscription response must be atomic; use the last published state
      // when available, otherwise a baseline derived from the cold-start truth.
      // 本地介质永远「已配置」，可失败的原因只有冷启动结论本身。
      const cached = storageWorkerRoot.lastState ?? {
        topic: "storage.state" as const, type: "storage.state.changed" as const,
        storageRevision: baselineRevision, sessionEpoch: coordinatorState.sessionEpoch,
        ...(coordinatorState.walletGeneration ? { walletGeneration: coordinatorState.walletGeneration } : {}),
        ...(coordinatorAuthority.coordinatorAuthorityRecovery ? { authorityRecovery: coordinatorAuthority.coordinatorAuthorityRecovery } : {}),
        status: coordinatorStorageStatus(),
        summary: null,
      };
      return [{ topic, baselineRevision, sessionEpoch: coordinatorState.sessionEpoch, snapshot: cached }];
    }
    if (topic === "msfile.state") {
      const baselineRevision = msfileWorkerProjection.msfileRevision;
      const cached = msfileWorkerProjection.lastMsFileState ?? {
        topic: "msfile.state" as const, type: "msfile.state.changed" as const,
        msfileRevision: baselineRevision, sessionEpoch: coordinatorState.sessionEpoch,
        status: (coordinatorState.vaultStatus === "unlocked" ? "unconfigured" : "unavailable") as import("@keymaster/contracts").MsFileServiceStatus,
        supplierGeneration: 0, globalSettings: null,
        ...MSFILE_READ_CONCURRENCY_RECOMMENDED,
        sellerSettings: { ...MSFILE_SELLER_SETTINGS_DEFAULT, supportedArbiterPublicKeys: [] },
        sellerRuntimeStatus: coordinatorState.vaultStatus === "unlocked" ? "disabled" as const : "waiting-unlock" as const,
        pendingApprovals: []
      };
      return [{ topic, baselineRevision, sessionEpoch: coordinatorState.sessionEpoch, snapshot: cached }];
    }
    if (topic === "sat.events") {
      const baselineRevision = satRevision;
      // Sat message/inbound 事件是 edge-triggered，不能把最近一条真实消息
      // 当作新 Tab 的 baseline 重放；baseline 只携带健康快照和 noop。
      const cached = lastSatState?.event.type === "noop" ? lastSatState : {
        topic: "sat.events" as const,
        type: "sat.events.changed" as const,
        satRevision: baselineRevision,
        sessionEpoch: coordinatorState.sessionEpoch,
        event: { type: "noop" as const },
      };
      return [{ topic, baselineRevision, sessionEpoch: coordinatorState.sessionEpoch, snapshot: cached }];
    }
    if (topic === "channel.events") {
      const subscriptionStatuses = channelWorkerRuntime.channelSubscriptionStatusBaseline();
      return [{
        topic,
        baselineRevision: channelRevision,
        sessionEpoch: coordinatorState.sessionEpoch,
        snapshot: {
          topic: "channel.events" as const,
          type: "channel.subscription.changed" as const,
          channelRevision,
          sessionEpoch: coordinatorState.sessionEpoch,
          subscriptionStatuses,
        }
      }];
    }
    if (topic === "contacts.presence") {
      const activePublicKeyHex = normalizedCoordinatorOwner();
      const projection = contactsPresenceProjection.current();
      const cached = projection
        && projection.sessionEpoch === coordinatorState.sessionEpoch
        && projection.activePublicKeyHex === activePublicKeyHex
        ? projection
        : {
          topic: "contacts.presence" as const,
          type: "contacts.presence.changed" as const,
          presenceRevision: contactsPresenceRevision,
          sessionEpoch: coordinatorState.sessionEpoch,
          activePublicKeyHex,
          presence: {}
        };
      return [{
        topic,
        baselineRevision: contactsPresenceRevision,
        sessionEpoch: coordinatorState.sessionEpoch,
        snapshot: cached
      }];
    }

    if (topic === "worker.units") {
      const baselineRevision = coordinatorRuntimeUnitRevision();
      return [{
        topic,
        baselineRevision,
        sessionEpoch: coordinatorState.sessionEpoch,
        snapshot: {
          topic: "worker.units" as const,
          type: "coordinator.worker-units.changed" as const,
          authorityInstanceId: coordinatorAuthority.coordinatorAuthorityInstanceId,
          workerUnitRevision: baselineRevision,
          sessionEpoch: coordinatorState.sessionEpoch,
          units: coordinatorRuntimeUnitSnapshots(),
        },
      }];
    }
    const baselineRevision = topic === "session.state" ? sessionRevision : backgroundSnapshotRevision;
    const snapshot = topic === "session.state"
      ? {
        topic, type: "session.state.changed" as const, sessionRevision: baselineRevision, sessionEpoch: coordinatorState.sessionEpoch, cause: "bootstrap" as const, vaultStatus: coordinatorState.vaultStatus,
        lockCleanup: walletLockBarrier.snapshot(), activePublicKeyHex: coordinatorState.vaultStatus === "unlocked" ? coordinatorState.activePublicKeyHex ?? null : null,
        ...(coordinatorState.vaultStatus === "unlocked" ? { activeKeyIdentity: vaultWorkerKeys.coordinatorActiveKeySummary() } : {}), runGeneration: coordinatorState.runGeneration, ...(coordinatorState.walletGeneration ? { walletGeneration: coordinatorState.walletGeneration } : {}), autoLockTimeoutMs: coordinatorMeta.autoLockTimeoutMs ?? AUTO_LOCK_DEFAULT_TIMEOUT_MS
      }
      : { topic, type: "background.snapshot.changed" as const, backgroundSnapshotRevision: baselineRevision, sessionEpoch: coordinatorState.sessionEpoch, snapshots: getTaskSnapshots(), scheduleSettings: coordinatorState.scheduleSettings, p2pkhSettings: coordinatorMeta.p2pkhSettings };
    return [{ topic, baselineRevision, sessionEpoch: coordinatorState.sessionEpoch, snapshot }];
  });

  return baselines;
}

function handleActivity(): void {
  coordinatorState.lastActivityAt = Date.now();
  resetAutoLockTimer();
}

// ============================================================
// 6. Request Processing
// ============================================================

/**
 * All coordinator RPCs share one FIFO. In particular, password rotation must
 * not overlap a Storage seal/open or another Vault operation: those operations
 * read and write the same keymaster.storage snapshots and otherwise could
 * escape the rotation journal.
 */
let coordinatorRequestTail: Promise<void> = Promise.resolve();

function storageErrorResponse(requestId: string, error: unknown): CoordinatorResponse {
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  return {
    requestId,
    sessionEpoch: coordinatorState.sessionEpoch,
    ack: {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
      ...(typeof code === "string" ? { code: code as never } : {})
    }
  };
}

function disconnectedClientResponse(requestId: string): CoordinatorResponse {
  return storageErrorResponse(requestId, Object.assign(new Error("Coordinator client disconnected"), { code: "transport_disconnected" }));
}

// ============================================================
// Channel runtime / owner inbox
// ============================================================

const channelWorkerRuntime = createChannelWorkerRuntime({
  session: () => ({ vaultStatus: coordinatorState.vaultStatus, sessionEpoch: coordinatorState.sessionEpoch, activePublicKeyHex: coordinatorState.activePublicKeyHex }),
  runtime: { current: () => satWorkerLifecycle.current(), ensure: () => ensureSatRuntime() },
  io: { run: (operation, signal, execute, options) => withCoordinatorFinalIoLease(operation, signal, execute, { ...options, auditOperation: options.auditOperation }) },
  admission: { disconnected: peerId => revokedCoordinatorPeerIds.has(peerId), response: disconnectedClientResponse },
  products: { available: isCoordinatorProductRegistered, blocked: coordinatorProductBlockedResponse },
  events: event => { publishTopicEvent("channel.events", event as never); },
  connectSession: getAuthoritativeConnectSession,
  crypto: { signer: vaultWorkerKeys.channelSigner, open: vaultWorkerKeys.openChannelPrivate },
  related: {
    prune(now) {
      for (const [messageId, request] of msfileBitfsBuyerRequests) {
        if (request.expiresAtMs <= now || request.ownerSessionEpoch !== coordinatorState.sessionEpoch) {
          msfileBitfsBuyerRequests.delete(messageId); msfileBitfsBuyerOfferCounts.delete(messageId);
        }
      }
    },
    recordPong: input => { contactsWorkerRuntime.current()?.recordVerifiedPong?.(input); },
    routeSignal: (body, opened, seedHashHex) => msfileBitfsRuntime.handleInboxWebRtc(body, opened, seedHashHex),
    hashRequestSeen: request => handleMsfileSellerHashRequest(request),
  },
});

// Coordinator 不接受任意 RPC 自报 caller；普通插件还会在 Host context 层被
// 绑定 manifest.id，这里是 Worker 边界的第二道 fail-closed 校验。

/** 测试不同 Channel 消息类型的本地去重命名空间。 */
type ChannelSeenMessageKind = "private" | "public" | "hash-request";

// 审查修复：控制面 mutation 必须串行。SharedWorker 的 onmessage 不等待前一个
// 请求结束，多端口可并发进入 executeMsfileControl；不串行化时同世代检查与
// “读取旧策略—合并—写回”都会互相覆盖。

/* ---------- Window P2P executor lease（施工单 001 §3.2） ----------
 * Coordinator 内存真值：同一 epoch+owner 同时最多一个 Window executor。
 * lock / key switch / Worker 重启直接清空；port 断开立即回收。 */
const windowP2pExecutorTransport = createWindowP2pMsFileTransport({
  get available() {
    return windowP2pWorkerRuntime.windowP2pExecutorLease?.transportReady === true
      && windowP2pWorkerRuntime.windowP2pExecutorLease.sessionEpoch === coordinatorState.sessionEpoch
      && coordinatorState.vaultStatus === "unlocked";
  },
  request: windowP2pWorkerRuntime.requestWindowP2pExecutorOperation,
  dispose: () => undefined,
});

const executeMsfileControl = msfileBitfsRuntime.executeMsfileControl;
const isMsfileMutationControl = msfileBitfsRuntime.isMsfileMutationControl;

function enqueueCoordinatorRequest(request: CoordinatorClientRequest, actualClientId: string, requestSignal?: AbortSignal): Promise<CoordinatorResponse> {
  const requestId = "requestId" in request ? request.requestId : generateRequestId();
  let started = false;
  const execute = (): Promise<CoordinatorResponse> => {
    started = true;
    // A cancelled request may have spent time behind another FIFO item. Do
    // not start its business handler after the peer was fenced; the caller's
    // Provider slot can settle immediately while this no-op keeps the FIFO
    // chain ordered for later requests.
    if (requestSignal?.aborted || revokedCoordinatorPeerIds.has(actualClientId)) {
      return Promise.resolve(disconnectedClientResponse(requestId));
    }
    return executeProcessRequest(request, actualClientId, requestSignal);
  };
  const run = coordinatorRequestTail.then(execute, execute);
  coordinatorRequestTail = run.then(() => undefined, () => undefined);
  if (!requestSignal) return run;

  // Only a request that has not entered executeProcessRequest is safe to
  // settle early. Once started, its handler must retain the execution slot
  // until its real Promise settles; this prevents a late side effect from
  // escaping the Runtime drain fence.
  let removeAbort: (() => void) | undefined;
  const cancelled = new Promise<CoordinatorResponse>((resolve) => {
    const onAbort = (): void => {
      if (!started) resolve(disconnectedClientResponse(requestId));
    };
    if (requestSignal.aborted) onAbort();
    else {
      requestSignal.addEventListener("abort", onAbort, { once: true });
      removeAbort = () => requestSignal.removeEventListener("abort", onAbort);
    }
  });
  return Promise.race([run, cancelled]).finally(() => removeAbort?.());
}

async function executeProcessRequest(request: CoordinatorClientRequest, actualClientId: string, requestSignal?: AbortSignal): Promise<CoordinatorResponse> {
  const requestId = "requestId" in request ? request.requestId : generateRequestId();
  const route = coordinatorRequestRoutes.get(request.kind);
  if (!route) return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "validation-error", message: "Unknown request kind" } };
  const call = { peerId: actualClientId, requestId, signal: requestSignal };
  if (requestSignal?.aborted || revokedCoordinatorPeerIds.has(actualClientId)) return disconnectedClientResponse(requestId);
  const policy = route.policy(request);
  if (policy.validateEpoch && "expectedSessionEpoch" in request && request.expectedSessionEpoch !== coordinatorState.sessionEpoch && request.expectedSessionEpoch !== "boot" && request.expectedSessionEpoch !== "locked") {
    const evidence = await route.stale?.(request, call);
    return evidence ?? { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "stale-epoch" } };
  }
  try { return await route.execute(request, call); }
  catch (error) { markStorageIoFailure(error); return storageErrorResponse(requestId, error); }
}

async function processRequestCore(request: CoordinatorClientRequest, actualClientId = (request as { clientId?: string }).clientId ?? "unknown", requestSignal?: AbortSignal): Promise<CoordinatorResponse> {
  const requestId = "requestId" in request ? request.requestId : generateRequestId();
  if (revokedCoordinatorPeerIds.has(actualClientId) || requestSignal?.aborted) return disconnectedClientResponse(requestId);
  const policy = coordinatorRequestRoutes.get(request.kind)?.policy(request);
  const cleanup = walletLockBarrier.snapshot();
  if (cleanup && policy?.activatesWallet) return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "blocked", reason: { key: "vault.lock.cleanupBlocked", fallback: cleanup.phase === "failed" ? "钱包清理失败，请重试清理后再解锁" : "钱包正在锁定，请等待清理完成" } } };
  // 清理声明允许本地 fail-closed 撤权，其余请求必须经过 origin authority。
  if (!policy?.cleanupOnly && storageWorkerRoot.root && storageWorkerRoot.ready) {
    try { await assertCoordinatorAuthorityCurrent(); }
    catch (error) {
      const detail = coordinatorAuthority.coordinatorAuthorityRecoveryOperationNames.length ? "; active final I/O=" + coordinatorAuthority.coordinatorAuthorityRecoveryOperationNames.join(",") : "";
      const response = storageErrorResponse(requestId, error);
      if (response.ack.status === "error") response.ack.message += detail;
      return response;
    }
  }
  if (revokedCoordinatorPeerIds.has(actualClientId) || requestSignal?.aborted) return disconnectedClientResponse(requestId);
  return policy?.scheduling === "parallel" ? executeProcessRequest(request, actualClientId, requestSignal) : enqueueCoordinatorRequest(request, actualClientId, requestSignal);
}

/**
 * 为可取消的页面请求登记控制器，再进入 Coordinator FIFO。
 *
 * 断开协议与原请求是两个独立 MessagePort 消息；控制器必须在进入
 * authority 等待前登记，否则旧页面可能在异步校验期间重新取得远端租约。
 */
async function processRequest(request: CoordinatorClientRequest, actualClientId = (request as { clientId?: string }).clientId ?? "unknown", requestSignal?: AbortSignal): Promise<CoordinatorResponse> {
  const call = { peerId: actualClientId, requestId: "requestId" in request ? request.requestId : generateRequestId(), signal: requestSignal };
  const prepared = coordinatorRequestRoutes.get(request.kind)?.prepare?.(request, call);
  let response: CoordinatorResponse | undefined;
  try { response = await processRequestCore(request, actualClientId, prepared?.signal ?? requestSignal); return response; }
  finally { prepared?.dispose(response); }
}

// ============================================================
// 7. Vault Operations
// ============================================================

/**
 * 解锁后的运行绑定收口。
 *
 * 会话状态与私钥副本由 lifecycle 的 adoptUnlockedKey 写入；这里负责最终
 * I/O 门禁、业务运行单元、任务恢复、快照广播和自动锁计时。任一步失败都
 * fail closed 回到 locked，而不是让页面看到半解锁状态。
 */
async function completeUnlockedBinding(cause: SessionStateEvent["cause"] = "unlock"): Promise<void> {
  const publicKeyHex = coordinatorState.activePublicKeyHex;
  const bindingEpoch = coordinatorState.sessionEpoch;
  if (walletLockBarrier.snapshot()) throw storageUnavailableError("Wallet cleanup has not completed");
  if (!publicKeyHex) throw storageUnavailableError("Unlocked wallet has no active key");
  try {
    await ensureCoordinatorUpgradeSession();
    bindCoordinatorTaskUnitsToOwner();
    try {
      await ensureMsfileBitfsBuyerRecovery(publicKeyHex);
    } catch (error) {
      console.warn("[msfile] BitFS buyer recovery gate remains closed", error instanceof Error ? error.message : String(error));
    }
    await reconcileCoordinatorRuntime();
    if (coordinatorState.sessionEpoch !== bindingEpoch || coordinatorState.vaultStatus !== "unlocked") throw storageUnavailableError("Wallet unlock was revoked during runtime binding");
  } catch (error) {
    await performGlobalLock("worker-unit-bind-failed");
    throw error;
  }
  emitStorageState();

  backgroundWorkerRuntime.resume("Vault is locked");
  triggerImmediateSync(BACKGROUND_TRIGGER_REASON.UNLOCK);
  publishSessionState(cause);
  void ensureSatRuntime()
    .then((runtime) => channelWorkerRuntime.ensureChannelSubscriptionMux(runtime))
    .catch((error) => console.warn("[channel] owner runtime startup deferred", error instanceof Error ? error.message : String(error)));
  publishTopicEvent("background.snapshot", {
    type: "background.snapshot.changed",
    sessionEpoch: coordinatorState.sessionEpoch,
    snapshots: getTaskSnapshots(),
  });
  resetAutoLockTimer();
}

/**
 * 单 Key 生命周期的唯一权威路径。
 *
 * 生命周期服务（WalletLifecycleService）负责 KeyHold 的解密、改密、重命名、
 * 导出和重置；Coordinator 只负责把它的结果接进 Worker 的会话、运行绑定、
 * grant 和业务运行单元。这里没有 Key 列表、没有选择、没有切换，也没有第二把
 * Key 的写入口——更换身份只能走 reset-wallet 之后重新创建或导入。
 */

/**
 * lifecycle 的授权撤销回调。
 *
 * 锁定与重置都必须先走这里：把授权、任务和 Connect 运行绑定一起撤销，
 * 让已经拿到句柄的迟到写入在任何数据检查之前就被拒绝。
 */
function revokeWalletGrants(reason: "lock" | "reset"): void {
  vaultWorkerKeys.activeKeyBackend = undefined;
  const hardwareCleanup = vaultWorkerKeys.hardwareConnections.close();
  walletRevocationCleanup?.push(hardwareCleanup);
  void hardwareCleanup.catch(() => undefined);
  vaultWorkerKeys.walletPayments?.close(); vaultWorkerKeys.walletPayments = undefined; vaultWorkerKeys.walletPaymentsOpening = undefined;
  storageWorkerRequests.revokeStorageSessionGrants();
  releaseMsfileRuntime(reason);
  // 授权已经撤销，不能让退出依赖旧存储句柄写入或旧身份签名。
  // 本地关闭连接并停止重试；远端订阅由下次启动的历史订阅查询对账。
  const satCleanup = releaseSatRuntime(reason);
  walletRevocationCleanup?.push(satCleanup);
  void satCleanup.catch(() => undefined);
  windowP2pWorkerRuntime.clearWindowP2pExecutorLeaseLocked();
  stopCoordinatorOwnerWorkerUnits();
}

/** 建立新会话的运行绑定；Coordinator 侧 grant 与存储绑定都读这几个字段。 */
function establishWalletSession(input: {
  sessionEpoch: string;
  walletGeneration: string;
  publicKeyHex: string;
}): void {
  if (walletLockBarrier.snapshot()) throw new Error("Wallet cleanup has not completed");
  coordinatorState.walletGeneration = input.walletGeneration;
  coordinatorState.sessionEpoch = input.sessionEpoch;
  coordinatorState.activePublicKeyHex = input.publicKeyHex;
}

async function handleLock(
  requestId: string,
  request: Extract<CoordinatorClientRequest, { kind: "lock" }>,
  peerId: string,
): Promise<CoordinatorResponse> {
  if (request.cleanup?.action === "register") walletLockBarrier.register(peerId);
  else if (request.cleanup?.action === "settled") walletLockBarrier.report(peerId, request.expectedSessionEpoch, request.cleanup.attempt, request.cleanup.error);
  else void performGlobalLock("manual").catch(error => console.error("[wallet] lock cleanup failed", error));
  return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "accepted" } };
}

/**
 * 锁定：先撤销授权，再清空内存身份。
 *
 * 不再有任何跨浏览器 Key 锁、lock.json 租约或持久化心跳：本地钱包只保证
 * 本浏览器本 Origin 的单实例，锁定是完全的内存态迁移。
 */
function performGlobalLock(reason: string): Promise<void> {
  if (globalLockRunning && walletLockBarrier.snapshot()?.phase !== "failed") return globalLockRunning;
  if (walletLockBarrier.snapshot()) return walletLockBarrier.retry();
  const backgroundCompletions = backgroundWorkerRuntime.completions();
  const previousOwnerUnits = new Set(COORDINATOR_WORKER_UNIT_CATALOG.filter(unit => unit.scopeKind === "owner-session").map(unit => unit.unitId));
  // Only the security commit precedes the lock event. A new epoch fences old
  // RPC/I/O immediately and clearing the key prevents signing. Plugin teardown,
  // abort callbacks, connection shutdown and directory updates run AFTER it.
  coordinatorState.sessionEpoch = generateEpoch();
  coordinatorState.vaultStatus = "locked";
  coordinatorState.activePublicKeyHex = undefined;
  vaultWorkerKeys.dropActivePrivateKey(); vaultWorkerKeys.setCoordinatorActiveKeySummary(undefined);
  testHarnessActivationSecret = undefined;
  coordinatorState.autoLockDeadline = undefined;
  lockRevocationPending = true;

  let revokePending: Promise<Promise<void>[]> | undefined;
  const revoke = (): Promise<Promise<void>[]> => {
    if (revokePending) return revokePending;
    const run = Promise.resolve().then(() => {
      cancelSmartSyncIdleTimer(); vaultAutoLock.pause();
      backgroundWorkerRuntime.block("Vault is locked");
      walletRevocationCleanup = [];
      try {
        revokeWalletGrants("lock"); storageWorkerRequests.storageBrowseCoordinator.revokeAll();
        workerStorageClients.invalidateAll(); stopCoordinatorOwnerWorkerUnits();
        closeCoordinatorUpgradeSession(`Coordinator locked: ${reason}`);
        reconcileCoordinatorSessionExposures();
        lockRevocationPending = false;
        workerWalletState.publish(); publishCoordinatorContactsPresence();
        return walletRevocationCleanup;
      } finally { walletRevocationCleanup = undefined; }
    }).catch(error => { revokePending = undefined; throw error; });
    revokePending = run;
    return run;
  };
  let firstConnectionCleanup = true;
  const operations = [
    {
      label: "钱包连接", run: async () => {
        const revocations = await revoke();
        if (firstConnectionCleanup) {
          firstConnectionCleanup = false;
          // The first rejection must reach the UI. Do not silently repeat it
          // before recording the failure; retries come from the user's button.
          await Promise.all(revocations);
        }
        await vaultWorkerKeys.hardwareConnections.close(); await satWorkerLifecycle.retryCleanup();
      }
    },
    {
      label: "后台插件", run: async () => {
        await revoke();
        if (coordinatorRuntimeApp) {
          await coordinatorRuntimeApp.reconcile();
          for (const state of coordinatorRuntimeApp.inspect().plugins.filter(plugin => plugin.units.some(unit => previousOwnerUnits.has(unit.unitId)))) {
            if (state.cleanup?.cleanupIncomplete || state.kind === "stopping" || state.kind === "cleanup-pending") throw new Error(`${state.id}: ${state.error ?? "清理未完成"}\n${JSON.stringify(state.cleanup, null, 2)}`);
          }
          synchronizeCoordinatorTaskUnitInstances();
        }
      }
    },
    { label: "钱包生命周期", run: async () => { await revoke(); if (vaultWalletWorker.walletLifecycle) await vaultWalletWorker.walletLifecycle.lock(); } },
    { label: "后台任务", run: async () => { await revoke(); await Promise.allSettled(backgroundCompletions); } },
  ];
  const running = walletLockBarrier.begin(coordinatorState.sessionEpoch, operations).finally(() => {
    if (globalLockRunning === running) globalLockRunning = undefined;
    emitMsFileState(); emitStorageState();
    publishTopicEvent("background.snapshot", { type: "background.snapshot.changed", sessionEpoch: coordinatorState.sessionEpoch, snapshots: getTaskSnapshots() });
  });
  globalLockRunning = running;
  return running;
}

// ============================================================
// 8. Crypto Operations
// ============================================================

// ============================================================
// 9. Background Operations
// ============================================================

// ============================================================
// 10. Ordinary P2PKH data-source selection and transaction broadcast RPC
// ============================================================

/** 当前 owner 的 p2pkh setting.json 是否已载入运行时镜像。 */

let testFailNextP2pkhSettingWrite = false;

function p2pkhSettingRepository(): ReturnType<typeof createP2pkhFileRepository> {
  return createP2pkhFileRepository(createWorkerModuleFileStore("p2pkh", ""));
}

const p2pkhWorkerSettings = createWorkerP2pkhSettings({
  admission: { available: isCoordinatorProductRegistered, blocked: coordinatorProductBlockedResponse },
  network: () => vaultWorkerKeys.requireCoordinatorNetworkIdentity().bsvNetwork,
  storage: () => createWorkerModuleFileStore("p2pkh", ""),
  session: () => ({ sessionEpoch: coordinatorState.sessionEpoch, activePublicKeyHex: coordinatorState.activePublicKeyHex }),
  projection: coordinatorMeta,
  beforeWrite: () => {
    if (testFailNextP2pkhSettingWrite) {
      testFailNextP2pkhSettingWrite = false;
      throw new StorageRuntimeError("storage_provider_error", "injected P2PKH setting write failure");
    }
  },
  clearSnapshots: () => p2pkhWorkerRuntime.snapshots()?.clearAll(),
  reschedule: () => cancelP2pkhSyncForProviderChange(),
  taskSnapshots: getTaskSnapshots,
  publishSnapshot: (event) => { publishTopicEvent("background.snapshot", event); },
  woc: () => testDomainUnitReadiness ? p2pkhWocService : p2pkhWorkerRuntime.query(),
});
const loadP2pkhSettingForOwner = p2pkhWorkerSettings.load;
const resetP2pkhSettingsRuntime = p2pkhWorkerSettings.reset;

/** Resource tables are keyed by the borrowed store object. All production
 * snapshot paths must use the same handle owned by the current P2PKH unit;
 * a second handle to the same files has an empty, separate resource table. */
function currentP2pkhDomainStorage(): BorrowedModuleFileStore {
  if (testDomainUnitReadiness) return createWorkerModuleFileStore("p2pkh", "");
  if (!p2pkhWorkerRuntime.binding()) throw new Error("P2PKH Worker instance is unavailable");
  p2pkhWorkerRuntime.binding()!.assertActive();
  return p2pkhWorkerRuntime.binding()!.storage;
}

const p2pkhWorkerOperations = createP2pkhWorkerOperations({
  domain: p2pkhWorkerRuntime, walletState: workerWalletState,
  network: () => coordinatorMeta.p2pkhSettings.bsvNetwork,
  storage: currentP2pkhDomainStorage,
  available: () => isCoordinatorProductRegistered("p2pkh"),
  blocked: requestId => coordinatorProductBlockedResponse(requestId, "p2pkh"),
  provider: () => testP2pkhBroadcastProvider,
  broadcastLease: execute => withCoordinatorFinalIoLease("write", undefined, execute, { auditOperation: "p2pkh.broadcast" }),
  funding: {
    reconcile: (input, snapshot) => reconcileMsfileBitfsFundingInputs(input.ownerPublicKeyHex, input.network, snapshot),
    filter: (input, snapshot) => filterP2pkhSnapshotByBitfsFunds(input.ownerPublicKeyHex, input.network, snapshot),
    protected: input => currentMsfileBitfsFundingLedger().listProtectedOutpoints(input),
  },
  changed: event => { publishTopicEvent("asset.data-changed", event); },
});
function ensureWorkerP2pkhResources(owner: string, network: "main" | "test") { return p2pkhWorkerOperations.ensureResources(owner, network); }
async function refreshP2pkhUtxoSnapshots(signal?: AbortSignal, storage = currentP2pkhDomainStorage(), assertActive: () => void = () => undefined) {
  return p2pkhWorkerOperations.refresh(signal, storage, assertActive);
}

function cancelP2pkhSyncForProviderChange() { return backgroundWorkerRuntime.restartTasks(["p2pkh.transactions-sync", "p2pkh.utxo-snapshot"], "provider-change"); }

async function handleP2pkhSettingsUpdate(requestId: string, request: Extract<CoordinatorClientRequest, { kind: "p2pkh.settings.update" }>): Promise<CoordinatorResponse> {
  if (!isCoordinatorProductRegistered("p2pkh")) return coordinatorProductBlockedResponse(requestId, "p2pkh");
  return p2pkhWorkerSettings.update(requestId, request);
}
async function handleP2pkhProviderConfigGet(requestId: string, request: Extract<CoordinatorClientRequest, { kind: "p2pkh.provider-config.get" }>): Promise<CoordinatorResponse> {
  if (!isCoordinatorProductRegistered("woc")) return coordinatorProductBlockedResponse(requestId, "woc");
  return p2pkhWorkerSettings.getProviderConfig(requestId, request);
}
async function handleP2pkhProviderConfigUpdate(requestId: string, request: Extract<CoordinatorClientRequest, { kind: "p2pkh.provider-config.update" }>): Promise<CoordinatorResponse> {
  if (!isCoordinatorProductRegistered("woc")) return coordinatorProductBlockedResponse(requestId, "woc");
  return p2pkhWorkerSettings.updateProviderConfig(requestId, request);
}

/** 读取 owner + network 对应的 P2PKH resource（不存在返回 undefined）。 */
async function executeP2pkhSnapshot(requestId: string, request: { ownerPublicKeyHex: string; network: "main" | "test" }, refresh: boolean) {
  return p2pkhWorkerOperations.snapshot(requestId, request, refresh);
}
const handleP2pkhUtxosGet = (requestId: string, request: Extract<CoordinatorClientRequest, { kind: "p2pkh.utxos.get" }>) => p2pkhWorkerOperations.snapshot(requestId, request, false);
const handleP2pkhUtxosRefresh = (requestId: string, request: Extract<CoordinatorClientRequest, { kind: "p2pkh.utxos.refresh" }>) => p2pkhWorkerOperations.snapshot(requestId, request, true);
const listWorkerProtocolProtection = p2pkhWorkerOperations.protocolProtection;
const handleP2pkhBroadcast = p2pkhWorkerOperations.broadcast;

// ============================================================
// 11. Task Execution
// ============================================================

// ============================================================
// 11. Snapshot & Broadcasting
// ============================================================

function coordinatorStorageIoOwnerPeerSnapshot(): CoordinatorBootstrapSnapshot["storageIoOwnerPeer"] {
  if (!storageIoOwner) return undefined;
  const state = coordinatorPeerState(storageIoOwner.peerId);
  const endpoint = state?.peer as PeerController & CoordinatorPeerEndpointInfo;
  // 只报告当前仍 active 的物理 endpoint；closing/revoked peer 不得被
  // 页面误认为可以继续承载 owner I/O。
  if (!state || endpoint.endpointState !== "active" || state.peer.scope.state !== "active"
    || !state.sessionOpen || state.status !== "open" || !sameCoordinatorSessionBinding(state.sessionBinding, storageIoOwner)) {
    return undefined;
  }
  if (!endpoint.binding) return undefined;
  return {
    peerId: state.peer.peerId,
    binding: { ...endpoint.binding },
    handoffRevision: storageIoOwner.commitOrder,
  };
}

function buildSnapshot(): CoordinatorBootstrapSnapshot {
  const storageIoOwnerPeer = coordinatorStorageIoOwnerPeerSnapshot();
  return {
    authorityInstanceId: coordinatorAuthority.coordinatorAuthorityInstanceId,
    runGeneration: coordinatorState.runGeneration,
    buildId: COORDINATOR_BUILD_ID,
    sessionEpoch: coordinatorState.sessionEpoch,
    vaultStatus: coordinatorState.vaultStatus,
    lockCleanup: walletLockBarrier.snapshot(),
    activePublicKeyHex: coordinatorState.vaultStatus === "unlocked" ? coordinatorState.activePublicKeyHex : undefined,
    ...(coordinatorState.vaultStatus === "unlocked" ? { activeKeyIdentity: vaultWorkerKeys.coordinatorActiveKeySummary() } : {}),
    // 钱包身份世代：单 Key 模型下没有 selectedPublicKeyHex（没有可切换的
    // Key），页面只用它判断重置/重新初始化后旧授权是否已经失效。
    walletGeneration: coordinatorState.walletGeneration || undefined,
    ...(coordinatorAuthority.coordinatorAuthorityRecovery ? { authorityRecovery: coordinatorAuthority.coordinatorAuthorityRecovery } : {}),
    coordinatorWorkerUnits: coordinatorRuntimeUnitSnapshots(),
    coordinatorWorkerUnitSnapshotRevision: coordinatorRuntimeUnitRevision(),
    taskSnapshots: getTaskSnapshots(),
    scheduleSettings: coordinatorState.scheduleSettings,
    autoLockTimeoutMs: coordinatorMeta.autoLockTimeoutMs ?? AUTO_LOCK_DEFAULT_TIMEOUT_MS,
    p2pkhSettings: coordinatorMeta.p2pkhSettings,
    ...(storageIoOwnerPeer ? { storageIoOwnerPeer } : {}),
  };
}

/** Display projection must not re-enter an owner capability after its Scope stops.
 * In-flight tasks remain registered until settlement to fence the next installation.
 */

/**
 * Worker 内的 UTXO 序号通知。
 *
 * 中文：topic stream 只发给页面 peer；Worker 内部的重试方（SatSubscription
 * 的中心广播服务）需要一个同进程的唤醒源，避免等退避到点再出网探测。
 * 只传序号，不传快照内容，语义与页面的 `asset.data-changed.utxoSeqs` 一致。
 */

function publishTopicEvent(topic: CoordinatorTopic, event: any): CoordinatorTopicEvent {
  const normalized = {
    ...event,
    ...(vaultWorkerKeys.coordinatorActiveKeySummary() ? { networkIdentity: { bsvNetwork: vaultWorkerKeys.coordinatorActiveKeySummary()!.bsvNetwork, publicKeyHex: vaultWorkerKeys.coordinatorActiveKeySummary()!.publicKeyHex } } : {}),
    topic,
    ...(topic === "session.state" ? { sessionRevision: ++sessionRevision } : topic === "background.snapshot" ? { backgroundSnapshotRevision: ++backgroundSnapshotRevision } : topic === "chain.height" ? { chainHeightRevision: ++chainHeightRevision } : topic === "storage.state" ? { storageRevision: event.storageRevision } : topic === "msfile.state" ? { msfileRevision: event.msfileRevision } : topic === "sat.events" ? { satRevision: event.satRevision } : topic === "channel.events" ? { channelRevision: ++channelRevision } : topic === "contacts.presence" ? { presenceRevision: ++contactsPresenceRevision } : topic === "worker.units" ? { workerUnitRevision: event.workerUnitRevision ?? coordinatorRuntimeUnitRevision() } : { assetDataRevision: ++assetDataRevision }),
    sessionEpoch: coordinatorState.sessionEpoch,
    ...(topic === "background.snapshot"
      ? {
        scheduleSettings: coordinatorState.scheduleSettings,
        // 所有 background 快照都带当前设置，保证新订阅者和跨 tab 更新使用同一份值。
        p2pkhSettings: coordinatorMeta.p2pkhSettings,
      }
      : {})
  } as CoordinatorTopicEvent;
  // Worker 内唤醒源：带 utxoSeqs 的快照事件同时通知同进程的重试方。
  if (topic === "asset.data-changed") {
    const assetEvent = normalized as CoordinatorTopicEvent & Pick<AssetDataChangedEvent, "publicKeyHex" | "utxoSeqs">;
    if (typeof assetEvent.publicKeyHex === "string" && assetEvent.utxoSeqs) {
      for (const network of ["main", "test"] as const) {
        const seq = assetEvent.utxoSeqs[network];
        if (typeof seq === "number") {
          p2pkhWorkerRuntime.publishUtxoSeq({ ownerPublicKeyHex: assetEvent.publicKeyHex, network, seq });
        }
      }
    }
  }
  // WebLoom owns the physical stream credit; each Coordinator peer only gets
  // a bounded domain queue. A slow peer therefore terminates its own stream
  // with stream_overflow instead of backpressuring unrelated pages or dropping
  // events silently.
  for (const state of coordinatorPeers.values()) {
    if (state.topicStream) enqueueCoordinatorTopicEvent(state.topicStream, normalized);
  }
  // This collection is populated only by explicit unit-test seams. It is not
  // a second runtime transport or a production connection registry.
  for (const sink of coordinatorTestEventSinks.values()) {
    if (sink.topics.has(topic)) {
      try { sink.postMessage(normalized); } catch { /* test sink may be closed */ }
    }
  }
  return normalized;
}

// ============================================================
// 12. Auto-lock Timer
// ============================================================

// ============================================================
// 13. Worker Entry Point
// ============================================================

const { owner: handleCoordinatorOwnerStorageRpc, platform: handleCoordinatorPlatformStorageRpc } = createStorageRpcHandlers({
  authorize: call => requireCoordinatorSessionPeer(call).peer.peerId,
  unavailable: storageUnavailableError,
  owner: storageWorkerRequests.executeOwnerStorageData,
  platform: storageWorkerRequests.executePlatformStorageData,
});
const vaultWorkerRuntime = createVaultWorkerRuntime({
  walletControl: vaultWorkerOperations.walletControl,
  walletState: workerWalletState,
  isIssued: (consumer, scope) => workerConsumers.get(consumer) === scope,
  activeCrypto: async (owner, scope) => vaultWorkerKeys.createWorkerActiveKeyCrypto(owner, scope),
  cryptoRpc: {
    authorize: call => { requireCoordinatorSessionPeer(call); },
    identity: () => ({ unlocked: coordinatorState.vaultStatus === "unlocked", publicKeyHex: coordinatorState.activePublicKeyHex, sessionEpoch: coordinatorState.sessionEpoch }),
    keySession: { hasKey: vaultWorkerKeys.hasActiveWalletCrypto, execute: vaultWorkerKeys.executeActiveWalletCrypto },
    withIoLease: (signal, execute) => withCoordinatorFinalIoLease("write", signal, execute, {
      auditOperation: "service.crypto.sign",
      durableLease: false,
    }),
  },
});

/** 将领域响应收窄为 typed RPC 的 response DTO；transport requestId 只由框架 callId 承担。 */
function coordinatorRpcResponse(request: CoordinatorRpcRequest, response: CoordinatorResponse | CoordinatorRpcResponse): CoordinatorRpcResponse {
  const result = "requestId" in response
    ? (({ requestId: _requestId, ...withoutRequestId }) => withoutRequestId)(response)
    : response;
  // Capability response parser only validates the common envelope. The
  // request-aware pass below owns nested operation/control/data result
  // selection and the strict ack/presence rules.
  return parseCoordinatorResponseFor(request, result);
}

function coordinatorRequestFromRpc(
  request: CoordinatorRpcCommandRequest,
  call: HandlerCallContext,
): CoordinatorClientRequest {
  const peerId = call.peer?.peerId;
  if (!peerId) throw Object.assign(new Error("Coordinator RPC has no bound peer"), { code: "transport_disconnected" });
  return coordinatorClientRequestFromRpc(request, peerId, call.operationId ?? generateRequestId());
}

function coordinatorSessionClosed(peerId: string, binding: CoordinatorSessionBinding): void {
  const state = coordinatorPeerState(peerId);
  if (!state) return;
  // The complete binding is an exact-match fence. A late close from an older
  // lease must not revoke a newer open on the same physical peer.
  fenceCoordinatorPeerSession(state, { physical: false, binding });
}

const COORDINATOR_SESSION_EXPOSURES = [
  STORAGE_PRIVATE_BROWSE_CAPABILITY,
  COORDINATOR_OWNER_STORAGE_RPC_CAPABILITY,
  COORDINATOR_PLATFORM_STORAGE_RPC_CAPABILITY,
  COORDINATOR_CRYPTO_RPC_CAPABILITY,
] as const;

/** 当前 owner/session 世代中可向 Window 暴露的 Coordinator 服务。 */
function coordinatorSessionServicesReady(): boolean {
  return coordinatorState.vaultStatus === "unlocked"
    && Boolean(coordinatorState.activePublicKeyHex && vaultWorkerKeys.hasActiveWalletCrypto())
    && Boolean(storageWorkerRoot.root && storageWorkerRoot.token)
    && storageWorkerRoot.ready
    && !storageWorkerRoot.failed;
}

function coordinatorSessionExposureIdentity(): string {
  // 服务暴露的身份由运行代次、会话世代和钱包身份世代决定；单 Key 模型下
  // 不再有桶身份，也不再有「切换 Key」这件事需要额外参与判定。
  return [
    coordinatorAuthority.coordinatorAuthorityInstanceId,
    coordinatorAuthority.coordinatorHandoverGeneration,
    coordinatorState.sessionEpoch,
    coordinatorState.runGeneration,
    coordinatorState.walletGeneration,
  ].join("\u0000");
}

function coordinatorSessionGrantId(state: CoordinatorPeerState, capabilityId: string): string {
  return `coordinator-session-grant:${state.peer.peerId}:${state.sessionGeneration}:${capabilityId}:${randomIdentifierSuffix()}`;
}

/**
 * 将当前 owner/session 世代投影到真实 WebLoom exposure。
 *
 * 暴露 reference 的 serviceInstanceId/grantId 由 WebLoom 生成并绑定到
 * 当前 group；owner 锁定、换 Key、Storage Root 重绑时先撤销旧 group，
 * 下一次 ready 才建立新 group。这样旧 proxy 即使仍在页面中也不能跨越
 * session epoch 或 walletState generation。
 */
function reconcileCoordinatorSessionExposure(state: CoordinatorPeerState): void {
  const ready = state.sessionOpen
    && state.status === "open"
    && state.peer.scope.state === "active"
    && coordinatorSessionServicesReady();
  const identity = ready ? coordinatorSessionExposureIdentity() : undefined;
  if (state.serviceExposure && state.serviceExposureIdentity === identity) return;

  state.serviceExposure?.revoke();
  state.serviceExposure = undefined;
  state.serviceExposureIdentity = undefined;
  if (!identity) return;

  try {
    state.serviceExposure = state.peer.exposeGroup(COORDINATOR_SESSION_EXPOSURES.map((capability) => ({
      capability,
      options: capability === STORAGE_PRIVATE_BROWSE_CAPABILITY
        ? {} // 私有票据由框架按连接与消费实例签发，不使用公共会话 grant。
        : { grantId: coordinatorSessionGrantId(state, capability.id) },
    })));
    state.serviceExposureIdentity = identity;
  } catch (error) {
    // 只有已确认的 endpoint/scope close race 可以收口；active peer 上的
    // 配置、allowlist、协议或目录错误必须进入结构化失败通道，不能让
    // Coordinator 看起来 ready 却静默缺失服务。
    const endpointState = (state.peer as PeerController & CoordinatorPeerEndpointInfo).endpointState;
    const endpointClosing = endpointState !== undefined && endpointState !== "active"
      || state.peer.scope.state !== "active";
    state.serviceExposure = undefined;
    state.serviceExposureIdentity = undefined;
    if (endpointClosing) return;
    const code = "coordinator_session_exposure_failed";
    const message = error instanceof Error ? error.message : "Coordinator service exposure failed";
    console.error("[coordinator] session exposure failed", {
      code,
      peerId: state.peer.peerId,
      endpointState,
      scopeState: state.peer.scope.state,
      message,
    });
    throw Object.assign(new Error("Coordinator session service exposure failed"), { code });
  }
}

/** Forum has its own exposure group: enabling it must not rotate storage/crypto grants. */
function reconcileForumSessionExposure(state: CoordinatorPeerState): void {
  const forum = coordinatorRuntimeApp?.state().units.find(unit => unit.unitId === "forum.coordinator-worker" && unit.state === "enabled");
  const identity = state.sessionOpen && state.status === "open" && state.peer.scope.state === "active"
    && coordinatorSessionServicesReady() && forum?.instanceId
    ? `${coordinatorSessionExposureIdentity()}\u0000${forum.instanceId}` : undefined;
  if (state.forumExposure && state.forumExposureIdentity === identity) return;
  state.forumExposure?.revoke();
  state.forumExposure = undefined;
  state.forumExposureIdentity = undefined;
  if (!identity) return;
  state.forumExposure = state.peer.exposeGroup([FORUM_WORKER_SERVICE_CAPABILITY, FORUM_WORKER_ATTACHMENT_CAPABILITY].map(capability => ({
    capability, options: { grantId: coordinatorSessionGrantId(state, capability.id) },
  })));
  state.forumExposureIdentity = identity;
}

function reconcileCoordinatorSessionExposures(): void {
  for (const state of coordinatorPeers.values()) {
    reconcileCoordinatorSessionExposure(state);
    reconcileForumSessionExposure(state);
  }
}

async function openCoordinatorSession(
  state: CoordinatorPeerState,
  request: CoordinatorSessionOpenRequest,
  call: HandlerCallContext,
): Promise<CoordinatorRpcResponse> {
  // The generation is the freshness baseline for this queued open. It may
  // legitimately move when this same physical peer replaces an old lease;
  // in that branch the fence below explicitly establishes the new baseline.
  // Two concurrent opens otherwise serialize on the same peer operation tail.
  // must serialize into one session: the second one observes the committed
  // session and returns its snapshot instead of invalidating the first open.
  // A close/revoke meanwhile advances the generation and makes both queued
  // stale attempts fail closed.
  let expectedGeneration = state.sessionGeneration;
  const peerId = state.peer.peerId;
  return enqueueCoordinatorPeerSessionOperation(state, async () => {
    if (state.sessionOpen && state.status === "open"
      && state.sessionBinding?.leaseId === request.leaseId) {
      return Promise.resolve({
        sessionEpoch: coordinatorState.sessionEpoch,
        ack: { status: "ok" as const },
        operationResult: { ...buildSnapshot(), sessionBinding: state.sessionBinding },
      });
    }
    if (state.sessionOpen) {
      // A reconnect on the same Runtime may receive a fresh page lease. Fence
      // the old lease before replacing it; its late bridge result cannot be
      // admitted into the new session.
      const fenced = fenceCoordinatorPeerSession(state, { physical: false, binding: state.sessionBinding });
      if (!fenced) throw coordinatorSessionStaleError("Coordinator session replacement became stale");
      // The fence synchronously increments the generation. Record that
      // post-fence value before waiting for asynchronous bridge drain.
      expectedGeneration = state.sessionGeneration;
      if (state.drainPromise) await state.drainPromise;
      if (state.sessionGeneration !== expectedGeneration || state.status === "revoked") {
        throw coordinatorSessionStaleError("Coordinator session replacement became stale");
      }
    }
    if (state.sessionGeneration !== expectedGeneration) throw coordinatorSessionStaleError();
    const generation = expectedGeneration + 1;
    state.sessionGeneration = generation;
    state.status = "active";
    const attempt: CoordinatorSessionOpenAttempt = {
      state,
      peerId,
      generation,
      signal: call.signal,
      binding: {
        peerGeneration: generation,
        sessionEpoch: coordinatorState.sessionEpoch,
        leaseId: request.leaseId,
      },
    };
    return enqueueCoordinatorSessionInitialization(async () => {
      assertCoordinatorSessionOpenFresh(attempt);
      coordinatorOpeningSession = attempt;
      try {
        // The two awaits below are deliberately followed by the same freshness
        // check. Their results are temporary until the final synchronous
        // exposure commit succeeds.
        assertCoordinatorSessionOpenFresh(attempt);
        await startCoordinatorInitialization(undefined, attempt.peerId);
        assertCoordinatorSessionOpenFresh(attempt);

        // No await is allowed between this check and exposeGroup. The group
        // publish is itself transactional; sessionOpen and physical I/O owner
        // become visible only after it has committed successfully.
        const serviceExposure = coordinatorSessionServicesReady()
          ? state.peer.exposeGroup(COORDINATOR_SESSION_EXPOSURES.map((capability) => ({
            capability,
            options: capability === STORAGE_PRIVATE_BROWSE_CAPABILITY
              ? {} // 私有票据由框架按连接与消费实例签发，不使用公共会话 grant。
              : { grantId: coordinatorSessionGrantId(state, capability.id) },
          })))
          : undefined;
        state.serviceExposure = serviceExposure;
        state.serviceExposureIdentity = serviceExposure ? coordinatorSessionExposureIdentity() : undefined;
        state.sessionBinding = { ...attempt.binding };
        state.sessionOpen = true;
        state.status = "open";
        reconcileForumSessionExposure(state);
        state.openCommitOrder = ++coordinatorSessionCommitOrder;
        // session.open 的 exposeGroup 已经提交，证明这个 peer 的反向
        // LocalStorage capability 可用。刷新时旧文档可能来不及把物理断线送达
        // SharedWorker；若继续保留旧 peer，后续 hydrate 会请求一个永不响应的
        // realm。这里切换的是“未来请求”的目标；既有请求已捕获旧 peer，并由
        // 各自 Scope/AbortSignal 收口。所有页面共享同源 localStorage，写入仍由
        // Provider 的事务/CAS 边界串行，不会绕过存储并发边界。
        storageIoOwner = {
          ...attempt.binding,
          peerId: attempt.peerId,
          commitOrder: ++coordinatorStorageIoHandoffRevision,
        };
        notifyCoordinatorStorageIoHandoff(storageIoOwner);
        return {
          sessionEpoch: coordinatorState.sessionEpoch,
          ack: { status: "ok" },
          operationResult: { ...buildSnapshot(), sessionBinding: state.sessionBinding },
        };
      } catch (error) {
        // Never revoke/clear a newer session from a stale open. A failed first
        // open has not changed sessionOpen or storageIoOwner, so there is no
        // local temporary assignment left to undo.
        if (!state.sessionOpen && state.sessionBinding?.leaseId === attempt.binding.leaseId) {
          state.sessionBinding = undefined;
          state.status = "active";
          state.openCommitOrder = undefined;
        }
        throw error;
      } finally {
        if (coordinatorOpeningSession === attempt) coordinatorOpeningSession = undefined;
      }
    });
  });
}

async function handleCoordinatorRpc(
  request: CoordinatorRpcRequest,
  call: HandlerCallContext,
): Promise<CoordinatorRpcResponse> {
  const state = requireCoordinatorPeer(call);
  const peerId = state.peer.peerId;
  if (request.kind === "session.open") {
    return coordinatorRpcResponse(request, await openCoordinatorSession(state, request, call));
  }
  if (request.kind === "session.close") {
    coordinatorSessionClosed(peerId, {
      peerGeneration: request.peerGeneration,
      sessionEpoch: request.sessionEpoch,
      leaseId: request.leaseId,
    });
    return coordinatorRpcResponse(request, { sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" } });
  }
  if (request.kind === "session.activity") {
    handleActivity();
    return coordinatorRpcResponse(request, { sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" } });
  }

  const fullRequest = coordinatorRequestFromRpc(request as CoordinatorRpcCommandRequest, call);
  const response = await processRequest(fullRequest, peerId, call.signal);
  return coordinatorRpcResponse(request, response);
}

function coordinatorTopicStream(
  request: CoordinatorTopicSubscription,
  call: HandlerCallContext,
): AsyncIterable<CoordinatorTopicEvent> {
  const state = requireCoordinatorPeer(call);
  const previous = state.topicStream;
  if (previous) closeCoordinatorTopicStreamQueue(previous, new Error("Coordinator topic subscription replaced"));
  const queue = createCoordinatorTopicStreamQueue(state.peer.peerId, request.topics);
  state.topicStream = queue;
  const onAbort = (): void => closeCoordinatorTopicStreamQueue(queue, new Error("Coordinator topic subscription cancelled"));
  call.signal.addEventListener("abort", onAbort, { once: true });

  return (async function* stream(): AsyncIterable<CoordinatorTopicEvent> {
    try {
      // Register the queue before awaiting the baseline so no live event can
      // pass between snapshot construction and stream readiness.
      const baselines = await buildTopicBaselines(request);
      for (const baseline of baselines) {
        if (call.signal.aborted) throw new Error("Coordinator topic subscription cancelled");
        yield baseline.snapshot as CoordinatorTopicEvent;
      }
      while (!call.signal.aborted) {
        const next = await takeCoordinatorTopicEvent(queue);
        if (next.done) return;
        yield next.value;
      }
    } catch (error) {
      console.warn("[coordinator] Topic stream stopped", error instanceof Error ? error.message : "unknown stream error");
      throw error;
    } finally {
      call.signal.removeEventListener("abort", onAbort);
      if (state.topicStream === queue) state.topicStream = undefined;
      closeCoordinatorTopicStreamQueue(queue);
    }
  })();
}

function configureCoordinatorPeer(peer: PeerController): void {
  const state: CoordinatorPeerState = {
    peer,
    lastSeenAt: Date.now(),
    status: "active",
    sessionOpen: false,
    sessionGeneration: 0,
    sessionOperationTail: Promise.resolve(),
    bridgeRequests: new Set(),
  };
  coordinatorPeers.set(peer.peerId, state);
  // Scope revocation is the synchronous admission fence. Async resource
  // disposal happens after this callback; no late call may create grants or
  // select this peer for physical Local I/O.
  peer.scope.onRevoke(() => {
    if (coordinatorPeers.get(peer.peerId) !== state) return;
    void vaultWorkerKeys.hardwareConnections.closePeer(peer.peerId);
    revokedCoordinatorPeerIds.add(peer.peerId);
    fenceCoordinatorPeerSession(state, { physical: true });
  });
}

/** Worker transport plugin：所有跨 realm 命令只从这里进入领域代码。 */
const coordinatorTransportPlugin = definePlugin({
  id: "keymaster.coordinator.transport",
  name: "Keymaster Coordinator transport",
  runtime: "shared-worker",
  unitId: "keymaster.coordinator.transport",
  provides: [
    COORDINATOR_RPC_CAPABILITY,
    COORDINATOR_TOPIC_STREAM_CAPABILITY,
  ] as const,
  dependencies: [{ capability: VAULT_WORKER_WALLET_CONTROL_CAPABILITY, sourceRuntime: "shared-worker", reason: "钱包控制面通过声明能力调用 Vault" }],
  setup(context) {
    workerConsumers.set(context.consumer, context.scope);
    coordinatorWalletControl = context.capability(VAULT_WORKER_WALLET_CONTROL_CAPABILITY).bind(context.consumer, context.scope);
    context.scope.onRevoke(() => { coordinatorWalletControl = undefined; workerConsumers.delete(context.consumer); });
    context.handle(COORDINATOR_RPC_CAPABILITY, (request, call) => handleCoordinatorRpc(request, call));
    context.handle(COORDINATOR_TOPIC_STREAM_CAPABILITY, (request, call) => coordinatorTopicStream(request, call));
  },
});

/** 公共层只绑定消费者和运行态观察，不参与插件业务 setup。 */
function withCoordinatorWorkerLifecycle(plugin: ReturnType<typeof definePlugin>) {
  return {
    ...plugin, async setup(context: import("webloom-framework").PluginContext) {
      const unitId = plugin.descriptor.id;
      const instance = activateCoordinatorWorkerUnitForRuntime(unitId, context.instanceId);
      workerConsumers.set(context.consumer, context.scope);
      context.scope.onRevoke(() => {
        workerConsumers.delete(context.consumer);
        stopCoordinatorWorkerUnit(unitId, context.instanceId);
      });
      try {
        const teardown = await plugin.setup(context);
        context.scope.assertActive();
        coordinatorWorkerUnitRegistry.ready(instance.unitId, instance.instanceId);
        return async () => { await teardown?.(); };
      } catch (error) {
        coordinatorWorkerUnitRegistry.fail(unitId, context.instanceId, error);
        throw error;
      }
    }
  };
}
const workerAssetEvents = {
  tasks: coordinatorTaskRegistrar,
  emit(event: AssetDataInvalidationEvent) {
    publishTopicEvent("asset.data-changed", { type: "asset.data-changed", providerId: event.providerId, publicKeyHex: event.publicKeyHex ?? "", kinds: event.kinds });
  },
};
const coordinatorRequestRoutes = new Map<string, import("@keymaster/contracts").WorkerRequestRoute>();
for (const route of [vaultWorkerOperations.route, vaultAutoLock.route, storageWorkerRequests.route, msfileWorkerRequests.route, windowP2pWorkerRuntime.route, channelWorkerRuntime.route, p2pkhWorkerOperations.route, p2pkhWorkerSettings.route, contactsPresenceProjection.route, backgroundWorkerRuntime.route,
defineWorkerRequestRoute<Extract<CoordinatorClientRequest, { kind: "lock" }>>({
  kinds: ["lock"], policy: () => ({ scheduling: "parallel", cleanupOnly: true, validateEpoch: false }), execute: (request, call) => handleLock(call.requestId, request, call.peerId),
}),
]) for (const kind of route.kinds) {
  if (coordinatorRequestRoutes.has(kind)) throw new Error("Duplicate Worker request owner: " + kind);
  coordinatorRequestRoutes.set(kind, route);
}

const coordinatorRuntimePlugins = [
  vaultWorkerRuntime.plugin,
  createStorageWorkerPlugin({
    files: workerStorageClientCapabilities[0].value,
    keyValues: workerStorageClientCapabilities[1].value,
    owner: handleCoordinatorOwnerStorageRpc, platform: handleCoordinatorPlatformStorageRpc,
    authorize: call => requireCoordinatorSessionPeer(call).peer.peerId,
    browse: processRequest,
    revokeBrowse: () => storageWorkerRequests.storageBrowseCoordinator.revokeAll(),
  }),
  createWindowP2pWorkerPlugin({
    bridge: { get available() { return windowP2pWorkerRuntime.windowP2pExecutorLease?.transportReady === true; }, request: windowP2pWorkerRuntime.requestWindowP2pExecutorOperation },
    isIssued: (consumer, scope) => workerConsumers.get(consumer) === scope,
    revokeLease(identity) {
      if (coordinatorWorkerUnitRegistry.get("window-p2p.coordinator-worker")?.instanceId === identity.instanceId && windowP2pWorkerRuntime.windowP2pExecutorLease?.sessionEpoch === identity.sessionEpoch && windowP2pWorkerRuntime.windowP2pExecutorLease.ownerPublicKeyHex === identity.ownerPublicKeyHex) windowP2pWorkerRuntime.clearWindowP2pExecutorLeaseLocked();
    },
  }),
  createSatSubscriptionWorkerPlugin({
    bindBridge: satWorkerLifecycle.bindBridge,
    bindP2pkh: satWorkerLifecycle.bindP2pkh,
    async start(instanceId, storage, assertActive) {
      const runtime = await ensureSatRuntime(instanceId, storage, assertActive);
      let cleanup: Promise<void> | undefined;
      const revoke = () => {
        if (!cleanup && satWorkerLifecycle.current() === runtime) { cleanup = releaseSatRuntime("unit-revoked"); void cleanup.catch(() => undefined); }
      };
      return {
        admin: runtime.admin, spi: runtime.spi, revoke,
        async dispose() { revoke(); await cleanup; },
      };
    },
    presenceChannel: assertActive => channelWorkerRuntime.createCoordinatorChannelRuntime(assertActive),
  }),
  createMsfileWorkerPlugin({
    bindBridge: msfileWorkerLifecycle.bindBridge,
    bindChain: msfileWorkerLifecycle.bindChain,
    async start(instanceId, stores, assertActive) {
      const service = await ensureMsfileRuntime(instanceId, stores, assertActive);
      const revoke = () => { if (msfileWorkerLifecycle.service() === service) releaseMsfileRuntime("unit-revoked"); };
      return { service, revoke, async dispose() { await msfileWorkerLifecycle.disposeInstance(service); } };
    },
    async control(control, identity, scopeSignal) {
      const operation = isMsfileMutationControl(control) ? "write" : "read";
      const result = await withCoordinatorFinalIoLease(operation, scopeSignal,
        signal => executeMsfileControl({
          kind: "msfile.control", clientId: identity.instanceId,
          requestId: crypto.randomUUID(), expectedSessionEpoch: identity.sessionEpoch, control
        }, signal),
        { allowLocalLock: true, allowLocalOwnerTransition: true, auditOperation: "msfile.control", durableLease: operation === "write" });
      if (result.ack.status !== "ok") throw msfileWorkerRequests.msfileError("msfile_unavailable", "MSFile BitFS control failed: " + result.ack.status);
      return result.operationResult as import("@keymaster/contracts").MsFileBitfsDemandSnapshot | undefined;
    },
  }),
  wocWorkerRuntime.plugin,
  contactsWorkerRuntime.plugin,
  p2pkhWorkerRuntime.plugin,
  createForumWorkerPlugin({
    admission: {
      authorize(call) {
        const peer = requireCoordinatorSessionPeer(call);
        const binding = coordinatorSessionBinding(peer);
        return () => { if (requireCoordinatorSessionPeer(call) !== peer || !sameCoordinatorSessionBinding(binding, coordinatorSessionBinding(peer))) throw new Error("Forum peer session replaced"); };
      },
    }
  }),
  createTokenBsv21WorkerPlugin(workerAssetEvents),
  createTokenStasWorkerPlugin(workerAssetEvents),
  createCollectible1SatordinalsWorkerPlugin(workerAssetEvents),
].map(withCoordinatorWorkerLifecycle);

// Unit tests import this module in a normal Node realm. The installer above is
// a no-op when native WebCrypto exists and never enables a fallback unless the
// realm explicitly reports an insecure context.
export function coordinatorHostOptions() {
  return {
    id: "keymaster-coordinator",
    plugins: [coordinatorTransportPlugin, ...coordinatorRuntimePlugins],
    privateCapabilities: storagePrivateCapabilities(),
    expose: [
      COORDINATOR_RPC_CAPABILITY,
      COORDINATOR_TOPIC_STREAM_CAPABILITY,
    ],
    peerExposureAllowlist: [
      FORUM_WORKER_SERVICE_CAPABILITY,
      FORUM_WORKER_ATTACHMENT_CAPABILITY,
      STORAGE_PRIVATE_BROWSE_CAPABILITY,
      COORDINATOR_OWNER_STORAGE_RPC_CAPABILITY,
      COORDINATOR_PLATFORM_STORAGE_RPC_CAPABILITY,
      COORDINATOR_CRYPTO_RPC_CAPABILITY,
    ],
    configurePeer: configureCoordinatorPeer,
    runtimeUnitAvailability: ({ unitId }: { unitId: string }) => {
      // 与 Worker 本地判定、公开快照投影共用同一个实现：框架门与本地不允许各
      // 判一次。传输插件是 Coordinator Host 的基础设施底座，不在领域目录里。
      if (unitId === COORDINATOR_TRANSPORT_UNIT_ID) return undefined;
      // 领域夹具显式装配真实服务/任务；自动 SharedWorker Host 只保留观察面。
      // 防止同一个测试同时启动夹具实例和生产 owner 实例，产生两套 actor/任务。
      // __testCoordinatorRuntimePlugin 返回的定义仍由独立 Native Host 执行。
      if (testDomainUnitReadiness && COORDINATOR_WORKER_UNIT_CATALOG.some(unit => unit.unitId === unitId && unit.scopeKind === "owner-session")) return "domain-fixture-host";
      // 门问的是「能不能启动」，因此排除「自身已就绪」这一项。
      return describeUnitUnavailableForFramework(
        evaluateCoordinatorUnitStartupPreconditions(unitId, coordinatorUnitAvailabilityContext()),
      );
    },
    runtimeUnitAttributes: ({ unitId }: { unitId: string }) => {
      const unit = COORDINATOR_WORKER_UNIT_CATALOG.find((candidate) => candidate.unitId === unitId);
      return {
        ...(unit ? { productId: unit.productId, scopeKind: unit.scopeKind } : {}),
        ...(unit?.scopeKind === "owner-session" && coordinatorState.activePublicKeyHex
          ? { ownerPublicKeyHex: coordinatorState.activePublicKeyHex, sessionEpoch: coordinatorState.sessionEpoch }
          : {}),
        // 本地介质没有桶世代：运行单元的身份由钱包世代与会话世代决定。
        ...(coordinatorState.walletGeneration ? { walletGeneration: coordinatorState.walletGeneration } : {}),
      };
    },
  };
}

export function attachCoordinatorHost(app: ReturnType<typeof startSharedWorkerApp>) {
  coordinatorRuntimeApp = app;

  let lastFrameworkReadyInstances = "";
  coordinatorRuntimeApp.subscribe(state => {
    const readyInstances = state.units.filter(unit => unit.state === "enabled")
      .map(unit => `${unit.unitId}:${unit.instanceId}`).sort().join("|");
    if (readyInstances === lastFrameworkReadyInstances) return;
    lastFrameworkReadyInstances = readyInstances;
    reconcileCoordinatorSessionExposures();
    synchronizeCoordinatorTaskUnitInstances();
    publishCoordinatorWorkerUnitSnapshot();
    scheduleCoordinatorRuntimeReconcile();
    for (const runtime of backgroundWorkerRuntime.taskRuntimes.values()) {
      const resumes = !testDomainUnitReadiness && runtime.state === "blocked"
        && isRuntimeAvailabilityBlockedReason(runtime.blockedReason) && !coordinatorTaskBlockedReason(runtime);
      scheduleRuntime(runtime);
      if (resumes) {
        runtime.state = "idle";
        runtime.blockedReason = undefined;
        if (runtime.syncPolicy === "smart" || runtime.syncPolicy === "managed" && (runtime.intervalMs ?? 0) > 0) {
          void executeTask(runtime.id, BACKGROUND_TRIGGER_REASON.INIT).catch(() => undefined);
        }
      }
    }
  });

}

/**
 * Worker 冷启动。
 *
 * 单 Key 本地存储没有 Provider 选择、没有桶、没有远程连接，也没有可恢复的
 * 「选中的 Key」。顺序固定为：
 *
 *   authority claim -> IndexedDB store -> 固定 KeyHold 仓储 -> 生命周期服务
 *   -> coldStart() -> installPlatformStorage() -> ready / locked / uninitialized
 *
 * coldStart 只读 `.keymaster/meta` 与 `key.json`：
 *   - ready：装配平台 Root，进入 **locked**（不读取、不解密私钥）；
 *   - uninitialized：只提供创建或导入，不触碰任何其它记录；
 *   - corrupt / unsupported：进入明确错误界面，绝不静默创建空钱包。
 */
async function initializeCoordinator(skipStorageBootstrap = false, propagateFailure = false, peerId?: string): Promise<void> {
  coordinatorInitializationInProgress = true;
  try {
    await initializeCoordinatorInternal(skipStorageBootstrap, propagateFailure, peerId);
  } finally {
    coordinatorInitializationInProgress = false;
  }
}

async function initializeCoordinatorInternal(skipStorageBootstrap = false, propagateFailure = false, peerId?: string): Promise<void> {
  // 必须先取得 Keymaster 自己的跨 Worker authority，再触碰任何持久化对象。
  try {
    await ensureCoordinatorAuthorityClaim();
  } catch (error) {
    coordinatorState.vaultStatus = "fatal";
    publishSessionState("bootstrap");
    const code = error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
    // authority 冲突/能力缺失不是可恢复的本地状态：必须让 session.open 失败，
    // 不能只返回一个没有 capability 的 fatal snapshot，让新页面看起来已经
    // 连上了一个不可用的 Worker。
    if (propagateFailure || code === "upgrade.authority_conflict" || code === "upgrade.authority_unavailable") throw error;
    return;
  }
  if (skipStorageBootstrap && !storageWorkerRoot.root) {
    throw storageUnavailableError("Storage root is unavailable during recovery");
  }
  if (!skipStorageBootstrap) {
    try {
      await vaultWalletWorker.bootstrapWalletStorage();
    } catch (error) {
      // 格式错误（包括未完成迁移）保留 coldStart 结论，页面才能进入恢复。
      // 只有数据库打开/事务等宿主故障才是 degraded；两种情况均不清库。
      const code = error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code : undefined;
      storageWorkerRoot.failed = code !== "storage_wallet_corrupt" && code !== "storage_wallet_unsupported";
      if (!storageWorkerRoot.failed) {
        // 恢复连接只允许 locked；保持 booting 会让入口可见却无法连接原设备。
        // locked 不安装业务 Root，也不恢复私钥或普通签名能力。
        coordinatorState.vaultStatus = "locked";
        coordinatorState.activePublicKeyHex = undefined;
      }
      emitStorageState();
      publishSessionState("bootstrap");
      if (propagateFailure) throw error;
      return;
    }
  }
  try {
    await withCoordinatorFinalIoLease(
      "write",
      undefined,
      async () => {
        await loadCoordinatorMeta();
        // 冷启动只依据 coldStart 的结论决定 Vault 状态；不列举 Key 目录、
        // 不恢复 selected Key，也不解密私钥。
        const coldStart = vaultWalletWorker.storageColdStartState ?? await vaultWalletWorker.walletLifecycle?.coldStart();
        vaultWalletWorker.storageColdStartState = coldStart;
        switch (coldStart?.state) {
          case "ready":
            coordinatorMeta.p2pkhSettings = { bsvNetwork: coldStart.key!.bsvNetwork };
            coordinatorState.walletGeneration = coldStart.walletGeneration ?? coordinatorState.walletGeneration;
            coordinatorState.vaultStatus = "locked";
            coordinatorState.activePublicKeyHex = undefined;
            break;
          case "uninitialized":
            coordinatorState.walletGeneration = "";
            coordinatorState.vaultStatus = "uninitialized";
            break;
          case "corrupt":
          case "unsupported":
            // 不静默创建空钱包：抛出可区分的存储错误，让页面进入错误界面。
            throw new StorageRuntimeError(
              coldStart.state === "corrupt" ? "storage_wallet_corrupt" : "storage_wallet_unsupported",
              coldStart.reason ?? "Local wallet data is unusable",
            );
          default:
            coordinatorState.walletGeneration = "";
            coordinatorState.vaultStatus = "uninitialized";
            break;
        }
      },
      { allowLocalLock: true, auditOperation: "coordinator.bootstrap.recover" },
    );
    // 只有冷启动结论为 ready 时才存在可写 Root。未初始化钱包本地没有任何
    // Root，corrupt/unsupported 已在上方抛出：这两种情况下**不得**安装
    // runtime 与任务，否则会把「没有钱包」误报成存储故障，或用空绑定覆盖
    // 仍可能可恢复的数据。可写 runtime 与任务由 initializeWallet() 在唯一
    // Key 事务提交成功后再安装。
    if (coordinatorState.vaultStatus === "locked") {
      await ensureStorageRuntime(peerId);
      await ensureCoordinatorTasksRegistered();
      // 启动时钱包是 locked：所有任务保持 blocked，等解锁后再恢复。
      for (const runtime of backgroundWorkerRuntime.taskRuntimes.values()) {
        runtime.state = "blocked";
        runtime.blockedReason = "Vault is locked";
      }
    }
    storageWorkerRoot.failed = false;
    emitStorageState();
  } catch (error) {
    // Root 已建立后发生的 IndexedDB/事务/配额错误仍属于 Storage 可用性域；
    // Vault 保持 booting，等待 Storage 恢复编排，不得伪装成 fatal。
    if (isStorageFailure(error)) {
      storageWorkerRoot.failed = true;
      emitStorageState();
      coordinatorState.vaultStatus = "booting";
      if (propagateFailure) throw error;
    } else {
      coordinatorState.vaultStatus = "fatal";
      if (propagateFailure) throw error;
    }
  } finally {
    // hello 只在存储启动完成后处理。无论初始化成功或失败，都必须广播最终
    // 状态，否则首个页面会永久停留在 booting。
    publishSessionState("bootstrap");
  }
}

/** 删除一个已撤销第三方 App 的独立目录；只作用于该目录。 */
async function clearThirdPartyAppRoot(appStorageName: string): Promise<void> {
  if (!storageWorkerRoot.root) return;
  // 第三方 App 的 namespace 不在中央声明目录里：它的 moduleId 由验证身份派生，
  // 目录由平台登记的 name 决定。buildWalletStorageRoot 对 third-party-app 只使用
  // appStorageName，因此 moduleId 在这里只是一条不参与路径计算的稳定坐标。
  await storageWorkerRoot.root.clearStorageRoot({
    declaration: THIRD_PARTY_APP_FILES_DECLARATION,
    appStorageName,
  });
}

let coordinatorInitialization: Promise<void> | undefined;
function startCoordinatorInitialization(_removedBootstrapState?: unknown, peerId?: string): Promise<void> {
  if (!coordinatorInitialization) {
    // Worker 级 single-flight：首个到达者的 peer 被闭包固定，后续 session 只
    // 等待同一次初始化。冷启动不再有任何「启动选择」，第一个参数已被忽略。
    coordinatorInitialization = initializeCoordinator(false, false, peerId);
  }
  return coordinatorInitialization;
}

// ============================================================
// 14. Test Exports
// ============================================================

/** 仅测试入口调用；生产 Worker graph 不导入测试实现。 */
export function coordinatorTestingPorts(): CoordinatorTestingPorts {
  return {
    get domainFixtureInstaller() { return domainFixtureInstaller; }, set domainFixtureInstaller(value: typeof domainFixtureInstaller) { domainFixtureInstaller = value; },
    get getTaskSnapshots() { return getTaskSnapshots; },
    get bindCoordinatorTaskUnitsToOwner() { return bindCoordinatorTaskUnitsToOwner; },
    get createWorkerKeyValueStore() { return createWorkerKeyValueStore; },
    get initializeCoordinatorP2pkhProviders() { return initializeCoordinatorP2pkhProviders; },

    get scheduleRuntime() { return scheduleRuntime; },
    get managedIntervalFor() { return managedIntervalFor; },
    get publishTopicEvent() { return publishTopicEvent; },
    get refreshP2pkhUtxoSnapshots() { return refreshP2pkhUtxoSnapshots; },
    get loadP2pkhSettingForOwner() { return loadP2pkhSettingForOwner; },
    get bitfsNetwork() { return bitfsNetwork; },
    get SAT_WINDOW_LANE_ID() { return SAT_WINDOW_LANE_ID; },
    get acquireCoordinatorFinalIoLease() { return acquireCoordinatorFinalIoLease; },
    get activateCoordinatorOwnerWorkerUnit() { return activateCoordinatorOwnerWorkerUnit; },
    get activateCoordinatorRootWorkerUnits() { return activateCoordinatorRootWorkerUnits; },
    get backgroundWorkerRuntime() { return backgroundWorkerRuntime; },
    get buildSnapshot() { return buildSnapshot; },
    get buildTopicBaselines() { return buildTopicBaselines; },
    get cancelSmartSyncIdleTimer() { return cancelSmartSyncIdleTimer; },
    get cancelTaskRuntimesByKey() { return cancelTaskRuntimesByKey; },
    get chainHeightRevision() { return chainHeightRevision; },
    set chainHeightRevision(value: typeof chainHeightRevision) { chainHeightRevision = value; },
    get channelRevision() { return channelRevision; },
    set channelRevision(value: typeof channelRevision) { channelRevision = value; },
    get channelWorkerRuntime() { return channelWorkerRuntime; },
    get closeCoordinatorTopicStreamQueue() { return closeCoordinatorTopicStreamQueue; },
    get closeCoordinatorUpgradeSession() { return closeCoordinatorUpgradeSession; },
    get configureCoordinatorPeer() { return configureCoordinatorPeer; },
    get contactsPresenceProjection() { return contactsPresenceProjection; },
    get contactsPresenceRevision() { return contactsPresenceRevision; },
    set contactsPresenceRevision(value: typeof contactsPresenceRevision) { contactsPresenceRevision = value; },
    get contactsWorkerRuntime() { return contactsWorkerRuntime; },
    get coordinatorAuthorityInstanceId() { return coordinatorAuthority.coordinatorAuthorityInstanceId; },
    set coordinatorAuthorityInstanceId(value: typeof coordinatorAuthority.coordinatorAuthorityInstanceId) { coordinatorAuthority.coordinatorAuthorityInstanceId = value; },
    get coordinatorAuthorityLock() { return coordinatorAuthority.coordinatorAuthorityLock; },
    set coordinatorAuthorityLock(value: typeof coordinatorAuthority.coordinatorAuthorityLock) { coordinatorAuthority.coordinatorAuthorityLock = value; },
    get coordinatorAuthorityRecord() { return coordinatorAuthority.coordinatorAuthorityRecord; },
    set coordinatorAuthorityRecord(value: typeof coordinatorAuthority.coordinatorAuthorityRecord) { coordinatorAuthority.coordinatorAuthorityRecord = value; },
    get coordinatorAuthorityRecovery() { return coordinatorAuthority.coordinatorAuthorityRecovery; },
    set coordinatorAuthorityRecovery(value: typeof coordinatorAuthority.coordinatorAuthorityRecovery) { coordinatorAuthority.coordinatorAuthorityRecovery = value; },
    get coordinatorAuthorityRecoveryOperationNames() { return coordinatorAuthority.coordinatorAuthorityRecoveryOperationNames; },
    set coordinatorAuthorityRecoveryOperationNames(value: typeof coordinatorAuthority.coordinatorAuthorityRecoveryOperationNames) { coordinatorAuthority.coordinatorAuthorityRecoveryOperationNames = value; },
    get coordinatorHandoverGeneration() { return coordinatorAuthority.coordinatorHandoverGeneration; },
    set coordinatorHandoverGeneration(value: typeof coordinatorAuthority.coordinatorHandoverGeneration) { coordinatorAuthority.coordinatorHandoverGeneration = value; },
    get coordinatorInitialization() { return coordinatorInitialization; },
    set coordinatorInitialization(value: typeof coordinatorInitialization) { coordinatorInitialization = value; },
    get coordinatorMeta() { return coordinatorMeta; },
    get coordinatorOpeningSession() { return coordinatorOpeningSession; },
    set coordinatorOpeningSession(value: typeof coordinatorOpeningSession) { coordinatorOpeningSession = value; },
    get coordinatorPeerState() { return coordinatorPeerState; },
    get coordinatorPeers() { return coordinatorPeers; },
    get coordinatorRequestTail() { return coordinatorRequestTail; },
    set coordinatorRequestTail(value: typeof coordinatorRequestTail) { coordinatorRequestTail = value; },
    get coordinatorRuntimePlugins() { return coordinatorRuntimePlugins; },
    get coordinatorSessionClosed() { return coordinatorSessionClosed; },
    get coordinatorSessionCommitOrder() { return coordinatorSessionCommitOrder; },
    set coordinatorSessionCommitOrder(value: typeof coordinatorSessionCommitOrder) { coordinatorSessionCommitOrder = value; },
    get coordinatorSessionOpenTail() { return coordinatorSessionOpenTail; },
    set coordinatorSessionOpenTail(value: typeof coordinatorSessionOpenTail) { coordinatorSessionOpenTail = value; },
    get coordinatorState() { return coordinatorState; },
    get coordinatorStorageIoHandoffRevision() { return coordinatorStorageIoHandoffRevision; },
    set coordinatorStorageIoHandoffRevision(value: typeof coordinatorStorageIoHandoffRevision) { coordinatorStorageIoHandoffRevision = value; },
    get coordinatorTestEventSinks() { return coordinatorTestEventSinks; },
    get coordinatorWorkerUnitRegistry() { return coordinatorWorkerUnitRegistry; },
    get createCoordinatorTaskRuntime() { return createCoordinatorTaskRuntime; },
    get createMsfileBitfsBuyerTask() { return createMsfileBitfsBuyerTask; },
    get createWorkerModuleFileStore() { return createWorkerModuleFileStore; },
    get createWorkerWalletState() { return createWorkerWalletState; },
    get discardCurrentPlatformStorageBinding() { return discardCurrentPlatformStorageBinding; },
    get emitSatState() { return emitSatState; },
    get emitStorageState() { return emitStorageState; },
    get ensureCoordinatorAuthorityClaim() { return ensureCoordinatorAuthorityClaim; },
    get ensureCoordinatorTasksRegistered() { return ensureCoordinatorTasksRegistered; },
    get ensureCoordinatorUpgradeSession() { return ensureCoordinatorUpgradeSession; },
    get ensureSatP2pkhService() { return ensureSatP2pkhService; },
    get ensureSatRuntime() { return ensureSatRuntime; },
    get ensureStorageRuntime() { return ensureStorageRuntime; },
    get executeTask() { return executeTask; },
    get generateEpoch() { return generateEpoch; },
    get globalLockRunning() { return globalLockRunning; },
    set globalLockRunning(value: typeof globalLockRunning) { globalLockRunning = value; },
    get handleActivity() { return handleActivity; },
    get handleAutolockSettingsUpdate() { return handleAutolockSettingsUpdate; },
    get handleBackgroundRunNow() { return handleBackgroundRunNow; },
    get handleBackgroundSettingsUpdate() { return handleBackgroundSettingsUpdate; },
    get handleCoordinatorRpc() { return handleCoordinatorRpc; },
    get handleMsfileSellerHashRequest() { return handleMsfileSellerHashRequest; },
    get handleP2pkhBroadcast() { return handleP2pkhBroadcast; },
    get handleP2pkhProviderConfigGet() { return handleP2pkhProviderConfigGet; },
    get handleP2pkhProviderConfigUpdate() { return handleP2pkhProviderConfigUpdate; },
    get initializeCoordinator() { return initializeCoordinator; },
    get installPlatformStorage() { return installPlatformStorage; },
    get lastSatState() { return lastSatState; },
    set lastSatState(value: typeof lastSatState) { lastSatState = value; },
    get loadCoordinatorMeta() { return loadCoordinatorMeta; },
    get lockRevocationPending() { return lockRevocationPending; },
    set lockRevocationPending(value: typeof lockRevocationPending) { lockRevocationPending = value; },
    get makeCoordinatorAuthorityInstanceId() { return makeCoordinatorAuthorityInstanceId; },
    get msfileBitfsRuntime() { return msfileBitfsRuntime; },
    get msfileWorkerLifecycle() { return msfileWorkerLifecycle; },
    get msfileWorkerProjection() { return msfileWorkerProjection; },
    get msfileWorkerRequests() { return msfileWorkerRequests; },
    get onWocQueueChanged() { return onWocQueueChanged; },
    get p2pkhWocService() { return p2pkhWocService; },
    set p2pkhWocService(value: typeof p2pkhWocService) { p2pkhWocService = value; },
    get p2pkhWorkerRuntime() { return p2pkhWorkerRuntime; },
    get persistCoordinatorSettings() { return persistCoordinatorSettings; },
    get prepareMsfileBitfsFundingSplit() { return prepareMsfileBitfsFundingSplit; },
    get processRequest() { return processRequest; },
    get readCoordinatorBitfsBlockHeight() { return readCoordinatorBitfsBlockHeight; },
    get recoverMsfileBitfsFundingSplit() { return recoverMsfileBitfsFundingSplit; },
    get registerCoordinatorTasks() { return registerCoordinatorTasks; },
    get releaseMsfileRuntime() { return releaseMsfileRuntime; },
    get releaseSatRuntime() { return releaseSatRuntime; },
    get releaseStorageRuntime() { return releaseStorageRuntime; },
    get revokedCoordinatorPeerIds() { return revokedCoordinatorPeerIds; },
    get satIncomingHandlers() { return satIncomingHandlers; },
    get satRevision() { return satRevision; },
    set satRevision(value: typeof satRevision) { satRevision = value; },
    get satWorkerLifecycle() { return satWorkerLifecycle; },
    get scheduleCoordinatorAuthorityClaim() { return scheduleCoordinatorAuthorityClaim; },
    get snapshotWriteMetrics() { return snapshotWriteMetrics; },
    get stopCoordinatorKeyValueMaintenance() { return stopCoordinatorKeyValueMaintenance; },
    get stopCoordinatorWorkerUnit() { return stopCoordinatorWorkerUnit; },
    get storageIoOwner() { return storageIoOwner; },
    set storageIoOwner(value: typeof storageIoOwner) { storageIoOwner = value; },
    get storageKeyValueMaintenance() { return storageKeyValueMaintenance; },
    get storageWorkerControl() { return storageWorkerControl; },
    get storageWorkerRequests() { return storageWorkerRequests; },
    get storageWorkerRoot() { return storageWorkerRoot; },
    get testChainHeightProvider() { return testChainHeightProvider; },
    set testChainHeightProvider(value: typeof testChainHeightProvider) { testChainHeightProvider = value; },
    get testCoordinatorPeerHandoffNotifier() { return testCoordinatorPeerHandoffNotifier; },
    set testCoordinatorPeerHandoffNotifier(value: typeof testCoordinatorPeerHandoffNotifier) { testCoordinatorPeerHandoffNotifier = value; },
    get testCoordinatorSnapshotMetrics() { return testCoordinatorSnapshotMetrics; },
    get testDomainUnitReadiness() { return testDomainUnitReadiness; },
    set testDomainUnitReadiness(value: typeof testDomainUnitReadiness) { testDomainUnitReadiness = value; },
    get testFailNextP2pkhSettingWrite() { return testFailNextP2pkhSettingWrite; },
    set testFailNextP2pkhSettingWrite(value: typeof testFailNextP2pkhSettingWrite) { testFailNextP2pkhSettingWrite = value; },
    get testHarnessActivationSecret() { return testHarnessActivationSecret; },
    set testHarnessActivationSecret(value: typeof testHarnessActivationSecret) { testHarnessActivationSecret = value; },
    get testMsfileRuntimeOverride() { return testMsfileRuntimeOverride; },
    set testMsfileRuntimeOverride(value: typeof testMsfileRuntimeOverride) { testMsfileRuntimeOverride = value; },
    get testP2pkhBroadcastProvider() { return testP2pkhBroadcastProvider; },
    set testP2pkhBroadcastProvider(value: typeof testP2pkhBroadcastProvider) { testP2pkhBroadcastProvider = value; },
    get testP2pkhUnspentAllProvider() { return testP2pkhUnspentAllProvider; },
    set testP2pkhUnspentAllProvider(value: typeof testP2pkhUnspentAllProvider) { testP2pkhUnspentAllProvider = value; },
    get testPersistCoordinatorSnapshotFailure() { return testPersistCoordinatorSnapshotFailure; },
    set testPersistCoordinatorSnapshotFailure(value: typeof testPersistCoordinatorSnapshotFailure) { testPersistCoordinatorSnapshotFailure = value; },
    get testSatBroadcastRetryOverrides() { return testSatBroadcastRetryOverrides; },
    set testSatBroadcastRetryOverrides(value: typeof testSatBroadcastRetryOverrides) { testSatBroadcastRetryOverrides = value; },
    get testStorageSessionResolver() { return testStorageSessionResolver; },
    set testStorageSessionResolver(value: typeof testStorageSessionResolver) { testStorageSessionResolver = value; },
    get triggerImmediateSync() { return triggerImmediateSync; },
    get vaultAutoLock() { return vaultAutoLock; },
    get vaultWalletWorker() { return vaultWalletWorker; },
    get vaultWorkerKeys() { return vaultWorkerKeys; },
    get vaultWorkerOperations() { return vaultWorkerOperations; },
    get walletLockBarrier() { return walletLockBarrier; },
    get walletRevocationCleanup() { return walletRevocationCleanup; },
    set walletRevocationCleanup(value: typeof walletRevocationCleanup) { walletRevocationCleanup = value; },
    get windowP2pWorkerRuntime() { return windowP2pWorkerRuntime; },
    get wocWorkerRuntime() { return wocWorkerRuntime; },
    get workerStorageClients() { return workerStorageClients; },
    get workerWalletState() { return workerWalletState; },
  };
}
export type { ChannelSeenMessageKind, CoordinatorPeerHandoffNotifier, BitfsNetwork, CoordinatorClientRequest, CoordinatorSettingsSnapshot };

export interface CoordinatorTestingPorts {
  domainFixtureInstaller: (() => Promise<void>) | undefined;
  getTaskSnapshots: typeof getTaskSnapshots;
  bindCoordinatorTaskUnitsToOwner: typeof bindCoordinatorTaskUnitsToOwner;
  createWorkerKeyValueStore: typeof createWorkerKeyValueStore;
  initializeCoordinatorP2pkhProviders: typeof initializeCoordinatorP2pkhProviders;

  scheduleRuntime: typeof scheduleRuntime;
  managedIntervalFor: typeof managedIntervalFor;
  publishTopicEvent: typeof publishTopicEvent;
  refreshP2pkhUtxoSnapshots: typeof refreshP2pkhUtxoSnapshots;
  loadP2pkhSettingForOwner: typeof loadP2pkhSettingForOwner;
  bitfsNetwork: typeof bitfsNetwork;
  SAT_WINDOW_LANE_ID: string;
  acquireCoordinatorFinalIoLease: typeof acquireCoordinatorFinalIoLease;
  activateCoordinatorOwnerWorkerUnit: typeof activateCoordinatorOwnerWorkerUnit;
  activateCoordinatorRootWorkerUnits: typeof activateCoordinatorRootWorkerUnits;
  backgroundWorkerRuntime: ReturnType<typeof createWorkerBackgroundRuntime>;
  buildSnapshot: typeof buildSnapshot;
  buildTopicBaselines: typeof buildTopicBaselines;
  cancelSmartSyncIdleTimer: typeof cancelSmartSyncIdleTimer;
  cancelTaskRuntimesByKey: typeof cancelTaskRuntimesByKey;
  chainHeightRevision: typeof chainHeightRevision;
  channelRevision: typeof channelRevision;
  channelWorkerRuntime: ReturnType<typeof createChannelWorkerRuntime>;
  closeCoordinatorTopicStreamQueue: typeof closeCoordinatorTopicStreamQueue;
  closeCoordinatorUpgradeSession: typeof closeCoordinatorUpgradeSession;
  configureCoordinatorPeer: typeof configureCoordinatorPeer;
  contactsPresenceProjection: ReturnType<typeof createWorkerPresenceProjection>;
  contactsPresenceRevision: typeof contactsPresenceRevision;
  contactsWorkerRuntime: ReturnType<typeof createContactsWorkerRuntime>;
  coordinatorAuthorityInstanceId: typeof coordinatorAuthority.coordinatorAuthorityInstanceId;
  coordinatorAuthorityLock: CoordinatorAuthorityLock | undefined;
  coordinatorAuthorityRecord: CoordinatorAuthorityRecord | undefined;
  coordinatorAuthorityRecovery: CoordinatorAuthorityRecovery | undefined;
  coordinatorAuthorityRecoveryOperationNames: string[];
  coordinatorHandoverGeneration: typeof coordinatorAuthority.coordinatorHandoverGeneration;
  coordinatorInitialization: Promise<void> | undefined;
  coordinatorMeta: CoordinatorRuntimeSettings;
  coordinatorOpeningSession: CoordinatorSessionOpenAttempt | undefined;
  coordinatorPeerState: typeof coordinatorPeerState;
  coordinatorPeers: typeof coordinatorPeers;
  coordinatorRequestTail: Promise<void>;
  coordinatorRuntimePlugins: typeof coordinatorRuntimePlugins;
  coordinatorSessionClosed: typeof coordinatorSessionClosed;
  coordinatorSessionCommitOrder: typeof coordinatorSessionCommitOrder;
  coordinatorSessionOpenTail: Promise<void>;
  coordinatorState: CoordinatorState;
  coordinatorStorageIoHandoffRevision: typeof coordinatorStorageIoHandoffRevision;
  coordinatorTestEventSinks: typeof coordinatorTestEventSinks;
  coordinatorWorkerUnitRegistry: ReturnType<typeof createCoordinatorWorkerUnitRegistry>;
  createCoordinatorTaskRuntime: typeof createCoordinatorTaskRuntime;
  createMsfileBitfsBuyerTask: typeof createMsfileBitfsBuyerTask;
  createWorkerModuleFileStore: typeof createWorkerModuleFileStore;
  createWorkerWalletState: typeof createWorkerWalletState;
  discardCurrentPlatformStorageBinding: typeof discardCurrentPlatformStorageBinding;
  emitSatState: typeof emitSatState;
  emitStorageState: typeof emitStorageState;
  ensureCoordinatorAuthorityClaim: typeof ensureCoordinatorAuthorityClaim;
  ensureCoordinatorTasksRegistered: typeof ensureCoordinatorTasksRegistered;
  ensureCoordinatorUpgradeSession: typeof ensureCoordinatorUpgradeSession;
  ensureSatP2pkhService: typeof ensureSatP2pkhService;
  ensureSatRuntime: typeof ensureSatRuntime;
  ensureStorageRuntime: typeof ensureStorageRuntime;
  executeTask: typeof executeTask;
  generateEpoch: typeof generateEpoch;
  globalLockRunning: Promise<void> | undefined;
  handleActivity: typeof handleActivity;
  handleAutolockSettingsUpdate: typeof handleAutolockSettingsUpdate;
  handleBackgroundRunNow: typeof handleBackgroundRunNow;
  handleBackgroundSettingsUpdate: typeof handleBackgroundSettingsUpdate;
  handleCoordinatorRpc: typeof handleCoordinatorRpc;
  handleMsfileSellerHashRequest: typeof handleMsfileSellerHashRequest;
  handleP2pkhBroadcast: typeof handleP2pkhBroadcast;
  handleP2pkhProviderConfigGet: typeof handleP2pkhProviderConfigGet;
  handleP2pkhProviderConfigUpdate: typeof handleP2pkhProviderConfigUpdate;
  initializeCoordinator: typeof initializeCoordinator;
  installPlatformStorage: typeof installPlatformStorage;
  lastSatState: CoordinatorSatStateEvent | undefined;
  loadCoordinatorMeta: typeof loadCoordinatorMeta;
  lockRevocationPending: boolean;
  makeCoordinatorAuthorityInstanceId: typeof makeCoordinatorAuthorityInstanceId;
  msfileBitfsRuntime: ReturnType<typeof createBitfsWorkerRuntime>;
  msfileWorkerLifecycle: ReturnType<typeof createMsFileWorkerLifecycle>;
  msfileWorkerProjection: ReturnType<typeof createMsFileWorkerProjection>;
  msfileWorkerRequests: ReturnType<typeof createMsFileWorkerRequests>;
  onWocQueueChanged: typeof onWocQueueChanged;
  p2pkhWocService: ReturnType<typeof createWocService> | undefined;
  p2pkhWorkerRuntime: ReturnType<typeof createP2pkhWorkerRuntime>;
  persistCoordinatorSettings: typeof persistCoordinatorSettings;
  prepareMsfileBitfsFundingSplit: typeof prepareMsfileBitfsFundingSplit;
  processRequest: typeof processRequest;
  readCoordinatorBitfsBlockHeight: typeof readCoordinatorBitfsBlockHeight;
  recoverMsfileBitfsFundingSplit: typeof recoverMsfileBitfsFundingSplit;
  registerCoordinatorTasks: typeof registerCoordinatorTasks;
  releaseMsfileRuntime: typeof releaseMsfileRuntime;
  releaseSatRuntime: typeof releaseSatRuntime;
  releaseStorageRuntime: typeof releaseStorageRuntime;
  revokedCoordinatorPeerIds: typeof revokedCoordinatorPeerIds;
  satIncomingHandlers: typeof satIncomingHandlers;
  satRevision: typeof satRevision;
  satWorkerLifecycle: ReturnType<typeof createSatWorkerLifecycle>;
  scheduleCoordinatorAuthorityClaim: typeof scheduleCoordinatorAuthorityClaim;
  snapshotWriteMetrics: typeof snapshotWriteMetrics;
  stopCoordinatorKeyValueMaintenance: typeof stopCoordinatorKeyValueMaintenance;
  stopCoordinatorWorkerUnit: typeof stopCoordinatorWorkerUnit;
  storageIoOwner: CoordinatorStorageIoOwner | undefined;
  storageKeyValueMaintenance: ReturnType<typeof createKeyValueMaintenance>;
  storageWorkerControl: ReturnType<typeof createStorageWorkerControl>;
  storageWorkerRequests: ReturnType<typeof createStorageWorkerRequests>;
  storageWorkerRoot: ReturnType<typeof createStorageWorkerRoot>;
  testChainHeightProvider: ((network: BsvNetwork) => Promise<number>) | undefined;
  testCoordinatorPeerHandoffNotifier: CoordinatorPeerHandoffNotifier | undefined;
  testCoordinatorSnapshotMetrics: typeof testCoordinatorSnapshotMetrics;
  testDomainUnitReadiness: boolean;
  testFailNextP2pkhSettingWrite: boolean;
  testHarnessActivationSecret: string | undefined;
  testMsfileRuntimeOverride: MsFileServiceImpl | undefined;
  testP2pkhBroadcastProvider: P2pkhTransactionBroadcastProvider | undefined;
  testP2pkhUnspentAllProvider: ((network: "main" | "test", address: string) => Promise<WocUtxoResponse[]>) | undefined;
  testPersistCoordinatorSnapshotFailure: boolean;
  testSatBroadcastRetryOverrides: { maxAttempts?: number; deadlineMs?: number; initialBackoffMs?: number; maxBackoffMs?: number } | undefined;
  testStorageSessionResolver: ((sessionId: string) => Promise<{ sessionId: string; origin: string; networkIdentity?: import("@keymaster/contracts").NetworkIdentity; ownerPublicKeyHex?: string; appIdentity: import("@keymaster/contracts").OwnerAppStorageGrant["appIdentity"]; revokedAt: number | null } | null>) | undefined;
  triggerImmediateSync: typeof triggerImmediateSync;
  vaultAutoLock: ReturnType<typeof createWorkerAutoLock>;
  vaultWalletWorker: ReturnType<typeof createVaultWalletWorker>;
  vaultWorkerKeys: ReturnType<typeof createVaultWorkerKeys>;
  vaultWorkerOperations: ReturnType<typeof createVaultWorkerOperations>;
  walletLockBarrier: typeof walletLockBarrier;
  walletRevocationCleanup: Promise<void>[] | undefined;
  windowP2pWorkerRuntime: ReturnType<typeof createWindowP2pWorkerRuntime>;
  wocWorkerRuntime: ReturnType<typeof createWocWorkerRuntime>;
  workerStorageClients: ReturnType<typeof createWorkerStorageClients>;
  workerWalletState: ReturnType<typeof createWalletStateSource>;
}
