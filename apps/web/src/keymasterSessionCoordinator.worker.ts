import { createPublicMsFileService } from "@keymaster/plugin-msfile/coordinator";
import { createVaultBootstrapStorage } from "@keymaster/platform-storage/assembly";
import { executeWorkerUnlock } from "@keymaster/plugin-vault/coordinator";
import { executeWorkerP2pkhSnapshot, readWorkerP2pkhResource } from "@keymaster/plugin-p2pkh/coordinator";
import { createSatWorkerTransport } from "@keymaster/plugin-sat-subscription/coordinator";
import { createWorkerPresenceProjection } from "@keymaster/plugin-contacts/coordinator";
import { createWorkerAutoLock } from "@keymaster/plugin-vault/coordinator";
import { createWorkerBackgroundRuntime, type TaskRuntime } from "@keymaster/plugin-background/coordinator";
import { VAULT_WORKER_CRYPTO_CAPABILITY, P2PKH_WORKER_TRANSFER_CAPABILITY, type P2pkhWorkerTransfer, type VaultWorkerCrypto } from "@keymaster/contracts";
import { createWorkerTransferRuntime } from "@keymaster/plugin-p2pkh/coordinator";
import { WOC_WORKER_BROADCAST_CAPABILITY, type WocWorkerBroadcastService, type WocServiceHandle } from "@keymaster/contracts";
import { createWorkerWocViews } from "@keymaster/plugin-woc/coordinator";
import { createChannelInbound, isUnknownChannelPublishFailure } from "@keymaster/plugin-sat-subscription/coordinator";
import { createChannelOperationExecutor } from "@keymaster/plugin-sat-subscription/coordinator";
import { createChannelPublications, publicMessageTimes } from "@keymaster/plugin-sat-subscription/coordinator";
import { createWorkerP2pkhSettings } from "@keymaster/plugin-p2pkh/coordinator";
import { createBitfsWorkerRuntime } from "@keymaster/plugin-msfile/coordinator";
import { createWorkerFundingRuntime } from "@keymaster/plugin-msfile/coordinator";
import { executeWorkerP2pkhBroadcast } from "@keymaster/plugin-p2pkh/coordinator";
import { executeWalletControl } from "@keymaster/plugin-vault/coordinator";
import { createWorkerBridgeBudget } from "@keymaster/plugin-window-p2p/coordinator";
import { ensureWorkerP2pkhResources as ensureOwnedP2pkhResources, refreshWorkerP2pkhResources } from "@keymaster/plugin-p2pkh/coordinator";
import { createOwnerChannelMux } from "@keymaster/plugin-sat-subscription/coordinator";
import { executeSatOperation } from "@keymaster/plugin-sat-subscription/coordinator";
import { createChannelCallerPolicy, privateProtocol, privateBodyForPublish, validatePrivateProtocolCaller, type ChannelPrivateProtocol } from "@keymaster/plugin-sat-subscription/coordinator";
import { createKeyValueMaintenance } from "@keymaster/platform-storage/coordinator";
import { CONTACTS_PRESENCE_CHANNEL_CAPABILITY, type ContactsPresenceChannel } from "@keymaster/contracts";
import { createContactsPresenceChannel } from "@keymaster/plugin-sat-subscription/coordinator";
import { MSFILE_SERVICE_CAPABILITY } from "@keymaster/contracts";
import { createMsFileWorkerService } from "@keymaster/plugin-msfile/coordinator";
import { createSatWorkerServices } from "@keymaster/plugin-sat-subscription/coordinator";
import { createChainHeightTask } from "@keymaster/plugin-woc/coordinator";
import { SAT_SUBSCRIPTION_SERVICE_CAPABILITY, SAT_SUBSCRIPTION_SPI_SERVICE_CAPABILITY, STORAGE_FILE_CLIENTS_CAPABILITY, STORAGE_KV_CLIENTS_CAPABILITY, P2PKH_ASSET_READER_CAPABILITY, WOC_BSV21_CAPABILITY, WOC_STAS_CAPABILITY, WOC_1SAT_ORDINALS_CAPABILITY, WOC_CAPABILITY, VAULT_WALLET_STATE_CAPABILITY } from "@keymaster/contracts";
import { BUILTIN_PLUGIN_DEFINITIONS } from "@keymaster/contracts";
import { createWorkerCryptoRpc, createWorkerActiveKeyCryptoFactory, createWorkerIdentityProjection, createWalletStateAccess, createWalletStateSource, createWorkerKeySession, signPrivateMessageForFixture } from "@keymaster/plugin-vault/coordinator";
import { STORAGE_PRIVATE_BROWSE_CAPABILITY, parseStorageBrowsePrivateResponse, removeRetiredPluginIntent, StorageBrowseCoordinator, type StorageBrowsePrivateCommand } from "@keymaster/platform-storage/assembly";
import { storagePrivateCapabilities } from "./assembly/storagePrivateCapabilities.js";
// apps/web/src/keymasterSessionCoordinator.worker.ts
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

import "./shims/buffer.js";

import type {
  CoordinatorOwnerStorageData,
  CoordinatorPlatformStorageData,
  StorageOwnerGrant,
  StoragePlatformGrant,
} from "@keymaster/contracts/storage-internal";
import type { SessionEpoch, CoordinatorVaultStatus, CoordinatorClientRequest as PublicCoordinatorClientRequest, CoordinatorResponse, CoordinatorTopicEvent, CoordinatorBootstrapSnapshot, CoordinatorTopic, CoordinatorCryptoOperation, CoordinatorBackgroundSyncSettings, CoordinatorTaskSnapshot, CoordinatorVaultOperation, CoordinatorSubscribeTopicsResult, CoordinatorTopicBaseline, AssetDataInvalidationEvent, SessionStateEvent, VaultSealedSecret, P2pkhProviderConfig, P2pkhProviderRegistry, P2pkhTransactionBroadcastProvider, P2pkhUtxoSnapshotResult, WindowP2pExecutorLease, WindowP2pIdentitySignResult, MsFileReadConcurrencySettings, CoordinatorSatStateEvent, CoordinatorChannelOperation, ChannelSubscriptionStatus, CoordinatorContactsPresenceEvent, CoordinatorWorkerUnitStateEvent, CoordinatorWorkerUnitPublicSnapshot, ChannelPrivateMessageEvent, ContactsService, SatWindowLaneOperation, SatWindowLaneSspRequestEvent, SatSubscriptionAdminService, SatSubscriptionService, SatSubscriptionSpiService, WindowP2pExecutorError, CoordinatorAuthorityRecovery, CoordinatorRpcRequest, CoordinatorRpcResponse, CoordinatorRpcCommandRequest, CoordinatorSessionOpenRequest, CoordinatorSessionCloseRequest, CoordinatorSessionBinding, CoordinatorTopicSubscription, SnapshotStore, StorageSnapshotJsonCompatible, PluginStorageDeclaration } from "@keymaster/contracts";
/** 可信 Worker 入口内的命令联合；私有浏览不进入公共 transport parser。 */
type CoordinatorClientRequest = PublicCoordinatorClientRequest | StorageBrowsePrivateCommand;

import { CENTRAL_STORAGE_DECLARATIONS, SYSTEM_STORAGE_DECLARATIONS, deriveAppStorageName, deriveThirdPartyStorageModuleId, coordinatorClientRequestFromRpc, parseCoordinatorResponseFor, isValidBackgroundSyncIntervalMs, emptyChainHeightSnapshot, BACKGROUND_TRIGGER_REASON, AUTO_LOCK_DEFAULT_TIMEOUT_MS, isValidAutoLockTimeoutMs, normalizeAutoLockTimeoutMs } from "@keymaster/contracts";
import { BUILTIN_PLUGIN_PRODUCT_ID_SET } from "@keymaster/contracts";
import {
  buildWalletStorageRoot,
} from "@keymaster/contracts";
import { COORDINATOR_SERVICE_CONTRACT_VERSION, COORDINATOR_SERVICE_PROTOCOL_VERSION } from "@keymaster/contracts";
import {
  COORDINATOR_RPC_CAPABILITY,
  COORDINATOR_TOPIC_STREAM_CAPABILITY,
  COORDINATOR_OWNER_STORAGE_RPC_CAPABILITY,
  COORDINATOR_PLATFORM_STORAGE_RPC_CAPABILITY,
  COORDINATOR_CRYPTO_RPC_CAPABILITY,
} from "@keymaster/contracts";
import { MSFILE_MAX_BLOCK_BYTES, MSFILE_MAX_SEED_BYTES, MSFILE_READ_CONCURRENCY_RECOMMENDED, MSFILE_SELLER_SETTINGS_DEFAULT, normalizeMsFileReadConcurrencySettings, SAT_SUBSCRIPTION_RESOURCE_LIMITS } from "@keymaster/contracts";
import { bytesToHex, installInsecureContextCryptoFallback, hexToBytes as cryptoHexToBytes, executeVaultOperation as executeOwnedVaultOperation, deriveP2pkhAddress } from "@keymaster/plugin-vault/coordinator";
// 不能通过 runtime barrel 导入：它 re-export React hooks，Vite 会把
// React Refresh 注入 SharedWorker，后者没有 window。
import { createMessageBus, definePlugin, startSharedWorkerApp, type UpgradeGate, type UpgradeIoLease, type UpgradeSession, type HandlerCallContext, type PeerController } from "webloom-framework";
import { createUpgradeGate } from "webloom-framework/advanced";

import { createFinalIoAudit, type FinalIoAuditOperation } from "./coordinator/finalIoAudit.js";
import { acquireCoordinatorAuthorityLock, type CoordinatorAuthorityLock } from "./coordinator/coordinatorAuthorityLock.js";
import {
  assertCoordinatorWorkerUnitCatalog,
  COORDINATOR_WORKER_UNIT_CATALOG,
  getCoordinatorWorkerUnitForTask,
} from "./coordinator/workerUnitCatalog.js";
import { createCoordinatorWorkerUnitRegistry } from "./coordinator/workerUnitRuntime.js";
import {
  COORDINATOR_TRANSPORT_UNIT_ID,
  describeUnitUnavailableForFramework,
  evaluateCoordinatorUnitAvailability,
  evaluateCoordinatorUnitConstructionPreconditions,
  evaluateCoordinatorUnitStartupPreconditions,
  isCoordinatorUnitUnavailableError,
  CoordinatorUnitUnavailableError,
  type CoordinatorUnitAvailabilityContext,
} from "./coordinator/workerUnitAvailability.js";
import { createWocService, createWocBsv21Service, createWocStasService, createWoc1SatOrdinalsService, registerWocP2pkhProviders } from "@keymaster/plugin-woc/coordinator";
import { createP2pkhProviderRegistry, createP2pkhUtxoSnapshotStore, p2pkhAddressToScriptHex, type P2pkhService, type P2pkhUtxoSnapshotResource, type P2pkhUtxoSnapshotStore } from "@keymaster/plugin-p2pkh/coordinator";
import { createP2pkhWorkerAssetReader, createP2pkhWorkerTaskDefinitions, createP2pkhFileRepository, openP2pkhStateRepository, createP2pkhStateRepository, disposeP2pkhStateRepository, parseP2pkhTransaction } from "@keymaster/plugin-p2pkh/coordinator";
import { createBsv21CoordinatorTask } from "@keymaster/plugin-token-bsv21/coordinator";
import { createStasCoordinatorTask } from "@keymaster/plugin-token-stas/coordinator";
import { createOrdinalsCoordinatorTask } from "@keymaster/plugin-collectible-1satordinals/coordinator";
import { createContactsPresenceTask, createContactsService } from "@keymaster/plugin-contacts/coordinator";
import type { BorrowedModuleFileStore, VaultWalletState, KeyValueStore, PlatformRootStore, VaultService, WocService, WocQueueSnapshot, BsvNetwork, ChainHeightSnapshot } from "@keymaster/contracts";
import type { KeyIdentity, WalletColdStartSnapshot, WalletInitializePlan, WalletInitializeResult, WalletLifecycleEvent, WalletLifecycleService } from "@keymaster/contracts";
import type { StorageNamespaceBinding } from "@keymaster/contracts";
import { WALLET_KEYHOLD_PATH, WALLET_META_PATH } from "@keymaster/contracts";
import type { StorageRuntimeController, StorageRuntimeControllerStatus, CoordinatorStorageControl, CoordinatorStorageStateEvent, CoordinatorMsFileControl, CoordinatorMsFileData, CoordinatorMsFileStateEvent, MsFileConnectAppContext, MsFileErrorCode, AssetDataChangedEvent, WocUtxoResponse } from "@keymaster/contracts";
import {
  createScopedStorageClients, createStorageGrantAuthority, createStorageRpcHandlers, createWorkerStorageClients, createStorageDataExecutor,
  createStorageRuntimeController,
  createPlatformRootStore,
  createIndexedDbWalletStore, createWalletStoreActivity, createStorageDataQueue, STORAGE_DATA_CONCURRENCY, STORAGE_DATA_MAX_QUEUE,
  StorageRuntimeError,
} from "@keymaster/platform-storage/coordinator";
import type { WalletStore } from "@keymaster/contracts/storage-internal";
import { createWalletLifecycleService, createWalletKeyRepository, type WalletKeyRepository } from "@keymaster/plugin-vault/coordinator";
import type { StoragePrivateRootStore } from "@keymaster/platform-storage/coordinator";
import { WALLET_LIST_MAX_LIMIT } from "@keymaster/platform-storage/coordinator";

import { installSharedWorkerRetirement } from "./coordinator/sharedWorkerRetirement.js";
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
import { createMsfileDataExecutor, createMsfileDataQueue, storeMsFileSeed, type BitfsSellerProtocolPort, type BitfsSellerStreamTransport, type MsFileServiceImpl } from "@keymaster/plugin-msfile/coordinator";
import {
  buildWindowP2pConcurrencyConfig,
  createWindowP2pMsFileTransport,
} from "@keymaster/plugin-msfile/executor-transport";
import type {
  WindowP2pExecutorConcurrencyConfig,
  WindowP2pExecutorOperation,
} from "@keymaster/contracts/window-p2p";
// 施工单 2026-08-26/001：identity/signing 的 payload 与 Peer Record 编码必须来自
// bitcoin-libp2p；Worker 只持有 active private key 并做标准 DER 签名。
import {
  noiseSigningPayload,
  peerIdFromPublicKeyBytes,
  parsePeerId,
  peerRecordUnsigned,
  sha256Bytes,
  validatePublicKey,
} from "bitcoin-libp2p/identity";
// Channel 密码学和固定 inbox 路由只在 SharedWorker 调用；Window executor
// 只看 SSP wire，不会收到私钥或明文。
import { inboxChannel, newMessageID, parsePublicKey } from "bsv8-channel-protocol";
import { PING_PRIVATE_MESSAGE_MAX_LIFETIME_MS } from "bsv8-channel-protocol/inbox";





import { HASH_REQUEST_CHANNEL } from "bsv8-channel-protocol/hash-request";
import { ChannelSubscriptionMux, validateExactChannel } from "@keymaster/plugin-sat-subscription/coordinator";
import { createChannelProtocolRelations } from "@keymaster/plugin-sat-subscription/coordinator";
import { MAX_WIRE_BYTES } from "sat-subscription-protocol/protocol";

import { configureProtocolStorageRepository, getConnectSession as getAuthoritativeConnectSession, isVerifiedAppIdentitySnapshot } from "@keymaster/plugin-protocol/coordinator";
import { type SatSubscriptionProvider, type SatSubscriptionStateStore, type SatSubscriptionRepository, type SatDefaultNetwork, type SatSupplierConnection, SatSubscriptionHandle } from "@keymaster/plugin-sat-subscription/coordinator";


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
  p2pkhSettings: { includeTestnet: boolean };
}
/** 桶级 Coordinator snapshot 持久化同步管理 + 自动锁；P2PKH 偏好归 owner 的 setting.json。 */
type CoordinatorSettingsSnapshot = Pick<CoordinatorRuntimeSettings, "scheduleSettings" | "autoLockTimeoutMs">;
function defaultCoordinatorRuntimeSettings(): CoordinatorRuntimeSettings {
  return {
    scheduleSettings: { taskIntervals: {} },
    autoLockTimeoutMs: AUTO_LOCK_DEFAULT_TIMEOUT_MS,
    p2pkhProviderConfigs: {},
    p2pkhSettings: { includeTestnet: false },
  };
}
const coordinatorMeta: CoordinatorRuntimeSettings = defaultCoordinatorRuntimeSettings();
function makeCoordinatorAuthorityInstanceId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `coordinator:${crypto.randomUUID()}`;
    }
  } catch {
    // Worker 启动身份只用于区分本次内存实例；缺失 Web Crypto 时仍保持唯一格式。
  }
  return `coordinator:${Date.now().toString(36)}:${randomIdentifierSuffix()}`;
}
/** 每次 Worker 载入生成一次；Worker 重启后必须变化。 */
let coordinatorAuthorityInstanceId = makeCoordinatorAuthorityInstanceId();
// 正式构建由 scripts/build-plugin-lifecycle.mjs 注入不可变 buildId。
// 本地开发/单测没有构建注入时才回退到模块 URL；该回退不能用于发布证据。
const COORDINATOR_BUILD_ID = import.meta.env.VITE_KEYMASTER_BUILD_ID ?? import.meta.url;
// 跨 Worker 的发布/回退由 Keymaster authority Web Lock 与部署交接协议控制；
// 这里仅保留协议字段，供本次 Worker 的内存 gate 和旧页面/旧授权迟到检查使用。
const COORDINATOR_UPGRADE_PROTOCOL_VERSION = COORDINATOR_SERVICE_PROTOCOL_VERSION;

interface CoordinatorAuthorityRecord {
  /** 记录格式版本，便于未来迁移而不把未知值当成当前权威。 */
  version: 1;
  /** 当前 Coordinator Worker 启动身份。 */
  authorityInstanceId: string;
  /** 当前 Worker 内单调递增的运行世代；不是跨 Worker 的持久版本。 */
  handoverGeneration: number;
  /** 当前 Worker 构建产物标识。 */
  buildId: string;
  /** 当前升级控制协议版本。 */
  protocolVersion: string;
  /** 当前 Worker 已进入最终 I/O 边界但尚未结束的内存租约。 */
  activeIoLeases: Record<string, {
    operation: "read" | "write";
    acquiredAt: number;
    /** 固定的最终 I/O 入口名，只用于当前运行时诊断。 */
    auditOperation?: FinalIoAuditOperation;
  }>;
}

interface CoordinatorFinalIoLease {
  leaseId: string;
  /** 释放时必须使用取得 lease 时捕获的身份，不能读取当前 Worker 的新身份。 */
  authorityInstanceId: string;
  handoverGeneration: number;
  release(): Promise<void>;
}

let coordinatorHandoverGeneration = 0;
let coordinatorAuthorityRecord: CoordinatorAuthorityRecord | undefined;
/** 当前物理 Worker 持有的 Keymaster origin 级跨 Worker authority。 */
let coordinatorAuthorityLock: CoordinatorAuthorityLock | undefined;
/** 兼容旧快照字段；新版不从业务 K-V 恢复旧 Worker 的临时租约。 */
let coordinatorAuthorityRecovery: CoordinatorAuthorityRecovery | undefined;
/** 兼容旧诊断字段；新版仅保留当前运行时内的固定入口名。 */
let coordinatorAuthorityRecoveryOperationNames: string[] = [];
let coordinatorAuthorityClaimTail: Promise<void> = Promise.resolve();
/**
 * 同一 Coordinator 内的并发只读请求共用一个内存 read lease。
 *
 * Keymaster authority Web Lock 负责不同物理 Worker 的唯一性；这里仅在
 * 当前 Worker 内聚合 read 引用，避免每个无副作用的 Stat 都重复做内存
 * admission。
 */
interface CoordinatorSharedReadLease {
  ioLease: CoordinatorFinalIoLease;
  authorityInstanceId: string;
  handoverGeneration: number;
  references: number;
}
let coordinatorSharedReadLease: CoordinatorSharedReadLease | undefined;
let coordinatorSharedReadLeaseTail: Promise<void> = Promise.resolve();
let coordinatorUpgradeGate: UpgradeGate | undefined;
let coordinatorUpgradeSession: UpgradeSession | undefined;
let keyDeletionTail: Promise<void> = Promise.resolve();
let p2pkhRegistry: P2pkhProviderRegistry | undefined;
let p2pkhWocService: ReturnType<typeof createWocService> | undefined;
let p2pkhWorkerWocQuery: WocService | undefined;
let p2pkhWorkerPorts: { storage: BorrowedModuleFileStore; walletState: VaultWalletState; crypto: VaultWorkerCrypto; assertActive(): void } | undefined;
let satWorkerP2pkhAccess: (() => Promise<P2pkhWorkerTransfer | null>) | undefined;
let coordinatorDomainMessageBus: ReturnType<typeof createMessageBus> | undefined;
let p2pkhUtxoSnapshots: P2pkhUtxoSnapshotStore | undefined;
/**
 * Worker 内唯一链高度读数（2026-09-26）。
 * 真值只来自节点 `/chain/info`；读取失败保留旧值并保持 available=true，
 * 首次成功之前为 available=false。消费者必须先看 available。
 */
let coordinatorChainHeight: ChainHeightSnapshot = emptyChainHeightSnapshot();
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
const storageActivity = createWalletStoreActivity(() => {
  if (!lastStorageState) return;
  const state = { ...lastStorageState, storageRevision: ++storageRevision, activity: storageActivity.snapshot() };
  lastStorageState = state; publishTopicEvent("storage.state", state);
});
let walletStore: WalletStore | undefined;
/** 固定 `key.json` 的唯一仓储；没有 list/readAll/delete，也没有切换。 */
let walletKeys: WalletKeyRepository | undefined;
/** 单钱包生命周期：冷启动、创建/导入、解锁、锁定、改密、改名、导出与重置。 */
let walletLifecycle: WalletLifecycleService | undefined;
/** 当前已装配的平台存储根；重置或 Worker 重启后重建。 */
let platformRootStore: StoragePrivateRootStore | undefined;
/** Root 安装令牌；不能用 walletGeneration 代替，因为重置后可能复用世代值。 */
let platformRootToken: object | undefined;
let coordinatorSettingsSnapshot: SnapshotStore<CoordinatorSettingsSnapshot> | undefined;
/** Protocol 的三个 platform-only purpose K-V。 */
interface CoordinatorProtocolStorageStores {
  durablePolicy: KeyValueStore;
  sessions: KeyValueStore;
  commandHistory: KeyValueStore;
}
let coordinatorProtocolStores: CoordinatorProtocolStorageStores | undefined;
let platformStorageReady = false;
let storageRootInstallationActive = false;
/** 冷启动只读结果；corrupt/unsupported 时进入明确错误界面，不静默建空钱包。 */
let storageColdStartState: WalletColdStartSnapshot | undefined;
let coordinatorInitializationInProgress = false;
/** 仅供 Worker 测试 seam 使用；生产路径没有 active-key 密码缓存。 */
let testHarnessActivationSecret: string | undefined;

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

const storageKeyValueMaintenance = createKeyValueMaintenance({ root: () => platformRootStore, rootToken: () => platformRootToken, isReady: () => platformStorageReady, ownerGrants: () => ownerStorageGrants.values() });
const registerCoordinatorKeyValueMaintenanceStore = storageKeyValueMaintenance.register;
const unregisterCoordinatorKeyValueMaintenanceStore = storageKeyValueMaintenance.unregister;
const stopCoordinatorKeyValueMaintenance = storageKeyValueMaintenance.stop;
const scheduleCoordinatorKeyValueMaintenance = storageKeyValueMaintenance.schedule;

/** 测试专用：执行一次与定时任务相同的受控最终清扫。 */
export async function __testCollectCoordinatorKeyValueGarbage(): Promise<void> { await storageKeyValueMaintenance.collectNow(); }

/** 测试专用：在测试本地介质的一个 K-V 句柄里制造可回收孤儿。 */
export async function __testSeedCoordinatorKeyValueGarbage(): Promise<string> {
  const store = walletStore;
  if (!store || !platformRootStore) throw new Error("Test Coordinator garbage storage is not ready");
  const declaration = CENTRAL_STORAGE_DECLARATIONS.bsvPrice;
  const handle = await platformRootStore.openPlatformStore({ declaration });
  const valuePrefix = `${buildWalletStorageRoot({
    authority: declaration.authority,
    moduleId: declaration.moduleId,
    purposeId: declaration.purposeId,
  })}.keymaster/values/`;
  const listValueIds = async (): Promise<Set<string>> => {
    const valueIds = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const page = await store.list({ prefix: valuePrefix, ...(cursor === undefined ? {} : { cursor }), limit: WALLET_LIST_MAX_LIMIT });
      for (const object of page.objects) valueIds.add(object.path);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return valueIds;
  };
  const before = await listValueIds();
  try {
    const key = `gc-orphan-${crypto.randomUUID()}`;
    await handle.put(key, { source: "coordinator-gc-test" }, { partition: "gc-test" });
    // value object 的文件名是内容哈希，不是业务 key：靠 put 前后差集才能拿到
    // 那个被 delete 变成孤儿的真实路径。
    const created = [...(await listValueIds())].filter((path) => !before.has(path));
    if (created.length !== 1) throw new Error(`Test Coordinator garbage expected one new value object, saw ${created.length}`);
    await handle.delete(key, { partition: "gc-test" });
    return created[0]!;
  } finally {
    // The next collection must discover this namespace through declarations,
    // not through a resident handle retained in the Coordinator registry.
    handle.close();
  }
}

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

/** 当前 grant 的撤销栅栏：锁、改密、重置和撤权让已发放句柄 fail closed。 */
function platformRootBindingIsCurrent(binding: StorageNamespaceBinding): boolean {
  if (platformRootToken === undefined) return false;
  if (binding.walletGeneration !== coordinatorState.walletGeneration) return false;
  return true;
}

/**
 * 装配当前钱包的存储根。
 *
 * 只有 IndexedDB 是正式介质：没有 Provider 选择、没有桶、没有远程连接。
 * 候选 Root 在提交前完全不可见，提交后才让旧句柄失效。
 */
async function installPlatformStorage(): Promise<void> {
  const previousRootToken = platformRootToken;
  const rootToken = {};
  let candidatePublished = false;
  let candidateSettingsSnapshot: SnapshotStore<CoordinatorSettingsSnapshot> | undefined;
  let candidateProtocol: CoordinatorProtocolStorageStores | undefined;
  try {
    if (!walletStore) throw new StorageRuntimeError("storage_unavailable", "Wallet storage is not available");
    const storage = walletStore;
    await withCoordinatorFinalIoLease("write", undefined, () => removeRetiredPluginIntent(storage), {
      allowLocalLock: true, auditOperation: "storage.retired-plugin-intent.cleanup",
    });
    const root = createPlatformRootStore({
      store: walletStore,
      generations: () => ({
        walletGeneration: coordinatorState.walletGeneration,
        sessionEpoch: coordinatorState.sessionEpoch,
        runGeneration: coordinatorState.runGeneration,
      }),
      isCurrent: platformRootBindingIsCurrent,
    });
    const settingsSnapshot = await root.openPlatformSnapshot({ declaration: CENTRAL_STORAGE_DECLARATIONS.coordinatorSettings, validate: validateCoordinatorSettingsSnapshot });
    candidateSettingsSnapshot = settingsSnapshot;
    const protocol = await openCoordinatorProtocolStorageStores(root);
    candidateProtocol = protocol;

    // 到这里为止只使用候选 Root；Hold、Vault 和后续恢复仍未能看到半成品。
    // 提交前才切换全局句柄，并释放上一代平台句柄。
    coordinatorSettingsSnapshot?.close();
    platformRootToken = rootToken;
    candidatePublished = true;
    configureProtocolStorageRepository(protocol);
    platformRootStore = root;
    registerCoordinatorProtocolMaintenanceStores(protocol);
    coordinatorSettingsSnapshot = settingsSnapshot;
    coordinatorProtocolStores = protocol;
    platformStorageReady = true;
    scheduleCoordinatorKeyValueMaintenance();
  } catch (error) {
    if (!candidatePublished) {
      closeCoordinatorProtocolStorageStores(candidateProtocol);
      candidateSettingsSnapshot?.close();
      if (platformRootToken === rootToken) platformRootToken = previousRootToken;
    }
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
    root: platformRootStore,
    rootToken: platformRootToken,
    settingsSnapshot: coordinatorSettingsSnapshot,
    protocol: coordinatorProtocolStores,
    runtime: storageController as (StorageRuntimeController & { dispose?: () => void }) | undefined,
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
  coordinatorMeta.p2pkhSettings ??= { includeTestnet: false };
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

/** Storage 持有浏览实现/授权/句柄；Coordinator 只提供真实会话和最终 I/O 边界。 */
const storageBrowseCoordinator = new StorageBrowseCoordinator({
  root: () => platformRootStore && platformRootToken && platformStorageReady
    ? { store: platformRootStore, token: platformRootToken } : undefined,
  generations: () => ({ walletGeneration: coordinatorState.walletGeneration,
    sessionEpoch: coordinatorState.sessionEpoch, runGeneration: coordinatorState.runGeneration }),
  isUnlocked: () => coordinatorState.vaultStatus === "unlocked",
  isPeerOpen: peerId => {
    const state = coordinatorPeerState(peerId);
    return Boolean(state?.sessionOpen && state.status === "open" && state.peer.scope.state === "active"
      && state.sessionBinding && state.openCommitOrder !== undefined);
  },
  isPeerRevoked: peerId => revokedCoordinatorPeerIds.has(peerId),
  withReadLease: task => withCoordinatorFinalIoLease("read", undefined, task, { auditOperation: "storage.browse" }),
});

/** 撤销当前存储根：所有已发放句柄与迟到结果立即失效。 */
function discardCurrentPlatformStorageBinding(): void {
  stopCoordinatorKeyValueMaintenance();
  storageBrowseCoordinator.dropBinding();
  const binding = captureCurrentPlatformStorageBinding();
  workerStorageClients.invalidateAll();
  disposeCurrentPlatformStorageBinding(binding);
  platformRootStore = undefined;
  platformRootToken = undefined;
  coordinatorSettingsSnapshot = undefined;
  coordinatorProtocolStores = undefined;
  storageController = undefined;
  platformStorageReady = false;
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

function coordinatorUpgradeError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** 业务 K-V CAS 冲突判断；只服务 bucket/profile 等业务状态，不用于运行锁。 */
function isStorageConflict(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  return code === "storage_conflict"
    || (error instanceof Error && /partition revision changed|concurrently|conflict/i.test(error.message));
}

async function readCoordinatorAuthorityRecord(): Promise<CoordinatorAuthorityRecord | undefined> {
  // authority record 的诊断字段只存在当前 Worker 内存；真正的跨 Worker
  // 唯一性由 Keymaster 自己持有的 origin 级 authority Web Lock 保证，不能
  // 从 Local/S3 业务 K-V 恢复一把已经失去上下文的临时锁。
  return coordinatorAuthorityRecord;
}

/**
 * 声明当前 Worker 的内存运行权威。
 *
 * 跨物理 Worker 的唯一性由 Keymaster authority Web Lock 负责；这里的随机
 * 身份只用于旧页面、旧授权和迟到结果检查，不依赖 Vault 状态，也不写
 * Local/S3 authority。锁冲突或 API 缺失必须在建立本地 record 前失败。
 */
async function claimCoordinatorAuthority(): Promise<void> {
  if (!coordinatorAuthorityLock) {
    coordinatorAuthorityLock = await acquireCoordinatorAuthorityLock();
  }
  // authority lock 会保持到当前 Worker 退场；这里的随机身份和内存世代
  // 供旧页面/旧授权拒绝以及本地 gate 做迟到检查，不把活动 I/O 写入业务桶。
  coordinatorHandoverGeneration += 1;
  coordinatorAuthorityRecord = {
    version: 1,
    authorityInstanceId: coordinatorAuthorityInstanceId,
    handoverGeneration: coordinatorHandoverGeneration,
    buildId: COORDINATOR_BUILD_ID,
    protocolVersion: COORDINATOR_UPGRADE_PROTOCOL_VERSION,
    activeIoLeases: {},
  };
  coordinatorAuthorityRecovery = undefined;
  coordinatorAuthorityRecoveryOperationNames = [];
  return;
}

let coordinatorAuthorityClaimInFlight: Promise<void> | undefined;

/** 串行化 claim；reset/并发 hello 不应在同一启动身份内重复消耗世代。 */
function scheduleCoordinatorAuthorityClaim(): Promise<void> {
  if (coordinatorAuthorityClaimInFlight) return coordinatorAuthorityClaimInFlight;
  const run = coordinatorAuthorityClaimTail.then(
    () => claimCoordinatorAuthority(),
    () => claimCoordinatorAuthority(),
  );
  coordinatorAuthorityClaimInFlight = run;
  coordinatorAuthorityClaimTail = run.then(() => undefined, () => undefined);
  run.then(
    () => { if (coordinatorAuthorityClaimInFlight === run) coordinatorAuthorityClaimInFlight = undefined; },
    () => { if (coordinatorAuthorityClaimInFlight === run) coordinatorAuthorityClaimInFlight = undefined; },
  );
  return run;
}

async function ensureCoordinatorAuthorityClaim(): Promise<void> {
  await coordinatorAuthorityClaimTail;
  if (
    coordinatorAuthorityRecord?.authorityInstanceId === coordinatorAuthorityInstanceId
    && coordinatorAuthorityRecord.handoverGeneration === coordinatorHandoverGeneration
  ) return;

  await scheduleCoordinatorAuthorityClaim();
  if (
    coordinatorAuthorityRecord?.authorityInstanceId !== coordinatorAuthorityInstanceId
    || coordinatorAuthorityRecord.handoverGeneration !== coordinatorHandoverGeneration
  ) throw coordinatorUpgradeError("upgrade.authority_stale", "Coordinator authority claim is stale");
}

async function assertCoordinatorAuthorityCurrent(): Promise<void> {
  await ensureCoordinatorAuthorityClaim();
  const current = await readCoordinatorAuthorityRecord();
  if (
    !coordinatorAuthorityLock
    || !current
    || current.authorityInstanceId !== coordinatorAuthorityInstanceId
    || current.handoverGeneration !== coordinatorHandoverGeneration
    || current.buildId !== COORDINATOR_BUILD_ID
    || current.protocolVersion !== COORDINATOR_UPGRADE_PROTOCOL_VERSION
  ) {
    throw coordinatorUpgradeError("upgrade.authority_stale", "Coordinator authority is no longer current");
  }
}

function makeCoordinatorFinalIoLeaseId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `coordinator-io:${crypto.randomUUID()}`;
    }
  } catch {
    // leaseId 只是防止两个释放操作误删彼此的内存记录；身份与世代仍会校验。
  }
  return `coordinator-io:${Date.now().toString(36)}:${randomIdentifierSuffix()}`;
}

/** 在当前 Worker 内存中登记一次最终 I/O；不产生业务 K-V commit。 */
async function acquireCoordinatorFinalIoLeaseExclusive(
  operation: "read" | "write",
  auditOperation?: FinalIoAuditOperation,
): Promise<CoordinatorFinalIoLease> {
  // I/O 租约只表示当前 Worker 内存中的排空计数；WebLoom 已经在浏览器
  // 级别负责 typed transport，但不负责跨构建互斥。Keymaster authority
  // Web Lock 已在 Worker claim 阶段取得并持续持有；这里再确认它存在，
  // 才允许进入最终 I/O。
  await assertCoordinatorAuthorityCurrent();
  const record = coordinatorAuthorityRecord;
  if (!record) throw coordinatorUpgradeError("upgrade.authority_unavailable", "Coordinator runtime authority is unavailable");
  const leaseId = makeCoordinatorFinalIoLeaseId();
  record.activeIoLeases[leaseId] = {
    operation,
    acquiredAt: Date.now(),
    ...(auditOperation ? { auditOperation } : {}),
  };
  let released = false;
  return {
    leaseId,
    authorityInstanceId: record.authorityInstanceId,
    handoverGeneration: record.handoverGeneration,
    release: async () => {
      if (released) return;
      released = true;
      delete record.activeIoLeases[leaseId];
    },
  };
}

function withCoordinatorSharedReadLeaseMutation<T>(operation: () => Promise<T>): Promise<T> {
  const run = coordinatorSharedReadLeaseTail.then(operation, operation);
  coordinatorSharedReadLeaseTail = run.then(() => undefined, () => undefined);
  return run;
}

function hasCurrentCoordinatorSharedReadLease(): boolean {
  return coordinatorSharedReadLease !== undefined
    && coordinatorSharedReadLease.references > 0
    && coordinatorSharedReadLease.authorityInstanceId === coordinatorAuthorityInstanceId
    && coordinatorSharedReadLease.handoverGeneration === coordinatorHandoverGeneration;
}

/**
 * 读请求按本地 Coordinator 聚合内存 lease；写请求仍是一请求一 lease。
 * 每个返回对象都有独立幂等 release，最后一个读请求才释放内存记录。
 */
async function acquireCoordinatorFinalIoLease(
  operation: "read" | "write",
  auditOperation?: FinalIoAuditOperation,
): Promise<CoordinatorFinalIoLease> {
  if (operation === "write") return acquireCoordinatorFinalIoLeaseExclusive(operation, auditOperation);
  return withCoordinatorSharedReadLeaseMutation(async () => {
    const existing = coordinatorSharedReadLease;
    const authorityInstanceId = coordinatorAuthorityInstanceId;
    const handoverGeneration = coordinatorHandoverGeneration;
    if (
      existing
      && existing.authorityInstanceId === authorityInstanceId
      && existing.handoverGeneration === handoverGeneration
    ) {
      existing.references += 1;
      let released = false;
      return {
        leaseId: `${existing.ioLease.leaseId}:${existing.references}`,
        authorityInstanceId,
        handoverGeneration,
        release: async () => {
          if (released) return;
          released = true;
          await withCoordinatorSharedReadLeaseMutation(async () => {
            existing.references = Math.max(0, existing.references - 1);
            if (existing.references !== 0) return;
            if (coordinatorSharedReadLease === existing) coordinatorSharedReadLease = undefined;
            await existing.ioLease.release();
          });
        },
      };
    }

    // 只会在测试 reset / 本地重建后遇到不匹配对象；旧对象的在途请求仍
    // 持有自己的引用，等它们 finally 释放，不能在这里强行改写新世代。
    const ioLease = await acquireCoordinatorFinalIoLeaseExclusive("read", auditOperation);
    const shared: CoordinatorSharedReadLease = {
      ioLease,
      authorityInstanceId: ioLease.authorityInstanceId,
      handoverGeneration: ioLease.handoverGeneration,
      references: 1,
    };
    coordinatorSharedReadLease = shared;
    let released = false;
    return {
      leaseId: `${ioLease.leaseId}:1`,
      authorityInstanceId: ioLease.authorityInstanceId,
      handoverGeneration: ioLease.handoverGeneration,
      release: async () => {
        if (released) return;
        released = true;
        await withCoordinatorSharedReadLeaseMutation(async () => {
          shared.references = Math.max(0, shared.references - 1);
          if (shared.references !== 0) return;
          if (coordinatorSharedReadLease === shared) coordinatorSharedReadLease = undefined;
          await shared.ioLease.release();
        });
      },
    };
  });
}

async function ensureCoordinatorUpgradeSession(): Promise<void> {
  await ensureCoordinatorAuthorityClaim();
  if (
    coordinatorUpgradeGate
    && coordinatorUpgradeSession
    && coordinatorUpgradeGate.authorityInstanceId === coordinatorAuthorityInstanceId
    && coordinatorUpgradeGate.handoverGeneration === coordinatorHandoverGeneration
    && coordinatorUpgradeGate.state === "active"
    && !coordinatorUpgradeSession.revoked
  ) return;

  coordinatorUpgradeGate?.close("Coordinator upgrade session replaced");
  const gate = createUpgradeGate({
    protocolVersion: COORDINATOR_UPGRADE_PROTOCOL_VERSION,
    buildId: COORDINATOR_BUILD_ID,
    authorityInstanceId: coordinatorAuthorityInstanceId,
    handoverGeneration: coordinatorHandoverGeneration,
    supportedContractVersions: [COORDINATOR_SERVICE_CONTRACT_VERSION],
    mode: "cold-switch",
  });
  const connectionId = `coordinator-final-io:${coordinatorAuthorityInstanceId}:${coordinatorHandoverGeneration}`;
  const handshake = gate.handshake({
    connectionId,
    protocolVersion: COORDINATOR_UPGRADE_PROTOCOL_VERSION,
    buildId: COORDINATOR_BUILD_ID,
    authorityInstanceId: coordinatorAuthorityInstanceId,
    handoverGeneration: coordinatorHandoverGeneration,
    supportedContractVersions: [COORDINATOR_SERVICE_CONTRACT_VERSION],
  });
  if (!handshake.accepted) {
    gate.close("Coordinator upgrade handshake rejected");
    throw coordinatorUpgradeError("upgrade.handshake_rejected", `Coordinator upgrade handshake rejected: ${handshake.reason}`);
  }
  coordinatorUpgradeGate = gate;
  coordinatorUpgradeSession = handshake.session;
}

async function withCoordinatorFinalIoLease<T>(
  operation: "read" | "write",
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
  options: {
    allowLocalLock?: boolean;
    allowLocalOwnerTransition?: boolean;
    /** 当前 control 已完成本地桶清理，Root 会在 lease 释放后销毁。 */
    allowLocalBindingDiscard?: boolean;
    auditOperation?: FinalIoAuditOperation;
    /** 是否登记当前 Worker 的内存 admission 计数；默认 true。 */
    durableLease?: boolean;
  } = {},
): Promise<T> {
  await ensureCoordinatorUpgradeSession();
  // 共享 read lease 只表示当前 Worker 已持有 Keymaster 的 origin 级
  // authority lock 并通过本地检查；高频只读请求无需重复登记内存计数。
  if (operation !== "read" || !hasCurrentCoordinatorSharedReadLease()) {
    await assertCoordinatorAuthorityCurrent();
  }
  const gate = coordinatorUpgradeGate;
  const session = coordinatorUpgradeSession;
  if (!gate || !session) throw coordinatorUpgradeError("upgrade.gate_unavailable", "Coordinator upgrade gate is unavailable");
  const initialSessionEpoch = coordinatorState.sessionEpoch;
  const initialRunGeneration = coordinatorState.runGeneration;
  const lease: UpgradeIoLease = gate.admit({ session, operation, signal });
  let ioLease: CoordinatorFinalIoLease | undefined;
  let audit: ReturnType<ReturnType<typeof createFinalIoAudit>["begin"]> | undefined;
  let operationError: unknown;
  try {
    lease.assertActive();
    // 本地 UpgradeGate 和内存 I/O lease 负责当前 Worker 的 admission/drain；
    // 跨 Worker 的唯一性由 Keymaster authority lock 保证。没有这把锁时
    // assertCoordinatorAuthorityCurrent 已经 fail closed，不能降级继续跑。
    if (options.durableLease !== false) {
      ioLease = await acquireCoordinatorFinalIoLease(operation, options.auditOperation);
    }
    lease.assertActive();
    audit = options.auditOperation ? finalIoAudit.begin(options.auditOperation) : undefined;
    const result = await run(lease.signal);
    // 某些有意完成锁定的 Vault 操作会在 callback 内关闭旧 gate，并由
    // performGlobalLock 建立新的 locked gate。此时旧 lease 被本地安全锁定
    // 撤销是预期结果；仍必须重新检查共享 authority，外部接管不能走这条
    // 放宽路径。
    const localLockReplacedGate = options.allowLocalLock === true
      && gate.state === "closed"
      && coordinatorUpgradeGate !== gate
      && (coordinatorState.vaultStatus === "locked" || coordinatorState.vaultStatus === "uninitialized");
    const localOwnerTransitionReplacedGate = options.allowLocalOwnerTransition === true
      && gate.state === "closed"
      && coordinatorUpgradeGate !== gate
      && coordinatorState.vaultStatus === "unlocked"
      && (coordinatorState.sessionEpoch !== initialSessionEpoch || coordinatorState.runGeneration !== initialRunGeneration);
    // 单 Key 本地存储没有「丢弃目录绑定」这一过渡态：Root 要么有效要么已被撤销。
    const localBindingDiscard = false;
    if (!localLockReplacedGate && !localOwnerTransitionReplacedGate && !localBindingDiscard) lease.assertActive();
    // Root 销毁会在 finally 中、本地 lease 释放后执行；不读取业务桶里的
    // 临时 authority 记录。
    if (!localBindingDiscard) await assertCoordinatorAuthorityCurrent();
    audit?.finish("completed");
    return result;
  } catch (error) {
    operationError = error;
    audit?.finish(operation === "write" ? "unknown" : "failed");
    throw error;
  } finally {
    let releaseError: unknown;
    try {
      await ioLease?.release();
    } catch (error) {
      releaseError = error;
    }
    lease.release();
    if (releaseError && operationError === undefined) throw releaseError;
    if (releaseError) {
      console.error("[coordinator] final I/O lease release failed", releaseError);
    }
  }
}

function closeCoordinatorUpgradeSession(reason: string): void {
  coordinatorUpgradeGate?.close(reason);
  coordinatorUpgradeGate = undefined;
  coordinatorUpgradeSession = undefined;
}

let testStorageSessionResolver: ((sessionId: string) => Promise<{ sessionId: string; origin: string; ownerPublicKeyHex?: string; appIdentity: import("@keymaster/contracts").OwnerAppStorageGrant["appIdentity"]; revokedAt: number | null } | null>) | undefined;

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

async function readProtocolConnectSession(sessionId: string): Promise<{ sessionId: string; origin: string; ownerPublicKeyHex: string; appIdentity: import("@keymaster/contracts").OwnerAppStorageGrant["appIdentity"]; revokedAt: number | null } | null> {
  if (testStorageSessionResolver) {
    const resolved = await testStorageSessionResolver(sessionId);
    return resolved && resolved.revokedAt === null && Boolean(resolved.sessionId && resolved.origin) && isValidStorageIdentity(resolved.appIdentity)
      ? { sessionId: resolved.sessionId, origin: resolved.origin, ownerPublicKeyHex: resolved.ownerPublicKeyHex ?? "", appIdentity: resolved.appIdentity, revokedAt: null }
      : null;
  }
  if (!sessionId) return null;
  const record = await getAuthoritativeConnectSession(sessionId);
  return record && isValidStorageIdentity(record.appIdentity)
    ? { sessionId: record.sessionId, origin: record.origin, ownerPublicKeyHex: record.ownerPublicKeyHex, appIdentity: record.appIdentity, revokedAt: null }
    : null;
}

function normalizedCoordinatorOwner(): string | null {
  return coordinatorState.vaultStatus === "unlocked" && coordinatorState.activePublicKeyHex
    ? coordinatorState.activePublicKeyHex.trim().toLowerCase()
    : null;
}

/** 将 Worker 内唯一 Contacts 在线真值投影为页面可订阅的快照事件。 */
function publishCoordinatorContactsPresence(): void { contactsPresenceProjection.publish(); }

function publishSessionState(cause: SessionStateEvent["cause"]): void {
  // 服务目录与 owner/session 可见性共享同一状态提交点。锁定、解锁、换
  // Key、Storage Root 重绑都会改变 identity；先同步撤权/旋转 exposure，
  // 再广播业务状态，避免页面看到已 unlocked 但仍持有旧 service proxy。
  reconcileCoordinatorSessionExposures();
  const state: SessionStateEvent = {
    topic: "session.state",
    type: "session.state.changed",
    cause,
    sessionRevision: 0,
    sessionEpoch: coordinatorState.sessionEpoch,
    vaultStatus: coordinatorState.vaultStatus,
    activePublicKeyHex: coordinatorState.vaultStatus === "unlocked" ? coordinatorState.activePublicKeyHex ?? null : null,
    ...(coordinatorState.vaultStatus === "unlocked" ? { activeKeyIdentity: coordinatorActiveKeySummary() } : {}),
    runGeneration: coordinatorState.runGeneration,
    ...(coordinatorState.walletGeneration ? { walletGeneration: coordinatorState.walletGeneration } : {}),
    autoLockTimeoutMs: coordinatorMeta.autoLockTimeoutMs ?? AUTO_LOCK_DEFAULT_TIMEOUT_MS,
    ...(coordinatorAuthorityRecovery ? { authorityRecovery: coordinatorAuthorityRecovery } : {}),
  };
  publishTopicEvent("session.state", state);
  workerWalletState.publish();
  publishCoordinatorContactsPresence();
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
  taskRuntimes: Map<string, TaskRuntime>;
  scheduleSettings: CoordinatorBackgroundSyncSettings;
  autoLockTimeoutMs: number;
  autoLockDeadline?: number;
  lastActivityAt: number;
}

/** 重新生成运行世代；用于让所有已发放句柄立即 fail closed。 */
function rotateCoordinatorRunGeneration(): void {
  coordinatorState.runGeneration = crypto.randomUUID();
}

let storageController: StorageRuntimeController | undefined;
let storageRecoveryOrchestrator: Promise<void> | undefined;
// Test-only seams keep worker ownership/dispatch tests independent from
// IndexedDB and platform K-V persistence.
let testStorageRuntimeOverride: StorageRuntimeController | undefined;
let testStorageStartupFailure = false;
let storageStartupFailure = false;
let storageRevision = 0;
let msfileRevision = 0;
let lastStorageState: CoordinatorStorageStateEvent | undefined;
let storageStateTail: Promise<void> = Promise.resolve();
const storageRequests = new Map<string, { controller: AbortController; clientId: string; connectSessionId?: string }>();
const storageRequestKey = (clientId: string, requestId: string): string => `${clientId}\u0000${requestId}`;
const storagePortCounts = new Map<string, number>();
const storageGrantAuthority = createStorageGrantAuthority({
  session: () => ({ sessionEpoch: coordinatorState.sessionEpoch, walletGeneration: coordinatorState.walletGeneration, runGeneration: coordinatorState.runGeneration, unlocked: coordinatorState.vaultStatus === "unlocked", rootAvailable: platformRootStore !== undefined }),
  appSession: readProtocolConnectSession,
});
const storageGrants = storageGrantAuthority.apps;
const ownerStorageGrants = storageGrantAuthority.owners;
const platformStorageGrants = storageGrantAuthority.platforms;
const resolvePlatformStorageGrant = storageGrantAuthority.resolvePlatform;
const resolveOwnerStorageGrant = storageGrantAuthority.resolveOwner;
const resolveStorageGrant = storageGrantAuthority.resolveApp;

let storageMutationTail: Promise<void> = Promise.resolve();
const STORAGE_DATA_MAX_PER_PORT = 16;
const storageDataQueue = createStorageDataQueue();
const withStorageDataSlot = storageDataQueue.run;

/**
 * Worker 侧的存储绑定。
 *
 * 物理数据不再按桶和 Owner 前缀隔离，但每次会话仍要绑定四件事才能读写：
 * 钱包身份世代、会话 epoch、Worker 运行世代和当前平台 Root 的对象身份。
 * 其中任何一项变化都会让已经发放的句柄与迟到结果 fail closed。
 */
interface CoordinatorStorageBinding {
  /** 钱包身份世代；重置或重新初始化后改变。 */
  walletGeneration: string;
  /** 会话世代；锁定、解锁、改密后改变。 */
  sessionEpoch: SessionEpoch;
  /** Worker 运行世代；每次 Worker 启动生成。 */
  runGeneration: string;
  /** 平台 Root 的对象身份；换绑时改变，必须保持引用相等。 */
  platformRootToken: object;
}

/** 正在进行的存储请求；锁定/改密/重置必须等它们排空后再动数据。 */
const storageBindingRequests = new Set<Promise<void>>();
/** 锁定期间未完成的旧绑定排空；下一次解锁必须先消费它。 */
let pendingStorageBindingDrain: Promise<void> | undefined;
/** 撤销授权前等待所有存储请求自然结束的上限。 */
export const STORAGE_BINDING_DRAIN_TIMEOUT_MS = 5_000;

/** 当前的四维存储绑定；Root 尚未安装时返回 undefined。 */
function currentCoordinatorStorageBinding(): CoordinatorStorageBinding | undefined {
  if (!platformRootToken) return undefined;
  return {
    walletGeneration: coordinatorState.walletGeneration,
    sessionEpoch: coordinatorState.sessionEpoch,
    runGeneration: coordinatorState.runGeneration,
    platformRootToken,
  };
}

function storageBindingsEqual(left: CoordinatorStorageBinding, right: CoordinatorStorageBinding): boolean {
  return left.walletGeneration === right.walletGeneration
    && left.sessionEpoch === right.sessionEpoch
    && left.runGeneration === right.runGeneration
    && left.platformRootToken === right.platformRootToken;
}

/** 断言某个绑定仍然是当前绑定；锁定、改密、重置和 Worker 重启都会让它失效。 */
function assertStorageBindingLive(binding: CoordinatorStorageBinding): void {
  const current = currentCoordinatorStorageBinding();
  if (!current || !storageBindingsEqual(current, binding)) {
    throw storageUnavailableError("Storage binding became stale");
  }
}

/** 登记一个存储请求；释放函数必须在 finally 中调用。 */
function beginStorageBindingRequest(): () => void {
  let resolveRelease!: () => void;
  const pending = new Promise<void>((resolve) => { resolveRelease = resolve; });
  storageBindingRequests.add(pending);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    storageBindingRequests.delete(pending);
    resolveRelease();
  };
}

/** 等待当前所有存储请求结束；超时抛错，调用方必须保持 fail closed。 */
async function drainStorageBindingRequests(): Promise<void> {
  if (storageBindingRequests.size === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const drained = await Promise.race([
      Promise.allSettled([...storageBindingRequests]).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), STORAGE_BINDING_DRAIN_TIMEOUT_MS);
      }),
    ]);
    if (!drained) {
      // 超时不能继续清库：忽略 AbortSignal 的迟到写入仍可能在清空之后
      // 落到新钱包里，因此必须保留绑定世代已经推进的事实。
      throw storageUnavailableError("Storage requests did not drain before the binding timeout");
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function rememberStorageBindingDrain(promise: Promise<void>): void {
  const existing = pendingStorageBindingDrain;
  if (existing === promise) return;
  pendingStorageBindingDrain = promise;
  // 锁定路径不能因为迟到请求而产生未处理 rejection；真正的错误由下一次
  // 解锁再次 await 并重新 drain 时返回。
  void promise.then(
    () => undefined,
    () => undefined
  );
}

/** 等待锁定留下的旧绑定排空；超时后保留已推进的世代，并允许后续重试。 */
async function waitForPendingStorageBindingDrain(): Promise<void> {
  const pending = pendingStorageBindingDrain;
  if (!pending) return;
  try {
    await pending;
  } catch {
    // 初次锁定的 drain 可能已经超时，但请求随后才自然结束；解锁时重新
    // 观察当前集合，不能把旧的 rejected Promise 当成永久结论。
    await drainStorageBindingRequests();
  }
  if (pendingStorageBindingDrain === pending) pendingStorageBindingDrain = undefined;
}

function storageUnavailableError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "storage_unavailable" });
}

function storageConflictError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "storage_conflict" });
}

function isStorageConflictError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "storage_conflict");
}

function beginStorageBindingRequestForTest(): () => void {
  return beginStorageBindingRequest();
}

/**
 * 撤销本次会话发放的全部存储授权。
 *
 * 只清理运行态授权表和 Connect 游标/运行绑定，不递归调用运行时控制器的
 * `abortSession()`：那条路径用于单个 App 断开，而这里正在推进会话世代，
 * 两者混用会让撤销动作依赖自身正在撤销的状态。
 */
function revokeStorageSessionGrants(): void {
  storageGrants.clear();
  ownerStorageGrants.clear();
  platformStorageGrants.clear();
  storageRequests.clear();
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
  revokeStorageSessionGrants();
  releaseMsfileRuntime(reason);
  await releaseSatRuntime(reason);
  clearWindowP2pExecutorLeaseLocked();
  stopCoordinatorOwnerWorkerUnits();
  // 任务 completion 由自己的绑定栅栏收口；这里不等待一个可能永不响应
  // AbortSignal 的业务 task，存储排空才是数据变更前的硬门禁。
  if (coordinatorState.activePublicKeyHex) {
    void cancelTaskRuntimesByKey(coordinatorState.activePublicKeyHex).catch((error) => {
      console.warn("[coordinator] task cancellation deferred", error instanceof Error ? error.message : String(error));
    });
  }
  const drain = drainStorageBindingRequests();
  try {
    await drain;
  } catch (error) {
    rememberStorageBindingDrain(drain);
    throw error;
  }
}

/* ---------- MSFile runtime state（施工单 KMMF-005/006） ---------- */
let msfileRuntime: MsFileServiceImpl | undefined;
let msfileWorkerChainAccess: (() => WocServiceHandle | undefined) | undefined;
/** 仅测试替身；生产请求永远只读取 Host-owned msfileRuntime。 */
let testMsfileRuntimeOverride: MsFileServiceImpl | undefined;
/** MSFile 首次装配 single-flight；首页资源与设置命令可能同时触发启动。 */
let msfileRuntimeStarting: Promise<MsFileServiceImpl> | undefined;
/** 释放/切换 owner 时递增，阻止迟到的候选实例重新发布。 */
let msfileRuntimeStartToken = 0;
type MsFileRuntimeStores = {
  ownerPublicKeyHex: string;
  settings: BorrowedModuleFileStore;
  appSettings: BorrowedModuleFileStore;
};
/** MSFile 的 owner 文件句柄与 App publisher 枚举；句柄由 worker 缓存与失效。 */
let msfileRuntimeStores: MsFileRuntimeStores | undefined;
let lastMsFileState: CoordinatorMsFileStateEvent | undefined;
const msfileFundingRuntime = createWorkerFundingRuntime({
  session: () => ({ vaultStatus: coordinatorState.vaultStatus, activePublicKeyHex: coordinatorState.activePublicKeyHex, sessionEpoch: coordinatorState.sessionEpoch }),
  journalStore: () => createWorkerModuleFileStore("msfile", "bitfs-journal"),
  executor: requestWindowP2pExecutorOperation,
  ensureResources: ensureWorkerP2pkhResources,
  snapshots: () => p2pkhUtxoSnapshots,
  readP2pkhSettings: () => p2pkhSettingRepository().readSetting(),
  maxFeeSatoshis: bitfsFundingMaxFeeSatoshis,
  deriveAddress: deriveP2pkhAddress,
  addressScript: p2pkhAddressToScriptHex,
  parseTransaction: parseP2pkhTransaction,
});
const msfileBitfsRuntime = createBitfsWorkerRuntime({
  session: () => ({ vaultStatus: coordinatorState.vaultStatus, activePublicKeyHex: coordinatorState.activePublicKeyHex, sessionEpoch: coordinatorState.sessionEpoch, runGeneration: coordinatorState.runGeneration }),
  service: () => msfileRuntime,
  ensureService: () => ensureMsfileRuntime(),
  files: (purpose) => createWorkerModuleFileStore("msfile", purpose),
  woc: () => testDomainUnitReadiness ? p2pkhWocService : msfileWorkerChainAccess?.(),
  p2pkhSettings: () => p2pkhSettingRepository().readSetting(),
  crypto: (owner) => createWorkerActiveKeyCrypto(owner),
  blockHeight: readCoordinatorBitfsBlockHeight,
  executor: requestWindowP2pExecutorOperation,
  network: bitfsNetwork,
  availability: coordinatorUnitAvailability,
  subscribeAvailability: subscribeCoordinatorUnitAvailability,
  ensureResources: ensureWorkerP2pkhResources,
  snapshots: () => p2pkhUtxoSnapshots,
  ensureChannel: () => ensureSatRuntime(),
  channel: () => satRuntime,
  buyerSubscriptions: async (runtime) => {
    const current = await ensureSatRuntime();
    if (current !== runtime) throw new Error("BitFS channel runtime changed");
    await ensureMsfileBitfsBuyerSubscriptions(current);
  },
  sellerSubscriptions: async (runtime) => {
    const current = await ensureSatRuntime();
    if (current !== runtime) throw new Error("BitFS channel runtime changed");
    await ensureMsfileBitfsSellerSubscriptions(current);
  },
  publishHashRequest: async (runtime, input, signal, prepared) => {
    const current = await ensureSatRuntime();
    if (current !== runtime) throw new Error("BitFS channel runtime changed");
    return publishChannelHashRequest(current, input, signal, prepared);
  },
  unknownPublishFailure: isUnknownChannelPublishFailure,
  executorLease: () => windowP2pExecutorLease,
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
    return publishPrivateEnvelope({ ...input, runtime: current });
  },
  funding: msfileFundingRuntime,
  parseTransaction: parseP2pkhTransaction,
  deriveAddress: deriveP2pkhAddress,
  addressScript: p2pkhAddressToScriptHex,
  maxFeeSatoshis: bitfsFundingMaxFeeSatoshis,
  diagnosticsEnabled: () => import.meta.env.VITE_BITFS_E2E === "true",
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

/**
 * 缺省 SatSubscription 供应商网络选择。
 *
 * 设计缘由：
 *   - `npm run dev` 使用 testnet 网关；
 *   - `npm run build` / `npm run build:production` 使用 mainnet 网关；
 *   - Worker 与页面由同一次 Vite 构建处理，`import.meta.env.DEV` 语义一致。
 */
function satDefaultNetwork(): SatDefaultNetwork {
  return import.meta.env.DEV === true ? "testnet" : "mainnet";
}

type BitfsNetwork = "main" | "test";

function bitfsNetwork(): BitfsNetwork {
  return import.meta.env.VITE_BITFS_NETWORK === "test" ? "test" : "main";
}

async function readCoordinatorBitfsBlockHeight(network: BitfsNetwork): Promise<number> {
  const snapshot = coordinatorChainHeight;
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
  if (!/^[1-9][0-9]{0,6}$/u.test(raw)) throw new Error("BitFS E2E 手续费上限配置无效");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("BitFS E2E 手续费上限配置无效");
  return value;
}
interface SatWorkerRuntimeState {
  ownerPublicKeyHex: string;
  ownerGeneration: number;
  /** owner runtime 生命周期信号；锁屏/无页面时取消在途物理对账。 */
  signal: AbortSignal;
  repository: SatSubscriptionRepository;
  state: SatSubscriptionStateStore;
  provider: SatSubscriptionProvider;
  handle: SatSubscriptionHandle;
  admin: SatSubscriptionAdminService;
  service: SatSubscriptionService;
  spi: SatSubscriptionSpiService;
  offIncoming: () => void;
}
let satRuntime: SatWorkerRuntimeState | undefined;
let satRuntimeStarting: Promise<SatWorkerRuntimeState> | undefined;
let satRuntimeStartToken = 0;
let satRuntimeStartingToken: number | undefined;
/** 可中止正在拨号的旧 owner Runtime，避免 owner 切换后连接迟到复活。 */
let satRuntimeStartAbortController: AbortController | undefined;
let satRevision = 0;
let lastSatState: CoordinatorSatStateEvent | undefined;
/** Coordinator 内唯一的逻辑 caller -> SSP 物理订阅复用器。 */
let channelSubscriptionMux: ChannelSubscriptionMux | undefined;
let channelMuxOwnerPublicKeyHex: string | undefined;
let channelSubscriptionMuxStatusOff: (() => void) | undefined;
const channelSubscriptionStatusSubscribers = new Set<{
  sessionEpoch: string;
  handler: (status: ChannelSubscriptionStatus) => void;
}>();
/** 旧 owner runtime 的异步清理；新 owner 必须等待它完成。 */
let satRuntimeRelease: Promise<void> = Promise.resolve();
/** 锁屏/切 owner 的远端 Sat 清理上限；安全边界不能依赖网络返回。 */
const SAT_RUNTIME_CLEANUP_TIMEOUT_MS = 5_000;
/** 防止首个 Channel caller 并发创建多个物理订阅协调器。 */
let channelSubscriptionMuxStarting: Promise<ChannelSubscriptionMux> | undefined;
let channelSubscriptionMuxStartOwner: string | undefined;
let channelSubscriptionMuxGeneration = 0;
let channelRevision = 0;
/** Worker 内部 Contacts 任务接收已路由的私密消息；不向页面暴露额外总线。 */
const channelPublicSubscribers = new Set<(event: { channel: string; publisherPublicKeyHex: string; messageId: string; content: import("@keymaster/contracts").JSONValue }) => void>();
const channelPrivateSubscribers = new Set<(event: ChannelPrivateMessageEvent) => void>();
let coordinatorContactsService: ContactsService | undefined;
let coordinatorContactsPresenceOff: (() => void) | undefined;
const channelProtocolRelations = createChannelProtocolRelations({
  sessionEpoch: () => coordinatorState.sessionEpoch,
  ownerPublicKeyHex: () => coordinatorState.activePublicKeyHex,
  pruneRelated(now) {
  for (const [messageId, request] of msfileBitfsBuyerRequests) {
    if (request.expiresAtMs <= now || request.ownerSessionEpoch !== coordinatorState.sessionEpoch) {
      msfileBitfsBuyerRequests.delete(messageId);
      msfileBitfsBuyerOfferCounts.delete(messageId);
    }
  }
  },
});
const channelPendingPings = channelProtocolRelations.pendingPings;
const channelHashRequests = channelProtocolRelations.hashRequests;
const channelWebrtcOffers = channelProtocolRelations.webrtcOffers;
const pruneChannelProtocolRelations = channelProtocolRelations.prune;
const channelHashRequestKey = channelProtocolRelations.hashRequestKey;
const channelHashRequestByMessageId = channelProtocolRelations.hashRequestByMessageId;
const channelWebrtcOfferKey = channelProtocolRelations.webrtcOfferKey;
const findChannelWebrtcOffer = channelProtocolRelations.findWebrtcOffer;
const pruneChannelPendingPings = channelProtocolRelations.prunePendingPings;
const scheduleChannelPendingPingCleanup = channelProtocolRelations.schedulePendingPingCleanup;
const allowAutomaticPong = channelProtocolRelations.allowAutomaticPong;
const rememberChannelMessage = channelProtocolRelations.rememberMessage;
const CHANNEL_PENDING_PING_TTL_MS = PING_PRIVATE_MESSAGE_MAX_LIFETIME_MS;
/** 以 connectionId 隔离入站 handler；supplierId 不是连接实例键。 */

/** Window lane 的连接状态事件；按 connectionId 和完整 fence 路由到当前 owner。 */

const { transport: satSubscriptionTransport, incomingHandlers: satIncomingHandlers, stateHandlers: satConnectionStateHandlers } = createSatWorkerTransport({
  operation: (operation, signal) => satWindowLaneOperation(operation, signal),
  cancelInbound: (connectionId, reason) => cancelSatInboundHandlersForConnection(connectionId, reason),
});
interface SatWorkerConnection extends SatSupplierConnection {
  readonly state: "online" | "degraded" | "closed";
}
const msfileRequests = new Map<string, { controller: AbortController; clientId: string; connectSessionId?: string }>();
const msfileRequestKey = (clientId: string, requestId: string): string => `${clientId}\u0000${requestId}`;
/** 两个 identity RPC 的取消句柄；不得与 MSFile 数据面混用。 */
const windowP2pExecutorIdentityRequests = new Map<string, { controller: AbortController; clientId: string; leaseId: string }>();
const windowP2pExecutorIdentityRequestKey = (clientId: string, requestId: string): string => `${clientId}\u0000${requestId}`;
const msfileGrants = new Map<string, { context: MsFileConnectAppContext; clientId: string; sessionEpoch: SessionEpoch }>();
/** 数据面队列有界，但具体并发由设置快照决定。 */
let msfileReadConcurrencySettings: MsFileReadConcurrencySettings = { ...MSFILE_READ_CONCURRENCY_RECOMMENDED };
let windowP2pExecutorConfigVersion = 0;
let windowP2pExecutorConfigSignature = JSON.stringify(msfileReadConcurrencySettings);
let windowP2pExecutorConcurrencyConfig: WindowP2pExecutorConcurrencyConfig = buildWindowP2pConcurrencyConfig(
  msfileReadConcurrencySettings,
  windowP2pExecutorConfigVersion,
);

function emitMsFileState(): void {
  msfileRevision += 1;
  const state = msfileRuntime?.describeState();
  const event: CoordinatorMsFileStateEvent = {
    topic: "msfile.state",
    type: "msfile.state.changed",
    msfileRevision,
    sessionEpoch: coordinatorState.sessionEpoch,
    status: state?.status ?? (coordinatorState.vaultStatus === "unlocked" ? "unconfigured" : "unavailable"),
    supplierGeneration: state?.supplierGeneration ?? 0,
    globalSettings: state?.globalSettings ?? null,
    mediaBlockReadConcurrency: state?.mediaBlockReadConcurrency ?? msfileReadConcurrencySettings.mediaBlockReadConcurrency,
    globalSeedReadConcurrency: state?.globalSeedReadConcurrency ?? msfileReadConcurrencySettings.globalSeedReadConcurrency,
    globalBlockReadConcurrency: state?.globalBlockReadConcurrency ?? msfileReadConcurrencySettings.globalBlockReadConcurrency,
    globalStatConcurrency: state?.globalStatConcurrency ?? msfileReadConcurrencySettings.globalStatConcurrency,
    sellerSettings: state?.sellerSettings ?? { ...MSFILE_SELLER_SETTINGS_DEFAULT, supportedArbiterPublicKeys: [] },
    sellerRuntimeStatus: state?.sellerRuntimeStatus ?? (coordinatorState.vaultStatus === "unlocked" ? "disabled" : "waiting-unlock"),
    pendingApprovals: state?.pendingApprovals ?? []
  };
  const nextConcurrency = normalizeMsFileReadConcurrencySettings(event) ?? msfileReadConcurrencySettings;
  const nextSignature = JSON.stringify(nextConcurrency);
  if (nextSignature !== windowP2pExecutorConfigSignature) {
    msfileReadConcurrencySettings = nextConcurrency;
    windowP2pExecutorConfigSignature = nextSignature;
    windowP2pExecutorConfigVersion += 1;
    windowP2pExecutorConcurrencyConfig = buildWindowP2pConcurrencyConfig(nextConcurrency, windowP2pExecutorConfigVersion);
    void syncWindowP2pExecutorConfig().catch(() => undefined);
    pumpMsfileDataWaiters();
  }
  lastMsFileState = event;
  publishTopicEvent("msfile.state", event);
}

const msfileDataQueue = createMsfileDataQueue(() => msfileReadConcurrencySettings, message => msfileError("msfile_unavailable", message));
const pumpMsfileDataWaiters = msfileDataQueue.pump;
const withMsfileDataSlot = msfileDataQueue.run;
const rejectMsfileDataWaiters = msfileDataQueue.rejectQueued;

async function ensureMsfileRuntime(expectedInstanceId?: string, boundStores?: MsFileRuntimeStores, assertScopeActive: () => void = () => undefined): Promise<MsFileServiceImpl> {
  // 唯一可用性判定：插件开? 解锁? 作用域就绪? 一次求值给出全部原因，不再手写
  // 同一串检查，也不再 reconcile 一下祈祷它已就绪。锁定 / 未初始化 / fatal 状态
  // 因此同样由这一条路径表达。
  assertCoordinatorUnitConstructible("msfile.coordinator-worker");
  // owner K-V 只能在统一 Storage 健康门禁打开后装配。这是数据面准入门，不是单元
  // 可用性判定：它对同一个 `platformStorageReady` 事实负责，与 7 个 storage.data
  // 入口共用，因此仍由本模块自己读事实。
  assertStorageDataAvailable();
  if (testMsfileRuntimeOverride) return testMsfileRuntimeOverride;
  if (msfileRuntime) {
    if (expectedInstanceId) {
      const unit = activateCoordinatorOwnerWorkerUnit("msfile.coordinator-worker", expectedInstanceId);
      const ready = coordinatorWorkerUnitRegistry.ready(unit.unitId, unit.instanceId);
      if (ready.instanceId !== expectedInstanceId) throw msfileError("msfile_unavailable", "MSFile runtime instance identity mismatch");
    }
    return msfileRuntime;
  }
  if (msfileRuntimeStarting) {
    const runtime = await msfileRuntimeStarting;
    if (expectedInstanceId) {
      const unit = activateCoordinatorOwnerWorkerUnit("msfile.coordinator-worker", expectedInstanceId);
      const ready = coordinatorWorkerUnitRegistry.ready(unit.unitId, unit.instanceId);
      if (ready.instanceId !== expectedInstanceId) throw msfileError("msfile_unavailable", "MSFile runtime instance identity mismatch");
    }
    return runtime;
  }
  if (!platformRootStore) throw msfileError("msfile_unavailable", "Platform storage has not been bootstrapped");
  const startToken = msfileRuntimeStartToken;
  const start = (async (): Promise<MsFileServiceImpl> => {
    const workerUnit = activateCoordinatorOwnerWorkerUnit("msfile.coordinator-worker", expectedInstanceId);
    let service: MsFileServiceImpl | undefined;
    let stores: MsFileRuntimeStores | undefined;
    try {
      const root = platformRootStore;
      if (!root) throw msfileError("msfile_unavailable", "Platform storage has not been bootstrapped");
      const ownerPublicKeyHex = coordinatorState.activePublicKeyHex?.trim().toLowerCase();
      if (!ownerPublicKeyHex) throw msfileError("msfile_unavailable", "MSFile runtime requires an unlocked active key");
      // 设置与供应商是 msfiles 模块根；App 覆盖额度是平台管理的
      // `.keymaster/system/app/app-settings/`。句柄由 worker 统一缓存、按
      // 四维绑定失效，因此这里不 close，也不持有文件生命周期。
      if (!testDomainUnitReadiness && !boundStores) throw msfileError("msfile_unavailable", "MSFile must be started by its Worker unit");
      stores = boundStores ?? { ownerPublicKeyHex, settings: createWorkerModuleFileStore("msfile", ""), appSettings: createWorkerModuleFileStore("msfile", "app-settings") };
      if (stores.ownerPublicKeyHex !== ownerPublicKeyHex) throw msfileError("msfile_unavailable", "MSFile storage owner changed");
      service = await createMsFileWorkerService({
        stores, transport: windowP2pExecutorTransport,
        assertFresh: () => {
          assertScopeActive();
          if (startToken !== msfileRuntimeStartToken || coordinatorState.vaultStatus !== "unlocked" || coordinatorState.activePublicKeyHex?.trim().toLowerCase() !== ownerPublicKeyHex) throw msfileError("msfile_unavailable", "MSFile runtime startup was superseded");
        },
        onSellerSettingsChanged: settings => configureMsfileSellerRuntime(service!, ownerPublicKeyHex, settings),
        notifyStateChange: () => emitMsFileState(),
      });
      assertStorageDataAvailable();
      if (
        startToken !== msfileRuntimeStartToken
        || coordinatorState.vaultStatus !== "unlocked"
        || coordinatorState.activePublicKeyHex?.trim().toLowerCase() !== ownerPublicKeyHex
        || !isCoordinatorProductRegistered("msfile")
      ) {
        throw msfileError("msfile_unavailable", "MSFile runtime startup was superseded");
      }
      msfileRuntimeStores = stores;
      msfileRuntime = service;
      const sellerStatus = await configureMsfileSellerRuntime(service, ownerPublicKeyHex, service.describeState().sellerSettings);
      service.setSellerRuntimeStatus(sellerStatus);
      coordinatorWorkerUnitRegistry.ready(workerUnit.unitId, workerUnit.instanceId);
      emitMsFileState();
      return service;
    } catch (error) {
      coordinatorWorkerUnitRegistry.fail(workerUnit.unitId, workerUnit.instanceId, error);
      stopCoordinatorWorkerUnit(workerUnit.unitId, workerUnit.instanceId);
      try { service?.dispose?.(); } catch { /* 启动失败时尽力释放服务 */ }
      throw error;
    }
  })();
  msfileRuntimeStarting = start;
  try {
    return await start;
  } finally {
    if (msfileRuntimeStarting === start) msfileRuntimeStarting = undefined;
  }
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
  // 同一把尺子：插件开? 解锁? 作用域就绪?（自身就绪正是本函数要做的事）
  assertCoordinatorUnitConstructible("sat-subscription.coordinator-worker");
  // owner 切换/锁定的退订和连接关闭必须完成后，才能把任何请求交给
  // 新 runtime；否则旧 owner 的清理可能和新 owner 的收费请求并发。
  await satRuntimeRelease.catch(() => undefined);
  assertCoordinatorUnitConstructible("sat-subscription.coordinator-worker");
  if (satRuntime) {
    if (expectedInstanceId) {
      const unit = activateCoordinatorOwnerWorkerUnit("sat-subscription.coordinator-worker", expectedInstanceId);
      const ready = coordinatorWorkerUnitRegistry.ready(unit.unitId, unit.instanceId);
      if (ready.instanceId !== expectedInstanceId) throw new Error("SatSubscription runtime instance identity mismatch");
    }
    return satRuntime;
  }
  if (satRuntimeStarting) {
    const pending = satRuntimeStarting;
    if (satRuntimeStartingToken === satRuntimeStartToken) return pending;
    // lock/key switch 已使旧启动失效；等待它完成清理后再创建新世代，
    // 避免两个世代同时拥有 Supplier 连接。
    await pending.catch(() => undefined);
    if (satRuntime) {
      if (expectedInstanceId) {
        const unit = activateCoordinatorOwnerWorkerUnit("sat-subscription.coordinator-worker", expectedInstanceId);
        const ready = coordinatorWorkerUnitRegistry.ready(unit.unitId, unit.instanceId);
        if (ready.instanceId !== expectedInstanceId) throw new Error("SatSubscription runtime instance identity mismatch");
      }
      return satRuntime;
    }
  }
  // 上面的断言已覆盖「解锁 + 有 active key」；这里把判定结果落到局部变量，
  // 不再重复判一次。
  if (!testDomainUnitReadiness && !storage) throw new Error("SatSubscription must be started by its Worker unit");
  const ownerPublicKeyHex = coordinatorState.activePublicKeyHex!;
  // SPI 的 ownerGeneration 是「插件运行代次」的单调计数，不是钱包身份世代：
  // 旧实现借用了 旧身份计数器（换 Key 时自增），单 Key 模型下已没有
  // 该世代，这里改用已存在的 satRuntimeStartToken —— 它同样在每次运行代次
  // 变化时单调递增，能让重启前后的 SPI 结果互相失效。
  const ownerGeneration = Math.max(1, satRuntimeStartToken + 1);
  const expectedSessionEpoch = coordinatorState.sessionEpoch;
  const startToken = satRuntimeStartToken;
  const workerUnit = activateCoordinatorOwnerWorkerUnit("sat-subscription.coordinator-worker", expectedInstanceId);
  const startAbortController = new AbortController();
  satRuntimeStartAbortController = startAbortController;
  const start = (async (): Promise<SatWorkerRuntimeState> => {
    const assertFresh = (): void => {
      assertScopeActive();
      if (startToken !== satRuntimeStartToken || !isCoordinatorProductRegistered("sat-subscription") || coordinatorState.vaultStatus !== "unlocked" || coordinatorState.sessionEpoch !== expectedSessionEpoch || coordinatorState.activePublicKeyHex !== ownerPublicKeyHex) throw new Error("SatSubscription runtime became stale while starting");
    };
    const owned = await createSatWorkerServices({
      storage: storage ?? createWorkerModuleFileStore("sat-subscription", ""),
      ownerPublicKeyHex, ownerGeneration, ownerSessionEpoch: expectedSessionEpoch,
      signal: startAbortController.signal, network: satDefaultNetwork(), transport: satSubscriptionTransport,
      assertFresh,
      getOwnerPublicKeyHex: () => coordinatorState.activePublicKeyHex ?? null,
      getOwnerGeneration: () => coordinatorState.activePublicKeyHex === ownerPublicKeyHex ? Math.max(1, satRuntimeStartToken + 1) : null,
      getP2pkh: () => testDomainUnitReadiness ? ensureSatP2pkhService() : satWorkerP2pkhAccess?.() ?? null,
      deriveP2pkhAddress: async (requestedOwner, network) => {
          if (requestedOwner !== ownerPublicKeyHex || coordinatorState.activePublicKeyHex !== ownerPublicKeyHex) throw new Error("SPI owner changed before address derivation");
          const result = await withCoordinatorFinalIoLease(
            "write",
            undefined,
            () => { vaultKeySession.assert(ownerPublicKeyHex, expectedSessionEpoch); return vaultKeySession.execute({ type: "deriveP2pkhAddress", network }); },
            { auditOperation: "sat.address.derive" },
          );
          if (result.type !== "deriveP2pkhAddress") throw new Error("Failed to derive the owner payment address");
          return result.address;
        },
    }).catch(error => {
      coordinatorWorkerUnitRegistry.fail(workerUnit.unitId, workerUnit.instanceId, error);
      stopCoordinatorWorkerUnit(workerUnit.unitId, workerUnit.instanceId);
      throw error;
    });
    const { repository, state, provider: boundProvider, handle, service, admin, spi } = owned;
    try {
      const runtime: SatWorkerRuntimeState = {
        ownerPublicKeyHex,
        ownerGeneration,
        signal: startAbortController.signal,
        repository,
        state,
        provider: boundProvider,
        handle,
        admin,
        service,
        spi,
        offIncoming: service.subscribeEvents((event) => handleIncomingChannelPublish(event)),
      };
      assertFresh();
      coordinatorWorkerUnitRegistry.ready(workerUnit.unitId, workerUnit.instanceId);
      satRuntime = runtime;
      return runtime;
    } catch (error) {
      coordinatorWorkerUnitRegistry.fail(workerUnit.unitId, workerUnit.instanceId, error);
      stopCoordinatorWorkerUnit(workerUnit.unitId, workerUnit.instanceId);
      try { handle?.close(); } catch { /* stale start cleanup */ }
      await boundProvider.shutdown().catch(() => undefined);
      repository.close();
      throw error;
    }
  })();
  satRuntimeStarting = start;
  satRuntimeStartingToken = startToken;
  try {
    return await start;
  } finally {
    if (satRuntimeStarting === start) {
      satRuntimeStarting = undefined;
      satRuntimeStartingToken = undefined;
    }
    if (satRuntimeStartAbortController === startAbortController) satRuntimeStartAbortController = undefined;
  }
}

async function releaseSatRuntime(
  reason: string,
  options: { physicalCleanup?: boolean } = {},
): Promise<void> {
  // 多次 lock/key-switch 可能同时到达；清理任务排队执行，后一个 owner
  // 永远不会越过前一个 owner 的物理退订和连接关闭。
  const previousRelease = satRuntimeRelease;
  satRuntimeStartToken += 1;
  satRuntimeStartAbortController?.abort(new Error(`Sat runtime released: ${reason}`));
  satRuntimeStartAbortController = undefined;
  const workerUnit = coordinatorWorkerUnitRegistry.get("sat-subscription.coordinator-worker");
  if (workerUnit) stopCoordinatorWorkerUnit(workerUnit.unitId, workerUnit.instanceId);
  // 先取消仍在 handler 中等待的入站 Publish，再移除连接注册表。取消只
  // 释放 bridge Wire，不提前释放 handler slot；slot 要等真实 Promise settle，
  // 防止永不结束的旧 handler 在新 owner 中制造未受控并发。
  cancelSatInboundHandlers(undefined, `Sat runtime was released: ${reason}`);
  satIncomingHandlers.clear();
  const { starting: p2pkhStarting } = workerTransferRuntime.release();
  resetP2pkhSettingsRuntime();
  const runtime = satRuntime;
  const runtimeStarting = satRuntimeStarting;
  satRuntime = undefined;
  satRuntimeStarting = undefined;
  lastSatState = undefined;
  const mux = channelSubscriptionMux;
  const muxStarting = channelSubscriptionMuxStarting;
  // 先中断 owner inbox/插件订阅的在途网络请求；锁屏仍会在第二阶段
  // 用一个新的 Mux 对账清理，最后一个页面离开则只保存领域清理意图。
  mux?.cancelInFlight();
  channelSubscriptionMuxStatusOff?.();
  channelSubscriptionMuxStatusOff = undefined;
  channelSubscriptionMux = undefined;
  channelMuxOwnerPublicKeyHex = undefined;
  channelSubscriptionMuxGeneration += 1;
  // 不把旧 starting promise 丢掉；下面会等待它自然完成并自行清理。
  channelSubscriptionMuxStarting = undefined;
  channelSubscriptionMuxStartOwner = undefined;
  channelCallersByClient.clear();
  channelProtocolRelations.clear();
  msfileBitfsRuntime.clearBuyerState();
  coordinatorContactsService?.resetPresence?.();

  const cleanup = previousRelease.then(async () => {
    // 必须在 runtime.handle.close / provider.shutdown 前清理物理订阅。
    // 每一步都有上限：远端 Supplier 永不返回时，清理只保留在当前 Worker
    // 运行态，不能拖延锁屏或阻止后续 owner 建立会话；下次由 SS server
    // 订阅查询重新取得远端事实。
    const startedRuntime = runtime ?? await awaitSatCleanup(runtimeStarting ?? Promise.resolve(undefined), "stale runtime start");
    const physicalCleanup = options.physicalCleanup !== false;
    // Mux 已在 release 入口取消了旧的物理动作；先推进 Provider 世代，
    // 再写清理意图，防止旧 Promise 迟到把 unsubscribing 覆盖回去。
    if (startedRuntime) {
      await awaitSatCleanup(startedRuntime.handle.preparePhysicalCleanup(), "persist physical cleanup intent");
    }
    const startedMux = await awaitSatCleanup(muxStarting ?? Promise.resolve(undefined), "stale mux start");
    const muxToRelease = mux ?? startedMux;
    if (muxToRelease) {
      try {
        if (physicalCleanup) {
          await awaitSatCleanup(muxToRelease.clear(), "old owner physical cleanup");
        }
      } finally {
        // clear 超时或 no-client teardown 后也必须取消旧 Mux 的退避重试，
        // 避免它在新 owner Runtime 建立后继续调用旧连接。
        muxToRelease.dispose();
      }
    }
    await awaitSatCleanup(p2pkhStarting ?? Promise.resolve(undefined), "stale P2PKH start");
    if (startedRuntime) {
      try { startedRuntime.offIncoming(); } catch { /* ignore */ }
      try { startedRuntime.handle.close(); } catch { /* ignore */ }
      await awaitSatCleanup(startedRuntime.provider.shutdown(), "Sat provider shutdown");
      startedRuntime.repository.close();
    }
  });
  satRuntimeRelease = cleanup.catch((error) => {
    console.warn("[sat-subscription] runtime cleanup failed", error instanceof Error ? error.message : String(error));
  });
  await cleanup;
}

function releaseMsfileRuntime(_reason: string): void {
  msfileRuntimeStartToken += 1;
  stopMsfileSellerRuntime();
  for (const pending of msfileRequests.values()) pending.controller.abort();
  msfileRequests.clear();
  for (const pending of windowP2pExecutorIdentityRequests.values()) pending.controller.abort();
  windowP2pExecutorIdentityRequests.clear();
  msfileGrants.clear();
  const workerUnit = coordinatorWorkerUnitRegistry.get("msfile.coordinator-worker");
  (msfileRuntime as unknown as { dispose?: () => void } | undefined)?.dispose?.();
  msfileRuntime = undefined;
  msfileRuntimeStores = undefined;
  msfileBitfsRuntime.revoke();
  lastMsFileState = undefined;
  if (workerUnit) stopCoordinatorWorkerUnit(workerUnit.unitId, workerUnit.instanceId);
}

function storageCoordinatorError(code: "storage_limit_exceeded" | "storage_unavailable", message: string = code): Error & { code: typeof code } {
  const error = new Error(message) as Error & { code: typeof code };
  error.code = code;
  return error;
}

function reserveStoragePortSlot(clientId: string): boolean {
  const count = storagePortCounts.get(clientId) ?? 0;
  if (count >= STORAGE_DATA_MAX_PER_PORT) return false;
  storagePortCounts.set(clientId, count + 1);
  return true;
}

function releaseStoragePortSlot(clientId: string): void {
  const next = Math.max(0, (storagePortCounts.get(clientId) ?? 1) - 1);
  if (next) storagePortCounts.set(clientId, next); else storagePortCounts.delete(clientId);
}

function emitStorageState(): void {
  storageStateTail = storageStateTail.then(async () => {
    const runtimeStatus = storageController?.status();
    const status: StorageRuntimeControllerStatus = storageStartupFailure
      ? "degraded"
      : runtimeStatus ?? (storageColdStartState?.state === "ready" ? "locked" : "uninitialized");
    const summary = await storageController?.summary().catch(() => null) ?? null;
    const revision = storageRevision + 1;
    const state: CoordinatorStorageStateEvent = {
      topic: "storage.state",
      type: "storage.state.changed",
      storageRevision: revision, activity: storageActivity.snapshot(),
      sessionEpoch: coordinatorState.sessionEpoch,
      status,
      ...(coordinatorState.walletGeneration ? { walletGeneration: coordinatorState.walletGeneration } : {}),
      ...(coordinatorAuthorityRecovery ? { authorityRecovery: coordinatorAuthorityRecovery } : {}),
      summary,
    };
    lastStorageState = state;
    storageRevision = revision;
    publishTopicEvent("storage.state", state);
  }, () => undefined);
}

/**
 * Coordinator-owned Storage recovery pipeline.
 *
 * 本地介质没有远程 Provider 可探测：恢复只重建当前钱包的存储根、撤销旧
 * grant，并让任务与句柄重新绑定。IndexedDB 不可用时映射为 degraded，
 * 不自动清库、不回退到 localStorage。
 */
async function runStorageRecoveryOrchestrator(peerId?: string): Promise<void> {
  if (storageRecoveryOrchestrator) return storageRecoveryOrchestrator;
  storageRecoveryOrchestrator = (async () => {
    if (!platformRootStore) {
      throw storageUnavailableError("Wallet storage root is unavailable");
    } else {
      // 恢复只替换当前底层绑定；任务 runtime 仍持有 wrapper，不能把
      // wrapper 永久 close，否则恢复后的下一次调度必然失败。
      workerStorageClients.invalidateAll();
      ownerStorageGrants.clear();
      platformStorageGrants.clear();
    }
    platformStorageReady = true;
    // Root ready 之后，所有恢复性读写都必须先取得共享 Coordinator 权威。
    await ensureCoordinatorAuthorityClaim();
    const recoveryComplete = await resumeAfterStorageReady(peerId);
    // 初次 initialize 正在 bootstrapPlatformStorage 之后继续读取 metadata
    // 和注册任务；这里不能越权把尚未完成的冷启动发布成 ready。
    if (!recoveryComplete) return;
    storageStartupFailure = false;
    emitStorageState();
  })();
  try {
    await storageRecoveryOrchestrator;
  } catch (error) {
    storageStartupFailure = true;
    emitStorageState();
    throw error;
  } finally {
    storageRecoveryOrchestrator = undefined;
  }
}

/**
 * 记录业务 I/O 的可诊断失败，但不把一次业务读写失败升级成全局启动门禁。
 * 用户的保存/读取请求会收到原始错误并可在原页面重试。
 */
function markStorageIoFailure(error: unknown): void {
  if (!platformStorageReady) return;
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (code !== "storage_unavailable" && code !== "storage_wallet_corrupt") return;
  if (code === "storage_unavailable" && /cancel|abort|closed|stale|fenced|binding|owner storage requests did not drain|key\/session transition/i.test(message)) return;
  // 仅保留脱敏日志；不自动清库，也不把业务错误升级成全局断路器。
  console.warn("[storage] business I/O failed", { code, message: "Wallet storage operation failed" });
}

function isStorageFailure(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  const recoveryRequired = error && typeof error === "object" && "recoveryRequired" in error
    ? (error as { recoveryRequired?: unknown }).recoveryRequired === true
    : false;
  return (typeof code === "string" && code.startsWith("storage_"))
    || code === "upgrade.authority_claim_failed"
    || recoveryRequired
    || storageStartupFailure;
}

function blockWorkerTasksForStorage(): void {
  for (const runtime of coordinatorState.taskRuntimes.values()) {
    if (runtime.timer) clearTimeout(runtime.timer);
    runtime.timer = undefined;
    runtime.nextRunAt = undefined;
    runtime.controller?.abort();
    if (runtime.state !== "blocked" || runtime.blockedReason !== "Storage unavailable") {
      runtime.state = "blocked";
      runtime.blockedReason = "Storage unavailable";
    }
  }
  publishTopicEvent("background.snapshot", {
    type: "background.snapshot.changed",
    sessionEpoch: coordinatorState.sessionEpoch,
    snapshots: getTaskSnapshots(),
    scheduleSettings: coordinatorState.scheduleSettings
  });
}

function assertStorageDataAvailable(): void {
  // 健康状态是启动/显式恢复诊断，不是业务 I/O 的全局断路器。一次请求
  // 失败后仍允许同一表单再次发起真实读写；Provider 会返回当前的实际错误。
  if (!platformStorageReady) {
    throw Object.assign(new Error("Storage is temporarily unavailable"), { code: "storage_unavailable" });
  }
}

async function ensureStorageRuntime(peerId?: string): Promise<StorageRuntimeController> {
  if (storageController) return storageController;
  if (testStorageRuntimeOverride) {
    storageController = testStorageRuntimeOverride;
    const unit = coordinatorWorkerUnitRegistry.activate("storage.coordinator-worker");
    coordinatorWorkerUnitRegistry.ready(unit.unitId, unit.instanceId);
    platformStorageReady = true;
    reconcileCoordinatorRuntime();
    return storageController;
  }
  if (testStorageStartupFailure) {
    storageStartupFailure = true;
    emitStorageState();
    throw storageCoordinatorError("storage_unavailable");
  }
  const startupError = (error: unknown): never => {
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
    // corrupt/unsupported 是明确的本地格式问题：界面必须展示恢复或升级路径，
    // 绝不能被降级成可重试的 degraded 而静默创建空钱包。
    if (code === "storage_wallet_corrupt" || code === "storage_wallet_unsupported") {
      storageStartupFailure = false;
      emitStorageState();
      throw error;
    }
    if (code === "storage_unavailable") {
      storageStartupFailure = false;
      emitStorageState();
    } else {
      storageStartupFailure = true;
      emitStorageState();
    }
    if (typeof code === "string" && code.startsWith("storage_")) throw error;
    throw storageCoordinatorError("storage_unavailable", error instanceof Error ? error.message : "Storage startup failed");
  };
  try {
    if (!walletLifecycle || !platformRootStore) throw new Error("Wallet storage root is unavailable");
  } catch (error) { startupError(error); }
  let runtime: StorageRuntimeController;
  try {
    const root = platformRootStore!;
    runtime = await createStorageRuntimeController({
      summary: async () => {
        // 冷启动缓存会在初始化/解锁事件后失效；摘要身份必须取当前权威世代。
        const walletGeneration = coordinatorState.walletGeneration;
        return {
          ...(coordinatorState.activePublicKeyHex ? { publicKeyHex: coordinatorState.activePublicKeyHex } : {}),
          ...(walletGeneration ? { label: walletKeys ? await readWalletKeyLabel(walletKeys) : undefined } : {}),
          ...(walletGeneration ? { walletGeneration } : {}),
        };
      },
      openAppFileStore: async (ctx) => root.openModuleFileStore({
        declaration: {
          moduleId: deriveThirdPartyStorageModuleId(ctx.appIdentity.publisherPublicKeyHex, ctx.appIdentity.appId),
          // App 只能访问自己的目录根，不允许用途子目录。
          purposeId: "",
          authority: "third-party-app",
          model: "files",
          schemaVersion: 1,
        },
        appStorageName: ctx.appStorageName,
        verifiedAppIdentity: {
          publisherPublicKeyHex: ctx.appIdentity.publisherPublicKeyHex,
          appId: ctx.appIdentity.appId,
        },
      }),
      abortSession: async (connectSessionId) => { revokeStorageSessionRequests(connectSessionId); },
      // 配额探测只能由钱包存储引擎访问:Worker 不直接碰 navigator.storage。
      persistence: async () => await walletStore?.persistence() ?? { persisted: false },
      status: () => coordinatorStorageStatus(),
    });
  } catch (error) {
    startupError(error);
  }
  storageController = runtime!;
  const storageUnit = coordinatorWorkerUnitRegistry.activate("storage.coordinator-worker");
  coordinatorWorkerUnitRegistry.ready(storageUnit.unitId, storageUnit.instanceId);
  platformStorageReady = true;
  reconcileCoordinatorRuntime();
  storageStartupFailure = false;
  scheduleCoordinatorKeyValueMaintenance();
  storageController.subscribe(emitStorageState);
  emitStorageState();
  return storageController;
}

/** 当前存储状态：锁定、损坏或不可用都由同一个只读投影报告。 */
function coordinatorStorageStatus(): StorageRuntimeControllerStatus {
  if (storageStartupFailure) return "degraded";
  const coldStart = storageColdStartState?.state;
  if (coldStart === "corrupt") return "corrupt";
  if (coldStart === "unsupported") return "unsupported";
  if (coordinatorState.vaultStatus === "unlocked") return "ready";
  return coldStart === "ready" ? "locked" : "uninitialized";
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
  storageStartupFailure = false;
  platformStorageReady = true;
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
  for (const runtime of coordinatorState.taskRuntimes.values()) {
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
  for (const request of storageRequests.values()) request.controller.abort();
  storageRequests.clear();
}

async function releaseStorageRuntime(reason: string): Promise<void> {
  abortStorageRequests();
  storageGrants.clear();
  ownerStorageGrants.clear();
  platformStorageGrants.clear();
  // dispose 丢弃游标与订阅者；持久数据仍在 IndexedDB 中。
  const storageUnit = coordinatorWorkerUnitRegistry.get("storage.coordinator-worker");
  (storageController as (StorageRuntimeController & { dispose?: () => void }) | undefined)?.dispose?.();
  storageController = undefined;
  platformStorageReady = false;
  if (storageUnit) stopCoordinatorWorkerUnit(storageUnit.unitId, storageUnit.instanceId);
  reconcileCoordinatorRuntime();
  void reason;
}

async function awaitSatCleanup<T>(operation: Promise<T>, label: string): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), SAT_RUNTIME_CLEANUP_TIMEOUT_MS);
      })
    ]);
  } catch (error) {
    console.warn(`[sat-subscription] ${label} failed`, error instanceof Error ? error.message : String(error));
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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

function topicStreamOverflowError(): Error & { code: string } {
  return Object.assign(new Error("Coordinator topic stream queue overflow"), { code: "stream_overflow" });
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
  if (queue.values.length >= COORDINATOR_TOPIC_QUEUE_LIMIT) {
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
  for (const [requestId, request] of storageRequests) {
    if (request.clientId === peerId) { request.controller.abort(); storageRequests.delete(requestId); }
  }
  for (const [requestId, request] of channelRequests) {
    if (request.clientId === peerId) { request.controller.abort(); channelRequests.delete(requestId); }
  }
  for (const [requestId, request] of msfileRequests) {
    if (request.clientId === peerId) { request.controller.abort(); msfileRequests.delete(requestId); }
  }
  for (const [requestId, request] of windowP2pExecutorIdentityRequests) {
    if (request.clientId === peerId) { request.controller.abort(); windowP2pExecutorIdentityRequests.delete(requestId); }
  }
  for (const [grantId, grant] of storageGrants) if (grant.clientId === peerId) storageGrants.delete(grantId);
  for (const [grantId, grant] of ownerStorageGrants) if (grant.clientId === peerId) ownerStorageGrants.delete(grantId);
  for (const [grantId, grant] of platformStorageGrants) if (grant.clientId === peerId) platformStorageGrants.delete(grantId);
  for (const [grantId, grant] of msfileGrants) if (grant.clientId === peerId) msfileGrants.delete(grantId);
  // 浏览授权是专属授权：peer 一旦脱离 committed session，它名下签发的授权当场作废，
  // 随后任何 browse 调用都只能得到「不可用」。
  storageBrowseCoordinator.revokeClient(peerId);
  const callers = channelCallersByClient.get(peerId);
  channelCallersByClient.delete(peerId);
  if (callers && channelSubscriptionMux) {
    for (const callerId of callers) void channelSubscriptionMux.release(callerId).catch(() => undefined);
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
  state.sessionGeneration += 1;
  state.sessionOpen = false;
  state.status = options.physical ? "revoked" : "closing";
  state.sessionBinding = undefined;
  state.openCommitOrder = undefined;
  state.serviceExposure?.revoke();
  state.serviceExposure = undefined;
  state.serviceExposureIdentity = undefined;
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
  taskRuntimes: new Map(),
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
    isStorageReady: () => platformStorageReady,
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
  for (const runtime of coordinatorState.taskRuntimes.values()) {
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
    authorityInstanceId: coordinatorAuthorityInstanceId,
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
  for (const runtime of coordinatorState.taskRuntimes.values()) {
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
  if (coordinatorState.taskRuntimes.size > 0) return;
  await registerCoordinatorTasks();
  activateCoordinatorRootWorkerUnits();
}

/** 最终租约入口的内存审计窗口；不保存业务数据，也不作为重试依据。 */
const finalIoAudit = createFinalIoAudit();

/** Worker 与 Host 共用的内置插件 -> 存储声明表。 */
const WORKER_SYSTEM_STORAGE_DECLARATIONS = SYSTEM_STORAGE_DECLARATIONS;

const vaultKeySession = createWorkerKeySession(() => ({
  unlocked: coordinatorState.vaultStatus === "unlocked",
  publicKeyHex: coordinatorState.activePublicKeyHex,
  sessionEpoch: coordinatorState.sessionEpoch,
}));
function replaceActivePrivateKey(next: Uint8Array | undefined): void { vaultKeySession.replace(next); }
function dropActivePrivateKey(): void { vaultKeySession.clear(); }

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

/** 每个页面端口的 Channel 请求控制器；断开时取消对应的远端订阅对账。 */
const channelRequests = new Map<string, { clientId: string; controller: AbortController }>();
function channelRequestKey(clientId: string, requestId: string): string {
  return `${clientId}:${requestId}`;
}
/** 已经被某个页面声明过的 caller；端口断开时必须释放其逻辑集合。 */
const channelCallersByClient = new Map<string, Set<string>>();

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
  service: () => coordinatorContactsService,
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
  state: () => coordinatorState,
  blockedReason: coordinatorTaskBlockedReason,
  isAvailabilityBlocked: isRuntimeAvailabilityBlockedReason,
  snapshots: getTaskSnapshots,
  publish: event => { publishTopicEvent("background.snapshot", event); },
  queueSnapshot: () => (testDomainUnitReadiness ? p2pkhWocService : p2pkhWorkerWocQuery)?.getQueueSnapshot(),
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
const { managedIntervalFor, cancelSmartSyncIdleTimer, isWocQueueIdle, canArmSmartSync, armSmartSyncIdleTimer, onWocQueueChanged, armSmartSyncIfIdle, triggerSmartSync, triggerImmediateSync, scheduleRuntime, assertTaskFresh, resolveKeyScope, handleBackgroundRunNow, handleBackgroundTrigger, handleBackgroundCancelByKey, cancelTaskRuntimesByKey, handleBackgroundCancel, handleBackgroundSettingsUpdate, executeTask } = backgroundWorkerRuntime;

/** managed 任务的当前间隔；未配置时使用该任务自己的缺省值。 */


/** 归一化同步管理设置：只保留已登记任务与合法间隔，非法值直接丢弃。 */

/** 智能调度只在可运行会话里计时：锁定 / 无 active key 时不挂计时器。 */


/**
 * 启动 2 秒计时。
 * 设计缘由：计时是「任务完成后」计时——WoC 队列变忙会取消计时，变空
 * 后再重新计时；429 backoff 期间自动把计时推迟到 backoff 解除。
 */


/** WoC 队列事件：忙则取消计时；空闲且会话可运行时从这一刻开始重新计时 2 秒。 */


/** 若会话可运行且 WoC 当前空闲（或测试环境没有 WoC 服务），重新开始 2 秒计时。 */


/** 触发所有 smart 任务（余额快照）；正在运行的任务由 executeTask 自身去重。 */


/**
 * 解锁 / 初始化后立即同步一次。
 * smart 任务立即刷新余额；managed 任务只有未关闭（间隔 > 0）时才跑。
 */


function createCoordinatorChainHeightTask(woc: WocService) {
  return createChainHeightTask({
    network: bitfsNetwork,
    readHeight: (network, signal) => testChainHeightProvider ? testChainHeightProvider(network) : woc.getChainHeight(network, { priority: "background", signal }),
    snapshot: () => coordinatorChainHeight,
    publish: snapshot => {
      coordinatorChainHeight = snapshot;
      publishTopicEvent("chain.height", { type: "chain.height.changed", sessionEpoch: coordinatorState.sessionEpoch, chainHeight: { ...snapshot } });
    },
  });
}

/** 依赖与作用域失效时撤下任务定时器。 */

const workerIdentityProjection = createWorkerIdentityProjection();
const coordinatorActiveKeySummary = workerIdentityProjection.summary;
const setCoordinatorActiveKeySummary = workerIdentityProjection.setSummary;
function workerWalletSnapshot(): import("@keymaster/contracts").VaultLifecycleSnapshot {
  return { status: coordinatorState.vaultStatus === "fatal" ? "locked" : coordinatorState.vaultStatus,
    activePublicKeyHex: coordinatorState.vaultStatus === "unlocked" ? coordinatorState.activePublicKeyHex : undefined,
    activeKeyIdentity: coordinatorState.vaultStatus === "unlocked" ? coordinatorActiveKeySummary() : undefined,
    sessionEpoch: coordinatorState.sessionEpoch, runGeneration: coordinatorState.runGeneration,
    walletGeneration: coordinatorState.walletGeneration, vaultLifecycleRevision: sessionRevision };
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
  root: () => platformRootStore,
  binding: currentCoordinatorStorageBinding,
  sameBinding: storageBindingsEqual,
  assertAvailable: assertStorageDataAvailable,
  assertLive: assertStorageBindingLive,
  beginRequest: beginStorageBindingRequest,
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
    const binding = currentCoordinatorStorageBinding();
    if (!binding) throw storageUnavailableError("Worker file binding is unavailable");
    const files = createWorkerModuleFileStore(pluginId, declaration.purposeId);
    return { ...files, ...declaration, model: "files" as const, ...binding, close: () => {} };
  },
  async openOwnerAppStore({ pluginId, declaration }) {
    const binding = currentCoordinatorStorageBinding();
    if (!binding) throw storageUnavailableError("Worker K-V binding is unavailable");
    const store = createWorkerKeyValueStore(pluginId, declaration.purposeId);
    return { ...store, ...binding };
  },
  async openPlatformStore() { throw storageUnavailableError("Worker public clients do not expose platform purposes"); },
  async clearStorageRoot() { throw storageUnavailableError("Worker public clients do not clear roots"); },
}, pluginId => BUILTIN_PLUGIN_DEFINITIONS.find(plugin => plugin.id === pluginId), (consumer, scope) => workerConsumers.get(consumer) === scope);

/**
 * 为 P2PKH service 提供 Worker 内的 active-key capability。
 *
 * 这里没有把 private key 放进返回值；返回的 capability 只闭包引用
 * Coordinator 当前的私钥缓冲，并且每次签名/派生前重新校验 owner 与
 * session。这样 Sat top-up 复用 P2PKH 交易编排时仍然满足私钥不出 Worker。
 */
let vaultCryptoProviderScope: import("webloom-framework").LifecycleScope | undefined;
const workerSessionCryptoFactory = createWorkerActiveKeyCryptoFactory({
  summary: coordinatorActiveKeySummary,
  sessionEpoch: () => coordinatorState.sessionEpoch,
  keySession: vaultKeySession,
  withIoLease(operation, execute) {
    return operation === "sign"
      ? withCoordinatorFinalIoLease("write", undefined, execute, { auditOperation: "vault.digest.sign" })
      : withCoordinatorFinalIoLease("write", undefined, execute, { auditOperation: "vault.address.derive" });
  },
});

function createWorkerActiveKeyCrypto(owner: string, providerScope = vaultCryptoProviderScope) {
  if (!providerScope && !testDomainUnitReadiness) throw new Error("Vault crypto provider is unavailable");
  return workerSessionCryptoFactory(owner, providerScope);
}

/**
 * P2PKH service 仍由现有 Coordinator broadcast pipeline 负责广播；Sat
 * 充值只注入一个内部 Coordinator facade，避免从 SharedWorker 再绕回页面。
 */
const workerTransferRuntime = createWorkerTransferRuntime({
  assertActive: () => {
    assertCoordinatorUnitConstructible("p2pkh.coordinator-worker");
    if (!testDomainUnitReadiness) { if (!p2pkhWorkerPorts) throw new Error("P2PKH Worker instance is unavailable"); p2pkhWorkerPorts.assertActive(); }
  },
  session: () => ({ owner: coordinatorState.activePublicKeyHex, epoch: coordinatorState.sessionEpoch, unlocked: coordinatorState.vaultStatus === "unlocked" }),
  loadSettings: (owner) => loadP2pkhSettingForOwner(owner),
  settings: () => coordinatorMeta.p2pkhSettings,
  walletState: () => testDomainUnitReadiness ? createWorkerWalletState() : p2pkhWorkerPorts!.walletState,
  storage: () => testDomainUnitReadiness ? createWorkerModuleFileStore("p2pkh", "") : p2pkhWorkerPorts!.storage,
  crypto: (owner) => testDomainUnitReadiness ? createWorkerActiveKeyCrypto(owner) : p2pkhWorkerPorts!.crypto.createActiveKeyCrypto(owner),
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
  subscribeUtxo: subscribeWorkerUtxoSeq,
  retryOptions: () => testSatBroadcastRetryOverrides,
});
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

async function installP2pkhCoordinatorTasks(walletState: VaultWalletState, woc: WocService, assertActive: () => void = () => {}, storage: BorrowedModuleFileStore = createWorkerModuleFileStore("p2pkh", "")): Promise<() => void> {
  const epoch = coordinatorState.sessionEpoch;
  for (const id of ["p2pkh.transactions-sync", "p2pkh.utxo-snapshot"]) {
    await coordinatorState.taskRuntimes.get(id)?.completion?.catch(() => undefined);
  }
  assertActive();
  if (coordinatorState.sessionEpoch !== epoch) throw new Error("P2PKH task installation became stale");
  const definitions = createP2pkhWorkerTaskDefinitions({
    walletState, woc, storage,
    isNetworkEnabled: network => network === "main" || coordinatorMeta.p2pkhSettings?.includeTestnet === true,
    loadSettings: loadP2pkhSettingForOwner,
    refreshUtxos: signal => refreshP2pkhUtxoSnapshots(signal, storage, assertActive),
    emitDataChanged: (kinds, utxoSeqs) => publishTopicEvent("asset.data-changed", { type: "asset.data-changed", providerId: "p2pkh", publicKeyHex: coordinatorState.activePublicKeyHex ?? "", kinds, ...(utxoSeqs === undefined ? {} : { utxoSeqs }) }),
  });
  for (const definition of definitions) {
    coordinatorState.taskRuntimes.set(definition.id, createCoordinatorTaskRuntime({
      id: definition.id, pluginId: definition.pluginId, unitId: definition.unitId,
      syncPolicy: definition.syncPolicy,
      ...(definition.syncPolicy === "managed" ? { intervalMs: managedIntervalFor(definition.id) } : {}),
      keyScope: definition.keyScope,
      run: async context => { await definition.run({ ...context, reportProgress: () => undefined }); },
    }));
  }
  const tasks = ["p2pkh.transactions-sync", "p2pkh.utxo-snapshot"].map(id => coordinatorState.taskRuntimes.get(id)!);
  for (const task of tasks) scheduleRuntime(task);
  return () => {
    for (const task of tasks) {
      task.controller?.abort();
      if (task.timer) clearTimeout(task.timer);
      const remove = () => { if (coordinatorState.taskRuntimes.get(task.id) === task) coordinatorState.taskRuntimes.delete(task.id); };
      if (task.completion) void task.completion.then(remove, remove);
      else remove();
    }
  };
}

async function installCoordinatorDomainTask(task: import("@keymaster/contracts").BackgroundTaskDefinition & { unitId: string }, pluginId: string, assertActive: () => void): Promise<() => void> {
  const epoch = coordinatorState.sessionEpoch;
  await coordinatorState.taskRuntimes.get(task.id)?.completion?.catch(() => undefined);
  assertActive();
  if (epoch !== coordinatorState.sessionEpoch) throw new Error("Domain task installation became stale");
  const runtime = createCoordinatorTaskRuntime({
    id: task.id, pluginId, unitId: task.unitId, syncPolicy: "managed", intervalMs: managedIntervalFor(task.id), keyScope: task.keyScope,
    run: async context => {
      const gate = await task.canRun?.();
      if (gate?.ready === false) throw new Error(typeof gate.reason === "string" ? gate.reason : gate.reason?.fallback ?? "Domain task is unavailable");
      await task.run({ ...context, reportProgress: () => undefined });
    },
  });
  coordinatorState.taskRuntimes.set(task.id, runtime);
  scheduleRuntime(runtime);
  return () => {
    runtime.controller?.abort();
    if (runtime.timer) clearTimeout(runtime.timer);
    const remove = () => { if (coordinatorState.taskRuntimes.get(task.id) === runtime) coordinatorState.taskRuntimes.delete(task.id); };
    if (runtime.completion) void runtime.completion.then(remove, remove);
    else remove();
  };
}

async function installContactsCoordinatorService(walletState: VaultWalletState, storage: BorrowedModuleFileStore, vault: { status(): string }, assertActive: () => void, ownCleanup: (cleanup: () => void) => void = () => {}, channel: ContactsPresenceChannel = createCoordinatorChannelRuntime()): Promise<() => void> {
  coordinatorContactsPresenceOff?.();
  coordinatorContactsPresenceOff = undefined;
  coordinatorContactsService?.dispose?.();
  const contactsService = createContactsService({
    walletState,
    messageBus: coordinatorDomainMessageBus,
    storage,
    channel
  });
  coordinatorContactsService = contactsService;
  const offContactsChange = contactsService.onChange(() => publishCoordinatorContactsPresence());
  const offContactsPresence = contactsService.onPresenceChange?.(() => publishCoordinatorContactsPresence());
  coordinatorContactsPresenceOff = () => {
    offContactsChange();
    offContactsPresence?.();
  };
  publishCoordinatorContactsPresence();
  const contactsPresenceTask = createContactsPresenceTask({ service: contactsService, walletState, vault });
  let disposeTask: (() => void) | undefined;
  const cleanup = () => {
    disposeTask?.();
    offContactsChange();
    offContactsPresence?.();
    contactsService.dispose?.();
    if (coordinatorContactsService === contactsService) {
      coordinatorContactsService = undefined;
      coordinatorContactsPresenceOff = undefined;
    }
  };
  ownCleanup(cleanup);
  try {
    disposeTask = await installCoordinatorDomainTask(contactsPresenceTask, "contacts", assertActive);
    assertActive();
    return cleanup;
  } catch (error) {
    cleanup();
    throw error;
  }
}

function initializeCoordinatorWocService(): ReturnType<typeof createWocService> {
  if (!coordinatorDomainMessageBus) throw new Error("Worker message bus is unavailable");
  const woc = createWocService({ messageBus: coordinatorDomainMessageBus });
  p2pkhWocService = woc;
  // 智能调度订阅 WoC 队列：队列变空 2 秒后刷新余额快照；变忙则重新计时。
  woc.onQueueChange(onWocQueueChanged);
  const persistedWocConfig = coordinatorMeta.p2pkhProviderConfigs?.woc;
  if (persistedWocConfig) {
    const next: Partial<import("@keymaster/contracts").WocConfig> = {};
    if (typeof persistedWocConfig.endpoint === "string" && persistedWocConfig.endpoint.trim()) next.baseUrl = persistedWocConfig.endpoint.trim();
    if (typeof persistedWocConfig.requestsPerSecond === "number") next.requestsPerSecond = persistedWocConfig.requestsPerSecond;
    if (Object.keys(next).length) woc.updateConfig(next);
  }
  return woc;
}

function initializeCoordinatorP2pkhProviders(woc: WocService, broadcast: WocWorkerBroadcastService): void {
  p2pkhRegistry = createP2pkhProviderRegistry();
  registerWocP2pkhProviders({ registry: p2pkhRegistry, woc: broadcast });
  p2pkhUtxoSnapshots = createP2pkhUtxoSnapshotStore({ woc: createP2pkhSnapshotWocSource(woc) });
}

async function registerCoordinatorTasks(): Promise<void> {
  const walletState = createWorkerWalletState();
  const messageBus = createMessageBus();
  coordinatorDomainMessageBus = messageBus;
  if (testDomainUnitReadiness) await installContactsCoordinatorService(walletState, createWorkerModuleFileStore("contacts", "address-book"), { status: () => coordinatorState.vaultStatus }, () => {});
  const woc = testDomainUnitReadiness ? initializeCoordinatorWocService() : undefined;
  if (woc) initializeCoordinatorP2pkhProviders(woc, woc);
  if (testDomainUnitReadiness && woc) await installCoordinatorDomainTask(createCoordinatorChainHeightTask(woc), "woc", () => {});
  if (testDomainUnitReadiness && woc) await installP2pkhCoordinatorTasks(walletState, woc);
  const p2pkhProvider = createP2pkhWorkerAssetReader({ walletState, storage: createWorkerModuleFileStore("p2pkh", ""), snapshots: () => p2pkhUtxoSnapshots, includeTestnet: () => coordinatorMeta.p2pkhSettings?.includeTestnet === true });
  const vault = { status: () => coordinatorState.vaultStatus, } as VaultService;
  if (testDomainUnitReadiness && woc) {
  const bsv21Task = createBsv21CoordinatorTask({ walletState, stateStore: createWorkerKeyValueStore("token-bsv21", "token-state"), p2pkh: p2pkhProvider, woc: createWocBsv21Service({ messageBus }), wocService: woc, vault, notifier: { emit: (event) => publishTopicEvent("asset.data-changed", { type: "asset.data-changed", providerId: event.providerId, publicKeyHex: event.publicKeyHex ?? "", kinds: event.kinds }), subscribe: () => () => undefined } });
  const stasTask = createStasCoordinatorTask({ walletState, stateStore: createWorkerKeyValueStore("token-stas", "token-state"), p2pkh: p2pkhProvider, woc: createWocStasService({ messageBus }), vault, notifier: { emit: (event) => publishTopicEvent("asset.data-changed", { type: "asset.data-changed", providerId: event.providerId, publicKeyHex: event.publicKeyHex ?? "", kinds: event.kinds }), subscribe: () => () => undefined } });
  const oneSatTask = createOrdinalsCoordinatorTask({ walletState, p2pkh: p2pkhProvider, woc: createWoc1SatOrdinalsService({ messageBus }), wocService: woc, vault, notifier: { emit: (event) => publishTopicEvent("asset.data-changed", { type: "asset.data-changed", providerId: event.providerId, publicKeyHex: event.publicKeyHex ?? "", kinds: event.kinds }), subscribe: () => () => undefined } });
  coordinatorState.taskRuntimes.set(bsv21Task.id, createCoordinatorTaskRuntime({ id: bsv21Task.id, pluginId: "token-bsv21", unitId: bsv21Task.unitId, syncPolicy: "managed", intervalMs: managedIntervalFor(bsv21Task.id), keyScope: () => coordinatorState.activePublicKeyHex ? { publicKeyHex: coordinatorState.activePublicKeyHex } : undefined, run: async ({ signal, reason, assertSessionFresh }) => { await bsv21Task.run({ signal, reason, reportProgress: () => undefined, assertSessionFresh }); } }));
  coordinatorState.taskRuntimes.set(stasTask.id, createCoordinatorTaskRuntime({ id: stasTask.id, pluginId: "token-stas", unitId: stasTask.unitId, syncPolicy: "managed", intervalMs: managedIntervalFor(stasTask.id), keyScope: () => coordinatorState.activePublicKeyHex ? { publicKeyHex: coordinatorState.activePublicKeyHex } : undefined, run: async ({ signal, reason, assertSessionFresh }) => { await stasTask.run({ signal, reason, reportProgress: () => undefined, assertSessionFresh }); } }));
  coordinatorState.taskRuntimes.set(oneSatTask.id, createCoordinatorTaskRuntime({ id: oneSatTask.id, pluginId: "collectible-1satordinals", unitId: oneSatTask.unitId, syncPolicy: "managed", intervalMs: managedIntervalFor(oneSatTask.id), keyScope: () => coordinatorState.activePublicKeyHex ? { publicKeyHex: coordinatorState.activePublicKeyHex } : undefined, run: async ({ signal, reason, assertSessionFresh }) => { await oneSatTask.run({ signal, reason, reportProgress: () => undefined, assertSessionFresh }); } }));
  }
  bindCoordinatorTaskUnitsToOwner();
  for (const runtime of coordinatorState.taskRuntimes.values()) scheduleRuntime(runtime);
  publishTopicEvent("background.snapshot", { type: "background.snapshot.changed", sessionEpoch: coordinatorState.sessionEpoch, snapshots: getTaskSnapshots() });
  // 任务在「已解锁」状态下补齐注册（首次接入存储等）时，第一时间同步一次。
  triggerImmediateSync(BACKGROUND_TRIGGER_REASON.INIT);
}

// ============================================================
// 3. Utility Functions
// ============================================================

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

function isP2pkhBroadcastRequest(request: CoordinatorClientRequest): request is Extract<CoordinatorClientRequest, { kind: "p2pkh.broadcast" }> {
  return request.kind === "p2pkh.broadcast";
}

/** Remove a submission only when the Coordinator can prove no provider call was made. */
async function abortNotDispatchedP2pkhSubmission(
  request: Extract<CoordinatorClientRequest, { kind: "p2pkh.broadcast" }>,
  reason: string
): Promise<void> {
  try {
    const walletState = createWorkerWalletState();
    if (walletState.snapshot().activePublicKeyHex?.toLowerCase() !== request.ownerPublicKeyHex.toLowerCase()) throw new Error("P2PKH storage owner is not active");
    const repository = createP2pkhStateRepository(await openP2pkhStateRepository(createWorkerModuleFileStore("p2pkh", "")));
    await repository.abortUnattemptedLocalSubmission?.({ submissionId: request.submissionId, reason });
    publishTopicEvent("asset.data-changed", { type: "asset.data-changed", providerId: "p2pkh", publicKeyHex: request.ownerPublicKeyHex, kinds: ["utxo", "submission", "balance"] });
  } catch {
    // Cleanup is best-effort here. The response is still explicitly marked
    // not-dispatched, while a later reconciliation can safely inspect the row.
  }
}

async function buildTopicBaselines(
  request: CoordinatorTopicSubscription,
): Promise<CoordinatorTopicBaseline[]> {
  await storageStateTail;

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
          chainHeight: { ...coordinatorChainHeight },
        },
      }];
    }
    if (topic === "storage.state") {
      const baselineRevision = storageRevision;
      // Subscription response must be atomic; use the last published state
      // when available, otherwise a baseline derived from the cold-start truth.
      // 本地介质永远「已配置」，可失败的原因只有冷启动结论本身。
      const cached = lastStorageState ?? {
        topic: "storage.state" as const, type: "storage.state.changed" as const,
        storageRevision: baselineRevision, sessionEpoch: coordinatorState.sessionEpoch,
        ...(coordinatorState.walletGeneration ? { walletGeneration: coordinatorState.walletGeneration } : {}),
        ...(coordinatorAuthorityRecovery ? { authorityRecovery: coordinatorAuthorityRecovery } : {}),
        status: coordinatorStorageStatus(),
        summary: null,
      };
      return [{ topic, baselineRevision, sessionEpoch: coordinatorState.sessionEpoch, snapshot: cached }];
    }
    if (topic === "msfile.state") {
      const baselineRevision = msfileRevision;
      const cached = lastMsFileState ?? {
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
      const subscriptionStatuses = channelSubscriptionStatusBaseline();
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
          authorityInstanceId: coordinatorAuthorityInstanceId,
          workerUnitRevision: baselineRevision,
          sessionEpoch: coordinatorState.sessionEpoch,
          units: coordinatorRuntimeUnitSnapshots(),
        },
      }];
    }
    const baselineRevision = topic === "session.state" ? sessionRevision : backgroundSnapshotRevision;
    const snapshot = topic === "session.state"
      ? { topic, type: "session.state.changed" as const, sessionRevision: baselineRevision, sessionEpoch: coordinatorState.sessionEpoch, cause: "bootstrap" as const, vaultStatus: coordinatorState.vaultStatus, activePublicKeyHex: coordinatorState.vaultStatus === "unlocked" ? coordinatorState.activePublicKeyHex ?? null : null,
    ...(coordinatorState.vaultStatus === "unlocked" ? { activeKeyIdentity: coordinatorActiveKeySummary() } : {}), runGeneration: coordinatorState.runGeneration, ...(coordinatorState.walletGeneration ? { walletGeneration: coordinatorState.walletGeneration } : {}), autoLockTimeoutMs: coordinatorMeta.autoLockTimeoutMs ?? AUTO_LOCK_DEFAULT_TIMEOUT_MS }
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

function isStorageRequest(request: CoordinatorClientRequest): boolean {
  return request.kind === "storage.grant" || request.kind === "storage.control" || request.kind === "storage.data" || request.kind === "storage.cancel" || request.kind === "storage.session.abort" || request.kind === "storage.browse.open" || request.kind === "storage.browse.data" || request.kind === "storage.browse.close" || request.kind === "storage.owner.bind" || request.kind === "storage.platform.bind" || request.kind === "storage.owner.data" || request.kind === "storage.platform.data" || request.kind === "storage.clear.root";
}

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

/** 清理进入 Worker 的一次性密码/明文字段；不得让 RPC 对象成为隐式缓存。 */
function clearStorageRequestSecrets(request: CoordinatorClientRequest): void {
  if (request.kind === "storage.control") {
    const control = request.control;
    if (control.type === "unlock") {
      control.password = "";
    }
    if (control.type === "initialize") {
      control.plan.firstKey.password = "";
      if (control.plan.firstKey.kind === "import") {
        control.plan.firstKey.material.hex = "";
        control.plan.firstKey.material.wif = undefined;
      }
    }
    if (control.type === "change-key-password") {
      control.oldPassword = "";
      control.newPassword = "";
    }
  }
}

function clearVaultOperationSecrets(operation: CoordinatorVaultOperation): void {
  switch (operation.type) {
    case "verifyPassword":
      operation.password = "";
      return;
    case "changePassword":
      operation.oldPassword = "";
      operation.newPassword = "";
      return;
    case "sealLocalSecret":
      operation.plaintext.fill(0);
      return;
    default:
      return;
  }
}

function disconnectedClientResponse(requestId: string): CoordinatorResponse {
  return storageErrorResponse(requestId, Object.assign(new Error("Coordinator client disconnected"), { code: "transport_disconnected" }));
}

async function executeStorageControl(
  request: Extract<CoordinatorClientRequest, { kind: "storage.control" }>,
  signal?: AbortSignal,
  peerId?: string,
): Promise<CoordinatorResponse> {
  if (signal?.aborted) throw storageUnavailableError("Storage control request was cancelled");
  const control = request.control;
  const ok = (operationResult?: unknown): CoordinatorResponse => ({
    requestId: request.requestId,
    sessionEpoch: coordinatorState.sessionEpoch,
    ack: { status: "ok" },
    ...(operationResult === undefined ? {} : { operationResult }),
  });

  if (control.type === "status") {
    if (storageStartupFailure) {
      const detail = coordinatorAuthorityRecoveryOperationNames.length > 0
        ? `; active final I/O=${coordinatorAuthorityRecoveryOperationNames.join(",")}`
        : "";
      return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "error", message: `Storage startup failed${detail}`, code: "storage_unavailable" } };
    }
    // 未初始化钱包还没有平台 Root；状态是纯投影，直接用冷启动结论回答。
    if (!platformRootStore) return ok(coordinatorStorageStatus());
    const service = await ensureStorageRuntime(peerId).catch(() => undefined);
    return ok(service?.status() ?? coordinatorStorageStatus());
  }

  if (control.type === "cold-start") {
    // 冷启动是纯只读的真值查询：它必须在没有平台根时也能回答，否则 uninitialized
    // 与 corrupt/unsupported 状态无法与「Root 装不上」区分开。
    const lifecycle = walletLifecycle ?? requireWalletLifecycle();
    const snapshot = await lifecycle.coldStart();
    return ok(snapshot);
  }

  if (control.type === "summary") {
    // 摘要同属只读投影：没有 Root 时从冷启动结论和浏览器持久化授权直接
    // 构造，不把「尚未创建钱包」升级成存储故障。
    if (!platformRootStore) {
      return ok({
        status: coordinatorStorageStatus(),
        medium: "indexeddb" as const,
        persistence: await walletStore?.persistence() ?? { persisted: false },
      });
    }
    const service = await ensureStorageRuntime(peerId);
    return ok(await service.summary());
  }

  if (control.type === "initialize") {
    return ok(await initializeWallet(control.plan));
  }

  await ensureStorageRuntime(peerId);
  const result = await executeWalletControl(control, {
    lifecycle: requireWalletLifecycle(),
    beforeRevoke: revokeStorageBindingAndDrain,
    unlocked(result) {
      coordinatorState.sessionEpoch = result.sessionEpoch;
      emitStorageState();
      publishSessionState("unlock");
    },
    locked() {
      coordinatorState.vaultStatus = "locked";
      setCoordinatorActiveKeySummary(undefined);
      emitStorageState();
      publishSessionState("lock");
    },
    passwordChanged() {
      emitStorageState();
      publishSessionState("change-password");
    },
    reset() {
      discardCurrentPlatformStorageBinding();
      coordinatorState.vaultStatus = "uninitialized";
      coordinatorState.walletGeneration = "";
      coordinatorState.activePublicKeyHex = undefined;
      storageColdStartState = { state: "uninitialized" };
      setCoordinatorActiveKeySummary(undefined);
      dropActivePrivateKey();
      emitStorageState();
          publishSessionState("reset-wallet");
    },
  });
  return ok(result);
}

/**
 * Storage 控制面的最终边界分类。
 *
 * 读取类操作可共享 final lease，其余控制操作都必须取得写入 admission。
 */
function storageControlIoKind(control: Extract<CoordinatorClientRequest, { kind: "storage.control" }>["control"]): "read" | "write" {
  switch (control.type) {
    case "status":
    case "summary":
    case "cold-start":
      return "read";
    default:
      return "write";
  }
}

async function executeStorageControlAtFinalBoundary(
  request: Extract<CoordinatorClientRequest, { kind: "storage.control" }>,
  signal?: AbortSignal,
  peerId?: string,
): Promise<CoordinatorResponse> {
  // 解锁、锁定、改密与重置都会主动推进会话或钱包身份世代；这些有意的
  // 本地状态迁移必须允许当前 storage control 的 final lease 观察到新
  // gate，否则旧 lease 会把它们误判成「未知来源的本地锁」。
  const transitionsSession = request.control.type === "unlock"
    || request.control.type === "lock"
    || request.control.type === "change-key-password"
    || request.control.type === "initialize"
    || request.control.type === "reset-wallet";
  return withCoordinatorFinalIoLease(
    storageControlIoKind(request.control),
    signal,
    (leaseSignal) => executeStorageControl(request, leaseSignal, peerId),
    {
      auditOperation: "storage.control",
      allowLocalLock: transitionsSession,
      allowLocalOwnerTransition: transitionsSession,
      // 重置会撤销运行根并重新安装；初始化同样要换绑到新钱包身份世代。
      allowLocalBindingDiscard: request.control.type === "reset-wallet" || request.control.type === "initialize",
      durableLease: storageControlIoKind(request.control) === "write",
    },
  );
}

const { executePlatformStorageDataUnsafe, executeOwnerStorageDataUnsafe, executeStorageDataUnsafe } = createStorageDataExecutor({
  root: () => platformRootStore,
  rootToken: () => platformRootToken,
  sessionEpoch: () => coordinatorState.sessionEpoch,
  assertStorageDataAvailable,
  storageUnavailableError,
  resolvePlatformStorageGrant,
  resolveOwnerStorageGrant,
  resolveStorageGrant,
  ensureStorageRuntime,
  beginStorageBindingRequest,
  currentCoordinatorStorageBinding,
  assertStorageBindingLive,
});

async function executePlatformStorageData(
  data: CoordinatorPlatformStorageData,
  actualClientId: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const operation = data.type === "platform.get" || data.type === "platform.list" ? "read" : "write";
  return withCoordinatorFinalIoLease(operation, signal, () => executePlatformStorageDataUnsafe(data, actualClientId, signal), {
    auditOperation: "storage.platform.data",
    // 平台 K-V 的 get/list 没有外部副作用；保留本地运行世代前后校验，
    // 但不把页面导航中尚未返回的只读 Promise 写成持久运行锁。
    durableLease: operation === "write",
  });
}

async function executeOwnerStorageData(
  data: CoordinatorOwnerStorageData,
  actualClientId: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const operation = data.type === "owner.get" || data.type === "owner.list" ? "read" : "write";
  return withCoordinatorFinalIoLease(operation, signal, (leaseSignal) => executeOwnerStorageDataUnsafe(data, actualClientId, leaseSignal), {
    auditOperation: "storage.owner.data",
    // owner K-V 的读取没有不可逆副作用；写入仍登记当前 Worker 的内存
    // lease，保证本次运行不会越过未知的本地写入。
    durableLease: operation === "write",
  });
}


async function executeStorageData(request: Extract<CoordinatorClientRequest, { kind: "storage.data" }>, controller: AbortController, actualClientId: string): Promise<CoordinatorResponse> {
  const operation = request.data.type === "list" || request.data.type === "get-range" ? "read" : "write";
  return withCoordinatorFinalIoLease(operation, controller.signal, () => executeStorageDataUnsafe(request, controller, actualClientId), { auditOperation: "storage.connect.data" });
}

/** 只撤销当前 App 的数据请求和 grant，不能反调 controller.abortSession 形成递归。 */
function revokeStorageSessionRequests(connectSessionId: string): void {
  for (const [requestId, pending] of storageRequests) {
    if (pending.connectSessionId === connectSessionId) { pending.controller.abort(); storageRequests.delete(requestId); }
  }
  for (const [grantId, grant] of storageGrants) if (grant.context.connectSessionId === connectSessionId) storageGrants.delete(grantId);
}

async function abortStorageSession(connectSessionId: string, peerId: string): Promise<void> {
  revokeStorageSessionRequests(connectSessionId);
  const service = await ensureStorageRuntime(peerId);
  await service.abortSession(connectSessionId);
}

async function executeStorageRequest(request: Extract<CoordinatorClientRequest, { kind: "storage.grant" | "storage.control" | "storage.data" | "storage.cancel" | "storage.session.abort" | "storage.browse.open" | "storage.browse.data" | "storage.browse.close" | "storage.owner.bind" | "storage.platform.bind" | "storage.owner.data" | "storage.platform.data" | "storage.clear.root" }>, actualClientId: string, requestSignal?: AbortSignal): Promise<CoordinatorResponse> {
  if (request.kind === "storage.grant") {
    const session = await readProtocolConnectSession(request.connectSessionId);
    if (revokedCoordinatorPeerIds.has(actualClientId)) return disconnectedClientResponse(request.requestId);
    if (!session) return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "error", message: "Storage session is invalid or revoked", code: "storage_identity_required" } };
    if (coordinatorState.vaultStatus !== "unlocked" || !coordinatorState.activePublicKeyHex || !platformRootStore) {
      return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "error", message: "Storage requires an unlocked wallet", code: "storage_identity_required" } };
    }
    const verifiedAppIdentity = {
      publisherPublicKeyHex: session.appIdentity.publisherPublicKeyHex,
      appId: session.appIdentity.appId,
    };
    const moduleId = deriveThirdPartyStorageModuleId(session.appIdentity.publisherPublicKeyHex, session.appIdentity.appId);
    // 目录名由平台登记并绑定验证身份；App 只能看到自己那一个目录，既不能
    // 列举 `apps/` 根，也不能指定别的 name 切换目录。
    const appStorageName = resolveConnectAppStorageName(verifiedAppIdentity);
    if (revokedCoordinatorPeerIds.has(actualClientId)) return disconnectedClientResponse(request.requestId);
    const grantId = `grant-${crypto.randomUUID()}`;
    storageGrants.set(grantId, {
      context: {
        connectSessionId: session.sessionId,
        transportOrigin: session.origin,
        appIdentity: session.appIdentity,
        appStorageName,
        moduleId,
        purposeId: "files",
        sessionEpoch: coordinatorState.sessionEpoch,
        walletGeneration: coordinatorState.walletGeneration,
        runGeneration: coordinatorState.runGeneration,
      },
      clientId: actualClientId,
      sessionEpoch: coordinatorState.sessionEpoch,
    });
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: grantId };
  }
  if (request.kind === "storage.browse.open" || request.kind === "storage.browse.data" || request.kind === "storage.browse.close") {
    return storageBrowseCoordinator.execute(request, actualClientId, requestSignal);
  }
  if (request.kind === "storage.cancel") {
    const target = storageRequests.get(storageRequestKey(actualClientId, request.targetRequestId));
    if (target?.clientId === actualClientId) target.controller.abort();
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" } };
  }
  if (request.kind === "storage.session.abort") {
    await abortStorageSession(request.connectSessionId, actualClientId);
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" } };
  }
  if (request.kind === "storage.platform.bind") {
    // platform bind 只面向平台专属 K-V。请求体只用于声明匹配，grant 始终
    // 由 Coordinator 使用中央声明目录里的预存值生成，调用方不能自报
    // module/purpose 来扩大权限。
    const expected = SYSTEM_STORAGE_DECLARATIONS[request.pluginId]?.flat().find((candidate) => candidate.authority === "platform-only" && candidate.purposeId === request.declaration.purposeId);
    if (!expected || expected.authority !== "platform-only" || expected.model !== "kv"
      || request.declaration.moduleId !== expected.moduleId
      || request.declaration.purposeId !== expected.purposeId
      || request.declaration.authority !== expected.authority
      || request.declaration.model !== expected.model
      || request.declaration.schemaVersion !== expected.schemaVersion) {
      return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "error", message: "Platform storage declaration is not authorized", code: "storage_forbidden" } };
    }
    if (!platformRootStore) return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "error", message: "Platform storage requires a ready root", code: "storage_unavailable" } };
    const grant: StoragePlatformGrant & { clientId: string } = {
      platformGrantId: `platform-${crypto.randomUUID()}`,
      walletGeneration: coordinatorState.walletGeneration,
      runGeneration: coordinatorState.runGeneration,
      moduleId: expected.moduleId,
      purposeId: expected.purposeId,
      authority: expected.authority,
      model: expected.model,
      schemaVersion: expected.schemaVersion,
      sessionEpoch: coordinatorState.sessionEpoch,
      clientId: actualClientId
    };
    platformStorageGrants.set(grant.platformGrantId, grant);
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: grant };
  }
  if (request.kind === "storage.owner.bind") {
    const expected = SYSTEM_STORAGE_DECLARATIONS[request.pluginId]?.find((candidate) => candidate.authority === "built-in-module" && candidate.purposeId === request.declaration.purposeId);
    if (!expected || expected.authority !== "built-in-module"
      || (expected.model !== "kv" && expected.model !== "files")
      || request.declaration.moduleId !== expected.moduleId
      || request.declaration.purposeId !== expected.purposeId
      || request.declaration.authority !== expected.authority
      || request.declaration.model !== expected.model
      || request.declaration.schemaVersion !== expected.schemaVersion) {
      return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "error", message: "Owner storage declaration is not authorized", code: "storage_forbidden" } };
    }
    if (coordinatorState.vaultStatus !== "unlocked" || !coordinatorState.activePublicKeyHex || !platformRootStore) return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "error", message: "Owner storage requires an unlocked wallet", code: "storage_unavailable" } };
    if (revokedCoordinatorPeerIds.has(actualClientId)) return disconnectedClientResponse(request.requestId);
    const grant: StorageOwnerGrant & { clientId: string } = {
      storageGrantId: `owner-${crypto.randomUUID()}`,
      walletGeneration: coordinatorState.walletGeneration,
      runGeneration: coordinatorState.runGeneration,
      moduleId: expected.moduleId,
      purposeId: expected.purposeId,
      authority: expected.authority,
      model: expected.model,
      schemaVersion: expected.schemaVersion,
      sessionEpoch: coordinatorState.sessionEpoch,
      clientId: actualClientId,
    };
    ownerStorageGrants.set(grant.storageGrantId, grant);
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: grant };
  }
  if (request.kind === "storage.clear.root") {
    // 只清空一个已绑定根：中央声明目录里登记过的 namespace，或某个已验证 App
    // 自己的 apps/<app-name>/ 目录。调用方不能自报未登记的坐标，也不能用
    // 别人的 name 清理其它 App 的数据。
    if (revokedCoordinatorPeerIds.has(actualClientId)) return disconnectedClientResponse(request.requestId);
    if (!platformRootStore) {
      return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "error", message: "Storage root is unavailable", code: "storage_unavailable" } };
    }
    const declaration = request.input.declaration;
    if (declaration.authority === "third-party-app") {
      if (request.input.appStorageName === undefined) {
        return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "error", message: "Clearing an app root requires its registered appStorageName", code: "storage_forbidden" } };
      }
      if (declaration.model !== "files" || declaration.purposeId !== "") {
        return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "error", message: "Third-party app storage declaration is invalid", code: "storage_forbidden" } };
      }
    } else {
      const expected = Object.values(CENTRAL_STORAGE_DECLARATIONS).find((candidate) => candidate.moduleId === declaration.moduleId
        && candidate.purposeId === declaration.purposeId
        && candidate.authority === declaration.authority
        && candidate.model === declaration.model
        && candidate.schemaVersion === declaration.schemaVersion);
      if (!expected) {
        return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "error", message: "Storage declaration is not authorized", code: "storage_forbidden" } };
      }
    }
    const controller = new AbortController();
    const requestKey = storageRequestKey(actualClientId, request.requestId);
    storageRequests.set(requestKey, { controller, clientId: actualClientId });
    try {
      await withCoordinatorFinalIoLease("write", controller.signal, async (signal) => {
        if (signal.aborted) throw storageUnavailableError("Storage root clearing was cancelled");
        const root = platformRootStore;
        if (!root) throw storageUnavailableError("Platform storage has not been bootstrapped");
        await root.clearStorageRoot(request.input);
      }, { auditOperation: "storage.platform.data" });
    } catch (error) {
      markStorageIoFailure(error);
      throw error;
    } finally {
      if (storageRequests.get(requestKey)?.controller === controller) storageRequests.delete(requestKey);
    }
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: true };
  }
  if (request.kind === "storage.owner.data") {
    if (revokedCoordinatorPeerIds.has(actualClientId)) return disconnectedClientResponse(request.requestId);
    const controller = new AbortController();
    const requestKey = storageRequestKey(actualClientId, request.requestId);
    storageRequests.set(requestKey, { controller, clientId: actualClientId });
    let value: unknown;
    try {
      value = await withStorageDataSlot(actualClientId, () => executeOwnerStorageData(request.data, actualClientId, controller.signal), controller.signal);
    } catch (error) {
      markStorageIoFailure(error);
      throw error;
    } finally {
      if (storageRequests.get(requestKey)?.controller === controller) storageRequests.delete(requestKey);
    }
    return {
      requestId: request.requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "ok" },
      // owner.delete is void; owner.get may legitimately return undefined.
      ...(request.data.type === "owner.delete" ? {} : { operationResult: value }),
    };
  }
  if (request.kind === "storage.platform.data") {
    if (revokedCoordinatorPeerIds.has(actualClientId)) return disconnectedClientResponse(request.requestId);
    const controller = new AbortController();
    const requestKey = storageRequestKey(actualClientId, request.requestId);
    storageRequests.set(requestKey, { controller, clientId: actualClientId });
    let value: unknown;
    try {
      value = await withStorageDataSlot(
        actualClientId,
        () => executePlatformStorageData(request.data, actualClientId, controller.signal),
        controller.signal,
      );
    } catch (error) {
      markStorageIoFailure(error);
      throw error;
    } finally {
      if (storageRequests.get(requestKey)?.controller === controller) storageRequests.delete(requestKey);
    }
    return {
      requestId: request.requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "ok" },
      ...(request.data.type === "platform.delete" ? {} : { operationResult: value }),
    };
  }
  const controller = new AbortController();
  const requestKey = storageRequestKey(actualClientId, request.requestId);
  let physicalStarted = false;
  let physicalAccountingReleased = false;
  const releasePhysicalAccounting = (): void => {
    if (physicalAccountingReleased) return;
    physicalAccountingReleased = true;
    // A client may reuse a requestId after cancellation. Do not let the old
    // physical operation delete the newer request's controller entry.
    if (storageRequests.get(requestKey)?.controller === controller) storageRequests.delete(requestKey);
    if (request.kind === "storage.data") releaseStoragePortSlot(actualClientId);
  };
  if (request.kind === "storage.data") {
    if (!reserveStoragePortSlot(actualClientId)) return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "error", message: "storage_limit_exceeded", code: "storage_limit_exceeded" } };
  }
  if (revokedCoordinatorPeerIds.has(actualClientId)) {
    if (request.kind === "storage.data") releaseStoragePortSlot(actualClientId);
    return disconnectedClientResponse(request.requestId);
  }
  storageRequests.set(requestKey, { controller, clientId: actualClientId, connectSessionId: request.kind === "storage.data" && "grantId" in request.data ? storageGrants.get(request.data.grantId)?.context.connectSessionId : undefined });
  try {
    if (request.kind === "storage.control") {
      let result!: CoordinatorResponse;
      const run = storageMutationTail.then(() => executeStorageControlAtFinalBoundary(request, controller.signal, actualClientId), () => executeStorageControlAtFinalBoundary(request, controller.signal, actualClientId));
      storageMutationTail = run.then(() => undefined, () => undefined);
      result = await run;
      return result;
    }
    return await withStorageDataSlot(
      actualClientId,
      () => executeStorageData(request, controller, actualClientId),
      controller.signal,
      {
        onPhysicalStart: () => { physicalStarted = true; },
        // The RPC may already have returned a cancellation error here. Keep
        // the admission count and request binding until the real Provider
        // Promise settles, otherwise repeated cancel calls bypass the limit.
        onPhysicalSettled: releasePhysicalAccounting
      }
    );
  } catch (err) {
    markStorageIoFailure(err);
    const code = (err as { code?: string })?.code;
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "error", message: err instanceof Error ? err.message : String(err), ...(typeof code === "string" ? { code: code as never } : {}) } };
  } finally {
    if (request.kind === "storage.data") {
      // Queued/early-cancelled calls never acquired a physical slot, so their
      // admission reservation belongs to the RPC lifecycle. Once physical
      // execution starts, releasePhysicalAccounting owns it until settle.
      if (!physicalStarted) releasePhysicalAccounting();
    } else if (storageRequests.get(requestKey)?.controller === controller) {
      storageRequests.delete(requestKey);
    }
  }
}

async function executeSatRequest(
  request: Extract<CoordinatorClientRequest, { kind: "sat.operation" }>,
): Promise<CoordinatorResponse> {
  // Sat 的 service.publish、TopUp、collect 和 Supplier 配置共享同一个
  // runtime；全部在内存 write lease 内完成，避免本次运行发生在签名/付款/
  // 远端提交与本地结果落库之间。
  if (coordinatorState.vaultStatus !== "unlocked" || !coordinatorState.activePublicKeyHex) {
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "locked" } };
  }
  return withCoordinatorFinalIoLease(
    "write",
    undefined,
    () => executeSatRequestUnsafe(request),
    { auditOperation: "sat.operation" },
  );
}

async function executeSatRequestUnsafe(
  request: Extract<CoordinatorClientRequest, { kind: "sat.operation" }>,
): Promise<CoordinatorResponse> {
  if (coordinatorState.vaultStatus !== "unlocked" || !coordinatorState.activePublicKeyHex) {
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "locked" } };
  }
  const runtime = await ensureSatRuntime();
  const value = await executeSatOperation(request.operation, runtime, async () => {
      try {
        const mux = await ensureChannelSubscriptionMux(runtime);
        await mux.set(channelCallerId({ kind: "system", systemId: "owner-inbox" }), [inboxChannel(parsePublicKey(runtime.ownerPublicKeyHex))]);
      } catch (error) {
        // 设置已落库；若当前 receive Supplier 尚不可用，保留系统 caller
        // 的意图，下一次设置/Channel 操作会再次尝试物理订阅。
        console.warn("[channel] owner inbox rebind unavailable", error instanceof Error ? error.message : String(error));
      }
  });
  return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: value };
}

// ============================================================
// Channel runtime / owner inbox
// ============================================================

const channelCallerPolicy = createChannelCallerPolicy({ sessionEpoch: () => coordinatorState.sessionEpoch, ownerPublicKeyHex: () => coordinatorState.activePublicKeyHex });
const channelCallerId = channelCallerPolicy.callerId;
const isAllowedOwnerInboxSubscription = channelCallerPolicy.allowsOwnerInboxSubscription;

/** 生成公开消息时间对；同一次签名必须只读取一次系统时钟。 */
const channelPublications = createChannelPublications({
  session: () => ({ sessionEpoch: coordinatorState.sessionEpoch, activePublicKeyHex: coordinatorState.activePublicKeyHex, vaultStatus: coordinatorState.vaultStatus }),
  signer: vaultKeySession,
  relations: channelProtocolRelations,
  unknownPublishFailure: isUnknownChannelPublishFailure,
});
const channelPublicMessageTimes = publicMessageTimes;

/** 测试公开消息时间边界；字段含义：issuedAtMs=签发时间，expiresAtMs=过期时间。 */
export function __testBuildChannelPublicMessageTimes(now: () => number = Date.now): { issuedAtMs: number; expiresAtMs: number } {
  return channelPublicMessageTimes(now);
}


function channelMonotonicNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

// Coordinator 不接受任意 RPC 自报 caller；普通插件还会在 Host context 层被
// 绑定 manifest.id，这里是 Worker 边界的第二道 fail-closed 校验。


/** 为 BitFS 买方订阅 Hash 需求与自己的 Inbox，继续复用唯一 Channel Mux。 */
async function ensureMsfileBitfsBuyerSubscriptions(runtime: SatWorkerRuntimeState): Promise<void> {
  const mux = await ensureChannelSubscriptionMux(runtime);
  const ownerInbox = inboxChannel(parsePublicKey(runtime.ownerPublicKeyHex));
  const callerId = channelCallerId({ kind: "plugin", pluginId: "msfile" }, "bitfs-buyer-runtime");
  await mux.set(callerId, [HASH_REQUEST_CHANNEL, ownerInbox], runtime.signal);
}

async function ensureMsfileBitfsSellerSubscriptions(runtime: SatWorkerRuntimeState): Promise<void> {
  const mux = await ensureChannelSubscriptionMux(runtime);
  const ownerInbox = inboxChannel(parsePublicKey(runtime.ownerPublicKeyHex));
  const callerId = channelCallerId({ kind: "plugin", pluginId: "msfile" }, "bitfs-seller-runtime");
  await mux.set(callerId, [HASH_REQUEST_CHANNEL, ownerInbox], runtime.signal);
}

async function ensureChannelSubscriptionMux(runtime: SatWorkerRuntimeState): Promise<ChannelSubscriptionMux> {
  if (channelSubscriptionMux && channelMuxOwnerPublicKeyHex === runtime.ownerPublicKeyHex) return channelSubscriptionMux;
  const existingStart = channelSubscriptionMuxStarting;
  if (existingStart && channelSubscriptionMuxStartOwner === runtime.ownerPublicKeyHex) return existingStart;
  if (existingStart) await existingStart.catch(() => undefined);

  const startGeneration = channelSubscriptionMuxGeneration;
  const start = createOwnerChannelMux({
    ownerPublicKeyHex: runtime.ownerPublicKeyHex, sessionEpoch: coordinatorState.sessionEpoch, signal: runtime.signal,
    driver: {
        // 订阅是可撤销的网络副作用，但仍必须绑定当前 Coordinator
        // authority。这样初始 owner inbox、请求中的 set/release 以及退避
        // 重试都不会在旧 Worker 接管后继续使用旧连接身份。
        subscribe: (channel, signal) => {
          if (bitfsNetwork() === "test" && channel.startsWith("bsvprice.")) return Promise.resolve();
          return withCoordinatorFinalIoLease(
          "write",
          signal,
          (leaseSignal) => runtime.handle.subscribePhysical(channel, leaseSignal),
          { allowLocalLock: true, allowLocalOwnerTransition: true, auditOperation: "channel.subscribe" },
        );
        },
        unsubscribe: (channel, signal) => withCoordinatorFinalIoLease(
          "write",
          signal,
          (leaseSignal) => runtime.handle.unsubscribePhysical(channel, leaseSignal),
          { allowLocalLock: true, allowLocalOwnerTransition: true, auditOperation: "channel.unsubscribe" },
        )
      },
    assertFresh(mux) {
      if (startGeneration !== channelSubscriptionMuxGeneration || coordinatorState.vaultStatus !== "unlocked" || coordinatorState.activePublicKeyHex !== runtime.ownerPublicKeyHex || (mux !== undefined && channelSubscriptionMux !== mux)) throw new Error("Channel subscription mux became stale during startup");
    },
    created(mux, offStatus) {
      channelSubscriptionMuxStatusOff?.();
      channelSubscriptionMux = mux;
      channelMuxOwnerPublicKeyHex = runtime.ownerPublicKeyHex;
      channelSubscriptionMuxStatusOff = offStatus;
    },
    released(mux) {
      if (channelSubscriptionMux === mux) {
        channelSubscriptionMux = undefined;
        channelMuxOwnerPublicKeyHex = undefined;
        channelSubscriptionMuxStatusOff = undefined;
      }
    },
    status: status => emitChannelSubscriptionStatus(status, runtime.ownerPublicKeyHex),
  });
  channelSubscriptionMuxStarting = start;
  channelSubscriptionMuxStartOwner = runtime.ownerPublicKeyHex;
  try {
    return await start;
  } finally {
    if (channelSubscriptionMuxStarting === start) {
      channelSubscriptionMuxStarting = undefined;
      channelSubscriptionMuxStartOwner = undefined;
    }
  }
}


type ChannelSeenMessageKind = "private" | "public" | "hash-request";

/**
 * channelSeenMessages 同时保存多种协议消息。kind 是本地存储命名空间，
 * 防止公共消息的 channel 与私密消息的 protocol 相同时互相误判为重复。
 */
function channelSeenMessageKey(kind: ChannelSeenMessageKind, ...parts: readonly string[]): string {
  return `${kind}\u0000${parts.join("\u0000")}`;
}

/** 测试不同 Channel 消息类型的本地去重命名空间。 */
export function __testBuildChannelSeenMessageKey(
  kind: ChannelSeenMessageKind,
  ...parts: readonly string[]
): string {
  return channelSeenMessageKey(kind, ...parts);
}

/**
 * 生成并发布完整的 bsv8.hash.request.v1。request_message_id 必须来自这
 * 条真实公开消息，不能由 WebRTC 插件另行随机生成后冒充 Hash 请求。
 */
async function publishChannelHashRequest(
  runtime: SatWorkerRuntimeState,
  input: { hash: string; locator: "webrtc-sdp" },
  signal?: AbortSignal,
  onPrepared?: (messageId: string) => void,
): Promise<{ messageId: string }> {
  // 签名和随后不可逆的网络 Publish 必须属于同一个最终 lease；只保护
  // sign() 会在接管发生后留下“旧 owner 已签名但仍可发布”的窗口。
  return withCoordinatorFinalIoLease(
    "write",
    signal,
    (leaseSignal) => publishChannelHashRequestUnsafe(runtime, input, leaseSignal, onPrepared),
    { auditOperation: "channel.hash-publish" },
  );
}

const publishChannelHashRequestUnsafe = channelPublications.hash;

/** Worker 内公共 Channel 消息的签名 + Publish 最终边界。 */
async function publishChannelPublicMessage(
  runtime: SatWorkerRuntimeState,
  channel: string,
  content: import("@keymaster/contracts").JSONValue,
  signal?: AbortSignal,
): Promise<{ messageId: string }> {
  validateExactChannel(channel);
  if (channel.startsWith("bsv8.inbox.")) throw new Error("bsv8.inbox.* is a reserved private channel");
  if (channel === HASH_REQUEST_CHANNEL) throw new Error("bsv8.hash.request.v1 is reserved for the trusted WebRTC Hash request publisher");
  return withCoordinatorFinalIoLease("write", signal, async (leaseSignal) => {
    return channelPublications.public(runtime, channel, content, leaseSignal);
  }, { auditOperation: "channel.public-publish" });
}

/** 在 Coordinator 内给固定业务服务使用的 Channel facade。 */
function createCoordinatorChannelRuntime(assertActive: () => void = () => undefined): ContactsPresenceChannel {
  const contactsCaller = { kind: "system" as const, systemId: "contacts-presence" };
  const assertContactsEnabled = (): void => {
    if (!isCoordinatorProductRegistered("contacts")) {
      throw new Error("Plugin unavailable: contacts");
    }
  };
  return createContactsPresenceChannel({
    assertActive,
    owner: () => coordinatorState.activePublicKeyHex,
    isReady: () => isCoordinatorProductRegistered("contacts")
      && coordinatorState.vaultStatus === "unlocked"
      && Boolean(coordinatorState.activePublicKeyHex),
    async publishPrivate(input, signal) {
      assertContactsEnabled();
      const runtime = await ensureSatRuntime();
      const protocol = privateProtocol(input.protocol);
      validatePrivateProtocolCaller(contactsCaller, protocol);
      const published = await publishPrivateEnvelope({
        runtime,
        recipientPublicKeyHex: input.recipientPublicKeyHex,
        protocol,
        body: privateBodyForPublish(protocol, input.content),
        signal: signal ?? runtime.signal
      });
      return { messageId: published.messageId, signedMessage: published.signedMessage };
    },
    async subscriptionSet(channels, signal) {
      assertContactsEnabled();
      const runtime = await ensureSatRuntime();
      const ownerSessionEpoch = coordinatorState.sessionEpoch;
      const mux = await ensureChannelSubscriptionMux(runtime);
      const result = await mux.set(channelCallerId(contactsCaller), channels, signal ?? runtime.signal);
      if (coordinatorState.vaultStatus !== "unlocked"
        || coordinatorState.sessionEpoch !== ownerSessionEpoch
        || coordinatorState.activePublicKeyHex !== runtime.ownerPublicKeyHex) {
        throw new Error("Channel subscription became stale");
      }
      return {
        channels: [...result],
        // `channels` is only the logical caller result. Include the current
        // Mux status in the same response so a newly-created caller does not
        // have to win a race with the global status event stream.
        statuses: result.map((channel) => mux.subscriptionStatus(channel)),
      };
    },
  });
}

function idleChannelSubscriptionStatus(channel: string): ChannelSubscriptionStatus {
  validateExactChannel(channel);
  return { channel, phase: "idle", errorCode: null, errorMessage: null, updatedAtMs: 0 };
}

function channelSubscriptionStatusBaseline(): ChannelSubscriptionStatus[] {
  const mux = channelSubscriptionMux;
  if (!mux || channelMuxOwnerPublicKeyHex !== coordinatorState.activePublicKeyHex) return [];
  return [...mux.subscriptionStatuses()];
}

function emitChannelSubscriptionStatus(status: ChannelSubscriptionStatus, ownerPublicKeyHex: string): void {
  if (channelMuxOwnerPublicKeyHex !== ownerPublicKeyHex) return;
  for (const subscriber of [...channelSubscriptionStatusSubscribers]) {
    if (subscriber.sessionEpoch !== coordinatorState.sessionEpoch) continue;
    try { subscriber.handler({ ...status }); } catch { /* 状态观察者不能打断 Coordinator。 */ }
  }
  publishTopicEvent("channel.events", {
    type: "channel.subscription.changed",
    subscriptionStatus: { ...status },
  });
}

function emitChannelPublicMessage(message: { channel: string; publisherPublicKeyHex: string; messageId: string; content: import("@keymaster/contracts").JSONValue }): void {
  for (const subscriber of channelPublicSubscribers) {
    try { subscriber(message); } catch { /* 单个内部消费者不能打断 Channel 路由。 */ }
  }
  publishTopicEvent("channel.events", {
    type: "channel.message.received",
    publicMessage: message
  });
}

function emitChannelPrivateMessage(message: { channel: string; publisherPublicKeyHex: string; messageId: string; protocol: string; content: import("@keymaster/contracts").JSONValue; rawEnvelope?: Uint8Array }): void {
  for (const subscriber of channelPrivateSubscribers) {
    try { subscriber(message); } catch { /* 单个内部消费者不能打断 Channel 路由。 */ }
  }
  publishTopicEvent("channel.events", {
    type: "channel.message.received",
    privateMessage: message
  });
}

async function publishPrivateEnvelope(input: {
  runtime: SatWorkerRuntimeState;
  recipientPublicKeyHex: string;
  protocol: ChannelPrivateProtocol;
  body: import("bsv8-channel-protocol/inbox").UnsignedPrivateMessage["body"];
  signal?: AbortSignal;
}): Promise<{ messageId: string; signedMessage: Uint8Array }> {
  // 私密消息也包含签名、加密和不可逆 Publish；这些步骤不能拆成多个
  // 独立边界，否则旧 Worker 仍可能在 authority 接管后发送迟到消息。
  return withCoordinatorFinalIoLease(
    "write",
    input.signal,
    (leaseSignal) => publishPrivateEnvelopeUnsafe({ ...input, signal: leaseSignal }),
    { auditOperation: "channel.private-publish" },
  );
}

const publishPrivateEnvelopeUnsafe = channelPublications.private;

const handleIncomingChannelPublish = createChannelInbound<SatWorkerRuntimeState>({
  session: () => ({ sessionEpoch: coordinatorState.sessionEpoch, activePublicKeyHex: coordinatorState.activePublicKeyHex, vaultStatus: coordinatorState.vaultStatus }),
  runtime: () => satRuntime,
  relations: channelProtocolRelations,
  openPrivate: (event, owner, epoch) => withCoordinatorFinalIoLease(
    "read", undefined,
    () => {
      if (coordinatorState.vaultStatus !== "unlocked" || coordinatorState.sessionEpoch !== epoch || coordinatorState.activePublicKeyHex !== owner) throw new Error("Channel owner changed before private message decrypt");
      return vaultKeySession.open(event.channel, event.contentJson);
    },
    { allowLocalLock: true, allowLocalOwnerTransition: true, auditOperation: "channel.incoming-decrypt" },
  ),
  publishPrivate: publishPrivateEnvelope,
  recordPong: (input) => { coordinatorContactsService?.recordVerifiedPong?.(input); },
  emitPrivate: emitChannelPrivateMessage,
  emitPublic: emitChannelPublicMessage,
  routeSignal: (body, opened, seedHashHex) => msfileBitfsRuntime.handleInboxWebRtc(body, opened, seedHashHex),
  hashRequestSeen: handleMsfileSellerHashRequest,
});

const executeOwnedChannelOperation = createChannelOperationExecutor<SatWorkerRuntimeState>({
  session: () => ({ sessionEpoch: coordinatorState.sessionEpoch, activePublicKeyHex: coordinatorState.activePublicKeyHex, vaultStatus: coordinatorState.vaultStatus }),
  publishHash: publishChannelHashRequest,
  publishPublic: publishChannelPublicMessage,
  publishPrivate: publishPrivateEnvelope,
  openPrivate: (owner, envelope, signal) => withCoordinatorFinalIoLease(
    "read", signal,
    () => vaultKeySession.open(inboxChannel(parsePublicKey(owner)), envelope),
    { allowLocalLock: true, allowLocalOwnerTransition: true, auditOperation: "channel.history-open" },
  ),
  connectSession: getAuthoritativeConnectSession,
  disconnected: clientId => revokedCoordinatorPeerIds.has(clientId),
  disconnectedResponse: disconnectedClientResponse,
  allowedInbox: isAllowedOwnerInboxSubscription,
  callers: channelCallersByClient,
});

async function executeChannelRequest(
  request: Extract<CoordinatorClientRequest, { kind: "channel.operation" }>,
  actualClientId: string,
  requestSignal?: AbortSignal,
): Promise<CoordinatorResponse> {
  if (requestSignal?.aborted || revokedCoordinatorPeerIds.has(actualClientId)) {
    return disconnectedClientResponse(request.requestId);
  }
  if (request.expectedSessionEpoch !== coordinatorState.sessionEpoch) {
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "stale-epoch" } };
  }
  if (coordinatorState.vaultStatus !== "unlocked" || !coordinatorState.activePublicKeyHex) {
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "locked" } };
  }
  const operation = request.operation;
  const callerProductId = operation.caller.kind === "plugin"
    ? operation.caller.pluginId
    : operation.caller.kind === "system"
      ? operation.caller.systemId === "contacts-presence" ? "contacts" : "sat-subscription"
      : undefined;
  // 拒绝不在发行版目录中的产品身份。登记不授予调用权限：Channel 还要
  // 复核会话、owner 与 caller。Connect caller 属于独立授权链，不在此处
  // 伪造成某个插件；它仍由 Connect session 校验保护。
  if (callerProductId && !isCoordinatorProductRegistered(callerProductId)) {
    return coordinatorProductBlockedResponse(request.requestId, callerProductId);
  }
  if (operation.ownerPublicKeyHex !== coordinatorState.activePublicKeyHex) {
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "stale-epoch" } };
  }
  if (operation.caller.kind === "connect") {
    const session = await getAuthoritativeConnectSession(operation.caller.connectSessionId);
    if (!session || session.revokedAt !== null || session.origin !== operation.caller.origin || session.ownerPublicKeyHex !== operation.ownerPublicKeyHex) {
      return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "error", message: "Channel Connect session is invalid", code: "storage_identity_required" } };
    }
  }
  const callerId = channelCallerId(operation.caller, actualClientId);
  if (operation.type === "subscription-set" || operation.type === "release") {
    const callers = channelCallersByClient.get(actualClientId) ?? new Set<string>();
    callers.add(callerId);
    channelCallersByClient.set(actualClientId, callers);
  }
  try {
    const runtime = await ensureSatRuntime();
    const mux = await ensureChannelSubscriptionMux(runtime);
    if (requestSignal?.aborted || revokedCoordinatorPeerIds.has(actualClientId)) {
      return disconnectedClientResponse(request.requestId);
    }
    return await executeOwnedChannelOperation(request, actualClientId, runtime, mux, callerId, requestSignal);
  } catch (error) {
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "error", message: error instanceof Error ? error.message : String(error) } };
  }
}

/** 页面资源只读 Coordinator 的联系人在线快照，不拥有探测或传输能力。 */
async function executeContactsPresenceSnapshot(request: Extract<CoordinatorClientRequest, { kind: "contacts.presence.snapshot" }>): Promise<CoordinatorResponse> {
  if (!isCoordinatorProductRegistered("contacts")) return coordinatorProductBlockedResponse(request.requestId, "contacts");
  return contactsPresenceProjection.snapshot(request.requestId, request.expectedSessionEpoch);
}

function isMsfileRequest(request: CoordinatorClientRequest): boolean {
  return (
    request.kind === "msfile.grant" ||
    request.kind === "msfile.control" ||
    request.kind === "msfile.data" ||
    request.kind === "msfile.cancel" ||
    request.kind === "msfile.session.abort" ||
    request.kind === "window-p2p.executor.acquire" ||
    request.kind === "window-p2p.executor.release" ||
    request.kind === "window-p2p.executor.spike.transfer" ||
    request.kind === "window-p2p.executor.identity.sign-noise" ||
    request.kind === "window-p2p.executor.identity.sign-peer-record"
  );
}

// 审查修复：控制面 mutation 必须串行。SharedWorker 的 onmessage 不等待前一个
// 请求结束，多端口可并发进入 executeMsfileControl；不串行化时同世代检查与
// “读取旧策略—合并—写回”都会互相覆盖。

/* ---------- Window P2P executor lease（施工单 001 §3.2） ----------
 * Coordinator 内存真值：同一 epoch+owner 同时最多一个 Window executor。
 * lock / key switch / Worker 重启直接清空；port 断开立即回收。 */
interface WindowP2pExecutorLeaseState extends WindowP2pExecutorLease {
  clientId: string;
  ownerPublicKeyHex: string;
  acquiredAt: number;
  lastPeerRecordSequence?: bigint;
  /** 生产 Window executor 的专用数据面通道；Spike lease 没有此字段。 */
  transportPort?: MessagePort;
  transportReady: boolean;
  /** Window 已应用的读取配置版本；未 ACK 时为 -1。 */
  transportConfigVersion: number;
}
let windowP2pExecutorLease: WindowP2pExecutorLeaseState | undefined;

interface WindowP2pExecutorBridgePending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  leaseId: string;
  cleanup?: () => void;
  reservedBytes: number;
  /** bridge 在途操作项数；小 Wire 也必须占用一个 item 配额。 */
  reservedItems: number;
}
const windowP2pExecutorBridgePending = new Map<string, WindowP2pExecutorBridgePending>();
interface WindowP2pExecutorInboundBridgePending {
  leaseId: string;
  supplierId: string;
  connectionId: string;
  ownerSessionEpoch: string;
  supplierGeneration: number;
  eventId: string;
  reservedBytes: number;
  reservedItems: number;
}
/** Window 已发送、Worker 尚未完成/拒绝的 SSP 入站 Wire。 */
const windowP2pExecutorInboundBridgePending = new Map<string, WindowP2pExecutorInboundBridgePending>();
/**
 * Worker 已启动但尚未 settle 的 Sat 入站业务 handler；这是跨 lease/owner
 * 仍然有效的资源真值。取消只能标记并 abort，不能提前删除 slot。
 */
interface ActiveSatInboundHandler {
  /** Window executor 租约编号。 */
  leaseId: string;
  /** 本次入站事件编号。 */
  eventId: string;
  /** Supplier 配置编号。 */
  supplierId: string;
  /** 真实连接实例编号。 */
  connectionId: string;
  /** 当前 owner 会话代际。 */
  ownerSessionEpoch: string;
  /** Supplier 配置代际。 */
  supplierGeneration: number;
  /** 传给支持取消的内部操作。 */
  controller: AbortController;
  /** 是否已经收到 event-cancel 或 lease/owner revoke。 */
  canceled: boolean;
  /** 入站 Wire 的 bridge 字节是否已经释放。 */
  bridgeBytesReleased: boolean;
}
const activeSatInboundHandlers = new Map<string, ActiveSatInboundHandler>();
/** 测试接缝：验证迟到/取消结果不会调用 Window 回写，不参与生产状态。 */
let testSatInboundResponseDispatcher: ((operation: SatWindowLaneOperation, signal: AbortSignal) => Promise<unknown>) | undefined;
const WINDOW_P2P_EXECUTOR_LEASE_TTL_MS = 5 * 60 * 1000;
// Spike RPC 的有界 pre-sign cancellation window：验证构建把窗口放大，给
// Chromium 的跨页消息派发留出确定的 lifecycle 竞态窗口；
// 普通生产构建仍使用 25ms，不把测试等待成本带入正式 executor。
declare const __KEYMASTER_MSFILE_SPIKE__: boolean;
const WINDOW_P2P_EXECUTOR_PRE_SIGN_YIELD_MS = typeof __KEYMASTER_MSFILE_SPIKE__ !== "undefined" && __KEYMASTER_MSFILE_SPIKE__
  ? 250
  : 25;
const WINDOW_P2P_EXECUTOR_TRANSFER_MAX_ITEMS = 5;
const WINDOW_P2P_EXECUTOR_TRANSFER_MAX_BYTES = 17 * 1024 * 1024;
const WINDOW_P2P_EXECUTOR_TRANSFER_MAX_ITEM_BYTES = 16 * 1024 * 1024;
const UINT64_MAX = (1n << 64n) - 1n;
let windowP2pExecutorLeaseTimer: ReturnType<typeof setTimeout> | undefined;
let windowP2pExecutorIdentityTail: Promise<void> = Promise.resolve();
let windowP2pExecutorTransferPendingItems = 0;
let windowP2pExecutorTransferPendingBytes = 0;
let windowP2pExecutorTransferPeakBytes = 0;

function rejectWindowP2pExecutorBridgePending(error: Error): void {
  windowP2pBridgeBudget.reset(error);
  for (const [requestId, pending] of windowP2pExecutorBridgePending) {
    windowP2pExecutorBridgePending.delete(requestId);
    windowP2pBridgeBudget.drop(pending.reservedBytes, pending.reservedItems);
    pending.cleanup?.();
    pending.reject(error);
  }
  cancelSatInboundHandlers(undefined, error.message);
  windowP2pExecutorInboundBridgePending.clear();

}

const windowP2pBridgeBudget = createWorkerBridgeBudget({ configuration: () => windowP2pExecutorConcurrencyConfig, error: windowP2pError });
const pumpWindowP2pExecutorBridgeBudget = windowP2pBridgeBudget.pump;
const reserveWindowP2pExecutorBridgeBytes = windowP2pBridgeBudget.reserve;
const releaseWindowP2pExecutorBridgeBytes = windowP2pBridgeBudget.release;

function inboundBridgeEventKey(connectionId: string, eventId: string): string {
  return connectionId + "\u0000" + eventId;
}

function reserveWindowP2pExecutorInboundEvent(event: SatWindowLaneSspRequestEvent, lease: WindowP2pExecutorLeaseState): boolean {
  const reservedBytes = event.wire.byteLength;
  const maxBytes = Math.min(windowP2pExecutorConcurrencyConfig.bridgeMaxInFlightBytes, SAT_SUBSCRIPTION_RESOURCE_LIMITS.maxBridgeInFlightBytes);
  const maxItems = Math.min(windowP2pExecutorConcurrencyConfig.bridgeMaxPendingItems, SAT_SUBSCRIPTION_RESOURCE_LIMITS.maxBridgePendingItems);
  const key = inboundBridgeEventKey(event.connectionId, event.eventId);
  if (reservedBytes < 1 || reservedBytes > maxBytes || windowP2pExecutorInboundBridgePending.has(key)) return false;
  if (!windowP2pBridgeBudget.reserveInbound(reservedBytes)) return false;
  windowP2pExecutorInboundBridgePending.set(key, {
    leaseId: lease.leaseId,
    supplierId: event.supplierId,
    connectionId: event.connectionId,
    ownerSessionEpoch: event.ownerSessionEpoch,
    supplierGeneration: event.supplierGeneration,
    eventId: event.eventId,
    reservedBytes,
    reservedItems: 1,
  });
  return true;
}

function releaseWindowP2pExecutorInboundEvent(event: Pick<SatWindowLaneSspRequestEvent, "connectionId" | "eventId">, leaseId: string): void {
  const key = inboundBridgeEventKey(event.connectionId, event.eventId);
  const pending = windowP2pExecutorInboundBridgePending.get(key);
  if (!pending || pending.leaseId !== leaseId) return;
  windowP2pExecutorInboundBridgePending.delete(key);
  releaseWindowP2pExecutorBridgeBytes(pending.reservedBytes, pending.reservedItems);
}

function activeSatInboundHandlerKey(task: Pick<ActiveSatInboundHandler, "leaseId" | "connectionId" | "eventId">): string {
  return task.leaseId + "\u0000" + task.connectionId + "\u0000" + task.eventId;
}

function releaseSatInboundHandlerBridge(task: ActiveSatInboundHandler): void {
  if (task.bridgeBytesReleased) return;
  task.bridgeBytesReleased = true;
  releaseWindowP2pExecutorInboundEvent({ connectionId: task.connectionId, eventId: task.eventId }, task.leaseId);
}

function cancelSatInboundHandler(task: ActiveSatInboundHandler, reason = "Sat inbound handler was canceled"): void {
  if (!task.canceled) {
    task.canceled = true;
    try { task.controller.abort(new DOMException(reason, "AbortError")); } catch { /* AbortController 已结束 */ }
  }
  // 取消可以立即释放 bridge 中的 Wire，但 active handler slot 要等真实
  // Promise settle 后才由 finishSatInboundHandler 释放。
  releaseSatInboundHandlerBridge(task);
}

function cancelSatInboundHandlers(leaseId?: string, reason = "Sat inbound handler was canceled"): void {
  for (const task of activeSatInboundHandlers.values()) {
    if (leaseId !== undefined && task.leaseId !== leaseId) continue;
    cancelSatInboundHandler(task, reason);
  }
}

function cancelSatInboundHandlersForConnection(connectionId: string, reason = "Sat connection was closed"): void {
  for (const task of activeSatInboundHandlers.values()) {
    if (task.connectionId === connectionId) cancelSatInboundHandler(task, reason);
  }
}

function beginSatInboundHandler(event: SatWindowLaneSspRequestEvent, lease: WindowP2pExecutorLeaseState): ActiveSatInboundHandler | undefined {
  if (activeSatInboundHandlers.size >= SAT_SUBSCRIPTION_RESOURCE_LIMITS.maxActiveWorkerInboundHandlers) return undefined;
  const task: ActiveSatInboundHandler = {
    leaseId: lease.leaseId,
    eventId: event.eventId,
    supplierId: event.supplierId,
    connectionId: event.connectionId,
    ownerSessionEpoch: event.ownerSessionEpoch,
    supplierGeneration: event.supplierGeneration,
    controller: new AbortController(),
    canceled: false,
    bridgeBytesReleased: false,
  };
  const key = activeSatInboundHandlerKey(task);
  if (activeSatInboundHandlers.has(key)) return undefined;
  activeSatInboundHandlers.set(key, task);
  return task;
}

function isCurrentSatInboundHandler(task: ActiveSatInboundHandler): boolean {
  return activeSatInboundHandlers.get(activeSatInboundHandlerKey(task)) === task
    && !task.canceled
    && windowP2pExecutorLease?.leaseId === task.leaseId
    && coordinatorState.sessionEpoch === task.ownerSessionEpoch
    && coordinatorState.vaultStatus === "unlocked"
    && satIncomingHandlers.get(task.connectionId)?.supplierId === task.supplierId
    && satIncomingHandlers.get(task.connectionId)?.ownerSessionEpoch === task.ownerSessionEpoch
    && satIncomingHandlers.get(task.connectionId)?.supplierGeneration === task.supplierGeneration;
}

function finishSatInboundHandler(task: ActiveSatInboundHandler): void {
  const key = activeSatInboundHandlerKey(task);
  if (activeSatInboundHandlers.get(key) !== task) return;
  activeSatInboundHandlers.delete(key);
  releaseSatInboundHandlerBridge(task);
}

function windowP2pError(code: string, message: string, sentBoundary?: "not-sent" | "unknown"): Error & WindowP2pExecutorError {
  const error = new Error(message) as Error & WindowP2pExecutorError;
  error.domain = "window-p2p";
  error.code = code;
  if (sentBoundary) error.sentBoundary = sentBoundary;
  return error;
}

function handleWindowP2pExecutorPortMessage(event: MessageEvent): void {
  const data = event.data as {
    type?: string;
    leaseId?: string;
    requestId?: string;
    ok?: boolean;
    result?: unknown;
    error?: WindowP2pExecutorError;
    version?: number;
    event?: unknown;
    laneId?: string;
    eventId?: string;
    connectionId?: string;
  } | undefined;
  if (!data || data.type === undefined) return;
  const lease = windowP2pExecutorLease;
  if (!lease || data.leaseId !== lease.leaseId) return;
  if (data.type === "ready") {
    lease.transportReady = data.ok === true;
    lease.transportConfigVersion = -1;
    if (!lease.transportReady) {
      clearWindowP2pExecutorLeaseLocked();
    } else {
      // 新 Host 就绪后卖方 stream 通道恢复；若卖方仍启用则回到 ready/selling。
      if (msfileBitfsRuntime.msfileSellerProtocolPort?.ready && coordinatorState.vaultStatus === "unlocked" && msfileRuntime) {
        msfileRuntime.setSellerRuntimeStatus((msfileBitfsRuntime.msfileSellerSessionManager?.activeCount() ?? 0) > 0 ? "selling" : "ready");
        void drainMsfilePendingSellerHashRequests();
      }
      void syncWindowP2pExecutorConfig().catch(() => {
        if (windowP2pExecutorLease?.leaseId === lease.leaseId) clearWindowP2pExecutorLeaseLocked();
      });
    }
    emitMsFileState();
    return;
  }
  if (data.type === "config-ack" && typeof data.version === "number") {
    if (!data.ok || data.version !== windowP2pExecutorConcurrencyConfig.version) {
      if (!data.ok && windowP2pExecutorLease?.leaseId === lease.leaseId) clearWindowP2pExecutorLeaseLocked();
      return;
    }
    lease.transportConfigVersion = data.version;
    windowP2pExecutorConfigSync?.resolve();
    windowP2pExecutorConfigSync = undefined;
    pumpWindowP2pExecutorBridgeBudget();
    emitMsFileState();
    return;
  }
  if (data.type === "event-cancel" && typeof data.eventId === "string" && data.eventId.length > 0) {
    // event 与 cancel 使用同一 MessagePort，正常情况下 event 先到这里。
    // 取消状态保存在权威 active handler 表；不能用独立 Set 代替任务 slot。
    const task = [...activeSatInboundHandlers.values()].find((item) => item.leaseId === lease.leaseId
      && item.eventId === data.eventId
      && (data.connectionId === undefined || item.connectionId === data.connectionId));
    if (task) {
      cancelSatInboundHandler(task, "Sat inbound event was canceled by Window");
      return;
    }
    // 极窄的 event 已准入但尚未创建业务 task 的窗口仍然释放 bridge；
    // MessagePort 顺序保证它不会在取消后重新进入 handler。
    const pending = [...windowP2pExecutorInboundBridgePending.values()].find((item) => item.leaseId === lease.leaseId
      && item.eventId === data.eventId
      && (data.connectionId === undefined || item.connectionId === data.connectionId));
    if (pending) releaseWindowP2pExecutorInboundEvent({ connectionId: pending.connectionId, eventId: pending.eventId }, lease.leaseId);
    return;
  }
  if (data.type === "event") {
    const eventValue = data.event;
    if (eventValue && typeof eventValue === "object" && (eventValue as { type?: unknown }).type === "ssp.state") {
      const stateEvent = eventValue as {
        type: "ssp.state";
        supplierId?: unknown;
        connectionId?: unknown;
        ownerSessionEpoch?: unknown;
        supplierGeneration?: unknown;
        state?: unknown;
      };
      const registration = typeof stateEvent.connectionId === "string"
        ? satConnectionStateHandlers.get(stateEvent.connectionId)
        : undefined;
      if (registration
        && registration.supplierId === stateEvent.supplierId
        && registration.ownerSessionEpoch === stateEvent.ownerSessionEpoch
        && registration.supplierGeneration === stateEvent.supplierGeneration
        && (stateEvent.state === "online" || stateEvent.state === "degraded" || stateEvent.state === "closed")) {
        registration.handler(stateEvent.state);
      }
      return;
    }
    if (eventValue && typeof eventValue === "object"
      && ((eventValue as { type?: unknown }).type === "bitfs-seller-frame"
        || (eventValue as { type?: unknown }).type === "bitfs-seller-session-closed"
        || (eventValue as { type?: unknown }).type === "bitfs-webrtc-frame"
        || (eventValue as { type?: unknown }).type === "bitfs-webrtc-signal-outbound"
        || (eventValue as { type?: unknown }).type === "bitfs-webrtc-runtime-error"
        || (eventValue as { type?: unknown }).type === "bitfs-webrtc-session-closed")) {
      // BitFS 卖方会话事件：只允许路由到当前唯一会话管理器；无 bridge 额度。
      handleBitfsSellerStreamEvent(eventValue, lease);
      return;
    }
    if (!eventValue || typeof eventValue !== "object" || (eventValue as { type?: unknown }).type !== "ssp.request") {
      // Window 在发送前已经为每个 SSP eventId 预占额度；即使事件形状
      // 损坏，也必须走 reject 闭环，不能让 Window reservation 永久泄漏。
      sendSatWindowEventReject(lease, eventValue, windowP2pError("ERR_INVALID_INBOUND_EVENT", "Window P2P inbound SSP event is invalid", "not-sent"));
      return;
    }
    const event = eventValue as SatWindowLaneSspRequestEvent;
    if (typeof event.supplierId !== "string" || typeof event.connectionId !== "string"
      || event.supplierId.length === 0 || event.connectionId.length === 0
      || typeof event.ownerSessionEpoch !== "string" || event.ownerSessionEpoch.length === 0
      || !Number.isSafeInteger(event.supplierGeneration) || event.supplierGeneration < 1
      || typeof event.eventId !== "string" || event.eventId.length === 0 || !(event.wire instanceof Uint8Array)) {
      sendSatWindowEventReject(lease, eventValue, windowP2pError("ERR_INVALID_INBOUND_EVENT", "Window P2P inbound SSP event is invalid", "not-sent"));
      return;
    }
    // Window 已在发送前做过一次预占；Worker 仍必须重新核算，不能信任
    // 任意 Tab 传来的 event size，且请求/响应/入站事件共用总预算。
    if (!reserveWindowP2pExecutorInboundEvent(event, lease)) {
      sendSatWindowEventReject(lease, event, windowP2pError("ERR_BRIDGE_BYTES_LIMIT", "Window P2P inbound SSP bridge budget is full", "not-sent"));
      return;
    }
    const task = beginSatInboundHandler(event, lease);
    if (!task) {
      releaseWindowP2pExecutorInboundEvent(event, lease.leaseId);
      sendSatWindowEventReject(lease, event, windowP2pError("ERR_INBOUND_HANDLER_LIMIT", "Sat inbound Worker handler limit reached", "not-sent"));
      return;
    }
    void handleSatWindowEvent(event, lease, task);
    return;
  }
  if (data.type !== "response" || typeof data.requestId !== "string") return;
  const pending = windowP2pExecutorBridgePending.get(data.requestId);
  if (!pending || pending.leaseId !== lease.leaseId) return;
  windowP2pExecutorBridgePending.delete(data.requestId);
  releaseWindowP2pExecutorBridgeBytes(pending.reservedBytes, pending.reservedItems);
  pending.cleanup?.();
  if (data.ok === true) pending.resolve(data.result);
  else pending.reject(restoreWindowP2pError(data.error));
}

/** 从 MessagePort 恢复白名单错误，拒绝普通 Error 文本驱动控制流。 */
function restoreWindowP2pError(value: unknown): Error & WindowP2pExecutorError {
  if (value && typeof value === "object") {
    const item = value as Partial<WindowP2pExecutorError>;
    if ((item.domain === "window-p2p" || item.domain === "sat-transport" || item.domain === "msfile-transport")
      && typeof item.code === "string" && item.code.length > 0 && typeof item.message === "string"
      && (item.sentBoundary === undefined || item.sentBoundary === "not-sent" || item.sentBoundary === "unknown")) {
      const error = new Error(item.message) as Error & WindowP2pExecutorError;
      error.domain = item.domain;
      error.code = item.code;
      if (item.sentBoundary) error.sentBoundary = item.sentBoundary;
      return error;
    }
  }
  return windowP2pError("ERR_BRIDGE_RESPONSE", "Window P2P bridge returned an invalid error");
}

function attachWindowP2pExecutorPort(port: MessagePort, clientId: string, leaseId: string): void {
  if (!port || typeof port.postMessage !== "function" || typeof port.start !== "function") {
    throw new Error("invalid Window P2P executor port");
  }
  const lease = windowP2pExecutorLease;
  if (!lease || lease.clientId !== clientId || lease.leaseId !== leaseId) {
    try { port.close(); } catch { /* already closed */ }
    return;
  }
  lease.transportPort = port;
  lease.transportReady = false;
  lease.transportConfigVersion = -1;
  port.onmessage = handleWindowP2pExecutorPortMessage;
  port.onmessageerror = () => {
    if (windowP2pExecutorLease?.leaseId === leaseId) clearWindowP2pExecutorLeaseLocked();
  };
  port.start();
}

let windowP2pExecutorConfigSync: {
  leaseId: string;
  version: number;
  resolve: () => void;
  reject: (error: Error) => void;
  promise: Promise<void>;
} | undefined;

function syncWindowP2pExecutorConfig(): Promise<void> {
  const lease = windowP2pExecutorLease;
  if (!lease?.transportPort || !lease.transportReady || lease.sessionEpoch !== coordinatorState.sessionEpoch) {
    return Promise.reject(windowP2pError("ERR_EXECUTOR_UNAVAILABLE", "Window P2P executor is unavailable"));
  }
  if (lease.transportConfigVersion === windowP2pExecutorConcurrencyConfig.version) return Promise.resolve();
  if (windowP2pExecutorConfigSync?.leaseId === lease.leaseId && windowP2pExecutorConfigSync.version === windowP2pExecutorConcurrencyConfig.version) {
    return windowP2pExecutorConfigSync.promise;
  }
  windowP2pExecutorConfigSync?.reject(windowP2pError("ERR_CONFIG_SUPERSEDED", "Window P2P executor concurrency config was superseded"));
  let resolveFn!: () => void;
  let rejectFn!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  windowP2pExecutorConfigSync = {
    leaseId: lease.leaseId,
    version: windowP2pExecutorConcurrencyConfig.version,
    resolve: resolveFn,
    reject: rejectFn,
    promise,
  };
  try {
    lease.transportPort.postMessage({ type: "config", leaseId: lease.leaseId, config: windowP2pExecutorConcurrencyConfig });
  } catch (error) {
    windowP2pExecutorConfigSync = undefined;
    rejectFn(windowP2pError("ERR_BRIDGE_POST", "Window P2P executor config could not be sent", "not-sent"));
  }
  return promise;
}

function awaitWindowP2pExecutorConfig(signal?: AbortSignal): Promise<void> {
  const promise = syncWindowP2pExecutorConfig();
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException("The operation was aborted", "AbortError"));
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("The operation was aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function requestWindowP2pExecutorOperation(operation: WindowP2pExecutorOperation, signal?: AbortSignal): Promise<unknown> {
  const lease = windowP2pExecutorLease;
  if (!lease || !lease.transportPort || !lease.transportReady || lease.sessionEpoch !== coordinatorState.sessionEpoch) {
    throw windowP2pError("ERR_EXECUTOR_UNAVAILABLE", "Window P2P executor is unavailable");
  }
  await awaitWindowP2pExecutorConfig(signal);
  const currentLease = windowP2pExecutorLease;
  if (!currentLease || !currentLease.transportPort || !currentLease.transportReady || currentLease.sessionEpoch !== coordinatorState.sessionEpoch) {
    throw windowP2pError("ERR_EXECUTOR_REVOKED", "Window P2P executor lease is no longer current");
  }
  const dispatchOperation = cloneWindowP2pOperationWire(operation);
  const requestId = "window-p2p-exec-data-" + crypto.randomUUID();
  const request = { type: "request", leaseId: currentLease.leaseId, requestId, operation: dispatchOperation };
  const laneOperation = dispatchOperation.type === "lane" && dispatchOperation.operation && typeof dispatchOperation.operation === "object"
    ? dispatchOperation.operation as { type?: unknown; kind?: unknown; wire?: unknown; frame?: unknown }
    : undefined;
  const reservedBytes = windowP2pExecutorBridgeBytesForOperation(dispatchOperation);
  await reserveWindowP2pExecutorBridgeBytes(reservedBytes, signal);
  if (signal?.aborted) {
    releaseWindowP2pExecutorBridgeBytes(reservedBytes);
    throw new DOMException("The operation was aborted", "AbortError");
  }
  // reserve 会让出事件循环；期间可能发生 lock、key switch 或 takeover。
  // 不能把已占用的 bridge 预算继续投递到旧 MessagePort。
  const afterReserveLease = windowP2pExecutorLease;
  if (afterReserveLease?.leaseId !== currentLease.leaseId || afterReserveLease.transportPort !== currentLease.transportPort || afterReserveLease.sessionEpoch !== coordinatorState.sessionEpoch) {
    releaseWindowP2pExecutorBridgeBytes(reservedBytes);
    throw windowP2pError("ERR_EXECUTOR_REVOKED", "Window P2P executor lease changed before dispatch");
  }
  return new Promise<unknown>((resolve, reject) => {
    const pending: WindowP2pExecutorBridgePending = { resolve, reject, leaseId: currentLease.leaseId, reservedBytes, reservedItems: 1 };
    windowP2pExecutorBridgePending.set(requestId, pending);
    const onAbort = () => {
      if (!windowP2pExecutorBridgePending.delete(requestId)) return;
      releaseWindowP2pExecutorBridgeBytes(pending.reservedBytes);
      try { currentLease.transportPort?.postMessage({ type: "cancel", leaseId: currentLease.leaseId, requestId }); } catch { /* executor may be gone */ }
      reject(new DOMException("The operation was aborted", "AbortError"));
    };
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
      pending.cleanup = () => signal.removeEventListener("abort", onAbort);
    }
    try {
      const transfer: Transferable[] = laneOperation?.wire instanceof Uint8Array
        ? [laneOperation.wire.buffer]
        : laneOperation?.frame instanceof Uint8Array
          ? [laneOperation.frame.buffer]
          : [];
      currentLease.transportPort!.postMessage(request, transfer);
    } catch (error) {
      if (windowP2pExecutorBridgePending.delete(requestId)) {
        releaseWindowP2pExecutorBridgeBytes(pending.reservedBytes);
        pending.cleanup?.();
        reject(windowP2pError("ERR_BRIDGE_POST", "Window P2P executor operation could not be sent", "not-sent"));
      }
    }
  });
}

/** 只复制实际 Wire 字节；禁止窄 Uint8Array 把更大的底层 buffer 带过 bridge。 */
function cloneWindowP2pOperationWire(operation: WindowP2pExecutorOperation): WindowP2pExecutorOperation {
  if (operation.type !== "lane" || !operation.operation || typeof operation.operation !== "object") return operation;
  const laneOperation = operation.operation as { wire?: unknown; frame?: unknown };
  const binaryKey = laneOperation.wire instanceof Uint8Array
    ? "wire"
    : laneOperation.frame instanceof Uint8Array
      ? "frame"
      : undefined;
  if (!binaryKey) return operation;
  const binary = binaryKey === "wire" ? laneOperation.wire : laneOperation.frame;
  return {
    ...operation,
    operation: {
      ...(operation.operation as Record<string, unknown>),
      [binaryKey]: binary instanceof Uint8Array ? binary.slice() : undefined,
    },
  };
}

/**
 * 计算一次 Worker -> Window 操作的最坏 bridge 占用。
 * SSP/SPI 请求必须同时为实际请求和最大响应预留，响应到达前不能释放。
 */
function windowP2pExecutorBridgeBytesForOperation(operation: WindowP2pExecutorOperation): number {
  if (operation.type !== "lane" || !operation.operation || typeof operation.operation !== "object") return 0;
  const laneOperation = operation.operation as { type?: unknown; kind?: unknown; wire?: unknown; frame?: unknown };
  if ((laneOperation.type === "requestSsp" || laneOperation.type === "requestSpi") && laneOperation.wire instanceof Uint8Array) {
    return laneOperation.wire.byteLength + MAX_WIRE_BYTES;
  }
  if (laneOperation.wire instanceof Uint8Array) return laneOperation.wire.byteLength;
  if (laneOperation.frame instanceof Uint8Array) return laneOperation.frame.byteLength;
  if (laneOperation.type === "read") return laneOperation.kind === "block" ? MSFILE_MAX_BLOCK_BYTES : MSFILE_MAX_SEED_BYTES;
  return 0;
}

function satWindowLaneOperation(operation: SatWindowLaneOperation, signal?: AbortSignal): Promise<unknown> {
  return requestWindowP2pExecutorOperation({ type: "lane", laneId: SAT_WINDOW_LANE_ID, operation }, signal);
}

function asSatWire(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) throw new Error(`${label} returned an invalid Wire`);
  return value.slice();
}

function satWindowEventReference(rawEvent: unknown): Record<string, unknown> {
  if (!rawEvent || typeof rawEvent !== "object") return { type: "ssp.request" };
  const value = rawEvent as Partial<SatWindowLaneSspRequestEvent>;
  return {
    type: "ssp.request",
    ...(typeof value.eventId === "string" ? { eventId: value.eventId } : {}),
    ...(typeof value.supplierId === "string" ? { supplierId: value.supplierId } : {}),
    ...(typeof value.connectionId === "string" ? { connectionId: value.connectionId } : {}),
    ...(typeof value.ownerSessionEpoch === "string" ? { ownerSessionEpoch: value.ownerSessionEpoch } : {}),
    ...(Number.isSafeInteger(value.supplierGeneration) ? { supplierGeneration: value.supplierGeneration } : {}),
  };
}

function sendSatWindowEventReject(
  lease: WindowP2pExecutorLeaseState,
  rawEvent: unknown,
  error: WindowP2pExecutorError,
): void {
  const reference = satWindowEventReference(rawEvent);
  if (typeof reference.eventId !== "string") return;
  try {
    lease.transportPort?.postMessage({
      type: "event-reject",
      leaseId: lease.leaseId,
      laneId: SAT_WINDOW_LANE_ID,
      event: reference,
      error,
    });
  } catch {
    // Window 不可达时 lease revoke 会清理本地 pending 和 bridge 额度。
  }
}

function sendSatWindowEventRelease(lease: WindowP2pExecutorLeaseState, event: SatWindowLaneSspRequestEvent): void {
  try {
    lease.transportPort?.postMessage({ type: "event-release", leaseId: lease.leaseId, eventId: event.eventId });
  } catch {
    // Window 不可达时本地 stop/revoke 会清理 reservation。
  }
}

/**
 * Window lane 的入站事件回到 Worker 后，使用 eventId 把 ActionResult 写回
 * 原始 SSP Stream。这样 provider 业务处理仍在唯一 owner runtime，lane
 * 只负责网络 writer。
 */
async function handleSatWindowEvent(
  rawEvent: unknown,
  lease: WindowP2pExecutorLeaseState,
  task: ActiveSatInboundHandler,
): Promise<void> {
  const event = rawEvent as SatWindowLaneSspRequestEvent;
  try {
    if (!rawEvent || typeof rawEvent !== "object" || (rawEvent as { type?: unknown }).type !== "ssp.request"
      || typeof event.supplierId !== "string" || typeof event.connectionId !== "string"
      || typeof event.ownerSessionEpoch !== "string" || !Number.isSafeInteger(event.supplierGeneration)
      || typeof event.eventId !== "string" || !(event.wire instanceof Uint8Array)) return;
    if (task.canceled) return;
    const registration = satIncomingHandlers.get(event.connectionId);
    if (!registration || registration.supplierId !== event.supplierId || registration.ownerSessionEpoch !== event.ownerSessionEpoch || registration.supplierGeneration !== event.supplierGeneration) {
      sendSatWindowEventReject(lease, event, windowP2pError("ERR_STALE_CONNECTION", "Sat inbound Publish belongs to a stale connection", "not-sent"));
      return;
    }
    // 先移交唯一 Wire 引用，再把 event 对象中的引用清空。取消时即使
    // handler 仍不支持 AbortSignal，Worker 也不会继续保留 bridge event buffer。
    const handlerWire = event.wire;
    event.wire = new Uint8Array();
    let response: Uint8Array;
    try {
      response = await registration.handler(handlerWire);
    } catch (error) {
      // Provider 已在可解析 request_id 的异常路径返回 ActionResult；若连
      // request_id 都无法取得，直接拒绝 lane pending，不能让 30 秒超时
      // 长期占用 Window/Worker 双向额度。
      if (!task.canceled && isCurrentSatInboundHandler(task)) {
        sendSatWindowEventReject(lease, event, windowP2pError("ERR_INCOMING_HANDLER", error instanceof Error ? error.message : "Sat inbound handler failed", "not-sent"));
      }
      return;
    }
    if (!isCurrentSatInboundHandler(task)) return;
    // 输入 Wire 已经被 handler 消费；先释放 Worker 入站额度，再为回写
    // ActionResult 预占出站额度。否则 32MiB 入站预算被占满时，handler 都
    // 会等待 response 额度，而 response 又只能在 handler finally 后释放，
    // 形成自锁。Window 侧 reservation 仍保持到 lane 收到 response/reject。
    releaseSatInboundHandlerBridge(task);
    try {
      const respond = testSatInboundResponseDispatcher ?? satWindowLaneOperation;
      await respond({ type: "respondSsp", supplierId: task.supplierId, connectionId: task.connectionId, ownerSessionEpoch: task.ownerSessionEpoch, supplierGeneration: task.supplierGeneration, eventId: task.eventId, wire: asSatWire(response, "Sat inbound response") }, task.controller.signal);
    } catch (error) {
      if (!task.canceled) {
        sendSatWindowEventReject(lease, event, windowP2pError("ERR_INCOMING_RESPONSE", error instanceof Error ? error.message : "Sat inbound response could not be written", "unknown"));
      }
    }
  } finally {
    finishSatInboundHandler(task);
    if (rawEvent && typeof rawEvent === "object" && (rawEvent as { type?: unknown }).type === "ssp.request") {
      sendSatWindowEventRelease(lease, event);
    }
  }
}



const windowP2pExecutorTransport = createWindowP2pMsFileTransport({
  get available() {
    return windowP2pExecutorLease?.transportReady === true
      && windowP2pExecutorLease.sessionEpoch === coordinatorState.sessionEpoch
      && coordinatorState.vaultStatus === "unlocked";
  },
  request: requestWindowP2pExecutorOperation,
  dispose: () => undefined,
});

function clearWindowP2pExecutorLeaseTimer(): void {
  if (windowP2pExecutorLeaseTimer !== undefined) clearTimeout(windowP2pExecutorLeaseTimer);
  windowP2pExecutorLeaseTimer = undefined;
}

function scheduleWindowP2pExecutorLeaseExpiry(leaseId: string, acquiredAt: number): void {
  clearWindowP2pExecutorLeaseTimer();
  const remaining = Math.max(0, WINDOW_P2P_EXECUTOR_LEASE_TTL_MS - (Date.now() - acquiredAt));
  windowP2pExecutorLeaseTimer = setTimeout(() => {
    windowP2pExecutorLeaseTimer = undefined;
    if (windowP2pExecutorLease?.leaseId === leaseId && Date.now() - windowP2pExecutorLease.acquiredAt >= WINDOW_P2P_EXECUTOR_LEASE_TTL_MS) {
      clearWindowP2pExecutorLeaseLocked();
      emitMsFileState();
    }
  }, remaining);
}

function clearWindowP2pExecutorLeaseLocked(): void {
  clearWindowP2pExecutorLeaseTimer();
  if (windowP2pExecutorLease === undefined) {
    // Sat connection state callbacks are capability-bound too; do not leave
    // them behind merely because the Window lease was already cleared.
    satConnectionStateHandlers.clear();
    return;
  }
  const oldLease = windowP2pExecutorLease;
  const revokedError = windowP2pError("ERR_EXECUTOR_REVOKED", "Window P2P executor lease was revoked");
  windowP2pExecutorConfigSync?.reject(revokedError);
  windowP2pExecutorConfigSync = undefined;
  rejectWindowP2pExecutorBridgePending(revokedError);
  try { oldLease.transportPort?.postMessage({ type: "revoked", leaseId: oldLease.leaseId }); } catch { /* executor may be gone */ }
  try { oldLease.transportPort?.close(); } catch { /* already closed */ }
  for (const [requestId, pending] of windowP2pExecutorIdentityRequests) {
    if (pending.leaseId === oldLease.leaseId) {
      pending.controller.abort();
      windowP2pExecutorIdentityRequests.delete(requestId);
    }
  }
  const workerUnit = coordinatorWorkerUnitRegistry.get("window-p2p.coordinator-worker");
  if (workerUnit) stopCoordinatorWorkerUnit(workerUnit.unitId, workerUnit.instanceId);
  satConnectionStateHandlers.clear();
  windowP2pExecutorLease = undefined;
  // 唯一 Window Host 消失后所有 BitFS 销售连接已不可用：立即清空会话并
  // 回到 degraded，不能停留在 selling。
  const sellerManager = msfileBitfsRuntime.msfileSellerSessionManager;
  if (sellerManager) {
    sellerManager.clear();
    if (coordinatorState.vaultStatus === "unlocked" && msfileRuntime && msfileBitfsRuntime.msfileSellerProtocolPort?.ready) {
      msfileRuntime.setSellerRuntimeStatus("degraded");
    }
  }
}

function acquireWindowP2pExecutorLease(input: {
  clientId: string;
  ownerPublicKeyHex: string;
}): { ok: true; lease: WindowP2pExecutorLease } | { ok: false; reason: "locked" | "stale-epoch" | "owner-mismatch" | "busy" } {
  if (coordinatorState.vaultStatus !== "unlocked") return { ok: false, reason: "locked" };
  if (!coordinatorState.activePublicKeyHex || input.ownerPublicKeyHex !== coordinatorState.activePublicKeyHex) {
    return { ok: false, reason: "owner-mismatch" };
  }
  if (windowP2pExecutorLease !== undefined) {
    // 同 port 幂等续租；跨 port / 跨 owner 冲突一律拒绝。
    if (windowP2pExecutorLease.clientId === input.clientId && windowP2pExecutorLease.ownerPublicKeyHex === input.ownerPublicKeyHex) {
      windowP2pExecutorLease.acquiredAt = Date.now();
      scheduleWindowP2pExecutorLeaseExpiry(windowP2pExecutorLease.leaseId, windowP2pExecutorLease.acquiredAt);
      return { ok: true, lease: { leaseId: windowP2pExecutorLease.leaseId, sessionEpoch: windowP2pExecutorLease.sessionEpoch, activePublicKeyHex: windowP2pExecutorLease.ownerPublicKeyHex } };
    }
    // 有界 TTL：超过租期视为旧 executor 已死，允许接管。
    if (Date.now() - windowP2pExecutorLease.acquiredAt < WINDOW_P2P_EXECUTOR_LEASE_TTL_MS) {
      return { ok: false, reason: "busy" };
    }
    clearWindowP2pExecutorLeaseLocked();
  }
  const leaseId = `window-p2p-exec-lease-${crypto.randomUUID()}`;
  const workerUnit = activateCoordinatorOwnerWorkerUnit("window-p2p.coordinator-worker");
  coordinatorWorkerUnitRegistry.ready(workerUnit.unitId, workerUnit.instanceId);
  windowP2pExecutorLease = {
    leaseId,
    clientId: input.clientId,
    ownerPublicKeyHex: input.ownerPublicKeyHex,
    sessionEpoch: coordinatorState.sessionEpoch,
    activePublicKeyHex: input.ownerPublicKeyHex,
    acquiredAt: Date.now(),
    transportReady: false,
    transportConfigVersion: -1,
  };
  scheduleWindowP2pExecutorLeaseExpiry(leaseId, windowP2pExecutorLease.acquiredAt);
  return { ok: true, lease: { leaseId, sessionEpoch: windowP2pExecutorLease.sessionEpoch, activePublicKeyHex: input.ownerPublicKeyHex } };
}

function executorIdentityError(requestId: string, message: string, status: "error" | "validation-error" = "error"): CoordinatorResponse {
  return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: status === "error" ? { status, message, code: "window_p2p_unavailable" } : { status, message } };
}

function parseUint64Decimal(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("Peer Record sequence must be canonical uint64 decimal");
  const sequence = BigInt(value);
  if (sequence > UINT64_MAX) throw new Error("Peer Record sequence exceeds uint64");
  return sequence;
}

function currentExecutorPublicKey(): Uint8Array {
  if (!coordinatorState.activePublicKeyHex || !vaultKeySession.hasKey()) throw new Error("Window P2P executor active key is unavailable");
  vaultKeySession.assert(coordinatorState.activePublicKeyHex);
  return validatePublicKey(cryptoHexToBytes(coordinatorState.activePublicKeyHex));
}

function executorLeaseIsCurrent(leaseId: string, actualClientId: string, expectedSessionEpoch: SessionEpoch): WindowP2pExecutorLeaseState {
  const lease = windowP2pExecutorLease;
  if (
    lease === undefined ||
    lease.leaseId !== leaseId ||
    lease.clientId !== actualClientId ||
    lease.sessionEpoch !== expectedSessionEpoch ||
    lease.sessionEpoch !== coordinatorState.sessionEpoch ||
    lease.ownerPublicKeyHex !== coordinatorState.activePublicKeyHex ||
    lease.activePublicKeyHex !== coordinatorState.activePublicKeyHex ||
    coordinatorState.vaultStatus !== "unlocked"
  ) throw new Error("Window P2P executor lease is not valid");
  if (Date.now() - lease.acquiredAt >= WINDOW_P2P_EXECUTOR_LEASE_TTL_MS) {
    clearWindowP2pExecutorLeaseLocked();
    throw new Error("Window P2P executor lease expired");
  }
  return lease;
}

function assertExecutorIdentityStillCurrent(lease: WindowP2pExecutorLeaseState, actualClientId: string, expectedSessionEpoch: SessionEpoch, publicKeyHex: string): void {
  const fresh = executorLeaseIsCurrent(lease.leaseId, actualClientId, expectedSessionEpoch);
  if (fresh !== lease || fresh.ownerPublicKeyHex !== publicKeyHex || coordinatorState.activePublicKeyHex !== publicKeyHex) {
    throw new Error("Window P2P executor identity changed during signing");
  }
}

async function executeWindowP2pExecutorIdentitySign(
  request: Extract<CoordinatorClientRequest, { kind: "window-p2p.executor.identity.sign-noise" | "window-p2p.executor.identity.sign-peer-record" }>,
  actualClientId: string,
  signal: AbortSignal
): Promise<CoordinatorResponse> {
  const lease = executorLeaseIsCurrent(request.leaseId, actualClientId, request.expectedSessionEpoch);
  const publicKeyHex = coordinatorState.activePublicKeyHex!;
  const publicKey = currentExecutorPublicKey();
  if (signal.aborted) throw new Error("Window P2P identity signing was cancelled");

  let digest: Uint8Array;
  let peerRecordSequence: bigint | undefined;
  if (request.kind === "window-p2p.executor.identity.sign-noise") {
    const staticKey = new Uint8Array(request.noiseStaticPublicKey);
    if (staticKey.byteLength !== 32) throw new Error("Noise static public key must be exactly 32 bytes");
    digest = sha256Bytes(noiseSigningPayload(staticKey));
  } else {
    if (!Array.isArray(request.addresses) || request.addresses.length !== 0) {
      throw new Error("Signed Peer Record addresses must be empty in the Window P2P executor spike");
    }
    const sequence = parseUint64Decimal(request.sequence);
    const expectedPeerId = peerIdFromPublicKeyBytes(publicKey);
    const peerId = parsePeerId(request.peerId);
    if (peerId.toString() !== expectedPeerId.toString()) throw new Error("Peer Record PeerId does not match the active public key");
    if (lease.lastPeerRecordSequence !== undefined && sequence < lease.lastPeerRecordSequence) {
      throw new Error("Peer Record sequence must be monotonic per lease");
    }
    const unsigned = peerRecordUnsigned({ peerId, addresses: [], sequence }, expectedPeerId);
    digest = sha256Bytes(unsigned);
    // The sequence is reserved only after a successful, current-key signature.
    peerRecordSequence = sequence;
  }

  // 给已经排队的 lock / key-switch / port-lifecycle 事件一次抢占机会。
  // 本地 secp256k1 很快，若不跨 task，让步前后的二次 lease/epoch 栅栏
  // 在真实浏览器中无法被触发，也就不能证明“等待中的签名”会 fail closed。
  await new Promise<void>((resolve) => setTimeout(resolve, WINDOW_P2P_EXECUTOR_PRE_SIGN_YIELD_MS));
  if (signal.aborted) throw new Error("Window P2P identity signing was cancelled");
  assertExecutorIdentityStillCurrent(lease, actualClientId, request.expectedSessionEpoch, publicKeyHex);

  const signature = await withCoordinatorFinalIoLease(
    "write",
    signal,
    () => vaultKeySession.signDigest(digest, "der", publicKeyHex),
    {
      auditOperation: "window-p2p.identity.sign",
      // Window P2P 身份签名只用于建立当前 executor 的本地握手，不会把
      // 签名提交给外部网络或持久化。保留本地 gate、authority 和 epoch
      // 前后校验，但不能让页面导航中的短签名阻塞新 Worker 接管。
      durableLease: false,
    },
  );
  assertExecutorIdentityStillCurrent(lease, actualClientId, request.expectedSessionEpoch, publicKeyHex);
  if (signal.aborted) throw new Error("Window P2P identity signing was cancelled");
  if (request.kind === "window-p2p.executor.identity.sign-peer-record") {
    if (peerRecordSequence === undefined) throw new Error("Peer Record sequence was not retained");
    lease.lastPeerRecordSequence = peerRecordSequence;
  }
  lease.acquiredAt = Date.now();
  scheduleWindowP2pExecutorLeaseExpiry(lease.leaseId, lease.acquiredAt);
  return {
    requestId: request.requestId,
    sessionEpoch: coordinatorState.sessionEpoch,
    ack: { status: "ok" },
    operationResult: { signatureDer: signature.slice().buffer as ArrayBuffer } satisfies WindowP2pIdentitySignResult
  };
}

function enqueueWindowP2pExecutorIdentitySign(
  request: Extract<CoordinatorClientRequest, { kind: "window-p2p.executor.identity.sign-noise" | "window-p2p.executor.identity.sign-peer-record" }>,
  actualClientId: string,
  signal: AbortSignal
): Promise<CoordinatorResponse> {
  const run = windowP2pExecutorIdentityTail.then(
    () => executeWindowP2pExecutorIdentitySign(request, actualClientId, signal),
    () => executeWindowP2pExecutorIdentitySign(request, actualClientId, signal)
  );
  windowP2pExecutorIdentityTail = run.then(() => undefined, () => undefined);
  return run;
}

const executeMsfileControl = msfileBitfsRuntime.executeMsfileControl;
const isMsfileMutationControl = msfileBitfsRuntime.isMsfileMutationControl;

async function resolveMsfileGrant(
  grantId: string,
  actualClientId: string,
  expectedSessionEpoch: SessionEpoch
): Promise<{ context: MsFileConnectAppContext; connectSessionId: string }> {
  // 前置检查（session 查询前）。
  const grant = msfileGrants.get(grantId);
  if (!grant || grant.clientId !== actualClientId || grant.sessionEpoch !== coordinatorState.sessionEpoch) {
    throw msfileError("msfile_identity_required", "MSFile grant is invalid");
  }
  const authoritative = await readProtocolConnectSession(grant.context.connectSessionId);
  // 审查修复：await 返回后重新获取 grant 并复核全部前置条件——
  // 挂起期间发生的 lock / session abort / key switch 都必须使本次请求失效。
  const fresh = msfileGrants.get(grantId);
  if (!fresh || fresh.clientId !== actualClientId || fresh.sessionEpoch !== coordinatorState.sessionEpoch) {
    throw msfileError("msfile_identity_required", "MSFile grant was revoked during session lookup");
  }
  if (expectedSessionEpoch !== coordinatorState.sessionEpoch || coordinatorState.vaultStatus !== "unlocked") {
    throw msfileError("msfile_identity_required", "MSFile session changed during lookup");
  }
  if (!authoritative || authoritative.origin !== fresh.context.transportOrigin || JSON.stringify(authoritative.appIdentity) !== JSON.stringify(fresh.context.appIdentity)) {
    throw msfileError("msfile_identity_required", "MSFile session is invalid or revoked");
  }
  if (authoritative.ownerPublicKeyHex !== fresh.context.ownerPublicKeyHex) {
    throw msfileError("msfile_identity_required", "MSFile session owner changed during lookup");
  }
  if (!coordinatorState.activePublicKeyHex || authoritative.ownerPublicKeyHex !== coordinatorState.activePublicKeyHex) {
    throw msfileError("msfile_identity_required", "MSFile session owner does not match the active runtime owner");
  }
  return { context: fresh.context, connectSessionId: fresh.context.connectSessionId };
}

function msfileError(code: MsFileErrorCode, message: string): Error & { code: MsFileErrorCode } {
  const error = new Error(message) as Error & { code: MsFileErrorCode };
  error.code = code;
  return error;
}

async function executeMsfileData(request: Extract<CoordinatorClientRequest, { kind: "msfile.data" }>, controller: AbortController, actualClientId: string): Promise<CoordinatorResponse> {
  const data: CoordinatorMsFileData = request.data;
  const signal = controller.signal;
  return withMsfileDataSlot(actualClientId, data, async () => {
    // MSFile 数据面的最终 lease 在 slot 已分配后取得，避免等待队列参与
    // authority 排序；Provider 调用、grant 复核和迟到结果检查仍在同一
    // lease 内完成。
    return withCoordinatorFinalIoLease(
      "read",
      signal,
      () => executeMsfileDataUnsafe(request, controller, actualClientId),
      { allowLocalLock: true, allowLocalOwnerTransition: true, auditOperation: "msfile.data" },
    );
  }, signal);
}

const executeMsfileDataUnsafe = createMsfileDataExecutor({
  runtime: () => ensureMsfileRuntime(),
  sessionEpoch: () => coordinatorState.sessionEpoch,
  resolveGrant: resolveMsfileGrant,
  unavailable: message => msfileError("msfile_unavailable", message),
});

type WindowP2pExecutorRequest = Extract<CoordinatorClientRequest, { kind: "window-p2p.executor.acquire" | "window-p2p.executor.release" | "window-p2p.executor.spike.transfer" | "window-p2p.executor.identity.sign-noise" | "window-p2p.executor.identity.sign-peer-record" }>;

async function executeWindowP2pExecutorRequest(request: WindowP2pExecutorRequest, actualClientId: string): Promise<CoordinatorResponse> {
  if (revokedCoordinatorPeerIds.has(actualClientId)) return disconnectedClientResponse(request.requestId);
  if (request.kind === "window-p2p.executor.acquire") {
    if (request.expectedSessionEpoch !== coordinatorState.sessionEpoch) {
      return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "stale-epoch" } };
    }
    if (request.executorPort && (typeof request.executorPort.postMessage !== "function" || typeof request.executorPort.start !== "function")) {
      try { request.executorPort.close(); } catch { /* malformed transferred value */ }
      return executorIdentityError(request.requestId, "invalid Window P2P executor port", "validation-error");
    }
    const result = acquireWindowP2pExecutorLease({ clientId: actualClientId, ownerPublicKeyHex: request.ownerPublicKeyHex });
    if (!result.ok) {
      try { request.executorPort?.close(); } catch { /* already detached */ }
      return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "error", message: `Window P2P executor lease rejected: ${result.reason}`, code: "window_p2p_unavailable" } };
    }
    if (request.executorPort) {
      try {
        attachWindowP2pExecutorPort(request.executorPort, actualClientId, result.lease.leaseId);
      } catch (error) {
        clearWindowP2pExecutorLeaseLocked();
        return executorIdentityError(request.requestId, error instanceof Error ? error.message : "invalid Window P2P executor port", "validation-error");
      }
    }
    emitMsFileState();
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: result.lease };
  }
  if (request.kind === "window-p2p.executor.release") {
    if (windowP2pExecutorLease !== undefined && windowP2pExecutorLease.leaseId === request.leaseId && windowP2pExecutorLease.clientId === actualClientId) {
      clearWindowP2pExecutorLeaseLocked();
    }
    emitMsFileState();
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" } };
  }
  if (request.kind === "window-p2p.executor.spike.transfer") {
    executorLeaseIsCurrent(request.leaseId, actualClientId, request.expectedSessionEpoch);
    if (!(request.bytes instanceof ArrayBuffer)) return executorIdentityError(request.requestId, "Window P2P executor transfer requires an ArrayBuffer", "validation-error");
    if (request.bytes.byteLength > WINDOW_P2P_EXECUTOR_TRANSFER_MAX_ITEM_BYTES) return executorIdentityError(request.requestId, "Window P2P executor transfer item exceeds the byte limit", "validation-error");
    if (windowP2pExecutorTransferPendingItems === 0) windowP2pExecutorTransferPeakBytes = 0;
    if (windowP2pExecutorTransferPendingItems + 1 > WINDOW_P2P_EXECUTOR_TRANSFER_MAX_ITEMS) return executorIdentityError(request.requestId, "Window P2P executor transfer queue reached the item limit", "validation-error");
    if (windowP2pExecutorTransferPendingBytes + request.bytes.byteLength > WINDOW_P2P_EXECUTOR_TRANSFER_MAX_BYTES) return executorIdentityError(request.requestId, "Window P2P executor transfer queue reached the byte limit", "validation-error");
    windowP2pExecutorTransferPendingItems += 1;
    windowP2pExecutorTransferPendingBytes += request.bytes.byteLength;
    windowP2pExecutorTransferPeakBytes = Math.max(windowP2pExecutorTransferPeakBytes, windowP2pExecutorTransferPendingBytes);
    const acceptedPendingBytes = windowP2pExecutorTransferPendingBytes;
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, WINDOW_P2P_EXECUTOR_PRE_SIGN_YIELD_MS));
      executorLeaseIsCurrent(request.leaseId, actualClientId, request.expectedSessionEpoch);
      return {
        requestId: request.requestId,
        sessionEpoch: coordinatorState.sessionEpoch,
        ack: { status: "ok" },
        operationResult: { bytes: request.bytes, acceptedPendingBytes, peakPendingBytes: windowP2pExecutorTransferPeakBytes }
      };
    } finally {
      windowP2pExecutorTransferPendingItems = Math.max(0, windowP2pExecutorTransferPendingItems - 1);
      windowP2pExecutorTransferPendingBytes = Math.max(0, windowP2pExecutorTransferPendingBytes - request.bytes.byteLength);
    }
  }
  const controller = new AbortController();
  const key = windowP2pExecutorIdentityRequestKey(actualClientId, request.requestId);
  windowP2pExecutorIdentityRequests.set(key, { controller, clientId: actualClientId, leaseId: request.leaseId });
  try {
    return await enqueueWindowP2pExecutorIdentitySign(request, actualClientId, controller.signal);
  } catch (error) {
    return executorIdentityError(request.requestId, error instanceof Error ? error.message : String(error));
  } finally {
    windowP2pExecutorIdentityRequests.delete(key);
  }
}

async function executeMsfileRequest(
  request: Extract<CoordinatorClientRequest, { kind: "msfile.grant" | "msfile.control" | "msfile.data" | "msfile.cancel" | "msfile.session.abort" }>,
  actualClientId: string
): Promise<CoordinatorResponse> {
  if (revokedCoordinatorPeerIds.has(actualClientId)) return disconnectedClientResponse(request.requestId);
  if (request.kind !== "msfile.cancel"
    && request.kind !== "msfile.session.abort"
    && !isCoordinatorProductRegistered("msfile")) {
    return coordinatorProductBlockedResponse(request.requestId, "msfile");
  }
  // cancel/session.abort 是纯本地清理，不能因为旧 authority 失效而被
  // 阻塞；其余请求则把授权查询、Provider I/O 和本地结果检查放在同一
  // 个最终 lease 中。锁定态沿用原有快速返回，解锁态才申请 lease。
  if (request.kind === "msfile.cancel" || request.kind === "msfile.session.abort") {
    return executeMsfileRequestUnsafe(request, actualClientId);
  }
  const controller = new AbortController();
  const requestKey = msfileRequestKey(actualClientId, request.requestId);
  msfileRequests.set(requestKey, {
    controller,
    clientId: actualClientId,
    connectSessionId: request.kind === "msfile.data" && request.data.grantId !== undefined
      ? msfileGrants.get(request.data.grantId)?.context.connectSessionId
      : undefined,
  });
  try {
    if (coordinatorState.vaultStatus !== "unlocked" || !coordinatorState.activePublicKeyHex) {
      return executeMsfileRequestUnsafe(request, actualClientId, controller);
    }
  // 数据面先进入本地并发槽位，再取得最终 lease。若在排队前取得
  // authority lease，lease 的 CAS 顺序会取代 MSFile 自身的 client 轮转，
  // 使同一个持续请求的 client 抢在后来进入的 Connect client 前面。
  // 真正的 Provider/授权读取仍由 executeMsfileData 在物理执行边界保护。
    if (request.kind === "msfile.data") return executeMsfileRequestUnsafe(request, actualClientId, controller);
  const operation = request.kind === "msfile.control"
    ? (isMsfileMutationControl(request.control) ? "write" : "read")
    : "read";
  try {
    return await withCoordinatorFinalIoLease(
      operation,
      controller.signal,
      () => executeMsfileRequestUnsafe(request, actualClientId, controller),
      {
        allowLocalLock: true,
        allowLocalOwnerTransition: true,
        auditOperation: "msfile.control",
        // settings.get 等控制面读取只读取 Coordinator 自有状态，不会
        // 触发供应商/支付副作用；真正的配置变更仍登记内存 write lease。
        durableLease: operation === "write",
      },
    );
    } catch (error) {
    // 请求可能在等待内存 I/O lease 时经历 lock → unlock；此时旧 gate
    // 会先被撤销，不能把“旧 epoch 已失效”冒泡成未处理异常。
    if (request.kind === "msfile.control" && request.expectedSessionEpoch !== coordinatorState.sessionEpoch) {
      return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "stale-epoch" } };
    }
    const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : undefined;
    return {
      requestId: request.requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: {
        status: "error",
        message: error instanceof Error ? error.message : String(error),
        ...(code ? { code: code as never } : {}),
      },
    };
    }
  } finally {
    if (msfileRequests.get(requestKey)?.controller === controller) msfileRequests.delete(requestKey);
  }
}

async function executeMsfileRequestUnsafe(
  request: Extract<CoordinatorClientRequest, { kind: "msfile.grant" | "msfile.control" | "msfile.data" | "msfile.cancel" | "msfile.session.abort" }>,
  actualClientId: string,
  requestController?: AbortController,
): Promise<CoordinatorResponse> {
  // 审查修复：msfile 通道在通用 FIFO 的 epoch 栅栏之前分流，因此自带栅栏。
  // session.abort / cancel 是纯本地清理，永远放行且不重建 runtime。
  if (
    request.kind !== "msfile.cancel" &&
    request.kind !== "msfile.session.abort" &&
    "expectedSessionEpoch" in request &&
    request.expectedSessionEpoch !== coordinatorState.sessionEpoch
  ) {
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "stale-epoch" } };
  }
  if (request.kind === "msfile.session.abort") {
    for (const [requestId, pending] of msfileRequests) {
      if (pending.connectSessionId === request.connectSessionId) { pending.controller.abort(); msfileRequests.delete(requestId); }
    }
    for (const [requestId, pending] of windowP2pExecutorIdentityRequests) {
      if (pending.clientId === actualClientId) { pending.controller.abort(); windowP2pExecutorIdentityRequests.delete(requestId); }
    }
    for (const [grantId, grant] of msfileGrants) {
      if (grant.context.connectSessionId === request.connectSessionId) msfileGrants.delete(grantId);
    }
    // 仅当 runtime 已存在（解锁期创建）时才取消其内部未决确认；绝不重建。
    if (coordinatorState.vaultStatus === "unlocked" && msfileRuntime) {
      await msfileRuntime.abortSession(request.connectSessionId);
      emitMsFileState();
    }
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" } };
  }
  if (!isCoordinatorProductRegistered("msfile")) {
    return coordinatorProductBlockedResponse(request.requestId, "msfile");
  }
  // grant/control/data 都要求 Vault unlocked + active key runtime 可用。
  if (coordinatorState.vaultStatus !== "unlocked") {
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "locked" } };
  }
  if (request.kind === "msfile.grant") {
    const session = await readProtocolConnectSession(request.context.connectSessionId);
    // 审查修复：session 查询是异步的——返回后复核请求 epoch 与 Vault 状态，
    // 跨越 lock/unlock / key switch 的 grant 不得绑定到新会话。
    if (request.expectedSessionEpoch !== coordinatorState.sessionEpoch || coordinatorState.vaultStatus !== "unlocked") {
      return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "stale-epoch" } };
    }
    if (!session || session.origin !== request.context.transportOrigin || JSON.stringify(session.appIdentity) !== JSON.stringify(request.context.appIdentity)) {
      return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "error", message: "MSFile session is invalid or revoked", code: "msfile_identity_required" } };
    }
    // grant 绑定前验证 session owner 与实际付款/签名 runtime 的 owner 一致：
    // wire Read 以 active key 身份购买，owner 错位即身份错位。
    if (!coordinatorState.activePublicKeyHex || session.ownerPublicKeyHex !== coordinatorState.activePublicKeyHex) {
      return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "error", message: "MSFile session owner does not match the active runtime owner", code: "msfile_identity_required" } };
    }
    const grantId = `msfile-grant-${crypto.randomUUID()}`;
    msfileGrants.set(grantId, { context: { connectSessionId: session.sessionId, transportOrigin: session.origin, ownerPublicKeyHex: session.ownerPublicKeyHex, appIdentity: session.appIdentity }, clientId: actualClientId, sessionEpoch: coordinatorState.sessionEpoch });
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: grantId };
  }
  if (request.kind === "msfile.cancel") {
    const target = msfileRequests.get(msfileRequestKey(actualClientId, request.targetRequestId));
    if (target?.clientId === actualClientId) target.controller.abort();
    const identityTarget = windowP2pExecutorIdentityRequests.get(windowP2pExecutorIdentityRequestKey(actualClientId, request.targetRequestId));
    if (identityTarget?.clientId === actualClientId) identityTarget.controller.abort();
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" } };
  }
  const controller = requestController ?? new AbortController();
  try {
    if (request.kind === "msfile.control") return await executeMsfileControl(request, controller.signal);
    return await executeMsfileData(request, controller, actualClientId);
  } catch (err) {
    // 物理操作可能在 lock → unlock 期间因为旧 controller 被 abort。
    // 这不是普通的 Provider 失败：请求携带的 epoch 已经失效，必须向调用方
    // 返回明确的 stale-epoch，不能把会话栅栏降级成通用 error。
    if (request.kind === "msfile.control" && request.expectedSessionEpoch !== coordinatorState.sessionEpoch) {
      return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "stale-epoch" } };
    }
    const code = (err as { code?: string })?.code;
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "error", message: err instanceof Error ? err.message : String(err), ...(typeof code === "string" ? { code: code as never } : {}) } };
  }
}

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

async function executeProcessRequest(
  request: CoordinatorClientRequest,
  actualClientId: string,
  requestSignal?: AbortSignal,
): Promise<CoordinatorResponse> {
  const requestId = "requestId" in request ? request.requestId : generateRequestId();

  if (requestSignal?.aborted || revokedCoordinatorPeerIds.has(actualClientId)) {
    return disconnectedClientResponse(requestId);
  }

  if (request.kind !== "lock" && "expectedSessionEpoch" in request) {
    if (
      request.expectedSessionEpoch !== coordinatorState.sessionEpoch &&
      request.expectedSessionEpoch !== "boot" &&
      request.expectedSessionEpoch !== "locked"
    ) {
      if (isP2pkhBroadcastRequest(request)) {
        await abortNotDispatchedP2pkhSubmission(request, "stale-session-epoch");
        return {
          requestId,
          sessionEpoch: coordinatorState.sessionEpoch,
          ack: { status: "ok" },
          operationResult: { status: "not-dispatched", reason: "stale-session-epoch" },
        };
      }
      return {
        requestId,
        sessionEpoch: coordinatorState.sessionEpoch,
        ack: { status: "stale-epoch" },
      };
    }
  }

  try {
    switch (request.kind) {
      case "unlock":
        return await handleUnlock(requestId, request);
      case "lock":
        return await handleLock(requestId, request);
      case "vault.operation":
        return await handleVaultOperation(requestId, request);
      case "crypto":
        return await handleCrypto(requestId, request);
      case "background.run-now":
        return await handleBackgroundRunNow(requestId, request);
      case "background.trigger":
        return await handleBackgroundTrigger(requestId, request);
      case "background.cancel":
        return await handleBackgroundCancel(requestId, request);
      case "background.cancel-by-key":
        return await handleBackgroundCancelByKey(requestId, request);
      case "background.settings.update":
        return await handleBackgroundSettingsUpdate(requestId, request);
      case "autolock.settings.update":
        return await handleAutolockSettingsUpdate(requestId, request);
      case "p2pkh.settings.update":
        return await handleP2pkhSettingsUpdate(requestId, request);
      case "p2pkh.provider-config.get":
        return await handleP2pkhProviderConfigGet(requestId, request);
      case "p2pkh.provider-config.update":
        return await handleP2pkhProviderConfigUpdate(requestId, request);
      case "p2pkh.utxos.get":
        return await handleP2pkhUtxosGet(requestId, request);
      case "p2pkh.utxos.refresh":
        return await handleP2pkhUtxosRefresh(requestId, request);
      case "p2pkh.broadcast":
        return await handleP2pkhBroadcast(requestId, request);
      case "sat.operation":
        return await executeSatRequest(request);
      case "channel.operation":
        return await executeChannelRequest(request, actualClientId, requestSignal);
      case "contacts.presence.snapshot":
        return await executeContactsPresenceSnapshot(request);
      default:
        return {
          requestId,
          sessionEpoch: coordinatorState.sessionEpoch,
          ack: { status: "validation-error", message: "Unknown request kind" },
        };
    }
  } catch (err) {
    markStorageIoFailure(err);
    const code = err && typeof err === "object" && typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string }).code
      : undefined;
    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: {
        status: "error",
        message: err instanceof Error ? err.message : String(err),
        ...(code ? { code: code as never } : {}),
      },
    };
  }
}

async function processRequestCore(
  request: CoordinatorClientRequest,
  actualClientId = (request as { clientId?: string }).clientId ?? "unknown",
  requestSignal?: AbortSignal,
): Promise<CoordinatorResponse> {
  const requestId = "requestId" in request ? request.requestId : generateRequestId();
  // 断开消息与前一个异步请求的 authority 校验可能交错；断开端口一旦
  // 被登记，后续路径不得再创建 grant、排队任务或取得最终 I/O lease。
  if (revokedCoordinatorPeerIds.has(actualClientId) || requestSignal?.aborted) return disconnectedClientResponse(requestId);
  const cleanupOnly = request.kind === "lock"
    || request.kind === "storage.cancel"
    || request.kind === "storage.session.abort"
    || request.kind === "msfile.cancel"
    || request.kind === "msfile.session.abort"
    || request.kind === "window-p2p.executor.release";
  // lock 是 fail-closed 安全动作：即使这个 Worker 已经失去当前内存
  // authority，仍必须能本地清空密钥、撤销代理并释放资源。其他清理入口
  // 同样不需要重新取得业务权威；其余入口都必须经过当前 authority fence，
  // 避免旧 Worker 在新 Runtime 接管后继续修改状态。
  if (!cleanupOnly && platformRootStore && platformStorageReady) {
    try {
      await assertCoordinatorAuthorityCurrent();
    } catch (error) {
      const requestId = "requestId" in request ? request.requestId : generateRequestId();
      const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : "upgrade.authority_stale";
      const message = error instanceof Error ? error.message : String(error);
      const detail = coordinatorAuthorityRecoveryOperationNames.length > 0
        ? `; active final I/O=${coordinatorAuthorityRecoveryOperationNames.join(",")}`
        : "";
      return {
        requestId,
        sessionEpoch: coordinatorState.sessionEpoch,
        ack: { status: "error", message: `${message}${detail}`, code: code as never },
      };
    }
  }
  if (revokedCoordinatorPeerIds.has(actualClientId) || requestSignal?.aborted) return disconnectedClientResponse(requestId);
  if (isStorageRequest(request)) {
    // Storage 分支有多个异步边界（Provider、K-V、Connect session）。
    // 无论哪一层抛错都必须回到 RPC 响应，并先由同一个入口分类健康状态；
    // 不能让 MessagePort 等待到超时。
    return executeStorageRequest(request as never, actualClientId, requestSignal).catch((error) => {
      markStorageIoFailure(error);
      return storageErrorResponse("requestId" in request ? request.requestId : generateRequestId(), error);
    }).finally(() => clearStorageRequestSecrets(request));
  }
  if (isMsfileRequest(request)) {
    if (request.kind === "window-p2p.executor.acquire" || request.kind === "window-p2p.executor.release" || request.kind === "window-p2p.executor.spike.transfer" || request.kind === "window-p2p.executor.identity.sign-noise" || request.kind === "window-p2p.executor.identity.sign-peer-record") {
    return executeWindowP2pExecutorRequest(request as WindowP2pExecutorRequest, actualClientId);
    }
    return executeMsfileRequest(request as never, actualClientId);
  }
  // lock 是最高优先级的本地安全动作，不能排在普通 Coordinator FIFO
  // 后面；否则前面的长任务会阻止它及时撤销密钥、lease 和代理。
  if (request.kind === "lock") return executeProcessRequest(request, actualClientId);
  // Vault identity is a committed in-memory projection. Shell reads must not
  // queue behind an unrelated network operation; their epoch and final read
  // lease checks still run in executeProcessRequest/handleVaultOperation.
  if (request.kind === "vault.operation" && request.operation.type === "getCurrentKey") return executeProcessRequest(request, actualClientId);
  return enqueueCoordinatorRequest(request, actualClientId, requestSignal);
}

/**
 * 为可取消的页面请求登记控制器，再进入 Coordinator FIFO。
 *
 * 断开协议与原请求是两个独立 MessagePort 消息；控制器必须在进入
 * authority 等待前登记，否则旧页面可能在异步校验期间重新取得远端租约。
 */
async function processRequest(
  request: CoordinatorClientRequest,
  actualClientId = (request as { clientId?: string }).clientId ?? "unknown",
  requestSignal?: AbortSignal,
): Promise<CoordinatorResponse> {
  if (request.kind !== "channel.operation") return processRequestCore(request, actualClientId, requestSignal);
  const requestId = request.requestId;
  const key = channelRequestKey(actualClientId, requestId);
  const controller = new AbortController();
  let removeRequestSignal: (() => void) | undefined;
  if (requestSignal) {
    const abort = (): void => {
      try { controller.abort(requestSignal.reason); } catch { controller.abort(); }
    };
    if (requestSignal.aborted) abort();
    else {
      requestSignal.addEventListener("abort", abort, { once: true });
      removeRequestSignal = () => requestSignal.removeEventListener("abort", abort);
    }
  }
  channelRequests.set(key, { clientId: actualClientId, controller });
  try {
    return await processRequestCore(request, actualClientId, controller.signal);
  } finally {
    removeRequestSignal?.();
    if (channelRequests.get(key)?.controller === controller) channelRequests.delete(key);
  }
}

// ============================================================
// 7. Vault Operations
// ============================================================

async function handleUnlock(
  requestId: string,
  request: { kind: "unlock"; password: string; expectedSessionEpoch: SessionEpoch }
): Promise<CoordinatorResponse> {
  try {
    return await withCoordinatorFinalIoLease(
      "write",
      undefined,
      () => handleUnlockUnsafe(requestId, request),
      { allowLocalLock: true, allowLocalOwnerTransition: true, auditOperation: "vault.unlock" },
    );
  } finally {
    // 释放 MessageEvent 对象中仍可控的密码引用；解密上下文/私钥在
    // handleUnlockUnsafe 的 finally 中处理。
    request.password = "";
  }
}

async function handleUnlockUnsafe(requestId: string, request: { kind: "unlock"; password: string; expectedSessionEpoch: SessionEpoch }): Promise<CoordinatorResponse> {
  return executeWorkerUnlock(requestId, request, {
    session: () => coordinatorState,
    coldStart: async () => storageColdStartState ?? await walletLifecycle?.coldStart(),
    lifecycle: requireWalletLifecycle,
    completeBinding: completeUnlockedBinding,
    storageFailed: markStorageIoFailure,
    clearFailedSession: () => { coordinatorState.vaultStatus = "locked"; coordinatorState.activePublicKeyHex = undefined; dropActivePrivateKey(); },
    storageError: storageErrorResponse,
  });
}

/**
 * 解锁后的运行绑定收口。
 *
 * 会话状态与私钥副本由 lifecycle 的 adoptUnlockedKey 写入；这里负责最终
 * I/O 门禁、业务运行单元、任务恢复、快照广播和自动锁计时。任一步失败都
 * fail closed 回到 locked，而不是让页面看到半解锁状态。
 */
async function completeUnlockedBinding(cause: SessionStateEvent["cause"] = "unlock"): Promise<void> {
  const publicKeyHex = coordinatorState.activePublicKeyHex;
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
  } catch (error) {
    await performGlobalLock("worker-unit-bind-failed");
    throw error;
  }
  emitStorageState();

  for (const runtime of coordinatorState.taskRuntimes.values()) {
    if (runtime.state === "blocked" && runtime.blockedReason === "Vault is locked") {
      runtime.state = "idle";
      runtime.blockedReason = undefined;
      scheduleRuntime(runtime);
      if (runtime.syncPolicy === "smart") armSmartSyncIfIdle();
    }
  }
  triggerImmediateSync(BACKGROUND_TRIGGER_REASON.UNLOCK);
  publishSessionState(cause);
  void ensureSatRuntime()
    .then((runtime) => ensureChannelSubscriptionMux(runtime))
    .catch((error) => console.warn("[channel] owner runtime startup deferred", error instanceof Error ? error.message : String(error)));
  publishTopicEvent("background.snapshot", {
    type: "background.snapshot.changed",
    sessionEpoch: coordinatorState.sessionEpoch,
    snapshots: getTaskSnapshots(),
  });
  resetAutoLockTimer();
}

async function handleVaultOperation(requestId: string, request: { kind: "vault.operation"; operation: CoordinatorVaultOperation }): Promise<CoordinatorResponse> {
  try {
    // 所有从页面进入的 Vault 仓库读写都必须在最终边界重新登记；仅在
    // processRequest 开头检查一次运行世代不足以覆盖中途的状态切换。
    // allowLocalLock / allowLocalOwnerTransition 只允许本次操作自己执行
    // fail-closed 锁定或 owner 切换；仍会重新校验共享 authority，不能把
    // 旧页面/迟到结果当成成功。
    const ioKind = vaultOperationIoKind(request.operation);
    const result = await withCoordinatorFinalIoLease(
      ioKind,
      undefined,
      () => executeVaultOperation(request.operation),
      {
        allowLocalLock: true,
        allowLocalOwnerTransition: true,
        auditOperation: "vault.operation",
        // list/get/export/verify 只读取当前本地真值；底层存储入口也有各自的
        // authority 与绑定世代检查。保留本 Worker 的前后栅栏，但只让真正
        // 会改写 Vault 的操作登记内存 write lease；刷新时浏览器锁随 Worker
        // 终止自动释放，不会留下无法清理的业务 K-V 记录。
        durableLease: ioKind === "write",
      },
    );
    return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: result };
  } catch (err) {
    markStorageIoFailure(err);
    return storageErrorResponse(requestId, err);
  } finally {
    clearVaultOperationSecrets(request.operation);
  }
}

/** Vault 操作的最终边界类型；含私钥/KeyHold 读取的操作也走 read lease。 */
function vaultOperationIoKind(operation: CoordinatorVaultOperation): "read" | "write" {
  switch (operation.type) {
    case "verifyPassword":
    case "exportKeyHold":
    case "getCurrentKey":
      return "read";
    default:
      return "write";
  }
}

/**
 * 单 Key 生命周期的唯一权威路径。
 *
 * 生命周期服务（WalletLifecycleService）负责 KeyHold 的解密、改密、重命名、
 * 导出和重置；Coordinator 只负责把它的结果接进 Worker 的会话、运行绑定、
 * grant 和业务运行单元。这里没有 Key 列表、没有选择、没有切换，也没有第二把
 * Key 的写入口——更换身份只能走 reset-wallet 之后重新创建或导入。
 */

/** 唯一 Key 的公开摘要；未解锁时只有冷启动 meta 里的公开字段。 */
function currentKeySummary(): KeyIdentity | undefined {
  return coordinatorActiveKeySummary();
}

/**
 * lifecycle 的解锁接管回调。
 *
 * 由 WalletLifecycleService 在认证通过、私钥清零之前调用；它负责完成全部
 * 会话状态写入与运行绑定，Coordinator 才会认为解锁已经成立。
 */
function adoptUnlockedKey(input: {
  identity: import("@keymaster/contracts").KeyIdentity;
  privateKeyBytes: Uint8Array;
  publicKeyHex: string;
  walletGeneration: string;
  sessionEpoch: string;
}): void {
  // 旧会话的所有 grant 与任务权限先撤销：解锁只授予新身份，不继承旧句柄。
  revokeStorageSessionGrants();
  coordinatorState.walletGeneration = input.walletGeneration;
  // 生命周期已经生成新的会话世代，Coordinator 必须使用它而不是再造一个：
  // grant、存储绑定和迟到结果全部按这个 epoch 判定。
  coordinatorState.sessionEpoch = input.sessionEpoch;
  coordinatorState.vaultStatus = "unlocked";
  coordinatorState.activePublicKeyHex = input.publicKeyHex;
  replaceActivePrivateKey(input.privateKeyBytes);
  setCoordinatorActiveKeySummary(input.identity);
  // The authenticated session is committed before owner-unit construction reads it.
  workerWalletState.publish();
  testHarnessActivationSecret = undefined;
}

/**
 * lifecycle 的授权撤销回调。
 *
 * 锁定与重置都必须先走这里：把授权、任务和 Connect 运行绑定一起撤销，
 * 让已经拿到句柄的迟到写入在任何数据检查之前就被拒绝。
 */
function revokeWalletGrants(reason: "lock" | "reset"): void {
  revokeStorageSessionGrants();
  releaseMsfileRuntime(reason);
  void releaseSatRuntime(reason).catch(() => undefined);
  clearWindowP2pExecutorLeaseLocked();
  stopCoordinatorOwnerWorkerUnits();
}

/** 建立新会话的运行绑定；Coordinator 侧 grant 与存储绑定都读这几个字段。 */
function establishWalletSession(input: {
  sessionEpoch: string;
  walletGeneration: string;
  publicKeyHex: string;
}): void {
  coordinatorState.walletGeneration = input.walletGeneration;
  coordinatorState.sessionEpoch = input.sessionEpoch;
  coordinatorState.activePublicKeyHex = input.publicKeyHex;
}

async function executeVaultOperation(operation: CoordinatorVaultOperation): Promise<unknown> {
  const epoch = coordinatorState.sessionEpoch;
  const owner = coordinatorState.activePublicKeyHex;
  return executeOwnedVaultOperation(operation, {
    lifecycle: requireWalletLifecycle,
    currentKey: currentKeySummary,
    beforePasswordChange: () => revokeStorageBindingAndDrain("vault.changePassword"),
    passwordChanged: () => {
          emitStorageState();
      publishSessionState("change-password");
    },
    renamed: (label) => {
      const summary = coordinatorActiveKeySummary();
      if (summary) setCoordinatorActiveKeySummary({ ...summary, label });
        },
    assertSecretSession: () => {
      if (coordinatorState.vaultStatus !== "unlocked" || coordinatorState.sessionEpoch !== epoch || coordinatorState.activePublicKeyHex !== owner) throw new Error("Vault secret session is unavailable");
    },
    deriveLocalSecretKey: (scope) => vaultKeySession.deriveLocalSecretKey(scope),
  });
}

function requireWalletLifecycle(): WalletLifecycleService {
  if (!walletLifecycle) throw storageUnavailableError("Wallet lifecycle is unavailable");
  return walletLifecycle;
}

async function handleLock(
  requestId: string,
  request: { kind: "lock"; expectedSessionEpoch: SessionEpoch },
): Promise<CoordinatorResponse> {
  await performGlobalLock("manual");
  return {
    requestId,
    sessionEpoch: coordinatorState.sessionEpoch,
    ack: { status: "accepted" },
  };
}

/**
 * 锁定：先撤销授权，再清空内存身份。
 *
 * 不再有任何跨浏览器 Key 锁、lock.json 租约或持久化心跳：本地钱包只保证
 * 本浏览器本 Origin 的单实例，锁定是完全的内存态迁移。
 */
async function performGlobalLock(reason: string): Promise<void> {
  cancelSmartSyncIdleTimer();
  // 先撤销会话、grant 与任务权限；迟到的写入在数据层检查之前就已经被拒。
  revokeWalletGrants("lock");
  // 浏览句柄绑定 session epoch，随 epoch 推进整体作废；这里显式撤销，让
  // 页面上已经拿到的句柄立刻失效，而不是等到下一次请求再失败。
  storageBrowseCoordinator.revokeAll();
  const previousActive = coordinatorState.activePublicKeyHex?.toLowerCase();
  if (previousActive) void cancelTaskRuntimesByKey(previousActive).catch(() => undefined);

  const lockedEpoch = generateEpoch();
  coordinatorState.sessionEpoch = lockedEpoch;
  coordinatorState.vaultStatus = "locked";
  for (const [, runtime] of coordinatorState.taskRuntimes) {
    runtime.controller?.abort();
    if (runtime.timer) clearTimeout(runtime.timer);
    runtime.state = "blocked";
    runtime.blockedReason = "Vault is locked";
    runtime.timer = undefined;
  }

  coordinatorState.activePublicKeyHex = undefined;
  dropActivePrivateKey();
  setCoordinatorActiveKeySummary(undefined);
  workerStorageClients.invalidateAll();
  testHarnessActivationSecret = undefined;
  coordinatorState.autoLockDeadline = undefined;
  vaultAutoLock.pause();
  stopCoordinatorOwnerWorkerUnits();
  reconcileCoordinatorRuntime();

  closeCoordinatorUpgradeSession(`Coordinator locked: ${reason}`);
  if (walletLifecycle) await walletLifecycle.lock().catch((error) => {
    console.warn("[wallet] lifecycle lock failed", error instanceof Error ? error.message : String(error));
  });

  emitMsFileState();
  emitStorageState();
  publishTopicEvent("background.snapshot", {
    type: "background.snapshot.changed",
    sessionEpoch: coordinatorState.sessionEpoch,
    snapshots: getTaskSnapshots(),
  });
  publishSessionState("lock");
}

// ============================================================
// 8. Crypto Operations
// ============================================================

async function handleCrypto(
  requestId: string,
  request: { kind: "crypto"; operation: CoordinatorCryptoOperation; expectedSessionEpoch: SessionEpoch }
): Promise<CoordinatorResponse> {
  if (coordinatorState.vaultStatus !== "unlocked") {
    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "blocked", reason: { key: "background.blocked.unlock", fallback: "Vault is locked" } },
    };
  }

  // Crypto RPC 同样属于 session-bound 操作。尤其 Channel seal/open 内部
  // 会经过异步 SDK；如果 lock 或 active-key switch 在中途推进 epoch，旧
  // 结果不能以新 owner 的身份返回。
  if (request.expectedSessionEpoch !== coordinatorState.sessionEpoch) {
    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "stale-epoch" },
    };
  }

  if (!vaultKeySession.hasKey()) {
    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "blocked", reason: { key: "background.blocked.noActiveKey", fallback: "No active key" } },
    };
  }

  try {
    const result = await withCoordinatorFinalIoLease(
      "write",
      undefined,
      () => vaultKeySession.execute(request.operation),
      {
        auditOperation: "service.crypto.sign",
        // 签名只在 Worker 内计算；结果必须经过下方 epoch 检查以及
        // withCoordinatorFinalIoLease 的后置运行世代检查才会发布。
        // 页面刷新若终止 Worker，浏览器锁会自动释放；纯本地签名不需要
        // 额外的业务持久化租约；Worker 生命周期 authority lock 仍然必须
        // 在进入 withCoordinatorFinalIoLease 前已取得。
        durableLease: false,
      },
    );

    if (request.expectedSessionEpoch !== coordinatorState.sessionEpoch || coordinatorState.vaultStatus !== "unlocked" || !vaultKeySession.hasKey()) {
      return {
        requestId,
        sessionEpoch: coordinatorState.sessionEpoch,
        ack: { status: "stale-epoch" },
      };
    }

    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "ok" },
      cryptoResult: result,
    };
  } catch (err) {
    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "error", message: err instanceof Error ? err.message : String(err) },
    };
  }
}

// ============================================================
// 9. Background Operations
// ============================================================

// ============================================================
// 10. Ordinary P2PKH data-source selection and transaction broadcast RPC
// ============================================================

/** 当前 owner 的 p2pkh setting.json 是否已载入运行时镜像。 */

let testFailNextP2pkhSettingWrite = false;

/** 测试专用：让下一次 setting.json 写失败一次。 */
export function __testFailNextP2pkhSettingWrite(): void {
  testFailNextP2pkhSettingWrite = true;
}

function p2pkhSettingRepository(): ReturnType<typeof createP2pkhFileRepository> {
  return createP2pkhFileRepository(createWorkerModuleFileStore("p2pkh", ""));
}

const p2pkhWorkerSettings = createWorkerP2pkhSettings({
  storage: () => createWorkerModuleFileStore("p2pkh", ""),
  session: () => ({ sessionEpoch: coordinatorState.sessionEpoch, activePublicKeyHex: coordinatorState.activePublicKeyHex }),
  projection: coordinatorMeta,
  beforeWrite: () => {
    if (testFailNextP2pkhSettingWrite) {
      testFailNextP2pkhSettingWrite = false;
      throw new StorageRuntimeError("storage_provider_error", "injected P2PKH setting write failure");
    }
  },
  clearSnapshots: () => p2pkhUtxoSnapshots?.clearAll(),
  reschedule: cancelP2pkhSyncForProviderChange,
  taskSnapshots: getTaskSnapshots,
  publishSnapshot: (event) => { publishTopicEvent("background.snapshot", event); },
  woc: () => testDomainUnitReadiness ? p2pkhWocService : p2pkhWorkerWocQuery,
});
const loadP2pkhSettingForOwner = p2pkhWorkerSettings.load;
const resetP2pkhSettingsRuntime = p2pkhWorkerSettings.reset;

function ensureWorkerP2pkhResources(ownerPublicKeyHex: string, includeTestnet: boolean): Promise<P2pkhUtxoSnapshotResource[]> {
  return ensureOwnedP2pkhResources(createWorkerModuleFileStore("p2pkh", ""), ownerPublicKeyHex, includeTestnet);
}

async function refreshP2pkhUtxoSnapshots(signal?: AbortSignal, storage: BorrowedModuleFileStore = createWorkerModuleFileStore("p2pkh", ""), assertActive: () => void = () => undefined): Promise<{ main?: number; test?: number }> {
  const owner = coordinatorState.activePublicKeyHex;
  const snapshots = p2pkhUtxoSnapshots;
  const epoch = coordinatorState.sessionEpoch;
  if (!owner || !snapshots) return {};
  if (createWorkerWalletState().snapshot().activePublicKeyHex?.toLowerCase() !== owner.toLowerCase()) return {};
  return refreshWorkerP2pkhResources({
    storage, ownerPublicKeyHex: owner,
    includeTestnet: coordinatorMeta.p2pkhSettings?.includeTestnet === true, snapshots,
    assertFresh: () => { assertActive(); if (coordinatorState.sessionEpoch !== epoch || coordinatorState.activePublicKeyHex !== owner || p2pkhUtxoSnapshots !== snapshots) throw new Error("P2PKH snapshot refresh became stale"); },
    afterRefresh: (network, result) => reconcileMsfileBitfsFundingInputs(owner, network, result),
  }, signal);
}

async function cancelP2pkhSyncForProviderChange(): Promise<void> {
  // P2PKH 现在拆成 history + UTXO 两个任务；Provider 变化时两个都要取消，
  // 避免旧任务继续使用已经撤权的 Provider 写结果。
  for (const taskId of ["p2pkh.transactions-sync", "p2pkh.utxo-snapshot"]) {
    const runtime = coordinatorState.taskRuntimes.get(taskId);
    runtime?.controller?.abort();
    if (runtime?.timer) clearTimeout(runtime.timer);
    runtime && (runtime.timer = undefined);
    if (runtime?.completion) await runtime.completion.catch(() => undefined);
    if (runtime && coordinatorState.vaultStatus === "unlocked" && coordinatorState.activePublicKeyHex) {
      // Execute immediately; executeTask's finally block installs the next
      // interval after this run. Scheduling here as well would leave a second
      // timer alive and allow overlapping sync runs.
      void executeTask(runtime.id, "provider-change");
    }
  }
}

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
async function p2pkhResourceForOwner(ownerPublicKeyHex: string, network: "main" | "test") {
  if (createWorkerWalletState().snapshot().activePublicKeyHex?.toLowerCase() !== ownerPublicKeyHex.toLowerCase()) throw new Error("P2PKH storage owner is not active");
  return readWorkerP2pkhResource(createWorkerModuleFileStore("p2pkh", ""), { ownerPublicKeyHex, network });
}
async function executeP2pkhSnapshot(requestId: string, request: { ownerPublicKeyHex: string; network: "main" | "test" }, refresh: boolean): Promise<CoordinatorResponse> {
  if (!isCoordinatorProductRegistered("p2pkh")) return coordinatorProductBlockedResponse(requestId, "p2pkh");
  const epoch = coordinatorState.sessionEpoch;
  const snapshots = p2pkhUtxoSnapshots;
  return executeWorkerP2pkhSnapshot(requestId, request, refresh, {
    storage: createWorkerModuleFileStore("p2pkh", ""), snapshots,
    epoch: () => coordinatorState.sessionEpoch,
    assertFresh: () => {
      if (coordinatorState.sessionEpoch !== epoch || coordinatorState.vaultStatus !== "unlocked" || coordinatorState.activePublicKeyHex?.toLowerCase() !== request.ownerPublicKeyHex.toLowerCase() || p2pkhUtxoSnapshots !== snapshots) throw new Error("P2PKH snapshot session became stale");
      if (!testDomainUnitReadiness) p2pkhWorkerPorts?.assertActive();
    },
    reconcile: (input, snapshot) => reconcileMsfileBitfsFundingInputs(input.ownerPublicKeyHex, input.network, snapshot),
    filter: (input, snapshot) => filterP2pkhSnapshotByBitfsFunds(input.ownerPublicKeyHex, input.network, snapshot),
    publish: event => { publishTopicEvent("asset.data-changed", event); },
  });
}
const handleP2pkhUtxosGet = (requestId: string, request: Extract<CoordinatorClientRequest, { kind: "p2pkh.utxos.get" }>) => executeP2pkhSnapshot(requestId, request, false);
const handleP2pkhUtxosRefresh = (requestId: string, request: Extract<CoordinatorClientRequest, { kind: "p2pkh.utxos.refresh" }>) => executeP2pkhSnapshot(requestId, request, true);

/** 读取内存 UTXO 快照；没有 resource 或没有快照时 available=false。 */


/**
 * 刷新内存 UTXO 快照。
 *
 * 刷新失败时旧快照原样保留（绝不清空/置零），RPC 以 error 返回失败，
 * 让调用方（转账 prepare/submit）明确拒绝继续，而不是使用过期快照。
 */


async function handleP2pkhBroadcast(
  requestId: string,
  request: Extract<CoordinatorClientRequest, { kind: "p2pkh.broadcast" }>
): Promise<CoordinatorResponse> {
  if (!isCoordinatorProductRegistered("p2pkh")) return coordinatorProductBlockedResponse(requestId, "p2pkh");
  // 广播可能已经被远端接受但尚未回写本地提交记录；必须把 Provider
  // 调用和 submission audit 放在同一个持久 write lease 内。若期间发生
  // 本地 lock，下面的 lease 复核会把结果报告为 error/unknown，不能伪报
  // 成功，但 Unsafe 逻辑仍会尽力记录远端返回或失败原因。
  return withCoordinatorFinalIoLease(
    "write",
    undefined,
    async () => {
      try {
        return await handleP2pkhBroadcastUnsafe(requestId, request);
      } catch (error) {
        // 不可逆操作的处理异常必须变成显式错误响应，而不是让框架层吞掉原因后
        // 只报 "Remote capability operation failed"；调用方会以 isolated 收口。
        const message = error instanceof Error ? error.message : String(error);
        return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "error", message: `P2PKH broadcast failed: ${message}` } };
      }
    },
    { auditOperation: "p2pkh.broadcast" },
  );
}

async function handleP2pkhBroadcastUnsafe(
  requestId: string,
  request: Extract<CoordinatorClientRequest, { kind: "p2pkh.broadcast" }>
): Promise<CoordinatorResponse> {
  const epoch = coordinatorState.sessionEpoch;
  const snapshots = p2pkhUtxoSnapshots;
  return executeWorkerP2pkhBroadcast(requestId, request, {
    assertFresh: () => {
      if (coordinatorState.sessionEpoch !== epoch || coordinatorState.vaultStatus !== "unlocked" || coordinatorState.activePublicKeyHex?.toLowerCase() !== request.ownerPublicKeyHex.toLowerCase() || p2pkhUtxoSnapshots !== snapshots) throw new Error("P2PKH broadcast session is unavailable");
    },
    provider: testP2pkhBroadcastProvider ?? p2pkhRegistry?.getBroadcastProvider("woc", request.network),
    walletState: createWorkerWalletState(),
    storage: () => createWorkerModuleFileStore("p2pkh", ""),
    sessionEpoch: () => coordinatorState.sessionEpoch,
    snapshots,
    resource: p2pkhResourceForOwner,
    listProtectedOutpoints: (input) => currentMsfileBitfsFundingLedger().listProtectedOutpoints(input),
    abortNotDispatched: abortNotDispatchedP2pkhSubmission,
    refresh: refreshP2pkhUtxoSnapshots,
    publishChanged: (event) => { publishTopicEvent("asset.data-changed", event); },
  });
}

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
    authorityInstanceId: coordinatorAuthorityInstanceId,
    runGeneration: coordinatorState.runGeneration,
    buildId: COORDINATOR_BUILD_ID,
    sessionEpoch: coordinatorState.sessionEpoch,
    vaultStatus: coordinatorState.vaultStatus,
    activePublicKeyHex: coordinatorState.vaultStatus === "unlocked" ? coordinatorState.activePublicKeyHex : undefined,
    ...(coordinatorState.vaultStatus === "unlocked" ? { activeKeyIdentity: coordinatorActiveKeySummary() } : {}),
    // 钱包身份世代：单 Key 模型下没有 selectedPublicKeyHex（没有可切换的
    // Key），页面只用它判断重置/重新初始化后旧授权是否已经失效。
    walletGeneration: coordinatorState.walletGeneration || undefined,
    ...(coordinatorAuthorityRecovery ? { authorityRecovery: coordinatorAuthorityRecovery } : {}),
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
function taskSnapshotKeyScope(runtime: TaskRuntime): { publicKeyHex: string; label?: string } | undefined {
  if (coordinatorState.vaultStatus !== "unlocked") return undefined;
  try { return resolveKeyScope(runtime); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "lifecycle.scope_revoked") return undefined;
    throw error;
  }
}

function getTaskSnapshots(): CoordinatorTaskSnapshot[] {
  const snapshots: CoordinatorTaskSnapshot[] = [];

  for (const [taskId, runtime] of coordinatorState.taskRuntimes) {
    snapshots.push({
      id: taskId,
      pluginId: runtime.pluginId,
      unitId: runtime.unitId,
      instanceId: runtime.instanceId,
      label: taskId,
      state: runtime.state,
      lastStartedAt: runtime.lastStartedAt,
      lastCompletedAt: runtime.lastCompletedAt,
      lastAttemptAt: runtime.lastAttemptAt,
      nextRunAt: runtime.nextRunAt,
      error: runtime.error,
      blockedReason: runtime.blockedReason ? { key: "background.blocked.task", fallback: runtime.blockedReason } : undefined,
      keyScope: taskSnapshotKeyScope(runtime),
    });
  }

  return snapshots;
}

/**
 * Worker 内的 UTXO 序号通知。
 *
 * 中文：topic stream 只发给页面 peer；Worker 内部的重试方（SatSubscription
 * 的中心广播服务）需要一个同进程的唤醒源，避免等退避到点再出网探测。
 * 只传序号，不传快照内容，语义与页面的 `asset.data-changed.utxoSeqs` 一致。
 */
interface WorkerUtxoSeqEvent {
  /** 序号归属 owner（压缩公钥 hex，小写）。 */
  ownerPublicKeyHex: string;
  /** 网络：main=主网，test=测试网。 */
  network: "main" | "test";
  /** 最新快照序号。 */
  seq: number;
}

const workerUtxoSeqListeners = new Set<(event: WorkerUtxoSeqEvent) => void>();

function subscribeWorkerUtxoSeq(listener: (event: WorkerUtxoSeqEvent) => void): () => void {
  workerUtxoSeqListeners.add(listener);
  return () => workerUtxoSeqListeners.delete(listener);
}

function publishWorkerUtxoSeq(event: WorkerUtxoSeqEvent): void {
  for (const listener of [...workerUtxoSeqListeners]) {
    try {
      listener(event);
    } catch {
      // 观察者失败不能影响快照提交。
    }
  }
}

function publishTopicEvent(topic: CoordinatorTopic, event: any): CoordinatorTopicEvent {
  const normalized = {
    ...event,
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
          publishWorkerUtxoSeq({ ownerPublicKeyHex: assetEvent.publicKeyHex, network, seq });
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
  owner: executeOwnerStorageData,
  platform: executePlatformStorageData,
});
const handleCoordinatorCryptoRpc = createWorkerCryptoRpc({
  authorize: call => { requireCoordinatorSessionPeer(call); },
  identity: () => ({ unlocked: coordinatorState.vaultStatus === "unlocked", publicKeyHex: coordinatorState.activePublicKeyHex, sessionEpoch: coordinatorState.sessionEpoch }),
  keySession: vaultKeySession,
  withIoLease: (signal, execute) => withCoordinatorFinalIoLease("write", signal, execute, {
    auditOperation: "service.crypto.sign",
    durableLease: false,
  }),
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
    && Boolean(coordinatorState.activePublicKeyHex && vaultKeySession.hasKey())
    && Boolean(platformRootStore && platformRootToken)
    && platformStorageReady
    && !storageStartupFailure;
}

function coordinatorSessionExposureIdentity(): string {
  // 服务暴露的身份由运行代次、会话世代和钱包身份世代决定；单 Key 模型下
  // 不再有桶身份，也不再有「切换 Key」这件事需要额外参与判定。
  return [
    coordinatorAuthorityInstanceId,
    coordinatorHandoverGeneration,
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

function reconcileCoordinatorSessionExposures(): void {
  for (const state of coordinatorPeers.values()) reconcileCoordinatorSessionExposure(state);
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
  if (fullRequest.kind === "channel.cancel") {
    const target = channelRequests.get(channelRequestKey(peerId, fullRequest.targetRequestId));
    if (target && target.clientId === peerId) target.controller.abort();
    return coordinatorRpcResponse(request, { sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" } });
  }
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
  setup(context) {
    context.handle(COORDINATOR_RPC_CAPABILITY, (request, call) => handleCoordinatorRpc(request, call));
    context.handle(COORDINATOR_TOPIC_STREAM_CAPABILITY, (request, call) => coordinatorTopicStream(request, call));
  },
});

/**
 * Coordinator 的真实 Worker 装配清单。
 *
 * setup 复用现有领域实现，但运行单元的启停、Scope 和公开快照由
 * WebLoom Host 拥有。`coordinatorWorkerUnitRegistry` 只保存任务/清理代码
 * 仍需的领域句柄；它不再是第二个对外生命周期 Host。
 */
const coordinatorRuntimePlugins = COORDINATOR_WORKER_UNIT_CATALOG.map((unit) => {
  const product = BUILTIN_PLUGIN_DEFINITIONS.find(candidate => candidate.id === unit.productId);
  const declaration = product?.units.find(candidate => candidate.id === unit.unitId);
  if (!product || !declaration || declaration.runtime !== "shared-worker") throw new Error(`Missing materialized Worker definition: ${unit.unitId}`);
  return definePlugin({
    id: unit.productId,
    name: product.name,
    unitId: unit.unitId,
    runtime: "shared-worker",
    provides: declaration.provides.map(capability => {
      const implementation = [VAULT_WORKER_CRYPTO_CAPABILITY, P2PKH_WORKER_TRANSFER_CAPABILITY, WOC_WORKER_BROADCAST_CAPABILITY, CONTACTS_PRESENCE_CHANNEL_CAPABILITY, MSFILE_SERVICE_CAPABILITY, SAT_SUBSCRIPTION_SERVICE_CAPABILITY, SAT_SUBSCRIPTION_SPI_SERVICE_CAPABILITY, COORDINATOR_OWNER_STORAGE_RPC_CAPABILITY, COORDINATOR_PLATFORM_STORAGE_RPC_CAPABILITY, COORDINATOR_CRYPTO_RPC_CAPABILITY, WOC_CAPABILITY, VAULT_WALLET_STATE_CAPABILITY, P2PKH_ASSET_READER_CAPABILITY, WOC_BSV21_CAPABILITY, WOC_STAS_CAPABILITY, WOC_1SAT_ORDINALS_CAPABILITY, STORAGE_FILE_CLIENTS_CAPABILITY, STORAGE_KV_CLIENTS_CAPABILITY]
        .find(candidate => candidate.kind === capability.kind && candidate.id === capability.id && candidate.version === capability.version);
      if (!implementation) throw new Error(`Worker capability implementation missing: ${capability.id}`);
      return implementation;
    }),
    privateProvides: declaration.privateProvides.map(capability => {
      if (capability.id === STORAGE_PRIVATE_BROWSE_CAPABILITY.id && capability.kind === STORAGE_PRIVATE_BROWSE_CAPABILITY.kind && capability.version === STORAGE_PRIVATE_BROWSE_CAPABILITY.version) return STORAGE_PRIVATE_BROWSE_CAPABILITY;
      throw new Error(`Worker private capability implementation missing: ${capability.id}`);
    }),
    dependencies: declaration.dependencies,
    permissions: declaration.permissions,
    async setup(context) {
      workerConsumers.set(context.consumer, context.scope);
      context.scope.onRevoke(() => workerConsumers.delete(context.consumer));
      let ready: ReturnType<typeof coordinatorWorkerUnitRegistry.ready>;
      if (unit.unitId === "msfile.coordinator-worker") {
        context.capability(SAT_SUBSCRIPTION_SERVICE_CAPABILITY);
        const chainAccess = () => {
          const query = context.optionalCapability(WOC_CAPABILITY);
          const broadcast = context.optionalCapability(WOC_WORKER_BROADCAST_CAPABILITY);
          return query && broadcast ? { ...query, broadcast: broadcast.broadcast.bind(broadcast) } : undefined;
        };
        msfileWorkerChainAccess = chainAccess;
        context.scope.onRevoke(() => { if (msfileWorkerChainAccess === chainAccess) msfileWorkerChainAccess = undefined; });
        const files = context.capability(STORAGE_FILE_CLIENTS_CAPABILITY);
        const ownerPublicKeyHex = context.capability(VAULT_WALLET_STATE_CAPABILITY).bind(context.consumer, context.scope).snapshot().activePublicKeyHex;
        if (!ownerPublicKeyHex) throw msfileError("msfile_unavailable", "MSFile requires an active owner");
        const ownedRuntime = await ensureMsfileRuntime(context.instanceId, { ownerPublicKeyHex, settings: files.bind(context.consumer, context.scope, ""), appSettings: files.bind(context.consumer, context.scope, "app-settings") }, () => context.scope.assertActive());
        context.scope.onRevoke(() => { if (msfileRuntime === ownedRuntime) releaseMsfileRuntime("unit-revoked"); });
        context.provide(MSFILE_SERVICE_CAPABILITY, createPublicMsFileService(ownedRuntime, () => context.scope.assertActive()));
        ready = coordinatorWorkerUnitRegistry.ready(unit.unitId, context.instanceId);
      } else if (unit.unitId === "sat-subscription.coordinator-worker") {
        const p2pkhAccess = async () => {
          const binding = context.optionalCapability(P2PKH_WORKER_TRANSFER_CAPABILITY);
          return binding ? binding.getService() : null;
        };
        satWorkerP2pkhAccess = p2pkhAccess;
        context.scope.onRevoke(() => { if (satWorkerP2pkhAccess === p2pkhAccess) satWorkerP2pkhAccess = undefined; });
        const ownedRuntime = await ensureSatRuntime(context.instanceId, context.capability(STORAGE_FILE_CLIENTS_CAPABILITY).bind(context.consumer, context.scope, ""), () => context.scope.assertActive());
        context.scope.onRevoke(() => { if (satRuntime === ownedRuntime) void releaseSatRuntime("unit-revoked"); });
        ready = coordinatorWorkerUnitRegistry.ready(unit.unitId, context.instanceId);
      } else {
        const activated = activateCoordinatorWorkerUnitForRuntime(unit.unitId, context.instanceId);
        if (activated.instanceId !== context.instanceId) {
          throw new Error(`Coordinator Worker unit instance mismatch: ${unit.unitId}`);
        }
        ready = coordinatorWorkerUnitRegistry.ready(activated.unitId, activated.instanceId);
      }
      if (ready.instanceId !== context.instanceId) {
        throw new Error(`Coordinator Worker unit ready instance mismatch: ${unit.unitId}`);
      }
      if (unit.productId === "window-p2p") {
        const owner = context.capability(VAULT_WALLET_STATE_CAPABILITY).bind(context.consumer, context.scope).snapshot().activePublicKeyHex;
        const epoch = coordinatorState.sessionEpoch;
        if (!owner || context.capability(VAULT_WALLET_STATE_CAPABILITY).bind(context.consumer, context.scope).snapshot().status !== "unlocked") throw new Error("Window P2P requires an unlocked owner");
        context.scope.onRevoke(() => {
          if (coordinatorWorkerUnitRegistry.get(unit.unitId)?.instanceId === context.instanceId && windowP2pExecutorLease?.sessionEpoch === epoch && windowP2pExecutorLease.ownerPublicKeyHex === owner) clearWindowP2pExecutorLeaseLocked();
        });
      }
      if (unit.productId === "sat-subscription") {
        if (!satRuntime) throw new Error("SatSubscription Worker service is unavailable");
        context.provide(SAT_SUBSCRIPTION_SERVICE_CAPABILITY, satRuntime.admin);
        context.provide(SAT_SUBSCRIPTION_SPI_SERVICE_CAPABILITY, satRuntime.spi);
        context.provide(CONTACTS_PRESENCE_CHANNEL_CAPABILITY, createCoordinatorChannelRuntime(() => context.scope.assertActive()));
      }
      if (unit.productId === "vault") {
        vaultCryptoProviderScope = context.scope;
        context.scope.onRevoke(() => { if (vaultCryptoProviderScope === context.scope) vaultCryptoProviderScope = undefined; });
        context.handle(COORDINATOR_CRYPTO_RPC_CAPABILITY, handleCoordinatorCryptoRpc);
        context.provide(VAULT_WALLET_STATE_CAPABILITY, createWalletStateAccess(
          workerWalletState, context.scope,
          (consumer, scope) => workerConsumers.get(consumer) === scope,
        ));
        context.provide(VAULT_WORKER_CRYPTO_CAPABILITY, Object.freeze({
          async createActiveKeyCrypto(owner: string) { context.scope.assertActive(); const crypto = await createWorkerActiveKeyCrypto(owner, context.scope); context.scope.assertActive(); return crypto; },
        }));
      }
      if (unit.productId === "woc") {
        const ownedWoc = testDomainUnitReadiness ? p2pkhWocService : initializeCoordinatorWocService();
        if (!ownedWoc) throw new Error("WOC Worker service has not been initialized");
        if (!testDomainUnitReadiness) context.scope.onRevoke(() => { ownedWoc.dispose(); if (p2pkhWocService === ownedWoc) p2pkhWocService = undefined; });
        const views = createWorkerWocViews(ownedWoc, () => context.scope.assertActive());
        context.scope.onRevoke(views.dispose);
        context.provide(WOC_CAPABILITY, views.query);
        context.provide(WOC_WORKER_BROADCAST_CAPABILITY, views.broadcast);
        if (!coordinatorDomainMessageBus) throw new Error("Worker message bus has not been initialized");
        context.provide(WOC_BSV21_CAPABILITY, createWocBsv21Service({ messageBus: coordinatorDomainMessageBus }));
        context.provide(WOC_STAS_CAPABILITY, createWocStasService({ messageBus: coordinatorDomainMessageBus }));
        context.provide(WOC_1SAT_ORDINALS_CAPABILITY, createWoc1SatOrdinalsService({ messageBus: coordinatorDomainMessageBus }));
        if (!testDomainUnitReadiness) {
          const cleanup = await installCoordinatorDomainTask(createCoordinatorChainHeightTask(ownedWoc), "woc", () => context.scope.assertActive());
          context.scope.onRevoke(cleanup);
        }
      }
      if (unit.productId === "p2pkh") {
        if (!testDomainUnitReadiness) {
          const ports = {
            storage: context.capability(STORAGE_FILE_CLIENTS_CAPABILITY).bind(context.consumer, context.scope, ""),
            walletState: context.capability(VAULT_WALLET_STATE_CAPABILITY).bind(context.consumer, context.scope),
            crypto: context.capability(VAULT_WORKER_CRYPTO_CAPABILITY),
            assertActive: () => context.scope.assertActive(),
          };
          p2pkhWorkerPorts = ports;
          context.scope.onRevoke(() => { if (p2pkhWorkerPorts === ports) { p2pkhWorkerPorts = undefined; workerTransferRuntime.release(); } });
          for (const id of ["p2pkh.transactions-sync", "p2pkh.utxo-snapshot"]) await coordinatorState.taskRuntimes.get(id)?.completion?.catch(() => undefined);
          context.scope.assertActive();
          const query = context.capability(WOC_CAPABILITY);
          p2pkhWorkerWocQuery = query;
          initializeCoordinatorP2pkhProviders(query, context.capability(WOC_WORKER_BROADCAST_CAPABILITY));
          const registry = p2pkhRegistry;
          const snapshots = p2pkhUtxoSnapshots;
          context.scope.onRevoke(() => {
            if (p2pkhRegistry === registry) p2pkhRegistry = undefined;
            if (p2pkhUtxoSnapshots === snapshots) { snapshots?.clearAll(); p2pkhUtxoSnapshots = undefined; }
            if (p2pkhWorkerWocQuery === query) { p2pkhWorkerWocQuery = undefined; p2pkhWorkerSettings.reset(); }
          });
        }
        context.provide(P2PKH_WORKER_TRANSFER_CAPABILITY, Object.freeze({
          async getService() {
            context.scope.assertActive();
            const service = await workerTransferRuntime.ensure();
            context.scope.assertActive();
            return Object.freeze({
              getGlobalSettings: () => { context.scope.assertActive(); return structuredClone(service.getGlobalSettings()); },
              async prepareTransfer(input: Parameters<P2pkhService["prepareTransfer"]>[0]) { context.scope.assertActive(); const preview = await service.prepareTransfer(input); context.scope.assertActive(); return preview; },
              async submitTransfer(preview: unknown) { context.scope.assertActive(); const result = await service.submitTransfer(preview as Parameters<P2pkhService["submitTransfer"]>[0]); context.scope.assertActive(); return result; },
            });
          },
        }));
        context.provide(P2PKH_ASSET_READER_CAPABILITY, createP2pkhWorkerAssetReader({ walletState: context.capability(VAULT_WALLET_STATE_CAPABILITY).bind(context.consumer, context.scope), storage: context.capability(STORAGE_FILE_CLIENTS_CAPABILITY).bind(context.consumer, context.scope, ""), snapshots: () => p2pkhUtxoSnapshots, includeTestnet: () => coordinatorMeta.p2pkhSettings?.includeTestnet === true }));
      }
      if (unit.productId === "p2pkh" && !testDomainUnitReadiness) {
        const cleanup = await installP2pkhCoordinatorTasks(context.capability(VAULT_WALLET_STATE_CAPABILITY).bind(context.consumer, context.scope), context.capability(WOC_CAPABILITY), () => context.scope.assertActive(), context.capability(STORAGE_FILE_CLIENTS_CAPABILITY).bind(context.consumer, context.scope, ""));
        context.scope.onRevoke(cleanup);
      }
      if (unit.productId === "contacts" && !testDomainUnitReadiness) {
        await installContactsCoordinatorService(context.capability(VAULT_WALLET_STATE_CAPABILITY).bind(context.consumer, context.scope), context.capability(STORAGE_FILE_CLIENTS_CAPABILITY).bind(context.consumer, context.scope, "address-book"), { status: () => context.capability(VAULT_WALLET_STATE_CAPABILITY).bind(context.consumer, context.scope).snapshot().status }, () => context.scope.assertActive(), cleanup => context.scope.onRevoke(cleanup), context.capability(CONTACTS_PRESENCE_CHANNEL_CAPABILITY));
      }
      if (!testDomainUnitReadiness && ["token-bsv21", "token-stas", "collectible-1satordinals"].includes(unit.productId)) {
        const walletState = context.capability(VAULT_WALLET_STATE_CAPABILITY).bind(context.consumer, context.scope);
        const p2pkh = context.capability(P2PKH_ASSET_READER_CAPABILITY);
        const vault = { status: () => walletState.snapshot().status };
        const notifier = { emit: (event: AssetDataInvalidationEvent) => publishTopicEvent("asset.data-changed", { type: "asset.data-changed", providerId: event.providerId, publicKeyHex: event.publicKeyHex ?? "", kinds: event.kinds }), subscribe: () => () => undefined };
        const task = unit.productId === "token-bsv21"
          ? createBsv21CoordinatorTask({ walletState, p2pkh, vault, stateStore: context.capability(STORAGE_KV_CLIENTS_CAPABILITY).bind(context.consumer, context.scope, "token-state"), woc: context.capability(WOC_BSV21_CAPABILITY), wocService: context.capability(WOC_CAPABILITY), notifier })
          : unit.productId === "token-stas"
          ? createStasCoordinatorTask({ walletState, p2pkh, vault, stateStore: context.capability(STORAGE_KV_CLIENTS_CAPABILITY).bind(context.consumer, context.scope, "token-state"), woc: context.capability(WOC_STAS_CAPABILITY), notifier })
          : createOrdinalsCoordinatorTask({ walletState, p2pkh, vault, woc: context.capability(WOC_1SAT_ORDINALS_CAPABILITY), wocService: context.capability(WOC_CAPABILITY), notifier });
        const cleanup = await installCoordinatorDomainTask(task, unit.productId, () => context.scope.assertActive());
        context.scope.onRevoke(cleanup);
      }
      if (unit.productId === "storage") {
        context.provide(STORAGE_FILE_CLIENTS_CAPABILITY, workerStorageClientCapabilities[0].value);
        context.provide(STORAGE_KV_CLIENTS_CAPABILITY, workerStorageClientCapabilities[1].value);
        context.handle(COORDINATOR_OWNER_STORAGE_RPC_CAPABILITY, handleCoordinatorOwnerStorageRpc);
        context.handle(COORDINATOR_PLATFORM_STORAGE_RPC_CAPABILITY, handleCoordinatorPlatformStorageRpc);
        context.scope.onRevoke(() => storageBrowseCoordinator.revokeAll());
        context.handlePrivate(STORAGE_PRIVATE_BROWSE_CAPABILITY, async (request, call) => {
          const state = requireCoordinatorSessionPeer(call);
          const full: StorageBrowsePrivateCommand = {
            ...request, clientId: state.peer.peerId, requestId: call.operationId ?? generateRequestId(),
          };
          const response = await processRequest(full, state.peer.peerId, call.signal);
          const { requestId: _requestId, ...result } = response;
          return parseStorageBrowsePrivateResponse(request, result);
        });
      }
      return () => stopCoordinatorWorkerUnit(ready.unitId, ready.instanceId);
    },
  });
});

/** Tests use these production setup definitions through the native Worker Host. */
export function __testCoordinatorRuntimePlugin(pluginId: string) {
  const plugin = coordinatorRuntimePlugins.find(plugin => plugin.manifest.id === pluginId);
  if (!plugin) throw new Error(`Worker plugin not found: ${pluginId}`);
  return plugin;
}

// Unit tests import this module in a normal Node realm. The installer above is
// a no-op when native WebCrypto exists and never enables a fallback unless the
// realm explicitly reports an insecure context.
if ((globalThis as unknown as { onconnect?: unknown }).onconnect !== undefined) {
// WebLoom 0.6.0 在这里创建 SharedWorker Host；它不负责跨 Worker 运行时
// 互斥。Keymaster 在初始化和最终 I/O 前使用自己的 origin 级 authority
// Web Lock；peer/session/lease/epoch/generation 继续负责页面会话与迟到结果。
coordinatorRuntimeApp = startSharedWorkerApp({
  id: "keymaster-coordinator",
  plugins: [coordinatorTransportPlugin, ...coordinatorRuntimePlugins],
  privateCapabilities: storagePrivateCapabilities(),
  expose: [
    COORDINATOR_RPC_CAPABILITY,
    COORDINATOR_TOPIC_STREAM_CAPABILITY,
  ],
  peerExposureAllowlist: [
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
});
let lastFrameworkReadyInstances = "";
coordinatorRuntimeApp.subscribe(state => {
  const readyInstances = state.units.filter(unit => unit.state === "enabled")
    .map(unit => `${unit.unitId}:${unit.instanceId}`).sort().join("|");
  if (readyInstances === lastFrameworkReadyInstances) return;
  lastFrameworkReadyInstances = readyInstances;
  synchronizeCoordinatorTaskUnitInstances();
  publishCoordinatorWorkerUnitSnapshot();
  scheduleCoordinatorRuntimeReconcile();
  for (const runtime of coordinatorState.taskRuntimes.values()) {
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
installSharedWorkerRetirement(
  coordinatorRuntimeApp,
  globalThis as unknown as Parameters<typeof installSharedWorkerRetirement>[1],
);
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
  if (skipStorageBootstrap && !platformRootStore) {
    throw storageUnavailableError("Storage root is unavailable during recovery");
  }
  if (!skipStorageBootstrap) {
    try {
      await bootstrapWalletStorage();
    } catch (error) {
      // IndexedDB 打不开、事务/配额失败或版本升级失败都属于 Storage 可用性
      // 问题：Vault 保持 booting，页面可重试；不升级成 Vault fatal，也不回退
      // 到 localStorage，更不自动清库。
      storageStartupFailure = true;
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
        const coldStart = storageColdStartState ?? await walletLifecycle?.coldStart();
        storageColdStartState = coldStart;
        switch (coldStart?.state) {
          case "ready":
            coordinatorState.walletGeneration = coldStart.meta?.walletGeneration ?? coordinatorState.walletGeneration;
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
      for (const runtime of coordinatorState.taskRuntimes.values()) {
        runtime.state = "blocked";
        runtime.blockedReason = "Vault is locked";
      }
    }
    storageStartupFailure = false;
    emitStorageState();
  } catch (error) {
    // Root 已建立后发生的 IndexedDB/事务/配额错误仍属于 Storage 可用性域；
    // Vault 保持 booting，等待 Storage 恢复编排，不得伪装成 fatal。
    if (isStorageFailure(error)) {
      storageStartupFailure = true;
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
  if (!platformRootStore) return;
  // 第三方 App 的 namespace 不在中央声明目录里：它的 moduleId 由验证身份派生，
  // 目录由平台登记的 name 决定。buildWalletStorageRoot 对 third-party-app 只使用
  // appStorageName，因此 moduleId 在这里只是一条不参与路径计算的稳定坐标。
  await platformRootStore.clearStorageRoot({
    declaration: THIRD_PARTY_APP_FILES_DECLARATION,
    appStorageName,
  });
}

/** 把生命周期事件翻译成跨 Tab 广播；具体状态提交仍由 Coordinator 完成。 */
function publishWalletLifecycleEvent(event: WalletLifecycleEvent): void {
  switch (event.type) {
    case "initialized":
      coordinatorState.walletGeneration = event.walletGeneration;
      storageColdStartState = undefined;
      break;
    case "unlocked":
      // adoptUnlockedKey 已经写好会话状态；这里只补广播所需的冷启动结论。
      storageColdStartState = undefined;
      break;
    case "locked":
      storageColdStartState = storageColdStartState?.state === "ready"
        ? { ...storageColdStartState }
        : storageColdStartState;
      break;
    case "reset":
      // 重置后回到未初始化：清掉冷启动结论，下一次判断重新读本地真值。
      coordinatorState.walletGeneration = "";
      storageColdStartState = undefined;
      break;
    case "renamed":
          break;
    case "password-changed":
    case "app-revoked":
      break;
    default:
      break;
  }
}

/**
 * 装配单钱包本地存储：IndexedDB -> 固定 KeyHold 仓储 -> 生命周期服务 -> 平台 Root。
 *
 * 这是本系统唯一的存储装配点：没有远程探测，也不列举 Key 目录。
 */
async function bootstrapWalletStorage(): Promise<void> {
  if (!walletStore) {
    walletStore = storageActivity.wrap(createIndexedDbWalletStore());
  }
  const vaultStorage = createVaultBootstrapStorage(walletStore);
  if (!walletKeys) {
    walletKeys = createWalletKeyRepository(vaultStorage.keys);
  }
  walletLifecycle = createWalletLifecycleService({
    store: vaultStorage.lifecycle,
    keys: walletKeys,
    generateWalletGeneration: () => crypto.randomUUID(),
    generateSessionEpoch: () => generateEpoch(),
    // `address` 只是兼容展示字段，不是身份真值；本 Worker 不在存储层派生
    // 地址，摘要会退回公钥 hex，业务插件需要时从 P2PKH resource 自行派生。
    deriveAddress: () => undefined,
    revokeGrants: revokeWalletGrants,
    establishSession: establishWalletSession,
    adoptUnlockedKey,
    publish: publishWalletLifecycleEvent,
    runGeneration: () => coordinatorState.runGeneration,
    currentSessionEpoch: () => coordinatorState.sessionEpoch,
    clearAppRoot: clearThirdPartyAppRoot,
  });
  // 冷启动只读 meta 与固定 KeyHold；这里不恢复任何运行态授权。
  storageColdStartState = await walletLifecycle.coldStart();
  if (storageColdStartState.state === "ready") {
    coordinatorState.walletGeneration = storageColdStartState.meta?.walletGeneration ?? coordinatorState.walletGeneration;
    await installPlatformStorage();
    return;
  }
  if (storageColdStartState.state === "corrupt" || storageColdStartState.state === "unsupported") {
    // 数据不可用时不装配可写 Root，避免任何路径覆盖仍可能可恢复的数据。
    throw new StorageRuntimeError(
      storageColdStartState.state === "corrupt" ? "storage_wallet_corrupt" : "storage_wallet_unsupported",
      storageColdStartState.reason ?? "Local wallet data is unusable",
    );
  }
  // uninitialized：没有 Root，也没有任何本地业务数据；等待创建或导入。
}

/**
 * 创建或导入唯一 Key，并完成解锁后的全部运行绑定。
 *
 * uninitialized 时本地没有 Root，因此这一步自己驱动完整装配顺序：
 *   lifecycle.initialize(plan) -> adoptUnlockedKey 写入会话状态
 *   -> 安装新钱包的 Root -> 读取 Coordinator meta -> 装配可写 runtime
 *   -> 注册任务 -> completeUnlockedBinding("initialize")
 *
 * lifecycle 只返回事务结果：只有 `ok: true` 才继续装配；失败路径保持
 * uninitialized，不装 Root、不发布 unlocked。
 */
async function initializeWallet(plan: WalletInitializePlan): Promise<WalletInitializeResult> {
  const lifecycle = requireWalletLifecycle();
  // 提交前必须确认本地确实还没有钱包；并发初始化由 lifecycle 的条件创建
  // 拒绝，这里只提前给出可行动的失败。
  const before = await lifecycle.coldStart();
  if (before.state !== "uninitialized") {
    if (before.state === "unsupported") {
      throw new StorageRuntimeError("storage_wallet_unsupported", "Local wallet schema is newer than this build");
    }
    if (before.state === "corrupt") {
      throw new StorageRuntimeError("storage_wallet_corrupt", "Wallet data is incomplete or damaged");
    }
    throw new StorageRuntimeError("storage_conflict", "This wallet already has a key");
  }

  const result = await lifecycle.initialize(plan);
  if (!result.ok) return result;

  // adoptUnlockedKey 已经写入 sessionEpoch、钱包世代与私钥副本。
  try {
    coordinatorState.walletGeneration = result.walletGeneration;
    storageColdStartState = undefined;
    await installPlatformStorage();
    await loadCoordinatorMeta();
    await ensureStorageRuntime();
    await ensureCoordinatorTasksRegistered();
    await completeUnlockedBinding("initialize");
  } catch (error) {
    // 装配失败不回滚已提交的 Key（那是事务真相），但会话必须 fail closed
    // 回 locked：页面看到的是「需要重新解锁」，而不是半装配的可用状态。
    await performGlobalLock("initialize-binding-failed").catch(() => undefined);
    throw error;
  }
  return result;
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

/**
 * 测试 Coordinator 的私信协议适配边界：业务 JSON 必须先转成
 * ChannelProtocol 的强类型 body，不能把旧 WebRTC envelope 原样下发。
 */
export function __testEncodeChannelPrivateBody(
  protocol: string,
  content: import("@keymaster/contracts").JSONValue
): import("bsv8-channel-protocol/inbox").UnsignedPrivateMessage["body"] {
  return privateBodyForPublish(protocol, content);
}

export function __testValidateChannelPrivateProtocol(
  caller: Extract<CoordinatorChannelOperation, { type: "private-publish" }>['caller'],
  protocol: string
): void {
  validatePrivateProtocolCaller(caller, privateProtocol(protocol));
}

/**
 * 用 Coordinator 的真实私密消息签名构造验证 fixture；用于确认协议 TTL
 * 在“构造 → 签名 → verifySignedPrivateMessage”链路中不会超过上限。
 */
export function __testSignChannelPrivateMessage(input: {
  recipientPublicKeyHex: string;
  protocol: string;
  content: import("@keymaster/contracts").JSONValue;
  messageId?: string;
  nowMs: number;
  privateKeyHex: string;
}): import("bsv8-channel-protocol/inbox").SignedPrivateMessage {
  const protocol = privateProtocol(input.protocol);
  return signPrivateMessageForFixture({
    recipientPublicKeyHex: input.recipientPublicKeyHex,
    protocol,
    body: privateBodyForPublish(protocol, input.content),
    messageId: input.messageId ?? newMessageID(),
    nowMs: input.nowMs,
    privateKeyHex: input.privateKeyHex
  });
}

export function __testGetSnapshot(): CoordinatorBootstrapSnapshot {
  return buildSnapshot();
}

/** 测试专用：观察卖方是否暂停自动锁，以及派生索引是否已释放。 */
export function __testGetMsfileSellerLifecycle(): {
  /** 自动锁截止时间；卖方启用时必须为空。 */
  autoLockDeadline?: number;
  /** 当前是否存在卖方索引。 */
  indexActive: boolean;
  /** 当前是否存在卖方匹配运行单元。 */
  runtimeActive: boolean;
} {
  return {
    ...(coordinatorState.autoLockDeadline === undefined ? {} : { autoLockDeadline: coordinatorState.autoLockDeadline }),
    indexActive: msfileBitfsRuntime.msfileSellerIndex !== undefined,
    runtimeActive: msfileBitfsRuntime.msfileSellerRuntime !== undefined,
  };
}

/** 测试专用：替换卖方协议端口与 stream transport；传 undefined 恢复生产实现。 */
export function __testSetMsfileSellerBridge(
  bridge: { transport: BitfsSellerStreamTransport; protocol: BitfsSellerProtocolPort } | undefined,
): void {
  msfileBitfsRuntime.testMsfileSellerBridge = bridge;
}

/** 测试专用：直接投递一条已验证 Hash 请求，验证 Worker 的卖方匹配接线。 */
export async function __testDispatchMsfileSellerHashRequest(
  request: import("bsv8-channel-protocol/hash-request").VerifiedHashRequest,
): Promise<void> {
  await handleMsfileSellerHashRequest(request);
}

/** 测试专用：观察当前唯一卖方会话数。 */
export function __testMsfileSellerSessionCount(): number {
  return msfileBitfsRuntime.msfileSellerSessionManager?.activeCount() ?? 0;
}

/** 测试专用：向当前 owner 的 `msfiles/` 根写入一个完整 Seed。 */
export async function __testMsfileStoreSeed(input: {
  /** 文件名。 */
  name: string;
  /** 媒体类型。 */
  mediaType: string;
  /** 文件字节。 */
  bytes: Uint8Array;
}): Promise<{ seedHashHex: string }> {
  const bytes = input.bytes.slice();
  const result = await storeMsFileSeed({
    store: createWorkerModuleFileStore("msfile", ""),
    source: {
      name: input.name,
      mediaType: input.mediaType,
      size: BigInt(bytes.byteLength),
      async *stream() { yield bytes; },
      async read(offset, length) { return bytes.slice(Number(offset), Number(offset) + length); },
    },
  });
  return { seedHashHex: result.entry.seedHashHex };
}

/** 测试专用：直接写入当前 owner `msfiles/` 根下的相对路径。 */
export async function __testMsfileOwnerStorageWrite(path: string, bytes: Uint8Array): Promise<void> {
  await createWorkerModuleFileStore("msfile", "").put(path, bytes);
}

/** 测试专用：删除当前 owner `msfiles/` 根下的相对路径。 */
export async function __testMsfileOwnerStorageDelete(path: string): Promise<void> {
  await createWorkerModuleFileStore("msfile", "").delete(path);
}

/** 测试专用：观测领域 owner handoff 对 WebLoom peer 的通知参数。 */
export function __testSetCoordinatorPeerHandoffNotifier(notifier: CoordinatorPeerHandoffNotifier | undefined): void {
  testCoordinatorPeerHandoffNotifier = notifier;
}

/** 测试专用：模拟另一个 Worker 让当前内存权威失效；不写业务 K-V。 */
export async function __testFenceCoordinatorAuthority(): Promise<void> {
  await ensureCoordinatorAuthorityClaim();
  if (!coordinatorAuthorityRecord) throw new Error("Coordinator authority is unavailable");
  coordinatorAuthorityRecord = {
    ...coordinatorAuthorityRecord,
    authorityInstanceId: "coordinator:external-test-fence",
    handoverGeneration: coordinatorAuthorityRecord.handoverGeneration + 1,
  };
}

/** 测试专用：持有一条最终 I/O 租约，模拟旧 Worker 崩溃前未完成的写入。 */
export async function __testHoldCoordinatorFinalIoLease(): Promise<() => Promise<void>> {
  await ensureCoordinatorUpgradeSession();
  const lease = await acquireCoordinatorFinalIoLease("write");
  return lease.release;
}

/** 测试专用：确认临时 I/O 计数没有在业务 K-V 创建版本。 */
export async function __testGetCoordinatorUpgradePartition(): Promise<{ revision: number; entryCount: number }> {
  // Coordinator upgrade/lease state is V1 memory-only. The old coordinator
  // K-V partition intentionally has no backing head, commits, or values.
  return { revision: 0, entryCount: 0 };
}

export function __testResetState(): void {
  testDomainUnitReadiness = true;
  stopCoordinatorKeyValueMaintenance();
  storageKeyValueMaintenance.clear();
  storageBrowseCoordinator.revokeAll();
  storageBrowseCoordinator.dropBinding();
  // Drop domain-owned resources before resetting the compatibility table. The
  // real WebLoom Host must then observe the booting/locked state and tear down
  // its old owner scopes before the next test unlocks a new owner.
  releaseMsfileRuntime("test-reset");
  testMsfileRuntimeOverride = undefined;
  coordinatorWorkerUnitRegistry.reset();
  if (storageController) {
    const storageUnit = coordinatorWorkerUnitRegistry.activate("storage.coordinator-worker");
    coordinatorWorkerUnitRegistry.ready(storageUnit.unitId, storageUnit.instanceId);
  }
  // 测试夹具模拟 Worker 重启：旧意图控制器和 authority 不能继续冒充新实例。
  closeCoordinatorUpgradeSession("Coordinator test Worker reset");
  const previousAuthorityLock = coordinatorAuthorityLock;
  coordinatorAuthorityLock = undefined;
  void previousAuthorityLock?.release().catch((error) => {
    console.warn("[coordinator] test authority lock release failed", error instanceof Error ? error.message : String(error));
  });
  coordinatorAuthorityInstanceId = makeCoordinatorAuthorityInstanceId();
  coordinatorAuthorityRecord = undefined;
  coordinatorAuthorityRecovery = undefined;
  coordinatorAuthorityRecoveryOperationNames = [];
  coordinatorHandoverGeneration = 0;
  // reset API 保持同步以兼容既有测试；真正的最终 I/O 会等待这条 claim
  // 完成，因此不会在新内存权威建立前执行业务操作。
  void scheduleCoordinatorAuthorityClaim().catch((error) => {
    console.warn("[coordinator] test authority claim failed", error instanceof Error ? error.message : String(error));
  });
  // 测试夹具也模拟一次 Root 重装；旧句柄不能跨“重启”复用同一个令牌。
  platformRootToken = {};
  storageStartupFailure = false;
  // releaseSatRuntime 会同步摘除旧 owner 的全局句柄，并把真实退订放入
  // satRuntimeRelease；下一次测试创建 runtime 时会等待该 Promise。
  void releaseSatRuntime("test");
  testPersistCoordinatorSnapshotFailure = false;
  testCoordinatorSnapshotMetrics.clear();
  testFailNextP2pkhSettingWrite = false;
  // 链高度是进程级公共状态：reset 必须清回「尚无可信读数」，
  // 否则上个用例的高度会泄漏进下一个用例的 baseline 断言。
  testChainHeightProvider = undefined;
  coordinatorChainHeight = emptyChainHeightSnapshot();
  chainHeightRevision = 0;
  cancelSmartSyncIdleTimer();
  backgroundWorkerRuntime.resetDebounce();
  for (const runtime of coordinatorState.taskRuntimes.values()) {
    runtime.controller?.abort();
    if (runtime.timer) clearTimeout(runtime.timer);
  }
  coordinatorState.sessionEpoch = generateEpoch();
  coordinatorState.vaultStatus = "booting";
  coordinatorState.activePublicKeyHex = undefined;
  dropActivePrivateKey();
  testHarnessActivationSecret = undefined;
  coordinatorState.taskRuntimes.clear();
  coordinatorState.autoLockDeadline = undefined;
  vaultAutoLock.pause();
  coordinatorState.lastActivityAt = Date.now();
  for (const state of coordinatorPeers.values()) {
    if (state.topicStream) closeCoordinatorTopicStreamQueue(state.topicStream);
  }
  coordinatorPeers.clear();
  storageIoOwner = undefined;
  coordinatorSessionCommitOrder = 0;
  coordinatorStorageIoHandoffRevision = 0;
  testCoordinatorPeerHandoffNotifier = undefined;
  coordinatorOpeningSession = undefined;
  coordinatorSessionOpenTail = Promise.resolve();
  revokedCoordinatorPeerIds.clear();
  coordinatorTestEventSinks.clear();
  for (const pending of channelRequests.values()) pending.controller.abort();
  channelRequests.clear();
  channelCallersByClient.clear();
  storageRequests.clear();
  storageGrants.clear();
  ownerStorageGrants.clear();
  platformStorageGrants.clear();
  workerStorageClients.invalidateAll();
  storagePortCounts.clear();
  storageDataQueue.resetForTests();
  msfileRequests.clear();
  msfileGrants.clear();
  msfileDataQueue.resetForTests();
  rejectWindowP2pExecutorBridgePending(windowP2pError("ERR_WORKER_RESTARTED", "Window P2P Coordinator runtime restarted"));
  // 测试接缝模拟整个 Worker 被销毁；真实 Worker 重启不会保留旧 Promise。
  activeSatInboundHandlers.clear();
  windowP2pBridgeBudget.reset(new Error("Worker fixture restarted"));
  msfileReadConcurrencySettings = { ...MSFILE_READ_CONCURRENCY_RECOMMENDED };
  windowP2pExecutorConfigVersion = 0;
  windowP2pExecutorConfigSignature = JSON.stringify(msfileReadConcurrencySettings);
  windowP2pExecutorConcurrencyConfig = buildWindowP2pConcurrencyConfig(msfileReadConcurrencySettings, windowP2pExecutorConfigVersion);
  windowP2pExecutorConfigSync?.reject(windowP2pError("ERR_WORKER_RESTARTED", "Window P2P Coordinator runtime restarted"));
  windowP2pExecutorConfigSync = undefined;
  msfileRuntime = undefined;
  msfileRuntimeStores = undefined;
  lastMsFileState = undefined;
  satIncomingHandlers.clear();
  channelProtocolRelations.clear();
  msfileBitfsRuntime.clearBuyerState();
  channelRevision = 0;
  coordinatorContactsPresenceOff?.();
  coordinatorContactsPresenceOff = undefined;
  coordinatorContactsService?.dispose?.();
  coordinatorContactsService = undefined;
  // 后台任务注册会重建 P2PKH 供应商注册表；重置时一并丢弃旧句柄，
  // 否则后续 ensureTestP2pkhProviders 会因为“注册表还在”而跳过重建，
  // 让 taskRuntimes 保持为空。
  p2pkhRegistry = undefined;
  p2pkhWocService = undefined;
  contactsPresenceRevision = 0;
  contactsPresenceProjection.reset();
  channelPublicSubscribers.clear();
  channelPrivateSubscribers.clear();
  channelSubscriptionStatusSubscribers.clear();
  channelSubscriptionMuxStatusOff?.();
  channelSubscriptionMuxStatusOff = undefined;
  testSatInboundResponseDispatcher = undefined;
  satRevision = 0;
  lastSatState = undefined;
  msfileBitfsRuntime.resetControlQueue();
  clearWindowP2pExecutorLeaseLocked();
  windowP2pExecutorIdentityTail = Promise.resolve();
  msfileBitfsRuntime.resetControlQueue();
  storageStateTail = Promise.resolve();
  storageMutationTail = Promise.resolve();
  storageController = testStorageRuntimeOverride;
  coordinatorRequestTail = Promise.resolve();
  testP2pkhBroadcastProvider = undefined;
  p2pkhUtxoSnapshots?.clearAll();
  workerWalletState.publish();
}

export function __testSetVaultStatus(status: CoordinatorVaultStatus, activePublicKeyHex?: string): void {
  coordinatorState.vaultStatus = status;
  coordinatorState.activePublicKeyHex = activePublicKeyHex;
  workerWalletState.publish();
}

export function __testSetP2pkhBroadcastProvider(provider: P2pkhTransactionBroadcastProvider | undefined): void {
  testP2pkhBroadcastProvider = provider;
}

/** 测试专用：替换快照 store 的 `unspent/all` 数据源。传 undefined 恢复真实 WoC。 */
export function __testSetP2pkhUnspentAllProvider(provider: ((network: "main" | "test", address: string) => Promise<WocUtxoResponse[]>) | undefined): void {
  testP2pkhUnspentAllProvider = provider;
}

/** 测试专用：缩短 Worker 内中心广播服务的重试预算。传 undefined 恢复生产默认值。 */
export function __testSetSatBroadcastRetryOverrides(input: { maxAttempts?: number; deadlineMs?: number; initialBackoffMs?: number; maxBackoffMs?: number } | undefined): void {
  testSatBroadcastRetryOverrides = input;
}

/** 测试专用：替换链高度读取源。传 undefined 恢复真实 WoC `/chain/info`。 */
export function __testSetChainHeightProvider(provider: ((network: BsvNetwork) => Promise<number>) | undefined): void {
  testChainHeightProvider = provider;
}

/** 测试专用：读取 Worker 内当前链高度快照。 */
export function __testGetChainHeight(): ChainHeightSnapshot {
  return { ...coordinatorChainHeight };
}

/**
 * 测试专用：把内存链高度读数清回「尚无可信读数」。
 *
 * 已解锁钱包注册任务时 INIT 会先同步一次高度；断言「禁用后入口阻塞」的用例
 * 需要一个干净的起点，但不能用 `__testResetState()`——那会连同平台 Root 一起
 * 丢掉，插件意图就再也落不了盘。
 */
export function __testResetChainHeight(): void {
  coordinatorChainHeight = emptyChainHeightSnapshot();
  chainHeightRevision = 0;
}

/** 测试专用：确认 BitFS 只消费统一同步的正确网络高度。 */
export function __testReadBitfsBlockHeight(network: BitfsNetwork): Promise<number> {
  return readCoordinatorBitfsBlockHeight(network);
}

/** 测试专用：装配真实 Coordinator 任务（含链高度同步），避免出网。 */
export async function __testRegisterRealCoordinatorTasks(): Promise<void> {
  await registerCoordinatorTasks();
}

/** 测试专用：取得 Worker 内 SatSubscription 使用的 P2PKH service。 */
export async function __testEnsureSatP2pkhService(): Promise<P2pkhService> {
  await ensureTestP2pkhProviders();
  return ensureSatP2pkhService();
}

/**
 * 测试专用：显式预热收款运行时。
 *
 * 这是「公开测试钩子」而不是判定逃生口——它只调用与生产完全相同的
 * `ensureSatRuntime`，可用来确定性表达「收款运行时已就绪 / 仍在预热」两个场景，
 * 不改变任何可用性判定结果。
 */
export async function __testEnsureSatRuntime(): Promise<void> {
  await ensureSatRuntime();
}

/** 测试专用：只释放收款运行时，用来制造「依赖掉线但 MSFile 仍在运行」。 */
export async function __testReleaseSatRuntime(): Promise<void> {
  await releaseSatRuntime("test");
}

/**
 * 测试专用：等待「依赖就绪后自动重跑卖方装配」那一次重判收敛。
 *
 * 收敛本身由订阅推式触发；这里只把在途的 Promise 交给测试 await，不引入轮询。
 */
export async function __testAwaitMsfileSellerDependencyResume(): Promise<void> {
  await msfileBitfsRuntime.msfileSellerDependencyResume?.catch(() => undefined);
  msfileBitfsRuntime.msfileSellerDependencyResume = undefined;
}

export function __testFailNextCoordinatorSnapshotPersist(): void {
  testPersistCoordinatorSnapshotFailure = true;
}

/** Test-only seams for the worker-owned P2PKH provider state machine. */
async function ensureTestP2pkhProviders(): Promise<void> {
  if (!p2pkhRegistry) await registerCoordinatorTasks();
}

export async function __testP2pkhProviderConfigUpdate(providerId: string, config: P2pkhProviderConfig): Promise<CoordinatorResponse> {
  await ensureTestP2pkhProviders();
  return handleP2pkhProviderConfigUpdate(`test-p2pkh-config-${Date.now()}`, {
    kind: "p2pkh.provider-config.update",
    clientId: "test",
    requestId: `test-p2pkh-config-${Date.now()}`,
    providerId,
    config,
    expectedSessionEpoch: coordinatorState.sessionEpoch
  });
}

export async function __testP2pkhProviderConfigGet(providerId: string): Promise<P2pkhProviderConfig> {
  await ensureTestP2pkhProviders();
  const response = await handleP2pkhProviderConfigGet(`test-p2pkh-config-get-${Date.now()}`, {
    kind: "p2pkh.provider-config.get",
    clientId: "test",
    requestId: `test-p2pkh-config-get-${Date.now()}`,
    providerId,
    expectedSessionEpoch: coordinatorState.sessionEpoch
  });
  return response.operationResult && typeof response.operationResult === "object" && !Array.isArray(response.operationResult)
    ? response.operationResult as P2pkhProviderConfig
    : {};
}

export async function __testSeedP2pkhLocalSubmission(input: { ownerPublicKeyHex: string; submission: unknown; claims?: unknown[] }): Promise<void> {
  const walletState = createWorkerWalletState();
  if (walletState.snapshot().activePublicKeyHex?.toLowerCase() !== input.ownerPublicKeyHex.toLowerCase()) throw new Error("P2PKH storage owner is not active");
  await satRuntimeRelease.catch(() => undefined);
  const repository = createP2pkhStateRepository(await openP2pkhStateRepository(createWorkerModuleFileStore("p2pkh", "")));
  await repository.prepareLocalSubmission({ submission: input.submission as never, claims: (input.claims ?? []) as never });
}

export async function __testFinishP2pkhLocalSubmission(input: { ownerPublicKeyHex: string; submissionId: string; localState: "local-confirmed" | "isolated" }): Promise<void> {
  const walletState = createWorkerWalletState();
  if (walletState.snapshot().activePublicKeyHex?.toLowerCase() !== input.ownerPublicKeyHex.toLowerCase()) throw new Error("P2PKH storage owner is not active");
  await satRuntimeRelease.catch(() => undefined);
  const repository = createP2pkhStateRepository(await openP2pkhStateRepository(createWorkerModuleFileStore("p2pkh", "")));
  await repository.finishLocalSubmission({ submissionId: input.submissionId, localState: input.localState });
}

export async function __testSetP2pkhChainResolution(input: { ownerPublicKeyHex: string; submissionId: string; chainResolution: "unresolved" | "chain-confirmed" }): Promise<void> {
  const walletState = createWorkerWalletState();
  if (walletState.snapshot().activePublicKeyHex?.toLowerCase() !== input.ownerPublicKeyHex.toLowerCase()) throw new Error("P2PKH storage owner is not active");
  await satRuntimeRelease.catch(() => undefined);
  const repository = createP2pkhStateRepository(await openP2pkhStateRepository(createWorkerModuleFileStore("p2pkh", "")));
  const row = (await repository.listLocalTransactions()).find((candidate) => candidate.id === input.submissionId);
  if (!row) throw new Error(`P2PKH submission not found: ${input.submissionId}`);
  const next = { ...row, chainResolution: input.chainResolution, ...(input.chainResolution === "chain-confirmed" ? { confirmedHistoryId: `${row.resourceId}:${row.txid}` } : { confirmedHistoryId: undefined }) };
  await repository.replaceLocalTransaction(next);
}

export async function __testListP2pkhLocalTransactions(ownerPublicKeyHex: string): Promise<unknown[]> {
  const walletState = createWorkerWalletState();
  if (walletState.snapshot().activePublicKeyHex?.toLowerCase() !== ownerPublicKeyHex.toLowerCase()) throw new Error("P2PKH storage owner is not active");
  await satRuntimeRelease.catch(() => undefined);
  const repository = createP2pkhStateRepository(await openP2pkhStateRepository(createWorkerModuleFileStore("p2pkh", "")));
  return repository.listLocalTransactions();
}

export async function __testListP2pkhLocalInputClaims(ownerPublicKeyHex: string): Promise<unknown[]> {
  const walletState = createWorkerWalletState();
  if (walletState.snapshot().activePublicKeyHex?.toLowerCase() !== ownerPublicKeyHex.toLowerCase()) throw new Error("P2PKH storage owner is not active");
  await satRuntimeRelease.catch(() => undefined);
  const repository = createP2pkhStateRepository(await openP2pkhStateRepository(createWorkerModuleFileStore("p2pkh", "")));
  return repository.listLocalInputClaims();
}

export async function __testP2pkhBroadcast(input: { ownerPublicKeyHex: string; network: "main" | "test"; submissionId: string; submission?: import("@keymaster/contracts").P2pkhBroadcastSubmission; expectedSessionEpoch?: SessionEpoch }): Promise<CoordinatorResponse> {
  await ensureTestP2pkhProviders();
  return handleP2pkhBroadcast(`test-p2pkh-broadcast-${Date.now()}`, {
    kind: "p2pkh.broadcast",
    clientId: "test",
    requestId: `test-p2pkh-broadcast-${Date.now()}`,
    ownerPublicKeyHex: input.ownerPublicKeyHex,
    network: input.network,
    submissionId: input.submissionId,
    ...(input.submission === undefined ? {} : { submission: input.submission }),
    expectedSessionEpoch: input.expectedSessionEpoch ?? coordinatorState.sessionEpoch
  });
}

export function __testGetConnectedPortCount(): number {
  return coordinatorTestEventSinks.size;
}

export function __testSetStorageSessionResolver(resolver: ((sessionId: string) => Promise<{ sessionId: string; origin: string; appIdentity: import("@keymaster/contracts").OwnerAppStorageGrant["appIdentity"]; revokedAt: number | null } | null>) | undefined): void {
  testStorageSessionResolver = resolver;
}

/** Minimal worker seams used by direct ownership/transport regression tests. */
export function __testSetStorageRuntime(runtime: Partial<StorageRuntimeController> | undefined): void {
  const previousUnit = coordinatorWorkerUnitRegistry.get("storage.coordinator-worker");
  testStorageRuntimeOverride = runtime as StorageRuntimeController | undefined;
  storageController = testStorageRuntimeOverride;
  if (runtime) {
    const unit = coordinatorWorkerUnitRegistry.activate("storage.coordinator-worker");
    coordinatorWorkerUnitRegistry.ready(unit.unitId, unit.instanceId);
    platformStorageReady = true;
    storageStartupFailure = false;
  }
  if (!runtime && previousUnit) stopCoordinatorWorkerUnit(previousUnit.unitId, previousUnit.instanceId);
}

export function __testSetStorageStartupFailure(enabled: boolean): void {
  testStorageStartupFailure = enabled;
  storageStartupFailure = enabled;
  if (enabled) {
    emitStorageState();
  } else {
    storageStartupFailure = false;
  }
  if (enabled) storageController = undefined;
}

export async function __testReleaseStorageRuntime(): Promise<void> {
  await releaseStorageRuntime("test-lock");
}

export async function __testStorageMutationBarrierProbe(): Promise<{ blockedBeforeRelease: boolean; completedAfterRelease: boolean }> {
  let release!: () => void;
  const previous = storageMutationTail;
  storageMutationTail = storageMutationTail.then(() => new Promise<void>((resolve) => { release = resolve; }));
  await previous;
  let completed = false;
  const run = executeStorageRequest({ kind: "storage.control", clientId: "test", requestId: crypto.randomUUID(), control: { type: "status" }, expectedSessionEpoch: coordinatorState.sessionEpoch }, "test").then(() => { completed = true; });
  await Promise.resolve();
  const blockedBeforeRelease = !completed;
  release();
  await run;
  storageMutationTail = Promise.resolve();
  return { blockedBeforeRelease, completedAfterRelease: completed };
}

export async function __testDispatchStorageGrant(connectSessionId: string, actualPortId: string, requestClientId = actualPortId): Promise<CoordinatorResponse> {
  return executeStorageRequest({ kind: "storage.grant", clientId: requestClientId, requestId: crypto.randomUUID(), connectSessionId, expectedSessionEpoch: coordinatorState.sessionEpoch }, actualPortId);
}

export async function __testResolveStorageGrant(grantId: string, actualPortId: string): Promise<import("@keymaster/contracts").OwnerAppStorageGrant> {
  return (await resolveStorageGrant(grantId, actualPortId)).context;
}

/** MSFile 测试接缝：会话解析与 RPC 分发。 */
export function __testSetMsfileRuntimeOverride(runtime: Partial<MsFileServiceImpl> | undefined): void {
  testMsfileRuntimeOverride = runtime as MsFileServiceImpl | undefined;
}

/** 测试专用：直接切换 Worker 数据面设置，验证队列不依赖真实 Window executor。 */
export function __testSetMsfileReadConcurrencySettings(settings: MsFileReadConcurrencySettings): void {
  const normalized = normalizeMsFileReadConcurrencySettings(settings);
  if (!normalized) throw new Error("invalid MSFile read concurrency settings");
  msfileReadConcurrencySettings = normalized;
  windowP2pExecutorConfigSignature = JSON.stringify(normalized);
  windowP2pExecutorConfigVersion += 1;
  windowP2pExecutorConcurrencyConfig = buildWindowP2pConcurrencyConfig(normalized, windowP2pExecutorConfigVersion);
  void syncWindowP2pExecutorConfig().catch(() => undefined);
  pumpMsfileDataWaiters();
}

export async function __testDispatchMsfileControl(control: CoordinatorMsFileControl): Promise<CoordinatorResponse> {
  return executeMsfileRequest({ kind: "msfile.control", clientId: "port-msfile", requestId: crypto.randomUUID(), control, expectedSessionEpoch: coordinatorState.sessionEpoch }, "port-msfile");
}

export async function __testDispatchMsfileGrant(
  input: { connectSessionId: string; transportOrigin: string; ownerPublicKeyHex: string; appIdentity: import("@keymaster/contracts").AppIdentitySnapshot },
  actualPortId = "port-msfile",
  expectedSessionEpoch: SessionEpoch = coordinatorState.sessionEpoch
): Promise<CoordinatorResponse> {
  return executeMsfileRequest({ kind: "msfile.grant", clientId: actualPortId, requestId: crypto.randomUUID(), context: { connectSessionId: input.connectSessionId, transportOrigin: input.transportOrigin, ownerPublicKeyHex: input.ownerPublicKeyHex, appIdentity: input.appIdentity }, expectedSessionEpoch }, actualPortId);
}

export async function __testDispatchMsfileData(data: CoordinatorMsFileData, actualPortId = "port-msfile"): Promise<CoordinatorResponse> {
  return executeMsfileRequest({ kind: "msfile.data", clientId: actualPortId, requestId: crypto.randomUUID(), data, expectedSessionEpoch: coordinatorState.sessionEpoch }, actualPortId);
}

export async function __testDispatchMsfileSessionAbort(connectSessionId: string, expectedSessionEpoch: SessionEpoch, actualPortId = "port-msfile"): Promise<CoordinatorResponse> {
  return executeMsfileRequest({ kind: "msfile.session.abort", clientId: actualPortId, requestId: crypto.randomUUID(), connectSessionId, expectedSessionEpoch }, actualPortId);
}

export async function __testDispatchMsfileControlWithEpoch(control: CoordinatorMsFileControl, expectedSessionEpoch: SessionEpoch, actualPortId = "port-msfile"): Promise<CoordinatorResponse> {
  return executeMsfileRequest({ kind: "msfile.control", clientId: actualPortId, requestId: crypto.randomUUID(), control, expectedSessionEpoch }, actualPortId);
}

export async function __testAcquireExecutorLease(ownerPublicKeyHex: string, clientId = "port-exec", expectedSessionEpoch: SessionEpoch = coordinatorState.sessionEpoch): Promise<CoordinatorResponse> {
  return processRequest({ kind: "window-p2p.executor.acquire", clientId, requestId: crypto.randomUUID(), ownerPublicKeyHex, expectedSessionEpoch }, clientId);
}

/** 测试 Worker bridge 的入站 Wire 预算；不启动真实 Host 或网络。 */
export function __testWindowP2pInboundBridgePressure(input: { attempts?: number; wireBytes?: number } = {}): {
  attempts: number;
  accepted: number;
  rejected: number;
  peakBytes: number;
  peakItems: number;
  releasedBytes: number;
  releasedItems: number;
} {
  const attempts = input.attempts ?? 64;
  const wireBytes = input.wireBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || !Number.isSafeInteger(wireBytes) || wireBytes < 1) {
    throw new RangeError("bridge pressure input must be positive safe integers");
  }
  const lease = windowP2pExecutorLease ?? {
    leaseId: "test-window-p2p-bridge-lease",
    sessionEpoch: "test-window-p2p-bridge-epoch",
    activePublicKeyHex: "02" + "11".repeat(32),
    clientId: "test-window-p2p-bridge",
    ownerPublicKeyHex: "02" + "11".repeat(32),
    acquiredAt: Date.now(),
    transportReady: true,
    transportConfigVersion: windowP2pExecutorConcurrencyConfig.version,
  } satisfies WindowP2pExecutorLeaseState;
  const acceptedEventIds: string[] = [];
  let accepted = 0;
  for (let index = 0; index < attempts; index += 1) {
    const eventId = `test-window-p2p-bridge-event-${index}`;
    const event = {
      type: "ssp.request" as const,
      eventId,
      wire: new Uint8Array(wireBytes),
      supplierId: "test-supplier",
      connectionId: "test-connection",
      ownerSessionEpoch: lease.sessionEpoch,
      supplierGeneration: 1,
    } satisfies SatWindowLaneSspRequestEvent;
    if (reserveWindowP2pExecutorInboundEvent(event, lease)) {
      accepted += 1;
      acceptedEventIds.push(eventId);
    }
  }
  const peakBytes = windowP2pBridgeBudget.snapshot().bytes;
  const peakItems = windowP2pBridgeBudget.snapshot().items;
  for (const eventId of acceptedEventIds) {
    releaseWindowP2pExecutorInboundEvent({ connectionId: "test-connection", eventId }, lease.leaseId);
  }
  return {
    attempts,
    accepted,
    rejected: attempts - accepted,
    peakBytes,
    peakItems,
    releasedBytes: windowP2pBridgeBudget.snapshot().bytes,
    releasedItems: windowP2pBridgeBudget.snapshot().items,
  };
}

/** 测试 SSP/SPI 小请求预留最大响应时，bridge 不会突破 32 MiB。 */
export async function __testWindowP2pResponseBridgePressure(input: { attempts?: number; requestBytes?: number } = {}): Promise<{
  attempts: number;
  requestBytes: number;
  accepted: number;
  queued: number;
  peakBytes: number;
  peakItems: number;
  releasedBytes: number;
  releasedItems: number;
}> {
  const attempts = input.attempts ?? 256;
  const requestBytes = input.requestBytes ?? 1;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || !Number.isSafeInteger(requestBytes) || requestBytes < 1 || requestBytes > MAX_WIRE_BYTES) {
    throw new RangeError("response bridge pressure input must be positive safe integers");
  }
  const operation = {
    type: "lane" as const,
    laneId: SAT_WINDOW_LANE_ID,
    operation: {
      type: "requestSsp" as const,
      supplierId: "test-supplier",
      connectionId: "test-connection",
      ownerSessionEpoch: "test-epoch",
      supplierGeneration: 1,
      wire: new Uint8Array(requestBytes),
    },
  } satisfies WindowP2pExecutorOperation;
  const reservedBytes = windowP2pExecutorBridgeBytesForOperation(operation);
  const controllers = Array.from({ length: attempts }, () => new AbortController());
  const reservations = controllers.map((controller) => reserveWindowP2pExecutorBridgeBytes(reservedBytes, controller.signal).then(() => undefined, () => undefined));
  await Promise.resolve();
  const accepted = windowP2pBridgeBudget.snapshot().items;
  const queued = windowP2pBridgeBudget.snapshot().queued;
  const peakBytes = windowP2pBridgeBudget.snapshot().bytes;
  const peakItems = accepted + queued;
  // 取消尚未准入的 waiter，再释放已经准入的操作，避免测试 helper 留下
  // 全局 bridge 状态或未处理 rejection 影响后续测试。
  for (const controller of controllers) controller.abort();
  for (let index = 0; index < accepted; index += 1) releaseWindowP2pExecutorBridgeBytes(reservedBytes);
  await Promise.all(reservations);
  return {
    attempts,
    requestBytes,
    accepted,
    queued,
    peakBytes,
    peakItems,
    releasedBytes: windowP2pBridgeBudget.snapshot().bytes,
    releasedItems: windowP2pBridgeBudget.snapshot().items,
  };
}

/**
 * 创建一个不依赖真实网络的 Worker 入站 handler 任务。
 * 这些测试接缝只用于验证取消、lease/generation 栅栏和资源上限；生产
 * 入站事件仍然只能从 Window executor 的 MessagePort 进入。
 */
export function __testStartSatInboundHandler(input: {
  leaseId?: string;
  eventId?: string;
  connectionId?: string;
  supplierId?: string;
  ownerSessionEpoch?: string;
  supplierGeneration?: number;
  wireBytes?: number;
  makeCurrent?: boolean;
  handler?: (wire: Uint8Array) => Promise<Uint8Array>;
} = {}): {
  accepted: boolean;
  leaseId: string;
  eventId: string;
  connectionId: string;
  signal?: AbortSignal;
  completion?: Promise<void>;
} {
  const leaseId = input.leaseId ?? `test-sat-inbound-lease-${crypto.randomUUID()}`;
  const eventId = input.eventId ?? `test-sat-inbound-event-${crypto.randomUUID()}`;
  const connectionId = input.connectionId ?? `test-sat-inbound-connection-${crypto.randomUUID()}`;
  const supplierId = input.supplierId ?? "test-sat-supplier";
  const ownerSessionEpoch = input.ownerSessionEpoch ?? "test-sat-inbound-epoch";
  const supplierGeneration = input.supplierGeneration ?? 1;
  const wireBytes = input.wireBytes ?? 1;
  if (!Number.isSafeInteger(supplierGeneration) || supplierGeneration < 1
    || !Number.isSafeInteger(wireBytes) || wireBytes < 1 || wireBytes > SAT_SUBSCRIPTION_RESOURCE_LIMITS.maxBridgeInFlightBytes) {
    throw new RangeError("invalid Sat inbound handler test input");
  }
  const lease = {
    leaseId,
    sessionEpoch: ownerSessionEpoch,
    activePublicKeyHex: "02" + "11".repeat(32),
    clientId: "test-sat-inbound",
    ownerPublicKeyHex: "02" + "11".repeat(32),
    acquiredAt: Date.now(),
    transportReady: true,
    transportConfigVersion: windowP2pExecutorConcurrencyConfig.version,
  } satisfies WindowP2pExecutorLeaseState;
  const event: SatWindowLaneSspRequestEvent = {
    type: "ssp.request",
    eventId,
    supplierId,
    connectionId,
    ownerSessionEpoch,
    supplierGeneration,
    wire: new Uint8Array(wireBytes),
  };
  if (!reserveWindowP2pExecutorInboundEvent(event, lease)) {
    return { accepted: false, leaseId, eventId, connectionId };
  }
  const task = beginSatInboundHandler(event, lease);
  if (!task) {
    releaseWindowP2pExecutorInboundEvent(event, lease.leaseId);
    return { accepted: false, leaseId, eventId, connectionId };
  }
  const registration = {
    supplierId,
    ownerSessionEpoch,
    supplierGeneration,
    handler: input.handler ?? (() => new Promise<Uint8Array>(() => undefined)),
  };
  satIncomingHandlers.set(connectionId, registration);
  if (input.makeCurrent) {
    windowP2pExecutorLease = lease;
    coordinatorState.sessionEpoch = ownerSessionEpoch;
    coordinatorState.vaultStatus = "unlocked";
    coordinatorState.activePublicKeyHex = lease.activePublicKeyHex;
  }
  const completion = handleSatWindowEvent(event, lease, task).finally(() => {
    if (satIncomingHandlers.get(connectionId) === registration) satIncomingHandlers.delete(connectionId);
  });
  return { accepted: true, leaseId, eventId, connectionId, signal: task.controller.signal, completion };
}

/** 测试单个 eventId + connectionId 的取消路径。 */
export function __testCancelSatInboundHandler(input: { leaseId: string; eventId: string; connectionId: string }): boolean {
  const task = activeSatInboundHandlers.get(`${input.leaseId}\u0000${input.connectionId}\u0000${input.eventId}`);
  if (!task) return false;
  cancelSatInboundHandler(task, "test cancellation");
  return true;
}

/** 测试 lease revoke；实际生产路径由 clearWindowP2pExecutorLeaseLocked 调用。 */
export function __testRevokeWindowP2pExecutorLease(): void {
  clearWindowP2pExecutorLeaseLocked();
}

/** 测试某个 Supplier generation 变更后的迟到结果栅栏。 */
export function __testChangeSatInboundGeneration(connectionId: string, supplierGeneration: number): boolean {
  const current = satIncomingHandlers.get(connectionId);
  if (!current) return false;
  satIncomingHandlers.set(connectionId, { ...current, supplierGeneration });
  return true;
}

export function __testSatInboundHandlerSnapshot(): {
  active: number;
  canceled: number;
  bridgeBytes: number;
  bridgeItems: number;
  maxActive: number;
} {
  return {
    active: activeSatInboundHandlers.size,
    canceled: [...activeSatInboundHandlers.values()].filter((task) => task.canceled).length,
    bridgeBytes: windowP2pBridgeBudget.snapshot().bytes,
    bridgeItems: windowP2pBridgeBudget.snapshot().items,
    maxActive: SAT_SUBSCRIPTION_RESOURCE_LIMITS.maxActiveWorkerInboundHandlers,
  };
}

export function __testSetSatInboundResponseDispatcher(dispatcher: ((operation: SatWindowLaneOperation, signal: AbortSignal) => Promise<unknown>) | undefined): void {
  testSatInboundResponseDispatcher = dispatcher;
}

/** 测试 sat.events 是 SharedWorker 的单一广播源，而不是每个 Tab 自建 runtime。 */
export function __testPublishSatState(event: import("@keymaster/contracts").CoordinatorSatEvent): void {
  emitSatState(event);
}

export async function __testReleaseExecutorLease(leaseId: string, clientId = "port-exec"): Promise<CoordinatorResponse> {
  return processRequest({ kind: "window-p2p.executor.release", clientId, requestId: crypto.randomUUID(), leaseId }, clientId);
}

export async function __testExecutorSignNoise(input: { leaseId: string; expectedSessionEpoch?: SessionEpoch; noiseStaticPublicKey: ArrayBuffer }, clientId = "port-exec"): Promise<CoordinatorResponse> {
  const request = { kind: "window-p2p.executor.identity.sign-noise" as const, clientId, requestId: crypto.randomUUID(), leaseId: input.leaseId, expectedSessionEpoch: input.expectedSessionEpoch ?? coordinatorState.sessionEpoch, noiseStaticPublicKey: input.noiseStaticPublicKey };
  return executeWindowP2pExecutorRequest(request, clientId);
}

export async function __testExecutorSignPeerRecord(input: { leaseId: string; expectedSessionEpoch?: SessionEpoch; peerId: string; addresses: string[]; sequence: string }, clientId = "port-exec"): Promise<CoordinatorResponse> {
  const request = { kind: "window-p2p.executor.identity.sign-peer-record" as const, clientId, requestId: crypto.randomUUID(), leaseId: input.leaseId, expectedSessionEpoch: input.expectedSessionEpoch ?? coordinatorState.sessionEpoch, peerId: input.peerId, addresses: input.addresses, sequence: input.sequence };
  return executeWindowP2pExecutorRequest(request, clientId);
}

export async function __testReleaseMsfileRuntime(): Promise<void> {
  releaseMsfileRuntime("test");
  testMsfileRuntimeOverride = undefined;
  await releaseSatRuntime("test");
}

export async function __testDispatchStorageData(input: { grantId: string; actualPortId: string; requestClientId?: string; connectSessionId?: string }): Promise<CoordinatorResponse> {
  const requestId = crypto.randomUUID();
  return executeStorageRequest({ kind: "storage.data", clientId: input.requestClientId ?? input.actualPortId, requestId, data: { type: "list", grantId: input.grantId, input: {} }, expectedSessionEpoch: coordinatorState.sessionEpoch }, input.actualPortId);
}

export async function __testDispatchStorageControl(control: CoordinatorStorageControl): Promise<CoordinatorResponse> {
  const request = { kind: "storage.control" as const, clientId: "test", requestId: crypto.randomUUID(), control, expectedSessionEpoch: coordinatorState.sessionEpoch };
  try {
    return await executeStorageRequest(request, "test");
  } finally {
    // 测试 seam 直接进入 executeStorageRequest，不经过生产
    // processRequestCore 的 finally；这里仍模拟 RPC 返回前的秘密清零。
    clearStorageRequestSecrets(request);
  }
}

/**
 * 测试：走真实 browse.open 分发入口。
 *
 * `actualPortId` 决定 Coordinator 从哪个 peer 上下文核验调用方；请求体本身没有任何
 * 身份字段，因此测试要证明的正是「换一个 peer 就换掉授权结论」。
 */
export async function __testDispatchStorageBrowseOpen(actualPortId: string): Promise<CoordinatorResponse> {
  const request = { kind: "storage.browse.open" as const, clientId: actualPortId, requestId: crypto.randomUUID(), expectedSessionEpoch: coordinatorState.sessionEpoch };
  try {
    return await executeStorageRequest(request, actualPortId);
  } finally {
    clearStorageRequestSecrets(request);
  }
}

/** 测试：已发放浏览授权是否仍被 Coordinator 认作受信任端口的授权。 */
export function __testHasStorageBrowseAuthorization(peerId: string): boolean {
  return storageBrowseCoordinator.hasClientAuthorization(peerId);
}

export function __testSeedStorageRequest(requestId: string, actualPortId: string, connectSessionId?: string): AbortSignal {
  const controller = new AbortController();
  storageRequests.set(storageRequestKey(actualPortId, requestId), { controller, clientId: actualPortId, connectSessionId });
  return controller.signal;
}

export async function __testDispatchStorageCancel(targetRequestId: string, actualPortId: string): Promise<CoordinatorResponse> {
  return executeStorageRequest({ kind: "storage.cancel", clientId: actualPortId, requestId: crypto.randomUUID(), targetRequestId }, actualPortId);
}

export async function __testDispatchStorageAbort(connectSessionId: string, actualPortId: string): Promise<CoordinatorResponse> {
  return executeStorageRequest({ kind: "storage.session.abort", clientId: actualPortId, requestId: crypto.randomUUID(), connectSessionId, expectedSessionEpoch: coordinatorState.sessionEpoch }, actualPortId);
}

export function __testStorageQueueAdmission(portId: string): { firstPortAccepted: number; firstPortRejected: boolean; secondPortAccepted: boolean; remaining: Record<string, number> } {
  let firstPortAccepted = 0;
  while (reserveStoragePortSlot(portId)) firstPortAccepted++;
  const firstPortRejected = !reserveStoragePortSlot(portId);
  const secondPortAccepted = reserveStoragePortSlot(`${portId}-other`);
  for (let i = 0; i < firstPortAccepted; i++) releaseStoragePortSlot(portId);
  if (secondPortAccepted) releaseStoragePortSlot(`${portId}-other`);
  return { firstPortAccepted, firstPortRejected, secondPortAccepted, remaining: Object.fromEntries(storagePortCounts) };
}

export async function __testPublishStorageState(): Promise<void> {
  emitStorageState();
  await storageStateTail;
}

export async function __testStorageFairDispatch(): Promise<string[]> {
  const order: string[] = [];
  const releases = new Map<string, () => void>();
  const run = (portId: string, label: string) => withStorageDataSlot(portId, () => new Promise<void>((resolve) => { order.push(label); releases.set(label, resolve); }));
  const active = [run("port-a", "a1"), run("port-a", "a2"), run("port-a", "a3")];
  const queuedA = run("port-a", "a4");
  const queuedB = run("port-b", "b1");
  await new Promise((resolve) => setTimeout(resolve, 0));
  releases.get("a1")?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  releases.get("b1")?.(); releases.get("a2")?.(); releases.get("a3")?.(); releases.get("a4")?.();
  await Promise.all([...active, queuedA, queuedB]);
  return order;
}

export function __testStorageTransfer(bytes: ArrayBuffer): { inputDetachedByteLength: number; detachedByteLength: number; receivedByteLength: number; transferCount: number } {
  const inputClone = structuredClone({ data: { content: { bytes } } }, { transfer: [bytes] });
  const inputDetachedByteLength = bytes.byteLength;
  let receivedByteLength = -1;
  let transferCount = 0;
  const port = { postMessage(message: unknown, transfer: ArrayBuffer[] = []) {
    transferCount = transfer.length;
    const cloned = structuredClone(message, { transfer });
    receivedByteLength = ((cloned as { operationResult?: { content?: { bytes?: ArrayBuffer } } }).operationResult?.content?.bytes)?.byteLength ?? -1;
  } } as unknown as MessagePort;
  const responseBytes = (inputClone.data as { content: { bytes: ArrayBuffer } }).content.bytes;
  try { port.postMessage({ operationResult: { content: { bytes: responseBytes } } }, [responseBytes]); } catch { /* the test fake records post failures */ }
  return { inputDetachedByteLength, detachedByteLength: responseBytes.byteLength, receivedByteLength, transferCount };
}

export function __testAttachPort(clientId: string, postMessage: (message: unknown, transfer?: ArrayBuffer[]) => void): void {
  revokedCoordinatorPeerIds.delete(clientId);
  coordinatorTestEventSinks.set(clientId, { postMessage, topics: new Set() });
}

/**
 * 测试专用的 Coordinator peer harness。它只建立已经提交的 session
 * binding，不绕过 requestLocalStorageBridge 的 pending/drain 路径。
 */
export function __testInstallCoordinatorBridgePeer(
  peer: Pick<PeerController, "peerId" | "scope">,
  binding: CoordinatorSessionBinding,
): void {
  configureCoordinatorPeer(peer as PeerController);
  const state = coordinatorPeerState(peer.peerId);
  if (!state) throw new Error("Coordinator test peer was not registered");
  state.sessionGeneration = binding.peerGeneration;
  state.status = "open";
  state.sessionOpen = true;
  state.sessionBinding = { ...binding };
  state.openCommitOrder = ++coordinatorSessionCommitOrder;
  storageIoOwner = {
    ...binding,
    peerId: peer.peerId,
    commitOrder: ++coordinatorStorageIoHandoffRevision,
  };
}

/**
 * 测试专用：通过真实 Coordinator RPC handler 执行 session.open/close。
 * 首次调用仍走 configureCoordinatorPeer；后续调用复用同一 peer state，
 * 因而可以覆盖真实的 lease replacement、exact-binding close 和 fence。
 * 不向生产 transport 暴露第二条路由，也不改变 handler 的业务行为。
 */
export async function __testHandleCoordinatorSessionRpc(
  peer: Pick<PeerController, "peerId" | "scope" | "capability" | "exposeGroup">,
  request: CoordinatorSessionOpenRequest | CoordinatorSessionCloseRequest,
  signal: AbortSignal = new AbortController().signal,
  options: { waitForDrain?: boolean } = {},
): Promise<CoordinatorRpcResponse> {
  const existing = coordinatorPeerState(peer.peerId);
  if (!existing) configureCoordinatorPeer(peer as PeerController);
  else if (existing.peer !== peer) throw new Error("Coordinator test peer instance was replaced");
  // 避免测试接缝触发真实外部初始化；handler 仍会执行 recovery-list
  // bridge 与完整 session.open 提交。调用完成后恢复原始 single-flight。
  const previousInitialization = coordinatorInitialization;
  if (request.kind === "session.open") coordinatorInitialization = Promise.resolve();
  try {
    const response = await handleCoordinatorRpc(request, {
      signal,
      deadlineAt: Date.now() + 60_000,
      operationId: `test-session-${peer.peerId}-${Date.now()}`,
      reference: {} as HandlerCallContext["reference"],
      origin: "remote",
      peer: { peerId: peer.peerId } as HandlerCallContext["peer"],
    });
    if (request.kind === "session.close" && options.waitForDrain) {
      await coordinatorPeerState(peer.peerId)?.drainPromise;
    }
    return response;
  } finally {
    if (request.kind === "session.open") coordinatorInitialization = previousInitialization;
  }
}

/** 测试专用：等待真实 close handler 发起的 bridge drain 完成。 */
export async function __testAwaitCoordinatorPeerDrain(peerId: string): Promise<void> {
  await coordinatorPeerState(peerId)?.drainPromise;
}

/** 测试专用：执行 session close 并等待 Worker 的 bridge drain。 */
export async function __testCloseCoordinatorBridgePeer(
  peerId: string,
  binding: CoordinatorSessionBinding,
): Promise<void> {
  const state = coordinatorPeerState(peerId);
  if (!state) return;
  coordinatorSessionClosed(peerId, binding);
  await state.drainPromise;
}

/** Domain fixture: hold a normal request without starting network I/O. */
export function __testHoldCoordinatorFifo(): () => void {
  const previous = coordinatorRequestTail;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  coordinatorRequestTail = previous.then(() => held);
  return release;
}

export async function __testDispatchStorageMessage(clientId: string, request: CoordinatorClientRequest): Promise<void> {
  const sink = coordinatorTestEventSinks.get(clientId);
  if (!sink) return;
  if (request.kind === "subscribe") {
    sink.topics.clear();
    for (const topic of request.topics) sink.topics.add(topic);
    const baselines = await buildTopicBaselines({ topics: request.topics });
    sink.postMessage({
      requestId: request.requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "ok" },
      operationResult: { topics: request.topics, baselines } satisfies CoordinatorSubscribeTopicsResult,
    });
    return;
  }
  if (request.kind === "activity") {
    handleActivity();
    return;
  }
  if (request.kind === "disconnect") {
    revokedCoordinatorPeerIds.add(clientId);
    for (const pending of storageRequests.values()) if (pending.clientId === clientId) pending.controller.abort();
    for (const pending of channelRequests.values()) if (pending.clientId === clientId) pending.controller.abort();
    for (const pending of msfileRequests.values()) if (pending.clientId === clientId) pending.controller.abort();
    for (const pending of windowP2pExecutorIdentityRequests.values()) if (pending.clientId === clientId) pending.controller.abort();
    for (const [grantId, grant] of storageGrants) if (grant.clientId === clientId) storageGrants.delete(grantId);
    for (const [grantId, grant] of ownerStorageGrants) if (grant.clientId === clientId) ownerStorageGrants.delete(grantId);
    // 浏览句柄绑定端口：断开即作废，不能留给重连后的页面继续用。
    storageBrowseCoordinator.revokeClient(clientId);
    for (const [grantId, grant] of platformStorageGrants) if (grant.clientId === clientId) platformStorageGrants.delete(grantId);
    for (const [grantId, grant] of msfileGrants) if (grant.clientId === clientId) msfileGrants.delete(grantId);
    coordinatorTestEventSinks.delete(clientId);
    return;
  }
  const response = await processRequest(request, clientId);
  sink.postMessage(response);
}

export function __testStorageQueueSnapshot(): { globalActive: number; queued: number; perPort: Record<string, number> } {
  return { globalActive: storageDataQueue.snapshot().active, queued: storageDataQueue.snapshot().queued, perPort: Object.fromEntries(storagePortCounts) };
}

/** Deterministically exercise queue-full and both cancellation paths. */
export async function __testStorageSlotErrorCodes(): Promise<{ queueFull: string; queuedAbort: string; activeAbort: string }> {
  __testResetState();
  const releases: Array<() => void> = [];
  const active = [0, 1, 2].map(() => withStorageDataSlot("slot-test", () => new Promise<void>((resolve) => releases.push(resolve))));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const queuedController = new AbortController();
  const queued = withStorageDataSlot("slot-test", async () => undefined, queuedController.signal).then(() => "missing", (error) => (error as { code?: string }).code ?? "missing");
  queuedController.abort();
  const waiting = Array.from({ length: STORAGE_DATA_MAX_QUEUE }, () => withStorageDataSlot("slot-test", async () => undefined));
  const queueFull = await withStorageDataSlot("slot-test", async () => undefined).then(() => "missing", (error) => (error as { code?: string }).code ?? "missing");
  const queuedAbort = await queued;
  releases.forEach((release) => release());
  await Promise.all([...active, ...waiting]);
  const activeController = new AbortController();
  let releaseActive!: () => void;
  const running = withStorageDataSlot("slot-active", () => new Promise<void>((resolve) => { releaseActive = resolve; }), activeController.signal).then(() => "missing", (error) => (error as { code?: string }).code ?? "missing");
  await new Promise((resolve) => setTimeout(resolve, 0));
  activeController.abort();
  const activeAbort = await running;
  releaseActive?.();
  return { queueFull, queuedAbort, activeAbort };
}

/**
 * 测试专用：四个忽略 AbortSignal 的物理操作被取消后仍占用 slot；第五个
 * 操作必须等真实 Provider Promise settle 后才能启动。
 */
export async function __testStorageCancelKeepsPhysicalSlots(): Promise<{
  activeAfterCancel: number;
  queuedAfterCancel: number;
  fifthStartedAfterCancel: boolean;
  activeDuringFifth: number;
  fifthStartedAfterPhysicalRelease: boolean;
  finalActive: number;
}> {
  __testResetState();
  const controllers = Array.from({ length: STORAGE_DATA_CONCURRENCY }, () => new AbortController());
  const releases: Array<() => void> = [];
  const canceledRpc = controllers.map((controller, index) => withStorageDataSlot(
    `slot-cancel-${index}`,
    () => new Promise<void>((resolve) => { releases.push(resolve); }),
    controller.signal
  ).catch(() => undefined));
  await new Promise((resolve) => setTimeout(resolve, 0));
  controllers.forEach((controller) => controller.abort());
  await Promise.all(canceledRpc);

  let fifthStarted = false;
  let releaseFifth!: () => void;
  const fifth = withStorageDataSlot("slot-cancel-fifth", () => new Promise<void>((resolve) => {
    fifthStarted = true;
    releaseFifth = resolve;
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const afterCancel = __testStorageQueueSnapshot();
  releases.forEach((release) => release());
  for (let i = 0; i < 3 && !fifthStarted; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  const afterPhysicalRelease = __testStorageQueueSnapshot();
  releaseFifth();
  await fifth;
  return {
    activeAfterCancel: afterCancel.globalActive,
    queuedAfterCancel: afterCancel.queued,
    fifthStartedAfterCancel: fifthStarted && afterCancel.globalActive < STORAGE_DATA_CONCURRENCY,
    activeDuringFifth: afterPhysicalRelease.globalActive,
    fifthStartedAfterPhysicalRelease: fifthStarted,
    finalActive: __testStorageQueueSnapshot().globalActive
  };
}

/** 调度单测显式装配依赖单元；不会替代生产服务装配或框架边界验收。 */
export function __testReadyWorkerUnit(unitId: string): void {
  const descriptor = COORDINATOR_WORKER_UNIT_CATALOG.find(candidate => candidate.unitId === unitId);
  const unit = descriptor?.scopeKind === "root" || descriptor?.scopeKind === "storage"
    ? coordinatorWorkerUnitRegistry.activate(unitId)
    : activateCoordinatorOwnerWorkerUnit(unitId);
  coordinatorWorkerUnitRegistry.ready(unitId, unit.instanceId);
}

export function __testRegisterTask(input: {
  id: string;
  /** 测试任务所属产品；已登记的真实任务省略时从 Worker 单元目录推导。 */
  pluginId?: string;
  /** 测试任务所属运行单元；省略时按产品生成 coordinator-worker 单元。 */
  unitId?: string;
  publicKeyHex: string;
  keyScope?: { publicKeyHex: string } | (() => { publicKeyHex: string } | undefined);
  /** 同步策略；省略时为 fixed（不读取同步管理设置、不参与智能调度）。 */
  syncPolicy?: "managed" | "smart" | "fixed";
  intervalMs?: number;
  run(context: { signal: AbortSignal; assertSessionFresh(): void }): Promise<void>;
}): void {
  const pluginId = input.pluginId ?? getCoordinatorWorkerUnitForTask(input.id)?.productId ?? "test";
  coordinatorState.taskRuntimes.set(input.id, createCoordinatorTaskRuntime({
    id: input.id,
    pluginId,
    unitId: input.unitId,
    allowUncataloguedForTest: true,
    syncPolicy: input.syncPolicy,
    intervalMs: input.intervalMs,
    keyScope: input.keyScope ?? { publicKeyHex: input.publicKeyHex },
    run: input.run
  }));
}

export async function __testRunTask(taskId: string): Promise<void> {
  await executeTask(taskId, "test");
}

export async function __testCancelByKey(publicKeyHex: string): Promise<boolean> {
  return cancelTaskRuntimesByKey(publicKeyHex);
}

export function __testInvalidateSession(): void {
  coordinatorState.sessionEpoch = generateEpoch();
  workerWalletState.publish();
}

/**
 * 测试专用：推进钱包身份世代，等价于 reset 后重新初始化（或重新导入同一把
 * 私钥）。这正是 `docs/存储.md` 要求的不变量：重置前的迟到结果不能写入
 * 重新创建的钱包，即使导入的是同一把私钥。
 *
 * 只推进世代而不动 Root：栅栏必须由绑定栅栏本身拒绝迟到结果，而不是靠
 * Root 被销毁这种副作用。
 */
export function __testAdvanceWalletGeneration(): void {
  coordinatorState.walletGeneration = `test-wallet-generation-${crypto.randomUUID()}`;
  workerWalletState.publish();
}

export async function __testBackgroundRunNow(taskId: string): Promise<CoordinatorResponse> {
  return handleBackgroundRunNow(`test-${Date.now()}`, { kind: "background.run-now", taskId, expectedSessionEpoch: coordinatorState.sessionEpoch });
}

export async function __testUpdateScheduleSettings(settings: CoordinatorBackgroundSyncSettings): Promise<CoordinatorResponse> {
  return handleBackgroundSettingsUpdate(`test-${Date.now()}`, { kind: "background.settings.update", settings, expectedSessionEpoch: coordinatorState.sessionEpoch });
}

export async function __testUpdateAutolockSettings(settings: { timeoutMs: number }): Promise<CoordinatorResponse> {
  return handleAutolockSettingsUpdate(`test-${Date.now()}`, { kind: "autolock.settings.update", settings, expectedSessionEpoch: coordinatorState.sessionEpoch });
}

export function __testGetAutolockTimeoutMs(): number {
  return coordinatorMeta.autoLockTimeoutMs ?? AUTO_LOCK_DEFAULT_TIMEOUT_MS;
}

/** 测试专用：调整智能调度 2 秒计时，避免测试等待真实时长。 */
export function __testSetSmartSyncDebounceMs(ms: number): void {
  backgroundWorkerRuntime.setDebounce(ms);
}

/** 测试专用：模拟 WoC 队列事件，驱动智能调度计时。 */
export function __testNotifyWocQueueChange(snapshot: WocQueueSnapshot): void {
  onWocQueueChanged(snapshot);
}

/** 测试专用：读取智能调度计时状态。 */
export function __testSmartSyncState(): { pending: boolean; debounceMs: number } {
  return backgroundWorkerRuntime.smartState();
}

/** 测试专用：模拟解锁 / 初始化后的立即同步。 */
export function __testTriggerImmediateSync(reason = "unlock"): void {
  triggerImmediateSync(reason);
}

/** 测试专用：按生产冷启动顺序从当前 Root 的三个固定对象重载公开 metadata。 */
export async function __testReloadCoordinatorMeta(): Promise<void> {
  await loadCoordinatorMeta();
}

/** 测试专用：写入一份原始 settings 快照，用来构造旧格式兼容路径。 */
export async function __testSeedCoordinatorSettingsSnapshot(settings: unknown): Promise<void> {
  await persistCoordinatorSettings(structuredClone(settings) as CoordinatorSettingsSnapshot);
}

export function __testCoordinatorSnapshotMetrics(): Record<"settings", { revision: number; writes: number }> {
  return {
    settings: snapshotWriteMetrics("coordinator.settings.persist"),
  };
}

export async function __testRestartWorker(): Promise<void> {
  __testResetState();
  await ensureCoordinatorAuthorityClaim();
  // reset 只清内存里的 Root 指针，没有关闭上一代快照句柄；直接读取会撞上
  // isCurrent 栅栏。重启语义要求旧句柄全部作废并从本地真值重新安装。
  discardCurrentPlatformStorageBinding();
  if (walletStore) {
    const coldStart = await walletLifecycle?.coldStart();
    if (coldStart?.state === "ready") await installPlatformStorage();
  }
  await loadCoordinatorMeta();
  // 冷启动状态只由 meta 与固定 KeyHold 决定：ready = locked,uninitialized =
  // 还没有 Key；corrupt/unsupported 不得静默变成空钱包。
  const coldStart = await walletLifecycle?.coldStart();
  coordinatorState.vaultStatus = coldStart?.state === "ready"
    ? "locked"
    : coldStart?.state === "uninitialized" ? "uninitialized" : "fatal";
  coordinatorState.activePublicKeyHex = undefined;
  dropActivePrivateKey();
}

/** 测试专用：清空一个中央 namespace，不连接浏览器持久化 API。 */
export async function __testClearCentralNamespace(moduleId: string): Promise<void> {
  if (!platformRootStore) throw new Error("Test platform storage is not ready");
  const normalizedModuleId = moduleId.toLowerCase();
  const declarations = Object.values(CENTRAL_STORAGE_DECLARATIONS).filter(
    (candidate) => candidate.moduleId === normalizedModuleId,
  );
  if (declarations.length === 0) throw new Error(`Unknown central module: ${moduleId}`);
  for (const declaration of declarations) {
    if (declaration.model !== "kv") continue;
    const store = await platformRootStore.openPlatformStore({ declaration });
    for (const partition of ["default", "settings", "suppliers", "policies", "usages"]) {
      for (;;) {
        const page = await store.list({ partition, limit: 1000 });
        if (page.entries.length === 0) break;
        await store.commit({
          partition,
          ifRevision: page.revision,
          operations: page.entries.map((entry) => ({ type: "delete" as const, key: entry.key }))
        });
      }
    }
  }
}

/** 为 Storage rotation 测试生成当前 Vault 可解开的 local secret。 */
export async function __testSealLocalSecret(scope: string, plaintext: string): Promise<VaultSealedSecret> {
  const bytes = new TextEncoder().encode(plaintext);
  return await executeVaultOperation({ type: "sealLocalSecret", scope, plaintext: bytes }) as VaultSealedSecret;
}

/** 测试专用：直接通过一个 Worker owner 文件 handle 验证当前 owner 可写。 */
export async function __testOwnerStoragePut(path: string, bytes: Uint8Array): Promise<void> {
  const store = createWorkerModuleFileStore("p2pkh", "");
  await store.put(path, bytes);
}


/** 解锁 Vault。 */
export async function __testUnlock(password: string): Promise<CoordinatorResponse> {
  const response = await processRequest({ kind: "unlock", password, requestId: `test-unlock-${Date.now()}`, clientId: "test", expectedSessionEpoch: coordinatorState.sessionEpoch });
  if (response.ack.status === "accepted" || response.ack.status === "already-unlocked") testHarnessActivationSecret = password;
  return response;
}

/** 修改 Vault 密码。 */
export async function __testChangePassword(oldPassword: string, newPassword: string): Promise<unknown> {
  return executeVaultOperation({ type: "changePassword", oldPassword, newPassword });
}

/** 锁定 Vault。 */
export async function __testLock(): Promise<CoordinatorResponse> {
  return processRequest({ kind: "lock", requestId: `test-lock-${Date.now()}`, clientId: "test", expectedSessionEpoch: coordinatorState.sessionEpoch });
}

/** 获取 Vault 状态。 */
export function __testGetVaultStatus(): CoordinatorVaultStatus {
  return coordinatorState.vaultStatus;
}

/** 获取 active key。 */
export function __testGetActivePublicKeyHex(): string | undefined {
  return coordinatorState.activePublicKeyHex;
}

/**
 * 测试专用：以生产顺序装配单钱包本地存储（冷启动 -> Root -> runtime/任务）。
 *
 * 单元测试必须走真实 IndexedDB 与真实生命周期服务，才能覆盖「未初始化不装
 * Root」「locked 门禁下仍装 runtime」这类冷启动断言。返回冷启动快照，让测试
 * 能区分「无钱包」与「钱包数据不可用」。
 */
export async function __testBootstrapWalletStorage(): Promise<WalletColdStartSnapshot> {
  await ensureCoordinatorAuthorityClaim();
  await bootstrapWalletStorage();
  const coldStart = storageColdStartState ?? await walletLifecycle?.coldStart();
  coordinatorState.walletGeneration = coldStart?.state === "ready"
    ? coldStart.meta?.walletGeneration ?? ""
    : "";
  if (coldStart?.state === "ready") {
    // 已解锁的会话不能被幂等 bootstrap 顺带锁掉：调用方按需重复 bootstrap
    // 是正常用法（例如先冷启动、再导入第二把 Key 观察拒绝路径），被拒绝的
    // 请求不得留下「会话已撤销」的副作用。这里只在没有活动身份时回到锁定
    // 投影，保持与生产冷启动一致的 fail closed 默认值。
    if (coordinatorState.vaultStatus !== "unlocked") {
      coordinatorState.vaultStatus = "locked";
      coordinatorState.activePublicKeyHex = undefined;
    }
    await ensureStorageRuntime();
    await ensureCoordinatorTasksRegistered();
    for (const runtime of coordinatorState.taskRuntimes.values()) {
      runtime.state = "blocked";
      runtime.blockedReason = "Vault is locked";
    }
  } else if (coldStart?.state === "uninitialized") {
    coordinatorState.walletGeneration = "";
    coordinatorState.vaultStatus = "uninitialized";
  }
  storageStartupFailure = false;
  emitStorageState();
  return coldStart ?? { state: "uninitialized" };
}

/** 测试专用：读取当前冷启动结论；uninitialized 时也能在没有 Root 的情况下回答。 */
export async function __testColdStart(): Promise<WalletColdStartSnapshot> {
  return await (walletLifecycle ?? requireWalletLifecycle()).coldStart();
}

/**
 * 测试专用：把新格式本地数据清空，并丢弃 Root 与唯一 Key 的运行绑定。
 *
 * `__testResetState()` 只清 Worker 内存。fake-indexeddb 的数据跨用例保留，
 * 因此「未初始化冷启动」这类断言必须先清库，否则会继承上一个用例的
 * `key.json` 与 meta。这里走生产的原子 reset，随后丢弃安装好的 Root、
 * 生命周期服务与身份世代，让下一个用例真的从 uninitialized 开始。
 */
export async function __testResetWalletStore(): Promise<void> {
  __testResetState();
  const store = walletStore;
  if (store) await store.resetWallet().catch(() => undefined);
  discardCurrentPlatformStorageBinding();
  walletStore = undefined;
  walletKeys = undefined;
  walletLifecycle = undefined;
  storageColdStartState = undefined;
  coordinatorState.walletGeneration = "";
  coordinatorState.vaultStatus = "uninitialized";
  coordinatorState.activePublicKeyHex = undefined;
}

/**
 * 测试专用：直接写入/清除本地钱包记录，用来构造 corrupt 与 unsupported 冷启动。
 *
 * 省略某个字段表示「保持原样」。删除必须显式写 `delete: true`：把「没传」
 * 解释成删除会让只想写坏 meta 的用例顺手删掉 key.json，构造出另一种损坏，
 * 断言随之失去意义。
 */
export async function __testSeedWalletLocalRecords(input: {
  /** meta 原文；省略表示不改动 `.keymaster/meta`。 */
  meta?: string;
  /** `key.json` 原文；省略表示不改动固定 KeyHold 路径。 */
  keyHold?: string;
  /** 删除固定 KeyHold 路径，构造「缺少唯一 KeyHold」。 */
  deleteKeyHold?: boolean;
}): Promise<void> {
  const store = walletStore;
  if (!store) throw new Error("Test wallet store is not ready");
  if (input.meta !== undefined) {
    await store.put(WALLET_META_PATH, new TextEncoder().encode(input.meta));
  }
  if (input.keyHold !== undefined) {
    await store.put(WALLET_KEYHOLD_PATH, new TextEncoder().encode(input.keyHold));
  }
  if (input.deleteKeyHold) await store.delete(WALLET_KEYHOLD_PATH).catch(() => undefined);
}

/** 测试专用：列出本地钱包对象路径；用于断言根目录不含桶或 Owner 前缀。 */
export async function __testListWalletObjectPaths(): Promise<string[]> {
  const store = walletStore;
  if (!store) throw new Error("Test wallet store is not ready");
  const paths: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await store.list({ limit: WALLET_LIST_MAX_LIMIT, ...(cursor === undefined ? {} : { cursor }) });
    paths.push(...page.objects.map((object) => object.path));
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return paths.sort();
}
