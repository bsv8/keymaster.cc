// packages/plugin-appmsg/src/appmsgDb.ts
// appmsg 本地消息库（key-scoped IndexedDB）。
//
// 设计缘由（施工单 2026-07-03 001）：
//   - 本地库是消息真值。每把 key 一个 namespace DB（storageId="messages"），
//     由 `keyspace.openKeyStorage(...)` 打开；删除 key 时该 DB 由 keyspace
//     自动清理，禁止组件内 `indexedDB.deleteDatabase` 直接删。
//   - 真值表：
//       * `messages`（keyPath = "messageId"）：完整消息记录。
//       * `targets`（keyPath = "targetKey"）：每个本地收件目标的同步状态。
//     索引：
//       * `messages.targetId`（多对一 → targets.targetKey）
//       * `messages.createdAtMs`（数值索引）
//       * `messages.insertedAtMs`（数值索引）
//   - 去重：写入时按 messageId 幂等；同一 message 在此 DB 只存在一份。
//   - 读路径（list / get）只读本地库；**不**走 HubMsg。
//   - 写路径（HubMsg push）先调 put 写本地库，再让 appmsg.core 派发给订阅者。
//
// 与传统 200 条内存缓存的关系：旧内存缓存被本组件完全替代——本地 DB
// 容量由 IndexedDB 配额决定，不人为限条数。

import type {
  AppMsgLocalDbSnapshot,
  AppMsgMessage,
  AppMsgTargetSyncState,
  KeyScopedStorageHandle,
  KeyspaceService
} from "@keymaster/contracts";

const PLUGIN_ID = "appmsg";
const STORAGE_ID = "messages";
/** 本地 DB schema 版本；新 schema 时按标准 upgrade 路径升级。 */
const DB_VERSION = 1;

/** 内部 handle。 */
interface OpenHandle {
  publicKeyHex: string;
  readonly db: IDBDatabase;
  close(): void;
}

let openHandle: OpenHandle | undefined;

/** 把公开 `AppMsgMessage` 转成 DB 内部存储形态。 */
function toRow(msg: AppMsgMessage): StoredMessage {
  return {
    messageId: msg.messageId,
    clientMessageId: msg.clientMessageId,
    senderPublicKeyHex: msg.senderPublicKeyHex,
    senderOrigin: msg.senderOrigin ?? null,
    senderAppId: msg.senderAppId ?? null,
    recipientPublicKeyHex: msg.recipientPublicKeyHex,
    recipientOrigin: msg.recipientOrigin ?? null,
    recipientAppId: msg.recipientAppId ?? null,
    contentType: msg.contentType,
    body: msg.body,
    createdAtMs: msg.createdAtMs,
    insertedAtMs: msg.insertedAtMs,
    targetId: computeTargetId({
      recipientOrigin: msg.recipientOrigin,
      recipientAppId: msg.recipientAppId
    })
  };
}

/** DB 内部存储形态。 */
interface StoredMessage {
  messageId: string;
  clientMessageId: string;
  senderPublicKeyHex: string;
  senderOrigin: string | null;
  senderAppId: string | null;
  recipientPublicKeyHex: string;
  recipientOrigin: string | null;
  recipientAppId: string | null;
  contentType: "text/plain" | "text/markdown";
  body: string;
  createdAtMs: number;
  insertedAtMs: number;
  /**
   * "targetKey" 维度冗余存储，便于快速按"我是当前 owner，我以这个
   * recipient 维度收消息"做索引；见 `computeTargetId`。
   */
  targetId: string;
}

/**
 * 公开 origin/appId → 内部 endpoint。
 *
 * 注：本函数**仅**在 plugin-appmsg 内部映射时使用；公开消息统一走
 * 公开 `AppMsgMessage` 形态。`appmsg.ts` 不再保留 `AppMsgMessageRecord`。
 */
function toEndpoint(
  origin: string | undefined,
  appId: string | undefined
): { kind: "origin" | "plugin"; id: string } {
  if (origin) return { kind: "origin", id: origin };
  if (appId) return { kind: "plugin", id: appId };
  // 兜底：本仓库不允许；调用方必须保证 origin 或 appId 二选一。
  return { kind: "plugin", id: "" };
}

/**
 * 单个本地收件目标维度稳定 id（targetKey）。
 *
 * 维度策略：发送方 perspective 时 recipient 决定；接收方 perspective 时
 * "我是当前 owner 收件"决定。我们只关心"我是当前 owner 时，与我相关的
 * 收件维度"：
 *   - 当 current owner 也是 recipient 时：targetId =
 *     `recipientOrigin ?? recipientAppId`。
 *   - 其它场景（自己发给别人）：仍然记录到同一 DB，但 targetId 用
 *     "我以这个维度发给对方"的稳定 key，便于后续按维度分组。
 */
export function computeTargetId(input: {
  recipientOrigin?: string | null;
  recipientAppId?: string | null;
}): string {
  if (input.recipientOrigin) return `origin:${input.recipientOrigin}`;
  if (input.recipientAppId) return `appId:${input.recipientAppId}`;
  return "unknown:";
}

/** 由公开消息构造 targetId。 */
export function targetIdFromMessage(m: AppMsgMessage): string {
  return computeTargetId({ recipientOrigin: m.recipientOrigin, recipientAppId: m.recipientAppId });
}

/** DB row → 公开 message。 */
function toMessage(row: StoredMessage): AppMsgMessage {
  const out: AppMsgMessage = {
    messageId: row.messageId,
    clientMessageId: row.clientMessageId,
    senderPublicKeyHex: row.senderPublicKeyHex,
    recipientPublicKeyHex: row.recipientPublicKeyHex,
    contentType: row.contentType,
    body: row.body,
    createdAtMs: row.createdAtMs,
    insertedAtMs: row.insertedAtMs
  };
  if (row.senderOrigin) out.senderOrigin = row.senderOrigin;
  else if (row.senderAppId) out.senderAppId = row.senderAppId;
  if (row.recipientOrigin) out.recipientOrigin = row.recipientOrigin;
  else if (row.recipientAppId) out.recipientAppId = row.recipientAppId;
  return out;
}

function reqAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * 打开指定 owner 的本地消息库。
 *
 * 切换 owner 时关闭旧 handle；同一 owner 重复打开复用。
 * 失败时返回 `null`，调用方按"暂时无本地库"降级。
 */
export async function openAppMsgLocalDb(input: {
  keyspace: KeyspaceService;
  publicKeyHex: string;
}): Promise<{
  handle: KeyScopedStorageHandle;
  publicKeyHex: string;
} | null> {
  if (!input.publicKeyHex) return null;
  if (openHandle && openHandle.publicKeyHex === input.publicKeyHex) {
    // 复用；KeyScopedStorageHandle 由 caller 持有。
    return {
      handle: { db: openHandle.db, name: openHandle.db.name, close: openHandle.close },
      publicKeyHex: openHandle.publicKeyHex
    };
  }
  if (openHandle) {
    try {
      openHandle.close();
    } catch {
      // ignore
    }
    openHandle = undefined;
  }
  let handle: KeyScopedStorageHandle;
  try {
    handle = await input.keyspace.openKeyStorage({
      publicKeyHex: input.publicKeyHex,
      pluginId: PLUGIN_ID,
      storageId: STORAGE_ID,
      version: DB_VERSION,
      upgrade(db) {
        if (!db.objectStoreNames.contains("messages")) {
          const store = db.createObjectStore("messages", { keyPath: "messageId" });
          store.createIndex("targetId", "targetId", { unique: false });
          store.createIndex("createdAtMs", "createdAtMs", { unique: false });
          store.createIndex("insertedAtMs", "insertedAtMs", { unique: false });
        }
        if (!db.objectStoreNames.contains("targets")) {
          db.createObjectStore("targets", { keyPath: "targetKey" });
        }
      }
    });
  } catch {
    return null;
  }
  const next: OpenHandle = {
    publicKeyHex: input.publicKeyHex,
    db: handle.db,
    close: () => {
      try {
        handle.close();
      } catch {
        // ignore
      }
      if (openHandle === next) openHandle = undefined;
    }
  };
  openHandle = next;
  return { handle, publicKeyHex: input.publicKeyHex };
}

/**
 * 关闭并清空缓存的 db handle（仅用于 dispose / 测试）。
 */
export function disposeAppMsgLocalDb(): void {
  if (!openHandle) return;
  try {
    openHandle.close();
  } catch {
    // ignore
  }
  openHandle = undefined;
}

/**
 * 获取当前本地 DB handle 公开快照（state / owner / lastInsertedAtMs / lastError）。
 *
 * 设计缘由（施工单 §5.4）：状态由本地 DB 决定；锁定 / 无 owner 时
 * state = "idle"。
 */
export function inspectLocalDb(input: {
  currentBoundOwner: string | null;
  lastInsertedAtMs: number;
  lastError: string | null;
}): AppMsgLocalDbSnapshot {
  const state: AppMsgLocalDbSnapshot["state"] = openHandle
    ? "open"
    : input.currentBoundOwner
      ? "closed"
      : "idle";
  return {
    state,
    ownerPublicKeyHex: input.currentBoundOwner,
    lastInsertedAtMs: input.lastInsertedAtMs,
    lastError: input.lastError
  };
}

/**
 * 工厂：构造绑定到当前 openHandle 的 db 操作集合。
 *
 * 调用方应在每次操作前确认 handle 仍处于 active；如果 owner 切换了，
 * 调用方负责重新调用 `openAppMsgLocalDb(...)` 拿到新 handle。
 */
export function createAppMsgLocalDbOps(handle: KeyScopedStorageHandle) {
  const db = handle.db;

  /** 写一条消息（按 messageId 幂等）。 */
  async function putMessage(m: AppMsgMessage): Promise<void> {
    const row = toRow(m);
    const tx = db.transaction("messages", "readwrite");
    tx.objectStore("messages").put(row);
    await txDone(tx);
  }

  /** 批量写（同一事务）。 */
  async function putMessages(list: AppMsgMessage[]): Promise<number> {
    if (list.length === 0) return 0;
    const tx = db.transaction("messages", "readwrite");
    const store = tx.objectStore("messages");
    let written = 0;
    for (const m of list) {
      store.put(toRow(m));
      written += 1;
    }
    await txDone(tx);
    return written;
  }

  /** 按 messageId 单条取。 */
  async function getMessage(messageId: string): Promise<AppMsgMessage | null> {
    const tx = db.transaction("messages", "readonly");
    const row = (await reqAsPromise(tx.objectStore("messages").get(messageId))) as
      | StoredMessage
      | undefined;
    return row ? toMessage(row) : null;
  }

  /**
   * 增量正向 list：返回 `messageId > afterMessageId` 的最近 limit 条记录；
   * `afterMessageId` 缺省时不过滤。
   *
   * 入参 `targetId`（可选）：仅返回与某一 targetKey 相关的消息。
   * 缺省 = 当前 owner 的所有消息（sender 或 recipient 都算）。
   */
  async function listMessages(input?: {
    targetId?: string;
    limit?: number;
    afterMessageId?: string;
  }): Promise<AppMsgMessage[]> {
    const limit = input?.limit ?? 50;
    const tx = db.transaction("messages", "readonly");
    const store = tx.objectStore("messages");
    const items: AppMsgMessage[] = [];
    if (input?.targetId) {
      const idx = store.index("targetId");
      const range = IDBKeyRange.only(input.targetId);
      const rows = (await reqAsPromise(idx.getAll(range))) as StoredMessage[];
      for (const r of rows) {
        if (input.afterMessageId && r.messageId <= input.afterMessageId) continue;
        items.push(toMessage(r));
      }
    } else {
      const rows = (await reqAsPromise(store.getAll())) as StoredMessage[];
      for (const r of rows) {
        if (input?.afterMessageId && r.messageId <= input.afterMessageId) continue;
        items.push(toMessage(r));
      }
    }
    // 按 insertedAtMs 倒序（最新优先）
    items.sort((a, b) => b.insertedAtMs - a.insertedAtMs);
    // 截断 limit；hasMore 由调用方在结果集合比 limit 多 1 时推断。
    return items.slice(0, Math.max(1, limit));
  }

  /** 取一个 owner 维度下所有不重复 targetId 列表。 */
  async function listTargetIds(): Promise<string[]> {
    const tx = db.transaction("targets", "readonly");
    const rows = (await reqAsPromise(tx.objectStore("targets").getAllKeys())) as IDBValidKey[];
    return rows.map((k) => String(k));
  }

  /** 取单个 target 的同步状态。 */
  async function getTargetState(targetId: string): Promise<AppMsgTargetSyncState | null> {
    const tx = db.transaction("targets", "readonly");
    const row = (await reqAsPromise(tx.objectStore("targets").get(targetId))) as
      | (Omit<AppMsgTargetSyncState, "targetKey"> & { targetKey?: string })
      | undefined;
    if (!row) return null;
    return {
      targetKey: targetId,
      lastSyncedMessageId: row.lastSyncedMessageId ?? "",
      lastReceivedAtMs: row.lastReceivedAtMs ?? 0,
      lastSyncStartedAtMs: row.lastSyncStartedAtMs ?? 0,
      lastSyncCompletedAtMs: row.lastSyncCompletedAtMs ?? 0,
      lastSyncError: row.lastSyncError ?? null
    };
  }

  /** 写单个 target 的同步状态（按 targetKey 幂等）。 */
  async function putTargetState(state: AppMsgTargetSyncState): Promise<void> {
    const tx = db.transaction("targets", "readwrite");
    tx.objectStore("targets").put(state);
    await txDone(tx);
  }

  /** 列出所有 target 同步状态。 */
  async function listTargetStates(): Promise<AppMsgTargetSyncState[]> {
    const tx = db.transaction("targets", "readonly");
    const rows = (await reqAsPromise(tx.objectStore("targets").getAll())) as AppMsgTargetSyncState[];
    return rows ?? [];
  }

  return {
    putMessage,
    putMessages,
    getMessage,
    listMessages,
    listTargetIds,
    getTargetState,
    putTargetState,
    listTargetStates
  };
}

export type AppMsgLocalDbOps = ReturnType<typeof createAppMsgLocalDbOps>;
