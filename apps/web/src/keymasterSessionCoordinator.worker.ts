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
  AssetDataInvalidationEvent,
  SessionStateEvent,
  VaultSealedSecret,
  P2pkhProviderRegistrySnapshot,
  P2pkhProviderConfig,
  P2pkhProviderSettings,
  P2pkhNetworkProviderSelection,
  P2pkhProviderRegistry,
  P2pkhTransactionBroadcastProvider,
  WindowP2pExecutorLease,
  WindowP2pNoiseSignRequest,
  WindowP2pPeerRecordSignRequest,
  WindowP2pIdentitySignResult,
  MsFileReadConcurrencySettings,
  CoordinatorSatOperation,
  CoordinatorSatStateEvent,
  CoordinatorChannelOperation,
  CoordinatorChannelStateEvent,
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
  StorageSecretEnvelope,
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
} from "@keymaster/contracts";
import { SYSTEM_STORAGE_DECLARATIONS, deriveThirdPartyApplicationStorageId, coordinatorClientRequestFromRpc, parseCoordinatorResponseFor } from "@keymaster/contracts";
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
  normalizeMsFileReadConcurrencySettings,
  SAT_SUBSCRIPTION_RESOURCE_LIMITS,
} from "@keymaster/contracts";
import { installInsecureContextCryptoFallback, vaultKeyRepository, createVaultKeyRepository, configureVaultKeyRepository, type VaultMetaRecord, type VaultKeyRecord, type VaultKeyRepository, deriveKey, verifyVerifier, hexToBytes as cryptoHexToBytes, bytesToHex, decryptBytesWithSaltBoundAad, encryptBytesWithSaltBoundAad, deriveP2pkhAddress, signEcdsaDigest, verifySessionKeyPair, encryptVerifier, buildVaultMeta, encryptMaterialWithPasskey, decryptMaterialWithPasskey, toPasskeySummary, generatePrivateKeyHex as generateValidPrivateKeyHex } from "@keymaster/plugin-vault/coordinator";
import { exportPrivateKey as keyholdExportPrivateKey, parse as keyholdParse, serialize as keyholdSerialize, recommendedParameters as keyholdRecommendedParameters, unlock as keyholdUnlock } from "keyhold";
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
import {
  assertCoordinatorWorkerUnitCatalog,
  COORDINATOR_WORKER_UNIT_CATALOG,
  getCoordinatorWorkerProductDependenciesForTask,
  getCoordinatorWorkerUnitForTask,
} from "./coordinator/workerUnitCatalog.js";
import { createCoordinatorWorkerUnitRegistry } from "./coordinator/workerUnitRuntime.js";
import { createWocService, createWocBsv21Service, createWocStasService, createWoc1SatOrdinalsService, registerWocP2pkhProviders } from "@keymaster/plugin-woc/coordinator";
import { createJungleBusClient, registerJungleBusP2pkhProvider } from "@keymaster/plugin-junglebus/coordinator";
import { createP2pkhProviderRegistry, createP2pkhService, type P2pkhService } from "@keymaster/plugin-p2pkh/coordinator";
import { createP2pkhCoordinatorTasks, openP2pkhStateRepository, createP2pkhStateRepository, P2PKH_REPOSITORY_VERSION, P2PKH_STORAGE_ID } from "@keymaster/plugin-p2pkh/coordinator";
import { createBsv21CoordinatorTask, BSV21_STORAGE_ID, BSV21_SCHEMA_VERSION } from "@keymaster/plugin-token-bsv21/coordinator";
import { createStasCoordinatorTask, STAS_STORAGE_ID, STAS_SCHEMA_VERSION } from "@keymaster/plugin-token-stas/coordinator";
import { createOrdinalsCoordinatorTask } from "@keymaster/plugin-collectible-1satordinals/coordinator";
import { createContactsPresenceTask, createContactsService, CONTACTS_STORAGE_ID, CONTACTS_SCHEMA_VERSION } from "@keymaster/plugin-contacts/coordinator";
import type { InitialSetupFirstKey, InitialSetupPlan, InitialSetupRecoveryRecordV1, InitialSetupRecoveryResult, InitialSetupRecoverySuccessV1, InitialSetupResult, KeyspaceService, KeyValueStore, PlatformRootStore, StorageBucketCatalogEntryV2, StorageBucketConnectionConfigV1, StorageBucketProvider, StorageBucketRef, StorageRecordV1, StorageKeyDerivationV1, StorageBucketSwitchResultV1, StorageCatalogKeyIndexRecordV1, StorageCatalogV2, VaultService, WocService } from "@keymaster/contracts";
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
} from "@keymaster/contracts";
import { createStorageRuntimeController, createOwnerLifecycleGuardedProvider, createPlatformRootStore, openMultipartUploadRepository, STORAGE_SECRET_SCOPE, StorageBootstrapController, StorageHealthController, StorageRuntimeError, createLocalStorageBucketProvider, createS3BucketProvider, encryptStorageProfile, normalizeProviderConfig, createStorageHoldSnapshotRepository, createStorageCatalogKeyIndexRepository, createStorageBucketManagementService, serializeBucketDocument, createBucketCryptoContext, deriveBucketCryptoContext, encryptBucketConfig, decryptBucketConfig, decryptBucketKey, encryptBucketKey, sealBucketDocument, verifyBucketDocument, sameStorageCatalogEntry, validateStorageCatalog } from "@keymaster/platform-storage/coordinator";
import type { LocalStorageBridgeCandidateBucket, LocalStorageBridgeRequest, LocalStorageBridgeResponse } from "@keymaster/platform-storage/coordinator";
import { buildDiagnosticText } from "./diagnostics/sanitizeDiagnostic.js";

// SharedWorker 的模块状态（包括 session epoch）会在下面初始化；先安装
// HTTP fallback，避免 insecure host 上的首个随机 ID 读取到缺失的 randomUUID。
installInsecureContextCryptoFallback();

// Web Worker 直接复用 platform-storage 的 Hold 适配器，但不需要把
// `keymaster-hold/browser` 作为应用层依赖暴露出来；该类型由加密函数的
// 返回值推导，避免运行时和类型包出现两套版本。
type HoldKeyRecord = Awaited<ReturnType<typeof encryptBucketKey>>;

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

// 施工单 docs/proposals/msfile：MSFile runtime 真值在 Coordinator SharedWorker。
// 001 架构 Spike 与 002 生产 Runtime 完成前 transport fail closed；之后由 Window executor 注入。
import {
  createMsFileService,
  openMsFileRepository,
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
import { marshalEnvelope, signPrivateMessage, sealSigned, verifySignedPrivateMessage, open as openPrivateMessage, validatePongRelation, validateWebRTCRelation, reviewOfferForHashRequest, dedupKey as privateDedupKey, privateMessageMaxLifetimeMs, PING_PRIVATE_MESSAGE_MAX_LIFETIME_MS } from "bsv8-channel-protocol/inbox";
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
  createSatSubscriptionProvider,
  createSatSubscriptionRepository,
  SAT_SUBSCRIPTION_STORAGE_ID,
  SAT_SUBSCRIPTION_SCHEMA_VERSION,
  createSatSubscriptionState,
  createSatSpiService,
  type SatSubscriptionProvider,
  type SatSubscriptionStateStore,
  type SatSubscriptionRepository,
  type SatSubscriptionTransport,
  type SatSupplierConnection,
  SatSubscriptionHandle,
  type SatP2pkhService,
} from "@keymaster/plugin-sat-subscription/coordinator";

// Vault 平台 K-V 操作（Worker 内只访问 Storage bootstrap 注入的句柄）
async function getVaultMeta(): Promise<VaultMetaRecord | undefined> {
  return vaultKeyRepository.getMeta();
}

async function getActiveKey(): Promise<PublicVaultKeyRecord | undefined> {
  const selectedPublicKeyHex = coordinatorMeta.selectedPublicKeyHex;
  if (selectedPublicKeyHex) {
    const selected = await getPublicVaultKey(selectedPublicKeyHex);
    if (selected) return selected;
  }
  const keys = await listPublicVaultKeys();
  const first = keys[0];
  if (first) { coordinatorMeta.selectedPublicKeyHex = first.publicKeyHex; await persistCoordinatorMeta(); }
  return first;
}

/** Reconcile persisted selection from public key listings only. */
async function reconcileSelectedPublicKey(): Promise<boolean> {
  const activeKey = await getActiveKey();
  if (activeKey) return true;

  // 没有 Key 的 meta 是不可用的空状态，回到首启流程。
  await vaultKeyRepository.deleteMeta();
  coordinatorMeta.selectedPublicKeyHex = undefined;
  await persistCoordinatorMeta();
  return false;
}

// 密码验证逻辑（简化版，实际需要导入 crypto 模块）
async function verifyPassword(password: string, meta: VaultMetaRecord): Promise<boolean> {
  const salt = decodePersisted(meta.saltB64);
  const key = await deriveKey(password, salt);
  return verifyVerifier(key, {
    salt: decodePersisted(meta.verifierSaltB64),
    iv: decodePersisted(meta.verifierIvB64),
    ciphertext: decodePersisted(meta.verifierCipherB64),
    version: meta.cryptoVersion
  });
}

async function decryptPrivateKey(password: string, record: VaultKeyRecord): Promise<Uint8Array> {
  if (record.storageVersion !== "keyhold-v2" || !record.keyholdDocument) throw new Error("Unsupported key storage version");
  const unlocked = await (await import("keyhold")).unlock((await import("keyhold")).parse((await import("keyhold")).serialize(record.keyholdDocument)), password);
  if (unlocked.publicKeyHex !== record.publicKeyHex) {
    unlocked.privateKey.fill(0);
    throw new Error("KeyHold public key mismatch");
  }
  return unlocked.privateKey;
}

function selectedCatalogBucket(): StorageBucketCatalogEntryV2 | undefined {
  const entry = storageBootstrapState?.selectedBucket;
  const provider = platformBucketProvider;
  const root = platformRootStore;
  if (!entry || !provider || !root) return undefined;
  if (entry.bucketId !== provider.bucketId || entry.backend !== provider.provider) return undefined;
  if (root.bucket.bucketId !== entry.bucketId || root.bucket.provider !== entry.backend) return undefined;
  return entry;
}

/**
 * 新版桶的 Key 公共索引句柄。
 *
 * `vaultKeyRepository` 仍服务旧 OPFS/旧 Profile 路径；新版桶的私钥密文
 * 只从已提交 KeymasterHold 快照读取，索引中没有 `keyholdDocument`。这样
 * 旧格式迁移完成后不会再产生 KeyHold/KeymasterHold 双写。
 */
function currentCatalogKeyIndex() {
  if (!platformKeysStore) throw new StorageRuntimeError("storage_unavailable", "Catalog Key index storage is unavailable");
  return createStorageCatalogKeyIndexRepository(platformKeysStore);
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
interface CatalogKeyBackupV1 {
  format: "keymaster.storage.catalog-key-backup";
  version: 1;
  publicKeyHex: string;
  label: string;
  address?: string;
  network?: "main" | "test";
  keyFormat: string;
  capabilities: string[];
  createdAt: string;
  source?: string;
  keyDerivation: StorageKeyDerivationV1;
  key: HoldKeyRecord;
}

function parseCatalogKeyBackup(input: string): CatalogKeyBackupV1 {
  let value: unknown;
  try { value = JSON.parse(input); } catch { throw new Error("Unrecognized key backup format"); }
  if (!value || typeof value !== "object") throw new Error("Unrecognized key backup format");
  const candidate = value as Partial<CatalogKeyBackupV1>;
  if (
    candidate.format !== "keymaster.storage.catalog-key-backup"
    || candidate.version !== 1
    || typeof candidate.publicKeyHex !== "string"
    || !/^0[23][0-9a-f]{64}$/u.test(candidate.publicKeyHex.toLowerCase())
    || typeof candidate.label !== "string"
    || !candidate.label.trim()
    || typeof candidate.keyFormat !== "string"
    || !candidate.keyFormat.trim()
    || !Array.isArray(candidate.capabilities)
    || !candidate.capabilities.every((item) => typeof item === "string")
    || typeof candidate.createdAt !== "string"
    || !candidate.keyDerivation
    || !candidate.key
  ) throw new Error("Unrecognized key backup format");
  const derivation = candidate.keyDerivation as Partial<StorageKeyDerivationV1>;
  if (derivation.algorithm !== "pbkdf2-hmac-sha-256" || derivation.passwordEncoding !== "utf-8"
    || derivation.outputLengthBits !== 256 || typeof derivation.iterations !== "number"
    || !Number.isSafeInteger(derivation.iterations) || derivation.iterations < 1
    || typeof derivation.saltB64Url !== "string") {
    throw new Error("Catalog key backup KDF is invalid");
  }
  return {
    format: candidate.format,
    version: candidate.version,
    publicKeyHex: candidate.publicKeyHex.toLowerCase(),
    label: candidate.label,
    ...(candidate.address === undefined ? {} : { address: candidate.address }),
    ...(candidate.network === undefined ? {} : { network: candidate.network }),
    keyFormat: candidate.keyFormat,
    capabilities: [...candidate.capabilities],
    createdAt: candidate.createdAt,
    ...(candidate.source === undefined ? {} : { source: candidate.source }),
    keyDerivation: { ...candidate.keyDerivation },
    key: candidate.key as HoldKeyRecord,
  };
}

async function exportCatalogKeyBackup(publicKeyHex: string): Promise<string> {
  const entry = selectedCatalogBucket();
  const provider = platformBucketProvider;
  if (!entry || !provider) throw new StorageRuntimeError("storage_unavailable", "The selected catalog bucket is unavailable");
  const key = await getPublicVaultKey(publicKeyHex);
  if (!key) throw new Error("Key not found");
  const committed = await createStorageHoldSnapshotRepository(provider).readCommitted();
  const encryptedKey = committed.document.keys.find((item) => item.publicKeyHex.toLowerCase() === key.publicKeyHex.toLowerCase());
  if (!encryptedKey) throw new Error("Key is missing from the committed Hold snapshot");
  const backup: CatalogKeyBackupV1 = {
    format: "keymaster.storage.catalog-key-backup",
    version: 1,
    publicKeyHex: key.publicKeyHex.toLowerCase(),
    label: encryptedKey.label,
    ...(key.address === undefined ? {} : { address: key.address }),
    ...(key.network === undefined ? {} : { network: key.network }),
    keyFormat: key.format,
    capabilities: [...key.capabilities],
    createdAt: key.createdAt,
    ...(key.source === undefined ? {} : { source: key.source }),
    keyDerivation: { ...committed.header.keyDerivation },
    key: encryptedKey,
  };
  return JSON.stringify(backup);
}

function vaultRecordToPublicKey(record: VaultKeyRecord): PublicVaultKeyRecord {
  return {
    publicKeyHex: record.publicKeyHex,
    label: record.label,
    address: record.address,
    network: record.network,
    format: record.format,
    capabilities: [...record.capabilities],
    createdAt: record.createdAt,
    ...(record.source === undefined ? {} : { source: record.source }),
  };
}

type CatalogCommittedSnapshot = Awaited<ReturnType<ReturnType<typeof createStorageHoldSnapshotRepository>["readCommitted"]>>;

/** 读取并认证当前桶的完整快照；调用方不获得可长期复用的密码上下文。 */
async function readVerifiedCurrentCatalogSnapshot(password: string): Promise<CatalogCommittedSnapshot> {
  const entry = selectedCatalogBucket();
  const provider = platformBucketProvider;
  if (!entry || !provider) throw new StorageRuntimeError("storage_unavailable", "The selected catalog bucket is unavailable");
  const committed = await createStorageHoldSnapshotRepository(provider).readCommitted();
  const context = await deriveBucketCryptoContext(password, entry.keyDerivation);
  try {
    if (!sameStorageKeyDerivation(committed.header.keyDerivation, entry.keyDerivation)) {
      throw new StorageRuntimeError("storage_provider_error", "Storage Hold snapshot KDF does not match the bucket catalog");
    }
    if (committed.header.configRevision !== entry.configRevision || !sameStorageRecord(committed.storage, entry.encryptedConfig)) {
      throw new StorageRuntimeError("storage_conflict", "Storage Hold snapshot does not match the bucket catalog");
    }
    await verifyBucketDocument(committed.document, context);
    const config = await decryptBucketConfig(committed.storage, context);
    if ((config.kind === "local" ? "local" : "s3") !== entry.backend) {
      throw new StorageRuntimeError("storage_provider_error", "Storage Hold snapshot backend does not match the bucket catalog");
    }
    return committed;
  } finally {
    context.dispose();
  }
}

/** 从 Hold 的公开 KeyRecord 重建一个不含密文的桶内索引记录。 */
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
    keyFormat: previous?.keyFormat ?? "keymaster-hold",
    capabilities: [...(previous?.capabilities ?? ["p2pkh"])],
    createdAt: previous?.createdAt ?? new Date().toISOString(),
    ...(previous?.source === undefined ? { source: "keymaster-hold" } : { source: previous.source }),
  };
}

/**
 * 用已认证快照修复公开索引。这里不会读取私钥，也不会把 Hold KeyRecord
 * 复制到本机；快照仍然是唯一的密文来源。
 */
async function rebuildCurrentCatalogKeyIndex(committed: CatalogCommittedSnapshot): Promise<PublicVaultKeyRecord[]> {
  const index = currentCatalogKeyIndex();
  const previous = new Map((await index.listKeys()).map((record) => [record.publicKeyHex.toLowerCase(), record]));
  const records = committed.document.keys.map((key) => catalogIndexFromHoldKey(key, previous.get(key.publicKeyHex.toLowerCase())));
  await index.replaceKeys(records);
  return records.map(catalogIndexToPublicKey);
}

/**
 * 发布新版桶的下一份完整 Hold 快照。
 *
 * 先对当前提交头做认证和 ETag CAS，再更新可重建的公开索引；因此即使
 * 索引写入在响应丢失后失败，下一次解锁也会以 Hold 快照修复它，而不会
 * 产生第二套私钥密文真值。
 */
async function publishCurrentCatalogHoldSnapshot(
  password: string,
  keys: readonly HoldKeyRecord[],
  indexRecords: readonly StorageCatalogKeyIndexRecordV1[],
): Promise<CatalogCommittedSnapshot> {
  const entry = selectedCatalogBucket();
  const provider = platformBucketProvider;
  const root = platformRootStore;
  if (!entry || !provider || !root) throw new StorageRuntimeError("storage_unavailable", "The selected catalog bucket is unavailable");
  const repository = createStorageHoldSnapshotRepository(provider);
  let previous: CatalogCommittedSnapshot | undefined;
  try {
    previous = await repository.readCommitted();
  } catch (error) {
    if (!(error instanceof StorageRuntimeError) || error.code !== "storage_not_found") throw error;
  }
  const previousIndex = await currentCatalogKeyIndex().listKeys();
  const context = await deriveBucketCryptoContext(password, entry.keyDerivation);
  try {
    if (previous) {
      if (!sameStorageKeyDerivation(previous.header.keyDerivation, entry.keyDerivation)
        || previous.header.configRevision !== entry.configRevision
        || !sameStorageRecord(previous.storage, entry.encryptedConfig)) {
        throw new StorageRuntimeError("storage_conflict", "Storage Hold snapshot does not match the bucket catalog");
      }
      await verifyBucketDocument(previous.document, context);
      await decryptBucketConfig(previous.storage, context);
    } else {
      // 空桶没有提交头时仍要认证本机目录中的配置，不能把任意密码
      // 当成首个 Vault/Key 的桶密码。
      await decryptBucketConfig(entry.encryptedConfig, context);
    }
    const document = await sealBucketDocument(entry.encryptedConfig, [...keys], context);
    const published = await repository.publish({
      document,
      configRevision: entry.configRevision,
      bucketGeneration: root.bucket.bucketGeneration,
      ...(previous?.headEtag === undefined ? {} : { expectedHeadEtag: previous.headEtag }),
    });
    let indexUpdated = false;
    try {
      await currentCatalogKeyIndex().replaceKeys(indexRecords);
      indexUpdated = true;
      await updateCurrentCatalogSnapshotRevision(published.header.snapshotRevision);
      return published;
    } catch (error) {
      const rollbackErrors: string[] = [];
      if (indexUpdated) {
        try { await currentCatalogKeyIndex().replaceKeys(previousIndex); }
        catch (rollbackError) { rollbackErrors.push(`Key index: ${rollbackError instanceof Error ? rollbackError.message : "unknown error"}`); }
      }
      try {
        if (published.headEtag) {
          if (previous) {
            await repository.publish({
              document: previous.document,
              configRevision: previous.header.configRevision,
              bucketGeneration: root.bucket.bucketGeneration,
              expectedHeadEtag: published.headEtag,
            });
          } else {
            // 这是首次发布且原来没有 head；用 ETag 删除新 head，避免
            // 目录修订写失败后留下一个目录无法引用的“幽灵”提交。
            await provider.delete(".keymaster/hold/v1/head.json", { ifMatch: published.headEtag });
          }
        }
      } catch (rollbackError) {
        rollbackErrors.push(`Hold: ${rollbackError instanceof Error ? rollbackError.message : "unknown error"}`);
      }
      if (rollbackErrors.length > 0) {
        throw new Error(`Storage Hold snapshot update failed; rollback was not fully confirmed (${rollbackErrors.join("; ")})`);
      }
      throw error;
    }
  } finally {
    context.dispose();
  }
}

/** 只在当前解锁操作中解开一条 Hold KeyRecord，并清理上下文。 */
async function decryptCurrentCatalogPrivateKey(
  publicKeyHex: string,
  password: string,
  committed?: CatalogCommittedSnapshot,
): Promise<Uint8Array> {
  const snapshot = committed ?? await readVerifiedCurrentCatalogSnapshot(password);
  const record = snapshot.document.keys.find((key) => key.publicKeyHex.toLowerCase() === publicKeyHex.toLowerCase());
  if (!record) throw new Error("Key not found in the committed Hold snapshot");
  const entry = selectedCatalogBucket();
  if (!entry) throw new StorageRuntimeError("storage_unavailable", "The selected catalog bucket is unavailable");
  const context = await deriveBucketCryptoContext(password, entry.keyDerivation);
  try {
    const plain = await decryptBucketKey(record, context);
    try {
      if (plain.publicKeyHex.toLowerCase() !== publicKeyHex.toLowerCase()) throw new Error("KeymasterHold public key mismatch");
      verifySessionKeyPair({ publicKeyHex: publicKeyHex.toLowerCase(), privateKeyBytes: plain.privateKey });
      return plain.privateKey.slice();
    } finally {
      plain.privateKey.fill(0);
    }
  } finally {
    context.dispose();
  }
}

async function listPublicVaultKeys(): Promise<PublicVaultKeyRecord[]> {
  if (selectedCatalogBucket()) return (await currentCatalogKeyIndex().listKeys()).map(catalogIndexToPublicKey);
  return (await vaultKeyRepository.listKeys()).map(vaultRecordToPublicKey);
}

async function getPublicVaultKey(publicKeyHex: string): Promise<PublicVaultKeyRecord | undefined> {
  if (selectedCatalogBucket()) {
    const record = await currentCatalogKeyIndex().getKey(publicKeyHex);
    return record ? catalogIndexToPublicKey(record) : undefined;
  }
  const record = await vaultKeyRepository.getKey(publicKeyHex);
  return record ? vaultRecordToPublicKey(record) : undefined;
}

/** 只有旧 OPFS/Profile 兼容路径可以读取完整 KeyHold 记录。 */
async function getLegacyVaultKeyRecord(publicKeyHex: string): Promise<VaultKeyRecord | undefined> {
  if (selectedCatalogBucket()) return undefined;
  return vaultKeyRepository.getKey(publicKeyHex);
}

async function requireLegacyVaultKeyRecord(publicKeyHex: string): Promise<VaultKeyRecord> {
  const record = await getLegacyVaultKeyRecord(publicKeyHex);
  if (!record) throw new Error("Key not found");
  return record;
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
 * 让新版目录桶的公开索引与已提交 Hold 快照保持一致。
 *
 * 旧 OPFS/Profile 路径继续由原来的 KeyHold repository 负责；它没有新版
 * 桶目录的 KDF/配置引用，因此不能在这里伪造一份 Hold 快照。
 */
async function syncSelectedCatalogHoldSnapshot(password: string): Promise<number | undefined> {
  const entry = selectedCatalogBucket();
  if (!entry) return undefined;
  let committed: CatalogCommittedSnapshot | undefined;
  try {
    committed = await readVerifiedCurrentCatalogSnapshot(password);
  } catch (error) {
    if (!(error instanceof StorageRuntimeError) || error.code !== "storage_not_found") throw error;
    const existingIndex = await currentCatalogKeyIndex().listKeys();
    if (existingIndex.length > 0) throw new StorageRuntimeError("storage_provider_error", "Catalog Key index exists but its Hold snapshot is missing");
    committed = await publishCurrentCatalogHoldSnapshot(password, [], []);
  }
  await rebuildCurrentCatalogKeyIndex(committed);
  return committed.header.snapshotRevision;
}

/**
 * 冷导入的 Hold 快照可能包含 Keys，但本机 `keys/` 还没有公开索引或
 * Vault meta。首次解锁桶时认证快照、重建公开索引，并按需创建只含
 * verifier 的 Vault meta；私钥只在本次临时密码上下文中出现，绝不通过
 * 页面返回。旧 KeyHold 记录只允许在逐条一致时做一次性清理迁移。
 */
async function hydrateCatalogVaultFromSnapshot(password: string): Promise<boolean> {
  const entry = selectedCatalogBucket();
  const provider = platformBucketProvider;
  const keysStore = platformKeysStore;
  if (!entry || !provider || !keysStore) return false;
  const vaultRepository = createVaultKeyRepository(keysStore);
  const existingMeta = await vaultRepository.getMeta();
  const legacyKeyholdRecords = await vaultRepository.listKeys();
  const index = createStorageCatalogKeyIndexRepository(keysStore);
  const previousIndex = new Map((await index.listKeys()).map((record) => [record.publicKeyHex.toLowerCase(), record]));
  let committed: CatalogCommittedSnapshot;
  try {
    committed = await createStorageHoldSnapshotRepository(provider).readCommitted();
  } catch (error) {
    if (!(error instanceof StorageRuntimeError) || error.code !== "storage_not_found") throw error;
    // 新建的空桶可以只有目录中的加密配置，还没有 Hold 提交头。先认证
    // 配置归属；有任何旧 Vault/index 残留则拒绝把损坏桶当成空桶。
    if (existingMeta || legacyKeyholdRecords.length > 0 || previousIndex.size > 0) {
      throw new StorageRuntimeError("storage_provider_error", "Catalog bucket has Key metadata but no committed Hold snapshot");
    }
    const context = await deriveBucketCryptoContext(password, entry.keyDerivation);
    try { await decryptBucketConfig(entry.encryptedConfig, context); }
    finally { context.dispose(); }
    return false;
  }
  const root = platformRootStore;
  if (!root || committed.header.configRevision !== entry.configRevision || committed.bucketGeneration < 1 || !sameStorageRecord(committed.storage, entry.encryptedConfig)) {
    throw new Error("Storage Hold snapshot does not match the selected bucket catalog");
  }
  const context = await deriveBucketCryptoContext(password, entry.keyDerivation);
  const records: StorageCatalogKeyIndexRecordV1[] = [];
  try {
    if (!sameStorageKeyDerivation(committed.header.keyDerivation, entry.keyDerivation)) throw new Error("Storage Hold snapshot KDF does not match the selected bucket catalog");
    await verifyBucketDocument(committed.document, context);
    // 认证 storage 记录，确保导入快照的配置也确实属于当前桶密码。
    await decryptBucketConfig(committed.storage, context);
    for (const key of committed.document.keys) {
      const plain = await decryptBucketKey(key, context);
      try {
        records.push(catalogIndexFromHoldKey(plain, previousIndex.get(plain.publicKeyHex.toLowerCase())));
      } finally {
        plain.privateKey.fill(0);
      }
    }
  } finally {
    context.dispose();
  }

  // 旧版本曾把同一桶的 KeyHold 文档放在 `keys/`。这里只接受它与已认证
  // Hold 快照逐条一致，然后一次性迁移为公开索引并删除旧私钥副本；若
  // 两套集合不一致，必须人工走显式迁移，不能任选一套继续运行。
  for (const legacy of legacyKeyholdRecords) {
    if (legacy.storageVersion !== "keyhold-v2" || !legacy.keyholdDocument) throw new Error("Unsupported legacy catalog KeyHold record; explicit migration required");
    const matching = records.find((record) => record.publicKeyHex.toLowerCase() === legacy.publicKeyHex.toLowerCase() && record.label === legacy.label);
    if (!matching) throw new Error("Legacy catalog KeyHold records do not match the committed Hold snapshot; explicit migration required");
    const unlocked = await keyholdUnlock(keyholdParse(keyholdSerialize(legacy.keyholdDocument)), password);
    try {
      if (unlocked.publicKeyHex.toLowerCase() !== legacy.publicKeyHex.toLowerCase()) throw new Error("Legacy catalog KeyHold public key mismatch");
    } finally { unlocked.privateKey.fill(0); }
  }
  if (records.length === 0) {
    if (previousIndex.size > 0 || legacyKeyholdRecords.length > 0) {
      throw new StorageRuntimeError("storage_provider_error", "Catalog Key metadata exists while the committed Hold snapshot is empty");
    }
    // 空桶可以合法地拥有一个旧式“空 Vault” verifier（例如用户刚创建
    // 空 Vault 但尚未导入第一把 Key）。先验证它，再让上层统一收敛到
    // uninitialized；不能因为快照为空就把正确密码误报为损坏。
    if (existingMeta && !(await verifyPassword(password, existingMeta))) {
      throw new StorageRuntimeError("storage_identity_required", "Catalog bucket password does not match its Vault metadata");
    }
    return false;
  }
  // 先验证本机 verifier，再修改公开索引或删除旧副本；错误密码/错误
  // 元数据路径必须是纯读失败，不能留下半迁移状态。
  if (existingMeta && !(await verifyPassword(password, existingMeta))) {
    throw new StorageRuntimeError("storage_identity_required", "Catalog bucket password does not match its Vault metadata");
  }
  await index.replaceKeys(records);
  for (const legacy of legacyKeyholdRecords) await vaultRepository.deleteKeyAndSidecars(legacy.publicKeyHex);
  if (!existingMeta) {
    // Vault meta 只保存密码 verifier；它不再保存任何 KeyHold 私钥文档。
    await vaultRepository.putMeta(await createCatalogVaultMeta(password));
  }
  coordinatorState.vaultStatus = "locked";
  coordinatorState.activePublicKeyHex = undefined;
  coordinatorMeta.selectedPublicKeyHex = records[0]!.publicKeyHex;
  coordinatorMeta.generation = coordinatorState.keyspaceGeneration;
  await persistCoordinatorMeta();
  publishSessionState("bootstrap");
  return true;
}

/** 当前新版桶的跨目录/桶内全量改密；失败时尽量回到旧 Hold 提交头。 */
async function changeSelectedCatalogBucketPassword(oldPassword: string, newPassword: string): Promise<import("@keymaster/contracts").StorageBucketPasswordRotationResultV1> {
  const entry = selectedCatalogBucket();
  const provider = platformBucketProvider;
  const root = platformRootStore;
  if (!entry || !provider || !root) throw new StorageRuntimeError("storage_unavailable", "The selected bucket is not available");
  if (entry.backend !== provider.provider || entry.bucketId !== provider.bucketId || root.bucket.bucketId !== entry.bucketId || root.bucket.provider !== entry.backend) {
    throw new StorageRuntimeError("storage_unavailable", "The selected bucket binding is stale");
  }
  if (oldPassword.length < 8 || newPassword.length < 8) throw new Error("Bucket password must contain at least 8 characters");
  if (oldPassword === newPassword) throw new Error("The new bucket password must be different");

  const repository = createStorageHoldSnapshotRepository(provider);
  const previous = await repository.readCommitted();
  // 新版目录桶的 KeyRecord 只存在 Hold 快照；`keys/` 只保留公开索引和
  // verifier 元数据。若仍有旧 KeyHold 副本，说明尚未完成显式迁移，不能
  // 在改密时任选一套作为真值。
  const previousMeta = await getVaultMeta();
  const legacyRecords = await vaultKeyRepository.listKeys();
  if (legacyRecords.length > 0) throw new Error("Catalog bucket contains legacy KeyHold records; explicit migration is required");
  if (previousMeta && !(await verifyPassword(oldPassword, previousMeta))) throw new Error("Bucket password does not match its Vault metadata");
  const manager = createStorageBucketManagementService();
  let updated: StorageBucketCatalogEntryV2 | undefined;
  let publishedHeadEtag: string | undefined;
  let catalogCandidate: StorageBucketCatalogEntryV2 | undefined;
  let catalogUpdated: StorageBucketCatalogEntryV2 | undefined;
  let vaultWriteAttempted = false;
  try {
    updated = await manager.changeBucketPassword({
      entry,
      provider,
      oldPassword,
      newPassword,
      bucketGeneration: root.bucket.bucketGeneration,
      persistCatalog: false
    });
    publishedHeadEtag = (await repository.readHead()).etag;
    // Vault meta 只承担“已有 Vault 的密码 verifier”职责。Key 密文已经
    // 由 manager 在上面的 Hold 快照中全部用新密码重加密；这里绝不能再
    // 生成/保存一份 KeyHold 文档。
    if (previousMeta) {
      vaultWriteAttempted = true;
      await vaultKeyRepository.putMeta(await createCatalogVaultMeta(newPassword));
    }
    // 目录更新也属于这次跨存储提交的一部分。页面桥在真正写入前会
    // 重新读取目录并校验 expectedBucket，不能让一个旧标签页覆盖新版本。
    catalogCandidate = { ...updated, updatedAt: Date.now() };
    catalogUpdated = await updateLocalStorageCatalogEntry(entry, catalogCandidate, root.bucket.bucketGeneration);
    updated = catalogUpdated;
    // 旋转成功后不能继续让内存中的旧密码保护会话运行；用户需用新桶
    // 密码重新进入，当前 Key 私钥和所有旧 owner 句柄一并释放。
    await performGlobalLock("bucket-password-change");
    storageBootstrapState = storageBootstrapState
      ? { ...storageBootstrapState, selectedBucket: updated }
      : null;
    return { ok: true, bucket: updated };
  } catch (error) {
    const rollbackErrors: string[] = [];
    // 桥请求可能在页面完成写入后才断开，不能仅依赖本地 boolean 判断；
    // 用新版条目做 expected 值尝试回滚，CAS 不匹配时安全地保持现状。
    if (catalogCandidate) {
      try {
        await updateLocalStorageCatalogEntry(catalogUpdated ?? catalogCandidate, entry, root.bucket.bucketGeneration, true);
      } catch (rollbackError) {
        rollbackErrors.push(`catalog: ${rollbackError instanceof Error ? rollbackError.message : "unknown error"}`);
      }
    }
    if (vaultWriteAttempted) {
      try {
        if (previousMeta) await vaultKeyRepository.putMeta(previousMeta);
        else await vaultKeyRepository.deleteMeta();
      } catch (rollbackError) {
        rollbackErrors.push(`Vault: ${rollbackError instanceof Error ? rollbackError.message : "unknown error"}`);
      }
    }
    if (publishedHeadEtag) {
      try {
        await repository.publish({
          document: previous.document,
          configRevision: previous.header.configRevision,
          bucketGeneration: root.bucket.bucketGeneration,
          expectedHeadEtag: publishedHeadEtag
        });
      } catch (rollbackError) {
        rollbackErrors.push(`Hold: ${rollbackError instanceof Error ? rollbackError.message : "unknown rollback error"}`);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new Error(`Bucket password rotation failed; rollback was not fully confirmed (${rollbackErrors.join("; ")})`);
    }
    throw error;
  }
}

function decodePersisted(value: string): Uint8Array {
  return cryptoHexToBytes(value);
}

interface CoordinatorMetaRecord {
  id: "singleton";
  selectedPublicKeyHex?: string;
  generation: number;
  scheduleSettings?: CoordinatorBackgroundSyncSettings;
  p2pkhProviders?: P2pkhProviderSettings;
  p2pkhProviderConfigs?: Record<string, Record<string, unknown>>;
  p2pkhSettings?: { includeTestnet: boolean };
  /** Coordinator 唯一插件意图；与运行实例状态分开持久化。 */
  pluginIntent?: PluginIntentSnapshot;
}
const coordinatorMeta: CoordinatorMetaRecord = { id: "singleton", generation: 0, scheduleSettings: { assetHoldingsIntervalMs: 900_000 } };
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
/**
 * 生产构建的 Worker URL 会随构建产物变化；把它作为升级门禁的 buildId，
 * 避免旧 Worker 只凭相同协议继续取得新一代 I/O 租约。
 */
// 正式构建由 scripts/build-plugin-lifecycle.mjs 注入不可变 buildId。
// 本地开发/单测没有构建注入时才回退到模块 URL；该回退不能用于发布证据。
const COORDINATOR_BUILD_ID = import.meta.env.VITE_KEYMASTER_BUILD_ID ?? import.meta.url;
// SharedWorker 的物理身份由脚本 URL 与 name 共同决定。相同身份的新模块
// 实例开始执行，就证明旧实例已经终止；只用 buildId 无法排除同一产物以
// 不同 URL/name 并存。旧 authority 没有此字段时必须继续 fail closed。
const COORDINATOR_WORKER_IDENTITY = JSON.stringify([
  import.meta.url,
  typeof (globalThis as typeof globalThis & { name?: unknown }).name === "string"
    ? (globalThis as typeof globalThis & { name: string }).name
    : "",
]);
const COORDINATOR_UPGRADE_PARTITION = "coordinator-upgrade";
const COORDINATOR_UPGRADE_KEY = "authority";
const COORDINATOR_AUTHORITY_CAS_TIMEOUT_MS = 5_000;
const COORDINATOR_UPGRADE_PROTOCOL_VERSION = COORDINATOR_SERVICE_PROTOCOL_VERSION;

interface CoordinatorAuthorityRecord {
  /** 记录格式版本，便于未来迁移而不把未知值当成当前权威。 */
  version: 1;
  /** 当前 Coordinator Worker 启动身份。 */
  authorityInstanceId: string;
  /** 跨 Worker 单调递增的接管世代。 */
  handoverGeneration: number;
  /** 当前 Worker 构建产物标识。 */
  buildId: string;
  /** 当前升级控制协议版本。 */
  protocolVersion: string;
  /** 精确 SharedWorker 身份；旧记录缺失时不允许自动清除写租约。 */
  workerIdentity?: string;
  /** 当前权威已经进入最终读写边界、尚未释放的持久 lease。 */
  activeIoLeases: Record<string, {
    operation: "read" | "write";
    acquiredAt: number;
    /** 固定的最终 I/O 入口名，只用于恢复对账；不包含业务参数。 */
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
/** 旧 Worker 的最终 I/O 尚未释放时，向页面公开的脱敏恢复状态。 */
let coordinatorAuthorityRecovery: CoordinatorAuthorityRecovery | undefined;
/** 当前恢复失败对应的固定 I/O 入口名；只用于定位现场阻塞。 */
let coordinatorAuthorityRecoveryOperationNames: string[] = [];
let coordinatorAuthorityClaimTail: Promise<void> = Promise.resolve();
/**
 * 同一 SharedWorker 内的 authority 读改写互斥。
 *
 * K-V store 自身只会串行提交单次 put，但 authority 的 revision 是先读再
 * CAS 写入；Host/Identify 连续签名时，多个请求仍可能拿到同一个旧 revision。
 * 这把锁只覆盖本地 authority CAS，不替代跨 Worker 的持久 CAS。
 */
let coordinatorAuthorityMutationTail: Promise<void> = Promise.resolve();
/**
 * 同一 Coordinator 内的并发只读请求共用一个持久 read lease。
 *
 * 持久 lease 的作用是阻止其它 Worker 在本 Worker 仍有最终 I/O 时接管；
 * 它不要求每个无副作用的 Stat 都对 authority K-V 做一次 CAS。每个请求
 * 仍保留自己的本地 UpgradeIoLease、epoch 检查和审计记录，只有跨 Worker
 * 的“本地仍有读请求”事实在共享记录中聚合，避免高频 Stat 把 authority
 * 存储变成串行性能瓶颈。
 */
interface CoordinatorSharedReadLease {
  durableLease: CoordinatorFinalIoLease;
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
const KEY_DELETION_JOURNAL_PREFIX = "deletion/";
let keyDeletionTail: Promise<void> = Promise.resolve();
interface KeyDeletionJournal {
  publicKeyHex: string;
  confirmationLabel: string;
  /** 删除事务阶段；每个阶段都必须先持久化再执行下一步。 */
  phase: "prepared" | "owner-fenced" | "requests-drained" | "owner-deleted" | "key-deleted" | "vault-finalized" | "complete";
}
const defaultP2pkhProviders = (): P2pkhProviderSettings => ({ main: { syncProviderId: "woc", broadcastProviderId: "woc" }, test: { syncProviderId: "woc", broadcastProviderId: "woc" }, generation: 0 });
let p2pkhRegistry: P2pkhProviderRegistry | undefined;
let p2pkhWocService: WocService | undefined;
let p2pkhJungleBusClient: ReturnType<typeof createJungleBusClient> | undefined;
let p2pkhProviderRevision = 0;
let testP2pkhBroadcastProvider: P2pkhTransactionBroadcastProvider | undefined;
let testPersistCoordinatorMetaFailure = false;
let platformRootStore: PlatformRootStore | undefined;
/** 当前统一抽象桶 Provider；所有 K-V 与文件运行时共用这一实例。 */
let platformBucketProvider: StorageBucketProvider | undefined;
/** Root 安装令牌；不能用 bucketGeneration 代替，因为 A→B→A 可能复用世代值。 */
let platformRootToken: object | undefined;
let platformKeysStore: KeyValueStore | undefined;
let platformStateStore: KeyValueStore | undefined;
/** 当前桶 protocol platform K-V；切桶回滚时必须保留旧句柄直到目标提交完成。 */
let platformProtocolStore: KeyValueStore | undefined;
let platformStorageReady = false;
let storageBootstrapState: StorageBootstrapState | null = null;
let storageBootstrapController: StorageBootstrapController | undefined;
const storageHealthController = new StorageHealthController();
/**
 * 某些 Storage control 会在成功/失败后撤销当前 Root。若控制请求本身
 * 仍持有最终 I/O lease，必须等 lease 的后置 authority 校验和释放完成后
 * 再销毁 Root，否则请求结果会被错误地变成 storage error。
 */
let catalogBindingDiscardDeferred = false;
/** 首次初始化暂存 Root 的所有权；失败事务不能触碰赢家的全局运行态。 */
let initialSetupRuntimeOwner: { transactionId: string; bucketId: string; rootToken: object } | undefined;
/** Worker 内缓存的公开恢复记录；权威副本由 Window bridge 持久化。 */
const initialSetupRecoveryRecords = new Map<string, InitialSetupRecoveryRecordV1>();
let coordinatorInitializationInProgress = false;
/** Storage Profile 独立密钥；与 Vault password/session 完全分离。 */
let storageProfileKey: CryptoKey | undefined;
let storageProfileSalt: Uint8Array | undefined;
/** 仅供下方 Worker test seam 使用；生产路径没有 active-key 密码缓存。 */
let testHarnessActivationSecret: string | undefined;
let storageRootInstallationActive = false;
let storageRecoveryOrchestrator: Promise<void> | undefined;
type WorkerOwnerStoreBinding = { close(): void; invalidateBinding(): void };
const workerOwnerStores = new Set<WorkerOwnerStoreBinding>();
const STORAGE_PROFILE_SALT_KEY = "storageProfileSaltHex";
const STORAGE_PROFILE_PARTITION = "storage-profile";
const STORAGE_PROFILE_KDF_DOMAIN = "keymaster.storage-profile.v2";

async function writeKeyDeletionJournal(journal: KeyDeletionJournal): Promise<void> {
  if (!platformKeysStore) throw new Error("Vault keys storage is unavailable");
  await platformKeysStore.put(`${KEY_DELETION_JOURNAL_PREFIX}${journal.publicKeyHex.toLowerCase()}`, journal, { partition: "deletion" });
}

async function removeKeyDeletionJournal(publicKeyHex: string): Promise<void> {
  await platformKeysStore?.delete(`${KEY_DELETION_JOURNAL_PREFIX}${publicKeyHex.toLowerCase()}`, { partition: "deletion" });
}

async function readKeyDeletionJournals(): Promise<KeyDeletionJournal[]> {
  const page = await platformKeysStore?.list({ partition: "deletion", prefix: KEY_DELETION_JOURNAL_PREFIX, limit: 1000 });
  return (page?.entries ?? []).map((entry) => entry.value as unknown as KeyDeletionJournal).filter((journal) =>
    typeof journal?.publicKeyHex === "string" && typeof journal?.confirmationLabel === "string" &&
    (journal.phase === "prepared" || journal.phase === "owner-fenced" || journal.phase === "requests-drained" || journal.phase === "owner-deleted" || journal.phase === "key-deleted" || journal.phase === "vault-finalized" || journal.phase === "complete")
  );
}

async function deriveStorageProfileKey(password: string, salt = storageProfileSalt): Promise<CryptoKey> {
  if (typeof password !== "string" || password.length < 8) {
    throw new Error("Storage Profile password must contain at least 8 characters");
  }
  if (!salt) throw new Error("Storage Profile salt is unavailable");
  // 独立域隔离：即使 Vault 和 Storage Profile 使用相同用户密码，二者
  // 也不会派生出同一把密钥。salt 只保存在平台 K-V，密码永不落盘。
  return deriveKey(`${STORAGE_PROFILE_KDF_DOMAIN}\0${password}`, salt);
}

async function setStorageProfilePassword(password: string): Promise<void> {
  storageProfileKey = await deriveStorageProfileKey(password);
}

/**
 * 以 partition revision CAS 初始化 Storage Profile salt。
 *
 * 多个 Coordinator Worker 可能同时首次安装同一个 Root；不能用“读取后
 * 无条件写入”，否则各 Worker 会各自派生出不同的 Profile 密钥，最终把
 * 先写入的密文变成不可恢复数据。竞争失败只重读，先成功写入的一方成为
 * 唯一盐值来源。
 */
async function loadOrCreateStorageProfileSalt(state: KeyValueStore): Promise<Uint8Array> {
  const maxAttempts = 8;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const persisted = await state.get<string>(STORAGE_PROFILE_SALT_KEY, { partition: STORAGE_PROFILE_PARTITION });
    if (persisted?.value && /^[0-9a-f]{32}$/u.test(persisted.value)) {
      return cryptoHexToBytes(persisted.value);
    }

    // 缺失值没有 entry revision；此时必须读取同一 partition 的当前头，
    // 再用 ifRevision 把“检查 + 创建”收敛成一次 CAS。
    const revision = persisted?.revision ?? (await state.list({ partition: STORAGE_PROFILE_PARTITION, limit: 1_000 })).revision;
    const generated = crypto.getRandomValues(new Uint8Array(16));
    try {
      await state.put(STORAGE_PROFILE_SALT_KEY, bytesToHex(generated), {
        partition: STORAGE_PROFILE_PARTITION,
        ifRevision: revision,
      });
      return generated;
    } catch (error) {
      if (!isStorageConflict(error)) throw error;
    }
  }
  throw storageUnavailableError("Storage Profile salt initialization conflicted repeatedly");
}

/**
 * 新版桶不再用桶密码派生 Storage Runtime 的上传临时密钥。该密钥只保护
 * 当前 Worker 会话内的 multipart upload id；它不是桶解密能力，Worker
 * 重启后自然失效，遗留上传记录按现有恢复逻辑报告并清理。
 */
async function createEphemeralStorageRuntimeKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

function createStorageRuntimeSecret(key: CryptoKey): { seal(scope: string, plaintext: Uint8Array): Promise<StorageSecretEnvelope>; open(scope: string, sealed: StorageSecretEnvelope): Promise<Uint8Array> } {
  return {
    async seal(scope: string, plaintext: Uint8Array): Promise<StorageSecretEnvelope> {
      const blob = await encryptBytesWithSaltBoundAad(key, plaintext, localSecretAad(scope));
      return { version: 2, saltHex: bytesToHex(blob.salt), nonceHex: bytesToHex(blob.iv), ciphertextHex: bytesToHex(blob.ciphertext) };
    },
    async open(scope: string, sealed: StorageSecretEnvelope): Promise<Uint8Array> {
      if (sealed.version !== 2) throw new Error("Unsupported sealed secret version");
      return decryptBytesWithSaltBoundAad(key, { salt: cryptoHexToBytes(sealed.saltHex), iv: cryptoHexToBytes(sealed.nonceHex), ciphertext: cryptoHexToBytes(sealed.ciphertextHex) }, localSecretAad(scope));
    }
  };
}

/** Storage-first：先验证抽象桶，再打开 keys/ 与平台状态区。 */
async function bootstrapPlatformStorage(profilePassword?: string): Promise<void> {
  if (platformRootStore) return;
  const hadPlatformRoot = Boolean(platformRootStore);
  storageBootstrapController?.dispose();
  const controller = new StorageBootstrapController({
    state: storageBootstrapState,
    health: storageHealthController,
    generation: 1,
    // localStorage 只存在 Window；Provider 的 bridge 不接收密码或明文
    // 私钥，页面在执行点重新校验当前桶和本地租约。
    local: { bridge: requestLocalStorageBridge },
    // 初次冷启动的 Vault metadata/Journal/任务还在上层初始化中，不能由
    // Provider probe 抢先发布 ready。健康探测定时器复用下面的回调，后续
    // 自动重试会重新安装 Root 并继续完整恢复。
    deferReady: true,
    // 初始 initialize 正在进行时只安装 Root；它完成 metadata/任务后再
    // 发布 ready。初始化失败后的自动重试则继续完整恢复编排。
    afterProviderReady: async () => {
      const provider = controller.getProvider();
      const bucket = controller.getBucket();
      if (!provider || !bucket) throw storageUnavailableError("Storage provider probe returned no bucket");
      if (!platformRootStore || platformBucketProvider !== provider) {
        if (platformRootStore && platformBucketProvider !== provider) {
          await releaseStorageRuntime("storage-root-rebind");
        }
        storageRootInstallationActive = true;
        try {
          await installPlatformStorage(provider, bucket, storageBootstrapState?.selectedBucket ? undefined : profilePassword);
        } finally {
          storageRootInstallationActive = false;
        }
      }
      if (coordinatorInitializationInProgress || storageRecoveryOrchestrator) return;
      await runStorageRecoveryOrchestrator();
    }
  });
  storageBootstrapController = controller;
  try {
    const bootstrap = await controller.bootstrap(profilePassword);
    if (!bootstrap.provider || !bootstrap.bucket || (bootstrap.status !== "checking" && bootstrap.status !== "ready")) {
      const error = new Error(bootstrap.message ?? "Storage bootstrap did not reach ready state") as Error & { code?: string };
      error.code = bootstrap.status === "authentication" ? "storage_identity_required" : "storage_unavailable";
      throw error;
    }
    // 正常情况下 afterProviderReady 已经完成 Root 安装。这个兜底只处理
    // 测试替换 callback 或未来控制器实现没有安装 Root 的情况。
    if (!platformRootStore) {
      storageRootInstallationActive = true;
      try {
        await installPlatformStorage(bootstrap.provider, bootstrap.bucket, storageBootstrapState?.selectedBucket ? undefined : profilePassword);
      } finally {
        storageRootInstallationActive = false;
      }
    }
  } catch (error) {
    // 首次 catalog 解锁在 afterProviderReady 之后还会继续恢复 Hold/Vault。
    // 如果这一步失败，StorageBootstrapController 只会释放自己的 provider；
    // 这里还必须撤销已经发布到 Worker 全局的候选 Root/句柄，避免遗留 S3
    // client 或让下一次重试误用已 disposed 的 Provider。
    if (!hadPlatformRoot && platformRootStore) discardCurrentPlatformStorageBinding();
    throw error;
  }
}

interface StagedCatalogBucket {
  entry: StorageBucketCatalogEntryV2;
  provider: StorageBucketProvider;
  bucket: StorageBucketRef;
  root: PlatformRootStore;
  rootToken: object;
  keys: KeyValueStore;
  state: KeyValueStore;
  protocol: KeyValueStore;
  storageRepository: Awaited<ReturnType<typeof openMultipartUploadRepository>>;
  runtime: StorageRuntimeController & { dispose?: () => void };
  storageProfileSalt: Uint8Array;
  storageProfileKey: CryptoKey;
  vaultRepository: VaultKeyRepository;
  coordinatorMeta: CoordinatorMetaRecord;
  vaultStatus: "uninitialized" | "locked";
  activePublicKeyHex?: string;
  activePrivateKeyBytes?: Uint8Array;
  /** 提交后才打开当前世代校验；暂存期允许目标桶尚未 selected。 */
  publish(): void;
}

function sameStorageKeyDerivation(left: StorageKeyDerivationV1, right: StorageKeyDerivationV1): boolean {
  return left.algorithm === right.algorithm
    && left.passwordEncoding === right.passwordEncoding
    && left.iterations === right.iterations
    && left.outputLengthBits === right.outputLengthBits
    && left.saltB64Url === right.saltB64Url;
}

function createCatalogProviderFromConnection(
  config: StorageBucketConnectionConfigV1,
  bucketId: string,
  bucketGeneration = 1,
  candidateBucket?: LocalStorageBridgeCandidateBucket,
): StorageBucketProvider {
  if (config.kind === "local") {
    return createLocalStorageBucketProvider({
      bucketId,
      bucketGeneration,
      bridge: requestLocalStorageBridge,
      ...(candidateBucket ? { candidateBucket } : {}),
    });
  }
  const normalized = normalizeProviderConfig({
    providerId: "s3-compatible",
    connection: {
      endpoint: config.endpoint,
      region: config.region,
      bucket: config.bucket,
      forcePathStyle: config.forcePathStyle === true,
      ...(config.sessionToken === undefined ? {} : { sessionToken: config.sessionToken }),
      ...(config.prefix === undefined ? {} : { prefix: config.prefix }),
    },
    credentials: {
      mode: "replace",
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  return createS3BucketProvider(normalized, { bucketId });
}

async function createCatalogProviderForSwitch(
  input: StorageBucketCatalogEntryV2,
  password: string,
  bucketGeneration: number,
  expectedSelectedBucketId?: string,
  cleanupOnly = false,
): Promise<StorageBucketProvider> {
  const entry = validateStorageCatalog({ format: "keymaster.storage.catalog", version: 2, buckets: [input] }).buckets[0]!;
  if (entry.backend === "local") {
    const candidateBucket: LocalStorageBridgeCandidateBucket = {
      bucket: entry,
      ...(expectedSelectedBucketId === undefined ? {} : { expectedSelectedBucketId }),
      bucketGeneration,
      ...(expectedSelectedBucketId === undefined ? { initialSetup: true } : {}),
      ...(cleanupOnly ? { cleanupOnly: true } : {}),
    };
    return createLocalStorageBucketProvider({
      bucketId: entry.bucketId,
      bucketGeneration,
      bridge: (request) => request.type === "catalog-update" || request.type === "catalog-select" || request.type === "catalog-commit"
        ? requestLocalStorageBridge(request)
        : request.type === "get" || request.type === "list" || request.type === "put" || request.type === "delete"
          ? requestLocalStorageBridge({ ...request, candidateBucket })
          : Promise.reject(new StorageRuntimeError("storage_provider_error", "Local storage candidate request is invalid")),
    });
  }
  if (!password) throw new StorageRuntimeError("storage_identity_required", "Bucket password is required");
  const context = await deriveBucketCryptoContext(password, entry.keyDerivation);
  try {
    const config = await decryptBucketConfig(entry.encryptedConfig, context);
    if (config.kind !== "s3") throw new StorageRuntimeError("storage_provider_error", "S3 bucket configuration is invalid");
    return (await import("@keymaster/platform-storage/coordinator")).createS3BucketProvider({
      version: 1,
      providerId: "s3-compatible",
      connection: {
        endpoint: config.endpoint,
        region: config.region,
        bucket: config.bucket,
        forcePathStyle: config.forcePathStyle === true,
        ...(config.sessionToken === undefined ? {} : { sessionToken: config.sessionToken }),
        ...(config.prefix === undefined ? {} : { prefix: config.prefix }),
      },
      credentials: { kind: "access-key", accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    }, { bucketId: entry.bucketId });
  } finally {
    context.dispose();
  }
}

async function createCatalogVaultMeta(password: string): Promise<VaultMetaRecord> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const passwordKey = await deriveKey(password, salt);
  const verifier = await encryptVerifier(passwordKey);
  return buildVaultMeta({ salt, verifier });
}

/**
 * 在目标 Root 中完成 Hold、Vault 索引和目标 Key 的认证；此函数不改变
 * Coordinator 全局仓库或会话状态。目标 Local 桶的物理 I/O 通过候选桥接
 * 范围完成，目录仍然保持旧桶 selected，直到外层 CAS 最后一步。
 */
async function stageCatalogVaultSession(
  entry: StorageBucketCatalogEntryV2,
  provider: StorageBucketProvider,
  keysStore: KeyValueStore,
  stateStore: KeyValueStore,
  password: string,
): Promise<Pick<StagedCatalogBucket, "vaultRepository" | "coordinatorMeta" | "vaultStatus" | "activePublicKeyHex" | "activePrivateKeyBytes">> {
  const repository = createStorageHoldSnapshotRepository(provider);
  let committed: Awaited<ReturnType<typeof repository.readCommitted>> | undefined;
  try {
    committed = await repository.readCommitted();
  } catch (error) {
    // 新建桶在目录中已经存在，但尚未有任何 Key/快照时，切换仍应能
    // 进入该空桶。缺少快照只在“目标 keys/ 也为空、没有 Vault meta”时
    // 表示 uninitialized；其它情况一律拒绝，避免把损坏桶当成空桶。
    if (!(error instanceof StorageRuntimeError) || error.code !== "storage_not_found") throw error;
  }
  if (committed && (committed.header.configRevision !== entry.configRevision
    || !sameStorageKeyDerivation(committed.header.keyDerivation, entry.keyDerivation)
    || !sameStorageRecord(committed.storage, entry.encryptedConfig)
    || committed.bucketGeneration < 1)) {
    throw new StorageRuntimeError("storage_provider_error", "Storage Hold snapshot does not match the target bucket catalog");
  }
  const targetVault = createVaultKeyRepository(keysStore);
  const targetIndex = createStorageCatalogKeyIndexRepository(keysStore);
  const existingMeta = await targetVault.getMeta();
  const legacyKeyholdRecords = await targetVault.listKeys();
  const existingIndex = new Map((await targetIndex.listKeys()).map((record) => [record.publicKeyHex.toLowerCase(), record]));
  if (!committed) {
    if (existingMeta || legacyKeyholdRecords.length > 0 || existingIndex.size > 0) {
      throw new StorageRuntimeError("storage_provider_error", "Target bucket has Key metadata but its Hold snapshot is missing; explicit migration is required");
    }
    const context = await deriveBucketCryptoContext(password, entry.keyDerivation);
    try {
      // Local 桶没有外部 Provider 探测可以替代密码认证；即使是空桶，
      // 也必须证明本次输入确实能解开目录中的桶配置密文。
      await decryptBucketConfig(entry.encryptedConfig, context);
    } finally {
      context.dispose();
    }
    const targetCoordinatorMeta: CoordinatorMetaRecord = {
      ...structuredClone(coordinatorMeta),
      selectedPublicKeyHex: undefined,
      generation: 0,
    };
    await stateStore.put("meta", targetCoordinatorMeta, { partition: "coordinator" });
    return {
      vaultRepository: targetVault,
      coordinatorMeta: targetCoordinatorMeta,
      vaultStatus: "uninitialized",
    };
  }
  const context = await deriveBucketCryptoContext(password, entry.keyDerivation);
  const snapshotRecords: StorageCatalogKeyIndexRecordV1[] = [];
  let activePrivateKeyBytes: Uint8Array | undefined;
  try {
    await verifyBucketDocument(committed.document, context);
    const config = await decryptBucketConfig(committed.storage, context);
    if ((config.kind === "local" ? "local" : "s3") !== entry.backend) throw new StorageRuntimeError("storage_provider_error", "Target bucket configuration backend does not match its catalog");
    for (const key of committed.document.keys) {
      const plain = await decryptBucketKey(key, context);
      try {
        snapshotRecords.push(catalogIndexFromHoldKey(plain, existingIndex.get(plain.publicKeyHex.toLowerCase())));
      } finally {
        plain.privateKey.fill(0);
      }
    }
  } finally {
    context.dispose();
  }

  if (existingMeta && !(await verifyPassword(password, existingMeta))) throw new StorageRuntimeError("storage_identity_required", "Target bucket Vault password does not match the bucket password");
  if (!existingMeta && legacyKeyholdRecords.length > 0) throw new StorageRuntimeError("storage_provider_error", "Target bucket has legacy KeyHold records without Vault metadata; explicit migration is required");
  // 旧版本的 catalog 桶可能已经有一份 KeyHold 副本。只有在它和已认证
  // 快照逐条一致、且每条旧文档都能用本桶密码解开时才允许一次性迁移。
  for (const legacy of legacyKeyholdRecords) {
    if (legacy.storageVersion !== "keyhold-v2" || !legacy.keyholdDocument) throw new StorageRuntimeError("storage_provider_error", "Target bucket contains an unsupported legacy KeyHold record");
    const matching = snapshotRecords.find((record) => record.publicKeyHex.toLowerCase() === legacy.publicKeyHex.toLowerCase() && record.label === legacy.label);
    if (!matching) throw new StorageRuntimeError("storage_provider_error", "Legacy catalog KeyHold records do not match the committed Hold snapshot; explicit migration is required");
    const unlocked = await keyholdUnlock(keyholdParse(keyholdSerialize(legacy.keyholdDocument)), password);
    try {
      if (unlocked.publicKeyHex.toLowerCase() !== legacy.publicKeyHex.toLowerCase()) throw new StorageRuntimeError("storage_provider_error", "Legacy catalog KeyHold public key mismatch");
    } finally { unlocked.privateKey.fill(0); }
  }
  // 空的、已初始化 Vault 是合法状态：例如用户删除了桶内最后一把
  // Key，但仍保留 Vault verifier。只有残留的旧 KeyHold 或索引才表示
  // 快照与桶内 Key 元数据不一致，需要显式迁移/修复。
  if (snapshotRecords.length === 0 && (legacyKeyholdRecords.length > 0 || existingIndex.size > 0)) {
    throw new StorageRuntimeError("storage_provider_error", "Target bucket has Key metadata but its Hold snapshot is empty");
  }
  await targetIndex.replaceKeys(snapshotRecords);
  for (const legacy of legacyKeyholdRecords) await targetVault.deleteKeyAndSidecars(legacy.publicKeyHex);

  let targetMeta = existingMeta;
  if (snapshotRecords.length > 0 && !targetMeta) {
    targetMeta = await createCatalogVaultMeta(password);
    await targetVault.putMeta(targetMeta);
  }

  const storedMeta = await stateStore.get<CoordinatorMetaRecord>("meta", { partition: "coordinator" });
  const targetCoordinatorMeta: CoordinatorMetaRecord = storedMeta?.value && storedMeta.value.id === "singleton" && Number.isSafeInteger(storedMeta.value.generation)
    ? structuredClone(storedMeta.value)
    : { ...coordinatorMeta, selectedPublicKeyHex: undefined, generation: 0 };
  const selected = snapshotRecords.find((record) => record.publicKeyHex.toLowerCase() === targetCoordinatorMeta.selectedPublicKeyHex?.toLowerCase()) ?? snapshotRecords[0];
  targetCoordinatorMeta.selectedPublicKeyHex = selected?.publicKeyHex;
  targetCoordinatorMeta.generation = Math.max(0, targetCoordinatorMeta.generation);
  await stateStore.put("meta", targetCoordinatorMeta, { partition: "coordinator" });

  if (selected) {
    const selectedKey = committed.document.keys.find((key) => key.publicKeyHex.toLowerCase() === selected.publicKeyHex.toLowerCase());
    if (!selectedKey) throw new StorageRuntimeError("storage_provider_error", "Target active Key is missing from its Hold snapshot");
    try {
      const selectedContext = await deriveBucketCryptoContext(password, entry.keyDerivation);
      try {
        const plain = await decryptBucketKey(selectedKey, selectedContext);
        try {
          activePrivateKeyBytes = plain.privateKey.slice();
          verifySessionKeyPair({ publicKeyHex: selected.publicKeyHex, privateKeyBytes: activePrivateKeyBytes });
        } finally {
          plain.privateKey.fill(0);
        }
      } finally {
        selectedContext.dispose();
      }
    } catch (error) {
      activePrivateKeyBytes?.fill(0);
      activePrivateKeyBytes = undefined;
      throw error;
    }
  }
  return {
    vaultRepository: targetVault,
    coordinatorMeta: targetCoordinatorMeta,
    vaultStatus: targetMeta ? "locked" : "uninitialized",
    ...(selected ? { activePublicKeyHex: selected.publicKeyHex } : {}),
    ...(selected && activePrivateKeyBytes ? { activePrivateKeyBytes } : {}),
  };
}

async function stageCatalogBucket(
  input: StorageBucketCatalogEntryV2,
  password: string,
  expectedSelectedBucketId: string | undefined,
  bucketGeneration: number,
  options: { provider?: StorageBucketProvider } = {},
): Promise<StagedCatalogBucket> {
  const entry = validateStorageCatalog({ format: "keymaster.storage.catalog", version: 2, buckets: [input] }).buckets[0]!;
  const ownsProvider = options.provider === undefined;
  const provider = options.provider ?? await createCatalogProviderForSwitch(entry, password, bucketGeneration, expectedSelectedBucketId);
  const rootToken = {};
  let candidatePublished = false;
  let keys: KeyValueStore | undefined;
  let state: KeyValueStore | undefined;
  let protocol: KeyValueStore | undefined;
  let storageStore: KeyValueStore | undefined;
  let storageRepository: Awaited<ReturnType<typeof openMultipartUploadRepository>> | undefined;
  let runtime: (StorageRuntimeController & { dispose?: () => void }) | undefined;
  let activePrivateKeyBytes: Uint8Array | undefined;
  try {
    const bucket: StorageBucketRef = Object.freeze({ bucketId: entry.bucketId, bucketGeneration, provider: entry.backend });
    const root = createPlatformRootStore({
      provider,
      bucket,
      isCurrent: ({ bucketGeneration: currentGeneration }) =>
        (candidatePublished ? platformRootToken === rootToken : true) && currentGeneration === bucketGeneration,
    });
    keys = await root.openPlatformKeysStore(1);
    state = await root.openPlatformStore({ applicationStorageId: "coordinator", schemaVersion: 1 });
    const storageProfileSalt = await loadOrCreateStorageProfileSalt(state);
    const storageProfileKey = await createEphemeralStorageRuntimeKey();
    protocol = await root.openPlatformStore({ applicationStorageId: "protocol", schemaVersion: 1 });
    storageStore = await root.openPlatformStore({ applicationStorageId: "storage", schemaVersion: 1 });
    storageRepository = await openMultipartUploadRepository(storageStore);
    storageStore = undefined;

    const stagedSession = await stageCatalogVaultSession(entry, provider, keys, state, password);
    activePrivateKeyBytes = stagedSession.activePrivateKeyBytes;
    runtime = await createStorageRuntimeController({
      multipartUploadRepository: storageRepository,
      bucketProvider: createOwnerLifecycleGuardedProvider(provider),
      bucketGeneration,
      secret: createStorageRuntimeSecret(storageProfileKey),
      logger: { warn: () => undefined },
    });
    return {
      entry,
      provider,
      bucket,
      root,
      rootToken,
      keys,
      state,
      protocol,
      storageRepository,
      runtime,
      storageProfileSalt,
      storageProfileKey,
      publish: () => { candidatePublished = true; },
      ...stagedSession,
    };
  } catch (error) {
    activePrivateKeyBytes?.fill(0);
    runtime?.dispose?.();
    if (!runtime) storageRepository?.close();
    storageStore?.close();
    protocol?.close();
    state?.close();
    keys?.close();
    if (ownsProvider) provider.dispose();
    throw error;
  }
}

type InitialSetupFailure = Extract<InitialSetupResult, { ok: false }>;
type InitialSetupPhase = NonNullable<InitialSetupFailure["error"]["phase"]>;

function initialSetupRecoveryRecord(input: {
  transactionId: string;
  bucketId: string;
  catalogEntryFingerprint?: string;
  configRevision: number;
  snapshotRevision: number;
  backend: "local" | "s3";
  connectionFingerprint?: string;
  phase: InitialSetupPhase;
  catalog: InitialSetupRecoveryRecordV1["catalog"];
  runtimeInstalled: boolean;
  cleanup: InitialSetupRecoveryRecordV1["cleanup"];
  status: InitialSetupRecoveryRecordV1["status"];
  success?: InitialSetupRecoverySuccessV1;
  error?: InitialSetupFailure["error"];
}): InitialSetupRecoveryRecordV1 {
  return {
    format: "keymaster.storage.initial-setup-recovery",
    version: 1,
    transactionId: input.transactionId,
    bucketId: input.bucketId,
    ...(input.catalogEntryFingerprint === undefined ? {} : { catalogEntryFingerprint: input.catalogEntryFingerprint }),
    configRevision: input.configRevision,
    snapshotRevision: input.snapshotRevision,
    backend: input.backend,
    ...(input.connectionFingerprint === undefined ? {} : { connectionFingerprint: input.connectionFingerprint }),
    phase: input.phase,
    catalog: input.catalog,
    runtimeInstalled: input.runtimeInstalled,
    cleanup: input.cleanup,
    status: input.status,
    ...(input.success === undefined ? {} : { success: structuredClone(input.success) }),
    ...(input.error === undefined ? {} : { error: structuredClone(input.error) }),
    updatedAt: Date.now(),
  };
}

async function loadInitialSetupRecoveryRecords(signal?: AbortSignal, peerId?: string): Promise<boolean> {
  try {
    const response = await requestLocalStorageBridge({ type: "initial-setup-recovery-list", signal }, peerId);
    if (response.type !== "initial-setup-recovery") return false;
    initialSetupRecoveryRecords.clear();
    for (const record of response.records) initialSetupRecoveryRecords.set(record.transactionId, structuredClone(record));
    return true;
  } catch (error) {
    if ((error as { code?: unknown })?.code === "service_reference_stale") throw error;
    // 恢复记录只用于恢复/诊断，不得把正常的未配置入口升级成 Fatal。
    // 但一旦账本读取失败，旧缓存也不能继续作为恢复事实使用；否则损坏
    // 账本可能被误判为空，或旧缓存可能继续允许危险的清理/新事务。
    initialSetupRecoveryRecords.clear();
    return false;
  }
}

async function listInitialSetupRecoveries(): Promise<InitialSetupRecoveryRecordV1[]> {
  const loaded = await loadInitialSetupRecoveryRecords();
  if (!loaded) throw new StorageRuntimeError("storage_unavailable", "Initial setup recovery records could not be read");
  return [...initialSetupRecoveryRecords.values()]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .map((record) => structuredClone(record));
}

async function persistInitialSetupRecoveryRecord(record: InitialSetupRecoveryRecordV1): Promise<void> {
  const response = await requestLocalStorageBridge({ type: "initial-setup-recovery-write", record });
  if (response.type !== "initial-setup-recovery") throw new StorageRuntimeError("storage_unavailable", "Initial setup recovery record could not be saved");
  initialSetupRecoveryRecords.clear();
  for (const persisted of response.records) initialSetupRecoveryRecords.set(persisted.transactionId, structuredClone(persisted));
}

async function readInitialSetupCatalog(): Promise<StorageCatalogV2> {
  const response = await requestLocalStorageBridge({ type: "catalog-read" });
  if (response.type !== "catalog-state") throw new StorageRuntimeError("storage_unavailable", "Storage catalog bridge returned an invalid read result");
  return response.catalog;
}

function recoverySuccessFromResult(bucket: StorageBucketCatalogEntryV2, result: Extract<InitialSetupResult, { ok: true }>): InitialSetupRecoverySuccessV1 {
  return {
    bucketLabel: bucket.label,
    publicKeyHex: result.firstKey.publicKeyHex,
    label: result.firstKey.label,
    address: result.firstKey.address,
    format: result.firstKey.format,
    capabilities: [...result.firstKey.capabilities],
    createdAt: result.firstKey.createdAt,
    ...(result.firstKey.source === undefined ? {} : { source: result.firstKey.source }),
  };
}

function initialSetupRecoveryUnavailable(
  record: InitialSetupRecoveryRecordV1,
  reason: string,
  details: unknown,
): InitialSetupFailure {
  return initialSetupFailure(
    "runtime",
    new StorageRuntimeError("storage_conflict", reason),
    "not-started",
    record.transactionId,
    details,
  );
}

async function resultFromInitialSetupRecovery(record: InitialSetupRecoveryRecordV1): Promise<InitialSetupResult | undefined> {
  if (record.status === "failed" && record.error) return { ok: false, error: structuredClone(record.error) };
  if (record.status !== "succeeded" || !record.success) return undefined;
  const catalog = await readInitialSetupCatalog();
  const bucket = catalog.buckets.find((candidate) => candidate.bucketId === record.bucketId);
  if (!bucket
    || catalog.selectedBucketId !== record.bucketId
    || bucket.backend !== record.backend
    || bucket.configRevision !== record.configRevision
    || bucket.snapshotRevision !== record.snapshotRevision) {
    // 成功记录不能因为目录暂时不可验证而降级为“没有结果”，更不能让
    // executeInitialSetupOnce 继续执行一份新计划并生成第二把 Key。
    return initialSetupRecoveryUnavailable(
      record,
      "The recorded initial setup succeeded but its committed catalog entry could not be verified",
      { recovery: "succeeded-record-catalog-mismatch" },
    );
  }
  return {
    ok: true,
    bucket,
    firstKey: {
      publicKeyHex: record.success.publicKeyHex,
      label: record.success.label,
      address: record.success.address,
      format: record.success.format,
      capabilities: [...record.success.capabilities],
      createdAt: record.success.createdAt,
      ...(record.success.source === undefined ? {} : { source: record.success.source }),
    },
  };
}

function ownsInitialSetupRuntime(transactionId: string, rootToken: object | undefined): boolean {
  return rootToken !== undefined
    && initialSetupRuntimeOwner?.transactionId === transactionId
    && initialSetupRuntimeOwner.rootToken === rootToken
    && platformRootToken === rootToken;
}

type InitialSetupCatalogObservation =
  | { kind: "empty"; catalog: StorageCatalogV2 }
  | { kind: "own"; catalog: StorageCatalogV2 }
  | { kind: "competing"; catalog: StorageCatalogV2 }
  | { kind: "unknown"; error: unknown };

async function observeInitialSetupCatalog(entry: StorageBucketCatalogEntryV2): Promise<InitialSetupCatalogObservation> {
  try {
    const catalog = await readInitialSetupCatalog();
    if (catalog.buckets.length === 0 && catalog.selectedBucketId === undefined) return { kind: "empty", catalog };
    const own = catalog.selectedBucketId === entry.bucketId
      && catalog.buckets.length === 1
      && sameStorageCatalogEntry(catalog.buckets[0]!, entry);
    return own ? { kind: "own", catalog } : { kind: "competing", catalog };
  } catch (error) {
    return { kind: "unknown", error };
  }
}

function initialSetupBucketId(transactionId: string): string {
  // transactionId 是外部契约输入，不能通过有损替换/截断映射到物理命名空间；
  // 完整 SHA-256 保留确定性，同时把碰撞概率降到密码学可接受范围。
  const digest = bytesToHex(sha256Bytes(new TextEncoder().encode("keymaster.initial-setup-bucket.v1:" + transactionId)));
  return "setup-" + digest;
}

function initialSetupCatalogEntryFingerprint(entry: StorageBucketCatalogEntryV2): string {
  // 目录条目包含随机密文/盐，但字段语义固定；显式构造规范顺序，避免
  // structured clone 或 JSON 字段顺序变化导致旧格式兼容校验失效。
  const canonical = JSON.stringify({
    bucketId: entry.bucketId,
    label: entry.label,
    backend: entry.backend,
    configRevision: entry.configRevision,
    keyDerivation: {
      algorithm: entry.keyDerivation.algorithm,
      passwordEncoding: entry.keyDerivation.passwordEncoding,
      iterations: entry.keyDerivation.iterations,
      outputLengthBits: entry.keyDerivation.outputLengthBits,
      saltB64Url: entry.keyDerivation.saltB64Url,
    },
    encryptedConfig: {
      cipher: {
        algorithm: entry.encryptedConfig.cipher.algorithm,
        keyLengthBits: entry.encryptedConfig.cipher.keyLengthBits,
        ivB64Url: entry.encryptedConfig.cipher.ivB64Url,
        tagLengthBits: entry.encryptedConfig.cipher.tagLengthBits,
        ciphertextAndTagB64Url: entry.encryptedConfig.cipher.ciphertextAndTagB64Url,
      },
    },
    snapshotRevision: entry.snapshotRevision,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  });
  return bytesToHex(sha256Bytes(new TextEncoder().encode(`keymaster.initial-setup-catalog-entry.v1:${canonical}`)));
}

/**
 * 只绑定 S3 物理目标，不绑定任何访问秘密。恢复时必须用同一指纹验证
 * 重新输入的连接，避免把同名候选前缀误删到另一个 S3 bucket。
 */
function initialSetupConnectionFingerprint(connection: StorageBucketConnectionConfigV1): string | undefined {
  if (connection.kind !== "s3") return undefined;
  const endpoint = connection.endpoint.trim().replace(/\/+$/u, "") || connection.endpoint.trim();
  const target = JSON.stringify({
    endpoint,
    region: connection.region.trim(),
    bucket: connection.bucket.trim(),
    prefix: connection.prefix?.trim() ?? "",
    forcePathStyle: connection.forcePathStyle === true,
  });
  return bytesToHex(sha256Bytes(new TextEncoder().encode(`keymaster.initial-setup-target.v1:${target}`)));
}

function validateInitialSetupPlan(plan: InitialSetupPlan): void {
  if (!plan || typeof plan !== "object") throw new StorageRuntimeError("storage_provider_error", "Initial setup plan is invalid");
  if (!/^[A-Za-z0-9._:-]{8,128}$/u.test(plan.transactionId)) throw new StorageRuntimeError("storage_provider_error", "Initial setup transaction ID is invalid");
  if (!plan.bucketLabel.trim() || plan.bucketLabel.trim().length > 128) throw new StorageRuntimeError("storage_provider_error", "Initial setup bucket label is invalid");
  if (plan.backend !== "local" && plan.backend !== "s3") throw new StorageRuntimeError("storage_provider_error", "Initial setup backend is invalid");
  if (plan.connection.kind !== plan.backend) throw new StorageRuntimeError("storage_provider_error", "Initial setup connection backend is inconsistent");
  if (typeof plan.bucketPassword !== "string" || plan.bucketPassword.length < 8) throw new StorageRuntimeError("storage_identity_required", "Bucket password must contain at least 8 characters");
  if (!plan.firstKey || (plan.firstKey.kind !== "generate" && plan.firstKey.kind !== "import")) throw new StorageRuntimeError("storage_provider_error", "Initial setup Key kind is invalid");
  if (typeof plan.firstKey.label !== "string" || !plan.firstKey.label.trim() || plan.firstKey.label.trim().length > 128) throw new StorageRuntimeError("storage_provider_error", "Initial setup Key label is invalid");
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

async function deleteInitialSetupProviderObjects(provider: StorageBucketProvider): Promise<void> {
  // Provider 已经把 S3 prefix 或 Local bucketId 限定在本次候选命名空间；
  // 删除循环每次从头列举，避免删除对象后复用旧 cursor 跳过条目。
  for (let pass = 0; pass < 1024; pass += 1) {
    const page = await provider.list({ limit: 100 });
    if (page.objects.length === 0) return;
    for (const object of page.objects) {
      await provider.delete(object.path, object.etag ? { ifMatch: object.etag } : {});
    }
  }
  throw new StorageRuntimeError("storage_limit_exceeded", "Initial setup cleanup exceeded the object limit");
}

async function createInitialSetupEntry(plan: InitialSetupPlan): Promise<StorageBucketCatalogEntryV2> {
  const context = await createBucketCryptoContext(plan.bucketPassword);
  try {
    const encryptedConfig = await encryptBucketConfig(plan.connection, context);
    const keyDerivation = { ...context.keyDerivation } as StorageKeyDerivationV1;
    const now = Date.now();
    return {
      bucketId: initialSetupBucketId(plan.transactionId),
      label: plan.bucketLabel.trim(),
      backend: plan.backend,
      configRevision: 1,
      keyDerivation,
      encryptedConfig,
      snapshotRevision: 0,
      createdAt: now,
      updatedAt: now,
    };
  } finally {
    context.dispose();
  }
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
async function executeInitialSetupTransaction(plan: InitialSetupPlan): Promise<InitialSetupResult> {
  let phase: InitialSetupPhase = "validate";
  let entry: StorageBucketCatalogEntryV2 | undefined;
  let provider: StorageBucketProvider | undefined;
  let staged: StagedCatalogBucket | undefined;
  let catalogCommitted = false;
  let bindingAdopted = false;
  let cleanupConfirmed = true;
  let privateKey: Uint8Array | undefined;
  let adoptedRootToken: object | undefined;
  let recovery: InitialSetupRecoveryRecordV1 | undefined;
  let recoveryCatalog: InitialSetupRecoveryRecordV1["catalog"] = "not-started";
  let catalogDetachedForCleanup = false;
  const bucketGeneration = 1;
  const transactionId = typeof plan?.transactionId === "string" ? plan.transactionId : undefined;
  const saveRecovery = async (input: {
    phase: InitialSetupPhase;
    catalog?: InitialSetupRecoveryRecordV1["catalog"];
    runtimeInstalled?: boolean;
    cleanup?: InitialSetupRecoveryRecordV1["cleanup"];
    status?: InitialSetupRecoveryRecordV1["status"];
    success?: InitialSetupRecoverySuccessV1;
    error?: InitialSetupFailure["error"];
  }): Promise<void> => {
    if (!entry || !transactionId) return;
    recoveryCatalog = input.catalog ?? recoveryCatalog;
    recovery = initialSetupRecoveryRecord({
      transactionId,
      bucketId: entry.bucketId,
      catalogEntryFingerprint: initialSetupCatalogEntryFingerprint(entry),
      configRevision: entry.configRevision,
      snapshotRevision: entry.snapshotRevision,
      backend: entry.backend,
      connectionFingerprint: recovery?.connectionFingerprint ?? initialSetupConnectionFingerprint(plan.connection),
      phase: input.phase,
      catalog: recoveryCatalog,
      runtimeInstalled: input.runtimeInstalled ?? recovery?.runtimeInstalled ?? false,
      cleanup: input.cleanup ?? recovery?.cleanup ?? "not-started",
      status: input.status ?? recovery?.status ?? "pending",
      ...(input.success === undefined ? {} : { success: input.success }),
      ...(input.error === undefined ? {} : { error: input.error }),
    });
    await persistInitialSetupRecoveryRecord(recovery);
  };
  try {
    validateInitialSetupPlan(plan);
    if (platformRootStore || storageBootstrapState?.selectedBucket || coordinatorState.vaultStatus === "unlocked" || coordinatorState.vaultStatus === "locked") {
      throw new StorageRuntimeError("storage_conflict", "Storage is already initialized");
    }
    phase = "stage";
    entry = await createInitialSetupEntry(plan);
    await saveRecovery({ phase, catalog: "not-started", cleanup: "not-started", status: "pending" });
    privateKey = await privateKeyForInitialSetup(plan.firstKey);
    const publicKeyHex = bytesToHex((await import("@noble/curves/secp256k1.js")).secp256k1.getPublicKey(privateKey, true)).toLowerCase();
    const keyFormat = initialSetupKeyFormat(plan.firstKey);
    const keyCapabilities = [...plan.firstKey.capabilities];
    const keySource = plan.firstKey.kind === "import" ? plan.firstKey.source : undefined;
    const keyCreatedAt = new Date().toISOString();
    // 暂存阶段需要写入 Hold/Vault；只有回滚清理时才会重新创建
    // cleanupOnly Provider，避免并发赢家提交后失败事务仍持有写权限。
    provider = await createCatalogProviderForSwitch(entry, plan.bucketPassword, bucketGeneration);

    phase = "hold";
    await saveRecovery({ phase });
    const context = await deriveBucketCryptoContext(plan.bucketPassword, entry.keyDerivation);
    let committed: Awaited<ReturnType<ReturnType<typeof createStorageHoldSnapshotRepository>["publish"]>>;
    try {
      const encryptedKey = await encryptBucketKey({ label: plan.firstKey.label.trim(), privateKey }, context);
      const document = await sealBucketDocument(entry.encryptedConfig, [encryptedKey], context);
      committed = await createStorageHoldSnapshotRepository(provider).publish({
        document,
        configRevision: entry.configRevision,
        bucketGeneration,
      });
    } finally {
      context.dispose();
    }
    privateKey.fill(0);
    privateKey = undefined;
    entry = { ...entry, snapshotRevision: committed.header.snapshotRevision };
    await saveRecovery({ phase, catalog: "not-started" });
    // Hold 发布会把 snapshotRevision 写回目录条目；Local Provider 在创建时
    // 捕获了候选目录快照，因此必须在进入 Vault/Root 暂存前换成带最新
    // revision 的候选 Provider。否则目录 commit 后页面桥会把后续 I/O
    // 误判成“候选条目已失效”。旧 Provider 仍保留到新 Provider 创建成功，
    // 这样新建 Provider 失败时，下面的回滚清理仍能访问已写入的 Hold。
    const refreshedProvider = await createCatalogProviderForSwitch(entry, plan.bucketPassword, bucketGeneration);
    provider.dispose();
    provider = refreshedProvider;

    phase = "stage";
    await saveRecovery({ phase });
    staged = await stageCatalogBucket(entry, plan.bucketPassword, undefined, bucketGeneration, { provider });
    // Hold KeyRecord 只携带加密私钥和 label；格式、来源、能力属于公开展示
    // 索引，必须在暂存 Root 内一次性写成首 Key 的真实元数据，不能让
    // stageCatalogVaultSession 的兼容默认值（keymaster-hold）泄漏到成功结果。
    await createStorageCatalogKeyIndexRepository(staged.keys).replaceKeys([{
      format: "keymaster.storage.catalog-key-index",
      publicKeyHex,
      label: plan.firstKey.label.trim(),
      address: deriveP2pkhAddress(publicKeyHex, "main"),
      network: "main",
      keyFormat,
      capabilities: keyCapabilities,
      createdAt: keyCreatedAt,
      ...(keySource === undefined ? {} : { source: keySource }),
    }]);
    provider = undefined;

    phase = "catalog-commit";
    await saveRecovery({ phase, catalog: "not-started" });
    const selected = await commitInitialStorageCatalogBucket(entry, bucketGeneration);
    catalogCommitted = true;
    await saveRecovery({ phase, catalog: "committed" });

    phase = "runtime";
    await saveRecovery({ phase, catalog: "committed" });
    const nextKeyspaceGeneration = Math.max(coordinatorState.keyspaceGeneration + 1, staged.coordinatorMeta.generation + 1);
    staged.coordinatorMeta.generation = nextKeyspaceGeneration;
    staged.coordinatorMeta.selectedPublicKeyHex = staged.activePublicKeyHex;
    adoptStagedCatalogBinding(staged);
    bindingAdopted = true;
    adoptedRootToken = staged.rootToken;
    initialSetupRuntimeOwner = { transactionId: plan.transactionId, bucketId: entry.bucketId, rootToken: staged.rootToken };
    storageBootstrapState = {
      ...(storageBootstrapState ?? { selectedBackend: selected.backend }),
      selectedBackend: selected.backend,
      selectedProfileId: selected.bucketId,
      selectedBucket: selected,
    };
    replaceCoordinatorMeta(staged.coordinatorMeta);
    coordinatorState.keyspaceGeneration = nextKeyspaceGeneration;
    coordinatorState.sessionEpoch = generateEpoch();
    coordinatorState.vaultStatus = staged.vaultStatus;
    coordinatorState.activePublicKeyHex = undefined;
    coordinatorState.autoLockDeadline = undefined;
    await persistCoordinatorMeta();
    if (coordinatorState.taskRuntimes.size === 0) await registerCoordinatorTasks();
    activateCoordinatorRootWorkerUnits();
    const activePrivateKeyBytes = staged.activePrivateKeyBytes;
    staged.activePrivateKeyBytes = undefined;
    if (!staged.activePublicKeyHex || !activePrivateKeyBytes) throw new StorageRuntimeError("storage_provider_error", "Initial setup active Key is unavailable");
    await enterUnlockedState(staged.activePublicKeyHex, activePrivateKeyBytes, "create-initial-key");
    storageHealthController.setStatus("ready");
    storageStartupFailure = false;
    emitStorageState();
    const firstKey = await currentCatalogKeyIndex().getKey(staged.activePublicKeyHex);
    if (!firstKey) throw new StorageRuntimeError("storage_provider_error", "Initial setup public Key index is unavailable");
    const result: Extract<InitialSetupResult, { ok: true }> = {
      ok: true,
      bucket: selected,
      firstKey: {
        publicKeyHex: firstKey.publicKeyHex,
        label: firstKey.label,
        address: firstKey.address ?? deriveP2pkhAddress(firstKey.publicKeyHex, "main"),
        format: firstKey.keyFormat,
        capabilities: [...firstKey.capabilities],
        createdAt: firstKey.createdAt,
        ...(firstKey.source === undefined ? {} : { source: firstKey.source }),
      },
    };
    await saveRecovery({ phase: "complete", catalog: "committed", runtimeInstalled: true, cleanup: "confirmed", status: "succeeded", success: recoverySuccessFromResult(selected, result) });
    return result;
  } catch (error) {
    const ownsRuntime = bindingAdopted && transactionId !== undefined && ownsInitialSetupRuntime(transactionId, adoptedRootToken);
    if (ownsRuntime && (coordinatorState.vaultStatus === "unlocked" || coordinatorState.activePublicKeyHex)) {
      await performGlobalLock("initial-setup-rollback").catch(() => undefined);
    }
    // 回滚前重新读取目录。并发赢家的目录不能被失败事务强行删除；
    // 只有精确命中自己的条目才发送幂等 rollback。只有确认目录已经
    // 撤销/为空/不含本候选条目后，才允许删除候选对象。
    if (entry) {
      const observation = await observeInitialSetupCatalog(entry);
      if (observation.kind === "own") {
        try {
          await commitInitialStorageCatalogBucket(entry, bucketGeneration, true);
          catalogCommitted = false;
          recoveryCatalog = "rolled-back";
          catalogDetachedForCleanup = true;
        } catch (rollbackError) {
          const afterRollback = await observeInitialSetupCatalog(entry);
          if (afterRollback.kind === "empty") {
            catalogCommitted = false;
            recoveryCatalog = "empty";
            catalogDetachedForCleanup = true;
          } else if (afterRollback.kind === "competing") {
            const stillReferenced = afterRollback.catalog.buckets.some((candidate) => candidate.bucketId === entry!.bucketId && sameStorageCatalogEntry(candidate, entry!));
            if (stillReferenced) {
              cleanupConfirmed = false;
              recoveryCatalog = "unknown";
            } else {
              // 另一个事务已赢得目录；这是 CAS 竞争，不是回滚未确认。
              catalogCommitted = false;
              recoveryCatalog = "competing";
              catalogDetachedForCleanup = true;
            }
          } else {
            cleanupConfirmed = false;
            recoveryCatalog = "unknown";
            void rollbackError;
          }
        }
      } else if (observation.kind === "empty") {
        recoveryCatalog = "empty";
        catalogDetachedForCleanup = true;
      } else if (observation.kind === "competing") {
        const stillReferenced = observation.catalog.buckets.some((candidate) => candidate.bucketId === entry!.bucketId && sameStorageCatalogEntry(candidate, entry!));
        recoveryCatalog = stillReferenced ? "unknown" : "competing";
        catalogDetachedForCleanup = !stillReferenced;
      } else {
        cleanupConfirmed = false;
        recoveryCatalog = "unknown";
      }
    } else {
      catalogDetachedForCleanup = true;
    }
    await saveRecovery({ phase: "rollback", catalog: recoveryCatalog, cleanup: cleanupConfirmed ? "not-started" : "unconfirmed", status: "pending" }).catch(() => undefined);
    let cleanupProvider = staged?.provider ?? provider;
    let cleanupProviderOwned = false;
    // Local bridge 在另一个事务赢得目录 CAS 后会拒绝普通候选 Provider。
    // 用同一条目重新申请只读/删除授权，清理范围仍被 bucketId 锁定，且
    // cleanupOnly 请求永远不能 put，避免“清理”路径反向污染赢家。
    if (entry && (recoveryCatalog === "competing" || recoveryCatalog === "unknown")) {
      try {
        const candidate = await createCatalogProviderForSwitch(entry, plan.bucketPassword, bucketGeneration, undefined, true);
        if (cleanupProvider && cleanupProvider !== staged?.provider) cleanupProvider.dispose();
        cleanupProvider = candidate;
        cleanupProviderOwned = true;
      } catch {
        // 继续使用已有 Provider；若目录已竞争，它会在第一次 list 时失败，
        // 最终按 rollback-unconfirmed 返回，不把清理误报成成功。
      }
    }
    if (cleanupProvider && catalogDetachedForCleanup) {
      try { await deleteInitialSetupProviderObjects(cleanupProvider); }
      catch (cleanupError) {
        cleanupConfirmed = false;
        await saveRecovery({ phase: "rollback", catalog: recoveryCatalog, cleanup: "unconfirmed", status: "pending" }).catch(() => undefined);
        void cleanupError;
      } finally {
        if (!staged || cleanupProviderOwned) cleanupProvider.dispose();
      }
    } else if (cleanupProvider) {
      cleanupConfirmed = false;
      await saveRecovery({ phase: "rollback", catalog: "unknown", cleanup: "unconfirmed", status: "pending" }).catch(() => undefined);
      if (!staged || cleanupProviderOwned) cleanupProvider.dispose();
    }
    if (ownsRuntime && catalogDetachedForCleanup) catalogBindingDiscardDeferred = true;
    // 已经接管到全局的 staged binding 由上面的 deferred discard 统一销毁，
    // 不在最终 I/O lease 内再次关闭同一组 Root/Provider。
    if (staged && !ownsRuntime) disposeStagedCatalogBucket(staged);
    if (ownsRuntime && catalogDetachedForCleanup) {
      if (initialSetupRuntimeOwner?.transactionId === transactionId) initialSetupRuntimeOwner = undefined;
      storageBootstrapState = null;
      coordinatorState.vaultStatus = "uninitialized";
      coordinatorState.activePublicKeyHex = undefined;
      dropActivePrivateKey();
      storageStartupFailure = false;
      storageHealthController.setStatus("unselected");
      emitStorageState();
    } else if (ownsRuntime) {
      storageStartupFailure = true;
      storageHealthController.setStatus("degraded", "Initial setup catalog rollback was not confirmed");
      emitStorageState();
    }
    const failure = initialSetupFailure(phase, error, cleanupConfirmed ? "confirmed" : "unconfirmed", transactionId, {
      catalog: recoveryCatalog,
      runtimeOwned: ownsRuntime,
    });
    await saveRecovery({ phase: "rollback", catalog: recoveryCatalog, cleanup: cleanupConfirmed ? "confirmed" : "unconfirmed", status: "failed", error: failure.error }).catch(() => undefined);
    return failure;
  } finally {
    privateKey?.fill(0);
    if (plan && typeof plan === "object") {
      plan.bucketPassword = "";
      if (plan.connection?.kind === "s3") {
        plan.connection.accessKeyId = "";
        plan.connection.secretAccessKey = "";
        plan.connection.sessionToken = undefined;
      }
      if (plan.firstKey?.kind === "import") {
        plan.firstKey.material.hex = "";
        plan.firstKey.material.wif = undefined;
      }
    }
  }
}

async function executeInitialSetupOnce(plan: InitialSetupPlan): Promise<InitialSetupResult> {
  const transactionId = plan && typeof plan === "object" && typeof plan.transactionId === "string"
    ? plan.transactionId
    : undefined;
  if (!transactionId) return executeInitialSetupTransaction(plan);
  const existing = initialSetupTransactions.get(transactionId);
  if (existing instanceof Promise) return existing;
  if (existing) return Promise.resolve(existing);
  const loaded = await loadInitialSetupRecoveryRecords();
  if (!loaded) {
    return initialSetupFailure(
      "runtime",
      new StorageRuntimeError("storage_unavailable", "The previous initialization transaction could not be checked for recovery"),
      "not-started",
      transactionId,
      { recovery: "recovery-records-unavailable" },
    );
  }
  const persisted = initialSetupRecoveryRecords.get(transactionId);
  if (persisted?.status === "succeeded" || persisted?.status === "failed") {
    const recovered = await resultFromInitialSetupRecovery(persisted);
    if (recovered) return recovered;
    if (persisted.status === "failed") {
      return initialSetupFailure(
        persisted.phase,
        new StorageRuntimeError("storage_provider_error", "The previous initialization transaction has no reconstructable result"),
        persisted.cleanup === "confirmed" ? "confirmed" : "unconfirmed",
        transactionId,
        { recovery: "missing-result" },
      );
    }
  } else if (persisted?.status === "pending") {
    return initialSetupFailure(
      persisted.phase,
      new StorageRuntimeError("storage_unavailable", "An earlier initialization transaction is still awaiting recovery"),
      "unconfirmed",
      transactionId,
      { recovery: "pending" },
    );
  }
  // 页面会在挂载时阻止新初始化，但 Worker 不能把这个安全边界交给
  // React：旧页面、第二个标签页或直接 RPC 都可能绕过页面状态。只要
  // 另一个事务仍 pending，或其清理没有 confirmed，就必须先恢复它。
  const blockingRecovery = [...initialSetupRecoveryRecords.values()]
    .filter((record) => record.transactionId !== transactionId)
    .filter((record) => record.status === "pending" || record.cleanup !== "confirmed")
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
  if (blockingRecovery) {
    return initialSetupFailure(
      "runtime",
      new StorageRuntimeError("storage_conflict", "Another initial setup transaction requires recovery before a new setup can begin"),
      "not-started",
      transactionId,
      {
        recovery: "another-transaction-requires-recovery",
        blockingTransactionId: blockingRecovery.transactionId,
        blockingStatus: blockingRecovery.status,
        blockingCleanup: blockingRecovery.cleanup,
      },
    );
  }
  const run = executeInitialSetupTransaction(plan).then((result) => {
    initialSetupTransactions.set(transactionId, result);
    return result;
  }, (error) => {
    initialSetupTransactions.delete(transactionId);
    throw error;
  });
  initialSetupTransactions.set(transactionId, run);
  return run;
}

function syntheticInitialSetupCleanupEntry(record: InitialSetupRecoveryRecordV1): StorageBucketCatalogEntryV2 {
  // Local 候选已经回滚出目录时，恢复记录只保留公开 bucketId；桥接层在
  // cleanupOnly 模式下不需要解密配置，使用一份结构合法的占位条目即可
  // 重新取得同 bucketId 的删除范围。S3 没有这条捷径，仍必须由调用方
  // 提供连接配置和密码。
  return {
    bucketId: record.bucketId,
    label: `recovery-${record.bucketId}`.slice(0, 128),
    backend: record.backend,
    configRevision: record.configRevision,
    keyDerivation: {
      algorithm: "pbkdf2-hmac-sha-256",
      passwordEncoding: "utf-8",
      iterations: 100_000,
      outputLengthBits: 256,
      saltB64Url: "AAAAAAAA",
    },
    encryptedConfig: {
      cipher: {
        algorithm: "aes-gcm",
        keyLengthBits: 256,
        ivB64Url: "AAAAAAAA",
        tagLengthBits: 128,
        ciphertextAndTagB64Url: "AA",
      },
    },
    snapshotRevision: record.snapshotRevision,
    createdAt: 0,
    updatedAt: 0,
  };
}

function recoveryErrorAfterCleanup(
  record: InitialSetupRecoveryRecordV1,
  rollback: "confirmed" | "unconfirmed",
  error: unknown,
  details?: unknown,
): InitialSetupFailure {
  if (record.error && rollback === "confirmed") {
    const previous = record.error;
    const message = "初始化候选数据已清理；可以修改表单后重新开始。";
    return {
      ok: false,
      error: {
        ...previous,
        summary: message,
        action: "修改表单后重新开始初始化。",
        rollback,
        diagnostic: buildDiagnosticText({
          phase: "rollback",
          code: previous.code,
          incidentId: previous.incidentId,
          rollback,
          occurredAt: new Date().toISOString(),
          redactionVersion: "diagnostic-v2",
          message,
          details: details ?? { previous: previous.code },
        }),
      },
    };
  }
  return initialSetupFailure("rollback", error, rollback, record.transactionId, details);
}

type InitialSetupCleanupInput = Extract<CoordinatorStorageControl, { type: "initial-setup-cleanup" }>;

async function retryInitialSetupCleanupTransaction(
  transactionId: string,
  input: InitialSetupCleanupInput,
): Promise<InitialSetupRecoveryResult> {
  const loaded = await loadInitialSetupRecoveryRecords();
  if (!loaded) return { status: "cleanup-required", error: initialSetupFailure("rollback", new StorageRuntimeError("storage_unavailable", "Initial setup recovery records are unavailable"), "unconfirmed", transactionId, { recovery: "recovery-records-unavailable" }).error };
  const current = initialSetupRecoveryRecords.get(transactionId);
  if (!current) return { status: "not-found" };

  // 成功事务只需返回可重建的公开结果；不要把同一 transactionId 当成
  // 新初始化再次执行，避免响应丢失时生成第二把 Key。
  if (current.status === "succeeded") {
    try {
      const result = await resultFromInitialSetupRecovery(current);
      return result?.ok
        ? { status: "setup-succeeded", result }
        : result?.error
          ? { status: "cleanup-required", error: result.error }
          : { status: "not-found" };
    } catch (error) {
      return { status: "cleanup-required", error: recoveryErrorAfterCleanup(current, "unconfirmed", error, { recovery: "succeeded-record-unreadable" }).error };
    }
  }
  if (current.status === "failed" && current.cleanup === "confirmed") {
    return { status: "cleanup-confirmed" };
  }

  const failRecovery = async (
    error: unknown,
    details: unknown,
    catalog: InitialSetupRecoveryRecordV1["catalog"] = current.catalog,
  ): Promise<InitialSetupRecoveryResult> => {
    const failure = recoveryErrorAfterCleanup(current, "unconfirmed", error, details);
    await persistInitialSetupRecoveryRecord({
      ...current,
      phase: "rollback",
      catalog,
      cleanup: "unconfirmed",
      status: "failed",
      error: failure.error,
    }).catch(() => undefined);
    return { status: "cleanup-required", error: failure.error };
  };

  let catalog: StorageCatalogV2;
  try {
    catalog = await readInitialSetupCatalog();
  } catch (error) {
    return failRecovery(error, { reason: "catalog-read-failed" });
  }
  const catalogEntry = catalog.buckets.find((candidate) => candidate.bucketId === current.bucketId);
  const expectedBucketId = initialSetupBucketId(current.transactionId);
  if (current.bucketId !== expectedBucketId && catalogEntry !== undefined) {
    const catalogEntryTrusted = current.catalogEntryFingerprint !== undefined
      && current.catalogEntryFingerprint === initialSetupCatalogEntryFingerprint(catalogEntry);
    if (!catalogEntryTrusted) {
      return failRecovery(
        new StorageRuntimeError("storage_conflict", "A legacy recovery record cannot verify the current catalog entry for its colliding bucket ID"),
        { reason: "legacy-bucket-id-collision-requires-manual-inspection", bucketId: current.bucketId },
        "competing",
      );
    }
  }
  if (catalogEntry && (catalogEntry.configRevision !== current.configRevision || catalogEntry.snapshotRevision !== current.snapshotRevision)) {
    return failRecovery(
      new StorageRuntimeError("storage_conflict", "A newer bucket entry uses this recovery bucket ID"),
      { reason: "recovery-entry-version-mismatch" },
      "competing",
    );
  }

  if (current.backend === "s3" && input.connection) {
    if (input.connection.kind !== "s3") {
      return failRecovery(new StorageRuntimeError("storage_provider_error", "Recovery connection backend does not match the transaction"), { reason: "recovery-backend-mismatch" });
    }
    if (!input.connection.accessKeyId || !input.connection.secretAccessKey) {
      return failRecovery(new StorageRuntimeError("storage_identity_required", "S3 cleanup requires Access Key ID and Secret Access Key"), { reason: "recovery-credentials-missing" });
    }
    const fingerprint = initialSetupConnectionFingerprint(input.connection);
    if (!current.connectionFingerprint || fingerprint !== current.connectionFingerprint) {
      return failRecovery(new StorageRuntimeError("storage_conflict", "The supplied S3 connection does not match the initialization transaction"), { reason: "recovery-connection-fingerprint-mismatch" });
    }
  } else if (current.backend === "s3" && !catalogEntry) {
    return failRecovery(
      new StorageRuntimeError("storage_identity_required", "S3 cleanup requires the original bucket connection"),
      { reason: "recovery record contains no credentials or connection configuration" },
    );
  }

  // 目录仍包含同一条目但已经不再 selected 时，不能把仍有权威引用的
  // 桶当成孤儿删除；必须先由用户/并发事务解决目录冲突。
  if (catalogEntry && catalog.selectedBucketId !== current.bucketId) {
    return failRecovery(
      new StorageRuntimeError("storage_conflict", "The recovery bucket is no longer the selected initialization bucket"),
      { reason: "recovery-entry-not-selected" },
      "competing",
    );
  }
  const cleanupEntry = catalogEntry ?? syntheticInitialSetupCleanupEntry(current);
  const generation = platformRootStore?.bucket.bucketGeneration ?? 1;
  let provider: StorageBucketProvider | undefined;
  let providerOwned = false;
  try {
    if (current.backend === "s3" && input.connection && (!catalogEntry || catalog.selectedBucketId !== current.bucketId)) {
      if (input.connection.kind !== "s3") throw new StorageRuntimeError("storage_provider_error", "Recovery connection backend does not match the transaction");
      provider = createCatalogProviderFromConnection(input.connection, current.bucketId, generation);
      providerOwned = true;
    } else {
      if (cleanupEntry.backend !== current.backend) throw new StorageRuntimeError("storage_provider_error", "Recovery bucket backend does not match the transaction");
      provider = await createCatalogProviderForSwitch(
        cleanupEntry,
        input.password ?? "",
        generation,
        undefined,
        true,
      );
      providerOwned = true;
    }

    // 目录仍精确指向本事务时，必须先 CAS 撤销权威引用；只有确认目录
    // 已为空/已竞争/已回滚后，才允许删除候选对象。
    const ownsCatalog = catalog.selectedBucketId === current.bucketId
      && catalogEntry !== undefined
      && catalog.buckets.length === 1
      && sameStorageCatalogEntry(catalogEntry, cleanupEntry);
    let catalogState: InitialSetupRecoveryRecordV1["catalog"] = current.catalog;
    let catalogDetached = false;
    if (ownsCatalog) {
      try {
        await commitInitialStorageCatalogBucket(cleanupEntry, generation, true);
        catalogState = "rolled-back";
        catalogDetached = true;
      } catch (rollbackError) {
        const after = await observeInitialSetupCatalog(cleanupEntry);
        if (after.kind === "empty") {
          catalogState = "empty";
          catalogDetached = true;
        } else if (after.kind === "competing") {
          const stillReferenced = after.catalog.buckets.some((candidate) => candidate.bucketId === current.bucketId && sameStorageCatalogEntry(candidate, cleanupEntry));
          if (!stillReferenced) {
            catalogState = "competing";
            catalogDetached = true;
          } else {
            return failRecovery(rollbackError, { catalog: "rollback-unconfirmed" }, "unknown");
          }
        } else {
          return failRecovery(rollbackError, { catalog: "rollback-unconfirmed" }, "unknown");
        }
      }
    } else if (catalog.selectedBucketId === undefined && catalog.buckets.length === 0) {
      catalogState = "empty";
      catalogDetached = true;
    } else if (catalog.selectedBucketId !== current.bucketId) {
      catalogState = "competing";
      catalogDetached = catalogEntry === undefined;
    }

    if (!catalogDetached) {
      return failRecovery(new StorageRuntimeError("storage_conflict", "The recovery bucket catalog reference could not be revoked"), { catalog: "rollback-unconfirmed" }, "unknown");
    }

    // 目录撤销和候选对象删除之间存在一个可观察的中间态。账本解析器
    // 不允许 pending 携带 error；这里必须先写成合法的 failed/unconfirmed
    // 记录，才能在删除失败或页面/Worker 重启后继续恢复，而不是把账本
    // 永久写成生产 bridge 会拒绝的组合。
    const cleanupStateError = current.error ?? initialSetupFailure(
      "rollback",
      new StorageRuntimeError("storage_provider_error", "Initialization candidate cleanup is awaiting object deletion"),
      "unconfirmed",
      current.transactionId,
      { recovery: "catalog-detached-before-cleanup" },
    ).error;
    await persistInitialSetupRecoveryRecord({
      ...current,
      phase: "rollback",
      catalog: catalogState,
      cleanup: "unconfirmed",
      status: "failed",
      error: cleanupStateError,
      updatedAt: Date.now(),
    });
    try {
      await deleteInitialSetupProviderObjects(provider);
    } catch (error) {
      return failRecovery(error, { catalog: catalogState, cleanup: "unconfirmed" }, catalogState);
    }
    const next: InitialSetupRecoveryRecordV1 = {
      ...current,
      phase: "rollback",
      catalog: catalogState,
      cleanup: "confirmed",
      status: "failed",
      error: cleanupStateError,
      updatedAt: Date.now(),
    };
    await persistInitialSetupRecoveryRecord(next);
    if (platformRootStore?.bucket.bucketId === current.bucketId && catalogState !== "competing") {
      catalogBindingDiscardDeferred = true;
      storageBootstrapState = null;
      coordinatorState.vaultStatus = "uninitialized";
      coordinatorState.activePublicKeyHex = undefined;
      dropActivePrivateKey();
      storageStartupFailure = false;
      storageHealthController.setStatus("unselected");
      emitStorageState();
    }
    return { status: "cleanup-confirmed" };
  } catch (error) {
    return failRecovery(error, { bucketId: current.bucketId });
  } finally {
    if (providerOwned) provider?.dispose();
    if (input.password !== undefined) input.password = "";
    if (input.connection?.kind === "s3") {
      input.connection.accessKeyId = "";
      input.connection.secretAccessKey = "";
      input.connection.sessionToken = undefined;
    }
  }
}

async function getInitialSetupResult(transactionId: string): Promise<InitialSetupResult | undefined> {
  const existing = initialSetupTransactions.get(transactionId);
  if (existing instanceof Promise) return existing;
  if (existing) return existing;
  const record = initialSetupRecoveryRecords.get(transactionId);
  if (record) return resultFromInitialSetupRecovery(record);
  await loadInitialSetupRecoveryRecords();
  const recovered = initialSetupRecoveryRecords.get(transactionId);
  return recovered ? resultFromInitialSetupRecovery(recovered) : undefined;
}

interface CurrentCatalogStorageBinding {
  provider?: StorageBucketProvider;
  root?: PlatformRootStore;
  rootToken?: object;
  keys?: KeyValueStore;
  state?: KeyValueStore;
  protocol?: KeyValueStore;
  storageRepository?: Awaited<ReturnType<typeof openMultipartUploadRepository>>;
  runtime?: StorageRuntimeController & { dispose?: () => void };
  storageProfileSalt?: Uint8Array;
  storageProfileKey?: CryptoKey;
  bootstrapController?: StorageBootstrapController;
}

function captureCurrentCatalogStorageBinding(): CurrentCatalogStorageBinding {
  return {
    provider: platformBucketProvider,
    root: platformRootStore,
    rootToken: platformRootToken,
    keys: platformKeysStore,
    state: platformStateStore,
    protocol: platformProtocolStore,
    storageRepository,
    runtime: storageRuntime as (StorageRuntimeController & { dispose?: () => void }) | undefined,
    storageProfileSalt,
    storageProfileKey,
    bootstrapController: storageBootstrapController,
  };
}

function replaceCoordinatorMeta(next: CoordinatorMetaRecord): void {
  const mutable = coordinatorMeta as unknown as Record<string, unknown>;
  for (const key of Object.keys(mutable)) {
    if (key !== "id") delete mutable[key];
  }
  Object.assign(coordinatorMeta, structuredClone(next));
  coordinatorMeta.scheduleSettings ??= { assetHoldingsIntervalMs: 900_000 };
  coordinatorMeta.p2pkhProviders ??= defaultP2pkhProviders();
  coordinatorMeta.p2pkhSettings ??= { includeTestnet: false };
}

function disposeStagedCatalogBucket(staged: StagedCatalogBucket): void {
  staged.activePrivateKeyBytes?.fill(0);
  staged.activePrivateKeyBytes = undefined;
  try { staged.runtime.dispose?.(); } catch { /* best effort */ }
  staged.protocol.close();
  staged.state.close();
  staged.keys.close();
  staged.provider.dispose();
}

function disposeCurrentCatalogBinding(binding: CurrentCatalogStorageBinding): void {
  try { binding.runtime?.dispose?.(); } catch { /* best effort */ }
  if (!binding.runtime) binding.storageRepository?.close();
  binding.protocol?.close();
  binding.state?.close();
  binding.keys?.close();
  if (binding.bootstrapController) binding.bootstrapController.dispose();
  else binding.provider?.dispose();
}

function discardCurrentPlatformStorageBinding(): void {
  const binding = captureCurrentCatalogStorageBinding();
  for (const store of workerOwnerStores) store.invalidateBinding();
  disposeCurrentCatalogBinding(binding);
  platformRootStore = undefined;
  platformBucketProvider = undefined;
  platformRootToken = undefined;
  platformKeysStore = undefined;
  platformStateStore = undefined;
  platformProtocolStore = undefined;
  storageRuntime = undefined;
  storageRepository = undefined;
  storageBootstrapController = undefined;
  storageProfileSalt = undefined;
  storageProfileKey = undefined;
  platformStorageReady = false;
}

function adoptStagedCatalogBinding(staged: StagedCatalogBucket): void {
  // 先切换 token，再打开候选 Root 的 current 检查；之后所有新 owner/K-V
  // 句柄都只能看见这一个目标绑定。候选 provider 在 CAS 前仍可读写目标
  // 命名空间，但不会被当前 Root 的旧 token 接受。
  platformRootToken = staged.rootToken;
  staged.publish();
  platformBucketProvider = staged.provider;
  platformRootStore = staged.root;
  platformKeysStore = staged.keys;
  platformStateStore = staged.state;
  platformProtocolStore = staged.protocol;
  storageRepository = staged.storageRepository;
  storageRuntime = staged.runtime;
  storageProfileSalt = staged.storageProfileSalt;
  storageProfileKey = staged.storageProfileKey;
  storageBootstrapController = undefined;
  configureVaultKeyRepository(staged.keys, { closePrevious: false });
  configureProtocolStorageRepository(staged.protocol, { closePrevious: false });
  staged.runtime.subscribe(emitStorageState);
  platformStorageReady = true;
  storageStartupFailure = false;
}

/**
 * 目标桶已经在独立 Root 中完成认证后，原子切换 Coordinator 和目录选项。
 * 目录 CAS 是最后一个跨上下文步骤；任何暂存/认证失败都不会触碰当前桶。
 */
async function switchSelectedCatalogBucket(
  targetInput: StorageBucketCatalogEntryV2,
  password: string,
): Promise<StorageBucketSwitchResultV1> {
  const currentEntry = selectedCatalogBucket();
  const currentBinding = captureCurrentCatalogStorageBinding();
  const previousVaultStatus = coordinatorState.vaultStatus;
  let previousActivePrivateKeyBytes = coordinatorState.activePrivateKeyBytes?.slice();
  const previousActivePublicKeyHex = coordinatorState.activePublicKeyHex;
  const wipePreviousActive = () => {
    previousActivePrivateKeyBytes?.fill(0);
    previousActivePrivateKeyBytes = undefined;
  };
  return (async (): Promise<StorageBucketSwitchResultV1> => {
  if (!currentEntry || !currentBinding.provider || !currentBinding.root || !currentBinding.rootToken) {
    wipePreviousActive();
    throw new StorageRuntimeError("storage_unavailable", "The current catalog bucket is not available");
  }
  if (!storageBootstrapState?.selectedBucket || storageBootstrapState.selectedBucket.bucketId !== currentEntry.bucketId) {
    wipePreviousActive();
    throw new StorageRuntimeError("storage_conflict", "The current storage bucket selection is stale");
  }
  const target = validateStorageCatalog({ format: "keymaster.storage.catalog", version: 2, buckets: [targetInput] }).buckets[0]!;
  if (target.bucketId === currentEntry.bucketId) {
    wipePreviousActive();
    throw new StorageRuntimeError("storage_conflict", "The target bucket is already selected");
  }
  if (password.length < 8) {
    wipePreviousActive();
    throw new StorageRuntimeError("storage_identity_required", "Bucket password must contain at least 8 characters");
  }

  const expectedSelectedBucketId = currentEntry.bucketId;
  const targetBucketGeneration = Math.max(1, currentBinding.root.bucket.bucketGeneration + 1);
  let staged: StagedCatalogBucket;
  try {
    staged = await stageCatalogBucket(target, password, expectedSelectedBucketId, targetBucketGeneration);
  } catch (error) {
    wipePreviousActive();
    throw error;
  }
  const targetWillUnlock = staged.vaultStatus === "locked"
    && Boolean(staged.activePublicKeyHex && staged.activePrivateKeyBytes);
  let catalogSelected = false;
  let catalogSelectAttempted = false;
  let bindingSwapped = false;
  try {
    // 先让旧会话进入 locked，并等待旧 owner 的真实请求排空；旧 Root/句柄
    // 在目标提交完成前仍保留，便于 CAS 失败时安全回到旧桶。
    await performGlobalLock(previousVaultStatus === "uninitialized" ? "recover-empty" : "bucket-switch");
    await waitForPendingOwnerStorageDrain();
    catalogSelectAttempted = true;
    const selected = await selectLocalStorageCatalogBucket(target, expectedSelectedBucketId, targetBucketGeneration);
    catalogSelected = true;

    const nextKeyspaceGeneration = Math.max(
      coordinatorState.keyspaceGeneration + 1,
      staged.coordinatorMeta.generation + 1,
    );
    staged.coordinatorMeta.generation = nextKeyspaceGeneration;
    if (staged.vaultStatus === "uninitialized") staged.coordinatorMeta.selectedPublicKeyHex = undefined;

    adoptStagedCatalogBinding(staged);
    bindingSwapped = true;
    // 测试专用故障点：模拟目标 Root/Provider 已经发布后，后续
    // Coordinator 初始化步骤失败。必须走下面完整的目录、绑定和会话回滚，
    // 不能因为“绑定已发布”就把半初始化目标留在全局状态里。
    if (testFailAfterCatalogBindingPublish) {
      testFailAfterCatalogBindingPublish = false;
      throw new Error("injected catalog binding initialization failure");
    }
    storageBootstrapState = {
      ...(storageBootstrapState ?? { selectedBackend: selected.backend }),
      selectedBackend: selected.backend,
      selectedProfileId: selected.bucketId,
      selectedBucket: selected,
    };
    replaceCoordinatorMeta(staged.coordinatorMeta);
    coordinatorState.keyspaceGeneration = nextKeyspaceGeneration;
    coordinatorState.sessionEpoch = generateEpoch();
    coordinatorState.vaultStatus = staged.vaultStatus;
    coordinatorState.activePublicKeyHex = undefined;
    coordinatorState.autoLockDeadline = undefined;
    await persistCoordinatorMeta();

    // Storage unit 是 root scopeKind；换 Root 时实例必须换代，不能让旧快照
    // 继续代表新桶。旧实例此刻还没有被销毁，失败回滚仍可重新装配。
    const oldStorageUnit = coordinatorWorkerUnitRegistry.get("storage.coordinator-worker");
    if (oldStorageUnit) coordinatorWorkerUnitRegistry.stop(oldStorageUnit.unitId, oldStorageUnit.instanceId);
    const targetStorageUnit = coordinatorWorkerUnitRegistry.activate("storage.coordinator-worker");
    coordinatorWorkerUnitRegistry.ready(targetStorageUnit.unitId, targetStorageUnit.instanceId);

    if (staged.vaultStatus === "locked" && staged.activePublicKeyHex && staged.activePrivateKeyBytes) {
      const activePrivateKeyBytes = staged.activePrivateKeyBytes;
      staged.activePrivateKeyBytes = undefined;
      await enterUnlockedState(staged.activePublicKeyHex, activePrivateKeyBytes, "unlock");
    } else {
      publishSessionState("bootstrap");
      publishTopicEvent("background.snapshot", {
        type: "background.snapshot.changed",
        sessionEpoch: coordinatorState.sessionEpoch,
        snapshots: getTaskSnapshots(),
      });
    }

    storageHealthController.setStatus("ready");
    emitStorageState();
    // 目标会话已经完成发布，旧 provider/Root 才可以释放。清理只影响旧
    // 句柄，不再参与当前 Coordinator 状态。
    disposeCurrentCatalogBinding(currentBinding);
    wipePreviousActive();
    return { ok: true, bucket: selected, vaultUnlocked: targetWillUnlock };
  } catch (error) {
    if (!bindingSwapped) {
      if (catalogSelected || catalogSelectAttempted) {
        try {
          await selectLocalStorageCatalogBucket(currentEntry, target.bucketId, currentBinding.root.bucket.bucketGeneration, target.bucketId);
        } catch (rollbackError) {
          disposeStagedCatalogBucket(staged);
          wipePreviousActive();
          throw new Error(`Bucket switch failed and directory rollback was not confirmed: ${rollbackError instanceof Error ? rollbackError.message : "unknown rollback error"}`);
        }
      }
      disposeStagedCatalogBucket(staged);
      // 暂存或目录 CAS 失败时，原桶目录没有切换；把刚才为排空旧
      // owner 做的 lock 逆向恢复，避免一次失败的切桶把用户无故踢回
      // 锁屏。恢复失败则保持 fail-closed，绝不重新暴露不完整私钥。
      if (previousVaultStatus === "unlocked" && previousActivePublicKeyHex && previousActivePrivateKeyBytes) {
        try {
          coordinatorState.vaultStatus = "locked";
          coordinatorState.activePublicKeyHex = undefined;
          dropActivePrivateKey();
          await enterUnlockedState(previousActivePublicKeyHex, previousActivePrivateKeyBytes, "unlock");
          previousActivePrivateKeyBytes = undefined;
        } catch (restoreError) {
          console.warn("[storage] failed to restore the previous bucket session", restoreError instanceof Error ? restoreError.message : String(restoreError));
        }
      }
      wipePreviousActive();
      throw error;
    }

    // 目标绑定已经发布但后续 owner/unit 初始化失败：先把目标会话锁死，
    // 再尝试把目录和 Coordinator 一起恢复到旧桶。失败时维持 fail-closed，
    // 不重新暴露旧私钥。
    try {
      if (coordinatorState.vaultStatus === "unlocked" || coordinatorState.activePublicKeyHex) {
        await performGlobalLock("bucket-switch-rollback");
      } else {
        closeCoordinatorUpgradeSession("Bucket switch rollback");
        coordinatorState.activePublicKeyHex = undefined;
        dropActivePrivateKey();
      }
      await waitForPendingOwnerStorageDrain();
    } catch (lockError) {
      console.warn("[storage] bucket switch rollback lock failed", lockError instanceof Error ? lockError.message : String(lockError));
    }

    let catalogRollbackError: unknown;
    if (catalogSelected) {
      try {
        await selectLocalStorageCatalogBucket(currentEntry, target.bucketId, currentBinding.root.bucket.bucketGeneration, target.bucketId);
      } catch (rollbackError) {
        catalogRollbackError = rollbackError;
      }
    }

    if (catalogRollbackError) {
      storageStartupFailure = true;
      storageHealthController.setStatus("degraded", "Bucket switch rollback could not restore the local catalog");
      emitStorageState();
      throw new Error(`Bucket switch failed; local catalog rollback was not confirmed: ${catalogRollbackError instanceof Error ? catalogRollbackError.message : "unknown rollback error"}`);
    }

    const targetUnit = coordinatorWorkerUnitRegistry.get("storage.coordinator-worker");
    if (targetUnit) coordinatorWorkerUnitRegistry.stop(targetUnit.unitId, targetUnit.instanceId);
    disposeStagedCatalogBucket(staged);

    // 保留单调递增的 keyspace generation；旧 Root 的旧 owner 不会因回滚
    // 重新获得有效句柄。旧桶回到 locked/uninitialized，用户可重新解锁。
    platformRootToken = currentBinding.rootToken;
    platformBucketProvider = currentBinding.provider;
    platformRootStore = currentBinding.root;
    platformKeysStore = currentBinding.keys;
    platformStateStore = currentBinding.state;
    platformProtocolStore = currentBinding.protocol;
    storageRepository = currentBinding.storageRepository;
    storageRuntime = currentBinding.runtime;
    storageProfileSalt = currentBinding.storageProfileSalt;
    storageProfileKey = currentBinding.storageProfileKey;
    storageBootstrapController = currentBinding.bootstrapController;
    configureVaultKeyRepository(currentBinding.keys!, { closePrevious: false });
    configureProtocolStorageRepository(currentBinding.protocol!, { closePrevious: false });
    storageBootstrapState = storageBootstrapState
      ? { ...storageBootstrapState, selectedBackend: currentEntry.backend, selectedProfileId: currentEntry.bucketId, selectedBucket: currentEntry }
      : { selectedBackend: currentEntry.backend, selectedProfileId: currentEntry.bucketId, selectedBucket: currentEntry };
    // 上面的 coordinatorMeta 目前仍是目标值；旧 locked 状态的 selected key
    // 只能从旧 Root 的 repository 公开读取，绝不尝试解密私钥或恢复 active。
    const oldMeta = await currentBinding.state?.get<CoordinatorMetaRecord>("meta", { partition: "coordinator" });
    replaceCoordinatorMeta(oldMeta?.value
      ? { ...oldMeta.value, generation: coordinatorState.keyspaceGeneration }
      : { id: "singleton", generation: coordinatorState.keyspaceGeneration });
    coordinatorState.vaultStatus = previousVaultStatus === "uninitialized" ? "uninitialized" : "locked";
    coordinatorState.activePublicKeyHex = undefined;
    dropActivePrivateKey();
    coordinatorState.autoLockDeadline = undefined;
    await persistCoordinatorMeta().catch(() => undefined);
    const restoredUnit = coordinatorWorkerUnitRegistry.activate("storage.coordinator-worker");
    coordinatorWorkerUnitRegistry.ready(restoredUnit.unitId, restoredUnit.instanceId);
    emitStorageState();
    if (previousVaultStatus === "unlocked" && previousActivePublicKeyHex && previousActivePrivateKeyBytes) {
      try {
        await enterUnlockedState(previousActivePublicKeyHex, previousActivePrivateKeyBytes, "unlock");
        previousActivePrivateKeyBytes = undefined;
      } catch (restoreError) {
        console.warn("[storage] failed to restore the previous bucket session", restoreError instanceof Error ? restoreError.message : String(restoreError));
      }
    }
    wipePreviousActive();
    throw error;
  }
  })().finally(wipePreviousActive);
}

/**
 * 当前桶的连接配置也属于 Coordinator 的绑定，不允许管理页只更新本机
 * 目录。流程与切桶相同，但抽象桶 ID/世代保持不变：先在旧 Provider 上
 * 验证并生成新 Hold，再锁定旧 owner、CAS 目录、暂存新 Root，最后发布新
 * Provider。失败时按提交头 ETag 回滚，旧运行时和旧会话可以继续使用。
 */
async function changeSelectedCatalogBucketConnection(
  nextConfig: StorageBucketConnectionConfigV1,
  nextLabel: string | undefined,
  password: string,
): Promise<StorageBucketCatalogEntryV2> {
  const currentEntry = selectedCatalogBucket();
  const currentBinding = captureCurrentCatalogStorageBinding();
  const previousVaultStatus = coordinatorState.vaultStatus;
  const previousActivePublicKeyHex = coordinatorState.activePublicKeyHex;
  let previousActivePrivateKeyBytes = coordinatorState.activePrivateKeyBytes?.slice();
  const wipePreviousActive = () => {
    previousActivePrivateKeyBytes?.fill(0);
    previousActivePrivateKeyBytes = undefined;
  };
  return (async (): Promise<StorageBucketCatalogEntryV2> => {
  if (!currentEntry || !currentBinding.provider || !currentBinding.root || !currentBinding.rootToken) {
    throw new StorageRuntimeError("storage_unavailable", "The current catalog bucket is not available");
  }
  if ((nextConfig.kind === "local" ? "local" : "s3") !== currentEntry.backend) {
    throw new StorageRuntimeError("storage_provider_error", "Storage bucket backend cannot be changed in-place");
  }
  if (password.length < 8) {
    throw new StorageRuntimeError("storage_identity_required", "Bucket password must contain at least 8 characters");
  }
  if (nextLabel !== undefined && !nextLabel.trim()) {
    throw new StorageRuntimeError("storage_provider_error", "Storage bucket label cannot be empty");
  }

  const repository = createStorageHoldSnapshotRepository(currentBinding.provider);
  const previous = await repository.readCommitted();
  if (previous.header.configRevision !== currentEntry.configRevision
    || !sameStorageRecord(previous.storage, currentEntry.encryptedConfig)) {
    throw new StorageRuntimeError("storage_conflict", "Storage bucket configuration changed; reload and retry");
  }

  let encryptedConfig!: StorageRecordV1;
  let document!: Awaited<ReturnType<typeof sealBucketDocument>>;
  const context = await deriveBucketCryptoContext(password, currentEntry.keyDerivation);
  try {
    await verifyBucketDocument(previous.document, context);
    await decryptBucketConfig(currentEntry.encryptedConfig, context);
    encryptedConfig = await encryptBucketConfig(nextConfig, context);
    document = await sealBucketDocument(encryptedConfig, previous.document.keys, context);
  } finally {
    context.dispose();
  }

  const nextEntryBase: StorageBucketCatalogEntryV2 = {
    ...currentEntry,
    ...(nextLabel === undefined ? {} : { label: nextLabel.trim() }),
    configRevision: currentEntry.configRevision + 1,
    keyDerivation: { ...document.keyDerivation },
    encryptedConfig,
    // publish 后再以真实 snapshotRevision 覆盖；这里的值只为通过结构校验。
    snapshotRevision: currentEntry.snapshotRevision,
    updatedAt: Date.now(),
  };
  let nextProvider: StorageBucketProvider | undefined;
  let nextRepository: ReturnType<typeof createStorageHoldSnapshotRepository> | undefined;
  let publishedHeadEtag: string | undefined;
  let catalogUpdateAttempted = false;
  let catalogUpdated = false;
  let staged: StagedCatalogBucket | undefined;
  let bindingSwapped = false;
  let nextEntryForCatalog: StorageBucketCatalogEntryV2 | undefined;
  try {
    // Provider 构造也必须位于清理范围内：配置校验或 Local 桥接
    // 初始化失败时，不能遗留为回滚准备的旧 Key 私钥副本。
    nextProvider = createCatalogProviderFromConnection(nextConfig, currentEntry.bucketId, currentBinding.root.bucket.bucketGeneration);
    nextRepository = createStorageHoldSnapshotRepository(nextProvider);
    // 目标物理根若与旧根相同，先读出现有 head 并使用其 ETag CAS；若
    // 是新 Endpoint/prefix，则允许在空目标根创建首个 head。
    const nextHead = await nextRepository!.readHead();
    const published = await nextRepository!.publish({
      document,
      configRevision: nextEntryBase.configRevision,
      bucketGeneration: currentBinding.root.bucket.bucketGeneration,
      ...(nextHead.etag ? { expectedHeadEtag: nextHead.etag } : {}),
    });
    publishedHeadEtag = published.headEtag;
    nextEntryForCatalog = {
      ...nextEntryBase,
      snapshotRevision: published.header.snapshotRevision,
    };

    // 先锁旧会话再更新目录，避免 Local 桥看到新目录后让仍在运行的旧
    // Provider 请求落入“旧配置 + 新目录”的混合状态。
    await performGlobalLock(previousVaultStatus === "uninitialized" ? "recover-empty" : "bucket-reconfigure");
    await waitForPendingOwnerStorageDrain();
    catalogUpdateAttempted = true;
    const selected = await updateLocalStorageCatalogEntry(
      currentEntry,
      nextEntryForCatalog,
      currentBinding.root.bucket.bucketGeneration,
    );
    catalogUpdated = true;

    // 目录已指向新密文后，Local 候选桥才允许读取新条目；这一步完成
    // 新 Provider/Root/Vault 索引的完整验证，失败会走下面的 CAS 回滚。
    staged = await stageCatalogBucket(
      nextEntryForCatalog,
      password,
      currentEntry.bucketId,
      currentBinding.root.bucket.bucketGeneration,
    );
    const targetWillUnlock = staged.vaultStatus === "locked"
      && Boolean(staged.activePublicKeyHex && staged.activePrivateKeyBytes);
    const nextKeyspaceGeneration = Math.max(
      coordinatorState.keyspaceGeneration + 1,
      staged.coordinatorMeta.generation + 1,
    );
    staged.coordinatorMeta.generation = nextKeyspaceGeneration;

    adoptStagedCatalogBinding(staged);
    bindingSwapped = true;
    storageBootstrapState = {
      ...(storageBootstrapState ?? { selectedBackend: selected.backend }),
      selectedBackend: selected.backend,
      selectedProfileId: selected.bucketId,
      selectedBucket: selected,
    };
    replaceCoordinatorMeta(staged.coordinatorMeta);
    coordinatorState.keyspaceGeneration = nextKeyspaceGeneration;
    coordinatorState.sessionEpoch = generateEpoch();
    coordinatorState.vaultStatus = staged.vaultStatus;
    coordinatorState.activePublicKeyHex = undefined;
    coordinatorState.autoLockDeadline = undefined;
    await persistCoordinatorMeta();

    const oldStorageUnit = coordinatorWorkerUnitRegistry.get("storage.coordinator-worker");
    if (oldStorageUnit) coordinatorWorkerUnitRegistry.stop(oldStorageUnit.unitId, oldStorageUnit.instanceId);
    const targetStorageUnit = coordinatorWorkerUnitRegistry.activate("storage.coordinator-worker");
    coordinatorWorkerUnitRegistry.ready(targetStorageUnit.unitId, targetStorageUnit.instanceId);
    if (staged.vaultStatus === "locked" && staged.activePublicKeyHex && staged.activePrivateKeyBytes) {
      const activePrivateKeyBytes = staged.activePrivateKeyBytes;
      staged.activePrivateKeyBytes = undefined;
      await enterUnlockedState(staged.activePublicKeyHex, activePrivateKeyBytes, "unlock");
    } else {
      publishSessionState("bootstrap");
      publishTopicEvent("background.snapshot", {
        type: "background.snapshot.changed",
        sessionEpoch: coordinatorState.sessionEpoch,
        snapshots: getTaskSnapshots(),
      });
    }
    storageHealthController.setStatus("ready");
    emitStorageState();
    disposeCurrentCatalogBinding(currentBinding);
    // 暂存 Root 会为当前运行时创建自己的 Provider；这里释放仅用于
    // 发布新 Hold 快照的临时 Provider，不能释放 staged.provider。
    nextProvider?.dispose();
    wipePreviousActive();
    return selected;
  } catch (error) {
    const rollbackErrors: string[] = [];
    if (catalogUpdated || catalogUpdateAttempted) {
      try {
        await updateLocalStorageCatalogEntry(
          nextEntryForCatalog ?? nextEntryBase,
          currentEntry,
          currentBinding.root.bucket.bucketGeneration,
          true,
        );
      } catch (rollbackError) {
        rollbackErrors.push(`catalog: ${rollbackError instanceof Error ? rollbackError.message : "unknown error"}`);
      }
    }
    if (publishedHeadEtag && nextRepository) {
      try {
        await nextRepository.publish({
          document: previous.document,
          configRevision: previous.header.configRevision,
          bucketGeneration: currentBinding.root.bucket.bucketGeneration,
          expectedHeadEtag: publishedHeadEtag,
        });
      } catch (rollbackError) {
        rollbackErrors.push(`Hold: ${rollbackError instanceof Error ? rollbackError.message : "unknown error"}`);
      }
    }
    if (bindingSwapped) {
      try {
        if (coordinatorState.vaultStatus === "unlocked" || coordinatorState.activePublicKeyHex) await performGlobalLock("bucket-reconfigure-rollback");
        else {
          closeCoordinatorUpgradeSession("Bucket reconfigure rollback");
          coordinatorState.activePublicKeyHex = undefined;
          dropActivePrivateKey();
        }
        await waitForPendingOwnerStorageDrain();
      } catch (lockError) {
        rollbackErrors.push(`session lock: ${lockError instanceof Error ? lockError.message : "unknown error"}`);
      }
    }
    if (staged) disposeStagedCatalogBucket(staged);
    if (bindingSwapped) {
      platformRootToken = currentBinding.rootToken;
      platformBucketProvider = currentBinding.provider;
      platformRootStore = currentBinding.root;
      platformKeysStore = currentBinding.keys;
      platformStateStore = currentBinding.state;
      platformProtocolStore = currentBinding.protocol;
      storageRepository = currentBinding.storageRepository;
      storageRuntime = currentBinding.runtime;
      storageProfileSalt = currentBinding.storageProfileSalt;
      storageProfileKey = currentBinding.storageProfileKey;
      storageBootstrapController = currentBinding.bootstrapController;
      configureVaultKeyRepository(currentBinding.keys!, { closePrevious: false });
      configureProtocolStorageRepository(currentBinding.protocol!, { closePrevious: false });
    }
    if (bindingSwapped || catalogUpdateAttempted) {
      storageBootstrapState = {
        ...(storageBootstrapState ?? { selectedBackend: currentEntry.backend }),
        selectedBackend: currentEntry.backend,
        selectedProfileId: currentEntry.bucketId,
        selectedBucket: currentEntry,
      };
      const oldMeta = await currentBinding.state?.get<CoordinatorMetaRecord>("meta", { partition: "coordinator" });
      replaceCoordinatorMeta(oldMeta?.value
        ? { ...oldMeta.value, generation: coordinatorState.keyspaceGeneration }
        : { id: "singleton", generation: coordinatorState.keyspaceGeneration });
      coordinatorState.vaultStatus = previousVaultStatus === "uninitialized" ? "uninitialized" : "locked";
      coordinatorState.activePublicKeyHex = undefined;
      dropActivePrivateKey();
      coordinatorState.autoLockDeadline = undefined;
      await persistCoordinatorMeta().catch(() => undefined);
      const restoredUnit = coordinatorWorkerUnitRegistry.activate("storage.coordinator-worker");
      coordinatorWorkerUnitRegistry.ready(restoredUnit.unitId, restoredUnit.instanceId);
      if (previousVaultStatus === "unlocked" && previousActivePublicKeyHex && previousActivePrivateKeyBytes && rollbackErrors.length === 0) {
        try {
          await enterUnlockedState(previousActivePublicKeyHex, previousActivePrivateKeyBytes, "unlock");
          previousActivePrivateKeyBytes = undefined;
        } catch (restoreError) {
          rollbackErrors.push(`session restore: ${restoreError instanceof Error ? restoreError.message : "unknown error"}`);
        }
      }
      emitStorageState();
    }
    nextProvider?.dispose();
    wipePreviousActive();
    if (rollbackErrors.length > 0) {
      storageStartupFailure = true;
      storageHealthController.setStatus("degraded", "Bucket configuration rollback was not fully confirmed");
      emitStorageState();
      throw new Error(`Bucket configuration update failed; rollback was not fully confirmed (${rollbackErrors.join("; ")})`);
    }
    throw error;
  }
  })().finally(wipePreviousActive);
}

/**
 * 当前桶改名只改变本机目录元数据，但仍属于当前 Coordinator 的真值。
 * 通过 Local 桥复用同一把目录锁和完整条目 CAS，避免管理页直接写目录后
 * 让顶栏、Worker 选中条目和其他标签页看到不同名称。
 */
async function renameSelectedCatalogBucket(nextLabel: string): Promise<StorageBucketCatalogEntryV2> {
  const currentEntry = selectedCatalogBucket();
  const root = platformRootStore;
  if (!currentEntry || !root) throw new StorageRuntimeError("storage_unavailable", "The current catalog bucket is not available");
  const label = nextLabel.trim();
  if (!label || label.length > 128) throw new StorageRuntimeError("storage_provider_error", "Storage bucket label is invalid");
  const nextEntry = { ...currentEntry, label, updatedAt: Date.now() };
  let updated: StorageBucketCatalogEntryV2;
  try {
    updated = await updateLocalStorageCatalogEntry(
      currentEntry,
      nextEntry,
      root.bucket.bucketGeneration,
    );
  } catch (error) {
    // 目录 CAS 可能已经成功但桥响应在返回途中丢失。用 rollback 的幂等
    // 语义重试：目录仍是旧条目时继续更新，已经是 nextEntry 时确认成功；
    // 若被第三方改成其它版本则仍返回原始冲突，不覆盖并发修改。
    try {
      updated = await updateLocalStorageCatalogEntry(
        currentEntry,
        nextEntry,
        root.bucket.bucketGeneration,
        true,
      );
    } catch {
      throw error;
    }
  }
  storageBootstrapState = storageBootstrapState
    ? { ...storageBootstrapState, selectedBucket: updated }
    : storageBootstrapState;
  return updated;
}

/** 把已探测通过的 Provider 安装成 Coordinator-owned Root。 */
async function installPlatformStorage(provider: StorageBucketProvider, bucket: StorageBucketRef, profilePassword?: string): Promise<void> {
  const previousRootToken = platformRootToken;
  const rootToken = {};
  let candidatePublished = false;
  let candidateKeys: KeyValueStore | undefined;
  let candidateState: KeyValueStore | undefined;
  let candidateProtocol: KeyValueStore | undefined;
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
    const keys = await root.openPlatformKeysStore(1);
    candidateKeys = keys;
    const state = await root.openPlatformStore({ applicationStorageId: "coordinator", schemaVersion: 1 });
    candidateState = state;
    const candidateSalt = await loadOrCreateStorageProfileSalt(state);
    // OPFS 没有远端 Profile 密码；仍为 multipart 密文 ID 使用独立的
    // 桶内密钥，避免把这些内部值退回明文或依赖 Vault 密码。
    let candidateStorageProfileKey: CryptoKey;
    if (profilePassword) {
      candidateStorageProfileKey = await deriveStorageProfileKey(profilePassword, candidateSalt);
    } else if (storageBootstrapState?.selectedBucket?.bucketId === bucket.bucketId) {
      // 新版 Local/S3 桶的密码只用于本次 createCatalogProvider 解密；
      // 不把它或其派生 key 放进 Coordinator 长期状态。
      candidateStorageProfileKey = await createEphemeralStorageRuntimeKey();
    } else if (bucket.provider === "opfs" && !storageProfileKey) {
      // 冷启动候选 Root 尚未提交，当前全局 salt 仍可能属于旧桶；
      // 必须使用本次候选 Root 原子初始化得到的 salt 派生临时 Profile
      // key，不能让默认参数读取尚未发布的全局 salt。
      candidateStorageProfileKey = await deriveStorageProfileKey("opfs-local-key", candidateSalt);
    } else if (storageProfileKey) {
      candidateStorageProfileKey = storageProfileKey;
    } else {
      candidateStorageProfileKey = await createEphemeralStorageRuntimeKey();
    }
    const protocol = await root.openPlatformStore({ applicationStorageId: "protocol", schemaVersion: 1 });
    candidateProtocol = protocol;
    candidateStorageRepository = await openMultipartUploadRepository(await root.openPlatformStore({ applicationStorageId: "storage", schemaVersion: 1 }));

    // 到这里为止只使用候选 Provider/Root；Hold、Vault 和后续恢复仍未能
    // 看到半成品。提交前才切换全局句柄，并释放上一代平台句柄。
    if (storageRepository && storageRepository !== candidateStorageRepository) storageRepository.close();
    if (platformStateStore && platformStateStore !== state) platformStateStore.close();
    platformRootToken = rootToken;
    candidatePublished = true;
    configureVaultKeyRepository(keys);
    configureProtocolStorageRepository(protocol);
    storageProfileSalt = candidateSalt;
    storageProfileKey = candidateStorageProfileKey;
    platformRootStore = root;
    platformBucketProvider = provider;
    platformKeysStore = keys;
    platformStateStore = state;
    platformProtocolStore = protocol;
    storageRepository = candidateStorageRepository;
    platformStorageReady = true;
  } catch (error) {
    if (!candidatePublished) {
      candidateStorageRepository?.close();
      candidateProtocol?.close();
      candidateState?.close();
      candidateKeys?.close();
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
 * 实现保持跨测试的 Worker 重启语义；生产启动永远走上面的 OPFS bootstrap，
 * 不会因为 Storage 缺失而自动降级到内存。
 */
function ensureTestPlatformStorage(): void {
  if (platformRootStore) return;
  const bucket: StorageBucketRef = Object.freeze({ bucketId: "test-memory", bucketGeneration: 1, provider: "opfs" });
  platformRootToken = {};
  const stores = new Map<string, KeyValueStore>();
  const getStore = (key: string, binding: Parameters<typeof createInMemoryKeyValueStore>[0]): KeyValueStore => {
    const existing = stores.get(key);
    if (existing) return { ...existing, close: () => undefined };
    const created = createInMemoryKeyValueStore(binding);
    stores.set(key, created);
    return { ...created, close: () => undefined };
  };
  const root: PlatformRootStore = {
    bucket,
    openKeyValueStore: async ({ ownerPublicKeyHex, applicationStorageId, schemaVersion }) => getStore(
      `owner:${ownerPublicKeyHex}:${applicationStorageId}:${schemaVersion}`,
      { scope: "key", ownerPublicKeyHex, applicationStorageId, schemaVersion, bucketId: bucket.bucketId, bucketGeneration: bucket.bucketGeneration }
    ) as import("@keymaster/contracts").OwnerAppStore,
    activateOwnerStorage: async () => ({ generation: 1 }),
    getOwnerStorageGeneration: async () => 1,
    assertOwnerStorageCurrent: async () => undefined,
    deleteOwnerStorage: async ({ ownerPublicKeyHex }) => {
      const prefix = `owner:${ownerPublicKeyHex}:`;
      for (const key of [...stores.keys()]) {
        if (key.startsWith(prefix)) { stores.get(key)?.close(); stores.delete(key); }
      }
    },
    openPlatformStore: async ({ applicationStorageId, schemaVersion }) => getStore(
      `platform:${applicationStorageId}:${schemaVersion}`,
      { scope: "platform", applicationStorageId, schemaVersion, bucketId: bucket.bucketId, bucketGeneration: bucket.bucketGeneration }
    ),
    openPlatformKeysStore: async (schemaVersion) => getStore(
      `platform:keys:${schemaVersion}`,
      { scope: "platform", applicationStorageId: "keys", schemaVersion, bucketId: bucket.bucketId, bucketGeneration: bucket.bucketGeneration }
    )
  };
  const keys = getStore("platform:keys:1", { scope: "platform", applicationStorageId: "keys", schemaVersion: 1, bucketId: bucket.bucketId, bucketGeneration: bucket.bucketGeneration });
  const state = getStore("platform:coordinator:1", { scope: "platform", applicationStorageId: "coordinator", schemaVersion: 1, bucketId: bucket.bucketId, bucketGeneration: bucket.bucketGeneration });
  const protocol = getStore("platform:protocol:1", { scope: "platform", applicationStorageId: "protocol", schemaVersion: 1, bucketId: bucket.bucketId, bucketGeneration: bucket.bucketGeneration });
  platformRootStore = root;
  platformKeysStore = keys;
  platformStateStore = state;
  platformProtocolStore = protocol;
  configureVaultKeyRepository(keys);
  configureProtocolStorageRepository(protocol);
  platformStorageReady = true;
}


async function loadCoordinatorMeta(): Promise<void> {
  const stored = await platformStateStore?.get<CoordinatorMetaRecord>("meta", { partition: "coordinator" });
  if (stored?.value) Object.assign(coordinatorMeta, stored.value);
  ensurePluginIntentController();
  coordinatorMeta.p2pkhProviders ??= defaultP2pkhProviders();
  coordinatorMeta.p2pkhSettings ??= { includeTestnet: false };
  if (coordinatorMeta.scheduleSettings) coordinatorState.scheduleSettings = coordinatorMeta.scheduleSettings;
}
async function persistCoordinatorMetaValue(value: CoordinatorMetaRecord): Promise<void> {
  if (testPersistCoordinatorMetaFailure) {
    testPersistCoordinatorMetaFailure = false;
    throw new Error("injected coordinator meta persist failure");
  }
  const stateStore = platformStateStore;
  if (!stateStore) throw new Error("Coordinator storage has not been bootstrapped");
  // metadata 也是 Coordinator 的权威状态；不能让已被新 Worker 接管的
  // 旧实例把旧 session / plugin intent 写回共享存储。这里复用最终
  // I/O lease，使 metadata 写入也参加跨 Worker 接管排空。
  await withCoordinatorFinalIoLease("write", undefined, async () => {
    await stateStore.put("meta", value, { partition: "coordinator" });
  }, { auditOperation: "coordinator.meta.persist" });
}
async function persistCoordinatorMeta(): Promise<void> {
  await persistCoordinatorMetaValue(coordinatorMeta);
}

function coordinatorUpgradeError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function normalizeCoordinatorAuthorityRecord(value: unknown): CoordinatorAuthorityRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<CoordinatorAuthorityRecord>;
  if (
    record.version !== 1
    || typeof record.authorityInstanceId !== "string"
    || record.authorityInstanceId.length === 0
    || typeof record.handoverGeneration !== "number"
    || !Number.isSafeInteger(record.handoverGeneration)
    || record.handoverGeneration < 0
    || typeof record.buildId !== "string"
    || record.buildId.length === 0
    || typeof record.protocolVersion !== "string"
    || record.protocolVersion.length === 0
  ) return undefined;

  // 兼容已经落盘的早期 authority 记录；旧记录没有 activeIoLeases 时
  // 视为空集，并在下一次 claim / lease 变更时升级为完整格式。
  const rawLeases = record.activeIoLeases;
  if (rawLeases === undefined) {
    return {
      version: 1,
      authorityInstanceId: record.authorityInstanceId,
      handoverGeneration: record.handoverGeneration,
      buildId: record.buildId,
      protocolVersion: record.protocolVersion,
      ...(typeof record.workerIdentity === "string" && record.workerIdentity.length > 0
        ? { workerIdentity: record.workerIdentity }
        : {}),
      activeIoLeases: {},
    };
  }
  if (!rawLeases || typeof rawLeases !== "object" || Array.isArray(rawLeases)) return undefined;
  const activeIoLeases: CoordinatorAuthorityRecord["activeIoLeases"] = {};
  for (const [leaseId, lease] of Object.entries(rawLeases)) {
    if (
      !leaseId
      || !lease
      || typeof lease !== "object"
      || ((lease as { operation?: unknown }).operation !== "read" && (lease as { operation?: unknown }).operation !== "write")
      || typeof (lease as { acquiredAt?: unknown }).acquiredAt !== "number"
      || !Number.isFinite((lease as { acquiredAt: number }).acquiredAt)
      || ((lease as { auditOperation?: unknown }).auditOperation !== undefined
        && typeof (lease as { auditOperation?: unknown }).auditOperation !== "string")
    ) return undefined;
    const auditOperation = (lease as { auditOperation?: unknown }).auditOperation;
    activeIoLeases[leaseId] = {
      operation: (lease as { operation: "read" | "write" }).operation,
      acquiredAt: (lease as { acquiredAt: number }).acquiredAt,
      ...(typeof auditOperation === "string" ? { auditOperation: auditOperation as FinalIoAuditOperation } : {}),
    };
  }
  return {
    version: 1,
    authorityInstanceId: record.authorityInstanceId,
    handoverGeneration: record.handoverGeneration,
    buildId: record.buildId,
    protocolVersion: record.protocolVersion,
    ...(typeof record.workerIdentity === "string" && record.workerIdentity.length > 0
      ? { workerIdentity: record.workerIdentity }
      : {}),
    activeIoLeases,
  };
}

function isCoordinatorAuthorityRecord(value: unknown): value is CoordinatorAuthorityRecord {
  return normalizeCoordinatorAuthorityRecord(value) !== undefined;
}

interface CoordinatorAuthoritySnapshot {
  /** 当前 authority 值；不存在时为空。 */
  record?: CoordinatorAuthorityRecord;
  /** 与这次读取对应的 partition revision，用于下一次 CAS。 */
  revision: number;
}

/**
 * 读取 authority 及其 CAS revision 的同一快照。
 *
 * 不能先 get 值、再无条件 list revision：两个异步读取之间如果有别的
 * Worker 更新 authority，后一个 list 的 revision 可能看起来是最新的，
 * 但前一个 get 仍是旧值，最终会把并发 Worker 的 lease 更新覆盖掉。
 * 已存在的 key 从 get 结果直接取得 revision；只有 key 不存在时才需要
 * list 来取得“空 partition”的 revision。
 */
async function readCoordinatorAuthoritySnapshot(stateStore: KeyValueStore): Promise<CoordinatorAuthoritySnapshot> {
  const entry = await stateStore.get<CoordinatorAuthorityRecord>(COORDINATOR_UPGRADE_KEY, {
    partition: COORDINATOR_UPGRADE_PARTITION,
  });
  if (entry) {
    const record = normalizeCoordinatorAuthorityRecord(entry.value);
    if (!record) throw coordinatorUpgradeError("upgrade.authority_record_invalid", "Coordinator authority record is invalid");
    return { record, revision: entry.revision };
  }

  const partition = await stateStore.list({ partition: COORDINATOR_UPGRADE_PARTITION, limit: 1_000 });
  const listed = partition.entries.find((candidate) => candidate.key === COORDINATOR_UPGRADE_KEY);
  if (!listed) return { revision: partition.revision };
  const record = normalizeCoordinatorAuthorityRecord(listed.value);
  if (!record) throw coordinatorUpgradeError("upgrade.authority_record_invalid", "Coordinator authority record is invalid");
  return { record, revision: listed.revision };
}

async function readCoordinatorAuthorityRecord(): Promise<CoordinatorAuthorityRecord | undefined> {
  if (!platformStateStore) throw coordinatorUpgradeError("upgrade.authority_unavailable", "Coordinator authority storage is unavailable");
  return (await readCoordinatorAuthoritySnapshot(platformStateStore)).record;
}

function isStorageConflict(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  return code === "storage_conflict"
    || (error instanceof Error && /partition revision changed|concurrently|conflict/i.test(error.message));
}

/**
 * 在独立 partition 中用 CAS 声明当前 Worker 的唯一权威。
 *
 * 这条记录不是插件状态，也不依赖 Vault 是否 unlocked；它是最终存储/
 * 签名边界用来拒绝旧 Worker 的共享持久化 fence。metadata 的测试故障注入
 * 不会影响这里，避免把安全锁定误判成普通 UI 配置保存失败。
 */
async function claimCoordinatorAuthority(): Promise<void> {
  if (!platformStateStore) throw coordinatorUpgradeError("upgrade.authority_unavailable", "Coordinator authority storage is unavailable");
  let lastError: unknown;
  let lastBusyLeaseCount = 0;
  let lastBusyHandoverGeneration = 0;
  let lastBusyAuthorityBuildId = "";
  let lastBusyIoOperations: CoordinatorAuthorityRecovery["activeIoOperations"] = { read: 0, write: 0 };
  let lastBusyIoOperationNames: string[] = [];
  // 正常的 Provider/存储请求可能超过几十毫秒；80ms 的固定重试会把
  // 合法的冷切换误报为失败。这里等待一个明确上限，超时仍保持旧
  // authority 记录不变，调用方继续 fail closed。
  const deadline = Date.now() + 5_000;
  for (;;) {
    if (Date.now() >= deadline) break;
    const currentSnapshot = await readCoordinatorAuthoritySnapshot(platformStateStore);
    const currentRecord = currentSnapshot.record;
    // 所有已升级的 Worker 都必须先登记最终 I/O lease；接管者不能在
    // 旧实例仍可能提交读写时直接覆盖 authority。没有超时强抢语义，
    // 因为未知旧版本的真实外部写入无法被本地 Abort 可靠中断。
    const hasActiveIoLeases = currentRecord && Object.keys(currentRecord.activeIoLeases).length > 0;
    const canRecoverTerminatedLocalWorker = hasActiveIoLeases
      && platformRootStore?.bucket.provider === "local"
      && currentRecord.buildId === COORDINATOR_BUILD_ID
      && currentRecord.protocolVersion === COORDINATOR_UPGRADE_PROTOCOL_VERSION
      && currentRecord.workerIdentity === COORDINATOR_WORKER_IDENTITY;
    if (hasActiveIoLeases && !canRecoverTerminatedLocalWorker) {
      const activeIoLeases = Object.values(currentRecord.activeIoLeases);
      lastBusyLeaseCount = activeIoLeases.length;
      lastBusyHandoverGeneration = currentRecord.handoverGeneration;
      lastBusyAuthorityBuildId = currentRecord.buildId;
      lastBusyIoOperations = {
        read: activeIoLeases.filter((lease) => lease.operation === "read").length,
        write: activeIoLeases.filter((lease) => lease.operation === "write").length,
      };
      lastBusyIoOperationNames = [...new Set(activeIoLeases.map((lease) => lease.auditOperation ?? "unknown"))].sort();
      lastError = coordinatorUpgradeError("upgrade.authority_busy", "Coordinator authority still has active final I/O leases");
      await new Promise((resolve) => setTimeout(resolve, Math.min(10, Math.max(1, deadline - Date.now()))));
      continue;
    }
    // canRecoverTerminatedLocalWorker 为 true 时，Local 的物理 I/O 在同源
    // Window localStorage 中完成，不会在 Worker 终止后继续成为远端写入。
    // 浏览器又不会同时运行两个 URL+name 完全相同的 SharedWorker：当前
    // 模块以相同 workerIdentity 重新执行，已构成旧 realm 终止的证据。
    // 下方 CAS 会原子推进 authority 并清空孤儿 lease；S3、不同构建/
    // URL/name 和旧格式记录仍保持 fail closed。
    // 旧 Worker 已经释放最终 I/O 后，之前记录的忙碌诊断不能继续影响
    // 当前这轮 claim。否则后续仅发生 CAS 冲突时会误报 recovery-required，
    // 把“暂时竞争”错误地显示成“旧 I/O 未知”。
    lastBusyLeaseCount = 0;
    lastBusyHandoverGeneration = currentRecord?.handoverGeneration ?? 0;
    lastBusyAuthorityBuildId = "";
    lastBusyIoOperations = { read: 0, write: 0 };
    lastBusyIoOperationNames = [];
    const handoverGeneration = (currentRecord?.handoverGeneration ?? 0) + 1;
    const next: CoordinatorAuthorityRecord = {
      version: 1,
      authorityInstanceId: coordinatorAuthorityInstanceId,
      handoverGeneration,
      buildId: COORDINATOR_BUILD_ID,
      protocolVersion: COORDINATOR_UPGRADE_PROTOCOL_VERSION,
      workerIdentity: COORDINATOR_WORKER_IDENTITY,
      activeIoLeases: {},
    };
    try {
      await platformStateStore.put(COORDINATOR_UPGRADE_KEY, next, {
        partition: COORDINATOR_UPGRADE_PARTITION,
        ifRevision: currentSnapshot.revision,
      });
      // 测试夹具可能在异步 claim 期间模拟了另一次 Worker 重启；
      // 不能把旧启动身份写回当前内存。
      if (next.authorityInstanceId === coordinatorAuthorityInstanceId) {
        coordinatorHandoverGeneration = next.handoverGeneration;
        coordinatorAuthorityRecord = next;
        coordinatorAuthorityRecovery = undefined;
        coordinatorAuthorityRecoveryOperationNames = [];
      }
      return;
    } catch (error) {
      if (!isStorageConflict(error)) throw error;
      lastError = error;
      // 让出事件循环，避免共享 K-V 在高冲突时被一个旧 Worker 忙等占满。
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  const failure = coordinatorUpgradeError(
    "upgrade.authority_claim_failed",
    `Coordinator authority claim timed out${lastError instanceof Error ? `: ${lastError.message}` : ""}`,
  );
  if (lastBusyLeaseCount > 0) {
    // 旧 Worker 崩溃时不能凭本地超时猜测其外部 I/O 已停止；保留安全锁定，
    // 把“等待旧租约自然释放后重试”发布给 UI，而不是静默变成 fatal。
    coordinatorAuthorityRecovery = {
      status: "recovery-required",
      reason: "active-final-io-leases",
      authorityBuildId: lastBusyAuthorityBuildId,
      activeIoLeaseCount: lastBusyLeaseCount,
      activeIoOperations: lastBusyIoOperations,
      handoverGeneration: lastBusyHandoverGeneration,
    };
    coordinatorAuthorityRecoveryOperationNames = lastBusyIoOperationNames;
    Object.assign(failure, {
      recoveryRequired: true,
      authorityBuildId: lastBusyAuthorityBuildId,
      activeIoLeaseCount: lastBusyLeaseCount,
      activeIoOperations: lastBusyIoOperations,
      handoverGeneration: lastBusyHandoverGeneration,
      // 仅用于当前现场恢复日志，名称来自固定审计枚举，不携带请求数据。
      activeIoOperationNames: lastBusyIoOperationNames,
    });
  }
  throw failure;
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
  const persisted = await readCoordinatorAuthorityRecord();
  if (
    !persisted
    || persisted.authorityInstanceId !== coordinatorAuthorityInstanceId
    || persisted.handoverGeneration !== coordinatorHandoverGeneration
    || persisted.buildId !== COORDINATOR_BUILD_ID
    || persisted.protocolVersion !== COORDINATOR_UPGRADE_PROTOCOL_VERSION
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
    // leaseId 只是防止两个释放操作误删彼此的记录；权威与世代仍由 CAS 校验。
  }
  return `coordinator-io:${Date.now().toString(36)}:${randomIdentifierSuffix()}`;
}

function rememberCoordinatorAuthorityRecord(record: CoordinatorAuthorityRecord): void {
  if (
    record.authorityInstanceId === coordinatorAuthorityInstanceId
    && record.handoverGeneration === coordinatorHandoverGeneration
  ) coordinatorAuthorityRecord = record;
}

function withCoordinatorAuthorityMutation<T>(operation: () => Promise<T>): Promise<T> {
  const run = coordinatorAuthorityMutationTail.then(operation, operation);
  coordinatorAuthorityMutationTail = run.then(() => undefined, () => undefined);
  return run;
}

/** 在共享 authority 记录中登记一次最终 I/O；接管 CAS 会等待该记录消失。 */
/** 直接对共享 authority 记录登记一个持久 lease；调用方已保证本地互斥。 */
async function acquireCoordinatorFinalIoLeaseExclusive(
  operation: "read" | "write",
  auditOperation?: FinalIoAuditOperation,
): Promise<CoordinatorFinalIoLease> {
  const stateStore = platformStateStore;
  if (!stateStore) throw coordinatorUpgradeError("upgrade.authority_unavailable", "Coordinator authority storage is unavailable");
  await assertCoordinatorAuthorityCurrent();
  const leaseId = makeCoordinatorFinalIoLeaseId();
  let lastError: unknown;
  const deadline = Date.now() + COORDINATOR_AUTHORITY_CAS_TIMEOUT_MS;
  return withCoordinatorAuthorityMutation(async () => {
    for (;;) {
      if (Date.now() >= deadline) break;
      const snapshot = await readCoordinatorAuthoritySnapshot(stateStore);
      const current = snapshot.record;
      if (
        !current
        || current.authorityInstanceId !== coordinatorAuthorityInstanceId
        || current.handoverGeneration !== coordinatorHandoverGeneration
        || current.buildId !== COORDINATOR_BUILD_ID
        || current.protocolVersion !== COORDINATOR_UPGRADE_PROTOCOL_VERSION
      ) throw coordinatorUpgradeError("upgrade.authority_stale", "Coordinator authority changed before final I/O admission");
      const next: CoordinatorAuthorityRecord = {
        ...current,
        activeIoLeases: {
          ...current.activeIoLeases,
          [leaseId]: {
            operation,
            acquiredAt: Date.now(),
            ...(auditOperation ? { auditOperation } : {}),
          },
        },
      };
      try {
        await stateStore.put(COORDINATOR_UPGRADE_KEY, next, {
          partition: COORDINATOR_UPGRADE_PARTITION,
          ifRevision: snapshot.revision,
        });
        rememberCoordinatorAuthorityRecord(next);
        let released = false;
        return {
          leaseId,
          authorityInstanceId: current.authorityInstanceId,
          handoverGeneration: current.handoverGeneration,
          release: async () => {
            if (released) return;
            released = true;
            // 这里不能使用当前全局 authority：测试夹具模拟 Worker 重启时，
            // 旧 I/O 的 finally 仍要能从旧记录中释放自己的 lease；若记录已
            // 被新 Worker 接管，release 函数会按捕获身份安全 no-op。
            await releaseCoordinatorFinalIoLease(
              stateStore,
              leaseId,
              current.authorityInstanceId,
              current.handoverGeneration,
            );
          },
        };
      } catch (error) {
        if (!isStorageConflict(error)) throw error;
        lastError = error;
        // 跨 Worker 的 CAS 竞争仍需重读；同一 Worker 内不会再有交错的
        // authority 读改写。让出事件循环避免占满 Provider。
        await new Promise((resolve) => setTimeout(resolve, Math.min(10, Math.max(1, deadline - Date.now()))));
      }
    }
    throw coordinatorUpgradeError(
      "upgrade.io_lease_conflict",
      `Coordinator final I/O lease could not be admitted${lastError instanceof Error ? `: ${lastError.message}` : ""}`,
    );
  });
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
 * 读请求按本地 Coordinator 聚合持久 lease；写请求仍是一请求一 lease。
 * 每个返回对象都有独立幂等 release，最后一个读请求才释放共享记录。
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
        leaseId: `${existing.durableLease.leaseId}:${existing.references}`,
        authorityInstanceId,
        handoverGeneration,
        release: async () => {
          if (released) return;
          released = true;
          await withCoordinatorSharedReadLeaseMutation(async () => {
            existing.references = Math.max(0, existing.references - 1);
            if (existing.references !== 0) return;
            if (coordinatorSharedReadLease === existing) coordinatorSharedReadLease = undefined;
            await existing.durableLease.release();
          });
        },
      };
    }

    // 只会在测试 reset / 本地重建后遇到不匹配对象；旧对象的在途请求仍
    // 持有自己的引用，等它们 finally 释放，不能在这里强行改写旧记录。
    const durableLease = await acquireCoordinatorFinalIoLeaseExclusive("read", auditOperation);
    const shared: CoordinatorSharedReadLease = {
      durableLease,
      authorityInstanceId: durableLease.authorityInstanceId,
      handoverGeneration: durableLease.handoverGeneration,
      references: 1,
    };
    coordinatorSharedReadLease = shared;
    let released = false;
    return {
      leaseId: `${durableLease.leaseId}:1`,
      authorityInstanceId: durableLease.authorityInstanceId,
      handoverGeneration: durableLease.handoverGeneration,
      release: async () => {
        if (released) return;
        released = true;
        await withCoordinatorSharedReadLeaseMutation(async () => {
          shared.references = Math.max(0, shared.references - 1);
          if (shared.references !== 0) return;
          if (coordinatorSharedReadLease === shared) coordinatorSharedReadLease = undefined;
          await shared.durableLease.release();
        });
      },
    };
  });
}

/** 释放持久 lease；若 authority 已被外部接管则只读退出，不能修改新 Worker 记录。 */
async function releaseCoordinatorFinalIoLease(
  stateStore: KeyValueStore,
  leaseId: string,
  leaseAuthorityInstanceId: string,
  leaseHandoverGeneration: number,
): Promise<void> {
  let lastError: unknown;
  const deadline = Date.now() + COORDINATOR_AUTHORITY_CAS_TIMEOUT_MS;
  return withCoordinatorAuthorityMutation(async () => {
    for (;;) {
      if (Date.now() >= deadline) break;
      const snapshot = await readCoordinatorAuthoritySnapshot(stateStore);
      const current = snapshot.record;
      if (
        !current
        || current.authorityInstanceId !== leaseAuthorityInstanceId
        || current.handoverGeneration !== leaseHandoverGeneration
      ) {
        return;
      }
      if (!Object.prototype.hasOwnProperty.call(current.activeIoLeases, leaseId)) {
        return;
      }
      const activeIoLeases = { ...current.activeIoLeases };
      delete activeIoLeases[leaseId];
      const next: CoordinatorAuthorityRecord = { ...current, activeIoLeases };
      try {
        await stateStore.put(COORDINATOR_UPGRADE_KEY, next, {
          partition: COORDINATOR_UPGRADE_PARTITION,
          ifRevision: snapshot.revision,
        });
        rememberCoordinatorAuthorityRecord(next);
        return;
      } catch (error) {
        if (!isStorageConflict(error)) throw error;
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(10, Math.max(1, deadline - Date.now()))));
      }
    }
    throw coordinatorUpgradeError(
      "upgrade.io_lease_release_failed",
      `Coordinator final I/O lease release failed${lastError instanceof Error ? `: ${lastError.message}` : ""}`,
    );
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
    /**
     * 非持久化的本地边界：不会改变外部或本地持久化真值，因此不需要
     * 在 Worker 重启后阻塞新 authority；本地 gate 和前后 authority
     * 校验仍然保留。默认 true，避免新入口意外绕过跨 Worker fence。
     */
    durableLease?: boolean;
  } = {},
): Promise<T> {
  await ensureCoordinatorUpgradeSession();
  // 共享 read lease 本身就是当前 authority 已通过持久 CAS 的证明；在
  // 它仍有引用时，接管者不能覆盖该记录，因此高频只读请求无需每次再
  // 读取 authority K-V。没有共享证明时（首个读、写入或重建后）仍做
  // 完整 authority 校验。
  if (operation !== "read" || !hasCurrentCoordinatorSharedReadLease()) {
    await assertCoordinatorAuthorityCurrent();
  }
  const gate = coordinatorUpgradeGate;
  const session = coordinatorUpgradeSession;
  if (!gate || !session) throw coordinatorUpgradeError("upgrade.gate_unavailable", "Coordinator upgrade gate is unavailable");
  const initialSessionEpoch = coordinatorState.sessionEpoch;
  const initialKeyspaceGeneration = coordinatorState.keyspaceGeneration;
  const lease: UpgradeIoLease = gate.admit({ session, operation, signal });
  let durableLease: CoordinatorFinalIoLease | undefined;
  let audit: ReturnType<ReturnType<typeof createFinalIoAudit>["begin"]> | undefined;
  let operationError: unknown;
  try {
    lease.assertActive();
    // 本地 UpgradeGate 只保护当前 Worker；持久 lease 还把最终 I/O 与
    // 其它 Worker 的 authority CAS 串起来。接管者看到此记录时只能等待，
    // 因而不会在本次写入的前后检查之间插入新的 authority。
    if (options.durableLease !== false) {
      durableLease = await acquireCoordinatorFinalIoLease(operation, options.auditOperation);
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
    // Root 销毁会在 finally 中、durable lease 释放后执行；此时不再要求
    // 旧 Root 的 authority 记录完成一次无意义的后置读取。
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
      await durableLease?.release();
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

/** 创建本次 Worker 唯一的插件意图控制面，并把持久化成功作为发布前置条件。 */
function ensurePluginIntentController(): PluginIntentController {
  if (pluginIntentController) return pluginIntentController;
  const controller = createPluginIntentController({
    authorityInstanceId: coordinatorAuthorityInstanceId,
    initial: coordinatorMeta.pluginIntent ?? emptyPluginIntentSnapshot(),
    persist: async (snapshot) => {
      const nextMeta: CoordinatorMetaRecord = { ...coordinatorMeta, pluginIntent: snapshot };
      await persistCoordinatorMetaValue(nextMeta);
      Object.assign(coordinatorMeta, nextMeta);
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

const persistActiveMeta = persistCoordinatorMeta;
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
  coordinatorMeta.generation = coordinatorState.keyspaceGeneration;
}

let storageRuntime: StorageRuntimeController | undefined;
let storageRepository: Awaited<ReturnType<typeof openMultipartUploadRepository>> | undefined;
// Test-only seams keep worker ownership/dispatch tests independent from S3 and
// platform K-V persistence.
let testStorageRuntimeOverride: StorageRuntimeController | undefined;
let testStorageStartupFailure = false;
let testFailAfterCatalogBindingPublish = false;
let testLocalStorageBridgeOverride: ((input: LocalStorageBridgeRequest) => Promise<LocalStorageBridgeResponse>) | undefined;
let storageStartupFailure = false;
let storageRevision = 0;
let msfileRevision = 0;
let lastStorageState: CoordinatorStorageStateEvent | undefined;
let storageStateTail: Promise<void> = Promise.resolve();
const storageRequests = new Map<string, { controller: AbortController; clientId: string; connectSessionId?: string }>();
const storageRequestKey = (clientId: string, requestId: string): string => `${clientId}\u0000${requestId}`;
const storagePortCounts = new Map<string, number>();
const storageGrants = new Map<string, { context: import("@keymaster/contracts").OwnerAppStorageGrant; ownerStorageGeneration: number; clientId: string; sessionEpoch: SessionEpoch }>();
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
let lastMsFileState: CoordinatorMsFileStateEvent | undefined;

/* ---------- SatSubscription runtime（唯一 owner：SharedWorker） ---------- */
const SAT_WINDOW_LANE_ID = "sat-subscription";
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
    // MSFile 是系统应用，但数据仍属于当前 active public key，不能落入
    // platform 全局桶；createWorkerOwnerStore 会绑定 `owner/MSFile/`。
    try {
      const msfileStore = createWorkerOwnerStore("msfile", 1);
      const repository = await openMsFileRepository(msfileStore);
      service = createMsFileService({
        repository: repository,
        transport: windowP2pExecutorTransport,
        notifyStateChange: (_state: MsFileServiceEventState) => emitMsFileState()
      });
      // 服务构造会异步读取 owner K-V；必须等首轮读取完成后再发布实例。
      // 初始化失败的候选实例在这里释放，下一次 control/recovery 可以重试，
      // 不把一次 Storage 竞态变成永久 unavailable。
      await service.waitUntilInitialized();
      assertStorageDataAvailable();
      if (
        startToken !== msfileRuntimeStartToken
        || coordinatorState.vaultStatus !== "unlocked"
        || !coordinatorState.activePublicKeyHex
        || !isCoordinatorProductEnabled("msfile")
      ) {
        throw msfileError("msfile_unavailable", "MSFile runtime startup was superseded");
      }
      msfileRuntime = service;
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
    const store = createWorkerOwnerStore("sat-subscription", SAT_SUBSCRIPTION_SCHEMA_VERSION);
    const repository = createSatSubscriptionRepository(store);
    let provider: ReturnType<typeof createSatSubscriptionProvider> | undefined;
    let handle: SatSubscriptionHandle | undefined;
    try {
      const loaded = await repository.load();
      const initial = {
        ...loaded,
        ownerSettings: loaded.ownerSettings ?? {
          ownerPublicKeyHex,
          defaultPublishSupplierId: null,
          receiveSupplierIds: [],
        },
      };
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
    // 每一步都有上限：远端 Supplier 永不返回时，清理转为 owner K-V 中的
    // 待退订证据，不能拖延锁屏或阻止后续 owner 建立会话。
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
  for (const pending of msfileRequests.values()) pending.controller.abort();
  msfileRequests.clear();
  for (const pending of windowP2pExecutorIdentityRequests.values()) pending.controller.abort();
  windowP2pExecutorIdentityRequests.clear();
  msfileGrants.clear();
  const workerUnit = coordinatorWorkerUnitRegistry.get("msfile.coordinator-worker");
  (msfileRuntime as unknown as { dispose?: () => void } | undefined)?.dispose?.();
  msfileRuntime = undefined;
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
    const summary = typeof storageRuntime?.getProviderSummary === "function"
      ? await storageRuntime.getProviderSummary().catch(() => null)
      : null;
    const revision = storageRevision + 1;
    const runtimeStatus = typeof storageRuntime?.status === "function" ? storageRuntime.status() : undefined;
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
      capabilities: typeof storageRuntime?.getConditionalCapabilities === "function"
        ? storageRuntime.getConditionalCapabilities()
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
async function runStorageRecoveryOrchestrator(): Promise<void> {
  if (storageRecoveryOrchestrator) return storageRecoveryOrchestrator;
  storageRecoveryOrchestrator = (async () => {
    if (!platformRootStore) {
      if (!storageBootstrapState) throw storageUnavailableError("Storage bootstrap selection is unavailable");
      // StorageBootstrapController 的自动重试可能已经拿到 provider/bucket，
      // 但当时还没有安装 Root。优先消费这份 Coordinator 内部结果，避免
      // 因为重新解密 Profile（密码未持久化）而把一次成功恢复重新变成认证失败。
      const recoveredProvider = storageBootstrapController?.getProvider();
      const recoveredBucket = storageBootstrapController?.getBucket();
      if (recoveredProvider && recoveredBucket) {
        storageRootInstallationActive = true;
        try {
          await installPlatformStorage(
            recoveredProvider,
            recoveredBucket,
            storageBootstrapState?.selectedBucket ? undefined : undefined,
          );
        } finally {
          storageRootInstallationActive = false;
        }
      } else {
        await bootstrapPlatformStorage();
      }
    } else {
      // 恢复只替换当前底层绑定；任务 runtime 仍持有 wrapper，不能把
      // wrapper 永久 close，否则恢复后的下一次调度必然失败。
      for (const store of workerOwnerStores) store.invalidateBinding();
      ownerStorageGrants.clear();
      platformStorageGrants.clear();
    }
    platformStorageReady = true;
    // Root ready 之后，所有恢复性读写都必须先取得共享 Coordinator 权威。
    // 否则两个 Worker 可能同时消费同一删除 Journal 或恢复同一 owner。
    await ensureCoordinatorAuthorityClaim();
    // Root ready 只是恢复的第一道门。必须先收敛所有未完成的删除
    // Journal，再恢复任务；否则旧任务可能在 owner 清理之后重新写入。
    const unfinishedDeletionJournals = await withCoordinatorFinalIoLease(
      "write",
      undefined,
      async () => {
        await recoverKeyDeletionJournals();
        return readKeyDeletionJournals();
      },
      { allowLocalLock: true, auditOperation: "keyspace.delete-journal.recover" },
    );
    if (unfinishedDeletionJournals.length > 0) {
      throw storageUnavailableError("Key deletion recovery is incomplete");
    }
    const recoveryComplete = await resumeAfterStorageReady();
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
async function probeStorageAndRecover(): Promise<void> {
  const snapshot = await storageHealthController.probe(
    async () => {
      const provider = platformBucketProvider;
      if (!provider) throw Object.assign(new Error("Storage provider is unavailable"), { code: "storage_unavailable" });
      const result = await provider.probe();
      if (!result.ok || result.conditionalWrites !== "native") {
        throw Object.assign(new Error("Storage bucket does not support required conditional writes"), { code: "storage_provider_error" });
      }
    },
    async () => {
      await runStorageRecoveryOrchestrator();
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

async function ensureStorageRuntime(): Promise<StorageRuntimeController> {
  if (storageRuntime) return storageRuntime;
  if (testStorageRuntimeOverride) {
    storageRuntime = testStorageRuntimeOverride;
    const unit = coordinatorWorkerUnitRegistry.activate("storage.coordinator-worker");
    coordinatorWorkerUnitRegistry.ready(unit.unitId, unit.instanceId);
    platformStorageReady = true;
    reconcileCoordinatorRuntime();
    return storageRuntime;
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
      if (!platformRootStore) await bootstrapPlatformStorage();
      const root = platformRootStore;
      if (!root) throw new Error("Platform storage root is unavailable");
      storageRepository = await openMultipartUploadRepository(await root.openPlatformStore({ applicationStorageId: "storage", schemaVersion: 1 }));
    }
  } catch (error) { startupError(error); }
  const multipartUploadRepository = storageRepository;
  if (!multipartUploadRepository) return startupError(new Error("Storage repository is unavailable"));
  const key = storageProfileKey;
  if (!key) return startupError(new Error("Storage Profile is unavailable"));
  const secret = createStorageRuntimeSecret(key);
  let runtime: StorageRuntimeController;
  try {
    runtime = await createStorageRuntimeController({
      multipartUploadRepository,
      // 文件 API 直接使用 Provider，必须和 owner K-V 一样经过桶级生命
      // 周期栅栏；否则另一个 Coordinator 删除 owner 时，迟到 PUT 仍可复活文件。
      bucketProvider: platformBucketProvider ? createOwnerLifecycleGuardedProvider(platformBucketProvider) : undefined,
      bucketGeneration: platformRootStore?.bucket.bucketGeneration,
      secret,
      logger: { warn: (event) => undefined }
    });
  } catch (error) {
    startupError(error);
  }
  storageRuntime = runtime!;
  const storageUnit = coordinatorWorkerUnitRegistry.activate("storage.coordinator-worker");
  coordinatorWorkerUnitRegistry.ready(storageUnit.unitId, storageUnit.instanceId);
  platformStorageReady = true;
  reconcileCoordinatorRuntime();
  storageStartupFailure = false;
  storageRuntime.subscribe(emitStorageState);
  emitStorageState();
  return storageRuntime;
}

/** Storage 选定/解锁后统一恢复 Root、Vault metadata、runtime 与任务。 */
async function resumeAfterStorageReady(): Promise<boolean> {
  storageStartupFailure = false;
  platformStorageReady = true;
  reconcileCoordinatorRuntime();
  if (coordinatorState.vaultStatus === "booting") {
    // 初始 initializeCoordinator 正在等待 bootstrapPlatformStorage；健康探测
    // 的 recovery finalize 不能再次启动一个嵌套 initialize，否则会互相等待。
    if (coordinatorInitializationInProgress) return false;
    coordinatorInitialization = initializeCoordinator(true, true);
    await coordinatorInitialization;
    return true;
  }
  await ensureStorageRuntime();
  if (coordinatorState.taskRuntimes.size === 0) await registerCoordinatorTasks();
  for (const runtime of coordinatorState.taskRuntimes.values()) {
    if (runtime.state === "blocked" && runtime.blockedReason === "Storage unavailable") {
      runtime.state = "idle";
      runtime.blockedReason = undefined;
      scheduleRuntime(runtime);
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
  (storageRuntime as (StorageRuntimeController & { dispose?: () => void }) | undefined)?.dispose?.();
  storageRuntime = undefined;
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

/** WebLoom 0.4.2 endpoint 字段的领域侧窄投影；不把框架对象泄漏进持久化。 */
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

/** 将旧 Provider 内部请求收窄为 Window reverse capability 的纯 DTO。 */
function coordinatorLocalStorageRequest(input: LocalStorageBridgeRequest, binding: CoordinatorSessionBinding): CoordinatorLocalStorageRequest {
  const withoutSignal = bridgeRequestWithoutSignal(input) as unknown as Record<string, unknown>;
  const { authorityInstanceId: _authorityInstanceId, leaseId: _leaseId, peerGeneration: _peerGeneration, sessionEpoch: _sessionEpoch, ...request } = withoutSignal;
  return { ...request, ...binding } as unknown as CoordinatorLocalStorageRequest;
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
    }) as Promise<LocalStorageBridgeResponse>;
    return Promise.resolve(call).then((response) => {
      assertCoordinatorBridgeFresh(state, binding, opening);
      return response;
    }).finally(cleanup);
  } catch (error) {
    cleanup();
    return Promise.reject(error);
  }
}

/**
 * 让页面在同一把目录 Web Lock 中完成 Coordinator-owned 目录 CAS。
 * 改密不能只靠 RPC 返回后再由页面“顺手 updateBucket”，否则页面写目录
 * 失败时 Worker 已经可能发布了新快照。这个窄桥只传输新旧加密条目，
 * 不传密码、私钥或明文连接配置。
 */
async function updateLocalStorageCatalogEntry(
  expectedBucket: StorageBucketCatalogEntryV2,
  nextBucket: StorageBucketCatalogEntryV2,
  bucketGeneration: number,
  rollback = false,
): Promise<StorageBucketCatalogEntryV2> {
  const response = await requestLocalStorageBridge({
    type: "catalog-update",
    bucketId: expectedBucket.bucketId,
    bucketGeneration,
    expectedBucket,
    nextBucket,
    ...(rollback ? { rollback: true } : {}),
  });
  if (response.type !== "catalog") throw storageUnavailableError("Local storage catalog bridge returned an invalid response");
  return response.bucket;
}

/** 在目标 Provider/Root 已经完成暂存后，最后一步才切换本机目录选项。 */
async function selectLocalStorageCatalogBucket(
  targetBucket: StorageBucketCatalogEntryV2,
  expectedSelectedBucketId: string,
  bucketGeneration: number,
  rollbackFromSelectedBucketId?: string,
): Promise<StorageBucketCatalogEntryV2> {
  const response = await requestLocalStorageBridge({
    type: "catalog-select",
    bucketId: targetBucket.bucketId,
    bucketGeneration,
    expectedSelectedBucketId,
    ...(rollbackFromSelectedBucketId ? { rollbackFromSelectedBucketId } : {}),
    targetBucket,
  });
  if (response.type !== "catalog") throw storageUnavailableError("Local storage catalog bridge returned an invalid selection result");
  return response.bucket;
}

/** 首次初始化的单一目录提交点；提交前目录必须为空，回滚只删除同一候选条目。 */
async function commitInitialStorageCatalogBucket(
  targetBucket: StorageBucketCatalogEntryV2,
  bucketGeneration: number,
  rollback = false,
): Promise<StorageBucketCatalogEntryV2> {
  const response = await requestLocalStorageBridge({
    type: "catalog-commit",
    bucketId: targetBucket.bucketId,
    bucketGeneration,
    targetBucket,
    ...(rollback ? { rollback: true } : {}),
  });
  if (response.type !== "catalog") throw storageUnavailableError("Local storage catalog commit bridge returned an invalid response");
  return response.bucket;
}

/** 发布桶内 Key 快照后同步本机目录中的提交版本。 */
async function updateCurrentCatalogSnapshotRevision(snapshotRevision: number): Promise<void> {
  const entry = selectedCatalogBucket();
  const root = platformRootStore;
  if (!entry || !root) throw storageUnavailableError("The selected catalog bucket is unavailable");
  if (entry.snapshotRevision === snapshotRevision) return;
  const updated = await updateLocalStorageCatalogEntry(
    entry,
    { ...entry, snapshotRevision },
    root.bucket.bucketGeneration,
  );
  storageBootstrapState = storageBootstrapState
    ? { ...storageBootstrapState, selectedBucket: updated }
    : storageBootstrapState;
}

// ============================================================
// 2. Worker Global State
// ============================================================

const coordinatorState: CoordinatorState = {
  sessionEpoch: generateEpoch(),
  vaultStatus: "booting",
  keyspaceGeneration: 0,
  taskRuntimes: new Map(),
  scheduleSettings: { assetHoldingsIntervalMs: 900_000 },
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

function activateCoordinatorOwnerWorkerUnit(
  unitId: string,
  instanceId?: string,
): ReturnType<typeof coordinatorWorkerUnitRegistry.activate> {
  const descriptor = COORDINATOR_WORKER_UNIT_CATALOG.find((unit) => unit.unitId === unitId);
  if (descriptor && !isCoordinatorProductEnabled(descriptor.productId)) {
    throw new Error(`Plugin disabled: ${descriptor.productId}`);
  }
  const existing = coordinatorWorkerUnitRegistry.get(unitId);
  if (existing && instanceId !== undefined && existing.instanceId !== instanceId) {
    // The registry is only a compatibility table. A Host setup owns the real
    // instance identity, so discard an older compatibility entry before
    // binding the exact Host context instance.
    coordinatorWorkerUnitRegistry.stop(unitId, existing.instanceId);
  }
  return coordinatorWorkerUnitRegistry.activate(unitId, {
    ...currentOwnerWorkerUnitIdentity(),
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
      unitSnapshot = coordinatorWorkerUnitRegistry.activate(unit.unitId, identity);
      unitSnapshot = coordinatorWorkerUnitRegistry.ready(unit.unitId, unitSnapshot.instanceId);
      activated.set(unit.unitId, unitSnapshot);
    }
    runtime.instanceId = unitSnapshot.instanceId;
  }
  // 这些服务由 registerCoordinatorTasks() 实际创建；它们没有独立周期
  // task，但仍必须和当前 owner 绑定，不能只依赖产品 manifest。
  for (const unitId of ["woc.coordinator-worker", "junglebus.coordinator-worker"] as const) {
    const serviceUnit = unitId === "woc.coordinator-worker" ? p2pkhWocService : p2pkhJungleBusClient;
    if (!serviceUnit) continue;
    const productId = unitId === "woc.coordinator-worker" ? "woc" : "junglebus";
    if (!isCoordinatorProductEnabled(productId, snapshot)
      || (productId === "junglebus" && coordinatorMeta.p2pkhProviderConfigs?.junglebus?.enabled === false)) continue;
    let unitSnapshot = activated.get(unitId);
    if (!unitSnapshot) {
      unitSnapshot = coordinatorWorkerUnitRegistry.activate(unitId, identity);
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

const PASSKEY_ADD_INTENT_TTL_MS = 120_000;
const passkeyAddIntents = new Map<string, {
  publicKeyHex: string;
  sessionEpoch: SessionEpoch;
  label: string;
  expiresAt: number;
}>();
function prunePasskeyAddIntents(now = Date.now()): void {
  for (const [intentId, intent] of passkeyAddIntents) {
    if (intent.expiresAt <= now) passkeyAddIntents.delete(intentId);
  }
  while (passkeyAddIntents.size >= 32) {
    const oldestIntentId = passkeyAddIntents.keys().next().value as string | undefined;
    if (!oldestIntentId) break;
    passkeyAddIntents.delete(oldestIntentId);
  }
}
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
  // P2PKH 同步的实际网络 Provider 是产品依赖的一部分。仅禁用 p2pkh
  // 自身还不够：WOC/JungleBus 被停用时，任务也必须在入口处阻断，而不是
  // 先启动一次再等到 registry 报 provider-unavailable。
  if (runtime.id === "p2pkh.transactions-sync" || runtime.id === "token-bsv21.sync" || runtime.id === "token-stas.sync" || runtime.id === "collectible-1satordinals.sync") {
    const selected = coordinatorMeta.p2pkhProviders;
    const providerIds = [
      selected?.main.syncProviderId,
      ...(coordinatorMeta.p2pkhSettings?.includeTestnet ? [selected?.test.syncProviderId] : []),
    ];
    for (const providerId of providerIds) {
      if ((providerId === "woc" || providerId === "junglebus") && !dependencies.includes(providerId)) dependencies.push(providerId);
    }
  }
  const disabled = dependencies.find((pluginId) => !isCoordinatorProductEnabled(pluginId, snapshot));
  return disabled ? `Plugin disabled: ${disabled}` : undefined;
}

function isPluginIntentBlockedReason(reason: string | undefined): boolean {
  return typeof reason === "string" && reason.startsWith("Plugin disabled: ");
}

/** Provider 重建后允许重新排程的可恢复阻塞；不是未知写入结果。 */
function isProviderAvailabilityBlockedReason(reason: string | undefined): boolean {
  return typeof reason === "string"
    && (reason.startsWith("Selected confirmed provider is unavailable:")
      || reason.startsWith("No confirmed sync provider selected for "));
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
  const hasWocConfirmed = Boolean(p2pkhRegistry.getConfirmedProvider("woc", "main"));
  const hasWocBroadcast = Boolean(p2pkhRegistry.getBroadcastProvider("woc", "main"));
  if (!wocEnabled) {
    if (hasWocConfirmed) {
      p2pkhRegistry.unregisterConfirmedProvider?.("woc");
      changed = true;
    }
    if (hasWocBroadcast) {
      p2pkhRegistry.unregisterBroadcastProvider?.("woc");
      changed = true;
    }
  } else if (p2pkhWocService && (!hasWocConfirmed || !hasWocBroadcast)) {
    // WOC 同时提供 confirmed 和 broadcast；若某一侧缺失，先移除另一侧
    // 再由同一个工厂完整注册，避免 registry duplicate provider。
    if (hasWocConfirmed) p2pkhRegistry.unregisterConfirmedProvider?.("woc");
    if (hasWocBroadcast) p2pkhRegistry.unregisterBroadcastProvider?.("woc");
    registerWocP2pkhProviders({ registry: p2pkhRegistry, woc: p2pkhWocService });
    changed = true;
  }

  const jungleBusEnabled = isCoordinatorProductEnabled("junglebus", snapshot)
    && coordinatorMeta.p2pkhProviderConfigs?.junglebus?.enabled !== false;
  const hasJungleBus = Boolean(p2pkhRegistry.getConfirmedProvider("junglebus", "main"));
  if (!jungleBusEnabled) {
    if (hasJungleBus) {
      p2pkhRegistry.unregisterConfirmedProvider?.("junglebus");
      changed = true;
    }
  } else if (!hasJungleBus && p2pkhJungleBusClient) {
    registerJungleBusP2pkhProvider({ registry: p2pkhRegistry, client: p2pkhJungleBusClient });
    changed = true;
  }
  if (changed) {
    // Provider 被撤权后，清理旧的 in-progress checkpoint；恢复时由同一
    // task 再按当前 provider generation 建立新的 checkpoint。
    void cancelP2pkhSyncForProviderChange().catch(() => undefined);
    publishTopicEvent("p2pkh.providers", { type: "p2pkh.providers.changed", snapshot: getP2pkhProviderSnapshot() });
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
  if (!runtime.intervalMs) return;
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
  // 先投影 Provider，再重算任务状态。启用 WOC/JungleBus 时，旧的
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
    generation: coordinatorMeta.generation,
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
    passkeyAddIntents.clear();
    coordinatorState.activePublicKeyHex = activePublicKeyHex;
    coordinatorMeta.selectedPublicKeyHex = activePublicKeyHex;
    coordinatorMeta.generation = coordinatorState.keyspaceGeneration;
    replaceActivePrivateKey(activePrivateKeyBytes);
    await persistCoordinatorMeta();
    // 只有 metadata 持久化和新的 owner 状态都准备好后，才重新打开最终
    // 存储/签名 I/O 门禁；失败会沿用下面的 fail-closed 回滚路径。
    await ensureCoordinatorUpgradeSession();
    completeActiveStorageOwnerTransition(transition);
  } catch (error) {
    const failedClosed = previous.vaultStatus === "unlocked" && coordinatorState.vaultStatus !== "unlocked";
    if (failedClosed) {
      // drain 超时已经由 transition 主动进入 locked；绝不能把旧私钥/旧
      // active owner 从回滚分支重新暴露出来。
      dropActivePrivateKey();
      coordinatorMeta.selectedPublicKeyHex = previous.selectedPublicKeyHex;
      coordinatorMeta.generation = coordinatorState.keyspaceGeneration;
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
    invalidateFailedKeyspaceTransition(Math.max(previous.generation, previous.keyspaceGeneration));
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

  publishSessionState(cause);
  // 解锁后立即建立 owner-scoped Sat runtime 和 owner inbox 的系统 caller。
  // 连接/供应商暂不可用时只记录诊断；owner 的订阅意图仍留在 Sat K-V/Mux，
  // 后续重连或设置变更会继续对账。
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
function createWorkerOwnerStore(pluginId: string, schemaVersion: number): KeyValueStore {
  const declaration = SYSTEM_STORAGE_DECLARATIONS[pluginId];
  if (!declaration || declaration.scope !== "key" || declaration.schemaVersion !== schemaVersion) throw new Error(`Unknown owner storage declaration: ${pluginId}`);
  const applicationStorageId = declaration.applicationStorageId;
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
      const opened = await root.openKeyValueStore({ ownerPublicKeyHex: owner, applicationStorageId, schemaVersion, keyspaceGeneration: expectedGeneration });
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
    // 副作用；仍保留当前 authority 的前后校验，但不把页面卸载时的
    // 读 Promise 留成新 Worker 的恢复阻断。
    durableLease: operation === "write",
  });
  const handle = {
    get bucketId() { return current?.bucketId ?? "pending"; },
    get bucketGeneration() { return current?.bucketGeneration ?? 0; },
    get ownerPublicKeyHex() { return ownerPublicKeyHex ?? ""; },
    applicationStorageId,
    get: async <T = KeyValueValue>(key: string, options?: { partition?: string }) => run("read", (store) => store.get<T>(key, options)),
    list: async (input: KeyValueListInput = {}) => run("read", (store) => store.list(input)),
    put: async <T = KeyValueValue>(key: string, value: T, condition?: { ifRevision?: number; partition?: string }) => run("write", (store) => store.put<T>(key, value, condition)),
    delete: async (key: string, condition?: { ifRevision?: number; partition?: string }) => { await run("write", (store) => store.delete(key, condition)); },
    commit: async (input: KeyValueCommitInput) => run("write", (store) => store.commit(input)),
    close: () => { if (closed) return; closed = true; invalidateBinding(); workerOwnerStores.delete(handle); },
    invalidateBinding: () => { if (!closed) invalidateBinding(); }
  } as KeyValueStore & WorkerOwnerStoreBinding;
  workerOwnerStores.add(handle);
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
      p2pkhProvidersGet: async (): Promise<CoordinatorValueResult<P2pkhProviderRegistrySnapshot>> => {
        if (!isCoordinatorProductEnabled("p2pkh")) {
          return {
            status: "blocked",
            reason: { key: "plugin.blocked.disabled", fallback: "Plugin disabled: p2pkh" },
          };
        }
        return {
          status: "ok",
          value: getP2pkhProviderSnapshot(),
          sessionEpoch: coordinatorState.sessionEpoch,
        };
      },
      p2pkhBroadcast: async (input: { ownerPublicKeyHex: string; network: "main" | "test"; submissionId: string; expectedProviderGeneration: number }): Promise<CoordinatorValueResult<unknown>> => {
        if (!isCoordinatorProductEnabled("p2pkh")) {
          return {
            status: "blocked",
            reason: { key: "plugin.blocked.disabled", fallback: "Plugin disabled: p2pkh" },
          };
        }
        if (coordinatorState.vaultStatus !== "unlocked" || coordinatorState.sessionEpoch !== ownerSessionEpoch || coordinatorState.activePublicKeyHex !== ownerPublicKeyHex) {
          return { status: "stale-epoch" };
        }
        const request = {
          kind: "p2pkh.broadcast" as const,
          clientId: "sat-subscription",
          requestId: generateRequestId(),
          ...input,
          expectedSessionEpoch: coordinatorState.sessionEpoch,
        };
        const response = await handleP2pkhBroadcast(request.requestId, request);
        if (response.ack.status !== "ok") return response.ack;
        if (coordinatorState.vaultStatus !== "unlocked" || coordinatorState.activePublicKeyHex !== ownerPublicKeyHex) {
          return { status: "stale-epoch" };
        }
        return { status: "ok", value: response.operationResult, sessionEpoch: response.sessionEpoch };
      },
    } as unknown as import("@keymaster/contracts").SessionCoordinatorClient;
    const service = createP2pkhService({ vault, coordinator: internalCoordinator, messageBus, keyspace });
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

async function registerCoordinatorTasks(): Promise<void> {
  const keyspace = createWorkerKeyspace();
  const messageBus = createMessageBus();
  coordinatorContactsPresenceOff?.();
  coordinatorContactsPresenceOff = undefined;
  coordinatorContactsService?.dispose?.();
  const contactsService = createContactsService({
    keyspace,
    messageBus,
    storage: createWorkerOwnerStore("contacts", CONTACTS_SCHEMA_VERSION),
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
    intervalMs: contactsPresenceTask.schedule?.defaultIntervalMs ?? 5 * 60 * 1000,
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
  const persistedWocConfig = coordinatorMeta.p2pkhProviderConfigs?.woc;
  if (persistedWocConfig) {
    const next: Partial<import("@keymaster/contracts").WocConfig> = {};
    if (typeof persistedWocConfig.endpoint === "string" && persistedWocConfig.endpoint.trim()) next.baseUrl = persistedWocConfig.endpoint.trim();
    if (typeof persistedWocConfig.requestsPerSecond === "number") next.requestsPerSecond = persistedWocConfig.requestsPerSecond;
    if (Object.keys(next).length) woc.updateConfig(next);
  }
  const emitDataChanged = (providerId: string, kinds: AssetDataInvalidationEvent["kinds"]) => publishTopicEvent("asset.data-changed", { type: "asset.data-changed", providerId, publicKeyHex: coordinatorState.activePublicKeyHex ?? "", kinds });
  p2pkhRegistry = createP2pkhProviderRegistry();
  registerWocP2pkhProviders({ registry: p2pkhRegistry, woc });
  const jungleBusConfig = coordinatorMeta.p2pkhProviderConfigs?.junglebus ?? {};
  const jungleBus = createJungleBusClient({
    ...(typeof jungleBusConfig.endpoint === "string" ? { baseUrl: jungleBusConfig.endpoint } : {}),
    ...(typeof jungleBusConfig.mainEndpoint === "string" ? { mainBaseUrl: jungleBusConfig.mainEndpoint } : {}),
    ...(typeof jungleBusConfig.testEndpoint === "string" ? { testBaseUrl: jungleBusConfig.testEndpoint } : {}),
    ...(typeof jungleBusConfig.timeoutMs === "number" ? { timeoutMs: jungleBusConfig.timeoutMs } : {}),
    ...(typeof jungleBusConfig.maxRetries === "number" ? { maxRetries: jungleBusConfig.maxRetries } : {}),
    ...(typeof jungleBusConfig.requestsPerSecond === "number" ? { requestsPerSecond: jungleBusConfig.requestsPerSecond } : {})
  });
  p2pkhJungleBusClient = jungleBus;
  if (jungleBusConfig.enabled !== false) {
    registerJungleBusP2pkhProvider({ registry: p2pkhRegistry, client: jungleBus });
  }
  const providerSettings = () => coordinatorMeta.p2pkhProviders ?? (coordinatorMeta.p2pkhProviders = defaultP2pkhProviders());
  const p2pkh = createP2pkhCoordinatorTasks({ keyspace, storage: createWorkerOwnerStore("p2pkh", P2PKH_REPOSITORY_VERSION), registry: p2pkhRegistry, getSelection: (network) => { const selection = providerSettings()[network]; return { syncProviderId: selection.syncProviderId, generation: providerSettings().generation }; }, isGenerationCurrent: (_network, generation) => generation === providerSettings().generation, isNetworkEnabled: (network) => network === "main" || coordinatorMeta.p2pkhSettings?.includeTestnet === true });
  // The ordinary BSV confirmed pipeline has exactly one task.
  const assetHoldingsIntervalMs = coordinatorState.scheduleSettings.assetHoldingsIntervalMs;
  coordinatorState.taskRuntimes.set("p2pkh.transactions-sync", createCoordinatorTaskRuntime({ id: "p2pkh.transactions-sync", pluginId: "p2pkh", unitId: p2pkh.unitId, intervalMs: assetHoldingsIntervalMs, keyScope: () => coordinatorState.activePublicKeyHex ? { publicKeyHex: coordinatorState.activePublicKeyHex } : undefined, run: async ({ signal, assertSessionFresh }) => { const result = await p2pkh.transactionsSync(signal); assertSessionFresh(); if (!result.cancelled) emitDataChanged("p2pkh", ["resource", "utxo", "history"]); } }));
  const p2pkhProvider = {
    listResources: async (assetId: "bsv" | "bsvtest") => {
      if (!coordinatorState.activePublicKeyHex) return [];
      const repository = createP2pkhStateRepository(await openP2pkhStateRepository(createWorkerOwnerStore("p2pkh", P2PKH_REPOSITORY_VERSION)));
      return (await repository.listResourcesByKey()).filter((resource) => assetId === (resource.network === "main" ? "bsv" : "bsvtest"));
    },
    listUtxos: async (filter?: { assetId?: "bsv" | "bsvtest"; ownerPublicKeyHex?: string }) => {
      const ownerPublicKeyHex = filter?.ownerPublicKeyHex ?? coordinatorState.activePublicKeyHex;
      if (!ownerPublicKeyHex) return [];
      if (keyspace.active().activePublicKeyHex?.toLowerCase() !== ownerPublicKeyHex.toLowerCase()) throw new Error("P2PKH storage owner is not active");
      const repository = createP2pkhStateRepository(await openP2pkhStateRepository(createWorkerOwnerStore("p2pkh", P2PKH_REPOSITORY_VERSION)));
      const utxos = await repository.listUtxos();
      return utxos.filter((utxo) => {
        if (filter?.assetId && filter.assetId !== (utxo.network === "main" ? "bsv" : "bsvtest")) return false;
        return true;
      });
    },
    getGlobalSettings: () => ({ includeTestnet: coordinatorMeta.p2pkhSettings?.includeTestnet === true })
  };
  const vault = { status: () => coordinatorState.vaultStatus, } as VaultService;
  const bsv21Task = createBsv21CoordinatorTask({ keyspace, store: createWorkerOwnerStore("token-bsv21", BSV21_SCHEMA_VERSION), p2pkh: p2pkhProvider, woc: createWocBsv21Service({ messageBus }), wocService: woc, vault, notifier: { emit: (event) => publishTopicEvent("asset.data-changed", { type: "asset.data-changed", providerId: event.providerId, publicKeyHex: event.publicKeyHex ?? "", kinds: event.kinds }), subscribe: () => () => undefined } });
  const stasTask = createStasCoordinatorTask({ keyspace, store: createWorkerOwnerStore("token-stas", STAS_SCHEMA_VERSION), p2pkh: p2pkhProvider, woc: createWocStasService({ messageBus }), vault, notifier: { emit: (event) => publishTopicEvent("asset.data-changed", { type: "asset.data-changed", providerId: event.providerId, publicKeyHex: event.publicKeyHex ?? "", kinds: event.kinds }), subscribe: () => () => undefined } });
  const oneSatTask = createOrdinalsCoordinatorTask({ keyspace, p2pkh: p2pkhProvider, woc: createWoc1SatOrdinalsService({ messageBus }), wocService: woc, vault, notifier: { emit: (event) => publishTopicEvent("asset.data-changed", { type: "asset.data-changed", providerId: event.providerId, publicKeyHex: event.publicKeyHex ?? "", kinds: event.kinds }), subscribe: () => () => undefined } });
  coordinatorState.taskRuntimes.set(bsv21Task.id, createCoordinatorTaskRuntime({ id: bsv21Task.id, pluginId: "token-bsv21", unitId: bsv21Task.unitId, intervalMs: assetHoldingsIntervalMs, keyScope: () => coordinatorState.activePublicKeyHex ? { publicKeyHex: coordinatorState.activePublicKeyHex } : undefined, run: async ({ signal, reason, assertSessionFresh }) => { await bsv21Task.run({ signal, reason, reportProgress: () => undefined, assertSessionFresh }); } }));
  coordinatorState.taskRuntimes.set(stasTask.id, createCoordinatorTaskRuntime({ id: stasTask.id, pluginId: "token-stas", unitId: stasTask.unitId, intervalMs: assetHoldingsIntervalMs, keyScope: () => coordinatorState.activePublicKeyHex ? { publicKeyHex: coordinatorState.activePublicKeyHex } : undefined, run: async ({ signal, reason, assertSessionFresh }) => { await stasTask.run({ signal, reason, reportProgress: () => undefined, assertSessionFresh }); } }));
  coordinatorState.taskRuntimes.set(oneSatTask.id, createCoordinatorTaskRuntime({ id: oneSatTask.id, pluginId: "collectible-1satordinals", unitId: oneSatTask.unitId, intervalMs: assetHoldingsIntervalMs, keyScope: () => coordinatorState.activePublicKeyHex ? { publicKeyHex: coordinatorState.activePublicKeyHex } : undefined, run: async ({ signal, reason, assertSessionFresh }) => { await oneSatTask.run({ signal, reason, reportProgress: () => undefined, assertSessionFresh }); } }));
  bindCoordinatorTaskUnitsToOwner();
  // Provider 初始注册必须再经过产品意图投影；否则 Worker 重启时若持久
  // 快照已禁用 WOC/JungleBus，短窗口内仍会把旧 Provider 暴露给任务。
  reconcileCoordinatorProviderIntent(currentPluginIntentSnapshot());
  for (const runtime of coordinatorState.taskRuntimes.values()) scheduleRuntime(runtime);
  publishTopicEvent("background.snapshot", { type: "background.snapshot.changed", sessionEpoch: coordinatorState.sessionEpoch, snapshots: getTaskSnapshots() });
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

function isP2pkhBroadcastRequest(request: CoordinatorClientRequest): request is Extract<CoordinatorClientRequest, { kind: "p2pkh.broadcast" | "p2pkh.rebroadcast-ancestors" }> {
  return request.kind === "p2pkh.broadcast" || request.kind === "p2pkh.rebroadcast-ancestors";
}

/** Remove a submission only when the Coordinator can prove no provider call was made. */
async function abortNotDispatchedP2pkhSubmission(
  request: Extract<CoordinatorClientRequest, { kind: "p2pkh.broadcast" | "p2pkh.rebroadcast-ancestors" }>,
  reason: string
): Promise<void> {
  // A rebroadcast may be the first request after an earlier Worker died
  // after crossing the network boundary. An empty attempt list is therefore
  // not evidence that this submission is safe to release.
  if (request.kind !== "p2pkh.broadcast") return;
  try {
    const keyspace = createWorkerKeyspace();
    if (keyspace.active().activePublicKeyHex?.toLowerCase() !== request.ownerPublicKeyHex.toLowerCase()) throw new Error("P2PKH storage owner is not active");
    const repository = createP2pkhStateRepository(await openP2pkhStateRepository(createWorkerOwnerStore("p2pkh", P2PKH_REPOSITORY_VERSION)));
    await repository.abortUnattemptedLocalSubmission?.({ submissionId: request.submissionId, reason, requestKind: "initial" });
    publishTopicEvent("asset.data-changed", { type: "asset.data-changed", providerId: "p2pkh", publicKeyHex: request.ownerPublicKeyHex, kinds: ["utxo", "submission", "claim"] });
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
      const summary = typeof storageRuntime?.getProviderSummary === "function"
        ? storageRuntime.getProviderSummary().catch(() => null)
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
    if (topic === "p2pkh.providers") {
      return [{ topic, baselineRevision: p2pkhProviderRevision, sessionEpoch: coordinatorState.sessionEpoch, snapshot: { topic, type: "p2pkh.providers.changed" as const, providerRevision: p2pkhProviderRevision, sessionEpoch: coordinatorState.sessionEpoch, snapshot: getP2pkhProviderSnapshot() } }];
    }
    if (topic === "msfile.state") {
      const baselineRevision = msfileRevision;
      const cached = lastMsFileState ?? {
        topic: "msfile.state" as const, type: "msfile.state.changed" as const,
        msfileRevision: baselineRevision, sessionEpoch: coordinatorState.sessionEpoch,
        status: (coordinatorState.vaultStatus === "unlocked" ? "unconfigured" : "unavailable") as import("@keymaster/contracts").MsFileServiceStatus,
        supplierGeneration: 0, globalSettings: null,
        ...MSFILE_READ_CONCURRENCY_RECOMMENDED,
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
      return [{
        topic,
        baselineRevision: channelRevision,
        sessionEpoch: coordinatorState.sessionEpoch,
        snapshot: {
          topic: "channel.events" as const,
          type: "channel.message.received" as const,
          channelRevision,
          sessionEpoch: coordinatorState.sessionEpoch
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
      ? { topic, type: "session.state.changed" as const, sessionRevision: baselineRevision, sessionEpoch: coordinatorState.sessionEpoch, cause: "bootstrap" as const, vaultStatus: coordinatorState.vaultStatus, activePublicKeyHex: coordinatorState.vaultStatus === "unlocked" ? coordinatorState.activePublicKeyHex ?? null : null, selectedPublicKeyHex: coordinatorMeta.selectedPublicKeyHex ?? null, keyspaceGeneration: coordinatorState.keyspaceGeneration }
        : { topic, type: "background.snapshot.changed" as const, backgroundSnapshotRevision: baselineRevision, sessionEpoch: coordinatorState.sessionEpoch, snapshots: getTaskSnapshots(), scheduleSettings: coordinatorState.scheduleSettings };
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
    if (control.type === "unlock-profile" || control.type === "unlock-bucket" || control.type === "import-profile" || control.type === "switch-bucket" || control.type === "change-bucket-config") {
      control.password = "";
    }
    if (control.type === "initial-setup") {
      control.plan.bucketPassword = "";
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
    if (control.type === "activate") {
      if (control.config.profilePassword !== undefined) control.config.profilePassword = undefined;
      if (control.config.credentials.mode === "replace") {
        control.config.credentials.accessKeyId = "";
        control.config.credentials.secretAccessKey = "";
      }
    }
    if (control.type === "change-bucket-password") {
      control.oldPassword = "";
      control.newPassword = "";
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

/** 首次 S3 配置必须先形成冷启动 Profile，再探测并绑定统一桶。 */
async function prepareInitialS3Storage(config: import("@keymaster/contracts").StorageProviderConfigDraft): Promise<import("@keymaster/contracts").StorageSelectedResult> {
  if (platformRootStore) return { status: "selected", backend: "s3", requiresRuntimeBootstrap: true };
  const password = config.profilePassword;
  if (!password || password.length < 8) throw Object.assign(new Error("Storage Profile password is required"), { code: "storage_identity_required" });
  const normalized = normalizeProviderConfig(config);
  const envelope = await encryptStorageProfile(normalized, password);
  storageBootstrapState = {
    selectedBackend: "s3",
    selectedProfileId: `${normalized.providerId}:${(normalized.connection as { bucket: string }).bucket}`,
    encryptedStorageProfileEnvelope: envelope
  };
  await bootstrapPlatformStorage(password);
  await setStorageProfilePassword(password);
  await runStorageRecoveryOrchestrator();
  return { status: "selected", backend: "s3", requiresRuntimeBootstrap: true };
}

async function executeStorageControl(request: Extract<CoordinatorClientRequest, { kind: "storage.control" }>, signal?: AbortSignal): Promise<CoordinatorResponse> {
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
    const service = await ensureStorageRuntime().catch(() => undefined);
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
        await bootstrapPlatformStorage();
      } else if (platformBucketProvider) {
        await probeStorageAndRecover();
      } else {
        throw storageUnavailableError("Storage provider is unavailable");
      }
      // 初次 bootstrap 失败时，原初始化 Promise 已经结束；恢复成功后
      // 重新执行同一段 Vault metadata bootstrap，不绕过 Storage-first 门禁。
      if (platformRootStore && storageHealthController.status() !== "ready") {
        await runStorageRecoveryOrchestrator();
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
    const service = await ensureStorageRuntime();
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: await service.getProviderSummary() };
  }
  if (control.type === "connection") {
    const service = await ensureStorageRuntime();
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: await service.getProviderConnection() };
  }
  if (control.type === "initial-setup") {
    const result = await executeInitialSetupOnce(control.plan);
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: result };
  }
  if (control.type === "initial-setup-result") {
    const result = await getInitialSetupResult(control.transactionId);
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: result };
  }
  if (control.type === "initial-setup-recovery-list") {
    const records = await listInitialSetupRecoveries();
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: records };
  }
  if (control.type === "initial-setup-cleanup") {
    try {
      const result = await retryInitialSetupCleanupTransaction(control.transactionId, control);
      return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: result };
    } finally {
      if (control.password !== undefined) control.password = "";
      if (control.connection?.kind === "s3") {
        control.connection.accessKeyId = "";
        control.connection.secretAccessKey = "";
        control.connection.sessionToken = undefined;
      }
    }
  }
  if (control.type === "switch-bucket") {
    try {
      const result = await switchSelectedCatalogBucket(control.bucket, control.password);
      return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: result };
    } finally {
      control.password = "";
    }
  }
  if (control.type === "change-bucket-config") {
    try {
      const result = await changeSelectedCatalogBucketConnection(control.config, control.label, control.password);
      emitStorageState();
      return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: result };
    } finally {
      control.password = "";
    }
  }
  if (control.type === "rename-bucket") {
    const result = await renameSelectedCatalogBucket(control.label);
    emitStorageState();
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: result };
  }
  if (control.type === "change-bucket-password") {
    const result = await changeSelectedCatalogBucketPassword(control.oldPassword, control.newPassword);
    emitStorageState();
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: result };
  }
  if (control.type === "unlock-profile") {
    try {
      if (!platformRootStore) await bootstrapPlatformStorage(control.password);
      await setStorageProfilePassword(control.password);
      await runStorageRecoveryOrchestrator();
      const service = await ensureStorageRuntime();
      const result = await service.unlockStorageProfile(control.password);
      if (result.ok) emitStorageState();
      return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: result };
    } catch {
      storageHealthController.setStatus("authentication", "Storage Profile password is invalid");
      return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: { ok: false, providerId: "aws-s3", latencyMs: 0, diagnostic: "authentication" } };
    }
  }
  if (control.type === "unlock-bucket") {
    const hadPlatformRoot = Boolean(platformRootStore);
    try {
      if (!storageBootstrapState?.selectedBucket) throw Object.assign(new Error("No selected storage bucket"), { code: "storage_not_configured" });
      if (!platformRootStore) await bootstrapPlatformStorage(control.password);
      await runStorageRecoveryOrchestrator();
      // Hold 冷导入文件可能已经带有完整 Keys；首次解锁桶时恢复到
      // Coordinator 的 canonical Vault 索引，空快照则仍保留 uninitialized
      // 供用户创建第一把 Key。
      await hydrateCatalogVaultFromSnapshot(control.password);
      // 对已有快照/已有 Vault，桶密码就是唯一的 Vault 密码。首次进入
      // 不能只把 Provider 置为 ready 后再要求用户重复输入同一密码；
      // 直接沿用本次短暂输入完成首个 Key 的解锁。该调用不缓存密码，
      // 并且在同一个 storage final lease 内完成 owner 迁移。
      if (coordinatorState.vaultStatus === "locked" && await getVaultMeta()) {
        const unlockResponse = await handleUnlockUnsafe(
          `bucket-unlock-${crypto.randomUUID()}`,
          { kind: "unlock", password: control.password, expectedSessionEpoch: coordinatorState.sessionEpoch },
        );
        if (unlockResponse.ack.status !== "accepted" && unlockResponse.ack.status !== "already-unlocked") {
          throw new Error("message" in unlockResponse.ack ? unlockResponse.ack.message : "Bucket Key unlock failed");
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
  if (control.type === "select-opfs") {
    try {
      if (platformRootStore && platformBucketProvider?.provider !== "opfs") throw new Error("The active bucket cannot be switched until the next startup");
      storageBootstrapState = { selectedBackend: "opfs", selectedProfileId: "opfs" };
      if (!platformRootStore) await bootstrapPlatformStorage();
      await runStorageRecoveryOrchestrator();
      return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: { ok: true, providerId: "opfs", latencyMs: 0 } };
    } catch (error) {
      storageHealthController.setStatus("degraded", error instanceof Error ? error.message : String(error));
      emitStorageState();
      return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: { ok: false, providerId: "opfs", latencyMs: 0, diagnostic: "provider" } };
    }
  }
  if (control.type === "import-profile") {
    try {
      if (platformRootStore) throw new Error("Storage Profile import requires a cold start so the selected bucket can be rebound");
      storageBootstrapState = { selectedBackend: "s3", selectedProfileId: "imported", encryptedStorageProfileEnvelope: structuredClone(control.envelope) };
      if (!platformRootStore) await bootstrapPlatformStorage(control.password);
      await setStorageProfilePassword(control.password);
      await runStorageRecoveryOrchestrator();
      const service = await ensureStorageRuntime();
      const result = await service.unlockStorageProfile(control.password);
      if (result.ok) emitStorageState();
      return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: result };
    } catch (error) {
      storageHealthController.setStatus("authentication", error instanceof Error ? error.message : String(error));
      emitStorageState();
      return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: { ok: false, providerId: "aws-s3", latencyMs: 0, diagnostic: "authentication" } };
    }
  }
  if (control.type === "cold-export") {
    // 冷导出只读取当前已绑定桶的不可变提交头及其快照记录。这里不能为
    // 读取 S3 配置而再次索要/缓存桶密码，也不能从本机目录拼接 Keys。
    assertStorageDataAvailable();
    if (signal?.aborted) throw storageUnavailableError("Storage cold export was cancelled");
    const selected = storageBootstrapState?.selectedBucket;
    const provider = platformBucketProvider;
    const root = platformRootStore;
    if (!selected || !provider || !root || selected.bucketId !== provider.bucketId || selected.backend !== provider.provider || root.bucket.bucketId !== selected.bucketId || root.bucket.provider !== selected.backend) {
      throw storageUnavailableError("The selected bucket is not available for cold export");
    }
    const committed = await createStorageHoldSnapshotRepository(provider).readCommitted();
    if (signal?.aborted) throw storageUnavailableError("Storage cold export was cancelled");
    const bytes = new TextEncoder().encode(serializeBucketDocument(committed.document));
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: bytes };
  }
  if (control.type === "activate" && !platformRootStore) {
    const selected = await prepareInitialS3Storage(control.config);
    // 首次 S3 激活已经完成 Root/Runtime bootstrap。运行期
    // activateProvider 会把同一个 bucket 误判为“已绑定后禁止切换”，
    // 因此这里必须以专用 selected 结果结束。
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: selected };
  }
  const service = await ensureStorageRuntime();
  if (control.type === "capabilities") return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: typeof service.getConditionalCapabilities === "function" ? service.getConditionalCapabilities() : null };
  if (control.type === "cancel-probe") { service.cancelProbe(); return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" } }; }
  if (control.type === "probe") return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: await service.probeProvider(control.config) };
  const current = (await service.getProviderSummary())?.generation ?? null;
  if (control.type === "activate" && control.expectedProviderGeneration !== current) return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "validation-error", message: "Storage provider generation changed" } };
  if ((control.type === "clear" || control.type === "reset") && control.expectedProviderGeneration !== current) return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "validation-error", message: "Storage provider generation changed" } };
  if (control.type === "activate") {
    if (control.config.profilePassword) await setStorageProfilePassword(control.config.profilePassword);
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: await service.activateProvider(control.config) };
  }
  if (control.type === "clear") { await service.clearProviderConfig(); return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" } }; }
  if (control.type === "reset") { await service.resetStorage(); return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" } }; }
  if (control.type === "probe-capabilities") return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: await service.probeConditionalCapabilities() };
  return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "validation-error", message: "Unknown storage control" } };
}

/**
 * Storage 控制面的最终边界分类。
 *
 * 初次选择/导入 Profile 可能还没有 Root 和 authority，必须保留冷启动
 * 路径；Root 已存在后，Provider 探测、配置提交和 Profile 恢复都不能
 * 绕过跨 Worker 的最终 I/O lease。
 */
function storageControlIoKind(control: Extract<CoordinatorClientRequest, { kind: "storage.control" }>["control"]): "read" | "write" {
  switch (control.type) {
    case "status":
    case "summary":
    case "connection":
    case "initial-setup-recovery-list":
    case "capabilities":
    case "probe":
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
): Promise<CoordinatorResponse> {
  const flushDeferredCatalogBindingDiscard = (): void => {
    if (!catalogBindingDiscardDeferred) return;
    catalogBindingDiscardDeferred = false;
    try { discardCurrentPlatformStorageBinding(); }
    catch (error) { console.warn("[coordinator] deferred catalog binding discard failed", error instanceof Error ? error.message : String(error)); }
  };
  // 没有 Root 时，activate/select/import 是建立第一个 Root 的冷启动操作；
  // 此阶段还没有可用的 Coordinator authority，直接走 bootstrap 分支。
  if (!platformRootStore) {
    try { return await executeStorageControl(request, signal); }
    finally { flushDeferredCatalogBindingDiscard(); }
  }
  try {
    return await withCoordinatorFinalIoLease(
      storageControlIoKind(request.control),
      signal,
      (leaseSignal) => executeStorageControl(request, leaseSignal),
      {
        auditOperation: "storage.control",
        // 桶首次解锁可能同时把 Hold 快照中的 Key 恢复到 Coordinator，
        // 然后进入同一把 Key 的 unlocked owner。这个有意的本地状态迁移
        // 必须允许当前 storage control 的 final lease 观察到新 gate。
        allowLocalLock: request.control.type === "unlock-bucket" || request.control.type === "switch-bucket" || request.control.type === "change-bucket-config",
        allowLocalOwnerTransition: request.control.type === "unlock-bucket" || request.control.type === "switch-bucket" || request.control.type === "change-bucket-config",
        allowLocalBindingDiscard: request.control.type === "initial-setup" || request.control.type === "initial-setup-cleanup",
        // status/summary/connection 等控制读取只观察本地状态；probe 也
        // 不提交配置或远端不可逆结果。它们仍经过本地 authority/epoch
        // 栅栏，但页面卸载时不应留下跨 Worker 恢复租约。
        durableLease: storageControlIoKind(request.control) === "write",
      },
    );
  } finally {
    // withCoordinatorFinalIoLease 已完成后置 authority 校验和 lease release。
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
  const store = await root.openPlatformStore({ applicationStorageId: grant.applicationStorageId, schemaVersion: grant.schemaVersion });
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
    // 平台 K-V 的 get/list 没有外部副作用；保留本地 authority 前后校验，
    // 但不把页面导航中尚未返回的只读 Promise 写成跨 Worker 恢复阻断。
    durableLease: operation === "write",
  });
}

async function resolveOwnerStorageGrant(grantId: string, actualClientId: string): Promise<StorageOwnerGrant> {
  const grant = ownerStorageGrants.get(grantId);
  if (!grant || grant.clientId !== actualClientId || grant.sessionEpoch !== coordinatorState.sessionEpoch || grant.ownerPublicKeyHex !== coordinatorState.activePublicKeyHex?.toLowerCase()) throw new Error("Owner storage grant is invalid");
  assertOwnerStorageNotFenced(grant.ownerPublicKeyHex);
  if (!platformRootStore || grant.bucketId !== platformRootStore.bucket.bucketId || grant.bucketGeneration !== platformRootStore.bucket.bucketGeneration) throw new Error("Owner storage bucket generation changed");
  await platformRootStore.assertOwnerStorageCurrent({ ownerPublicKeyHex: grant.ownerPublicKeyHex, generation: grant.ownerStorageGeneration });
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
    store = await root.openKeyValueStore({
      ownerPublicKeyHex: grant.ownerPublicKeyHex,
      applicationStorageId: grant.applicationStorageId,
      schemaVersion: 1,
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
    // owner K-V 的读取没有不可逆副作用；写入仍必须持久化登记，保证
    // Worker 接管不会越过未知的旧写入。
    durableLease: operation === "write",
  });
}

async function executeStorageDataUnsafe(request: Extract<CoordinatorClientRequest, { kind: "storage.data" }>, controller: AbortController, actualClientId: string): Promise<CoordinatorResponse> {
  assertStorageDataAvailable();
  const capturedSessionEpoch = coordinatorState.sessionEpoch;
  const service = await ensureStorageRuntime();
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
    await root.assertOwnerStorageCurrent({ ownerPublicKeyHex: ctx.ownerPublicKeyHex, generation: resolvedGrant.ownerStorageGeneration });
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

async function resolveStorageGrant(grantId: string, actualClientId: string): Promise<{ context: import("@keymaster/contracts").OwnerAppStorageGrant; ownerStorageGeneration: number; connectSessionId: string }> {
  const grant = storageGrants.get(grantId);
  if (!grant || grant.clientId !== actualClientId || grant.sessionEpoch !== coordinatorState.sessionEpoch) {
    const error = new Error("Storage grant is invalid") as Error & { code?: string }; error.code = "storage_identity_required"; throw error;
  }
  const authoritative = await readProtocolConnectSession(grant.context.connectSessionId);
  if (!authoritative || authoritative.origin !== grant.context.transportOrigin || authoritative.ownerPublicKeyHex !== grant.context.ownerPublicKeyHex || JSON.stringify(authoritative.appIdentity) !== JSON.stringify(grant.context.appIdentity) || grant.context.sessionEpoch !== coordinatorState.sessionEpoch || !platformRootStore || grant.context.bucketId !== platformRootStore.bucket.bucketId || grant.context.bucketGeneration !== platformRootStore.bucket.bucketGeneration || coordinatorState.activePublicKeyHex?.toLowerCase() !== grant.context.ownerPublicKeyHex) {
    const error = new Error("Storage session is invalid or revoked") as Error & { code?: string }; error.code = "storage_identity_required"; throw error;
  }
  await platformRootStore.assertOwnerStorageCurrent({ ownerPublicKeyHex: grant.context.ownerPublicKeyHex, generation: grant.ownerStorageGeneration });
  return { context: grant.context, ownerStorageGeneration: grant.ownerStorageGeneration, connectSessionId: grant.context.connectSessionId };
}

async function abortStorageSession(connectSessionId: string): Promise<void> {
  for (const [requestId, pending] of storageRequests) {
    if (pending.connectSessionId === connectSessionId) { pending.controller.abort(); storageRequests.delete(requestId); }
  }
  for (const [grantId, grant] of storageGrants) if (grant.context.connectSessionId === connectSessionId) storageGrants.delete(grantId);
  const service = await ensureStorageRuntime();
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
    const applicationStorageId = deriveThirdPartyApplicationStorageId(session.appIdentity.publisherPublicKeyHex, session.appIdentity.appId);
    const ownerStorageGeneration = await platformRootStore.getOwnerStorageGeneration({ ownerPublicKeyHex });
    if (revokedCoordinatorPeerIds.has(actualClientId)) return disconnectedClientResponse(request.requestId);
    const grantId = `grant-${crypto.randomUUID()}`;
    storageGrants.set(grantId, { context: { connectSessionId: session.sessionId, transportOrigin: session.origin, appIdentity: session.appIdentity, bucketId: platformRootStore.bucket.bucketId, bucketGeneration: platformRootStore.bucket.bucketGeneration, ownerPublicKeyHex, applicationStorageId, sessionEpoch: coordinatorState.sessionEpoch }, ownerStorageGeneration, clientId: actualClientId, sessionEpoch: coordinatorState.sessionEpoch });
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: grantId };
  }
  if (request.kind === "storage.cancel") {
    const target = storageRequests.get(storageRequestKey(actualClientId, request.targetRequestId));
    if (target?.clientId === actualClientId) target.controller.abort();
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" } };
  }
  if (request.kind === "storage.session.abort") {
    await abortStorageSession(request.connectSessionId);
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" } };
  }
  if (request.kind === "storage.platform.bind") {
    const expected = SYSTEM_STORAGE_DECLARATIONS[request.pluginId];
    // Host 的插件配置句柄由 bootstrap 使用内部 pluginId "runtime"
    // 申请，但真实平台目录是 settings。
    const allowedBootstrapNamespace = request.pluginId === "runtime" && request.declaration.applicationStorageId === "settings";
    const allowedVaultNamespace = request.pluginId === "vault" && ["coordinator", "protocol", "storage", "session"].includes(request.declaration.applicationStorageId);
    if ((!expected || expected.scope !== "platform" || request.declaration.scope !== expected.scope || request.declaration.applicationStorageId !== expected.applicationStorageId || request.declaration.schemaVersion !== expected.schemaVersion) && !allowedBootstrapNamespace && !allowedVaultNamespace) {
      return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "error", message: "Platform storage declaration is not authorized", code: "storage_forbidden" } };
    }
    if (!platformRootStore) return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "error", message: "Platform storage requires a ready root", code: "storage_unavailable" } };
    const grant: StoragePlatformGrant & { clientId: string } = {
      platformGrantId: `platform-${crypto.randomUUID()}`,
      bucketId: platformRootStore.bucket.bucketId,
      bucketGeneration: platformRootStore.bucket.bucketGeneration,
      applicationStorageId: request.declaration.applicationStorageId,
      schemaVersion: request.declaration.schemaVersion,
      sessionEpoch: coordinatorState.sessionEpoch,
      clientId: actualClientId
    };
    platformStorageGrants.set(grant.platformGrantId, grant);
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: grant };
  }
  if (request.kind === "storage.owner.bind") {
    const expected = SYSTEM_STORAGE_DECLARATIONS[request.pluginId];
    if (!expected || expected.scope !== "key" || request.declaration.scope !== expected.scope || request.declaration.applicationStorageId !== expected.applicationStorageId || request.declaration.schemaVersion !== expected.schemaVersion) {
      return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "error", message: "Owner storage declaration is not authorized", code: "storage_forbidden" } };
    }
    const ownerPublicKeyHex = coordinatorState.activePublicKeyHex?.toLowerCase();
    if (coordinatorState.vaultStatus !== "unlocked" || !ownerPublicKeyHex || !platformRootStore) return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "error", message: "Owner storage requires an unlocked active key", code: "storage_unavailable" } };
    const ownerStorageGeneration = await platformRootStore.getOwnerStorageGeneration({ ownerPublicKeyHex });
    if (revokedCoordinatorPeerIds.has(actualClientId)) return disconnectedClientResponse(request.requestId);
    const grant: StorageOwnerGrant & { clientId: string } = { storageGrantId: `owner-${crypto.randomUUID()}`, bucketId: platformRootStore.bucket.bucketId, bucketGeneration: platformRootStore.bucket.bucketGeneration, ownerPublicKeyHex, applicationStorageId: expected.applicationStorageId, ownerStorageGeneration, sessionEpoch: coordinatorState.sessionEpoch, clientId: actualClientId };
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
      const run = storageMutationTail.then(() => executeStorageControlAtFinalBoundary(request, controller.signal), () => executeStorageControlAtFinalBoundary(request, controller.signal));
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
  // runtime；全部在持久 write lease 内完成，避免接管发生在签名/付款/
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
  const verified = parseHashRequest(HASH_REQUEST_CHANNEL, contentJson, issuedAtMs);
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
      const messageId = await publishPrivateEnvelope({
        runtime,
        recipientPublicKeyHex: input.recipientPublicKeyHex,
        protocol,
        body: privateBodyForPublish(protocol, input.content),
        signal: signal ?? runtime.signal
      });
      return { messageId };
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
      return { channels: [...result] };
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

function emitChannelPublicMessage(message: { channel: string; publisherPublicKeyHex: string; messageId: string; content: import("@keymaster/contracts").JSONValue }): void {
  for (const subscriber of channelPublicSubscribers) {
    try { subscriber(message); } catch { /* 单个内部消费者不能打断 Channel 路由。 */ }
  }
  publishTopicEvent("channel.events", {
    type: "channel.message.received",
    publicMessage: message
  });
}

function emitChannelPrivateMessage(message: { channel: string; publisherPublicKeyHex: string; messageId: string; protocol: string; content: import("@keymaster/contracts").JSONValue }): void {
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
}): Promise<string> {
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
}): Promise<string> {
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
    verifiedWebrtc = verifySignedPrivateMessage(signed, now);
    const webrtcBody = verifiedWebrtc.body as import("bsv8-channel-protocol/webrtc-signal").WebRTCSignalV1Body;
    if (webrtcBody.signal.type === "offer") {
      const hashRequest = channelHashRequestByMessageId(webrtcBody.request_message_id, recipient);
      if (!hashRequest) throw new Error("WebRTC offer must reference a live public Hash request");
      reviewOfferForHashRequest(hashRequest, verifiedWebrtc, now);
    } else {
      const offer = findChannelWebrtcOffer(webrtcBody, verifiedWebrtc);
      if (!offer) throw new Error("WebRTC signal has no verified offer relation");
      validateWebRTCRelation(offer, verifiedWebrtc);
    }
  }
  const pingMessage = input.protocol === PING_PROTOCOL && isPingRequestBody(input.body)
    ? verifySignedPrivateMessage(signed, now)
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
  return messageId;
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
          return openPrivateMessage(event.channel, event.contentJson, currentOwnerPrivateKey(), Date.now());
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
          emitChannelPrivateMessage({ channel: opened.channel, publisherPublicKeyHex: opened.from_public_key, messageId: opened.message_id, protocol: opened.protocol, content: pingBody as unknown as import("@keymaster/contracts").JSONValue });
          return;
        }
        case APP_MESSAGE_PROTOCOL: {
          const appBody = opened.body as import("bsv8-channel-protocol/app-message").MessageV1Body;
          const content: import("@keymaster/contracts").JSONValue = appBody.type === "deliver"
            ? appBody.content as import("@keymaster/contracts").JSONValue
            : { type: "ack", acknowledged_message_id: appBody.acknowledged_message_id };
          emitChannelPrivateMessage({ channel: opened.channel, publisherPublicKeyHex: opened.from_public_key, messageId: opened.message_id, protocol: opened.protocol, content });
          return;
        }
        case WEBRTC_SIGNAL_PROTOCOL: {
          const webrtcBody = parseWebrtcBodyValue(opened.body as unknown as import("bsv8-channel-protocol").JSONValue);
          if (webrtcBody.signal.type === "offer") {
            const hashRequest = channelHashRequestByMessageId(webrtcBody.request_message_id, owner);
            if (!hashRequest) throw new Error("WebRTC offer references an unknown or expired Hash request");
            const relation = reviewOfferForHashRequest(hashRequest, opened, Date.now());
            channelWebrtcOffers.set(relation.key, opened);
            pruneChannelProtocolRelations();
          } else {
            const offer = findChannelWebrtcOffer(webrtcBody, opened);
            if (!offer) throw new Error("WebRTC signal has no verified offer relation");
            validateWebRTCRelation(offer, opened);
          }
          emitChannelPrivateMessage({ channel: opened.channel, publisherPublicKeyHex: opened.from_public_key, messageId: opened.message_id, protocol: opened.protocol, content: webrtcBody as unknown as import("@keymaster/contracts").JSONValue });
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
      const hashRequest = parseHashRequest(event.channel, event.contentJson, Date.now());
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
      return;
    }
    const publicMessage = parsePublicMessage(event.channel, event.contentJson, Date.now());
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
        const messageId = await publishPrivateEnvelope({ runtime, recipientPublicKeyHex: operation.recipientPublicKeyHex, protocol, body: privateBodyForPublish(protocol, operation.content), signal: requestSignal });
        if (request.expectedSessionEpoch !== coordinatorState.sessionEpoch
          || coordinatorState.vaultStatus !== "unlocked"
          || coordinatorState.activePublicKeyHex !== operation.ownerPublicKeyHex) {
          throw new Error("Private Channel publish became stale after network completion");
        }
        return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: { messageId } };
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
        return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: { channels } };
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
// Chromium 的跨页消息派发和真实 OPFS CAS 留出确定的 lifecycle 竞态窗口；
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
      case "read-seed": value = await service.readSeed({ supplierPublicKeyHex: data.supplierPublicKeyHex, seedHashHex: data.seedHashHex, signal }); break;
      case "read-block": value = await service.readBlock({ supplierPublicKeyHex: data.supplierPublicKeyHex, blockHashHex: data.blockHashHex, signal }); break;
    }
  } else {
    const { context } = await resolveMsfileGrant(data.grantId, actualClientId, requestEpoch);
    // grant 解析是异步的：返回后再次确认未跨越会话栅栏。
    if (requestEpoch !== coordinatorState.sessionEpoch || signal.aborted) {
      throw msfileError("msfile_unavailable", "MSFile request was cancelled");
    }
    switch (data.type) {
      case "stat": value = await service.connect.stat(context, { seedHashHex: data.seedHashHex, signal }); break;
      case "read-seed": value = await service.connect.readSeed(context, { supplierPublicKeyHex: data.supplierPublicKeyHex, seedHashHex: data.seedHashHex, signal }); break;
      case "read-block": value = await service.connect.readBlock(context, { supplierPublicKeyHex: data.supplierPublicKeyHex, blockHashHex: data.blockHashHex, signal }); break;
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
        // 触发供应商/支付副作用；真正的配置变更仍使用持久 final lease。
        durableLease: operation === "write",
      },
    );
    } catch (error) {
    // 请求可能在等待持久 I/O lease 时经历 lock → unlock；此时旧 gate
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
      case "p2pkh.providers.get":
        return await handleP2pkhProvidersGet(requestId);
      case "p2pkh.settings.update":
        return await handleP2pkhSettingsUpdate(requestId, request);
      case "p2pkh.providers.update":
        return await handleP2pkhProvidersUpdate(requestId, request);
      case "p2pkh.provider-config.get":
        return await handleP2pkhProviderConfigGet(requestId, request);
      case "p2pkh.provider-config.update":
        return await handleP2pkhProviderConfigUpdate(requestId, request);
      case "p2pkh.broadcast":
      case "p2pkh.rebroadcast-ancestors":
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
  // lock 是 fail-closed 安全动作：即使这个 Worker 已经失去持久 authority，
  // 仍必须能本地清空密钥、撤销代理并释放资源。其他清理入口同样不需要
  // 重新取得业务权威；其余入口都必须经过共享 authority fence，避免旧
  // Worker 在新 Worker 接管后继续修改状态。
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
    const catalogMode = Boolean(selectedCatalogBucket());
    // 1. 从 K-V 读取仅包含 verifier 的 vault_meta；新版桶的私钥密文
    //    不在这个 K-V 记录中，而在已提交 Hold 快照中。
    const meta = await getVaultMeta();
    if (!meta) {
      return {
        requestId,
        sessionEpoch: coordinatorState.sessionEpoch,
        ack: { status: "validation-error", message: "Vault not initialized" },
      };
    }

    // 2. 验证密码
    if (!(await verifyPassword(request.password, meta))) {
      return {
        requestId,
        sessionEpoch: coordinatorState.sessionEpoch,
        ack: { status: "validation-error", message: "Invalid password" },
      };
    }

    let committedCatalog: CatalogCommittedSnapshot | undefined;
    if (catalogMode) {
      committedCatalog = await readVerifiedCurrentCatalogSnapshot(request.password);
      await rebuildCurrentCatalogKeyIndex(committedCatalog);
    }

    // 3. 获取 active key。旧版本允许创建“有密码但没有 key”的空 Vault；
    //    这种 Vault 已经是初始化状态，应清掉孤立的密码元数据，
    //    而不是把用户永久卡在 "No active key"。
    const activeKey = request.publicKeyHex ? await getPublicVaultKey(request.publicKeyHex) : await getActiveKey();
    if (!activeKey) {
      await vaultKeyRepository.deleteMeta();
      await performGlobalLock("recover-empty");
      return {
        requestId,
        sessionEpoch: coordinatorState.sessionEpoch,
        ack: { status: "accepted" },
      };
    }
    privateKey = catalogMode
      ? await decryptCurrentCatalogPrivateKey(activeKey.publicKeyHex, request.password, committedCatalog)
      : await decryptPrivateKey(request.password, await requireLegacyVaultKeyRecord(activeKey.publicKeyHex));

    // 4. 统一进入 unlocked 状态
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
    // processRequest 开头检查一次 authority 不足以覆盖中途 Worker 接管。
    // allowLocalLock / allowLocalOwnerTransition 只允许本次操作自己执行
    // fail-closed 锁定或 owner 切换；仍会重新校验共享 authority，不能把
    // 外部接管当成成功。
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
        // 会改写 Vault 的操作持久阻塞跨 Worker 接管，避免刷新把未完成的
        // UI 读取固化成无法释放的孤儿 lease。
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
    case "listCurrentKeyPasskeys":
    case "listPasskeysForKey":
    case "getPasskeyChallenge":
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
 * 崩溃可恢复的联合删除：Journal 先落在 keys/，每个阶段都幂等。
 * 重启后即使上一次停在任意 await 之间，也会从该阶段继续到收尾。
 */
async function executeKeyDeletionTransaction(publicKeyHexInput: string, confirmationLabel: string, existing?: KeyDeletionJournal): Promise<true> {
  const publicKeyHex = publicKeyHexInput.toLowerCase();
  // 新版目录桶没有可删除的 KeyHold record；其私钥密文在进入本事务前
  // 已从 Hold 快照发布的集合中移除，这里只清理可重建的公开索引。旧
  // OPFS/Profile 路径仍执行原有 KeyHold sidecar 删除。
  const catalogMode = Boolean(selectedCatalogBucket());
  const journal: KeyDeletionJournal = existing ?? { publicKeyHex, confirmationLabel, phase: "prepared" };
  if (!existing) await writeKeyDeletionJournal(journal);

  if (journal.phase !== "key-deleted" && journal.phase !== "vault-finalized" && journal.phase !== "complete") {
    fenceOwnerForKeyDeletion(publicKeyHex);
    if (journal.phase === "prepared") {
      journal.phase = "owner-fenced";
      await writeKeyDeletionJournal(journal);
    }
  }

  if (journal.phase === "owner-fenced") {
    // activePublicKeyHex 仍保留到这里完成，保证动态 keyScope 的任务也能
    // 被准确归属；此后清空 active，防止 owner-delete 阶段再有新业务请求。
    await cancelTaskRuntimesByKey(publicKeyHex);
    await drainOwnerStorageRequests(publicKeyHex);
    clearDeletedActiveOwner(publicKeyHex);
    journal.phase = "requests-drained";
    await writeKeyDeletionJournal(journal);
  }

  if (journal.phase === "requests-drained") {
    const root = platformRootStore;
    if (!root) throw new Error("Storage has not been bootstrapped");
    try {
      await root.deleteOwnerStorage({ ownerPublicKeyHex: publicKeyHex });
    } catch (error) {
      markStorageIoFailure(error);
      throw error;
    }
    journal.phase = "owner-deleted";
    await writeKeyDeletionJournal(journal);
  }

  if (journal.phase === "owner-deleted") {
    try {
      if (catalogMode) await currentCatalogKeyIndex().deleteKey(publicKeyHex);
      else await vaultKeyRepository.deleteKeyAndSidecars(publicKeyHex);
    } catch (error) {
      markStorageIoFailure(error);
      throw error;
    }
    journal.phase = "key-deleted";
    await writeKeyDeletionJournal(journal);
  }

  if (journal.phase === "key-deleted") {
    clearDeletedActiveOwner(publicKeyHex);
    await repairSelectedAfterDelete(publicKeyHex);
    const remaining = await listPublicVaultKeys();
    if (remaining.length === 0) {
      // 最后一把 Key 删除后必须原子收敛到 uninitialized：先删 Vault meta，
      // 再让全局 lock 发布 uninitialized，而不是保留一个空 Vault meta。
      await vaultKeyRepository.deleteMeta();
      await performGlobalLock("empty-vault");
    } else {
      publishSessionState("delete-active-key");
    }
    journal.phase = "vault-finalized";
    await writeKeyDeletionJournal(journal);
  }

  if (journal.phase === "vault-finalized") {
    journal.phase = "complete";
    await writeKeyDeletionJournal(journal);
  }
  if (journal.phase === "complete") {
    await removeKeyDeletionJournal(publicKeyHex);
    // 删除事务完成后允许将同一公钥作为一次全新的导入重新绑定；
    // Journal 未完成前必须保留 fence，避免旧请求重新进入该 owner 根。
    ownerStorageFences.delete(publicKeyHex);
  }
  return true;
}

/** 所有删除（用户操作与启动恢复）共用一条串行事务链。 */
function executeKeyDeletion(publicKeyHex: string, confirmationLabel: string, existing?: KeyDeletionJournal): Promise<true> {
  const result = keyDeletionTail.then(
    () => executeKeyDeletionTransaction(publicKeyHex, confirmationLabel, existing),
    () => executeKeyDeletionTransaction(publicKeyHex, confirmationLabel, existing)
  );
  keyDeletionTail = result.then(() => undefined, () => undefined);
  return result;
}

async function recoverKeyDeletionJournals(): Promise<void> {
  let firstError: unknown;
  for (const journal of await readKeyDeletionJournals()) {
    try {
      const key = await getPublicVaultKey(journal.publicKeyHex);
      // 只有 owner 已经删除、但 key phase 尚未落盘时，才能把缺失 Key
      // 视为已完成；更早阶段仍必须继续清理 owner 目录。
      if (!key && journal.phase === "owner-deleted") {
        journal.phase = "key-deleted";
        await writeKeyDeletionJournal(journal);
      }
      await executeKeyDeletion(journal.publicKeyHex, journal.confirmationLabel, journal);
    } catch (error) {
      console.warn("[vault] key deletion recovery deferred", error instanceof Error ? error.message : String(error));
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
}

async function executeVaultOperation(operation: CoordinatorVaultOperation, internalActivationSecret?: string): Promise<unknown> {
  switch (operation.type) {
    case "listKeys": return (await listPublicVaultKeys()).map(({ publicKeyHex, label, capabilities, createdAt, address, network, format, source }) => ({ publicKeyHex, label, capabilities, createdAt, address, network, format, source }));
    case "getKey": {
      const key = await getPublicVaultKey(operation.publicKeyHex);
      if (!key) return undefined;
      const { publicKeyHex, label, capabilities, createdAt, address, network, format, source } = key;
      return { publicKeyHex, label, capabilities, createdAt, address, network, format, source };
    }
    case "verifyPassword": { const meta = await getVaultMeta(); if (!meta) throw new Error("Vault not initialized"); if (!(await verifyPassword(operation.password, meta))) throw new Error("Invalid password"); return true; }
    case "setActive": {
      if (coordinatorState.vaultStatus !== "unlocked") throw new Error("Vault is locked");
      // setActive 是旧的内部兼容入口，不再从 Coordinator 会话读取密码。
      // 生产切换必须走 activate-key RPC；只有带有本次内部操作秘密的
      // 首次导入路径，或 test seam，才允许继续使用这个内部分支。
      const activationSecret = internalActivationSecret ?? testHarnessActivationSecret;
      if (!activationSecret) throw new Error("Active key changes require a password");
      const key = await getPublicVaultKey(operation.publicKeyHex); if (!key) throw new Error("Key not found");
      const bytes = selectedCatalogBucket()
        ? await decryptCurrentCatalogPrivateKey(key.publicKeyHex, activationSecret)
        : await decryptPrivateKey(activationSecret, await requireLegacyVaultKeyRecord(key.publicKeyHex));
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
        passkeyAddIntents.clear();
        coordinatorMeta.selectedPublicKeyHex = key.publicKeyHex;
        coordinatorMeta.generation = coordinatorState.keyspaceGeneration;
        await persistActiveMeta();
        // Key 切换只有在持久元数据和当前 authority 都通过最终边界后，
        // 才允许提交 owner transition；否则旧实例可能继续持有可用 owner。
        await ensureCoordinatorUpgradeSession();
        completeActiveStorageOwnerTransition(transition);
      } catch (error) {
        const failedClosed = Boolean(previousActive) && coordinatorState.vaultStatus !== "unlocked";
        if (failedClosed) {
          dropActivePrivateKey();
          coordinatorMeta.selectedPublicKeyHex = previousSelected;
          coordinatorMeta.generation = coordinatorState.keyspaceGeneration;
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
      const catalogMode = Boolean(selectedCatalogBucket());
      const keys = await listPublicVaultKeys();
      const target = keys.find((key) => key.publicKeyHex.toLowerCase() === operation.publicKeyHex.toLowerCase());
      if (!target) throw new Error("Key not found");
      if (!target.label) throw new Error("Key label is unavailable");
      if (operation.confirmationLabel !== target.label) throw new Error("Key label mismatch");
      if (!platformRootStore) throw new Error("Storage has not been bootstrapped");
      let previousCatalog: CatalogCommittedSnapshot | undefined;
      let previousCatalogIndex: StorageCatalogKeyIndexRecordV1[] | undefined;
      if (catalogMode) {
        if (!operation.bucketPassword) throw new Error("Bucket password is required");
        previousCatalog = await readVerifiedCurrentCatalogSnapshot(operation.bucketPassword);
        previousCatalogIndex = await currentCatalogKeyIndex().listKeys();
        const nextKeys = previousCatalog.document.keys.filter((key) => key.publicKeyHex.toLowerCase() !== target.publicKeyHex.toLowerCase());
        if (nextKeys.length === previousCatalog.document.keys.length) throw new Error("Key is missing from the committed Hold snapshot");
        const nextIndex = previousCatalogIndex.filter((record) => record.publicKeyHex.toLowerCase() !== target.publicKeyHex.toLowerCase());
        await publishCurrentCatalogHoldSnapshot(operation.bucketPassword, nextKeys, nextIndex);
      }
      try {
        return await executeKeyDeletion(operation.publicKeyHex, operation.confirmationLabel);
      } catch (error) {
        // 删除是 Journal 事务；若失败停在 owner/key 删除之前，目标私钥
        // 仍然存在，必须恢复原完整快照。若 Journal 已进入 key-deleted，
        // 则保留删减后的快照，避免把已删除的私钥重新发布。
        if (catalogMode && operation.bucketPassword && previousCatalog && previousCatalogIndex) {
          const journal = await platformKeysStore?.get<KeyDeletionJournal>(`${KEY_DELETION_JOURNAL_PREFIX}${target.publicKeyHex.toLowerCase()}`, { partition: "deletion" });
          if (!journal?.value || !["key-deleted", "vault-finalized", "complete"].includes(journal.value.phase)) {
            await publishCurrentCatalogHoldSnapshot(operation.bucketPassword, previousCatalog.document.keys, previousCatalogIndex).catch((rollbackError) => {
              console.warn("[vault] Hold snapshot rollback after key deletion failure failed", rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
            });
          }
        }
        throw error;
      }
    }
    case "createVault": return await createVaultRpc(operation.password);
    case "createVaultWithInitialKey": return await createVaultRpc(operation.password, { label: operation.label, capabilities: operation.capabilities });
    case "createVaultWithImportedKey": return await createVaultRpc(operation.vaultPassword, operation.key);
    case "generateKey": return await addKeyRpc(operation.password, { label: operation.label, capabilities: operation.capabilities, material: { hex: generatePrivateKeyHex() }, format: "generated", source: "vault-generated" });
    case "importPrivateKey": return await addKeyRpc(operation.password, operation);
    case "exportCurrentKeyBackup": {
      const selectedHex = coordinatorMeta.selectedPublicKeyHex;
      if (!selectedHex) throw new Error("No selected private key");
      if (selectedCatalogBucket()) return exportCatalogKeyBackup(selectedHex);
      const key = await vaultKeyRepository.getKey(selectedHex);
      if (!key) throw new Error("Key not found");
      if (key.storageVersion !== "keyhold-v2" || !key.keyholdDocument) throw new Error("Unsupported key storage version");
      return (await import("keyhold")).serialize((await import("keyhold")).parse((await import("keyhold")).serialize(key.keyholdDocument)));
    }
    case "listCurrentKeyPasskeys": {
      const key = await requireCurrentKeyRecord();
      return (await vaultKeyRepository.listSidecars(key.publicKeyHex)).map(toPasskeySummary);
    }
    case "listPasskeysForKey": {
      const key = await vaultKeyRepository.getKey(operation.publicKeyHex);
      if (!key) throw new Error("Key not found");
      return (await vaultKeyRepository.listSidecars(key.publicKeyHex)).map(toPasskeySummary);
    }
    case "getPasskeyChallenge": {
      const { protection } = await findKeyByPasskeyId(operation.passkeyId);
      return {
        credentialIdB64: protection.credentialIdB64,
        prfSaltB64: protection.prfSaltB64,
        rpId: protection.rpId,
        transports: protection.transports
      };
    }
    case "prepareAddPasskeyToCurrentKey": {
      const key = await requireCurrentKeyRecord();
      if (selectedCatalogBucket()) {
        throw new Error("Catalog bucket Keys require the bucket password; Passkey protection is unavailable");
      }
      const label = operation.label.trim();
      if (!label) throw new Error("Passkey name is required");
      if ((await vaultKeyRepository.listSidecars(key.publicKeyHex)).some((item) => item.label === label)) {
        throw new Error("Passkey name already exists for this key");
      }
      prunePasskeyAddIntents();
      const intentId = crypto.randomUUID();
      passkeyAddIntents.set(intentId, {
        publicKeyHex: key.publicKeyHex,
        sessionEpoch: coordinatorState.sessionEpoch,
        label,
        expiresAt: Date.now() + PASSKEY_ADD_INTENT_TTL_MS
      });
      return { intentId, publicKeyHex: key.publicKeyHex };
    }
    case "addPasskeyToCurrentKey": {
      if (selectedCatalogBucket()) {
        throw new Error("Catalog bucket Keys require the bucket password; Passkey protection is unavailable");
      }
      const intent = passkeyAddIntents.get(operation.intentId);
      passkeyAddIntents.delete(operation.intentId);
      if (!intent || intent.expiresAt < Date.now()) throw new Error("Passkey setup expired; try again");
      const key = await requireCurrentKeyRecord();
      if (intent.sessionEpoch !== coordinatorState.sessionEpoch || intent.publicKeyHex !== key.publicKeyHex) {
        throw new Error("Current key changed during passkey setup");
      }
      const allKeys = await vaultKeyRepository.listKeys();
      if ((await Promise.all(allKeys.map((record) => vaultKeyRepository.listSidecars(record.publicKeyHex)))).some((items) => items.some((item) => item.id === operation.credentialIdB64))) {
        throw new Error("Passkey already exists in this Vault");
      }
      const prfOutput = cryptoHexToBytes(operation.prfOutputHex);
      let encrypted: Awaited<ReturnType<typeof encryptMaterialWithPasskey>>;
      try {
        encrypted = await encryptMaterialWithPasskey({
          prfOutput,
          publicKeyHex: key.publicKeyHex,
          credentialIdB64: operation.credentialIdB64,
          privateKeyBytes: coordinatorState.activePrivateKeyBytes!
        });
      } finally {
        prfOutput.fill(0);
      }
      const protection = {
        id: operation.credentialIdB64,
        label: intent.label,
        credentialIdB64: operation.credentialIdB64,
        prfSaltB64: operation.prfSaltB64,
        rpId: operation.rpId,
        createdAt: new Date().toISOString(),
        transports: operation.transports,
        ...encrypted
      };
      await vaultKeyRepository.putSidecar({ publicKeyHex: key.publicKeyHex, ...protection });
      return toPasskeySummary(protection);
    }
    case "removePasskeyFromCurrentKey": {
      const key = await requireCurrentKeyRecord();
      const sidecar = (await vaultKeyRepository.listSidecars(key.publicKeyHex)).find((item) => item.id === operation.passkeyId);
      if (!sidecar) throw new Error("Passkey protection not found");
      await vaultKeyRepository.deleteSidecar(key.publicKeyHex, operation.passkeyId);
      return true;
    }
    case "activateKeyWithPasskey": {
      if (coordinatorState.vaultStatus !== "unlocked") throw new Error("Vault is locked");
      if (selectedCatalogBucket()) {
        // 新版桶的密码归属在桶，不允许 Passkey 作为跨 Key 的密码绕过。
        throw new Error("Catalog bucket key activation requires the bucket password");
      }
      const { key, protection } = await findKeyByPasskeyId(operation.passkeyId);
      const prfOutput = cryptoHexToBytes(operation.prfOutputHex);
      let privateKey: Uint8Array;
      try {
        privateKey = await decryptMaterialWithPasskey({
          prfOutput,
          publicKeyHex: key.publicKeyHex,
          protection
        });
      } finally {
        prfOutput.fill(0);
      }
      let privateKeyTransferred = false;
      try {
        verifySessionKeyPair({ publicKeyHex: key.publicKeyHex, privateKeyBytes: privateKey });
        const previousPublicKeyHex = coordinatorState.activePublicKeyHex;
        const previousBytes = coordinatorState.activePrivateKeyBytes?.slice();
        const previousGeneration = coordinatorState.keyspaceGeneration;
        const previousSelected = coordinatorMeta.selectedPublicKeyHex;
        privateKeyTransferred = true;
        let transition: ActiveOwnerTransitionResult | undefined;
        try {
          transition = await transitionActiveStorageOwner(key.publicKeyHex);
          dropActivePrivateKey();
          replaceActivePrivateKey(privateKey);
          coordinatorState.activePublicKeyHex = key.publicKeyHex;
          if (previousPublicKeyHex?.toLowerCase() === key.publicKeyHex.toLowerCase()) coordinatorState.keyspaceGeneration++;
          coordinatorState.sessionEpoch = generateEpoch();
          passkeyAddIntents.clear();
          coordinatorMeta.selectedPublicKeyHex = key.publicKeyHex;
          coordinatorMeta.generation = coordinatorState.keyspaceGeneration;
          await persistActiveMeta();
          completeActiveStorageOwnerTransition(transition);
        } catch (error) {
          const failedClosed = Boolean(previousPublicKeyHex) && coordinatorState.vaultStatus !== "unlocked";
          if (failedClosed) {
            dropActivePrivateKey();
            coordinatorMeta.selectedPublicKeyHex = previousSelected;
            coordinatorMeta.generation = coordinatorState.keyspaceGeneration;
            privateKeyTransferred = false;
            throw error;
          }
          dropActivePrivateKey();
          if (previousBytes) replaceActivePrivateKey(previousBytes);
          coordinatorState.activePublicKeyHex = previousPublicKeyHex;
          coordinatorMeta.selectedPublicKeyHex = previousSelected;
          completeActiveStorageOwnerTransition(transition);
          invalidateFailedKeyspaceTransition(previousGeneration);
          privateKeyTransferred = false;
          throw error;
        }
        if (previousBytes) previousBytes.fill(0);
        publishSessionState("activate-key");
        return true;
      } finally {
        if (!privateKeyTransferred) privateKey.fill(0);
      }
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
      if ((await vaultKeyRepository.listKeys()).length !== 0) throw new Error("Vault still has keys");
      await vaultKeyRepository.deleteMeta();
      await performGlobalLock("empty-vault");
      return true;
    }
    case "recoverEmptyVaultToUninitialized": await vaultKeyRepository.deleteMeta(); await performGlobalLock("recover-empty"); return true;
    case "exportKeyBackup": {
      if (selectedCatalogBucket()) return exportCatalogKeyBackup(operation.publicKeyHex);
      const key = await vaultKeyRepository.getKey(operation.publicKeyHex);
      if (!key) throw new Error("Key not found");
      if (key.storageVersion !== "keyhold-v2" || !key.keyholdDocument) throw new Error("Unsupported key storage version");
      return (await import("keyhold")).serialize((await import("keyhold")).parse((await import("keyhold")).serialize(key.keyholdDocument)));
    }
    case "importKeyBackup": {
      if (selectedCatalogBucket()) {
        // 新版桶优先接受只包含 Hold KeyRecord 的 catalog backup。旧 OPFS /
        // 旧 Profile 导出的单 Key 文件仍允许走一次性转换：源文件密码只在
        // 这里解开旧 KeyHold，随后立即用目标桶密码重新封装进唯一的 Hold
        // 快照，不把旧 `keyholdDocument` 写回新版 `keys/`。
        let catalogBackup: CatalogKeyBackupV1 | undefined;
        try { catalogBackup = parseCatalogKeyBackup(operation.backup); } catch { /* try the explicit legacy KeyHold format below */ }
        if (catalogBackup) {
          const sourceContext = await deriveBucketCryptoContext(operation.sourcePassword, catalogBackup.keyDerivation);
          let plain: Awaited<ReturnType<typeof decryptBucketKey>> | undefined;
          try {
            plain = await decryptBucketKey(catalogBackup.key, sourceContext);
            if (plain.publicKeyHex.toLowerCase() !== catalogBackup.publicKeyHex) throw new Error("Catalog key backup public key mismatch");
            return await addCatalogKeyMaterialRpc(operation.targetPassword, plain.privateKey, {
              label: catalogBackup.label,
              capabilities: catalogBackup.capabilities,
              format: catalogBackup.keyFormat,
              ...(catalogBackup.source === undefined ? {} : { source: catalogBackup.source }),
            }, "import-initial-key");
          } finally {
            plain?.privateKey.fill(0);
            sourceContext.dispose();
          }
        }

        let legacyDocument: import("keyhold").Document;
        try { legacyDocument = keyholdParse(operation.backup) as import("keyhold").Document; }
        catch { throw new Error("Unrecognized key backup format"); }
        let legacyUnlocked: Awaited<ReturnType<typeof keyholdUnlock>>;
        try { legacyUnlocked = await keyholdUnlock(legacyDocument, operation.sourcePassword); }
        catch { throw new Error("Invalid source password"); }
        try {
          return await addCatalogKeyMaterialRpc(operation.targetPassword, legacyUnlocked.privateKey, {
            label: legacyDocument.label,
            capabilities: ["p2pkh"],
            format: "keyhold-v2",
            source: "legacy-keyhold-migration",
          }, "import-initial-key");
        } finally {
          legacyUnlocked.privateKey.fill(0);
        }
      }
      const currentMeta = await getVaultMeta();
      if (!currentMeta) throw new Error("Vault not initialized");
      const keyhold = await import("keyhold");
      let sourceDoc: import("keyhold").Document;
      try {
        sourceDoc = keyhold.parse(operation.backup);
      } catch {
        throw new Error("Unrecognized key backup format");
      }
      const source = await keyhold.unlock(sourceDoc, operation.sourcePassword);
      let targetDocument: import("keyhold").Document;
      try {
        if (!(await verifyPassword(operation.targetPassword, currentMeta))) throw new Error("Invalid password");
        const existingKey = await vaultKeyRepository.getKey(source.publicKeyHex);
        if (existingKey) throw new Error("Key already exists");
        targetDocument = keyhold.parse(await keyhold.exportPrivateKey({ privateKey: source.privateKey, password: operation.targetPassword, label: sourceDoc.label, parameters: keyhold.recommendedParameters() }));
      } finally {
        source.privateKey.fill(0);
      }
      const record: VaultKeyRecord = { publicKeyHex: source.publicKeyHex, label: sourceDoc.label, address: "", network: "main", format: "keyhold-v2", capabilities: ["p2pkh"], createdAt: new Date().toISOString(), storageVersion: "keyhold-v2", keyholdDocument: targetDocument };
      let persisted = false;
      try {
        await platformRootStore?.activateOwnerStorage({ ownerPublicKeyHex: record.publicKeyHex });
        await vaultKeyRepository.putKey(record);
        persisted = true;
        // 仅当 Vault 已 unlocked 且是第一个 key 时，设置为 active
        if (coordinatorState.vaultStatus === "unlocked") {
          const keys = await vaultKeyRepository.listKeys();
          if (keys.length === 1) {
            await executeVaultOperation({ type: "setActive", publicKeyHex: record.publicKeyHex }, operation.targetPassword);
          }
        }
      } catch (error) {
        if (persisted) {
          await vaultKeyRepository.deleteKeyAndSidecars(record.publicKeyHex).catch(() => undefined);
          await platformRootStore?.deleteOwnerStorage({ ownerPublicKeyHex: record.publicKeyHex }).catch(() => undefined);
        }
        throw error;
      }
      return { publicKeyHex: record.publicKeyHex, label: record.label, address: record.address, network: record.network, format: record.format, capabilities: record.capabilities, createdAt: record.createdAt, source: record.source };
    }
    default: throw new Error(`Unsupported vault operation: ${(operation as { type: string }).type}`);
  }
}

async function requireCurrentKeyRecord(): Promise<VaultKeyRecord> {
  if (selectedCatalogBucket()) throw new Error("Catalog bucket Keys use the committed KeymasterHold snapshot; Passkey storage is unavailable");
  if (
    coordinatorState.vaultStatus !== "unlocked" ||
    !coordinatorState.activePublicKeyHex ||
    !coordinatorState.activePrivateKeyBytes
  ) {
    throw new Error("No active private key");
  }
  const key = await vaultKeyRepository.getKey(coordinatorState.activePublicKeyHex);
  if (!key) throw new Error("Active key not found");
  verifySessionKeyPair({
    publicKeyHex: key.publicKeyHex,
    privateKeyBytes: coordinatorState.activePrivateKeyBytes
  });
  return key;
}

async function repairSelectedAfterDelete(deleted: string): Promise<void> {
  const remaining = await listPublicVaultKeys();
  if (remaining.length === 0) {
    coordinatorMeta.selectedPublicKeyHex = undefined;
    await persistCoordinatorMeta();
    return;
  }
  if (coordinatorMeta.selectedPublicKeyHex?.toLowerCase() === deleted.toLowerCase() || !await getPublicVaultKey(coordinatorMeta.selectedPublicKeyHex ?? "")) {
    coordinatorMeta.selectedPublicKeyHex = remaining[0]!.publicKeyHex;
    coordinatorMeta.generation = ++coordinatorState.keyspaceGeneration;
    await persistCoordinatorMeta();
    publishSessionState("delete-active-key");
  }
}

async function findKeyByPasskeyId(passkeyId: string): Promise<{
  key: VaultKeyRecord;
  protection: import("@keymaster/plugin-vault/coordinator").WebAuthnSidecarRecord;
}> {
  if (selectedCatalogBucket()) throw new Error("Catalog bucket Keys use the bucket password; Passkey storage is unavailable");
  const matches: Array<{ key: VaultKeyRecord; protection: import("@keymaster/plugin-vault/coordinator").WebAuthnSidecarRecord }> = [];
  for (const key of await vaultKeyRepository.listKeys()) {
    const protection = (await vaultKeyRepository.listSidecars(key.publicKeyHex)).find((item) => item.id === passkeyId);
    if (protection) matches.push({ key, protection });
  }
  if (matches.length === 0) throw new Error("Passkey protection not found");
  if (matches.length > 1) throw new Error("Passkey protection id is not unique");
  return matches[0]!;
}

function generatePrivateKeyHex(): string { return generateValidPrivateKeyHex(); }
async function createVaultRpc(password: string, key?: { label?: string; capabilities?: string[]; material?: { hex: string; wif?: string }; format?: string; source?: string }): Promise<unknown> {
  if (await getVaultMeta()) throw new Error("Vault already exists");
  if (selectedCatalogBucket()) {
    // 新版桶的首个 Vault 密码就是桶密码；先认证连接配置，避免先写
    // 一个无法与桶快照统一的 Vault meta。
    await syncSelectedCatalogHoldSnapshot(password);
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = key?.material ?? { hex: generatePrivateKeyHex() };
  const passwordKey = await deriveKey(password, salt);
  const verifier = await (await import("@keymaster/plugin-vault/coordinator")).encryptVerifier(passwordKey);
  const meta = (await import("@keymaster/plugin-vault/coordinator")).buildVaultMeta({ salt, verifier });
  await vaultKeyRepository.putMeta(meta);
  if (key) {
    // 有 key 时调用 addKeyRpc，它会设置 unlocked 状态
    try {
      return await addKeyRpc(password, { ...key, material: keyMaterial, label: key.label ?? "Key", capabilities: key.capabilities ?? ["p2pkh"], format: key.format ?? "imported", source: key.source }, key.format === "imported" ? "import-initial-key" : "create-initial-key");
    } catch (error) {
      // addKeyRpc 的 Hold 发布或 owner 初始化失败时不能留下一个
      // “有密码但没有对应 Key 快照”的孤立 Vault。
      await vaultKeyRepository.deleteMeta().catch((cleanupError) => console.warn("[vault] failed to roll back initial Vault metadata", cleanupError instanceof Error ? cleanupError.message : String(cleanupError)));
      throw error;
    }
  }
  // 空 Vault 创建后保持 locked 状态；本次密码只用于上面的 verifier 写入。
  testHarnessActivationSecret = undefined;
  passkeyAddIntents.clear();
  coordinatorState.vaultStatus = "locked";
  coordinatorState.sessionEpoch = generateEpoch();
  coordinatorMeta.selectedPublicKeyHex = undefined;
  coordinatorMeta.generation = coordinatorState.keyspaceGeneration;
  await persistCoordinatorMeta();
  // 广播 locked 状态
  publishSessionState("create-vault");
  return true;
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
  const meta = await getVaultMeta();
  if (!meta) throw new Error("Vault not initialized");
  if (!(await verifyPassword(password, meta))) throw new Error("Invalid password");
  await syncSelectedCatalogHoldSnapshot(password);
  const previous = await readVerifiedCurrentCatalogSnapshot(password);
  const previousIndex = await currentCatalogKeyIndex().listKeys();
  let published = false;
  let privateKeyTransferred = false;
  let publicKeyHex: string | undefined;
  try {
    publicKeyHex = bytesToHex((await import("@noble/curves/secp256k1.js")).secp256k1.getPublicKey(privateKey, true)).toLowerCase();
    if (previous.document.keys.some((key) => key.publicKeyHex.toLowerCase() === publicKeyHex)) throw new Error("Key already exists");
    const entry = selectedCatalogBucket();
    if (!entry) throw new StorageRuntimeError("storage_unavailable", "The selected catalog bucket is unavailable");
    const context = await deriveBucketCryptoContext(password, entry.keyDerivation);
    let encryptedKey: HoldKeyRecord;
    try { encryptedKey = await encryptBucketKey({ label: input.label, privateKey }, context); }
    finally { context.dispose(); }
    const nextIndex = [
      ...previousIndex,
      {
        format: "keymaster.storage.catalog-key-index" as const,
        publicKeyHex,
        label: input.label,
        address: deriveP2pkhAddress(publicKeyHex, "main"),
        network: "main" as const,
        keyFormat: input.format,
        capabilities: [...(input.capabilities ?? ["p2pkh"])],
        createdAt: new Date().toISOString(),
        ...(input.source === undefined ? {} : { source: input.source }),
      },
    ];
    await publishCurrentCatalogHoldSnapshot(password, [...previous.document.keys, encryptedKey], nextIndex);
    published = true;
    await platformRootStore?.activateOwnerStorage({ ownerPublicKeyHex: publicKeyHex });
    const previousStatus = coordinatorState.vaultStatus;
    coordinatorState.keyspaceGeneration++;
    try {
      await enterUnlockedState(publicKeyHex, privateKey, previousStatus === "unlocked" ? "activate-key" : initialCause);
    } catch (error) {
      if (coordinatorState.vaultStatus === "unlocked" || previousStatus !== "unlocked") coordinatorState.vaultStatus = previousStatus;
      throw error;
    }
    privateKeyTransferred = true;
    return {
      publicKeyHex,
      label: input.label,
      address: deriveP2pkhAddress(publicKeyHex, "main"),
      network: "main",
      format: input.format,
      capabilities: input.capabilities ?? ["p2pkh"],
      createdAt: nextIndex[nextIndex.length - 1]!.createdAt,
      source: input.source,
    };
  } catch (error) {
    if (published && publicKeyHex) {
      await publishCurrentCatalogHoldSnapshot(password, previous.document.keys, previousIndex).catch((rollbackError) => {
        console.warn("[vault] failed to roll back catalog Hold snapshot after new Key failure", rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
      });
      await platformRootStore?.deleteOwnerStorage({ ownerPublicKeyHex: publicKeyHex }).catch((cleanupError) => {
        console.warn("[vault] failed to roll back new catalog Key owner storage", cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
      });
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
  if (selectedCatalogBucket()) return addCatalogKeyRpc(password, input, initialCause);
  const meta = await getVaultMeta();
  if (!meta) throw new Error("Vault not initialized");
  // 即使当前 Vault 已 unlocked，也必须验证本次输入的密码，不能复用
  // 当前会话上下文为新 Key 绕过桶密码校验。
  if (!(await verifyPassword(password, meta))) throw new Error("Invalid password");
  const priv = cryptoHexToBytes(input.material.hex);
  let privateKeyTransferred = false;
  let persistedPublicKeyHex: string | undefined;
  try {
    const pub = bytesToHex((await import("@noble/curves/secp256k1.js")).secp256k1.getPublicKey(priv, true));
    if (await vaultKeyRepository.getKey(pub)) throw new Error("Key already exists");
    const document = keyholdParse(await keyholdExportPrivateKey({ privateKey: priv, password, label: input.label, parameters: keyholdRecommendedParameters() }));
    const record: VaultKeyRecord = { publicKeyHex: pub, label: input.label, address: deriveP2pkhAddress(pub, "main"), network: "main" as const, format: input.format, capabilities: input.capabilities ?? ["p2pkh"], createdAt: new Date().toISOString(), source: input.source, storageVersion: "keyhold-v2", keyholdDocument: document };
    await platformRootStore?.activateOwnerStorage({ ownerPublicKeyHex: pub });
    await vaultKeyRepository.putKey(record);
    persistedPublicKeyHex = pub;
    const wasUnlocked = coordinatorState.vaultStatus === "unlocked";
    // keyspaceGeneration 递增；只有 enter 成功后 worker state 才接管 priv。
    const previousStatus = coordinatorState.vaultStatus;
    // 先完成可能失败的密钥派生，再推进 generation；这样派生失败不会留下
    // 一个无法对应任何状态转换的世代。
    coordinatorState.keyspaceGeneration++;
    try {
      await enterUnlockedState(pub, priv, wasUnlocked ? "activate-key" : initialCause);
    } catch (error) {
      // owner drain 超时会由统一 transition 主动收口为 locked；此时不能
      // 让 addKey 的兼容回滚分支把状态重新写成 unlocked。
      if (coordinatorState.vaultStatus === "unlocked" || previousStatus !== "unlocked") {
        coordinatorState.vaultStatus = previousStatus;
      }
      throw error;
    }
    privateKeyTransferred = true;
    return { publicKeyHex: pub, label: record.label, address: record.address, network: record.network, format: record.format, capabilities: record.capabilities, createdAt: record.createdAt, source: record.source };
  } catch (error) {
    if (persistedPublicKeyHex) {
      await vaultKeyRepository.deleteKeyAndSidecars(persistedPublicKeyHex).catch((cleanupError) => console.warn("[vault] failed to roll back new Key record", cleanupError instanceof Error ? cleanupError.message : String(cleanupError)));
      await platformRootStore?.deleteOwnerStorage({ ownerPublicKeyHex: persistedPublicKeyHex }).catch((cleanupError) => console.warn("[vault] failed to roll back new Key owner storage", cleanupError instanceof Error ? cleanupError.message : String(cleanupError)));
    }
    throw error;
  } finally {
    if (!privateKeyTransferred) priv.fill(0);
  }
}
async function changePasswordRpc(oldPassword: string, newPassword: string): Promise<boolean> {
  if (selectedCatalogBucket()) {
    // 旧 Vault 改密只会旋转旧 KeyHold/meta，无法同时 CAS 更新本机桶
    // 目录与 Hold 快照；在完整桶改密流程接入前必须拒绝，避免密码分裂。
    throw new Error("Change the catalog bucket password from bucket management");
  }
  // Acquire the same mutation lane before even reading key material. This
  // prevents activate/clear/reset from starting while rotation is preparing.
  let releaseStorageMutation!: () => void;
  const previousStorageMutation = storageMutationTail;
  storageMutationTail = storageMutationTail.then(() => new Promise<void>((resolve) => { releaseStorageMutation = resolve; }));
  await previousStorageMutation;
  try {
    const meta = await getVaultMeta();
    if (!meta) throw new Error("Vault not initialized");
    if (!(await verifyPassword(oldPassword, meta))) throw new Error("Invalid password");
  const newSalt = crypto.getRandomValues(new Uint8Array(16));
  const newKey = await deriveKey(newPassword, newSalt);
  const oldPasswordKey = await deriveKey(oldPassword, decodePersisted(meta.saltB64));
  const verifier = await (await import("@keymaster/plugin-vault/coordinator")).encryptVerifier(newKey);
  const records = await vaultKeyRepository.listKeys();
  for (const record of records) if (record.storageVersion !== "keyhold-v2" || !record.keyholdDocument) throw new Error("Unsupported key storage version");
  const rotatedRecords: VaultKeyRecord[] = [];
  for (const record of records) {
    const unlocked = await (await import("keyhold")).unlock((await import("keyhold")).parse((await import("keyhold")).serialize(record.keyholdDocument!)), oldPassword);
    try {
      if (unlocked.publicKeyHex !== record.publicKeyHex) {
        unlocked.privateKey.fill(0);
        throw new Error("KeyHold public key mismatch");
      }
      const nextDoc = (await import("keyhold")).parse(await (await import("keyhold")).exportPrivateKey({ privateKey: unlocked.privateKey, password: newPassword, label: record.keyholdDocument!.label, parameters: (await import("keyhold")).recommendedParameters() }));
      rotatedRecords.push({ publicKeyHex: record.publicKeyHex, label: record.label, address: record.address, network: record.network, format: record.format, capabilities: record.capabilities, createdAt: record.createdAt, source: record.source, storageVersion: "keyhold-v2", keyholdDocument: nextDoc });
    } finally { unlocked.privateKey.fill(0); }
  }
  // Re-wrap Storage-owned local secrets behind the same Worker-owned gate.
  // Storage requests are fenced before the password rotation commit.
  const storageWithRotation = storageRuntime as (StorageRuntimeController & { beginPasswordRotation?: () => Promise<void>; finishPasswordRotation?: (degraded?: boolean) => void }) | undefined;
  let storageRotationDegraded = false;
  try {
    await storageWithRotation?.beginPasswordRotation?.();
    try {
      await vaultKeyRepository.putMetaAndKeys((await import("@keymaster/plugin-vault/coordinator")).buildVaultMeta({ salt: newSalt, verifier }), rotatedRecords);
    } catch (error) {
      throw error;
    }
    await performGlobalLock("password-change");
    return true;
  } finally {
    if (coordinatorState.vaultStatus === "unlocked") storageWithRotation?.finishPasswordRotation?.(storageRotationDegraded);
    releaseStorageMutation?.();
  }
  } catch (error) {
    releaseStorageMutation?.();
    throw error;
  }
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
  passkeyAddIntents.clear();

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
  coordinatorMeta.generation = coordinatorState.keyspaceGeneration;
  publishSessionState(reason === "key-deleted" || reason === "empty-vault" ? "delete-active-key" : reason === "recover-empty" ? "recover-empty-vault" : "lock");
  emitMsFileState();
  emitStorageState();

  // 广播任务快照，让 UI 立即显示 blocked 状态
  publishTopicEvent("background.snapshot", {
    type: "background.snapshot.changed",
    sessionEpoch: coordinatorState.sessionEpoch,
    snapshots: getTaskSnapshots(),
  });

  // 元数据只涉及本地持久化，失败不能回滚已经完成的安全锁定。
  await persistCoordinatorMeta().catch((error) => {
    markStorageIoFailure(error);
    console.warn("[coordinator] locked state metadata persistence failed", error instanceof Error ? error.message : String(error));
  });

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
    const meta = await getVaultMeta();
    if (!meta || !(await verifyPassword(request.password, meta))) throw new Error("Invalid password");
    const catalogMode = Boolean(selectedCatalogBucket());
    const committedCatalog = catalogMode
      ? await readVerifiedCurrentCatalogSnapshot(request.password)
      : undefined;
    if (catalogMode) await rebuildCurrentCatalogKeyIndex(committedCatalog!);
    const key = await getPublicVaultKey(request.publicKeyHex);
    if (!key) throw new Error("Key not found");
    // 同桶切换必须重新使用本次请求提供的桶密码；不能从当前 Key 会话
    // 或 Coordinator 状态取可复用的密码材料。
    const privateKey = catalogMode
      ? await decryptCurrentCatalogPrivateKey(key.publicKeyHex, request.password, committedCatalog)
      : await decryptPrivateKey(request.password, await requireLegacyVaultKeyRecord(key.publicKeyHex));
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
      passkeyAddIntents.clear();
      coordinatorMeta.selectedPublicKeyHex = key.publicKeyHex;
      coordinatorMeta.generation = coordinatorState.keyspaceGeneration;
      await persistCoordinatorMeta();
      await ensureCoordinatorUpgradeSession();
      completeActiveStorageOwnerTransition(transition);
    } catch (error) {
      const failedClosed = Boolean(previousActive) && coordinatorState.vaultStatus !== "unlocked";
      if (failedClosed) {
        dropActivePrivateKey();
        coordinatorMeta.selectedPublicKeyHex = previousSelected;
        coordinatorMeta.generation = coordinatorState.keyspaceGeneration;
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
        // withCoordinatorFinalIoLease 的后置 authority 检查才会发布。
        // 页面刷新若终止 Worker，持久 lease 反而会成为无法释放的孤儿，
        // 令新 Worker 在 hydrate 前永久拒绝接管。
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
  const interval = request.settings.assetHoldingsIntervalMs;
  if (!Number.isFinite(interval) || interval < 1_000 || interval > 7 * 24 * 60 * 60 * 1000) {
    return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "validation-error", message: "Invalid schedule interval" } };
  }
  const nextSettings = { ...request.settings };
  const nextMeta: CoordinatorMetaRecord = { ...coordinatorMeta, scheduleSettings: nextSettings };
  // 持久化成功才发布新的内存状态；保存失败不能制造“设置已生效”
  // 的假象，也不能让后续调度使用未落盘的值。
  await persistCoordinatorMetaValue(nextMeta);
  Object.assign(coordinatorMeta, nextMeta);
  coordinatorState.scheduleSettings = nextSettings;
  for (const runtime of coordinatorState.taskRuntimes.values()) { runtime.intervalMs = nextSettings.assetHoldingsIntervalMs; scheduleRuntime(runtime); }

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

// ============================================================
// 10. Ordinary P2PKH data-source selection and transaction broadcast RPC
// ============================================================

function p2pkhProviderSettings(): P2pkhProviderSettings {
  return coordinatorMeta.p2pkhProviders ?? (coordinatorMeta.p2pkhProviders = defaultP2pkhProviders());
}

function p2pkhSelection(network: "main" | "test"): P2pkhNetworkProviderSelection {
  return p2pkhProviderSettings()[network];
}

function validateP2pkhSelection(network: "main" | "test", selection: P2pkhNetworkProviderSelection): string | undefined {
  if (selection.syncProviderId && !p2pkhRegistry?.getConfirmedProvider(selection.syncProviderId, network)) return `Confirmed provider is unavailable for ${network}: ${selection.syncProviderId}`;
  if (selection.broadcastProviderId && !p2pkhRegistry?.getBroadcastProvider(selection.broadcastProviderId, network)) return `Broadcast provider is unavailable for ${network}: ${selection.broadcastProviderId}`;
  return undefined;
}

async function cancelP2pkhSyncForProviderChange(): Promise<void> {
  const runtime = coordinatorState.taskRuntimes.get("p2pkh.transactions-sync");
  runtime?.controller?.abort();
  if (runtime?.timer) clearTimeout(runtime.timer);
  runtime && (runtime.timer = undefined);
  if (runtime?.completion) await runtime.completion.catch(() => undefined);
  const publicKeyHex = coordinatorState.activePublicKeyHex;
  if (!publicKeyHex) return;
  const keyspace = createWorkerKeyspace();
  try {
    const repository = createP2pkhStateRepository(await openP2pkhStateRepository(createWorkerOwnerStore("p2pkh", P2PKH_REPOSITORY_VERSION)));
    for (const resource of await repository.listResourcesByKey()) await repository.clearInProgressSyncState(resource.resourceId);
  } catch {
    // The generation fence still prevents late commits. A transient cleanup
    // failure is surfaced by the next sync attempt instead of losing claims.
  }
  if (runtime && coordinatorState.vaultStatus === "unlocked" && coordinatorState.activePublicKeyHex) {
    // Execute immediately; executeTask's finally block installs the next
    // interval after this run. Scheduling here as well would leave a second
    // timer alive and allow overlapping sync runs.
    void executeTask(runtime.id, "provider-change");
  }
}

async function handleP2pkhProvidersGet(requestId: string): Promise<CoordinatorResponse> {
  if (!isCoordinatorProductEnabled("p2pkh")) return coordinatorProductBlockedResponse(requestId, "p2pkh");
  return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: getP2pkhProviderSnapshot() };
}

async function handleP2pkhSettingsUpdate(
  requestId: string,
  request: Extract<CoordinatorClientRequest, { kind: "p2pkh.settings.update" }>
): Promise<CoordinatorResponse> {
  if (!isCoordinatorProductEnabled("p2pkh")) return coordinatorProductBlockedResponse(requestId, "p2pkh");
  if (typeof request.settings.includeTestnet !== "boolean") {
    return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "validation-error", message: "Invalid P2PKH network settings" } };
  }
  const nextMeta: CoordinatorMetaRecord = { ...coordinatorMeta, p2pkhSettings: { includeTestnet: request.settings.includeTestnet } };
  await persistCoordinatorMetaValue(nextMeta);
  Object.assign(coordinatorMeta, nextMeta);
  await cancelP2pkhSyncForProviderChange();
  publishTopicEvent("background.snapshot", { type: "background.snapshot.changed", snapshots: getTaskSnapshots() });
  return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "accepted" } };
}

async function handleP2pkhProvidersUpdate(
  requestId: string,
  request: Extract<CoordinatorClientRequest, { kind: "p2pkh.providers.update" }>
): Promise<CoordinatorResponse> {
  if (!isCoordinatorProductEnabled("p2pkh")) return coordinatorProductBlockedResponse(requestId, "p2pkh");
  const current = p2pkhProviderSettings();
  if (request.expectedGeneration !== current.generation) return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "validation-error", message: "P2PKH provider settings generation changed" } };
  const validation = validateP2pkhSelection(request.network, request.selection);
  if (validation) return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "validation-error", message: validation } };
  const next: P2pkhProviderSettings = { ...current, main: { ...current.main }, test: { ...current.test }, [request.network]: { ...request.selection }, generation: current.generation + 1 };
  const nextMeta: CoordinatorMetaRecord = { ...coordinatorMeta, p2pkhProviders: next };
  await persistCoordinatorMetaValue(nextMeta);
  Object.assign(coordinatorMeta, nextMeta);
  await cancelP2pkhSyncForProviderChange();
  publishTopicEvent("p2pkh.providers", { type: "p2pkh.providers.changed", snapshot: getP2pkhProviderSnapshot() });
  publishTopicEvent("background.snapshot", { type: "background.snapshot.changed", snapshots: getTaskSnapshots() });
  return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "accepted" }, operationResult: getP2pkhProviderSnapshot() };
}

async function handleP2pkhProviderConfigGet(
  requestId: string,
  request: Extract<CoordinatorClientRequest, { kind: "p2pkh.provider-config.get" }>
): Promise<CoordinatorResponse> {
  const productId = request.providerId === "woc" || request.providerId === "junglebus" ? request.providerId : "p2pkh";
  if (!isCoordinatorProductEnabled(productId)) return coordinatorProductBlockedResponse(requestId, productId);
  const persisted = coordinatorMeta.p2pkhProviderConfigs?.[request.providerId];
  if (persisted) return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: { ...persisted } };
  if (request.providerId === "woc" && p2pkhWocService) {
    const config = p2pkhWocService.getConfig();
    return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: { endpoint: config.baseUrl, requestsPerSecond: config.requestsPerSecond } };
  }
  if (request.providerId === "junglebus" && p2pkhJungleBusClient?.getConfig) {
    const config = p2pkhJungleBusClient.getConfig();
    return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: { endpoint: config.baseUrl, mainEndpoint: config.mainBaseUrl, testEndpoint: config.testBaseUrl, timeoutMs: config.timeoutMs, maxRetries: config.maxRetries, requestsPerSecond: config.requestsPerSecond } };
  }
  return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: {} };
}

async function handleP2pkhProviderConfigUpdate(
  requestId: string,
  request: Extract<CoordinatorClientRequest, { kind: "p2pkh.provider-config.update" }>
): Promise<CoordinatorResponse> {
  const productId = request.providerId === "woc" || request.providerId === "junglebus" ? request.providerId : "p2pkh";
  if (!isCoordinatorProductEnabled(productId)) return coordinatorProductBlockedResponse(requestId, productId);
  const knownDisabledConfirmedProvider = request.providerId === "junglebus" && Boolean(p2pkhJungleBusClient);
  if (!knownDisabledConfirmedProvider
    && !p2pkhRegistry?.listConfirmedProviders().some((provider) => provider.id === request.providerId)
    && !p2pkhRegistry?.listBroadcastProviders().some((provider) => provider.id === request.providerId)) {
    return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "validation-error", message: `Unknown P2PKH provider: ${request.providerId}` } };
  }
  const previousConfigs = coordinatorMeta.p2pkhProviderConfigs;
  const previousConfig = previousConfigs?.[request.providerId];
  const enabled = request.providerId === "junglebus" ? request.config.enabled !== false : true;
  const nextConfig = { ...(previousConfig ?? {}), ...request.config };
  const settings = p2pkhProviderSettings();
  const disabling = request.providerId === "junglebus" && !enabled;
  const nextSelection: P2pkhProviderSettings = {
    ...settings,
    // Keep the user's explicit provider id when the optional plugin is
    // disabled. The registry absence is intentional and makes the sync task
    // enter blocked; clearing to null would silently turn an explicit choice
    // into an unconfigured/fallback-looking state.
    main: { ...settings.main },
    test: { ...settings.test },
    generation: settings.generation + 1
  };
  const nextMeta: CoordinatorMetaRecord = {
    ...coordinatorMeta,
    p2pkhProviderConfigs: { ...(previousConfigs ?? {}), [request.providerId]: nextConfig },
    p2pkhProviders: nextSelection
  };
  const wasJungleBusRegistered = Boolean(p2pkhRegistry?.getConfirmedProvider("junglebus", "main"));
  const previousJungleBusClientConfig = p2pkhJungleBusClient?.getConfig?.();
  const previousWocConfig = p2pkhWocService?.getConfig?.();
  try {
    // Persist the candidate before changing the in-memory selection or
    // registry. A failed write must leave the running session untouched.
    await persistCoordinatorMetaValue(nextMeta);
    if (request.providerId === "junglebus" && enabled && p2pkhJungleBusClient && !wasJungleBusRegistered) {
      registerJungleBusP2pkhProvider({ registry: p2pkhRegistry!, client: p2pkhJungleBusClient });
    }
    if (request.providerId === "junglebus" && disabling && wasJungleBusRegistered) {
      p2pkhRegistry?.unregisterConfirmedProvider?.("junglebus");
    }
    if (request.providerId === "woc" && p2pkhWocService) {
      const update: Partial<import("@keymaster/contracts").WocConfig> = {};
      if (typeof request.config.endpoint === "string" && request.config.endpoint.trim()) update.baseUrl = request.config.endpoint.trim();
      if (typeof request.config.requestsPerSecond === "number") update.requestsPerSecond = request.config.requestsPerSecond;
      if (Object.keys(update).length) p2pkhWocService.updateConfig(update);
    } else if (request.providerId === "junglebus" && p2pkhJungleBusClient?.updateConfig) {
      p2pkhJungleBusClient.updateConfig({
        ...(typeof request.config.endpoint === "string" ? { baseUrl: request.config.endpoint } : {}),
        ...(typeof request.config.mainEndpoint === "string" ? { mainBaseUrl: request.config.mainEndpoint } : {}),
        ...(typeof request.config.testEndpoint === "string" ? { testBaseUrl: request.config.testEndpoint } : {}),
        ...(typeof request.config.timeoutMs === "number" ? { timeoutMs: request.config.timeoutMs } : {}),
        ...(typeof request.config.maxRetries === "number" ? { maxRetries: request.config.maxRetries } : {}),
        ...(typeof request.config.requestsPerSecond === "number" ? { requestsPerSecond: request.config.requestsPerSecond } : {})
      });
    }
  } catch (error) {
    if (request.providerId === "junglebus" && p2pkhJungleBusClient) {
      const isRegistered = Boolean(p2pkhRegistry?.getConfirmedProvider("junglebus", "main"));
      if (wasJungleBusRegistered && !isRegistered) registerJungleBusP2pkhProvider({ registry: p2pkhRegistry!, client: p2pkhJungleBusClient });
      if (!wasJungleBusRegistered && isRegistered) p2pkhRegistry?.unregisterConfirmedProvider?.("junglebus");
      if (previousJungleBusClientConfig) p2pkhJungleBusClient.updateConfig?.(previousJungleBusClientConfig);
    }
    if (request.providerId === "woc" && previousWocConfig) p2pkhWocService?.updateConfig?.(previousWocConfig);
    await persistCoordinatorMetaValue(coordinatorMeta).catch(() => undefined);
    throw error;
  }
  Object.assign(coordinatorMeta, nextMeta);
  await cancelP2pkhSyncForProviderChange();
  publishTopicEvent("p2pkh.providers", { type: "p2pkh.providers.changed", snapshot: getP2pkhProviderSnapshot() });
  return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "accepted" } };
}

async function handleP2pkhBroadcast(
  requestId: string,
  request: Extract<CoordinatorClientRequest, { kind: "p2pkh.broadcast" | "p2pkh.rebroadcast-ancestors" }>
): Promise<CoordinatorResponse> {
  if (!isCoordinatorProductEnabled("p2pkh")) return coordinatorProductBlockedResponse(requestId, "p2pkh");
  // 广播可能已经被远端接受但尚未回写本地提交记录；必须把 Provider
  // 调用和 submission audit 放在同一个持久 write lease 内。若期间发生
  // 本地 lock，下面的 lease 复核会把结果报告为 error/unknown，不能伪报
  // 成功，但 Unsafe 逻辑仍会尽力记录远端返回或失败原因。
  return withCoordinatorFinalIoLease(
    "write",
    undefined,
    () => handleP2pkhBroadcastUnsafe(requestId, request),
    { auditOperation: "p2pkh.broadcast" },
  );
}

async function handleP2pkhBroadcastUnsafe(
  requestId: string,
  request: Extract<CoordinatorClientRequest, { kind: "p2pkh.broadcast" | "p2pkh.rebroadcast-ancestors" }>
): Promise<CoordinatorResponse> {
  const isRebroadcast = request.kind === "p2pkh.rebroadcast-ancestors";
  const settings = p2pkhProviderSettings();
  if (request.expectedProviderGeneration !== settings.generation) {
    await abortNotDispatchedP2pkhSubmission(request, "stale-provider-generation");
    return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: { status: "not-dispatched", reason: "stale-provider-generation" } };
  }
  const providerId = p2pkhSelection(request.network).broadcastProviderId;
  const provider = testP2pkhBroadcastProvider ?? (providerId ? p2pkhRegistry?.getBroadcastProvider(providerId, request.network) : undefined);
  if (!provider) {
    await abortNotDispatchedP2pkhSubmission(request, "broadcast-provider-unavailable");
    return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: { status: "not-dispatched", reason: "broadcast-provider-unavailable" } };
  }

  const keyspace = createWorkerKeyspace();
  if (keyspace.active().activePublicKeyHex?.toLowerCase() !== request.ownerPublicKeyHex.toLowerCase()) throw new Error("P2PKH storage owner is not active");
  const repository = createP2pkhStateRepository(await openP2pkhStateRepository(createWorkerOwnerStore("p2pkh", P2PKH_REPOSITORY_VERSION)));
  const localRows = (await repository.listLocalTransactions()).filter((row) => row.network === request.network);
  const local = localRows.find((row) => row.id === request.submissionId);
  if (!local) return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "validation-error", message: "Local P2PKH submission not found" } };
  if (!isRebroadcast && (local.localState !== "submitting" || local.chainResolution !== "unresolved")) return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "validation-error", message: `Submission is not dispatchable in localState=${local.localState}, chainResolution=${local.chainResolution}` } };
  const rowsByTxid = new Map<string, typeof localRows>();
  for (const row of localRows) {
    const group = rowsByTxid.get(row.txid) ?? [];
    group.push(row);
    rowsByTxid.set(row.txid, group);
  }
  const compareCanonicalRows = (left: (typeof localRows)[number], right: (typeof localRows)[number]): number => left.rawTxHex.localeCompare(right.rawTxHex) || left.id.localeCompare(right.id);
  const canonicalRowForTxid = (txid: string): (typeof localRows)[number] | undefined => [...(rowsByTxid.get(txid) ?? [])].sort(compareCanonicalRows)[0];
  const orderedTxids: string[] = [];
  const visited = new Set<string>();
  const visit = (txid: string) => {
    if (visited.has(txid)) return;
    visited.add(txid);
    const group = rowsByTxid.get(txid) ?? [];
    const parentTxids = [...new Set(group.flatMap((row) => row.parentTxids))].sort();
    for (const parentTxid of parentTxids) {
      if (rowsByTxid.has(parentTxid)) visit(parentTxid);
    }
    orderedTxids.push(txid);
  };
  visit(local.txid);
  const dispatch = async (row: (typeof localRows)[number]) => {
    const previousLocalState = row.localState;
    const startedAt = new Date().toISOString();
    try {
      const result = await provider.broadcast({ network: request.network, canonicalTxid: row.txid, rawTxHex: row.rawTxHex });
      if (result.canonicalTxid !== row.txid) throw new Error("Broadcast provider returned a different transaction id");
      const finishedAt = new Date().toISOString();
      await repository.finishLocalSubmission({ submissionId: row.id, localState: "local-confirmed", attempt: { id: `${row.id}:${startedAt}`, submissionId: row.id, providerId: provider.descriptor.id, startedAt, finishedAt, status: result.status, providerReference: result.providerReference, providerCode: result.providerCode, providerMessage: result.providerMessage } });
      publishTopicEvent("asset.data-changed", { type: "asset.data-changed", providerId: "p2pkh", publicKeyHex: request.ownerPublicKeyHex, kinds: ["utxo", "submission", "claim"] });
      return { status: result.status === "already-known" ? "already-known" : "local-confirmed", txid: row.txid } as const;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const finishedAt = new Date().toISOString();
      const attempt = { id: `${row.id}:${startedAt}`, submissionId: row.id, providerId: provider.descriptor.id, startedAt, finishedAt, status: "isolated" as const, providerMessage: message };
      if (previousLocalState === "local-confirmed") {
        // A failed rebroadcast cannot invalidate an earlier accepted or
        // already-known result. Preserve outputs/claims and append the audit.
        await repository.finishLocalSubmission({ submissionId: row.id, localState: "local-confirmed", attempt });
      } else {
        await repository.finishLocalSubmission({ submissionId: row.id, localState: "isolated", reason: message, attempt });
      }
      publishTopicEvent("asset.data-changed", { type: "asset.data-changed", providerId: "p2pkh", publicKeyHex: request.ownerPublicKeyHex, kinds: ["submission", "claim"] });
      return { status: previousLocalState === "local-confirmed" ? "rebroadcast-failed" : "isolated", txid: row.txid, reason: message } as const;
    }
  };
  if (isRebroadcast) {
    for (const txid of orderedTxids) {
      const group = rowsByTxid.get(txid) ?? [];
      // A duplicate audit sibling is part of the same logical transaction.
      // Conflict wins over chain confirmation so an unsafe fork can never be
      // hidden by platform K-V repository return order; chain confirmation then wins over a
      // merely local lifecycle and skips the provider call.
      if (group.some((row) => row.chainResolution === "conflicted")) return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: { status: "isolated", txid, reason: "conflicted-ancestor" } };
      if (group.some((row) => row.chainResolution === "chain-confirmed")) continue;
      // Ancestor groups may use a deterministic representative, but the
      // requested logical transaction must preserve the submission audit
      // boundary: its attempt belongs to the exact submissionId supplied by
      // the caller, even when another sibling sorts first.
      const ancestor = txid === local.txid ? local : canonicalRowForTxid(txid);
      if (!ancestor) continue;
      const result = await dispatch(ancestor);
      if (result.status === "isolated" || result.status === "rebroadcast-failed") return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: { ...result, providerId: provider.descriptor.id } };
    }
    return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: { status: "local-confirmed", providerId: provider.descriptor.id, txid: local.txid } };
  }
  const result = await dispatch(local);
  return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: { ...result, providerId: provider.descriptor.id } };
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
    p2pkhSettings: coordinatorMeta.p2pkhSettings,
    storageBucketGeneration: platformRootStore?.bucket.bucketGeneration,
    ...(platformRootStore ? { storageBucketId: platformRootStore.bucket.bucketId } : {}),
    p2pkhProviders: getP2pkhProviderSnapshot(),
    ...(storageIoOwnerPeer ? { storageIoOwnerPeer } : {}),
    // Worker 重启后 controller 可能尚未惰性创建，但持久化快照已经是
    // 当前产品意图真值；首个页面不能拿 revision=0 覆盖它。
    pluginIntent: pluginIntentController?.snapshot() ?? coordinatorMeta.pluginIntent,
  };
}

function getP2pkhProviderSnapshot(): P2pkhProviderRegistrySnapshot {
  const settings = coordinatorMeta.p2pkhProviders ?? (coordinatorMeta.p2pkhProviders = defaultP2pkhProviders());
  return {
    syncProviders: p2pkhRegistry?.listConfirmedProviders() ?? [],
    broadcastProviders: p2pkhRegistry?.listBroadcastProviders() ?? [],
    selection: {
      main: { ...settings.main },
      test: { ...settings.test },
      generation: settings.generation,
    },
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

function publishTopicEvent(topic: CoordinatorTopic, event: any): CoordinatorTopicEvent {
  const normalized = {
    ...event,
    topic,
    ...(topic === "session.state" ? { sessionRevision: ++sessionRevision } : topic === "background.snapshot" ? { backgroundSnapshotRevision: ++backgroundSnapshotRevision } : topic === "storage.state" ? { storageRevision: event.storageRevision } : topic === "msfile.state" ? { msfileRevision: event.msfileRevision } : topic === "p2pkh.providers" ? { providerRevision: ++p2pkhProviderRevision } : topic === "sat.events" ? { satRevision: event.satRevision } : topic === "channel.events" ? { channelRevision: ++channelRevision } : topic === "contacts.presence" ? { presenceRevision: ++contactsPresenceRevision } : topic === "plugin.intent" ? { pluginIntentRevision: event.pluginIntentRevision ?? event.snapshot?.revision ?? 0 } : topic === "worker.units" ? { workerUnitRevision: event.workerUnitRevision ?? coordinatorRuntimeUnitRevision() } : { assetDataRevision: ++assetDataRevision }),
    sessionEpoch: coordinatorState.sessionEpoch,
    ...(topic === "background.snapshot" ? { scheduleSettings: coordinatorState.scheduleSettings } : {})
  } as CoordinatorTopicEvent;
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
  const AUTO_LOCK_TIMEOUT_MS = 15 * 60 * 1000;
  if (autoLockTimer) clearTimeout(autoLockTimer);
  coordinatorState.autoLockDeadline = Date.now() + AUTO_LOCK_TIMEOUT_MS;

  autoLockTimer = setTimeout(() => {
    autoLockTimer = undefined;
    if (
      coordinatorState.autoLockDeadline &&
      Date.now() >= coordinatorState.autoLockDeadline &&
      coordinatorState.vaultStatus === "unlocked"
    ) {
      void performGlobalLock("auto-lock-timeout");
    }
  }, AUTO_LOCK_TIMEOUT_MS);
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
      // 纯本地签名没有外部 I/O 或持久化副作用；返回前仍受 authority、
      // UpgradeGate、AbortSignal 和 session epoch 的多重后置栅栏保护。
      // 不持久化 lease，避免页面卸载杀死 Worker 后留下恢复阻断。
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
      await loadInitialSetupRecoveryRecords(call.signal, attempt.peerId);
      assertCoordinatorSessionOpenFresh(attempt);
      if (!platformRootStore && !storageBootstrapState?.selectedBucket && request.storageBootstrapState?.selectedBucket) {
        storageBootstrapState = request.storageBootstrapState;
        bootstrapHintAssigned = true;
      }
      await startCoordinatorInitialization(request.storageBootstrapState);
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
      // Web Lock 与 Provider CAS 串行，不会绕过存储并发边界。
      storageIoOwner = {
        ...attempt.binding,
        peerId: attempt.peerId,
        commitOrder: ++coordinatorStorageIoHandoffRevision,
      };
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
  runtimeUnitAvailability: ({ unitId }) => {
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
  runtimeUnitAttributes: ({ unitId }) => {
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
}

// Worker 启动时从 K-V 读取仅公开的 Vault metadata
// 状态为 uninitialized 或 locked；绝不读取/解密私钥直到 unlock RPC
async function initializeCoordinator(skipStorageBootstrap = false, propagateFailure = false): Promise<void> {
  coordinatorInitializationInProgress = true;
  try {
    await initializeCoordinatorInternal(skipStorageBootstrap, propagateFailure);
  } finally {
    coordinatorInitializationInProgress = false;
  }
}

async function initializeCoordinatorInternal(skipStorageBootstrap = false, propagateFailure = false): Promise<void> {
  if (skipStorageBootstrap && !platformRootStore) {
    throw storageUnavailableError("Storage root is unavailable during recovery");
  }
  if (!skipStorageBootstrap) {
    try {
      // Storage 是独立健康域；失败时保持 Vault booting，等待页面重试，
      // 不能把可恢复的 Provider/CORS/认证问题升级成 Vault fatal。
      await bootstrapPlatformStorage();
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
    // 先取得共享持久化权威，再允许启动恢复读取 metadata、消费 Journal
    // 或修改 Vault 选择。claim 与 locked/unlocked 状态完全解耦。
    await ensureCoordinatorAuthorityClaim();
    // Storage ready 后，Vault/Keyspace 才允许读取 keys/。
    await withCoordinatorFinalIoLease(
      "write",
      undefined,
      async () => {
        await loadCoordinatorMeta();
        // keys/ 中的删除 Journal 优先恢复；这一步不依赖 Vault 解锁，
        // 因为 Journal 只包含公开公钥和用户确认标签。
        await recoverKeyDeletionJournals();
        const meta = await getVaultMeta();
        if (meta) {
          coordinatorState.vaultStatus = "locked";
          coordinatorState.activePublicKeyHex = undefined;
          coordinatorState.keyspaceGeneration = coordinatorMeta.generation;
          // 只校正持久化的公开选择，不解析或解密私钥文档。
          if (!await reconcileSelectedPublicKey()) coordinatorState.vaultStatus = "uninitialized";
        } else {
          coordinatorState.vaultStatus = "uninitialized";
        }
      },
      { allowLocalLock: true, auditOperation: "coordinator.bootstrap.recover" },
    );
    await ensureStorageRuntime();
    await registerCoordinatorTasks();
    activateCoordinatorRootWorkerUnits();
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
function startCoordinatorInitialization(state?: StorageBootstrapState): Promise<void> {
  if (!coordinatorInitialization) {
    // Worker 没有 localStorage；首个页面 hello 提供启动选择。
    // 缺失选择时保持 unselected，任何 keys/ 与 Vault 初始化都不得发生。
    storageBootstrapState = state ?? null;
    coordinatorInitialization = initializeCoordinator();
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

/** 测试专用：只推进持久化权威，不修改当前 Worker 内存。 */
export async function __testFenceCoordinatorAuthority(): Promise<void> {
  await ensureCoordinatorAuthorityClaim();
  if (!platformStateStore || !coordinatorAuthorityRecord) throw new Error("Coordinator authority is unavailable");
  const partition = await platformStateStore.list({ partition: COORDINATOR_UPGRADE_PARTITION, limit: 1 });
  await platformStateStore.put(COORDINATOR_UPGRADE_KEY, {
    ...coordinatorAuthorityRecord,
    authorityInstanceId: "coordinator:external-test-fence",
    handoverGeneration: coordinatorAuthorityRecord.handoverGeneration + 1,
  } satisfies CoordinatorAuthorityRecord, {
    partition: COORDINATOR_UPGRADE_PARTITION,
    ifRevision: partition.revision,
  });
}

/** 测试专用：持有一条最终 I/O 租约，模拟旧 Worker 崩溃前未完成的写入。 */
export async function __testHoldCoordinatorFinalIoLease(): Promise<() => Promise<void>> {
  await ensureCoordinatorUpgradeSession();
  const lease = await acquireCoordinatorFinalIoLease("write");
  return lease.release;
}

export function __testResetState(): void {
  ensureTestPlatformStorage();
  // Drop domain-owned resources before resetting the compatibility table. The
  // real WebLoom Host must then observe the booting/locked state and tear down
  // its old owner scopes before the next test unlocks a new owner.
  releaseMsfileRuntime("test-reset");
  testMsfileRuntimeOverride = undefined;
  testMsfileRuntimeRecoveryAllowed = true;
  coordinatorWorkerUnitRegistry.reset();
  if (storageRuntime) {
    const storageUnit = coordinatorWorkerUnitRegistry.activate("storage.coordinator-worker");
    coordinatorWorkerUnitRegistry.ready(storageUnit.unitId, storageUnit.instanceId);
  }
  // 测试夹具模拟 Worker 重启：旧意图控制器和 authority 不能继续冒充新实例。
  closeCoordinatorUpgradeSession("Coordinator test Worker reset");
  pluginIntentControllerOff?.();
  pluginIntentControllerOff = undefined;
  pluginIntentController = undefined;
  coordinatorAuthorityInstanceId = makeCoordinatorAuthorityInstanceId();
  coordinatorAuthorityRecord = undefined;
  coordinatorAuthorityRecovery = undefined;
  coordinatorAuthorityRecoveryOperationNames = [];
  coordinatorHandoverGeneration = 0;
  // reset API 保持同步以兼容既有测试；真正的最终 I/O 会等待这条 claim
  // 完成，因此不会在新权威落盘前执行业务操作。
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
  testPersistCoordinatorMetaFailure = false;
  testFailAfterCatalogBindingPublish = false;
  testLocalStorageBridgeOverride = undefined;
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
  contactsPresenceRevision = 0;
  lastContactsPresenceState = undefined;
  contactsPresencePublishTail = Promise.resolve();
  channelPublicSubscribers.clear();
  channelPrivateSubscribers.clear();
  testSatInboundResponseDispatcher = undefined;
  satRevision = 0;
  lastSatState = undefined;
  msfileMutationTail = Promise.resolve();
  clearWindowP2pExecutorLeaseLocked();
  windowP2pExecutorIdentityTail = Promise.resolve();
  msfileMutationTail = Promise.resolve();
  storageStateTail = Promise.resolve();
  storageMutationTail = Promise.resolve();
  storageRuntime = testStorageRuntimeOverride;
  passkeyAddIntents.clear();
  coordinatorRequestTail = Promise.resolve();
  testP2pkhBroadcastProvider = undefined;
}

export function __testSetVaultStatus(status: CoordinatorVaultStatus, activePublicKeyHex?: string): void {
  coordinatorState.vaultStatus = status;
  coordinatorState.activePublicKeyHex = activePublicKeyHex;
}

export function __testSetP2pkhBroadcastProvider(provider: P2pkhTransactionBroadcastProvider | undefined): void {
  testP2pkhBroadcastProvider = provider;
}

export function __testFailNextCoordinatorMetaPersist(): void {
  testPersistCoordinatorMetaFailure = true;
}

/** 测试专用：在切桶目标绑定已发布后注入一次后续初始化失败。 */
export function __testFailAfterCatalogBindingPublish(): void {
  testFailAfterCatalogBindingPublish = true;
}

/** 测试专用：替换页面 Local bridge，覆盖候选 Root 和目录 CAS 的真实切桶流程。 */
export function __testSetLocalStorageBridgeOverride(
  bridge: ((input: LocalStorageBridgeRequest) => Promise<LocalStorageBridgeResponse>) | undefined,
): void {
  testLocalStorageBridgeOverride = bridge;
}

/** 测试专用：清空内存 Root，进入真正的“尚未初始化”首桶事务前置态。 */
export function __testPrepareInitialSetup(): void {
  if (platformRootStore) discardCurrentPlatformStorageBinding();
  storageBootstrapController?.dispose();
  storageBootstrapController = undefined;
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

/** 测试专用：注入公开恢复记录，验证同一 transactionId 不会重新执行。 */
export function __testSeedInitialSetupRecoveryRecord(record: InitialSetupRecoveryRecordV1): void {
  initialSetupRecoveryRecords.set(record.transactionId, structuredClone(record));
}

/** 测试专用：把一个已加密目录条目安装成当前 Local catalog binding。 */
export async function __testInstallCatalogLocalBinding(entry: StorageBucketCatalogEntryV2): Promise<void> {
  if (!testLocalStorageBridgeOverride) throw new Error("Local storage bridge test override is not installed");
  if (platformRootStore) discardCurrentPlatformStorageBinding();
  storageBootstrapState = {
    selectedBackend: "local",
    selectedProfileId: entry.bucketId,
    selectedBucket: structuredClone(entry),
  };
  const provider = createLocalStorageBucketProvider({
    bucketId: entry.bucketId,
    bucketGeneration: 1,
    bridge: requestLocalStorageBridge,
  });
  try {
    await installPlatformStorage(provider, {
      bucketId: entry.bucketId,
      bucketGeneration: 1,
      provider: "local",
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
  target: StorageBucketCatalogEntryV2,
  password: string,
): Promise<StorageBucketSwitchResultV1> {
  return switchSelectedCatalogBucket(target, password);
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

export async function __testP2pkhProvidersUpdate(network: "main" | "test", selection: P2pkhNetworkProviderSelection): Promise<CoordinatorResponse> {
  await ensureTestP2pkhProviders();
  const current = p2pkhProviderSettings();
  return handleP2pkhProvidersUpdate(`test-p2pkh-selection-${Date.now()}`, {
    kind: "p2pkh.providers.update",
    clientId: "test",
    requestId: `test-p2pkh-selection-${Date.now()}`,
    network,
    selection,
    expectedGeneration: current.generation,
    expectedSessionEpoch: coordinatorState.sessionEpoch
  });
}

export async function __testSeedP2pkhLocalSubmission(input: { ownerPublicKeyHex: string; submission: unknown; claims?: unknown[]; localOutpoints?: unknown[] }): Promise<void> {
  const keyspace = createWorkerKeyspace();
  if (keyspace.active().activePublicKeyHex?.toLowerCase() !== input.ownerPublicKeyHex.toLowerCase()) throw new Error("P2PKH storage owner is not active");
  const repository = createP2pkhStateRepository(await openP2pkhStateRepository(createWorkerOwnerStore("p2pkh", P2PKH_REPOSITORY_VERSION)));
  await repository.prepareLocalSubmission({ submission: input.submission as never, claims: (input.claims ?? []) as never, localOutpoints: (input.localOutpoints ?? []) as never });
}

export async function __testFinishP2pkhLocalSubmission(input: { ownerPublicKeyHex: string; submissionId: string; localState: "local-confirmed" | "isolated" }): Promise<void> {
  const keyspace = createWorkerKeyspace();
  if (keyspace.active().activePublicKeyHex?.toLowerCase() !== input.ownerPublicKeyHex.toLowerCase()) throw new Error("P2PKH storage owner is not active");
  const repository = createP2pkhStateRepository(await openP2pkhStateRepository(createWorkerOwnerStore("p2pkh", P2PKH_REPOSITORY_VERSION)));
  await repository.finishLocalSubmission({ submissionId: input.submissionId, localState: input.localState });
}

export async function __testSetP2pkhChainResolution(input: { ownerPublicKeyHex: string; submissionId: string; chainResolution: "unresolved" | "chain-confirmed" | "conflicted"; conflictSourceTxids?: string[] }): Promise<void> {
  const keyspace = createWorkerKeyspace();
  if (keyspace.active().activePublicKeyHex?.toLowerCase() !== input.ownerPublicKeyHex.toLowerCase()) throw new Error("P2PKH storage owner is not active");
  const repository = createP2pkhStateRepository(await openP2pkhStateRepository(createWorkerOwnerStore("p2pkh", P2PKH_REPOSITORY_VERSION)));
  const row = (await repository.listLocalTransactions()).find((candidate) => candidate.id === input.submissionId);
  if (!row) throw new Error(`P2PKH submission not found: ${input.submissionId}`);
  const next = { ...row, chainResolution: input.chainResolution, ...(input.chainResolution === "conflicted" ? { conflictSourceTxids: input.conflictSourceTxids ?? ["test-conflict"] } : { conflictSourceTxids: undefined }), ...(input.chainResolution === "chain-confirmed" ? { confirmedFactId: `${row.resourceId}:${row.txid}` } : { confirmedFactId: undefined }) };
  await repository.replaceLocalTransaction(next);
}

export async function __testListP2pkhLocalTransactions(ownerPublicKeyHex: string): Promise<unknown[]> {
  const keyspace = createWorkerKeyspace();
  if (keyspace.active().activePublicKeyHex?.toLowerCase() !== ownerPublicKeyHex.toLowerCase()) throw new Error("P2PKH storage owner is not active");
  const repository = createP2pkhStateRepository(await openP2pkhStateRepository(createWorkerOwnerStore("p2pkh", P2PKH_REPOSITORY_VERSION)));
  return repository.listLocalTransactions();
}

export async function __testListP2pkhLocalOutpoints(ownerPublicKeyHex: string): Promise<unknown[]> {
  const keyspace = createWorkerKeyspace();
  if (keyspace.active().activePublicKeyHex?.toLowerCase() !== ownerPublicKeyHex.toLowerCase()) throw new Error("P2PKH storage owner is not active");
  const repository = createP2pkhStateRepository(await openP2pkhStateRepository(createWorkerOwnerStore("p2pkh", P2PKH_REPOSITORY_VERSION)));
  return repository.listLocalOutpoints();
}

export async function __testListP2pkhLocalInputClaims(ownerPublicKeyHex: string): Promise<unknown[]> {
  const keyspace = createWorkerKeyspace();
  if (keyspace.active().activePublicKeyHex?.toLowerCase() !== ownerPublicKeyHex.toLowerCase()) throw new Error("P2PKH storage owner is not active");
  const repository = createP2pkhStateRepository(await openP2pkhStateRepository(createWorkerOwnerStore("p2pkh", P2PKH_REPOSITORY_VERSION)));
  return repository.listLocalInputClaims();
}

export async function __testP2pkhBroadcast(input: { ownerPublicKeyHex: string; network: "main" | "test"; submissionId: string; expectedProviderGeneration: number; expectedSessionEpoch?: SessionEpoch; rebroadcast?: boolean }): Promise<CoordinatorResponse> {
  await ensureTestP2pkhProviders();
  if (input.submissionId.startsWith("unknown-rebroadcast")) {
  }
  const kind = input.rebroadcast ? "p2pkh.rebroadcast-ancestors" : "p2pkh.broadcast";
  return handleP2pkhBroadcast(`test-p2pkh-broadcast-${Date.now()}`, {
    kind,
    clientId: "test",
    requestId: `test-p2pkh-broadcast-${Date.now()}`,
    ownerPublicKeyHex: input.ownerPublicKeyHex,
    network: input.network,
    submissionId: input.submissionId,
    expectedProviderGeneration: input.expectedProviderGeneration,
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
  storageRuntime = testStorageRuntimeOverride;
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
  if (enabled) { storageRuntime = undefined; storageRepository = undefined; }
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

/** MSFile 测试接缝：会话解析与 RPC 分发（施工单 docs/proposals/msfile）。 */
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
  run(context: { signal: AbortSignal; assertSessionFresh(): void }): Promise<void>;
}): void {
  const pluginId = input.pluginId ?? getCoordinatorWorkerUnitForTask(input.id)?.productId ?? "test";
  coordinatorState.taskRuntimes.set(input.id, createCoordinatorTaskRuntime({
    id: input.id,
    pluginId,
    unitId: input.unitId,
    allowUncataloguedForTest: true,
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

export async function __testRestartWorker(): Promise<void> {
  __testResetState();
  await ensureCoordinatorAuthorityClaim();
  await loadCoordinatorMeta();
  const meta = await getVaultMeta();
  coordinatorState.vaultStatus = meta ? "locked" : "uninitialized";
  coordinatorState.activePublicKeyHex = undefined;
  dropActivePrivateKey();
  if (meta && !await reconcileSelectedPublicKey()) coordinatorState.vaultStatus = "uninitialized";
}

// ============================================================
// 15. Backup Import Test Helpers
// ============================================================

/** 测试专用：删除 Vault 密钥材料。 */
export async function __testDeleteVault(): Promise<void> {
  try {
    // 删除所有 keys
    const keys = await vaultKeyRepository.listKeys();
    for (const key of keys) {
      await vaultKeyRepository.deleteKeyAndSidecars(key.publicKeyHex);
    }
    // 删除 meta
    await vaultKeyRepository.deleteMeta();
  } catch {
    // 忽略错误（可能数据库不存在）
  }
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

/** 测试专用：清空一个平台 K-V namespace，不连接浏览器持久化 API。 */
export async function __testClearPlatformNamespace(applicationStorageId: string): Promise<void> {
  ensureTestPlatformStorage();
  if (!platformRootStore) throw new Error("Test platform storage is not ready");
  const store = await platformRootStore.openPlatformStore({ applicationStorageId, schemaVersion: 1 });
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

/** 测试专用：直接通过一个 Worker owner K-V handle 验证当前 owner 可写。 */
export async function __testOwnerStoragePut(key: string, value: unknown): Promise<void> {
  const store = createWorkerOwnerStore("msfile", 1);
  try {
    await store.put(key, value, { partition: "transition-test" });
  } finally {
    store.close();
  }
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

/** Test-only facade for the worker's atomic key+sidecar deletion primitive. */
export async function __testDeleteKeyMaterial(publicKeyHex: string): Promise<void> {
  // 测试接缝也走与生产相同的 Journal + owner namespace 联合删除，
  // 只放宽“必须 unlocked”的 RPC 前置条件以覆盖 locked cold path。
  const key = await getPublicVaultKey(publicKeyHex);
  if (!key) throw new Error("Key not found");
  await executeKeyDeletion(publicKeyHex, key.label);
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

export async function __testAddPasskeyToCurrentKey(input: {
  label: string;
  credentialIdB64: string;
  prfSaltB64: string;
  prfOutputHex: string;
  rpId: string;
}): Promise<unknown> {
  const prepared = await executeVaultOperation({
    type: "prepareAddPasskeyToCurrentKey",
    label: input.label
  }) as { intentId: string };
  return executeVaultOperation({
    type: "addPasskeyToCurrentKey",
    intentId: prepared.intentId,
    credentialIdB64: input.credentialIdB64,
    prfSaltB64: input.prfSaltB64,
    prfOutputHex: input.prfOutputHex,
    rpId: input.rpId
  });
}

export async function __testRemovePasskeyFromCurrentKey(input: {
  passkeyId: string;
}): Promise<void> {
  await executeVaultOperation({ type: "removePasskeyFromCurrentKey", ...input });
}

export async function __testActivateKeyWithPasskey(input: {
  passkeyId: string;
  prfOutputHex: string;
}): Promise<void> {
  await executeVaultOperation({ type: "activateKeyWithPasskey", ...input });
}

export async function __testListPasskeysForKey(publicKeyHex: string): Promise<unknown[]> {
  const result = await executeVaultOperation({ type: "listPasskeysForKey", publicKeyHex });
  return result as unknown[];
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
