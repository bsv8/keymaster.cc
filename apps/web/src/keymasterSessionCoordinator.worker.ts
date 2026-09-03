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
//   - 只暴露 onconnect / MessagePort 协议
//   - Worker 重启后必为 locked，禁止恢复为 unlocked

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
  ActiveKeyCrypto,
} from "@keymaster/contracts";
import {
  MSFILE_MAX_BLOCK_BYTES,
  MSFILE_MAX_SEED_BYTES,
  MSFILE_READ_CONCURRENCY_RECOMMENDED,
  normalizeMsFileReadConcurrencySettings,
  SAT_SUBSCRIPTION_RESOURCE_LIMITS,
} from "@keymaster/contracts";
import { vaultDb, type VaultMetaRecord, type VaultKeyRecord, type KeyHoldVaultKeyRecord, deriveKey, verifyVerifier, hexToBytes as cryptoHexToBytes, base64ToBytes, bytesToHex, decryptBytesWithAad, encryptBytesWithAad, decryptBytesWithSaltBoundAad, encryptBytesWithSaltBoundAad, deriveP2pkhAddress, signEcdsaDigest, verifySessionKeyPair, encryptVerifier, buildVaultMeta, encryptBytes, decryptBytes, encryptMaterialWithPasskey, decryptMaterialWithPasskey, toPasskeySummary } from "@keymaster/plugin-vault/coordinator";
import { exportPrivateKey as keyholdExportPrivateKey, parse as keyholdParse, recommendedParameters as keyholdRecommendedParameters } from "keyhold";
// 不能通过 runtime barrel 导入：它 re-export React hooks，Vite 会把
// React Refresh 注入 SharedWorker，后者没有 window。
import { createMessageBus } from "@keymaster/runtime/messageBus";
import { createWocService, createWocBsv21Service, createWocStasService, createWoc1SatOrdinalsService, registerWocP2pkhProviders } from "@keymaster/plugin-woc/coordinator";
import { createJungleBusClient, registerJungleBusP2pkhProvider } from "@keymaster/plugin-junglebus/coordinator";
import { createP2pkhProviderRegistry, createP2pkhService, type P2pkhService } from "@keymaster/plugin-p2pkh/coordinator";
import { createP2pkhCoordinatorTasks, openP2pkhDb, createP2pkhDb } from "@keymaster/plugin-p2pkh/coordinator";
import { createBsv21CoordinatorTask } from "@keymaster/plugin-token-bsv21/coordinator";
import { createStasCoordinatorTask } from "@keymaster/plugin-token-stas/coordinator";
import { createOrdinalsCoordinatorTask } from "@keymaster/plugin-collectible-1satordinals/coordinator";
import { createContactsPresenceTask, createContactsService } from "@keymaster/plugin-contacts/coordinator";
import type { KeyspaceService, VaultService, WocService } from "@keymaster/contracts";
import type {
  StorageService,
  StorageServiceStatus,
  CoordinatorStorageControl,
  CoordinatorStorageData,
  CoordinatorStorageStateEvent,
  CoordinatorMsFileControl,
  CoordinatorMsFileData,
  CoordinatorMsFileStateEvent,
  MsFileConnectAppContext,
  MsFileErrorCode,
} from "@keymaster/contracts";
import { createStorageService, openStorageDb, STORAGE_SECRET_SCOPE } from "@keymaster/plugin-storage/coordinator";
// 施工单 docs/proposals/msfile：MSFile runtime 真值在 Coordinator SharedWorker。
// 001 架构 Spike 与 002 生产 Runtime 完成前 transport fail closed；之后由 Window executor 注入。
import {
  createMsFileService,
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
import { getConnectSession as getAuthoritativeConnectSession, isVerifiedAppIdentitySnapshot } from "@keymaster/plugin-protocol/coordinator";
import {
  createSatSubscriptionProvider,
  openSatSubscriptionDb,
  createSatSubscriptionState,
  createSatSpiService,
  type SatSubscriptionProvider,
  type SatSubscriptionStateStore,
  type SatSubscriptionDb,
  type SatSubscriptionTransport,
  type SatSupplierConnection,
  SatSubscriptionHandle,
  type SatP2pkhService,
} from "@keymaster/plugin-sat-subscription/coordinator";

// Vault DB 操作（Worker 内可直接访问 IndexedDB）
async function getVaultMeta(): Promise<VaultMetaRecord | undefined> {
  return vaultDb.getMeta();
}

async function getActiveKey(): Promise<VaultKeyRecord | undefined> {
  const selectedPublicKeyHex = coordinatorMeta.selectedPublicKeyHex;
  if (selectedPublicKeyHex) {
    const selected = await vaultDb.getKey(selectedPublicKeyHex);
    if (selected) return selected;
  }
  const keys = await vaultDb.listKeys();
  const first = keys[0];
  if (first) { coordinatorMeta.selectedPublicKeyHex = first.publicKeyHex; await persistCoordinatorMeta(); }
  return first;
}

/** Reconcile persisted selection from public key listings only. */
async function reconcileSelectedPublicKey(): Promise<boolean> {
  const activeKey = await getActiveKey();
  if (activeKey) return true;

  // Legacy versions could leave behind a password meta record without any
  // key material. That state can never produce an active session, so treat it
  // as a fresh Vault instead of exposing a locked "No active key" dead end.
  await vaultDb.deleteMeta();
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

function decodePersisted(value: string): Uint8Array {
  try { return cryptoHexToBytes(value); } catch { return base64ToBytes(value); }
}

interface CoordinatorMetaRecord {
  id: "singleton";
  selectedPublicKeyHex?: string;
  generation: number;
  scheduleSettings?: CoordinatorBackgroundSyncSettings;
  p2pkhProviders?: P2pkhProviderSettings;
  p2pkhProviderConfigs?: Record<string, Record<string, unknown>>;
  p2pkhSettings?: { includeTestnet: boolean };
}
const coordinatorMeta: CoordinatorMetaRecord = { id: "singleton", generation: 0, scheduleSettings: { assetHoldingsIntervalMs: 900_000 } };
const defaultP2pkhProviders = (): P2pkhProviderSettings => ({ main: { syncProviderId: "woc", broadcastProviderId: "woc" }, test: { syncProviderId: "woc", broadcastProviderId: "woc" }, generation: 0 });
let p2pkhRegistry: P2pkhProviderRegistry | undefined;
let p2pkhWocService: WocService | undefined;
let p2pkhJungleBusClient: ReturnType<typeof createJungleBusClient> | undefined;
let p2pkhProviderRevision = 0;
let testP2pkhBroadcastProvider: P2pkhTransactionBroadcastProvider | undefined;
let testPersistCoordinatorMetaFailure = false;
async function loadCoordinatorMeta(): Promise<void> {
  await new Promise<void>((resolve) => {
    const req = indexedDB.open("keymaster.session-coordinator", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("meta", { keyPath: "id" });
    req.onsuccess = () => { const db = req.result; const get = db.transaction("meta", "readonly").objectStore("meta").get("singleton"); get.onsuccess = () => { Object.assign(coordinatorMeta, get.result ?? {}); coordinatorMeta.p2pkhProviders ??= defaultP2pkhProviders(); coordinatorMeta.p2pkhSettings ??= { includeTestnet: false }; if (coordinatorMeta.scheduleSettings) coordinatorState.scheduleSettings = coordinatorMeta.scheduleSettings; resolve(); }; get.onerror = () => resolve(); };
    req.onerror = () => resolve();
  });
}
async function persistCoordinatorMetaValue(value: CoordinatorMetaRecord): Promise<void> {
  if (testPersistCoordinatorMetaFailure) {
    testPersistCoordinatorMetaFailure = false;
    throw new Error("injected coordinator meta persist failure");
  }
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open("keymaster.session-coordinator", 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains("meta")) req.result.createObjectStore("meta", { keyPath: "id" });
    };
    req.onsuccess = () => {
      let openedDb: IDBDatabase | undefined;
      try {
        const db = req.result;
        openedDb = db;
        const tx = db.transaction("meta", "readwrite");
        tx.objectStore("meta").put(value);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { const error = tx.error ?? new Error("Coordinator metadata persistence failed"); db.close(); reject(error); };
        tx.onabort = () => { const error = tx.error ?? new Error("Coordinator metadata persistence aborted"); db.close(); reject(error); };
      } catch (error) { openedDb?.close(); reject(error); }
    };
    req.onerror = () => reject(req.error ?? new Error("Coordinator metadata database unavailable"));
  });
}
async function persistCoordinatorMeta(): Promise<void> {
  await persistCoordinatorMetaValue(coordinatorMeta);
}

const STORAGE_DB_NAME = "keymaster.storage";
const STORAGE_DB_VERSION = 1;
const STORAGE_PROVIDER_SCOPE = "keymaster.storage.provider-config.v1";
const STORAGE_UPLOAD_SCOPE = "keymaster.storage.upload.v1/";
const STORAGE_SECRET_DERIVATION_DOMAIN = "keymaster.storage.local-secret.v2";

type StorageEnvelopeRecord = VaultSealedSecret;
type StorageProviderRecord = { key: "active"; sealedConfig: StorageEnvelopeRecord };
type StorageUploadRecord = { internalUploadId: string; sealedS3UploadId: StorageEnvelopeRecord };
type StorageRotationSnapshot = { provider?: StorageProviderRecord; uploads: StorageUploadRecord[] };
type StorageRotationJournal = { key: "rotation"; phase: "prepared" | "storage-committed"; old: StorageRotationSnapshot; next?: StorageRotationSnapshot };
let testStorageSessionResolver: ((sessionId: string) => Promise<{ sessionId: string; origin: string; ownerPublicKeyHex?: string; appIdentity: import("@keymaster/contracts").StorageAppContext["appIdentity"]; revokedAt: number | null } | null>) | undefined;

function isValidStorageIdentity(identity: unknown): identity is import("@keymaster/contracts").StorageAppContext["appIdentity"] {
  return isVerifiedAppIdentitySnapshot(identity);
}

async function readProtocolConnectSession(sessionId: string): Promise<{ sessionId: string; origin: string; ownerPublicKeyHex: string; appIdentity: import("@keymaster/contracts").StorageAppContext["appIdentity"]; revokedAt: number | null } | null> {
  if (testStorageSessionResolver) {
    const resolved = await testStorageSessionResolver(sessionId);
    return resolved && resolved.revokedAt === null && Boolean(resolved.sessionId && resolved.origin) && isValidStorageIdentity(resolved.appIdentity)
      ? { sessionId: resolved.sessionId, origin: resolved.origin, ownerPublicKeyHex: resolved.ownerPublicKeyHex ?? "", appIdentity: resolved.appIdentity, revokedAt: null }
      : null;
  }
  if (!sessionId || typeof indexedDB === "undefined") return null;
  const record = await getAuthoritativeConnectSession(sessionId);
  return record && isValidStorageIdentity(record.appIdentity)
    ? { sessionId: record.sessionId, origin: record.origin, ownerPublicKeyHex: record.ownerPublicKeyHex, appIdentity: record.appIdentity, revokedAt: null }
    : null;
}

function isStorageEnvelope(value: unknown): value is StorageEnvelopeRecord {
  if (!value || typeof value !== "object") return false;
  const envelope = value as Partial<StorageEnvelopeRecord>;
  return (envelope.version === 1 || envelope.version === 2)
    && typeof envelope.saltHex === "string"
    && typeof envelope.nonceHex === "string"
    && typeof envelope.ciphertextHex === "string";
}

function isStorageRotationSnapshot(value: unknown): value is StorageRotationSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<StorageRotationSnapshot>;
  const provider = snapshot.provider;
  const validProvider = provider === undefined
    || (typeof provider === "object" && provider !== null && provider.key === "active" && isStorageEnvelope(provider.sealedConfig));
  const uploads = snapshot.uploads;
  return validProvider
    && Array.isArray(uploads)
    && uploads.every((record) => Boolean(record)
      && typeof record === "object"
      && typeof (record as Partial<StorageUploadRecord>).internalUploadId === "string"
      && isStorageEnvelope((record as Partial<StorageUploadRecord>).sealedS3UploadId));
}

function isStorageRotationJournal(value: unknown): value is StorageRotationJournal {
  if (!value || typeof value !== "object") return false;
  const journal = value as Partial<StorageRotationJournal>;
  return journal.key === "rotation"
    && (journal.phase === "prepared" || journal.phase === "storage-committed")
    && isStorageRotationSnapshot(journal.old)
    && (journal.next === undefined || isStorageRotationSnapshot(journal.next));
}

function openExistingStorageDb(): Promise<IDBDatabase | undefined> {
  return new Promise((resolve) => {
    const request = indexedDB.open(STORAGE_DB_NAME, STORAGE_DB_VERSION);
    let created = false;
    request.onupgradeneeded = (event) => {
      created = (event as IDBVersionChangeEvent).oldVersion === 0;
      if (created) request.transaction?.abort();
    };
    request.onsuccess = () => {
      if (created) { request.result.close(); resolve(undefined); return; }
      resolve(request.result);
    };
    request.onerror = () => resolve(undefined);
  });
}

function localSecretAad(version: 1 | 2, scope: string): string {
  return `keymaster:local-secret:v${version}|${scope}`;
}

async function deriveStorageSecretKey(password: string, vaultSalt: Uint8Array): Promise<CryptoKey> {
  // A separately domain-separated PBKDF2 invocation prevents local Storage
  // envelopes from becoming another direct use of the Vault key, while the
  // Vault salt still gives this derivation the same password-rotation anchor.
  return deriveKey(`${STORAGE_SECRET_DERIVATION_DOMAIN}\0${password}`, vaultSalt);
}

async function decryptStoredLocalSecret(key: CryptoKey, scope: string, sealed: StorageEnvelopeRecord, legacyKey?: CryptoKey): Promise<Uint8Array> {
  const blob = { salt: cryptoHexToBytes(sealed.saltHex), iv: cryptoHexToBytes(sealed.nonceHex), ciphertext: cryptoHexToBytes(sealed.ciphertextHex) };
  try {
    return sealed.version === 2
      ? await decryptBytesWithSaltBoundAad(key, blob, localSecretAad(2, scope))
      : await decryptBytesWithAad(key, blob, localSecretAad(1, scope));
  } catch (error) {
    // v1/v2 records written before the domain key was introduced used the
    // Vault password key. Keep a one-time migration path for those records.
    if (!legacyKey) throw error;
    return sealed.version === 2
      ? decryptBytesWithSaltBoundAad(legacyKey, blob, localSecretAad(2, scope))
      : decryptBytesWithAad(legacyKey, blob, localSecretAad(1, scope));
  }
}

async function encryptStoredLocalSecret(key: CryptoKey, scope: string, plaintext: Uint8Array): Promise<StorageEnvelopeRecord> {
  const blob = await encryptBytesWithSaltBoundAad(key, plaintext, localSecretAad(2, scope));
  return { version: 2, saltHex: bytesToHex(blob.salt), nonceHex: bytesToHex(blob.iv), ciphertextHex: bytesToHex(blob.ciphertext) };
}

async function storageSnapshotCanOpen(snapshot: StorageRotationSnapshot, key: CryptoKey, legacyKey?: CryptoKey): Promise<boolean> {
  try {
    if (snapshot.provider?.sealedConfig) {
      const bytes = await decryptStoredLocalSecret(key, STORAGE_PROVIDER_SCOPE, snapshot.provider.sealedConfig, legacyKey);
      bytes.fill(0);
    }
    for (const record of snapshot.uploads) {
      const bytes = await decryptStoredLocalSecret(key, `${STORAGE_UPLOAD_SCOPE}${record.internalUploadId}`, record.sealedS3UploadId, legacyKey);
      bytes.fill(0);
    }
    return true;
  } catch {
    return false;
  }
}

function storageDbTransaction(db: IDBDatabase, mode: IDBTransactionMode, callback: (stores: { provider: IDBObjectStore; uploads: IDBObjectStore }) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction | undefined;
    try {
      transaction = db.transaction(["providerConfig", "multipartUploads"], mode);
      callback({ provider: transaction.objectStore("providerConfig"), uploads: transaction.objectStore("multipartUploads") });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction?.error ?? new Error("Storage transaction failed"));
      transaction.onabort = () => reject(transaction?.error ?? new Error("Storage transaction aborted"));
    } catch (error) {
      try { transaction?.abort(); } catch { /* preserve the original callback error */ }
      reject(error);
    }
  });
}

function clearStorageRotationJournal(db: IDBDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction("providerConfig", "readwrite");
      tx.objectStore("providerConfig").delete("rotation");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Storage rotation journal cleanup failed"));
      tx.onabort = () => reject(tx.error ?? new Error("Storage rotation journal cleanup aborted"));
    } catch (error) {
      reject(error);
    }
  });
}

async function recoverStorageRotation(storageKey: CryptoKey, legacyVaultKey: CryptoKey): Promise<void> {
  const db = await openExistingStorageDb();
  if (!db) return;
  try {
    const rawJournal = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction("providerConfig", "readonly");
      const request = tx.objectStore("providerConfig").get("rotation");
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
    });
    if (!rawJournal) return;
    if (!isStorageRotationJournal(rawJournal)) throw new Error("Storage rotation journal is corrupt");
    const journal = rawJournal;
    const current = await new Promise<StorageRotationSnapshot>((resolve, reject) => {
      const tx = db.transaction(["providerConfig", "multipartUploads"], "readonly");
      const provider = tx.objectStore("providerConfig").get("active");
      const uploads = tx.objectStore("multipartUploads").getAll();
      tx.oncomplete = () => resolve({ provider: provider.result as StorageProviderRecord | undefined, uploads: (uploads.result as StorageUploadRecord[]) ?? [] });
      tx.onerror = () => reject(tx.error);
    });
    if (await storageSnapshotCanOpen(current, storageKey, legacyVaultKey)) {
      // The Vault commit either did not happen (prepared journal) or this is
      // the new password after a completed Vault commit. Current ciphertext is
      // therefore already consistent; only the journal needs retiring.
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("providerConfig", "readwrite");
        tx.objectStore("providerConfig").delete("rotation");
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
      });
      return;
    }
    if (!(await storageSnapshotCanOpen(journal.old, storageKey, legacyVaultKey))) {
      // Storage is optional, so an unreadable snapshot must not block Vault
      // unlock. Keep the journal, however: it is still the only evidence that
      // may make a later retry/recovery possible after a transient key/session
      // mismatch or a repaired record.
      return;
    }
    await storageDbTransaction(db, "readwrite", ({ provider, uploads }) => {
      provider.delete("active");
      if (journal.old.provider) provider.put(journal.old.provider);
      for (const record of current.uploads) uploads.delete(record.internalUploadId);
      for (const record of journal.old.uploads) uploads.put(record);
      provider.delete("rotation");
    });
  } catch {
    // Recovery is compensating Storage maintenance, not part of Vault
    // authentication. A malformed/corrupt optional record must never make a
    // valid Vault password fail to unlock. Preserve the journal on every
    // read/write failure; deleting it would destroy the only rollback proof.
  } finally {
    db.close();
  }
}

/**
 * Restore the snapshot captured by the first migration attempt. This is a
 * compensating transaction, not another migration: it must never call
 * prepareStorageRotation() or replace the journal's original `old` snapshot.
 */
async function rollbackStorageRotation(): Promise<void> {
  const db = await openExistingStorageDb();
  if (!db) return;
  try {
    const rawJournal = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction("providerConfig", "readonly");
      const request = tx.objectStore("providerConfig").get("rotation");
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
    });
    if (!rawJournal) throw new Error("Storage rotation journal is missing");
    if (!isStorageRotationJournal(rawJournal)) throw new Error("Storage rotation journal is corrupt");
    const journal = rawJournal;
    await storageDbTransaction(db, "readwrite", ({ provider, uploads }) => {
      provider.delete("active");
      if (journal.old.provider) provider.put(journal.old.provider);
      uploads.clear();
      for (const record of journal.old.uploads) uploads.put(record);
      provider.delete("rotation");
    });
  } finally {
    db.close();
  }
}

/**
 * Take the Storage snapshot and publish the rotation barrier in one
 * IndexedDB transaction. StorageDb write transactions use the same object
 * stores and reject once this barrier exists, so a caller that sealed with
 * the old key cannot commit a late record after the snapshot.
 */
async function prepareStorageRotation(db: IDBDatabase): Promise<StorageRotationSnapshot> {
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(["providerConfig", "multipartUploads"], "readwrite");
      const providerStore = tx.objectStore("providerConfig");
      const provider = providerStore.get("active");
      const existingRotation = providerStore.get("rotation");
      const uploads = tx.objectStore("multipartUploads").getAll();
      let providerDone = false;
      let uploadsDone = false;
      let rotationDone = false;
      let preparationError: Error | undefined;
      let snapshot: StorageRotationSnapshot | undefined;
      const publishBarrier = () => {
        if (!providerDone || !uploadsDone || !rotationDone || snapshot || preparationError) return;
        snapshot = {
          provider: provider.result as StorageProviderRecord | undefined,
          uploads: (uploads.result as StorageUploadRecord[]) ?? []
        };
        providerStore.put({ key: "rotation", phase: "prepared", old: snapshot });
      };
      provider.onsuccess = () => { providerDone = true; publishBarrier(); };
      uploads.onsuccess = () => { uploadsDone = true; publishBarrier(); };
      existingRotation.onsuccess = () => {
        if (existingRotation.result) {
          preparationError = new Error("Storage password rotation is already in progress");
          tx.abort();
          return;
        }
        rotationDone = true;
        publishBarrier();
      };
      tx.oncomplete = () => {
        if (snapshot) resolve(snapshot);
        else reject(preparationError ?? new Error("Storage rotation snapshot was not prepared"));
      };
      tx.onerror = () => reject(tx.error ?? new Error("Storage rotation snapshot failed"));
      tx.onabort = () => reject(preparationError ?? tx.error ?? new Error("Storage rotation snapshot aborted"));
    } catch (error) {
      reject(error);
    }
  });
}

/** Re-wrap every Storage-owned sealed value before changing the Vault password. */
async function migrateStorageSecrets(oldStorageKey: CryptoKey, newStorageKey: CryptoKey, legacyVaultKey?: CryptoKey): Promise<void> {
  const db = await openExistingStorageDb();
  if (!db) return;
  let barrierPrepared = false;
  try {
    const oldSnapshot = await prepareStorageRotation(db);
    barrierPrepared = true;
    const records = oldSnapshot;
    let providerSealed: StorageEnvelopeRecord | undefined;
    if (records.provider?.sealedConfig) {
      const bytes = await decryptStoredLocalSecret(oldStorageKey, STORAGE_PROVIDER_SCOPE, records.provider.sealedConfig, legacyVaultKey);
      try { providerSealed = await encryptStoredLocalSecret(newStorageKey, STORAGE_PROVIDER_SCOPE, bytes); } finally { bytes.fill(0); }
    }
    const uploadSealed = new Map<string, StorageEnvelopeRecord>();
    for (const record of records.uploads) {
      const bytes = await decryptStoredLocalSecret(oldStorageKey, `${STORAGE_UPLOAD_SCOPE}${record.internalUploadId}`, record.sealedS3UploadId, legacyVaultKey);
      try { uploadSealed.set(record.internalUploadId, await encryptStoredLocalSecret(newStorageKey, `${STORAGE_UPLOAD_SCOPE}${record.internalUploadId}`, bytes)); } finally { bytes.fill(0); }
    }
    const nextSnapshot: StorageRotationSnapshot = {
      provider: providerSealed && records.provider ? { ...records.provider, sealedConfig: providerSealed } : records.provider,
      uploads: records.uploads.map((record) => ({ ...record, sealedS3UploadId: uploadSealed.get(record.internalUploadId) ?? record.sealedS3UploadId }))
    };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["providerConfig", "multipartUploads"], "readwrite");
      if (providerSealed && records.provider) tx.objectStore("providerConfig").put({ ...records.provider, sealedConfig: providerSealed });
      for (const record of records.uploads) {
        const sealed = uploadSealed.get(record.internalUploadId);
        if (sealed) tx.objectStore("multipartUploads").put({ ...record, sealedS3UploadId: sealed });
      }
      tx.objectStore("providerConfig").put({ key: "rotation", phase: "storage-committed", old: oldSnapshot, next: nextSnapshot } satisfies StorageRotationJournal);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch (error) {
    // All ciphertext rewrites are prepared in memory and committed in one
    // IndexedDB transaction. If decryption or the commit fails, retain the
    // old records and remove the barrier immediately; otherwise the next
    // unlock would attempt recovery and could lock out the whole Vault.
    if (barrierPrepared) await clearStorageRotationJournal(db).catch(() => undefined);
    throw error;
  } finally {
    db.close();
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
        // 本地联系人 DB 暂不可读时，安全降级为空快照（全部 offline）。
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
  publishTopicEvent("session.state", {
    type: "session.state.changed",
    cause,
    vaultStatus: coordinatorState.vaultStatus,
    activePublicKeyHex: coordinatorState.vaultStatus === "unlocked" ? coordinatorState.activePublicKeyHex ?? null : null,
    selectedPublicKeyHex: coordinatorMeta.selectedPublicKeyHex ?? null,
    keyspaceGeneration: coordinatorState.keyspaceGeneration,
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
  passwordKey?: CryptoKey;
  password?: string;
  storageSecretKey?: CryptoKey;
  keyspaceGeneration: number;
  taskRuntimes: Map<string, TaskRuntime>;
  scheduleSettings: CoordinatorBackgroundSyncSettings;
  autoLockDeadline?: number;
  lastActivityAt: number;
}

let storageRuntime: StorageService | undefined;
let storageDb: Awaited<ReturnType<typeof openStorageDb>> | undefined;
// Test-only seams keep worker ownership/dispatch tests independent from S3 and IDB.
let testStorageRuntimeOverride: StorageService | undefined;
let testStorageStartupFailure = false;
let storageStartupFailure = false;
const storageLifecycleListeners = new Set<(snapshot: { status: "unlocked" | "locked" | "uninitialized" }) => void>();
let storageRevision = 0;
let msfileRevision = 0;
let lastStorageState: CoordinatorStorageStateEvent | undefined;
let storageStateTail: Promise<void> = Promise.resolve();
const storageRequests = new Map<string, { controller: AbortController; clientId: string; connectSessionId?: string }>();
const storageRequestKey = (clientId: string, requestId: string): string => `${clientId}\u0000${requestId}`;
const storagePortCounts = new Map<string, number>();
const storageGrants = new Map<string, { context: import("@keymaster/contracts").StorageAppContext; clientId: string; sessionEpoch: SessionEpoch }>();
let storageMutationTail: Promise<void> = Promise.resolve();
let storageDataActive = 0;
type StorageDataWaiter = { resolve: () => void; reject: (error: Error) => void; signal?: AbortSignal; active: boolean; clientId: string };
const storageDataWaiters: StorageDataWaiter[] = [];
const STORAGE_DATA_CONCURRENCY = 4;
const STORAGE_DATA_MAX_QUEUE = 64;
const STORAGE_DATA_MAX_PER_PORT = 16;
const STORAGE_DATA_MAX_ACTIVE_PER_PORT = STORAGE_DATA_CONCURRENCY - 1;
const storageDataActiveByPort = new Map<string, number>();

/* ---------- MSFile runtime state（施工单 KMMF-005/006） ---------- */
let msfileRuntime: MsFileServiceImpl | undefined;
let lastMsFileState: CoordinatorMsFileStateEvent | undefined;

/* ---------- SatSubscription runtime（唯一 owner：SharedWorker） ---------- */
const SAT_WINDOW_LANE_ID = "sat-subscription";
interface SatWorkerRuntimeState {
  ownerPublicKeyHex: string;
  ownerGeneration: number;
  db: SatSubscriptionDb;
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

async function ensureMsfileRuntime(): Promise<MsFileServiceImpl> {
  // 审查修复：锁定 / 未初始化 / fatal 状态不得创建 MSFile runtime。
  if (coordinatorState.vaultStatus !== "unlocked") {
    throw msfileError("msfile_unavailable", "MSFile requires an unlocked Vault");
  }
  if (msfileRuntime) return msfileRuntime;
  const service = createMsFileService({
    transport: windowP2pExecutorTransport,
    notifyStateChange: (_state: MsFileServiceEventState) => emitMsFileState()
  });
  // 服务构造是同步的；DB 打开在内部异步完成，首个 control 调用会等待。
  msfileRuntime = service;
  emitMsFileState();
  return msfileRuntime;
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

async function ensureSatRuntime(): Promise<SatWorkerRuntimeState> {
  if (coordinatorState.vaultStatus !== "unlocked" || !coordinatorState.activePublicKeyHex) {
    throw new Error("SatSubscription requires an unlocked active key");
  }
  // owner 切换/锁定的退订和连接关闭必须完成后，才能把任何请求交给
  // 新 runtime；否则旧 owner 的清理可能和新 owner 的收费请求并发。
  await satRuntimeRelease.catch(() => undefined);
  if (coordinatorState.vaultStatus !== "unlocked" || !coordinatorState.activePublicKeyHex) {
    throw new Error("SatSubscription owner is no longer unlocked");
  }
  if (satRuntime) return satRuntime;
  if (satRuntimeStarting) {
    const pending = satRuntimeStarting;
    if (satRuntimeStartingToken === satRuntimeStartToken) return pending;
    // lock/key switch 已使旧启动失效；等待它完成清理后再创建新世代，
    // 避免两个世代同时拥有 Supplier 连接。
    await pending.catch(() => undefined);
    if (satRuntime) return satRuntime;
  }
  const ownerPublicKeyHex = coordinatorState.activePublicKeyHex;
  const ownerGeneration = Math.max(1, coordinatorState.keyspaceGeneration);
  const expectedSessionEpoch = coordinatorState.sessionEpoch;
  const startToken = satRuntimeStartToken;
  const startAbortController = new AbortController();
  satRuntimeStartAbortController = startAbortController;
  const start = (async (): Promise<SatWorkerRuntimeState> => {
    const keyspace = createWorkerKeyspace();
    const db = await openSatSubscriptionDb({ keyspace, publicKeyHex: ownerPublicKeyHex });
    let provider: ReturnType<typeof createSatSubscriptionProvider> | undefined;
    let handle: SatSubscriptionHandle | undefined;
    try {
      const loaded = await db.load();
      const initial = {
        ...loaded,
        ownerSettings: loaded.ownerSettings ?? {
          ownerPublicKeyHex,
          defaultPublishSupplierId: null,
          receiveSupplierIds: [],
        },
      };
      const state = createSatSubscriptionState({ ownerPublicKeyHex, initial, persistence: db });
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
        if (startToken !== satRuntimeStartToken || coordinatorState.vaultStatus !== "unlocked" || coordinatorState.sessionEpoch !== expectedSessionEpoch || coordinatorState.activePublicKeyHex !== ownerPublicKeyHex) {
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
        deriveMainAddress: async (requestedOwner) => {
          if (requestedOwner !== ownerPublicKeyHex || coordinatorState.activePublicKeyHex !== ownerPublicKeyHex) throw new Error("SPI owner changed before address derivation");
          const result = await executeCryptoOperation({ type: "deriveP2pkhAddress", network: "main" }, privateKeyForSigner());
          if (result.type !== "deriveP2pkhAddress") throw new Error("Failed to derive the owner payment address");
          return result.address;
        },
      });
      if (!service || !admin) throw new Error("SatSubscription provider did not expose its trusted services");
      const runtime: SatWorkerRuntimeState = {
        ownerPublicKeyHex,
        ownerGeneration,
        db,
        state,
        provider: boundProvider,
        handle,
        admin,
        service,
        spi,
        offIncoming: service.subscribeEvents((event) => handleIncomingChannelPublish(event)),
      };
      assertFresh();
      satRuntime = runtime;
      return runtime;
    } catch (error) {
      try { handle?.close(); } catch { /* stale start cleanup */ }
      await provider?.shutdown().catch(() => undefined);
      db.close();
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

async function releaseSatRuntime(reason: string): Promise<void> {
  // 多次 lock/key-switch 可能同时到达；清理任务排队执行，后一个 owner
  // 永远不会越过前一个 owner 的物理退订和连接关闭。
  const previousRelease = satRuntimeRelease;
  satRuntimeStartToken += 1;
  satRuntimeStartAbortController?.abort(new Error(`Sat runtime released: ${reason}`));
  satRuntimeStartAbortController = undefined;
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
  channelSubscriptionMux = undefined;
  channelMuxOwnerPublicKeyHex = undefined;
  channelSubscriptionMuxGeneration += 1;
  // 不把旧 starting promise 丢掉；下面会等待它自然完成并自行清理。
  channelSubscriptionMuxStarting = undefined;
  channelSubscriptionMuxStartOwner = undefined;
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
    // 每一步都有上限：远端 Supplier 永不返回时，清理转为 owner DB 中的
    // 待退订证据，不能拖延锁屏或阻止后续 owner 建立会话。
    const startedRuntime = runtime ?? await awaitSatCleanup(runtimeStarting ?? Promise.resolve(undefined), "stale runtime start");
    if (startedRuntime) {
      await awaitSatCleanup(startedRuntime.handle.preparePhysicalCleanup(), "persist physical cleanup intent");
    }
    const startedMux = await awaitSatCleanup(muxStarting ?? Promise.resolve(undefined), "stale mux start");
    const muxToRelease = mux ?? startedMux;
    if (muxToRelease) {
      try {
        await awaitSatCleanup(muxToRelease.clear(), "old owner physical cleanup");
      } finally {
        // clear 超时后也必须取消旧 Mux 的退避重试，避免它在新 owner
        // Runtime 建立后继续调用旧连接。
        muxToRelease.dispose();
      }
    }
    await awaitSatCleanup(p2pkhStarting ?? Promise.resolve(undefined), "stale P2PKH start");
    if (startedRuntime) {
      try { startedRuntime.offIncoming(); } catch { /* ignore */ }
      try { startedRuntime.handle.close(); } catch { /* ignore */ }
      await awaitSatCleanup(startedRuntime.provider.shutdown(), "Sat provider shutdown");
      startedRuntime.db.close();
    }
  });
  satRuntimeRelease = cleanup.catch((error) => {
    console.warn("[sat-subscription] runtime cleanup failed", error instanceof Error ? error.message : String(error));
  });
  await cleanup;
}

function releaseMsfileRuntime(_reason: string): void {
  for (const pending of msfileRequests.values()) pending.controller.abort();
  msfileRequests.clear();
  for (const pending of windowP2pExecutorIdentityRequests.values()) pending.controller.abort();
  windowP2pExecutorIdentityRequests.clear();
  msfileGrants.clear();
  (msfileRuntime as unknown as { dispose?: () => void } | undefined)?.dispose?.();
  msfileRuntime = undefined;
  lastMsFileState = undefined;
}

function storageCoordinatorError(code: "storage_limit_exceeded" | "storage_unavailable"): Error & { code: typeof code } {
  const error = new Error(code) as Error & { code: typeof code };
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
    const summary = await (storageRuntime?.getProviderSummary().catch(() => null) ?? Promise.resolve(null));
    const revision = storageRevision + 1;
    const state: CoordinatorStorageStateEvent = {
      topic: "storage.state", type: "storage.state.changed", storageRevision: revision,
      sessionEpoch: coordinatorState.sessionEpoch,
      providerGeneration: summary?.generation ?? null,
      status: storageStartupFailure ? "degraded" : storageRuntime?.status() ?? (coordinatorState.vaultStatus === "unlocked" ? "unconfigured" : "locked"),
      summary,
      capabilities: storageRuntime?.getConditionalCapabilities() ?? null,
    };
    lastStorageState = state;
    storageRevision = revision;
    publishTopicEvent("storage.state", state);
  }, () => undefined);
}

function notifyStorageLifecycle(status: "unlocked" | "locked" | "uninitialized"): void {
  for (const listener of storageLifecycleListeners) listener({ status });
}

function pumpStorageDataWaiters(): void {
  while (storageDataActive < STORAGE_DATA_CONCURRENCY && storageDataWaiters.length) {
    let index = storageDataWaiters.findIndex((waiter) => (storageDataActiveByPort.get(waiter.clientId) ?? 0) < STORAGE_DATA_MAX_ACTIVE_PER_PORT);
    if (index < 0) index = 0; // no competing port: do not strand a single client
    const waiter = storageDataWaiters.splice(index, 1)[0]!;
    if (!waiter.active || waiter.signal?.aborted) continue;
    waiter.active = false;
    storageDataActive += 1;
    storageDataActiveByPort.set(waiter.clientId, (storageDataActiveByPort.get(waiter.clientId) ?? 0) + 1);
    waiter.resolve();
  }
}

async function withStorageDataSlot<T>(clientId: string, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (storageDataActive >= STORAGE_DATA_CONCURRENCY || (storageDataActiveByPort.get(clientId) ?? 0) >= STORAGE_DATA_MAX_ACTIVE_PER_PORT) {
    if (storageDataWaiters.length >= STORAGE_DATA_MAX_QUEUE) throw storageCoordinatorError("storage_limit_exceeded");
    await new Promise<void>((resolve, reject) => {
      const waiter: StorageDataWaiter = { resolve, reject, signal, active: true, clientId };
      const abort = () => {
        if (!waiter.active) return;
        waiter.active = false;
        const index = storageDataWaiters.indexOf(waiter);
        if (index >= 0) storageDataWaiters.splice(index, 1);
        reject(storageCoordinatorError("storage_unavailable"));
      };
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener("abort", abort, { once: true });
      storageDataWaiters.push(waiter);
    });
  } else {
    storageDataActive += 1;
    storageDataActiveByPort.set(clientId, (storageDataActiveByPort.get(clientId) ?? 0) + 1);
  }
  const operation = run();
  operation.catch(() => undefined);
  let onAbort: (() => void) | undefined;
  try {
    if (!signal) return await operation;
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(storageCoordinatorError("storage_unavailable"));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    return await Promise.race([operation, cancelled]);
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    storageDataActive -= 1;
    const nextPort = Math.max(0, (storageDataActiveByPort.get(clientId) ?? 1) - 1);
    if (nextPort) storageDataActiveByPort.set(clientId, nextPort); else storageDataActiveByPort.delete(clientId);
    pumpStorageDataWaiters();
  }
}

async function ensureStorageRuntime(): Promise<StorageService> {
  if (storageRuntime) return storageRuntime;
  if (testStorageRuntimeOverride) { storageRuntime = testStorageRuntimeOverride; return storageRuntime; }
  if (testStorageStartupFailure) { storageStartupFailure = true; emitStorageState(); throw storageCoordinatorError("storage_unavailable"); }
  const startupError = (error: unknown): never => {
    storageStartupFailure = true;
    emitStorageState();
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
    if (typeof code === "string" && code.startsWith("storage_")) throw error;
    throw storageCoordinatorError("storage_unavailable");
  };
  try { storageDb ??= await openStorageDb(); } catch (error) { startupError(error); }
  const db = storageDb;
  if (!db) return startupError(new Error("Storage database is unavailable"));
  const vaultAdapter = {
    status: () => (coordinatorState.vaultStatus === "fatal" ? "locked" : coordinatorState.vaultStatus),
    onLifecycleChange(listener: (snapshot: any) => void) {
      const wrapped = (snapshot: { status: "unlocked" | "locked" | "uninitialized" }) => listener(snapshot);
      storageLifecycleListeners.add(wrapped); return () => { storageLifecycleListeners.delete(wrapped); };
    }
  };
  const secret = {
    async seal(scope: string, plaintext: Uint8Array): Promise<VaultSealedSecret> {
      const key = coordinatorState.storageSecretKey; if (!key) throw new Error("Vault is locked");
      const blob = await encryptBytesWithSaltBoundAad(key, plaintext, localSecretAad(2, scope));
      return { version: 2, saltHex: bytesToHex(blob.salt), nonceHex: bytesToHex(blob.iv), ciphertextHex: bytesToHex(blob.ciphertext) };
    },
    async open(scope: string, sealed: VaultSealedSecret): Promise<Uint8Array> {
      const key = coordinatorState.storageSecretKey; if (!key) throw new Error("Vault is locked");
      return sealed.version === 2
        ? decryptBytesWithSaltBoundAad(key, { salt: cryptoHexToBytes(sealed.saltHex), iv: cryptoHexToBytes(sealed.nonceHex), ciphertext: cryptoHexToBytes(sealed.ciphertextHex) }, localSecretAad(2, scope))
        : decryptBytesWithAad(key, { salt: cryptoHexToBytes(sealed.saltHex), iv: cryptoHexToBytes(sealed.nonceHex), ciphertext: cryptoHexToBytes(sealed.ciphertextHex) }, localSecretAad(1, scope));
    }
  };
  let runtime: StorageService;
  try {
    runtime = await createStorageService({ db, secret, vault: vaultAdapter, logger: { warn: (event) => undefined } });
  } catch (error) {
    startupError(error);
  }
  storageRuntime = runtime!;
  storageStartupFailure = false;
  storageRuntime.subscribe(emitStorageState);
  emitStorageState();
  return storageRuntime;
}

function abortStorageRequests(): void {
  for (const request of storageRequests.values()) request.controller.abort();
  storageRequests.clear();
}

async function releaseStorageRuntime(reason: string): Promise<void> {
  abortStorageRequests();
  storageGrants.clear();
  // StorageServiceImpl's dispose aborts its request controller and destroys the
  // S3 client without waiting for remote multipart cleanup.
  (storageRuntime as (StorageService & { dispose?: () => void }) | undefined)?.dispose?.();
  storageRuntime = undefined;
  storageDb = undefined;
  notifyStorageLifecycle(coordinatorState.vaultStatus === "uninitialized" ? "uninitialized" : "locked");
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

interface ConnectedPort {
  port: MessagePort;
  clientId: string;
  subscriptions: Set<CoordinatorTopic>;
  lastSeenAt: number;
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

const connectedPorts = new Map<string, ConnectedPort>();
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
let lastContactsPresenceState: CoordinatorContactsPresenceEvent | undefined;
let contactsPresencePublishTail: Promise<void> = Promise.resolve();
function resolveKeyScope(runtime: TaskRuntime): { publicKeyHex: string; label?: string } | undefined { return typeof runtime.keyScope === "function" ? runtime.keyScope() : runtime.keyScope; }
function scheduleRuntime(runtime: TaskRuntime): void { if (!runtime.intervalMs) return; if (runtime.timer) clearTimeout(runtime.timer); runtime.nextRunAt = new Date(Date.now() + runtime.intervalMs).toISOString(); runtime.timer = setTimeout(() => { runtime.timer = undefined; void executeTask(runtime.id, "interval"); }, runtime.intervalMs); }
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
  passwordKey: CryptoKey,
  storageSecretKey: CryptoKey,
  activePublicKeyHex: string,
  activePrivateKeyBytes: Uint8Array,
  cause: SessionStateEvent["cause"]
): Promise<void> {
  const previous = {
    vaultStatus: coordinatorState.vaultStatus,
    sessionEpoch: coordinatorState.sessionEpoch,
    activePublicKeyHex: coordinatorState.activePublicKeyHex,
    activePrivateKeyBytes: coordinatorState.activePrivateKeyBytes,
    passwordKey: coordinatorState.passwordKey,
    password: coordinatorState.password,
    storageSecretKey: coordinatorState.storageSecretKey,
    selectedPublicKeyHex: coordinatorMeta.selectedPublicKeyHex,
    generation: coordinatorMeta.generation
  };
  const changesUnlockedActiveKey = previous.vaultStatus === "unlocked"
    && previous.activePublicKeyHex !== undefined
    && previous.activePublicKeyHex !== activePublicKeyHex;
  try {
    // 在 coordinatorState 暴露新 owner 之前完成旧 owner 的 runtime 清理，
    // 这样旧 Supplier/私钥上下文不会被 B owner 的请求观察到。
    if (changesUnlockedActiveKey) {
      releaseMsfileRuntime("activate-key");
      await releaseSatRuntime("activate-key");
      clearWindowP2pExecutorLeaseLocked();
    }
    // 旧 owner runtime 已经在上面完成清理；现在才把新 owner 放入会话状态。
    // metadata 写入失败时仍恢复旧会话状态，调用方继续拥有入参私钥 buffer。
    coordinatorState.vaultStatus = "unlocked";
    coordinatorState.sessionEpoch = generateEpoch();
    passkeyAddIntents.clear();
    coordinatorState.activePublicKeyHex = activePublicKeyHex;
    coordinatorState.passwordKey = passwordKey;
    coordinatorState.password = coordinatorState.password ?? "";
    coordinatorState.storageSecretKey = storageSecretKey;
    coordinatorMeta.selectedPublicKeyHex = activePublicKeyHex;
    coordinatorMeta.generation = coordinatorState.keyspaceGeneration;
    await persistCoordinatorMeta();
    replaceActivePrivateKey(activePrivateKeyBytes);
  } catch (error) {
    coordinatorState.vaultStatus = previous.vaultStatus;
    coordinatorState.sessionEpoch = previous.sessionEpoch;
    coordinatorState.activePublicKeyHex = previous.activePublicKeyHex;
    coordinatorState.activePrivateKeyBytes = previous.activePrivateKeyBytes;
    coordinatorState.passwordKey = previous.passwordKey;
    coordinatorState.password = previous.password;
    coordinatorState.storageSecretKey = previous.storageSecretKey;
    coordinatorMeta.selectedPublicKeyHex = previous.selectedPublicKeyHex;
    coordinatorMeta.generation = previous.generation;
    throw error;
  }
  notifyStorageLifecycle("unlocked");
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
  // 连接/供应商暂不可用时只记录诊断；owner 的订阅意图仍留在 Sat DB/Mux，
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
  const storageName = (key: string, pluginId: string, storageId: string) => `keymaster.key.${key}.plugin.${pluginId}.${storageId}`;
  return {
    listKeys: async () => (await vaultDb.listKeys()).map((key) => ({ publicKeyHex: key.publicKeyHex, label: key.label, capabilities: key.capabilities, createdAt: key.createdAt })),
    getKey: async (publicKeyHex) => { const key = await vaultDb.getKey(publicKeyHex); return key ? { publicKeyHex: key.publicKeyHex, label: key.label, capabilities: key.capabilities, createdAt: key.createdAt } : undefined; },
    active,
    selected: () => coordinatorMeta.selectedPublicKeyHex,
    setActive: async (publicKeyHex) => { await executeVaultOperation({ type: "setActive", publicKeyHex }); },
    requireActiveKey: () => { if (!coordinatorState.activePublicKeyHex) throw new Error("No active key"); return { publicKeyHex: coordinatorState.activePublicKeyHex, label: "", capabilities: ["p2pkh"], createdAt: "" }; },
    onActiveKeyChanged: () => () => undefined,
    openKeyStorage: async (input) => { const name = storageName(input.publicKeyHex, input.pluginId, input.storageId); const db = await new Promise<IDBDatabase>((resolve, reject) => { const req = indexedDB.open(name, input.version); req.onupgradeneeded = (event) => input.upgrade(req.result, (event as IDBVersionChangeEvent).oldVersion, input.version, req.transaction ?? undefined); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); return { db, name, close: () => db.close() }; },
    registerPluginStorage: () => undefined,
    listPluginStorages: () => [],
    prepareDeleteKey: async () => undefined,
    // Deletion is coordinated by the application keyspace facade so that
    // namespace cleanup and password verification cannot be bypassed.
    deleteKey: async () => { throw new Error("Use the coordinator keyspace deletion flow"); },
    isInitializing: () => false,
    onInitializationChange: () => () => undefined
  };
}

/**
 * 为 P2PKH service 提供 Worker 内的 active-key capability。
 *
 * 这里没有把 private key 放进返回值；返回的 capability 只闭包引用
 * Coordinator 当前的私钥缓冲，并且每次签名/派生前重新校验 owner 与
 * session。这样 Sat top-up 复用 P2PKH 交易编排时仍然满足私钥不出 Worker。
 */
async function createWorkerActiveKeyCrypto(publicKeyHex: string): Promise<ActiveKeyCrypto> {
  const record = await vaultDb.getKey(publicKeyHex);
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
      const signature = await signEcdsaDigest({
        privateKeyBytes: requirePrivateKey(),
        digest: new Uint8Array(input.digest),
        format: input.format,
      });
      return { publicKeyHex, format: input.format, signature: signature.slice().buffer as ArrayBuffer };
    },
    async deriveP2pkhAddress(input) {
      if (input.publicKeyHex !== publicKeyHex) throw new Error("session_key_mismatch");
      requirePrivateKey();
      return { publicKeyHex, address: deriveP2pkhAddress(publicKeyHex, input.network) };
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
  if (coordinatorState.vaultStatus !== "unlocked" || !coordinatorState.activePublicKeyHex) {
    throw new Error("P2PKH top-up requires an unlocked active key");
  }
  const ownerPublicKeyHex = coordinatorState.activePublicKeyHex;
  const ownerSessionEpoch = coordinatorState.sessionEpoch;
  const existingService = satP2pkhService;
  if (existingService && satP2pkhServiceOwnerPublicKeyHex === ownerPublicKeyHex) {
    await existingService.onVaultUnlocked();
    if (coordinatorState.vaultStatus !== "unlocked" || coordinatorState.activePublicKeyHex !== ownerPublicKeyHex || coordinatorState.sessionEpoch !== ownerSessionEpoch || satP2pkhService !== existingService) {
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
    // 避免两个 P2PKH service 同时持有 DB/消息总线订阅。
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
      p2pkhProvidersGet: async (): Promise<CoordinatorValueResult<P2pkhProviderRegistrySnapshot>> => ({
        status: "ok",
        value: getP2pkhProviderSnapshot(),
        sessionEpoch: coordinatorState.sessionEpoch,
      }),
      p2pkhBroadcast: async (input: { ownerPublicKeyHex: string; network: "main" | "test"; submissionId: string; expectedProviderGeneration: number }): Promise<CoordinatorValueResult<unknown>> => {
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
      if (coordinatorState.vaultStatus !== "unlocked" || coordinatorState.activePublicKeyHex !== ownerPublicKeyHex) {
        throw new Error("P2PKH service became stale while starting");
      }
      if (startToken !== satP2pkhServiceStartToken || coordinatorState.sessionEpoch !== ownerSessionEpoch) {
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
  coordinatorState.taskRuntimes.set(contactsPresenceTask.id, {
    id: contactsPresenceTask.id,
    pluginId: contactsPresenceTask.pluginId,
    state: "idle",
    intervalMs: contactsPresenceTask.schedule?.defaultIntervalMs ?? 5 * 60 * 1000,
    keyScope: () => coordinatorState.activePublicKeyHex ? { publicKeyHex: coordinatorState.activePublicKeyHex } : undefined,
    run: async ({ signal, reason, assertSessionFresh }) => {
      const gate = await contactsPresenceTask.canRun?.();
      if (gate?.ready === false) {
        throw new Error(typeof gate.reason === "string" ? gate.reason : gate.reason?.fallback ?? "联系人在线探测暂不可运行");
      }
      await contactsPresenceTask.run({ signal, reason, reportProgress: () => undefined, assertSessionFresh });
    }
  });
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
  const p2pkh = createP2pkhCoordinatorTasks({ keyspace, registry: p2pkhRegistry, getSelection: (network) => { const selection = providerSettings()[network]; return { syncProviderId: selection.syncProviderId, generation: providerSettings().generation }; }, isGenerationCurrent: (_network, generation) => generation === providerSettings().generation, isNetworkEnabled: (network) => network === "main" || coordinatorMeta.p2pkhSettings?.includeTestnet === true });
  // The ordinary BSV confirmed pipeline has exactly one task.
  const assetHoldingsIntervalMs = coordinatorState.scheduleSettings.assetHoldingsIntervalMs;
  coordinatorState.taskRuntimes.set("p2pkh.transactions-sync", { id: "p2pkh.transactions-sync", pluginId: "p2pkh", state: "idle", intervalMs: assetHoldingsIntervalMs, keyScope: () => coordinatorState.activePublicKeyHex ? { publicKeyHex: coordinatorState.activePublicKeyHex } : undefined, run: async ({ signal, assertSessionFresh }) => { const result = await p2pkh.transactionsSync(signal); assertSessionFresh(); if (!result.cancelled) emitDataChanged("p2pkh", ["resource", "utxo", "history"]); } });
  const p2pkhProvider = {
    listResources: async (assetId: "bsv" | "bsvtest") => {
      if (!coordinatorState.activePublicKeyHex) return [];
      const db = createP2pkhDb(await openP2pkhDb({ keyspace, publicKeyHex: coordinatorState.activePublicKeyHex }));
      return (await db.listResourcesByKey()).filter((resource) => assetId === (resource.network === "main" ? "bsv" : "bsvtest"));
    },
    listUtxos: async (filter?: { assetId?: "bsv" | "bsvtest"; ownerPublicKeyHex?: string }) => {
      const ownerPublicKeyHex = filter?.ownerPublicKeyHex ?? coordinatorState.activePublicKeyHex;
      if (!ownerPublicKeyHex) return [];
      const db = createP2pkhDb(await openP2pkhDb({ keyspace, publicKeyHex: ownerPublicKeyHex }));
      const utxos = await db.listUtxos();
      return utxos.filter((utxo) => {
        if (filter?.assetId && filter.assetId !== (utxo.network === "main" ? "bsv" : "bsvtest")) return false;
        return true;
      });
    },
    getGlobalSettings: () => ({ includeTestnet: coordinatorMeta.p2pkhSettings?.includeTestnet === true })
  };
  const vault = { status: () => coordinatorState.vaultStatus, } as VaultService;
  const bsv21Task = createBsv21CoordinatorTask({ keyspace, p2pkh: p2pkhProvider, woc: createWocBsv21Service({ messageBus }), wocService: woc, vault, notifier: { emit: (event) => publishTopicEvent("asset.data-changed", { type: "asset.data-changed", providerId: event.providerId, publicKeyHex: event.publicKeyHex ?? "", kinds: event.kinds }), subscribe: () => () => undefined } });
  const stasTask = createStasCoordinatorTask({ keyspace, p2pkh: p2pkhProvider, woc: createWocStasService({ messageBus }), vault, notifier: { emit: (event) => publishTopicEvent("asset.data-changed", { type: "asset.data-changed", providerId: event.providerId, publicKeyHex: event.publicKeyHex ?? "", kinds: event.kinds }), subscribe: () => () => undefined } });
  const oneSatTask = createOrdinalsCoordinatorTask({ keyspace, p2pkh: p2pkhProvider, woc: createWoc1SatOrdinalsService({ messageBus }), wocService: woc, vault, notifier: { emit: (event) => publishTopicEvent("asset.data-changed", { type: "asset.data-changed", providerId: event.providerId, publicKeyHex: event.publicKeyHex ?? "", kinds: event.kinds }), subscribe: () => () => undefined } });
  coordinatorState.taskRuntimes.set(bsv21Task.id, { id: bsv21Task.id, pluginId: bsv21Task.pluginId, state: "idle", intervalMs: assetHoldingsIntervalMs, keyScope: () => coordinatorState.activePublicKeyHex ? { publicKeyHex: coordinatorState.activePublicKeyHex } : undefined, run: async ({ signal, reason, assertSessionFresh }) => { await bsv21Task.run({ signal, reason, reportProgress: () => undefined, assertSessionFresh }); } });
  coordinatorState.taskRuntimes.set(stasTask.id, { id: stasTask.id, pluginId: stasTask.pluginId, state: "idle", intervalMs: assetHoldingsIntervalMs, keyScope: () => coordinatorState.activePublicKeyHex ? { publicKeyHex: coordinatorState.activePublicKeyHex } : undefined, run: async ({ signal, reason, assertSessionFresh }) => { await stasTask.run({ signal, reason, reportProgress: () => undefined, assertSessionFresh }); } });
  coordinatorState.taskRuntimes.set(oneSatTask.id, { id: oneSatTask.id, pluginId: oneSatTask.pluginId, state: "idle", intervalMs: assetHoldingsIntervalMs, keyScope: () => coordinatorState.activePublicKeyHex ? { publicKeyHex: coordinatorState.activePublicKeyHex } : undefined, run: async ({ signal, reason, assertSessionFresh }) => { await oneSatTask.run({ signal, reason, reportProgress: () => undefined, assertSessionFresh }); } });
  for (const runtime of coordinatorState.taskRuntimes.values()) scheduleRuntime(runtime);
  publishTopicEvent("background.snapshot", { type: "background.snapshot.changed", sessionEpoch: coordinatorState.sessionEpoch, snapshots: getTaskSnapshots() });
}

// ============================================================
// 3. Utility Functions
// ============================================================

function generateEpoch(): SessionEpoch {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function generateRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function generateClientId(): string {
  return `client-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ============================================================
// 4. Port Management
// ============================================================

function handlePortConnect(event: MessageEvent): void {
  const port = event.ports[0];
  if (!port) return;

  const clientId = generateClientId();
  const connectedPort: ConnectedPort = {
    port,
    clientId,
    subscriptions: new Set(),
    lastSeenAt: Date.now(),
  };

  connectedPorts.set(clientId, connectedPort);

  port.onmessage = (msgEvent: MessageEvent<CoordinatorClientRequest>) => {
    handleClientMessage(clientId, msgEvent.data);
  };

  port.onmessageerror = () => {
    handlePortDisconnect(clientId);
  };

  port.start();

  // 发送初始状态
  sendToPort(port, {
    requestId: "hello",
    sessionEpoch: coordinatorState.sessionEpoch,
    ack: { status: "ok" },
  });
}

function handlePortDisconnect(clientId: string): void {
  for (const [requestId, request] of storageRequests) {
    if (request.clientId === clientId) { request.controller.abort(); storageRequests.delete(requestId); }
  }
  for (const [grantId, grant] of storageGrants) if (grant.clientId === clientId) storageGrants.delete(grantId);
  storagePortCounts.delete(clientId);
  // MSFile：断开端口的未决请求与 grant 全部失效。
  for (const [requestId, request] of msfileRequests) {
    if (request.clientId === clientId) { request.controller.abort(); msfileRequests.delete(requestId); }
  }
  for (const [requestId, request] of windowP2pExecutorIdentityRequests) {
    if (request.clientId === clientId) { request.controller.abort(); windowP2pExecutorIdentityRequests.delete(requestId); }
  }
  for (const [grantId, grant] of msfileGrants) if (grant.clientId === clientId) msfileGrants.delete(grantId);
  if (windowP2pExecutorLease !== undefined && windowP2pExecutorLease.clientId === clientId) {
    clearWindowP2pExecutorLeaseLocked();
    emitMsFileState();
  }
  connectedPorts.delete(clientId);
  // 最后一个 port 断开时，Worker 生命周期结束即内存消失
  // 不主动锁定，等待浏览器回收或重启
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
    const db = createP2pkhDb(await openP2pkhDb({ keyspace: createWorkerKeyspace(), publicKeyHex: request.ownerPublicKeyHex }));
    await db.abortUnattemptedLocalSubmission?.({ submissionId: request.submissionId, reason, requestKind: "initial" });
    publishTopicEvent("asset.data-changed", { type: "asset.data-changed", providerId: "p2pkh", publicKeyHex: request.ownerPublicKeyHex, kinds: ["utxo", "submission", "claim"] });
  } catch {
    // Cleanup is best-effort here. The response is still explicitly marked
    // not-dispatched, while a later reconciliation can safely inspect the row.
  }
}

// ============================================================
// 5. Message Handling
// ============================================================

async function handleClientMessage(
  clientId: string,
  request: CoordinatorClientRequest
): Promise<void> {
  const connectedPort = connectedPorts.get(clientId);
  if (!connectedPort) return;

  connectedPort.lastSeenAt = Date.now();

  if (request.kind === "hello") {
    handleHello(clientId, request);
    return;
  }

  if (request.kind === "subscribe") {
    await handleSubscribe(clientId, request);
    return;
  }

  if (request.kind === "activity") {
    handleActivity(clientId);
    return;
  }
  if (request.kind === "disconnect") {
    handlePortDisconnect(clientId);
    return;
  }

  // lock 是收敛型的安全操作：即使发起页面持有旧 epoch，也必须能够锁定
  // 当前全局会话。其余命令仍由 epoch 栅栏拒绝，避免旧页面操作新会话。
  if (request.kind !== "lock" && "expectedSessionEpoch" in request && request.expectedSessionEpoch !== coordinatorState.sessionEpoch) {
    if (request.kind === "window-p2p.executor.acquire") {
      try { request.executorPort?.close(); } catch { /* already detached */ }
    }
    if (isP2pkhBroadcastRequest(request)) {
      await abortNotDispatchedP2pkhSubmission(request, "stale-session-epoch");
      sendToPort(connectedPort.port, { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: { status: "not-dispatched", reason: "stale-session-epoch" } });
    } else {
      sendToPort(connectedPort.port, { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "stale-epoch" } });
    }
    return;
  }

  const response = await processRequest(request, clientId);
  const transfers: ArrayBuffer[] = [];
  const body = (response.operationResult as { content?: { bytes?: ArrayBuffer }; signatureDer?: ArrayBuffer; bytes?: ArrayBuffer } | undefined)?.content?.bytes;
  const signatureDer = (response.operationResult as { signatureDer?: ArrayBuffer } | undefined)?.signatureDer;
  const executorTransfer = (response.operationResult as { bytes?: ArrayBuffer } | undefined)?.bytes;
  const cryptoResult = response.cryptoResult as { envelope?: Uint8Array; signature?: Uint8Array; envelopeJson?: Uint8Array; contentJson?: Uint8Array } | undefined;
  if (body instanceof ArrayBuffer) transfers.push(body);
  if (signatureDer instanceof ArrayBuffer) transfers.push(signatureDer);
  if (executorTransfer instanceof ArrayBuffer) transfers.push(executorTransfer);
  if (cryptoResult?.envelope?.buffer instanceof ArrayBuffer) transfers.push(cryptoResult.envelope.buffer);
  if (cryptoResult?.signature?.buffer instanceof ArrayBuffer) transfers.push(cryptoResult.signature.buffer);
  if (cryptoResult?.envelopeJson?.buffer instanceof ArrayBuffer) transfers.push(cryptoResult.envelopeJson.buffer);
  if (cryptoResult?.contentJson?.buffer instanceof ArrayBuffer) transfers.push(cryptoResult.contentJson.buffer);
  sendToPort(connectedPort.port, response, transfers);
}

function handleHello(
  clientId: string,
  request: { kind: "hello"; clientId: string; requestId: string }
): void {
  const connectedPort = connectedPorts.get(clientId);
  if (!connectedPort) return;

  // 发送完整快照
  sendToPort(connectedPort.port, {
    requestId: request.requestId,
    sessionEpoch: coordinatorState.sessionEpoch,
    ack: { status: "ok" },
    operationResult: buildSnapshot()
  });
}

async function handleSubscribe(
  clientId: string,
  request: { kind: "subscribe"; topics: CoordinatorTopic[]; requestId: string }
): Promise<void> {
  const connectedPort = connectedPorts.get(clientId);
  if (!connectedPort) return;
  await storageStateTail;

  connectedPort.subscriptions.clear();
  for (const topic of request.topics) {
    connectedPort.subscriptions.add(topic);
  }

  const baselines: CoordinatorTopicBaseline[] = request.topics.flatMap((topic): CoordinatorTopicBaseline[] => {
    if (topic === "asset.data-changed") return [];
    if (topic === "storage.state") {
      const baselineRevision = storageRevision;
      const summary = storageRuntime?.getProviderSummary().catch(() => null);
      // Subscription response must be atomic; use the last published state
      // when available, otherwise a locked/unconfigured baseline.
      const cached = lastStorageState ?? {
        topic: "storage.state" as const, type: "storage.state.changed" as const,
        storageRevision: baselineRevision, sessionEpoch: coordinatorState.sessionEpoch,
        providerGeneration: null, status: coordinatorState.vaultStatus === "unlocked" ? "unconfigured" as const : "locked" as const,
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
    const baselineRevision = topic === "session.state" ? sessionRevision : backgroundSnapshotRevision;
    const snapshot = topic === "session.state"
      ? { topic, type: "session.state.changed" as const, sessionRevision: baselineRevision, sessionEpoch: coordinatorState.sessionEpoch, cause: "bootstrap" as const, vaultStatus: coordinatorState.vaultStatus, activePublicKeyHex: coordinatorState.vaultStatus === "unlocked" ? coordinatorState.activePublicKeyHex ?? null : null, selectedPublicKeyHex: coordinatorMeta.selectedPublicKeyHex ?? null, keyspaceGeneration: coordinatorState.keyspaceGeneration }
        : { topic, type: "background.snapshot.changed" as const, backgroundSnapshotRevision: baselineRevision, sessionEpoch: coordinatorState.sessionEpoch, snapshots: getTaskSnapshots(), scheduleSettings: coordinatorState.scheduleSettings };
    return [{ topic, baselineRevision, sessionEpoch: coordinatorState.sessionEpoch, snapshot }];
  });

  sendToPort(connectedPort.port, {
    requestId: request.requestId,
    sessionEpoch: coordinatorState.sessionEpoch,
    ack: { status: "ok" },
    operationResult: { topics: request.topics, baselines } satisfies CoordinatorSubscribeTopicsResult,
  });
}

function handleActivity(clientId: string): void {
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
  return request.kind === "storage.grant" || request.kind === "storage.control" || request.kind === "storage.data" || request.kind === "storage.cancel" || request.kind === "storage.session.abort";
}

async function executeStorageControl(request: Extract<CoordinatorClientRequest, { kind: "storage.control" }>): Promise<CoordinatorResponse> {
  const service = await ensureStorageRuntime();
  const control = request.control;
  if (control.type === "status") return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: service.status() };
  if (control.type === "summary") return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: await service.getProviderSummary() };
  if (control.type === "connection") return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: await service.getProviderConnection() };
  if (control.type === "capabilities") return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: service.getConditionalCapabilities() };
  if (control.type === "cancel-probe") { service.cancelProbe(); return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" } }; }
  if (control.type === "probe") return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: await service.probeProvider(control.config) };
  const current = (await service.getProviderSummary())?.generation ?? null;
  if (control.type === "activate" && control.expectedProviderGeneration !== current) return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "validation-error", message: "Storage provider generation changed" } };
  if ((control.type === "clear" || control.type === "reset") && control.expectedProviderGeneration !== current) return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "validation-error", message: "Storage provider generation changed" } };
  if (control.type === "activate") return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: await service.activateProvider(control.config) };
  if (control.type === "clear") { await service.clearProviderConfig(); return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" } }; }
  if (control.type === "reset") { await service.resetStorage(); return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" } }; }
  if (control.type === "probe-capabilities") return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: await service.probeConditionalCapabilities() };
  return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "validation-error", message: "Unknown storage control" } };
}

async function executeStorageData(request: Extract<CoordinatorClientRequest, { kind: "storage.data" }>, controller: AbortController, actualClientId: string): Promise<CoordinatorResponse> {
  const capturedSessionEpoch = coordinatorState.sessionEpoch;
  const service = await ensureStorageRuntime();
  const data = request.data;
  const ctx = (await resolveStorageGrant(data.grantId, actualClientId)).context;
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
    const error = new Error("storage_unavailable") as Error & { code?: string }; error.code = "storage_unavailable"; throw error;
  }
  const finalSummary = typeof service.getProviderSummary === "function" ? await service.getProviderSummary().catch(() => null) : null;
  if ((finalSummary?.generation ?? null) !== capturedProviderGeneration) {
    const error = new Error("storage_unavailable") as Error & { code?: string }; error.code = "storage_unavailable"; throw error;
  }
  await resolveStorageGrant(data.grantId, actualClientId);
  return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: value };
}

async function resolveStorageGrant(grantId: string, actualClientId: string): Promise<{ context: import("@keymaster/contracts").StorageAppContext; connectSessionId: string }> {
  const grant = storageGrants.get(grantId);
  if (!grant || grant.clientId !== actualClientId || grant.sessionEpoch !== coordinatorState.sessionEpoch) {
    const error = new Error("Storage grant is invalid") as Error & { code?: string }; error.code = "storage_identity_required"; throw error;
  }
  const authoritative = await readProtocolConnectSession(grant.context.connectSessionId);
  if (!authoritative || authoritative.origin !== grant.context.transportOrigin || JSON.stringify(authoritative.appIdentity) !== JSON.stringify(grant.context.appIdentity)) {
    const error = new Error("Storage session is invalid or revoked") as Error & { code?: string }; error.code = "storage_identity_required"; throw error;
  }
  return { context: grant.context, connectSessionId: grant.context.connectSessionId };
}

async function abortStorageSession(connectSessionId: string): Promise<void> {
  for (const [requestId, pending] of storageRequests) {
    if (pending.connectSessionId === connectSessionId) { pending.controller.abort(); storageRequests.delete(requestId); }
  }
  for (const [grantId, grant] of storageGrants) if (grant.context.connectSessionId === connectSessionId) storageGrants.delete(grantId);
  const service = await ensureStorageRuntime();
  await service.abortSession(connectSessionId);
}

async function executeStorageRequest(request: Extract<CoordinatorClientRequest, { kind: "storage.grant" | "storage.control" | "storage.data" | "storage.cancel" | "storage.session.abort" }>, actualClientId: string): Promise<CoordinatorResponse> {
  if (request.kind === "storage.grant") {
    const session = await readProtocolConnectSession(request.connectSessionId);
    if (!session) return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "error", message: "Storage session is invalid or revoked", code: "storage_identity_required" } };
    const grantId = `grant-${crypto.randomUUID()}`;
    storageGrants.set(grantId, { context: { connectSessionId: session.sessionId, transportOrigin: session.origin, appIdentity: session.appIdentity }, clientId: actualClientId, sessionEpoch: coordinatorState.sessionEpoch });
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
  const controller = new AbortController();
  if (request.kind === "storage.data") {
    if (!reserveStoragePortSlot(actualClientId)) return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "error", message: "storage_limit_exceeded", code: "storage_limit_exceeded" } };
  }
  storageRequests.set(storageRequestKey(actualClientId, request.requestId), { controller, clientId: actualClientId, connectSessionId: request.kind === "storage.data" ? storageGrants.get(request.data.grantId)?.context.connectSessionId : undefined });
  try {
    if (request.kind === "storage.control") {
      let result!: CoordinatorResponse;
      const run = storageMutationTail.then(() => executeStorageControl(request), () => executeStorageControl(request));
      storageMutationTail = run.then(() => undefined, () => undefined);
      result = await run;
      return result;
    }
    return await withStorageDataSlot(actualClientId, () => executeStorageData(request, controller, actualClientId), controller.signal);
  } catch (err) {
    const code = (err as { code?: string })?.code;
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "error", message: err instanceof Error ? err.message : String(err), ...(typeof code === "string" ? { code: code as never } : {}) } };
  } finally {
    storageRequests.delete(storageRequestKey(actualClientId, request.requestId));
    if (request.kind === "storage.data") {
      releaseStoragePortSlot(actualClientId);
    }
  }
}

async function executeSatRequest(
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

function channelCallerId(caller: ChannelCaller): string {
  const epoch = coordinatorState.sessionEpoch;
  if (caller.kind === "plugin") {
    if (!caller.pluginId || caller.pluginId.length > 128 || !TRUSTED_CHANNEL_PLUGIN_IDS.has(caller.pluginId)) {
      throw new Error("Channel plugin caller id is not trusted");
    }
    return `${epoch}:plugin:${caller.pluginId}`;
  }
  if (caller.kind === "system") {
    if (!caller.systemId || caller.systemId.length > 128 || !TRUSTED_CHANNEL_SYSTEM_IDS.has(caller.systemId)) {
      throw new Error("Channel system caller id is not trusted");
    }
    return `${epoch}:system:${caller.systemId}`;
  }
  if (!caller.connectSessionId || !caller.origin) throw new Error("Channel Connect caller is incomplete");
  return `${epoch}:connect:${caller.connectSessionId}:${caller.origin}`;
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
        subscribe: (channel) => runtime.handle.subscribePhysical(channel),
        unsubscribe: (channel) => runtime.handle.unsubscribePhysical(channel)
      }
    });
    channelSubscriptionMux = mux;
    channelMuxOwnerPublicKeyHex = runtime.ownerPublicKeyHex;
    const ownerInbox = inboxChannel(parsePublicKey(runtime.ownerPublicKeyHex));
    try {
      await mux.set(`${coordinatorState.sessionEpoch}:system:owner-inbox`, [ownerInbox]);
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

/**
 * 生成并发布完整的 bsv8.hash.request.v1。request_message_id 必须来自这
 * 条真实公开消息，不能由 WebRTC 插件另行随机生成后冒充 Hash 请求。
 */
async function publishChannelHashRequest(
  runtime: SatWorkerRuntimeState,
  input: { hash: string; locator: "webrtc-sdp" }
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
    await runtime.service.publish({ channel: HASH_REQUEST_CHANNEL, contentJson });
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

/** 在 Coordinator 内给固定业务服务使用的 Channel facade。 */
function createCoordinatorChannelRuntime(): ChannelRuntime {
  const contactsCaller = { kind: "system" as const, systemId: "contacts-presence" };
  return {
    isReady: () => coordinatorState.vaultStatus === "unlocked" && Boolean(coordinatorState.activePublicKeyHex),
    async publish(input) {
      validateExactChannel(input.channel);
      if (input.channel === HASH_REQUEST_CHANNEL) {
        throw new Error("Use the trusted WebRTC Hash request publisher for bsv8.hash.request.v1");
      }
      const runtime = await ensureSatRuntime();
      const ownerSessionEpoch = coordinatorState.sessionEpoch;
      const privateKey = currentOwnerPrivateKey();
      const { issuedAtMs, expiresAtMs } = channelPublicMessageTimes();
      const signed = signPublicMessage({
        channel: input.channel,
        from_public_key: publicKeyFromPrivate(privateKey),
        message_id: newMessageID(),
        issued_at_ms: issuedAtMs,
        expires_at_ms: expiresAtMs,
        content: input.content
      }, privateKey);
      await runtime.service.publish({ channel: input.channel, contentJson: marshalPublicMessage(signed) });
      if (coordinatorState.vaultStatus !== "unlocked"
        || coordinatorState.sessionEpoch !== ownerSessionEpoch
        || coordinatorState.activePublicKeyHex !== runtime.ownerPublicKeyHex) {
        throw new Error("Channel owner changed while publishing");
      }
      return { messageId: signed.message_id };
    },
    async publishPrivate(input) {
      const runtime = await ensureSatRuntime();
      const protocol = privateProtocol(input.protocol);
      validatePrivateProtocolCaller(contactsCaller, protocol);
      const messageId = await publishPrivateEnvelope({
        runtime,
        recipientPublicKeyHex: input.recipientPublicKeyHex,
        protocol,
        body: privateBodyForPublish(protocol, input.content)
      });
      return { messageId };
    },
    async subscriptionSet(channels) {
      const runtime = await ensureSatRuntime();
      const ownerSessionEpoch = coordinatorState.sessionEpoch;
      const mux = await ensureChannelSubscriptionMux(runtime);
      const result = await mux.set(channelCallerId(contactsCaller), channels);
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
    await input.runtime.service.publish({ channel, contentJson: marshalEnvelope(envelope) });
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
    const ownerPrivateKey = currentOwnerPrivateKey();
    const ownerInbox = inboxChannel(parsePublicKey(owner));
    if (event.channel === ownerInbox) {
      const opened = await openPrivateMessage(event.channel, event.contentJson, ownerPrivateKey, Date.now());
      // 解密本身可能让出事件循环；锁定、切换 owner 或重建 session 后，
      // 旧事件不得进入新 owner 的业务处理器。
      if (coordinatorState.vaultStatus !== "unlocked"
        || coordinatorState.sessionEpoch !== ownerSessionEpoch
        || coordinatorState.activePublicKeyHex !== owner) {
        return;
      }
      const dedup = privateDedupKey(opened);
      const key = `${dedup.protocol}\u0000${dedup.from_public_key}\u0000${dedup.message_id}`;
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
      const key = channelHashRequestKey(hashRequest.message_id, hashRequest.from_public_key);
      if (!rememberChannelMessage(key)) return;
      channelHashRequests.set(key, hashRequest);
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
    const key = `${publicDedup.from_public_key}\u0000${publicDedup.message_id}`;
    if (!rememberChannelMessage(key)) return;
    emitChannelPublicMessage({ channel: publicMessage.channel, publisherPublicKeyHex: publicMessage.from_public_key, messageId: publicMessage.message_id, content: publicMessage.content });
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
  request: Extract<CoordinatorClientRequest, { kind: "channel.operation" }>
): Promise<CoordinatorResponse> {
  if (request.expectedSessionEpoch !== coordinatorState.sessionEpoch) {
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "stale-epoch" } };
  }
  if (coordinatorState.vaultStatus !== "unlocked" || !coordinatorState.activePublicKeyHex) {
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "locked" } };
  }
  const operation = request.operation;
  if (operation.ownerPublicKeyHex !== coordinatorState.activePublicKeyHex) {
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "stale-epoch" } };
  }
  if (operation.caller.kind === "connect") {
    const session = await getAuthoritativeConnectSession(operation.caller.connectSessionId);
    if (!session || session.revokedAt !== null || session.origin !== operation.caller.origin || session.ownerPublicKeyHex !== operation.ownerPublicKeyHex) {
      return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "error", message: "Channel Connect session is invalid", code: "storage_identity_required" } };
    }
  }
  try {
    const runtime = await ensureSatRuntime();
    const mux = await ensureChannelSubscriptionMux(runtime);
    switch (operation.type) {
      case "hash-request-publish": {
        if (operation.caller.kind !== "plugin" || operation.caller.pluginId !== "webrtc") {
          throw new Error("Only the trusted WebRTC plugin may publish Hash requests");
        }
        if (operation.locator !== "webrtc-sdp") throw new Error("Unsupported Hash request locator");
        const published = await publishChannelHashRequest(runtime, operation);
        if (request.expectedSessionEpoch !== coordinatorState.sessionEpoch
          || coordinatorState.vaultStatus !== "unlocked"
          || coordinatorState.activePublicKeyHex !== operation.ownerPublicKeyHex) {
          throw new Error("Hash request publish became stale after network completion");
        }
        return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: published };
      }
      case "publish": {
        validateExactChannel(operation.channel);
        if (operation.channel.startsWith("bsv8.inbox.")) {
          throw new Error("bsv8.inbox.* is a reserved private channel");
        }
        if (operation.channel === HASH_REQUEST_CHANNEL) {
          throw new Error("bsv8.hash.request.v1 is reserved for the trusted WebRTC Hash request publisher");
        }
        const privateKey = currentOwnerPrivateKey();
        const from = publicKeyFromPrivate(privateKey);
        const { issuedAtMs, expiresAtMs } = channelPublicMessageTimes();
        const message = {
          channel: operation.channel,
          from_public_key: from,
          message_id: newMessageID(),
          issued_at_ms: issuedAtMs,
          expires_at_ms: expiresAtMs,
          content: operation.content
        } as const;
        const signed = signPublicMessage(message, privateKey);
        await runtime.service.publish({ channel: operation.channel, contentJson: marshalPublicMessage(signed) });
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
        return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: { messageId: signed.message_id } };
      }
      case "private-publish": {
        const protocol = privateProtocol(operation.protocol);
        validatePrivateProtocolCaller(operation.caller, protocol);
        const messageId = await publishPrivateEnvelope({ runtime, recipientPublicKeyHex: operation.recipientPublicKeyHex, protocol, body: privateBodyForPublish(protocol, operation.content) });
        if (request.expectedSessionEpoch !== coordinatorState.sessionEpoch
          || coordinatorState.vaultStatus !== "unlocked"
          || coordinatorState.activePublicKeyHex !== operation.ownerPublicKeyHex) {
          throw new Error("Private Channel publish became stale after network completion");
        }
        return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: { messageId } };
      }
      case "subscription-set": {
        if (operation.channels.length > CHANNEL_MAX_SUBSCRIPTIONS_PER_CALLER) throw new Error("Too many Channel subscriptions");
        const callerId = channelCallerId(operation.caller);
        for (const channel of operation.channels) {
          validateExactChannel(channel);
          if (channel.startsWith("bsv8.inbox.")) {
            if (!isAllowedOwnerInboxSubscription(operation.caller, channel)) {
              throw new Error("bsv8.inbox.* is reserved for the current owner inbox router");
            }
          }
        }
        const channels = await mux.set(callerId, operation.channels);
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
        mux.release(channelCallerId(operation.caller));
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
// Spike RPC 的有界 pre-sign cancellation window：只影响尚未接入生产数据面的
// executor identity 通道，用于让跨 tab lifecycle 事件可靠越过二次栅栏。
const WINDOW_P2P_EXECUTOR_PRE_SIGN_YIELD_MS = 25;
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

  const signature = await signEcdsaDigest({ privateKeyBytes: coordinatorState.activePrivateKeyBytes!, digest, format: "der" });
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

async function executeMsfileControl(request: Extract<CoordinatorClientRequest, { kind: "msfile.control" }>): Promise<CoordinatorResponse> {
  if (!isMsfileMutationControl(request.control)) {
    return executeMsfileControlNow(request);
  }
  // mutation 进串行尾；前一个失败不阻塞后续。
  const run = msfileMutationTail.then(() => executeMsfileControlNow(request), () => executeMsfileControlNow(request));
  msfileMutationTail = run.then(() => undefined, () => undefined);
  return run;
}

async function executeMsfileControlNow(request: Extract<CoordinatorClientRequest, { kind: "msfile.control" }>): Promise<CoordinatorResponse> {
  // 审查修复：排队中的请求必须携带其入队时的 epoch；任务开始时与当前 epoch
  // 比较——入队后发生 lock/unlock/key switch 都会推进 epoch，从而在此被拒。
  const requestEpoch = request.expectedSessionEpoch;
  if (coordinatorState.vaultStatus !== "unlocked") {
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "locked" } };
  }
  if (requestEpoch !== coordinatorState.sessionEpoch) {
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "stale-epoch" } };
  }
  const service = await ensureMsfileRuntime();
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
  // DB commit 后复核：请求 epoch、Vault、runtime 身份任一变化都报告为
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
  // 审查修复：以请求自身的 epoch 为栅栏（执行时现取会得到恒真比较）。
  const requestEpoch = request.expectedSessionEpoch;
  const service = await ensureMsfileRuntime();
  const data: CoordinatorMsFileData = request.data;
  const signal = controller.signal;
  return withMsfileDataSlot(actualClientId, data, async () => {
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
  }, signal);
}

type WindowP2pExecutorRequest = Extract<CoordinatorClientRequest, { kind: "window-p2p.executor.acquire" | "window-p2p.executor.release" | "window-p2p.executor.spike.transfer" | "window-p2p.executor.identity.sign-noise" | "window-p2p.executor.identity.sign-peer-record" }>;

async function executeWindowP2pExecutorRequest(request: WindowP2pExecutorRequest, actualClientId: string): Promise<CoordinatorResponse> {
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
  const controller = new AbortController();
  msfileRequests.set(msfileRequestKey(actualClientId, request.requestId), {
    controller,
    clientId: actualClientId,
    connectSessionId: request.kind === "msfile.data" && request.data.grantId !== undefined
      ? msfileGrants.get(request.data.grantId)?.context.connectSessionId
      : undefined
  });
  try {
    if (request.kind === "msfile.control") return await executeMsfileControl(request);
    return await executeMsfileData(request, controller, actualClientId);
  } catch (err) {
    const code = (err as { code?: string })?.code;
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "error", message: err instanceof Error ? err.message : String(err), ...(typeof code === "string" ? { code: code as never } : {}) } };
  } finally {
    msfileRequests.delete(msfileRequestKey(actualClientId, request.requestId));
  }
}

function enqueueCoordinatorRequest(request: CoordinatorClientRequest): Promise<CoordinatorResponse> {
  const run = coordinatorRequestTail.then(
    () => executeProcessRequest(request),
    () => executeProcessRequest(request)
  );
  coordinatorRequestTail = run.then(() => undefined, () => undefined);
  return run;
}

async function executeProcessRequest(
  request: CoordinatorClientRequest
): Promise<CoordinatorResponse> {
  const requestId = "requestId" in request ? request.requestId : generateRequestId();

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
        return await executeChannelRequest(request);
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

async function processRequest(request: CoordinatorClientRequest, actualClientId = (request as { clientId?: string }).clientId ?? "unknown"): Promise<CoordinatorResponse> {
  if (isStorageRequest(request)) return executeStorageRequest(request as never, actualClientId);
  if (isMsfileRequest(request)) {
    if (request.kind === "window-p2p.executor.acquire" || request.kind === "window-p2p.executor.release" || request.kind === "window-p2p.executor.spike.transfer" || request.kind === "window-p2p.executor.identity.sign-noise" || request.kind === "window-p2p.executor.identity.sign-peer-record") {
    return executeWindowP2pExecutorRequest(request as WindowP2pExecutorRequest, actualClientId);
    }
    return executeMsfileRequest(request as never, actualClientId);
  }
  return enqueueCoordinatorRequest(request);
}

// ============================================================
// 7. Vault Operations
// ============================================================

async function handleUnlock(
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
    // 1. 从 DB 读取 vault_meta
    const meta = await getVaultMeta();
    if (!meta) {
      return {
        requestId,
        sessionEpoch: coordinatorState.sessionEpoch,
        ack: { status: "validation-error", message: "Vault not initialized" },
      };
    }

    // 2. 验证密码
    const passwordKey = await deriveKey(request.password, decodePersisted(meta.saltB64));
    const passwordValid = await verifyVerifier(passwordKey, { salt: decodePersisted(meta.verifierSaltB64), iv: decodePersisted(meta.verifierIvB64), ciphertext: decodePersisted(meta.verifierCipherB64), version: meta.cryptoVersion });
    if (!passwordValid) {
      return {
        requestId,
        sessionEpoch: coordinatorState.sessionEpoch,
        ack: { status: "validation-error", message: "Invalid password" },
      };
    }

    const storageSecretKey = await deriveStorageSecretKey(request.password, decodePersisted(meta.saltB64));
    await recoverStorageRotation(storageSecretKey, passwordKey);

    // 3. 获取 active key。旧版本允许创建“有密码但没有 key”的空 Vault；
    //    这种 Vault 已经是初始化状态，应清掉孤立的密码元数据，
    //    而不是把用户永久卡在 "No active key"。
    const activeKey = request.publicKeyHex ? await vaultDb.getKey(request.publicKeyHex) : await getActiveKey();
    if (!activeKey) {
      await vaultDb.deleteMeta();
      await performGlobalLock("recover-empty");
      return {
        requestId,
        sessionEpoch: coordinatorState.sessionEpoch,
        ack: { status: "accepted" },
      };
    }
    privateKey = await decryptPrivateKey(request.password, activeKey);

    // 4. 统一进入 unlocked 状态
    coordinatorState.password = request.password;
    await enterUnlockedState(passwordKey, storageSecretKey, activeKey.publicKeyHex, privateKey, "unlock");
    privateKeyTransferred = true;

    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "accepted" },
    };
  } catch (err) {
    // unlock 失败，回到 locked
    coordinatorState.vaultStatus = "locked";
    coordinatorState.activePublicKeyHex = undefined;
    dropActivePrivateKey();
    privateKeyTransferred = false;
    coordinatorState.passwordKey = undefined;
    coordinatorState.password = undefined;
    coordinatorState.storageSecretKey = undefined;

    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "error", message: err instanceof Error ? err.message : String(err) },
    };
  } finally {
    if (privateKey && !privateKeyTransferred) privateKey.fill(0);
  }
}

async function handleVaultOperation(requestId: string, request: { kind: "vault.operation"; operation: CoordinatorVaultOperation }): Promise<CoordinatorResponse> {
  try {
    const result = await executeVaultOperation(request.operation);
    return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: result };
  } catch (err) {
    return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "error", message: err instanceof Error ? err.message : String(err) } };
  }
}

async function executeVaultOperation(operation: CoordinatorVaultOperation): Promise<unknown> {
  switch (operation.type) {
    case "listKeys": return (await vaultDb.listKeys()).map(({ publicKeyHex, label, capabilities, createdAt, address, network, format, source }) => ({ publicKeyHex, label, capabilities, createdAt, address, network, format, source }));
    case "getKey": {
      const key = await vaultDb.getKey(operation.publicKeyHex);
      if (!key) return undefined;
      const { publicKeyHex, label, capabilities, createdAt, address, network, format, source } = key;
      return { publicKeyHex, label, capabilities, createdAt, address, network, format, source };
    }
    case "verifyPassword": { const meta = await getVaultMeta(); if (!meta) throw new Error("Vault not initialized"); if (!(await verifyPassword(operation.password, meta))) throw new Error("Invalid password"); return true; }
    case "setActive": {
      if (coordinatorState.vaultStatus !== "unlocked" || !coordinatorState.passwordKey) throw new Error("Vault is locked");
      const key = await vaultDb.getKey(operation.publicKeyHex); if (!key) throw new Error("Key not found");
      const bytes = await decryptPrivateKey(coordinatorState.password ?? "", key);
      const previousActive = coordinatorState.activePublicKeyHex;
      const previousBytes = coordinatorState.activePrivateKeyBytes?.slice();
      const previousGeneration = coordinatorState.keyspaceGeneration;
      const previousEpoch = coordinatorState.sessionEpoch;
      const previousSelected = coordinatorMeta.selectedPublicKeyHex;
      // 旧 owner 仍在 coordinatorState 中时完成清理，避免清理过程读取到新
      // owner 的签名身份或 Supplier 配置。
      releaseMsfileRuntime("activate-key");
      await releaseSatRuntime("activate-key");
      clearWindowP2pExecutorLeaseLocked();
      replaceActivePrivateKey(bytes);
      coordinatorState.activePublicKeyHex = key.publicKeyHex;
      coordinatorState.keyspaceGeneration++;
      coordinatorState.sessionEpoch = generateEpoch();
      passkeyAddIntents.clear();
      coordinatorMeta.selectedPublicKeyHex = key.publicKeyHex;
      coordinatorMeta.generation = coordinatorState.keyspaceGeneration;
      try {
        if (previousActive && previousActive !== operation.publicKeyHex) {
          await cancelTaskRuntimesByKey(previousActive);
        }
        await persistActiveMeta();
      } catch (error) {
        dropActivePrivateKey();
        if (previousBytes) replaceActivePrivateKey(previousBytes);
        coordinatorState.activePublicKeyHex = previousActive;
        coordinatorState.keyspaceGeneration = previousGeneration;
        coordinatorState.sessionEpoch = previousEpoch;
        coordinatorMeta.selectedPublicKeyHex = previousSelected;
        coordinatorMeta.generation = previousGeneration;
        emitMsFileState();
        throw error;
      } finally {
        if (previousBytes && coordinatorState.activePrivateKeyBytes !== previousBytes) previousBytes.fill(0);
      }
      publishSessionState("activate-key");
      emitMsFileState();
      return true;
    }
    case "deleteKeyMaterial": await cancelTaskRuntimesByKey(operation.publicKeyHex); await vaultDb.deleteKeyAndSidecars(operation.publicKeyHex); if (coordinatorState.activePublicKeyHex === operation.publicKeyHex) { dropActivePrivateKey(); coordinatorState.activePublicKeyHex = undefined; } await repairSelectedAfterDelete(operation.publicKeyHex); return true;
    case "createVault": return await createVaultRpc(operation.password);
    case "createVaultWithInitialKey": return await createVaultRpc(operation.password, { label: operation.label, capabilities: operation.capabilities });
    case "createVaultWithImportedKey": return await createVaultRpc(operation.vaultPassword, operation.key);
    case "generateKey": return await addKeyRpc(operation.password, { label: operation.label, capabilities: operation.capabilities, material: { hex: generatePrivateKeyHex() }, format: "generated", source: "vault-generated" });
    case "importPrivateKey": return await addKeyRpc(operation.password, operation);
    case "exportCurrentKeyBackup": {
      const selectedHex = coordinatorMeta.selectedPublicKeyHex;
      if (!selectedHex) throw new Error("No selected private key");
      const key = await vaultDb.getKey(selectedHex);
      if (!key) throw new Error("Key not found");
      if (key.storageVersion !== "keyhold-v2" || !key.keyholdDocument) throw new Error("Unsupported key storage version");
      return (await import("keyhold")).serialize((await import("keyhold")).parse((await import("keyhold")).serialize(key.keyholdDocument)));
    }
    case "listCurrentKeyPasskeys": {
      const key = await requireCurrentKeyRecord();
      return (await vaultDb.listSidecars(key.publicKeyHex)).map(toPasskeySummary);
    }
    case "listPasskeysForKey": {
      const key = await vaultDb.getKey(operation.publicKeyHex);
      if (!key) throw new Error("Key not found");
      return (await vaultDb.listSidecars(key.publicKeyHex)).map(toPasskeySummary);
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
      const label = operation.label.trim();
      if (!label) throw new Error("Passkey name is required");
      if ((await vaultDb.listSidecars(key.publicKeyHex)).some((item) => item.label === label)) {
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
      const intent = passkeyAddIntents.get(operation.intentId);
      passkeyAddIntents.delete(operation.intentId);
      if (!intent || intent.expiresAt < Date.now()) throw new Error("Passkey setup expired; try again");
      const key = await requireCurrentKeyRecord();
      if (intent.sessionEpoch !== coordinatorState.sessionEpoch || intent.publicKeyHex !== key.publicKeyHex) {
        throw new Error("Current key changed during passkey setup");
      }
      const allKeys = await vaultDb.listKeys();
      if ((await Promise.all(allKeys.map((record) => vaultDb.listSidecars(record.publicKeyHex)))).some((items) => items.some((item) => item.id === operation.credentialIdB64))) {
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
      await vaultDb.putSidecar({ publicKeyHex: key.publicKeyHex, ...protection });
      return toPasskeySummary(protection);
    }
    case "removePasskeyFromCurrentKey": {
      const key = await requireCurrentKeyRecord();
      const sidecar = (await vaultDb.listSidecars(key.publicKeyHex)).find((item) => item.id === operation.passkeyId);
      if (!sidecar) throw new Error("Passkey protection not found");
      await vaultDb.deleteSidecar(key.publicKeyHex, operation.passkeyId);
      return true;
    }
    case "activateKeyWithPasskey": {
      if (coordinatorState.vaultStatus !== "unlocked") throw new Error("Vault is locked");
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
        const previousEpoch = coordinatorState.sessionEpoch;
        const previousSelected = coordinatorMeta.selectedPublicKeyHex;
        // Passkey 激活与普通切换是同一类 owner 边界：先清理旧 owner 的
        // MSFile、Sat 物理订阅和窗口 lease，再让新 owner 对外可见。
        releaseMsfileRuntime("activate-key");
        await releaseSatRuntime("activate-key");
        clearWindowP2pExecutorLeaseLocked();
        if (previousPublicKeyHex && previousPublicKeyHex !== key.publicKeyHex) {
          await cancelTaskRuntimesByKey(previousPublicKeyHex);
        }
        replaceActivePrivateKey(privateKey);
        privateKeyTransferred = true;
        coordinatorState.activePublicKeyHex = key.publicKeyHex;
        coordinatorState.keyspaceGeneration++;
        coordinatorState.sessionEpoch = generateEpoch();
        passkeyAddIntents.clear();
        coordinatorMeta.selectedPublicKeyHex = key.publicKeyHex;
        coordinatorMeta.generation = coordinatorState.keyspaceGeneration;
        try {
          await persistActiveMeta();
        } catch (error) {
          dropActivePrivateKey();
          if (previousBytes) replaceActivePrivateKey(previousBytes);
          coordinatorState.activePublicKeyHex = previousPublicKeyHex;
          coordinatorState.keyspaceGeneration = previousGeneration;
          coordinatorState.sessionEpoch = previousEpoch;
          coordinatorMeta.selectedPublicKeyHex = previousSelected;
          coordinatorMeta.generation = previousGeneration;
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
      if (coordinatorState.vaultStatus !== "unlocked" || !coordinatorState.storageSecretKey) throw new Error("Vault is locked");
      if (!operation.scope || operation.scope.length > 256 || /[\u0000-\u001f\u007f]/u.test(operation.scope)) throw new Error("Invalid secret scope");
      try {
        const blob = await encryptBytesWithSaltBoundAad(coordinatorState.storageSecretKey, operation.plaintext, localSecretAad(2, operation.scope));
        return { version: 2, saltHex: bytesToHex(blob.salt), nonceHex: bytesToHex(blob.iv), ciphertextHex: bytesToHex(blob.ciphertext) };
      } finally {
        operation.plaintext.fill(0);
      }
    }
    case "openLocalSecret": {
      if (coordinatorState.vaultStatus !== "unlocked" || !coordinatorState.storageSecretKey || !coordinatorState.passwordKey) throw new Error("Vault is locked");
      if (!operation.scope || operation.scope.length > 256 || /[\u0000-\u001f\u007f]/u.test(operation.scope)) throw new Error("Invalid secret scope");
      const sealed = operation.sealed;
      if (sealed.version !== 1 && sealed.version !== 2) throw new Error("Invalid sealed secret");
      const blob = { salt: cryptoHexToBytes(sealed.saltHex), iv: cryptoHexToBytes(sealed.nonceHex), ciphertext: cryptoHexToBytes(sealed.ciphertextHex) };
      let plaintext: Uint8Array;
      try {
        plaintext = sealed.version === 2
          ? await decryptBytesWithSaltBoundAad(coordinatorState.storageSecretKey, blob, localSecretAad(2, operation.scope))
          : await decryptBytesWithAad(coordinatorState.storageSecretKey, blob, localSecretAad(1, operation.scope));
      } catch (error) {
        // Read legacy Storage envelopes once; newly sealed values always use
        // the independent domain key above.
        plaintext = sealed.version === 2
          ? await decryptBytesWithSaltBoundAad(coordinatorState.passwordKey, blob, localSecretAad(2, operation.scope))
          : await decryptBytesWithAad(coordinatorState.passwordKey, blob, localSecretAad(1, operation.scope));
      }
      return plaintext;
    }
    case "changePassword": return await changePasswordRpc(operation.oldPassword, operation.newPassword);
    case "finalizeEmptyVaultAfterLastKeyDeletion": {
      if ((await vaultDb.listKeys()).length !== 0) throw new Error("Vault still has keys");
      await vaultDb.deleteMeta();
      await performGlobalLock("empty-vault");
      return true;
    }
    case "recoverEmptyVaultToUninitialized": await vaultDb.deleteMeta(); await performGlobalLock("recover-empty"); return true;
    case "exportKeyBackup": {
      const key = await vaultDb.getKey(operation.publicKeyHex);
      if (!key) throw new Error("Key not found");
      if (key.storageVersion !== "keyhold-v2" || !key.keyholdDocument) throw new Error("Unsupported key storage version");
      return (await import("keyhold")).serialize((await import("keyhold")).parse((await import("keyhold")).serialize(key.keyholdDocument)));
    }
    case "importKeyBackup": {
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
        const existingKey = await vaultDb.getKey(source.publicKeyHex);
        if (existingKey) throw new Error("Key already exists");
        targetDocument = keyhold.parse(await keyhold.exportPrivateKey({ privateKey: source.privateKey, password: operation.targetPassword, label: sourceDoc.label, parameters: keyhold.recommendedParameters() }));
      } finally {
        source.privateKey.fill(0);
      }
      const record: VaultKeyRecord = { publicKeyHex: source.publicKeyHex, label: sourceDoc.label, address: "", network: "main", format: "keyhold-v2", capabilities: ["p2pkh"], createdAt: new Date().toISOString(), storageVersion: "keyhold-v2", keyholdDocument: targetDocument };
      await vaultDb.putKey(record);
      // 仅当 Vault 已 unlocked 且是第一个 key 时，设置为 active
      if (coordinatorState.vaultStatus === "unlocked") {
        const keys = await vaultDb.listKeys();
        if (keys.length === 1) {
          await executeVaultOperation({ type: "setActive", publicKeyHex: record.publicKeyHex });
        }
      }
      return { publicKeyHex: record.publicKeyHex, label: record.label, address: record.address, network: record.network, format: record.format, capabilities: record.capabilities, createdAt: record.createdAt, source: record.source };
    }
    default: throw new Error(`Unsupported vault operation: ${(operation as { type: string }).type}`);
  }
}

async function requireCurrentKeyRecord(): Promise<VaultKeyRecord> {
  if (
    coordinatorState.vaultStatus !== "unlocked" ||
    !coordinatorState.activePublicKeyHex ||
    !coordinatorState.activePrivateKeyBytes
  ) {
    throw new Error("No active private key");
  }
  const key = await vaultDb.getKey(coordinatorState.activePublicKeyHex);
  if (!key) throw new Error("Active key not found");
  verifySessionKeyPair({
    publicKeyHex: key.publicKeyHex,
    privateKeyBytes: coordinatorState.activePrivateKeyBytes
  });
  return key;
}

async function repairSelectedAfterDelete(deleted: string): Promise<void> {
  const remaining = await vaultDb.listKeys();
  if (remaining.length === 0) {
    coordinatorMeta.selectedPublicKeyHex = undefined;
    await persistCoordinatorMeta();
    return;
  }
  if (coordinatorMeta.selectedPublicKeyHex === deleted || !await vaultDb.getKey(coordinatorMeta.selectedPublicKeyHex ?? "")) {
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
  const matches: Array<{ key: VaultKeyRecord; protection: import("@keymaster/plugin-vault/coordinator").WebAuthnSidecarRecord }> = [];
  for (const key of await vaultDb.listKeys()) {
    const protection = (await vaultDb.listSidecars(key.publicKeyHex)).find((item) => item.id === passkeyId);
    if (protection) matches.push({ key, protection });
  }
  if (matches.length === 0) throw new Error("Passkey protection not found");
  if (matches.length > 1) throw new Error("Passkey protection id is not unique");
  return matches[0]!;
}

function generatePrivateKeyHex(): string { const bytes = crypto.getRandomValues(new Uint8Array(32)); return bytesToHex(bytes); }
async function createVaultRpc(password: string, key?: { label?: string; capabilities?: string[]; material?: { hex: string; wif?: string }; format?: string; source?: string }): Promise<unknown> {
  if (await getVaultMeta()) throw new Error("Vault already exists");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = key?.material ?? { hex: generatePrivateKeyHex() };
  const passwordKey = await deriveKey(password, salt);
  const verifier = await (await import("@keymaster/plugin-vault/coordinator")).encryptVerifier(passwordKey);
  const meta = (await import("@keymaster/plugin-vault/coordinator")).buildVaultMeta({ salt, verifier });
  await vaultDb.putMeta(meta);
  if (key) {
    // 有 key 时调用 addKeyRpc，它会设置 unlocked 状态
    return addKeyRpc(password, { ...key, material: keyMaterial, label: key.label ?? "Key", capabilities: key.capabilities ?? ["p2pkh"], format: key.format ?? "imported", source: key.source }, key.format === "imported" ? "import-initial-key" : "create-initial-key");
  }
  // 空 Vault 创建后保持 locked 状态，清空内存中的 passwordKey
  coordinatorState.passwordKey = undefined;
  coordinatorState.password = undefined;
  coordinatorState.storageSecretKey = undefined;
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
async function addKeyRpc(password: string, input: { label: string; capabilities?: string[]; material: { hex: string; wif?: string }; format: string; source?: string }, initialCause: Extract<SessionStateEvent["cause"], "create-initial-key" | "import-initial-key"> = "create-initial-key"): Promise<unknown> {
  const meta = await getVaultMeta();
  if (!meta) throw new Error("Vault not initialized");
  const passwordKey = coordinatorState.passwordKey ?? await (async () => {
    const k = await deriveKey(password, decodePersisted(meta.saltB64));
    if (!(await verifyVerifier(k, { salt: decodePersisted(meta.verifierSaltB64), iv: decodePersisted(meta.verifierIvB64), ciphertext: decodePersisted(meta.verifierCipherB64) }))) throw new Error("Invalid password");
    return k;
  })();
  const priv = cryptoHexToBytes(input.material.hex);
  let privateKeyTransferred = false;
  try {
    const pub = bytesToHex((await import("@noble/curves/secp256k1.js")).secp256k1.getPublicKey(priv, true));
    const document = keyholdParse(await keyholdExportPrivateKey({ privateKey: priv, password, label: input.label, parameters: keyholdRecommendedParameters() }));
    const record: VaultKeyRecord = { publicKeyHex: pub, label: input.label, address: deriveP2pkhAddress(pub, "main"), network: "main" as const, format: input.format, capabilities: input.capabilities ?? ["p2pkh"], createdAt: new Date().toISOString(), source: input.source, storageVersion: "keyhold-v2", keyholdDocument: document };
    await vaultDb.putKey(record);
    const wasUnlocked = coordinatorState.vaultStatus === "unlocked";
    // keyspaceGeneration 递增；只有 enter 成功后 worker state 才接管 priv。
    const previousGeneration = coordinatorState.keyspaceGeneration;
    const previousPassword = coordinatorState.password;
    const previousStatus = coordinatorState.vaultStatus;
    coordinatorState.keyspaceGeneration++;
    coordinatorState.password = password;
    const storageSecretKey = await deriveStorageSecretKey(password, decodePersisted(meta.saltB64));
    try {
      await enterUnlockedState(passwordKey, storageSecretKey, pub, priv, wasUnlocked ? "activate-key" : initialCause);
    } catch (error) {
      coordinatorState.keyspaceGeneration = previousGeneration;
      coordinatorState.password = previousPassword;
      coordinatorState.vaultStatus = previousStatus;
      throw error;
    }
    privateKeyTransferred = true;
    return { publicKeyHex: pub, label: record.label, address: record.address, network: record.network, format: record.format, capabilities: record.capabilities, createdAt: record.createdAt, source: record.source };
  } finally {
    if (!privateKeyTransferred) priv.fill(0);
  }
}
async function changePasswordRpc(oldPassword: string, newPassword: string): Promise<boolean> {
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
  const oldStorageKey = await deriveStorageSecretKey(oldPassword, decodePersisted(meta.saltB64));
  const oldPasswordKey = await deriveKey(oldPassword, decodePersisted(meta.saltB64));
  const newStorageKey = await deriveStorageSecretKey(newPassword, newSalt);
  const verifier = await (await import("@keymaster/plugin-vault/coordinator")).encryptVerifier(newKey);
  const records = await vaultDb.listKeys();
  for (const record of records) if (record.storageVersion !== "keyhold-v2" || !record.keyholdDocument) throw new Error("Unsupported key storage version");
  const migrated: KeyHoldVaultKeyRecord[] = [];
  for (const record of records) {
    const unlocked = await (await import("keyhold")).unlock((await import("keyhold")).parse((await import("keyhold")).serialize(record.keyholdDocument!)), oldPassword);
    try {
      if (unlocked.publicKeyHex !== record.publicKeyHex) {
        unlocked.privateKey.fill(0);
        throw new Error("KeyHold public key mismatch");
      }
      const nextDoc = (await import("keyhold")).parse(await (await import("keyhold")).exportPrivateKey({ privateKey: unlocked.privateKey, password: newPassword, label: record.keyholdDocument!.label, parameters: (await import("keyhold")).recommendedParameters() }));
      migrated.push({ publicKeyHex: record.publicKeyHex, label: record.label, address: record.address, network: record.network, format: record.format, capabilities: record.capabilities, createdAt: record.createdAt, source: record.source, storageVersion: "keyhold-v2", keyholdDocument: nextDoc });
    } finally { unlocked.privateKey.fill(0); }
  }
  // Re-wrap Storage-owned local secrets behind the same Worker-owned gate.
  // Slow S3 requests are aborted/drained before the journal migration starts.
  const storageWithRotation = storageRuntime as (StorageService & { beginPasswordRotation?: () => Promise<void>; finishPasswordRotation?: (degraded?: boolean) => void }) | undefined;
  let storageRotationDegraded = false;
  try {
    await storageWithRotation?.beginPasswordRotation?.();
    await migrateStorageSecrets(oldStorageKey, newStorageKey, oldPasswordKey);
    try {
      await vaultDb.putMetaAndKeys((await import("@keymaster/plugin-vault/coordinator")).buildVaultMeta({ salt: newSalt, verifier }), migrated);
    } catch (error) {
      // IndexedDB has no cross-database transaction. Roll Storage back if the
      // Vault atomic commit fails, preserving the pre-rotation password. If the
      // compensating write itself fails, surface that fact; the durable journal
      // remains for recovery on the next unlock instead of being silently lost.
      try {
        await rollbackStorageRotation();
      } catch (rollbackError) {
        storageRotationDegraded = true;
        storageWithRotation?.finishPasswordRotation?.(true);
        throw new Error(`Password rotation rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
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
  coordinatorState.passwordKey = undefined;
  coordinatorState.password = undefined;
  coordinatorState.storageSecretKey = undefined;
  passkeyAddIntents.clear();

  coordinatorState.autoLockDeadline = undefined;

  // 这些 release 函数在调用期间只摘除本地句柄；真正的远端退订、连接
  // 关闭和 DB 清理在第二阶段后台执行，并由 releaseSatRuntime 限时。
  // 这样旧 runtime 不会在 locked 状态继续对外提供能力。
  const storageCleanup = releaseStorageRuntime(reason);
  releaseMsfileRuntime(reason);
  const satCleanup = releaseSatRuntime(reason);
  clearWindowP2pExecutorLeaseLocked();

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
    console.warn("[coordinator] locked state metadata persistence failed", error instanceof Error ? error.message : String(error));
  });

  // 任务 completion 只能在仍处于本次 locked epoch 时清理；若期间已经
  // 解锁，新 runtime 的 controller 不能被旧任务迟到完成覆盖。
  void Promise.allSettled(completions).then(() => {
    if (coordinatorState.sessionEpoch !== lockedEpoch) return;
    for (const runtime of coordinatorState.taskRuntimes.values()) runtime.controller = undefined;
  });
  void storageCleanup.catch((error) => console.warn("[storage] locked cleanup failed", error instanceof Error ? error.message : String(error)));
  void satCleanup.catch((error) => console.warn("[sat-subscription] locked cleanup failed", error instanceof Error ? error.message : String(error)));
}

async function handleActivateKey(
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
    const key = await vaultDb.getKey(request.publicKeyHex);
    if (!key || !coordinatorState.passwordKey) throw new Error("Key not found");
    const privateKey = await decryptPrivateKey(coordinatorState.password ?? "", key);
    const previousActive = coordinatorState.activePublicKeyHex;
    const previousBytes = coordinatorState.activePrivateKeyBytes?.slice();
    const previousGeneration = coordinatorState.keyspaceGeneration;
    const previousEpoch = coordinatorState.sessionEpoch;
    const previousSelected = coordinatorMeta.selectedPublicKeyHex;
    // Active key change invalidates the MSFile identity, host and all old
    // supplier connections before the new epoch becomes observable.
    releaseMsfileRuntime("activate-key");
    await releaseSatRuntime("activate-key");
    clearWindowP2pExecutorLeaseLocked();
    replaceActivePrivateKey(privateKey);
    coordinatorState.activePublicKeyHex = request.publicKeyHex;
    coordinatorState.keyspaceGeneration++;
    coordinatorState.sessionEpoch = generateEpoch();
    coordinatorMeta.selectedPublicKeyHex = request.publicKeyHex;
    coordinatorMeta.generation = coordinatorState.keyspaceGeneration;
    try {
      if (previousActive && previousActive !== request.publicKeyHex) {
        await cancelTaskRuntimesByKey(previousActive);
      }
      await persistCoordinatorMeta();
    } catch (error) {
      dropActivePrivateKey();
      if (previousBytes) replaceActivePrivateKey(previousBytes);
      coordinatorState.activePublicKeyHex = previousActive;
      coordinatorState.keyspaceGeneration = previousGeneration;
      coordinatorState.sessionEpoch = previousEpoch;
      coordinatorMeta.selectedPublicKeyHex = previousSelected;
      coordinatorMeta.generation = previousGeneration;
      emitMsFileState();
      throw error;
    } finally {
      if (previousBytes && coordinatorState.activePrivateKeyBytes !== previousBytes) previousBytes.fill(0);
    }

    publishSessionState("activate-key");
    emitMsFileState();

    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: { status: "accepted" },
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
    const result = await executeCryptoOperation(
      request.operation,
      coordinatorState.activePrivateKeyBytes
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
  const interval = request.settings.assetHoldingsIntervalMs;
  if (!Number.isFinite(interval) || interval < 1_000 || interval > 7 * 24 * 60 * 60 * 1000) {
    return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "validation-error", message: "Invalid schedule interval" } };
  }
  coordinatorState.scheduleSettings = request.settings;
  coordinatorMeta.scheduleSettings = request.settings;
  await persistCoordinatorMeta();
  for (const runtime of coordinatorState.taskRuntimes.values()) { runtime.intervalMs = request.settings.assetHoldingsIntervalMs; scheduleRuntime(runtime); }

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
    const db = createP2pkhDb(await openP2pkhDb({ keyspace, publicKeyHex }));
    for (const resource of await db.listResourcesByKey()) await db.clearInProgressSyncState(resource.resourceId);
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
  return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: getP2pkhProviderSnapshot() };
}

async function handleP2pkhSettingsUpdate(
  requestId: string,
  request: Extract<CoordinatorClientRequest, { kind: "p2pkh.settings.update" }>
): Promise<CoordinatorResponse> {
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
  const db = createP2pkhDb(await openP2pkhDb({ keyspace, publicKeyHex: request.ownerPublicKeyHex }));
  const localRows = (await db.listLocalTransactions()).filter((row) => row.network === request.network);
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
      await db.finishLocalSubmission({ submissionId: row.id, localState: "local-confirmed", attempt: { id: `${row.id}:${startedAt}`, submissionId: row.id, providerId: provider.descriptor.id, startedAt, finishedAt, status: result.status, providerReference: result.providerReference, providerCode: result.providerCode, providerMessage: result.providerMessage } });
      publishTopicEvent("asset.data-changed", { type: "asset.data-changed", providerId: "p2pkh", publicKeyHex: request.ownerPublicKeyHex, kinds: ["utxo", "submission", "claim"] });
      return { status: result.status === "already-known" ? "already-known" : "local-confirmed", txid: row.txid } as const;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const finishedAt = new Date().toISOString();
      const attempt = { id: `${row.id}:${startedAt}`, submissionId: row.id, providerId: provider.descriptor.id, startedAt, finishedAt, status: "isolated" as const, providerMessage: message };
      if (previousLocalState === "local-confirmed") {
        // A failed rebroadcast cannot invalidate an earlier accepted or
        // already-known result. Preserve outputs/claims and append the audit.
        await db.finishLocalSubmission({ submissionId: row.id, localState: "local-confirmed", attempt });
      } else {
        await db.finishLocalSubmission({ submissionId: row.id, localState: "isolated", reason: message, attempt });
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
      // hidden by IndexedDB return order; chain confirmation then wins over a
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
  if (coordinatorState.vaultStatus !== "unlocked" || !coordinatorState.activePublicKeyHex) {
    runtime.state = "blocked";
    runtime.blockedReason = "Vault is locked";
    scheduleRuntime(runtime);
    return;
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

  const execution = (async () => {
   try {
    if (runtime.startedEpoch !== coordinatorState.sessionEpoch || runtime.startedGeneration !== coordinatorState.keyspaceGeneration || runtime.startedPublicKeyHex !== coordinatorState.activePublicKeyHex) throw new Error("stale task epoch");
    if (!runtime.run) throw new Error(`Task ${taskId} has no Coordinator handler`);
    await runtime.run({ signal: controller.signal, reason, reportProgress: () => undefined, assertSessionFresh: () => assertTaskFresh(taskId) });
    if (runtime.startedEpoch !== coordinatorState.sessionEpoch || runtime.startedGeneration !== coordinatorState.keyspaceGeneration || runtime.startedPublicKeyHex !== coordinatorState.activePublicKeyHex) throw new Error("stale task result");
    runtime.state = "idle";
    runtime.lastCompletedAt = new Date().toISOString();
    runtime.error = undefined;
   } catch (err) {
    if (controller.signal.aborted) {
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
    runtime.controller = undefined;

    // 若当前 Vault 已锁定或 epoch 已变化，保留 blocked，不得把任务重写为 idle
    if (coordinatorState.vaultStatus !== "unlocked" ||
        runtime.startedEpoch !== coordinatorState.sessionEpoch ||
        runtime.startedGeneration !== coordinatorState.keyspaceGeneration ||
        runtime.startedPublicKeyHex !== coordinatorState.activePublicKeyHex) {
      runtime.state = "blocked";
      runtime.blockedReason = "Vault is locked";
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

function buildSnapshot(): CoordinatorBootstrapSnapshot {
  return {
    sessionEpoch: coordinatorState.sessionEpoch,
    vaultStatus: coordinatorState.vaultStatus,
    activePublicKeyHex: coordinatorState.activePublicKeyHex,
    selectedPublicKeyHex: coordinatorMeta.selectedPublicKeyHex,
    keyspaceGeneration: coordinatorState.keyspaceGeneration,
    taskSnapshots: getTaskSnapshots(),
    scheduleSettings: coordinatorState.scheduleSettings,
    p2pkhProviders: getP2pkhProviderSnapshot(),
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
    ...(topic === "session.state" ? { sessionRevision: ++sessionRevision } : topic === "background.snapshot" ? { backgroundSnapshotRevision: ++backgroundSnapshotRevision } : topic === "storage.state" ? { storageRevision: event.storageRevision } : topic === "msfile.state" ? { msfileRevision: event.msfileRevision } : topic === "p2pkh.providers" ? { providerRevision: ++p2pkhProviderRevision } : topic === "sat.events" ? { satRevision: event.satRevision } : topic === "channel.events" ? { channelRevision: ++channelRevision } : topic === "contacts.presence" ? { presenceRevision: ++contactsPresenceRevision } : { assetDataRevision: ++assetDataRevision }),
    sessionEpoch: coordinatorState.sessionEpoch,
    ...(topic === "background.snapshot" ? { scheduleSettings: coordinatorState.scheduleSettings } : {})
  } as CoordinatorTopicEvent;
  for (const [, connectedPort] of connectedPorts) {
    if (connectedPort.subscriptions.has(topic)) {
      sendToPort(connectedPort.port, normalized);
    }
  }
  return normalized;
}

function sendToPort(port: MessagePort, message: unknown, transfer: ArrayBuffer[] = []): void {
  try {
    port.postMessage(message, transfer);
  } catch {
    // 端口可能已关闭
  }
}

// ============================================================
// 12. Auto-lock Timer
// ============================================================

function resetAutoLockTimer(): void {
  const AUTO_LOCK_TIMEOUT_MS = 15 * 60 * 1000;
  coordinatorState.autoLockDeadline = Date.now() + AUTO_LOCK_TIMEOUT_MS;

  setTimeout(() => {
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

const workerScope = globalThis as unknown as {
  onconnect: ((event: MessageEvent) => void) | null;
};

workerScope.onconnect = handlePortConnect;

// Worker 启动时从 DB 读取仅公开的 Vault metadata
// 状态为 uninitialized 或 locked；绝不读取/解密私钥直到 unlock RPC
async function initializeCoordinator(): Promise<void> {
  try {
    await loadCoordinatorMeta();
    const meta = await getVaultMeta();
    if (meta) {
      coordinatorState.vaultStatus = "locked";
      coordinatorState.activePublicKeyHex = undefined;
      coordinatorState.keyspaceGeneration = coordinatorMeta.generation;
      // Reconcile only the persisted public selection.  This deliberately
      // uses list/get and never parses or unlocks a key document, so opaque
      // legacy records remain visible for locked recovery/delete flows.
      if (!await reconcileSelectedPublicKey()) coordinatorState.vaultStatus = "uninitialized";
    } else {
      coordinatorState.vaultStatus = "uninitialized";
    }
    try { await ensureStorageRuntime(); }
    catch { storageRuntime = undefined; storageDb = undefined; emitStorageState(); }
    await registerCoordinatorTasks();
    // 启动时如果 vault 是 locked 状态，将所有任务标记为 blocked
    if (coordinatorState.vaultStatus === "locked") {
      for (const runtime of coordinatorState.taskRuntimes.values()) {
        runtime.state = "blocked";
        runtime.blockedReason = "Vault is locked";
      }
    }
  } catch {
    coordinatorState.vaultStatus = "fatal";
  } finally {
    // hello 可能先于异步 IndexedDB 初始化抵达。无论初始化成功或失败，
    // 都必须广播最终状态，否则首个页面会永久停留在 booting。
    publishSessionState("bootstrap");
  }
}

void initializeCoordinator();

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

export function __testResetState(): void {
  // releaseSatRuntime 会同步摘除旧 owner 的全局句柄，并把真实退订放入
  // satRuntimeRelease；下一次测试创建 runtime 时会等待该 Promise。
  void releaseSatRuntime("test");
  testPersistCoordinatorMetaFailure = false;
  for (const runtime of coordinatorState.taskRuntimes.values()) {
    runtime.controller?.abort();
    if (runtime.timer) clearTimeout(runtime.timer);
  }
  coordinatorState.sessionEpoch = generateEpoch();
  coordinatorState.vaultStatus = "booting";
  coordinatorState.activePublicKeyHex = undefined;
  dropActivePrivateKey();
  coordinatorState.passwordKey = undefined;
  coordinatorState.password = undefined;
  coordinatorState.storageSecretKey = undefined;
  coordinatorState.keyspaceGeneration = 0;
  coordinatorState.taskRuntimes.clear();
  coordinatorState.autoLockDeadline = undefined;
  coordinatorState.lastActivityAt = Date.now();
  connectedPorts.clear();
  storageRequests.clear();
  storageGrants.clear();
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

/** Test-only seams for the worker-owned P2PKH provider state machine. */
async function ensureTestP2pkhProviders(): Promise<void> {
  if (!p2pkhRegistry) await registerCoordinatorTasks();
}

export async function __testP2pkhProviderConfigUpdate(providerId: string, config: Record<string, unknown>): Promise<CoordinatorResponse> {
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

export async function __testP2pkhProviderConfigGet(providerId: string): Promise<Record<string, unknown>> {
  await ensureTestP2pkhProviders();
  const response = await handleP2pkhProviderConfigGet(`test-p2pkh-config-get-${Date.now()}`, {
    kind: "p2pkh.provider-config.get",
    clientId: "test",
    requestId: `test-p2pkh-config-get-${Date.now()}`,
    providerId,
    expectedSessionEpoch: coordinatorState.sessionEpoch
  });
  return (response.operationResult ?? {}) as Record<string, unknown>;
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
  const db = createP2pkhDb(await openP2pkhDb({ keyspace: createWorkerKeyspace(), publicKeyHex: input.ownerPublicKeyHex }));
  await db.prepareLocalSubmission({ submission: input.submission as never, claims: (input.claims ?? []) as never, localOutpoints: (input.localOutpoints ?? []) as never });
}

export async function __testFinishP2pkhLocalSubmission(input: { ownerPublicKeyHex: string; submissionId: string; localState: "local-confirmed" | "isolated" }): Promise<void> {
  const db = createP2pkhDb(await openP2pkhDb({ keyspace: createWorkerKeyspace(), publicKeyHex: input.ownerPublicKeyHex }));
  await db.finishLocalSubmission({ submissionId: input.submissionId, localState: input.localState });
}

export async function __testSetP2pkhChainResolution(input: { ownerPublicKeyHex: string; submissionId: string; chainResolution: "unresolved" | "chain-confirmed" | "conflicted"; conflictSourceTxids?: string[] }): Promise<void> {
  const db = createP2pkhDb(await openP2pkhDb({ keyspace: createWorkerKeyspace(), publicKeyHex: input.ownerPublicKeyHex }));
  const row = (await db.listLocalTransactions()).find((candidate) => candidate.id === input.submissionId);
  if (!row) throw new Error(`P2PKH submission not found: ${input.submissionId}`);
  const next = { ...row, chainResolution: input.chainResolution, ...(input.chainResolution === "conflicted" ? { conflictSourceTxids: input.conflictSourceTxids ?? ["test-conflict"] } : { conflictSourceTxids: undefined }), ...(input.chainResolution === "chain-confirmed" ? { confirmedFactId: `${row.resourceId}:${row.txid}` } : { confirmedFactId: undefined }) };
  await new Promise<void>((resolve, reject) => {
    const transaction = db.getDb().transaction("p2pkh_local_transactions", "readwrite");
    transaction.objectStore("p2pkh_local_transactions").put(next);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function __testListP2pkhLocalTransactions(ownerPublicKeyHex: string): Promise<unknown[]> {
  const db = createP2pkhDb(await openP2pkhDb({ keyspace: createWorkerKeyspace(), publicKeyHex: ownerPublicKeyHex }));
  return db.listLocalTransactions();
}

export async function __testListP2pkhLocalOutpoints(ownerPublicKeyHex: string): Promise<unknown[]> {
  const db = createP2pkhDb(await openP2pkhDb({ keyspace: createWorkerKeyspace(), publicKeyHex: ownerPublicKeyHex }));
  return db.listLocalOutpoints();
}

export async function __testListP2pkhLocalInputClaims(ownerPublicKeyHex: string): Promise<unknown[]> {
  const db = createP2pkhDb(await openP2pkhDb({ keyspace: createWorkerKeyspace(), publicKeyHex: ownerPublicKeyHex }));
  return db.listLocalInputClaims();
}

export async function __testP2pkhBroadcast(input: { ownerPublicKeyHex: string; network: "main" | "test"; submissionId: string; expectedProviderGeneration: number; expectedSessionEpoch?: SessionEpoch; rebroadcast?: boolean }): Promise<CoordinatorResponse> {
  await ensureTestP2pkhProviders();
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
  return connectedPorts.size;
}

export function __testSetStorageSessionResolver(resolver: ((sessionId: string) => Promise<{ sessionId: string; origin: string; appIdentity: import("@keymaster/contracts").StorageAppContext["appIdentity"]; revokedAt: number | null } | null>) | undefined): void {
  testStorageSessionResolver = resolver;
}

/** Minimal worker seams used by direct ownership/transport regression tests. */
export function __testSetStorageRuntime(runtime: Partial<StorageService> | undefined): void {
  testStorageRuntimeOverride = runtime as StorageService | undefined;
  storageRuntime = testStorageRuntimeOverride;
}

export function __testSetStorageStartupFailure(enabled: boolean): void {
  testStorageStartupFailure = enabled;
  if (!enabled) storageStartupFailure = false;
  if (enabled) { storageRuntime = undefined; storageDb = undefined; }
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
  const run = executeStorageControl({ kind: "storage.control", clientId: "test", requestId: crypto.randomUUID(), control: { type: "status" }, expectedSessionEpoch: coordinatorState.sessionEpoch }).then(() => { completed = true; });
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

export async function __testResolveStorageGrant(grantId: string, actualPortId: string): Promise<import("@keymaster/contracts").StorageAppContext> {
  return (await resolveStorageGrant(grantId, actualPortId)).context;
}

/** MSFile 测试接缝：会话解析与 RPC 分发（施工单 docs/proposals/msfile）。 */
export function __testSetMsfileRuntimeOverride(runtime: Partial<MsFileServiceImpl> | undefined): void {
  msfileRuntime = runtime as MsFileServiceImpl | undefined;
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
  await releaseSatRuntime("test");
}

export async function __testDispatchStorageData(input: { grantId: string; actualPortId: string; requestClientId?: string; connectSessionId?: string }): Promise<CoordinatorResponse> {
  const requestId = crypto.randomUUID();
  return executeStorageRequest({ kind: "storage.data", clientId: input.requestClientId ?? input.actualPortId, requestId, data: { type: "list", grantId: input.grantId, input: {} }, expectedSessionEpoch: coordinatorState.sessionEpoch }, input.actualPortId);
}

export async function __testDispatchStorageControl(control: Extract<CoordinatorStorageControl, { type: "status" }>): Promise<CoordinatorResponse> {
  return executeStorageRequest({ kind: "storage.control", clientId: "test", requestId: crypto.randomUUID(), control, expectedSessionEpoch: coordinatorState.sessionEpoch }, "test");
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
  sendToPort(port, { operationResult: { content: { bytes: responseBytes } } }, [responseBytes]);
  return { inputDetachedByteLength, detachedByteLength: responseBytes.byteLength, receivedByteLength, transferCount };
}

export function __testAttachPort(clientId: string, postMessage: (message: unknown, transfer?: ArrayBuffer[]) => void): void {
  const port = { postMessage, start() {}, close() {}, onmessage: null, onmessageerror: null } as unknown as MessagePort;
  connectedPorts.set(clientId, { port, clientId, subscriptions: new Set(), lastSeenAt: Date.now() });
}

export async function __testDispatchStorageMessage(clientId: string, request: CoordinatorClientRequest): Promise<void> {
  await handleClientMessage(clientId, request);
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

export function __testRegisterTask(input: {
  id: string;
  publicKeyHex: string;
  keyScope?: { publicKeyHex: string } | (() => { publicKeyHex: string } | undefined);
  run(context: { signal: AbortSignal; assertSessionFresh(): void }): Promise<void>;
}): void {
  coordinatorState.taskRuntimes.set(input.id, {
    id: input.id,
    pluginId: "test",
    state: "idle",
    keyScope: input.keyScope ?? { publicKeyHex: input.publicKeyHex },
    run: input.run
  });
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
  await loadCoordinatorMeta();
  const meta = await getVaultMeta();
  coordinatorState.vaultStatus = meta ? "locked" : "uninitialized";
  coordinatorState.activePublicKeyHex = undefined;
  dropActivePrivateKey();
  coordinatorState.passwordKey = undefined;
  coordinatorState.password = undefined;
  coordinatorState.storageSecretKey = undefined;
  if (meta && !await reconcileSelectedPublicKey()) coordinatorState.vaultStatus = "uninitialized";
}

// ============================================================
// 15. Backup Import Test Helpers
// ============================================================

/** 删除 Vault（清理 IndexedDB）。 */
export async function __testDeleteVault(): Promise<void> {
  try {
    // 删除所有 keys
    const keys = await vaultDb.listKeys();
    for (const key of keys) {
      await vaultDb.deleteKeyAndSidecars(key.publicKeyHex);
    }
    // 删除 meta
    await vaultDb.deleteMeta();
  } catch {
    // 忽略错误（可能数据库不存在）
  }
  // 重置内存状态
  coordinatorState.vaultStatus = "uninitialized";
  coordinatorState.activePublicKeyHex = undefined;
  dropActivePrivateKey();
  coordinatorState.passwordKey = undefined;
  coordinatorState.password = undefined;
  coordinatorState.storageSecretKey = undefined;
  coordinatorState.keyspaceGeneration = 0;
}

/** 创建 Vault（空或带初始 key）。 */
export async function __testCreateVault(password: string, options?: { label?: string; capabilities?: string[] }): Promise<{ publicKeyHex?: string }> {
  const result = await executeVaultOperation({ type: "createVaultWithInitialKey", password, label: options?.label ?? "Key", capabilities: options?.capabilities ?? ["p2pkh"] });
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
  return result as { publicKeyHex: string };
}

export async function __testSetActive(publicKeyHex: string): Promise<void> {
  await executeVaultOperation({ type: "setActive", publicKeyHex });
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
  await executeVaultOperation({ type: "deleteKeyMaterial", publicKeyHex });
}

/** Test-only invocation of the single empty-vault finalization operation. */
export async function __testFinalizeEmptyVaultAfterLastKeyDeletion(): Promise<void> {
  await executeVaultOperation({ type: "finalizeEmptyVaultAfterLastKeyDeletion" });
}

/** 导入备份。 */
export async function __testImportKeyBackup(backup: string, sourcePassword: string, targetPassword: string): Promise<{ publicKeyHex: string }> {
  const result = await executeVaultOperation({ type: "importKeyBackup", backup, sourcePassword, targetPassword });
  return result as { publicKeyHex: string };
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
  return processRequest({ kind: "unlock", password, publicKeyHex, requestId: `test-unlock-${Date.now()}`, clientId: "test", expectedSessionEpoch: coordinatorState.sessionEpoch });
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
