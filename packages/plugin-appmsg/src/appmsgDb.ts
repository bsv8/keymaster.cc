// packages/plugin-appmsg/src/appmsgDb.ts
// appmsg 本地消息库（key-scoped IndexedDB）。
//
// 设计缘由（施工单 2026-07-03 001 + 反馈 §"必须修改"）：
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
//   - **scoped API**：低层不允许"全库读 / 全库 get"——
//     ACL 边界收口在 DB 层：所有 get / list 都**必须**经 scoped 方法
//     （`getMessageForScope` / `listMessagesForScope` /
//     `getMessageForTarget` / `listMessagesForTarget` / `listAllMessages`），
//     上层不能"自己拼"。

import type {
  AppMsgLocalDbSnapshot,
  AppMsgMessage,
  AppMsgScope,
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
 * 把 `AppMsgScope` 转换为"我看哪些消息"的判定函数。
 *
 * 关键约束：
 *   - 跨 owner 永远不可见；
 *   - 同 owner 下，sender 端与 recipient 端必须**严格对称**——本 scope
 *     只看见 owner 在自己 endpoint 上发送 / 接收的消息。
 *   - kind = "all"（仅系统消息应用）可见 owner 维度内任意消息。
 */
function messageMatchesScope(m: AppMsgMessage, scope: AppMsgScope): boolean {
  if (m.senderPublicKeyHex !== scope.ownerPublicKeyHex &&
      m.recipientPublicKeyHex !== scope.ownerPublicKeyHex) {
    return false;
  }
  if (scope.kind === "all") return true;
  if (!scope.id) return false;
  if (scope.kind === "origin") {
    return (
      (m.senderPublicKeyHex === scope.ownerPublicKeyHex &&
        m.senderOrigin === scope.id) ||
      (m.recipientPublicKeyHex === scope.ownerPublicKeyHex &&
        m.recipientOrigin === scope.id)
    );
  }
  if (scope.kind === "plugin") {
    return (
      (m.senderPublicKeyHex === scope.ownerPublicKeyHex &&
        m.senderAppId === scope.id) ||
      (m.recipientPublicKeyHex === scope.ownerPublicKeyHex &&
        m.recipientAppId === scope.id)
    );
  }
  return false;
}

/**
 * single target key（<kind>:<id>）↔ target id 转换。
 */
export function computeTargetId(input: {
  recipientOrigin?: string | null;
  recipientAppId?: string | null;
}): string {
  if (input.recipientOrigin) return `origin:${input.recipientOrigin}`;
  if (input.recipientAppId) return `appId:${input.recipientAppId}`;
  return "unknown:";
}

/** 公开消息 → target key。 */
export function targetIdFromMessage(m: AppMsgMessage): string {
  return computeTargetId({
    recipientOrigin: m.recipientOrigin,
    recipientAppId: m.recipientAppId
  });
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
 * 工厂：构造绑定到当前 openHandle 的 db 操作集合（scoped）。
 *
 * 关键边界：DB 层**不**暴露"无 scope 的全库读"。所有读取必须经
 * 下方方法之一：
 *   - `getMessageForScope(...)` / `listMessagesForScope(...)`：按
 *     `AppMsgScope` 过滤；用于 `AppMsgCore.list/get` 路径；
 *   - `getMessageForTarget(...)` / `listMessagesForTarget(...)`：按单
 *     targetKey 维度过滤；用于 sync 路径；
 *   - `listAllMessages(...)`：仅 `subscribeUnfilteredMessages` / system
 *     message app 这条有限路径使用。
 */
export function createAppMsgLocalDbOps(handle: KeyScopedStorageHandle) {
  const db = handle.db;

  /* ====== 写（不涉及 scope） ====== */

  async function putMessage(m: AppMsgMessage): Promise<void> {
    const row = toRow(m);
    const tx = db.transaction("messages", "readwrite");
    tx.objectStore("messages").put(row);
    await txDone(tx);
  }

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

  /* ====== 读（scoped） ====== */

  /**
   * scope ACL 读取：取单条 message，但仅在该 `scope` 可见时才返回。
   *
   * `noScopeAccess = true` 时返回 `null`。调用方**不**能直接调此方法
   * 读全库——这是一个 ACL 收口。
   */
  async function getMessageForScope(input: {
    messageId: string;
    scope: AppMsgScope;
  }): Promise<AppMsgMessage | null> {
    const tx = db.transaction("messages", "readonly");
    const row = (await reqAsPromise(tx.objectStore("messages").get(input.messageId))) as
      | StoredMessage
      | undefined;
    if (!row) return null;
    const m = toMessage(row);
    return messageMatchesScope(m, input.scope) ? m : null;
  }

  /**
   * scope ACL list：取 scope 内可见的全部消息，按 insertedAtMs desc。
   *
   * 全表扫描 + 内存过滤——v1 简化：对单 key 维度来说，DB 量级可控。
   */
  async function listMessagesForScope(input: {
    scope: AppMsgScope;
    afterMessageId?: string;
    limit?: number;
  }): Promise<AppMsgMessage[]> {
    const tx = db.transaction("messages", "readonly");
    const rows = (await reqAsPromise(tx.objectStore("messages").getAll())) as StoredMessage[];
    const out: AppMsgMessage[] = [];
    for (const r of rows) {
      const m = toMessage(r);
      if (!messageMatchesScope(m, input.scope)) continue;
      if (input.afterMessageId && r.messageId <= input.afterMessageId) continue;
      out.push(m);
    }
    out.sort((a, b) => b.insertedAtMs - a.insertedAtMs);
    return out.slice(0, Math.max(1, input.limit ?? 50));
  }

  /**
   * 单 target 维度同步：sync 路径专用。
   *
   * 行为：按 targetId 索引读取——比 scope list 快得多（命中索引命中）。
   * **不**做 ACL（targetId 维度 = 仅"我以这个 target 维度收"）。
   */
  async function getMessageForTarget(input: {
    messageId: string;
    targetId: string;
  }): Promise<AppMsgMessage | null> {
    const tx = db.transaction("messages", "readonly");
    const store = tx.objectStore("messages");
    const row = (await reqAsPromise(store.get(input.messageId))) as StoredMessage | undefined;
    if (!row) return null;
    if (row.targetId !== input.targetId) return null;
    return toMessage(row);
  }

  /** 单 target 增量 list（按 messageId > cursor 过滤）。 */
  async function listMessagesForTarget(input: {
    targetId: string;
    afterMessageId?: string;
    limit?: number;
  }): Promise<AppMsgMessage[]> {
    const tx = db.transaction("messages", "readonly");
    const store = tx.objectStore("messages");
    const idx = store.index("targetId");
    const range = IDBKeyRange.only(input.targetId);
    const rows = (await reqAsPromise(idx.getAll(range))) as StoredMessage[];
    const out: AppMsgMessage[] = [];
    for (const r of rows) {
      if (input.afterMessageId && r.messageId <= input.afterMessageId) continue;
      out.push(toMessage(r));
    }
    out.sort((a, b) => b.insertedAtMs - a.insertedAtMs);
    return out.slice(0, Math.max(1, input.limit ?? 100));
  }

  /**
   * 系统消息应用专用全量读——本 DB 操作层不强制锁，仅在 `appmsg.core`
   * 工厂层用 `KEYMASTER_MESSAGE_APP_ID` 校验调用方，**仅**允许系统
   * 消息应用构造者使用。
   */
  async function listAllMessages(input?: {
    afterMessageId?: string;
    limit?: number;
  }): Promise<AppMsgMessage[]> {
    const tx = db.transaction("messages", "readonly");
    const rows = (await reqAsPromise(tx.objectStore("messages").getAll())) as StoredMessage[];
    const out: AppMsgMessage[] = [];
    for (const r of rows) {
      if (input?.afterMessageId && r.messageId <= input.afterMessageId) continue;
      out.push(toMessage(r));
    }
    out.sort((a, b) => b.insertedAtMs - a.insertedAtMs);
    return out.slice(0, Math.max(1, input?.limit ?? 200));
  }

  /* ====== targets / 同步状态 ====== */

  async function listTargetIds(): Promise<string[]> {
    const tx = db.transaction("targets", "readonly");
    const rows = (await reqAsPromise(tx.objectStore("targets").getAllKeys())) as IDBValidKey[];
    return rows.map((k) => String(k));
  }

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

  async function putTargetState(state: AppMsgTargetSyncState): Promise<void> {
    const tx = db.transaction("targets", "readwrite");
    tx.objectStore("targets").put(state);
    await txDone(tx);
  }

  async function listTargetStates(): Promise<AppMsgTargetSyncState[]> {
    const tx = db.transaction("targets", "readonly");
    const rows = (await reqAsPromise(tx.objectStore("targets").getAll())) as AppMsgTargetSyncState[];
    return rows ?? [];
  }

  return {
    putMessage,
    putMessages,
    getMessageForScope,
    listMessagesForScope,
    getMessageForTarget,
    listMessagesForTarget,
    listAllMessages,
    listTargetIds,
    getTargetState,
    putTargetState,
    listTargetStates
  };
}

export type AppMsgLocalDbOps = ReturnType<typeof createAppMsgLocalDbOps>;

/**
 * 同步全库 snapshot（仅供 `inspectLocalDb` 阶段使用；不暴露给 caller）。
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
 * 把 sender 投影转成 `AppMsgScope`。
 *
 * 设计缘由：
 *   - 把"origin caller vs plugin caller vs system all"统一为一个
 *     scope 判定函数；
 *   - 上层（core / facade）只用 `AppMsgScope` 做 ACL，避免散落的
 *     if-else。
 */
export function senderProjectionToScope(input: {
  senderPublicKeyHex: string;
  senderOrigin?: string;
  senderAppId?: string;
}): AppMsgScope {
  if (input.senderOrigin) {
    return {
      ownerPublicKeyHex: input.senderPublicKeyHex,
      kind: "origin",
      id: input.senderOrigin
    };
  }
  if (input.senderAppId) {
    return {
      ownerPublicKeyHex: input.senderPublicKeyHex,
      kind: "plugin",
      id: input.senderAppId
    };
  }
  // 兜底：如果既没 origin 也没 appId，给个"全" scope（**仅** system message
  // app 应使用；调用方应在 facade 层就拒绝这种输入）。
  return {
    ownerPublicKeyHex: input.senderPublicKeyHex,
    kind: "all",
    id: null
  };
}

// 防止 IDE 报 unused
void 0;
