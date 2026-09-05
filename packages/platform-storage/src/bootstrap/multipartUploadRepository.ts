// Storage bootstrap 的 K-V Repository。
//
// Provider 配置和 multipart 运行记录属于平台 storage 区，不能再使用浏览器
// 数据库保存。生产调用方必须显式注入平台 K-V 句柄。

import type { KeyValueStore, StorageSecretEnvelope } from "@keymaster/contracts";
import { StorageRuntimeError } from "../runtime/storageRuntimeError.js";

export const MULTIPART_REPOSITORY_NAME = "platform-storage";
export const MULTIPART_REPOSITORY_VERSION = 1;
const PARTITION = "storage";
const PROVIDER_KEY = "provider/active";
const ROTATION_KEY = "provider/rotation";
const UPLOAD_PREFIX = "uploads/";

export interface StoredProviderConfigRecord {
  key: "active";
  providerId: string;
  publicSummary: { bucketHint: string; endpointHint?: string; accessKeyHint: string };
  sealedConfig: StorageSecretEnvelope;
  generation: number;
  updatedAt: number;
}

export interface StoredMultipartUploadRecord {
  internalUploadId: string;
  connectSessionId: string;
  transportOrigin: string;
  ownerPublicKeyHex: string;
  applicationStorageId: string;
  bucketId: string;
  bucketGeneration: number;
  sessionEpoch: string;
  relativePath: string;
  physicalKey: string;
  sealedS3UploadId: StorageSecretEnvelope;
  providerGeneration: number;
  contentType?: string;
  expectedSize: number;
  overwrite: boolean;
  parts: Array<{ partNumber: number; etag: string; size: number }>;
  expiresAt: number;
  createdAt: number;
}

function rotationInProgressError(): StorageRuntimeError {
  return new StorageRuntimeError("storage_unavailable", "Storage is temporarily unavailable during password rotation");
}

export interface MultipartUploadRepository {
  getProviderConfig(): Promise<StoredProviderConfigRecord | null>;
  replaceProviderConfig(record: StoredProviderConfigRecord): Promise<void>;
  clearProviderConfig(): Promise<void>;
  /** 显式、用户确认的重置，同时清除卡住的 rotation 记录。 */
  resetStorage(): Promise<void>;
  putMultipart(record: StoredMultipartUploadRecord): Promise<void>;
  getMultipart(id: string): Promise<StoredMultipartUploadRecord | null>;
  deleteMultipart(id: string): Promise<void>;
  listMultiparts(): Promise<StoredMultipartUploadRecord[]>;
  close(): void;
}

/** 打开平台 storage K-V；生产必须显式传入平台绑定句柄。 */
export function openMultipartUploadRepository(store: KeyValueStore): Promise<MultipartUploadRepository> {
  let closed = false;
  const assertOpen = () => { if (closed) throw new Error("Storage repository is closed"); };
  const uploadKey = (id: string) => `${UPLOAD_PREFIX}${id}`;

  async function readRotation(): Promise<{ value?: unknown; revision: number }> {
    const current = await store.list({ partition: PARTITION, prefix: ROTATION_KEY, limit: 1 });
    return { value: current.entries[0]?.value, revision: current.revision };
  }

  async function commitGuarded(operations: Array<{ type: "put" | "delete"; key: string; value?: unknown }>): Promise<void> {
    assertOpen();
    const current = await readRotation();
    if (current.value) throw rotationInProgressError();
    await store.commit({
      partition: PARTITION,
      ifRevision: current.revision,
      operations: operations.map((operation) => operation.type === "put"
        ? { type: "put" as const, key: operation.key, value: operation.value as never }
        : { type: "delete" as const, key: operation.key })
    });
  }

  async function listEntries(prefix: string): Promise<Array<{ key: string; value: unknown }>> {
    const entries: Array<{ key: string; value: unknown }> = [];
    let cursor: string | undefined;
    do {
      const page = await store.list({ partition: PARTITION, prefix, cursor, limit: 1000 });
      entries.push(...page.entries.map((entry) => ({ key: entry.key, value: entry.value })));
      cursor = page.nextCursor;
    } while (cursor);
    return entries;
  }

  return Promise.resolve({
    async getProviderConfig() {
      assertOpen();
      return (await store.get<StoredProviderConfigRecord>(PROVIDER_KEY, { partition: PARTITION }))?.value ?? null;
    },
    async replaceProviderConfig(record: StoredProviderConfigRecord) {
      await commitGuarded([{ type: "put", key: PROVIDER_KEY, value: record }]);
    },
    async clearProviderConfig() {
      const entries = await listEntries("");
      await commitGuarded(entries.map((entry) => ({ type: "delete" as const, key: entry.key })));
    },
    async resetStorage() {
      assertOpen();
      const entries = await listEntries("");
      const current = await store.list({ partition: PARTITION, limit: 1 });
      if (entries.length > 0) {
        await store.commit({
          partition: PARTITION,
          ifRevision: current.revision,
          operations: entries.map((entry) => ({ type: "delete" as const, key: entry.key }))
        });
      }
    },
    async putMultipart(record: StoredMultipartUploadRecord) {
      await commitGuarded([{ type: "put", key: uploadKey(record.internalUploadId), value: record }]);
    },
    async getMultipart(id: string) {
      assertOpen();
      return (await store.get<StoredMultipartUploadRecord>(uploadKey(id), { partition: PARTITION }))?.value ?? null;
    },
    async deleteMultipart(id: string) {
      await commitGuarded([{ type: "delete", key: uploadKey(id) }]);
    },
    async listMultiparts() {
      return (await listEntries(UPLOAD_PREFIX)).map((entry) => entry.value as StoredMultipartUploadRecord);
    },
    close() { closed = true; store.close(); }
  });
}
