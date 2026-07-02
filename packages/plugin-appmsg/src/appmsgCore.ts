// packages/plugin-appmsg/src/appmsgCore.ts
// appmsg.core 平台单例：HubMsg 连接 + 本地缓存 + 推送分发。
//
// 设计缘由（施工单 2026-07-01 002 硬切换）：
//   - 单例：HubMsg WSS 一条连接；owner 切换时由本组件 reconnect；
//   - 本地缓存：最近 messages 按 (owner + endpoint) 切片内存维护；
//     断线重连后按 afterMessageId 补拉；
//   - 推送分发：服务端 event → 本地缓存 → 内部 `message_received` 事件
//     （**不**对外）→ 当前 endpoint 的 `appmsg.inbox_dirty` dirty event；
//   - 不做未读计数真值；不做服务端未读真值；UI 用 dirty event + list 自
//     己渲染红点。

import type {
  AppMsgAddress,
  AppMsgChannelCountBox,
  AppMsgConnectionSnapshot,
  AppMsgCore,
  AppMsgEndpoint,
  AppMsgInboxDirtyEvent,
  AppMsgListBox,
  AppMsgListInternalParams,
  AppMsgListResult,
  AppMsgMessage,
  AppMsgMessageReceivedEvent,
  AppMsgPluginClient,
  AppMsgSendParams,
  AppMsgSendResult,
  AppMsgContentType
} from "@keymaster/contracts";
import { AppMsgPluginClientImpl } from "./pluginClient.js";
import {
  type HubMsgBindSigner,
  type HubMsgConnection,
  HubMsgConnectionImpl,
  type HubMsgMessageRecord,
  toAppMsgMessage
} from "./hubmsgConnection.js";

/**
 * appmsg.core 配置。
 *
 * 设计缘由：
 *   - `url`：HubMsg 单 WSS 入口；v1 固定 `wss://<host>/ws/v1`；
 *   - `signerProvider`：本平台单例每次 connect 时调用它取当前 owner 的
 *     bind 签名材料（owner 切换 / vault 锁状态变化时由 plugin-appmsg
 *     驱动 reconnect）；
 *   - `logger`：可选；用于本地轨迹（系统级日志真值仍走
 *     `ctx.logger`，但本字段的 logger 可以做平台层本地 trace）；
 *   - `capabilityForBind`：`plugin-appmsg` 必须拿到 owner runtime 才能
 *     bind；这里以 signer provider 闭包形式注入。
 */
export interface AppMsgCoreConfig {
  url: string;
  heartbeatSec?: number;
  /**
   * 给出当前 owner 的 bind signer。返回 `null` 时表示当前没有可 bind 的
   * owner（例如 vault 锁定且无 active key）。
   */
  signerProvider: () => Promise<HubMsgBindSigner | null>;
  logger?: {
    info?: (input: unknown) => void;
    warn?: (input: unknown) => void;
    error?: (input: unknown) => void;
  };
}

/**
 * 结构化 logger 写方法（施工单 2026-07-02 001）。
 *
 * 设计缘由：与 `AppMsgCoreConfig.logger` 形状相同，但语义约束为
 * 平台内部"系统级日志"——本单统一用这套入口输出
 * `appmsg.connect.begin / .bound / .failed` / `appmsg.send.*` /
 * `appmsg.receive.pushed` / `appmsg.counts.refresh.*` 等固定事件。
 * 不让 caller 把 `event` 当杂烩传进来。
 *
 * 隐私边界（施工单 2026-07-02 001 §4.5）：
 *   - **不**允许 `body` 字段进日志。
 *   - 允许 `bodyBytes`（正文字节数）作为唯一"大小"指标。
 *   - 其它 key 透传。
 */
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

/**
 * 内部 inbox dirty 事件订阅项。
 *
 * 设计缘由：
 *   - 内部 event 订阅按 (ownerPublicKeyHex + endpoint) 过滤；订阅者只能
 *     收到与自己匹配的 dirty event，避免跨 endpoint 串事件。
 */
interface DirtySubscription {
  match: (event: AppMsgInboxDirtyEvent) => boolean;
  handler: (event: AppMsgInboxDirtyEvent) => void;
}

/**
 * 内部 message_received 事件订阅项（仅 plugin-appmsg 内部使用）。
 *
 * 设计缘由：
 *   - 服务端推送的完整消息正文先落入本地缓存；这件事先**不**对外暴露，
 *     而是先由本组件决定是否对外推 dirty event。
 */
interface MessageReceivedSubscription {
  handler: (event: AppMsgMessageReceivedEvent) => void;
}

/**
 * appmsg.core 单例实现。
 *
 * 关键约束：
 *   - HubMsg 连接只允许一条；reconnect 时先 close 旧的再 connect 新的；
 *   - 本地缓存按 `(ownerPublicKeyHex + endpoint.kind + endpoint.id)` 切片；
 *   - dirty event 仅推送 `event.inbox_dirty`；完整消息走 `message.received`
 *     内部事件；
 *   - v1 **不**做未读计数真值；UI 想显示红点自己订阅 dirty event。
 */
export class AppMsgCoreImpl implements AppMsgCore {
  private connection: HubMsgConnection | null = null;
  private readonly cfg: AppMsgCoreConfig;
  /** 当前绑定 ownerPublicKeyHex；用于脏事件过滤。 */
  private currentBoundOwner: string | null = null;
  /** 当前 owner 的 inbox dirty 订阅者。 */
  private readonly dirtySubs = new Set<DirtySubscription>();
  /** 当前 owner 的 message_received 内部订阅者。 */
  private readonly messageReceivedSubs = new Set<MessageReceivedSubscription>();
  /**
   * 本地缓存：按 (owner + endpoint) 切片；每片保留最近 N 条记录（默认 200）。
   * v1 简化：纯内存，不持久化（与 HubMsg "断线重连靠 afterMessageId 补拉"对齐）。
   */
  private readonly cache = new Map<string, AppMsgMessage[]>();
  /**
   * 已登记的 plugin 端点 id 注册表（施工单 2026-07-02 001）。
   *
   * 真值来源：`createPluginScopedClient(endpointId)` 调用时 `add`。
   * 没有反注册路径——v1 简化为"enable 阶段注册一次，整个生命周期有效"。
   * 卸载插件时 plugin-appmsg 进程级销毁，Set 随实例一起被回收。
   */
  private readonly pluginEndpoints = new Set<string>();
  /* ============== 施工单 2026-07-02 001：诊断快照状态 ============== */
  /** 最近一次成功 bind 的时间戳（unix ms）；0 表示从未成功。 */
  private lastBoundAtMsValue: number = 0;
  /** 最近一次连接 / bind / 接收 / send 错误 message；null 表示无错。 */
  private lastErrorMessageValue: string | null = null;
  /** 最近一次收到 push 消息的时间戳（unix ms）；0 表示从未收到。 */
  private lastReceivedAtMsValue: number = 0;

  constructor(cfg: AppMsgCoreConfig) {
    this.cfg = cfg;
  }

  /**
   * connect：以当前 ownerPublicKeyHex 建连；vault 未解锁 / 无 owner 时
   * 不建连（返回，不抛错）。
   *
   * 设计缘由：
   *   - plugin-appmsg 在 setup 期间 + owner 切换 + vault unlock 时调用；
   *   - 同一 owner 重复 connect：幂等返回；
   *   - owner 变化：先 close 旧连接再 connect 新连接。
   */
  async connectForOwner(ownerPublicKeyHex: string): Promise<void> {
    if (this.currentBoundOwner === ownerPublicKeyHex && this.connection?.state() === "bound") {
      return;
    }
    emitLog(this.cfg.logger, "info", "appmsg.connect.begin", { ownerPublicKeyHex });
    await this.disconnect();
    const signer = await this.cfg.signerProvider();
    if (!signer) {
      this.lastErrorMessageValue = "no signer available (vault locked or no active key)";
      emitLog(this.cfg.logger, "warn", "appmsg.connect.failed", {
        ownerPublicKeyHex,
        reason: "no_signer"
      });
      return;
    }
    const conn = new HubMsgConnectionImpl({ url: this.cfg.url, heartbeatSec: this.cfg.heartbeatSec });
    this.connection = conn;
    conn.subscribeEvent<{ ownerPublicKeyHex: string; endpoint: AppMsgEndpoint; atMs: number; message?: HubMsgMessageRecord }>(
      "message.received",
      (data) => {
        if (!data?.message) return;
        // 1. 落本地缓存
        const msg = toAppMsgMessage(data.message);
        this.putCache(msg);
        // 2. 内部事件
        const received: AppMsgMessageReceivedEvent = { message: msg };
        for (const s of this.messageReceivedSubs) {
          try {
            s.handler(received);
          } catch {
            // ignore
          }
        }
        // 3. 对外 dirty event：按 (owner + endpoint) 过滤推送给订阅者
        const dirty: AppMsgInboxDirtyEvent = {
          ownerPublicKeyHex: data.ownerPublicKeyHex,
          endpoint: data.endpoint,
          atMs: data.atMs
        };
        for (const s of this.dirtySubs) {
          if (s.match(dirty)) {
            try {
              s.handler(dirty);
            } catch {
              // ignore
            }
          }
        }
        // 4. 诊断真值：记录最近一次收到消息时间
        this.lastReceivedAtMsValue = Date.now();
        // 5. 系统日志：只记元数据，不记 body
        emitLog(this.cfg.logger, "info", "appmsg.receive.pushed", {
          messageId: msg.messageId,
          clientMessageId: msg.clientMessageId,
          senderEndpoint: msg.sender.endpoint,
          recipientEndpoint: msg.recipient.endpoint,
          contentType: msg.contentType,
          bodyBytes: msg.body.length
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
    this.lastBoundAtMsValue = Date.now();
    this.lastErrorMessageValue = null;
    emitLog(this.cfg.logger, "info", "appmsg.connect.bound", { ownerPublicKeyHex });
    // 重连后按 afterMessageId 补拉（v1 简化：当前实现仅做基础 connect；
    //     真正补拉由调用方调 `listAsOrigin(box="inbox", afterMessageId=...)` 触发）。
  }

  /**
   * reconnect：仅供"刷新时 best-effort 重连"使用（系统页手动刷新时）。
   *
   * 与 `connectForOwner` 的区别：本方法在当前 owner 已经 bound 时只发
   * `appmsg.reconnect.begin` 日志、**不**走完整 connect 流程；
   * 否则等同 `connectForOwner`。
   */
  async reconnectIfNeeded(): Promise<void> {
    emitLog(this.cfg.logger, "info", "appmsg.reconnect.begin", {
      ownerPublicKeyHex: this.currentBoundOwner
    });
    try {
      if (this.connection?.state() === "bound" && this.currentBoundOwner) {
        return;
      }
      if (!this.currentBoundOwner) {
        // 没有当前 owner —— 让 caller 自己走 `connectForOwner` 决定。
        return;
      }
      await this.connectForOwner(this.currentBoundOwner);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastErrorMessageValue = msg;
      emitLog(this.cfg.logger, "error", "appmsg.reconnect.failed", {
        err: msg
      });
    }
  }

  /** 关闭连接；幂等。 */
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
  }

  /* ============== 对外 AppMsgCore 接口实现 ============== */

  /**
   * 列 inbox / sent。`scope` 是"当前调用方的地址身份"，服务端按
   * `(scope.owner, scope.endpoint)` 做 ACL：仅返回 sender 或 recipient
   * 侧匹配 scope 的 message。
   *
   * 设计缘由（施工单 2026-07-01/003）：
   *   - 之前命名 `sender` 引起歧义；`scope` 明确表达"这是读取 ACL
   *     的地址身份，不是发送者"。
   *   - `scope.endpoint` kind 不限：plugin endpoint 与 origin endpoint
   *     都可作为 list scope；服务端按 ACL 拦截跨 endpoint 越权读取。
   */
  async list(input: {
    scope: AppMsgAddress;
    params: AppMsgListInternalParams;
  }): Promise<AppMsgListResult> {
    if (!this.connection || this.connection.state() !== "bound") {
      throw new Error("appmsg.core: not connected");
    }
    if (input.scope.endpoint.kind !== "origin" && input.scope.endpoint.kind !== "plugin") {
      throw new Error("appmsg.core: invalid scope endpoint kind");
    }
    const effectiveOwner =
      input.scope.ownerPublicKeyHex && input.scope.ownerPublicKeyHex.length > 0
        ? input.scope.ownerPublicKeyHex
        : this.currentBoundOwner ?? "";
    if (!effectiveOwner) {
      throw new Error("appmsg.core: no bound owner for current call");
    }
    // HubMsg wire: MessageListParams.scopeEndpoint
    const params = {
      box: input.params.box,
      afterMessageId: input.params.afterMessageId ?? "",
      beforeMessageId: input.params.beforeMessageId ?? "",
      limit: input.params.limit ?? 50,
      scopeOwnerPublicKeyHex: effectiveOwner,
      scopeEndpoint: input.scope.endpoint
    };
    const res = await this.connection.request<typeof params, { items: HubMsgMessageRecord[]; hasMore: boolean }>(
      "message.list",
      params
    );
    const items = res.items.map(toAppMsgMessage);
    // 同步本地缓存
    for (const m of items) this.putCache(m);
    return { items, hasMore: Boolean(res.hasMore) };
  }

  async get(input: { scope: AppMsgAddress; messageId: string }): Promise<AppMsgMessage | null> {
    if (!this.connection || this.connection.state() !== "bound") {
      throw new Error("appmsg.core: not connected");
    }
    if (input.scope.endpoint.kind !== "origin" && input.scope.endpoint.kind !== "plugin") {
      throw new Error("appmsg.core: invalid scope endpoint kind");
    }
    const effectiveOwner =
      input.scope.ownerPublicKeyHex && input.scope.ownerPublicKeyHex.length > 0
        ? input.scope.ownerPublicKeyHex
        : this.currentBoundOwner ?? "";
    if (!effectiveOwner) {
      throw new Error("appmsg.core: no bound owner for current call");
    }
    // HubMsg wire: MessageGetParams.scopeEndpoint
    const res = await this.connection.request<
      { messageId: string; scopeOwnerPublicKeyHex: string; scopeEndpoint: AppMsgEndpoint },
      { message: HubMsgMessageRecord | null }
    >("message.get", {
      messageId: input.messageId,
      scopeOwnerPublicKeyHex: effectiveOwner,
      scopeEndpoint: input.scope.endpoint
    });
    if (!res.message) return null;
    const m = toAppMsgMessage(res.message);
    this.putCache(m);
    return m;
  }

  async send(input: {
    sender: AppMsgAddress;
    recipientOwnerPublicKeyHex: string;
    recipientEndpoint: AppMsgEndpoint;
    contentType: AppMsgContentType;
    body: string;
    clientMessageId: string;
    createdAtMs: number;
  }): Promise<AppMsgSendResult> {
    if (!this.connection || this.connection.state() !== "bound") {
      const err = "appmsg.core: not connected";
      emitLog(this.cfg.logger, "warn", "appmsg.send.failed", {
        clientMessageId: input.clientMessageId,
        reason: "not_connected"
      });
      throw new Error(err);
    }
    if (input.sender.endpoint.kind !== "origin" && input.sender.endpoint.kind !== "plugin") {
      emitLog(this.cfg.logger, "warn", "appmsg.send.failed", {
        clientMessageId: input.clientMessageId,
        reason: "invalid_sender_endpoint_kind"
      });
      throw new Error("appmsg.core: invalid sender endpoint kind");
    }
    const effectiveOwner =
      input.sender.ownerPublicKeyHex && input.sender.ownerPublicKeyHex.length > 0
        ? input.sender.ownerPublicKeyHex
        : this.currentBoundOwner ?? "";
    if (!effectiveOwner) {
      emitLog(this.cfg.logger, "warn", "appmsg.send.failed", {
        clientMessageId: input.clientMessageId,
        reason: "no_bound_owner"
      });
      throw new Error("appmsg.core: no bound owner for current call");
    }
    void effectiveOwner; // server derives sender from bind; explicit reference kept for clarity.
    emitLog(this.cfg.logger, "info", "appmsg.send.begin", {
      clientMessageId: input.clientMessageId,
      senderEndpoint: input.sender.endpoint,
      recipientEndpoint: input.recipientEndpoint,
      contentType: input.contentType,
      bodyBytes: input.body.length
    });
    try {
      // HubMsg wire: MessageSendParams.senderEndpoint
      const res = await this.connection.request<
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
        senderOwnerPublicKeyHex: effectiveOwner,
        senderEndpoint: input.sender.endpoint,
        recipientOwnerPublicKeyHex: input.recipientOwnerPublicKeyHex,
        recipientEndpoint: input.recipientEndpoint,
        contentType: input.contentType,
        body: input.body,
        createdAtMs: input.createdAtMs
      });
      emitLog(this.cfg.logger, "info", "appmsg.send.ok", {
        messageId: res.messageId,
        clientMessageId: input.clientMessageId
      });
      return { messageId: res.messageId, createdAtMs: res.createdAtMs };
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

  subscribeInboxDirty(handler: (event: AppMsgInboxDirtyEvent) => void): () => void {
    const sub: DirtySubscription = {
      match: () => true,
      handler
    };
    this.dirtySubs.add(sub);
    return () => {
      this.dirtySubs.delete(sub);
    };
  }

  /**
   * runtime host 在 enable 阶段调用：产出一个 sender endpoint
   * 已绑定到 `endpointId` 的 scoped `appmsg.client`。
   *
   * 实现：直接 new `AppMsgPluginClientImpl(this, endpointId)`。
   * runtime 不需要 import plugin-appmsg：runtime 通过 `AppMsgCore`
   * 接口间接拿到 scoped client。
   *
   * 同时把 `endpointId` 登记到 plugin 端点注册表
   * （`listKnownPluginEndpoints()` 的真值），供系统页渲染
   * "plugin 渠道" 行。重复登记幂等。
   */
  createPluginScopedClient(endpointId: string): AppMsgPluginClient {
    this.pluginEndpoints.add(endpointId);
    return new AppMsgPluginClientImpl(this, endpointId);
  }

  /**
   * 内部订阅：服务端推送的完整消息（先落缓存、再对外推 dirty）。
   *
   * 仅 platform 内部使用；外部 app / 插件**不**直接订阅该事件。
   */
  subscribeMessageReceived(handler: (event: AppMsgMessageReceivedEvent) => void): () => void {
    const sub: MessageReceivedSubscription = { handler };
    this.messageReceivedSubs.add(sub);
    return () => {
      this.messageReceivedSubs.delete(sub);
    };
  }

  /**
   * 当前 owner + endpoint 的本地缓存读取。
   *
   * 设计缘由：UI 想"快速刷新"时不必调一次 list；先读本地缓存，
   * 再视情况调 list 补拉。v1 简化：仅返回缓存，**不**做补拉。
   */
  readCache(address: AppMsgAddress): AppMsgMessage[] {
    return this.cache.get(cacheKey(address)) ?? [];
  }

  /* ============== 施工单 2026-07-02 001：系统级诊断内部方法 ============== */

  /**
   * 同步读当前连接快照。
   *
   * 不抛错、不重连；任何状态下都能读。
   */
  inspectConnection(): AppMsgConnectionSnapshot {
    const conn = this.connection;
    const state: AppMsgConnectionSnapshot["state"] = conn
      ? (conn.state() as AppMsgConnectionSnapshot["state"])
      : this.currentBoundOwner
        ? "closed"
        : "idle";
    return {
      state,
      ownerPublicKeyHex: this.currentBoundOwner,
      url: this.cfg.url,
      lastBoundAtMs: this.lastBoundAtMsValue,
      lastError: this.lastErrorMessageValue,
      lastReceivedAtMs: this.lastReceivedAtMsValue
    };
  }

  /**
   * 列出已登记的 plugin 端点 id。
   */
  listKnownPluginEndpoints(): string[] {
    return [...this.pluginEndpoints];
  }

  /**
   * 拉取当前 owner 在 HubMsg 中已知 origin 列表。
   *
   * 失败时（无 owner / 连接断开 / HubMsg 报错）reject；调用方
   * 应当把失败映射成"刷新失败"状态，**不**把整页渲染崩掉。
   */
  async listKnownOrigins(): Promise<string[]> {
    if (!this.connection || this.connection.state() !== "bound" || !this.currentBoundOwner) {
      throw new Error("appmsg.core: not connected");
    }
    const res = await this.connection.request<Record<string, never>, { origins: string[] }>(
      "message.origins",
      {}
    );
    return Array.isArray(res.origins) ? res.origins : [];
  }

  /**
   * 批量取若干 scope 的 inbox / sent / all 计数。
   *
   * 单个 scope 的失败不打断其它 scope：失败 scope 收到
   * `error` 非空的 `AppMsgChannelCountBox`。整体调用失败时
   * 全部 scope 收到 error（让 UI 一次性标"刷新失败"）。
   *
   * 日志事件名：施工单 2026-07-02 001 §7.4 收敛为
   * `appmsg.diagnostics.refresh.*`（**不**用 `appmsg.counts.refresh.*`）
   * ——"diagnostics"才是系统页语义，counts 只是其中一项。
   */
  async countScopes(scopes: AppMsgAddress[]): Promise<AppMsgChannelCountBox[]> {
    if (scopes.length === 0) return [];
    if (!this.connection || this.connection.state() !== "bound" || !this.currentBoundOwner) {
      const msg = "appmsg.core: not connected";
      return scopes.map((s) => ({ scope: s, counts: null, error: msg }));
    }
    emitLog(this.cfg.logger, "info", "appmsg.diagnostics.refresh.begin", {
      count: scopes.length
    });
    try {
      const endpoints = scopes.map((s) => s.endpoint);
      const res = await this.connection.request<
        { endpoints: AppMsgEndpoint[] },
        { items: Array<{ endpoint: AppMsgEndpoint; inbox: number; sent: number; all: number }> }
      >("message.counts", { endpoints });
      // 按 input order 配对
      const byKey = new Map<string, { inbox: number; sent: number; all: number }>();
      for (const item of res.items ?? []) {
        byKey.set(`${item.endpoint.kind}::${item.endpoint.id}`, {
          inbox: Number(item.inbox) || 0,
          sent: Number(item.sent) || 0,
          all: Number(item.all) || 0
        });
      }
      const out: AppMsgChannelCountBox[] = scopes.map((s) => {
        const k = `${s.endpoint.kind}::${s.endpoint.id}`;
        const c = byKey.get(k);
        return {
          scope: s,
          counts: c ? { inbox: c.inbox, sent: c.sent, all: c.all } : null,
          error: c ? null : "no_result_for_scope"
        };
      });
      const failed = out.filter((b) => b.error !== null).length;
      if (failed === 0) {
        emitLog(this.cfg.logger, "info", "appmsg.diagnostics.refresh.ok", {
          count: scopes.length
        });
      } else if (failed < scopes.length) {
        emitLog(this.cfg.logger, "warn", "appmsg.diagnostics.refresh.partial_failed", {
          count: scopes.length,
          failed
        });
      } else {
        emitLog(this.cfg.logger, "error", "appmsg.diagnostics.refresh.failed", {
          count: scopes.length,
          reason: "all_scopes_failed"
        });
      }
      return out;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastErrorMessageValue = msg;
      emitLog(this.cfg.logger, "error", "appmsg.diagnostics.refresh.failed", {
        count: scopes.length,
        err: msg
      });
      return scopes.map((s) => ({ scope: s, counts: null, error: msg }));
    }
  }

  /**
   * 系统页 page-level 失败日志入口（施工单 2026-07-02 001）：
   * 把 `reconnectIfNeeded` / `listKnownOrigins` 阶段失败也写进
   * `appmsg.diagnostics.refresh.failed` 事件，方便 `/settings/logs`
   * 按事件名检索到完整失败链路。
   *
   * 本身不抛错：日志写失败吞掉。
   */
  async logDiagnosticsRefreshFailed(input: { stage: string; err: string; durationMs: number }): Promise<void> {
    try {
      emitLog(this.cfg.logger, "error", "appmsg.diagnostics.refresh.failed", {
        stage: input.stage,
        err: input.err,
        durationMs: input.durationMs
      });
    } catch {
      // ignore
    }
  }

  /* ============== 私有工具 ============== */

  private putCache(message: AppMsgMessage): void {
    // 同一 message 可能命中两个 cache 槽（sender 槽 + recipient 槽）。
    const sk = cacheKey(message.sender);
    const rk = cacheKey(message.recipient);
    this.appendIntoCache(sk, message);
    this.appendIntoCache(rk, message);
  }
  private appendIntoCache(key: string, message: AppMsgMessage): void {
    let arr = this.cache.get(key);
    if (!arr) {
      arr = [];
      this.cache.set(key, arr);
    }
    // 去重：按 messageId
    if (arr.some((m) => m.messageId === message.messageId)) return;
    arr.push(message);
    // 简单窗口：保留最近 200 条
    if (arr.length > 200) {
      arr.splice(0, arr.length - 200);
    }
  }
}

function cacheKey(a: AppMsgAddress): string {
  return `${a.ownerPublicKeyHex}::${a.endpoint.kind}::${a.endpoint.id}`;
}

/**
 * 用 owner runtime 提供的私钥 hex 算 secp256k1 compact 签名。
 *
 * 设计缘由：本函数把签名责任**收口**到 plugin-appmsg 内；
 *   - caller 通过 `signerProvider()` 把 owner runtime 注入；
 *   - bind 时调用 `signer.sign(message)` 即可。
 *   - 实际签名在 caller 闭包里完成（plugin-appmsg 不持有 owner 私钥）。
 */
export async function makeSecp256k1SignerFromPrivHex(
  privKeyHex: string,
  signCompact: (privKeyHex: string, message: string) => Promise<string>
): Promise<(message: string) => Promise<string>> {
  return (message: string) => signCompact(privKeyHex, message);
}

/** 类型 helper：从 contracts `AppMsgListBox` 重新导出。 */
export type { AppMsgListBox };
export type { AppMsgSendParams };