// Message 历史统一 K-V Repository。
// 每条记录按 owner 隔离；调用方只能拿到当前 active owner 的受限句柄。

import type { KeyValueStore, MessageRecord } from "@keymaster/contracts";

const STORAGE_ID = "Messages";
const PARTITION = "messages";
const PREFIX = "message/";
export type MessageRepositoryOwnerGuard = () => boolean;

export interface MessageRepository {
  list(guard?: MessageRepositoryOwnerGuard): Promise<MessageRecord[]>;
  get(messageId: string, guard?: MessageRepositoryOwnerGuard): Promise<MessageRecord | undefined>;
  put(message: MessageRecord, guard?: MessageRepositoryOwnerGuard): Promise<void>;
}

function normalizeOwner(ownerPublicKeyHex: string): string {
  const owner = ownerPublicKeyHex.trim().toLowerCase();
  if (!/^(02|03)[0-9a-f]{64}$/u.test(owner)) throw new Error("Message history owner public key is invalid");
  return owner;
}

export const MESSAGE_STORAGE_ID = STORAGE_ID;
export const MESSAGE_SCHEMA_VERSION = 1;

export function createMessageRepository(store: KeyValueStore): MessageRepository {
  // Storage-first 启动时 Host 会先注入延迟绑定句柄；setup 阶段还没有
  // active key，不能在构造 Repository 时读取 owner。真正执行 K-V 操作
  // 时句柄已经完成 owner 绑定，再校验其 canonical publicKeyHex。
  function currentOwner(): string {
    return normalizeOwner(store.ownerPublicKeyHex);
  }
  async function listValues(current: KeyValueStore): Promise<MessageRecord[]> {
    const rows: MessageRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await current.list({ partition: PARTITION, prefix: PREFIX, cursor, limit: 1000 });
      rows.push(...page.entries.map((entry) => entry.value as unknown as MessageRecord));
      cursor = page.nextCursor;
    } while (cursor);
    return rows;
  }
  function assertCurrent(guard?: MessageRepositoryOwnerGuard): void {
    if (guard && !guard()) throw new Error("Message history owner session became stale");
  }
  return {
    async list(guard) {
      assertCurrent(guard);
      const rows = await listValues(store); assertCurrent(guard); return rows;
    },
    async get(messageId, guard) {
      assertCurrent(guard);
      const row = await store.get<MessageRecord>(`${PREFIX}${messageId}`, { partition: PARTITION });
      assertCurrent(guard); return row?.value;
    },
    async put(message, guard) {
      const owner = currentOwner();
      if (message.senderPublicKeyHex !== owner && message.recipientPublicKeyHex !== owner) throw new Error("Message history record does not belong to owner");
      assertCurrent(guard);
      try {
        await store.put(`${PREFIX}${message.messageId}`, message, { partition: PARTITION });
        assertCurrent(guard);
      } catch (error) {
        if (!guard || guard()) throw error;
        // K-V commit may have completed immediately before the session fence
        // changed. Remove this newly written record before surfacing the stale
        // owner error; the repository never leaves a late message behind.
        try { await store.delete(`${PREFIX}${message.messageId}`, { partition: PARTITION }); } catch { /* best effort */ }
        throw error;
      }
    }
  };
}
