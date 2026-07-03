// packages/plugin-appmsg/src/appmsgCore.ts
// appmsg.core 平台单例：HubMsg 连接 + 本地消息库 + 推送分发 + 增量同步 + 在线查询。
//
// 设计缘由（施工单 2026-07-03 001）：
//   - 单例：HubMsg WSS 一条连接；owner 切换时由本组件 reconnect；vault 锁时
//     关闭。
//   - **单真值在 Keymaster 本地 DB**（`packages/plugin-appmsg/src/appmsgDb.ts`）：
//     HubMsg 仅做远端持久化 / 实时推送 / 在线查询。
//   - 推送链路固定：HubMsg push → appmsg.core 落本地库 → 派发给订阅者 →
//     异步触发一次增量同步。
//   - 公开接口只暴露简单 facade：`sendMessage` / `listMessages` /
//     `getMessage` / `subscribeMessages` / `checkOnline`——owner / endpoint /
//     box / atMs 全部不出现。
//   - 失败语义：best-effort + 重连 + 增量同步自愈；**不**做 replay 队列、
//     **不**做按 message seq ack、**不**做 transport seq。

import type {
  AppMsgAddress,
  AppMsgContentType,
  AppMsgCore,
  AppMsgEndpoint,
  AppMsgGetInput,
  AppMsgListInput,
  AppMsgListResult,
  AppMsgLocalDbSnapshot,
  AppMsgMessage,
  AppMsgOnlineInput,
  AppMsgOnlineResult,
  AppMsgSendInput,
  AppMsgSendResult,
  AppMsgSimpleClient,
  AppMsgTargetSyncState,
  KeyScopedStorageHandle,
  KeyspaceService
} from "@keymaster/contracts";
import {
  HubMsgConnectionImpl,
  type HubMsgConnection,
  type HubMsgMessageRecord,
  type HubMsgOnlineResult,
  toAppMsgMessage
} from "./hubmsgConnection.js";
import {
  computeTargetId,
  createAppMsgLocalDbOps,
  disposeAppMsgLocalDb,
  inspectLocalDb,
  openAppMsgLocalDb,
  type AppMsgLocalDbOps
} from "./appmsgDb.js";
import { syncAllScopes, syncOneScope } from "./appmsgSync.js";
import { makeMessageScopedClient } from "./messageFacade.js";

/**
 * appmsg.core 配置。
 */
export interface AppMsgCoreConfig {
  url: string;
  heartbeatSec?: number;
  /**
   * 给出当前 owner 的 bind signer。返回 `null` 时表示当前没有可 bind 的
   * owner（vault 锁定 / 无 active key）。
   */
  signerProvider: () => Promise<HubMsgBindSigner | null>;
  /** 注入 keyspace 适配（active key 解析 + storageId 名）。 */
  keyspace: KeyspaceService;
  pluginId: string;
  storageId: string;
  logger?: {
    info?: (input: unknown) => void;
    warn?: (input: unknown) => void;
    error?: (input: unknown) => void;
  };
}

// 兼容旧 hubmsgConnection 文件里仍按 namespace 导出 `HubMsgBindSigner`
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

/** 内部完整消息订阅项。 */
interface MessageSubscription {
  handler: (msg: AppMsgMessage) => void;
}

/** 把公开 sender 投影 + clientMessageId 转成 HubMsg wire senderEndpoint。 */
function senderEndpointFor(senderProjection: {
  senderOrigin?: string;
  senderAppId?: string;
}): AppMsgEndpoint {
  if (senderProjection.senderOrigin) {
    return { kind: "origin", id: senderProjection.senderOrigin };
  }
  if (senderProjection.senderAppId) {
    return { kind: "plugin", id: senderProjection.senderAppId };
  }
  return { kind: "plugin", id: "" };
}

/**
 * 把公开 `AppMsgMessage` 转成 HubMsg wire `HubMsgMessageRecord` 形态。
 *
 * HubMsg wire 上仍走 `(ownerPublicKeyHex + endpoint)`；本仓库公开视图
 * 用 `senderPublicKeyHex + (origin|appId)`；这里在边界做一次单向映射。
 *
 * 注意：本函数当前**未**在 appmsg.core 主路径使用，保留只为可能出现的
 * 内部 send-out 转 wire 路径。
 */
function toWireMessageRecord(m: AppMsgMessage): HubMsgMessageRecord {
  return {
    messageId: m.messageId,
    clientMessageId: m.clientMessageId,
    senderOwnerPublicKeyHex: m.senderPublicKeyHex,
    senderEndpoint: senderEndpointFor({
      senderOrigin: m.senderOrigin,
      senderAppId: m.senderAppId
    }),
    recipientOwnerPublicKeyHex: m.recipientPublicKeyHex,
    recipientEndpoint: senderEndpointFor({
      senderOrigin: m.recipientOrigin,
      senderAppId: m.recipientAppId
    }),
    contentType: m.contentType,
    body: m.body,
    createdAtMs: m.createdAtMs,
    insertedAtMs: m.insertedAtMs
  };
}

/** 把 HubMsg wire `AppMsgMessageRecord` 转成公开 `AppMsgMessage`。 */
function wireRecordToPublic(rec: HubMsgMessageRecord): AppMsgMessage {
  const sOrigin = rec.senderEndpoint.kind === "origin" ? rec.senderEndpoint.id : undefined;
  const sAppId = rec.senderEndpoint.kind === "plugin" ? rec.senderEndpoint.id : undefined;
  const rOrigin = rec.recipientEndpoint.kind === "origin" ? rec.recipientEndpoint.id : undefined;
  const rAppId = rec.recipientEndpoint.kind === "plugin" ? rec.recipientEndpoint.id : undefined;
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

/* ====== 主实现 ====== */

export class AppMsgCoreImpl implements AppMsgCore {
  private connection: HubMsgConnection | null = null;
  private readonly cfg: AppMsgCoreConfig;
  /** 当前绑定的 ownerPublicKeyHex。 */
  private currentBoundOwner: string | null = null;
  /** 本地 DB handle。 */
  private localHandle: KeyScopedStorageHandle | null = null;
  /** 当前 owner 的本地 DB ops 句柄。 */
  private localOps: AppMsgLocalDbOps | null = null;
  /** 完整消息订阅者。 */
  private readonly messageSubs = new Set<MessageSubscription>();
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
    // 先开本地 DB（即便 HubMsg 还没连上，本地读取 / 同步状态都能用）。
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

    // 订阅完整消息推送：先落本地库，再派发给订阅者。
    conn.subscribeEvent<{
      message: import("@keymaster/contracts").AppMsgMessage;
    }>(
      "message.received",
      (data) => {
        if (!data?.message) return;
        const publicMsg = data.message as unknown as AppMsgMessage;
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
        // 2. 派发给订阅者
        for (const s of this.messageSubs) {
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
    // 绑定后立即做一次增量同步（best-effort）
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
      // 旧的本地 DB 不属于这个 owner；忽略。
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

  /** 切换 owner 时由 connectForOwner 内部调用。 */
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

  /* ====== 公开 facade ====== */

  async listLocalMessages(input?: AppMsgListInput): Promise<AppMsgListResult> {
    if (!this.localOps) {
      return { items: [], hasMore: false };
    }
    try {
      const targetKey = await this.defaultTargetKeyForCurrent();
      const afterMessageId = input?.afterMessageId ?? "";
      const limit = input?.limit ?? 50;
      const items = await this.localOps.listMessages({
        targetId: targetKey ?? undefined,
        afterMessageId,
        limit
      });
      return { items, hasMore: items.length >= limit };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastErrorMessageValue = msg;
      emitLog(this.cfg.logger, "warn", "appmsg.local.list.failed", { err: msg });
      return { items: [], hasMore: false };
    }
  }

  async getLocalMessage(input: AppMsgGetInput): Promise<AppMsgMessage | null> {
    if (!this.localOps) return null;
    try {
      return await this.localOps.getMessage(input.messageId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastErrorMessageValue = msg;
      emitLog(this.cfg.logger, "warn", "appmsg.local.get.failed", { err: msg });
      return null;
    }
  }

  async sendMessage(input: AppMsgSendInput): Promise<AppMsgSendResult> {
    if (
      !this.connection ||
      this.connection.state() !== "bound" ||
      !this.currentBoundOwner
    ) {
      const msg = "appmsg.core: not connected";
      emitLog(this.cfg.logger, "warn", "appmsg.send.failed", {
        clientMessageId: input.clientMessageId,
        reason: "not_connected"
      });
      throw new Error(msg);
    }
    if (!input.recipientPublicKeyHex) {
      throw new Error("appmsg.send: recipientPublicKeyHex required");
    }
    const hasOrigin =
      typeof input.recipientOrigin === "string" && input.recipientOrigin.length > 0;
    const hasAppId =
      typeof input.recipientAppId === "string" && input.recipientAppId.length > 0;
    if (hasOrigin === hasAppId) {
      throw new Error("appmsg.send: exactly one of recipientOrigin / recipientAppId required");
    }
    emitLog(this.cfg.logger, "info", "appmsg.send.begin", {
      clientMessageId: input.clientMessageId,
      contentType: input.contentType,
      bodyBytes: input.body.length
    });
    try {
      const result = await this.connection.request<
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
        senderOwnerPublicKeyHex: this.currentBoundOwner,
        senderEndpoint: { kind: "plugin", id: "" }, // 由 call site 在 protocolService 注入；core sendMessage 由 facade 调用，senderProjection 应自报
        recipientOwnerPublicKeyHex: input.recipientPublicKeyHex,
        recipientEndpoint: {
          kind: hasOrigin ? "origin" : "plugin",
          id: hasOrigin ? (input.recipientOrigin as string) : (input.recipientAppId as string)
        },
        contentType: input.contentType,
        body: input.body,
        createdAtMs: input.createdAtMs
      });
      emitLog(this.cfg.logger, "info", "appmsg.send.ok", {
        messageId: result.messageId,
        clientMessageId: input.clientMessageId
      });
      return { messageId: result.messageId, createdAtMs: result.createdAtMs };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastErrorMessageValue = msg;
      emitLog(this.cfg.logger, "error", "appmsg.send.failed", {
        clientMessageId: input.clientMessageId,
        err: msg
      });
      throw err;
    }
  }

  subscribeMessages(handler: (msg: AppMsgMessage) => void): () => void {
    const sub: MessageSubscription = { handler };
    this.messageSubs.add(sub);
    return () => {
      this.messageSubs.delete(sub);
    };
  }

  /**
   * 主动触发一次增量同步。
   *
   * 失败就失败——不抛错。下次重连 / 下次推送 / 下次手动刷新继续。
   */
  async triggerSync(): Promise<void> {
    if (this.syncInFlight) {
      // 多个 trigger 并发时串行化：同时只跑一次。
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
        computeTargetId({
          recipientOrigin: ep.kind === "origin" ? ep.id : undefined,
          recipientAppId: ep.kind === "plugin" ? ep.id : undefined
        }),
      loadCursor: async (targetKey) => {
        if (!this.localOps) return "";
        const st = await this.localOps.getTargetState(targetKey);
        return st?.lastSyncedMessageId ?? "";
      }
    });
  }

  /**
   * 收件维度集合：当前 owner 在本地库已有 target + 系统消息应用自身 +
   * plugin 端点（本地已知）。
   */
  private async collectKnownScopes(): Promise<AppMsgEndpoint[]> {
    const out: AppMsgEndpoint[] = [];
    // 系统消息应用自身必加。
    out.push({ kind: "plugin", id: "keymaster.message" });
    // 当前 owner 收件维度：本地 DB 已存在的 targets。
    if (this.localOps) {
      try {
        const tids = await this.localOps.listTargetIds();
        for (const t of tids) {
          const ep = parseTargetKeyToEndpoint(t);
          if (ep) out.push(ep);
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

  async checkOnline(input: AppMsgOnlineInput): Promise<AppMsgOnlineResult> {
    const out: AppMsgOnlineResult = {};
    if (!input || input.length === 0) return out;
    if (
      !this.connection ||
      this.connection.state() !== "bound" ||
      !this.currentBoundOwner
    ) {
      // 全 unknown
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

  /**
   * 构造对外 sender 已绑定的 `AppMsgSimpleClient`。
   *
   * 本仓库对外模型：sender = `{ senderPublicKeyHex, senderOrigin? , senderAppId? }`。
   * sender 投影由 runtime / facade 在构造时固定，本方法只做透传 + 把
   * sender 投影写到生成 scoped client 的闭包里。
   */
  createMessageScopedClient(input: {
    senderPublicKeyHex: string;
    senderOrigin?: string;
    senderAppId?: string;
  }): AppMsgSimpleClient {
    return makeMessageScopedClient(this, {
      senderPublicKeyHex: input.senderPublicKeyHex,
      senderOrigin: input.senderOrigin,
      senderAppId: input.senderAppId
    });
  }

  /* ====== 私有工具 ====== */

  private recordTargetLastReceived(msg: AppMsgMessage): void {
    if (!this.localOps) return;
    const targetId = targetIdFromPublicMsg(msg);
    if (!targetId) return;
    // 本次推送到的 messageId 至少为 cursor 的备选（不必一定更新 cursor；
    // 这里只 update lastReceivedAtMs）。cursor 在 syncOneScope 阶段更新。
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

  /** 当前 owner 对应的默认 target key（用于 list 时过滤 "自己收件"）。 */
  private async defaultTargetKeyForCurrent(): Promise<string | null> {
    if (!this.localOps) return null;
    try {
      const ids = await this.localOps.listTargetIds();
      return ids[0] ?? null;
    } catch {
      return null;
    }
  }
}

/** target key → AppMsgEndpoint。 */
function parseTargetKeyToEndpoint(targetKey: string): AppMsgEndpoint | null {
  if (targetKey.startsWith("origin:")) {
    return { kind: "origin", id: targetKey.slice("origin:".length) };
  }
  if (targetKey.startsWith("appId:")) {
    return { kind: "plugin", id: targetKey.slice("appId:".length) };
  }
  return null;
}

/** 公开消息 → target key。 */
function targetIdFromPublicMsg(m: AppMsgMessage): string {
  return computeTargetId({
    recipientOrigin: m.recipientOrigin,
    recipientAppId: m.recipientAppId
  });
}

/* ====== 已废弃 / 仅供类型系统对账 ====== */
// 旧 AppMsgPluginClient 已被 `AppMsgSimpleClient` 取代；保留空 type alias
// 防止已有 `import { AppMsgPluginClient }` 编译失败——runtime 会用
// `createMessageScopedClient(...)` 的结果（`AppMsgSimpleClient`）替代。
export type { AppMsgPluginClient } from "@keymaster/contracts";
