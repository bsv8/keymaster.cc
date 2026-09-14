// 桶级 multipart 恢复元数据 Repository。
//
// 当前 Provider 由 Coordinator 在绑定桶时注入，不能在这个 Repository 中
// 选择、保存或恢复。这里唯一允许持久化的是未完成 multipart 的恢复元数据；
// 文件内容、Provider 凭据和运行时连接对象都留在 Provider/内存中。

import type { KeyValueStore } from "@keymaster/contracts";

export const MULTIPART_REPOSITORY_NAME = "platform-storage";
export const MULTIPART_REPOSITORY_VERSION = 1;
const PARTITION = "storage";
const UPLOAD_PREFIX = "uploads/";

export interface StoredMultipartUploadRecord {
  internalUploadId: string;
  connectSessionId: string;
  transportOrigin: string;
  ownerPublicKeyHex: string;
  moduleId: string;
  purposeId: "files";
  bucketId: string;
  bucketGeneration: number;
  sessionEpoch: string;
  relativePath: string;
  physicalKey: string;
  /** Provider 返回的 multipart 句柄；它是恢复元数据，不是凭据。 */
  uploadId: string;
  /** 绑定时的桶世代；不是 Provider 选择记录。 */
  providerGeneration: number;
  contentType?: string;
  expectedSize: number;
  overwrite: boolean;
  parts: Array<{ partNumber: number; etag: string; size: number }>;
  expiresAt: number;
  createdAt: number;
}

export interface MultipartUploadRepository {
  putMultipart(record: StoredMultipartUploadRecord): Promise<void>;
  getMultipart(id: string): Promise<StoredMultipartUploadRecord | null>;
  deleteMultipart(id: string): Promise<void>;
  listMultiparts(): Promise<StoredMultipartUploadRecord[]>;
  close(): void;
}

/** 打开由 Host 绑定的桶级 multipart 元数据 Store。 */
export function openMultipartUploadRepository(store: KeyValueStore): Promise<MultipartUploadRepository> {
  let closed = false;
  const assertOpen = () => {
    if (closed) throw new Error("Multipart upload repository is closed");
  };
  const uploadKey = (id: string) => `${UPLOAD_PREFIX}${id}`;

  async function listEntries(): Promise<Array<{ key: string; value: unknown }>> {
    assertOpen();
    const entries: Array<{ key: string; value: unknown }> = [];
    let cursor: string | undefined;
    do {
      const page = await store.list({ partition: PARTITION, prefix: UPLOAD_PREFIX, cursor, limit: 1000 });
      entries.push(...page.entries.map((entry) => ({ key: entry.key, value: entry.value })));
      cursor = page.nextCursor;
    } while (cursor);
    return entries;
  }

  return Promise.resolve({
    async putMultipart(record: StoredMultipartUploadRecord) {
      assertOpen();
      await store.put(uploadKey(record.internalUploadId), record, { partition: PARTITION });
    },
    async getMultipart(id: string) {
      assertOpen();
      return (await store.get<StoredMultipartUploadRecord>(uploadKey(id), { partition: PARTITION }))?.value ?? null;
    },
    async deleteMultipart(id: string) {
      assertOpen();
      await store.delete(uploadKey(id), { partition: PARTITION });
    },
    async listMultiparts() {
      return (await listEntries()).map((entry) => entry.value as StoredMultipartUploadRecord);
    },
    close() {
      if (closed) return;
      closed = true;
      store.close();
    },
  });
}
