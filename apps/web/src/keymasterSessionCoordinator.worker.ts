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
  AssetDataInvalidationEvent,
  SessionStateEvent,
  VaultSealedSecret,
  P2pkhProviderRegistrySnapshot,
  P2pkhProviderSettings,
  P2pkhNetworkProviderSelection,
  P2pkhProviderRegistry,
  P2pkhTransactionBroadcastProvider,
  MsFileExecutorLease,
  MsFileNoiseSignRequest,
  MsFilePeerRecordSignRequest,
  MsFileIdentitySignResult,
} from "@keymaster/contracts";
import { vaultDb, type VaultMetaRecord, type VaultKeyRecord, type KeyHoldVaultKeyRecord, deriveKey, verifyVerifier, hexToBytes as cryptoHexToBytes, base64ToBytes, bytesToHex, decryptBytesWithAad, encryptBytesWithAad, decryptBytesWithSaltBoundAad, encryptBytesWithSaltBoundAad, buildOpenedAppMsgMessage, deriveP2pkhAddress, signEcdsaDigest, verifySessionKeyPair, sealAppMessageLocalBytes, openAppMessageLocalBytes, encryptVerifier, buildVaultMeta, encryptBytes, decryptBytes, encryptMaterialWithPasskey, decryptMaterialWithPasskey, toPasskeySummary } from "@keymaster/plugin-vault/coordinator";
import { exportPrivateKey as keyholdExportPrivateKey, parse as keyholdParse, recommendedParameters as keyholdRecommendedParameters } from "keyhold";
// 不能通过 runtime barrel 导入：它 re-export React hooks，Vite 会把
// React Refresh 注入 SharedWorker，后者没有 window。
import { createMessageBus } from "@keymaster/runtime/messageBus";
import { createWocService, createWocBsv21Service, createWocStasService, createWoc1SatOrdinalsService, registerWocP2pkhProviders } from "@keymaster/plugin-woc/coordinator";
import { createJungleBusClient, registerJungleBusP2pkhProvider } from "@keymaster/plugin-junglebus/coordinator";
import { createP2pkhProviderRegistry } from "@keymaster/plugin-p2pkh/coordinator";
import { createP2pkhCoordinatorTasks, openP2pkhDb, createP2pkhDb } from "@keymaster/plugin-p2pkh/coordinator";
import { createBsv21CoordinatorTask } from "@keymaster/plugin-token-bsv21/coordinator";
import { createStasCoordinatorTask } from "@keymaster/plugin-token-stas/coordinator";
import { createOrdinalsCoordinatorTask } from "@keymaster/plugin-collectible-1satordinals/coordinator";
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
import { createMsFileExecutorTransport, type MsFileExecutorOperation } from "@keymaster/plugin-msfile/executor-transport";
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
import { getConnectSession as getAuthoritativeConnectSession, isVerifiedAppIdentitySnapshot } from "@keymaster/plugin-protocol/coordinator";

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

interface CoordinatorMetaRecord { id: "singleton"; selectedPublicKeyHex?: string; generation: number; scheduleSettings?: CoordinatorBackgroundSyncSettings; p2pkhProviders?: P2pkhProviderSettings; p2pkhProviderConfigs?: Record<string, Record<string, unknown>>; p2pkhSettings?: { includeTestnet: boolean }; }
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
function publishSessionState(cause: SessionStateEvent["cause"]): void {
  publishTopicEvent("session.state", {
    type: "session.state.changed",
    cause,
    vaultStatus: coordinatorState.vaultStatus,
    activePublicKeyHex: coordinatorState.vaultStatus === "unlocked" ? coordinatorState.activePublicKeyHex ?? null : null,
    selectedPublicKeyHex: coordinatorMeta.selectedPublicKeyHex ?? null,
    keyspaceGeneration: coordinatorState.keyspaceGeneration,
  });
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
const msfileRequests = new Map<string, { controller: AbortController; clientId: string; connectSessionId?: string }>();
const msfileRequestKey = (clientId: string, requestId: string): string => `${clientId}\u0000${requestId}`;
/** 两个 identity RPC 的取消句柄；不得与 MSFile 数据面混用。 */
const msfileExecutorIdentityRequests = new Map<string, { controller: AbortController; clientId: string; leaseId: string }>();
const msfileExecutorIdentityRequestKey = (clientId: string, requestId: string): string => `${clientId}\u0000${requestId}`;
const msfileGrants = new Map<string, { context: MsFileConnectAppContext; clientId: string; sessionEpoch: SessionEpoch }>();
// 有界并发：Seed attachment 较大，固定 4 路；Block 较小，允许 8 路。
// 读 attachment 的全局上限是 4 + 8；Stat 另留 4 个轻量槽位，确保大 Read
// 期间 Stat 不会因 attachment 配额耗尽而被阻塞。
const MSFILE_DATA_MAX_ACTIVE = 12;
const MSFILE_STAT_MAX_ACTIVE = 4;
const MSFILE_TOTAL_MAX_ACTIVE = MSFILE_DATA_MAX_ACTIVE + MSFILE_STAT_MAX_ACTIVE;
const MSFILE_SEED_DATA_MAX_ACTIVE = 4;
const MSFILE_BLOCK_DATA_MAX_ACTIVE = 8;
let msfileDataActive = 0;
let msfileStatActive = 0;
let msfileSeedDataActive = 0;
let msfileBlockDataActive = 0;

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
    pendingApprovals: state?.pendingApprovals ?? []
  };
  lastMsFileState = event;
  publishTopicEvent("msfile.state", event);
}

async function ensureMsfileRuntime(): Promise<MsFileServiceImpl> {
  // 审查修复：锁定 / 未初始化 / fatal 状态不得创建 MSFile runtime。
  if (coordinatorState.vaultStatus !== "unlocked") {
    throw msfileError("msfile_unavailable", "MSFile requires an unlocked Vault");
  }
  if (msfileRuntime) return msfileRuntime;
  const service = createMsFileService({
    transport: msfileExecutorTransport,
    notifyStateChange: (_state: MsFileServiceEventState) => emitMsFileState()
  });
  // 服务构造是同步的；DB 打开在内部异步完成，首个 control 调用会等待。
  msfileRuntime = service;
  emitMsFileState();
  return msfileRuntime;
}

function releaseMsfileRuntime(_reason: string): void {
  for (const pending of msfileRequests.values()) pending.controller.abort();
  msfileRequests.clear();
  for (const pending of msfileExecutorIdentityRequests.values()) pending.controller.abort();
  msfileExecutorIdentityRequests.clear();
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
  try {
    // Update durable/session metadata before transferring ownership of the new
    // private-key buffer. A failed metadata write therefore leaves the old
    // active session untouched and the caller still owns `activePrivateKeyBytes`.
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
  const active = () => ({ activePublicKeyHex: coordinatorState.activePublicKeyHex });
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

async function registerCoordinatorTasks(): Promise<void> {
  const keyspace = createWorkerKeyspace();
  const messageBus = createMessageBus();
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
  for (const [requestId, request] of msfileExecutorIdentityRequests) {
    if (request.clientId === clientId) { request.controller.abort(); msfileExecutorIdentityRequests.delete(requestId); }
  }
  for (const [grantId, grant] of msfileGrants) if (grant.clientId === clientId) msfileGrants.delete(grantId);
  if (msfileExecutorLease !== undefined && msfileExecutorLease.clientId === clientId) {
    clearMsFileExecutorLeaseLocked();
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
    if (request.kind === "msfile.executor.acquire") {
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
  if (body instanceof ArrayBuffer) transfers.push(body);
  if (signatureDer instanceof ArrayBuffer) transfers.push(signatureDer);
  if (executorTransfer instanceof ArrayBuffer) transfers.push(executorTransfer);
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
        supplierGeneration: 0, globalSettings: null, pendingApprovals: []
      };
      return [{ topic, baselineRevision, sessionEpoch: coordinatorState.sessionEpoch, snapshot: cached }];
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

function isMsfileRequest(request: CoordinatorClientRequest): boolean {
  return (
    request.kind === "msfile.grant" ||
    request.kind === "msfile.control" ||
    request.kind === "msfile.data" ||
    request.kind === "msfile.cancel" ||
    request.kind === "msfile.session.abort" ||
    request.kind === "msfile.executor.acquire" ||
    request.kind === "msfile.executor.release" ||
    request.kind === "msfile.executor.spike.transfer" ||
    request.kind === "msfile.executor.identity.sign-noise" ||
    request.kind === "msfile.executor.identity.sign-peer-record"
  );
}

// 审查修复：控制面 mutation 必须串行。SharedWorker 的 onmessage 不等待前一个
// 请求结束，多端口可并发进入 executeMsfileControl；不串行化时同世代检查与
// “读取旧策略—合并—写回”都会互相覆盖。
let msfileMutationTail: Promise<void> = Promise.resolve();

/* ---------- MSFile executor lease（施工单 001 §3.2） ----------
 * Coordinator 内存真值：同一 epoch+owner 同时最多一个 Window executor。
 * lock / key switch / Worker 重启直接清空；port 断开立即回收。 */
interface MsFileExecutorLeaseState extends MsFileExecutorLease {
  clientId: string;
  ownerPublicKeyHex: string;
  acquiredAt: number;
  lastPeerRecordSequence?: bigint;
  /** 生产 Window executor 的专用数据面通道；Spike lease 没有此字段。 */
  transportPort?: MessagePort;
  transportReady: boolean;
}
let msfileExecutorLease: MsFileExecutorLeaseState | undefined;

interface MsFileExecutorBridgePending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  leaseId: string;
  cleanup?: () => void;
  reservedBytes: number;
}
const msfileExecutorBridgePending = new Map<string, MsFileExecutorBridgePending>();
const MSFILE_EXECUTOR_BRIDGE_MAX_IN_FLIGHT_BYTES = 4 * 16 * 1024 * 1024 + 8 * 256 * 1024;
let msfileExecutorBridgeInFlightBytes = 0;

const MSFILE_EXECUTOR_LEASE_TTL_MS = 5 * 60 * 1000;
// Spike RPC 的有界 pre-sign cancellation window：只影响尚未接入生产数据面的
// executor identity 通道，用于让跨 tab lifecycle 事件可靠越过二次栅栏。
const MSFILE_EXECUTOR_PRE_SIGN_YIELD_MS = 25;
const MSFILE_EXECUTOR_TRANSFER_MAX_ITEMS = 5;
const MSFILE_EXECUTOR_TRANSFER_MAX_BYTES = 17 * 1024 * 1024;
const MSFILE_EXECUTOR_TRANSFER_MAX_ITEM_BYTES = 16 * 1024 * 1024;
const UINT64_MAX = (1n << 64n) - 1n;
let msfileExecutorLeaseTimer: ReturnType<typeof setTimeout> | undefined;
let msfileExecutorIdentityTail: Promise<void> = Promise.resolve();
let msfileExecutorTransferPendingItems = 0;
let msfileExecutorTransferPendingBytes = 0;
let msfileExecutorTransferPeakBytes = 0;

function rejectMsfileExecutorBridgePending(error: Error): void {
  for (const [requestId, pending] of msfileExecutorBridgePending) {
    msfileExecutorBridgePending.delete(requestId);
    msfileExecutorBridgeInFlightBytes = Math.max(0, msfileExecutorBridgeInFlightBytes - pending.reservedBytes);
    pending.cleanup?.();
    pending.reject(error);
  }
}

function handleMsfileExecutorPortMessage(event: MessageEvent): void {
  const data = event.data as { type?: string; leaseId?: string; requestId?: string; ok?: boolean; result?: unknown; errorMessage?: string } | undefined;
  if (!data || data.type === undefined) return;
  const lease = msfileExecutorLease;
  if (!lease || data.leaseId !== lease.leaseId) return;
  if (data.type === "ready") {
    lease.transportReady = data.ok === true;
    if (!lease.transportReady) {
      clearMsFileExecutorLeaseLocked();
    }
    emitMsFileState();
    return;
  }
  if (data.type !== "response" || typeof data.requestId !== "string") return;
  const pending = msfileExecutorBridgePending.get(data.requestId);
  if (!pending || pending.leaseId !== lease.leaseId) return;
  msfileExecutorBridgePending.delete(data.requestId);
  msfileExecutorBridgeInFlightBytes = Math.max(0, msfileExecutorBridgeInFlightBytes - pending.reservedBytes);
  pending.cleanup?.();
  if (data.ok === true) pending.resolve(data.result);
  else pending.reject(new Error(typeof data.errorMessage === "string" ? data.errorMessage : "MSFile executor request failed"));
}

function attachMsfileExecutorPort(port: MessagePort, clientId: string, leaseId: string): void {
  if (!port || typeof port.postMessage !== "function" || typeof port.start !== "function") {
    throw new Error("invalid MSFile executor port");
  }
  const lease = msfileExecutorLease;
  if (!lease || lease.clientId !== clientId || lease.leaseId !== leaseId) {
    try { port.close(); } catch { /* already closed */ }
    return;
  }
  lease.transportPort = port;
  lease.transportReady = false;
  port.onmessage = handleMsfileExecutorPortMessage;
  port.onmessageerror = () => {
    if (msfileExecutorLease?.leaseId === leaseId) clearMsFileExecutorLeaseLocked();
  };
  port.start();
}

function requestMsfileExecutorOperation(operation: MsFileExecutorOperation, signal?: AbortSignal): Promise<unknown> {
  const lease = msfileExecutorLease;
  if (!lease || !lease.transportPort || !lease.transportReady || lease.sessionEpoch !== coordinatorState.sessionEpoch) {
    return Promise.reject(msfileError("msfile_unavailable", "MSFile Window executor is unavailable"));
  }
  const requestId = `msfile-exec-data-${crypto.randomUUID()}`;
  const request = { type: "request", leaseId: lease.leaseId, requestId, operation };
  return new Promise<unknown>((resolve, reject) => {
    const reservedBytes = operation.type === "read"
      ? operation.kind === "block" ? 256 * 1024 : 16 * 1024 * 1024
      : 0;
    if (msfileExecutorBridgeInFlightBytes + reservedBytes > MSFILE_EXECUTOR_BRIDGE_MAX_IN_FLIGHT_BYTES) {
      reject(msfileError("msfile_unavailable", "MSFile executor transfer limit exceeded"));
      return;
    }
    msfileExecutorBridgeInFlightBytes += reservedBytes;
    const pending: MsFileExecutorBridgePending = { resolve, reject, leaseId: lease.leaseId, reservedBytes };
    msfileExecutorBridgePending.set(requestId, pending);
    const onAbort = () => {
      if (!msfileExecutorBridgePending.delete(requestId)) return;
      msfileExecutorBridgeInFlightBytes = Math.max(0, msfileExecutorBridgeInFlightBytes - pending.reservedBytes);
      try { lease.transportPort?.postMessage({ type: "cancel", leaseId: lease.leaseId, requestId }); } catch { /* executor may be gone */ }
      reject(new DOMException("The operation was aborted", "AbortError"));
    };
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
      pending.cleanup = () => signal.removeEventListener("abort", onAbort);
    }
    try {
      lease.transportPort!.postMessage(request);
    } catch (error) {
      if (msfileExecutorBridgePending.delete(requestId)) {
        msfileExecutorBridgeInFlightBytes = Math.max(0, msfileExecutorBridgeInFlightBytes - pending.reservedBytes);
        pending.cleanup?.();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  });
}

const msfileExecutorTransport = createMsFileExecutorTransport({
  get available() {
    return msfileExecutorLease?.transportReady === true
      && msfileExecutorLease.sessionEpoch === coordinatorState.sessionEpoch
      && coordinatorState.vaultStatus === "unlocked";
  },
  request: requestMsfileExecutorOperation,
  dispose: () => undefined,
});

function clearMsFileExecutorLeaseTimer(): void {
  if (msfileExecutorLeaseTimer !== undefined) clearTimeout(msfileExecutorLeaseTimer);
  msfileExecutorLeaseTimer = undefined;
}

function scheduleMsFileExecutorLeaseExpiry(leaseId: string, acquiredAt: number): void {
  clearMsFileExecutorLeaseTimer();
  const remaining = Math.max(0, MSFILE_EXECUTOR_LEASE_TTL_MS - (Date.now() - acquiredAt));
  msfileExecutorLeaseTimer = setTimeout(() => {
    msfileExecutorLeaseTimer = undefined;
    if (msfileExecutorLease?.leaseId === leaseId && Date.now() - msfileExecutorLease.acquiredAt >= MSFILE_EXECUTOR_LEASE_TTL_MS) {
      clearMsFileExecutorLeaseLocked();
      emitMsFileState();
    }
  }, remaining);
}

function clearMsFileExecutorLeaseLocked(): void {
  clearMsFileExecutorLeaseTimer();
  if (msfileExecutorLease === undefined) return;
  const oldLease = msfileExecutorLease;
  rejectMsfileExecutorBridgePending(new Error("MSFile Window executor lease was revoked"));
  try { oldLease.transportPort?.postMessage({ type: "revoked", leaseId: oldLease.leaseId }); } catch { /* executor may be gone */ }
  try { oldLease.transportPort?.close(); } catch { /* already closed */ }
  for (const [requestId, pending] of msfileExecutorIdentityRequests) {
    if (pending.leaseId === oldLease.leaseId) {
      pending.controller.abort();
      msfileExecutorIdentityRequests.delete(requestId);
    }
  }
  msfileExecutorLease = undefined;
}

function acquireMsFileExecutorLease(input: {
  clientId: string;
  ownerPublicKeyHex: string;
}): { ok: true; lease: MsFileExecutorLease } | { ok: false; reason: "locked" | "stale-epoch" | "owner-mismatch" | "busy" } {
  if (coordinatorState.vaultStatus !== "unlocked") return { ok: false, reason: "locked" };
  if (!coordinatorState.activePublicKeyHex || input.ownerPublicKeyHex !== coordinatorState.activePublicKeyHex) {
    return { ok: false, reason: "owner-mismatch" };
  }
  if (msfileExecutorLease !== undefined) {
    // 同 port 幂等续租；跨 port / 跨 owner 冲突一律拒绝。
    if (msfileExecutorLease.clientId === input.clientId && msfileExecutorLease.ownerPublicKeyHex === input.ownerPublicKeyHex) {
      msfileExecutorLease.acquiredAt = Date.now();
      scheduleMsFileExecutorLeaseExpiry(msfileExecutorLease.leaseId, msfileExecutorLease.acquiredAt);
      return { ok: true, lease: { leaseId: msfileExecutorLease.leaseId, sessionEpoch: msfileExecutorLease.sessionEpoch, activePublicKeyHex: msfileExecutorLease.ownerPublicKeyHex } };
    }
    // 有界 TTL：超过租期视为旧 executor 已死，允许接管。
    if (Date.now() - msfileExecutorLease.acquiredAt < MSFILE_EXECUTOR_LEASE_TTL_MS) {
      return { ok: false, reason: "busy" };
    }
    clearMsFileExecutorLeaseLocked();
  }
  const leaseId = `msfile-exec-lease-${crypto.randomUUID()}`;
  msfileExecutorLease = {
    leaseId,
    clientId: input.clientId,
    ownerPublicKeyHex: input.ownerPublicKeyHex,
    sessionEpoch: coordinatorState.sessionEpoch,
    activePublicKeyHex: input.ownerPublicKeyHex,
    acquiredAt: Date.now(),
    transportReady: false
  };
  scheduleMsFileExecutorLeaseExpiry(leaseId, msfileExecutorLease.acquiredAt);
  return { ok: true, lease: { leaseId, sessionEpoch: msfileExecutorLease.sessionEpoch, activePublicKeyHex: input.ownerPublicKeyHex } };
}

function executorIdentityError(requestId: string, message: string, status: "error" | "validation-error" = "error"): CoordinatorResponse {
  return { requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: status === "error" ? { status, message, code: "msfile_unavailable" } : { status, message } };
}

function parseUint64Decimal(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("Peer Record sequence must be canonical uint64 decimal");
  const sequence = BigInt(value);
  if (sequence > UINT64_MAX) throw new Error("Peer Record sequence exceeds uint64");
  return sequence;
}

function currentExecutorPublicKey(): Uint8Array {
  if (!coordinatorState.activePublicKeyHex || !coordinatorState.activePrivateKeyBytes) throw new Error("MSFile executor active key is unavailable");
  verifySessionKeyPair({ publicKeyHex: coordinatorState.activePublicKeyHex, privateKeyBytes: coordinatorState.activePrivateKeyBytes });
  return validatePublicKey(cryptoHexToBytes(coordinatorState.activePublicKeyHex));
}

function executorLeaseIsCurrent(leaseId: string, actualClientId: string, expectedSessionEpoch: SessionEpoch): MsFileExecutorLeaseState {
  const lease = msfileExecutorLease;
  if (
    lease === undefined ||
    lease.leaseId !== leaseId ||
    lease.clientId !== actualClientId ||
    lease.sessionEpoch !== expectedSessionEpoch ||
    lease.sessionEpoch !== coordinatorState.sessionEpoch ||
    lease.ownerPublicKeyHex !== coordinatorState.activePublicKeyHex ||
    lease.activePublicKeyHex !== coordinatorState.activePublicKeyHex ||
    coordinatorState.vaultStatus !== "unlocked"
  ) throw new Error("MSFile executor lease is not valid");
  if (Date.now() - lease.acquiredAt >= MSFILE_EXECUTOR_LEASE_TTL_MS) {
    clearMsFileExecutorLeaseLocked();
    throw new Error("MSFile executor lease expired");
  }
  return lease;
}

function assertExecutorIdentityStillCurrent(lease: MsFileExecutorLeaseState, actualClientId: string, expectedSessionEpoch: SessionEpoch, publicKeyHex: string): void {
  const fresh = executorLeaseIsCurrent(lease.leaseId, actualClientId, expectedSessionEpoch);
  if (fresh !== lease || fresh.ownerPublicKeyHex !== publicKeyHex || coordinatorState.activePublicKeyHex !== publicKeyHex) {
    throw new Error("MSFile executor identity changed during signing");
  }
}

async function executeMsfileExecutorIdentitySign(
  request: Extract<CoordinatorClientRequest, { kind: "msfile.executor.identity.sign-noise" | "msfile.executor.identity.sign-peer-record" }>,
  actualClientId: string,
  signal: AbortSignal
): Promise<CoordinatorResponse> {
  const lease = executorLeaseIsCurrent(request.leaseId, actualClientId, request.expectedSessionEpoch);
  const publicKeyHex = coordinatorState.activePublicKeyHex!;
  const publicKey = currentExecutorPublicKey();
  if (signal.aborted) throw new Error("MSFile identity signing was cancelled");

  let digest: Uint8Array;
  let peerRecordSequence: bigint | undefined;
  if (request.kind === "msfile.executor.identity.sign-noise") {
    const staticKey = new Uint8Array(request.noiseStaticPublicKey);
    if (staticKey.byteLength !== 32) throw new Error("Noise static public key must be exactly 32 bytes");
    digest = sha256Bytes(noiseSigningPayload(staticKey));
  } else {
    if (!Array.isArray(request.addresses) || request.addresses.length !== 0) {
      throw new Error("Signed Peer Record addresses must be empty in the MSFile executor spike");
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
  await new Promise<void>((resolve) => setTimeout(resolve, MSFILE_EXECUTOR_PRE_SIGN_YIELD_MS));
  if (signal.aborted) throw new Error("MSFile identity signing was cancelled");
  assertExecutorIdentityStillCurrent(lease, actualClientId, request.expectedSessionEpoch, publicKeyHex);

  const signature = await signEcdsaDigest({ privateKeyBytes: coordinatorState.activePrivateKeyBytes!, digest, format: "der" });
  assertExecutorIdentityStillCurrent(lease, actualClientId, request.expectedSessionEpoch, publicKeyHex);
  if (signal.aborted) throw new Error("MSFile identity signing was cancelled");
  if (request.kind === "msfile.executor.identity.sign-peer-record") {
    if (peerRecordSequence === undefined) throw new Error("Peer Record sequence was not retained");
    lease.lastPeerRecordSequence = peerRecordSequence;
  }
  lease.acquiredAt = Date.now();
  scheduleMsFileExecutorLeaseExpiry(lease.leaseId, lease.acquiredAt);
  return {
    requestId: request.requestId,
    sessionEpoch: coordinatorState.sessionEpoch,
    ack: { status: "ok" },
    operationResult: { signatureDer: signature.slice().buffer as ArrayBuffer } satisfies MsFileIdentitySignResult
  };
}

function enqueueMsfileExecutorIdentitySign(
  request: Extract<CoordinatorClientRequest, { kind: "msfile.executor.identity.sign-noise" | "msfile.executor.identity.sign-peer-record" }>,
  actualClientId: string,
  signal: AbortSignal
): Promise<CoordinatorResponse> {
  const run = msfileExecutorIdentityTail.then(
    () => executeMsfileExecutorIdentitySign(request, actualClientId, signal),
    () => executeMsfileExecutorIdentitySign(request, actualClientId, signal)
  );
  msfileExecutorIdentityTail = run.then(() => undefined, () => undefined);
  return run;
}

const MSFILE_MUTATION_CONTROLS = new Set<CoordinatorMsFileControl["type"]>([
  "settings.global.update",
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
  // 有界并发：超过上限直接失败（不静默排队无限请求）。
  if (
    msfileDataActive >= MSFILE_TOTAL_MAX_ACTIVE ||
    (data.type === "stat" && msfileStatActive >= MSFILE_STAT_MAX_ACTIVE) ||
    (data.type === "read-seed" && (msfileSeedDataActive >= MSFILE_SEED_DATA_MAX_ACTIVE || msfileDataActive - msfileStatActive >= MSFILE_DATA_MAX_ACTIVE)) ||
    (data.type === "read-block" && (msfileBlockDataActive >= MSFILE_BLOCK_DATA_MAX_ACTIVE || msfileDataActive - msfileStatActive >= MSFILE_DATA_MAX_ACTIVE))
  ) {
    throw msfileError("msfile_unavailable", "Too many concurrent MSFile requests");
  }
  msfileDataActive += 1;
  if (data.type === "stat") msfileStatActive += 1;
  if (data.type === "read-seed") msfileSeedDataActive += 1;
  if (data.type === "read-block") msfileBlockDataActive += 1;
  try {
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
  } finally {
    msfileDataActive = Math.max(0, msfileDataActive - 1);
    if (data.type === "stat") msfileStatActive = Math.max(0, msfileStatActive - 1);
    if (data.type === "read-seed") msfileSeedDataActive = Math.max(0, msfileSeedDataActive - 1);
    if (data.type === "read-block") msfileBlockDataActive = Math.max(0, msfileBlockDataActive - 1);
  }
}

type MsFileExecutorSpikeRequest = Extract<CoordinatorClientRequest, { kind: "msfile.executor.acquire" | "msfile.executor.release" | "msfile.executor.spike.transfer" | "msfile.executor.identity.sign-noise" | "msfile.executor.identity.sign-peer-record" }>;

async function executeMsfileExecutorRequest(request: MsFileExecutorSpikeRequest, actualClientId: string): Promise<CoordinatorResponse> {
  if (request.kind === "msfile.executor.acquire") {
    if (request.expectedSessionEpoch !== coordinatorState.sessionEpoch) {
      return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "stale-epoch" } };
    }
    if (request.executorPort && (typeof request.executorPort.postMessage !== "function" || typeof request.executorPort.start !== "function")) {
      try { request.executorPort.close(); } catch { /* malformed transferred value */ }
      return executorIdentityError(request.requestId, "invalid MSFile executor port", "validation-error");
    }
    const result = acquireMsFileExecutorLease({ clientId: actualClientId, ownerPublicKeyHex: request.ownerPublicKeyHex });
    if (!result.ok) {
      try { request.executorPort?.close(); } catch { /* already detached */ }
      return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "error", message: `MSFile executor lease rejected: ${result.reason}`, code: "msfile_unavailable" } };
    }
    if (request.executorPort) {
      try {
        attachMsfileExecutorPort(request.executorPort, actualClientId, result.lease.leaseId);
      } catch (error) {
        clearMsFileExecutorLeaseLocked();
        return executorIdentityError(request.requestId, error instanceof Error ? error.message : "invalid MSFile executor port", "validation-error");
      }
    }
    emitMsFileState();
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" }, operationResult: result.lease };
  }
  if (request.kind === "msfile.executor.release") {
    if (msfileExecutorLease !== undefined && msfileExecutorLease.leaseId === request.leaseId && msfileExecutorLease.clientId === actualClientId) {
      clearMsFileExecutorLeaseLocked();
    }
    emitMsFileState();
    return { requestId: request.requestId, sessionEpoch: coordinatorState.sessionEpoch, ack: { status: "ok" } };
  }
  if (request.kind === "msfile.executor.spike.transfer") {
    executorLeaseIsCurrent(request.leaseId, actualClientId, request.expectedSessionEpoch);
    if (!(request.bytes instanceof ArrayBuffer)) return executorIdentityError(request.requestId, "MSFile executor transfer requires an ArrayBuffer", "validation-error");
    if (request.bytes.byteLength > MSFILE_EXECUTOR_TRANSFER_MAX_ITEM_BYTES) return executorIdentityError(request.requestId, "MSFile executor transfer item exceeds the byte limit", "validation-error");
    if (msfileExecutorTransferPendingItems === 0) msfileExecutorTransferPeakBytes = 0;
    if (msfileExecutorTransferPendingItems + 1 > MSFILE_EXECUTOR_TRANSFER_MAX_ITEMS) return executorIdentityError(request.requestId, "MSFile executor transfer queue reached the item limit", "validation-error");
    if (msfileExecutorTransferPendingBytes + request.bytes.byteLength > MSFILE_EXECUTOR_TRANSFER_MAX_BYTES) return executorIdentityError(request.requestId, "MSFile executor transfer queue reached the byte limit", "validation-error");
    msfileExecutorTransferPendingItems += 1;
    msfileExecutorTransferPendingBytes += request.bytes.byteLength;
    msfileExecutorTransferPeakBytes = Math.max(msfileExecutorTransferPeakBytes, msfileExecutorTransferPendingBytes);
    const acceptedPendingBytes = msfileExecutorTransferPendingBytes;
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, MSFILE_EXECUTOR_PRE_SIGN_YIELD_MS));
      executorLeaseIsCurrent(request.leaseId, actualClientId, request.expectedSessionEpoch);
      return {
        requestId: request.requestId,
        sessionEpoch: coordinatorState.sessionEpoch,
        ack: { status: "ok" },
        operationResult: { bytes: request.bytes, acceptedPendingBytes, peakPendingBytes: msfileExecutorTransferPeakBytes }
      };
    } finally {
      msfileExecutorTransferPendingItems = Math.max(0, msfileExecutorTransferPendingItems - 1);
      msfileExecutorTransferPendingBytes = Math.max(0, msfileExecutorTransferPendingBytes - request.bytes.byteLength);
    }
  }
  const controller = new AbortController();
  const key = msfileExecutorIdentityRequestKey(actualClientId, request.requestId);
  msfileExecutorIdentityRequests.set(key, { controller, clientId: actualClientId, leaseId: request.leaseId });
  try {
    return await enqueueMsfileExecutorIdentitySign(request, actualClientId, controller.signal);
  } catch (error) {
    return executorIdentityError(request.requestId, error instanceof Error ? error.message : String(error));
  } finally {
    msfileExecutorIdentityRequests.delete(key);
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
    for (const [requestId, pending] of msfileExecutorIdentityRequests) {
      if (pending.clientId === actualClientId) { pending.controller.abort(); msfileExecutorIdentityRequests.delete(requestId); }
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
    const identityTarget = msfileExecutorIdentityRequests.get(msfileExecutorIdentityRequestKey(actualClientId, request.targetRequestId));
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
      default:
        return {
          requestId,
          sessionEpoch: coordinatorState.sessionEpoch,
          ack: { status: "validation-error", message: "Unknown request kind" },
        };
    }
  } catch (err) {
    return {
      requestId,
      sessionEpoch: coordinatorState.sessionEpoch,
      ack: {
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

async function processRequest(request: CoordinatorClientRequest, actualClientId = (request as { clientId?: string }).clientId ?? "unknown"): Promise<CoordinatorResponse> {
  if (isStorageRequest(request)) return executeStorageRequest(request as never, actualClientId);
  if (isMsfileRequest(request)) {
    if (request.kind === "msfile.executor.acquire" || request.kind === "msfile.executor.release" || request.kind === "msfile.executor.spike.transfer" || request.kind === "msfile.executor.identity.sign-noise" || request.kind === "msfile.executor.identity.sign-peer-record") {
      return executeMsfileExecutorRequest(request as MsFileExecutorSpikeRequest, actualClientId);
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
      replaceActivePrivateKey(bytes);
      coordinatorState.activePublicKeyHex = key.publicKeyHex;
      coordinatorState.keyspaceGeneration++;
      coordinatorState.sessionEpoch = generateEpoch();
      passkeyAddIntents.clear();
      // 施工单 docs/proposals/msfile：active key 切换立即销毁旧 MSFile runtime
      // （wire 身份随 owner 公钥变化，旧 host/连接/授权不可继续使用）。
      releaseMsfileRuntime("activate-key");
      clearMsFileExecutorLeaseLocked();
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
  // Storage is preempted before Vault keys are cleared; no S3 network cleanup
  // is allowed to delay destruction of the client or credential material.
  await releaseStorageRuntime(reason);
  // 施工单 docs/proposals/msfile：lock 时销毁 MSFile runtime，未决请求与确认取消。
  releaseMsfileRuntime(reason);
  clearMsFileExecutorLeaseLocked();
  // abort 所有 session-bound task，并在清空运行句柄前保留 completion，确保
  // handler 已经退出；否则迟到的 DB commit 可能越过锁定栅栏。
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
  await Promise.allSettled(completions);
  for (const runtime of coordinatorState.taskRuntimes.values()) runtime.controller = undefined;

  // 覆盖私钥 buffer
  if (coordinatorState.activePrivateKeyBytes) {
    coordinatorState.activePrivateKeyBytes.fill(0);
  }

  // 撤销 capability、清空 active key
  coordinatorState.activePublicKeyHex = undefined;
    dropActivePrivateKey();
  coordinatorState.passwordKey = undefined;
  coordinatorState.password = undefined;
  coordinatorState.storageSecretKey = undefined;
  passkeyAddIntents.clear();

  // 递增 epoch
  coordinatorState.sessionEpoch = generateEpoch();
  coordinatorState.vaultStatus = reason === "recover-empty" || reason === "empty-vault" ? "uninitialized" : "locked";

  coordinatorState.keyspaceGeneration++;
  if (reason === "empty-vault" || reason === "recover-empty") coordinatorMeta.selectedPublicKeyHex = undefined;
  coordinatorMeta.generation = coordinatorState.keyspaceGeneration;
  await persistCoordinatorMeta();
  publishSessionState(reason === "key-deleted" || reason === "empty-vault" ? "delete-active-key" : reason === "recover-empty" ? "recover-empty-vault" : "lock");
  emitMsFileState();
  emitStorageState();

  // 广播任务快照，让 UI 立即显示 blocked 状态
  publishTopicEvent("background.snapshot", {
    type: "background.snapshot.changed",
    sessionEpoch: coordinatorState.sessionEpoch,
    snapshots: getTaskSnapshots(),
  });

  // 清除自动锁定 timer
  if (coordinatorState.autoLockDeadline) {
    coordinatorState.autoLockDeadline = undefined;
  }
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
    clearMsFileExecutorLeaseLocked();
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
    case "sealSendInput": { const i = operation.input; const sealed = sealAppMessageLocalBytes({ senderPrivateKeyBytes: privateKeyBytes, senderPublicKeyBytes: cryptoHexToBytes(coordinatorState.activePublicKeyHex!), recipientPublicKeyBytes: cryptoHexToBytes(i.recipient.recipientPublicKeyHex), senderEndpoint: i.sender.senderOrigin ? { kind: "origin", id: i.sender.senderOrigin } : { kind: "plugin", id: i.sender.senderAppId ?? "" }, recipientEndpoint: i.recipient.recipientOrigin ? { kind: "origin", id: i.recipient.recipientOrigin } : { kind: "plugin", id: i.recipient.recipientAppId ?? "" }, contentType: i.contentType, body: i.body, clientMessageId: i.clientMessageId, createdAtMs: i.createdAtMs }); return { type: "sealSendInput", envelope: sealed.envelope, signature: sealed.signatureBytes }; }
    case "openSealed": { const r = operation.record; const opened = openAppMessageLocalBytes({ signed: { envelopeBytes: new Uint8Array(r.envelope.envelopeBytes), signatureBytes: new Uint8Array(r.envelope.signatureBytes) }, recipientPrivateKeyBytes: privateKeyBytes, recipientPublicKeyBytes: cryptoHexToBytes(coordinatorState.activePublicKeyHex!) }); return { type: "openSealed", plaintext: new TextEncoder().encode(JSON.stringify(buildOpenedAppMsgMessage(r, opened))) }; }
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
    if (resolveKeyScope(runtime)?.publicKeyHex !== publicKeyHex) continue;
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
// 10. Ordinary P2PKH provider registry and broadcast RPC
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

function publishTopicEvent(topic: CoordinatorTopic, event: any): void {
  const normalized = {
    ...event,
    topic,
    ...(topic === "session.state" ? { sessionRevision: ++sessionRevision } : topic === "background.snapshot" ? { backgroundSnapshotRevision: ++backgroundSnapshotRevision } : topic === "storage.state" ? { storageRevision: event.storageRevision } : topic === "msfile.state" ? { msfileRevision: event.msfileRevision } : topic === "p2pkh.providers" ? { providerRevision: ++p2pkhProviderRevision } : { assetDataRevision: ++assetDataRevision }),
    sessionEpoch: coordinatorState.sessionEpoch,
    ...(topic === "background.snapshot" ? { scheduleSettings: coordinatorState.scheduleSettings } : {})
  } as CoordinatorTopicEvent;
  for (const [, connectedPort] of connectedPorts) {
    if (connectedPort.subscriptions.has(topic)) {
      sendToPort(connectedPort.port, normalized);
    }
  }
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

export function __testGetSnapshot(): CoordinatorBootstrapSnapshot {
  return buildSnapshot();
}

export function __testResetState(): void {
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
  msfileDataActive = 0;
  msfileStatActive = 0;
  msfileSeedDataActive = 0;
  msfileBlockDataActive = 0;
  rejectMsfileExecutorBridgePending(new Error("MSFile Coordinator runtime restarted"));
  msfileExecutorBridgeInFlightBytes = 0;
  msfileRuntime = undefined;
  lastMsFileState = undefined;
  msfileMutationTail = Promise.resolve();
  clearMsFileExecutorLeaseLocked();
  msfileExecutorIdentityTail = Promise.resolve();
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
  return processRequest({ kind: "msfile.executor.acquire", clientId, requestId: crypto.randomUUID(), ownerPublicKeyHex, expectedSessionEpoch }, clientId);
}

export async function __testReleaseExecutorLease(leaseId: string, clientId = "port-exec"): Promise<CoordinatorResponse> {
  return processRequest({ kind: "msfile.executor.release", clientId, requestId: crypto.randomUUID(), leaseId }, clientId);
}

export async function __testExecutorSignNoise(input: { leaseId: string; expectedSessionEpoch?: SessionEpoch; noiseStaticPublicKey: ArrayBuffer }, clientId = "port-exec"): Promise<CoordinatorResponse> {
  const request = { kind: "msfile.executor.identity.sign-noise" as const, clientId, requestId: crypto.randomUUID(), leaseId: input.leaseId, expectedSessionEpoch: input.expectedSessionEpoch ?? coordinatorState.sessionEpoch, noiseStaticPublicKey: input.noiseStaticPublicKey };
  return executeMsfileExecutorRequest(request, clientId);
}

export async function __testExecutorSignPeerRecord(input: { leaseId: string; expectedSessionEpoch?: SessionEpoch; peerId: string; addresses: string[]; sequence: string }, clientId = "port-exec"): Promise<CoordinatorResponse> {
  const request = { kind: "msfile.executor.identity.sign-peer-record" as const, clientId, requestId: crypto.randomUUID(), leaseId: input.leaseId, expectedSessionEpoch: input.expectedSessionEpoch ?? coordinatorState.sessionEpoch, peerId: input.peerId, addresses: input.addresses, sequence: input.sequence };
  return executeMsfileExecutorRequest(request, clientId);
}

export async function __testReleaseMsfileRuntime(): Promise<void> {
  releaseMsfileRuntime("test");
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
  run(context: { signal: AbortSignal; assertSessionFresh(): void }): Promise<void>;
}): void {
  coordinatorState.taskRuntimes.set(input.id, {
    id: input.id,
    pluginId: "test",
    state: "idle",
    keyScope: { publicKeyHex: input.publicKeyHex },
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
