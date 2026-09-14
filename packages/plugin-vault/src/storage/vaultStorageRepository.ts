// Vault 的 V1 存储边界。
//
// 这里的 K-V 句柄只承载公开元数据和生命周期日志：
//   - authMetadata：密码 verifier/KDF 元数据；
//   - keyIndex：Key 列表展示所需的公开元数据；
//   - keyLifecycleJournals：Add/Delete 共用的按公钥生命周期事务认领和
//     跨重启补偿日志。
//
// 私钥密文不属于任何一个 K-V store。它只能经由 Coordinator 注入的
// VaultCatalogHoldAdapter 读取、加密和发布到 `.keymaster/hold/v1`。
// 本文件不依赖 KeymasterHold SDK，避免把 Provider/物理路径带进插件。

import type {
  BorrowedKeyValueStore,
  KeyValueCommitOperation,
  StorageHoldHeadExpectation,
  StorageCatalogKeyIndexRecordV1,
  StorageKeyDerivationV1
} from "@keymaster/contracts";

/** 中央声明目录中的稳定 purpose 名称。 */
export const VAULT_STORAGE_PURPOSES = Object.freeze({
  authMetadata: "auth-metadata",
  keyIndex: "key-index",
  keyLifecycleJournals: "key-lifecycle-journals"
} as const);

export type VaultStoragePurpose = (typeof VAULT_STORAGE_PURPOSES)[keyof typeof VAULT_STORAGE_PURPOSES];

/** 密码验证所需的公开 KDF/verifier 元数据；不含任何私钥材料。 */
export interface VaultAuthMetadata {
  id: "singleton";
  cryptoVersion: "v2";
  kdf: "pbkdf2-sha256";
  iterations: number;
  keyLengthBits: number;
  saltB64: string;
  verifierSaltB64: string;
  verifierIvB64: string;
  verifierCipherB64: string;
  createdAt: string;
}

/** Add/Delete 共用的生命周期阶段；日志只描述公开事务状态，不携带私钥。 */
export type VaultKeyLifecycleJournalPhase =
  | "prepared"
  | "hold-committed"
  | "owner-storage-active"
  | "owner-storage-deleted"
  | "completed";

/** Vault 生命周期事务的公开记录；同一公钥同一时间最多一条。 */
export interface VaultKeyLifecycleJournalRecord {
  format: "keymaster.vault.key-lifecycle-journal";
  version: 1;
  transactionId: string;
  operation: "add" | "delete";
  publicKeyHex: string;
  phase: VaultKeyLifecycleJournalPhase;
  /** 事务首次观察到的 Hold Head；空 Hold 以 null 表示。 */
  baseHoldEtag: string | null;
  /** 事务发布后的 Hold Head；尚未发布时为 null。 */
  committedHoldEtag: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Hold 适配器可安全跨包传输的 JSON 值。 */
export type VaultCatalogHoldJsonValue =
  | null
  | boolean
  | number
  | string
  | VaultCatalogHoldJsonValue[]
  | { [key: string]: VaultCatalogHoldJsonValue };

/**
 * `.keymaster/hold/v1` 内一条已加密 Key 的 opaque 表示。
 *
 * `cipher` 的具体字段由 Coordinator/Hold 适配层解释；插件的
 * K-V 仓库永远不会把这个对象写入 system namespace。
 */
export interface VaultCatalogHoldRecord {
  publicKeyHex: string;
  label: string;
  cipher: { [key: string]: VaultCatalogHoldJsonValue };
}

/** Hold 适配器返回的已认证当前提交；不暴露 Provider 或物理路径。 */
export interface VaultCatalogHoldSnapshot {
  revision: number;
  headEtag?: string;
  /** 用于备份封装的公开 KDF 参数；不包含密码或派生密钥。 */
  keyDerivation?: StorageKeyDerivationV1;
  keys: readonly VaultCatalogHoldRecord[];
  /** 适配器私有的完整文档；调用方不得持久化到 K-V。 */
  opaqueDocument?: unknown;
}

/**
 * Coordinator 注入的 Catalog Hold 适配器。
 *
 * Noether 负责把本接口绑定到 `keymaster-hold` 和当前桶 Provider。所有
 * add/import/export/password-change/delete 路径必须通过这些 Hold 操作
 * 完成；本接口没有普通 K-V 的私钥写入旁路。
 */
export interface VaultCatalogHoldAdapter {
  /** 读取并认证当前 `.keymaster/hold/v1` 提交。 */
  readCommitted(input: { password: string }): Promise<VaultCatalogHoldSnapshot>;
  /**
   * 读取当前 Hold 中仍保持加密状态的记录，供锁定态冷备份使用。
   * 该路径不解密私钥，也不把 Provider 或物理路径暴露给插件/调用方。
   */
  readEncryptedSnapshot(): Promise<VaultCatalogHoldSnapshot>;
  /** 用当前桶密码把一把短生命周期明文私钥加密成 Hold record。 */
  encryptPrivateKey(input: {
    password: string;
    label: string;
    privateKey: Uint8Array;
  }): Promise<VaultCatalogHoldRecord>;
  /** 在当前操作内解开一条 Hold record；返回值不得写入任何 K-V。 */
  decryptPrivateKey(input: {
    password: string;
    record: VaultCatalogHoldRecord;
  }): Promise<Uint8Array>;
  /** 发布完整下一代 Hold；适配器负责 CAS/认证和 `.keymaster/hold/v1` I/O。 */
  publish(input: {
    password: string;
    keys: readonly VaultCatalogHoldRecord[];
    expectedHead: StorageHoldHeadExpectation;
  }): Promise<VaultCatalogHoldSnapshot>;
  /**
   * 原子旋转 Hold 内全部私钥密文的保护密码。
   * 不能用逐条 K-V 更新替代；不支持该能力的适配器必须显式拒绝。
   */
  rotatePassword(input: {
    oldPassword: string;
    newPassword: string;
  }): Promise<VaultCatalogHoldSnapshot>;
}

/** Host/Coordinator 为 Vault 绑定的三个独立 purpose store。 */
export interface VaultPurposeStores {
  readonly authMetadata: BorrowedKeyValueStore;
  readonly keyIndex: BorrowedKeyValueStore;
  readonly keyLifecycleJournals: BorrowedKeyValueStore;
}

export interface VaultStorageRepositoryInput {
  readonly stores: VaultPurposeStores;
  readonly hold: VaultCatalogHoldAdapter;
}

export interface VaultStorageRepository {
  readonly hold: VaultCatalogHoldAdapter;

  getAuthMetadata(): Promise<VaultAuthMetadata | undefined>;
  putAuthMetadata(metadata: VaultAuthMetadata): Promise<void>;
  deleteAuthMetadata(): Promise<void>;

  listKeyIndex(): Promise<StorageCatalogKeyIndexRecordV1[]>;
  getKeyIndex(publicKeyHex: string): Promise<StorageCatalogKeyIndexRecordV1 | undefined>;
  replaceKeyIndex(records: readonly StorageCatalogKeyIndexRecordV1[]): Promise<void>;
  deleteKeyIndex(publicKeyHex: string): Promise<void>;

  getKeyLifecycleJournal(publicKeyHex: string): Promise<VaultKeyLifecycleJournalRecord | undefined>;
  listKeyLifecycleJournals(publicKeyHex?: string): Promise<VaultKeyLifecycleJournalRecord[]>;
  /** 以 partition revision CAS 认领一个尚不存在的公钥事务槽。 */
  claimKeyLifecycleJournal(record: VaultKeyLifecycleJournalRecord): Promise<void>;
  /** 仅允许持有相同 transactionId 的事务以 partition revision CAS 推进阶段。 */
  updateKeyLifecycleJournal(record: VaultKeyLifecycleJournalRecord): Promise<void>;
  /** 仅允许持有相同 transactionId 的事务以 partition revision CAS 释放认领。 */
  deleteKeyLifecycleJournal(publicKeyHex: string, transactionId: string): Promise<void>;
}

const PARTITION = VAULT_STORAGE_PURPOSES;
const AUTH_METADATA_KEY = "singleton";
const KEY_INDEX_PREFIX = "keys/";
const LIFECYCLE_JOURNAL_PREFIX = "journals/";
const MAX_ATOMIC_ENTRIES = 1000;
const PUBLIC_KEY_PATTERN = /^(02|03)[0-9a-f]{64}$/u;
const MAX_LIFECYCLE_CLAIM_RETRIES = 4;

function assertStore(store: BorrowedKeyValueStore, purpose: VaultStoragePurpose): void {
  if (
    store.moduleId !== "vault"
    || store.purposeId !== purpose
    || store.scope !== "bucket"
    || store.authority !== "platform-only"
    || store.model !== "kv"
  ) {
    throw new Error(`Vault store is not bound to purpose ${purpose}`);
  }
}

function assertPublicKeyHex(value: unknown, field: string): string {
  if (typeof value !== "string" || !PUBLIC_KEY_PATTERN.test(value.toLowerCase())) {
    throw new Error(`${field} is invalid`);
  }
  return value.toLowerCase();
}

function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} is invalid`);
  return value;
}

function assertSupportedFields(value: unknown, allowed: readonly string[], path: string): void {
  if (!value || typeof value !== "object" || value instanceof Uint8Array) return;
  const allowedSet = new Set(allowed);
  const unsupported = Object.keys(value as Record<string, unknown>).find((key) => !allowedSet.has(key));
  if (unsupported) throw new Error(`${path}.${unsupported} is not supported in Vault metadata`);
}

function validateAuthMetadata(value: unknown): VaultAuthMetadata {
  assertSupportedFields(value, [
    "id", "cryptoVersion", "kdf", "iterations", "keyLengthBits", "saltB64",
    "verifierSaltB64", "verifierIvB64", "verifierCipherB64", "createdAt"
  ], "authMetadata");
  if (!value || typeof value !== "object") throw new Error("Vault auth metadata is invalid");
  const metadata = value as Partial<VaultAuthMetadata>;
  if (
    metadata.id !== "singleton"
    || metadata.cryptoVersion !== "v2"
    || metadata.kdf !== "pbkdf2-sha256"
    || typeof metadata.iterations !== "number"
    || !Number.isSafeInteger(metadata.iterations)
    || metadata.iterations < 1
    || metadata.keyLengthBits !== 256
    || typeof metadata.saltB64 !== "string"
    || typeof metadata.verifierSaltB64 !== "string"
    || typeof metadata.verifierIvB64 !== "string"
    || typeof metadata.verifierCipherB64 !== "string"
    || typeof metadata.createdAt !== "string"
  ) throw new Error("Vault auth metadata is invalid");
  return { ...metadata } as VaultAuthMetadata;
}

function validateKeyIndex(value: unknown): StorageCatalogKeyIndexRecordV1 {
  assertSupportedFields(value, [
    "format", "publicKeyHex", "label", "address", "network", "keyFormat", "capabilities", "createdAt", "source"
  ], "keyIndex");
  if (!value || typeof value !== "object") throw new Error("Vault Key index record is invalid");
  const record = value as Partial<StorageCatalogKeyIndexRecordV1>;
  if (
    record.format !== "keymaster.storage.catalog-key-index"
    || typeof record.publicKeyHex !== "string"
    || !PUBLIC_KEY_PATTERN.test(record.publicKeyHex.toLowerCase())
    || typeof record.label !== "string"
    || !record.label.trim()
    || typeof record.keyFormat !== "string"
    || !record.keyFormat.trim()
    || !Array.isArray(record.capabilities)
    || !record.capabilities.every((capability) => typeof capability === "string")
    || typeof record.createdAt !== "string"
    || (record.address !== undefined && typeof record.address !== "string")
    || (record.network !== undefined && record.network !== "main" && record.network !== "test")
    || (record.source !== undefined && typeof record.source !== "string")
  ) throw new Error("Vault Key index record is invalid");
  return {
    format: record.format,
    publicKeyHex: record.publicKeyHex.toLowerCase(),
    label: record.label,
    ...(record.address === undefined ? {} : { address: record.address }),
    ...(record.network === undefined ? {} : { network: record.network }),
    keyFormat: record.keyFormat,
    capabilities: [...record.capabilities],
    createdAt: record.createdAt,
    ...(record.source === undefined ? {} : { source: record.source })
  };
}

function validateLifecycleJournal(value: unknown): VaultKeyLifecycleJournalRecord {
  assertSupportedFields(value, [
    "format", "version", "transactionId", "operation", "publicKeyHex", "phase",
    "baseHoldEtag", "committedHoldEtag", "createdAt", "updatedAt"
  ], "keyLifecycleJournal");
  if (!value || typeof value !== "object") throw new Error("Vault key lifecycle journal is invalid");
  const record = value as Partial<VaultKeyLifecycleJournalRecord>;
  const validAddPhase = record.phase === "prepared"
    || record.phase === "hold-committed"
    || record.phase === "owner-storage-active";
  const validDeletePhase = record.phase === "prepared"
    || record.phase === "hold-committed"
    || record.phase === "owner-storage-deleted"
    || record.phase === "completed";
  if (
    record.format !== "keymaster.vault.key-lifecycle-journal"
    || record.version !== 1
    || typeof record.transactionId !== "string"
    || !record.transactionId
    || (record.operation !== "add" && record.operation !== "delete")
    || typeof record.publicKeyHex !== "string"
    || !PUBLIC_KEY_PATTERN.test(record.publicKeyHex.toLowerCase())
    || (record.operation === "add" ? !validAddPhase : !validDeletePhase)
    || (record.baseHoldEtag !== null && (typeof record.baseHoldEtag !== "string" || !record.baseHoldEtag))
    || (record.committedHoldEtag !== null && (typeof record.committedHoldEtag !== "string" || !record.committedHoldEtag))
    || typeof record.createdAt !== "string"
    || typeof record.updatedAt !== "string"
  ) throw new Error("Vault key lifecycle journal is invalid");
  return {
    format: record.format,
    version: 1,
    transactionId: record.transactionId,
    operation: record.operation,
    publicKeyHex: record.publicKeyHex.toLowerCase(),
    phase: record.phase!,
    baseHoldEtag: record.baseHoldEtag!,
    committedHoldEtag: record.committedHoldEtag!,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

function keyIndexPath(publicKeyHex: string): string {
  return `${KEY_INDEX_PREFIX}${assertPublicKeyHex(publicKeyHex, "publicKeyHex")}`;
}

function lifecycleJournalPath(publicKeyHex: string): string {
  return `${LIFECYCLE_JOURNAL_PREFIX}${assertPublicKeyHex(publicKeyHex, "publicKeyHex")}`;
}

function isStorageConflict(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "storage_conflict");
}

function storageConflict(message: string): Error & { code: "storage_conflict" } {
  return Object.assign(new Error(message), { code: "storage_conflict" as const });
}

async function listValues<T>(
  store: BorrowedKeyValueStore,
  partition: string,
  prefix: string,
  validate: (value: unknown) => T
): Promise<T[]> {
  const values: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list({ partition, prefix, cursor, limit: MAX_ATOMIC_ENTRIES });
    values.push(...page.entries.map((entry) => validate(entry.value)));
    cursor = page.nextCursor;
  } while (cursor);
  return values;
}

async function deletePrefix(
  store: BorrowedKeyValueStore,
  partition: string,
  prefix: string,
  validate: (value: unknown) => { publicKeyHex?: string }
): Promise<void> {
  const page = await store.list({ partition, prefix, limit: MAX_ATOMIC_ENTRIES });
  if (page.nextCursor) throw new Error("Vault purpose store is too large for an atomic deletion");
  const operations: KeyValueCommitOperation[] = page.entries.map((entry) => ({ type: "delete", key: entry.key }));
  // Validate before mutating so malformed metadata cannot be silently deleted
  // as if it were a valid record.
  for (const entry of page.entries) validate(entry.value);
  if (operations.length === 0) return;
  await store.commit({ partition, ifRevision: page.revision, operations });
}

/** 创建一个只使用三个 purpose store + Catalog Hold 的 Vault repository。 */
export function createVaultStorageRepository(input: VaultStorageRepositoryInput): VaultStorageRepository {
  const { stores, hold } = input;
  assertStore(stores.authMetadata, VAULT_STORAGE_PURPOSES.authMetadata);
  assertStore(stores.keyIndex, VAULT_STORAGE_PURPOSES.keyIndex);
  assertStore(stores.keyLifecycleJournals, VAULT_STORAGE_PURPOSES.keyLifecycleJournals);

  return {
    hold,

    async getAuthMetadata(): Promise<VaultAuthMetadata | undefined> {
      const entry = await stores.authMetadata.get<VaultAuthMetadata>(AUTH_METADATA_KEY, { partition: PARTITION.authMetadata });
      return entry ? validateAuthMetadata(entry.value) : undefined;
    },
    async putAuthMetadata(metadata: VaultAuthMetadata): Promise<void> {
      await stores.authMetadata.put(AUTH_METADATA_KEY, validateAuthMetadata(metadata), { partition: PARTITION.authMetadata });
    },
    async deleteAuthMetadata(): Promise<void> {
      await stores.authMetadata.delete(AUTH_METADATA_KEY, { partition: PARTITION.authMetadata });
    },

    async listKeyIndex(): Promise<StorageCatalogKeyIndexRecordV1[]> {
      return listValues(stores.keyIndex, PARTITION.keyIndex, KEY_INDEX_PREFIX, validateKeyIndex);
    },
    async getKeyIndex(publicKeyHex: string): Promise<StorageCatalogKeyIndexRecordV1 | undefined> {
      const entry = await stores.keyIndex.get<StorageCatalogKeyIndexRecordV1>(keyIndexPath(publicKeyHex), { partition: PARTITION.keyIndex });
      return entry ? validateKeyIndex(entry.value) : undefined;
    },
    async replaceKeyIndex(records: readonly StorageCatalogKeyIndexRecordV1[]): Promise<void> {
      const valid = records.map(validateKeyIndex);
      const unique = new Set(valid.map((record) => record.publicKeyHex));
      if (unique.size !== valid.length) throw new Error("Vault Key index contains duplicate public keys");
      const page = await stores.keyIndex.list({ partition: PARTITION.keyIndex, prefix: KEY_INDEX_PREFIX, limit: MAX_ATOMIC_ENTRIES });
      if (page.nextCursor) throw new Error("Vault Key index is too large for an atomic replacement");
      const existing = page.entries.map((entry) => validateKeyIndex(entry.value));
      const operations: KeyValueCommitOperation[] = [
        ...existing.map((record) => ({ type: "delete" as const, key: keyIndexPath(record.publicKeyHex) })),
        ...valid.map((record) => ({ type: "put" as const, key: keyIndexPath(record.publicKeyHex), value: record }))
      ];
      if (operations.length === 0) return;
      await stores.keyIndex.commit({ partition: PARTITION.keyIndex, ifRevision: page.revision, operations });
    },
    async deleteKeyIndex(publicKeyHex: string): Promise<void> {
      await stores.keyIndex.delete(keyIndexPath(publicKeyHex), { partition: PARTITION.keyIndex });
    },

    async getKeyLifecycleJournal(publicKeyHex: string): Promise<VaultKeyLifecycleJournalRecord | undefined> {
      const key = lifecycleJournalPath(publicKeyHex);
      const entry = await stores.keyLifecycleJournals.get<VaultKeyLifecycleJournalRecord>(key, { partition: PARTITION.keyLifecycleJournals });
      return entry ? validateLifecycleJournal(entry.value) : undefined;
    },
    async listKeyLifecycleJournals(publicKeyHex?: string): Promise<VaultKeyLifecycleJournalRecord[]> {
      const filter = publicKeyHex === undefined ? undefined : assertPublicKeyHex(publicKeyHex, "publicKeyHex");
      const records = await listValues(stores.keyLifecycleJournals, PARTITION.keyLifecycleJournals, LIFECYCLE_JOURNAL_PREFIX, validateLifecycleJournal);
      return filter === undefined ? records : records.filter((record) => record.publicKeyHex === filter);
    },
    async claimKeyLifecycleJournal(record: VaultKeyLifecycleJournalRecord): Promise<void> {
      const valid = validateLifecycleJournal(record);
      const key = lifecycleJournalPath(valid.publicKeyHex);
      for (let attempt = 0; attempt < MAX_LIFECYCLE_CLAIM_RETRIES; attempt += 1) {
        const page = await stores.keyLifecycleJournals.list({
          partition: PARTITION.keyLifecycleJournals,
          prefix: key,
          limit: 1,
        });
        const existing = page.entries.find((entry) => entry.key === key);
        if (existing) {
          const current = validateLifecycleJournal(existing.value);
          // A conditional commit can succeed while its response is lost. A
          // retry by the same transaction is therefore idempotent; a
          // different transaction must still receive the durable lock conflict.
          if (
            current.transactionId === valid.transactionId
            && current.operation === valid.operation
            && current.publicKeyHex === valid.publicKeyHex
          ) return;
          throw storageConflict("Vault Key lifecycle transaction is already active");
        }
        try {
          await stores.keyLifecycleJournals.commit({
            partition: PARTITION.keyLifecycleJournals,
            ifRevision: page.revision,
            operations: [{ type: "put", key, value: valid }],
          });
          return;
        } catch (error) {
          // A different public key may have advanced this partition. Re-read
          // before deciding whether the requested public key is occupied.
          if (!isStorageConflict(error) || attempt + 1 >= MAX_LIFECYCLE_CLAIM_RETRIES) throw error;
        }
      }
      throw storageConflict("Vault Key lifecycle transaction claim conflicted");
    },
    async updateKeyLifecycleJournal(record: VaultKeyLifecycleJournalRecord): Promise<void> {
      const valid = validateLifecycleJournal(record);
      const key = lifecycleJournalPath(valid.publicKeyHex);
      const page = await stores.keyLifecycleJournals.list({
        partition: PARTITION.keyLifecycleJournals,
        prefix: key,
        limit: 1,
      });
      const existing = page.entries.find((entry) => entry.key === key);
      if (!existing) throw storageConflict("Vault Key lifecycle transaction is missing");
      const current = validateLifecycleJournal(existing.value);
      if (current.transactionId !== valid.transactionId) {
        throw storageConflict("Vault Key lifecycle transaction is owned by another operation");
      }
      await stores.keyLifecycleJournals.commit({
        partition: PARTITION.keyLifecycleJournals,
        ifRevision: page.revision,
        operations: [{ type: "put", key, value: valid }],
      });
    },
    async deleteKeyLifecycleJournal(publicKeyHex: string, transactionId: string): Promise<void> {
      const normalizedPublicKeyHex = assertPublicKeyHex(publicKeyHex, "publicKeyHex");
      const normalizedTransactionId = assertNonEmptyString(transactionId, "transactionId");
      const key = lifecycleJournalPath(normalizedPublicKeyHex);
      const page = await stores.keyLifecycleJournals.list({
        partition: PARTITION.keyLifecycleJournals,
        prefix: key,
        limit: 1,
      });
      const existing = page.entries.find((entry) => entry.key === key);
      if (!existing) return;
      const current = validateLifecycleJournal(existing.value);
      if (current.transactionId !== normalizedTransactionId) {
        throw storageConflict("Vault Key lifecycle transaction is owned by another operation");
      }
      await stores.keyLifecycleJournals.commit({
        partition: PARTITION.keyLifecycleJournals,
        ifRevision: page.revision,
        operations: [{ type: "delete", key }],
      });
    }
  };
}

let configuredRepository: VaultStorageRepository | undefined;

/** 注入三个 Host 借用句柄和 Catalog Hold 适配器；不接管句柄生命周期。 */
export function configureVaultStorageRepository(input: VaultStorageRepositoryInput): void {
  configuredRepository = createVaultStorageRepository(input);
}

/** 清除当前内存绑定；不会关闭 Host 借用的任何 store。 */
export function disposeVaultStorageRepository(): void {
  configuredRepository = undefined;
}

export function getVaultStorageRepository(): VaultStorageRepository {
  if (!configuredRepository) throw new Error("Vault storage has not been bootstrapped");
  return configuredRepository;
}

/** 全局 facade 只转发到当前装配，仍不持有或关闭底层 store。 */
export const vaultStorageRepository: VaultStorageRepository = {
  get hold(): VaultCatalogHoldAdapter {
    return getVaultStorageRepository().hold;
  },
  getAuthMetadata: () => getVaultStorageRepository().getAuthMetadata(),
  putAuthMetadata: (metadata) => getVaultStorageRepository().putAuthMetadata(metadata),
  deleteAuthMetadata: () => getVaultStorageRepository().deleteAuthMetadata(),
  listKeyIndex: () => getVaultStorageRepository().listKeyIndex(),
  getKeyIndex: (publicKeyHex) => getVaultStorageRepository().getKeyIndex(publicKeyHex),
  replaceKeyIndex: (records) => getVaultStorageRepository().replaceKeyIndex(records),
  deleteKeyIndex: (publicKeyHex) => getVaultStorageRepository().deleteKeyIndex(publicKeyHex),
  getKeyLifecycleJournal: (publicKeyHex) => getVaultStorageRepository().getKeyLifecycleJournal(publicKeyHex),
  listKeyLifecycleJournals: (publicKeyHex) => getVaultStorageRepository().listKeyLifecycleJournals(publicKeyHex),
  claimKeyLifecycleJournal: (record) => getVaultStorageRepository().claimKeyLifecycleJournal(record),
  updateKeyLifecycleJournal: (record) => getVaultStorageRepository().updateKeyLifecycleJournal(record),
  deleteKeyLifecycleJournal: (publicKeyHex, transactionId) => getVaultStorageRepository().deleteKeyLifecycleJournal(publicKeyHex, transactionId)
};
