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
/**
 * 硬切换 2026-07-04 001：本地 DB storageId = `messages_v3`。
 *
 * 设计缘由：
 *   - 旧 `messages` / `messages_v2` DB 视为废弃数据，本次硬切换
 *     **不**迁移、**不**兼容读、**不**fall through；
 *   - 新 storageId 由 keyspace.openKeyStorage 直接建；keyspace 在
 *     deleteKey 时整体清理；
 *   - **v3 schema 引入 `providerId` 维度**：
 *     - `messages` 表增加 `providerId` 字段；listAllMessages / listForScope
 *       等所有读路径**必须**带 `providerId` 过滤；
 *     - `targets` 表 keyPath 改为 `[providerId, targetKey]` 复合键；
 *       cursor key = `(providerId, targetKey)`，切换 provider 后本地库
 *       数据互不串；
 *     - 旧 v2 schema 升级到 v3 时**不**迁移旧数据；onupgradeneeded
 *       直接 wipe 两个 store 再按 v3 schema 重建。
 *   - 旧 DB 留在 IndexedDB 中不动；浏览器 / 用户可手动清理。
 */
const STORAGE_ID = "messages_v3";
/** 本地 DB schema 版本；硬切换 v4 = keyPath 改为 [providerId, messageId]
 * 复合键（不同 provider 的同 messageId 不互相覆盖）。 */
const DB_VERSION = 4;

/** 内部 handle。 */
interface OpenHandle {
  publicKeyHex: string;
  readonly db: IDBDatabase;
  close(): void;
}

let openHandle: OpenHandle | undefined;

/** 把公开 `AppMsgMessage` 转成 DB 内部存储形态。 */
function toRow(providerId: string, msg: AppMsgMessage): StoredMessage {
  return {
    providerId,
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
  /** 当前 active provider id（v3 新增；切 provider 后旧数据不串）。 */
  providerId: string;
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

/** DB 内部存储形态：target sync state。 */
interface StoredTargetState {
  /** 当前 active provider id（v3 新增；target state 按 providerId 隔离）。 */
  providerId: string;
  /** 收件目标维度稳定 key：`<origin|appId>:<id>`。 */
  targetKey: string;
  lastSyncedMessageId: string;
  lastReceivedAtMs: number;
  lastSyncStartedAtMs: number;
  lastSyncCompletedAtMs: number;
  lastSyncError: string | null;
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
 * 设计缘由（硬切换 2026-07-04 001）：
 *   - 每次调用**直接**通过 keyspace.openKeyStorage 打开新 handle；
 *     不再做模块级 handle 缓存——原 cache 在 disconnect → reconnect 时
 *     会返回已关闭的 db 引用，导致后续 transaction 报
 *     `InvalidStateError`。
 *   - 失败时返回 `null`，调用方按"暂时无本地库"降级。
 */
export async function openAppMsgLocalDb(input: {
  keyspace: KeyspaceService;
  publicKeyHex: string;
}): Promise<{
  handle: KeyScopedStorageHandle;
  publicKeyHex: string;
} | null> {
  if (!input.publicKeyHex) return null;
  // 旧缓存的 handle（如果还活着）主动关掉，避免 leak。
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
      upgrade(db, _oldVersion, _newVersion) {
        // v3 schema：硬切换——**不**迁移旧 store；遇到 v1/v2 直接 wipe 再建。
        if (db.objectStoreNames.contains("messages")) {
          db.deleteObjectStore("messages");
        }
        if (db.objectStoreNames.contains("targets")) {
          db.deleteObjectStore("targets");
        }
        // messages 表 keyPath = `[providerId, messageId]` 复合键：
        //   - 同一 provider 下 messageId 唯一；
        //   - 不同 provider 的同 messageId 不互相覆盖。
        //   - 切换 active provider 后旧 provider 数据保留在 DB，互不串。
        const msgStore = db.createObjectStore("messages", {
          keyPath: ["providerId", "messageId"]
        });
        msgStore.createIndex("providerTarget", ["providerId", "targetId"], {
          unique: false
        });
        msgStore.createIndex("providerId", "providerId", { unique: false });
        msgStore.createIndex("targetId", "targetId", { unique: false });
        msgStore.createIndex("createdAtMs", "createdAtMs", { unique: false });
        msgStore.createIndex("insertedAtMs", "insertedAtMs", { unique: false });
        // targets 表 keyPath 改为 [providerId, targetKey] 复合键。
        db.createObjectStore("targets", { keyPath: ["providerId", "targetKey"] });
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
 * 关键边界（硬切换 2026-07-04 001）：
 *   - **所有**读写路径**必须**带 `providerId`；不允许跨 provider 读。
 *   - 切 active provider 后旧 provider 数据保留在 DB，但当前 provider
 *     的 list / get / sync cursor 只看当前 providerId 维度。
 *   - 复合 key targets 表：`[providerId, targetKey]` —— 同 owner 同
 *     endpoint 但不同 provider 的 cursor 不串。
 *
 * 所有读取方法汇总：
 *   - `getMessageForScope(...)` / `listMessagesForScope(...)`：按
 *     `AppMsgScope` + providerId 过滤；用于 `AppMsgCore.list/get` 路径；
 *   - `getMessageForTarget(...)` / `listMessagesForTarget(...)`：按
 *     `[providerId, targetId]` 复合索引过滤；用于 sync 路径；
 *   - `listAllMessages(...)`：按 providerId 过滤；用于 admin 全库浏览。
 */
export function createAppMsgLocalDbOps(handle: KeyScopedStorageHandle) {
  const db = handle.db;

  /* ====== 写（带 providerId） ====== */

  async function putMessage(providerId: string, m: AppMsgMessage): Promise<void> {
    const row = toRow(providerId, m);
    const tx = db.transaction("messages", "readwrite");
    tx.objectStore("messages").put(row);
    await txDone(tx);
  }

  async function putMessages(providerId: string, list: AppMsgMessage[]): Promise<number> {
    if (list.length === 0) return 0;
    const tx = db.transaction("messages", "readwrite");
    const store = tx.objectStore("messages");
    let written = 0;
    for (const m of list) {
      store.put(toRow(providerId, m));
      written += 1;
    }
    await txDone(tx);
    return written;
  }

  /* ====== 读（scoped + providerId） ====== */

  /**
   * scope ACL + providerId 读取：取单条 message，但仅在该 `scope` +
   * `providerId` 可见时才返回。
   *
   * `noScopeAccess = true` 或 provider 不匹配时返回 `null`。调用方
   * **不**能直接调此方法读全库——这是一个 ACL 收口。
   */
  async function getMessageForScope(input: {
    providerId: string;
    messageId: string;
    scope: AppMsgScope;
  }): Promise<AppMsgMessage | null> {
    const tx = db.transaction("messages", "readonly");
    const row = (await reqAsPromise(
      tx.objectStore("messages").get([input.providerId, input.messageId])
    )) as StoredMessage | undefined;
    if (!row) return null;
    if (row.providerId !== input.providerId) return null;
    const m = toMessage(row);
    return messageMatchesScope(m, input.scope) ? m : null;
  }

  /**
   * scope ACL + providerId list：取当前 providerId + scope 内可见的
   * 全部消息，按 insertedAtMs desc。
   *
   * 先按 `providerId` 索引命中再扫 scope——v1 简化路径。
   */
  async function listMessagesForScope(input: {
    providerId: string;
    scope: AppMsgScope;
    afterMessageId?: string;
    limit?: number;
  }): Promise<AppMsgMessage[]> {
    const tx = db.transaction("messages", "readonly");
    const store = tx.objectStore("messages");
    const idx = store.index("providerId");
    const range = IDBKeyRange.only(input.providerId);
    const rows = (await reqAsPromise(idx.getAll(range))) as StoredMessage[];
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
   * 单 target 维度同步（带 providerId）：sync 路径专用。
   *
   * 命中 `[providerId, targetId]` 复合索引。**不**做 ACL（targetId
   * 维度 = 仅"我以这个 target 维度收"）。
   */
  async function getMessageForTarget(input: {
    providerId: string;
    messageId: string;
    targetId: string;
  }): Promise<AppMsgMessage | null> {
    const tx = db.transaction("messages", "readonly");
    const store = tx.objectStore("messages");
    const row = (await reqAsPromise(
      store.get([input.providerId, input.messageId])
    )) as StoredMessage | undefined;
    if (!row) return null;
    if (row.providerId !== input.providerId) return null;
    if (row.targetId !== input.targetId) return null;
    return toMessage(row);
  }

  /**
   * 单 target 增量 list（按 [providerId, targetId] + messageId > cursor）。
   */
  async function listMessagesForTarget(input: {
    providerId: string;
    targetId: string;
    afterMessageId?: string;
    limit?: number;
  }): Promise<AppMsgMessage[]> {
    const tx = db.transaction("messages", "readonly");
    const store = tx.objectStore("messages");
    const idx = store.index("providerTarget");
    const range = IDBKeyRange.only([input.providerId, input.targetId]);
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
   * 当前 provider 全量读——管理页 + 协议层全库订阅使用。
   *
   * **必须**带 `providerId`；不允许跨 provider 读。
   */
  async function listAllMessages(input: {
    providerId: string;
    afterMessageId?: string;
    limit?: number;
  }): Promise<AppMsgMessage[]> {
    const tx = db.transaction("messages", "readonly");
    const store = tx.objectStore("messages");
    const idx = store.index("providerId");
    const range = IDBKeyRange.only(input.providerId);
    const rows = (await reqAsPromise(idx.getAll(range))) as StoredMessage[];
    const out: AppMsgMessage[] = [];
    for (const r of rows) {
      if (input.afterMessageId && r.messageId <= input.afterMessageId) continue;
      out.push(toMessage(r));
    }
    out.sort((a, b) => b.insertedAtMs - a.insertedAtMs);
    return out.slice(0, Math.max(1, input.limit ?? 200));
  }

  /* ====== targets / 同步状态（带 providerId） ====== */

  async function listTargetIds(providerId: string): Promise<string[]> {
    const tx = db.transaction("targets", "readonly");
    const store = tx.objectStore("targets");
    const range = IDBKeyRange.bound([providerId, ""], [providerId, "￿"]);
    const keys = (await reqAsPromise(store.getAllKeys(range))) as IDBValidKey[];
    return keys
      .map((k) => {
        if (Array.isArray(k)) return String(k[1]);
        return String(k);
      })
      .filter((s) => s.length > 0);
  }

  async function getTargetState(
    providerId: string,
    targetKey: string
  ): Promise<AppMsgTargetSyncState | null> {
    const tx = db.transaction("targets", "readonly");
    const row = (await reqAsPromise(tx.objectStore("targets").get([providerId, targetKey]))) as
      | StoredTargetState
      | undefined;
    if (!row) return null;
    return {
      targetKey: row.targetKey,
      lastSyncedMessageId: row.lastSyncedMessageId ?? "",
      lastReceivedAtMs: row.lastReceivedAtMs ?? 0,
      lastSyncStartedAtMs: row.lastSyncStartedAtMs ?? 0,
      lastSyncCompletedAtMs: row.lastSyncCompletedAtMs ?? 0,
      lastSyncError: row.lastSyncError ?? null
    };
  }

  async function putTargetState(
    providerId: string,
    state: AppMsgTargetSyncState
  ): Promise<void> {
    const row: StoredTargetState = {
      providerId,
      targetKey: state.targetKey,
      lastSyncedMessageId: state.lastSyncedMessageId,
      lastReceivedAtMs: state.lastReceivedAtMs,
      lastSyncStartedAtMs: state.lastSyncStartedAtMs,
      lastSyncCompletedAtMs: state.lastSyncCompletedAtMs,
      lastSyncError: state.lastSyncError
    };
    const tx = db.transaction("targets", "readwrite");
    tx.objectStore("targets").put(row);
    await txDone(tx);
  }

  async function listTargetStates(providerId: string): Promise<AppMsgTargetSyncState[]> {
    const tx = db.transaction("targets", "readonly");
    const store = tx.objectStore("targets");
    const range = IDBKeyRange.bound([providerId, ""], [providerId, "￿"]);
    const rows = (await reqAsPromise(store.getAll(range))) as StoredTargetState[];
    return rows.map((row) => ({
      targetKey: row.targetKey,
      lastSyncedMessageId: row.lastSyncedMessageId,
      lastReceivedAtMs: row.lastReceivedAtMs,
      lastSyncStartedAtMs: row.lastSyncStartedAtMs,
      lastSyncCompletedAtMs: row.lastSyncCompletedAtMs,
      lastSyncError: row.lastSyncError
    }));
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
 *
 * 注意：当前实现是历史遗留死代码——core 层直接构造快照，**不**经过
 * 本函数。保留仅为向后兼容；新接入请走 `appmsgCore.inspectLocalDb()`。
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
    lastError: input.lastError,
    nextReconnectAtMs: null
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
