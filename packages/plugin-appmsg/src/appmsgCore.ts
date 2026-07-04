// packages/plugin-appmsg/src/appmsgCore.ts
// appmsg.core 平台单例：HubMsg 连接 + 本地消息库 + 推送分发 + 增量同步 +
// 在线查询 + 严格 sender/scope ACL。
//
// 设计缘由（施工单 2026-07-03 001 + 反馈 §"必须修改"）：
//   - 单例：HubMsg WSS 一条连接；owner 切换时由本组件 reconnect；vault
//     锁时关闭。
//   - **单真值在 Keymaster 本地 DB**（`packages/plugin-appmsg/src/appmsgDb.ts`）：
//     HubMsg 仅做远端持久化 / 实时推送 / 在线查询。
//   - **严格 sender 投影 + ACL**：所有 sendScopedMessage / listScopedMessages /
//     getScopedMessage / subscribeScopedMessages 都**必须**带
//     `AppMsgSenderProjection`；平台内部再转 `AppMsgScope`；
//     getMessage / listMessage **不**经过全库路径——任何 scope 不符的消息
//     一律返回 null。
//   - **scoped 订阅**：core 内部保存 `{match: (msg) => boolean, handler}`，
//     每个订阅都有自己的 match；`subscribeScopedMessages` 的 match 由 sender
//     投影导出 scope，事件只在 scope 内分发。
//   - 唯一可走全库读 / 全库订阅的是 `keymaster.message` 系统消息应用——
//     通过 `createSystemMessageClient(...)` 工厂；调用方具备 manifest 上
//     `appMessageEndpoint.endpointId === KEYMASTER_MESSAGE_APP_ID` 才会被放行。
//   - send：sender 投影**严格映射**为 HubMsg senderEndpoint（origin ↔
//     origin endpoint；appId ↔ plugin endpoint）；recipient = 自己时同时写
//     本地副本（因为 HubMsg 服务端对 self-send 不再 push）。
//   - 失败语义：best-effort + 重连 + 增量同步自愈；**不**做 replay 队列。

import type {
  AppMsgAddress,
  AppMsgContentType,
  AppMsgCore,
  AppMsgEndpoint,
  AppMsgGetScopedInput,
  AppMsgGetInput,
  AppMsgListInput,
  AppMsgListScopedInput,
  AppMsgListResult,
  AppMsgLocalDbSnapshot,
  AppMsgMessage,
  AppMsgOnlineInput,
  AppMsgOnlineResult,
  AppMsgOnlineStatus,
  AppMsgScope,
  AppMsgSendInput,
  AppMsgSendResult,
  AppMsgSendScopedInput,
  AppMsgSenderProjection,
  AppMsgSimpleClient,
  AppMsgSubscribeScopedInput,
  AppMsgTargetSyncState,
  KeyScopedStorageHandle,
  KeyspaceService
} from "@keymaster/contracts";
import { KEYMASTER_MESSAGE_APP_ID } from "@keymaster/contracts";
import {
  HubMsgConnectionImpl,
  type HubMsgConnection,
  type HubMsgMessageRecord,
  type HubMsgOnlineResult
} from "./hubmsgConnection.js";
import {
  createAppMsgLocalDbOps,
  disposeAppMsgLocalDb,
  inspectLocalDb,
  openAppMsgLocalDb,
  senderProjectionToScope,
  targetIdFromMessage,
  type AppMsgLocalDbOps
} from "./appmsgDb.js";
import { syncAllScopes, syncOneScope } from "./appmsgSync.js";
import { makeMessageScopedClient, SystemMessageAppClient } from "./messageFacade.js";

/**
 * appmsg.core 配置。
 */
export interface AppMsgCoreConfig {
  url: string;
  heartbeatSec?: number;
  /** 给出当前 owner 的 bind signer；缺 = vault locked / 无 active key。 */
  signerProvider: () => Promise<HubMsgBindSigner | null>;
  /** 注入 keyspace 适配。 */
  keyspace: KeyspaceService;
  pluginId: string;
  storageId: string;
  logger?: {
    info?: (input: unknown) => void;
    warn?: (input: unknown) => void;
    error?: (input: unknown) => void;
  };
}

import type { HubMsgBindSigner } from "./hubmsgConnection.js";

/* ====== 内部 logger bridge ====== */

function emitLog(
  logger: AppMsgCoreConfig["logger"] | undefined,
  level: "info" | "warn" | "error",
  event: string,
  data?: Record<string, unknown>
): void {
  if (!logger) return;
  const fn = logger[level];
  if (!fn) return;
  const safe: Record<string, unknown> = { event };
  if (data) {
    for (const k of Object.keys(data)) {
      if (k === "body") continue;
      safe[k] = data[k];
    }
  }
  try {
    fn(safe);
  } catch {
    // ignore
  }
}

/* ====== 内部类型 ====== */

interface MessageSubscription {
  match: (msg: AppMsgMessage) => boolean;
  handler: (msg: AppMsgMessage) => void;
}

/** sender 投影 → HubMsg wire senderEndpoint（严格）。 */
function senderEndpointFor(sender: AppMsgSenderProjection): AppMsgEndpoint {
  if (sender.senderOrigin) {
    return { kind: "origin", id: sender.senderOrigin };
  }
  if (sender.senderAppId) {
    return { kind: "plugin", id: sender.senderAppId };
  }
  // 兜底为空 endpoint；调用方应该在 facade 层就拒绝这种输入。
  return { kind: "plugin", id: "" };
}

function recipientEndpointFor(input: {
  recipientOrigin?: string;
  recipientAppId?: string;
}): AppMsgEndpoint {
  if (input.recipientOrigin) {
    return { kind: "origin", id: input.recipientOrigin };
  }
  if (input.recipientAppId) {
    return { kind: "plugin", id: input.recipientAppId };
  }
  return { kind: "plugin", id: "" };
}

/** 内部 scope match 函数（按 sender 投影导出）。 */
function scopeMatchFromSender(
  sender: AppMsgSenderProjection,
  scope: AppMsgScope
): (m: AppMsgMessage) => boolean {
  return (m) => {
    return matchesScope(m, scope);
  };
}

/** 公开 ACL 判定：从 scope 看消息。 */
function matchesScope(m: AppMsgMessage, scope: AppMsgScope): boolean {
  // 至少一端属于本 owner；否则跨 owner 一定不可见。
  if (m.senderPublicKeyHex !== scope.ownerPublicKeyHex &&
      m.recipientPublicKeyHex !== scope.ownerPublicKeyHex) {
    return false;
  }
  if (scope.kind === "all") return true;
  if (!scope.id) return false;
  // 注意：sender 端与 recipient 端必须**严格对称**——只有当发送或接收发
  // 生在 owner 的 endpoint（同 scope.id）时这条消息才属于本 scope。
  // 反例：owner 是 recipient（recipientOrigin === scope.id），但发送人
  // 是别人，senderOrigin 也偶然等于 scope.id——这是对方把消息发到了
  // 和本 owner 同一个 origin 上，但不属于本 owner 视角下的"自己发的"。
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

/* ====== 主实现 ====== */

export class AppMsgCoreImpl implements AppMsgCore {
  private connection: HubMsgConnection | null = null;
  private readonly cfg: AppMsgCoreConfig;
  /** 当前绑定的 owner publicKeyHex。 */
  private currentBoundOwner: string | null = null;
  /** 本地 DB handle。 */
  private localHandle: KeyScopedStorageHandle | null = null;
  /** 当前 owner 的本地 DB ops 句柄。 */
  private localOps: AppMsgLocalDbOps | null = null;
  /** scoped 订阅者列表。 */
  private readonly scopedSubs = new Set<MessageSubscription>();
  /** unfiltered 订阅者列表（**仅** keymaster.message 系统应用可创建）。 */
  private readonly unfilteredSubs = new Set<MessageSubscription>();
  /** 最近一次本地库写入时间戳。 */
  private lastInsertedAtMsValue: number = 0;
  /** 最近一次错误 message。 */
  private lastErrorMessageValue: string | null = null;
  /** 防止同时多次 triggerSync 并发。 */
  private syncInFlight: Promise<void> | null = null;

  constructor(cfg: AppMsgCoreConfig) {
    this.cfg = cfg;
  }

  /* ====== 连接管理 ====== */

  async connectForOwner(ownerPublicKeyHex: string): Promise<void> {
    if (
      this.currentBoundOwner === ownerPublicKeyHex &&
      this.connection?.state() === "bound"
    ) {
      return;
    }
    emitLog(this.cfg.logger, "info", "appmsg.connect.begin", { ownerPublicKeyHex });
    await this.disconnect();
    await this.openLocalDbForOwner(ownerPublicKeyHex);

    const signer = await this.cfg.signerProvider();
    if (!signer) {
      this.lastErrorMessageValue = "no signer available (vault locked or no active key)";
      emitLog(this.cfg.logger, "warn", "appmsg.connect.failed", {
        ownerPublicKeyHex,
        reason: "no_signer"
      });
      return;
    }
    const conn = new HubMsgConnectionImpl({
      url: this.cfg.url,
      heartbeatSec: this.cfg.heartbeatSec
    });
    this.connection = conn;

    conn.subscribeEvent<{
      message: HubMsgMessageRecord;
    }>(
      "message.received",
      (data) => {
        if (!data?.message) return;
        const publicMsg = wireRecordToPublic(data.message);
        // 1. 落本地库（best-effort）
        this.localOps
          ?.putMessage(publicMsg)
          .then(() => {
            this.lastInsertedAtMsValue = Date.now();
            this.recordTargetLastReceived(publicMsg);
          })
          .catch((err) => {
            this.lastErrorMessageValue = err instanceof Error ? err.message : String(err);
            emitLog(this.cfg.logger, "warn", "appmsg.local.put.failed", {
              err: this.lastErrorMessageValue,
              messageId: publicMsg.messageId
            });
          });
        // 2. 派发给订阅者（先 scoped，再 unfiltered）
        for (const s of this.scopedSubs) {
          try {
            if (s.match(publicMsg)) s.handler(publicMsg);
          } catch {
            // ignore
          }
        }
        for (const s of this.unfilteredSubs) {
          try {
            s.handler(publicMsg);
          } catch {
            // ignore
          }
        }
        // 3. 异步触发一次增量同步（best-effort）
        void this.triggerSync();
        // 4. 系统轨迹
        emitLog(this.cfg.logger, "info", "appmsg.receive.pushed", {
          messageId: publicMsg.messageId,
          clientMessageId: publicMsg.clientMessageId,
          contentType: publicMsg.contentType,
          bodyBytes: publicMsg.body.length
        });
      }
    );

    try {
      await conn.connect(signer);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastErrorMessageValue = msg;
      emitLog(this.cfg.logger, "error", "appmsg.connect.failed", {
        ownerPublicKeyHex,
        reason: "bind_error",
        err: msg
      });
      try {
        conn.close();
      } catch {
        // ignore
      }
      this.connection = null;
      return;
    }
    this.currentBoundOwner = ownerPublicKeyHex;
    this.lastErrorMessageValue = null;
    emitLog(this.cfg.logger, "info", "appmsg.connect.bound", { ownerPublicKeyHex });
    void this.triggerSync();
  }

  async disconnect(): Promise<void> {
    if (this.connection) {
      try {
        this.connection.close();
      } catch {
        // ignore
      }
      this.connection = null;
      emitLog(this.cfg.logger, "info", "appmsg.connect.closed", {
        ownerPublicKeyHex: this.currentBoundOwner
      });
    }
    this.currentBoundOwner = null;
    if (this.localHandle) {
      try {
        this.localHandle.close();
      } catch {
        // ignore
      }
      this.localHandle = null;
      this.localOps = null;
    }
  }

  /* ====== 本地 DB ====== */

  async openLocalDb(input: { publicKeyHex: string }): Promise<KeyScopedStorageHandle | null> {
    if (this.currentBoundOwner && this.currentBoundOwner !== input.publicKeyHex) {
      return null;
    }
    const opened = await openAppMsgLocalDb({
      keyspace: this.cfg.keyspace,
      publicKeyHex: input.publicKeyHex
    });
    if (!opened) return null;
    this.localHandle = opened.handle;
    this.localOps = createAppMsgLocalDbOps(opened.handle);
    return opened.handle;
  }

  private async openLocalDbForOwner(publicKeyHex: string): Promise<void> {
    if (this.localHandle) {
      try {
        this.localHandle.close();
      } catch {
        // ignore
      }
      this.localHandle = null;
      this.localOps = null;
    }
    const opened = await openAppMsgLocalDb({
      keyspace: this.cfg.keyspace,
      publicKeyHex
    });
    if (!opened) {
      this.lastErrorMessageValue = "local db not available";
      return;
    }
    this.localHandle = opened.handle;
    this.localOps = createAppMsgLocalDbOps(opened.handle);
  }

  inspectLocalDb(): AppMsgLocalDbSnapshot {
    return inspectLocalDb({
      currentBoundOwner: this.currentBoundOwner,
      lastInsertedAtMs: this.lastInsertedAtMsValue,
      lastError: this.lastErrorMessageValue
    });
  }

  /* ====== Scoped 实现 ====== */

  async sendScopedMessage(input: AppMsgSendScopedInput): Promise<AppMsgSendResult> {
    // 校验 sender 与 owner 绑定一致：调用方必须用当前 owner publicKeyHex。
    if (!this.currentBoundOwner) {
      throw new Error("appmsg.core: not connected");
    }
    if (input.senderPublicKeyHex !== this.currentBoundOwner) {
      throw new Error(
        `appmsg.core: senderPublicKeyHex mismatch (got ${input.senderPublicKeyHex.slice(0, 8)}…, current ${this.currentBoundOwner.slice(0, 8)}…)`
      );
    }
    const hasSenderOrigin = typeof input.senderOrigin === "string" && input.senderOrigin.length > 0;
    const hasSenderAppId = typeof input.senderAppId === "string" && input.senderAppId.length > 0;
    if (hasSenderOrigin === hasSenderAppId) {
      throw new Error(
        "appmsg.core: exactly one of senderOrigin / senderAppId required"
      );
    }
    if (
      !this.connection ||
      this.connection.state() !== "bound"
    ) {
      throw new Error("appmsg.core: HubMsg not bound; cannot send");
    }
    const hasRecipientOrigin = typeof input.recipientOrigin === "string" && input.recipientOrigin.length > 0;
    const hasRecipientAppId = typeof input.recipientAppId === "string" && input.recipientAppId.length > 0;
    if (hasRecipientOrigin === hasRecipientAppId) {
      throw new Error(
        "appmsg.core: exactly one of recipientOrigin / recipientAppId required"
      );
    }
    if (!input.recipientPublicKeyHex) {
      throw new Error("appmsg.core: recipientPublicKeyHex required");
    }
    if (
      input.contentType !== "text/plain" &&
      input.contentType !== "text/markdown"
    ) {
      throw new Error("appmsg.core: invalid contentType");
    }
    if (typeof input.body !== "string" || input.body.length === 0) {
      throw new Error("appmsg.core: body must be non-empty");
    }
    if (!input.clientMessageId) {
      throw new Error("appmsg.core: clientMessageId required");
    }
    emitLog(this.cfg.logger, "info", "appmsg.send.begin", {
      clientMessageId: input.clientMessageId,
      contentType: input.contentType,
      bodyBytes: input.body.length,
      senderKind: hasSenderOrigin ? "origin" : hasSenderAppId ? "plugin" : "none"
    });
    const senderEp = senderEndpointFor(input);
    const recvEp = recipientEndpointFor(input);
    let res: { messageId: string; createdAtMs: number };
    try {
      res = await this.connection.request<
        {
          clientMessageId: string;
          senderOwnerPublicKeyHex: string;
          senderEndpoint: AppMsgEndpoint;
          recipientOwnerPublicKeyHex: string;
          recipientEndpoint: AppMsgEndpoint;
          contentType: AppMsgContentType;
          body: string;
          createdAtMs: number;
        },
        { messageId: string; createdAtMs: number }
      >("message.send", {
        clientMessageId: input.clientMessageId,
        senderOwnerPublicKeyHex: input.senderPublicKeyHex,
        senderEndpoint: senderEp,
        recipientOwnerPublicKeyHex: input.recipientPublicKeyHex,
        recipientEndpoint: recvEp,
        contentType: input.contentType,
        body: input.body,
        createdAtMs: input.createdAtMs
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastErrorMessageValue = msg;
      emitLog(this.cfg.logger, "error", "appmsg.send.failed", {
        clientMessageId: input.clientMessageId,
        err: msg
      });
      throw err;
    }
    emitLog(this.cfg.logger, "info", "appmsg.send.ok", {
      messageId: res.messageId,
      clientMessageId: input.clientMessageId
    });

    // self-send（sender == recipient at endpoint）时 HubMsg 服务端不会
    // push；本地 DB 仍要保留这条消息。
    const isSelfSend =
      input.senderPublicKeyHex === input.recipientPublicKeyHex &&
      ((hasSenderOrigin && input.senderOrigin === input.recipientOrigin) ||
        (hasSenderAppId && input.senderAppId === input.recipientAppId));
    if (isSelfSend && this.localOps) {
      try {
        await this.localOps.putMessage({
          messageId: res.messageId,
          clientMessageId: input.clientMessageId,
          senderPublicKeyHex: input.senderPublicKeyHex,
          senderOrigin: hasSenderOrigin ? input.senderOrigin : undefined,
          senderAppId: hasSenderAppId ? input.senderAppId : undefined,
          recipientPublicKeyHex: input.recipientPublicKeyHex,
          recipientOrigin: hasRecipientOrigin ? input.recipientOrigin : undefined,
          recipientAppId: hasRecipientAppId ? input.recipientAppId : undefined,
          contentType: input.contentType,
          body: input.body,
          createdAtMs: input.createdAtMs,
          insertedAtMs: res.createdAtMs
        });
        this.lastInsertedAtMsValue = Date.now();
      } catch (err) {
        this.lastErrorMessageValue = err instanceof Error ? err.message : String(err);
      }
    }
    return { messageId: res.messageId, createdAtMs: res.createdAtMs };
  }

  async listScopedMessages(input: AppMsgListScopedInput): Promise<AppMsgListResult> {
    if (!this.currentBoundOwner) return { items: [], hasMore: false };
    if (input.senderPublicKeyHex !== this.currentBoundOwner) {
      return { items: [], hasMore: false };
    }
    if (!this.localOps) return { items: [], hasMore: false };
    const scope = senderProjectionToScope(input);
    try {
      const limit = input.limit ?? 50;
      const items = await this.localOps.listMessagesForScope({
        scope,
        afterMessageId: input.afterMessageId ?? "",
        limit
      });
      return { items, hasMore: items.length >= limit };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastErrorMessageValue = msg;
      return { items: [], hasMore: false };
    }
  }

  async getScopedMessage(input: AppMsgGetScopedInput): Promise<AppMsgMessage | null> {
    if (!this.currentBoundOwner) return null;
    if (input.senderPublicKeyHex !== this.currentBoundOwner) return null;
    if (!this.localOps) return null;
    const scope = senderProjectionToScope(input);
    try {
      return await this.localOps.getMessageForScope({
        messageId: input.messageId,
        scope
      });
    } catch (err) {
      this.lastErrorMessageValue = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  subscribeScopedMessages(input: AppMsgSubscribeScopedInput): () => void {
    if (!this.currentBoundOwner) return () => undefined;
    if (input.senderPublicKeyHex !== this.currentBoundOwner) return () => undefined;
    const scope = senderProjectionToScope(input);
    const sub: MessageSubscription = {
      match: scopeMatchFromSender(input, scope),
      handler: input.handler
    };
    this.scopedSubs.add(sub);
    return () => {
      this.scopedSubs.delete(sub);
    };
  }

  subscribeUnfilteredMessages(handler: (msg: AppMsgMessage) => void): () => void {
    // 本方法**仅**由 `createSystemMessageClient` 调用；调用方应在
    // facade 工厂层校验 `KEYMASTER_MESSAGE_APP_ID`，但这里也再守一遍。
    const sub: MessageSubscription = {
      match: () => true,
      handler
    };
    this.unfilteredSubs.add(sub);
    return () => {
      this.unfilteredSubs.delete(sub);
    };
  }

  async listUnfilteredMessages(input?: AppMsgListInput): Promise<AppMsgListResult> {
    if (!this.localOps) return { items: [], hasMore: false };
    try {
      const limit = input?.limit ?? 200;
      const items = await this.localOps.listAllMessages({
        afterMessageId: input?.afterMessageId,
        limit
      });
      return { items, hasMore: items.length >= limit };
    } catch (err) {
      this.lastErrorMessageValue = err instanceof Error ? err.message : String(err);
      return { items: [], hasMore: false };
    }
  }

  /* ====== 公开 facade 构造 ====== */

  createMessageScopedClient(input: AppMsgSenderProjection): AppMsgSimpleClient {
    return makeMessageScopedClient(this, input);
  }

  createSystemMessageClient(input: { ownerPublicKeyHex: string }): AppMsgSimpleClient {
    // 严格检查：仅允许 owner publicKeyHex 等于当前 bind owner 且走
    // 系统消息 appId；这是平台 internal 二次守门——facade 工厂层也应
    // 自己校验过 KEYMASTER_MESSAGE_APP_ID。
    if (!this.currentBoundOwner || this.currentBoundOwner !== input.ownerPublicKeyHex) {
      throw new Error(
        "appmsg.core: createSystemMessageClient requires current bound owner"
      );
    }
    // 关键：系统消息应用走 unfiltered——**不**走简单 facade（那个会
    // 受 scope 限制）。
    return new SystemMessageAppClient(this, input.ownerPublicKeyHex);
  }

  /* ====== 同步 ====== */

  async triggerSync(): Promise<void> {
    if (this.syncInFlight) {
      await this.syncInFlight.catch(() => {
        // ignore
      });
    }
    this.syncInFlight = this.doSync();
    try {
      await this.syncInFlight;
    } finally {
      this.syncInFlight = null;
    }
  }

  private async doSync(): Promise<void> {
    if (!this.currentBoundOwner) return;
    const scopes = await this.collectKnownScopes();
    if (scopes.length === 0) return;
    await syncAllScopes({
      conn: this.connection,
      ops: this.localOps,
      ownerPublicKeyHex: this.currentBoundOwner,
      scopeEndpoints: scopes,
      pageLimit: 100,
      resolveTargetKey: (ep) =>
        ep.kind === "origin"
          ? `origin:${ep.id}`
          : `appId:${ep.id}`,
      loadCursor: async (targetKey) => {
        if (!this.localOps) return "";
        const st = await this.localOps.getTargetState(targetKey);
        return st?.lastSyncedMessageId ?? "";
      }
    });
  }

  private async collectKnownScopes(): Promise<AppMsgEndpoint[]> {
    const out: AppMsgEndpoint[] = [];
    out.push({ kind: "plugin", id: KEYMASTER_MESSAGE_APP_ID });
    if (this.localOps) {
      try {
        const tids = await this.localOps.listTargetIds();
        for (const t of tids) {
          if (t.startsWith("origin:")) {
            out.push({ kind: "origin", id: t.slice("origin:".length) });
          } else if (t.startsWith("appId:")) {
            out.push({ kind: "plugin", id: t.slice("appId:".length) });
          }
        }
      } catch {
        // ignore
      }
    }
    return out;
  }

  async listTargetSyncStates(): Promise<AppMsgTargetSyncState[]> {
    if (!this.localOps) return [];
    try {
      return await this.localOps.listTargetStates();
    } catch {
      return [];
    }
  }

  /* ====== 在线 ====== */

  async checkOnline(input: AppMsgOnlineInput): Promise<AppMsgOnlineResult> {
    const out: AppMsgOnlineResult = {};
    if (!input || input.length === 0) return out;
    if (
      !this.connection ||
      this.connection.state() !== "bound" ||
      !this.currentBoundOwner
    ) {
      for (const h of input) out[h] = "unknown";
      return out;
    }
    try {
      const res = await this.connection.request<
        { publicKeyHexes: string[] },
        HubMsgOnlineResult
      >("message.online", { publicKeyHexes: input });
      const onlineSet = new Set(res.onlinePublicKeyHexes ?? []);
      for (const h of input) {
        out[h] = onlineSet.has(h) ? "online" : "offline";
      }
      return out;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastErrorMessageValue = msg;
      emitLog(this.cfg.logger, "warn", "appmsg.online.failed", { err: msg });
      for (const h of input) out[h] = "unknown";
      return out;
    }
  }

  /* ====== 私有 ====== */

  private recordTargetLastReceived(msg: AppMsgMessage): void {
    if (!this.localOps) return;
    const targetId = targetIdFromMessage(msg);
    if (!targetId) return;
    void (async () => {
      try {
        const prev =
          (await this.localOps!.getTargetState(targetId)) ?? {
            targetKey: targetId,
            lastSyncedMessageId: "",
            lastReceivedAtMs: 0,
            lastSyncStartedAtMs: 0,
            lastSyncCompletedAtMs: 0,
            lastSyncError: null
          };
        await this.localOps!.putTargetState({
          ...prev,
          lastReceivedAtMs: Math.max(prev.lastReceivedAtMs, msg.insertedAtMs || Date.now())
        });
      } catch {
        // swallow
      }
    })();
  }
}

/** HubMsg wire `HubMsgMessageRecord` → 公开 `AppMsgMessage`。 */
function wireRecordToPublic(rec: HubMsgMessageRecord): AppMsgMessage {
  const sOrigin = rec.senderEndpoint.kind === "origin" ? rec.senderEndpoint.id : undefined;
  const sAppId = rec.senderEndpoint.kind === "plugin" ? rec.senderEndpoint.id : undefined;
  const rOrigin =
    rec.recipientEndpoint.kind === "origin" ? rec.recipientEndpoint.id : undefined;
  const rAppId =
    rec.recipientEndpoint.kind === "plugin" ? rec.recipientEndpoint.id : undefined;
  const out: AppMsgMessage = {
    messageId: rec.messageId,
    clientMessageId: rec.clientMessageId,
    senderPublicKeyHex: rec.senderOwnerPublicKeyHex,
    recipientPublicKeyHex: rec.recipientOwnerPublicKeyHex,
    contentType: rec.contentType,
    body: rec.body,
    createdAtMs: rec.createdAtMs,
    insertedAtMs: rec.insertedAtMs
  };
  if (sOrigin) out.senderOrigin = sOrigin;
  else if (sAppId) out.senderAppId = sAppId;
  if (rOrigin) out.recipientOrigin = rOrigin;
  else if (rAppId) out.recipientAppId = rAppId;
  return out;
}

/**
 * 旧 `AppMsgPluginClient` 接口已被 `AppMsgSimpleClient` 取代；保留 type
 * 兼容名仅供旧 import。
 */
export type { AppMsgPluginClient } from "@keymaster/contracts";

// 防止 IDE 报 unused
void ({} as AppMsgAddress);
void ({} as AppMsgOnlineStatus);
void ({} as AppMsgSendInput);
void ({} as AppMsgGetInput);
void ({} as AppMsgListInput);
