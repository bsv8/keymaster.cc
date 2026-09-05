// Vault 的统一 K-V Repository。
//
// 这里保存平台 `keys/` 根下的 Vault 元数据、加密 KeyHold 文档和 WebAuthn
// sidecar。Repository 只接收已经由 Storage/Coordinator 绑定的 KeyValueStore，
// 不知道 Provider、物理路径，也不读取旧 platform K-V repository 数据。

import type { BsvNetwork, KeyValueStore } from "@keymaster/contracts";
import type { Document as KeyHoldDocument } from "keyhold";
import { createInMemoryKeyValueStore } from "@keymaster/runtime";

export interface VaultMetaRecord {
  id: "singleton";
  /** Vault crypto 版本。用于密码验证和正式记录解密。 */
  cryptoVersion: "v2";
  /** KDF 方案。v2 固定 pbkdf2-sha256。 */
  kdf: "pbkdf2-sha256";
  /** PBKDF2 迭代次数。 */
  iterations: number;
  /** PBKDF2 输出位数。 */
  keyLengthBits: number;
  /** 派生 key 时使用的 salt。 */
  saltB64: string;
  /** 验证密码用的加密块。 */
  verifierSaltB64: string;
  verifierIvB64: string;
  verifierCipherB64: string;
  createdAt: string;
}

interface VaultKeyRecordBase {
  /** 主键：压缩公钥 hex；落库前必须派生。 */
  publicKeyHex: string;
  label: string;
  /** 派生出来的 BSV 地址，仅用于展示。 */
  address: string;
  /** 导入时网络，仅用于业务展示。 */
  network: BsvNetwork;
  format: string;
  capabilities: string[];
  createdAt: string;
  source?: string;
}

/** 新记录只保存 canonical KeyHold 文档。 */
export interface KeyHoldVaultKeyRecord extends VaultKeyRecordBase {
  storageVersion: "keyhold-v2";
  keyholdDocument: KeyHoldDocument;
  cipherVersion?: never;
  cipherSaltB64?: never;
  cipherIvB64?: never;
  cipherB64?: never;
  passkeyProtections?: never;
}

export type VaultKeyRecord = KeyHoldVaultKeyRecord;

export interface VaultPasskeyProtectionRecord {
  id: string;
  label: string;
  credentialIdB64: string;
  prfSaltB64: string;
  rpId: string;
  createdAt: string;
  transports?: string[];
  cipherVersion: "webauthn-prf-v1";
  cipherIvB64: string;
  cipherB64: string;
}

export interface WebAuthnSidecarRecord {
  publicKeyHex: string;
  id: string;
  label: string;
  credentialIdB64: string;
  rpId: string;
  prfSaltB64: string;
  createdAt: string;
  transports?: string[];
  cipherVersion: "webauthn-prf-v1";
  cipherIvB64: string;
  cipherB64: string;
}

const PARTITION = "vault";
const META_KEY = "meta";
const KEY_PREFIX = "keys/";
const SIDECAR_PREFIX = "sidecars/";

let keyStore: KeyValueStore | undefined;

/** Storage-first 启动时注入平台 `keys/` 句柄。 */
export function configureVaultKeyRepository(store: KeyValueStore): void {
  keyStore?.close();
  keyStore = store;
}

/**
 * 测试夹具清空内存句柄；生产启动不会调用此函数，也不会自动创建本地
 * 持久化 fallback。这样缺少 Storage bootstrap 时会直接 fail closed。
 */
export function disposeVaultKeyRepository(): void {
  keyStore?.close();
  keyStore = createInMemoryKeyValueStore({
    scope: "platform",
    applicationStorageId: "keys",
    schemaVersion: 1,
    bucketId: "test-memory",
    bucketGeneration: 1
  });
}

function requireStore(): KeyValueStore {
  if (!keyStore) throw new Error("Vault storage has not been bootstrapped");
  return keyStore;
}

async function listValues<T>(prefix: string): Promise<T[]> {
  const store = requireStore();
  const values: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list({ partition: PARTITION, prefix, cursor, limit: 1000 });
    values.push(...page.entries.map((entry) => entry.value as T));
    cursor = page.nextCursor;
  } while (cursor);
  return values;
}

const keyPath = (publicKeyHex: string) => `${KEY_PREFIX}${publicKeyHex}`;
const sidecarPath = (publicKeyHex: string, id: string) => `${SIDECAR_PREFIX}${publicKeyHex}/${id}`;

export const vaultKeyRepository = {
  async getMeta(): Promise<VaultMetaRecord | undefined> {
    return (await requireStore().get<VaultMetaRecord>(META_KEY, { partition: PARTITION }))?.value;
  },
  async putMeta(meta: VaultMetaRecord): Promise<void> {
    await requireStore().put(META_KEY, meta, { partition: PARTITION });
  },
  async deleteMeta(): Promise<void> {
    await requireStore().delete(META_KEY, { partition: PARTITION });
  },
  async listKeys(): Promise<VaultKeyRecord[]> {
    return listValues<VaultKeyRecord>(KEY_PREFIX);
  },
  async getKey(publicKeyHex: string): Promise<VaultKeyRecord | undefined> {
    return (await requireStore().get<VaultKeyRecord>(keyPath(publicKeyHex), { partition: PARTITION }))?.value;
  },
  async getKeyByAddress(address: string): Promise<VaultKeyRecord | undefined> {
    return (await this.listKeys()).find((record) => record.address === address);
  },
  async putKey(record: VaultKeyRecord): Promise<void> {
    if (!record.publicKeyHex) throw new Error("vaultKeyRepository.putKey requires publicKeyHex");
    await requireStore().put(keyPath(record.publicKeyHex), record, { partition: PARTITION });
  },
  async putKeyRecords(records: VaultKeyRecord[]): Promise<void> {
    for (const record of records) {
      if (!record.publicKeyHex) throw new Error("vaultKeyRepository.putKeyRecords requires publicKeyHex");
    }
    await requireStore().commit({
      partition: PARTITION,
      operations: records.map((record) => ({ type: "put" as const, key: keyPath(record.publicKeyHex), value: record }))
    });
  },
  /** 原子写回 Vault meta 与 canonical keys。 */
  async putMetaAndKeys(meta: VaultMetaRecord, records: VaultKeyRecord[]): Promise<void> {
    for (const record of records) {
      if (!record.publicKeyHex) throw new Error("vaultKeyRepository.putMetaAndKeys requires publicKeyHex");
    }
    await requireStore().commit({
      partition: PARTITION,
      operations: [
        { type: "put", key: META_KEY, value: meta },
        ...records.map((record) => ({ type: "put" as const, key: keyPath(record.publicKeyHex), value: record }))
      ]
    });
  },
  async deleteKeyAndSidecars(publicKeyHex: string): Promise<void> {
    const store = requireStore();
    const sidecars = await store.list({ partition: PARTITION, prefix: `${SIDECAR_PREFIX}${publicKeyHex}/`, limit: 1000 });
    await store.commit({
      partition: PARTITION,
      operations: [
        { type: "delete", key: keyPath(publicKeyHex) },
        ...sidecars.entries.map((entry) => ({ type: "delete" as const, key: entry.key }))
      ]
    });
  },
  async deleteSidecar(publicKeyHex: string, id: string): Promise<void> {
    await requireStore().delete(sidecarPath(publicKeyHex, id), { partition: PARTITION });
  },
  async listSidecars(publicKeyHex: string): Promise<WebAuthnSidecarRecord[]> {
    return listValues<WebAuthnSidecarRecord>(`${SIDECAR_PREFIX}${publicKeyHex}/`);
  },
  async putSidecar(sidecar: WebAuthnSidecarRecord): Promise<void> {
    await requireStore().put(sidecarPath(sidecar.publicKeyHex, sidecar.id), sidecar, { partition: PARTITION });
  }
};
