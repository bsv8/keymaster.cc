// 桶内公开 Key 索引。
//
// KeymasterHold 快照中的 KeyRecord 才是私钥密文的唯一真值；本索引只
// 保存公开展示字段，允许 UI 在不把完整 KeyRecord 复制到本机目录的情况
// 下列出 Key。索引丢失时可以由已认证 Hold 快照重建，索引不能生成私钥。

import type { KeyValueStore, StorageCatalogKeyIndexRecordV1 } from "@keymaster/contracts";

const PARTITION = "catalog-key-index";
const PREFIX = "keys/";

function keyPath(publicKeyHex: string): string {
  return `${PREFIX}${publicKeyHex.toLowerCase()}`;
}

function isPublicKeyHex(value: unknown): value is string {
  return typeof value === "string" && /^0[23][0-9a-f]{64}$/u.test(value);
}

function validateRecord(value: unknown): StorageCatalogKeyIndexRecordV1 {
  if (!value || typeof value !== "object") throw new Error("Catalog Key index record is invalid");
  const record = value as Partial<StorageCatalogKeyIndexRecordV1>;
  if (
    record.format !== "keymaster.storage.catalog-key-index"
    || !isPublicKeyHex(record.publicKeyHex)
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
  ) throw new Error("Catalog Key index record is invalid");
  return {
    format: record.format,
    publicKeyHex: record.publicKeyHex.toLowerCase(),
    label: record.label,
    ...(record.address === undefined ? {} : { address: record.address }),
    ...(record.network === undefined ? {} : { network: record.network }),
    keyFormat: record.keyFormat,
    capabilities: [...record.capabilities],
    createdAt: record.createdAt,
    ...(record.source === undefined ? {} : { source: record.source }),
  };
}

async function listValues(store: KeyValueStore): Promise<StorageCatalogKeyIndexRecordV1[]> {
  const values: StorageCatalogKeyIndexRecordV1[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list({ partition: PARTITION, prefix: PREFIX, cursor, limit: 1000 });
    values.push(...page.entries.map((entry) => validateRecord(entry.value)));
    cursor = page.nextCursor;
  } while (cursor);
  return values;
}

/** 为一个已绑定桶创建公开 Key 索引句柄；不持有密码或 Provider。 */
export function createStorageCatalogKeyIndexRepository(store: KeyValueStore) {
  return {
    async listKeys(): Promise<StorageCatalogKeyIndexRecordV1[]> {
      return listValues(store);
    },
    async getKey(publicKeyHex: string): Promise<StorageCatalogKeyIndexRecordV1 | undefined> {
      if (!isPublicKeyHex(publicKeyHex.toLowerCase())) return undefined;
      const value = await store.get<StorageCatalogKeyIndexRecordV1>(keyPath(publicKeyHex), { partition: PARTITION });
      return value ? validateRecord(value.value) : undefined;
    },
    async putKey(record: StorageCatalogKeyIndexRecordV1): Promise<void> {
      const valid = validateRecord(record);
      await store.put(keyPath(valid.publicKeyHex), valid, { partition: PARTITION });
    },
    /** 以一个 K-V commit 原子替换索引；Hold 快照仍是权威来源。 */
    async replaceKeys(records: readonly StorageCatalogKeyIndexRecordV1[]): Promise<void> {
      const valid = records.map(validateRecord);
      const unique = new Set(valid.map((record) => record.publicKeyHex));
      if (unique.size !== valid.length) throw new Error("Catalog Key index contains duplicate public keys");
      const existing = await listValues(store);
      const existingPage = await store.list({ partition: PARTITION, prefix: PREFIX, limit: 1000 });
      if (existingPage.nextCursor) {
        // 实际桶的索引数量受 Key 列表上限约束；拒绝不完整删除，避免旧
        // 索引在分页场景中残留并重新成为误导性的第二套列表。
        throw new Error("Catalog Key index is too large for an atomic replacement");
      }
      const nextByPath = new Map(valid.map((record) => [keyPath(record.publicKeyHex), record]));
      await store.commit({
        partition: PARTITION,
        ifRevision: existingPage.revision,
        operations: [
          ...existing.map((record) => ({ type: "delete" as const, key: keyPath(record.publicKeyHex) })),
          ...[...nextByPath.values()].map((record) => ({ type: "put" as const, key: keyPath(record.publicKeyHex), value: record })),
        ],
      });
    },
    async deleteKey(publicKeyHex: string): Promise<void> {
      if (!isPublicKeyHex(publicKeyHex.toLowerCase())) return;
      await store.delete(keyPath(publicKeyHex), { partition: PARTITION });
    },
  };
}

export type StorageCatalogKeyIndexRepository = ReturnType<typeof createStorageCatalogKeyIndexRepository>;
