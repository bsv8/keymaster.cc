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

import type {
  CoordinatorOwnerStorageData,
  CoordinatorPlatformStorageData,
  StorageOwnerGrant,
  StoragePlatformGrant,
} from "@keymaster/contracts/storage-internal";
import type {
  SessionEpoch,
  CoordinatorVaultStatus,
  CoordinatorClientRequest,
  CoordinatorResponse,
  CoordinatorTopicEvent,
  CoordinatorBootstrapSnapshot,
  CoordinatorTopic,
  CoordinatorCommandAck,
  CoordinatorCryptoOperation,
  CoordinatorCryptoResult,
  CoordinatorBackgroundSyncSettings,
  CoordinatorTaskSnapshot,
  CoordinatorVaultOperation,
  CoordinatorSubscribeTopicsResult,
  CoordinatorTopicBaseline,
  CoordinatorValueResult,
  P2pkhBroadcastSubmission,
  AssetDataInvalidationEvent,
  SessionStateEvent,
  VaultSealedSecret,
  P2pkhProviderConfig,
  P2pkhProviderRegistry,
  P2pkhTransactionBroadcastProvider,
  P2pkhUtxoSnapshotResult,
  WindowP2pExecutorLease,
  WindowP2pNoiseSignRequest,
  WindowP2pPeerRecordSignRequest,
  WindowP2pIdentitySignResult,
  MsFileReadConcurrencySettings,
  CoordinatorSatOperation,
  CoordinatorSatStateEvent,
  CoordinatorChannelOperation,
  CoordinatorChannelStateEvent,
  ChannelSubscriptionStatus,
  CoordinatorContactsPresenceEvent,
  CoordinatorWorkerUnitStateEvent,
  CoordinatorWorkerUnitSnapshot,
  ChannelPrivateMessageEvent,
  ChannelRuntime,
  ContactsService,
  SatWindowLaneOperation,
  SatWindowLaneSspRequestEvent,
  SatSubscriptionAdminService,
  SatSubscriptionService,
  SatSubscriptionSpiService,
  SatSubscriptionSettingsSnapshot,
  SatIncomingPublish,
  ContactPresenceMap,
  WindowP2pExecutorError,
  KeyValueListInput,
  KeyValueValue,
  KeyValueCommitInput,
  ActiveKeyCrypto,
  StorageBootstrapState,
  PluginIntentStateEvent,
  CoordinatorAuthorityRecovery,
  CoordinatorRpcRequest,
  CoordinatorRpcResponse,
  CoordinatorRpcCommandRequest,
  CoordinatorSessionOpenRequest,
  CoordinatorSessionCloseRequest,
  CoordinatorSessionBinding,
  CoordinatorLocalStorageRequest,
  CoordinatorLocalStorageResponse,
  CoordinatorTopicSubscription,
  CoordinatorOwnerStorageResult,
  CoordinatorPlatformStorageResult,
  SnapshotStore,
  StorageSnapshotJsonCompatible,
  StorageHoldHeadExpectation,
  PluginStorageDeclaration,
} from "@keymaster/contracts";
import { CENTRAL_STORAGE_DECLARATIONS, SYSTEM_STORAGE_DECLARATIONS, REMOTE_STORAGE_HOLD_HEAD_PATH, REMOTE_STORAGE_ROOT_MANIFEST_PATH, KEYMASTER_SESSION_RECOMMENDED_ITERATIONS, createKeymasterSession, deriveThirdPartyStorageModuleId, coordinatorClientRequestFromRpc, encodeBase64Url, parseCoordinatorResponseFor, validateKeyHoldDocument, validateKeymasterSession, BACKGROUND_MANAGED_SYNC_TASK_IDS, BACKGROUND_SYNC_DEFAULT_INTERVAL_MS, BACKGROUND_SYNC_INTERVAL_OPTIONS_MS, BACKGROUND_TRIGGER_REASON, isDefinitelyNotDispatchedBroadcastError, AUTO_LOCK_DEFAULT_TIMEOUT_MS, AUTO_LOCK_NEVER_TIMEOUT_MS, isValidAutoLockTimeoutMs, normalizeAutoLockTimeoutMs } from "@keymaster/contracts";
import {
  BUILTIN_ALWAYS_ON_PLUGIN_PRODUCT_ID_SET,
  BUILTIN_PLUGIN_PRODUCT_ID_SET,
} from "@keymaster/contracts";
import {
  COORDINATOR_CRYPTO_SERVICE,
  COORDINATOR_OWNER_STORAGE_SERVICE,
  COORDINATOR_SERVICE_CONTRACT_VERSION,
  COORDINATOR_SERVICE_PROTOCOL_VERSION,
} from "@keymaster/contracts";
import {
  COORDINATOR_RPC_CAPABILITY,
  COORDINATOR_TOPIC_STREAM_CAPABILITY,
  COORDINATOR_LOCAL_STORAGE_RPC_CAPABILITY,
  COORDINATOR_OWNER_STORAGE_RPC_CAPABILITY,
  COORDINATOR_PLATFORM_STORAGE_RPC_CAPABILITY,
  COORDINATOR_CRYPTO_RPC_CAPABILITY,
} from "@keymaster/contracts";
import {
  MSFILE_MAX_BLOCK_BYTES,
  MSFILE_MAX_SEED_BYTES,
  MSFILE_READ_CONCURRENCY_RECOMMENDED,
  MSFILE_SELLER_SETTINGS_DEFAULT,
  normalizeMsFileReadConcurrencySettings,
  SAT_SUBSCRIPTION_RESOURCE_LIMITS,
} from "@keymaster/contracts";
import { installInsecureContextCryptoFallback, hexToBytes as cryptoHexToBytes, bytesToHex, decryptBytesWithSaltBoundAad, encryptBytesWithSaltBoundAad, deriveP2pkhAddress, signEcdsaDigest, verifySessionKeyPair, generatePrivateKeyHex as generateValidPrivateKeyHex, configureVaultStorageRepository, disposeVaultStorageRepository, vaultStorageRepository, type VaultCatalogHoldAdapter, type VaultCatalogHoldRecord, type VaultCatalogHoldSnapshot } from "@keymaster/plugin-vault/coordinator";
// 不能通过 runtime barrel 导入：它 re-export React hooks，Vite 会把
// React Refresh 注入 SharedWorker，后者没有 window。
import {
  createMessageBus,
  definePlugin,
  startSharedWorkerApp,
  type PluginIntentController,
  type PluginIntentSnapshot,
  type UpgradeGate,
  type UpgradeIoLease,
  type UpgradeSession,
  type HandlerCallContext,
  type PeerController,
} from "webloom-framework";
import {
  createPluginIntentController,
  createUpgradeGate,
} from "webloom-framework/advanced";
import { createInMemoryKeyValueStore } from "@keymaster/runtime/storage";
import { createFinalIoAudit, type FinalIoAuditOperation } from "./coordinator/finalIoAudit.js";
import { acquireCoordinatorAuthorityLock, type CoordinatorAuthorityLock } from "./coordinator/coordinatorAuthorityLock.js";
import {
  assertCoordinatorWorkerUnitCatalog,
  COORDINATOR_WORKER_UNIT_CATALOG,
  getCoordinatorWorkerProductDependenciesForTask,
  getCoordinatorWorkerUnitForTask,
} from "./coordinator/workerUnitCatalog.js";
import { createCoordinatorWorkerUnitRegistry } from "./coordinator/workerUnitRuntime.js";
import { createWocService, createWocBsv21Service, createWocStasService, createWoc1SatOrdinalsService, registerWocP2pkhProviders } from "@keymaster/plugin-woc/coordinator";
import { createCentralBroadcastService, createP2pkhProviderRegistry, createP2pkhService, createP2pkhUtxoSnapshotStore, p2pkhAddressToScriptHex, type P2pkhService, type P2pkhUtxoSnapshotResource, type P2pkhUtxoSnapshotStore } from "@keymaster/plugin-p2pkh/coordinator";
import { createP2pkhCoordinatorTasks, createP2pkhFileRepository, openP2pkhStateRepository, createP2pkhStateRepository, disposeP2pkhStateRepository, parseP2pkhTransaction } from "@keymaster/plugin-p2pkh/coordinator";
import { createBsv21CoordinatorTask } from "@keymaster/plugin-token-bsv21/coordinator";
import { createStasCoordinatorTask } from "@keymaster/plugin-token-stas/coordinator";
import { createOrdinalsCoordinatorTask } from "@keymaster/plugin-collectible-1satordinals/coordinator";
import { createContactsPresenceTask, createContactsService } from "@keymaster/plugin-contacts/coordinator";
import type { BorrowedOwnerFileStore, DeviceRecordV1, DeviceLocationV1, ExistingRemoteStorageConnectPlan, ExistingRemoteStorageConnectResult, InitialSetupFirstKey, InitialSetupPlan, InitialSetupRecoveryRecordV1, InitialSetupRecoveryResult, InitialSetupRecoverySuccessV1, InitialSetupKeyResult, InitialSetupResult, KeyHoldDocumentV1, KeymasterSessionKeyDerivationV1, KeymasterSessionV1, KeyspaceService, KeyValueStore, OwnerFileStore, PlatformRootStore, StorageBucketConnectionConfigV1, StorageBucketProvider, StorageBucketReadOnlyProvider, StorageBucketRef, StorageRecordV1, StorageKeyDerivationV1, StorageBucketSwitchResultV1, StorageCatalogKeyIndexRecordV1, StorageRuntimeBucketV1, StorageBucketListPage, StorageBucketObject, StorageBucketProbeResult, StorageBucketWriteCondition, VaultService, WocService, WocServiceHandle, WocQueueSnapshot } from "@keymaster/contracts";
import type {
  StorageRuntimeController,
  StorageRuntimeControllerStatus,
  CoordinatorStorageControl,
  CoordinatorStorageData,
  CoordinatorStorageStateEvent,
  CoordinatorMsFileControl,
  CoordinatorMsFileData,
  CoordinatorMsFileStateEvent,
  MsFileConnectAppContext,
  MsFileErrorCode,
  AssetDataChangedEvent,
  WocUtxoResponse,
} from "@keymaster/contracts";
import { createStorageRuntimeController, createPlatformRootStore, createKeyValueStore, openMultipartUploadRepository, StorageHealthController, StorageRuntimeError, createLocalStorageBucketProvider, createS3BucketProvider, normalizeProviderConfig, encryptDeviceConfig, decryptDeviceConfig, createKeyLock, createKeyHoldRepository, createKeyHoldDocument, decryptKeyHoldDocument, parseKeyHoldDocument, serializeKeyHoldDocument, generateSessionId, createBucketObjectStoreCapabilityState, setBucketObjectStoreCapabilityMode } from "@keymaster/platform-storage/coordinator";
import type { BucketObjectStoreCapabilityState, KeyHoldFile, KeyHoldRepository, KeyLock, LocalStorageBridgeRequest, LocalStorageBridgeResponse, UnlockedKeyHold } from "@keymaster/platform-storage/coordinator";
import { buildDiagnosticText } from "./diagnostics/sanitizeDiagnostic.js";
import { installSharedWorkerRetirement } from "./coordinator/sharedWorkerRetirement.js";

// 旧 Hold/目录事务尚未从本文件删除前，集中定义它们所需的旧连接形状。
// 新 device-bootstrap v1 不允许这些字段；这里只是让待删除的旧编排保持
// 可编译，所有真正写入新文件的路径仍必须使用 v1 校验器。
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
import {
  BitfsSeedIndex,
  BitfsSellerRuntime,
  BitfsSellerProtocol,
  BitfsSellerSessionManager,
  BitfsTransactionBroadcaster,
  createBitfsJournal,
  createBitfsSessionJournal,
  createBitfsTransactionJournal,
  createBitfsVaultSigner,
  createBitfsWocChainPort,
  createMsFileLocalContentSource,
  createMsFileService,
  createUnavailableBitfsSellerContentResolver,
  openMsFileRepository,
  reconcileBitfsTransactions,
  reconcileBitfsSessionTransactions,
  storeMsFileSeed,
  type BitfsSellerMatch,
  type BitfsSellerProtocolPort,
  type BitfsSellerStreamTransport,
  type BitfsTransactionJournal,
  type BitfsStreamEvent,
  type MsFileServiceImpl,
  type MsFileServiceEventState,
} from "@keymaster/plugin-msfile/coordinator";
import {
  buildWindowP2pConcurrencyConfig,
  createWindowP2pMsFileTransport,
} from "@keymaster/plugin-msfile/executor-transport";
import type {
  WindowP2pExecutorConcurrencyConfig,
  WindowP2pExecutorOperation,
} from "@keymaster/plugin-window-p2p/executor-transport";
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
import {
  inboxChannel,
  newMessageID,
  parseInboxChannel,
  parseMessageID,
  parsePrivateKey,
  parsePublicKey,
  parseSHA256Hash,
  publicKeyFromPrivate,
} from "bsv8-channel-protocol";
import { marshalEnvelope, marshalPrivateMessage, signPrivateMessage, sealSigned, verifySignedPrivateMessage, open as openPrivateMessage, validatePongRelation, validateWebRTCRelation, reviewOfferForHashRequest, dedupKey as privateDedupKey, privateMessageMaxLifetimeMs, PING_PRIVATE_MESSAGE_MAX_LIFETIME_MS } from "bsv8-channel-protocol/inbox";
import { APP_MESSAGE_PROTOCOL, newAck, newDeliver } from "bsv8-channel-protocol/app-message";
import { PING_PROTOCOL, parseBodyValue as parsePingBodyValue, newPong } from "bsv8-channel-protocol/ping";
import { WEBRTC_SIGNAL_PROTOCOL, parseBodyValue as parseWebrtcBodyValue } from "bsv8-channel-protocol/webrtc-signal";
import { sign as signPublicMessage, marshal as marshalPublicMessage, parseAndVerify as parsePublicMessage, dedupKey as publicDedupKey, PUBLIC_MESSAGE_MAX_LIFETIME_MS } from "bsv8-channel-protocol/public-message";
import { HASH_REQUEST_CHANNEL, newWebRTCSDPLocator, parseAndVerify as parseHashRequest, sign as signHashRequest, marshal as marshalHashRequest } from "bsv8-channel-protocol/hash-request";
import { ChannelSubscriptionMux, validateExactChannel } from "./channelSubscriptionMux.js";
import { PendingPingRegistry } from "./channelPendingPingRegistry.js";
import { MAX_WIRE_BYTES } from "sat-subscription-protocol/protocol";
import { configureProtocolStorageRepository, getConnectSession as getAuthoritativeConnectSession, isVerifiedAppIdentitySnapshot } from "@keymaster/plugin-protocol/coordinator";
import {
  applyDefaultSatSupplier,
  createSatSubscriptionProvider,
  createSatSubscriptionRepository,
  createSatSubscriptionState,
  createSatSpiService,
  type SatSubscriptionProvider,
  type SatSubscriptionStateStore,
  type SatSubscriptionRepository,
  type SatSubscriptionTransport,
  type SatDefaultNetwork,
  type SatSupplierConnection,
  SatSubscriptionHandle,
  type SatP2pkhService,
} from "@keymaster/plugin-sat-subscription/coordinator";

// Vault 平台元数据操作（Worker 内只访问 Storage bootstrap 注入的句柄）。
// 私钥密文永远由 Hold adapter 读写；这些 K-V 只保存公开索引、认证元数据、
// Add/Delete 共用的生命周期日志。
function wipeUnlockedDeviceBootstrapKeys(): void {
  unlockedKeyHold?.privateKeyBytes.fill(0);
  unlockedKeyHold = undefined;
}

/** v1 解锁结果只在 Worker 内存中保留，不能进入页面或任何 K-V。 */
function adoptUnlockedDeviceBootstrapKey(unlocked: UnlockedKeyHold): void {
  wipeUnlockedDeviceBootstrapKeys();
  unlockedKeyHold = unlocked;
}

function unlockedDeviceBootstrapPrivateKey(publicKeyHex: string): Uint8Array | undefined {
  const wanted = publicKeyHex.toLowerCase();
  return unlockedKeyHold?.document.publicKeyHex === wanted ? unlockedKeyHold.privateKeyBytes : undefined;
}

async function getActiveKey(): Promise<PublicVaultKeyRecord | undefined> {
  const selectedPublicKeyHex = coordinatorMeta.selectedPublicKeyHex;
  if (selectedPublicKeyHex) {
    const selected = await getPublicVaultKey(selectedPublicKeyHex);
    if (selected) return selected;
  }
  const keys = await listPublicVaultKeys();
  const first = keys[0];
  if (first) {
    coordinatorMeta.selectedPublicKeyHex = first.publicKeyHex;
    await persistSelectedPublicKey();
  }
  return first;
}

/** Reconcile persisted selection from public key listings only. */
async function reconcileSelectedPublicKey(): Promise<boolean> {
  const activeKey = await getActiveKey();
  if (activeKey) return true;

  // 没有 Key 就是空状态，回到首启流程。
  coordinatorMeta.selectedPublicKeyHex = undefined;
  await persistSelectedPublicKey();
  return false;
}

function selectedCatalogBucket(): StorageRuntimeBucketV1 | undefined {
  const entry = storageBootstrapState?.selectedBucket;
  const provider = platformBucketProvider;
  const root = platformRootStore;
  if (!entry || !provider || !root) return undefined;
  if (entry.bucketId !== provider.bucketId || entry.backend !== provider.provider) return undefined;
  if (root.bucket.bucketId !== entry.bucketId || root.bucket.provider !== entry.backend) return undefined;
  return entry;
}

/**
 * 当前桶的设备目录投影。
 *
 * 页面设备引导只保存本机连接密文（每次加密使用随机 IV），运行态条目则绑定
 * 远端 Hold 权威 storage record。页面目录 CAS 按密文比较，因此 Worker 发起
 * 目录更新必须用这份投影做 expected/next：纯元数据更新保留本机连接密文，
 * 只有配置/改密流程显式发布新密文时才让两者收敛。
 */
/**
 * Key 公开元数据的内存缓存。
 *
 * keys/ 下的 KeyHold 文件是唯一真值（见 KeymasterFormats）；本缓存只为
 * 列表展示保留本次会话内计算出的 address/capabilities/createdAt 等派生
 * 字段,重启后按需从文件重建,不再写入任何桶内 K-V。
 */
const vaultKeyIndexCache = new Map<string, StorageCatalogKeyIndexRecordV1>();
let vaultKeyIndexHydrated = false;

/** 首次读取时从 KeyHold 文件重建缓存；文件读取失败保持空列表。 */
async function hydrateVaultKeyIndex(): Promise<void> {
  if (vaultKeyIndexHydrated) return;
  vaultKeyIndexHydrated = true;
  if (!hasVaultHoldBinding()) return;
  try {
    const snapshot = await requireVaultHoldAdapter().readCommitted({ password: "" });
    for (const key of snapshot.keys) {
      const lower = key.publicKeyHex.toLowerCase();
      if (!vaultKeyIndexCache.has(lower)) vaultKeyIndexCache.set(lower, catalogIndexFromHoldKey(key));
    }
  } catch {
    // 未绑定/读取失败时列表为空;后续 replaceKeys 会重新填充。
    vaultKeyIndexHydrated = false;
  }
}

function resetVaultKeyIndexCache(): void {
  vaultKeyIndexCache.clear();
  vaultKeyIndexHydrated = false;
}

function currentCatalogKeyIndex() {
  return {
    listKeys: async () => { await hydrateVaultKeyIndex(); return [...vaultKeyIndexCache.values()].map((record) => structuredClone(record)); },
    getKey: async (publicKeyHex: string) => {
      await hydrateVaultKeyIndex();
      const record = vaultKeyIndexCache.get(publicKeyHex.toLowerCase());
      return record ? structuredClone(record) : undefined;
    },
    replaceKeys: async (records: readonly StorageCatalogKeyIndexRecordV1[]) => {
      vaultKeyIndexCache.clear();
      for (const record of records) vaultKeyIndexCache.set(record.publicKeyHex.toLowerCase(), structuredClone(record));
      vaultKeyIndexHydrated = true;
    },
    deleteKey: async (publicKeyHex: string) => { vaultKeyIndexCache.delete(publicKeyHex.toLowerCase()); },
  };
}

type PublicVaultKeyRecord = {
  publicKeyHex: string;
  label: string;
  address?: string;
  network?: "main" | "test";
  format: string;
  capabilities: string[];
  createdAt: string;
  source?: string;
};

function catalogIndexToPublicKey(record: StorageCatalogKeyIndexRecordV1): PublicVaultKeyRecord {
  return {
    publicKeyHex: record.publicKeyHex,
    label: record.label,
    ...(record.address === undefined ? {} : { address: record.address }),
    ...(record.network === undefined ? {} : { network: record.network }),
    format: record.keyFormat,
    capabilities: [...record.capabilities],
    createdAt: record.createdAt,
    ...(record.source === undefined ? {} : { source: record.source }),
  };
}

/**
 * 目录桶的单 Key 备份格式。
 *
 * 它只携带一个已经用“源桶密码”加密的 Hold KeyRecord；导出不会解密
 * 私钥。导入时先用 sourcePassword 解开，再由目标桶密码重新封装并发布
 * 到目标桶的完整 Hold 快照，因此不会重新引入 KeyHold 私钥副本。
 */
async function exportCatalogKeyBackup(publicKeyHex: string): Promise<string> {
  const provider = platformBucketProvider;
  if (!provider) throw new StorageRuntimeError("storage_unavailable", "The selected runtime bucket is unavailable");
  const bytes = await createKeyHoldRepository(provider).export(publicKeyHex);
  return new TextDecoder().decode(bytes);
}

async function exportVaultKeyBackup(publicKeyHex: string): Promise<string> {
  if (selectedCatalogBucket()) return exportCatalogKeyBackup(publicKeyHex);
  if (!testVaultHoldBinding) throw new StorageRuntimeError("storage_unavailable", "Vault is not bound to a bucket");
  const encryptedKey = testVaultHoldBinding.snapshot().keys.find((item) => item.publicKeyHex.toLowerCase() === publicKeyHex.toLowerCase());
  if (!encryptedKey) throw new Error("Key is missing from the vault");
  return serializeKeyHoldDocument(fromVaultCatalogHoldRecord(encryptedKey));
}

function toVaultCatalogHoldRecord(document: KeyHoldDocumentV1): VaultCatalogHoldRecord {
  return {
    publicKeyHex: document.publicKeyHex,
    label: document.label,
    cipher: { ...document.cipher },
    keyDerivation: { ...document.keyDerivation },
  };
}

function fromVaultCatalogHoldRecord(record: VaultCatalogHoldRecord): KeyHoldDocumentV1 {
  if (!record.keyDerivation) throw new StorageRuntimeError("storage_remote_corrupt", "KeyHold record is missing its keyDerivation");
  return validateKeyHoldDocument({
    format: "keyhold",
    version: 1,
    label: record.label,
    publicKeyHex: record.publicKeyHex,
    keyDerivation: { ...record.keyDerivation },
    cipher: record.cipher,
  });
}

/** Worker 侧扩展：单 Key 文件模型下删除必须显式按公钥进行,不能用集合快照隐式删除。 */
interface WorkerCatalogHoldAdapter extends VaultCatalogHoldAdapter {
  removeKey(publicKeyHex: string): Promise<void>;
}

/** 把当前桶 Provider 适配成 Vault 插件的唯一私钥入口（KeyHold 单 Key 文件）。 */
function createCatalogHoldAdapter(provider: StorageBucketProvider): WorkerCatalogHoldAdapter {
  const repository = createKeyHoldRepository(provider);
  const snapshotOf = (files: readonly KeyHoldFile[]): VaultCatalogHoldSnapshot => ({
    revision: 0,
    keys: files.map((file) => toVaultCatalogHoldRecord(file.document)),
  });
  return {
    async readCommitted() {
      return snapshotOf(await repository.readAll());
    },
    async readEncryptedSnapshot() {
      return snapshotOf(await repository.readAll());
    },
    async encryptPrivateKey({ password, label, privateKey }) {
      const file = await repository.create({ label, privateKeyBytes: privateKey, password });
      return toVaultCatalogHoldRecord(file.document);
    },
    async decryptPrivateKey({ password, record }) {
      const unlocked = await repository.unlock(record.publicKeyHex, password);
      try {
        if (unlocked.document.publicKeyHex.toLowerCase() !== record.publicKeyHex.toLowerCase()) throw new Error("KeyHold public key mismatch");
        verifySessionKeyPair({ publicKeyHex: unlocked.document.publicKeyHex, privateKeyBytes: unlocked.privateKeyBytes });
        return unlocked.privateKeyBytes.slice();
      } finally {
        unlocked.privateKeyBytes.fill(0);
      }
    },
    async publish() {
      // KeyHold 是一 Key 一文件：publish 只回报当前全部文件,绝不按集合快照
      // 隐式删除。删除必须走 removeKey,避免并发新增被旧快照覆盖删除。
      return snapshotOf(await repository.readAll());
    },
    async removeKey(publicKeyHex) {
      const wanted = publicKeyHex.toLowerCase();
      const file = (await repository.readAll()).find((candidate) => candidate.document.publicKeyHex.toLowerCase() === wanted);
      if (file) await repository.delete(file.document.publicKeyHex, file.etag);
    },
  };
}

/**
 * 测试专用的内存 KeyHold 装配。
 *
 * 它使用与真实桶相同的 KeyHold SDK 加解密函数，只把已经加密的单 Key
 * 文档放在测试进程内存中；不引入私钥 K-V，也不让生产路径拥有非桶持久化后门。
 */
function createTestVaultHoldBinding(): { adapter: WorkerCatalogHoldAdapter; snapshot(): VaultCatalogHoldSnapshot; reset(): void } {
  const documents = new Map<string, KeyHoldDocumentV1>();
  let revision = 0;
  const snapshot = (): VaultCatalogHoldSnapshot => ({
    revision,
    keys: [...documents.values()].map(toVaultCatalogHoldRecord),
  });
  const adapter: WorkerCatalogHoldAdapter = {
    async readCommitted() {
      return snapshot();
    },
    async readEncryptedSnapshot() {
      return snapshot();
    },
    async encryptPrivateKey(input) {
      const document = await createKeyHoldDocument({ label: input.label, privateKey: input.privateKey }, input.password);
      documents.set(document.publicKeyHex.toLowerCase(), document);
      revision += 1;
      return toVaultCatalogHoldRecord(document);
    },
    async decryptPrivateKey(input) {
      const document = documents.get(input.record.publicKeyHex.toLowerCase()) ?? fromVaultCatalogHoldRecord(input.record);
      const plain = await decryptKeyHoldDocument(document, input.password);
      try {
        verifySessionKeyPair({ publicKeyHex: plain.publicKeyHex, privateKeyBytes: plain.privateKey });
        return plain.privateKey.slice();
      } finally {
        plain.privateKey.fill(0);
      }
    },
    async publish() {
      if (testFailNextHoldRollbackCas) {
        testFailNextHoldRollbackCas = false;
        throw new StorageRuntimeError("storage_conflict", "injected catalog Hold rollback CAS failure");
      }
      revision += 1;
      return snapshot();
    },
    async removeKey(publicKeyHex) {
      documents.delete(publicKeyHex.toLowerCase());
      revision += 1;
    },
  };
  return {
    adapter,
    snapshot,
    reset() {
      documents.clear();
      revision = 0;
    },
  };
}

async function listPublicVaultKeys(): Promise<PublicVaultKeyRecord[]> {
  return (await currentCatalogKeyIndex().listKeys()).map(catalogIndexToPublicKey);
}

async function getPublicVaultKey(publicKeyHex: string): Promise<PublicVaultKeyRecord | undefined> {
  const record = await currentCatalogKeyIndex().getKey(publicKeyHex);
  return record ? catalogIndexToPublicKey(record) : undefined;
}

function hasVaultHoldBinding(): boolean {
  return Boolean(selectedCatalogBucket() || testVaultHoldBinding);
}

function requireVaultHoldAdapter(): WorkerCatalogHoldAdapter {
  if (!hasVaultHoldBinding()) throw new StorageRuntimeError("storage_unavailable", "Vault is not bound to a bucket");
  return vaultStorageRepository.hold as WorkerCatalogHoldAdapter;
}

async function readVaultHoldSnapshot(_password: string): Promise<VaultCatalogHoldSnapshot> {
  return requireVaultHoldAdapter().readCommitted({ password: "" });
}

async function rebuildVaultHoldKeyIndex(keys: readonly VaultCatalogHoldRecord[]): Promise<PublicVaultKeyRecord[]> {
  const index = currentCatalogKeyIndex();
  const previous = new Map((await index.listKeys()).map((record) => [record.publicKeyHex.toLowerCase(), record]));
  const records = keys.map((key) => catalogIndexFromHoldKey(key, previous.get(key.publicKeyHex.toLowerCase())));
  await index.replaceKeys(records);
  return records.map(catalogIndexToPublicKey);
}

async function publishVaultHoldSnapshot(
  password: string,
  keys: readonly VaultCatalogHoldRecord[],
  indexRecords: readonly StorageCatalogKeyIndexRecordV1[],
  expectedHead: StorageHoldHeadExpectation,
): Promise<VaultCatalogHoldSnapshot> {
  // KeyHold 单 Key 文件没有共享 Head：expectedHead 不再参与 CAS,保留参数
  // 只为兼容调用点。并发新增/删除互不冲突,索引必须按 publish 后的真实
  // 文件集合重建,不能信任调用方基于旧快照算出的 indexRecords。
  void expectedHead;
  const hold = requireVaultHoldAdapter();
  const published = await hold.publish({ password, keys, expectedHead });
  try {
    const metadata = new Map(indexRecords.map((record) => [record.publicKeyHex.toLowerCase(), record]));
    const current = new Map((await currentCatalogKeyIndex().listKeys()).map((record) => [record.publicKeyHex.toLowerCase(), record]));
    const committed = published.keys.map((key) => {
      const lower = key.publicKeyHex.toLowerCase();
      const base = metadata.get(lower) ?? current.get(lower);
      const record = base ?? catalogIndexFromHoldKey(key);
      return { ...record, label: key.label };
    });
    await currentCatalogKeyIndex().replaceKeys(committed);
    return published;
  } catch (error) {
    // 索引可重建,这里不做任何删除补偿:失败回滚由调用方按公钥精确执行,
    // 否则会把并发写入的其它 Key 文件一起删掉。
    throw error;
  }
}

async function decryptVaultPrivateKey(
  publicKeyHex: string,
  password: string,
  snapshot?: VaultCatalogHoldSnapshot,
): Promise<Uint8Array> {
  const committed = snapshot ?? await readVaultHoldSnapshot(password);
  const record = committed.keys.find((key) => key.publicKeyHex.toLowerCase() === publicKeyHex.toLowerCase());
  if (!record) throw new Error("Key not found in the vault");
  const privateKey = await requireVaultHoldAdapter().decryptPrivateKey({ password, record });
  try {
    verifySessionKeyPair({ publicKeyHex: publicKeyHex.toLowerCase(), privateKeyBytes: privateKey });
    return privateKey;
  } catch (error) {
    privateKey.fill(0);
    throw error;
  }
}

/** 从 KeyHold 公开字段重建一个不含密文的桶内索引记录。 */
function catalogIndexFromHoldKey(
  key: { publicKeyHex: string; label: string },
  previous?: StorageCatalogKeyIndexRecordV1,
): StorageCatalogKeyIndexRecordV1 {
  return {
    format: "keymaster.storage.catalog-key-index",
    publicKeyHex: key.publicKeyHex.toLowerCase(),
    label: key.label,
    address: previous?.address ?? deriveP2pkhAddress(key.publicKeyHex, "main"),
    network: previous?.network ?? "main",
    keyFormat: previous?.keyFormat ?? "keyhold",
    capabilities: [...(previous?.capabilities ?? ["p2pkh"])],
    createdAt: previous?.createdAt ?? new Date().toISOString(),
    ...(previous?.source === undefined ? {} : { source: previous.source }),
  };
}

async function rebuildCurrentCatalogKeyIndex(keys: readonly { publicKeyHex: string; label: string }[]): Promise<PublicVaultKeyRecord[]> {
  const index = currentCatalogKeyIndex();
  const previous = new Map((await index.listKeys()).map((record) => [record.publicKeyHex.toLowerCase(), record]));
  const records = keys.map((key) => catalogIndexFromHoldKey(key, previous.get(key.publicKeyHex.toLowerCase())));
  await index.replaceKeys(records);
  return records.map(catalogIndexToPublicKey);
}

function expectedHoldHead(headEtag: string | undefined): StorageHoldHeadExpectation {
  return headEtag === undefined ? { kind: "absent" } : { kind: "etag", etag: headEtag };
}

type KeyMutationRollbackStage = "hold" | "key-index" | "owner-storage" | "mutation-journal";

interface KeyMutationRollbackFailure {
  stage: KeyMutationRollbackStage;
  error: unknown;
}

/**
 * Key mutation rollback is part of the safety boundary, not best-effort
 * logging.  Keep the original failures attached for diagnostics while
 * exposing only stable storage semantics to callers.
 */
class KeyMutationRollbackUnconfirmedError extends StorageRuntimeError {
  readonly rollbackUnconfirmed = true;
  readonly failures: readonly KeyMutationRollbackFailure[];

  constructor(failures: readonly KeyMutationRollbackFailure[]) {
    const summary = failures.map(({ stage, error }) => {
      const code = error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
      return `${stage}: ${typeof code === "string" ? code : error instanceof Error ? error.message : "unknown error"}`;
    }).join("; ");
    super("storage_unavailable", `Key mutation rollback-unconfirmed${summary ? ` (${summary})` : ""}`, "provider");
    this.name = "KeyMutationRollbackUnconfirmedError";
    this.failures = [...failures];
  }
}

function isKeyMutationRollbackUnconfirmed(error: unknown): error is KeyMutationRollbackUnconfirmedError {
  return error instanceof KeyMutationRollbackUnconfirmedError
    || Boolean(error && typeof error === "object" && (error as { rollbackUnconfirmed?: unknown }).rollbackUnconfirmed === true);
}

/** Enter degraded/fail-closed mode before returning an unconfirmed mutation. */
async function failClosedAfterKeyMutationRollback(error: KeyMutationRollbackUnconfirmedError): Promise<void> {
  storageStartupFailure = true;
  storageHealthController.setStatus("degraded", "Key mutation rollback was not confirmed");
  emitStorageState();
  try {
    await performGlobalLock("key-mutation-rollback-unconfirmed");
  } catch (lockError) {
    console.error("[vault] fail-closed lock after unconfirmed rollback failed", {
      rollback: error.message,
      lock: lockError instanceof Error ? lockError.message : String(lockError),
    });
    coordinatorState.vaultStatus = "locked";
    coordinatorState.activePublicKeyHex = undefined;
    dropActivePrivateKey();
    emitStorageState();
  }
}

function sameStorageRecord(left: unknown, right: unknown): boolean {
  const leftCipher = (left as { cipher?: Partial<StorageRecordV1["cipher"]> } | undefined)?.cipher;
  const rightCipher = (right as { cipher?: Partial<StorageRecordV1["cipher"]> } | undefined)?.cipher;
  if (!leftCipher || !rightCipher) return false;
  return leftCipher.algorithm === rightCipher.algorithm
    && leftCipher.keyLengthBits === rightCipher.keyLengthBits
    && leftCipher.ivB64Url === rightCipher.ivB64Url
    && leftCipher.tagLengthBits === rightCipher.tagLengthBits
    && leftCipher.ciphertextAndTagB64Url === rightCipher.ciphertextAndTagB64Url;
}

/**
 * 让公开 Key 索引与 \`keys/\` 目录保持一致。
 */
async function syncSelectedCatalogHoldSnapshot(_password: string): Promise<number | undefined> {
  const binding = selectedCatalogBucket();
  if (!binding) {
    if (!testVaultHoldBinding) throw new StorageRuntimeError("storage_unavailable", "Vault is not bound to a bucket");
    const snapshot = await readVaultHoldSnapshot("");
    await rebuildCurrentCatalogKeyIndex(snapshot.keys);
    return snapshot.revision;
  }
  const provider = platformBucketProvider;
  if (!provider) throw new StorageRuntimeError("storage_unavailable", "The selected runtime bucket is unavailable");
  const files = await createKeyHoldRepository(provider).readAll();
  await rebuildCurrentCatalogKeyIndex(files.map((file) => ({ publicKeyHex: file.document.publicKeyHex, label: file.document.label })));
  return files.length;
}

/**
 * 桶内 \`keys/\` 目录是私钥唯一真值：重建公开索引并把运行态收敛为 locked。
 * 密码校验发生在单 Key 解锁，不再有桶级 verifier。
 */
async function hydrateCatalogVaultFromSnapshot(_password: string): Promise<boolean> {
  const binding = selectedCatalogBucket();
  const provider = platformBucketProvider;
  if (!binding || !provider) return false;
  const files = await createKeyHoldRepository(provider).readAll();
  const index = currentCatalogKeyIndex();
  const previousIndex = new Map((await index.listKeys()).map((record) => [record.publicKeyHex.toLowerCase(), record]));
  const records = files.map((file) => catalogIndexFromHoldKey({ publicKeyHex: file.document.publicKeyHex, label: file.document.label }, previousIndex.get(file.document.publicKeyHex.toLowerCase())));
  if (records.length === 0) {
    if (previousIndex.size > 0) throw new StorageRuntimeError("storage_provider_error", "Catalog Key metadata exists while the keys/ directory is empty");
    return false;
  }
  await index.replaceKeys(records);
  coordinatorState.vaultStatus = "locked";
  coordinatorState.activePublicKeyHex = undefined;
  coordinatorMeta.selectedPublicKeyHex = records[0]!.publicKeyHex;
  await persistSelectedPublicKey();
  publishSessionState("bootstrap");
  return true;
}

/** 当前新版桶的跨目录/桶内全量改密；失败时尽量回到旧 Hold 提交头。 */

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
      || typeof interval !== "number" || !BACKGROUND_SYNC_INTERVAL_OPTIONS_MS.includes(interval as never)) {
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

function validatePluginIntentSnapshot(value: unknown): PluginIntentSnapshot {
  const record = snapshotRecord(value, "Plugin intent");
  const intentRevision = record.revision;
  if (Object.keys(record).length !== 3 || !Number.isSafeInteger(intentRevision) || (intentRevision as number) < 0) {
    throw new StorageRuntimeError("storage_provider_error", "Plugin intent snapshot value is invalid");
  }
  const desiredEnabled = snapshotRecord(record.desiredEnabled, "Plugin intent desiredEnabled");
  const desiredRevision = snapshotRecord(record.desiredRevision, "Plugin intent desiredRevision");
  for (const [key, flag] of Object.entries(desiredEnabled)) if (typeof key !== "string" || typeof flag !== "boolean") throw new StorageRuntimeError("storage_provider_error", "Plugin intent desiredEnabled is invalid");
  for (const [key, revision] of Object.entries(desiredRevision)) if (typeof key !== "string" || !Number.isSafeInteger(revision) || (revision as number) < 0) throw new StorageRuntimeError("storage_provider_error", "Plugin intent desiredRevision is invalid");
  return { revision: intentRevision as number, desiredEnabled: { ...desiredEnabled } as Record<string, boolean>, desiredRevision: { ...desiredRevision } as Record<string, number> };
}

interface CoordinatorRuntimeSettings {
  selectedPublicKeyHex?: string;
  scheduleSettings: CoordinatorBackgroundSyncSettings;
  autoLockTimeoutMs: number;
  p2pkhProviderConfigs: Record<string, Record<string, unknown>>;
  p2pkhSettings: { includeTestnet: boolean };
  pluginIntent: PluginIntentSnapshot;
}
/** 桶级 Coordinator snapshot 持久化同步管理 + 自动锁；P2PKH 偏好归 owner 的 setting.json。 */
type CoordinatorSettingsSnapshot = Pick<CoordinatorRuntimeSettings, "scheduleSettings" | "autoLockTimeoutMs">;
function defaultCoordinatorRuntimeSettings(): CoordinatorRuntimeSettings {
  return {
    scheduleSettings: { taskIntervals: {} },
    autoLockTimeoutMs: AUTO_LOCK_DEFAULT_TIMEOUT_MS,
    p2pkhProviderConfigs: {},
    p2pkhSettings: { includeTestnet: false },
    pluginIntent: emptyPluginIntentSnapshot(),
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
let pluginIntentController: PluginIntentController | undefined;
let pluginIntentControllerOff: (() => void) | undefined;
let keyDeletionTail: Promise<void> = Promise.resolve();
let p2pkhRegistry: P2pkhProviderRegistry | undefined;
let p2pkhWocService: WocServiceHandle | undefined;
let p2pkhUtxoSnapshots: P2pkhUtxoSnapshotStore | undefined;
let testP2pkhBroadcastProvider: P2pkhTransactionBroadcastProvider | undefined;
/** 测试专用：替换快照 store 的 `unspent/all` 数据源，避免测试出网。 */
let testP2pkhUnspentAllProvider: ((network: "main" | "test", address: string) => Promise<WocUtxoResponse[]>) | undefined;
/** 测试专用：缩短 Worker 内中心广播服务的重试预算。 */
let testSatBroadcastRetryOverrides: { maxAttempts?: number; deadlineMs?: number; initialBackoffMs?: number; maxBackoffMs?: number } | undefined;
let testPersistCoordinatorSnapshotFailure = false;
let testFailColdStartInstall = false;
let testFailAfterBucketPasswordCatalogUpdate = false;
let testFailAfterBucketConfigCatalogUpdate = false;
let testFailNextVaultAuthMetadataRollback = false;
let testFailNextVaultAuthMetadataRestore = false;
let testFailNextBucketPasswordDeviceRollback = false;
let platformRootStore: PlatformRootStore | undefined;
/** 当前统一抽象桶 Provider；所有 K-V 与文件运行时共用这一实例。 */
let platformBucketProvider: StorageBucketProvider | undefined;
/**
 * Local Provider 在候选 Root 暂存期间必须固定到发起 peer；被 staged
 * binding 采用后，后续 I/O 必须跟随 storageIoOwner。WeakMap 让 publish
 * 只作用于对应 Provider，避免“当前已有 Root”误把另一个候选提前解锁。
 */
const coordinatorLocalStorageProviderPublishers = new WeakMap<StorageBucketProvider, () => void>();

function createCoordinatorLocalStorageBridgeState(peerId?: string): {
  targetPeerId(): string | undefined;
  publish(): void;
} {
  let published = false;
  return {
    targetPeerId: () => published ? undefined : peerId,
    publish: () => { published = true; },
  };
}

function publishCoordinatorLocalStorageProvider(provider: StorageBucketProvider): void {
  coordinatorLocalStorageProviderPublishers.get(provider)?.();
}

/** Root 安装令牌；不能用 bucketGeneration 代替，因为 A→B→A 可能复用世代值。 */
let platformRootToken: object | undefined;

/** 仅供 Worker 单元测试使用的 Hold 替身；生产启动永远由当前桶 Provider 装配。 */
let testVaultHoldBinding: { adapter: VaultCatalogHoldAdapter; snapshot(): VaultCatalogHoldSnapshot; reset(): void } | undefined;
let platformStorageStore: KeyValueStore | undefined;
let coordinatorSettingsSnapshot: SnapshotStore<CoordinatorSettingsSnapshot> | undefined;
let coordinatorPluginIntentSnapshot: SnapshotStore<PluginIntentSnapshot> | undefined;
/** 仅测试夹具保留的内存 Store 索引；生产路径没有这个观测入口。 */
let testPlatformStores: Map<string, KeyValueStore> | undefined;
let testCoordinatorSnapshots: Map<string, { revision: number; value?: unknown; writes: number }> | undefined;
/** 仅测试夹具：模拟浏览器 LocalStorage 里跨 Worker 重启保留的 session。 */
let testWorkerSession: KeymasterSessionV1 | undefined;
/** 当前桶 Protocol 的三个 purpose K-V；切桶回滚时必须整体保留旧句柄。 */
interface CoordinatorProtocolStorageStores {
  durablePolicy: KeyValueStore;
  sessions: KeyValueStore;
  commandHistory: KeyValueStore;
}
let coordinatorProtocolStores: CoordinatorProtocolStorageStores | undefined;

/** 把当前桶 Provider 装配成 Hold 适配器；没有钱包级 K-V。 */
function configureCoordinatorVaultStorage(provider: StorageBucketProvider): void {
  configureVaultStorageRepository({ hold: createCatalogHoldAdapter(provider) });
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
let platformStorageReady = false;
let storageBootstrapState: StorageBootstrapState | null = null;
/** v1 设备引导模式；一旦 session.open 明确发送快照，旧 catalog 不能再成为真值。 */
/** 桶内 `keys/<公钥>.keyhold` 的唯一运行时仓储与当前解锁 Key。 */
let keyHoldRepository: KeyHoldRepository | undefined;
let unlockedKeyHold: UnlockedKeyHold | undefined;
const storageHealthController = new StorageHealthController();
/**
 * 某些 Storage control 会在成功/失败后撤销当前 Root。若控制请求本身
 * 仍持有最终 I/O lease，必须等 lease 的后置运行时校验和释放完成后
 * 再销毁 Root，否则请求结果会被错误地变成 storage error。
 */
let catalogBindingDiscardDeferred = false;
/** 首次初始化暂存 Root 的所有权；失败事务不能触碰赢家的全局运行态。 */
let initialSetupRuntimeOwner: { transactionId: string; bucketId: string; rootToken: object } | undefined;
/** Worker 内缓存的公开恢复记录；业务恢复记录仍由业务 K-V 正式持久化。 */
const initialSetupRecoveryRecords = new Map<string, InitialSetupRecoveryRecordV1>();
/** 只有这些 operationId 跨 Worker 重启；完整阶段账本始终只在 Worker 内存。 */
const deviceRecoveryOperationIds = new Set<string>();
let coordinatorInitializationInProgress = false;
/** 仅供下方 Worker test seam 使用；生产路径没有 active-key 密码缓存。 */
let testHarnessActivationSecret: string | undefined;
let storageRootInstallationActive = false;
let storageRecoveryOrchestrator: Promise<void> | undefined;
type CoordinatorKeyValueMaintenanceStore = KeyValueStore & {
  collectGarbage(input?: { minAgeMs?: number; maxDeletes?: number }): Promise<{ scanned: number; candidates: number; deleted: number; failed: number }>;
};
const coordinatorKeyValueMaintenanceStores = new Set<CoordinatorKeyValueMaintenanceStore>();
const COORDINATOR_KV_GC_INTERVAL_MS = 15 * 60 * 1000;
const COORDINATOR_KV_GC_MIN_AGE_MS = 10 * 60 * 1000;
const COORDINATOR_KV_GC_MAX_DELETES = 64;
let coordinatorKvGcTimer: ReturnType<typeof setTimeout> | undefined;
let coordinatorKvGcGeneration = 0;
let coordinatorKvGcRunning: Promise<void> | undefined;
type WorkerOwnerStoreBinding = { close(): void; invalidateBinding(): void; collectGarbage?(): Promise<{ scanned: number; candidates: number; deleted: number; failed: number }> };
const workerOwnerStores = new Set<WorkerOwnerStoreBinding>();

function registerCoordinatorKeyValueMaintenanceStore(store: KeyValueStore): void {
  const maintenance = store as CoordinatorKeyValueMaintenanceStore;
  if (typeof maintenance.collectGarbage === "function") coordinatorKeyValueMaintenanceStores.add(maintenance);
}

function unregisterCoordinatorKeyValueMaintenanceStore(store: KeyValueStore | undefined): void {
  if (store) coordinatorKeyValueMaintenanceStores.delete(store as CoordinatorKeyValueMaintenanceStore);
}

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

function stopCoordinatorKeyValueMaintenance(): void {
  coordinatorKvGcGeneration += 1;
  if (coordinatorKvGcTimer !== undefined) {
    clearTimeout(coordinatorKvGcTimer);
    coordinatorKvGcTimer = undefined;
  }
}

function maintenanceDeclarationKey(declaration: Pick<PluginStorageDeclaration, "moduleId" | "purposeId" | "scope" | "model" | "schemaVersion">, ownerPublicKeyHex?: string): string {
  return `${declaration.scope}:${ownerPublicKeyHex?.toLowerCase() ?? ""}:${declaration.moduleId}:${declaration.purposeId}:${declaration.model}:${declaration.schemaVersion}`;
}

function coordinatorKeyValueMaintenanceDeclarations(ownerPublicKeyHex: string | undefined): Array<{ declaration: PluginStorageDeclaration; ownerPublicKeyHex?: string }> {
  const declarations = new Map<string, { declaration: PluginStorageDeclaration; ownerPublicKeyHex?: string }>();
  for (const declaration of Object.values(CENTRAL_STORAGE_DECLARATIONS)) {
    if (declaration.scope !== "bucket" || declaration.model !== "kv") continue;
    declarations.set(maintenanceDeclarationKey(declaration), { declaration: { ...declaration } });
  }
  if (!ownerPublicKeyHex) return [...declarations.values()];
  const owner = ownerPublicKeyHex.toLowerCase();
  for (const declaration of Object.values(SYSTEM_STORAGE_DECLARATIONS).flat()) {
    if (declaration.scope !== "owner" || declaration.model !== "kv") continue;
    declarations.set(maintenanceDeclarationKey(declaration, owner), { declaration: { ...declaration }, ownerPublicKeyHex: owner });
  }
  // Host-bound built-in namespaces are normally already in SYSTEM_STORAGE_DECLARATIONS.
  // Include active grants as well so a future centrally authorized dynamic namespace
  // is not stranded merely because it has no long-lived Worker handle.
  for (const grant of ownerStorageGrants.values()) {
    if (grant.ownerPublicKeyHex.toLowerCase() !== owner || grant.model !== "kv") continue;
    const declaration: PluginStorageDeclaration = {
      moduleId: grant.moduleId,
      purposeId: grant.purposeId,
      scope: "owner",
      authority: grant.authority,
      model: grant.model,
      schemaVersion: grant.schemaVersion,
    };
    declarations.set(maintenanceDeclarationKey(declaration, owner), { declaration, ownerPublicKeyHex: owner });
  }
  return [...declarations.values()];
}

function maintenanceStoreMatches(store: KeyValueStore, root: PlatformRootStore, target: { declaration: PluginStorageDeclaration; ownerPublicKeyHex?: string }): boolean {
  return store.bucketId === root.bucket.bucketId
    && store.bucketGeneration === root.bucket.bucketGeneration
    && store.moduleId === target.declaration.moduleId
    && store.purposeId === target.declaration.purposeId
    && store.scope === target.declaration.scope
    && store.model === target.declaration.model
    && store.schemaVersion === target.declaration.schemaVersion
    && (target.declaration.scope === "bucket"
      ? !store.ownerPublicKeyHex
      : Boolean(store.ownerPublicKeyHex)
        && store.ownerPublicKeyHex?.toLowerCase() === target.ownerPublicKeyHex?.toLowerCase());
}

async function collectCoordinatorKeyValueGarbage(input: { minAgeMs: number; maxDeletes: number }, swallowErrors: boolean): Promise<void> {
  const root = platformRootStore;
  const rootToken = platformRootToken;
  if (!root || !rootToken || !platformStorageReady) return;
  const owner = coordinatorState.activePublicKeyHex?.toLowerCase();
  const visited = new Set<string>();
  const collect = async (store: KeyValueStore, targetKey: string): Promise<void> => {
    if (visited.has(targetKey)) return;
    visited.add(targetKey);
    const maintenance = store as CoordinatorKeyValueMaintenanceStore;
    if (typeof maintenance.collectGarbage !== "function") return;
    try {
      await maintenance.collectGarbage(input);
    } catch (error) {
      if (!swallowErrors) throw error;
      console.warn("[storage] coordinator K-V garbage collection failed", error instanceof Error ? error.message : String(error));
    }
  };

  for (const store of [...coordinatorKeyValueMaintenanceStores]) {
    if (store.scope === "owner" && (!owner || store.ownerPublicKeyHex?.toLowerCase() !== owner)) continue;
    const target = {
      moduleId: store.moduleId,
      purposeId: store.purposeId,
      scope: store.scope,
      model: store.model,
      schemaVersion: store.schemaVersion,
    } as const;
    await collect(store, maintenanceDeclarationKey(target, target.scope === "owner" ? owner : undefined));
  }

  for (const target of coordinatorKeyValueMaintenanceDeclarations(owner)) {
    const targetKey = maintenanceDeclarationKey(target.declaration, target.ownerPublicKeyHex);
    if (visited.has(targetKey)) continue;
    let store: KeyValueStore | undefined;
    try {
      store = target.declaration.scope === "bucket"
        ? await root.openPlatformStore({ declaration: target.declaration })
        : await root.openKeyValueStore({ ownerPublicKeyHex: target.ownerPublicKeyHex!, declaration: target.declaration, keyspaceGeneration: coordinatorState.keyspaceGeneration });
      if (!maintenanceStoreMatches(store, root, target)) throw new Error("Coordinator K-V maintenance binding mismatch");
      await collect(store, targetKey);
    } catch (error) {
      if (!swallowErrors) throw error;
      console.warn("[storage] coordinator K-V namespace maintenance failed", error instanceof Error ? error.message : String(error));
    } finally {
      store?.close();
    }
    if (platformRootStore !== root || platformRootToken !== rootToken) return;
  }
}

function scheduleCoordinatorKeyValueMaintenance(): void {
  if (!platformStorageReady || coordinatorKvGcTimer !== undefined) return;
  const generation = coordinatorKvGcGeneration;
  coordinatorKvGcTimer = setTimeout(() => {
    coordinatorKvGcTimer = undefined;
    if (generation !== coordinatorKvGcGeneration) return;
    let run: Promise<void>;
    run = collectCoordinatorKeyValueGarbage({ minAgeMs: COORDINATOR_KV_GC_MIN_AGE_MS, maxDeletes: COORDINATOR_KV_GC_MAX_DELETES }, true).finally(() => {
      if (coordinatorKvGcRunning === run) coordinatorKvGcRunning = undefined;
      if (generation === coordinatorKvGcGeneration) scheduleCoordinatorKeyValueMaintenance();
    });
    coordinatorKvGcRunning = run;
  }, COORDINATOR_KV_GC_INTERVAL_MS);
}

/** 测试专用：执行一次与定时任务相同的受控最终清扫。 */
export async function __testCollectCoordinatorKeyValueGarbage(): Promise<void> {
  stopCoordinatorKeyValueMaintenance();
  await coordinatorKvGcRunning?.catch(() => undefined);
  await collectCoordinatorKeyValueGarbage({ minAgeMs: 0, maxDeletes: COORDINATOR_KV_GC_MAX_DELETES }, false);
  scheduleCoordinatorKeyValueMaintenance();
}

/**
 * 测试专用：在一个已关闭的桶/Owner K-V 句柄中制造可回收孤儿。
 * 返回值只用于测试 Provider 夹具观测，不属于生产接口。
 */
export async function __testSeedCoordinatorKeyValueGarbage(scope: "bucket" | "owner"): Promise<string> {
  ensureTestPlatformStorage();
  const root = platformRootStore;
  const providerState = testCoordinatorGarbageProviderState;
  if (!root || !providerState) throw new Error("Test Coordinator garbage storage is not ready");
  const ownerPublicKeyHex = scope === "owner" ? coordinatorState.activePublicKeyHex : undefined;
  if (scope === "owner" && !ownerPublicKeyHex) throw new Error("An active owner is required for the test garbage namespace");
  const declaration = scope === "bucket"
    ? CENTRAL_STORAGE_DECLARATIONS.bsvPrice
    : CENTRAL_STORAGE_DECLARATIONS.messageHistory;
  const before = new Set(providerState.objects.keys());
  const store = scope === "bucket"
    ? await root.openPlatformStore({ declaration })
    : await root.openKeyValueStore({ ownerPublicKeyHex: ownerPublicKeyHex!, declaration, keyspaceGeneration: coordinatorState.keyspaceGeneration });
  try {
    const key = `gc-orphan-${crypto.randomUUID()}`;
    await store.put(key, { source: "coordinator-gc-test" }, { partition: "gc-test" });
    await store.delete(key, { partition: "gc-test" });
  } finally {
    // The next collection must discover this namespace through declarations,
    // not through a resident handle retained in the Coordinator registry.
    store.close();
  }
  const orphanPath = [...providerState.objects.keys()].find((path) => path.includes("/.keymaster/values/") && !before.has(path));
  if (!orphanPath) throw new Error("Test Coordinator garbage orphan was not created");
  return orphanPath;
}

/** 测试专用：解析 s3 桶 ID（同物理位置复用,否则随机生成）。 */
export async function __testResolveS3BucketStorageId(connection: StorageBucketConnectionConfigV1): Promise<string> {
  return resolveS3BucketStorageId(connection);
}

export function __testCoordinatorKeyValueObjectExists(path: string): boolean {
  return Boolean(testCoordinatorGarbageProviderState?.objects.has(path));
}

async function waitForTestCatalogHoldPublishBarrier(): Promise<void> {
  const barrier = testCatalogHoldPublishBarrier;
  if (!barrier) return;
  testCatalogHoldPublishBarrier = undefined;
  barrier.resolveEntered();
  await barrier.released;
}

async function waitForTestCatalogHoldRollbackBarrier(): Promise<void> {
  const barrier = testCatalogHoldRollbackBarrier;
  if (!barrier) return;
  testCatalogHoldRollbackBarrier = undefined;
  barrier.resolveEntered();
  await barrier.released;
}

async function waitForTestKeyLifecycleOwnerBarrier(): Promise<void> {
  const barrier = testKeyLifecycleOwnerBarrier;
  if (!barrier) return;
  testKeyLifecycleOwnerBarrier = undefined;
  barrier.resolveEntered();
  await barrier.released;
}

function asColdStartReadOnlyProvider(provider: StorageBucketProvider): import("@keymaster/contracts").StorageBucketReadOnlyProvider {
  return Object.freeze({
    provider: provider.provider,
    bucketId: provider.bucketId,
    probe: (signal?: AbortSignal) => provider.probe(signal),
    get: (path: string, options?: { signal?: AbortSignal; ifMatch?: string }) => provider.get(path, options),
    list: (input?: { prefix?: string; cursor?: string; limit?: number; signal?: AbortSignal }) => provider.list(input),
  });
}

type WorkerS3ProviderConfig = Parameters<typeof createS3BucketProvider>[0];
type WorkerS3ProviderOptions = NonNullable<Parameters<typeof createS3BucketProvider>[1]>;
type WorkerS3ProviderOptionsFactory = (config: WorkerS3ProviderConfig) => WorkerS3ProviderOptions | undefined;

let testS3BucketProviderOptionsFactory: WorkerS3ProviderOptionsFactory | undefined;

/** 测试专用：注入 S3 Provider 的对象存储/能力状态，验证凭据来源。 */
export function __testSetS3BucketProviderOptionsFactory(factory: WorkerS3ProviderOptionsFactory | undefined): void {
  testS3BucketProviderOptionsFactory = factory;
}

function workerS3ProviderOptions(
  config: WorkerS3ProviderConfig,
  bucketId: string,
  capabilityState?: BucketObjectStoreCapabilityState,
): WorkerS3ProviderOptions {
  const override = testS3BucketProviderOptionsFactory?.(config);
  if (override) return { ...override, bucketId: override.bucketId ?? bucketId };
  return { bucketId, ...(capabilityState === undefined ? {} : { capabilityState }) };
}

/**
 * 把设备记录里已探测到的条件写能力灌入新的 Provider 能力状态，冷启动/切桶
 * 时不再重复发送条件写探针；字段缺失表示尚未探测，由首次连接时探测并写回。
 */
function capabilityStateForRecord(record: DeviceRecordV1): BucketObjectStoreCapabilityState | undefined {
  if (record.location.providerId !== "s3") return undefined;
  // 判别字段在嵌套 location 上，TS 不会自动收窄整个联合；这里按 s3 形态读取。
  const mode = (record as Extract<DeviceRecordV1, { location: { providerId: "s3" } }>).capabilities?.conditionalWrites;
  if (!mode) return undefined;
  const state = createBucketObjectStoreCapabilityState();
  setBucketObjectStoreCapabilityMode(state, "put", mode, "automatic");
  setBucketObjectStoreCapabilityMode(state, "complete", mode, "automatic");
  return state;
}

/** 由运行时绑定创建 Provider；s3 用启动密码与 session KDF 解开设备记录密文。 */
async function createRuntimeProvider(
  binding: StorageRuntimeBucketV1,
  password: string | undefined,
  peerId?: string,
): Promise<StorageBucketProvider> {
  if (binding.backend === "local") {
    const bridgeState = createCoordinatorLocalStorageBridgeState(peerId);
    const provider = createLocalStorageBucketProvider({
      bucketId: binding.bucketId,
      bucketGeneration: 1,
      bridge: (request) => requestLocalStorageBridge(request, bridgeState.targetPeerId()),
    });
    coordinatorLocalStorageProviderPublishers.set(provider, bridgeState.publish);
    return provider;
  }
  if (!binding.keyDerivation) throw new StorageRuntimeError("storage_provider_error", "Startup password KDF is missing for the s3 bucket");
  if (!password) throw new StorageRuntimeError("storage_identity_required", "Startup password is required");
  const deviceRecord = binding.deviceRecord as Extract<DeviceRecordV1, { location: { providerId: "s3" } }>;
  if (deviceRecord.location.providerId !== "s3") throw new StorageRuntimeError("storage_provider_error", "Device record backend does not match the binding");
  const plaintext = await decryptDeviceConfig({
    password,
    keyDerivation: binding.keyDerivation,
    location: deviceRecord.location,
    cipher: deviceRecord.cipher,
  });
  const normalized: WorkerS3ProviderConfig = {
    version: 1,
    providerId: "s3-compatible",
    connection: {
      endpoint: plaintext.endpoint,
      region: plaintext.region,
      bucket: plaintext.bucket,
      forcePathStyle: plaintext.forcePathStyle === true,
      ...(plaintext.sessionToken === undefined ? {} : { sessionToken: plaintext.sessionToken }),
      ...(plaintext.prefix === undefined ? {} : { prefix: plaintext.prefix }),
    },
    credentials: { kind: "access-key", accessKeyId: plaintext.accessKeyId, secretAccessKey: plaintext.secretAccessKey },
  };
  try {
    return createS3BucketProvider(normalized, workerS3ProviderOptions(normalized, binding.bucketId, capabilityStateForRecord(binding.deviceRecord)));
  } finally {
    plaintext.accessKeyId = "";
    plaintext.secretAccessKey = "";
    if (plaintext.sessionToken !== undefined) plaintext.sessionToken = "";
  }
}

/**
 * 带密码的冷启动：解开设备记录凭据、确认 `keys/` 已有钱包，再安装可写运行态。
 * 认证前零远端写入；失败不得降级为首次初始化。
 */
async function bootstrapColdStartAuthenticated(password: string, peerId?: string): Promise<void> {
  const binding = storageBootstrapState?.selectedBucket;
  if (!binding) throw storageUnavailableError("Storage bootstrap selection is unavailable");
  if (platformRootStore) return;
  let provider = await createRuntimeProvider(binding, password, peerId);
  let candidateOwned = true;
  try {
    const listed = await createKeyHoldRepository(provider).list();
    if (listed.keys.length === 0) {
      throw new StorageRuntimeError("storage_remote_not_initialized", "The remote storage namespace is not initialized");
    }
    if (testFailColdStartInstall) {
      testFailColdStartInstall = false;
      throw new StorageRuntimeError("storage_unavailable", "injected cold start install failure after authentication");
    }
    storageRootInstallationActive = true;
    try {
      await installPlatformStorage(provider, {
        bucketId: binding.bucketId,
        bucketGeneration: 1,
        provider: binding.backend,
      });
    } finally {
      storageRootInstallationActive = false;
    }
    storageBootstrapState = {
      ...(storageBootstrapState ?? { selectedBackend: binding.backend }),
      selectedBackend: binding.backend,
      selectedProfileId: binding.bucketId,
      selectedBucket: binding,
    };
    candidateOwned = false;
  } finally {
    if (candidateOwned) provider.dispose();
  }
}

/** 切换到另一个已登记桶：先验证目标 Key 密码，再抢 Key 锁并安装运行态。 */
async function switchSelectedRuntimeBucket(
  binding: StorageRuntimeBucketV1,
  password: string,
  peerId?: string,
  options: { keyPassword?: string; publicKeyHex?: string } = {},
): Promise<StorageBucketSwitchResultV1> {
  if (!binding || typeof binding !== "object" || !binding.bucketId) throw new StorageRuntimeError("storage_provider_error", "Switch bucket binding is invalid");
  const provider = await createRuntimeProvider(binding, password, peerId);
  const repository = createKeyHoldRepository(provider);
  let adopted = false;
  try {
    const listed = await repository.list();
    if (listed.keys.length === 0) throw new StorageRuntimeError("storage_remote_not_initialized", "The remote storage namespace is not initialized");
    const session = await ensureWorkerSession(peerId);
    const requested = options.publicKeyHex?.toLowerCase();
    if (requested !== undefined && !listed.keys.some((key) => key.publicKeyHex.toLowerCase() === requested)) {
      throw new StorageRuntimeError("storage_not_found", "The selected Key does not exist in this bucket");
    }
    const publicKeyHex = requested
      ?? (session.activeKey !== undefined && listed.keys.some((key) => key.publicKeyHex === session.activeKey)
        ? session.activeKey
        : listed.keys[0]!.publicKeyHex);
    const keyPassword = options.keyPassword ?? password;
    // 先在临时 Provider 上验证目标 Key 密码。验证失败时当前运行态、桶
    // 目录和 session 都没有被触碰，用户可以安全重试或取消。
    const verification = await repository.unlock(publicKeyHex, keyPassword);
    verification.privateKeyBytes.fill(0);
    if (platformRootStore) {
      await performGlobalLock("switch-bucket");
      discardCurrentPlatformStorageBinding();
    }
    storageRootInstallationActive = true;
    try {
      await installPlatformStorage(provider, { bucketId: binding.bucketId, bucketGeneration: 1, provider: binding.backend });
    } finally {
      storageRootInstallationActive = false;
    }
    adopted = true;
    storageBootstrapState = { selectedBackend: binding.backend, selectedProfileId: binding.bucketId, selectedBucket: binding };
    // 跨桶切换后必须重建 Storage 运行态：顶栏/桶管理页切换不会刷新页面，
    // 缺少 storageController 时 storage.state 的 status 会停在 checking，
    // 存储守卫会把用户挡在业务页外。
    storageController = undefined;
    await ensureStorageRuntime(peerId);
    await writeWorkerSession({ ...session, activeBucketId: binding.bucketId, activeKey: publicKeyHex }, peerId);
    const lock = createKeyLock(provider, { ownerPublicKeyHex: publicKeyHex, holder: session.sessionId });
    await lock.acquire();
    installActiveKeyLock(lock);
    const unlocked = await repository.unlock(publicKeyHex, keyPassword);
    const privateKeyBytes = unlocked.privateKeyBytes;
    unlocked.privateKeyBytes = new Uint8Array(0);
    await enterUnlockedState(publicKeyHex, privateKeyBytes, "unlock");
    storageHealthController.setStatus("ready");
    emitStorageState();
    return { ok: true, bucket: binding, vaultUnlocked: true };
  } finally {
    if (!adopted && platformBucketProvider !== provider) provider.dispose();
  }
}

/** 更新当前桶的连接配置：重封设备记录密文并重建运行态。 */
async function changeRuntimeBucketConnection(
  config: StorageBucketConnectionConfigV1,
  label: string | undefined,
  password: string,
  peerId?: string,
): Promise<StorageRuntimeBucketV1> {
  const binding = selectedCatalogBucket();
  if (!binding) throw new StorageRuntimeError("storage_unavailable", "The current runtime bucket is not available");
  if (config.kind !== binding.backend) throw new StorageRuntimeError("storage_provider_error", "Storage bucket backend cannot be changed in-place");
  const displayName = (label?.trim() || binding.label || binding.bucketId);
  if (displayName.length > 128) throw new StorageRuntimeError("storage_provider_error", "Storage bucket label is invalid");
  const built = await buildDeviceRecordForConnection({
    connection: config,
    remoteStorageId: binding.bucketId,
    displayName,
    password,
    keyDerivation: binding.keyDerivation,
  });
  const next = runtimeBinding({
    remoteStorageId: binding.bucketId,
    backend: binding.backend,
    displayName,
    record: built.record,
    ...(built.keyDerivation === undefined ? {} : { keyDerivation: built.keyDerivation }),
  });
  await performGlobalLock("change-bucket-config");
  discardCurrentPlatformStorageBinding();
  const nextProvider = await createRuntimeProvider(next, password, peerId);
  let adopted = false;
  try {
    await installPlatformStorage(nextProvider, { bucketId: next.bucketId, bucketGeneration: 1, provider: next.backend });
    adopted = true;
    await putDeviceRecord(next.bucketId, built.record, true, peerId);
    const session = await ensureWorkerSession(peerId);
    await writeWorkerSession({
      ...session,
      activeBucketId: next.bucketId,
      ...(built.keyDerivation === undefined ? {} : { keyDerivation: built.keyDerivation }),
    }, peerId);
    storageBootstrapState = { selectedBackend: next.backend, selectedProfileId: next.bucketId, selectedBucket: next };
    storageHealthController.setStatus("ready");
    emitStorageState();
    return next;
  } finally {
    if (!adopted && platformBucketProvider !== nextProvider) nextProvider.dispose();
  }
}

/**
 * 删除非当前 Local 桶中的一把 Key：KeyHold 文件 + 该 Key 的 owner 数据。
 *
 * Local 桶数据就在本机 localStorage，不需要桶密码；但当前运行态桶不能走
 * 这条路径（必须走 keyspace.deleteKey 取消任务、关闭句柄并修复 active）。
 */
async function deleteLocalBucketKey(
  binding: StorageRuntimeBucketV1,
  publicKeyHexInput: string,
  peerId?: string,
): Promise<void> {
  const publicKeyHex = publicKeyHexInput.toLowerCase();
  if (binding.backend !== "local") {
    throw new StorageRuntimeError("storage_forbidden", "Only local bucket keys can be deleted without an active session");
  }
  if (selectedCatalogBucket()?.bucketId === binding.bucketId) {
    throw new StorageRuntimeError("storage_conflict", "The current bucket key must be deleted through keyspace.deleteKey");
  }
  const provider = await createRuntimeProvider(binding, "", peerId);
  try {
    const repository = createKeyHoldRepository(provider);
    const listed = await repository.list();
    const target = listed.keys.find((key) => key.publicKeyHex.toLowerCase() === publicKeyHex);
    if (!target) throw new StorageRuntimeError("storage_not_found", "Key not found");
    const file = await repository.read(target.publicKeyHex);
    await repository.delete(target.publicKeyHex, file?.etag);
    // 一 Key 一文件：删除 KeyHold 后清掉该 Key 的 owner namespace 数据
    // （含 lock.json 与全部业务 K-V），避免留下无归属数据。
    const root = createPlatformRootStore({
      provider,
      bucket: { bucketId: binding.bucketId, bucketGeneration: 1, provider: binding.backend },
    });
    await root.deleteOwnerStorage({ ownerPublicKeyHex: publicKeyHex });
  } finally {
    provider.dispose();
  }
}

/** 修改当前桶显示名；只更新设备记录，不触碰 Provider 与 Key。 */
async function renameRuntimeBucket(label: string, peerId?: string): Promise<StorageRuntimeBucketV1> {
  const binding = selectedCatalogBucket();
  if (!binding) throw new StorageRuntimeError("storage_unavailable", "The current runtime bucket is not available");
  const trimmed = label.trim();
  if (!trimmed || trimmed.length > 128) throw new StorageRuntimeError("storage_provider_error", "Storage bucket label is invalid");
  const record: DeviceRecordV1 = { ...binding.deviceRecord, displayName: trimmed } as DeviceRecordV1;
  await putDeviceRecord(binding.bucketId, record, true, peerId);
  const next: StorageRuntimeBucketV1 = { ...binding, label: trimmed, deviceRecord: record };
  storageBootstrapState = { ...(storageBootstrapState ?? { selectedBackend: next.backend }), selectedBackend: next.backend, selectedProfileId: next.bucketId, selectedBucket: next };
  emitStorageState();
  return next;
}

/** Storage-first：先验证抽象桶，再打开 keys/ 与平台状态区。 */
async function bootstrapPlatformStorage(profilePassword?: string, peerId?: string): Promise<void> {
  // 冷启动/恢复的第一步也可能打开 Provider；必须先取得跨物理 Worker
  // authority，不能因为当前还没有 Root 就绕过 authority lock。
  await ensureCoordinatorAuthorityClaim();
  if (platformRootStore) return;
  const binding = storageBootstrapState?.selectedBucket;
  if (!binding) throw storageUnavailableError("Storage bootstrap selection is unavailable");
  if (binding.backend === "s3" && !profilePassword) {
    storageHealthController.setStatus("authentication", "Startup password is required");
    emitStorageState();
    throw Object.assign(new Error("Startup password is required"), { code: "storage_identity_required" });
  }
  await bootstrapColdStartAuthenticated(profilePassword ?? "", peerId);
}

/** 冷启动候选 Provider：只解密设备连接，不触碰远端。 */
type InitialSetupFailure = Extract<InitialSetupResult, { ok: false }>;
type InitialSetupPhase = NonNullable<InitialSetupFailure["error"]["phase"]>;


/**
 * s3 桶的本机 ID 规则：
 *   - 名字形如 `bucket_<16 位小写 hex>`(随机 64 bit)；
 *   - 生成前逐条查本机设备记录,重复则重生成；
 *   - 同一物理位置(endpoint+region+bucket+prefix)已有记录时**复用其 ID**,
 *     不产生第二条记录。
 *
 * 64 bit 的依据：设备记录上限 32 条,生日碰撞概率 ≈ 32²/2^65 ≈ 1.4e-17;
 * 叠加生成前查重后实际为零。
 */
const S3_BUCKET_ID_PREFIX = "bucket_";
const S3_BUCKET_ID_BYTES = 8;

function normalizeS3LocationPart(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\/+$/u, "");
}

function sameS3PhysicalLocation(
  left: Extract<DeviceLocationV1, { providerId: "s3" }>,
  right: Extract<DeviceLocationV1, { providerId: "s3" }>,
): boolean {
  return normalizeS3LocationPart(left.endpoint) === normalizeS3LocationPart(right.endpoint)
    && normalizeS3LocationPart(left.region) === normalizeS3LocationPart(right.region)
    && normalizeS3LocationPart(left.bucket) === normalizeS3LocationPart(right.bucket)
    && (left.prefix ?? "").replace(/^\/+|\/+$/gu, "") === (right.prefix ?? "").replace(/^\/+|\/+$/gu, "");
}

/** 解析 s3 桶的本机 ID：同物理位置复用,否则随机生成并查重。 */
async function resolveS3BucketStorageId(connection: StorageBucketConnectionConfigV1, peerId?: string): Promise<string> {
  if (connection.kind !== "s3") throw new StorageRuntimeError("storage_provider_error", "S3 bucket ID requires an s3 connection");
  const location = deviceLocationFromConnection(connection, "");
  if (location.providerId !== "s3") throw new StorageRuntimeError("storage_provider_error", "S3 bucket ID requires an s3 location");
  const listed = await requestLocalStorageBridge({ type: "device-record-list" }, peerId);
  if (listed.type !== "device-records") throw new StorageRuntimeError("storage_unavailable", "Device record bridge returned an invalid list result");
  const existing = listed.entries.find((entry) => entry.record.location.providerId === "s3" && sameS3PhysicalLocation(entry.record.location, location));
  if (existing) return existing.remoteStorageId;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = S3_BUCKET_ID_PREFIX + bytesToHex(crypto.getRandomValues(new Uint8Array(S3_BUCKET_ID_BYTES))).toLowerCase();
    const found = await requestLocalStorageBridge({ type: "device-record-get", remoteStorageId: id }, peerId);
    if (found.type !== "device-record") throw new StorageRuntimeError("storage_unavailable", "Device record bridge returned an invalid read result");
    if (!found.record) return id;
  }
  throw new StorageRuntimeError("storage_provider_error", "Failed to allocate a unique S3 bucket ID");
}

function initialSetupBucketId(transactionId: string): string {
  // transactionId 是外部契约输入，不能通过有损替换/截断映射到物理命名空间；
  // 完整 SHA-256 保留确定性，同时把碰撞概率降到密码学可接受范围。
  const digest = bytesToHex(sha256Bytes(new TextEncoder().encode("keymaster.initial-setup-bucket.v1:" + transactionId)));
  return "setup-" + digest;
}

function deviceLocationFromConnection(connection: StorageBucketConnectionConfigV1, remoteStorageId: string): DeviceLocationV1 {
  if (connection.kind === "local") return { providerId: "local" };
  const normalized = normalizeProviderConfig({
    providerId: "s3-compatible",
    connection: {
      endpoint: connection.endpoint,
      region: connection.region,
      bucket: connection.bucket,
      ...(connection.prefix === undefined ? {} : { prefix: connection.prefix }),
      ...(connection.sessionToken === undefined ? {} : { sessionToken: connection.sessionToken }),
      forcePathStyle: connection.forcePathStyle === true,
    },
    credentials: {
      mode: "replace",
      accessKeyId: connection.accessKeyId,
      secretAccessKey: connection.secretAccessKey,
    },
  });
  const target = normalized.connection as {
    endpoint: string;
    region: string;
    bucket: string;
    prefix?: string;
    forcePathStyle?: boolean;
  };
  const prefix = target.prefix?.replace(/^\/+|\/+$/gu, "");
  return {
    providerId: "s3",
    endpoint: target.endpoint,
    region: target.region,
    bucket: target.bucket,
    ...(!prefix ? {} : { prefix }),
    ...(target.forcePathStyle === undefined ? {} : { forcePathStyle: target.forcePathStyle }),
  };
}

function validateInitialSetupPlan(plan: InitialSetupPlan): void {
  if (!plan || typeof plan !== "object") throw new StorageRuntimeError("storage_provider_error", "Initial setup plan is invalid");
  if (!/^[A-Za-z0-9._:-]{8,128}$/u.test(plan.transactionId)) throw new StorageRuntimeError("storage_provider_error", "Initial setup transaction ID is invalid");
  if (!plan.bucketLabel.trim() || plan.bucketLabel.trim().length > 128) throw new StorageRuntimeError("storage_provider_error", "Initial setup bucket label is invalid");
  if (plan.backend !== "local" && plan.backend !== "s3") throw new StorageRuntimeError("storage_provider_error", "Initial setup backend is invalid");
  if (plan.connection.kind !== plan.backend) throw new StorageRuntimeError("storage_provider_error", "Initial setup connection backend is inconsistent");
  // 两个密码域：s3 必须有启动密码；local 不设启动密码。首 Key 的密码始终必填。
  if (plan.connection.kind === "s3") {
    if (typeof plan.startupPassword !== "string" || plan.startupPassword.length < 8) throw new StorageRuntimeError("storage_identity_required", "Startup password must contain at least 8 characters");
  } else if (plan.startupPassword !== undefined && plan.startupPassword.length > 0) {
    throw new StorageRuntimeError("storage_provider_error", "Local buckets must not set a startup password");
  }
  // Local 桶 ID 由 Worker 随机生成；页面显式传入时仍校验格式并复用。
  if (plan.connection.kind === "local" && plan.remoteStorageId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(plan.remoteStorageId)) {
    throw new StorageRuntimeError("storage_provider_error", "Local bucket namespace is invalid");
  }
  if (!plan.firstKey || (plan.firstKey.kind !== "generate" && plan.firstKey.kind !== "import")) throw new StorageRuntimeError("storage_provider_error", "Initial setup Key kind is invalid");
  if (typeof plan.firstKey.label !== "string" || !plan.firstKey.label.trim() || plan.firstKey.label.trim().length > 128) throw new StorageRuntimeError("storage_provider_error", "Initial setup Key label is invalid");
  if (typeof plan.firstKey.password !== "string" || plan.firstKey.password.length < 8) throw new StorageRuntimeError("storage_identity_required", "Key password must contain at least 8 characters");
  if (!Array.isArray(plan.firstKey.capabilities) || plan.firstKey.capabilities.length === 0 || !plan.firstKey.capabilities.every((value) => typeof value === "string" && value.length > 0 && value.length <= 64)) {
    throw new StorageRuntimeError("storage_provider_error", "Initial setup Key capabilities are invalid");
  }
  if (plan.connection.kind === "s3") {
    if (!plan.connection.endpoint || !plan.connection.region || !plan.connection.bucket || !plan.connection.accessKeyId || !plan.connection.secretAccessKey) {
      throw new StorageRuntimeError("storage_provider_error", "Initial setup S3 connection is incomplete");
    }
    try {
      const endpoint = new URL(plan.connection.endpoint);
      if (endpoint.protocol !== "https:") throw new Error();
    } catch {
      throw new StorageRuntimeError("storage_provider_error", "Initial setup S3 endpoint must be HTTPS");
    }
  }
  if (plan.firstKey.kind === "import") {
    if (!plan.firstKey.material || typeof plan.firstKey.material.hex !== "string" || !/^[0-9a-f]{64}$/iu.test(plan.firstKey.material.hex)) throw new StorageRuntimeError("storage_provider_error", "Initial setup imported Key material is invalid");
    if (plan.firstKey.material.wif !== undefined && typeof plan.firstKey.material.wif !== "string") throw new StorageRuntimeError("storage_provider_error", "Initial setup imported WIF material is invalid");
    if (typeof plan.firstKey.format !== "string" || !plan.firstKey.format.trim() || plan.firstKey.format.length > 128) throw new StorageRuntimeError("storage_provider_error", "Initial setup imported Key format is invalid");
  }
}

function initialSetupKeyFormat(firstKey: InitialSetupFirstKey): string {
  return firstKey.kind === "generate" ? "generated-secp256k1" : firstKey.format;
}

function initialSetupErrorCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && code.startsWith("storage_") ? code : "initial_setup_failed";
}

function initialSetupFailure(
  phase: InitialSetupPhase,
  error: unknown,
  rollback: InitialSetupFailure["error"]["rollback"],
  transactionId?: string,
  details?: unknown,
): InitialSetupFailure {
  const code = initialSetupErrorCode(error);
  const incidentId = `initial-${randomIdentifierSuffix()}`;
  const message = error instanceof Error ? error.message : "Initial setup failed";
  const summary = rollback === "confirmed"
    ? "初始化未完成，本次暂存数据已回滚，可以修改表单后重试。"
    : rollback === "unconfirmed"
      ? "初始化未完成，清理结果尚未确认；请先重试清理，不要继续进入业务页面。"
      : "初始化尚未完成，当前没有可用的完整运行态。";
  return {
    ok: false,
    error: {
      title: "无法完成初始化",
      summary,
      action: rollback === "unconfirmed" ? "检查存储权限或网络后重试清理。" : "检查参数和存储权限后重试。",
      code,
      incidentId,
      ...(transactionId === undefined ? {} : { transactionId }),
      phase,
      rollback,
      diagnostic: buildDiagnosticText({
        phase,
        code,
        incidentId,
        rollback,
        occurredAt: new Date().toISOString(),
        redactionVersion: "diagnostic-v2",
        message,
        details: details ?? { error: message },
      }),
    },
  };
}

async function privateKeyForInitialSetup(firstKey: InitialSetupFirstKey): Promise<Uint8Array> {
  const privateKey = firstKey.kind === "generate"
    ? cryptoHexToBytes(generateValidPrivateKeyHex())
    : cryptoHexToBytes(firstKey.material.hex);
  try {
    if (privateKey.byteLength !== 32) throw new Error("Private key must contain 32 bytes");
    // getPublicKey 同时验证曲线标量范围；不把无效导入材料写入候选桶。
    (await import("@noble/curves/secp256k1.js")).secp256k1.getPublicKey(privateKey, true);
    return privateKey;
  } catch (error) {
    privateKey.fill(0);
    throw new StorageRuntimeError("storage_provider_error", error instanceof Error ? error.message : "Initial setup private key is invalid");
  }
}

/**
 * 首次初始化事务：Hold、Vault/index、Root 暂存完成后，最后才提交目录引用。
 * 该函数只被 storage.control 的 initial-setup 调用，页面不得复制这条编排。
 */
/**
 * 解析初始化/接入计划的本机桶 ID。
 *
 * - 显式提供时直接使用；
 * - Local 桶：物理命名空间就是设备记录 ID,按事务 ID 派生随机桶 ID；
 * - S3 桶：本机逻辑身份按物理位置复用/随机分配,必须与事务安装阶段
 *   使用同一个值,否则 Provider 与 Root 的 bucketId 会不一致。
 */
async function resolvePlanRemoteStorageId(
  plan: { transactionId: string; connection: StorageBucketConnectionConfigV1; remoteStorageId?: string },
  peerId?: string,
): Promise<string> {
  if (plan.remoteStorageId !== undefined) return plan.remoteStorageId;
  return plan.connection.kind === "local"
    ? initialSetupBucketId(plan.transactionId)
    : await resolveS3BucketStorageId(plan.connection, peerId);
}

/** 由初始化/接入计划创建 Provider；凭据只在本调用内存中存在。 */
async function createPlanProvider(plan: { transactionId: string; connection: StorageBucketConnectionConfigV1; remoteStorageId?: string }, peerId?: string): Promise<StorageBucketProvider> {
  const remoteStorageId = await resolvePlanRemoteStorageId(plan, peerId);
  if (plan.connection.kind === "local") {
    const bridgeState = createCoordinatorLocalStorageBridgeState(peerId);
    const provider = createLocalStorageBucketProvider({
      bucketId: remoteStorageId,
      bucketGeneration: 1,
      bridge: (request) => requestLocalStorageBridge(request, bridgeState.targetPeerId()),
    });
    coordinatorLocalStorageProviderPublishers.set(provider, bridgeState.publish);
    return provider;
  }
  const normalized: WorkerS3ProviderConfig = {
    version: 1,
    providerId: "s3-compatible",
    connection: {
      endpoint: plan.connection.endpoint,
      region: plan.connection.region,
      bucket: plan.connection.bucket,
      forcePathStyle: plan.connection.forcePathStyle === true,
      ...(plan.connection.sessionToken === undefined ? {} : { sessionToken: plan.connection.sessionToken }),
      ...(plan.connection.prefix === undefined ? {} : { prefix: plan.connection.prefix }),
    },
    credentials: { kind: "access-key", accessKeyId: plan.connection.accessKeyId, secretAccessKey: plan.connection.secretAccessKey },
  };
  try {
    return createS3BucketProvider(normalized, workerS3ProviderOptions(normalized, remoteStorageId));
  } finally {
    normalized.credentials.accessKeyId = "";
    normalized.credentials.secretAccessKey = "";
  }
}

const activeKeyLock = { current: undefined as import("@keymaster/platform-storage/coordinator").KeyLock | undefined };

/** 安装新的 Key 锁并释放旧的；同一把 Key 同一时间只有一个浏览器持有。 */
function installActiveKeyLock(lock: import("@keymaster/platform-storage/coordinator").KeyLock): void {
  const previous = activeKeyLock.current;
  activeKeyLock.current = lock;
  // 切换 Key 按规范“先抢新锁,成功后再释放旧锁”；这里旧锁已被新锁替代。
  if (previous) void previous.release().catch(() => undefined);
}

/**
 * 浏览器 session 的 Worker 内存缓存（见《浏览器session》）。
 *
 * 选中 Key / 切换桶 / 连接桶都是低频固定动作：读取一次后常驻内存，每次
 * 写透 LocalStorage 再原地更新缓存；业务路径不再逐次反向读取页面。
 * Worker 重启（模块重载）后缓存丢失，下一次读取自然回到持久化 session。
 */
let workerSessionCache: KeymasterSessionV1 | undefined;
let workerSessionCacheLoaded = false;
let workerSessionMutationTail: Promise<unknown> = Promise.resolve();

function invalidateWorkerSessionCache(): void {
  workerSessionCache = undefined;
  workerSessionCacheLoaded = false;
}

/** 单元测试没有页面 LocalStorage bridge 时，用内存 session 夹具代替。 */
function useTestWorkerSession(): boolean {
  return testPlatformStores !== undefined && testLocalStorageBridgeOverride === undefined;
}

async function readWorkerSession(peerId?: string): Promise<KeymasterSessionV1 | undefined> {
  if (workerSessionCacheLoaded) return workerSessionCache;
  if (useTestWorkerSession()) {
    workerSessionCache = testWorkerSession ? structuredClone(testWorkerSession) : undefined;
    workerSessionCacheLoaded = true;
    return workerSessionCache;
  }
  const response = await requestLocalStorageBridge({ type: "session-read" }, peerId);
  if (response.type !== "session") throw storageUnavailableError("Session bridge returned an invalid read result");
  workerSessionCache = response.session;
  workerSessionCacheLoaded = true;
  return workerSessionCache;
}

async function writeWorkerSession(session: KeymasterSessionV1, peerId?: string): Promise<void> {
  const checked = validateKeymasterSession(session);
  if (useTestWorkerSession()) {
    testWorkerSession = structuredClone(checked);
    workerSessionCache = structuredClone(checked);
    workerSessionCacheLoaded = true;
    return;
  }
  const response = await requestLocalStorageBridge({ type: "session-write", session: checked }, peerId);
  if (response.type !== "void") throw storageUnavailableError("Session bridge returned an invalid write result");
  workerSessionCache = checked;
  workerSessionCacheLoaded = true;
}

async function ensureWorkerSession(peerId?: string): Promise<KeymasterSessionV1> {
  const existing = await readWorkerSession(peerId);
  if (existing) return existing;
  const session = createKeymasterSession(generateSessionId());
  await writeWorkerSession(session, peerId);
  return session;
}

/**
 * 把「当前选中 Key」收敛到 session.activeKey（浏览器本地真值）。
 *
 * 只有值变化时才写透一次；`activeKey` 必须与 `activeBucketId` 成对，
 * 因此未选桶时不落盘。多次变更通过串行尾链提交，避免读-改-写互相覆盖。
 */
function updateWorkerSessionSelection(selectedPublicKeyHex: string | undefined, peerId?: string): Promise<void> {
  const run = workerSessionMutationTail.then(async () => {
    if (selectedPublicKeyHex === undefined) {
      const current = await readWorkerSession(peerId);
      if (!current?.activeKey) return;
      const { activeKey: _activeKey, ...rest } = current;
      await writeWorkerSession(rest, peerId);
      return;
    }
    const nextKey = selectedPublicKeyHex.toLowerCase();
    const current = await ensureWorkerSession(peerId);
    if (current.activeKey === nextKey) return;
    if (current.activeBucketId === undefined) return;
    await writeWorkerSession({ ...current, activeKey: nextKey }, peerId);
  });
  workerSessionMutationTail = run.catch(() => undefined);
  return run;
}

async function putDeviceRecord(remoteStorageId: string, record: DeviceRecordV1, replace: boolean, peerId?: string): Promise<void> {
  const response = await requestLocalStorageBridge({ type: "device-record-put", remoteStorageId, record, replace }, peerId);
  if (response.type !== "void") throw storageUnavailableError("Device record bridge returned an invalid write result");
}

/**
 * 把一次成功的条件写探测结果写回设备记录（整记录替换，保留其它字段）。
 * 已登记桶专用；未登记桶的探测结果由页面放入提交计划。
 */
async function updateDeviceRecordCapabilities(
  remoteStorageId: string,
  conditionalWrites: "native" | "best-effort",
  peerId?: string,
): Promise<void> {
  const response = await requestLocalStorageBridge({ type: "device-record-get", remoteStorageId }, peerId);
  if (response.type !== "device-record" || !response.record) return;
  const record = response.record;
  if (record.location.providerId !== "s3") return;
  const s3Record = record as Extract<DeviceRecordV1, { location: { providerId: "s3" } }>;
  if (s3Record.capabilities?.conditionalWrites === conditionalWrites) return;
  await putDeviceRecord(remoteStorageId, { ...s3Record, capabilities: { conditionalWrites } }, true, peerId);
}

function generateSessionKeyDerivation(): KeymasterSessionKeyDerivationV1 {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return {
    algorithm: "pbkdf2-hmac-sha-256",
    passwordEncoding: "utf-8",
    iterations: KEYMASTER_SESSION_RECOMMENDED_ITERATIONS,
    outputLengthBits: 256,
    saltB64Url: encodeBase64Url(salt),
  };
}

/** 生成设备记录：local 只有公开坐标；s3 用启动密码与 session KDF 封存凭据。 */
async function buildDeviceRecordForConnection(input: {
  connection: StorageBucketConnectionConfigV1;
  remoteStorageId: string;
  displayName: string;
  password: string;
  keyDerivation: KeymasterSessionKeyDerivationV1 | undefined;
  /** 页面探测阶段得到的条件写能力；缺失表示尚未探测。 */
  capabilities?: InitialSetupPlan["capabilities"];
}): Promise<{ record: DeviceRecordV1; keyDerivation?: KeymasterSessionKeyDerivationV1 }> {
  const location = deviceLocationFromConnection(input.connection, input.remoteStorageId);
  if (location.providerId === "local") {
    return { record: { format: "keymaster.device", version: 1, displayName: input.displayName, location } };
  }
  if (input.connection.kind !== "s3") throw new StorageRuntimeError("storage_provider_error", "S3 device record requires an s3 connection");
  const keyDerivation = input.keyDerivation ?? generateSessionKeyDerivation();
  const cipher = await encryptDeviceConfig({
    password: input.password,
    keyDerivation,
    location,
    plaintext: {
      endpoint: input.connection.endpoint,
      region: input.connection.region,
      bucket: input.connection.bucket,
      accessKeyId: input.connection.accessKeyId,
      secretAccessKey: input.connection.secretAccessKey,
      ...(input.connection.sessionToken === undefined ? {} : { sessionToken: input.connection.sessionToken }),
      ...(input.connection.prefix === undefined ? {} : { prefix: input.connection.prefix }),
      ...(input.connection.forcePathStyle === undefined ? {} : { forcePathStyle: input.connection.forcePathStyle }),
    },
  });
  return {
    record: {
      format: "keymaster.device",
      version: 1,
      displayName: input.displayName,
      location,
      cipher,
      ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
    },
    keyDerivation,
  };
}

function runtimeBinding(input: {
  remoteStorageId: string;
  backend: "local" | "s3";
  displayName: string;
  record: DeviceRecordV1;
  keyDerivation?: KeymasterSessionKeyDerivationV1;
}): StorageRuntimeBucketV1 {
  return {
    bucketId: input.remoteStorageId,
    backend: input.backend,
    label: input.displayName,
    deviceRecord: input.record,
    ...(input.keyDerivation === undefined ? {} : { keyDerivation: input.keyDerivation }),
  };
}

function initialSetupKeyResult(publicKeyHex: string, plan: InitialSetupPlan): InitialSetupKeyResult {
  return {
    publicKeyHex,
    label: plan.firstKey.label.trim(),
    address: deriveP2pkhAddress(publicKeyHex, "main"),
    format: initialSetupKeyFormat(plan.firstKey),
    capabilities: [...plan.firstKey.capabilities],
    createdAt: new Date().toISOString(),
    ...(plan.firstKey.kind === "import" && plan.firstKey.source !== undefined ? { source: plan.firstKey.source } : {}),
  };
}

/**
 * 首次建桶：抢新 Key 锁 → 写 `keys/<公钥>.keyhold` → 写 `keymaster.device.<ID>`
 * 与 session → 安装平台运行态。失败不回滚已写好的 KeyHold 文件：用户可以
 * 用同一 Key 密码重新接入；这比删除用户私钥更安全。
 */
async function executeInitialSetupTransaction(plan: InitialSetupPlan, peerId?: string): Promise<InitialSetupResult> {
  validateInitialSetupPlan(plan);
  // 已初始化时允许"新建桶并切换"（桶管理页入口）：新桶的 KeyHold、设备
  // 记录与 session 先完整写入，安装阶段才锁定并替换旧运行态。失败不会
  // 删除已写好的新桶数据，用户可用同一 Key 密码重新接入。
  // 页面不要求提供桶 ID：统一走 resolvePlanRemoteStorageId,保证 Provider
  // 与安装阶段使用同一个本机桶 ID。
  const remoteStorageId = await resolvePlanRemoteStorageId(plan, peerId);
  const displayName = plan.bucketLabel.trim();
  if (plan.connection.kind === "local") {
    // 本机已登记同 ID 桶时不能再建：请走解锁/切换路径。
    const existing = await requestLocalStorageBridge({ type: "device-record-get", remoteStorageId }, peerId);
    if (existing.type !== "device-record") throw new StorageRuntimeError("storage_unavailable", "Device record bridge returned an invalid read result");
    if (existing.record) throw new StorageRuntimeError("storage_conflict", "A bucket with this namespace is already registered on this device");
    // 页面已做同名检查；Worker 侧再按设备记录兜底，避免绕过页面写入重名桶。
    const listed = await requestLocalStorageBridge({ type: "device-record-list" }, peerId);
    if (listed.type !== "device-records") throw new StorageRuntimeError("storage_unavailable", "Device record bridge returned an invalid list result");
    if (listed.entries.some((entry) => (entry.record.displayName ?? "").trim() === displayName)) {
      throw new StorageRuntimeError("storage_conflict", "A bucket with this name is already registered on this device");
    }
  }
  let provider: StorageBucketProvider | undefined;
  let privateKey: Uint8Array | undefined;
  let lock: import("@keymaster/platform-storage/coordinator").KeyLock | undefined;
  try {
    provider = await createPlanProvider({ ...plan, remoteStorageId }, peerId);
    privateKey = await privateKeyForInitialSetup(plan.firstKey);
    const publicKeyHex = bytesToHex((await import("@noble/curves/secp256k1.js")).secp256k1.getPublicKey(privateKey, true)).toLowerCase();
    const repository = createKeyHoldRepository(provider);
    // 规范顺序：先抢新 Key 的应用锁,再写 keys/<公钥>.keyhold。
    const session = await ensureWorkerSession(peerId);
    lock = createKeyLock(provider, { ownerPublicKeyHex: publicKeyHex, holder: session.sessionId });
    await lock.acquire();
    const created = await repository.create({ label: plan.firstKey.label.trim(), privateKeyBytes: privateKey, password: plan.firstKey.password });
    if (created.document.publicKeyHex !== publicKeyHex) throw new StorageRuntimeError("storage_provider_error", "Initial setup Key public key mismatch");
    const built = await buildDeviceRecordForConnection({
      connection: plan.connection,
      remoteStorageId,
      displayName,
      password: plan.startupPassword ?? "",
      keyDerivation: session.keyDerivation,
      ...(plan.capabilities === undefined ? {} : { capabilities: plan.capabilities }),
    });
    await putDeviceRecord(remoteStorageId, built.record, false, peerId);
    await writeWorkerSession({
      ...session,
      activeBucketId: remoteStorageId,
      activeKey: publicKeyHex,
      ...(built.keyDerivation === undefined ? {} : { keyDerivation: built.keyDerivation }),
    }, peerId);
    const binding = runtimeBinding({ remoteStorageId, backend: plan.backend, displayName, record: built.record, ...(built.keyDerivation === undefined ? {} : { keyDerivation: built.keyDerivation }) });
    // 已有运行态时先全局锁定并卸下旧绑定，再把新桶安装为当前运行态；
    // 此时新桶数据已完整落盘，安装失败也不会破坏旧桶数据。
    if (platformRootStore) {
      await performGlobalLock("initial-setup");
      discardCurrentPlatformStorageBinding();
    }
    storageRootInstallationActive = true;
    try {
      await installPlatformStorage(provider, { bucketId: remoteStorageId, bucketGeneration: 1, provider: plan.backend });
    } finally {
      storageRootInstallationActive = false;
    }
    storageBootstrapState = { selectedBackend: binding.backend, selectedProfileId: binding.bucketId, selectedBucket: binding };
    // 初始创建后装配 Storage 运行态并发布 ready：否则页面停留在初始化向导,
    // 只有刷新走冷启动才会看到就绪状态。
    storageController = undefined;
    await ensureStorageRuntime(peerId);
    await ensureCoordinatorTasksRegistered();
    coordinatorState.keyspaceGeneration += 1;
    coordinatorState.sessionEpoch = generateEpoch();
    coordinatorState.vaultStatus = "uninitialized";
    coordinatorState.activePublicKeyHex = undefined;
    storageHealthController.setStatus("ready");
    storageStartupFailure = false;
    emitStorageState();
    installActiveKeyLock(lock);
    lock = undefined;
    const activePrivateKeyBytes = privateKey;
    privateKey = undefined;
    await enterUnlockedState(publicKeyHex, activePrivateKeyBytes, plan.firstKey.kind === "import" ? "import-initial-key" : "create-initial-key");
    return { ok: true, bucket: binding, firstKey: initialSetupKeyResult(publicKeyHex, plan) };
  } finally {
    lock?.dispose();
    privateKey?.fill(0);
    if (provider && platformBucketProvider !== provider) provider.dispose();
  }
}

/** 校验接入已有远端的计划。 */
function validateExistingRemoteStorageConnectPlan(plan: ExistingRemoteStorageConnectPlan): void {
  if (!plan || typeof plan !== "object") throw new StorageRuntimeError("storage_provider_error", "Existing remote connect plan is invalid");
  if (!/^[A-Za-z0-9._:-]{8,128}$/u.test(plan.operationId)) throw new StorageRuntimeError("storage_provider_error", "Existing remote operation ID is invalid");
  if (plan.backend === "local") {
    if (typeof plan.remoteStorageId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(plan.remoteStorageId)) throw new StorageRuntimeError("storage_provider_error", "Local bucket namespace is invalid");
  } else if (plan.remoteStorageId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(plan.remoteStorageId)) {
    throw new StorageRuntimeError("storage_provider_error", "Existing remote storage ID is invalid");
  }
  if (!plan.displayName.trim() || plan.displayName.trim().length > 128) throw new StorageRuntimeError("storage_provider_error", "Existing remote display name is invalid");
  if (plan.backend !== "local" && plan.backend !== "s3") throw new StorageRuntimeError("storage_provider_error", "Existing remote backend is invalid");
  if (plan.connection.kind !== plan.backend) throw new StorageRuntimeError("storage_provider_error", "Existing remote connection backend is inconsistent");
  if (typeof plan.keyPassword !== "string" || plan.keyPassword.length < 8) throw new StorageRuntimeError("storage_identity_required", "Key password must contain at least 8 characters");
  if (plan.connection.kind === "s3") {
    if (typeof plan.startupPassword !== "string" || plan.startupPassword.length < 8) throw new StorageRuntimeError("storage_identity_required", "Startup password must contain at least 8 characters");
  } else if (plan.startupPassword !== undefined && plan.startupPassword.length > 0) {
    throw new StorageRuntimeError("storage_provider_error", "Local buckets must not set a startup password");
  }
  if (plan.connection.kind === "s3" && (!plan.connection.endpoint || !plan.connection.region || !plan.connection.bucket || !plan.connection.accessKeyId || !plan.connection.secretAccessKey)) {
    throw new StorageRuntimeError("storage_provider_error", "Existing remote S3 connection is incomplete");
  }
}

/**
 * 只读探测：连接目标桶并列出 \`keys/\` 目录。
 *
 * 判定规则（KeymasterFormats《初始化流程》）：
 *   - 至少一份可解析 KeyHold 文件 → has-keys（进入解锁）；
 *   - 目录不存在/为空 → empty（进入创建）；
 *   - 读取失败（网络/权限/损坏） → 返回错误,只允许重试,绝不当作空桶。
 * 探测不加锁、不写任何对象。
 */
async function executeBucketProbe(plan: import("@keymaster/contracts").BucketProbePlan, peerId?: string): Promise<import("@keymaster/contracts").BucketProbeResult> {
  try {
    // 探测是只读的,已初始化时也允许：桶管理页用它来连接已有桶。
    // Local 新建探测不要求页面提供桶 ID：命名空间按操作 ID 派生；管理页
    // 连接已有桶时仍会显式传入 remoteStorageId。
    //
    // 已登记桶（plan.binding）直接用设备记录 + 启动密码建立只读连接；
    // S3 凭据密文只在本次探测内解密，结束后 Provider 立即释放。
    let provider: StorageBucketProvider;
    if (plan.binding) {
      provider = await createRuntimeProvider(plan.binding, plan.password, peerId);
    } else {
      if (!plan.connection) throw new StorageRuntimeError("storage_provider_error", "Probe connection is required");
      if (plan.connection.kind !== plan.backend) throw new StorageRuntimeError("storage_provider_error", "Probe connection backend is inconsistent");
      provider = await createPlanProvider({
        transactionId: plan.operationId,
        connection: plan.connection,
        ...(plan.remoteStorageId === undefined ? {} : { remoteStorageId: plan.remoteStorageId }),
      }, peerId);
    }
    try {
      // S3 桶必须在读取 keys/ 前确认条件写能力：设备记录里已有探测结果时
      // 直接复用（不再发送写探针）；缺失或要求重新探测时才实测并写回。
      // 原生条件写优先；服务忽略条件头时降级为 best-effort（HEAD 后写入）。
      const isS3 = plan.binding ? plan.binding.backend === "s3" : plan.connection?.kind === "s3";
      let conditionalWrites: "native" | "best-effort" | undefined;
      if (isS3) {
        const cached = plan.binding && plan.binding.deviceRecord.location.providerId === "s3"
          ? (plan.binding.deviceRecord as Extract<DeviceRecordV1, { location: { providerId: "s3" } }>).capabilities?.conditionalWrites
          : undefined;
        if (!plan.forceReprobe && cached) {
          conditionalWrites = cached;
        } else {
          const probed = await provider.probe();
          if (!probed.ok || probed.conditionalWrites === "unsupported") {
            throw new StorageRuntimeError("storage_provider_error", "该桶无法提供可用的条件写入（原子或 best-effort 模拟）");
          }
          conditionalWrites = probed.conditionalWrites;
          // 已登记桶：探测结果写回设备记录；未登记桶把结果返回页面，由提交
          // 计划一并写入，避免提交时重复探测。
          if (plan.binding) await updateDeviceRecordCapabilities(plan.binding.bucketId, probed.conditionalWrites, peerId);
        }
      }
      const listed = await createKeyHoldRepository(provider).list();
      return listed.keys.length === 0
        ? { ok: true, state: "empty", ...(conditionalWrites === undefined ? {} : { conditionalWrites }) }
        : {
            ok: true,
            state: "has-keys",
            keys: listed.keys.map((key) => ({ publicKeyHex: key.publicKeyHex, label: key.label })),
            ...(conditionalWrites === undefined ? {} : { conditionalWrites }),
          };
    } finally {
      provider.dispose();
    }
  } catch (error) {
    return { ok: false, error: initialSetupFailure("validate", error instanceof Error ? error : new Error(String(error)), "not-started", plan.operationId).error };
  }
}

/** 生产"连接已有远端"入口：列出 `keys/`、用该 Key 自己的密码解锁，再写本机记录并接管运行态。 */
async function executeExistingRemoteStorageConnect(
  plan: ExistingRemoteStorageConnectPlan,
  peerId?: string,
): Promise<ExistingRemoteStorageConnectResult> {
  validateExistingRemoteStorageConnectPlan(plan);
  // 运行态已安装时允许连接第二个桶（桶管理页入口）：解锁成功后再切换运行态。
  // 只有“正在初始化但运行态未安装完成”的中间态才拒绝。
  if (!platformRootStore && storageBootstrapState?.selectedBucket) {
    return { ok: false, error: initialSetupFailure("validate", new StorageRuntimeError("storage_conflict", "Storage initialization is still in progress"), "not-started", plan.operationId).error };
  }
  let provider: StorageBucketProvider | undefined;
  let lock: import("@keymaster/platform-storage/coordinator").KeyLock | undefined;
  let unlocked: UnlockedKeyHold | undefined;
  try {
    const remoteStorageId = await resolvePlanRemoteStorageId({ transactionId: plan.operationId, connection: plan.connection, ...(plan.remoteStorageId === undefined ? {} : { remoteStorageId: plan.remoteStorageId }) }, peerId);
    provider = await createPlanProvider({
      transactionId: plan.operationId,
      connection: plan.connection,
      remoteStorageId,
    }, peerId);
    const repository = createKeyHoldRepository(provider);
    const listed = await repository.list();
    if (listed.keys.length === 0) throw new StorageRuntimeError("storage_remote_not_initialized", "The remote storage namespace is not initialized");
    const session = await ensureWorkerSession(peerId);
    const requested = plan.publicKeyHex?.toLowerCase();
    if (requested !== undefined && !listed.keys.some((key) => key.publicKeyHex.toLowerCase() === requested)) throw new StorageRuntimeError("storage_not_found", "The selected Key does not exist in this bucket");
    const publicKeyHex = requested
      ?? (session.activeKey !== undefined && listed.keys.some((key) => key.publicKeyHex === session.activeKey)
        ? session.activeKey
        : listed.keys[0]!.publicKeyHex);
    unlocked = await repository.unlock(publicKeyHex, plan.keyPassword);
    lock = createKeyLock(provider, { ownerPublicKeyHex: publicKeyHex, holder: session.sessionId });
    await lock.acquire();
    const built = await buildDeviceRecordForConnection({
      connection: plan.connection,
      remoteStorageId,
      displayName: plan.displayName,
      password: plan.startupPassword ?? "",
      keyDerivation: session.keyDerivation,
      ...(plan.capabilities === undefined ? {} : { capabilities: plan.capabilities }),
    });
    // 已初始化时先锁旧 Vault 并卸下旧绑定,再写记录、安装新运行态。
    if (platformRootStore) {
      await performGlobalLock("connect-bucket");
      discardCurrentPlatformStorageBinding();
    }
    await putDeviceRecord(remoteStorageId, built.record, true, peerId);
    await writeWorkerSession({
      ...session,
      activeBucketId: remoteStorageId,
      activeKey: publicKeyHex,
      ...(built.keyDerivation === undefined ? {} : { keyDerivation: built.keyDerivation }),
    }, peerId);
    const binding = runtimeBinding({
      remoteStorageId,
      backend: plan.backend,
      displayName: plan.displayName,
      record: built.record,
      ...(built.keyDerivation === undefined ? {} : { keyDerivation: built.keyDerivation }),
    });
    storageRootInstallationActive = true;
    try {
      await installPlatformStorage(provider, { bucketId: remoteStorageId, bucketGeneration: 1, provider: plan.backend });
    } finally {
      storageRootInstallationActive = false;
    }
    storageBootstrapState = { selectedBackend: binding.backend, selectedProfileId: binding.bucketId, selectedBucket: binding };
    // 连接成功后同样装配 Storage 运行态,页面无需刷新即可继续。
    storageController = undefined;
    await ensureStorageRuntime(peerId);
    await ensureCoordinatorTasksRegistered();
    coordinatorState.keyspaceGeneration += 1;
    coordinatorState.sessionEpoch = generateEpoch();
    coordinatorState.vaultStatus = "uninitialized";
    coordinatorState.activePublicKeyHex = undefined;
    storageHealthController.setStatus("ready");
    storageStartupFailure = false;
    installActiveKeyLock(lock);
    lock = undefined;
    const privateKeyBytes = unlocked.privateKeyBytes;
    unlocked.privateKeyBytes = new Uint8Array(0);
    await enterUnlockedState(publicKeyHex, privateKeyBytes, "unlock");
    const keyFile = await repository.read(publicKeyHex);
    return {
      ok: true,
      bucket: binding,
      activeKey: {
        publicKeyHex,
        label: keyFile?.document.label ?? publicKeyHex,
        address: deriveP2pkhAddress(publicKeyHex, "main"),
        format: "keyhold",
        capabilities: ["p2pkh"],
        createdAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    return { ok: false, error: initialSetupFailure("runtime", error instanceof Error ? error : new Error(String(error)), "not-started", plan.operationId).error };
  } finally {
    lock?.dispose();
    unlocked?.privateKeyBytes.fill(0);
    if (provider && platformBucketProvider !== provider) provider.dispose();
  }
}

async function executeInitialSetupOnce(plan: InitialSetupPlan, peerId?: string): Promise<InitialSetupResult> {
  const transactionId = plan && typeof plan === "object" && typeof plan.transactionId === "string"
    ? plan.transactionId
    : undefined;
  if (!transactionId) return executeInitialSetupTransaction(plan, peerId);
  const existing = initialSetupTransactions.get(transactionId);
  if (existing instanceof Promise) return existing;
  if (existing?.ok) return Promise.resolve(existing);
  const run = executeInitialSetupTransaction(plan, peerId).then((result) => {
    if (result.ok) initialSetupTransactions.set(transactionId, result);
    else initialSetupTransactions.delete(transactionId);
    return result;
  }, (error) => {
    initialSetupTransactions.delete(transactionId);
    throw error;
  });
  initialSetupTransactions.set(transactionId, run);
  return run;
}

/** 已完成事务的公开结果；进行中或未记录都返回 undefined。 */
async function getInitialSetupResult(transactionId: string, _peerId?: string): Promise<InitialSetupResult | undefined> {
  const existing = initialSetupTransactions.get(transactionId);
  return existing instanceof Promise ? undefined : existing;
}

interface CurrentCatalogStorageBinding {
  provider?: StorageBucketProvider;
  root?: PlatformRootStore;
  rootToken?: object;
  storageStore?: KeyValueStore;
  settingsSnapshot?: SnapshotStore<CoordinatorSettingsSnapshot>;
  pluginIntentSnapshot?: SnapshotStore<PluginIntentSnapshot>;
  protocol?: CoordinatorProtocolStorageStores;
  storageRepository?: Awaited<ReturnType<typeof openMultipartUploadRepository>>;
  runtime?: StorageRuntimeController & { dispose?: () => void };
}

function captureCurrentCatalogStorageBinding(): CurrentCatalogStorageBinding {
  return {
    provider: platformBucketProvider,
    root: platformRootStore,
    rootToken: platformRootToken,
    storageStore: platformStorageStore,
    settingsSnapshot: coordinatorSettingsSnapshot,
    pluginIntentSnapshot: coordinatorPluginIntentSnapshot,
    protocol: coordinatorProtocolStores,
    storageRepository,
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
  coordinatorMeta.pluginIntent ??= emptyPluginIntentSnapshot();
  replacePluginIntentController();
}

function disposeCurrentCatalogBinding(binding: CurrentCatalogStorageBinding): void {
  unregisterCoordinatorKeyValueMaintenanceStore(binding.storageStore);
  unregisterCoordinatorProtocolMaintenanceStores(binding.protocol);
  try { binding.runtime?.dispose?.(); } catch { /* best effort */ }
  if (!binding.runtime) binding.storageRepository?.close();
  binding.settingsSnapshot?.close();
  binding.pluginIntentSnapshot?.close();
  binding.storageStore?.close();
  closeCoordinatorProtocolStorageStores(binding.protocol);
  binding.provider?.dispose();
}

function discardCurrentPlatformStorageBinding(): void {
  stopCoordinatorKeyValueMaintenance();
  const binding = captureCurrentCatalogStorageBinding();
  for (const store of workerOwnerStores) store.invalidateBinding();
  disposeCurrentCatalogBinding(binding);
  platformRootStore = undefined;
  platformBucketProvider = undefined;
  platformRootToken = undefined;
  resetVaultKeyIndexCache();
  platformStorageStore = undefined;
  coordinatorSettingsSnapshot = undefined;
  coordinatorPluginIntentSnapshot = undefined;
  coordinatorProtocolStores = undefined;
  storageController = undefined;
  storageRepository = undefined;
  platformStorageReady = false;
  coordinatorMeta.pluginIntent = emptyPluginIntentSnapshot();
  disposePluginIntentController();
}


async function installPlatformStorage(
  provider: StorageBucketProvider,
  bucket: StorageBucketRef,
): Promise<void> {
  const previousRootToken = platformRootToken;
  const rootToken = {};
  let candidatePublished = false;
  let candidateSettingsSnapshot: SnapshotStore<CoordinatorSettingsSnapshot> | undefined;
  let candidatePluginIntentSnapshot: SnapshotStore<PluginIntentSnapshot> | undefined;
  let candidateProtocol: CoordinatorProtocolStorageStores | undefined;
  let candidateStorageStore: KeyValueStore | undefined;
  let candidateStorageRepository: Awaited<ReturnType<typeof openMultipartUploadRepository>> | undefined;
  try {
    const root = createPlatformRootStore({
      provider,
      bucket,
      isCurrent: ({ ownerPublicKeyHex, bucketGeneration, keyspaceGeneration }) =>
        (candidatePublished ? platformRootToken === rootToken : true) &&
        bucketGeneration === bucket.bucketGeneration &&
        (keyspaceGeneration === undefined || keyspaceGeneration === coordinatorState.keyspaceGeneration) &&
        (!ownerPublicKeyHex || ownerPublicKeyHex.toLowerCase() === coordinatorState.activePublicKeyHex?.toLowerCase())
    });
    const settingsSnapshot = await root.openPlatformSnapshot({ declaration: CENTRAL_STORAGE_DECLARATIONS.coordinatorSettings, validate: validateCoordinatorSettingsSnapshot });
    candidateSettingsSnapshot = settingsSnapshot;
    const pluginIntentSnapshot = await root.openPlatformSnapshot({ declaration: CENTRAL_STORAGE_DECLARATIONS.coordinatorPluginIntent, validate: validatePluginIntentSnapshot });
    candidatePluginIntentSnapshot = pluginIntentSnapshot;
    const protocol = await openCoordinatorProtocolStorageStores(root);
    candidateProtocol = protocol;
    candidateStorageStore = await root.openPlatformStore({ declaration: CENTRAL_STORAGE_DECLARATIONS.storageMultipartUploads });
    candidateStorageRepository = await openMultipartUploadRepository(candidateStorageStore);

    // 到这里为止只使用候选 Provider/Root；Hold、Vault 和后续恢复仍未能
    // 看到半成品。提交前才切换全局句柄，并释放上一代平台句柄。
    if (storageRepository && storageRepository !== candidateStorageRepository) storageRepository.close();
    coordinatorSettingsSnapshot?.close();
    coordinatorPluginIntentSnapshot?.close();
    disposeVaultStorageRepository();
    platformRootToken = rootToken;
    candidatePublished = true;
    configureCoordinatorVaultStorage(provider);
    configureProtocolStorageRepository(protocol);
    platformRootStore = root;
    platformBucketProvider = provider;
    // 安装完成后，Local Provider 的反向 bridge 必须跟随当前 storageIoOwner，
    // 而不是创建它的那个页面 peer；否则页面刷新/关闭后旧 peer 被回收，
    // 后续解锁会去找一个不再存在的页面。
    publishCoordinatorLocalStorageProvider(provider);
    platformStorageStore = candidateStorageStore;
    registerCoordinatorKeyValueMaintenanceStore(candidateStorageStore);
    registerCoordinatorProtocolMaintenanceStores(protocol);
    coordinatorSettingsSnapshot = settingsSnapshot;
    coordinatorPluginIntentSnapshot = pluginIntentSnapshot;
    // 新 Root 提交后先撤销旧桶意图控制器；loadCoordinatorMeta 会从本次
    // 固定对象恢复并重建，期间任何惰性读取都只能看到空的默认意图。
    coordinatorMeta.pluginIntent = emptyPluginIntentSnapshot();
    disposePluginIntentController();
    coordinatorProtocolStores = protocol;
    storageRepository = candidateStorageRepository;
    platformStorageReady = true;
    scheduleCoordinatorKeyValueMaintenance();
  } catch (error) {
    if (!candidatePublished) {
      candidateStorageRepository?.close();
      candidateStorageStore?.close();
      closeCoordinatorProtocolStorageStores(candidateProtocol);
      candidateSettingsSnapshot?.close();
      candidatePluginIntentSnapshot?.close();
      // 候选 Provider 由本次 install 创建/传入，失败时不能把 S3 client
      // 和已打开的连接凭据留在 Worker；当前 Provider 若仍是旧实例则由
      // 上层继续持有，避免把正在工作的会话误关掉。
      if (provider !== platformBucketProvider) provider.dispose();
      if (platformRootToken === rootToken) platformRootToken = previousRootToken;
    }
    throw error;
  }
}

/**
 * Worker 单元测试的 Storage bootstrap 夹具。
 *
 * 它只在 `__testResetState()` 中启用，使用 runtime 提供的内存 K-V
 * 实现保持跨测试的 Worker 重启语义；生产启动不会因为 Storage 缺失而
 * 自动降级到内存。
 */
interface TestCoordinatorGarbageProviderState {
  provider: StorageBucketProvider;
  objects: Map<string, { bytes: Uint8Array; etag: string; lastModified: string }>;
}

let testCoordinatorGarbageProviderState: TestCoordinatorGarbageProviderState | undefined;
/** 测试用 owner 文件对象：key = "<owner>::<相对路径>"。 */
const testOwnerFileObjects = new Map<string, Uint8Array>();

function ensureTestCoordinatorGarbageProvider(): TestCoordinatorGarbageProviderState {
  if (testCoordinatorGarbageProviderState) return testCoordinatorGarbageProviderState;
  const objects = new Map<string, { bytes: Uint8Array; etag: string; lastModified: string }>();
  let etagNumber = 0;
  const copyObject = (path: string, object: { bytes: Uint8Array; etag: string; lastModified: string }): StorageBucketObject => ({
    path,
    bytes: new Uint8Array(object.bytes),
    size: object.bytes.byteLength,
    etag: object.etag,
    lastModified: object.lastModified,
  });
  const conflict = (message: string): StorageRuntimeError => new StorageRuntimeError("storage_conflict", message);
  const provider: StorageBucketProvider = {
    provider: "local",
    bucketId: "test-memory",
    async probe(): Promise<StorageBucketProbeResult> {
      return { ok: true, conditionalWrites: "native", latencyMs: 0 };
    },
    async get(path: string, options: { signal?: AbortSignal; ifMatch?: string } = {}): Promise<StorageBucketObject | undefined> {
      const current = objects.get(path);
      if (options.ifMatch !== undefined && (!current || current.etag !== options.ifMatch)) throw conflict("test garbage provider ETag changed");
      return current ? copyObject(path, current) : undefined;
    },
    async list(input: { prefix?: string; cursor?: string; limit?: number; signal?: AbortSignal } = {}): Promise<StorageBucketListPage> {
      const prefix = input.prefix ?? "";
      const offset = input.cursor === undefined ? 0 : Number.parseInt(input.cursor, 10);
      const limit = input.limit ?? 1000;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
        throw new StorageRuntimeError("storage_limit_exceeded", "Test garbage provider list bounds are invalid");
      }
      const paths = [...objects.keys()].filter((path) => path.startsWith(prefix)).sort((left, right) => left.localeCompare(right));
      const selected = paths.slice(offset, offset + limit).map((path) => copyObject(path, objects.get(path)!));
      return {
        objects: selected,
        ...(offset + selected.length < paths.length ? { nextCursor: String(offset + selected.length) } : {}),
      };
    },
    async put(path: string, bytes: Uint8Array, condition: StorageBucketWriteCondition & { signal?: AbortSignal } = {}): Promise<{ etag: string; lastModified: string }> {
      const current = objects.get(path);
      if (condition.ifNoneMatch === "*" && current) throw conflict("test garbage provider object already exists");
      if (condition.ifMatch !== undefined && (!current || current.etag !== condition.ifMatch)) throw conflict("test garbage provider ETag changed");
      const object = {
        bytes: new Uint8Array(bytes),
        etag: `test-garbage-${++etagNumber}`,
        // An epoch timestamp makes minAgeMs: 0 deterministic: every object is
        // old enough for the explicit test-only collection pass.
        lastModified: new Date(0).toISOString(),
      };
      objects.set(path, object);
      return { etag: object.etag, lastModified: object.lastModified };
    },
    async delete(path: string, options: { signal?: AbortSignal; ifMatch?: string } = {}): Promise<void> {
      const current = objects.get(path);
      if (options.ifMatch !== undefined && (!current || current.etag !== options.ifMatch)) throw conflict("test garbage provider ETag changed");
      objects.delete(path);
    },
    dispose(): void { /* test provider */ },
  };
  testCoordinatorGarbageProviderState = { provider, objects };
  return testCoordinatorGarbageProviderState;
}

function ensureTestPlatformStorage(): void {
  testWorkerSession ??= {
    format: "keymaster.session",
    version: 1,
    sessionId: "0123456789abcdef0123456789abcdef",
    activeBucketId: "test-memory",
  };
  if (platformRootStore) return;
  const bucket: StorageBucketRef = Object.freeze({ bucketId: "test-memory", bucketGeneration: 1, provider: "local" });
  platformRootToken = {};
  const garbageProvider = ensureTestCoordinatorGarbageProvider();
  const stores = new Map<string, KeyValueStore>();
  const snapshots = new Map<string, { revision: number; value?: unknown; writes: number }>();
  testPlatformStores = stores;
  testCoordinatorSnapshots = snapshots;
  const getStore = (key: string, binding: Parameters<typeof createInMemoryKeyValueStore>[0]): KeyValueStore => {
    const existing = stores.get(key);
    if (existing) return { ...existing, close: () => undefined };
    const created = createInMemoryKeyValueStore(binding);
    stores.set(key, created);
    return { ...created, close: () => undefined };
  };
  const openTestGarbageStore = (declaration: PluginStorageDeclaration, ownerPublicKeyHex?: string): KeyValueStore => {
    const binding = {
      ...declaration,
      bucketId: bucket.bucketId,
      bucketGeneration: bucket.bucketGeneration,
      ...(ownerPublicKeyHex === undefined ? {} : { ownerPublicKeyHex }),
    } satisfies Parameters<typeof createKeyValueStore>[0]["binding"];
    return createKeyValueStore({ provider: garbageProvider.provider, binding });
  };
  const isTestGarbageBucketDeclaration = (declaration: PluginStorageDeclaration): boolean =>
    declaration.moduleId === CENTRAL_STORAGE_DECLARATIONS.bsvPrice.moduleId
    && declaration.purposeId === CENTRAL_STORAGE_DECLARATIONS.bsvPrice.purposeId
    && declaration.scope === "bucket"
    && declaration.model === "kv";
  const isTestGarbageOwnerDeclaration = (declaration: PluginStorageDeclaration): boolean =>
    declaration.moduleId === CENTRAL_STORAGE_DECLARATIONS.messageHistory.moduleId
    && declaration.purposeId === CENTRAL_STORAGE_DECLARATIONS.messageHistory.purposeId
    && declaration.scope === "owner"
    && declaration.model === "kv";
  const makeSnapshot = <T>(declaration: PluginStorageDeclaration, validate: (value: unknown) => StorageSnapshotJsonCompatible<T>): SnapshotStore<T> => {
    const key = `snapshot:${declaration.moduleId}:${declaration.purposeId}:${declaration.schemaVersion}`;
    return {
      async read() {
        const current = snapshots.get(key);
        if (!current || current.value === undefined) return undefined;
        return { value: validate(structuredClone(current.value)), revision: current.revision };
      },
      async write(value, condition = {}) {
        const current = snapshots.get(key);
        const revision = current?.revision ?? 0;
        if (condition.ifRevision !== undefined && condition.ifRevision !== revision) throw new StorageRuntimeError("storage_conflict", "snapshot revision changed");
        if (current?.value !== undefined && JSON.stringify(current.value) === JSON.stringify(value)) return { revision, wrote: false };
        snapshots.set(key, { revision: revision + 1, value: structuredClone(value), writes: (current?.writes ?? 0) + 1 });
        return { revision: revision + 1, wrote: true };
      },
      close: () => undefined,
    };
  };
  const root: PlatformRootStore = {
    bucket,
    openOwnerFileStore: async ({ ownerPublicKeyHex, declaration, appPublisherPublicKeyHex }) => {
      // 测试存根按 owner/module/purpose 隔离；三方 App 文件根落在
      // `<owner>/app.<publisher>/`，与生产路径语义一致。
      const base = appPublisherPublicKeyHex === undefined
        ? `${ownerPublicKeyHex.toLowerCase()}::${declaration.moduleId}::${declaration.purposeId}::`
        : `${ownerPublicKeyHex.toLowerCase()}::app.${appPublisherPublicKeyHex.toLowerCase()}::`;
      return {
        list: async (input = {}) => ({
          files: [...testOwnerFileObjects.keys()]
            .filter((key) => key.startsWith(base) && key.slice(base.length).startsWith(input.prefix ?? ""))
            .map((key) => ({ path: key.slice(base.length), size: testOwnerFileObjects.get(key)!.byteLength })),
        }),
        get: async (path) => {
          const value = testOwnerFileObjects.get(base + path);
          return value ? { path, bytes: new Uint8Array(value) } : undefined;
        },
        put: async (path, bytes) => { testOwnerFileObjects.set(base + path, new Uint8Array(bytes)); return {}; },
        delete: async (path) => { testOwnerFileObjects.delete(base + path); },
      };
    },
    listOwnerAppPublishers: async ({ ownerPublicKeyHex }) => {
      const prefix = `${ownerPublicKeyHex.toLowerCase()}::app.`;
      const publishers = new Set<string>();
      for (const key of testOwnerFileObjects.keys()) {
        if (!key.startsWith(prefix)) continue;
        const segment = key.slice(prefix.length).split("::", 1)[0] ?? "";
        if (/^(02|03)[0-9a-f]{64}$/u.test(segment)) publishers.add(segment);
      }
      return [...publishers].sort();
    },
    openKeyValueStore: async ({ ownerPublicKeyHex, declaration }) => isTestGarbageOwnerDeclaration(declaration)
      ? openTestGarbageStore(declaration, ownerPublicKeyHex) as import("@keymaster/contracts").OwnerAppStore
      : getStore(
        `owner:${ownerPublicKeyHex}:${declaration.moduleId}:${declaration.purposeId}:${declaration.schemaVersion}`,
        { ...declaration, ownerPublicKeyHex, bucketId: bucket.bucketId, bucketGeneration: bucket.bucketGeneration }
      ) as import("@keymaster/contracts").OwnerAppStore,
    deleteOwnerStorage: async ({ ownerPublicKeyHex }) => {
      if (testFailNextOwnerStorageDeletion) {
        testFailNextOwnerStorageDeletion = false;
        throw new StorageRuntimeError("storage_provider_error", "injected owner storage deletion failure");
      }
      const prefix = `owner:${ownerPublicKeyHex}:`;
      for (const key of [...stores.keys()]) {
        if (key.startsWith(prefix)) { stores.get(key)?.close(); stores.delete(key); }
      }
    },
    openPlatformStore: async ({ declaration }) => isTestGarbageBucketDeclaration(declaration)
      ? openTestGarbageStore(declaration)
      : getStore(
        `bucket:${declaration.moduleId}:${declaration.purposeId}:${declaration.schemaVersion}`,
        { ...declaration, bucketId: bucket.bucketId, bucketGeneration: bucket.bucketGeneration }
      ),
    openPlatformSnapshot: async <T>(input: { declaration: PluginStorageDeclaration; validate: (value: unknown) => StorageSnapshotJsonCompatible<T> }) => {
      return makeSnapshot(input.declaration, input.validate);
    },
  };
  const protocol: CoordinatorProtocolStorageStores = {
    durablePolicy: getStore(`bucket:${CENTRAL_STORAGE_DECLARATIONS.protocolDurablePolicy.moduleId}:${CENTRAL_STORAGE_DECLARATIONS.protocolDurablePolicy.purposeId}:1`, { ...CENTRAL_STORAGE_DECLARATIONS.protocolDurablePolicy, bucketId: bucket.bucketId, bucketGeneration: bucket.bucketGeneration }),
    sessions: getStore(`bucket:${CENTRAL_STORAGE_DECLARATIONS.protocolSessions.moduleId}:${CENTRAL_STORAGE_DECLARATIONS.protocolSessions.purposeId}:1`, { ...CENTRAL_STORAGE_DECLARATIONS.protocolSessions, bucketId: bucket.bucketId, bucketGeneration: bucket.bucketGeneration }),
    commandHistory: getStore(`bucket:${CENTRAL_STORAGE_DECLARATIONS.protocolCommandHistory.moduleId}:${CENTRAL_STORAGE_DECLARATIONS.protocolCommandHistory.purposeId}:1`, { ...CENTRAL_STORAGE_DECLARATIONS.protocolCommandHistory, bucketId: bucket.bucketId, bucketGeneration: bucket.bucketGeneration }),
  };
  platformRootStore = root;
  coordinatorSettingsSnapshot = makeSnapshot(CENTRAL_STORAGE_DECLARATIONS.coordinatorSettings, validateCoordinatorSettingsSnapshot);
  coordinatorPluginIntentSnapshot = makeSnapshot(CENTRAL_STORAGE_DECLARATIONS.coordinatorPluginIntent, validatePluginIntentSnapshot);
  coordinatorProtocolStores = protocol;
  configureProtocolStorageRepository(protocol);
  platformStorageReady = true;
  testVaultHoldBinding ??= createTestVaultHoldBinding();
  configureVaultStorageRepository({ hold: testVaultHoldBinding.adapter });
}


async function loadCoordinatorMeta(): Promise<void> {
  const [session, settings, pluginIntent] = await Promise.all([
    readWorkerSession(),
    coordinatorSettingsSnapshot?.read(),
    coordinatorPluginIntentSnapshot?.read(),
  ]);
  // 桶级固定对象和浏览器 session 都是独立的恢复单元；缺失表示各自的
  // V1 默认值，而不是重新创建一个聚合 Coordinator K-V 记录。
  // 「当前选中 Key」的真值是浏览器 session.activeKey（见《浏览器session》），
  // 不再从桶内 snapshot 恢复，两个浏览器因此互不覆盖。
  const defaults = defaultCoordinatorRuntimeSettings();
  replaceCoordinatorMeta({
    ...defaults,
    ...(settings?.value ?? {}),
    selectedPublicKeyHex: session?.activeKey,
    pluginIntent: pluginIntent?.value ?? defaults.pluginIntent,
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
  }, { auditOperation });
}

/**
 * 持久化当前选中 Key：写浏览器 session.activeKey，桶内不再有固定对象。
 *
 * 切换 / 删除 Key 都是低频固定动作，写透后 Worker 直接复用内存缓存，
 * 不产生逐次远程 I/O。
 */
async function persistSelectedPublicKey(selectedPublicKeyHex = coordinatorMeta.selectedPublicKeyHex): Promise<void> {
  await updateWorkerSessionSelection(selectedPublicKeyHex);
}

async function persistCoordinatorSettings(settings: CoordinatorSettingsSnapshot = {
  scheduleSettings: coordinatorMeta.scheduleSettings,
  autoLockTimeoutMs: coordinatorMeta.autoLockTimeoutMs,
}): Promise<void> {
  await writeCoordinatorSnapshot(coordinatorSettingsSnapshot, structuredClone(settings), "coordinator.settings.persist");
}

async function persistCoordinatorPluginIntent(snapshot: PluginIntentSnapshot = coordinatorMeta.pluginIntent): Promise<void> {
  await writeCoordinatorSnapshot(coordinatorPluginIntentSnapshot, structuredClone(snapshot), "coordinator.plugin-intent.persist");
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
  const initialKeyspaceGeneration = coordinatorState.keyspaceGeneration;
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
      && (coordinatorState.sessionEpoch !== initialSessionEpoch || coordinatorState.keyspaceGeneration !== initialKeyspaceGeneration);
    const localBindingDiscard = options.allowLocalBindingDiscard === true && catalogBindingDiscardDeferred;
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

function emptyPluginIntentSnapshot(): PluginIntentSnapshot {
  return { revision: 0, desiredEnabled: {}, desiredRevision: {} };
}

function disposePluginIntentController(): void {
  pluginIntentControllerOff?.();
  pluginIntentControllerOff = undefined;
  pluginIntentController = undefined;
}

function replacePluginIntentController(): void {
  disposePluginIntentController();
  ensurePluginIntentController();
}

/** 创建本次 Worker 唯一的插件意图控制面，并把持久化成功作为发布前置条件。 */
function ensurePluginIntentController(): PluginIntentController {
  if (pluginIntentController) return pluginIntentController;
  const controller = createPluginIntentController({
    authorityInstanceId: coordinatorAuthorityInstanceId,
    initial: coordinatorMeta.pluginIntent ?? emptyPluginIntentSnapshot(),
    persist: async (snapshot) => {
      // 仅发布 plugin-intent 固定对象；任务 reconcile 订阅发生在持久化
      // 成功之后，失败时内存意图和运行中任务都保持原值。
      await persistCoordinatorPluginIntent(snapshot);
      coordinatorMeta.pluginIntent = structuredClone(snapshot);
    },
  });
  pluginIntentController = controller;
  pluginIntentControllerOff = controller.subscribe((snapshot) => {
    coordinatorMeta.pluginIntent = snapshot;
    // Controller 的 accepted 事件表示意图已经落盘；从这里开始 Worker
    // 必须立即撤掉旧任务入口，不能等 Window Host 的异步 reconcile。
    reconcileCoordinatorTaskIntent(snapshot);
    reconcileCoordinatorRuntime();
    publishTopicEvent("plugin.intent", {
      type: "plugin.intent.changed",
      authorityInstanceId: coordinatorAuthorityInstanceId,
      pluginIntentRevision: snapshot.revision,
      snapshot,
    } satisfies Omit<PluginIntentStateEvent, "topic" | "sessionEpoch">);
  });
  return controller;
}

let testStorageSessionResolver: ((sessionId: string) => Promise<{ sessionId: string; origin: string; ownerPublicKeyHex?: string; appIdentity: import("@keymaster/contracts").OwnerAppStorageGrant["appIdentity"]; revokedAt: number | null } | null>) | undefined;

function isValidStorageIdentity(identity: unknown): identity is import("@keymaster/contracts").OwnerAppStorageGrant["appIdentity"] {
  return isVerifiedAppIdentitySnapshot(identity);
}

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

function localSecretAad(scope: string): string {
  return `keymaster:local-secret:v3|${scope}`;
}

/**
 * 从当前 active key 临时派生插件本地秘密的用途密钥。
 *
 * 密码只用于一次 Vault/桶认证；本地秘密不再依赖也不再缓存密码派生
 * CryptoKey。每次 seal/open 以当前私钥 + public key + scope 重新做 HKDF，
 * 得到的 AES key 只存在当前 await 链中。
 */
async function deriveVaultLocalSecretKey(scope: string): Promise<CryptoKey> {
  const privateKeyBytes = coordinatorState.activePrivateKeyBytes;
  const publicKeyHex = coordinatorState.activePublicKeyHex;
  if (!privateKeyBytes || !publicKeyHex) throw new Error("Vault is locked");
  const baseKey = await crypto.subtle.importKey("raw", privateKeyBytes as BufferSource, "HKDF", false, ["deriveBits"]);
  const rawBits = new Uint8Array(await crypto.subtle.deriveBits({
    name: "HKDF",
    hash: "SHA-256",
    salt: new TextEncoder().encode("keymaster.vault.local-secret.v3"),
    info: new TextEncoder().encode(`${publicKeyHex.toLowerCase()}\0${scope}`)
  }, baseKey, 256));
  try {
    return await crypto.subtle.importKey("raw", rawBits as BufferSource, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  } finally {
    rawBits.fill(0);
  }
}

function normalizedCoordinatorOwner(): string | null {
  return coordinatorState.vaultStatus === "unlocked" && coordinatorState.activePublicKeyHex
    ? coordinatorState.activePublicKeyHex.trim().toLowerCase()
    : null;
}

/** 将 Worker 内唯一 Contacts 在线真值投影为页面可订阅的快照事件。 */
function publishCoordinatorContactsPresence(): void {
  const service = coordinatorContactsService;
  const ownerPublicKeyHex = normalizedCoordinatorOwner();
  const sessionEpoch = coordinatorState.sessionEpoch;
  const run = contactsPresencePublishTail.then(async () => {
    let presence: ContactPresenceMap = {};
    if (service && ownerPublicKeyHex) {
      try {
        presence = await service.getPresenceSnapshot?.() ?? {};
      } catch {
        // 本地联系人 K-V 暂不可读时，安全降级为空快照（全部 offline）。
        presence = {};
      }
    }
    // 快照查询可能跨越 lock/key switch/service teardown；迟到结果不得污染新世代。
    if (service !== coordinatorContactsService
      || sessionEpoch !== coordinatorState.sessionEpoch
      || ownerPublicKeyHex !== normalizedCoordinatorOwner()) return;
    const event = publishTopicEvent("contacts.presence", {
      type: "contacts.presence.changed",
      activePublicKeyHex: ownerPublicKeyHex,
      presence,
    }) as CoordinatorContactsPresenceEvent;
    lastContactsPresenceState = event;
  }, () => undefined);
  contactsPresencePublishTail = run.then(() => undefined, () => undefined);
}

function publishSessionState(cause: SessionStateEvent["cause"]): void {
  // 服务目录与 owner/session 可见性共享同一状态提交点。锁定、解锁、换
  // Key、Storage Root 重绑都会改变 identity；先同步撤权/旋转 exposure，
  // 再广播业务状态，避免页面看到已 unlocked 但仍持有旧 service proxy。
  reconcileCoordinatorSessionExposures();
  publishTopicEvent("session.state", {
    type: "session.state.changed",
    cause,
    vaultStatus: coordinatorState.vaultStatus,
    activePublicKeyHex: coordinatorState.vaultStatus === "unlocked" ? coordinatorState.activePublicKeyHex ?? null : null,
    selectedPublicKeyHex: coordinatorMeta.selectedPublicKeyHex ?? null,
    keyspaceGeneration: coordinatorState.keyspaceGeneration,
    autoLockTimeoutMs: coordinatorMeta.autoLockTimeoutMs ?? AUTO_LOCK_DEFAULT_TIMEOUT_MS,
    ...(coordinatorAuthorityRecovery ? { authorityRecovery: coordinatorAuthorityRecovery } : {}),
  });
  publishCoordinatorContactsPresence();
}

// ============================================================
// 1. Coordinator State
// ============================================================

interface CoordinatorState {
  sessionEpoch: SessionEpoch;
  vaultStatus: CoordinatorVaultStatus;
  activePublicKeyHex?: string;
  activePrivateKeyBytes?: Uint8Array;
  keyspaceGeneration: number;
  taskRuntimes: Map<string, TaskRuntime>;
  scheduleSettings: CoordinatorBackgroundSyncSettings;
  autoLockTimeoutMs: number;
  autoLockDeadline?: number;
  lastActivityAt: number;
}

/**
 * 失败的 owner 切换也必须消耗一个新的 keyspace generation。
 *
 * 不能把 generation 回滚到旧值：A→B 失败后如果恢复成 A 的旧 generation，
 * 旧的 A 句柄可能再次通过 Root 的校验。这里同时刷新 session epoch，确保
 * 其它依赖会话世代的异步操作也不会复活。
 */
function invalidateFailedKeyspaceTransition(previousGeneration: number): void {
  coordinatorState.keyspaceGeneration = Math.max(
    coordinatorState.keyspaceGeneration,
    previousGeneration,
  ) + 1;
  coordinatorState.sessionEpoch = generateEpoch();
}

let storageController: StorageRuntimeController | undefined;
let storageRepository: Awaited<ReturnType<typeof openMultipartUploadRepository>> | undefined;
// Test-only seams keep worker ownership/dispatch tests independent from S3 and
// platform K-V persistence.
let testStorageRuntimeOverride: StorageRuntimeController | undefined;
let testStorageStartupFailure = false;
let testFailAfterCatalogBindingPublish = false;
let testFailNextOwnerStorageDeletion = false;
let testFailAfterOwnerStorageActivation = false;
let testFailNextHoldRollbackCas = false;
let testCatalogHoldPublishBarrier: {
  entered: Promise<void>;
  resolveEntered: () => void;
  released: Promise<void>;
  release: () => void;
} | undefined;
let testCatalogHoldRollbackBarrier: {
  entered: Promise<void>;
  resolveEntered: () => void;
  released: Promise<void>;
  release: () => void;
} | undefined;
let testKeyLifecycleOwnerBarrier: {
  entered: Promise<void>;
  resolveEntered: () => void;
  released: Promise<void>;
  release: () => void;
} | undefined;
let testLocalStorageBridgeOverride: ((input: LocalStorageBridgeRequest) => Promise<LocalStorageBridgeResponse>) | undefined;
let storageStartupFailure = false;
let storageRevision = 0;
let msfileRevision = 0;
let lastStorageState: CoordinatorStorageStateEvent | undefined;
let storageStateTail: Promise<void> = Promise.resolve();
const storageRequests = new Map<string, { controller: AbortController; clientId: string; connectSessionId?: string }>();
const storageRequestKey = (clientId: string, requestId: string): string => `${clientId}\u0000${requestId}`;
const storagePortCounts = new Map<string, number>();
const storageGrants = new Map<string, { context: import("@keymaster/contracts").OwnerAppStorageGrant; clientId: string; sessionEpoch: SessionEpoch }>();
const ownerStorageGrants = new Map<string, StorageOwnerGrant & { clientId: string }>();
const platformStorageGrants = new Map<string, StoragePlatformGrant & { clientId: string }>();
let storageMutationTail: Promise<void> = Promise.resolve();
/** 首次初始化按 transactionId single-flight；响应丢失或重复点击不得生成第二把 Key。 */
const initialSetupTransactions = new Map<string, Promise<InitialSetupResult> | InitialSetupResult>();
let storageDataActive = 0;
type StorageDataWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  active: boolean;
  clientId: string;
};
const storageDataWaiters: StorageDataWaiter[] = [];
const STORAGE_DATA_CONCURRENCY = 4;
const STORAGE_DATA_MAX_QUEUE = 64;
const STORAGE_DATA_MAX_PER_PORT = 16;
const STORAGE_DATA_MAX_ACTIVE_PER_PORT = STORAGE_DATA_CONCURRENCY - 1;
const storageDataActiveByPort = new Map<string, number>();

/** 删除 owner 时的请求栅栏；新请求拒绝，旧请求可被等待到自然结束。 */
const ownerStorageFences = new Map<string, number>();
const ownerStorageRequests = new Map<string, Set<Promise<void>>>();
/** 锁定期间未完成的旧 owner 排空；下一次解锁必须先消费它。 */
let pendingOwnerStorageDrain: { ownerPublicKeyHex: string; promise: Promise<void> } | undefined;
/** 删除 owner 前等待所有 KV/文件请求自然结束的上限。 */
export const OWNER_STORAGE_DRAIN_TIMEOUT_MS = 5_000;

function storageUnavailableError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "storage_unavailable" });
}

function storageConflictError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "storage_conflict" });
}

function isStorageConflictError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "storage_conflict");
}

function assertOwnerStorageNotFenced(ownerPublicKeyHex: string): void {
  if (ownerStorageFences.has(ownerPublicKeyHex.toLowerCase())) {
    throw storageUnavailableError("Owner storage is fenced during a key/session transition");
  }
}

function beginOwnerStorageRequest(ownerPublicKeyHex: string): () => void {
  const owner = ownerPublicKeyHex.toLowerCase();
  assertOwnerStorageNotFenced(owner);
  let resolveRelease!: () => void;
  const pending = new Promise<void>((resolve) => { resolveRelease = resolve; });
  let requests = ownerStorageRequests.get(owner);
  if (!requests) {
    requests = new Set<Promise<void>>();
    ownerStorageRequests.set(owner, requests);
  }
  requests.add(pending);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    requests!.delete(pending);
    if (requests!.size === 0) ownerStorageRequests.delete(owner);
    resolveRelease();
  };
}

async function drainOwnerStorageRequests(ownerPublicKeyHex: string): Promise<void> {
  const requests = ownerStorageRequests.get(ownerPublicKeyHex.toLowerCase());
  if (!requests?.size) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const drained = await Promise.race([
      Promise.allSettled([...requests]).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), OWNER_STORAGE_DRAIN_TIMEOUT_MS);
      })
    ]);
    if (!drained) {
      // 超时不能继续 owner 目录清理；迟到的 Provider 写入仍可能在
      // AbortSignal 被忽略时完成，因此必须保留 Journal 与 owner fence。
      throw storageUnavailableError("Owner storage requests did not drain before key deletion timeout");
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function rememberOwnerStorageDrain(ownerPublicKeyHex: string, promise: Promise<void>): void {
  const owner = ownerPublicKeyHex.toLowerCase();
  const existing = pendingOwnerStorageDrain;
  if (existing?.ownerPublicKeyHex === owner) return;
  pendingOwnerStorageDrain = { ownerPublicKeyHex: owner, promise };
  // 锁定路径不能因为 Provider 忽略 AbortSignal 而产生未处理 rejection；
  // 真正的错误由下一次解锁再次 await 并重新 drain 时返回。
  void promise.then(
    () => undefined,
    () => undefined
  );
}

/** 等待锁定留下的旧 owner 排空；超时后保留 fence，并允许后续重试。 */
async function waitForPendingOwnerStorageDrain(): Promise<string | undefined> {
  const pending = pendingOwnerStorageDrain;
  if (!pending) return undefined;
  try {
    await pending.promise;
  } catch {
    // 初次锁定的 drain 可能已经超时，但 Provider 随后才自然结束；
    // 解锁时重新观察当前集合，不能把旧的 rejected Promise 当成永久结论。
    await drainOwnerStorageRequests(pending.ownerPublicKeyHex);
  }
  if (pendingOwnerStorageDrain?.promise === pending.promise) pendingOwnerStorageDrain = undefined;
  return pending.ownerPublicKeyHex;
}

interface ActiveOwnerTransitionResult {
  /** 切换前的 unlocked owner；成功公开新 owner 后才能释放它的 fence。 */
  previousOwner?: string;
  /** lock → unlock 时等待并排空的 owner；成功公开目标后才能释放它的 fence。 */
  pendingOwner?: string;
}

/**
 * 完成一次 active-owner 迁移后，统一释放已经排空的临时 fence。
 *
 * pendingOwner 与目标 owner 不一定相同：例如 lock(A) → unlock(B) 时，
 * pendingOwner 是 A，而新 active owner 是 B。只按“pending 等于目标”清理
 * 会让 A 永久保持 fenced，之后切回 A 时所有 owner K-V 都会被拒绝。
 */
function completeActiveStorageOwnerTransition(transition: ActiveOwnerTransitionResult | undefined): void {
  if (!transition) return;
  if (transition.previousOwner) ownerStorageFences.delete(transition.previousOwner);
  if (transition.pendingOwner) ownerStorageFences.delete(transition.pendingOwner);
}

/**
 * 所有 active-key 入口共用的 owner 边界。
 *
 * 顺序固定为：旧 owner fence/grant revoke → abort runtime/task → drain
 * owner storage → 调用方才可以把新 owner 写入 Coordinator state。
 */
async function transitionActiveStorageOwner(nextPublicKeyHex: string): Promise<ActiveOwnerTransitionResult> {
  const nextOwner = nextPublicKeyHex.toLowerCase();
  let pendingOwner: string | undefined;
  try {
    pendingOwner = await waitForPendingOwnerStorageDrain();
  } catch (error) {
    // 只有当前仍 unlocked 时才需要主动收口；locked → unlock 失败时已经
    // 是 fail-closed 状态，必须原样保持。
    if (coordinatorState.vaultStatus === "unlocked") await performGlobalLock("owner-transition-failed");
    throw error;
  }

  const previousOwner = coordinatorState.activePublicKeyHex?.toLowerCase();
  if (!previousOwner || previousOwner === nextOwner) {
    return { previousOwner: undefined, pendingOwner };
  }

  // owner 切换会改变最终读写边界的身份；先撤销旧接管会话，防止已经
  // 拿到的租约在新 owner 进入期间继续提交。
  closeCoordinatorUpgradeSession("Coordinator owner transition");
  fenceOwnerStorage(previousOwner);
  releaseMsfileRuntime("activate-key");
  await releaseSatRuntime("activate-key");
  clearWindowP2pExecutorLeaseLocked();
  stopCoordinatorOwnerWorkerUnits();
  // 任务 completion 由自己的 session/generation 栅栏收口；这里不等待
  // 一个可能永不响应 AbortSignal 的业务 task，owner storage drain 才是
  // 新 owner 暴露前的硬门禁。
  void cancelTaskRuntimesByKey(previousOwner).catch((error) => {
    console.warn("[coordinator] old owner task cancellation deferred", error instanceof Error ? error.message : String(error));
  });
  const drain = drainOwnerStorageRequests(previousOwner);
  try {
    await drain;
  } catch (error) {
    rememberOwnerStorageDrain(previousOwner, drain);
    // 排空超时不得回滚到旧 owner，也不得继续激活目标 owner。
    await performGlobalLock("owner-transition-failed");
    throw error;
  }
  return { previousOwner, pendingOwner };
}

function assertOwnerStorageBindingFresh(ownerPublicKeyHex: string, generation: number, rootToken: object | undefined): void {
  const owner = ownerPublicKeyHex.toLowerCase();
  if (
    ownerStorageFences.has(owner) ||
    coordinatorState.activePublicKeyHex?.toLowerCase() !== owner ||
    coordinatorState.keyspaceGeneration !== generation ||
    platformRootToken !== rootToken
  ) throw storageUnavailableError("Owner storage binding became stale");
}

/* ---------- MSFile runtime state（施工单 KMMF-005/006） ---------- */
let msfileRuntime: MsFileServiceImpl | undefined;
/** 仅测试替身；生产请求永远只读取 Host-owned msfileRuntime。 */
let testMsfileRuntimeOverride: MsFileServiceImpl | undefined;
/** 测试模拟 Worker/domain teardown 后允许按现有 Host instance 恢复一次。 */
let testMsfileRuntimeRecoveryAllowed = false;
/** MSFile 首次装配 single-flight；首页资源与设置命令可能同时触发启动。 */
let msfileRuntimeStarting: Promise<MsFileServiceImpl> | undefined;
/** 释放/切换 owner 时递增，阻止迟到的候选实例重新发布。 */
let msfileRuntimeStartToken = 0;
type MsFileRuntimeStores = {
  ownerPublicKeyHex: string;
  settings: BorrowedOwnerFileStore;
  appSettings(publisherPublicKeyHex: string): BorrowedOwnerFileStore;
  listAppPublishers(): Promise<string[]>;
};
/** MSFile 的 owner 文件句柄与 App publisher 枚举；句柄由 worker 缓存与失效。 */
let msfileRuntimeStores: MsFileRuntimeStores | undefined;
let lastMsFileState: CoordinatorMsFileStateEvent | undefined;
/** 当前 owner 的 BitFS 卖方派生索引；锁定、切 Key 或关闭卖方时立即丢弃。 */
let msfileSellerIndex: BitfsSeedIndex | undefined;
/** 索引重建取消句柄，防止旧 owner 的迟到结果重新发布。 */
let msfileSellerIndexController: AbortController | undefined;
/** 当前 owner 唯一的卖方匹配运行单元。 */
let msfileSellerRuntime: BitfsSellerRuntime | undefined;
/** 当前 owner 唯一的卖方协议端口；未就绪时不得对外报价。 */
let msfileSellerProtocolPort: BitfsSellerProtocolPort | undefined;
/** 当前 owner 唯一的卖方会话管理器；多 Tab 只共享这一份。 */
let msfileSellerSessionManager: BitfsSellerSessionManager | undefined;
/** 当前 owner 的 BitFS 交易 outbox；与普通 P2PKH 业务记录隔离。 */
let msfileBitfsTransactionJournal: BitfsTransactionJournal | undefined;
/** 只通过 Worker 内 WoC 句柄广播/对账的 BitFS 交易器。 */
let msfileBitfsBroadcaster: BitfsTransactionBroadcaster | undefined;
/** 卖方会话 generation；锁定、切 Key、关闭卖方或重建 runtime 时推进。 */
let msfileSellerSessionEpoch = 0;
/** 测试注入的卖方 bridge；生产为 undefined，使用 Window lane + 未就绪端口。 */
let testMsfileSellerBridge: { transport: BitfsSellerStreamTransport; protocol: BitfsSellerProtocolPort } | undefined;

function sellerKeepsVaultUnlocked(): boolean {
  return coordinatorState.vaultStatus === "unlocked"
    && msfileRuntime?.describeState().sellerSettings.sellerEnabled === true;
}

function stopMsfileSellerRuntime(): void {
  msfileSellerSessionEpoch += 1;
  msfileSellerIndexController?.abort();
  msfileSellerIndexController = undefined;
  msfileSellerRuntime?.clear();
  msfileSellerRuntime = undefined;
  const manager = msfileSellerSessionManager;
  msfileSellerSessionManager = undefined;
  msfileSellerProtocolPort = undefined;
  msfileBitfsTransactionJournal = undefined;
  msfileBitfsBroadcaster = undefined;
  manager?.clear();
  msfileSellerIndex?.clear();
  msfileSellerIndex = undefined;
}

/**
 * Worker → Window lane 的 BitFS stream 端口。
 *
 * 中文说明：帧字节由协议端口负责先落盘再交给这里；本适配器只做受限
 * lane operation 转发，Window 侧仍会再次严格解析并做身份 pin。
 */
function createMsfileSellerStreamTransport(): BitfsSellerStreamTransport {
  return {
    async open(input) {
      await requestWindowP2pExecutorOperation({
        type: "lane",
        laneId: "msfile",
        operation: {
          type: "bitfs-seller-open",
          sessionId: input.sessionId,
          addresses: input.addresses,
          publicKeyHex: input.publicKeyHex,
          expectedPeerId: input.expectedPeerId,
          firstFrame: input.firstFrame,
        },
      }, input.signal);
    },
    async send(sessionId, frame) {
      await requestWindowP2pExecutorOperation({
        type: "lane",
        laneId: "msfile",
        operation: { type: "bitfs-seller-send", sessionId, frame },
      });
    },
    async close(sessionId, reason) {
      await requestWindowP2pExecutorOperation({
        type: "lane",
        laneId: "msfile",
        operation: { type: "bitfs-seller-close", sessionId, reason },
      }).catch(() => undefined);
    },
  };
}

/** 当前是否存在可用的 BitFS 卖方 stream 通道。 */
function msfileSellerTransportAvailable(): boolean {
  if (testMsfileSellerBridge) return true;
  return windowP2pExecutorLease?.transportReady === true
    && windowP2pExecutorLease.sessionEpoch === coordinatorState.sessionEpoch;
}

async function configureMsfileSellerRuntime(
  service: MsFileServiceImpl,
  ownerPublicKeyHex: string,
  settings: import("@keymaster/contracts").MsFileSellerSettings,
): Promise<import("@keymaster/contracts").MsFileSellerRuntimeStatus> {
  stopMsfileSellerRuntime();
  if (!settings.sellerEnabled) {
    // 关闭后从当前时刻重新计算自动锁定，而不是沿用暂停前的旧 deadline。
    resetAutoLockTimer();
    return "disabled";
  }
  // 卖方需要持续接单；启用期间只暂停自动锁，手动锁定仍走全局释放路径。
  if (autoLockTimer) clearTimeout(autoLockTimer);
  autoLockTimer = undefined;
  coordinatorState.autoLockDeadline = undefined;
  if (settings.supportedArbiterPublicKeys.length === 0) return "configuration-error";
  service.setSellerRuntimeStatus("indexing");
  const controller = new AbortController();
  msfileSellerIndexController = controller;
  const index = new BitfsSeedIndex();
  msfileSellerIndex = index;
  try {
    const contentStore = createWorkerOwnerFileStore("msfile", "");
    await index.build(contentStore, controller.signal);
    if (controller.signal.aborted || coordinatorState.activePublicKeyHex !== ownerPublicKeyHex || msfileRuntime !== service) {
      return "waiting-unlock";
    }
    const cryptoPort = await createWorkerActiveKeyCrypto(ownerPublicKeyHex);
    const signer = createBitfsVaultSigner(cryptoPort);
    const journalStore = createWorkerOwnerFileStore("msfile", "bitfs-journal");
    const journal = createBitfsJournal(journalStore);
    const transactionJournal = createBitfsTransactionJournal(journalStore);
    const woc = p2pkhWocService;
    // WoC 未装配时仍允许派生索引和 fail-closed 协议端口启动；
    // 任何真实交易广播/高度查询都会明确失败，不会伪造链上事实。
    const chain = woc ? createBitfsWocChainPort(woc, "main") : {
      async broadcast(): Promise<never> { throw new Error("BitFS Worker 内 WoC 服务未就绪"); },
      async lookupTransaction(): Promise<"unknown"> { return "unknown"; },
    };
    const broadcaster = new BitfsTransactionBroadcaster({
      journal: transactionJournal,
      chain,
      nowMs: () => Date.now(),
    });
    const sessions = createBitfsSessionJournal(journalStore);
    // 恢复阶段只查询已持久化的 txid，不自动重播不可逆交易。
    const outcomes = await reconcileBitfsTransactions({ journal: transactionJournal, broadcaster, signal: controller.signal });
    await reconcileBitfsSessionTransactions({ sessions, outcomes, nowMs: Date.now() });
    if (controller.signal.aborted) return "waiting-unlock";
    msfileBitfsTransactionJournal = transactionJournal;
    msfileBitfsBroadcaster = broadcaster;
    msfileSellerRuntime = new BitfsSellerRuntime({
      signer,
      index,
      journal,
      settings: () => service.describeState().sellerSettings,
      nowMs: () => Date.now(),
      allowLoopbackWs: import.meta.env?.DEV === true,
    });
    const protocolPort = testMsfileSellerBridge?.protocol ?? new BitfsSellerProtocol({
      signer,
      sessions,
      // go-bitfs 补齐“exact Kind 5 → 已验证 Hash 视图”前保持 fail closed，
      // 不在 Keymaster 内复制 CBOR 字段位置或授权验证公式。
      content: createUnavailableBitfsSellerContentResolver(),
      broadcaster,
      ownerPublicKeyHex,
      generation: () => msfileSellerSessionEpoch,
      nowMs: () => Date.now(),
      blockHeight: () => {
        if (!woc) throw new Error("BitFS Worker 内 WoC 服务未就绪");
        return woc.getChainHeight("main", { priority: "interactive" });
      },
    });
    const transport = testMsfileSellerBridge?.transport ?? createMsfileSellerStreamTransport();
    const manager: BitfsSellerSessionManager = new BitfsSellerSessionManager({
      transport,
      protocol: protocolPort,
      nowMs: () => Date.now(),
      // 报价期限是最短会话空闲时间；给对端留出付款与交付窗口。
      idleTimeoutMs: () => Math.max(30_000, settings.quoteLifetimeSeconds * 1_000),
      maxSessions: () => service.describeState().sellerSettings.maxConcurrentSales,
      onActiveSessionsChanged: (activeCount) => {
        if (msfileSellerSessionManager !== manager) return;
        if (coordinatorState.vaultStatus !== "unlocked" || coordinatorState.activePublicKeyHex !== ownerPublicKeyHex) return;
        service.setSellerRuntimeStatus(activeCount > 0
          ? "selling"
          : (protocolPort.ready && msfileSellerTransportAvailable() ? "ready" : "degraded"));
      },
      isCurrent: () => msfileSellerSessionManager === manager
        && !controller.signal.aborted
        && coordinatorState.activePublicKeyHex === ownerPublicKeyHex
        && msfileRuntime === service,
    });
    msfileSellerProtocolPort = protocolPort;
    msfileSellerSessionManager = manager;
    // 协议端口未就绪时只能保持 degraded：不报价、不暴露库存。
    return protocolPort.ready ? "ready" : "degraded";
  } catch (error) {
    if (controller.signal.aborted) return "waiting-unlock";
    console.warn("[msfile] seller runtime configuration failed", error instanceof Error ? error.message : String(error));
    stopMsfileSellerRuntime();
    return "configuration-error";
  }
}

/**
 * 消费一条已验证 Hash 请求：命中完整 Seed 且 locator 兼容时建立销售会话。
 *
 * 中文说明：只处理 ChannelProtocol 已验签的 VerifiedHashRequest；未命中保持
 * 静默。报价只在协议端口就绪时产生，且报价字节由 journal 先落盘。
 */
async function handleMsfileSellerHashRequest(
  request: import("bsv8-channel-protocol/hash-request").VerifiedHashRequest,
): Promise<void> {
  const runtime = msfileSellerRuntime;
  const manager = msfileSellerSessionManager;
  const protocolPort = msfileSellerProtocolPort;
  const service = msfileRuntime;
  if (!runtime || !manager || !protocolPort || !service) return;
  if (!protocolPort.ready) return;
  if (coordinatorState.vaultStatus !== "unlocked" || !coordinatorState.activePublicKeyHex) return;
  const ownerPublicKeyHex = coordinatorState.activePublicKeyHex;
  const epoch = msfileSellerSessionEpoch;
  if (manager.activeCount() >= service.describeState().sellerSettings.maxConcurrentSales) return;
  let match: BitfsSellerMatch | null;
  try {
    match = await runtime.match(request);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    console.warn("[msfile] seller hash request match failed", error instanceof Error ? error.message : String(error));
    return;
  }
  if (!match) return;
  // match 期间可能发生锁定、切 Key、关闭卖方或 runtime 重建；迟到结果不得建会话。
  if (epoch !== msfileSellerSessionEpoch
    || msfileSellerRuntime !== runtime
    || msfileSellerSessionManager !== manager
    || coordinatorState.vaultStatus !== "unlocked"
    || coordinatorState.activePublicKeyHex !== ownerPublicKeyHex) return;
  try {
    const publicKeyHex = request.from_public_key;
    await manager.start({
      sessionId: crypto.randomUUID(),
      addresses: match.addresses,
      publicKeyHex,
      // 只从已验证公钥派生 PeerId；不使用请求者自报的 locator PeerId。
      expectedPeerId: peerIdFromPublicKeyBytes(cryptoHexToBytes(publicKeyHex)).toString(),
      quoteBytes: match.quoteBytes,
      seedHashHex: match.seedHashHex,
    });
  } catch (error) {
    console.warn("[msfile] seller session start failed", error instanceof Error ? error.message : String(error));
  }
}

/** Window lane 的 BitFS 事件只允许路由到当前唯一卖方会话管理器。 */
function handleBitfsSellerStreamEvent(rawEvent: unknown, lease: WindowP2pExecutorLeaseState): void {
  if (!rawEvent || typeof rawEvent !== "object") return;
  const event = rawEvent as Partial<BitfsStreamEvent>;
  const manager = msfileSellerSessionManager;
  if (!manager) return;
  if (typeof event.sessionId !== "string" || event.sessionId.length === 0) return;
  // 旧 lease/旧 owner 的迟到事件不得进入新会话。
  if (event.ownerSessionEpoch !== lease.sessionEpoch) return;
  if (event.type === "bitfs-seller-session-closed") {
    void manager.close(event.sessionId, typeof event.reason === "string" ? event.reason : "stream_error").catch(() => undefined);
    return;
  }
  if (event.type !== "bitfs-seller-frame" || !(event.frame instanceof Uint8Array)) return;
  void manager.handleFrame({ sessionId: event.sessionId, frame: event.frame }).catch(() => undefined);
}

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
  const meta = import.meta as ImportMeta & { env?: { DEV?: boolean } };
  return meta.env?.DEV === true ? "testnet" : "mainnet";
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
interface PendingChannelPing {
  /** 创建 Ping 时绑定的 owner session epoch。 */
  ownerSessionEpoch: SessionEpoch;
  /** 创建 Ping 时绑定的 owner 公钥。 */
  ownerPublicKeyHex: string;
  /** Ping 的目标联系人公钥。 */
  contactPublicKeyHex: string;
  /** Ping 的 ChannelProtocol message_id。 */
  messageId: string;
  /** 本地单调时钟起点，仅用于 RTT 诊断。 */
  startedAtMonotonicMs: number;
  /** Ping 的本地过期时间。 */
  expiresAtMs: number;
  /** 本地已签名并验证的 Ping，用于 ChannelProtocol 关系校验。 */
  pingMessage: import("bsv8-channel-protocol/inbox").VerifiedPrivateMessage;
}
const CHANNEL_PENDING_PING_TTL_MS = PING_PRIVATE_MESSAGE_MAX_LIFETIME_MS;
const CHANNEL_PENDING_PING_MAX = 256;
const channelPendingPings = new PendingPingRegistry<PendingChannelPing>(CHANNEL_PENDING_PING_MAX);
let channelPendingPingCleanupTimer: ReturnType<typeof setTimeout> | undefined;
const channelAutoPongBySender = new Map<string, { windowStartedAtMs: number; count: number }>();
let channelAutoPongWindowStartedAtMs = 0;
let channelAutoPongCount = 0;
const CHANNEL_AUTO_PONG_WINDOW_MS = 60_000;
const CHANNEL_AUTO_PONG_MAX_PER_SENDER = 8;
const CHANNEL_AUTO_PONG_MAX_GLOBAL = 64;
/** 入站消息去重只保留有限数量；锁屏、切换 key、重启都会清空。 */
const channelSeenMessages = new Set<string>();
const CHANNEL_SEEN_LIMIT = 4096;
/** 已验签的公开 Hash 请求；只作为 WebRTC offer 关系审查证据。 */
const channelHashRequests = new Map<string, import("bsv8-channel-protocol/hash-request").VerifiedHashRequest>();
const CHANNEL_HASH_REQUEST_LIMIT = 1024;
/** 已验签的 WebRTC offer；后续 answer/ICE 必须引用同一会话。 */
const channelWebrtcOffers = new Map<string, import("bsv8-channel-protocol/inbox").VerifiedPrivateMessage>();
const CHANNEL_WEBRTC_OFFER_LIMIT = 512;

function pruneChannelProtocolRelations(now = Date.now()): void {
  for (const [key, request] of channelHashRequests) {
    if (request.expires_at_ms <= now) channelHashRequests.delete(key);
  }
  for (const [key, offer] of channelWebrtcOffers) {
    if (offer.expires_at_ms <= now) channelWebrtcOffers.delete(key);
  }
  while (channelHashRequests.size > CHANNEL_HASH_REQUEST_LIMIT) {
    const first = channelHashRequests.keys().next().value as string | undefined;
    if (first === undefined) break;
    channelHashRequests.delete(first);
  }
  while (channelWebrtcOffers.size > CHANNEL_WEBRTC_OFFER_LIMIT) {
    const first = channelWebrtcOffers.keys().next().value as string | undefined;
    if (first === undefined) break;
    channelWebrtcOffers.delete(first);
  }
}

function channelHashRequestKey(messageId: string, publisherPublicKeyHex: string): string {
  return `${publisherPublicKeyHex.trim().toLowerCase()}\u0000${messageId}`;
}

function channelHashRequestByMessageId(
  messageId: string,
  publisherPublicKeyHex: string
): import("bsv8-channel-protocol/hash-request").VerifiedHashRequest | undefined {
  pruneChannelProtocolRelations();
  return channelHashRequests.get(channelHashRequestKey(messageId, publisherPublicKeyHex));
}

function channelWebrtcOfferKey(requestMessageId: string, offererPublicKeyHex: string, sessionId: string): string {
  return `${requestMessageId}\u0000${offererPublicKeyHex}\u0000${sessionId}`;
}

function findChannelWebrtcOffer(
  body: import("bsv8-channel-protocol/webrtc-signal").WebRTCSignalV1Body,
  message: import("bsv8-channel-protocol/inbox").VerifiedPrivateMessage
): import("bsv8-channel-protocol/inbox").VerifiedPrivateMessage | undefined {
  pruneChannelProtocolRelations();
  // answer 的 offerer 必须是 answer 的接收者；ICE 双向都可能发送，
  // 但只能在双方公钥对应的完整三元组中找到唯一一条 offer。
  const candidates = body.signal.type === "answer"
    ? [message.to_public_key]
    : [message.from_public_key, message.to_public_key];
  const matches = new Map<string, import("bsv8-channel-protocol/inbox").VerifiedPrivateMessage>();
  for (const offerer of candidates) {
    const key = channelWebrtcOfferKey(body.request_message_id, offerer, body.session_id);
    const offer = channelWebrtcOffers.get(key);
    if (offer) matches.set(key, offer);
  }
  return matches.size === 1 ? matches.values().next().value : undefined;
}

function pruneChannelPendingPings(now = Date.now()): void {
  channelPendingPings.prune((pending) =>
    pending.ownerSessionEpoch === coordinatorState.sessionEpoch
      && pending.ownerPublicKeyHex === coordinatorState.activePublicKeyHex, now);
}

function scheduleChannelPendingPingCleanup(): void {
  if (channelPendingPingCleanupTimer !== undefined) return;
  channelPendingPingCleanupTimer = setTimeout(() => {
    channelPendingPingCleanupTimer = undefined;
    pruneChannelPendingPings();
    if (channelPendingPings.size > 0) scheduleChannelPendingPingCleanup();
  }, Math.min(CHANNEL_PENDING_PING_TTL_MS, 5_000));
}
/** 以 connectionId 隔离入站 handler；supplierId 不是连接实例键。 */
const satIncomingHandlers = new Map<string, { supplierId: string; ownerSessionEpoch: string; supplierGeneration: number; handler: (wire: Uint8Array) => Promise<Uint8Array> }>();
/** Window lane 的连接状态事件；按 connectionId 和完整 fence 路由到当前 owner。 */
const satConnectionStateHandlers = new Map<string, {
  supplierId: string;
  ownerSessionEpoch: string;
  supplierGeneration: number;
  handler: (state: "online" | "degraded" | "closed") => void;
}>();
/** Sat 充值复用 Worker 内的 P2PKH service；只创建一次，不在页面/每个 Tab 创建。 */
let satP2pkhService: P2pkhService | undefined;
let satP2pkhServiceStarting: Promise<P2pkhService> | undefined;
let satP2pkhServiceOwnerPublicKeyHex: string | undefined;
let satP2pkhServiceStartToken = 0;
let satP2pkhServiceStartingToken: number | undefined;
let satP2pkhServiceStartingOwnerPublicKeyHex: string | undefined;

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
const MSFILE_DATA_MAX_QUEUE = 256;
type MsFileDataClass = "stat" | "seed" | "block";
interface MsFileDataWaiter {
  clientId: string;
  dataClass: MsFileDataClass;
  signal: AbortSignal;
  run: () => Promise<CoordinatorResponse>;
  resolve: (response: CoordinatorResponse) => void;
  reject: (error: Error) => void;
  active: boolean;
  onAbort: () => void;
}
const msfileDataWaiters: MsFileDataWaiter[] = [];
const msfileDataActiveByClient = new Map<string, number>();
/** 每个 client 最近一次获得槽位的顺序；用于真正的轮转公平，而不是只靠 FIFO。 */
const msfileDataClientLastServed = new Map<string, number>();
let msfileDataDispatchSequence = 0;
let msfileDataActive = 0;
let msfileStatActive = 0;
let msfileSeedDataActive = 0;
let msfileBlockDataActive = 0;
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

function msfileDataClass(data: CoordinatorMsFileData): MsFileDataClass {
  switch (data.type) {
    case "stat": return "stat";
    case "read-seed": return "seed";
    case "read-block": return "block";
  }
}

function msfileDataClassHasCapacity(dataClass: MsFileDataClass): boolean {
  switch (dataClass) {
    case "stat": return msfileStatActive < msfileReadConcurrencySettings.globalStatConcurrency;
    case "seed": return msfileSeedDataActive < msfileReadConcurrencySettings.globalSeedReadConcurrency;
    case "block": return msfileBlockDataActive < msfileReadConcurrencySettings.globalBlockReadConcurrency;
  }
}

function msfileDataClientActive(clientId: string): number {
  return msfileDataActiveByClient.get(clientId) ?? 0;
}

function pumpMsfileDataWaiters(): void {
  while (true) {
    let selectedIndex = -1;
    let selectedClientLastServed = Number.POSITIVE_INFINITY;
    for (let index = 0; index < msfileDataWaiters.length; index += 1) {
      const waiter = msfileDataWaiters[index]!;
      if (!waiter.active) continue;
      if (waiter.signal.aborted) {
        msfileDataWaiters.splice(index, 1);
        index -= 1;
        waiter.active = false;
        waiter.signal.removeEventListener("abort", waiter.onAbort);
        waiter.reject(msfileError("msfile_unavailable", "MSFile request was cancelled while waiting"));
        continue;
      }
      if (!msfileDataClassHasCapacity(waiter.dataClass)) continue;
      // 同一类资源满时跳过；有可用槽位时按 client 的最近服务顺序轮转。
      // 仅按当前 active 数 + FIFO 会让持续入队的 player 永远压在后来
      // 的 Connect App 前面，因此这里把“最近服务时间”作为主排序键。
      const clientLastServed = msfileDataClientLastServed.get(waiter.clientId) ?? 0;
      if (clientLastServed < selectedClientLastServed) {
        selectedIndex = index;
        selectedClientLastServed = clientLastServed;
      }
    }
    if (selectedIndex < 0) break;
    const waiter = msfileDataWaiters.splice(selectedIndex, 1)[0]!;
    if (!waiter.active) continue;
    waiter.active = false;
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    msfileDataActive += 1;
    if (waiter.dataClass === "stat") msfileStatActive += 1;
    if (waiter.dataClass === "seed") msfileSeedDataActive += 1;
    if (waiter.dataClass === "block") msfileBlockDataActive += 1;
    msfileDataActiveByClient.set(waiter.clientId, msfileDataClientActive(waiter.clientId) + 1);
    msfileDataDispatchSequence += 1;
    msfileDataClientLastServed.set(waiter.clientId, msfileDataDispatchSequence);
    void waiter.run().then(waiter.resolve, waiter.reject).finally(() => {
      msfileDataActive = Math.max(0, msfileDataActive - 1);
      if (waiter.dataClass === "stat") msfileStatActive = Math.max(0, msfileStatActive - 1);
      if (waiter.dataClass === "seed") msfileSeedDataActive = Math.max(0, msfileSeedDataActive - 1);
      if (waiter.dataClass === "block") msfileBlockDataActive = Math.max(0, msfileBlockDataActive - 1);
      const nextClientActive = Math.max(0, msfileDataClientActive(waiter.clientId) - 1);
      if (nextClientActive === 0) msfileDataActiveByClient.delete(waiter.clientId);
      else msfileDataActiveByClient.set(waiter.clientId, nextClientActive);
      if (nextClientActive === 0 && !msfileDataWaiters.some((pending) => pending.active && pending.clientId === waiter.clientId)) {
        msfileDataClientLastServed.delete(waiter.clientId);
      }
      pumpMsfileDataWaiters();
    });
  }
}

function withMsfileDataSlot(
  clientId: string,
  data: CoordinatorMsFileData,
  run: () => Promise<CoordinatorResponse>,
  signal: AbortSignal,
): Promise<CoordinatorResponse> {
  if (signal.aborted) return Promise.reject(msfileError("msfile_unavailable", "MSFile request was cancelled"));
  if (msfileDataWaiters.length >= MSFILE_DATA_MAX_QUEUE) {
    return Promise.reject(msfileError("msfile_unavailable", "MSFile request queue is full"));
  }
  const dataClass = msfileDataClass(data);
  return new Promise<CoordinatorResponse>((resolve, reject) => {
    const waiter: MsFileDataWaiter = {
      clientId,
      dataClass,
      signal,
      run,
      resolve,
      reject,
      active: true,
      onAbort: () => {
        const index = msfileDataWaiters.indexOf(waiter);
        if (index < 0 || !waiter.active) return;
        msfileDataWaiters.splice(index, 1);
        waiter.active = false;
        reject(msfileError("msfile_unavailable", "MSFile request was cancelled while waiting"));
      },
    };
    signal.addEventListener("abort", waiter.onAbort, { once: true });
    msfileDataWaiters.push(waiter);
    pumpMsfileDataWaiters();
  });
}

function rejectMsfileDataWaiters(error = msfileError("msfile_unavailable", "MSFile request queue was cancelled")): void {
  for (const waiter of msfileDataWaiters.splice(0)) {
    if (!waiter.active) continue;
    waiter.active = false;
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.reject(error);
  }
}

async function ensureMsfileRuntime(expectedInstanceId?: string): Promise<MsFileServiceImpl> {
  // 审查修复：锁定 / 未初始化 / fatal 状态不得创建 MSFile runtime。
  if (!isCoordinatorProductEnabled("msfile")) {
    throw msfileError("msfile_unavailable", "MSFile plugin is disabled");
  }
  if (coordinatorState.vaultStatus !== "unlocked") {
    throw msfileError("msfile_unavailable", "MSFile requires an unlocked Vault");
  }
  // owner K-V 只能在统一 Storage 健康门禁打开后装配。尤其是首次解锁
  // 时，Window Host 与 Coordinator owner-apps 阶段可能并发到达；不能让
  // 一个在 recovery 窗口中启动的 service 把临时 unavailable 永久缓存成
  // initializationError。
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
  // Requests must enter through the WebLoom unit setup.  This prevents a
  // lazy RPC from creating a second registry instance that is not owned by the
  // Host context.  The setup path below supplies the real instance identity.
  if (!expectedInstanceId && coordinatorRuntimeApp && !testMsfileRuntimeRecoveryAllowed) {
    await reconcileCoordinatorRuntime();
    if (msfileRuntime) return msfileRuntime;
    throw msfileError("msfile_unavailable", "MSFile WebLoom runtime unit is not ready");
  }
  if (!expectedInstanceId && coordinatorRuntimeApp && testMsfileRuntimeRecoveryAllowed) {
    const hostUnit = coordinatorRuntimeApp.state().units.find((unit) => unit.unitId === "msfile.coordinator-worker");
    if (hostUnit?.instanceId && (hostUnit.state === "enabled" || hostUnit.state === "starting" || hostUnit.state === "error-disabled")) {
      expectedInstanceId = hostUnit.instanceId;
    }
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
      // 设置与供应商是 owner 文件；App 覆盖额度按 publisher 惰性打开
      // `<owner>/app.<publisher>/settings.json`。句柄由 worker 统一缓存、
      // 切 owner/世代时失效，因此这里不 close，也不持有 K-V 生命周期。
      stores = {
        ownerPublicKeyHex,
        settings: createWorkerOwnerFileStore("msfile", ""),
        appSettings: (publisherPublicKeyHex: string) => createWorkerOwnerFileStore("msfile", "app-settings", publisherPublicKeyHex),
        listAppPublishers: listWorkerOwnerAppPublishers,
      };
      const repository = await openMsFileRepository(stores);
      service = createMsFileService({
        repository: repository,
        transport: windowP2pExecutorTransport,
        localSource: createMsFileLocalContentSource(createWorkerOwnerFileStore("msfile", "")),
        onSellerSettingsChanged: (settings) => configureMsfileSellerRuntime(service!, ownerPublicKeyHex, settings),
        notifyStateChange: (_state: MsFileServiceEventState) => emitMsFileState()
      });
      // 服务构造会异步读取 owner 文件；必须等首轮读取完成后再发布实例。
      // 初始化失败的候选实例在这里释放，下一次 control/recovery 可以重试，
      // 不把一次 Storage 竞态变成永久 unavailable。
      await service.waitUntilInitialized();
      assertStorageDataAvailable();
      if (
        startToken !== msfileRuntimeStartToken
        || coordinatorState.vaultStatus !== "unlocked"
        || coordinatorState.activePublicKeyHex?.trim().toLowerCase() !== ownerPublicKeyHex
        || !isCoordinatorProductEnabled("msfile")
      ) {
        throw msfileError("msfile_unavailable", "MSFile runtime startup was superseded");
      }
      msfileRuntimeStores = stores;
      msfileRuntime = service;
      const sellerStatus = await configureMsfileSellerRuntime(service, ownerPublicKeyHex, service.describeState().sellerSettings);
      service.setSellerRuntimeStatus(sellerStatus);
      testMsfileRuntimeRecoveryAllowed = false;
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

async function ensureSatRuntime(expectedInstanceId?: string): Promise<SatWorkerRuntimeState> {
  if (!isCoordinatorProductEnabled("sat-subscription")) {
    throw new Error("SatSubscription plugin is disabled");
  }
  if (coordinatorState.vaultStatus !== "unlocked" || !coordinatorState.activePublicKeyHex) {
    throw new Error("SatSubscription requires an unlocked active key");
  }
  // owner 切换/锁定的退订和连接关闭必须完成后，才能把任何请求交给
  // 新 runtime；否则旧 owner 的清理可能和新 owner 的收费请求并发。
  await satRuntimeRelease.catch(() => undefined);
  if (!isCoordinatorProductEnabled("sat-subscription")) {
    throw new Error("SatSubscription plugin is disabled");
  }
  if (coordinatorState.vaultStatus !== "unlocked" || !coordinatorState.activePublicKeyHex) {
    throw new Error("SatSubscription owner is no longer unlocked");
  }
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
  // A request-side lazy load must be reconciled through the real WebLoom unit
  // setup first, otherwise it could publish a registry instance unrelated to
  // the Host context that owns the public runtime snapshot.
  if (!expectedInstanceId && coordinatorRuntimeApp) {
    await reconcileCoordinatorRuntime();
    if (satRuntime) return satRuntime;
    throw new Error("SatSubscription WebLoom runtime unit is not ready");
  }
  const ownerPublicKeyHex = coordinatorState.activePublicKeyHex;
  const ownerGeneration = Math.max(1, coordinatorState.keyspaceGeneration);
  const expectedSessionEpoch = coordinatorState.sessionEpoch;
  const startToken = satRuntimeStartToken;
  const workerUnit = activateCoordinatorOwnerWorkerUnit("sat-subscription.coordinator-worker", expectedInstanceId);
  const startAbortController = new AbortController();
  satRuntimeStartAbortController = startAbortController;
  const start = (async (): Promise<SatWorkerRuntimeState> => {
    // SatSubscription 只打开 `<owner>/sat-subscription/` 文件根；旧的
    // `.keymaster/.../subscription-state` K-V 不再读取、迁移或删除。
    const store = createWorkerOwnerFileStore("sat-subscription", "");
    const repository = createSatSubscriptionRepository(store, ownerPublicKeyHex);
    let provider: ReturnType<typeof createSatSubscriptionProvider> | undefined;
    let handle: SatSubscriptionHandle | undefined;
    try {
      const loaded = await repository.load();
      // 缺省供应商：dev 用 testnet 网关，正式构建用 mainnet 网关。
      // 已有供应商时保持用户配置；只在供应商为空时补默认出口/入口。
      const initial = applyDefaultSatSupplier(loaded, satDefaultNetwork());
      const state = createSatSubscriptionState({ ownerPublicKeyHex, initial, persistence: repository });
      provider = createSatSubscriptionProvider({
        stateForOwner: async (requestedOwner) => {
          if (requestedOwner !== coordinatorState.activePublicKeyHex || requestedOwner !== ownerPublicKeyHex) throw new Error("SatSubscription owner changed");
          return state;
        },
        transport: satSubscriptionTransport,
        signal: startAbortController.signal,
        ownerGeneration,
        ownerSessionEpoch: expectedSessionEpoch,
        logger: { warn: (event, data) => console.warn("[sat-subscription]", event, data) },
      });
      const privateKeyForSigner = (): Uint8Array => {
        if (coordinatorState.activePublicKeyHex !== ownerPublicKeyHex || !coordinatorState.activePrivateKeyBytes) throw new Error("Sat owner signer is unavailable");
        return coordinatorState.activePrivateKeyBytes;
      };
      handle = await provider.bind({ ownerPublicKeyHex });
      const boundProvider = provider;
      const assertFresh = (): void => {
        if (startToken !== satRuntimeStartToken
          || !isCoordinatorProductEnabled("sat-subscription")
          || coordinatorState.vaultStatus !== "unlocked"
          || coordinatorState.sessionEpoch !== expectedSessionEpoch
          || coordinatorState.activePublicKeyHex !== ownerPublicKeyHex) {
          throw new Error("SatSubscription runtime became stale while starting");
        }
      };
      assertFresh();
      const service = boundProvider.service();
      const admin = boundProvider.adminService();
      const spi = createSatSpiService({
        getRuntime: () => boundProvider.spiRuntime(),
        getOwnerPublicKeyHex: () => coordinatorState.activePublicKeyHex ?? null,
        getOwnerGeneration: () => coordinatorState.activePublicKeyHex === ownerPublicKeyHex ? Math.max(1, coordinatorState.keyspaceGeneration) : null,
        stateForOwner: async (requestedOwner) => {
          if (requestedOwner !== ownerPublicKeyHex || coordinatorState.activePublicKeyHex !== ownerPublicKeyHex) throw new Error("SPI owner changed");
          return state;
        },
        // P2PKH 只服务 SPI 充值；不能因为充值插件启动/初始化失败而阻断
        // 消息、通讯录、在线状态和 WebRTC。真正准备/提交充值时才懒加载。
        getP2pkh: () => ensureSatP2pkhService(),
        deriveP2pkhAddress: async (requestedOwner, network) => {
          if (requestedOwner !== ownerPublicKeyHex || coordinatorState.activePublicKeyHex !== ownerPublicKeyHex) throw new Error("SPI owner changed before address derivation");
          const result = await withCoordinatorFinalIoLease(
            "write",
            undefined,
            () => executeCryptoOperation({ type: "deriveP2pkhAddress", network }, privateKeyForSigner()),
            { auditOperation: "sat.address.derive" },
          );
          if (result.type !== "deriveP2pkhAddress") throw new Error("Failed to derive the owner payment address");
          return result.address;
        },
      });
      if (!service || !admin) throw new Error("SatSubscription provider did not expose its trusted services");
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
      await provider?.shutdown().catch(() => undefined);
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
  satP2pkhServiceStartToken += 1;
  const p2pkh = satP2pkhService;
  const p2pkhStarting = satP2pkhServiceStarting;
  satP2pkhService = undefined;
  satP2pkhServiceOwnerPublicKeyHex = undefined;
  try { p2pkh?.onVaultLocked(); } catch { /* locked cleanup is best effort */ }
  try { p2pkh?.dispose?.(); } catch { /* locked cleanup is best effort */ }
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
  channelSeenMessages.clear();
  channelHashRequests.clear();
  channelWebrtcOffers.clear();
  channelPendingPings.clear();
  if (channelPendingPingCleanupTimer !== undefined) {
    clearTimeout(channelPendingPingCleanupTimer);
    channelPendingPingCleanupTimer = undefined;
  }
  channelAutoPongBySender.clear();
  channelAutoPongWindowStartedAtMs = 0;
  channelAutoPongCount = 0;
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
    const summary = typeof storageController?.getProviderSummary === "function"
      ? await storageController.getProviderSummary().catch(() => null)
      : null;
    const revision = storageRevision + 1;
    const runtimeStatus = typeof storageController?.status === "function" ? storageController.status() : undefined;
    const healthStatus = storageHealthController.status();
    const status = storageStartupFailure || healthStatus === "degraded" || healthStatus === "authentication" || healthStatus === "incompatible"
      ? "degraded"
      : !platformStorageReady || healthStatus !== "ready"
        ? "checking"
        : runtimeStatus ?? "checking";
    const state: CoordinatorStorageStateEvent = {
      topic: "storage.state", type: "storage.state.changed", storageRevision: revision,
      sessionEpoch: coordinatorState.sessionEpoch,
      providerGeneration: summary?.generation ?? null,
      ...(platformRootStore ? { bucketId: platformRootStore.bucket.bucketId, bucketGeneration: platformRootStore.bucket.bucketGeneration } : {}),
      status,
      healthStatus,
      catalogBucket: Boolean(selectedCatalogBucket()),
      ...(coordinatorAuthorityRecovery ? { authorityRecovery: coordinatorAuthorityRecovery } : {}),
      summary,
      capabilities: typeof storageController?.getConditionalCapabilities === "function"
        ? storageController.getConditionalCapabilities()
        : null,
    };
    lastStorageState = state;
    storageRevision = revision;
    publishTopicEvent("storage.state", state);
  }, () => undefined);
}

let skippedInitialStorageHealthSnapshot = false;
storageHealthController.subscribe(() => {
  if (!skippedInitialStorageHealthSnapshot) {
    skippedInitialStorageHealthSnapshot = true;
    return;
  }
  emitStorageState();
});

/**
 * Coordinator-owned Storage recovery pipeline. Provider 恢复只是第一步；
 * Root、Vault metadata、业务任务和旧资源句柄必须在同一条编排链上恢复。
 */
async function runStorageRecoveryOrchestrator(peerId?: string): Promise<void> {
  if (storageRecoveryOrchestrator) return storageRecoveryOrchestrator;
  storageRecoveryOrchestrator = (async () => {
    if (!platformRootStore) {
      if (!storageBootstrapState) throw storageUnavailableError("Storage bootstrap selection is unavailable");
      await bootstrapPlatformStorage(undefined, peerId);
    } else {
      // 恢复只替换当前底层绑定；任务 runtime 仍持有 wrapper，不能把
      // wrapper 永久 close，否则恢复后的下一次调度必然失败。
      for (const store of workerOwnerStores) store.invalidateBinding();
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
    storageHealthController.setStatus("ready");
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
 * 用户的保存/读取请求会收到原始错误并可在原页面重试；启动健康状态只由
 * 启动恢复和用户明确点击的“重试存储”改变。
 */
function markStorageIoFailure(error: unknown): void {
  if (!platformStorageReady) return;
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (code !== "storage_provider_error" && code !== "storage_unavailable") return;
  if (code === "storage_unavailable" && /cancel|abort|closed|stale|fenced|binding|owner storage requests did not drain|key\/session transition/i.test(message)) return;
  // 仅保留脱敏日志；不要调用 health.setStatus、blockWorkerTasksForStorage
  // 或 probeStorageAndRecover。业务错误必须就地返回，恢复动作由用户重试
  // 业务操作，或显式点击存储页的“重试”触发。
  console.warn("[storage] business I/O failed", {
    code,
    message: code === "storage_provider_error" ? "Storage provider operation failed" : "Storage is unavailable"
  });
}

/** Provider 探测、Root 重绑、Journal 收敛和任务恢复的单次原子操作。 */
async function probeStorageAndRecover(peerId?: string): Promise<void> {
  const snapshot = await storageHealthController.probe(
    async () => {
      const provider = platformBucketProvider;
      if (!provider) throw Object.assign(new Error("Storage provider is unavailable"), { code: "storage_unavailable" });
      // 已探测过的桶直接复用能力缓存，只做读取健康检查；未探测时实测并写回。
      const binding = selectedCatalogBucket();
      const cached = binding && binding.deviceRecord.location.providerId === "s3"
        ? (binding.deviceRecord as Extract<DeviceRecordV1, { location: { providerId: "s3" } }>).capabilities?.conditionalWrites
        : undefined;
      if (!cached) {
        const result = await provider.probe();
        if (!result.ok || result.conditionalWrites === "unsupported") {
          throw Object.assign(new Error("Storage bucket does not support required conditional writes"), { code: "storage_provider_error" });
        }
        if (binding) await updateDeviceRecordCapabilities(binding.bucketId, result.conditionalWrites, peerId);
      }
    },
    async () => {
      await runStorageRecoveryOrchestrator(peerId);
    }
  );
  if (snapshot.status !== "ready") {
    storageStartupFailure = true;
    emitStorageState();
    throw storageUnavailableError(snapshot.message ?? "Storage recovery is unavailable");
  }
  platformStorageReady = true;
  storageStartupFailure = false;
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
    || storageHealthController.status() === "degraded"
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

function pumpStorageDataWaiters(): void {
  while (storageDataActive < STORAGE_DATA_CONCURRENCY && storageDataWaiters.length) {
    let index = storageDataWaiters.findIndex((waiter) => (storageDataActiveByPort.get(waiter.clientId) ?? 0) < STORAGE_DATA_MAX_ACTIVE_PER_PORT);
    if (index < 0) index = 0; // no competing port: do not strand a single client
    const waiter = storageDataWaiters.splice(index, 1)[0]!;
    if (!waiter.active) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      continue;
    }
    if (waiter.signal?.aborted) {
      waiter.active = false;
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject(storageCoordinatorError("storage_unavailable", "Storage request cancelled"));
      continue;
    }
    waiter.active = false;
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    storageDataActive += 1;
    storageDataActiveByPort.set(waiter.clientId, (storageDataActiveByPort.get(waiter.clientId) ?? 0) + 1);
    waiter.resolve();
  }
}

interface StorageDataSlotLifecycle {
  /** 物理 Provider Promise 已真正开始执行。 */
  onPhysicalStart?: () => void;
  /** 物理 Provider Promise 已 settle；此时才允许释放并发槽。 */
  onPhysicalSettled?: () => void;
}

/**
 * 取得 Storage physical slot。
 *
 * cancel 只结束调用方等待的 RPC，不结束 Provider 自己的 Promise。槽位和
 * 每端口 physical 计数必须等真实 Promise settle 后才释放，否则忽略
 * AbortSignal 的 Provider 可以被反复 cancel 绕过全局并发上限。
 */
async function withStorageDataSlot<T>(
  clientId: string,
  run: () => Promise<T>,
  signal?: AbortSignal,
  lifecycle?: StorageDataSlotLifecycle
): Promise<T> {
  let slotHeld = false;
  const releasePhysicalSlot = (): void => {
    if (!slotHeld) return;
    slotHeld = false;
    storageDataActive = Math.max(0, storageDataActive - 1);
    const nextPort = Math.max(0, (storageDataActiveByPort.get(clientId) ?? 1) - 1);
    if (nextPort) storageDataActiveByPort.set(clientId, nextPort); else storageDataActiveByPort.delete(clientId);
    pumpStorageDataWaiters();
    lifecycle?.onPhysicalSettled?.();
  };

  if (signal?.aborted) throw storageCoordinatorError("storage_unavailable", "Storage request cancelled");
  if (storageDataActive >= STORAGE_DATA_CONCURRENCY || (storageDataActiveByPort.get(clientId) ?? 0) >= STORAGE_DATA_MAX_ACTIVE_PER_PORT) {
    if (storageDataWaiters.length >= STORAGE_DATA_MAX_QUEUE) throw storageCoordinatorError("storage_limit_exceeded");
    await new Promise<void>((resolve, reject) => {
      const waiter: StorageDataWaiter = { resolve, reject, signal, active: true, clientId };
      const abort = () => {
        if (!waiter.active) return;
        waiter.active = false;
        const index = storageDataWaiters.indexOf(waiter);
        if (index >= 0) storageDataWaiters.splice(index, 1);
        signal?.removeEventListener("abort", abort);
        reject(storageCoordinatorError("storage_unavailable", "Storage request cancelled"));
      };
      waiter.onAbort = abort;
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener("abort", abort, { once: true });
      storageDataWaiters.push(waiter);
    });
    // pumpStorageDataWaiters() 在 resolve waiter 后到这里之间可能发生
    // abort；这时已占用的 slot 不能泄漏，但也不能启动 Provider。
    slotHeld = true;
    if (signal?.aborted) {
      releasePhysicalSlot();
      throw storageCoordinatorError("storage_unavailable", "Storage request cancelled");
    }
  } else {
    storageDataActive += 1;
    storageDataActiveByPort.set(clientId, (storageDataActiveByPort.get(clientId) ?? 0) + 1);
    slotHeld = true;
  }

  lifecycle?.onPhysicalStart?.();
  const operation = Promise.resolve().then(run);
  // 这里是唯一的 physical slot release 点。不能放到下面 RPC race 的
  // finally，否则 cancel 会在 Provider 仍运行时把槽位重新交给新请求。
  void operation.then(releasePhysicalSlot, releasePhysicalSlot);
  let onAbort: (() => void) | undefined;
  try {
    if (!signal) return await operation;
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(storageCoordinatorError("storage_unavailable", "Storage request cancelled"));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    return await Promise.race([operation, cancelled]);
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
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
  if (testStorageStartupFailure) { storageStartupFailure = true; storageHealthController.setStatus("degraded", "Storage startup failed"); emitStorageState(); throw storageCoordinatorError("storage_unavailable"); }
  const startupError = (error: unknown): never => {
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
    const currentHealth = storageHealthController.status();
    if (currentHealth === "unselected" || currentHealth === "authentication") {
      storageStartupFailure = false;
      emitStorageState();
    } else {
      storageStartupFailure = true;
      storageHealthController.setStatus("degraded", error instanceof Error ? error.message : String(error));
      emitStorageState();
    }
    if (typeof code === "string" && code.startsWith("storage_")) throw error;
    throw storageCoordinatorError("storage_unavailable");
  };
  try {
    if (!storageRepository) {
      if (!platformRootStore) await bootstrapPlatformStorage(undefined, peerId);
      const root = platformRootStore;
      if (!root) throw new Error("Platform storage root is unavailable");
      platformStorageStore = await root.openPlatformStore({ declaration: CENTRAL_STORAGE_DECLARATIONS.storageMultipartUploads });
      registerCoordinatorKeyValueMaintenanceStore(platformStorageStore);
      storageRepository = await openMultipartUploadRepository(platformStorageStore);
    }
  } catch (error) { startupError(error); }
  const multipartUploadRepository = storageRepository;
  if (!multipartUploadRepository) return startupError(new Error("Storage repository is unavailable"));
  let runtime: StorageRuntimeController;
  try {
    runtime = await createStorageRuntimeController({
      multipartUploadRepository,
      bucketProvider: platformBucketProvider,
      bucketGeneration: platformRootStore?.bucket.bucketGeneration,
      logger: { warn: (event) => undefined }
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
  // StorageRuntimeControllerImpl's dispose aborts its request controller and destroys the
  // S3 client without waiting for remote multipart cleanup.
  const storageUnit = coordinatorWorkerUnitRegistry.get("storage.coordinator-worker");
  (storageController as (StorageRuntimeController & { dispose?: () => void }) | undefined)?.dispose?.();
  storageController = undefined;
  storageRepository = undefined;
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

interface TaskRuntime {
  id: string;
  pluginId: string;
  /** 稳定运行单元身份；与用户可启停的产品 id 分开。 */
  unitId: string;
  /** 本次 Worker 装配的运行实例；任务重建后必须变化。 */
  instanceId: string;
  state: "idle" | "queued" | "running" | "blocked";
  controller?: AbortController;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastAttemptAt?: string;
  nextRunAt?: string;
  error?: string;
  blockedReason?: string;
  timer?: ReturnType<typeof setTimeout>;
  keyScope?: { publicKeyHex: string; label?: string } | (() => { publicKeyHex: string; label?: string } | undefined);
  intervalMs?: number;
  /**
   * 同步策略（2026-09-20 智能调度）：
   *   - "managed"：间隔由同步管理设置决定（30 秒 / 1 分钟 / 5 分钟 / 关闭）。
   *   - "smart"：由 WoC 空闲 2 秒的智能调度驱动，没有固定周期。
   *   - "fixed"/缺省：平台固定周期或测试任务，不读取同步管理设置。
   */
  syncPolicy?: "managed" | "smart" | "fixed";
  run?: (context: { signal: AbortSignal; reason: string; reportProgress(progress: unknown): void; assertSessionFresh(): void }) => Promise<void>;
  startedEpoch?: SessionEpoch;
  startedGeneration?: number;
  startedPublicKeyHex?: string;
  completion?: Promise<void>;
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

function bridgeRequestWithoutSignal(input: LocalStorageBridgeRequest): LocalStorageBridgeRequest {
  if (input.type === "put") {
    // Provider callers put the internal AbortSignal in the write-condition
    // object as well as on the request. Neither copy is structured-cloneable.
    const { signal, condition, ...request } = input;
    void signal;
    return { ...request, ...(condition ? { condition: { ifMatch: condition.ifMatch, ifNoneMatch: condition.ifNoneMatch } } : {}) };
  }
  const { signal, ...request } = input;
  void signal;
  return request;
}

/** TypedArray 的 RPC DTO 校验是 O(bytes)；跨桥字节统一用精确 ArrayBuffer。 */
function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer as ArrayBuffer
    : bytes.slice().buffer as ArrayBuffer;
}

/** Window reverse capability 返回的 ArrayBuffer 字节 -> Provider 内部 Uint8Array。 */
function localStorageResponseFromDto(response: CoordinatorLocalStorageResponse): LocalStorageBridgeResponse {
  const object = (value: import("@keymaster/contracts").CoordinatorLocalStorageObject): { path: string; bytes: Uint8Array; size?: number; etag?: string; lastModified?: string } => ({
    path: value.path,
    bytes: new Uint8Array(value.bytes),
    ...(value.size === undefined ? {} : { size: value.size }),
    ...(value.etag === undefined ? {} : { etag: value.etag }),
    ...(value.lastModified === undefined ? {} : { lastModified: value.lastModified }),
  });
  if (response.type === "object") {
    return response.object === undefined ? { type: "object" } : { type: "object", object: object(response.object) };
  }
  if (response.type === "list") {
    return {
      type: "list",
      objects: response.objects.map(object),
      ...(response.nextCursor === undefined ? {} : { nextCursor: response.nextCursor }),
    };
  }
  return response;
}

/** 将旧 Provider 内部请求收窄为 Window reverse capability 的纯 DTO。 */
function coordinatorLocalStorageRequest(input: LocalStorageBridgeRequest, binding: CoordinatorSessionBinding): CoordinatorLocalStorageRequest {
  const withoutSignal = bridgeRequestWithoutSignal(input) as unknown as Record<string, unknown>;
  const { authorityInstanceId: _authorityInstanceId, leaseId: _leaseId, peerGeneration: _peerGeneration, sessionEpoch: _sessionEpoch, ...request } = withoutSignal;
  const wire = request.type === "put" && request.bytes instanceof Uint8Array
    ? { ...request, bytes: exactArrayBuffer(request.bytes) }
    : request;
  return { ...wire, ...binding } as unknown as CoordinatorLocalStorageRequest;
}

/**
 * Coordinator → Window 的 LocalStorage 唯一反向调用面。peerId 只来自
 * WebLoom HandlerCallContext/会话绑定；绝不从页面请求或“最后活动页面”推导。
 */
function requestLocalStorageBridge(input: LocalStorageBridgeRequest, peerId?: string): Promise<LocalStorageBridgeResponse> {
  const opening = coordinatorOpeningSession;
  const temporaryPeerId = peerId === undefined && storageIoOwner === undefined && opening
    ? (() => { assertCoordinatorSessionOpenFresh(opening); return opening.peerId; })()
    : undefined;
  const targetPeerId = peerId ?? storageIoOwner?.peerId ?? temporaryPeerId;
  const signal = input.signal ?? opening?.signal;
  if (signal?.aborted) throw storageUnavailableError("Local storage bridge request was cancelled");
  if (testLocalStorageBridgeOverride) return testLocalStorageBridgeOverride(input);
  const state = targetPeerId ? coordinatorPeerState(targetPeerId) : undefined;
  if (!state || state.peer.scope.state !== "active") throw storageUnavailableError("Local storage bridge is unavailable");
  const binding = opening !== undefined && opening.state === state && (peerId === undefined || peerId === opening.peerId)
    ? opening.binding
    : coordinatorSessionBinding(state);
  if (!binding) throw coordinatorSessionStaleError("Coordinator LocalStorage bridge has no committed session binding");
  assertCoordinatorBridgeFresh(state, binding, opening);
  const request = coordinatorLocalStorageRequest(input, binding);
  const controller = new AbortController();
  const sourceSignal = signal;
  const onAbort = (): void => controller.abort();
  if (sourceSignal?.aborted) throw storageUnavailableError("Local storage bridge request was cancelled");
  sourceSignal?.addEventListener("abort", onAbort, { once: true });
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => { settle = resolve; });
  const pending: CoordinatorBridgeRequest = { controller, settled };
  state.bridgeRequests.add(pending);
  const cleanup = (): void => {
    sourceSignal?.removeEventListener("abort", onAbort);
    state.bridgeRequests.delete(pending);
    settle();
  };
  try {
    // Capability clients normally return a rejected Promise for dispatch
    // failures, but a peer adapter can also throw before returning one. The
    // pending record is already visible to close/drain at this point, so the
    // synchronous path must use the same cleanup as finally.
    const call = state.peer.capability(COORDINATOR_LOCAL_STORAGE_RPC_CAPABILITY).call(request, {
      signal: controller.signal,
      operationId: generateRequestId(),
    }) as Promise<CoordinatorLocalStorageResponse>;
    return Promise.resolve(call).then((response) => {
      assertCoordinatorBridgeFresh(state, binding, opening);
      return localStorageResponseFromDto(response);
    }).finally(cleanup);
  } catch (error) {
    cleanup();
    return Promise.reject(error);
  }
}

// ============================================================
// 2. Worker Global State
// ============================================================

const coordinatorState: CoordinatorState = {
  sessionEpoch: generateEpoch(),
  vaultStatus: "booting",
  keyspaceGeneration: 0,
  taskRuntimes: new Map(),
  scheduleSettings: { taskIntervals: {} },
  autoLockTimeoutMs: AUTO_LOCK_DEFAULT_TIMEOUT_MS,
  lastActivityAt: Date.now(),
};

/**
 * 领域兼容运行态表。
 *
 * WebLoom Host 是对外运行单元状态的唯一来源；这张表暂时保留给现有
 * Coordinator 任务和最终 I/O 清理代码保存领域句柄。它不再直接生成
 * `worker.units` / bootstrap 的公开快照，避免手工 Registry 伪装成 Runtime
 * Host。
 */
const coordinatorWorkerUnitRegistry = createCoordinatorWorkerUnitRegistry(undefined, {
  onChange: () => publishCoordinatorWorkerUnitSnapshot(),
});

let coordinatorRuntimeApp: ReturnType<typeof startSharedWorkerApp> | undefined;
let coordinatorRuntimeUnitSnapshotRevision = 0;
type CoordinatorPeerHandoffNotifier = (peerId: string, handoffRevision?: number) => boolean;
let testCoordinatorPeerHandoffNotifier: CoordinatorPeerHandoffNotifier | undefined;

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

function coordinatorRuntimeUnitVisible(unit: (typeof COORDINATOR_WORKER_UNIT_CATALOG)[number]): boolean {
  if (!isCoordinatorProductEnabled(unit.productId)) return false;
  if (unit.scopeKind === "storage" && !platformStorageReady) return false;
  if (unit.scopeKind === "owner-session") {
    return coordinatorState.vaultStatus === "unlocked" && Boolean(coordinatorState.activePublicKeyHex);
  }
  return true;
}

/** 将 WebLoom Host 的 unit state 投影为 Keymaster 旧协议的领域快照。 */
function coordinatorRuntimeUnitSnapshots(): CoordinatorWorkerUnitSnapshot[] {
  const app = coordinatorRuntimeApp;
  // Host 尚未完成装配时 fail closed；公开协议不能退回到领域兼容表，
  // 否则首个 bootstrap 可能把手工 Registry 误报成已由 WebLoom 启动。
  if (!app) return [];
  const runtimeState = app.state();
  if (runtimeState.state === "failed" || runtimeState.state === "disposed") return [];
  const revision = Math.max(1, runtimeState.revision);
  coordinatorRuntimeUnitSnapshotRevision = Math.max(coordinatorRuntimeUnitSnapshotRevision, revision);
  const snapshots: CoordinatorWorkerUnitSnapshot[] = [];
  for (const runtimeUnit of runtimeState.units) {
    const descriptor = COORDINATOR_WORKER_UNIT_CATALOG.find((candidate) => candidate.unitId === runtimeUnit.unitId);
    if (!descriptor || runtimeUnit.runtime !== "shared-worker" || !coordinatorRuntimeUnitVisible(descriptor)) continue;
    if (runtimeUnit.state !== "enabled" && runtimeUnit.state !== "starting" && runtimeUnit.state !== "error-disabled") continue;
    if (!runtimeUnit.instanceId) continue;
    const state = runtimeUnit.state === "error-disabled" ? "failed" : runtimeUnit.state === "enabled" ? "ready" : "starting";
    snapshots.push({
      productId: descriptor.productId,
      unitId: descriptor.unitId,
      runtime: "shared-worker",
      scopeKind: descriptor.scopeKind,
      instanceId: runtimeUnit.instanceId,
      state,
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
  if (descriptor && !isCoordinatorProductEnabled(descriptor.productId)) {
    throw new Error(`Plugin disabled: ${descriptor.productId}`);
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
function bindCoordinatorTaskUnitsToOwner(snapshot = currentPluginIntentSnapshot()): void {
  if (coordinatorState.vaultStatus !== "unlocked" || !coordinatorState.activePublicKeyHex) return;
  const identity = currentOwnerWorkerUnitIdentity();
  const activated = new Map<string, ReturnType<typeof coordinatorWorkerUnitRegistry.activate>>();
  for (const runtime of coordinatorState.taskRuntimes.values()) {
    // disable → enable 可能发生在旧任务仍等待 Provider 返回期间。旧
    // completion 尚未结束时不能先发布一个新的 ready unit；否则快照会同时
    // 代表两个物理世代，下一次调度也可能与旧 I/O 重叠。旧 completion 的
    // finally 会在收尾后重新进入 scheduleRuntime，届时由 executeTask 懒加载
    // 新实例。
    if (runtime.completion) continue;
    const unit = getCoordinatorWorkerUnitForTask(runtime.id);
    if (!unit) continue;
    if (!isCoordinatorProductEnabled(unit.productId, snapshot) || coordinatorTaskBlockedReason(runtime, snapshot)) continue;
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
    if (!isCoordinatorProductEnabled(productId, snapshot)) continue;
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

/** Vault 的私钥/Keyspace 管理外壳属于 Worker root，随 Worker 重启而重建。 */
function activateCoordinatorRootWorkerUnits(): void {
  const vaultUnit = coordinatorWorkerUnitRegistry.activate("vault.coordinator-worker");
  if (vaultUnit.state === "starting") {
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

/** Transfer ownership of the worker's active private-key buffer. */
function replaceActivePrivateKey(next: Uint8Array | undefined): void {
  const previous = coordinatorState.activePrivateKeyBytes;
  if (previous && previous !== next) previous.fill(0);
  coordinatorState.activePrivateKeyBytes = next;
}

/** Drop the worker-owned active private-key buffer. */
function dropActivePrivateKey(): void {
  replaceActivePrivateKey(undefined);
}

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
let assetDataRevision = 0;
let contactsPresenceRevision = 0;
/** 统一主会话只保留一个自动锁定计时器；旧计时器不能跨解锁世代存活。 */
let autoLockTimer: ReturnType<typeof setTimeout> | undefined;
let lastContactsPresenceState: CoordinatorContactsPresenceEvent | undefined;
let contactsPresencePublishTail: Promise<void> = Promise.resolve();
function resolveKeyScope(runtime: TaskRuntime): { publicKeyHex: string; label?: string } | undefined { return typeof runtime.keyScope === "function" ? runtime.keyScope() : runtime.keyScope; }

/** Coordinator 真实任务的最终 I/O 审计入口；测试任务不进入生产台账。 */
const COORDINATOR_TASK_FINAL_IO_AUDIT: Readonly<Record<string, FinalIoAuditOperation>> = Object.fromEntries(
  COORDINATOR_WORKER_UNIT_CATALOG.flatMap((unit) => unit.finalIoAuditEntries.map((entry) => [entry.taskId, entry.operation] as const)),
);

function currentPluginIntentSnapshot(): PluginIntentSnapshot {
  return pluginIntentController?.snapshot() ?? coordinatorMeta.pluginIntent ?? emptyPluginIntentSnapshot();
}

/** Worker 侧产品启用判定；未知产品默认拒绝，测试任务使用显式 test 例外。 */
function isCoordinatorProductEnabled(pluginId: string, snapshot = currentPluginIntentSnapshot()): boolean {
  if (pluginId === "test") return true;
  if (BUILTIN_ALWAYS_ON_PLUGIN_PRODUCT_ID_SET.has(pluginId)) return true;
  if (!BUILTIN_PLUGIN_PRODUCT_ID_SET.has(pluginId)) return false;
  return snapshot.desiredEnabled[pluginId] !== false;
}

function coordinatorTaskBlockedReason(runtime: TaskRuntime, snapshot = currentPluginIntentSnapshot()): string | undefined {
  const dependencies = [
    ...getCoordinatorWorkerProductDependenciesForTask(runtime.id),
  ];
  if (dependencies.length === 0) {
    dependencies.push("background", runtime.pluginId);
  }
  // P2PKH 链上数据（历史 + UTXO 快照）只有 WoC 一个来源；WOC 被停用时，
  // 相关任务必须在入口处阻断，而不是先启动一次再等 provider-unavailable。
  if (runtime.id === "p2pkh.transactions-sync" || runtime.id === "p2pkh.utxo-snapshot" || runtime.id === "token-bsv21.sync" || runtime.id === "token-stas.sync" || runtime.id === "collectible-1satordinals.sync") {
    if (!dependencies.includes("woc")) dependencies.push("woc");
  }
  const disabled = dependencies.find((pluginId) => !isCoordinatorProductEnabled(pluginId, snapshot));
  return disabled ? `Plugin disabled: ${disabled}` : undefined;
}

function isPluginIntentBlockedReason(reason: string | undefined): boolean {
  return typeof reason === "string" && reason.startsWith("Plugin disabled: ");
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
      reason: { key: "plugin.blocked.disabled", fallback: `Plugin disabled: ${pluginId}` },
    },
  };
}

/** Provider 产品的启停也必须投影到真实 registry，不能只改变 Window UI。 */
function reconcileCoordinatorProviderIntent(snapshot: PluginIntentSnapshot): boolean {
  if (!p2pkhRegistry) return false;
  let changed = false;
  const wocEnabled = isCoordinatorProductEnabled("woc", snapshot);
  const hasWocBroadcast = Boolean(p2pkhRegistry.getBroadcastProvider("woc", "main"));
  if (!wocEnabled) {
    if (hasWocBroadcast) {
      p2pkhRegistry.unregisterBroadcastProvider?.("woc");
      changed = true;
    }
  } else if (p2pkhWocService && !hasWocBroadcast) {
    registerWocP2pkhProviders({ registry: p2pkhRegistry, woc: p2pkhWocService });
    changed = true;
  }
  if (changed) {
    // Provider 被撤权后，取消当前同步 run；恢复时由同一 task 重新开始。
    void cancelP2pkhSyncForProviderChange().catch(() => undefined);
  }
  return changed;
}

/** 把产品级意图同步投影到真实 Worker 单元实例；停止不只撤 Provider。 */
function reconcileCoordinatorWorkerUnitIntent(snapshot: PluginIntentSnapshot): boolean {
  let changed = false;
  for (const unit of coordinatorWorkerUnitRegistry.snapshots()) {
    if (unit.scopeKind !== "root" && !isCoordinatorProductEnabled(unit.productId, snapshot)) {
      changed = coordinatorWorkerUnitRegistry.stop(unit.unitId, unit.instanceId) || changed;
    }
  }

  // 这两个服务拥有独立的异步/远端资源，先同步撤掉 unit，再让领域清理
  // 复用原有恢复仓库和物理退订流程；清理结果不会重新激活旧 instance。
  if (!isCoordinatorProductEnabled("msfile", snapshot) && (msfileRuntime || msfileRuntimeStarting)) {
    releaseMsfileRuntime("plugin intent disabled");
    changed = true;
  }
  if (!isCoordinatorProductEnabled("sat-subscription", snapshot)
    && (satRuntime || satRuntimeStarting || coordinatorWorkerUnitRegistry.get("sat-subscription.coordinator-worker"))) {
    void releaseSatRuntime("plugin intent disabled").catch(() => undefined);
    changed = true;
  }

  if (coordinatorState.vaultStatus === "unlocked" && coordinatorState.activePublicKeyHex) {
    // 启用后只重建当前仍满足依赖的实际 task/service 单元；不为静态声明
    // 伪造 ready 快照，未使用的服务继续保持懒加载。
    bindCoordinatorTaskUnitsToOwner(snapshot);
  }
  return changed;
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
const WOC_IDLE_SYNC_DEBOUNCE_MS = 2_000;

let smartSyncIdleTimer: ReturnType<typeof setTimeout> | undefined;
let smartSyncDebounceMs = WOC_IDLE_SYNC_DEBOUNCE_MS;

/** managed 任务的当前间隔；未配置时使用平台缺省（5 分钟）。 */
function managedIntervalFor(taskId: string): number {
  const configured = coordinatorState.scheduleSettings.taskIntervals[taskId];
  return typeof configured === "number" ? configured : BACKGROUND_SYNC_DEFAULT_INTERVAL_MS;
}

/** 归一化同步管理设置：只保留已登记任务与合法选项，非法值直接丢弃。 */
function normalizeBackgroundSyncSettings(settings: CoordinatorBackgroundSyncSettings | undefined): CoordinatorBackgroundSyncSettings {
  const taskIntervals: Record<string, number> = {};
  const options = BACKGROUND_SYNC_INTERVAL_OPTIONS_MS as readonly number[];
  for (const taskId of BACKGROUND_MANAGED_SYNC_TASK_IDS) {
    const raw = settings?.taskIntervals?.[taskId];
    if (typeof raw === "number" && options.includes(raw)) taskIntervals[taskId] = raw;
  }
  return { taskIntervals };
}

function cancelSmartSyncIdleTimer(): void {
  if (smartSyncIdleTimer !== undefined) {
    clearTimeout(smartSyncIdleTimer);
    smartSyncIdleTimer = undefined;
  }
}

function isWocQueueIdle(snapshot: WocQueueSnapshot): boolean {
  return snapshot.queued === 0 && snapshot.inFlight === 0;
}

/** 智能调度只在可运行会话里计时：锁定 / 无 active key 时不挂计时器。 */
function canArmSmartSync(): boolean {
  return coordinatorState.vaultStatus === "unlocked" && Boolean(coordinatorState.activePublicKeyHex);
}

/**
 * 启动 2 秒计时。
 * 设计缘由：计时是「任务完成后」计时——WoC 队列变忙会取消计时，变空
 * 后再重新计时；429 backoff 期间自动把计时推迟到 backoff 解除。
 */
function armSmartSyncIdleTimer(snapshot: WocQueueSnapshot = p2pkhWocService?.getQueueSnapshot() ?? { queued: 0, inFlight: 0, coordinated: false }): void {
  if (smartSyncIdleTimer !== undefined) return;
  const now = Date.now();
  const backoffDelay = snapshot.backoffUntil && snapshot.backoffUntil > now ? snapshot.backoffUntil - now : 0;
  smartSyncIdleTimer = setTimeout(() => {
    smartSyncIdleTimer = undefined;
    // 计时期间发生锁定 / 切 owner 时不得触发同步。
    if (!canArmSmartSync()) return;
    triggerSmartSync(BACKGROUND_TRIGGER_REASON.IDLE_SYNC);
  }, Math.max(smartSyncDebounceMs, backoffDelay));
}

/** WoC 队列事件：忙则取消计时；空闲且会话可运行时从这一刻开始重新计时 2 秒。 */
function onWocQueueChanged(snapshot: WocQueueSnapshot): void {
  if (!isWocQueueIdle(snapshot)) {
    cancelSmartSyncIdleTimer();
    return;
  }
  if (canArmSmartSync()) armSmartSyncIdleTimer(snapshot);
}

/** 若会话可运行且 WoC 当前空闲（或测试环境没有 WoC 服务），重新开始 2 秒计时。 */
function armSmartSyncIfIdle(): void {
  if (!canArmSmartSync()) return;
  const snapshot = p2pkhWocService?.getQueueSnapshot();
  if (!snapshot || isWocQueueIdle(snapshot)) armSmartSyncIdleTimer(snapshot);
}

/** 触发所有 smart 任务（余额快照）；正在运行的任务由 executeTask 自身去重。 */
function triggerSmartSync(reason: string): void {
  for (const runtime of coordinatorState.taskRuntimes.values()) {
    if (runtime.syncPolicy !== "smart") continue;
    void executeTask(runtime.id, reason).catch(() => undefined);
  }
}

/**
 * 解锁 / 初始化后立即同步一次。
 * smart 任务立即刷新余额；managed 任务只有未关闭（间隔 > 0）时才跑。
 */
function triggerImmediateSync(reason: string): void {
  if (coordinatorState.vaultStatus !== "unlocked" || !coordinatorState.activePublicKeyHex) return;
  for (const runtime of coordinatorState.taskRuntimes.values()) {
    if (runtime.syncPolicy === "smart") {
      void executeTask(runtime.id, reason).catch(() => undefined);
      continue;
    }
    if (runtime.syncPolicy === "managed" && (runtime.intervalMs ?? 0) > 0) {
      void executeTask(runtime.id, reason).catch(() => undefined);
    }
  }
}

/** 让定时器本身也服从产品意图，避免 disable 后留下隐藏的 Worker 入口。 */
function scheduleRuntime(runtime: TaskRuntime): void {
  const intentBlockedReason = coordinatorTaskBlockedReason(runtime);
  if (intentBlockedReason) {
    if (runtime.timer) clearTimeout(runtime.timer);
    runtime.timer = undefined;
    runtime.nextRunAt = undefined;
    if (runtime.state !== "running") {
      runtime.state = "blocked";
      runtime.blockedReason = intentBlockedReason;
    }
    return;
  }
  // smart 任务没有固定周期：由 WoC 空闲 2 秒的智能调度驱动。
  if (runtime.syncPolicy === "smart") {
    if (runtime.timer) clearTimeout(runtime.timer);
    runtime.timer = undefined;
    runtime.nextRunAt = undefined;
    return;
  }
  // 间隔为 0 / 缺省表示关闭自动同步：清除定时器与 nextRunAt，手动仍可触发。
  if (!runtime.intervalMs) {
    if (runtime.timer) clearTimeout(runtime.timer);
    runtime.timer = undefined;
    runtime.nextRunAt = undefined;
    return;
  }
  if (runtime.timer) clearTimeout(runtime.timer);
  runtime.nextRunAt = new Date(Date.now() + runtime.intervalMs).toISOString();
  runtime.timer = setTimeout(() => { runtime.timer = undefined; void executeTask(runtime.id, "interval"); }, runtime.intervalMs);
}

/**
 * 意图持久化成功后立即撤掉 Worker 任务入口；重新启用只恢复 idle/定时器，
 * 不会把旧 completion 当成新实例。真正的 async 资源清理仍由任务自己的
 * AbortSignal / finally 完成。
 */
function reconcileCoordinatorTaskIntent(snapshot: PluginIntentSnapshot): void {
  // 先投影 Provider，再重算任务状态。启用 WOC 时，旧的
  // provider-unavailable 阻塞必须能在同一轮恢复；禁用时则由下面的产品
  // 依赖检查先挡住任务入口。
  let changed = reconcileCoordinatorProviderIntent(snapshot);
  changed = reconcileCoordinatorWorkerUnitIntent(snapshot) || changed;
  for (const runtime of coordinatorState.taskRuntimes.values()) {
    const blockedReason = coordinatorTaskBlockedReason(runtime, snapshot);
    if (blockedReason) {
      if (runtime.timer) clearTimeout(runtime.timer);
      runtime.timer = undefined;
      runtime.nextRunAt = undefined;
      runtime.controller?.abort(new Error(blockedReason));
      if (runtime.state !== "blocked" || runtime.blockedReason !== blockedReason) {
        runtime.state = "blocked";
        runtime.blockedReason = blockedReason;
        runtime.error = undefined;
        changed = true;
      }
      continue;
    }
    // 运行中的旧 completion 可能还在收尾；先保留 blocked，等它的 finally
    // 观察到新意图后再恢复调度，防止同一任务出现两个物理实例。
    if (runtime.state === "blocked"
      && (isPluginIntentBlockedReason(runtime.blockedReason) || isProviderAvailabilityBlockedReason(runtime.blockedReason))
      && !runtime.completion) {
      runtime.state = "idle";
      runtime.blockedReason = undefined;
      runtime.error = undefined;
      if (coordinatorState.vaultStatus === "unlocked" && coordinatorState.activePublicKeyHex) scheduleRuntime(runtime);
      // 智能任务没有固定周期：从产品恢复这一刻重新开始 2 秒计时。
      if (runtime.syncPolicy === "smart") armSmartSyncIfIdle();
      changed = true;
    }
  }
  if (changed) {
    publishTopicEvent("background.snapshot", {
      type: "background.snapshot.changed",
      sessionEpoch: coordinatorState.sessionEpoch,
      snapshots: getTaskSnapshots(),
    });
  }
}

function assertTaskFresh(taskId: string): void {
  const runtime = coordinatorState.taskRuntimes.get(taskId);
  if (!runtime || runtime.startedEpoch !== coordinatorState.sessionEpoch || runtime.startedGeneration !== coordinatorState.keyspaceGeneration || runtime.startedPublicKeyHex !== coordinatorState.activePublicKeyHex) {
    throw new Error("stale task session epoch");
  }
}

/**
 * 统一进入 unlocked 状态。
 * 设计缘由：unlock、创建首把 key、导入首把 key 共用状态写入、任务恢复、快照广播和自动锁定启动。
 */
async function enterUnlockedState(
  activePublicKeyHex: string,
  activePrivateKeyBytes: Uint8Array,
  cause: SessionStateEvent["cause"]
): Promise<void> {
  const previous = {
    vaultStatus: coordinatorState.vaultStatus,
    activePublicKeyHex: coordinatorState.activePublicKeyHex,
    activePrivateKeyBytes: coordinatorState.activePrivateKeyBytes?.slice(),
    selectedPublicKeyHex: coordinatorMeta.selectedPublicKeyHex,
    keyspaceGeneration: coordinatorState.keyspaceGeneration
  };
  let transition: ActiveOwnerTransitionResult | undefined;
  try {
    transition = await transitionActiveStorageOwner(activePublicKeyHex);
    // 旧私钥不能在新 owner 写入期间继续留在 Coordinator state；回滚使用
    // 上面保存的独立副本，不能复用已经被覆盖/清零的旧 buffer。
    dropActivePrivateKey();
    coordinatorState.vaultStatus = "unlocked";
    coordinatorState.sessionEpoch = generateEpoch();
    coordinatorState.activePublicKeyHex = activePublicKeyHex;
    coordinatorMeta.selectedPublicKeyHex = activePublicKeyHex;
    replaceActivePrivateKey(activePrivateKeyBytes);
    // 锁 / 解锁本身只发布内存会话，不写桶内固定对象；但“当前使用的 Key”
    // 是浏览器 session.activeKey 的真值，固定动作结束时写透一次（值未变
    // 则跳过），刷新后仍回到这把 Key。
    // 只有新的 owner 状态准备好后，才重新打开最终 I/O 门禁。
    await ensureCoordinatorUpgradeSession();
    await persistSelectedPublicKey(activePublicKeyHex);
    completeActiveStorageOwnerTransition(transition);
  } catch (error) {
    const failedClosed = previous.vaultStatus === "unlocked" && coordinatorState.vaultStatus !== "unlocked";
    if (failedClosed) {
      // drain 超时已经由 transition 主动进入 locked；绝不能把旧私钥/旧
      // active owner 从回滚分支重新暴露出来。
      dropActivePrivateKey();
      coordinatorMeta.selectedPublicKeyHex = previous.selectedPublicKeyHex;
      throw error;
    }
    dropActivePrivateKey();
    coordinatorState.vaultStatus = previous.vaultStatus;
    coordinatorState.activePublicKeyHex = previous.activePublicKeyHex;
    if (previous.activePrivateKeyBytes) replaceActivePrivateKey(previous.activePrivateKeyBytes);
    coordinatorMeta.selectedPublicKeyHex = previous.selectedPublicKeyHex;
    // lock → unlock 已经排空 pending owner，但新 owner 的 metadata
    // 提交失败时并没有公开新的 active owner；回滚必须撤销临时 fence。
    completeActiveStorageOwnerTransition(transition);
    // 失败回滚不能复用旧 generation/epoch；否则旧 owner 句柄可能重新通过
    // Root 的 isCurrent 检查。
    invalidateFailedKeyspaceTransition(previous.keyspaceGeneration);
    throw error;
  }
  try {
    // 领域任务/Provider 已在 Worker 内创建；只有 owner/session 已提交并且
    // 最终 I/O 门禁重新打开后，才把这些 unit 发布为本次实例。
    bindCoordinatorTaskUnitsToOwner();
    await reconcileCoordinatorRuntime();
  } catch (error) {
    await performGlobalLock("worker-unit-bind-failed");
    throw error;
  }
  emitStorageState();

  // 恢复所有 blocked 任务为 idle 并重新调度
  for (const runtime of coordinatorState.taskRuntimes.values()) {
    if (runtime.state === "blocked" && runtime.blockedReason === "Vault is locked") {
      runtime.state = "idle";
      runtime.blockedReason = undefined;
      scheduleRuntime(runtime);
    }
  }

  // 解锁 / 初始化完成后第一时间同步一次：余额快照立即刷新，未关闭的
  // managed 任务也立即跑一轮，随后回到各自的同步管理间隔。
  triggerImmediateSync(BACKGROUND_TRIGGER_REASON.UNLOCK);

  publishSessionState(cause);
  // 解锁后立即建立 owner-scoped Sat runtime 和 owner inbox 的系统 caller。
  // 连接/供应商暂不可用时只记录诊断；owner 的本地设置仍在
  // sat-subscription/setting.json，远端订阅事实由后续 SS server 查询取得。
  void ensureSatRuntime()
    .then((runtime) => ensureChannelSubscriptionMux(runtime))
    .catch((error) => console.warn("[channel] owner runtime startup deferred", error instanceof Error ? error.message : String(error)));
  // 广播任务快照
  publishTopicEvent("background.snapshot", {
    type: "background.snapshot.changed",
    sessionEpoch: coordinatorState.sessionEpoch,
    snapshots: getTaskSnapshots(),
  });

  // 启动自动锁定计时器
  resetAutoLockTimer();
}

function createWorkerKeyspace(): KeyspaceService {
  const active = () => ({
    activePublicKeyHex: coordinatorState.activePublicKeyHex,
    // 让 Worker 内部的 owner-scoped service 也能捕获会话世代。
    generation: coordinatorState.keyspaceGeneration
  });
  return {
    listKeys: async () => (await listPublicVaultKeys()).map((key) => ({ publicKeyHex: key.publicKeyHex, label: key.label, capabilities: key.capabilities, createdAt: key.createdAt })),
    getKey: async (publicKeyHex) => { const key = await getPublicVaultKey(publicKeyHex); return key ? { publicKeyHex: key.publicKeyHex, label: key.label, capabilities: key.capabilities, createdAt: key.createdAt } : undefined; },
    active,
    selected: () => coordinatorMeta.selectedPublicKeyHex,
    setActive: async (publicKeyHex) => {
      await withCoordinatorFinalIoLease(
        "write",
        undefined,
        () => executeVaultOperation({ type: "setActive", publicKeyHex }),
        { allowLocalLock: true, allowLocalOwnerTransition: true, auditOperation: "keyspace.active.set" },
      );
    },
    requireActiveKey: () => { if (!coordinatorState.activePublicKeyHex) throw new Error("No active key"); return { publicKeyHex: coordinatorState.activePublicKeyHex, label: "", capabilities: ["p2pkh"], createdAt: "" }; },
    onActiveKeyChanged: () => () => undefined,
    prepareDeleteKey: async () => undefined,
    // Deletion is coordinated by the application keyspace facade so that
    // namespace cleanup and password verification cannot be bypassed.
    deleteKey: async () => { throw new Error("Use the coordinator keyspace deletion flow"); },
    isInitializing: () => false,
    onInitializationChange: () => () => undefined
  };
}

/** Worker 任务在 locked 首屏也要先注册；真实 owner 存储延迟到解锁后绑定。 */
/**
 * Worker 内插件使用的 owner 文件根（model: "files"，扁平布局）。
 *
 * 与 K-V 句柄同理：解锁后按当前 owner/keyspace 世代惰性绑定,切 Key
 * 或切桶会让旧绑定失效并在下次调用时重建。
 */
const workerOwnerFileHandles = new Map<string, BorrowedOwnerFileStore>();

function createWorkerOwnerFileStore(
  pluginId: string,
  purposeId?: string,
  appPublisherPublicKeyHex?: string,
): BorrowedOwnerFileStore {
  const publisherKey = appPublisherPublicKeyHex?.trim().toLowerCase();
  const handleKey = `${pluginId}\u0000${purposeId ?? "*"}\u0000${publisherKey ?? "*"}`;
  const cachedHandle = workerOwnerFileHandles.get(handleKey);
  if (cachedHandle) return cachedHandle;
  const declaration = SYSTEM_STORAGE_DECLARATIONS[pluginId]?.find((candidate) => candidate.scope === "owner" && candidate.model === "files" && (purposeId === undefined || candidate.purposeId === purposeId));
  if (!declaration || declaration.scope !== "owner" || declaration.authority !== "built-in-module" || declaration.model !== "files") throw new Error(`Unknown owner file storage declaration: ${pluginId}`);
  if (publisherKey !== undefined && !/^(02|03)[0-9a-f]{64}$/u.test(publisherKey)) throw new Error("App publisher public key is invalid");
  let closed = false;
  let ownerPublicKeyHex: string | undefined;
  let current: OwnerFileStore | undefined;
  let generation: number | undefined;
  let bindingRootToken: object | undefined;
  const invalidateBinding = (): void => {
    current = undefined;
    ownerPublicKeyHex = undefined;
    generation = undefined;
    bindingRootToken = undefined;
  };
  const resolve = async (): Promise<OwnerFileStore> => {
    if (closed) throw new Error("Worker owner file storage handle is closed");
    assertStorageDataAvailable();
    const owner = coordinatorState.activePublicKeyHex?.trim().toLowerCase();
    if (!owner) throw new Error("Owner storage requires an unlocked active key");
    assertOwnerStorageNotFenced(owner);
    const expectedGeneration = coordinatorState.keyspaceGeneration;
    const expectedRootToken = platformRootToken;
    if (!expectedRootToken) throw new Error("Owner storage root is unavailable");
    if (!current || ownerPublicKeyHex !== owner || generation !== expectedGeneration || bindingRootToken !== expectedRootToken) {
      invalidateBinding();
      if (!platformRootStore) throw new Error("Owner storage is not ready");
      const root = platformRootStore;
      const opened = await root.openOwnerFileStore({
        ownerPublicKeyHex: owner,
        declaration,
        ...(publisherKey === undefined ? {} : { appPublisherPublicKeyHex: publisherKey }),
        keyspaceGeneration: expectedGeneration,
      });
      if (
        closed ||
        platformRootStore !== root ||
        platformRootToken !== expectedRootToken ||
        coordinatorState.activePublicKeyHex?.toLowerCase() !== owner ||
        coordinatorState.keyspaceGeneration !== expectedGeneration
      ) {
        throw storageUnavailableError("Owner file storage binding became stale while opening");
      }
      current = opened;
      ownerPublicKeyHex = owner;
      generation = expectedGeneration;
      bindingRootToken = expectedRootToken;
    }
    return current;
  };
  const run = async <T>(
    operation: "read" | "write",
    execute: (store: OwnerFileStore) => Promise<T>,
  ): Promise<T> => withCoordinatorFinalIoLease(operation, undefined, async () => {
    try {
      const store = await resolve();
      const owner = ownerPublicKeyHex;
      const boundGeneration = generation;
      const boundRootToken = bindingRootToken;
      if (!owner || boundGeneration === undefined) throw storageUnavailableError("Owner file storage binding is unavailable");
      const release = beginOwnerStorageRequest(owner);
      try {
        const value = await execute(store);
        assertOwnerStorageBindingFresh(owner, boundGeneration, boundRootToken);
        return value;
      } finally {
        release();
      }
    } catch (error) {
      markStorageIoFailure(error);
      throw error;
    }
  }, {
    auditOperation: "storage.owner.files",
    durableLease: operation === "write",
  });
  const handle: BorrowedOwnerFileStore = {
    list: (input) => run("read", (store) => store.list(input)),
    get: (path, options) => run("read", (store) => store.get(path, options)),
    put: (path, bytes, condition) => run("write", (store) => store.put(path, bytes, condition)),
    delete: (path, options) => run("write", (store) => store.delete(path, options)),
  };
  const binding: WorkerOwnerStoreBinding = {
    close: () => {
      if (closed) return;
      closed = true;
      invalidateBinding();
      workerOwnerStores.delete(binding);
      workerOwnerFileHandles.delete(handleKey);
      // 文件句柄关闭后该 owner 的内存本地态不可再被读取。
      if (pluginId === "p2pkh") disposeP2pkhStateRepository();
    },
    invalidateBinding: () => {
      if (closed) return;
      invalidateBinding();
      // 切 owner/世代/桶后旧 owner 的本地行不可见；链上真值会从文件重建。
      if (pluginId === "p2pkh") disposeP2pkhStateRepository();
    },
  };
  workerOwnerStores.add(binding);
  workerOwnerFileHandles.set(handleKey, handle);
  return handle;
}

/**
 * 枚举当前 owner 下已存在的三方 App publisher（`app.<publisher>/` 目录）。
 * 只返回目录名；用于 MSFile 设置页列出 App 授权，不读取 App 文件内容。
 */
async function listWorkerOwnerAppPublishers(): Promise<string[]> {
  assertStorageDataAvailable();
  const owner = coordinatorState.activePublicKeyHex?.trim().toLowerCase();
  if (!owner) throw new Error("Owner storage requires an unlocked active key");
  assertOwnerStorageNotFenced(owner);
  if (!platformRootStore) throw new Error("Owner storage is not ready");
  const root = platformRootStore;
  const rootToken = platformRootToken;
  const generation = coordinatorState.keyspaceGeneration;
  const publishers = await root.listOwnerAppPublishers({ ownerPublicKeyHex: owner, keyspaceGeneration: generation });
  if (
    platformRootStore !== root
    || platformRootToken !== rootToken
    || coordinatorState.activePublicKeyHex?.toLowerCase() !== owner
    || coordinatorState.keyspaceGeneration !== generation
  ) {
    throw storageUnavailableError("Owner app publisher listing became stale");
  }
  return publishers;
}

function createWorkerOwnerStore(pluginId: string, purposeId?: string): KeyValueStore {
  const declaration = SYSTEM_STORAGE_DECLARATIONS[pluginId]?.find((candidate) => candidate.scope === "owner" && candidate.model === "kv" && (purposeId === undefined || candidate.purposeId === purposeId));
  if (!declaration || declaration.scope !== "owner" || declaration.authority !== "built-in-module" || declaration.model !== "kv") throw new Error(`Unknown owner storage declaration: ${pluginId}`);
  let closed = false;
  let ownerPublicKeyHex: string | undefined;
  let current: KeyValueStore | undefined;
  let generation: number | undefined;
  let bindingRootToken: object | undefined;
  const invalidateBinding = (): void => {
    current?.close();
    current = undefined;
    ownerPublicKeyHex = undefined;
    generation = undefined;
    bindingRootToken = undefined;
  };
  const resolve = async (): Promise<KeyValueStore> => {
    if (closed) throw new Error("Worker owner storage handle is closed");
    assertStorageDataAvailable();
    const owner = coordinatorState.activePublicKeyHex?.trim().toLowerCase();
    if (!owner) throw new Error("Owner storage requires an unlocked active key");
    assertOwnerStorageNotFenced(owner);
    const expectedGeneration = coordinatorState.keyspaceGeneration;
    const expectedRootToken = platformRootToken;
    if (!expectedRootToken) throw new Error("Owner storage root is unavailable");
    if (!current || ownerPublicKeyHex !== owner || generation !== expectedGeneration || bindingRootToken !== expectedRootToken) {
      invalidateBinding();
      if (!platformRootStore) throw new Error("Owner storage is not ready");
      const root = platformRootStore;
      const opened = await root.openKeyValueStore({ ownerPublicKeyHex: owner, declaration, keyspaceGeneration: expectedGeneration });
      if (
        closed ||
        platformRootStore !== root ||
        platformRootToken !== expectedRootToken ||
        coordinatorState.activePublicKeyHex?.toLowerCase() !== owner ||
        coordinatorState.keyspaceGeneration !== expectedGeneration
      ) {
        opened.close();
        throw storageUnavailableError("Owner storage binding became stale while opening");
      }
      current = opened;
      ownerPublicKeyHex = owner;
      generation = expectedGeneration;
      bindingRootToken = expectedRootToken;
    }
    return current;
  };
  const run = async <T>(
    operation: "read" | "write",
    execute: (store: KeyValueStore) => Promise<T>,
  ): Promise<T> => withCoordinatorFinalIoLease(operation, undefined, async () => {
    try {
      const store = await resolve();
      const owner = ownerPublicKeyHex;
      const boundGeneration = generation;
      const boundRootToken = bindingRootToken;
      if (!owner || boundGeneration === undefined) throw storageUnavailableError("Owner storage binding is unavailable");
      const release = beginOwnerStorageRequest(owner);
      try {
        const value = await execute(store);
        assertOwnerStorageBindingFresh(owner, boundGeneration, boundRootToken);
        return value;
      } finally {
        release();
      }
    } catch (error) {
      markStorageIoFailure(error);
      throw error;
    }
  }, {
    auditOperation: "storage.owner.data",
    // Worker-owned owner K-V 的 get/list 是纯本地只读，不会产生外部
    // 副作用；仍保留当前运行世代的前后校验，但不把页面卸载时的
    // 读 Promise 留成业务 K-V 中的恢复阻断。
    durableLease: operation === "write",
  });
  const handle = {
    get bucketId() { return current?.bucketId ?? "pending"; },
    get bucketGeneration() { return current?.bucketGeneration ?? 0; },
    get ownerPublicKeyHex() { return ownerPublicKeyHex ?? ""; },
    moduleId: declaration.moduleId,
    purposeId: declaration.purposeId,
    scope: declaration.scope,
    authority: declaration.authority,
    model: declaration.model,
    schemaVersion: declaration.schemaVersion,
    get: async <T = KeyValueValue>(key: string, options?: { partition?: string }) => run("read", (store) => store.get<T>(key, options)),
    list: async (input: KeyValueListInput = {}) => run("read", (store) => store.list(input)),
    put: async <T = KeyValueValue>(key: string, value: T, condition?: { ifRevision?: number; partition?: string }) => run("write", (store) => store.put<T>(key, value, condition)),
    delete: async (key: string, condition?: { ifRevision?: number; partition?: string }) => { await run("write", (store) => store.delete(key, condition)); },
    commit: async (input: KeyValueCommitInput) => run("write", (store) => store.commit(input)),
    collectGarbage: async (input: { minAgeMs?: number; maxDeletes?: number } = {}) => run("write", (store) => {
      const maintenance = store as KeyValueStore & { collectGarbage?: (options?: { minAgeMs?: number; maxDeletes?: number }) => Promise<{ scanned: number; candidates: number; deleted: number; failed: number }> };
      if (!maintenance.collectGarbage) throw new Error("K-V garbage collection is unavailable");
      return maintenance.collectGarbage(input);
    }),
    close: () => { if (closed) return; closed = true; invalidateBinding(); workerOwnerStores.delete(handle); coordinatorKeyValueMaintenanceStores.delete(handle as unknown as CoordinatorKeyValueMaintenanceStore); },
    invalidateBinding: () => { if (!closed) invalidateBinding(); }
  } as KeyValueStore & WorkerOwnerStoreBinding & CoordinatorKeyValueMaintenanceStore;
  workerOwnerStores.add(handle);
  coordinatorKeyValueMaintenanceStores.add(handle as unknown as CoordinatorKeyValueMaintenanceStore);
  return handle;
}

/**
 * 为 P2PKH service 提供 Worker 内的 active-key capability。
 *
 * 这里没有把 private key 放进返回值；返回的 capability 只闭包引用
 * Coordinator 当前的私钥缓冲，并且每次签名/派生前重新校验 owner 与
 * session。这样 Sat top-up 复用 P2PKH 交易编排时仍然满足私钥不出 Worker。
 */
async function createWorkerActiveKeyCrypto(publicKeyHex: string): Promise<ActiveKeyCrypto> {
  const record = await getPublicVaultKey(publicKeyHex);
  if (!record) throw new Error(`Unknown key ${publicKeyHex}`);
  const requirePrivateKey = (): Uint8Array => {
    if (coordinatorState.vaultStatus !== "unlocked" || coordinatorState.activePublicKeyHex !== publicKeyHex || !coordinatorState.activePrivateKeyBytes) {
      throw new Error("Vault is locked or active key changed");
    }
    return coordinatorState.activePrivateKeyBytes;
  };
  const identity = {
    publicKeyHex: record.publicKeyHex,
    label: record.label,
    capabilities: [...record.capabilities],
    createdAt: record.createdAt,
    sessionId: coordinatorState.sessionEpoch,
  };
  return {
    getIdentity: () => ({ ...identity, capabilities: [...identity.capabilities] }),
    async signDigest(input) {
      if (input.publicKeyHex !== publicKeyHex) throw new Error("session_key_mismatch");
      if (!(input.digest instanceof ArrayBuffer) || input.digest.byteLength !== 32) throw new Error("Digest must be exactly 32 bytes");
      const signature = await withCoordinatorFinalIoLease("write", undefined, () => signEcdsaDigest({
          privateKeyBytes: requirePrivateKey(),
          digest: new Uint8Array(input.digest),
          format: input.format,
        }), { auditOperation: "vault.digest.sign" });
      return { publicKeyHex, format: input.format, signature: signature.slice().buffer as ArrayBuffer };
    },
    async deriveP2pkhAddress(input) {
      if (input.publicKeyHex !== publicKeyHex) throw new Error("session_key_mismatch");
      return withCoordinatorFinalIoLease("write", undefined, async () => {
        requirePrivateKey();
        return { publicKeyHex, address: deriveP2pkhAddress(publicKeyHex, input.network) };
      }, { auditOperation: "vault.address.derive" });
    },
    exportEncryptedKeyBackup: async () => { throw new Error("P2PKH Worker capability does not expose key export"); },
    dispose: () => undefined,
  };
}

/**
 * P2PKH service 仍由现有 Coordinator broadcast pipeline 负责广播；Sat
 * 充值只注入一个内部 Coordinator facade，避免从 SharedWorker 再绕回页面。
 */
async function ensureSatP2pkhService(): Promise<P2pkhService> {
  if (!isCoordinatorProductEnabled("p2pkh")) {
    throw new Error("Plugin disabled: p2pkh");
  }
  if (coordinatorState.vaultStatus !== "unlocked" || !coordinatorState.activePublicKeyHex) {
    throw new Error("P2PKH top-up requires an unlocked active key");
  }
  const ownerPublicKeyHex = coordinatorState.activePublicKeyHex;
  const ownerSessionEpoch = coordinatorState.sessionEpoch;
  await loadP2pkhSettingForOwner(ownerPublicKeyHex);
  const existingService = satP2pkhService;
  if (existingService && satP2pkhServiceOwnerPublicKeyHex === ownerPublicKeyHex) {
    await existingService.onVaultUnlocked();
    if (!isCoordinatorProductEnabled("p2pkh")
      || coordinatorState.vaultStatus !== "unlocked"
      || coordinatorState.activePublicKeyHex !== ownerPublicKeyHex
      || coordinatorState.sessionEpoch !== ownerSessionEpoch
      || satP2pkhService !== existingService) {
      throw new Error("P2PKH service became stale while rebinding");
    }
    return existingService;
  }
  if (satP2pkhService) {
    // 防御异常的旧 owner 残留；正常 key switch 已由 releaseSatRuntime
    // 清理，但这里仍不能把旧 owner 的 service 交给新 owner。
    const stale = satP2pkhService;
    satP2pkhService = undefined;
    satP2pkhServiceOwnerPublicKeyHex = undefined;
    try { stale.onVaultLocked(); } catch { /* best effort */ }
    try { stale.dispose?.(); } catch { /* best effort */ }
  }
  if (satP2pkhServiceStarting) {
    const pending = satP2pkhServiceStarting;
    if (satP2pkhServiceStartingToken === satP2pkhServiceStartToken && satP2pkhServiceStartingOwnerPublicKeyHex === ownerPublicKeyHex) return pending;
    // 等待旧 owner 的启动完成并完成自身清理，再开始新 owner 世代，
    // 避免两个 P2PKH service 同时持有 K-V/消息总线订阅。
    await pending.catch(() => undefined);
    if (satP2pkhService && satP2pkhServiceOwnerPublicKeyHex === ownerPublicKeyHex) return satP2pkhService;
  }
  const startToken = satP2pkhServiceStartToken;
  const start = (async (): Promise<P2pkhService> => {
    const keyspace = createWorkerKeyspace();
    const messageBus = createMessageBus();
    const vault = {
      status: () => coordinatorState.vaultStatus,
      createActiveKeyCrypto: (requestedOwner: string) => createWorkerActiveKeyCrypto(requestedOwner),
    } as unknown as VaultService;
    const internalCoordinator = {
      // createP2pkhService 构造时读取 p2pkhSettings；Worker 内部 facade
      // 只需要投影设置，不暴露其它 bootstrap 字段。
      getBootstrapSnapshot: () => ({ p2pkhSettings: coordinatorMeta.p2pkhSettings }),
      p2pkhUtxosGet: async (input: { ownerPublicKeyHex: string; network: "main" | "test" }): Promise<CoordinatorValueResult<P2pkhUtxoSnapshotResult>> => {
        if (!isCoordinatorProductEnabled("p2pkh")) {
          return {
            status: "blocked",
            reason: { key: "plugin.blocked.disabled", fallback: "Plugin disabled: p2pkh" },
          };
        }
        const resource = await p2pkhResourceForOwner(input.ownerPublicKeyHex, input.network);
        if (!resource || !p2pkhUtxoSnapshots) return { status: "ok", value: { available: false, state: "unavailable" as const, items: [] }, sessionEpoch: coordinatorState.sessionEpoch };
        return { status: "ok", value: p2pkhUtxoSnapshots.get(resource), sessionEpoch: coordinatorState.sessionEpoch };
      },
      p2pkhUtxosRefresh: async (input: { ownerPublicKeyHex: string; network: "main" | "test" }): Promise<CoordinatorValueResult<P2pkhUtxoSnapshotResult>> => {
        if (!isCoordinatorProductEnabled("p2pkh")) {
          return {
            status: "blocked",
            reason: { key: "plugin.blocked.disabled", fallback: "Plugin disabled: p2pkh" },
          };
        }
        const resource = await p2pkhResourceForOwner(input.ownerPublicKeyHex, input.network);
        if (!resource || !p2pkhUtxoSnapshots) return { status: "ok", value: { available: false, state: "unavailable" as const, items: [] }, sessionEpoch: coordinatorState.sessionEpoch };
        try {
          return { status: "ok", value: await p2pkhUtxoSnapshots.refresh(resource), sessionEpoch: coordinatorState.sessionEpoch };
        } catch (error) {
          return { status: "error", message: error instanceof Error ? error.message : String(error) };
        }
      },
      p2pkhBroadcast: async (input: { ownerPublicKeyHex: string; network: "main" | "test"; submissionId: string; submission?: P2pkhBroadcastSubmission }): Promise<CoordinatorValueResult<unknown>> => {
        if (!isCoordinatorProductEnabled("p2pkh")) {
          return {
            status: "blocked",
            reason: { key: "plugin.blocked.disabled", fallback: "Plugin disabled: p2pkh" },
          };
        }
        if (coordinatorState.vaultStatus !== "unlocked" || coordinatorState.sessionEpoch !== ownerSessionEpoch || coordinatorState.activePublicKeyHex !== ownerPublicKeyHex) {
          // 与页面 client 同语义：会话/owner 失效是终态，中心服务会映射成 cancelled，
          // 不能被当成可重试的传输失败空转到预算耗尽。
          return { status: "ok", value: { status: "not-dispatched", reason: "stale-session-epoch" }, sessionEpoch: coordinatorState.sessionEpoch };
        }
        const request = {
          kind: "p2pkh.broadcast" as const,
          clientId: "sat-subscription",
          requestId: generateRequestId(),
          ...input,
          expectedSessionEpoch: coordinatorState.sessionEpoch,
        };
        const response = await handleP2pkhBroadcast(request.requestId, request);
        if (response.ack.status === "stale-epoch") {
          return { status: "ok", value: { status: "not-dispatched", reason: "stale-session-epoch" }, sessionEpoch: response.sessionEpoch };
        }
        if (response.ack.status !== "ok") return response.ack;
        if (coordinatorState.vaultStatus !== "unlocked" || coordinatorState.activePublicKeyHex !== ownerPublicKeyHex) {
          return { status: "ok", value: { status: "not-dispatched", reason: "stale-session-epoch" }, sessionEpoch: coordinatorState.sessionEpoch };
        }
        return { status: "ok", value: response.operationResult, sessionEpoch: response.sessionEpoch };
      },
    } as unknown as import("@keymaster/contracts").SessionCoordinatorClient;
    // Worker 内的中心广播服务：与页面共用同一套重试/唤醒语义，但依赖
    // 全部在 SharedWorker 进程内解析（不新增 capability，也不跨 realm）。
    // 中文：SatSubscription 的自动充值由此获得"等新序号→重新组合→再提交"。
    const centralBroadcastService = createCentralBroadcastService({
      coordinator: { p2pkhBroadcast: (input) => internalCoordinator.p2pkhBroadcast(input) },
      subscribeTopic: (listener) => subscribeWorkerUtxoSeq((event) => {
        if (event.ownerPublicKeyHex.toLowerCase() !== ownerPublicKeyHex.toLowerCase()) return;
        listener({ utxoSeqs: event.network === "main" ? { main: event.seq } : { test: event.seq } } as AssetDataChangedEvent);
      }),
      getSnapshot: async (network) => {
        const result = await internalCoordinator.p2pkhUtxosGet({ ownerPublicKeyHex, network });
        return result.status === "ok" ? result.value : { available: false, state: "unavailable", items: [] };
      },
      refreshSnapshot: async (network) => {
        const result = await internalCoordinator.p2pkhUtxosRefresh({ ownerPublicKeyHex, network });
        return result.status === "ok" ? result.value : { available: false, state: "unavailable", items: [] };
      },
      ...(testSatBroadcastRetryOverrides ?? {}),
    });
    const service = createP2pkhService({
      vault,
      coordinator: internalCoordinator,
      centralBroadcastService,
      broadcastWithCoordinator: (input) => internalCoordinator.p2pkhBroadcast(input),
      messageBus,
      keyspace,
      storage: createWorkerOwnerFileStore("p2pkh", ""),
    });
    try {
      // 充值首次进入时确保 owner 的 main P2PKH resource 已存在；该调用只
      // 在 Worker 中读取私钥并派生地址，不会把私钥/crypto capability发给页面。
      await service.onVaultUnlocked();
      if (!isCoordinatorProductEnabled("p2pkh")
        || coordinatorState.vaultStatus !== "unlocked"
        || coordinatorState.activePublicKeyHex !== ownerPublicKeyHex) {
        throw new Error("P2PKH service became stale while starting");
      }
      if (startToken !== satP2pkhServiceStartToken
        || !isCoordinatorProductEnabled("p2pkh")
        || coordinatorState.sessionEpoch !== ownerSessionEpoch) {
        throw new Error("P2PKH service start was superseded");
      }
      satP2pkhService = service;
      satP2pkhServiceOwnerPublicKeyHex = ownerPublicKeyHex;
      return service;
    } catch (error) {
      try { service.onVaultLocked(); } catch { /* best effort */ }
      try { service.dispose?.(); } catch { /* best effort */ }
      throw error;
    }
  })();
  satP2pkhServiceStarting = start;
  satP2pkhServiceStartingToken = startToken;
  satP2pkhServiceStartingOwnerPublicKeyHex = ownerPublicKeyHex;
  try {
    return await start;
  } finally {
    if (satP2pkhServiceStarting === start) satP2pkhServiceStarting = undefined;
    if (satP2pkhServiceStarting === undefined) {
      satP2pkhServiceStartingToken = undefined;
      satP2pkhServiceStartingOwnerPublicKeyHex = undefined;
    }
  }
}

/**
 * 快照 store 的 WoC 数据源包装。
 *
 * 生产路径原样委托给真实 WoC；测试可用 `__testSetP2pkhUnspentAllProvider`
 * 替换 `unspent/all`，让 Worker 侧的消费/重试链路不出网。
 */
function createP2pkhSnapshotWocSource(woc: WocServiceHandle): WocService {
  return {
    getAddressUnspentAll: (network: "main" | "test", address: string, options?: import("@keymaster/contracts").WocRequestOptions) =>
      testP2pkhUnspentAllProvider
        ? testP2pkhUnspentAllProvider(network, address)
        : woc.getAddressUnspentAll(network, address, options),
    getTransactionObservation: (network: "main" | "test", txid: string, options?: import("@keymaster/contracts").WocRequestOptions) => woc.getTransactionObservation(network, txid, options),
  } as unknown as WocService;
}

async function registerCoordinatorTasks(): Promise<void> {
  const keyspace = createWorkerKeyspace();
  const messageBus = createMessageBus();
  coordinatorContactsPresenceOff?.();
  coordinatorContactsPresenceOff = undefined;
  coordinatorContactsService?.dispose?.();
  const contactsService = createContactsService({
    keyspace,
    messageBus,
    storage: createWorkerOwnerFileStore("contacts", "address-book"),
    channel: createCoordinatorChannelRuntime()
  });
  coordinatorContactsService = contactsService;
  const offContactsChange = contactsService.onChange(() => publishCoordinatorContactsPresence());
  const offContactsPresence = contactsService.onPresenceChange?.(() => publishCoordinatorContactsPresence());
  coordinatorContactsPresenceOff = () => {
    offContactsChange();
    offContactsPresence?.();
  };
  publishCoordinatorContactsPresence();
  const contactsPresenceTask = createContactsPresenceTask({
    service: contactsService,
    keyspace,
    vault: { status: () => coordinatorState.vaultStatus }
  });
  coordinatorState.taskRuntimes.set(contactsPresenceTask.id, createCoordinatorTaskRuntime({
    id: contactsPresenceTask.id,
    // BackgroundTaskDefinition 的历史 pluginId 仍带 package 前缀；Worker
    // 状态必须使用用户可操作的产品 id，才能和 PluginIntent 对齐。
    pluginId: "contacts",
    syncPolicy: "managed",
    intervalMs: managedIntervalFor(contactsPresenceTask.id),
    keyScope: () => coordinatorState.activePublicKeyHex ? { publicKeyHex: coordinatorState.activePublicKeyHex } : undefined,
    unitId: contactsPresenceTask.unitId,
    run: async ({ signal, reason, assertSessionFresh }) => {
      const gate = await contactsPresenceTask.canRun?.();
      if (gate?.ready === false) {
        throw new Error(typeof gate.reason === "string" ? gate.reason : gate.reason?.fallback ?? "联系人在线探测暂不可运行");
      }
      await contactsPresenceTask.run({ signal, reason, reportProgress: () => undefined, assertSessionFresh });
    }
  }));
  const woc = createWocService({ messageBus });
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
  const emitDataChanged = (providerId: string, kinds: AssetDataInvalidationEvent["kinds"], utxoSeqs?: { main?: number; test?: number }) => publishTopicEvent("asset.data-changed", { type: "asset.data-changed", providerId, publicKeyHex: coordinatorState.activePublicKeyHex ?? "", kinds, ...(utxoSeqs === undefined ? {} : { utxoSeqs }) });
  p2pkhRegistry = createP2pkhProviderRegistry();
  registerWocP2pkhProviders({ registry: p2pkhRegistry, woc });
  p2pkhUtxoSnapshots = createP2pkhUtxoSnapshotStore({ woc: createP2pkhSnapshotWocSource(woc) });
  const p2pkh = createP2pkhCoordinatorTasks({ keyspace, storage: createWorkerOwnerFileStore("p2pkh", ""), woc, isNetworkEnabled: (network) => network === "main" || coordinatorMeta.p2pkhSettings?.includeTestnet === true });
  // P2PKH 拆成两个任务：
  //   - p2pkh.transactions-sync：链上历史元数据，按同步管理间隔运行；
  //   - p2pkh.utxo-snapshot：BSV 余额来源（内存 UTXO 快照），由智能调度
  //     在 WoC 空闲 2 秒后刷新，永远保持最新。
  coordinatorState.taskRuntimes.set("p2pkh.transactions-sync", createCoordinatorTaskRuntime({ id: "p2pkh.transactions-sync", pluginId: "p2pkh", unitId: p2pkh.unitId, syncPolicy: "managed", intervalMs: managedIntervalFor("p2pkh.transactions-sync"), keyScope: () => coordinatorState.activePublicKeyHex ? { publicKeyHex: coordinatorState.activePublicKeyHex } : undefined, run: async ({ signal, assertSessionFresh }) => {
    await loadP2pkhSettingForOwner(coordinatorState.activePublicKeyHex);
    const result = await p2pkh.transactionsSync(signal);
    assertSessionFresh();
    if (result.cancelled) return;
    // 历史同步与 UTXO 快照互不依赖：快照刷新由 smart 任务独立负责。
    emitDataChanged("p2pkh", ["resource", "history", "submission", "balance"]);
  } }));
  coordinatorState.taskRuntimes.set("p2pkh.utxo-snapshot", createCoordinatorTaskRuntime({ id: "p2pkh.utxo-snapshot", pluginId: "p2pkh", unitId: p2pkh.unitId, syncPolicy: "smart", keyScope: () => coordinatorState.activePublicKeyHex ? { publicKeyHex: coordinatorState.activePublicKeyHex } : undefined, run: async ({ signal, assertSessionFresh }) => {
    await loadP2pkhSettingForOwner(coordinatorState.activePublicKeyHex);
    // 单个资源失败只保留旧快照；失败不写 0，也不影响其它资源。
    const utxoSeqs = await refreshP2pkhUtxoSnapshots(signal);
    assertSessionFresh();
    emitDataChanged("p2pkh", ["utxo", "balance"], utxoSeqs);
  } }));
  const p2pkhProvider = {
    listResources: async (assetId: "bsv" | "bsvtest") => {
      if (!coordinatorState.activePublicKeyHex) return [];
      const repository = createP2pkhStateRepository(await openP2pkhStateRepository(createWorkerOwnerFileStore("p2pkh", "")));
      return (await repository.listResourcesByKey()).filter((resource) => assetId === (resource.network === "main" ? "bsv" : "bsvtest"));
    },
    listUtxos: async (filter?: { assetId?: "bsv" | "bsvtest"; ownerPublicKeyHex?: string }) => {
      const ownerPublicKeyHex = filter?.ownerPublicKeyHex ?? coordinatorState.activePublicKeyHex;
      if (!ownerPublicKeyHex) return [];
      if (keyspace.active().activePublicKeyHex?.toLowerCase() !== ownerPublicKeyHex.toLowerCase()) throw new Error("P2PKH storage owner is not active");
      const repository = createP2pkhStateRepository(await openP2pkhStateRepository(createWorkerOwnerFileStore("p2pkh", "")));
      const rows: Array<{ id: string; resourceId: string; publicKeyHex: string; network: "main" | "test"; address: string; txid: string; vout: number; value: number; height: number; script: string; status: "confirmed" | "unconfirmed"; isSpentInMempoolTx: boolean; syncedAt: string }> = [];
      for (const resource of await repository.listResourcesByKey()) {
        if (filter?.assetId && resource.network !== (filter.assetId === "bsv" ? "main" : "test")) continue;
        const snapshot = p2pkhUtxoSnapshots?.get(resource);
        if (!snapshot?.available) continue;
        for (const item of snapshot.items) {
          if (item.isSpentInMempoolTx) continue;
          rows.push({
            id: `utxo:${resource.resourceId}:${item.txid}:${item.vout}`,
            resourceId: resource.resourceId,
            publicKeyHex: resource.publicKeyHex,
            network: resource.network,
            address: resource.address,
            txid: item.txid,
            vout: item.vout,
            value: item.value,
            height: item.height,
            script: p2pkhAddressToScriptHex(resource.address, resource.network),
            status: item.status,
            isSpentInMempoolTx: item.isSpentInMempoolTx,
            syncedAt: snapshot.syncedAt ?? new Date().toISOString()
          });
        }
      }
      return rows;
    },
    getGlobalSettings: () => ({ includeTestnet: coordinatorMeta.p2pkhSettings?.includeTestnet === true })
  };
  const vault = { status: () => coordinatorState.vaultStatus, } as VaultService;
  const bsv21Task = createBsv21CoordinatorTask({ keyspace, stateStore: createWorkerOwnerStore("token-bsv21"), p2pkh: p2pkhProvider, woc: createWocBsv21Service({ messageBus }), wocService: woc, vault, notifier: { emit: (event) => publishTopicEvent("asset.data-changed", { type: "asset.data-changed", providerId: event.providerId, publicKeyHex: event.publicKeyHex ?? "", kinds: event.kinds }), subscribe: () => () => undefined } });
  const stasTask = createStasCoordinatorTask({ keyspace, stateStore: createWorkerOwnerStore("token-stas"), p2pkh: p2pkhProvider, woc: createWocStasService({ messageBus }), vault, notifier: { emit: (event) => publishTopicEvent("asset.data-changed", { type: "asset.data-changed", providerId: event.providerId, publicKeyHex: event.publicKeyHex ?? "", kinds: event.kinds }), subscribe: () => () => undefined } });
  const oneSatTask = createOrdinalsCoordinatorTask({ keyspace, p2pkh: p2pkhProvider, woc: createWoc1SatOrdinalsService({ messageBus }), wocService: woc, vault, notifier: { emit: (event) => publishTopicEvent("asset.data-changed", { type: "asset.data-changed", providerId: event.providerId, publicKeyHex: event.publicKeyHex ?? "", kinds: event.kinds }), subscribe: () => () => undefined } });
  coordinatorState.taskRuntimes.set(bsv21Task.id, createCoordinatorTaskRuntime({ id: bsv21Task.id, pluginId: "token-bsv21", unitId: bsv21Task.unitId, syncPolicy: "managed", intervalMs: managedIntervalFor(bsv21Task.id), keyScope: () => coordinatorState.activePublicKeyHex ? { publicKeyHex: coordinatorState.activePublicKeyHex } : undefined, run: async ({ signal, reason, assertSessionFresh }) => { await bsv21Task.run({ signal, reason, reportProgress: () => undefined, assertSessionFresh }); } }));
  coordinatorState.taskRuntimes.set(stasTask.id, createCoordinatorTaskRuntime({ id: stasTask.id, pluginId: "token-stas", unitId: stasTask.unitId, syncPolicy: "managed", intervalMs: managedIntervalFor(stasTask.id), keyScope: () => coordinatorState.activePublicKeyHex ? { publicKeyHex: coordinatorState.activePublicKeyHex } : undefined, run: async ({ signal, reason, assertSessionFresh }) => { await stasTask.run({ signal, reason, reportProgress: () => undefined, assertSessionFresh }); } }));
  coordinatorState.taskRuntimes.set(oneSatTask.id, createCoordinatorTaskRuntime({ id: oneSatTask.id, pluginId: "collectible-1satordinals", unitId: oneSatTask.unitId, syncPolicy: "managed", intervalMs: managedIntervalFor(oneSatTask.id), keyScope: () => coordinatorState.activePublicKeyHex ? { publicKeyHex: coordinatorState.activePublicKeyHex } : undefined, run: async ({ signal, reason, assertSessionFresh }) => { await oneSatTask.run({ signal, reason, reportProgress: () => undefined, assertSessionFresh }); } }));
  bindCoordinatorTaskUnitsToOwner();
  // Provider 初始注册必须再经过产品意图投影；否则 Worker 重启时若持久
  // 快照已禁用 WOC，短窗口内仍会把旧 Provider 暴露给任务。
  reconcileCoordinatorProviderIntent(currentPluginIntentSnapshot());
  for (const runtime of coordinatorState.taskRuntimes.values()) scheduleRuntime(runtime);
  publishTopicEvent("background.snapshot", { type: "background.snapshot.changed", sessionEpoch: coordinatorState.sessionEpoch, snapshots: getTaskSnapshots() });
  // 任务在「已解锁」状态下补齐注册（首次接入存储等）时，第一时间同步一次。
  triggerImmediateSync(BACKGROUND_TRIGGER_REASON.INIT);
}

// ============================================================
// 3. Utility Functions
// ============================================================

function generateEpoch(): SessionEpoch {
  return `${Date.now()}-${randomIdentifierSuffix()}`;
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
    const keyspace = createWorkerKeyspace();
    if (keyspace.active().activePublicKeyHex?.toLowerCase() !== request.ownerPublicKeyHex.toLowerCase()) throw new Error("P2PKH storage owner is not active");
    const repository = createP2pkhStateRepository(await openP2pkhStateRepository(createWorkerOwnerFileStore("p2pkh", "")));
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
    if (topic === "storage.state") {
      const baselineRevision = storageRevision;
      const summary = typeof storageController?.getProviderSummary === "function"
        ? storageController.getProviderSummary().catch(() => null)
        : Promise.resolve(null);
      // Subscription response must be atomic; use the last published state
      // when available, otherwise a locked/unconfigured baseline.
      const cached = lastStorageState ?? {
        topic: "storage.state" as const, type: "storage.state.changed" as const,
        storageRevision: baselineRevision, sessionEpoch: coordinatorState.sessionEpoch,
        providerGeneration: null, status: coordinatorState.vaultStatus === "unlocked" ? "unconfigured" as const : "locked" as const,
        catalogBucket: false,
        summary: null, capabilities: null,
      };
      void summary;
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
      const cached = lastContactsPresenceState
        && lastContactsPresenceState.sessionEpoch === coordinatorState.sessionEpoch
        && lastContactsPresenceState.activePublicKeyHex === activePublicKeyHex
        ? lastContactsPresenceState
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
    if (topic === "plugin.intent") {
      const snapshot = pluginIntentController?.snapshot() ?? emptyPluginIntentSnapshot();
      const baseline = snapshot.revision;
      return [{
        topic,
        baselineRevision: baseline,
        sessionEpoch: coordinatorState.sessionEpoch,
        snapshot: {
          topic: "plugin.intent" as const,
          type: "plugin.intent.changed" as const,
          authorityInstanceId: coordinatorAuthorityInstanceId,
          pluginIntentRevision: baseline,
          sessionEpoch: coordinatorState.sessionEpoch,
          snapshot,
        },
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
      ? { topic, type: "session.state.changed" as const, sessionRevision: baselineRevision, sessionEpoch: coordinatorState.sessionEpoch, cause: "bootstrap" as const, vaultStatus: coordinatorState.vaultStatus, activePublicKeyHex: coordinatorState.vaultStatus === "unlocked" ? coordinatorState.activePublicKeyHex ?? null : null, selectedPublicKeyHex: coordinatorMeta.selectedPublicKeyHex ?? null, keyspaceGeneration: coordinatorState.keyspaceGeneration, autoLockTimeoutMs: coordinatorMeta.autoLockTimeoutMs ?? AUTO_LOCK_DEFAULT_TIMEOUT_MS }
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
  return request.kind === "storage.grant" || request.kind === "storage.control" || request.kind === "storage.data" || request.kind === "storage.cancel" || request.kind === "storage.session.abort" || request.kind === "storage.owner.bind" || request.kind === "storage.platform.bind" || request.kind === "storage.owner.data" || request.kind === "storage.platform.data" || request.kind === "storage.owner.delete";
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
    if (control.type === "unlock-bucket" || control.type === "switch-bucket" || control.type === "change-bucket-config") {
      control.password = "";
    }
    if (control.type === "initial-setup") {
      control.plan.startupPassword = "";
      control.plan.firstKey.password = "";
      if (control.plan.connection.kind === "s3") {
        control.plan.connection.accessKeyId = "";
        control.plan.connection.secretAccessKey = "";
        control.plan.connection.sessionToken = undefined;
      }
      if (control.plan.firstKey.kind === "import") {
        control.plan.firstKey.material.hex = "";
        control.plan.firstKey.material.wif = undefined;
      }
    }
    if (control.type === "connect-existing-remote") {
      control.plan.keyPassword = "";
      control.plan.startupPassword = "";
      if (control.plan.connection.kind === "s3") {
        control.plan.connection.accessKeyId = "";
        control.plan.connection.secretAccessKey = "";
        control.plan.connection.sessionToken = undefined;
      }
    }
    if (control.type === "initial-setup-cleanup") {
      if (control.password !== undefined) control.password = "";
      if (control.connection?.kind === "s3") {
        control.connection.accessKeyId = "";
        control.connection.secretAccessKey = "";
        control.connection.sessionToken = undefined;
      }
    }
    if (control.type === "change-bucket-config" && control.config.kind === "s3") {
      control.config.accessKeyId = "";
      control.config.secretAccessKey = "";
      control.config.sessionToken = undefined;
    }
  }
}

function clearVaultOperationSecrets(operation: CoordinatorVaultOperation): void {
  switch (operation.type) {
    case "createVault":
    case "createVaultWithInitialKey":
    case "generateKey":
    case "importPrivateKey":
    case "verifyPassword":
      operation.password = "";
      if (operation.type === "importPrivateKey") {
        operation.material.hex = "";
        operation.material.wif = undefined;
      }
      return;
    case "createVaultWithImportedKey":
      operation.vaultPassword = "";
      operation.key.material.hex = "";
      operation.key.material.wif = undefined;
      return;
    case "deleteKey":
      operation.bucketPassword = undefined;
      return;
    case "changePassword":
      operation.oldPassword = "";
      operation.newPassword = "";
      return;
    case "importKeyBackup":
      operation.sourcePassword = "";
      operation.targetPassword = "";
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
  if (control.type === "status") {
    if (storageStartupFailure) {
      const detail = coordinatorAuthorityRecoveryOperationNames.length > 0
        ? `; active final I/O=${coordinatorAuthorityRecoveryOperationNames.join(",")}`
        : "";
      const health = storageHealthController.snapshot();
      const healthDetail = health.message
        ? `; ${health.diagnostic ?? "unknown"}: ${health.message}`
        : health.diagnostic ? `; ${health.diagnostic}` : "";
      return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "error", message: `Storage startup failed${healthDetail}${detail}`, code: "storage_unavailable" } };
    }
    if (storageHealthController.status() !== "ready" && !storageStartupFailure) {
      return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: storageHealthController.status() };
    }
    const service = await ensureStorageRuntime(peerId).catch(() => undefined);
    if (!service) {
      if (storageStartupFailure) return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "error", message: "Storage startup failed", code: "storage_unavailable" } };
      return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: storageHealthController.status() };
    }
    const runtimeStatus = service.status();
    // 这里报告的是“平台存储是否可启动”，不是 S3 Profile 是否已解锁。
    // Provider 已配置但 Profile 未解锁时，平台 keys/ 与业务 K-V 仍可用，
    // 设置页应当先启动，再让用户输入独立 Profile 密码。
    const status = storageStartupFailure ? "degraded" : platformStorageReady ? "ready" : runtimeStatus;
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: status };
  }
  if (control.type === "retry") {
    try {
      if (!platformRootStore) {
        await bootstrapPlatformStorage(undefined, peerId);
      } else if (platformBucketProvider) {
        await probeStorageAndRecover(peerId);
      } else {
        throw storageUnavailableError("Storage provider is unavailable");
      }
      // 初次 bootstrap 失败时，原初始化 Promise 已经结束；恢复成功后
      // 重新执行同一段 Vault metadata bootstrap，不绕过 Storage-first 门禁。
      if (platformRootStore && storageHealthController.status() !== "ready") {
        await runStorageRecoveryOrchestrator(peerId);
      }
      storageStartupFailure = false;
      platformStorageReady = true;
      emitStorageState();
    } catch (error) {
      const currentHealth = storageHealthController.status();
      storageStartupFailure = currentHealth !== "unselected" && currentHealth !== "authentication";
      if (storageStartupFailure) storageHealthController.setStatus("degraded", error instanceof Error ? error.message : String(error));
      emitStorageState();
    }
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: storageHealthController.status() };
  }
  if (control.type === "summary") {
    const service = await ensureStorageRuntime(peerId);
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: await service.getProviderSummary() };
  }
  if (control.type === "connection") {
    const service = await ensureStorageRuntime(peerId);
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: await service.getProviderConnection() };
  }
  if (control.type === "initial-setup") {
    const result = await executeInitialSetupOnce(control.plan, peerId);
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: result };
  }
  if (control.type === "connect-existing-remote") {
    const result = await executeExistingRemoteStorageConnect(control.plan, peerId);
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: result };
  }
  if (control.type === "probe-bucket") {
    try {
      const result = await executeBucketProbe(control.plan, peerId);
      return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: result };
    } finally {
      // 只读探测的启动密码同样只在本次调用内存在。
      if (control.plan.password !== undefined) control.plan.password = "";
    }
  }
  if (control.type === "initial-setup-result") {
    const result = await getInitialSetupResult(control.transactionId, peerId);
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: result };
  }
  if (control.type === "initial-setup-recovery-list") {
    // 新设计不再有设备侧恢复指针；账本只存在于当前 Worker 内存。
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: [] };
  }
  if (control.type === "switch-bucket") {
    try {
      const result = await switchSelectedRuntimeBucket(control.bucket, control.password, peerId, {
        ...(control.keyPassword === undefined ? {} : { keyPassword: control.keyPassword }),
        ...(control.publicKeyHex === undefined ? {} : { publicKeyHex: control.publicKeyHex }),
      });
      return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: result };
    } finally {
      control.password = "";
      control.keyPassword = "";
    }
  }
  if (control.type === "change-bucket-config") {
    try {
      const result = await changeRuntimeBucketConnection(control.config, control.label, control.password, peerId);
      emitStorageState();
      return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: result };
    } finally {
      control.password = "";
    }
  }
  if (control.type === "rename-bucket") {
    const result = await renameRuntimeBucket(control.label, peerId);
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: result };
  }
  if (control.type === "delete-local-bucket-key") {
    await deleteLocalBucketKey(control.bucket, control.publicKeyHex, peerId);
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" } };
  }
  if (control.type === "unlock-bucket") {
    const hadPlatformRoot = Boolean(platformRootStore);
    try {
      if (!storageBootstrapState?.selectedBucket) throw Object.assign(new Error("No selected storage bucket"), { code: "storage_not_configured" });
      if (!platformRootStore) {
        await bootstrapPlatformStorage(control.password, peerId);
      }
      await runStorageRecoveryOrchestrator(peerId);
      // Hold 冷导入文件可能已经带有完整 Keys；首次解锁桶时恢复到
      // Coordinator 的 canonical Vault 索引，空快照则仍保留 uninitialized
      // 供用户创建第一把 Key。
      await hydrateCatalogVaultFromSnapshot(control.password);
      // 启动密码与 Key 密码是两个独立密码域（规范允许取相同值，但互不
      // 关联）。这里只在两者恰好相同时顺手解锁 Vault；失败只说明启动
      // 密码不是该 Key 的密码，绝不能把存储认证判成失败——保持锁定态，
      // 由锁定页继续询问 Key 自己的密码。
      if (coordinatorState.vaultStatus === "locked" && (await listPublicVaultKeys()).length > 0) {
        const unlockResponse = await handleUnlockUnsafe(
          `bucket-unlock-${crypto.randomUUID()}`,
          { kind: "unlock", password: control.password, expectedSessionEpoch: coordinatorState.sessionEpoch },
        );
        if (unlockResponse.ack.status !== "accepted" && unlockResponse.ack.status !== "already-unlocked") {
          coordinatorState.vaultStatus = "locked";
        }
      }
      emitStorageState();
      return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: { ok: true, vaultUnlocked: coordinatorState.vaultStatus === "unlocked" } };
    } catch (error) {
      if (!hadPlatformRoot && platformRootStore) discardCurrentPlatformStorageBinding();
      storageHealthController.setStatus("authentication", error instanceof Error ? error.message : "Bucket password is invalid");
      emitStorageState();
      return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: { ok: false, diagnostic: error instanceof Error ? error.message : "authentication" } };
    } finally {
      // 新版桶密码只属于本次 bootstrap 调用；Provider 建立后只保留
      // 当前桶 S3 凭据，不保留密码或密码派生材料。
      control.password = "";
    }
  }
  const service = await ensureStorageRuntime(peerId);
  if (control.type === "capabilities") return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: typeof service.getConditionalCapabilities === "function" ? service.getConditionalCapabilities() : null };
  if (control.type === "cancel-probe") { service.cancelProbe(); return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" } }; }
  if (control.type === "probe-capabilities") {
    const result = await service.probeConditionalCapabilities();
    // 手动重新探测：把确定的结果写回当前桶的设备记录，之后不再自动探测。
    const binding = selectedCatalogBucket();
    const mode = result.put === "native" || result.put === "best-effort" ? result.put : undefined;
    if (binding && mode) await updateDeviceRecordCapabilities(binding.bucketId, mode, peerId);
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: result };
  }
  return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "validation-error", message: "Unknown storage control" } };
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
    case "connection":
    case "initial-setup-recovery-list":
    case "capabilities":
    case "probe-capabilities":
    case "cold-export":
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
  const flushDeferredCatalogBindingDiscard = (): void => {
    if (!catalogBindingDiscardDeferred) return;
    catalogBindingDiscardDeferred = false;
    try { discardCurrentPlatformStorageBinding(); }
    catch (error) { console.warn("[coordinator] deferred catalog binding discard failed", error instanceof Error ? error.message : String(error)); }
  };
  try {
    return await withCoordinatorFinalIoLease(
      storageControlIoKind(request.control),
      signal,
      (leaseSignal) => executeStorageControl(request, leaseSignal, peerId),
      {
        auditOperation: "storage.control",
        // 桶首次解锁可能同时把 Hold 快照中的 Key 恢复到 Coordinator，
        // 然后进入同一把 Key 的 unlocked owner。这个有意的本地状态迁移
        // 必须允许当前 storage control 的 final lease 观察到新 gate。
        // 密码轮转同样会主动锁定当前 Vault，需要同一豁免。
        // initial-setup 在已初始化时也会先锁定旧运行态再安装新桶。
        allowLocalLock: request.control.type === "unlock-bucket" || request.control.type === "switch-bucket" || request.control.type === "change-bucket-config" || request.control.type === "initial-setup",
        allowLocalOwnerTransition: request.control.type === "unlock-bucket" || request.control.type === "switch-bucket" || request.control.type === "change-bucket-config" || request.control.type === "initial-setup",
        allowLocalBindingDiscard: request.control.type === "initial-setup" || request.control.type === "connect-existing-remote" || request.control.type === "initial-setup-cleanup",
        // status/summary/connection 等控制读取只观察本地状态；probe 也
        // 不提交配置或远端不可逆结果。它们仍经过 authority lock、本地
        // 运行世代和 epoch 栅栏；冷启动没有 Root 也不能绕过跨 Worker 锁。
        durableLease: storageControlIoKind(request.control) === "write",
      },
    );
  } finally {
    // withCoordinatorFinalIoLease 已完成后置运行世代校验和内存 lease release。
    flushDeferredCatalogBindingDiscard();
  }
}

async function resolvePlatformStorageGrant(grantId: string, actualClientId: string): Promise<StoragePlatformGrant & { clientId: string }> {
  const grant = platformStorageGrants.get(grantId);
  if (!grant || grant.clientId !== actualClientId || grant.sessionEpoch !== coordinatorState.sessionEpoch) throw new Error("Platform storage grant is invalid");
  if (!platformRootStore || grant.bucketId !== platformRootStore.bucket.bucketId || grant.bucketGeneration !== platformRootStore.bucket.bucketGeneration) throw new Error("Platform storage bucket generation changed");
  return grant;
}

async function executePlatformStorageDataUnsafe(
  data: CoordinatorPlatformStorageData,
  actualClientId: string,
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted) throw storageUnavailableError("Platform storage request was cancelled");
  assertStorageDataAvailable();
  const root = platformRootStore;
  const rootToken = platformRootToken;
  if (!root || !rootToken) throw new Error("Platform storage has not been bootstrapped");
  const grant = await resolvePlatformStorageGrant(data.platformGrantId, actualClientId);
  const store = await root.openPlatformStore({ declaration: {
    moduleId: grant.moduleId,
    purposeId: grant.purposeId,
    scope: "bucket",
    authority: grant.authority,
    model: grant.model,
    schemaVersion: grant.schemaVersion,
  } });
  try {
    if (signal?.aborted) throw storageUnavailableError("Platform storage request was cancelled");
    let value: unknown;
    switch (data.type) {
      case "platform.get": value = await store.get(data.key, { partition: data.partition }); break;
      case "platform.list": value = await store.list(data.input); break;
      case "platform.put": value = await store.put(data.key, data.value, data.condition); break;
      case "platform.delete": await store.delete(data.key, data.condition); value = undefined; break;
      case "platform.commit": value = await store.commit({ partition: data.partition, ifRevision: data.ifRevision, operations: data.operations }); break;
    }
    if (platformRootStore !== root || platformRootToken !== rootToken) throw storageUnavailableError("Platform storage binding became stale");
    assertStorageDataAvailable();
    return value;
  } finally {
    store.close();
  }
}

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

async function resolveOwnerStorageGrant(grantId: string, actualClientId: string): Promise<StorageOwnerGrant> {
  const grant = ownerStorageGrants.get(grantId);
  if (!grant || grant.clientId !== actualClientId || grant.sessionEpoch !== coordinatorState.sessionEpoch || grant.ownerPublicKeyHex !== coordinatorState.activePublicKeyHex?.toLowerCase()) throw new Error("Owner storage grant is invalid");
  assertOwnerStorageNotFenced(grant.ownerPublicKeyHex);
  if (!platformRootStore || grant.bucketId !== platformRootStore.bucket.bucketId || grant.bucketGeneration !== platformRootStore.bucket.bucketGeneration) throw new Error("Owner storage bucket generation changed");
  return grant;
}

async function executeOwnerStorageDataUnsafe(data: CoordinatorOwnerStorageData, actualClientId: string, signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) throw storageUnavailableError("Owner storage request was cancelled");
  assertStorageDataAvailable();
  const grant = await resolveOwnerStorageGrant(data.storageGrantId, actualClientId);
  const root = platformRootStore;
  const rootToken = platformRootToken;
  const generation = coordinatorState.keyspaceGeneration;
  if (!root || !rootToken) throw new Error("Platform storage has not been bootstrapped");
  const release = beginOwnerStorageRequest(grant.ownerPublicKeyHex);
  let store: KeyValueStore | undefined;
  try {
    if (grant.model === "files") {
      const files = await root.openOwnerFileStore({
        ownerPublicKeyHex: grant.ownerPublicKeyHex,
        declaration: {
          moduleId: grant.moduleId,
          purposeId: grant.purposeId,
          scope: "owner",
          authority: grant.authority,
          model: grant.model,
          schemaVersion: grant.schemaVersion,
        },
        keyspaceGeneration: generation,
      });
      let fileValue: unknown;
      switch (data.type) {
        case "owner.file-list": fileValue = await files.list(data.input); break;
        case "owner.file-get": fileValue = await files.get(data.path); break;
        case "owner.file-put": fileValue = await files.put(data.path, data.bytes, {
          ...(data.ifNoneMatch === undefined ? {} : { ifNoneMatch: "*" as const }),
          ...(data.ifMatch === undefined ? {} : { ifMatch: data.ifMatch }),
        }); break;
        case "owner.file-delete": await files.delete(data.path, data.ifMatch === undefined ? {} : { ifMatch: data.ifMatch }); fileValue = undefined; break;
        default: throw new Error("Owner file storage request is invalid");
      }
      if (signal?.aborted) throw storageUnavailableError("Owner storage request was cancelled");
      assertOwnerStorageBindingFresh(grant.ownerPublicKeyHex, generation, rootToken);
      return fileValue;
    }
    store = await root.openKeyValueStore({
      ownerPublicKeyHex: grant.ownerPublicKeyHex,
      declaration: {
        moduleId: grant.moduleId,
        purposeId: grant.purposeId,
        scope: "owner",
        authority: grant.authority,
        model: grant.model,
        schemaVersion: grant.schemaVersion,
      },
      keyspaceGeneration: generation
    });
    if (signal?.aborted) throw storageUnavailableError("Owner storage request was cancelled");
    let value: unknown;
    switch (data.type) {
      case "owner.get": value = await store.get(data.key, { partition: data.partition }); break;
      case "owner.list": value = await store.list(data.input); break;
      case "owner.put": value = await store.put(data.key, data.value, data.condition); break;
      case "owner.delete": await store.delete(data.key, data.condition); value = undefined; break;
      case "owner.commit": value = await store.commit({ partition: data.partition, ifRevision: data.ifRevision, operations: data.operations }); break;
    }
    if (signal?.aborted) throw storageUnavailableError("Owner storage request was cancelled");
    assertOwnerStorageBindingFresh(grant.ownerPublicKeyHex, generation, rootToken);
    return value;
  } finally {
    store?.close();
    release();
  }
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

async function executeStorageDataUnsafe(request: Extract<CoordinatorClientRequest, { kind: "storage.data" }>, controller: AbortController, actualClientId: string): Promise<CoordinatorResponse> {
  assertStorageDataAvailable();
  const capturedSessionEpoch = coordinatorState.sessionEpoch;
  const service = await ensureStorageRuntime(actualClientId);
  if (!("grantId" in request.data)) throw new Error("Storage grant is required for file operations");
  const data = request.data;
  const resolvedGrant = await resolveStorageGrant(data.grantId, actualClientId);
  const ctx = resolvedGrant.context;
  const root = platformRootStore;
  if (!root) throw storageUnavailableError("Platform storage root is unavailable");
  // storage.data 与 owner KV 共用同一条 owner tracker。Provider 即使忽略
  // AbortSignal，删除事务也会等待这个 finally 释放，而不是只等待 KV。
  const releaseOwnerRequest = beginOwnerStorageRequest(ctx.ownerPublicKeyHex);
  try {
    const initialSummary = typeof service.getProviderSummary === "function" ? await service.getProviderSummary().catch(() => null) : null;
    const capturedProviderGeneration = initialSummary?.generation ?? null;
    const signal = controller.signal;
    let value: unknown;
    switch (data.type) {
      case "list": value = await service.list(ctx, { ...data.input, signal }); break;
      case "create-directory": value = await service.createDirectory(ctx, { ...data.input, signal }); break;
      case "delete-directory": value = await service.deleteDirectory(ctx, { ...data.input, signal }); break;
      case "put": value = await service.put(ctx, { ...data.input, signal }); break;
      case "get-range": value = await service.getRange(ctx, { ...data.input, signal }); break;
      case "delete": value = await service.delete(ctx, { ...data.input, signal }); break;
      case "begin-upload": value = await service.beginUpload(ctx, { ...data.input, signal }); break;
      case "upload-part": value = await service.uploadPart(ctx, { ...data.input, signal }); break;
      case "complete-upload": value = await service.completeUpload(ctx, { ...data.input, signal }); break;
      case "abort-upload": value = await service.abortUpload(ctx, { ...data.input, signal }); break;
    }
    // A provider may ignore AbortSignal and resolve after lock/replacement. The
    // result is never committed or returned across a session/generation fence.
    if (controller.signal.aborted || capturedSessionEpoch !== coordinatorState.sessionEpoch) {
      const error = new Error("Storage request became stale during owner transition") as Error & { code?: string };
      error.code = "storage_unavailable";
      throw error;
    }
    const finalSummary = typeof service.getProviderSummary === "function" ? await service.getProviderSummary().catch(() => null) : null;
    if ((finalSummary?.generation ?? null) !== capturedProviderGeneration) {
      const error = new Error("storage_unavailable") as Error & { code?: string }; error.code = "storage_unavailable"; throw error;
    }
    await resolveStorageGrant(data.grantId, actualClientId);
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: value };
  } finally {
    releaseOwnerRequest();
  }
}

async function executeStorageData(request: Extract<CoordinatorClientRequest, { kind: "storage.data" }>, controller: AbortController, actualClientId: string): Promise<CoordinatorResponse> {
  const operation = request.data.type === "list" || request.data.type === "get-range" ? "read" : "write";
  return withCoordinatorFinalIoLease(operation, controller.signal, () => executeStorageDataUnsafe(request, controller, actualClientId), { auditOperation: "storage.connect.data" });
}

async function resolveStorageGrant(grantId: string, actualClientId: string): Promise<{ context: import("@keymaster/contracts").OwnerAppStorageGrant; connectSessionId: string }> {
  const grant = storageGrants.get(grantId);
  if (!grant || grant.clientId !== actualClientId || grant.sessionEpoch !== coordinatorState.sessionEpoch) {
    const error = new Error("Storage grant is invalid") as Error & { code?: string }; error.code = "storage_identity_required"; throw error;
  }
  const authoritative = await readProtocolConnectSession(grant.context.connectSessionId);
  if (!authoritative || authoritative.origin !== grant.context.transportOrigin || authoritative.ownerPublicKeyHex !== grant.context.ownerPublicKeyHex || JSON.stringify(authoritative.appIdentity) !== JSON.stringify(grant.context.appIdentity) || grant.context.sessionEpoch !== coordinatorState.sessionEpoch || !platformRootStore || grant.context.bucketId !== platformRootStore.bucket.bucketId || grant.context.bucketGeneration !== platformRootStore.bucket.bucketGeneration || coordinatorState.activePublicKeyHex?.toLowerCase() !== grant.context.ownerPublicKeyHex) {
    const error = new Error("Storage session is invalid or revoked") as Error & { code?: string }; error.code = "storage_identity_required"; throw error;
  }
  return { context: grant.context, connectSessionId: grant.context.connectSessionId };
}

async function abortStorageSession(connectSessionId: string, peerId: string): Promise<void> {
  for (const [requestId, pending] of storageRequests) {
    if (pending.connectSessionId === connectSessionId) { pending.controller.abort(); storageRequests.delete(requestId); }
  }
  for (const [grantId, grant] of storageGrants) if (grant.context.connectSessionId === connectSessionId) storageGrants.delete(grantId);
  const service = await ensureStorageRuntime(peerId);
  await service.abortSession(connectSessionId);
}

async function executeStorageRequest(request: Extract<CoordinatorClientRequest, { kind: "storage.grant" | "storage.control" | "storage.data" | "storage.cancel" | "storage.session.abort" | "storage.owner.bind" | "storage.platform.bind" | "storage.owner.data" | "storage.platform.data" | "storage.owner.delete" }>, actualClientId: string): Promise<CoordinatorResponse> {
  if (request.kind === "storage.grant") {
    const session = await readProtocolConnectSession(request.connectSessionId);
    if (revokedCoordinatorPeerIds.has(actualClientId)) return disconnectedClientResponse(request.requestId);
    if (!session) return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "error", message: "Storage session is invalid or revoked", code: "storage_identity_required" } };
    const ownerPublicKeyHex = coordinatorState.activePublicKeyHex?.toLowerCase();
    if (coordinatorState.vaultStatus !== "unlocked" || !ownerPublicKeyHex || session.ownerPublicKeyHex.toLowerCase() !== ownerPublicKeyHex || !platformRootStore) {
      return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "error", message: "Storage requires an unlocked active owner", code: "storage_identity_required" } };
    }
    const moduleId = deriveThirdPartyStorageModuleId(session.appIdentity.publisherPublicKeyHex, session.appIdentity.appId);
    if (revokedCoordinatorPeerIds.has(actualClientId)) return disconnectedClientResponse(request.requestId);
    const grantId = `grant-${crypto.randomUUID()}`;
    storageGrants.set(grantId, { context: { connectSessionId: session.sessionId, transportOrigin: session.origin, appIdentity: session.appIdentity, bucketId: platformRootStore.bucket.bucketId, bucketGeneration: platformRootStore.bucket.bucketGeneration, ownerPublicKeyHex, moduleId, purposeId: "files", sessionEpoch: coordinatorState.sessionEpoch }, clientId: actualClientId, sessionEpoch: coordinatorState.sessionEpoch });
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: grantId };
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
    // runtime 是页面 Host 的插件配置入口；其它 bucket 级模块必须命中
    // 中央声明目录。请求体只用于声明匹配，grant 始终由 Coordinator
    // 使用预绑定的 expected 值生成，调用方不能自报 module/purpose。
    const expected = SYSTEM_STORAGE_DECLARATIONS[request.pluginId]?.flat().find((candidate) => candidate.scope === "bucket" && candidate.purposeId === request.declaration.purposeId);
    if (!expected || expected.scope !== "bucket" || expected.authority === "third-party-app" || expected.model !== "kv"
      || request.declaration.moduleId !== expected.moduleId
      || request.declaration.purposeId !== expected.purposeId
      || request.declaration.scope !== expected.scope
      || request.declaration.authority !== expected.authority
      || request.declaration.model !== expected.model
      || request.declaration.schemaVersion !== expected.schemaVersion) {
      return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "error", message: "Platform storage declaration is not authorized", code: "storage_forbidden" } };
    }
    if (!platformRootStore) return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "error", message: "Platform storage requires a ready root", code: "storage_unavailable" } };
    const grant: StoragePlatformGrant & { clientId: string } = {
      platformGrantId: `platform-${crypto.randomUUID()}`,
      bucketId: platformRootStore.bucket.bucketId,
      bucketGeneration: platformRootStore.bucket.bucketGeneration,
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
    const expected = SYSTEM_STORAGE_DECLARATIONS[request.pluginId]?.find((candidate) => candidate.scope === "owner" && candidate.purposeId === request.declaration.purposeId);
    if (!expected || expected.scope !== "owner" || expected.authority !== "built-in-module"
      || (expected.model !== "kv" && expected.model !== "files")
      || request.declaration.moduleId !== expected.moduleId
      || request.declaration.purposeId !== expected.purposeId
      || request.declaration.scope !== expected.scope
      || request.declaration.authority !== expected.authority
      || request.declaration.model !== expected.model
      || request.declaration.schemaVersion !== expected.schemaVersion) {
      return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "error", message: "Owner storage declaration is not authorized", code: "storage_forbidden" } };
    }
    const ownerPublicKeyHex = coordinatorState.activePublicKeyHex?.toLowerCase();
    if (coordinatorState.vaultStatus !== "unlocked" || !ownerPublicKeyHex || !platformRootStore) return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "error", message: "Owner storage requires an unlocked active key", code: "storage_unavailable" } };
    if (revokedCoordinatorPeerIds.has(actualClientId)) return disconnectedClientResponse(request.requestId);
    const grant: StorageOwnerGrant & { clientId: string } = {
      storageGrantId: `owner-${crypto.randomUUID()}`,
      bucketId: platformRootStore.bucket.bucketId,
      bucketGeneration: platformRootStore.bucket.bucketGeneration,
      ownerPublicKeyHex,
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
  if (request.kind === "storage.owner.delete") {
    if (revokedCoordinatorPeerIds.has(actualClientId)) return disconnectedClientResponse(request.requestId);
    const controller = new AbortController();
    const requestKey = storageRequestKey(actualClientId, request.requestId);
    storageRequests.set(requestKey, { controller, clientId: actualClientId });
    try {
      await withCoordinatorFinalIoLease("write", controller.signal, async (signal) => {
        if (signal.aborted) throw storageUnavailableError("Owner storage deletion was cancelled");
        const root = platformRootStore;
        if (!root) throw new Error("Platform storage has not been bootstrapped");
        await root.deleteOwnerStorage({ ownerPublicKeyHex: request.ownerPublicKeyHex });
      }, { auditOperation: "storage.owner.delete" });
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
  const operation: CoordinatorSatOperation = request.operation;
  let value: unknown;
  switch (operation.type) {
    case "ensure":
      value = null;
      break;
    case "admin.getSettings":
      value = await runtime.admin.getSettingsSnapshot();
      break;
    case "admin.upsertSupplier":
      await runtime.admin.upsertSupplier(operation.config);
      value = null;
      break;
    case "admin.deleteSupplier":
      await runtime.admin.deleteSupplier(operation.supplierId);
      value = null;
      break;
    case "admin.setOwnerSettings":
      await runtime.admin.setOwnerSettings(operation.settings);
      try {
        const mux = await ensureChannelSubscriptionMux(runtime);
        await mux.set(channelCallerId({ kind: "system", systemId: "owner-inbox" }), [inboxChannel(parsePublicKey(runtime.ownerPublicKeyHex))]);
      } catch (error) {
        // 设置已落库；若当前 receive Supplier 尚不可用，保留系统 caller
        // 的意图，下一次设置/Channel 操作会再次尝试物理订阅。
        console.warn("[channel] owner inbox rebind unavailable", error instanceof Error ? error.message : String(error));
      }
      value = null;
      break;
    case "admin.refreshSubscriptions":
      value = await runtime.handle.refreshSubscriptions(operation.input);
      break;
    case "admin.getBilling":
      value = await runtime.admin.getBilling(operation.input);
      break;
    case "service.publish": value = await runtime.service.publish(operation.input); break;
    case "spi.getInformation": value = await runtime.spi.getInformation(operation.input); break;
    case "spi.prepareTopUp": value = await runtime.spi.prepareTopUp(operation.input); break;
    case "spi.submitTopUp": value = await runtime.spi.submitTopUp(operation.preview); break;
    case "spi.collectNew": value = await runtime.spi.collectNew(operation.input); break;
    case "spi.retryCollect": value = await runtime.spi.retryCollect(operation.input); break;
    case "spi.collect": value = await runtime.spi.collect(operation.input); break;
  }
  return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: value };
}

// ============================================================
// Channel runtime / owner inbox
// ============================================================

const CHANNEL_MAX_SUBSCRIPTIONS_PER_CALLER = 64;
const CHANNEL_PROTOCOLS = new Set([APP_MESSAGE_PROTOCOL, WEBRTC_SIGNAL_PROTOCOL, PING_PROTOCOL]);
type ChannelPrivateProtocol = typeof APP_MESSAGE_PROTOCOL | typeof WEBRTC_SIGNAL_PROTOCOL | typeof PING_PROTOCOL;
type ChannelCaller = Extract<CoordinatorChannelOperation, { type: "subscription-set" }>['caller'];
type ChannelOperationCaller = Extract<CoordinatorChannelOperation, { type: "private-publish" }>['caller'];

/** 生成公开消息时间对；同一次签名必须只读取一次系统时钟。 */
function channelPublicMessageTimes(now: () => number = Date.now): { issuedAtMs: number; expiresAtMs: number } {
  const issuedAtMs = now();
  return { issuedAtMs, expiresAtMs: issuedAtMs + PUBLIC_MESSAGE_MAX_LIFETIME_MS };
}

/** 测试公开消息时间边界；字段含义：issuedAtMs=签发时间，expiresAtMs=过期时间。 */
export function __testBuildChannelPublicMessageTimes(now: () => number = Date.now): { issuedAtMs: number; expiresAtMs: number } {
  return channelPublicMessageTimes(now);
}

function currentOwnerPrivateKey(): ReturnType<typeof parsePrivateKey> {
  if (coordinatorState.vaultStatus !== "unlocked" || !coordinatorState.activePrivateKeyBytes || !coordinatorState.activePublicKeyHex) {
    throw new Error("Channel runtime requires an unlocked active key");
  }
  const privateKey = parsePrivateKey(coordinatorState.activePrivateKeyBytes);
  if (publicKeyFromPrivate(privateKey) !== coordinatorState.activePublicKeyHex) throw new Error("Active Channel owner key mismatch");
  return privateKey;
}

function channelMonotonicNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function allowAutomaticPong(senderPublicKeyHex: string): boolean {
  const now = Date.now();
  if (channelAutoPongWindowStartedAtMs === 0 || now - channelAutoPongWindowStartedAtMs >= CHANNEL_AUTO_PONG_WINDOW_MS) {
    channelAutoPongWindowStartedAtMs = now;
    channelAutoPongCount = 0;
    channelAutoPongBySender.clear();
  }
  if (channelAutoPongCount >= CHANNEL_AUTO_PONG_MAX_GLOBAL) return false;
  const sender = channelAutoPongBySender.get(senderPublicKeyHex);
  if (sender && now - sender.windowStartedAtMs < CHANNEL_AUTO_PONG_WINDOW_MS && sender.count >= CHANNEL_AUTO_PONG_MAX_PER_SENDER) return false;
  if (!sender || now - sender.windowStartedAtMs >= CHANNEL_AUTO_PONG_WINDOW_MS) {
    channelAutoPongBySender.set(senderPublicKeyHex, { windowStartedAtMs: now, count: 1 });
  } else {
    sender.count += 1;
  }
  channelAutoPongCount += 1;
  return true;
}

// Coordinator 不接受任意 RPC 自报 caller；普通插件还会在 Host context 层被
// 绑定 manifest.id，这里是 Worker 边界的第二道 fail-closed 校验。
const TRUSTED_CHANNEL_PLUGIN_IDS = new Set(["bsv-price", "message", "webrtc"]);
const TRUSTED_CHANNEL_SYSTEM_IDS = new Set(["owner-inbox", "contacts-presence"]);

function channelCallerId(caller: ChannelCaller, clientId?: string): string {
  const epoch = coordinatorState.sessionEpoch;
  // Window Host 是独立运行实例；把 Coordinator 生成的端口身份加入
  // caller key，避免一个页面卸载时释放另一个页面仍在使用的订阅。
  const instanceSuffix = clientId ? `:${clientId}` : "";
  if (caller.kind === "plugin") {
    if (!caller.pluginId || caller.pluginId.length > 128 || !TRUSTED_CHANNEL_PLUGIN_IDS.has(caller.pluginId)) {
      throw new Error("Channel plugin caller id is not trusted");
    }
    return `${epoch}:plugin:${caller.pluginId}${instanceSuffix}`;
  }
  if (caller.kind === "system") {
    if (!caller.systemId || caller.systemId.length > 128 || !TRUSTED_CHANNEL_SYSTEM_IDS.has(caller.systemId)) {
      throw new Error("Channel system caller id is not trusted");
    }
    return `${epoch}:system:${caller.systemId}${instanceSuffix}`;
  }
  if (!caller.connectSessionId || !caller.origin) throw new Error("Channel Connect caller is incomplete");
  return `${epoch}:connect:${caller.connectSessionId}:${caller.origin}${instanceSuffix}`;
}

async function ensureChannelSubscriptionMux(runtime: SatWorkerRuntimeState): Promise<ChannelSubscriptionMux> {
  if (channelSubscriptionMux && channelMuxOwnerPublicKeyHex === runtime.ownerPublicKeyHex) return channelSubscriptionMux;
  const existingStart = channelSubscriptionMuxStarting;
  if (existingStart && channelSubscriptionMuxStartOwner === runtime.ownerPublicKeyHex) return existingStart;
  if (existingStart) await existingStart.catch(() => undefined);

  const startGeneration = channelSubscriptionMuxGeneration;
  const start = (async (): Promise<ChannelSubscriptionMux> => {
    if (startGeneration !== channelSubscriptionMuxGeneration
      || coordinatorState.vaultStatus !== "unlocked"
      || coordinatorState.activePublicKeyHex !== runtime.ownerPublicKeyHex) {
      throw new Error("Channel subscription mux became stale before startup");
    }
    const mux = new ChannelSubscriptionMux({
      driver: {
        // 订阅是可撤销的网络副作用，但仍必须绑定当前 Coordinator
        // authority。这样初始 owner inbox、请求中的 set/release 以及退避
        // 重试都不会在旧 Worker 接管后继续使用旧连接身份。
        subscribe: (channel, signal) => withCoordinatorFinalIoLease(
          "write",
          signal,
          (leaseSignal) => runtime.handle.subscribePhysical(channel, leaseSignal),
          { allowLocalLock: true, allowLocalOwnerTransition: true, auditOperation: "channel.subscribe" },
        ),
        unsubscribe: (channel, signal) => withCoordinatorFinalIoLease(
          "write",
          signal,
          (leaseSignal) => runtime.handle.unsubscribePhysical(channel, leaseSignal),
          { allowLocalLock: true, allowLocalOwnerTransition: true, auditOperation: "channel.unsubscribe" },
        )
      }
    });
    channelSubscriptionMux = mux;
    channelMuxOwnerPublicKeyHex = runtime.ownerPublicKeyHex;
    channelSubscriptionMuxStatusOff?.();
    channelSubscriptionMuxStatusOff = mux.subscribeSubscriptionStatus((status) => {
      emitChannelSubscriptionStatus(status, runtime.ownerPublicKeyHex);
    });
    const ownerInbox = inboxChannel(parsePublicKey(runtime.ownerPublicKeyHex));
    try {
      await mux.set(`${coordinatorState.sessionEpoch}:system:owner-inbox`, [ownerInbox], runtime.signal);
    } catch (error) {
      // 未配置 receive Supplier 时只保留 caller 意图；后续设置或重连会重试。
      console.warn("[channel] owner inbox subscription unavailable", error instanceof Error ? error.message : String(error));
    }
    if (startGeneration !== channelSubscriptionMuxGeneration
      || coordinatorState.vaultStatus !== "unlocked"
      || coordinatorState.activePublicKeyHex !== runtime.ownerPublicKeyHex
      || channelSubscriptionMux !== mux) {
      try {
        await mux.clear().catch(() => undefined);
      } finally {
        mux.dispose();
      }
      if (channelSubscriptionMux === mux) {
        channelSubscriptionMux = undefined;
        channelMuxOwnerPublicKeyHex = undefined;
      }
      throw new Error("Channel subscription mux became stale during startup");
    }
    return mux;
  })();
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

function rememberChannelMessage(key: string): boolean {
  if (channelSeenMessages.has(key)) return false;
  channelSeenMessages.add(key);
  while (channelSeenMessages.size > CHANNEL_SEEN_LIMIT) {
    const first = channelSeenMessages.values().next().value as string | undefined;
    if (first === undefined) break;
    channelSeenMessages.delete(first);
  }
  return true;
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
): Promise<{ messageId: string }> {
  // 签名和随后不可逆的网络 Publish 必须属于同一个最终 lease；只保护
  // sign() 会在接管发生后留下“旧 owner 已签名但仍可发布”的窗口。
  return withCoordinatorFinalIoLease(
    "write",
    signal,
    (leaseSignal) => publishChannelHashRequestUnsafe(runtime, input, leaseSignal),
    { auditOperation: "channel.hash-publish" },
  );
}

async function publishChannelHashRequestUnsafe(
  runtime: SatWorkerRuntimeState,
  input: { hash: string; locator: "webrtc-sdp" },
  signal?: AbortSignal,
): Promise<{ messageId: string }> {
  const hash = parseSHA256Hash(input.hash);
  const ownerSessionEpoch = coordinatorState.sessionEpoch;
  const privateKey = currentOwnerPrivateKey();
  const issuedAtMs = Date.now();
  const signed = signHashRequest({
    from_public_key: publicKeyFromPrivate(privateKey),
    message_id: newMessageID(),
    issued_at_ms: issuedAtMs,
    expires_at_ms: issuedAtMs + 10 * 60 * 1000,
    body: { hash, locators: [newWebRTCSDPLocator()] }
  }, privateKey);
  const contentJson = marshalHashRequest(signed);
  // Supplier 通常不会把本 owner 的 Publish 回送给自己；本地仍必须保存
  // 这条 SDK 生成的 VerifiedHashRequest，才能审查远端随后发来的 offer。
  const verified = parseHashRequest(HASH_REQUEST_CHANNEL, contentJson);
  const relationKey = channelHashRequestKey(verified.message_id, verified.from_public_key);
  channelHashRequests.set(relationKey, verified);
  pruneChannelProtocolRelations();
  try {
    await runtime.service.publish({ channel: HASH_REQUEST_CHANNEL, contentJson }, signal);
  } catch (error) {
    const stillFresh = coordinatorState.vaultStatus === "unlocked"
      && coordinatorState.sessionEpoch === ownerSessionEpoch
      && coordinatorState.activePublicKeyHex === runtime.ownerPublicKeyHex;
    // unknown_result 表示消息可能已经到达远端，保留关系等待过期；明确
    // 失败或 owner 已切换时不能留下本地伪 Hash 请求证据。
    if (!stillFresh || !isUnknownChannelPublishFailure(error)) channelHashRequests.delete(relationKey);
    throw error;
  }
  if (coordinatorState.vaultStatus !== "unlocked"
    || coordinatorState.sessionEpoch !== ownerSessionEpoch
    || coordinatorState.activePublicKeyHex !== runtime.ownerPublicKeyHex) {
    channelHashRequests.delete(relationKey);
    throw new Error("Channel owner changed while publishing Hash request");
  }
  return { messageId: signed.message_id };
}

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
    const ownerSessionEpoch = coordinatorState.sessionEpoch;
    const privateKey = currentOwnerPrivateKey();
    const { issuedAtMs, expiresAtMs } = channelPublicMessageTimes();
    const signed = signPublicMessage({
      channel,
      from_public_key: publicKeyFromPrivate(privateKey),
      message_id: newMessageID(),
      issued_at_ms: issuedAtMs,
      expires_at_ms: expiresAtMs,
      body: content,
    }, privateKey);
    await runtime.service.publish({ channel, contentJson: marshalPublicMessage(signed) }, leaseSignal);
    if (coordinatorState.vaultStatus !== "unlocked"
      || coordinatorState.sessionEpoch !== ownerSessionEpoch
      || coordinatorState.activePublicKeyHex !== runtime.ownerPublicKeyHex) {
      throw new Error("Channel owner changed while publishing");
    }
    return { messageId: signed.message_id };
  }, { auditOperation: "channel.public-publish" });
}

/** 在 Coordinator 内给固定业务服务使用的 Channel facade。 */
function createCoordinatorChannelRuntime(): ChannelRuntime {
  const contactsCaller = { kind: "system" as const, systemId: "contacts-presence" };
  const assertContactsEnabled = (): void => {
    if (!isCoordinatorProductEnabled("contacts")) {
      throw new Error("Plugin disabled: contacts");
    }
  };
  return {
    isReady: () => isCoordinatorProductEnabled("contacts")
      && coordinatorState.vaultStatus === "unlocked"
      && Boolean(coordinatorState.activePublicKeyHex),
    async publish(input, signal) {
      assertContactsEnabled();
      const runtime = await ensureSatRuntime();
      return publishChannelPublicMessage(runtime, input.channel, input.content, signal ?? runtime.signal);
    },
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
    subscriptionStatus(channel) {
      validateExactChannel(channel);
      const mux = channelSubscriptionMux;
      if (!mux || channelMuxOwnerPublicKeyHex !== coordinatorState.activePublicKeyHex) {
        return idleChannelSubscriptionStatus(channel);
      }
      return mux.subscriptionStatus(channel);
    },
    subscribeSubscriptionStatus(handler) {
      assertContactsEnabled();
      const subscriber = { sessionEpoch: coordinatorState.sessionEpoch, handler };
      channelSubscriptionStatusSubscribers.add(subscriber);
      return () => channelSubscriptionStatusSubscribers.delete(subscriber);
    },
    subscribe(handler) {
      const subscriber = (event: { channel: string; publisherPublicKeyHex: string; messageId: string; content: import("@keymaster/contracts").JSONValue }) => handler(event);
      channelPublicSubscribers.add(subscriber);
      return () => channelPublicSubscribers.delete(subscriber);
    },
    subscribePrivate(handler) {
      channelPrivateSubscribers.add(handler);
      return () => channelPrivateSubscribers.delete(handler);
    }
  };
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

async function publishPrivateEnvelopeUnsafe(input: {
  runtime: SatWorkerRuntimeState;
  recipientPublicKeyHex: string;
  protocol: ChannelPrivateProtocol;
  body: import("bsv8-channel-protocol/inbox").UnsignedPrivateMessage["body"];
  signal?: AbortSignal;
}): Promise<{ messageId: string; signedMessage: Uint8Array }> {
  if (!CHANNEL_PROTOCOLS.has(input.protocol)) throw new Error("Unsupported private Channel protocol");
  const recipient = parsePublicKey(input.recipientPublicKeyHex);
  const channel = inboxChannel(recipient);
  const ownerSessionEpoch = coordinatorState.sessionEpoch;
  if (input.runtime.ownerPublicKeyHex !== coordinatorState.activePublicKeyHex) {
    throw new Error("Channel owner changed before private publish");
  }
  const privateKey = currentOwnerPrivateKey();
  const messageId = newMessageID();
  const now = Date.now();
  const startedAtMonotonicMs = input.protocol === PING_PROTOCOL && isPingRequestBody(input.body)
    ? channelMonotonicNow()
    : undefined;
  // 过期时间必须由 ChannelProtocol 的子协议上限决定：Ping 60 秒，
  // WebRTC 120 秒，其它私密消息最多 24 小时。签名构造集中在同一个
  // helper，测试可以直接走与 Coordinator 相同的真实签名入口。
  const signed = signChannelPrivateMessage({
    recipientPublicKeyHex: recipient,
    protocol: input.protocol,
    body: input.body,
    messageId,
    nowMs: now,
    privateKey
  });
  let verifiedWebrtc: import("bsv8-channel-protocol/inbox").VerifiedPrivateMessage | undefined;
  if (input.protocol === WEBRTC_SIGNAL_PROTOCOL) {
    verifiedWebrtc = verifySignedPrivateMessage(signed);
    const webrtcBody = verifiedWebrtc.body as import("bsv8-channel-protocol/webrtc-signal").WebRTCSignalV1Body;
    if (webrtcBody.signal.type === "offer") {
      const hashRequest = channelHashRequestByMessageId(webrtcBody.request_message_id, recipient);
      if (!hashRequest) throw new Error("WebRTC offer must reference a live public Hash request");
      reviewOfferForHashRequest(hashRequest, verifiedWebrtc);
    } else {
      const offer = findChannelWebrtcOffer(webrtcBody, verifiedWebrtc);
      if (!offer) throw new Error("WebRTC signal has no verified offer relation");
      validateWebRTCRelation(offer, verifiedWebrtc);
    }
  }
  const pingMessage = input.protocol === PING_PROTOCOL && isPingRequestBody(input.body)
    ? verifySignedPrivateMessage(signed)
    : undefined;
  const verifiedWebrtcBody = verifiedWebrtc?.body as import("bsv8-channel-protocol/webrtc-signal").WebRTCSignalV1Body | undefined;
  const webrtcOfferKey = verifiedWebrtc && verifiedWebrtcBody?.signal.type === "offer"
    ? channelWebrtcOfferKey(
      verifiedWebrtcBody.request_message_id,
      verifiedWebrtc.from_public_key,
      verifiedWebrtcBody.session_id
    )
    : undefined;
  if (verifiedWebrtc && webrtcOfferKey) {
    // Offer 关系必须在发送边界前登记。Publish 返回 unknown_result 时，
    // 远端可能已经收到 offer 并立即回 answer；提前登记才能通过后续关系
    // 审查。明确失败时下面会删除这条本地证据。
    channelWebrtcOffers.set(webrtcOfferKey, verifiedWebrtc);
    pruneChannelProtocolRelations();
  }
  let envelope: Awaited<ReturnType<typeof sealSigned>>;
  try {
    envelope = await sealSigned(signed, privateKey);
  } catch (error) {
    if (webrtcOfferKey) channelWebrtcOffers.delete(webrtcOfferKey);
    throw error;
  }
  if (input.protocol === PING_PROTOCOL && isPingRequestBody(input.body)) {
    pruneChannelPendingPings(now);
    // 必须在网络 Publish 前登记；Pong 可能在 publish Promise settle 前
    // 经另一个入站 handler 到达。unknown_result 时保留到 TTL，禁止重复发送。
    channelPendingPings.set({
      messageId,
      ownerSessionEpoch,
      ownerPublicKeyHex: input.runtime.ownerPublicKeyHex,
      contactPublicKeyHex: recipient,
      startedAtMonotonicMs: startedAtMonotonicMs!,
      expiresAtMs: now + CHANNEL_PENDING_PING_TTL_MS,
      pingMessage: pingMessage!
    });
    scheduleChannelPendingPingCleanup();
  }
  try {
    await input.runtime.service.publish({ channel, contentJson: marshalEnvelope(envelope) }, input.signal);
  } catch (error) {
    const stillFresh = coordinatorState.vaultStatus === "unlocked"
      && coordinatorState.sessionEpoch === ownerSessionEpoch
      && coordinatorState.activePublicKeyHex === input.runtime.ownerPublicKeyHex;
    if (!isUnknownChannelPublishFailure(error) || !stillFresh) {
      channelPendingPings.delete(messageId);
      if (webrtcOfferKey) channelWebrtcOffers.delete(webrtcOfferKey);
    }
    throw error;
  }
  if (coordinatorState.vaultStatus !== "unlocked"
    || coordinatorState.sessionEpoch !== ownerSessionEpoch
    || coordinatorState.activePublicKeyHex !== input.runtime.ownerPublicKeyHex) {
    channelPendingPings.delete(messageId);
    if (webrtcOfferKey) channelWebrtcOffers.delete(webrtcOfferKey);
    throw new Error("Channel owner changed while publishing");
  }
  // 出站签名明文由调用方作为本地证据原样保存；不重新序列化，不包含密文。
  return { messageId, signedMessage: marshalPrivateMessage(signed) };
}

function signChannelPrivateMessage(input: {
  recipientPublicKeyHex: string;
  protocol: ChannelPrivateProtocol;
  body: import("bsv8-channel-protocol/inbox").UnsignedPrivateMessage["body"];
  messageId: string;
  nowMs: number;
  privateKey: Uint8Array;
}): import("bsv8-channel-protocol/inbox").SignedPrivateMessage {
  const recipient = parsePublicKey(input.recipientPublicKeyHex);
  const issuedAtMs = input.nowMs;
  const message = {
    channel: inboxChannel(recipient),
    from_public_key: publicKeyFromPrivate(input.privateKey),
    message_id: parseMessageID(input.messageId),
    issued_at_ms: issuedAtMs,
    expires_at_ms: issuedAtMs + privateMessageMaxLifetimeMs(input.protocol),
    protocol: input.protocol,
    body: input.body
  } as import("bsv8-channel-protocol/inbox").UnsignedPrivateMessage;
  return signPrivateMessage(message, input.privateKey);
}

function isPingRequestBody(
  body: import("bsv8-channel-protocol/inbox").UnsignedPrivateMessage["body"]
): body is import("bsv8-channel-protocol/ping").PingBody {
  return body !== null
    && typeof body === "object"
    && !Array.isArray(body)
    && "type" in body
    && body.type === "ping";
}

function privateProtocol(protocol: string): ChannelPrivateProtocol {
  if (CHANNEL_PROTOCOLS.has(protocol as ChannelPrivateProtocol)) return protocol as ChannelPrivateProtocol;
  throw new Error("Unsupported private Channel protocol");
}

function validatePrivateProtocolCaller(caller: ChannelOperationCaller, protocol: ChannelPrivateProtocol): void {
  if (caller.kind === "connect") throw new Error("Connect caller cannot publish private inbox messages");
  if (caller.kind === "plugin") {
    if (caller.pluginId === "message" && protocol === APP_MESSAGE_PROTOCOL) return;
    // WebRTC 的呼叫/文件请求先使用已注册的 message 子协议交换
    // Hash 请求上下文；真正的 SDP/ICE 仍只能走 WEBRTC_SIGNAL_PROTOCOL。
    if (caller.pluginId === "webrtc" && (protocol === WEBRTC_SIGNAL_PROTOCOL || protocol === APP_MESSAGE_PROTOCOL)) return;
    throw new Error("Channel plugin is not allowed to publish this private protocol");
  }
  if (caller.systemId === "contacts-presence" && protocol === PING_PROTOCOL) return;
  throw new Error("Channel system is not allowed to publish this private protocol");
}

/** 把已验证历史信封转换成给消息插件的业务 JSON；不投递、不产生副作用。 */
function privateHistoryContent(opened: import("bsv8-channel-protocol/inbox").VerifiedPrivateMessage): import("@keymaster/contracts").JSONValue {
  if (opened.protocol === APP_MESSAGE_PROTOCOL) {
    const body = opened.body as import("bsv8-channel-protocol/app-message").MessageV1Body;
    return body.type === "deliver"
      ? body.content as import("@keymaster/contracts").JSONValue
      : { type: "ack", acknowledged_message_id: body.acknowledged_message_id };
  }
  if (opened.protocol === PING_PROTOCOL) {
    return parsePingBodyValue(opened.body as unknown as import("bsv8-channel-protocol").JSONValue) as unknown as import("@keymaster/contracts").JSONValue;
  }
  if (opened.protocol === WEBRTC_SIGNAL_PROTOCOL) {
    return parseWebrtcBodyValue(opened.body as unknown as import("bsv8-channel-protocol").JSONValue) as unknown as import("@keymaster/contracts").JSONValue;
  }
  throw new Error("UNSUPPORTED_PROTOCOL");
}

function isActiveOwnerInboxChannel(channel: string): boolean {
  const owner = coordinatorState.activePublicKeyHex;
  if (!owner) return false;
  try {
    return channel === inboxChannel(parsePublicKey(owner));
  } catch {
    return false;
  }
}

function isAllowedOwnerInboxSubscription(caller: ChannelCaller, channel: string): boolean {
  if (!isActiveOwnerInboxChannel(channel)) return false;
  // owner-inbox / contacts-presence 是 Coordinator 内部系统路由；message /
  // webrtc 是 Host 绑定身份的内部插件路由。Connect 和其他插件不能订阅
  // 任意 bsv8.inbox.*，避免把私有收件箱暴露成公共事件流。
  if (caller.kind === "system") {
    return caller.systemId === "owner-inbox" || caller.systemId === "contacts-presence";
  }
  return caller.kind === "plugin" && (caller.pluginId === "message" || caller.pluginId === "webrtc");
}

function privateBodyForPublish(protocol: string, content: import("@keymaster/contracts").JSONValue): import("bsv8-channel-protocol/inbox").UnsignedPrivateMessage["body"] {
  const supportedProtocol = privateProtocol(protocol);
  if (supportedProtocol === APP_MESSAGE_PROTOCOL) {
    if (content !== null && typeof content === "object" && !Array.isArray(content) && content.type === "ack") {
      const acknowledged = content.acknowledged_message_id;
      if (typeof acknowledged !== "string") throw new Error("Message ACK must contain acknowledged_message_id");
      return newAck(parseMessageID(acknowledged));
    }
    return newDeliver(content as import("bsv8-channel-protocol").JSONValue);
  }
  if (supportedProtocol === WEBRTC_SIGNAL_PROTOCOL) return parseWebrtcBodyValue(content as import("bsv8-channel-protocol").JSONValue);
  if (supportedProtocol === PING_PROTOCOL) return parsePingBodyValue(content as import("bsv8-channel-protocol").JSONValue);
  throw new Error("Unsupported private Channel protocol");
}

async function handleIncomingChannelPublish(event: SatIncomingPublish): Promise<void> {
  if (coordinatorState.vaultStatus !== "unlocked" || !coordinatorState.activePublicKeyHex) return;
  pruneChannelPendingPings();
  pruneChannelProtocolRelations();
  try {
    const owner = coordinatorState.activePublicKeyHex;
    const ownerSessionEpoch = coordinatorState.sessionEpoch;
    const ownerInbox = inboxChannel(parsePublicKey(owner));
    if (event.channel === ownerInbox) {
      const opened = await withCoordinatorFinalIoLease(
        "read",
        undefined,
        () => {
          // 私信解密也必须在最终权限边界内重新取得当前 owner 私钥；
          // 不能使用 await 之前捕获的旧 key 穿过锁定/接管窗口。
          if (coordinatorState.vaultStatus !== "unlocked"
            || coordinatorState.sessionEpoch !== ownerSessionEpoch
            || coordinatorState.activePublicKeyHex !== owner) {
            throw new Error("Channel owner changed before private message decrypt");
          }
          return openPrivateMessage(event.channel, event.contentJson, currentOwnerPrivateKey());
        },
        { allowLocalLock: true, allowLocalOwnerTransition: true, auditOperation: "channel.incoming-decrypt" },
      );
      // 解密本身可能让出事件循环；锁定、切换 owner 或重建 session 后，
      // 旧事件不得进入新 owner 的业务处理器。
      if (coordinatorState.vaultStatus !== "unlocked"
        || coordinatorState.sessionEpoch !== ownerSessionEpoch
        || coordinatorState.activePublicKeyHex !== owner) {
        return;
      }
      const dedup = privateDedupKey(opened);
      const key = channelSeenMessageKey("private", dedup.protocol, dedup.from_public_key, dedup.message_id);
      if (!rememberChannelMessage(key)) return;
      switch (opened.protocol) {
        case PING_PROTOCOL: {
          const pingBody = parsePingBodyValue(opened.body as unknown as import("bsv8-channel-protocol").JSONValue);
          if (pingBody.type === "ping") {
            const runtime = satRuntime;
            if (runtime && runtime.ownerPublicKeyHex === owner && allowAutomaticPong(opened.from_public_key)) {
              try {
                await publishPrivateEnvelope({ runtime, recipientPublicKeyHex: opened.from_public_key, protocol: PING_PROTOCOL, body: newPong(opened.message_id) });
              } catch (error) {
                console.warn("[channel] automatic Pong failed", error instanceof Error ? error.message : String(error));
              }
            }
            return;
          }
          const pending = channelPendingPings.get(pingBody.ping_message_id);
          if (!pending
            || pending.ownerSessionEpoch !== coordinatorState.sessionEpoch
            || pending.ownerPublicKeyHex !== owner
            || pending.contactPublicKeyHex !== opened.from_public_key
            || pending.expiresAtMs <= Date.now()) {
            return;
          }
          try {
            validatePongRelation(pending.pingMessage, opened);
          } catch {
            return;
          }
          channelPendingPings.delete(pingBody.ping_message_id);
          // RTT 仅作为诊断值，不进入 Contact 实体或公开资源。
          void Math.max(0, channelMonotonicNow() - pending.startedAtMonotonicMs);
          coordinatorContactsService?.recordVerifiedPong?.({
            contactPublicKeyHex: opened.from_public_key,
            receivedAtMs: Date.now()
          });
          emitChannelPrivateMessage({ channel: opened.channel, publisherPublicKeyHex: opened.from_public_key, messageId: opened.message_id, protocol: opened.protocol, content: pingBody as unknown as import("@keymaster/contracts").JSONValue, rawEnvelope: event.contentJson.slice() });
          return;
        }
        case APP_MESSAGE_PROTOCOL: {
          const appBody = opened.body as import("bsv8-channel-protocol/app-message").MessageV1Body;
          const content: import("@keymaster/contracts").JSONValue = appBody.type === "deliver"
            ? appBody.content as import("@keymaster/contracts").JSONValue
            : { type: "ack", acknowledged_message_id: appBody.acknowledged_message_id };
          emitChannelPrivateMessage({ channel: opened.channel, publisherPublicKeyHex: opened.from_public_key, messageId: opened.message_id, protocol: opened.protocol, content, rawEnvelope: event.contentJson.slice() });
          return;
        }
        case WEBRTC_SIGNAL_PROTOCOL: {
          const webrtcBody = parseWebrtcBodyValue(opened.body as unknown as import("bsv8-channel-protocol").JSONValue);
          if (webrtcBody.signal.type === "offer") {
            const hashRequest = channelHashRequestByMessageId(webrtcBody.request_message_id, owner);
            if (!hashRequest) throw new Error("WebRTC offer references an unknown or expired Hash request");
            const relation = reviewOfferForHashRequest(hashRequest, opened);
            channelWebrtcOffers.set(relation.key, opened);
            pruneChannelProtocolRelations();
          } else {
            const offer = findChannelWebrtcOffer(webrtcBody, opened);
            if (!offer) throw new Error("WebRTC signal has no verified offer relation");
            validateWebRTCRelation(offer, opened);
          }
          emitChannelPrivateMessage({ channel: opened.channel, publisherPublicKeyHex: opened.from_public_key, messageId: opened.message_id, protocol: opened.protocol, content: webrtcBody as unknown as import("@keymaster/contracts").JSONValue, rawEnvelope: event.contentJson.slice() });
          return;
        }
        default:
          throw new Error("UNSUPPORTED_PROTOCOL");
      }
    }
    // bsv8.inbox.* is a private namespace. A message arriving at another
    // owner's inbox is never reinterpreted as a public application message.
    if (event.channel.startsWith("bsv8.inbox.")) {
      try { parseInboxChannel(event.channel); } catch { /* malformed private namespace is rejected below */ }
      return;
    }
    if (event.channel === HASH_REQUEST_CHANNEL) {
      const hashRequest = parseHashRequest(event.channel, event.contentJson);
      const relationKey = channelHashRequestKey(hashRequest.message_id, hashRequest.from_public_key);
      const seenKey = channelSeenMessageKey("hash-request", relationKey);
      if (!rememberChannelMessage(seenKey)) return;
      channelHashRequests.set(relationKey, hashRequest);
      pruneChannelProtocolRelations();
      emitChannelPublicMessage({
        channel: event.channel,
        publisherPublicKeyHex: hashRequest.from_public_key,
        messageId: hashRequest.message_id,
        content: {
          hash: hashRequest.body.hash,
          locators: hashRequest.body.locators.map((locator) => locator.kind === "multiaddr"
            ? { kind: locator.kind, address: locator.address }
            : { kind: locator.kind })
        } as unknown as import("@keymaster/contracts").JSONValue
      });
      // BitFS 卖方匹配：命中完整 Seed 且 locator 兼容时才建立销售会话；
      // 未命中或端口未就绪时保持静默，不泄露库存。
      void handleMsfileSellerHashRequest(hashRequest);
      return;
    }
    const publicMessage = parsePublicMessage(event.channel, event.contentJson);
    const publicDedup = publicDedupKey(publicMessage);
    const key = channelSeenMessageKey("public", publicDedup.channel, publicDedup.from_public_key, publicDedup.message_id);
    if (!rememberChannelMessage(key)) return;
    emitChannelPublicMessage({ channel: publicMessage.channel, publisherPublicKeyHex: publicMessage.from_public_key, messageId: publicMessage.message_id, content: publicMessage.body });
  } catch (error) {
    // 无效、过期、未知协议或非 owner inbox 的私密消息全部丢弃；不向 SSP
    // 暴露本地 crypto 错误，也不猜测业务协议。
    console.warn("[channel] inbound message rejected", error instanceof Error ? error.message : String(error));
    if (channelErrorCode(error) === "UNSUPPORTED_PROTOCOL") {
      const rejection = new Error("UNSUPPORTED_PROTOCOL") as Error & { domain?: string; code?: string };
      rejection.domain = "channel-inbound";
      rejection.code = "UNSUPPORTED_PROTOCOL";
      throw rejection;
    }
  }
}

function channelErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return error instanceof Error && error.message === "UNSUPPORTED_PROTOCOL" ? error.message : undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") return code;
  return error instanceof Error && error.message === "UNSUPPORTED_PROTOCOL" ? error.message : undefined;
}

function isUnknownChannelPublishFailure(error: unknown): boolean {
  const code = channelErrorCode(error);
  if (code === "unknown_result") return true;
  return error instanceof Error && /unknown[_ ]result/i.test(error.message);
}

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
  // 旧页面/旧插件即使还持有 Coordinator facade，也不能绕过产品意图重建
  // Channel 入口。Connect caller 属于 protocol 的独立授权链，不在此处
  // 伪造成某个插件；它仍由 Connect session 校验保护。
  if (callerProductId && !isCoordinatorProductEnabled(callerProductId)) {
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
    switch (operation.type) {
      case "hash-request-publish": {
        if (operation.caller.kind !== "plugin" || operation.caller.pluginId !== "webrtc") {
          throw new Error("Only the trusted WebRTC plugin may publish Hash requests");
        }
        if (operation.locator !== "webrtc-sdp") throw new Error("Unsupported Hash request locator");
        const published = await publishChannelHashRequest(runtime, operation, requestSignal);
        if (request.expectedSessionEpoch !== coordinatorState.sessionEpoch
          || coordinatorState.vaultStatus !== "unlocked"
          || coordinatorState.activePublicKeyHex !== operation.ownerPublicKeyHex) {
          throw new Error("Hash request publish became stale after network completion");
        }
        return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: published };
      }
      case "publish": {
        const published = await publishChannelPublicMessage(runtime, operation.channel, operation.content, requestSignal);
        if (request.expectedSessionEpoch !== coordinatorState.sessionEpoch
          || coordinatorState.vaultStatus !== "unlocked"
          || coordinatorState.activePublicKeyHex !== operation.ownerPublicKeyHex) {
          throw new Error("Channel publish became stale after network completion");
        }
        if (operation.caller.kind === "connect") {
          const session = await getAuthoritativeConnectSession(operation.caller.connectSessionId);
          if (!session || session.revokedAt !== null || session.origin !== operation.caller.origin || session.ownerPublicKeyHex !== operation.ownerPublicKeyHex) {
            throw new Error("Channel Connect session was revoked during publish");
          }
        }
        return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: published };
      }
      case "private-publish": {
        const protocol = privateProtocol(operation.protocol);
        validatePrivateProtocolCaller(operation.caller, protocol);
        const published = await publishPrivateEnvelope({ runtime, recipientPublicKeyHex: operation.recipientPublicKeyHex, protocol, body: privateBodyForPublish(protocol, operation.content), signal: requestSignal });
        if (request.expectedSessionEpoch !== coordinatorState.sessionEpoch
          || coordinatorState.vaultStatus !== "unlocked"
          || coordinatorState.activePublicKeyHex !== operation.ownerPublicKeyHex) {
          throw new Error("Private Channel publish became stale after network completion");
        }
        return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: { messageId: published.messageId, signedMessage: published.signedMessage } };
      }
      case "open-private-envelope": {
        // 只有受信任消息插件能按需解密历史信封；Connect App 和公共频道不可用。
        if (operation.caller.kind !== "plugin" || operation.caller.pluginId !== "message") {
          throw new Error("Only the trusted message plugin may open private envelopes");
        }
        if (coordinatorState.vaultStatus !== "unlocked"
          || !coordinatorState.activePublicKeyHex
          || coordinatorState.activePublicKeyHex !== operation.ownerPublicKeyHex) {
          throw new Error("Private envelope history open requires the current unlocked owner");
        }
        const expectedEpoch = coordinatorState.sessionEpoch;
        const opened = await withCoordinatorFinalIoLease(
          "read",
          requestSignal,
          () => openPrivateMessage(inboxChannel(parsePublicKey(operation.ownerPublicKeyHex)), operation.envelope, currentOwnerPrivateKey()),
          { allowLocalLock: true, allowLocalOwnerTransition: true, auditOperation: "channel.history-open" },
        );
        if (request.expectedSessionEpoch !== coordinatorState.sessionEpoch
          || coordinatorState.vaultStatus !== "unlocked"
          || coordinatorState.activePublicKeyHex !== operation.ownerPublicKeyHex
          || expectedEpoch !== coordinatorState.sessionEpoch) {
          throw new Error("Private Channel history open became stale after decrypt");
        }
        return {
          requestId: request.requestId,
          sessionEpoch: coordinatorState.sessionEpoch,
          ack: { status: "ok" },
          operationResult: {
            channel: opened.channel,
            protocol: opened.protocol,
            messageId: opened.message_id,
            publisherPublicKeyHex: opened.from_public_key,
            issuedAtMs: opened.issued_at_ms,
            expiresAtMs: opened.expires_at_ms,
            content: privateHistoryContent(opened)
          }
        };
      }
      case "subscription-set": {
        if (operation.channels.length > CHANNEL_MAX_SUBSCRIPTIONS_PER_CALLER) throw new Error("Too many Channel subscriptions");
        for (const channel of operation.channels) {
          validateExactChannel(channel);
          if (channel.startsWith("bsv8.inbox.")) {
            if (!isAllowedOwnerInboxSubscription(operation.caller, channel)) {
              throw new Error("bsv8.inbox.* is reserved for the current owner inbox router");
            }
          }
        }
        const channels = await mux.set(callerId, operation.channels, requestSignal);
        if (requestSignal?.aborted || revokedCoordinatorPeerIds.has(actualClientId)) {
          return disconnectedClientResponse(request.requestId);
        }
        if (request.expectedSessionEpoch !== coordinatorState.sessionEpoch
          || coordinatorState.vaultStatus !== "unlocked"
          || coordinatorState.activePublicKeyHex !== operation.ownerPublicKeyHex) {
          throw new Error("Channel subscription became stale after reconciliation");
        }
        if (operation.caller.kind === "connect") {
          const session = await getAuthoritativeConnectSession(operation.caller.connectSessionId);
          if (!session || session.revokedAt !== null || session.origin !== operation.caller.origin || session.ownerPublicKeyHex !== operation.ownerPublicKeyHex) {
            throw new Error("Channel Connect session was revoked during subscription reconciliation");
          }
        }
        return {
          requestId: request.requestId,
          sessionEpoch: coordinatorState.sessionEpoch,
          ack: { status: "ok" },
          operationResult: {
            channels,
            // Return the authoritative state observed by this Mux after the
            // logical set. This also covers a caller joining an already
            // physically subscribed channel.
            statuses: channels.map((channel) => mux.subscriptionStatus(channel)),
          }
        };
      }
      case "release":
        await mux.release(callerId, requestSignal);
        channelCallersByClient.get(actualClientId)?.delete(callerId);
        return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: null };
    }
  } catch (error) {
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "error", message: error instanceof Error ? error.message : String(error) } };
  }
}

/** 页面资源只读 Coordinator 的联系人在线快照，不拥有探测或传输能力。 */
async function executeContactsPresenceSnapshot(
  request: Extract<CoordinatorClientRequest, { kind: "contacts.presence.snapshot" }>
): Promise<CoordinatorResponse> {
  if (request.expectedSessionEpoch !== coordinatorState.sessionEpoch) {
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "stale-epoch" } };
  }
  if (!isCoordinatorProductEnabled("contacts")) return coordinatorProductBlockedResponse(request.requestId, "contacts");
  if (coordinatorState.vaultStatus !== "unlocked" || !coordinatorState.activePublicKeyHex) {
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: {} };
  }
  try {
    const presence = await coordinatorContactsService?.getPresenceSnapshot?.() ?? {};
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: presence };
  } catch (error) {
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "error", message: error instanceof Error ? error.message : String(error) } };
  }
}

/** 读取 Worker 唯一的插件产品启停意图。 */
async function executePluginIntentSnapshot(
  request: Extract<CoordinatorClientRequest, { kind: "plugin.intent.snapshot" }>
): Promise<CoordinatorResponse> {
  const controller = pluginIntentController ?? ensurePluginIntentController();
  return {
    requestId: request.requestId,
    sessionEpoch: coordinatorState.sessionEpoch,
    ack: { status: "ok" },
    operationResult: controller.snapshot(),
  };
}

/** 提交启停意图；结果本身区分持久化接受、修订冲突和持久化失败。 */
async function executePluginIntentSubmit(
  request: Extract<CoordinatorClientRequest, { kind: "plugin.intent.submit" }>
): Promise<CoordinatorResponse> {
  const command = request.command;
  // 产品意图是 Coordinator 的唯一写入口；不能让调用方把任意字符串
  // 写入持久快照，否则 Window Host 会收到一条无法装配、也无法审计的意图。
  if (
    !command
    || typeof command !== "object"
    || typeof command.pluginId !== "string"
    || !BUILTIN_PLUGIN_PRODUCT_ID_SET.has(command.pluginId)
  ) {
    return {
      requestId: request.requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "ok" },
      operationResult: {
        status: "command-conflict",
        commandId: typeof command?.commandId === "string" ? command.commandId : "unknown",
        message: "插件产品未在 Coordinator 内置清单注册",
      },
    };
  }
  if (!command.desiredEnabled && BUILTIN_ALWAYS_ON_PLUGIN_PRODUCT_ID_SET.has(command.pluginId)) {
    return {
      requestId: request.requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "ok" },
      operationResult: {
        status: "command-conflict",
        commandId: command.commandId,
        message: "该插件产品属于系统必需组件，不能关闭",
      },
    };
  }
  try {
    const controller = pluginIntentController ?? ensurePluginIntentController();
    const result = await controller.submit(command);
    // Coordinator 意图提交成功后，必须在响应前完成同一 Worker Host 的
    // unit reconcile；否则页面可能先收到 accepted，却在下一条快照里仍看见
    // 旧 instance，或在重新启用时读到尚未装配的 unit。
    await reconcileCoordinatorRuntime();
    return {
      requestId: request.requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "ok" },
      operationResult: result,
    };
  } catch (error) {
    // 正常的业务拒绝由 controller 结构化返回；这里只保护未预期的
    // Worker 内部异常，避免 MessagePort 请求永远等不到响应。
    return {
      requestId: request.requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "error", message: error instanceof Error ? error.message : String(error) },
    };
  }
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
let msfileMutationTail: Promise<void> = Promise.resolve();

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
let windowP2pExecutorBridgeInFlightBytes = 0;
let windowP2pExecutorBridgeInFlightItems = 0;
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
interface WindowP2pExecutorBridgeBudgetWaiter {
  reservedBytes: number;
  reservedItems: number;
  signal?: AbortSignal;
  resolve: () => void;
  reject: (error: Error) => void;
  onAbort: () => void;
}
const windowP2pExecutorBridgeBudgetWaiters: WindowP2pExecutorBridgeBudgetWaiter[] = [];

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
  for (const [requestId, pending] of windowP2pExecutorBridgePending) {
    windowP2pExecutorBridgePending.delete(requestId);
    windowP2pExecutorBridgeInFlightBytes = Math.max(0, windowP2pExecutorBridgeInFlightBytes - pending.reservedBytes);
    windowP2pExecutorBridgeInFlightItems = Math.max(0, windowP2pExecutorBridgeInFlightItems - pending.reservedItems);
    pending.cleanup?.();
    pending.reject(error);
  }
  cancelSatInboundHandlers(undefined, error.message);
  windowP2pExecutorInboundBridgePending.clear();
  windowP2pExecutorBridgeInFlightBytes = 0;
  windowP2pExecutorBridgeInFlightItems = 0;
  for (const waiter of windowP2pExecutorBridgeBudgetWaiters.splice(0)) {
    waiter.signal?.removeEventListener("abort", waiter.onAbort);
    waiter.reject(error);
  }
}

function pumpWindowP2pExecutorBridgeBudget(): void {
  const maxBytes = Math.min(windowP2pExecutorConcurrencyConfig.bridgeMaxInFlightBytes, SAT_SUBSCRIPTION_RESOURCE_LIMITS.maxBridgeInFlightBytes);
  const maxItems = Math.min(windowP2pExecutorConcurrencyConfig.bridgeMaxPendingItems, SAT_SUBSCRIPTION_RESOURCE_LIMITS.maxBridgePendingItems);
  while (windowP2pExecutorBridgeBudgetWaiters.length > 0) {
    const waiter = windowP2pExecutorBridgeBudgetWaiters[0]!;
    if (waiter.signal?.aborted) {
      windowP2pExecutorBridgeBudgetWaiters.shift();
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject(new DOMException("The operation was aborted", "AbortError"));
      continue;
    }
    if (windowP2pExecutorBridgeInFlightBytes + waiter.reservedBytes > maxBytes) break;
    if (windowP2pExecutorBridgeInFlightItems + waiter.reservedItems > maxItems) break;
    windowP2pExecutorBridgeBudgetWaiters.shift();
    waiter.signal?.removeEventListener("abort", waiter.onAbort);
    windowP2pExecutorBridgeInFlightBytes += waiter.reservedBytes;
    windowP2pExecutorBridgeInFlightItems += waiter.reservedItems;
    waiter.resolve();
  }
}

function reserveWindowP2pExecutorBridgeBytes(reservedBytes: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("The operation was aborted", "AbortError"));
  const maxBytes = Math.min(windowP2pExecutorConcurrencyConfig.bridgeMaxInFlightBytes, SAT_SUBSCRIPTION_RESOURCE_LIMITS.maxBridgeInFlightBytes);
  const maxItems = Math.min(windowP2pExecutorConcurrencyConfig.bridgeMaxPendingItems, SAT_SUBSCRIPTION_RESOURCE_LIMITS.maxBridgePendingItems);
  if (!Number.isSafeInteger(reservedBytes) || reservedBytes < 0 || reservedBytes > maxBytes) {
    return Promise.reject(windowP2pError("ERR_BRIDGE_BYTES_LIMIT", "Window P2P bridge byte limit cannot admit this operation"));
  }
  // inFlightItems 已包含 pending、入站 reservation 以及已经从 waiter
  // 队列中准入但尚未落入 pending map 的项；再加上 waiter 才是完整在途数。
  // 不能只看两个 Map，否则同一轮同步 burst 会在 continuation 执行前超额
  // 接受一倍以上的请求。
  if (windowP2pExecutorBridgeInFlightItems + windowP2pExecutorBridgeBudgetWaiters.length >= maxItems) {
    return Promise.reject(windowP2pError("ERR_BRIDGE_PENDING_LIMIT", "Window P2P bridge pending item limit reached"));
  }
  return new Promise<void>((resolve, reject) => {
    const waiter: WindowP2pExecutorBridgeBudgetWaiter = {
      reservedBytes,
      reservedItems: 1,
      signal,
      resolve,
      reject,
      onAbort: () => {
        const index = windowP2pExecutorBridgeBudgetWaiters.indexOf(waiter);
        if (index < 0) return;
        windowP2pExecutorBridgeBudgetWaiters.splice(index, 1);
        reject(new DOMException("The operation was aborted", "AbortError"));
        pumpWindowP2pExecutorBridgeBudget();
      },
    };
    signal?.addEventListener("abort", waiter.onAbort, { once: true });
    windowP2pExecutorBridgeBudgetWaiters.push(waiter);
    pumpWindowP2pExecutorBridgeBudget();
  });
}

function releaseWindowP2pExecutorBridgeBytes(reservedBytes: number, reservedItems = 1): void {
  windowP2pExecutorBridgeInFlightBytes = Math.max(0, windowP2pExecutorBridgeInFlightBytes - reservedBytes);
  windowP2pExecutorBridgeInFlightItems = Math.max(0, windowP2pExecutorBridgeInFlightItems - reservedItems);
  pumpWindowP2pExecutorBridgeBudget();
}

function inboundBridgeEventKey(connectionId: string, eventId: string): string {
  return connectionId + "\u0000" + eventId;
}

function reserveWindowP2pExecutorInboundEvent(event: SatWindowLaneSspRequestEvent, lease: WindowP2pExecutorLeaseState): boolean {
  const reservedBytes = event.wire.byteLength;
  const maxBytes = Math.min(windowP2pExecutorConcurrencyConfig.bridgeMaxInFlightBytes, SAT_SUBSCRIPTION_RESOURCE_LIMITS.maxBridgeInFlightBytes);
  const maxItems = Math.min(windowP2pExecutorConcurrencyConfig.bridgeMaxPendingItems, SAT_SUBSCRIPTION_RESOURCE_LIMITS.maxBridgePendingItems);
  const key = inboundBridgeEventKey(event.connectionId, event.eventId);
  if (reservedBytes < 1 || reservedBytes > maxBytes || windowP2pExecutorInboundBridgePending.has(key)) return false;
  if (windowP2pExecutorBridgeInFlightBytes + reservedBytes > maxBytes
    || windowP2pExecutorBridgeInFlightItems + 1 > maxItems) return false;
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
  windowP2pExecutorBridgeInFlightBytes += reservedBytes;
  windowP2pExecutorBridgeInFlightItems += 1;
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
      if (msfileSellerProtocolPort?.ready && coordinatorState.vaultStatus === "unlocked" && msfileRuntime) {
        msfileRuntime.setSellerRuntimeStatus((msfileSellerSessionManager?.activeCount() ?? 0) > 0 ? "selling" : "ready");
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
        || (eventValue as { type?: unknown }).type === "bitfs-seller-session-closed")) {
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
    ? dispatchOperation.operation as { type?: unknown; kind?: unknown; wire?: unknown }
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
  const laneOperation = operation.operation as { wire?: unknown };
  if (!(laneOperation.wire instanceof Uint8Array)) return operation;
  return {
    ...operation,
    operation: {
      ...(operation.operation as Record<string, unknown>),
      wire: laneOperation.wire.slice(),
    },
  };
}

/**
 * 计算一次 Worker -> Window 操作的最坏 bridge 占用。
 * SSP/SPI 请求必须同时为实际请求和最大响应预留，响应到达前不能释放。
 */
function windowP2pExecutorBridgeBytesForOperation(operation: WindowP2pExecutorOperation): number {
  if (operation.type !== "lane" || !operation.operation || typeof operation.operation !== "object") return 0;
  const laneOperation = operation.operation as { type?: unknown; kind?: unknown; wire?: unknown };
  if ((laneOperation.type === "requestSsp" || laneOperation.type === "requestSpi") && laneOperation.wire instanceof Uint8Array) {
    return laneOperation.wire.byteLength + MAX_WIRE_BYTES;
  }
  if (laneOperation.wire instanceof Uint8Array) return laneOperation.wire.byteLength;
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

const satSubscriptionTransport: SatSubscriptionTransport = {
  async connect(input): Promise<SatSupplierConnection> {
    const connectionId = `sat-connection-${crypto.randomUUID()}`;
    const fence = { supplierId: input.supplier.supplierId, connectionId, ownerSessionEpoch: input.ownerSessionEpoch, supplierGeneration: input.supplierGeneration } as const;
    // 先把业务 handler 放入 connectionId 索引，再发起 Window connect；这样
    // lane/adapter 在 connect 返回前收到的首条 Publish 也能回到当前 owner。
    if (input.onSspRequest) {
      satIncomingHandlers.set(connectionId, {
        supplierId: fence.supplierId,
        ownerSessionEpoch: fence.ownerSessionEpoch,
        supplierGeneration: fence.supplierGeneration,
        handler: input.onSspRequest,
      });
    }
    let result: unknown;
    try {
      result = await satWindowLaneOperation({
        type: "connect",
        ...fence,
        supplierPublicKeyHex: input.supplier.supplierPublicKeyHex,
        multiaddrs: [...input.supplier.multiaddrs]
      }, input.signal);
    } catch (error) {
      cancelSatInboundHandlersForConnection(connectionId, "Sat connection setup failed");
      satIncomingHandlers.delete(connectionId);
      throw error;
    }
    if (!result || typeof result !== "object" || typeof (result as { authenticatedPublicKeyHex?: unknown }).authenticatedPublicKeyHex !== "string"
      || (result as Partial<typeof fence>).supplierId !== fence.supplierId
      || (result as Partial<typeof fence>).connectionId !== fence.connectionId
      || (result as Partial<typeof fence>).ownerSessionEpoch !== fence.ownerSessionEpoch
      || (result as Partial<typeof fence>).supplierGeneration !== fence.supplierGeneration) {
      cancelSatInboundHandlersForConnection(connectionId, "Sat connection returned an invalid fence");
      satIncomingHandlers.delete(connectionId);
      throw new Error("Sat Window lane returned an invalid authenticated connection");
    }
    let connectionState: "online" | "degraded" | "closed" = "online";
    const stateListeners = new Set<(state: "online" | "degraded" | "closed") => void>();
    const setConnectionState = (next: "online" | "degraded" | "closed"): void => {
      if (connectionState === next) return;
      connectionState = next;
      for (const listener of stateListeners) {
        try { listener(next); } catch { /* 单个状态监听器不能打断连接。 */ }
      }
    };
    const connection: SatSupplierConnection = {
      ...fence,
      authenticatedPublicKeyHex: (result as { authenticatedPublicKeyHex: string }).authenticatedPublicKeyHex,
      get state() { return connectionState; },
      onStateChange: (handler) => {
        stateListeners.add(handler);
        handler(connectionState);
        satConnectionStateHandlers.set(connectionId, {
          supplierId: fence.supplierId,
          ownerSessionEpoch: fence.ownerSessionEpoch,
          supplierGeneration: fence.supplierGeneration,
          handler
        });
        return () => {
          stateListeners.delete(handler);
          if (satConnectionStateHandlers.get(connectionId)?.handler === handler) satConnectionStateHandlers.delete(connectionId);
        };
      },
      requestSsp: async (wire, signal) => {
        if (connectionState === "closed") throw new Error("Sat supplier connection is closed");
        try {
          const response = asSatWire(await satWindowLaneOperation({ type: "requestSsp", ...fence, wire: wire.slice() }, signal), "requestSsp");
          setConnectionState("online");
          return response;
        } catch (error) {
          setConnectionState("degraded");
          throw error;
        }
      },
      requestSpi: async (wire, signal) => {
        if (connectionState === "closed") throw new Error("Sat supplier connection is closed");
        try {
          const response = asSatWire(await satWindowLaneOperation({ type: "requestSpi", ...fence, wire: wire.slice() }, signal), "requestSpi");
          setConnectionState("online");
          return response;
        } catch (error) {
          setConnectionState("degraded");
          throw error;
        }
      },
      subscribeSspRequests: (handler) => {
        satIncomingHandlers.set(connectionId, { supplierId: input.supplier.supplierId, ownerSessionEpoch: input.ownerSessionEpoch, supplierGeneration: input.supplierGeneration, handler });
        return () => {
          if (satIncomingHandlers.get(connectionId)?.handler === handler) {
            cancelSatInboundHandlersForConnection(connectionId, "Sat SSP handler was unsubscribed");
            satIncomingHandlers.delete(connectionId);
          }
        };
      },
      close: () => {
        setConnectionState("closed");
        cancelSatInboundHandlersForConnection(connectionId, "Sat connection was closed");
        satIncomingHandlers.delete(connectionId);
        satConnectionStateHandlers.delete(connectionId);
        void satWindowLaneOperation({ type: "close", ...fence }).catch(() => undefined);
      },
    };
    return connection;
  },
};

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
  const sellerManager = msfileSellerSessionManager;
  if (sellerManager) {
    sellerManager.clear();
    if (coordinatorState.vaultStatus === "unlocked" && msfileRuntime && msfileSellerProtocolPort?.ready) {
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
  if (!coordinatorState.activePublicKeyHex || !coordinatorState.activePrivateKeyBytes) throw new Error("Window P2P executor active key is unavailable");
  verifySessionKeyPair({ publicKeyHex: coordinatorState.activePublicKeyHex, privateKeyBytes: coordinatorState.activePrivateKeyBytes });
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
    () => signEcdsaDigest({ privateKeyBytes: coordinatorState.activePrivateKeyBytes!, digest, format: "der" }),
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

const MSFILE_MUTATION_CONTROLS = new Set<CoordinatorMsFileControl["type"]>([
  "settings.global.update",
  "settings.seller.update",
  "settings.readConcurrency.update",
  "settings.readConcurrency.reset",
  "settings.mediaBlockReadConcurrency.update",
  "supplier.upsert",
  "supplier.delete",
  "app-policy.update",
  "app-policy.clear",
  "approval.resolve"
]);

function isMsfileMutationControl(control: CoordinatorMsFileControl): boolean {
  return MSFILE_MUTATION_CONTROLS.has(control.type);
}

async function executeMsfileControl(
  request: Extract<CoordinatorClientRequest, { kind: "msfile.control" }>,
  signal?: AbortSignal,
): Promise<CoordinatorResponse> {
  if (!isMsfileMutationControl(request.control)) {
    return executeMsfileControlNow(request, signal);
  }
  // mutation 进串行尾；前一个失败不阻塞后续。
  const run = msfileMutationTail.then(() => executeMsfileControlNow(request, signal), () => executeMsfileControlNow(request, signal));
  msfileMutationTail = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * 桶内文件块写入的 Worker 侧并发上限。
 *
 * 页面 storage 数据面每个端口只允许 3 个并发请求；批量上传如果逐块走
 * 那条通道，远端一次 PUT 的延迟就是瓶颈。桶块由 Coordinator 直接写
 * OwnerFileStore，这里给出一个有界并发，既提高吞吐又不放大内存。
 */
const MSFILE_BUCKET_BLOCK_WRITE_MAX_CONCURRENCY = 16;
let msfileBucketBlockWritesActive = 0;
const msfileBucketBlockWriteWaiters: Array<() => void> = [];

async function withMsfileBucketBlockWriteSlot<T>(run: () => Promise<T>): Promise<T> {
  while (msfileBucketBlockWritesActive >= MSFILE_BUCKET_BLOCK_WRITE_MAX_CONCURRENCY) {
    await new Promise<void>((resolve) => { msfileBucketBlockWriteWaiters.push(resolve); });
  }
  msfileBucketBlockWritesActive += 1;
  try {
    return await run();
  } finally {
    msfileBucketBlockWritesActive = Math.max(0, msfileBucketBlockWritesActive - 1);
    msfileBucketBlockWriteWaiters.shift()?.();
  }
}

async function executeMsfileControlNow(
  request: Extract<CoordinatorClientRequest, { kind: "msfile.control" }>,
  signal?: AbortSignal,
): Promise<CoordinatorResponse> {
  // 审查修复：排队中的请求必须携带其入队时的 epoch；任务开始时与当前 epoch
  // 比较——入队后发生 lock/unlock/key switch 都会推进 epoch，从而在此被拒。
  const requestEpoch = request.expectedSessionEpoch;
  if (signal?.aborted) throw msfileError("msfile_unavailable", "MSFile control request was cancelled");
  if (coordinatorState.vaultStatus !== "unlocked") {
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "locked" } };
  }
  if (requestEpoch !== coordinatorState.sessionEpoch) {
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "stale-epoch" } };
  }
  const service = await ensureMsfileRuntime();
  if (signal?.aborted) throw msfileError("msfile_unavailable", "MSFile control request was cancelled");
  const runtimeAtStart = service;
  const control: CoordinatorMsFileControl = request.control;
  // 同世代检查在串行任务内部执行，天然免受并发窗口影响。
  const supplierGenerationNow = (): number => msfileRuntime === runtimeAtStart ? service.describeState().supplierGeneration : -1;
  let value: unknown;
  switch (control.type) {
    case "settings.get": value = await service.getSettingsSnapshot(); break;
    case "settings.readConcurrency.get": value = await service.getReadConcurrencySettings(); break;
    case "settings.readConcurrency.update": await service.updateReadConcurrencySettings(control.input); value = null; break;
    case "settings.readConcurrency.reset": await service.resetReadConcurrencySettings(); value = null; break;
    case "settings.mediaBlockReadConcurrency.get": value = await service.getMediaBlockReadConcurrency(); break;
    case "settings.mediaBlockReadConcurrency.update": await service.updateMediaBlockReadConcurrency(control.mediaBlockReadConcurrency); value = null; break;
    case "settings.global.update": await service.updateGlobalPriceSettings(control.input); value = null; break;
    case "settings.seller.update": await service.updateSellerSettings(control.input); value = null; break;
    case "supplier.upsert":
      if (control.expectedGeneration !== null && control.expectedGeneration !== supplierGenerationNow()) {
        return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "validation-error", message: "MSFile supplier generation changed" } };
      }
      await service.upsertSupplier(control.supplier); value = null; break;
    case "supplier.delete":
      if (control.expectedGeneration !== null && control.expectedGeneration !== supplierGenerationNow()) {
        return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "validation-error", message: "MSFile supplier generation changed" } };
      }
      await service.deleteSupplier(control.supplierPublicKeyHex); value = null; break;
    case "supplier.probe": value = await service.probeSupplier(control.supplierPublicKeyHex); break;
    case "app-policy.update": await service.updateAppPriceOverride(control.input); value = null; break;
    case "app-policy.clear": await service.clearAppPriceOverride(control.key); value = null; break;
    case "app-authorizations.list": value = await service.listAppAuthorizations(); break;
    case "approvals.pending": value = service.listPendingApprovals(); break;
    case "approval.resolve": await service.resolveApproval(control.approvalId, control.decision); value = null; break;
    case "bucket.put-block": {
      // 直接写 owner 文件根，不经过页面 storage 数据面的每端口并发上限；
      // 路径由 Worker 拼接，页面只给 hash 和字节。
      const files = createWorkerOwnerFileStore("msfile", "");
      await withMsfileBucketBlockWriteSlot(() => files.put(
        `storage/${control.seedHashHex}/${control.blockHashHex}`,
        new Uint8Array(control.bytes),
      ));
      value = null;
      break;
    }
    case "bucket.get-block": {
      const files = createWorkerOwnerFileStore("msfile", "");
      const object = await files.get(`storage/${control.seedHashHex}/${control.blockHashHex}`);
      if (!object) throw msfileError("msfile_content_not_found", "MSFile bucket block is missing");
      // 响应同样走 ArrayBuffer，避免 TypedArray 的逐元素 DTO 校验开销。
      value = object.bytes.slice().buffer;
      break;
    }
    default: return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "validation-error", message: "Unknown MSFile control" } };
  }
  if (signal?.aborted) throw msfileError("msfile_unavailable", "MSFile control request was cancelled");
  // K-V commit 后复核：请求 epoch、Vault、runtime 身份任一变化都报告为
  // stale-epoch（写入已提交、不可撤销，与 Storage 数据面语义一致）。
  if (
    requestEpoch !== coordinatorState.sessionEpoch ||
    coordinatorState.vaultStatus !== "unlocked" ||
    msfileRuntime !== runtimeAtStart
  ) {
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "stale-epoch" } };
  }
  return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: value };
}

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

async function executeMsfileDataUnsafe(
  request: Extract<CoordinatorClientRequest, { kind: "msfile.data" }>,
  controller: AbortController,
  actualClientId: string,
): Promise<CoordinatorResponse> {
  // 审查修复：以请求自身的 epoch 为栅栏（执行时现取会得到恒真比较）。
  const requestEpoch = request.expectedSessionEpoch;
  const service = await ensureMsfileRuntime();
  const data: CoordinatorMsFileData = request.data;
  const signal = controller.signal;
  // 真正调用 service 前的执行栅栏：排队 / 授权解析期间的取消与世代切换。
  if (requestEpoch !== coordinatorState.sessionEpoch || signal.aborted) {
    throw msfileError("msfile_unavailable", "MSFile request was cancelled");
  }
  let value: unknown;
  if (data.grantId === undefined) {
    // 受信任内部插件路径：只使用全局额度；gateway 不参与。
    switch (data.type) {
      case "stat": value = await service.stat({ seedHashHex: data.seedHashHex, signal }); break;
      case "read-seed": value = await service.readSeed({ sourceId: data.sourceId, seedHashHex: data.seedHashHex, signal }); break;
      case "read-block": value = await service.readBlock({ sourceId: data.sourceId, seedHashHex: data.seedHashHex, blockHashHex: data.blockHashHex, signal }); break;
    }
  } else {
    const { context } = await resolveMsfileGrant(data.grantId, actualClientId, requestEpoch);
    // grant 解析是异步的：返回后再次确认未跨越会话栅栏。
    if (requestEpoch !== coordinatorState.sessionEpoch || signal.aborted) {
      throw msfileError("msfile_unavailable", "MSFile request was cancelled");
    }
    switch (data.type) {
      case "stat": value = await service.connect.stat(context, { seedHashHex: data.seedHashHex, signal }); break;
      case "read-seed": value = await service.connect.readSeed(context, { sourceId: data.sourceId, seedHashHex: data.seedHashHex, signal }); break;
      case "read-block": value = await service.connect.readBlock(context, { sourceId: data.sourceId, seedHashHex: data.seedHashHex, blockHashHex: data.blockHashHex, signal }); break;
    }
  }
  if (controller.signal.aborted || requestEpoch !== coordinatorState.sessionEpoch) {
    throw msfileError("msfile_unavailable", "MSFile request was cancelled");
  }
  return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: value };
}

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
    && !isCoordinatorProductEnabled("msfile")) {
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
  if (!isCoordinatorProductEnabled("msfile")) {
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
      case "activate-key":
        return await handleActivateKey(requestId, request);
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
      case "plugin.intent.snapshot":
        return await executePluginIntentSnapshot(request);
      case "plugin.intent.submit":
        return await executePluginIntentSubmit(request);
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
    return executeStorageRequest(request as never, actualClientId).catch((error) => {
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
  request: { kind: "unlock"; password: string; publicKeyHex?: string; expectedSessionEpoch: SessionEpoch }
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

async function handleUnlockUnsafe(
  requestId: string,
  request: { kind: "unlock"; password: string; publicKeyHex?: string; expectedSessionEpoch: SessionEpoch }
): Promise<CoordinatorResponse> {
  if (coordinatorState.vaultStatus === "unlocked") {
    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "already-unlocked" },
    };
  }

  if (coordinatorState.vaultStatus === "booting" || coordinatorState.vaultStatus === "fatal") {
    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "not-ready" },
    };
  }

  if (coordinatorState.vaultStatus === "uninitialized") {
    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "validation-error", message: "Vault not initialized" },
    };
  }

  let privateKey: Uint8Array | undefined;
  let privateKeyTransferred = false;
  try {
    // 1. keys/ 下没有任何 KeyHold 文件 = 尚未初始化,不能靠密码“解锁”。
    const committedHold = await readVaultHoldSnapshot("");
    await rebuildVaultHoldKeyIndex(committedHold.keys);
    if (committedHold.keys.length === 0) {
      return {
        requestId,
        sessionEpoch: coordinatorState.sessionEpoch,
        ack: { status: "validation-error", message: "Vault not initialized" },
      };
    }

    // 2. 选择要解锁的 Key；密码由该 Key 自己的 KeyHold 文档验证。
    const activeKey = request.publicKeyHex ? await getPublicVaultKey(request.publicKeyHex) : await getActiveKey();
    if (!activeKey) {
      return {
        requestId,
        sessionEpoch: coordinatorState.sessionEpoch,
        ack: { status: "validation-error", message: "Invalid password" },
      };
    }
    try {
      privateKey = await decryptVaultPrivateKey(activeKey.publicKeyHex, request.password, committedHold);
    } catch {
      return {
        requestId,
        sessionEpoch: coordinatorState.sessionEpoch,
        ack: { status: "validation-error", message: "Invalid password" },
      };
    }

    // 4. 验证通过后先抢该 Key 的应用锁：抢不到说明另一个浏览器正在使用,
    //    不能进入无锁状态（规范：使用某把 Key 必须持有锁）。
    const provider = platformBucketProvider;
    if (provider) {
      // 页面刷新会复用同一个 SharedWorker：上一次会话持有的锁可能仍然
      // “存活”（s3 心跳不依赖页面桥），而 release() 是异步删除。必须先
      // 释放旧锁，再写新锁，否则旧锁的删除会把刚写入的 lock.json 删掉，
      // 造成“已解锁但桶里没有锁”的非法状态。
      const previousLock = activeKeyLock.current;
      if (previousLock) {
        activeKeyLock.current = undefined;
        await previousLock.release().catch(() => undefined);
      }
      const session = await ensureWorkerSession();
      const keyLock = createKeyLock(provider, { ownerPublicKeyHex: activeKey.publicKeyHex, holder: session.sessionId });
      try {
        await keyLock.acquire();
      } catch (error) {
        keyLock.dispose();
        if (isStorageConflictError(error)) {
          return {
            requestId,
            sessionEpoch: coordinatorState.sessionEpoch,
            ack: { status: "blocked", reason: { key: "vault.locked.keyInUse", fallback: "该 Key 正被另一个浏览器使用" } },
          };
        }
        throw error;
      }
      installActiveKeyLock(keyLock);
    }
    // 没有物理 Provider（测试注入的 Hold 绑定）时没有可写 lock.json 的介质。

    // 5. 统一进入 unlocked 状态
    await enterUnlockedState(activeKey.publicKeyHex, privateKey, "unlock");
    privateKeyTransferred = true;

    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "accepted" },
    };
  } catch (err) {
    markStorageIoFailure(err);
    // unlock 失败，回到 locked
    coordinatorState.vaultStatus = "locked";
    coordinatorState.activePublicKeyHex = undefined;
    dropActivePrivateKey();
    privateKeyTransferred = false;

    return storageErrorResponse(requestId, err);
  } finally {
    if (privateKey && !privateKeyTransferred) privateKey.fill(0);
  }
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
    case "listKeys":
    case "getKey":
    case "verifyPassword":
    case "exportCurrentKeyBackup":
    case "exportKeyBackup":
      return "read";
    default:
      return "write";
  }
}

function fenceOwnerStorage(publicKeyHex: string): void {
  const owner = publicKeyHex.toLowerCase();
  if (ownerStorageFences.has(owner)) return;

  // 先推进两个世代，再撤销所有 grant；已经拿到 wrapper 的旧请求会在
  // operation 完成后被最终绑定检查拒绝，新的请求则从 grant/fence 入口拒绝。
  ownerStorageFences.set(owner, coordinatorState.keyspaceGeneration);
  coordinatorState.keyspaceGeneration += 1;
  coordinatorState.sessionEpoch = generateEpoch();

  const ownerConnectSessionIds = new Set(
    [...storageGrants.values()]
      .filter((grant) => grant.context.ownerPublicKeyHex.toLowerCase() === owner)
      .map((grant) => grant.context.connectSessionId)
  );
  for (const [requestId, pending] of storageRequests) {
    if (pending.connectSessionId && ownerConnectSessionIds.has(pending.connectSessionId)) {
      pending.controller.abort();
      storageRequests.delete(requestId);
    }
  }
  for (const [grantId, grant] of storageGrants) {
    if (grant.context.ownerPublicKeyHex.toLowerCase() === owner) storageGrants.delete(grantId);
  }
  for (const [grantId, grant] of ownerStorageGrants) {
    if (grant.ownerPublicKeyHex.toLowerCase() === owner) ownerStorageGrants.delete(grantId);
  }
  // 平台 grant 同样绑定当前 session epoch；统一撤销可避免锁定/切 Key
  // 期间已经拿到的 platform handle 继续写入新的 Root。
  platformStorageGrants.clear();
}

function fenceOwnerForKeyDeletion(publicKeyHex: string): void {
  fenceOwnerStorage(publicKeyHex);
}

function clearDeletedActiveOwner(publicKeyHex: string): void {
  if (coordinatorState.activePublicKeyHex?.toLowerCase() !== publicKeyHex.toLowerCase()) return;
  dropActivePrivateKey();
  coordinatorState.activePublicKeyHex = undefined;
}

/**
 * 联合删除：先删 KeyHold 文件（唯一持久化提交），再删除 owner namespace，
 * 最后收敛选择状态。没有共享索引/日志，文件本身即真值。
 */
async function executeKeyDeletionTransaction(
  publicKeyHexInput: string,
  confirmationLabel: string,
  password: string | undefined,
): Promise<true> {
  const publicKeyHex = publicKeyHexInput.toLowerCase();
  void confirmationLabel;
  const hold = requireVaultHoldAdapter();
  const encryptedHold = await hold.readEncryptedSnapshot();
  if (encryptedHold.keys.some((key) => key.publicKeyHex.toLowerCase() === publicKeyHex)) {
    void password;
    await hold.removeKey(publicKeyHex);
    await rebuildVaultHoldKeyIndex((await hold.readCommitted({ password: "" })).keys);
  }
  await waitForTestKeyLifecycleOwnerBarrier();
  fenceOwnerForKeyDeletion(publicKeyHex);
  // activePublicKeyHex 仍保留到这里完成，保证动态 keyScope 的任务也能被
  // 准确归属；此后清空 active，防止 owner-delete 阶段再有新业务请求。
  await cancelTaskRuntimesByKey(publicKeyHex);
  await drainOwnerStorageRequests(publicKeyHex);
  clearDeletedActiveOwner(publicKeyHex);
  const root = platformRootStore;
  if (!root) throw new Error("Storage has not been bootstrapped");
  try {
    await root.deleteOwnerStorage({ ownerPublicKeyHex: publicKeyHex });
  } catch (error) {
    markStorageIoFailure(error);
    throw error;
  }
  clearDeletedActiveOwner(publicKeyHex);
  await repairSelectedAfterDelete(publicKeyHex);
  const remaining = await listPublicVaultKeys();
  if (remaining.length === 0) {
    // 最后一把 Key 删除后就是“尚未初始化”：没有 Key 也没有密码域。
    await performGlobalLock("empty-vault");
    coordinatorState.vaultStatus = "uninitialized";
    publishSessionState("delete-active-key");
  } else {
    publishSessionState("delete-active-key");
  }
  ownerStorageFences.delete(publicKeyHex);
  return true;
}

/** 所有删除共用一条串行事务链。 */
function executeKeyDeletion(publicKeyHex: string, confirmationLabel: string, password?: string): Promise<true> {
  const result = keyDeletionTail.then(
    () => executeKeyDeletionTransaction(publicKeyHex, confirmationLabel, password),
    () => executeKeyDeletionTransaction(publicKeyHex, confirmationLabel, password)
  );
  keyDeletionTail = result.then(() => undefined, () => undefined);
  return result;
}

async function executeVaultOperation(operation: CoordinatorVaultOperation, internalActivationSecret?: string): Promise<unknown> {
  switch (operation.type) {
    case "listKeys": {
      let keys = await listPublicVaultKeys();
      // 慢速远端（例如 s3）冷启动恢复后，索引可能因绑定世代切换被判空；
      // 已解锁时按 keys/ 真实文件自愈重建，避免 UI 误显示“还没有 Key”。
      if (keys.length === 0 && coordinatorState.vaultStatus === "unlocked" && hasVaultHoldBinding()) {
        try {
          const hold = await readVaultHoldSnapshot("");
          if (hold.keys.length > 0) keys = await rebuildVaultHoldKeyIndex(hold.keys);
        } catch {
          // 读取失败保持原结果；下一次资源失效会再次尝试。
        }
      }
      return keys.map(({ publicKeyHex, label, capabilities, createdAt, address, network, format, source }) => ({ publicKeyHex, label, capabilities, createdAt, address, network, format, source }));
    }
    case "getKey": {
      let key = await getPublicVaultKey(operation.publicKeyHex);
      if (!key && coordinatorState.vaultStatus === "unlocked" && hasVaultHoldBinding()) {
        try {
          const hold = await readVaultHoldSnapshot("");
          if (hold.keys.length > 0) {
            await rebuildVaultHoldKeyIndex(hold.keys);
            key = await getPublicVaultKey(operation.publicKeyHex);
          }
        } catch {
          // 同上：读取失败保持原结果。
        }
      }
      if (!key) return undefined;
      const { publicKeyHex, label, capabilities, createdAt, address, network, format, source } = key;
      return { publicKeyHex, label, capabilities, createdAt, address, network, format, source };
    }
    case "verifyPassword": {
      const committed = await readVaultHoldSnapshot("");
      const target = await getActiveKey();
      if (committed.keys.length === 0 || !target) throw new Error("Vault not initialized");
      await decryptVaultPrivateKey(target.publicKeyHex, operation.password, committed);
      return true;
    }
    case "setActive": {
      if (coordinatorState.vaultStatus !== "unlocked") throw new Error("Vault is locked");
      // setActive 是旧的内部兼容入口，不再从 Coordinator 会话读取密码。
      // 生产切换必须走 activate-key RPC；只有带有本次内部操作秘密的
      // 首次导入路径，或 test seam，才允许继续使用这个内部分支。
      const activationSecret = internalActivationSecret ?? testHarnessActivationSecret;
      if (!activationSecret) throw new Error("Active key changes require a password");
      const key = await getPublicVaultKey(operation.publicKeyHex); if (!key) throw new Error("Key not found");
      const bytes = await decryptVaultPrivateKey(key.publicKeyHex, activationSecret);
      const previousActive = coordinatorState.activePublicKeyHex;
      const previousBytes = coordinatorState.activePrivateKeyBytes?.slice();
      const previousGeneration = coordinatorState.keyspaceGeneration;
      const previousSelected = coordinatorMeta.selectedPublicKeyHex;
      let transferred = false;
      let transition: ActiveOwnerTransitionResult | undefined;
      try {
        transition = await transitionActiveStorageOwner(key.publicKeyHex);
        dropActivePrivateKey();
        replaceActivePrivateKey(bytes);
        transferred = true;
        coordinatorState.activePublicKeyHex = key.publicKeyHex;
        if (previousActive?.toLowerCase() === key.publicKeyHex.toLowerCase()) coordinatorState.keyspaceGeneration++;
        coordinatorState.sessionEpoch = generateEpoch();
        coordinatorMeta.selectedPublicKeyHex = key.publicKeyHex;
        await persistSelectedPublicKey(key.publicKeyHex);
        // Key 切换只有在本地 session.activeKey 和当前 authority 都通过最终
        // 边界后，才允许提交 owner transition；否则旧实例可能继续持有
        // 可用 owner。
        await ensureCoordinatorUpgradeSession();
        completeActiveStorageOwnerTransition(transition);
      } catch (error) {
        const failedClosed = Boolean(previousActive) && coordinatorState.vaultStatus !== "unlocked";
        if (failedClosed) {
          dropActivePrivateKey();
          coordinatorMeta.selectedPublicKeyHex = previousSelected;
          throw error;
        }
        dropActivePrivateKey();
        if (previousBytes) replaceActivePrivateKey(previousBytes);
        coordinatorState.activePublicKeyHex = previousActive;
        coordinatorMeta.selectedPublicKeyHex = previousSelected;
        completeActiveStorageOwnerTransition(transition);
        invalidateFailedKeyspaceTransition(previousGeneration);
        emitMsFileState();
        throw error;
      } finally {
        if (!transferred) bytes.fill(0);
      }
      publishSessionState("activate-key");
      emitMsFileState();
      return true;
    }
    case "deleteKey": {
      if (coordinatorState.vaultStatus !== "unlocked") throw new Error("Vault is locked");
      const keys = await listPublicVaultKeys();
      const target = keys.find((key) => key.publicKeyHex.toLowerCase() === operation.publicKeyHex.toLowerCase());
      if (!target) throw new Error("Key not found");
      if (!target.label || operation.confirmationLabel !== target.label) throw new Error("Key label mismatch");
      return await executeKeyDeletion(operation.publicKeyHex, target.label, operation.bucketPassword);
    }
    case "createVault": return await createVaultRpc(operation.password);
    case "createVaultWithInitialKey": return await createVaultRpc(operation.password, { label: operation.label, capabilities: operation.capabilities });
    case "createVaultWithImportedKey": return await createVaultRpc(operation.vaultPassword, operation.key);
    case "generateKey": return await addKeyRpc(operation.password, { label: operation.label, capabilities: operation.capabilities, material: { hex: generatePrivateKeyHex() }, format: "generated", source: "vault-generated" });
    case "importPrivateKey": return await addKeyRpc(operation.password, operation);
    case "exportCurrentKeyBackup": {
      const selectedHex = coordinatorMeta.selectedPublicKeyHex;
      if (!selectedHex) throw new Error("No selected private key");
      return exportVaultKeyBackup(selectedHex);
    }
    case "sealLocalSecret": {
      if (coordinatorState.vaultStatus !== "unlocked") throw new Error("Vault is locked");
      if (!operation.scope || operation.scope.length > 256 || /[\u0000-\u001f\u007f]/u.test(operation.scope)) throw new Error("Invalid secret scope");
      const localSecretKey = await deriveVaultLocalSecretKey(operation.scope);
      try {
        const blob = await encryptBytesWithSaltBoundAad(localSecretKey, operation.plaintext, localSecretAad(operation.scope));
      return { version: 3, keySource: "active-key-hkdf-v1", saltHex: bytesToHex(blob.salt), nonceHex: bytesToHex(blob.iv), ciphertextHex: bytesToHex(blob.ciphertext) };
      } finally {
        operation.plaintext.fill(0);
      }
    }
    case "openLocalSecret": {
      if (coordinatorState.vaultStatus !== "unlocked") throw new Error("Vault is locked");
      if (!operation.scope || operation.scope.length > 256 || /[\u0000-\u001f\u007f]/u.test(operation.scope)) throw new Error("Invalid secret scope");
      const sealed = operation.sealed;
      if (sealed.version !== 3 || sealed.keySource !== "active-key-hkdf-v1") {
        throw new Error("Legacy local secret requires explicit re-sealing with the current active Key");
      }
      const blob = { salt: cryptoHexToBytes(sealed.saltHex), iv: cryptoHexToBytes(sealed.nonceHex), ciphertext: cryptoHexToBytes(sealed.ciphertextHex) };
      const localSecretKey = await deriveVaultLocalSecretKey(operation.scope);
      return decryptBytesWithSaltBoundAad(localSecretKey, blob, localSecretAad(operation.scope));
    }
    case "changePassword": return await changePasswordRpc(operation.oldPassword, operation.newPassword);
    case "finalizeEmptyVaultAfterLastKeyDeletion": {
      if ((await listPublicVaultKeys()).length !== 0) throw new Error("Vault still has keys");
      await performGlobalLock("empty-vault");
      coordinatorState.vaultStatus = "uninitialized";
      return true;
    }
    case "recoverEmptyVaultToUninitialized": await performGlobalLock("recover-empty"); coordinatorState.vaultStatus = "uninitialized"; return true;
    case "exportKeyBackup": {
      return exportVaultKeyBackup(operation.publicKeyHex);
    }
    case "importKeyBackup": {
      // KeyHold 单 Key 文件导入：原样写入，不重加密、不需要密码。
      const provider = platformBucketProvider;
      if (!provider) throw new StorageRuntimeError("storage_unavailable", "The selected runtime bucket is unavailable");
      const repository = createKeyHoldRepository(provider);
      const imported = await repository.import(new TextEncoder().encode(operation.backup));
      await rebuildCurrentCatalogKeyIndex((await repository.readAll()).map((file) => ({ publicKeyHex: file.document.publicKeyHex, label: file.document.label })));
      return { publicKeyHex: imported.document.publicKeyHex, label: imported.document.label };
    }
    default: throw new Error(`Unsupported vault operation: ${(operation as { type: string }).type}`);
  }
}

async function repairSelectedAfterDelete(deleted: string): Promise<void> {
  const remaining = await listPublicVaultKeys();
  if (remaining.length === 0) {
    coordinatorMeta.selectedPublicKeyHex = undefined;
    await persistSelectedPublicKey();
    return;
  }
  if (coordinatorMeta.selectedPublicKeyHex?.toLowerCase() === deleted.toLowerCase() || !await getPublicVaultKey(coordinatorMeta.selectedPublicKeyHex ?? "")) {
    coordinatorMeta.selectedPublicKeyHex = remaining[0]!.publicKeyHex;
    coordinatorState.keyspaceGeneration++;
    await persistSelectedPublicKey();
    publishSessionState("delete-active-key");
  }
}

function generatePrivateKeyHex(): string { return generateValidPrivateKeyHex(); }
async function createVaultRpc(password: string, key?: { label?: string; capabilities?: string[]; material?: { hex: string; wif?: string }; format?: string; source?: string }): Promise<unknown> {
  // 新模型没有“空钱包”：创建钱包 = 写入第一把 Key（以它自己的密码加密）。
  if ((await listPublicVaultKeys()).length > 0) throw new Error("Vault already exists");
  await syncSelectedCatalogHoldSnapshot(password);
  const material = key?.material ?? { hex: generatePrivateKeyHex() };
  return await addKeyRpc(
    password,
    {
      ...key,
      material,
      label: key?.label ?? "Key",
      capabilities: key?.capabilities ?? ["p2pkh"],
      format: key?.format ?? (key?.material ? "imported" : "generated"),
      source: key?.source,
    },
    key?.format === "imported" ? "import-initial-key" : "create-initial-key",
  );
}

/**
 * 新版目录桶新增 Key 的唯一写入路径。
 *
 * Hold `KeyRecord` 先成为提交快照中的唯一密文，然后公开索引随之更新；
 * 不再生成或保存 KeyHold 文档。owner namespace 的创建失败时恢复旧快照，
 * 这样业务 Root 不会看到一把只有半套归属的 Key。
 */
async function addCatalogKeyMaterialRpc(
  password: string,
  privateKey: Uint8Array,
  input: { label: string; capabilities?: string[]; format: string; source?: string },
  initialCause: Extract<SessionStateEvent["cause"], "create-initial-key" | "import-initial-key"> = "create-initial-key",
): Promise<unknown> {
  let published: VaultCatalogHoldSnapshot | undefined;
  let privateKeyTransferred = false;
  let publicKeyHex: string | undefined;
  let ownerActivated = false;
  let previousStatus: CoordinatorVaultStatus | undefined;
  try {
    publicKeyHex = bytesToHex((await import("@noble/curves/secp256k1.js")).secp256k1.getPublicKey(privateKey, true)).toLowerCase();
    await syncSelectedCatalogHoldSnapshot(password);
    const previous = await readVaultHoldSnapshot(password);
    previousStatus = coordinatorState.vaultStatus;
    const keepLocked = previousStatus === "locked" && previous.keys.length === 0;
    if (previous.keys.some((key) => key.publicKeyHex.toLowerCase() === publicKeyHex)) throw new Error("Key already exists");
    // 一 Key 一文件：加密写入即本次新增的唯一持久化提交。
    const encryptedKey = await requireVaultHoldAdapter().encryptPrivateKey({ password, label: input.label, privateKey });
    await waitForTestCatalogHoldPublishBarrier();
    published = await publishVaultHoldSnapshot(password, [...previous.keys, encryptedKey], [], expectedHoldHead(previous.headEtag));
    await waitForTestKeyLifecycleOwnerBarrier();
    // 桶内没有 owner 生命周期记录可激活；标记激活成功以保留失败回滚语义。
    if (!platformRootStore) throw new StorageRuntimeError("storage_unavailable", "Platform storage root is unavailable during Key activation");
    ownerActivated = true;
    if (testFailAfterOwnerStorageActivation) {
      testFailAfterOwnerStorageActivation = false;
      throw new StorageRuntimeError("storage_provider_error", "injected post-activation Key mutation failure");
    }
    const createdAt = new Date().toISOString();
    if (keepLocked) {
      // 锁定的空 Vault 中导入：只建立加密文件与归属,不暴露私钥、不建立会话。
      coordinatorState.vaultStatus = "locked";
      coordinatorState.activePublicKeyHex = undefined;
      coordinatorMeta.selectedPublicKeyHex = undefined;
      dropActivePrivateKey();
      await persistSelectedPublicKey(undefined);
    } else {
      coordinatorState.keyspaceGeneration++;
      try {
        await enterUnlockedState(publicKeyHex, privateKey, previousStatus === "unlocked" ? "activate-key" : initialCause);
      } catch (error) {
        if (coordinatorState.vaultStatus === "unlocked" || previousStatus !== "unlocked") coordinatorState.vaultStatus = previousStatus;
        throw error;
      }
    }
    privateKeyTransferred = !keepLocked;
    return {
      publicKeyHex,
      label: input.label,
      address: deriveP2pkhAddress(publicKeyHex, "main"),
      network: "main",
      format: input.format,
      capabilities: input.capabilities ?? ["p2pkh"],
      createdAt,
      ...(input.source === undefined ? {} : { source: input.source }),
    };
  } catch (error) {
    const rollbackFailures: KeyMutationRollbackFailure[] = [];
    if (published && publicKeyHex) {
      // 文件是唯一真值：回滚 = 删除自己的文件并重建内存索引。
      await waitForTestCatalogHoldRollbackBarrier();
      try {
        await requireVaultHoldAdapter().removeKey(publicKeyHex);
        await rebuildVaultHoldKeyIndex((await requireVaultHoldAdapter().readCommitted({ password })).keys);
      } catch (rollbackError) {
        rollbackFailures.push({ stage: "hold", error: rollbackError });
      }
    }
    if (ownerActivated) {
      try {
        const root = platformRootStore;
        if (!root) throw new StorageRuntimeError("storage_unavailable", "Platform storage root is unavailable during Key rollback");
        await root.deleteOwnerStorage({ ownerPublicKeyHex: publicKeyHex! });
      } catch (cleanupError) {
        rollbackFailures.push({ stage: "owner-storage", error: cleanupError });
      }
    }
    if (rollbackFailures.length > 0) {
      const rollbackError = new KeyMutationRollbackUnconfirmedError(rollbackFailures);
      await failClosedAfterKeyMutationRollback(rollbackError);
      throw rollbackError;
    }
    if (isKeyMutationRollbackUnconfirmed(error)) {
      await failClosedAfterKeyMutationRollback(error instanceof KeyMutationRollbackUnconfirmedError
        ? error
        : new KeyMutationRollbackUnconfirmedError([{ stage: "hold", error }])
      );
    }
    throw error;
  } finally {
    if (!privateKeyTransferred) privateKey.fill(0);
  }
}

async function addCatalogKeyRpc(
  password: string,
  input: { label: string; capabilities?: string[]; material: { hex: string; wif?: string }; format: string; source?: string },
  initialCause: Extract<SessionStateEvent["cause"], "create-initial-key" | "import-initial-key"> = "create-initial-key",
): Promise<unknown> {
  const privateKey = cryptoHexToBytes(input.material.hex);
  return addCatalogKeyMaterialRpc(password, privateKey, input, initialCause);
}

async function addKeyRpc(password: string, input: { label: string; capabilities?: string[]; material: { hex: string; wif?: string }; format: string; source?: string }, initialCause: Extract<SessionStateEvent["cause"], "create-initial-key" | "import-initial-key"> = "create-initial-key"): Promise<unknown> {
  return addCatalogKeyRpc(password, input, initialCause);
}
/**
 * 修改 active Key 自己的密码（KeyHold 文件整文件替换）。
 *
 * 只影响密钥文件：解锁会话与会话里的明文私钥保持不变；其他 Key 的
 * 密码互不影响。旧密码错误时 KeyHold 解锁失败,不写任何东西。
 */
async function changePasswordRpc(oldPassword: string, newPassword: string): Promise<boolean> {
  if (coordinatorState.vaultStatus !== "unlocked") throw new StorageRuntimeError("storage_unavailable", "Vault is locked");
  const publicKeyHex = coordinatorState.activePublicKeyHex?.toLowerCase();
  if (!publicKeyHex) throw new StorageRuntimeError("storage_unavailable", "No active key to change password for");
  if (typeof newPassword !== "string" || newPassword.length === 0) throw new StorageRuntimeError("storage_provider_error", "New password is required");
  const provider = platformBucketProvider;
  if (!provider) throw new StorageRuntimeError("storage_unavailable", "The selected runtime bucket is unavailable");
  await createKeyHoldRepository(provider).changePassword({ publicKeyHex, oldPassword, newPassword });
  return true;
}

async function handleLock(
  requestId: string,
  request: { kind: "lock"; expectedSessionEpoch: SessionEpoch }
): Promise<CoordinatorResponse> {
  await performGlobalLock("manual");
  return {
    requestId,
    sessionEpoch: coordinatorState.sessionEpoch,
    ack: { status: "accepted" },
  };
}

async function performGlobalLock(reason: string): Promise<void> {
  // 规范：用户主动锁定 = 释放该 Key 的应用锁（删除 lock.json）。
  const heldKeyLock = activeKeyLock.current;
  activeKeyLock.current = undefined;
  if (heldKeyLock) await heldKeyLock.release().catch(() => undefined);
  // 锁定时智能调度计时也必须停止；解锁后会立即同步一次并重新开始计时。
  cancelSmartSyncIdleTimer();
  // 第一阶段必须完全脱离网络：先递增 epoch、撤销 capability、覆盖密钥
  // 并广播 locked。Supplier 永不返回时，锁屏请求也不能被远端拖住。
  closeCoordinatorUpgradeSession(`Coordinator locked: ${reason}`);
  const previousActive = coordinatorState.activePublicKeyHex?.toLowerCase();
  // 锁定也属于 owner 边界：先 fence/grant revoke，再 abort 任务和请求。
  // fence 保留到下一次解锁完成 drain 后，防止旧 owner 在 lock → unlock
  // 窗口中重新取得底层存储绑定。
  if (previousActive) fenceOwnerStorage(previousActive);
  const lockedEpoch = generateEpoch();
  // 先推进会话世代并切换为 locked，使所有已经排队的请求立即失效；
  // 后续释放连接/写清理意图都只能作为第二阶段后台工作。
  coordinatorState.sessionEpoch = lockedEpoch;
  coordinatorState.vaultStatus = reason === "recover-empty" || reason === "empty-vault" ? "uninitialized" : "locked";
  const completions: Promise<void>[] = [];
  for (const [, runtime] of coordinatorState.taskRuntimes) {
    runtime.controller?.abort();
    if (runtime.completion) completions.push(runtime.completion);
    if (runtime.timer) {
      clearTimeout(runtime.timer);
    }
    // 锁定时将任务标记为 blocked，而非 idle，让 UI 显示"等待解锁"
    runtime.state = "blocked";
    runtime.blockedReason = "Vault is locked";
    runtime.timer = undefined;
  }

  // 撤销 capability、清空 active key；replace/drop 会覆盖旧 Uint8Array。
  coordinatorState.activePublicKeyHex = undefined;
  dropActivePrivateKey();
  // 保留 wrapper 给未来 unlock/恢复复用，但立即丢弃所有旧底层绑定。
  for (const store of workerOwnerStores) store.invalidateBinding();
  testHarnessActivationSecret = undefined;

  coordinatorState.autoLockDeadline = undefined;
  if (autoLockTimer) clearTimeout(autoLockTimer);
  autoLockTimer = undefined;

  // 这些 release 函数在调用期间只摘除本地句柄；真正的远端退订、连接
  // 关闭和 K-V 清理在第二阶段后台执行，并由 releaseSatRuntime 限时。
  // 这样旧 runtime 不会在 locked 状态继续对外提供能力。
  releaseMsfileRuntime(reason);
  const satCleanup = releaseSatRuntime(reason);
  clearWindowP2pExecutorLeaseLocked();
  stopCoordinatorOwnerWorkerUnits();
  reconcileCoordinatorRuntime();

  if (previousActive) {
    rememberOwnerStorageDrain(previousActive, drainOwnerStorageRequests(previousActive));
  }

  coordinatorState.keyspaceGeneration++;
  if (reason === "empty-vault" || reason === "recover-empty") coordinatorMeta.selectedPublicKeyHex = undefined;
  publishSessionState(reason === "key-deleted" || reason === "empty-vault" ? "delete-active-key" : reason === "recover-empty" ? "recover-empty-vault" : "lock");
  emitMsFileState();
  emitStorageState();

  // 广播任务快照，让 UI 立即显示 blocked 状态
  publishTopicEvent("background.snapshot", {
    type: "background.snapshot.changed",
    sessionEpoch: coordinatorState.sessionEpoch,
    snapshots: getTaskSnapshots(),
  });

  // 普通 lock/unlock 不写持久化：只有清空 Vault 这种业务状态变化需要
  // 把本机 session.activeKey 收敛到“无选择”；安全锁定本身始终只改内存。
  if (reason === "empty-vault" || reason === "recover-empty") {
    await persistSelectedPublicKey().catch((error) => {
      markStorageIoFailure(error);
      console.warn("[coordinator] session activeKey persistence failed", error instanceof Error ? error.message : String(error));
    });
  }

  // 任务 completion 只能在仍处于本次 locked epoch 时清理；若期间已经
  // 解锁，新 runtime 的 controller 不能被旧任务迟到完成覆盖。
  void Promise.allSettled(completions).then(() => {
    if (coordinatorState.sessionEpoch !== lockedEpoch) return;
    for (const runtime of coordinatorState.taskRuntimes.values()) runtime.controller = undefined;
  });
  void satCleanup.catch((error) => console.warn("[sat-subscription] locked cleanup failed", error instanceof Error ? error.message : String(error)));
}

async function handleActivateKey(
  requestId: string,
  request: { kind: "activate-key"; password: string; publicKeyHex: string; expectedSessionEpoch: SessionEpoch }
): Promise<CoordinatorResponse> {
  try {
    return await withCoordinatorFinalIoLease(
      "write",
      undefined,
      () => handleActivateKeyUnsafe(requestId, request),
      { allowLocalOwnerTransition: true, auditOperation: "vault.activate-key" },
    );
  } finally {
    request.password = "";
  }
}

async function handleActivateKeyUnsafe(
  requestId: string,
  request: { kind: "activate-key"; password: string; publicKeyHex: string; expectedSessionEpoch: SessionEpoch }
): Promise<CoordinatorResponse> {
  if (coordinatorState.vaultStatus !== "unlocked") {
    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "blocked", reason: { key: "background.blocked.unlock", fallback: "Vault is locked" } },
    };
  }

  try {
    // 只有当前解密出的 Key 密码能解开目标 KeyHold 文档即视为验证通过。
    const committed = await readVaultHoldSnapshot("");
    if (committed.keys.length === 0) throw new Error("Vault not initialized");
    await decryptVaultPrivateKey(request.publicKeyHex ?? (await getActiveKey())?.publicKeyHex ?? "", request.password, committed);
    const committedHold = await readVaultHoldSnapshot(request.password);
    await rebuildVaultHoldKeyIndex(committedHold.keys);
    const key = await getPublicVaultKey(request.publicKeyHex);
    if (!key) throw new Error("Key not found");
    // 同桶切换必须重新使用本次请求提供的桶密码；不能从当前 Key 会话
    // 或 Coordinator 状态取可复用的密码材料。
    const privateKey = await decryptVaultPrivateKey(key.publicKeyHex, request.password, committedHold);
    const previousActive = coordinatorState.activePublicKeyHex;
    const previousBytes = coordinatorState.activePrivateKeyBytes?.slice();
    const previousGeneration = coordinatorState.keyspaceGeneration;
    const previousSelected = coordinatorMeta.selectedPublicKeyHex;
    let transferred = false;
    let transition: ActiveOwnerTransitionResult | undefined;
    try {
      transition = await transitionActiveStorageOwner(key.publicKeyHex);
      dropActivePrivateKey();
      replaceActivePrivateKey(privateKey);
      transferred = true;
      coordinatorState.activePublicKeyHex = key.publicKeyHex;
      if (previousActive?.toLowerCase() === key.publicKeyHex.toLowerCase()) coordinatorState.keyspaceGeneration++;
      coordinatorState.sessionEpoch = generateEpoch();
      coordinatorMeta.selectedPublicKeyHex = key.publicKeyHex;
      await persistSelectedPublicKey(key.publicKeyHex);
      await ensureCoordinatorUpgradeSession();
      completeActiveStorageOwnerTransition(transition);
    } catch (error) {
      const failedClosed = Boolean(previousActive) && coordinatorState.vaultStatus !== "unlocked";
      if (failedClosed) {
        dropActivePrivateKey();
        coordinatorMeta.selectedPublicKeyHex = previousSelected;
        throw error;
      }
      dropActivePrivateKey();
      if (previousBytes) replaceActivePrivateKey(previousBytes);
      coordinatorState.activePublicKeyHex = previousActive;
      coordinatorMeta.selectedPublicKeyHex = previousSelected;
      completeActiveStorageOwnerTransition(transition);
      invalidateFailedKeyspaceTransition(previousGeneration);
      emitMsFileState();
      throw error;
    } finally {
      if (!transferred) privateKey.fill(0);
    }

    publishSessionState("activate-key");
    emitMsFileState();

    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "accepted" },
    };
  } catch (err) {
    markStorageIoFailure(err);
    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: {
        status: "error",
        message: err instanceof Error ? err.message : String(err),
        ...((err as { code?: unknown })?.code && typeof (err as { code?: unknown }).code === "string"
          ? { code: (err as { code: string }).code as never }
          : {})
      },
    };
  }
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

  if (!coordinatorState.activePrivateKeyBytes) {
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
      () => executeCryptoOperation(request.operation, coordinatorState.activePrivateKeyBytes!),
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

    if (request.expectedSessionEpoch !== coordinatorState.sessionEpoch || coordinatorState.vaultStatus !== "unlocked" || !coordinatorState.activePrivateKeyBytes) {
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

async function executeCryptoOperation(
  operation: CoordinatorCryptoOperation,
  privateKeyBytes: Uint8Array
): Promise<CoordinatorCryptoResult> {
  switch (operation.type) {
    case "signDigest": {
      const sig = await signEcdsaDigest({
        privateKeyBytes,
        digest: cryptoHexToBytes(operation.digestHex),
        format: operation.format
      });
      return { type: "signDigest", signatureHex: bytesToHex(sig), format: operation.format };
    }
    case "deriveP2pkhAddress": return { type: "deriveP2pkhAddress", address: deriveP2pkhAddress(coordinatorState.activePublicKeyHex!, operation.network) };
    default: throw new Error("Unsupported coordinator crypto operation");
  }
}

// ============================================================
// 9. Background Operations
// ============================================================

async function handleBackgroundRunNow(
  requestId: string,
  request: { kind: "background.run-now"; taskId: string; expectedSessionEpoch: SessionEpoch },
  reason = "manual"
): Promise<CoordinatorResponse> {
  if (coordinatorState.vaultStatus !== "unlocked") {
    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "blocked", reason: { key: "background.blocked.unlock", fallback: "Vault is locked" } },
    };
  }

  const runtime = coordinatorState.taskRuntimes.get(request.taskId);
  if (!runtime) {
    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "validation-error", message: `Task not found: ${request.taskId}` },
    };
  }

  // 意图更新与手动触发可能在同一事件循环内交错；不能只依赖上一轮
  // reconcile 已经把 runtime 标成 blocked。入口再次读取当前意图，避免
  // 一个刚被禁用的产品被旧 UI 命令重新拉起。
  const intentBlockedReason = coordinatorTaskBlockedReason(runtime);
  if (intentBlockedReason) {
    if (runtime.timer) clearTimeout(runtime.timer);
    runtime.timer = undefined;
    runtime.nextRunAt = undefined;
    runtime.state = "blocked";
    runtime.blockedReason = intentBlockedReason;
    runtime.error = undefined;
    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "blocked", reason: { key: "background.blocked.task", fallback: intentBlockedReason } },
    };
  }

  if (runtime.state === "running") {
    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "already-running" },
    };
  }

  if (runtime.state === "blocked") {
    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "blocked", reason: { key: "background.blocked.task", fallback: runtime.blockedReason ?? "Task blocked" } },
    };
  }

  void executeTask(request.taskId, reason);
  return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "accepted" } };
}

async function handleBackgroundTrigger(requestId: string, request: { kind: "background.trigger"; taskId: string; reason: string; expectedSessionEpoch: SessionEpoch }): Promise<CoordinatorResponse> {
  return handleBackgroundRunNow(requestId, { kind: "background.run-now", taskId: request.taskId, expectedSessionEpoch: request.expectedSessionEpoch }, request.reason);
}

async function handleBackgroundCancelByKey(requestId: string, request: { kind: "background.cancel-by-key"; publicKeyHex: string; expectedSessionEpoch: SessionEpoch }): Promise<CoordinatorResponse> {
  const cancelled = await cancelTaskRuntimesByKey(request.publicKeyHex);
  publishTopicEvent("background.snapshot", { type: "background.snapshot.changed", sessionEpoch: coordinatorState.sessionEpoch, snapshots: getTaskSnapshots() });
  return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: cancelled ? { status: "accepted" } : { status: "ok" } };
}

async function cancelTaskRuntimesByKey(publicKeyHex: string): Promise<boolean> {
  let cancelled = false;
  const completions: Promise<void>[] = [];
  for (const runtime of coordinatorState.taskRuntimes.values()) {
    // keyScope 可能是随当前 active owner 动态变化的函数；owner 切换后，
    // 运行中的旧任务不能被误认为属于新 owner。以任务启动时捕获的 owner
    // 为准，确保旧 Contacts/P2PKH 任务及时 abort 并等待 completion。
    const taskOwnerPublicKeyHex = runtime.state === "running" && runtime.startedPublicKeyHex
      ? runtime.startedPublicKeyHex
      : resolveKeyScope(runtime)?.publicKeyHex;
    if (taskOwnerPublicKeyHex !== publicKeyHex) continue;
    runtime.controller?.abort();
    if (runtime.timer) clearTimeout(runtime.timer);
    runtime.timer = undefined;
    runtime.state = "idle";
    if (runtime.completion) completions.push(runtime.completion);
    cancelled = true;
  }
  await Promise.allSettled(completions);
  return cancelled;
}

async function handleBackgroundCancel(
  requestId: string,
  request: { kind: "background.cancel"; taskId: string; expectedSessionEpoch: SessionEpoch }
): Promise<CoordinatorResponse> {
  const runtime = coordinatorState.taskRuntimes.get(request.taskId);
  if (!runtime) {
    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "validation-error", message: `Task not found: ${request.taskId}` },
    };
  }

  if (runtime.state === "running" && runtime.controller) {
    runtime.controller.abort();
    const completion = runtime.completion;
    runtime.state = "idle";
    if (completion) await completion;
    runtime.controller = undefined;

    publishTopicEvent("background.snapshot", {
      type: "background.snapshot.changed",
      sessionEpoch: coordinatorState.sessionEpoch,
      snapshots: getTaskSnapshots(),
    });

    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "accepted" },
    };
  }

  return {
    requestId,
    sessionEpoch: coordinatorState.sessionEpoch,
    ack: { status: "ok" },
  };
}

async function handleBackgroundSettingsUpdate(
  requestId: string,
  request: { kind: "background.settings.update"; settings: CoordinatorBackgroundSyncSettings; expectedSessionEpoch: SessionEpoch }
): Promise<CoordinatorResponse> {
  if (
    request.expectedSessionEpoch !== coordinatorState.sessionEpoch
    && request.expectedSessionEpoch !== "boot"
    && request.expectedSessionEpoch !== "locked"
  ) {
    return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "stale-epoch" } };
  }
  const rawIntervals = request.settings?.taskIntervals;
  if (!rawIntervals || typeof rawIntervals !== "object" || Array.isArray(rawIntervals)) {
    return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "validation-error", message: "Invalid sync settings" } };
  }
  const options = BACKGROUND_SYNC_INTERVAL_OPTIONS_MS as readonly number[];
  for (const [taskId, interval] of Object.entries(rawIntervals)) {
    if (!(BACKGROUND_MANAGED_SYNC_TASK_IDS as readonly string[]).includes(taskId)
      || typeof interval !== "number" || !options.includes(interval)) {
      return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "validation-error", message: `Invalid sync interval for ${taskId}` } };
    }
  }
  const nextSettings = normalizeBackgroundSyncSettings(request.settings);
  const nextSnapshot: CoordinatorSettingsSnapshot = {
    scheduleSettings: nextSettings,
    autoLockTimeoutMs: coordinatorMeta.autoLockTimeoutMs ?? AUTO_LOCK_DEFAULT_TIMEOUT_MS,
  };
  // 持久化成功才发布新的内存状态；保存失败不能制造“设置已生效”
  // 的假象，也不能让后续调度使用未落盘的值。
  await persistCoordinatorSettings(nextSnapshot);
  coordinatorMeta.scheduleSettings = nextSettings;
  coordinatorState.scheduleSettings = nextSettings;
  for (const runtime of coordinatorState.taskRuntimes.values()) {
    if (runtime.syncPolicy !== "managed") continue;
    runtime.intervalMs = nextSettings.taskIntervals[runtime.id] ?? BACKGROUND_SYNC_DEFAULT_INTERVAL_MS;
    scheduleRuntime(runtime);
  }

  publishTopicEvent("background.snapshot", {
    type: "background.snapshot.changed",
    sessionEpoch: coordinatorState.sessionEpoch,
    snapshots: getTaskSnapshots(),
  });

  return {
    requestId,
    sessionEpoch: coordinatorState.sessionEpoch,
    ack: { status: "accepted" },
  };
}

async function handleAutolockSettingsUpdate(
  requestId: string,
  request: { kind: "autolock.settings.update"; settings: { timeoutMs: number }; expectedSessionEpoch: SessionEpoch }
): Promise<CoordinatorResponse> {
  if (
    request.expectedSessionEpoch !== coordinatorState.sessionEpoch
    && request.expectedSessionEpoch !== "boot"
    && request.expectedSessionEpoch !== "locked"
  ) {
    return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "stale-epoch" } };
  }
  const timeoutMs = request.settings?.timeoutMs;
  if (!isValidAutoLockTimeoutMs(timeoutMs)) {
    return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "validation-error", message: "Invalid auto-lock timeout" } };
  }
  const nextSnapshot: CoordinatorSettingsSnapshot = {
    scheduleSettings: coordinatorMeta.scheduleSettings,
    autoLockTimeoutMs: timeoutMs,
  };
  // 持久化成功才发布内存状态；保存失败不能制造“已生效”假象。
  await persistCoordinatorSettings(nextSnapshot);
  coordinatorMeta.autoLockTimeoutMs = timeoutMs;
  coordinatorState.autoLockTimeoutMs = timeoutMs;
  // 立即按新超时重算 deadline：解锁态下从当前时刻重新计时；
  // 永不锁定则清除 timer；锁定态下只记设置，下次解锁生效。
  if (coordinatorState.vaultStatus === "unlocked") {
    resetAutoLockTimer();
  } else {
    if (autoLockTimer) clearTimeout(autoLockTimer);
    autoLockTimer = undefined;
    coordinatorState.autoLockDeadline = undefined;
  }

  publishSessionState("autolock-settings");

  return {
    requestId,
    sessionEpoch: coordinatorState.sessionEpoch,
    ack: { status: "accepted" },
  };
}

// ============================================================
// 10. Ordinary P2PKH data-source selection and transaction broadcast RPC
// ============================================================

/** 当前 owner 的 p2pkh setting.json 是否已载入运行时镜像。 */
let p2pkhSettingOwner: string | undefined;

let testFailNextP2pkhSettingWrite = false;

/** 测试专用：让下一次 setting.json 写失败一次。 */
export function __testFailNextP2pkhSettingWrite(): void {
  testFailNextP2pkhSettingWrite = true;
}

function p2pkhSettingRepository(): ReturnType<typeof createP2pkhFileRepository> {
  return createP2pkhFileRepository(createWorkerOwnerFileStore("p2pkh", ""));
}

/** 从 setting.json 载入运行时镜像；同 owner 只载入一次。 */
async function loadP2pkhSettingForOwner(ownerPublicKeyHex: string | undefined): Promise<void> {
  const owner = ownerPublicKeyHex?.trim().toLowerCase();
  if (!owner) {
    p2pkhSettingOwner = undefined;
    return;
  }
  if (p2pkhSettingOwner === owner) return;
  try {
    const setting = await p2pkhSettingRepository().readSetting();
    coordinatorMeta.p2pkhSettings = { includeTestnet: setting.includeTestnet };
    // 旧 providerConfigs 中的 junglebus 等配置已由解析器丢弃。
    coordinatorMeta.p2pkhProviderConfigs = structuredClone(setting.providerConfigs);
    p2pkhSettingOwner = owner;
  } catch (error) {
    // 读取失败不能把用户设置清成默认；保持当前镜像并允许后续重试。
    console.warn("[p2pkh] load setting.json failed", error instanceof Error ? error.message : String(error));
  }
}

/** 锁屏 / 切 owner：运行时不保留上一个 owner 的偏好与内存快照。 */
function resetP2pkhSettingsRuntime(): void {
  p2pkhSettingOwner = undefined;
  coordinatorMeta.p2pkhProviderConfigs = {};
  coordinatorMeta.p2pkhSettings = { includeTestnet: false };
  p2pkhUtxoSnapshots?.clearAll();
}

/** 读-改-写 setting.json；failure 时调用方不得更新内存镜像。 */
async function writeP2pkhSettingFile(patch: {
  includeTestnet?: boolean;
  providerConfigs?: Record<string, Record<string, unknown>>;
}): Promise<void> {
  if (testFailNextP2pkhSettingWrite) {
    testFailNextP2pkhSettingWrite = false;
    throw new StorageRuntimeError("storage_provider_error", "injected P2PKH setting write failure");
  }
  const repository = p2pkhSettingRepository();
  const current = await repository.readSetting();
  await repository.writeSetting({
    includeTestnet: patch.includeTestnet ?? current.includeTestnet,
    feeRateSatoshisPerKb: current.feeRateSatoshisPerKb,
    providerConfigs: patch.providerConfigs ?? current.providerConfigs,
  });
}

/**
 * 为当前 owner 在 Worker 侧材料化启用的 P2PKH 资源。
 *
 * 资源表是每个 JS realm 各自的内存态（见 p2pkhStateRepository）：页面窗口
 * 创建的资源对 Worker 不可见，Worker 的余额快照任务必须按同一套确定性规则
 * （owner 公钥 + 网络 → P2PKH 地址）自己补齐资源，否则快照刷新找不到任何
 * 地址，余额永远停在“未知”。
 */
async function ensureWorkerP2pkhResources(ownerPublicKeyHex: string, includeTestnet: boolean): Promise<P2pkhUtxoSnapshotResource[]> {
  const repository = createP2pkhStateRepository(await openP2pkhStateRepository(createWorkerOwnerFileStore("p2pkh", "")));
  const existing = await repository.listResourcesByKey();
  const networks: Array<"main" | "test"> = includeTestnet ? ["main", "test"] : ["main"];
  const createdAt = new Date().toISOString();
  for (const network of networks) {
    const resourceId = `p2pkh:${network}`;
    if (existing.some((resource) => resource.resourceId === resourceId)) continue;
    const address = deriveP2pkhAddress(ownerPublicKeyHex, network);
    const resource = {
      resourceId,
      publicKeyHex: ownerPublicKeyHex,
      label: "",
      address,
      network,
      createdAt,
      generation: 0,
    };
    await repository.putAddress(resource);
    existing.push(resource);
  }
  return existing;
}

/**
 * 刷新当前 owner 全部启用网络的内存 UTXO 快照。
 * 单个资源失败只保留其旧快照，不影响其它资源；错误向上抛给调用方决定。
 */
async function refreshP2pkhUtxoSnapshots(signal?: AbortSignal): Promise<{ main?: number; test?: number }> {
  const owner = coordinatorState.activePublicKeyHex;
  if (!owner || !p2pkhUtxoSnapshots) return {};
  const keyspace = createWorkerKeyspace();
  if (keyspace.active().activePublicKeyHex?.toLowerCase() !== owner.toLowerCase()) return {};
  const includeTestnet = coordinatorMeta.p2pkhSettings?.includeTestnet === true;
  const resources = await ensureWorkerP2pkhResources(owner, includeTestnet);
  const utxoSeqs: { main?: number; test?: number } = {};
  for (const resource of resources) {
    if (resource.network === "test" && !includeTestnet) continue;
    if (signal?.aborted) return utxoSeqs;
    // consumed 快照不能仅凭“下一次 unspent 内容暂时没变”解封。
    // 先做一次交易级只读观察：只有消费交易超过阈值且 confirmed /
    // unconfirmed 都不存在时，才复用原序号恢复 fresh。
    await p2pkhUtxoSnapshots.reconcileConsumed(resource).catch(() => false);
    const result = await p2pkhUtxoSnapshots.refresh(resource, signal ? { signal } : {}).catch(() => undefined);
    if (result?.seq !== undefined) utxoSeqs[resource.network] = result.seq;
  }
  return utxoSeqs;
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

async function handleP2pkhSettingsUpdate(
  requestId: string,
  request: Extract<CoordinatorClientRequest, { kind: "p2pkh.settings.update" }>
): Promise<CoordinatorResponse> {
  if (!isCoordinatorProductEnabled("p2pkh")) return coordinatorProductBlockedResponse(requestId, "p2pkh");
  if (typeof request.settings.includeTestnet !== "boolean") {
    return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "validation-error", message: "Invalid P2PKH network settings" } };
  }
  // 先写 owner 的 setting.json,成功后才更新内存镜像。
  await writeP2pkhSettingFile({ includeTestnet: request.settings.includeTestnet });
  coordinatorMeta.p2pkhSettings = { includeTestnet: request.settings.includeTestnet };
  await cancelP2pkhSyncForProviderChange();
  publishTopicEvent("background.snapshot", {
    type: "background.snapshot.changed",
    snapshots: getTaskSnapshots(),
    // 设置写入成功后随同快照广播，窗口无需再发起 RPC 才能收敛 testnet 开关。
    p2pkhSettings: coordinatorMeta.p2pkhSettings,
  });
  return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "accepted" } };
}

async function handleP2pkhProviderConfigGet(
  requestId: string,
  request: Extract<CoordinatorClientRequest, { kind: "p2pkh.provider-config.get" }>
): Promise<CoordinatorResponse> {
  // 只剩 WoC 一个 Provider；未知 provider id 直接拒绝。
  if (request.providerId !== "woc") {
    return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "validation-error", message: `Unknown P2PKH provider: ${request.providerId}` } };
  }
  if (!isCoordinatorProductEnabled("woc")) return coordinatorProductBlockedResponse(requestId, "woc");
  const persisted = coordinatorMeta.p2pkhProviderConfigs?.woc;
  if (persisted) return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: { ...persisted } };
  if (p2pkhWocService) {
    const config = p2pkhWocService.getConfig();
    return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: { endpoint: config.baseUrl, requestsPerSecond: config.requestsPerSecond } };
  }
  return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: {} };
}

async function handleP2pkhProviderConfigUpdate(
  requestId: string,
  request: Extract<CoordinatorClientRequest, { kind: "p2pkh.provider-config.update" }>
): Promise<CoordinatorResponse> {
  if (request.providerId !== "woc") {
    return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "validation-error", message: `Unknown P2PKH provider: ${request.providerId}` } };
  }
  if (!isCoordinatorProductEnabled("woc")) return coordinatorProductBlockedResponse(requestId, "woc");
  const previousConfigs = coordinatorMeta.p2pkhProviderConfigs;
  const previousConfig = previousConfigs?.woc;
  const nextConfig = { ...(previousConfig ?? {}), ...request.config };
  const nextProviderConfigs = { ...(previousConfigs ?? {}), woc: nextConfig };
  const previousWocConfig = p2pkhWocService?.getConfig?.();
  try {
    // Persist the candidate before changing the running service. A failed
    // write must leave the running session untouched.
    await writeP2pkhSettingFile({ providerConfigs: nextProviderConfigs });
    if (p2pkhWocService) {
      const update: Partial<import("@keymaster/contracts").WocConfig> = {};
      if (typeof request.config.endpoint === "string" && request.config.endpoint.trim()) update.baseUrl = request.config.endpoint.trim();
      if (typeof request.config.requestsPerSecond === "number") update.requestsPerSecond = request.config.requestsPerSecond;
      if (Object.keys(update).length) p2pkhWocService.updateConfig(update);
    }
  } catch (error) {
    if (previousWocConfig) p2pkhWocService?.updateConfig?.(previousWocConfig);
    throw error;
  }
  coordinatorMeta.p2pkhProviderConfigs = nextProviderConfigs;
  await cancelP2pkhSyncForProviderChange();
  return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "accepted" } };
}

/** 读取 owner + network 对应的 P2PKH resource（不存在返回 undefined）。 */
async function p2pkhResourceForOwner(ownerPublicKeyHex: string, network: "main" | "test") {
  const keyspace = createWorkerKeyspace();
  if (keyspace.active().activePublicKeyHex?.toLowerCase() !== ownerPublicKeyHex.toLowerCase()) throw new Error("P2PKH storage owner is not active");
  const repository = createP2pkhStateRepository(await openP2pkhStateRepository(createWorkerOwnerFileStore("p2pkh", "")));
  return repository.getResource(`p2pkh:${network}`);
}

/** 读取内存 UTXO 快照；没有 resource 或没有快照时 available=false。 */
async function handleP2pkhUtxosGet(
  requestId: string,
  request: Extract<CoordinatorClientRequest, { kind: "p2pkh.utxos.get" }>
): Promise<CoordinatorResponse> {
  if (!isCoordinatorProductEnabled("p2pkh")) return coordinatorProductBlockedResponse(requestId, "p2pkh");
  const resource = await p2pkhResourceForOwner(request.ownerPublicKeyHex, request.network);
  if (!resource || !p2pkhUtxoSnapshots) return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: { available: false, state: "unavailable", items: [] } satisfies P2pkhUtxoSnapshotResult };
  return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: p2pkhUtxoSnapshots.get(resource) };
}

/**
 * 刷新内存 UTXO 快照。
 *
 * 刷新失败时旧快照原样保留（绝不清空/置零），RPC 以 error 返回失败，
 * 让调用方（转账 prepare/submit）明确拒绝继续，而不是使用过期快照。
 */
async function handleP2pkhUtxosRefresh(
  requestId: string,
  request: Extract<CoordinatorClientRequest, { kind: "p2pkh.utxos.refresh" }>
): Promise<CoordinatorResponse> {
  if (!isCoordinatorProductEnabled("p2pkh")) return coordinatorProductBlockedResponse(requestId, "p2pkh");
  const resource = await p2pkhResourceForOwner(request.ownerPublicKeyHex, request.network);
  if (!resource || !p2pkhUtxoSnapshots) return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: { available: false, state: "unavailable", items: [] } satisfies P2pkhUtxoSnapshotResult };
  try {
    await p2pkhUtxoSnapshots.reconcileConsumed(resource);
    const result = await p2pkhUtxoSnapshots.refresh(resource);
    // 主动刷新成功后通知页面重读余额/币列表。
    publishTopicEvent("asset.data-changed", {
      type: "asset.data-changed",
      providerId: "p2pkh",
      publicKeyHex: request.ownerPublicKeyHex,
      kinds: ["utxo", "balance"],
      ...(result.seq === undefined ? {} : { utxoSeqs: { [request.network]: result.seq } }),
    });
    return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: result };
  } catch (error) {
    // 旧快照保留；把失败原因返回给调用方。
    const message = error instanceof Error ? error.message : String(error);
    return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "error", message: `P2PKH UTXO snapshot refresh failed: ${message}` } };
  }
}

async function handleP2pkhBroadcast(
  requestId: string,
  request: Extract<CoordinatorClientRequest, { kind: "p2pkh.broadcast" }>
): Promise<CoordinatorResponse> {
  if (!isCoordinatorProductEnabled("p2pkh")) return coordinatorProductBlockedResponse(requestId, "p2pkh");
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
  const provider = testP2pkhBroadcastProvider ?? p2pkhRegistry?.getBroadcastProvider("woc", request.network);
  if (!provider) {
    await abortNotDispatchedP2pkhSubmission(request, "broadcast-provider-unavailable");
    return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: { status: "not-dispatched", reason: "broadcast-provider-unavailable" } };
  }

  const keyspace = createWorkerKeyspace();
  if (keyspace.active().activePublicKeyHex?.toLowerCase() !== request.ownerPublicKeyHex.toLowerCase()) throw new Error("P2PKH storage owner is not active");
  const repository = createP2pkhStateRepository(await openP2pkhStateRepository(createWorkerOwnerFileStore("p2pkh", "")));
  let consumed = false;
  let snapshotResource: P2pkhUtxoSnapshotResource | undefined;
  const consumedBinding = request.submission?.utxoBinding;
  let local = (await repository.listLocalTransactions()).find((row) => row.id === request.submissionId && row.network === request.network);
  if (!local) {
    // 页面 service 与 Worker 是两个 JS realm，页面内存中的本地提交这里读不到。
    // 页面必须在广播请求里带上待广播的 canonical 交易；Worker 先用生产解析器
    // 复核 txid 与原始交易一致，再写自己的审计存储（write-ahead），最后广播。
    if (!request.submission) return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "validation-error", message: "Local P2PKH submission not found" } };
    let parsed;
    try {
      parsed = parseP2pkhTransaction(request.submission.rawTxHex, request.submission.txid);
    } catch {
      return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "validation-error", message: "P2PKH broadcast payload txid does not match the raw transaction" } };
    }
    if (parsed.canonicalTxid !== request.submission.txid) {
      return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "validation-error", message: "P2PKH broadcast payload txid does not match the raw transaction" } };
    }
    const now = new Date().toISOString();
    local = {
      id: request.submissionId,
      resourceId: request.submission.resourceId,
      publicKeyHex: request.ownerPublicKeyHex,
      network: request.network,
      txid: request.submission.txid,
      rawTxHex: request.submission.rawTxHex,
      localState: "submitting",
      chainResolution: "unresolved",
      inputOutpointKeys: parsed.inputs.map((input) => input.outpointKey),
      ownOutputs: [],
      createdAt: now,
      updatedAt: now,
      attempts: [],
    };
    try {
      await repository.prepareLocalSubmission({ submission: local, claims: [] });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "validation-error", message: `P2PKH broadcast payload write-ahead failed: ${message}` } };
    }
  } else if (request.submission && local.txid.toLowerCase() !== request.submission.txid) {
    return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "validation-error", message: "P2PKH broadcast payload does not match the stored submission" } };
  }
  if (local.localState !== "submitting" || local.chainResolution !== "unresolved") {
    return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "validation-error", message: `Submission is not dispatchable in localState=${local.localState}, chainResolution=${local.chainResolution}` } };
  }

  // 中文：无论 Worker 是否已有本地 write-ahead 记录，都必须从本次原始
  // 交易解析输入 outpoint；不能信任页面或旧记录中的 inputOutpointKeys。
  const rawTxHexForValidation = request.submission?.rawTxHex ?? local.rawTxHex;
  const txidForValidation = request.submission?.txid ?? local.txid;
  let parsedInputOutpointKeys: string[];
  try {
    const parsed = parseP2pkhTransaction(rawTxHexForValidation, txidForValidation);
    if (parsed.canonicalTxid !== local.txid.toLowerCase()) throw new Error("txid mismatch");
    parsedInputOutpointKeys = parsed.inputs.map((input) => input.outpointKey);
  } catch {
    return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "validation-error", message: "P2PKH broadcast raw transaction is invalid" } };
  }

  // 唯一的 Worker 门禁：在同一无 await 的同步块内完成绑定核对、输入归属
  // 校验和消费。纯代币输入没有命中钱包快照时保持 untouched，不要求序号。
  snapshotResource = await p2pkhResourceForOwner(request.ownerPublicKeyHex, request.network);
  const consumeResult = snapshotResource && p2pkhUtxoSnapshots
    ? p2pkhUtxoSnapshots.consume(snapshotResource, {
        binding: consumedBinding,
        inputOutpointKeys: parsedInputOutpointKeys,
        txid: local.txid,
      })
    // 没有该 owner/network 资源时无法证明输入属于钱包快照，按纯协议输入
    // 路径继续；正常 P2PKH 资源由 ensureWorkerP2pkhResources 预先材料化。
    : { status: "untouched" as const };
  if (consumeResult.status === "rejected") {
    await abortNotDispatchedP2pkhSubmission(request, consumeResult.reason);
    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "ok" },
      operationResult: {
        status: "not-dispatched",
        reason: consumeResult.reason,
        ...(consumeResult.currentSeq === undefined ? {} : { currentSeq: consumeResult.currentSeq }),
      },
    };
  }
  consumed = consumeResult.status === "consumed";

  const startedAt = new Date().toISOString();
  try {
    const result = await provider.broadcast({ network: request.network, canonicalTxid: local.txid, rawTxHex: local.rawTxHex });
    if (result.canonicalTxid !== local.txid) {
      // 中文：Provider 已返回，但 txid 与本地原始交易不一致。它不是“未派发”，
      // 不能回滚消费；同时把回执完整透传，让协议层进入 provider-inconsistent。
      const message = "Broadcast provider returned a different transaction id";
      const finishedAt = new Date().toISOString();
      await repository.finishLocalSubmission({
        submissionId: local.id,
        localState: "isolated",
        reason: message,
        attempt: { id: `${local.id}:${startedAt}`, submissionId: local.id, providerId: provider.descriptor.id, startedAt, finishedAt, status: "isolated", providerMessage: message },
      });
      publishTopicEvent("asset.data-changed", { type: "asset.data-changed", providerId: "p2pkh", publicKeyHex: request.ownerPublicKeyHex, kinds: ["submission", "balance"] });
      return {
        requestId,
        sessionEpoch: coordinatorState.sessionEpoch,
        ack: { status: "ok" },
        operationResult: {
          status: "isolated",
          txid: local.txid,
          reason: message,
          canonicalTxid: local.txid,
          providerReturnedTxidRaw: result.canonicalTxid,
          providerReturnedTxidNormalized: result.canonicalTxid.toLowerCase(),
          txidIntegrity: "mismatch",
          providerId: provider.descriptor.id,
        },
      };
    }
    const finishedAt = new Date().toISOString();
    await repository.finishLocalSubmission({ submissionId: local.id, localState: "local-confirmed", attempt: { id: `${local.id}:${startedAt}`, submissionId: local.id, providerId: provider.descriptor.id, startedAt, finishedAt, status: result.status, providerReference: result.providerReference, providerCode: result.providerCode, providerMessage: result.providerMessage } });
    // 广播后立即触发一次后台刷新；普通 P2PKH 不维护本地输入占用，
    // 下一组可花 UTXO 由 WoC 快照内容变化和新 seq 决定。
    void refreshP2pkhUtxoSnapshots().then((utxoSeqs) => {
      publishTopicEvent("asset.data-changed", { type: "asset.data-changed", providerId: "p2pkh", publicKeyHex: request.ownerPublicKeyHex, kinds: ["utxo", "submission", "balance"], ...(Object.keys(utxoSeqs).length === 0 ? {} : { utxoSeqs }) });
    }).catch(() => {
      publishTopicEvent("asset.data-changed", { type: "asset.data-changed", providerId: "p2pkh", publicKeyHex: request.ownerPublicKeyHex, kinds: ["submission", "balance"] });
    });
    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "ok" },
      operationResult: {
        status: result.status === "already-known" ? "already-known" : "local-confirmed",
        txid: local.txid,
        canonicalTxid: result.canonicalTxid,
        providerReturnedTxidRaw: result.providerReturnedTxidRaw ?? result.canonicalTxid,
        providerReturnedTxidNormalized: result.providerReturnedTxidNormalized ?? result.canonicalTxid.toLowerCase(),
        txidIntegrity: result.txidIntegrity ?? "exact",
        providerId: provider.descriptor.id,
        ...(result.providerReference === undefined ? {} : { providerReference: result.providerReference }),
        ...(result.providerCode === undefined ? {} : { providerCode: result.providerCode }),
        ...(result.providerMessage === undefined ? {} : { providerMessage: result.providerMessage }),
      }
    };
  } catch (error) {
    // reason 必须是非空、有上界的字符串：它要跨 RPC parser 和 UI，空 message
    // 的 Error 会让响应校验失败，把“已隔离”伪装成框架层 handler 异常。
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = (rawMessage.trim() || (error instanceof Error ? error.name || "broadcast-isolated" : "broadcast-isolated")).slice(0, 2_048);
    const finishedAt = new Date().toISOString();
    const attempt = { id: `${local.id}:${startedAt}`, submissionId: local.id, providerId: provider.descriptor.id, startedAt, finishedAt, status: "isolated" as const, providerMessage: message };
    // 只有结构化标记（code=definitive-not-dispatched）或节点明确拒绝交易本体
    // 的错误才允许回滚消费；HTTP 4xx / 超时 / 网络错误可能是"已存在"，保持 isolated。
    if (isDefinitelyNotDispatchedBroadcastError(error)) {
      if (consumed && snapshotResource && consumedBinding) p2pkhUtxoSnapshots?.rollbackConsume(snapshotResource, consumedBinding);
      await abortNotDispatchedP2pkhSubmission(request, message);
      return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: { status: "not-dispatched", reason: "coordinator-not-dispatched" } };
    }
    await repository.finishLocalSubmission({ submissionId: local.id, localState: "isolated", reason: message, attempt });
    publishTopicEvent("asset.data-changed", { type: "asset.data-changed", providerId: "p2pkh", publicKeyHex: request.ownerPublicKeyHex, kinds: ["submission", "balance"] });
    return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: { status: "isolated", txid: local.txid, reason: message, providerId: provider.descriptor.id } };
  }
}

// ============================================================
// 11. Task Execution
// ============================================================

async function executeTask(taskId: string, reason: string): Promise<void> {
  const runtime = coordinatorState.taskRuntimes.get(taskId);
  if (!runtime) {
    throw new Error(`Task not found: ${taskId}`);
  }
  const intentBlockedReason = coordinatorTaskBlockedReason(runtime);
  if (intentBlockedReason) {
    if (runtime.timer) clearTimeout(runtime.timer);
    runtime.timer = undefined;
    runtime.nextRunAt = undefined;
    runtime.state = "blocked";
    runtime.blockedReason = intentBlockedReason;
    runtime.error = undefined;
    publishTopicEvent("background.snapshot", {
      type: "background.snapshot.changed",
      sessionEpoch: coordinatorState.sessionEpoch,
      snapshots: getTaskSnapshots(),
    });
    return;
  }
  // 「同步管理」关闭（间隔 0）表示不自动同步：定时器 / 领域事件 / 解锁
  // 首次同步都不再拉起任务；托盘的手动「立即同步一次」仍然有效。
  if (runtime.syncPolicy === "managed" && (runtime.intervalMs ?? 0) <= 0 && reason !== BACKGROUND_TRIGGER_REASON.MANUAL) {
    return;
  }
  if (coordinatorState.vaultStatus !== "unlocked" || !coordinatorState.activePublicKeyHex) {
    runtime.state = "blocked";
    runtime.blockedReason = "Vault is locked";
    scheduleRuntime(runtime);
    return;
  }

  // 旧 completion 未结束时，re-enable 只能等待它在 finally 中恢复调度；
  // 不能由手动/定时入口再开第二个同任务实例。
  if (runtime.completion) return;
  const taskUnit = getCoordinatorWorkerUnitForTask(taskId);
  if (taskUnit) {
    const workerUnit = activateCoordinatorOwnerWorkerUnit(taskUnit.unitId);
    const readyUnit = coordinatorWorkerUnitRegistry.ready(workerUnit.unitId, workerUnit.instanceId);
    runtime.instanceId = readyUnit.instanceId;
  }

  const controller = new AbortController();
  runtime.controller = controller;
  runtime.startedEpoch = coordinatorState.sessionEpoch;
  runtime.startedGeneration = coordinatorState.keyspaceGeneration;
  runtime.startedPublicKeyHex = coordinatorState.activePublicKeyHex;
  runtime.blockedReason = undefined;
  runtime.error = undefined;
  runtime.state = "running";
  runtime.lastStartedAt = new Date().toISOString();
  runtime.lastAttemptAt = runtime.lastStartedAt;

  publishTopicEvent("background.snapshot", {
    type: "background.snapshot.changed",
    sessionEpoch: coordinatorState.sessionEpoch,
    snapshots: getTaskSnapshots(),
  });

  let execution!: Promise<void>;
  execution = (async () => {
   try {
    if (runtime.startedEpoch !== coordinatorState.sessionEpoch || runtime.startedGeneration !== coordinatorState.keyspaceGeneration || runtime.startedPublicKeyHex !== coordinatorState.activePublicKeyHex) throw new Error("stale task epoch");
    if (!runtime.run) throw new Error(`Task ${taskId} has no Coordinator handler`);
    const run = (signal: AbortSignal) => runtime.run!({
      signal,
      reason,
      reportProgress: () => undefined,
      assertSessionFresh: () => assertTaskFresh(taskId),
    });
    const auditOperation = COORDINATOR_TASK_FINAL_IO_AUDIT[taskId];
    if (auditOperation) {
      // 任务里的 Provider 网络读取与 checkpoint / projection 写入是一个
      // 真实业务实例；必须一起占用最终 lease，不能只保护 RPC 外壳。
      await withCoordinatorFinalIoLease("write", controller.signal, run, { auditOperation });
    } else {
      // 仅测试任务或无外部 I/O 的内核任务走普通取消路径；生产任务都
      // 必须在上面的显式审计表中登记，否则发布审计脚本会拒绝通过。
      await run(controller.signal);
    }
    if (runtime.startedEpoch !== coordinatorState.sessionEpoch || runtime.startedGeneration !== coordinatorState.keyspaceGeneration || runtime.startedPublicKeyHex !== coordinatorState.activePublicKeyHex) throw new Error("stale task result");
    runtime.state = "idle";
    runtime.lastCompletedAt = new Date().toISOString();
    runtime.error = undefined;
   } catch (err) {
    const currentIntentBlockedReason = coordinatorTaskBlockedReason(runtime);
    if (currentIntentBlockedReason) {
      runtime.state = "blocked";
      runtime.blockedReason = currentIntentBlockedReason;
      runtime.error = undefined;
    } else if (controller.signal.aborted && isPluginIntentBlockedReason(runtime.blockedReason)) {
      // disable 后又在旧 completion 结束前 enable：保持“等旧实例退出”
      // 的中间状态，finally 会在同一 completion 上恢复新的定时器。
      runtime.state = "blocked";
      runtime.error = undefined;
    } else if (controller.signal.aborted) {
      runtime.state = "idle";
      runtime.error = "Cancelled";
    } else if (taskId === "p2pkh.transactions-sync" && typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "provider-unavailable") {
      runtime.state = "blocked";
      runtime.blockedReason = err instanceof Error ? err.message : "Confirmed provider unavailable";
      runtime.error = runtime.blockedReason;
    } else {
      runtime.state = "idle";
      runtime.error = err instanceof Error ? err.message : String(err);
    }
   } finally {
    // 同一 Task 在旧 owner completion 尚未结束时可能已经被新 owner
    // 重新启动；旧 completion 不能覆盖新 execution 的 controller/state。
    if (runtime.completion !== execution) return;
    runtime.controller = undefined;

    const finalIntentBlockedReason = coordinatorTaskBlockedReason(runtime);
    // 若产品意图已关闭，保留 disabled blocked，不得被旧 completion 重写为 idle。
    if (finalIntentBlockedReason) {
      runtime.state = "blocked";
      runtime.blockedReason = finalIntentBlockedReason;
      runtime.error = undefined;
    // 若当前 Vault 已锁定或 epoch 已变化，保留 blocked，不得把任务重写为 idle
    } else if (coordinatorState.vaultStatus !== "unlocked" ||
        runtime.startedEpoch !== coordinatorState.sessionEpoch ||
        runtime.startedGeneration !== coordinatorState.keyspaceGeneration ||
        runtime.startedPublicKeyHex !== coordinatorState.activePublicKeyHex) {
      runtime.state = "blocked";
      runtime.blockedReason = "Vault is locked";
    } else if (isPluginIntentBlockedReason(runtime.blockedReason)) {
      // 旧任务在 disable -> enable 窗口内退出；此时才允许重新排程。
      runtime.state = "idle";
      runtime.blockedReason = undefined;
      runtime.error = undefined;
      scheduleRuntime(runtime);
    } else if (!controller.signal.aborted && runtime.state !== "blocked") {
      // 仅当任务所属 session 仍有效且未 abort 时才恢复 idle/排程
      scheduleRuntime(runtime);
    }

    // 智能调度：smart 任务完成后，若 WoC 队列已空闲，从「任务完成」
    // 这一刻重新计时 2 秒；任务运行期间的队列事件已把计时取消。
    // 门禁：锁定 / 无 active key / 任务所属 session 已失效时不得重新计时，
    // 否则锁定时被 abort 的任务会在 finally 里把计时器重新挂起来。
    if (runtime.syncPolicy === "smart"
      && runtime.state !== "blocked"
      && coordinatorState.vaultStatus === "unlocked"
      && coordinatorState.activePublicKeyHex
      && runtime.startedEpoch === coordinatorState.sessionEpoch
      && runtime.startedGeneration === coordinatorState.keyspaceGeneration
      && runtime.startedPublicKeyHex === coordinatorState.activePublicKeyHex) {
      armSmartSyncIfIdle();
    }

    publishTopicEvent("background.snapshot", {
      type: "background.snapshot.changed",
      sessionEpoch: coordinatorState.sessionEpoch,
      snapshots: getTaskSnapshots(),
    });
   }
  })();
  runtime.completion = execution;
  await execution;
  runtime.completion = undefined;
}

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
    buildId: COORDINATOR_BUILD_ID,
    sessionEpoch: coordinatorState.sessionEpoch,
    vaultStatus: coordinatorState.vaultStatus,
    activePublicKeyHex: coordinatorState.activePublicKeyHex,
    selectedPublicKeyHex: coordinatorMeta.selectedPublicKeyHex,
    keyspaceGeneration: coordinatorState.keyspaceGeneration,
    ...(coordinatorAuthorityRecovery ? { authorityRecovery: coordinatorAuthorityRecovery } : {}),
    coordinatorWorkerUnits: coordinatorRuntimeUnitSnapshots(),
    coordinatorWorkerUnitSnapshotRevision: coordinatorRuntimeUnitRevision(),
    taskSnapshots: getTaskSnapshots(),
    scheduleSettings: coordinatorState.scheduleSettings,
    autoLockTimeoutMs: coordinatorMeta.autoLockTimeoutMs ?? AUTO_LOCK_DEFAULT_TIMEOUT_MS,
    p2pkhSettings: coordinatorMeta.p2pkhSettings,
    storageBucketGeneration: platformRootStore?.bucket.bucketGeneration,
    ...(platformRootStore ? { storageBucketId: platformRootStore.bucket.bucketId } : {}),
    ...(storageIoOwnerPeer ? { storageIoOwnerPeer } : {}),
    // Worker 重启后 controller 可能尚未惰性创建，但持久化快照已经是
    // 当前产品意图真值；首个页面不能拿 revision=0 覆盖它。
    pluginIntent: pluginIntentController?.snapshot() ?? coordinatorMeta.pluginIntent,
  };
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
      keyScope: resolveKeyScope(runtime),
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
    ...(topic === "session.state" ? { sessionRevision: ++sessionRevision } : topic === "background.snapshot" ? { backgroundSnapshotRevision: ++backgroundSnapshotRevision } : topic === "storage.state" ? { storageRevision: event.storageRevision } : topic === "msfile.state" ? { msfileRevision: event.msfileRevision } : topic === "sat.events" ? { satRevision: event.satRevision } : topic === "channel.events" ? { channelRevision: ++channelRevision } : topic === "contacts.presence" ? { presenceRevision: ++contactsPresenceRevision } : topic === "plugin.intent" ? { pluginIntentRevision: event.pluginIntentRevision ?? event.snapshot?.revision ?? 0 } : topic === "worker.units" ? { workerUnitRevision: event.workerUnitRevision ?? coordinatorRuntimeUnitRevision() } : { assetDataRevision: ++assetDataRevision }),
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

function resetAutoLockTimer(): void {
  if (autoLockTimer) clearTimeout(autoLockTimer);
  if (sellerKeepsVaultUnlocked()) {
    autoLockTimer = undefined;
    coordinatorState.autoLockDeadline = undefined;
    return;
  }
  const timeoutMs = normalizeAutoLockTimeoutMs(
    coordinatorMeta.autoLockTimeoutMs ?? coordinatorState.autoLockTimeoutMs
  );
  coordinatorState.autoLockTimeoutMs = timeoutMs;
  coordinatorMeta.autoLockTimeoutMs = timeoutMs;
  // 永不锁定：不清 deadline，直接不设 timer。
  if (timeoutMs === AUTO_LOCK_NEVER_TIMEOUT_MS) {
    autoLockTimer = undefined;
    coordinatorState.autoLockDeadline = undefined;
    return;
  }
  coordinatorState.autoLockDeadline = Date.now() + timeoutMs;

  autoLockTimer = setTimeout(() => {
    autoLockTimer = undefined;
    if (
      coordinatorState.autoLockDeadline &&
      Date.now() >= coordinatorState.autoLockDeadline &&
      coordinatorState.vaultStatus === "unlocked"
    ) {
      void performGlobalLock("auto-lock-timeout");
    }
  }, timeoutMs);
}

// ============================================================
// 13. Worker Entry Point
// ============================================================

async function handleCoordinatorOwnerStorageRpc(
  request: CoordinatorOwnerStorageData,
  call: HandlerCallContext,
): Promise<CoordinatorOwnerStorageResult> {
  const state = requireCoordinatorSessionPeer(call);
  if (call.signal.aborted) throw storageUnavailableError("Owner storage request was cancelled");
  const value = await executeOwnerStorageData(request, state.peer.peerId, call.signal);
  if (call.signal.aborted) throw storageUnavailableError("Owner storage request was cancelled");
  return value as CoordinatorOwnerStorageResult;
}

async function handleCoordinatorPlatformStorageRpc(
  request: CoordinatorPlatformStorageData,
  call: HandlerCallContext,
): Promise<CoordinatorPlatformStorageResult> {
  const state = requireCoordinatorSessionPeer(call);
  if (call.signal.aborted) throw storageUnavailableError("Platform storage request was cancelled");
  const value = await executePlatformStorageData(request, state.peer.peerId, call.signal);
  if (call.signal.aborted) throw storageUnavailableError("Platform storage request was cancelled");
  return value as CoordinatorPlatformStorageResult;
}

async function handleCoordinatorCryptoRpc(
  request: CoordinatorCryptoOperation,
  call: HandlerCallContext,
): Promise<CoordinatorCryptoResult> {
  requireCoordinatorSessionPeer(call);
  if (call.signal.aborted) throw new Error("Coordinator crypto request was cancelled");
  if (coordinatorState.vaultStatus !== "unlocked" || !coordinatorState.activePrivateKeyBytes) {
    throw Object.assign(new Error("Coordinator crypto is unavailable"), { code: "service_unavailable" });
  }
  const capturedEpoch = coordinatorState.sessionEpoch;
  const result = await withCoordinatorFinalIoLease(
    "write",
    call.signal,
    () => executeCryptoOperation(request, coordinatorState.activePrivateKeyBytes!),
    {
      auditOperation: "service.crypto.sign",
      // 纯本地签名没有外部 I/O 或持久化副作用；返回前仍受 authority lock、
      // UpgradeGate、AbortSignal 和 session epoch 的多重后置栅栏保护。
      // 纯本地签名不需要额外的内存 I/O 计数；authority lock 负责 Worker
      // 唯一性。
      durableLease: false,
    },
  );
  // The final visibility check is deliberately after the crypto promise and
  // lease boundary: a lock/key switch must turn an old result into a failure.
  if (call.signal.aborted || capturedEpoch !== coordinatorState.sessionEpoch || coordinatorState.vaultStatus !== "unlocked") {
    throw Object.assign(new Error("Coordinator crypto session became stale"), { code: "service_reference_stale" });
  }
  return result;
}

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
  COORDINATOR_OWNER_STORAGE_RPC_CAPABILITY,
  COORDINATOR_PLATFORM_STORAGE_RPC_CAPABILITY,
  COORDINATOR_CRYPTO_RPC_CAPABILITY,
] as const;

/** 当前 owner/session 世代中可向 Window 暴露的 Coordinator 服务。 */
function coordinatorSessionServicesReady(): boolean {
  return coordinatorState.vaultStatus === "unlocked"
    && Boolean(coordinatorState.activePublicKeyHex && coordinatorState.activePrivateKeyBytes)
    && Boolean(platformRootStore && platformRootToken)
    && platformStorageReady
    && !storageStartupFailure
    && storageHealthController.status() === "ready";
}

function coordinatorSessionExposureIdentity(): string {
  const bucket = platformRootStore?.bucket;
  return [
    coordinatorAuthorityInstanceId,
    coordinatorHandoverGeneration,
    coordinatorState.sessionEpoch,
    coordinatorState.keyspaceGeneration,
    bucket?.bucketId ?? "null",
    bucket?.bucketGeneration ?? "null",
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
 * session epoch 或 keyspace generation。
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
      options: { grantId: coordinatorSessionGrantId(state, capability.id) },
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
    const previousBootstrapState = storageBootstrapState;
    const hadInitialization = coordinatorInitialization !== undefined;
    let bootstrapHintAssigned = false;
    coordinatorOpeningSession = attempt;
    try {
      // The two awaits below are deliberately followed by the same freshness
      // check. Their results are temporary until the final synchronous
      // exposure commit succeeds.
      assertCoordinatorSessionOpenFresh(attempt);
      if (!platformRootStore && !storageBootstrapState?.selectedBucket && request.storageBootstrapState?.selectedBucket) {
        storageBootstrapState = request.storageBootstrapState;
        bootstrapHintAssigned = true;
      }
      await startCoordinatorInitialization(request.storageBootstrapState, attempt.peerId);
      assertCoordinatorSessionOpenFresh(attempt);

      // No await is allowed between this check and exposeGroup. The group
      // publish is itself transactional; sessionOpen and physical I/O owner
      // become visible only after it has committed successfully.
      const serviceExposure = coordinatorSessionServicesReady()
        ? state.peer.exposeGroup(COORDINATOR_SESSION_EXPOSURES.map((capability) => ({
            capability,
            options: { grantId: coordinatorSessionGrantId(state, capability.id) },
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
      // open has not changed sessionOpen or storageIoOwner; the only local
      // temporary assignment we may undo is the uncommitted bootstrap hint.
      if (!state.sessionOpen && coordinatorOpeningSession === attempt && !hadInitialization && bootstrapHintAssigned) {
        storageBootstrapState = previousBootstrapState;
      }
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
    COORDINATOR_OWNER_STORAGE_RPC_CAPABILITY,
    COORDINATOR_PLATFORM_STORAGE_RPC_CAPABILITY,
    COORDINATOR_CRYPTO_RPC_CAPABILITY,
  ] as const,
  dependencies: [{
    capability: COORDINATOR_LOCAL_STORAGE_RPC_CAPABILITY,
    source: "peer",
    reason: "Coordinator LocalStorage I/O is implemented by the bound Window peer",
  }] as const,
  startup: "required",
  defaultEnabled: true,
  canDisable: false,
  setup(context) {
    context.handle(COORDINATOR_RPC_CAPABILITY, (request, call) => handleCoordinatorRpc(request, call));
    context.handle(COORDINATOR_TOPIC_STREAM_CAPABILITY, (request, call) => coordinatorTopicStream(request, call));
    context.handle(COORDINATOR_OWNER_STORAGE_RPC_CAPABILITY, (request, call) => handleCoordinatorOwnerStorageRpc(request, call));
    context.handle(COORDINATOR_PLATFORM_STORAGE_RPC_CAPABILITY, (request, call) => handleCoordinatorPlatformStorageRpc(request, call));
    context.handle(COORDINATOR_CRYPTO_RPC_CAPABILITY, (request, call) => handleCoordinatorCryptoRpc(request, call));
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
  return definePlugin({
    id: `keymaster.coordinator.${unit.productId}`,
    name: `Keymaster ${unit.productId} Coordinator`,
    unitId: unit.unitId,
    runtime: "shared-worker",
    startup: unit.unitId === "vault.coordinator-worker" ? "required" : "optional",
    defaultEnabled: true,
    canDisable: unit.unitId !== "vault.coordinator-worker",
    async setup(context) {
      let ready: ReturnType<typeof coordinatorWorkerUnitRegistry.ready>;
      if (unit.unitId === "msfile.coordinator-worker") {
        await ensureMsfileRuntime(context.instanceId);
        ready = coordinatorWorkerUnitRegistry.ready(unit.unitId, context.instanceId);
      } else if (unit.unitId === "sat-subscription.coordinator-worker") {
        await ensureSatRuntime(context.instanceId);
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
      return () => stopCoordinatorWorkerUnit(ready.unitId, ready.instanceId);
    },
  });
});

// Unit tests import this module in a normal Node realm. The installer above is
// a no-op when native WebCrypto exists and never enables a fallback unless the
// realm explicitly reports an insecure context.
if ((globalThis as unknown as { onconnect?: unknown }).onconnect !== undefined) {
// WebLoom 0.5.0 在这里创建 SharedWorker Host；它不负责跨 Worker 运行时
// 互斥。Keymaster 在初始化和最终 I/O 前使用自己的 origin 级 authority
// Web Lock；peer/session/lease/epoch/generation 继续负责页面会话与迟到结果。
coordinatorRuntimeApp = startSharedWorkerApp({
  id: "keymaster-coordinator",
  plugins: [coordinatorTransportPlugin, ...coordinatorRuntimePlugins],
  expose: [
    COORDINATOR_RPC_CAPABILITY,
    COORDINATOR_TOPIC_STREAM_CAPABILITY,
  ],
  peerExposureAllowlist: [
    COORDINATOR_OWNER_STORAGE_RPC_CAPABILITY,
    COORDINATOR_PLATFORM_STORAGE_RPC_CAPABILITY,
    COORDINATOR_CRYPTO_RPC_CAPABILITY,
  ],
  configurePeer: configureCoordinatorPeer,
  runtimeUnitAvailability: ({ unitId }: { unitId: string }) => {
    // The transport plugin is the Coordinator Host's required foundation; it
    // is intentionally not part of the domain worker-unit catalog because it
    // owns the RPC/topic entrypoints rather than a product task/service.
    if (unitId === "keymaster.coordinator.transport") return undefined;
    const unit = COORDINATOR_WORKER_UNIT_CATALOG.find((candidate) => candidate.unitId === unitId);
    if (!unit) return "coordinator-unit-unknown";
    if (!isCoordinatorProductEnabled(unit.productId)) return `plugin-disabled:${unit.productId}`;
    if (unit.scopeKind === "storage" && !platformStorageReady) return "storage-root-unavailable";
    if (unit.scopeKind === "owner-session"
      && (coordinatorState.vaultStatus !== "unlocked" || !coordinatorState.activePublicKeyHex)) {
      return "owner-session-unavailable";
    }
    for (const dependency of unit.requiredProductIds ?? []) {
      if (!isCoordinatorProductEnabled(dependency)) return `plugin-dependency-disabled:${dependency}`;
    }
    return undefined;
  },
  runtimeUnitAttributes: ({ unitId }: { unitId: string }) => {
    const unit = COORDINATOR_WORKER_UNIT_CATALOG.find((candidate) => candidate.unitId === unitId);
    return {
      ...(unit ? { productId: unit.productId, scopeKind: unit.scopeKind } : {}),
      ...(unit?.scopeKind === "owner-session" && coordinatorState.activePublicKeyHex
        ? { ownerPublicKeyHex: coordinatorState.activePublicKeyHex, sessionEpoch: coordinatorState.sessionEpoch }
        : {}),
      ...(platformRootStore ? { bucketGeneration: platformRootStore.bucket.bucketGeneration } : {}),
    };
  },
});
installSharedWorkerRetirement(
  coordinatorRuntimeApp,
  globalThis as unknown as Parameters<typeof installSharedWorkerRetirement>[1],
);
}

// Worker 启动时从 K-V 读取仅公开的 Vault metadata
// 状态为 uninitialized 或 locked；绝不读取/解密私钥直到 unlock RPC
async function initializeCoordinator(skipStorageBootstrap = false, propagateFailure = false, peerId?: string): Promise<void> {
  coordinatorInitializationInProgress = true;
  try {
    await initializeCoordinatorInternal(skipStorageBootstrap, propagateFailure, peerId);
  } finally {
    coordinatorInitializationInProgress = false;
  }
}

async function initializeCoordinatorInternal(skipStorageBootstrap = false, propagateFailure = false, peerId?: string): Promise<void> {
  // 必须先取得 Keymaster 自己的跨 Worker authority，再触碰任何 Provider
  // 或恢复对象；否则不同 Worker URL 可能同时初始化同一个物理桶。
  try {
    await ensureCoordinatorAuthorityClaim();
  } catch (error) {
    coordinatorState.vaultStatus = "fatal";
    publishSessionState("bootstrap");
    const code = error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
    // authority 冲突/能力缺失不是 Storage onboarding 的可恢复状态；
    // 必须让 session.open 失败，不能只返回一个没有 capability 的 fatal
    // snapshot，让新页面看起来已经连上了一个不可用 Worker。
    if (propagateFailure || code === "upgrade.authority_conflict" || code === "upgrade.authority_unavailable") throw error;
    return;
  }
  if (skipStorageBootstrap && !platformRootStore) {
    throw storageUnavailableError("Storage root is unavailable during recovery");
  }
  if (!skipStorageBootstrap) {
    try {
      // Storage 是独立健康域；失败时保持 Vault booting，等待页面重试，
      // 不能把可恢复的 Provider/CORS/认证问题升级成 Vault fatal。
      await bootstrapPlatformStorage(undefined, peerId);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
      const healthStatus = storageHealthController.status();
      // 未选择后端、以及已选择 S3 但还没有输入 Profile 密码，都是可恢复的
      // onboarding 状态；不能把它们伪装成 degraded，否则 UI 会丢失原始入口。
      const preservesOnboardingState = healthStatus === "unselected" || healthStatus === "authentication";
      storageStartupFailure = !preservesOnboardingState;
      if (code === "storage_identity_required" && healthStatus !== "unselected") {
        storageHealthController.setStatus("authentication", error instanceof Error ? error.message : String(error));
      } else if (!preservesOnboardingState) {
        storageHealthController.setStatus("degraded", error instanceof Error ? error.message : String(error));
      }
      emitStorageState();
      publishSessionState("bootstrap");
      return;
    }
  }
  try {
    // Storage ready 后，Vault/Keyspace 才允许读取 keys/。
    await withCoordinatorFinalIoLease(
      "write",
      undefined,
      async () => {
        await loadCoordinatorMeta();
        // Key lifecycle Journal 优先恢复；这一步不依赖 Vault 解锁，因为
        // Journal 和 Hold 成员关系都只需要公开恢复信息。
        const hasKeys = (await listPublicVaultKeys()).length > 0;
        if (hasKeys) {
          coordinatorState.vaultStatus = "locked";
          coordinatorState.activePublicKeyHex = undefined;
          coordinatorState.keyspaceGeneration = Math.max(1, coordinatorState.keyspaceGeneration);
          // 只校正持久化的公开选择，不解析或解密私钥文档。
          if (!await reconcileSelectedPublicKey()) coordinatorState.vaultStatus = "uninitialized";
        } else {
          coordinatorState.vaultStatus = "uninitialized";
        }
      },
      { allowLocalLock: true, auditOperation: "coordinator.bootstrap.recover" },
    );
    await ensureStorageRuntime(peerId);
    await ensureCoordinatorTasksRegistered();
    // 启动时如果 vault 是 locked 状态，将所有任务标记为 blocked
    if (coordinatorState.vaultStatus === "locked") {
      for (const runtime of coordinatorState.taskRuntimes.values()) {
        runtime.state = "blocked";
        runtime.blockedReason = "Vault is locked";
      }
    }
    // bootstrapPlatformStorage 只完成 Provider/Root 装配；metadata、Journal
    // 和任务注册也成功后，才把 Storage 健康状态发布为 ready。
    storageStartupFailure = false;
    storageHealthController.setStatus("ready");
    emitStorageState();
  } catch (error) {
    // Root 已建立后发生的 Provider/CORS/network/K-V 错误仍属于 Storage
    // 健康域；Vault 保持 booting，等待 Storage 恢复编排，不得伪装成 fatal。
    if (isStorageFailure(error)) {
      storageStartupFailure = true;
      if (storageHealthController.status() !== "unselected" && storageHealthController.status() !== "authentication") {
        storageHealthController.setStatus("degraded", "Storage initialization failed");
      }
      emitStorageState();
      coordinatorState.vaultStatus = "booting";
      if (propagateFailure) throw error;
    } else {
      coordinatorState.vaultStatus = "fatal";
      if (propagateFailure) throw error;
    }
  } finally {
    // hello 只在存储启动完成后处理。无论初始化成功或失败，
    // 都必须广播最终状态，否则首个页面会永久停留在 booting。
    publishSessionState("bootstrap");
  }
}

let coordinatorInitialization: Promise<void> | undefined;
function startCoordinatorInitialization(state?: StorageBootstrapState, peerId?: string): Promise<void> {
  if (!coordinatorInitialization) {
    // Worker 没有 localStorage；首个 session.open 提供启动选择和反向
    // LocalStorage peer。这个 Promise 是 Worker 级 single-flight：首个
    // 到达者的 state/peer 被闭包固定，后续 session 只等待同一初始化，
    // 不能替换 peer 或重启初始化。peer 失效时 bridge freshness fence
    // fail-closed；后续显式 storage/recovery 请求再绑定新的 active peer。
    // 缺失选择时保持 unselected，任何 keys/ 与 Vault 初始化都不得发生。
    storageBootstrapState = state ?? null;
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
  return signChannelPrivateMessage({
    recipientPublicKeyHex: input.recipientPublicKeyHex,
    protocol,
    body: privateBodyForPublish(protocol, input.content),
    messageId: input.messageId ?? newMessageID(),
    nowMs: input.nowMs,
    privateKey: parsePrivateKey(cryptoHexToBytes(input.privateKeyHex))
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
    indexActive: msfileSellerIndex !== undefined,
    runtimeActive: msfileSellerRuntime !== undefined,
  };
}

/** 测试专用：替换卖方协议端口与 stream transport；传 undefined 恢复生产实现。 */
export function __testSetMsfileSellerBridge(
  bridge: { transport: BitfsSellerStreamTransport; protocol: BitfsSellerProtocolPort } | undefined,
): void {
  testMsfileSellerBridge = bridge;
}

/** 测试专用：直接投递一条已验证 Hash 请求，验证 Worker 的卖方匹配接线。 */
export async function __testDispatchMsfileSellerHashRequest(
  request: import("bsv8-channel-protocol/hash-request").VerifiedHashRequest,
): Promise<void> {
  await handleMsfileSellerHashRequest(request);
}

/** 测试专用：观察当前唯一卖方会话数。 */
export function __testMsfileSellerSessionCount(): number {
  return msfileSellerSessionManager?.activeCount() ?? 0;
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
    store: createWorkerOwnerFileStore("msfile", ""),
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
  await createWorkerOwnerFileStore("msfile", "").put(path, bytes);
}

/** 测试专用：删除当前 owner `msfiles/` 根下的相对路径。 */
export async function __testMsfileOwnerStorageDelete(path: string): Promise<void> {
  await createWorkerOwnerFileStore("msfile", "").delete(path);
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
  ensureTestPlatformStorage();
  stopCoordinatorKeyValueMaintenance();
  coordinatorKeyValueMaintenanceStores.clear();
  // Drop domain-owned resources before resetting the compatibility table. The
  // real WebLoom Host must then observe the booting/locked state and tear down
  // its old owner scopes before the next test unlocks a new owner.
  releaseMsfileRuntime("test-reset");
  testMsfileRuntimeOverride = undefined;
  testMsfileRuntimeRecoveryAllowed = true;
  coordinatorWorkerUnitRegistry.reset();
  if (storageController) {
    const storageUnit = coordinatorWorkerUnitRegistry.activate("storage.coordinator-worker");
    coordinatorWorkerUnitRegistry.ready(storageUnit.unitId, storageUnit.instanceId);
  }
  // 测试夹具模拟 Worker 重启：旧意图控制器和 authority 不能继续冒充新实例。
  closeCoordinatorUpgradeSession("Coordinator test Worker reset");
  pluginIntentControllerOff?.();
  pluginIntentControllerOff = undefined;
  pluginIntentController = undefined;
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
  // 测试夹具复用同一个内存 Root；每个用例从 ready 的 Storage 健康基线开始，
  // 避免上一个用例注入的 degraded/authentication 状态污染后续业务断言。
  storageHealthController.resetForTesting("ready");
  storageStartupFailure = false;
  catalogBindingDiscardDeferred = false;
  initialSetupRuntimeOwner = undefined;
  initialSetupTransactions.clear();
  initialSetupRecoveryRecords.clear();
  // releaseSatRuntime 会同步摘除旧 owner 的全局句柄，并把真实退订放入
  // satRuntimeRelease；下一次测试创建 runtime 时会等待该 Promise。
  void releaseSatRuntime("test");
  testPersistCoordinatorSnapshotFailure = false;
  testFailNextP2pkhSettingWrite = false;
  testFailColdStartInstall = false;
    testFailAfterBucketPasswordCatalogUpdate = false;
    testFailAfterBucketConfigCatalogUpdate = false;
    testFailNextVaultAuthMetadataRollback = false;
    testFailNextVaultAuthMetadataRestore = false;
    testFailNextBucketPasswordDeviceRollback = false;
  testFailAfterCatalogBindingPublish = false;
  testFailNextOwnerStorageDeletion = false;
  testFailAfterOwnerStorageActivation = false;
  testFailNextHoldRollbackCas = false;
  testCatalogHoldPublishBarrier?.release();
  testCatalogHoldPublishBarrier = undefined;
  testCatalogHoldRollbackBarrier?.release();
  testCatalogHoldRollbackBarrier = undefined;
  testKeyLifecycleOwnerBarrier?.release();
  testKeyLifecycleOwnerBarrier = undefined;
  testLocalStorageBridgeOverride = undefined;
  invalidateWorkerSessionCache();
  cancelSmartSyncIdleTimer();
  smartSyncDebounceMs = WOC_IDLE_SYNC_DEBOUNCE_MS;
  for (const runtime of coordinatorState.taskRuntimes.values()) {
    runtime.controller?.abort();
    if (runtime.timer) clearTimeout(runtime.timer);
  }
  coordinatorState.sessionEpoch = generateEpoch();
  coordinatorState.vaultStatus = "booting";
  coordinatorState.activePublicKeyHex = undefined;
  dropActivePrivateKey();
  testHarnessActivationSecret = undefined;
  coordinatorState.keyspaceGeneration = 0;
  coordinatorState.taskRuntimes.clear();
  coordinatorState.autoLockDeadline = undefined;
  if (autoLockTimer) clearTimeout(autoLockTimer);
  autoLockTimer = undefined;
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
  platformStorageGrants.clear();
  for (const store of workerOwnerStores) store.invalidateBinding();
  ownerStorageFences.clear();
  pendingOwnerStorageDrain = undefined;
  ownerStorageRequests.clear();
  storagePortCounts.clear();
  storageDataActive = 0;
  storageDataActiveByPort.clear();
  storageDataWaiters.length = 0;
  msfileRequests.clear();
  msfileGrants.clear();
  rejectMsfileDataWaiters();
  msfileDataActiveByClient.clear();
  msfileDataClientLastServed.clear();
  msfileDataDispatchSequence = 0;
  msfileDataActive = 0;
  msfileStatActive = 0;
  msfileSeedDataActive = 0;
  msfileBlockDataActive = 0;
  rejectWindowP2pExecutorBridgePending(windowP2pError("ERR_WORKER_RESTARTED", "Window P2P Coordinator runtime restarted"));
  // 测试接缝模拟整个 Worker 被销毁；真实 Worker 重启不会保留旧 Promise。
  activeSatInboundHandlers.clear();
  windowP2pExecutorBridgeInFlightBytes = 0;
  windowP2pExecutorBridgeInFlightItems = 0;
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
  channelSeenMessages.clear();
  channelHashRequests.clear();
  channelWebrtcOffers.clear();
  channelRevision = 0;
  channelPendingPings.clear();
  if (channelPendingPingCleanupTimer !== undefined) {
    clearTimeout(channelPendingPingCleanupTimer);
    channelPendingPingCleanupTimer = undefined;
  }
  channelAutoPongBySender.clear();
  channelAutoPongWindowStartedAtMs = 0;
  channelAutoPongCount = 0;
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
  lastContactsPresenceState = undefined;
  contactsPresencePublishTail = Promise.resolve();
  channelPublicSubscribers.clear();
  channelPrivateSubscribers.clear();
  channelSubscriptionStatusSubscribers.clear();
  channelSubscriptionMuxStatusOff?.();
  channelSubscriptionMuxStatusOff = undefined;
  testSatInboundResponseDispatcher = undefined;
  satRevision = 0;
  lastSatState = undefined;
  msfileMutationTail = Promise.resolve();
  clearWindowP2pExecutorLeaseLocked();
  windowP2pExecutorIdentityTail = Promise.resolve();
  msfileMutationTail = Promise.resolve();
  storageStateTail = Promise.resolve();
  storageMutationTail = Promise.resolve();
  storageController = testStorageRuntimeOverride;
  coordinatorRequestTail = Promise.resolve();
  testP2pkhBroadcastProvider = undefined;
  p2pkhUtxoSnapshots?.clearAll();
}

export function __testSetVaultStatus(status: CoordinatorVaultStatus, activePublicKeyHex?: string): void {
  coordinatorState.vaultStatus = status;
  coordinatorState.activePublicKeyHex = activePublicKeyHex;
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

/** 测试专用：取得 Worker 内 SatSubscription 使用的 P2PKH service。 */
export async function __testEnsureSatP2pkhService(): Promise<P2pkhService> {
  await ensureTestP2pkhProviders();
  return ensureSatP2pkhService();
}

export function __testFailNextCoordinatorSnapshotPersist(): void {
  testPersistCoordinatorSnapshotFailure = true;
}

/** 测试专用：在切桶目标绑定已发布后注入一次后续初始化失败。 */
export function __testFailAfterCatalogBindingPublish(): void {
  testFailAfterCatalogBindingPublish = true;
}

/** 测试专用：在冷启动认证成功、Root 安装前注入一次安装失败。 */
export function __testFailColdStartInstall(): void {
  testFailColdStartInstall = true;
}

/** 测试专用：在密码轮转目录更新成功后注入一次失败以触发设备层回滚。 */
export function __testFailAfterBucketPasswordCatalogUpdate(): void {
  testFailAfterBucketPasswordCatalogUpdate = true;
}

/** 测试专用：在配置更新目录提交后注入一次失败以触发设备层回滚。 */
export function __testFailAfterBucketConfigCatalogUpdate(): void {
  testFailAfterBucketConfigCatalogUpdate = true;
}

/** 测试专用：让密码轮转的 Vault verifier 回滚失败一次，验证事务会保留到重启恢复。 */
export function __testFailNextVaultAuthMetadataRollback(): void {
  testFailNextVaultAuthMetadataRollback = true;
}

/** 测试专用：让 revoked 恢复的 Vault verifier 写入失败一次。 */
export function __testFailNextVaultAuthMetadataRestore(): void {
  testFailNextVaultAuthMetadataRestore = true;
}

/** 测试专用：让密码轮转失败后的设备回滚 CAS 失败一次。 */
export function __testFailNextBucketPasswordDeviceRollback(): void {
  testFailNextBucketPasswordDeviceRollback = true;
}

/** 测试专用：模拟 Hold 已发布后，生命周期 Journal 的阶段推进写入失败。 */

/** 测试专用：让下一次 Owner namespace 删除失败。 */
export function __testFailNextOwnerStorageDeletion(): void {
  testFailNextOwnerStorageDeletion = true;
}

/** 测试专用：在 Owner 激活后、事务阶段推进前注入一次新增 Key 失败。 */
export function __testFailAfterOwnerStorageActivation(): void {
  testFailAfterOwnerStorageActivation = true;
}

/** 测试专用：暂停下一次新增 Key 的 Hold publish，制造旧快照并发窗口。 */
export function __testBlockNextCatalogHoldPublish(): { entered: Promise<void>; release: () => void } {
  if (testCatalogHoldPublishBarrier) throw new Error("Catalog Hold publish barrier is already armed");
  let resolveEntered!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { resolveEntered = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  testCatalogHoldPublishBarrier = { entered, resolveEntered, released, release };
  return { entered, release };
}

/** 测试专用：暂停新增 Key 的 Hold 回滚，制造回滚与新 Head 的竞争。 */
export function __testBlockNextCatalogHoldRollback(): { entered: Promise<void>; release: () => void } {
  if (testCatalogHoldRollbackBarrier) throw new Error("Catalog Hold rollback barrier is already armed");
  let resolveEntered!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { resolveEntered = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  testCatalogHoldRollbackBarrier = { entered, resolveEntered, released, release };
  return { entered, release };
}

/** 测试专用：暂停 Add/Delete 的 Owner 副作用，制造跨客户端事务窗口。 */
export function __testBlockNextKeyLifecycleOwnerSideEffect(): { entered: Promise<void>; release: () => void } {
  if (testKeyLifecycleOwnerBarrier) throw new Error("Key lifecycle Owner barrier is already armed");
  let resolveEntered!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { resolveEntered = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  testKeyLifecycleOwnerBarrier = { entered, resolveEntered, released, release };
  return { entered, release };
}

/** 测试专用：让下一次新 Key 回滚 Hold 的 CAS 失败。 */
export function __testFailNextHoldRollbackCas(): void {
  testFailNextHoldRollbackCas = true;
}

/** 测试专用：替换页面 Local bridge，覆盖候选 Root 和目录 CAS 的真实切桶流程。 */
export function __testSetLocalStorageBridgeOverride(
  bridge: ((input: LocalStorageBridgeRequest) => Promise<LocalStorageBridgeResponse>) | undefined,
): void {
  testLocalStorageBridgeOverride = bridge;
  // 桥切换后不能复用上一条 session 缓存的真值。
  invalidateWorkerSessionCache();
}

/** 测试专用：清空内存 Root，进入真正的“尚未初始化”首桶事务前置态。 */
export function __testPrepareInitialSetup(): void {
  if (platformRootStore) discardCurrentPlatformStorageBinding();
  storageBootstrapState = null;
  platformStorageReady = false;
  storageStartupFailure = false;
  catalogBindingDiscardDeferred = false;
  storageHealthController.resetForTesting("unselected");
  coordinatorState.vaultStatus = "uninitialized";
  coordinatorState.activePublicKeyHex = undefined;
  dropActivePrivateKey();
  initialSetupRuntimeOwner = undefined;
  initialSetupTransactions.clear();
  initialSetupRecoveryRecords.clear();
}

/** 测试专用：验证不同 transactionId 不会因可见字符截断而共享桶命名空间。 */
export function __testInitialSetupBucketId(transactionId: string): string {
  return initialSetupBucketId(transactionId);
}

/**
 * 测试专用：模拟 Worker 真重启后的 session.open 冷启动。
 *
 * 页面只提供设备引导投影（revision=0）；本接缝通过真实
 * initializeCoordinator 执行 Storage-first 装配与 Vault metadata 恢复，
 * 不提前安装可写 Root。返回后重置 single-flight，避免污染后续用例。
 */
export async function __testColdStartFromDeviceHint(
  state: StorageBootstrapState | null,
  peerId = "test",
): Promise<void> {
  coordinatorInitialization = undefined;
  try {
    await startCoordinatorInitialization(state ?? undefined, peerId);
  } finally {
    coordinatorInitialization = undefined;
  }
}

/** 测试专用：把一个已加密目录条目安装成当前 Local catalog binding。 */
export async function __testInstallCatalogLocalBinding(binding: StorageRuntimeBucketV1): Promise<void> {
  if (!testLocalStorageBridgeOverride) throw new Error("Local storage bridge test override is not installed");
  if (platformRootStore) discardCurrentPlatformStorageBinding();
  storageBootstrapState = {
    selectedBackend: binding.backend,
    selectedProfileId: binding.bucketId,
    selectedBucket: structuredClone(binding),
  };
  const provider = createLocalStorageBucketProvider({
    bucketId: binding.bucketId,
    bucketGeneration: 1,
    bridge: requestLocalStorageBridge,
  });
  try {
    await installPlatformStorage(provider, {
      bucketId: binding.bucketId,
      bucketGeneration: 1,
      provider: binding.backend,
    });
  } catch (error) {
    provider.dispose();
    storageBootstrapState = null;
    throw error;
  }
}

/** 测试专用：释放 catalog binding，并恢复普通内存 Storage 夹具。 */
export async function __testReleaseCatalogLocalBinding(): Promise<void> {
  if (platformRootStore && platformBucketProvider?.provider === "local") discardCurrentPlatformStorageBinding();
  storageBootstrapState = null;
  testLocalStorageBridgeOverride = undefined;
  ensureTestPlatformStorage();
}

/** 测试专用：调用真实 Worker 的跨桶切换编排。 */
export async function __testSwitchCatalogBucket(
  target: StorageRuntimeBucketV1,
  password: string,
  options: { keyPassword?: string; publicKeyHex?: string } = {},
): Promise<StorageBucketSwitchResultV1> {
  return switchSelectedRuntimeBucket(target, password, undefined, options);
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
  const keyspace = createWorkerKeyspace();
  if (keyspace.active().activePublicKeyHex?.toLowerCase() !== input.ownerPublicKeyHex.toLowerCase()) throw new Error("P2PKH storage owner is not active");
  await satRuntimeRelease.catch(() => undefined);
  const repository = createP2pkhStateRepository(await openP2pkhStateRepository(createWorkerOwnerFileStore("p2pkh", "")));
  await repository.prepareLocalSubmission({ submission: input.submission as never, claims: (input.claims ?? []) as never });
}

export async function __testFinishP2pkhLocalSubmission(input: { ownerPublicKeyHex: string; submissionId: string; localState: "local-confirmed" | "isolated" }): Promise<void> {
  const keyspace = createWorkerKeyspace();
  if (keyspace.active().activePublicKeyHex?.toLowerCase() !== input.ownerPublicKeyHex.toLowerCase()) throw new Error("P2PKH storage owner is not active");
  await satRuntimeRelease.catch(() => undefined);
  const repository = createP2pkhStateRepository(await openP2pkhStateRepository(createWorkerOwnerFileStore("p2pkh", "")));
  await repository.finishLocalSubmission({ submissionId: input.submissionId, localState: input.localState });
}

export async function __testSetP2pkhChainResolution(input: { ownerPublicKeyHex: string; submissionId: string; chainResolution: "unresolved" | "chain-confirmed" }): Promise<void> {
  const keyspace = createWorkerKeyspace();
  if (keyspace.active().activePublicKeyHex?.toLowerCase() !== input.ownerPublicKeyHex.toLowerCase()) throw new Error("P2PKH storage owner is not active");
  await satRuntimeRelease.catch(() => undefined);
  const repository = createP2pkhStateRepository(await openP2pkhStateRepository(createWorkerOwnerFileStore("p2pkh", "")));
  const row = (await repository.listLocalTransactions()).find((candidate) => candidate.id === input.submissionId);
  if (!row) throw new Error(`P2PKH submission not found: ${input.submissionId}`);
  const next = { ...row, chainResolution: input.chainResolution, ...(input.chainResolution === "chain-confirmed" ? { confirmedHistoryId: `${row.resourceId}:${row.txid}` } : { confirmedHistoryId: undefined }) };
  await repository.replaceLocalTransaction(next);
}

export async function __testListP2pkhLocalTransactions(ownerPublicKeyHex: string): Promise<unknown[]> {
  const keyspace = createWorkerKeyspace();
  if (keyspace.active().activePublicKeyHex?.toLowerCase() !== ownerPublicKeyHex.toLowerCase()) throw new Error("P2PKH storage owner is not active");
  await satRuntimeRelease.catch(() => undefined);
  const repository = createP2pkhStateRepository(await openP2pkhStateRepository(createWorkerOwnerFileStore("p2pkh", "")));
  return repository.listLocalTransactions();
}

export async function __testListP2pkhLocalInputClaims(ownerPublicKeyHex: string): Promise<unknown[]> {
  const keyspace = createWorkerKeyspace();
  if (keyspace.active().activePublicKeyHex?.toLowerCase() !== ownerPublicKeyHex.toLowerCase()) throw new Error("P2PKH storage owner is not active");
  await satRuntimeRelease.catch(() => undefined);
  const repository = createP2pkhStateRepository(await openP2pkhStateRepository(createWorkerOwnerFileStore("p2pkh", "")));
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
    storageHealthController.setStatus("ready");
  }
  if (!runtime && previousUnit) stopCoordinatorWorkerUnit(previousUnit.unitId, previousUnit.instanceId);
}

export function __testSetStorageStartupFailure(enabled: boolean): void {
  testStorageStartupFailure = enabled;
  storageStartupFailure = enabled;
  if (enabled) {
    storageHealthController.setStatus("degraded", "Storage startup failed");
    emitStorageState();
  }
  if (!enabled) {
    storageStartupFailure = false;
    storageHealthController.resetForTesting("ready");
  }
  if (enabled) { storageController = undefined; storageRepository = undefined; }
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
  if (!runtime) testMsfileRuntimeRecoveryAllowed = true;
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
  const peakBytes = windowP2pExecutorBridgeInFlightBytes;
  const peakItems = windowP2pExecutorBridgeInFlightItems;
  for (const eventId of acceptedEventIds) {
    releaseWindowP2pExecutorInboundEvent({ connectionId: "test-connection", eventId }, lease.leaseId);
  }
  return {
    attempts,
    accepted,
    rejected: attempts - accepted,
    peakBytes,
    peakItems,
    releasedBytes: windowP2pExecutorBridgeInFlightBytes,
    releasedItems: windowP2pExecutorBridgeInFlightItems,
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
  const accepted = windowP2pExecutorBridgeInFlightItems;
  const queued = windowP2pExecutorBridgeBudgetWaiters.length;
  const peakBytes = windowP2pExecutorBridgeInFlightBytes;
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
    releasedBytes: windowP2pExecutorBridgeInFlightBytes,
    releasedItems: windowP2pExecutorBridgeInFlightItems,
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
    bridgeBytes: windowP2pExecutorBridgeInFlightBytes,
    bridgeItems: windowP2pExecutorBridgeInFlightItems,
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
  testMsfileRuntimeRecoveryAllowed = true;
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

export function __testSeedStorageRequest(requestId: string, actualPortId: string, connectSessionId?: string): AbortSignal {
  const controller = new AbortController();
  storageRequests.set(storageRequestKey(actualPortId, requestId), { controller, clientId: actualPortId, connectSessionId });
  return controller.signal;
}

/** 测试专用：模拟 Provider 忽略 AbortSignal 的 owner-scoped 在途请求。 */
export function __testSeedOwnerStorageRequest(ownerPublicKeyHex: string): () => void {
  return beginOwnerStorageRequest(ownerPublicKeyHex);
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
  peer: Pick<PeerController, "peerId" | "scope" | "capability">,
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

/** 测试专用：直接走 Worker 的 LocalStorage reverse capability 请求路径。 */
export function __testRequestCoordinatorLocalStorageBridge(
  input: LocalStorageBridgeRequest,
  peerId?: string,
): Promise<LocalStorageBridgeResponse> {
  return requestLocalStorageBridge(input, peerId);
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
    for (const [grantId, grant] of platformStorageGrants) if (grant.clientId === clientId) platformStorageGrants.delete(grantId);
    for (const [grantId, grant] of msfileGrants) if (grant.clientId === clientId) msfileGrants.delete(grantId);
    coordinatorTestEventSinks.delete(clientId);
    return;
  }
  const response = await processRequest(request, clientId);
  sink.postMessage(response);
}

export function __testStorageQueueSnapshot(): { globalActive: number; queued: number; perPort: Record<string, number> } {
  return { globalActive: storageDataActive, queued: storageDataWaiters.length, perPort: Object.fromEntries(storagePortCounts) };
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
  coordinatorState.keyspaceGeneration++;
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
  smartSyncDebounceMs = Math.max(0, Math.floor(ms));
}

/** 测试专用：模拟 WoC 队列事件，驱动智能调度计时。 */
export function __testNotifyWocQueueChange(snapshot: WocQueueSnapshot): void {
  onWocQueueChanged(snapshot);
}

/** 测试专用：读取智能调度计时状态。 */
export function __testSmartSyncState(): { pending: boolean; debounceMs: number } {
  return { pending: smartSyncIdleTimer !== undefined, debounceMs: smartSyncDebounceMs };
}

/** 测试专用：模拟解锁 / 初始化后的立即同步。 */
export function __testTriggerImmediateSync(reason = "unlock"): void {
  triggerImmediateSync(reason);
}

/** 测试专用：按生产冷启动顺序从当前 Root 的三个固定对象重载公开 metadata。 */
export async function __testReloadCoordinatorMeta(): Promise<void> {
  await loadCoordinatorMeta();
}

/** 测试专用：写入指定 Coordinator settings 快照值（模拟旧桶遗留数据）。 */
export function __testSeedCoordinatorSettingsSnapshot(value: unknown): void {
  ensureTestPlatformStorage();
  const declaration = CENTRAL_STORAGE_DECLARATIONS.coordinatorSettings;
  const key = `snapshot:${declaration.moduleId}:${declaration.purposeId}:${declaration.schemaVersion}`;
  testCoordinatorSnapshots?.set(key, { revision: 1, value: structuredClone(value), writes: 1 });
}

export function __testCoordinatorSnapshotMetrics(): Record<"settings" | "pluginIntent", { revision: number; writes: number }> {
  ensureTestPlatformStorage();
  const metric = (declaration: PluginStorageDeclaration) => {
    const key = `snapshot:${declaration.moduleId}:${declaration.purposeId}:${declaration.schemaVersion}`;
    const current = testCoordinatorSnapshots?.get(key);
    return { revision: current?.revision ?? 0, writes: current?.writes ?? 0 };
  };
  return {
    settings: metric(CENTRAL_STORAGE_DECLARATIONS.coordinatorSettings),
    pluginIntent: metric(CENTRAL_STORAGE_DECLARATIONS.coordinatorPluginIntent),
  };
}

/** 测试专用：读取 Worker 缓存/测试夹具中的浏览器 session（含 activeKey）。 */
export function __testGetWorkerSession(): KeymasterSessionV1 | undefined {
  const session = workerSessionCacheLoaded ? workerSessionCache : testWorkerSession;
  return session ? structuredClone(session) : undefined;
}

export async function __testRestartWorker(): Promise<void> {
  __testResetState();
  await ensureCoordinatorAuthorityClaim();
  await loadCoordinatorMeta();
  // 冷启动状态只由 keys/ 文件决定：有 Key = locked,没有 = uninitialized。
  const hasKeys = (await listPublicVaultKeys()).length > 0;
  coordinatorState.vaultStatus = hasKeys ? "locked" : "uninitialized";
  coordinatorState.activePublicKeyHex = undefined;
  dropActivePrivateKey();
  if (hasKeys && !await reconcileSelectedPublicKey()) coordinatorState.vaultStatus = "uninitialized";
}

// ============================================================
// 15. Backup Import Test Helpers
// ============================================================

/** 测试专用：删除 Vault 密钥材料。 */
export async function __testDeleteVault(): Promise<void> {
  resetVaultKeyIndexCache();
  testVaultHoldBinding?.reset();
  if (testVaultHoldBinding) configureVaultStorageRepository({ hold: testVaultHoldBinding.adapter });
  // 重置内存状态
  coordinatorState.vaultStatus = "uninitialized";
  coordinatorState.activePublicKeyHex = undefined;
  dropActivePrivateKey();
  testHarnessActivationSecret = undefined;
  coordinatorState.keyspaceGeneration = 0;
  coordinatorState.autoLockDeadline = undefined;
  if (autoLockTimer) clearTimeout(autoLockTimer);
  autoLockTimer = undefined;
}

/** 测试专用：清空一个中央 namespace，不连接浏览器持久化 API。 */
export async function __testClearCentralNamespace(moduleId: string): Promise<void> {
  ensureTestPlatformStorage();
  if (!platformRootStore) throw new Error("Test platform storage is not ready");
  const normalizedModuleId = moduleId.toLowerCase();
  const declarations = Object.values(CENTRAL_STORAGE_DECLARATIONS).filter(
    (candidate) => candidate.moduleId === normalizedModuleId,
  );
  if (declarations.length === 0) throw new Error(`Unknown central module: ${moduleId}`);
  // owner 声明（含 owner 文件模型）没有 bucket 级 store 可清；这里直接
  // 清掉内存 owner 文件对象与 owner K-V 句柄，保持测试隔离。
  if (declarations.some((declaration) => declaration.scope === "owner")) {
    const stores = testPlatformStores;
    if (stores) {
      const suffix = `:${normalizedModuleId}:`;
      for (const key of [...stores.keys()]) {
        if (key.includes(suffix)) {
          stores.get(key)?.close();
          stores.delete(key);
        }
      }
    }
    for (const key of [...testOwnerFileObjects.keys()]) {
      if (key.includes(`::${normalizedModuleId}::`)) testOwnerFileObjects.delete(key);
    }
    return;
  }
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

/** 创建 Vault（空或带初始 key）。 */
export async function __testCreateVault(password: string, options?: { label?: string; capabilities?: string[] }): Promise<{ publicKeyHex?: string }> {
  const result = await executeVaultOperation({ type: "createVaultWithInitialKey", password, label: options?.label ?? "Key", capabilities: options?.capabilities ?? ["p2pkh"] });
  testHarnessActivationSecret = password;
  return result as { publicKeyHex?: string };
}

/** 创建没有 key 的 locked Vault。 */
export async function __testCreateEmptyVault(password: string): Promise<void> {
  await executeVaultOperation({ type: "createVault", password });
}

/** 测试专用：通过新的中央 Vault repository 读取公开状态。 */
export async function __testListVaultKeys(): Promise<PublicVaultKeyRecord[]> {
  return listPublicVaultKeys();
}

export async function __testGetVaultAuthMetadata(): Promise<undefined> {
  return undefined;
}


/** 测试专用：清空 Hold/index 以覆盖“当前会话仍在线但没有 Key”的导入分支。 */
export async function __testClearVaultHold(password: string): Promise<void> {
  const current = await readVaultHoldSnapshot(password);
  const hold = requireVaultHoldAdapter();
  for (const key of current.keys) await hold.removeKey(key.publicKeyHex);
  await publishVaultHoldSnapshot(password, [], [], expectedHoldHead(current.headEtag));
}

/** 为 Storage rotation 测试生成当前 Vault 可解开的 local secret。 */
export async function __testSealLocalSecret(scope: string, plaintext: string): Promise<VaultSealedSecret> {
  const bytes = new TextEncoder().encode(plaintext);
  return await executeVaultOperation({ type: "sealLocalSecret", scope, plaintext: bytes }) as VaultSealedSecret;
}

/** 导入私钥。 */
export async function __testImportPrivateKey(password: string, input: { label: string; material: { hex: string; wif?: string }; format: string; capabilities: string[]; source?: string }): Promise<{ publicKeyHex: string }> {
  const result = await executeVaultOperation({ type: "importPrivateKey", password, ...input });
  testHarnessActivationSecret = password;
  return result as { publicKeyHex: string };
}

export async function __testSetActive(publicKeyHex: string): Promise<void> {
  await executeVaultOperation({ type: "setActive", publicKeyHex }, testHarnessActivationSecret);
}

/** 测试专用：直接通过一个 Worker owner 文件 handle 验证当前 owner 可写。 */
export async function __testOwnerStoragePut(path: string, bytes: Uint8Array): Promise<void> {
  const store = createWorkerOwnerFileStore("p2pkh", "");
  await store.put(path, bytes);
}

/** 测试专用：观测内存 Root 中指定 owner 是否仍有 namespace 句柄。 */
export function __testOwnerStorageNamespaceExists(publicKeyHex: string): boolean {
  const prefix = `owner:${publicKeyHex.toLowerCase()}:`;
  return [...(testPlatformStores?.keys() ?? [])].some((key) => key.startsWith(prefix));
}

/** 导出备份。 */
export async function __testExportKeyBackup(publicKeyHex: string): Promise<string> {
  const result = await executeVaultOperation({ type: "exportKeyBackup", publicKeyHex });
  return result as string;
}

/** Locked-state cold export through the persisted selected record. */
export async function __testExportCurrentKeyBackup(): Promise<string> {
  const result = await executeVaultOperation({ type: "exportCurrentKeyBackup" });
  return result as string;
}

/** Test-only facade for the worker's atomic key deletion primitive. */
export async function __testDeleteKeyMaterial(publicKeyHex: string, bucketPassword?: string): Promise<void> {
  // 测试接缝也走与生产相同的 Journal + owner namespace 联合删除，
  // 只放宽“必须 unlocked”的 RPC 前置条件以覆盖 locked cold path。
  const key = await getPublicVaultKey(publicKeyHex);
  if (!key) throw new Error("Key not found");
  await executeKeyDeletion(publicKeyHex, key.label, bucketPassword);
}

/** Test-only invocation of the single empty-vault finalization operation. */
export async function __testFinalizeEmptyVaultAfterLastKeyDeletion(): Promise<void> {
  await executeVaultOperation({ type: "finalizeEmptyVaultAfterLastKeyDeletion" });
}

/** 导入备份。 */
export async function __testImportKeyBackup(backup: string, sourcePassword: string, targetPassword: string): Promise<{ publicKeyHex: string }> {
  // 测试接缝也必须经过真实 vault.operation RPC handler，覆盖请求 epoch、
  // Coordinator authority 和最终 I/O lease；否则直接调用领域函数会把
  // 生产入口上的接管竞态隐藏起来。
  const response = await processRequest({
    kind: "vault.operation",
    clientId: "test",
    requestId: `test-import-key-backup-${Date.now()}`,
    operation: { type: "importKeyBackup", backup, sourcePassword, targetPassword },
    expectedSessionEpoch: coordinatorState.sessionEpoch,
  });
  if (response.ack.status !== "ok") {
    const message = "message" in response.ack ? response.ack.message : `Backup import failed: ${response.ack.status}`;
    const error = new Error(message) as Error & { code?: string };
    if ("code" in response.ack && typeof response.ack.code === "string") error.code = response.ack.code;
    throw error;
  }
  return response.operationResult as { publicKeyHex: string };
}

/** 解锁 Vault。 */
export async function __testUnlock(password: string, publicKeyHex?: string): Promise<CoordinatorResponse> {
  const response = await processRequest({ kind: "unlock", password, publicKeyHex, requestId: `test-unlock-${Date.now()}`, clientId: "test", expectedSessionEpoch: coordinatorState.sessionEpoch });
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
