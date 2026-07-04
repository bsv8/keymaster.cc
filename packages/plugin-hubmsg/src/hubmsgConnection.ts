// packages/plugin-hubmsg/src/hubmsgConnection.ts
// HubMsg 单 WSS 连接管理（v1，硬切换 2026-07-04 001 之后）。
//
// 设计缘由：
//   - 单一 WSS 入口：HubMsg 真值层提供的 `wss://<host>/ws/v1`；
//   - 三步握手：server_open -> client_bind -> bind_ready；
//   - 业务帧：request / result / event；
//   - 推送事件：`message.received`（HubMsg → keymaster），本模块内部
//     把 wire `HubMsgMessageRecord` 翻译为标准化 `AppMsgMessage`，对外
//     只暴露标准化输出——**plugin-appmsg 不再接触 wire record**；
//   - 协议 RPC：message.send / message.list / message.get / message.online
//     ——本模块把它们包装成 typed `MessageProviderOperations` 业务方法
//     （sendMessage / listMessages / getMessage / subscribeMessages /
//     checkOnline），**不**暴露字符串方法名给上层；
//   - 本模块**不**依赖具体签名 / 私钥操作；client_bind 的签名由 caller
//     （plugin-appmsg 在 setup 阶段借 owner 私钥）通过 `ProviderSigner`
//     提供；
//   - 旧 `appmsg.inbox_dirty` / `message.origins` / `message.counts`
//     已彻底删除（硬切换 2026-07-03/001）。
//
// 边界：
//   - 本模块**不**依赖具体签名 / 私钥操作；
//   - 本模块**不**做持久化（消息本地库在 plugin-appmsg）；
//   - 本模块**不**做未读计数（v1 不做）；
//   - 本模块**不**做群聊 / 附件 / 撤回 / 编辑 / 已读回执。

import { canonicalBindText } from "@keymaster/contracts";
import type {
  AppMsgContentType,
  AppMsgMessage,
  AppMsgOnlineStatus,
  ProviderEndpointRef,
  ProviderGetInput,
  ProviderListInput,
  ProviderListResult,
  ProviderOnlineInput,
  ProviderOnlineResult,
  ProviderSendInput,
  ProviderSendResult,
  ProviderSenderProjection,
  ProviderSigner
} from "@keymaster/contracts";

/** HubMsg 单 WSS 入口配置。 */
export interface HubMsgConnectionConfig {
  /** 形如 `wss://host/ws/v1`。 */
  url: string;
  /** 心跳秒数；缺省 30s。 */
  heartbeatSec?: number;
}

/* ============== Provider 绑定阶段 ============== */

/**
 * Bind signer 抽象（plugin-appmsg 提供）。
 *
 * 设计缘由（硬切换 2026-07-04 001 修订）：
 *   - 本模块**不**直接拿 owner 私钥 hex；它接收 `HubMsgBindSigner`
 *     闭包，由自己决定何时调用；
 *   - HubMsg 特有的四元组 `(sessionId, nonce, publicKeyHex, issuedAtMs)`
 *     拼接规则（`canonicalBindText`）**下沉**到 `plugin-hubmsg`；
 *   - signer 通用抽象 `signChallenge({challenge})` 接受任意字节返回
 *     hex 签名——provider 内部决定 challenge 内容；当前平台 vault
 *     持有 secp256k1 私钥，所以走 SHA-256 + secp256k1 + compact。
 */
export interface HubMsgBindSigner {
  publicKeyHex: string;
  /**
   * 用 owner 私钥对 `challenge` 字节做 secp256k1 签名（SHA-256 + compact
   * 64-byte），返回小写 hex。
   */
  signChallenge(args: { challenge: Uint8Array }): Promise<string>;
}

/**
 * 把通用 `ProviderSigner` 适配到 HubMsg 内部 `HubMsgBindSigner`。
 *
 * HubMsg bind 流程需要的 challenge 内容由 `canonicalBindText` 给出——
 * 本类**只**做"拼 canonicalBindText → 调通用 signChallenge"，把
 * HubMsg 特有的协议拼接收口在 `plugin-hubmsg` 内部。
 */
export class HubMsgBindSignerAdapter implements HubMsgBindSigner {
  constructor(private readonly providerSigner: ProviderSigner) {}
  get publicKeyHex(): string {
    return this.providerSigner.publicKeyHex;
  }
  async signChallenge(args: { challenge: Uint8Array }): Promise<string> {
    return this.providerSigner.signChallenge({ challenge: args.challenge });
  }
}

/* ============== v1 RPC method / event 名 ============== */

/** v1 RPC method 名常量集合（**仅**本模块内部使用，**不**暴露给上层）。 */
export const HUBMSG_METHOD = {
  MessageSend: "message.send",
  MessageList: "message.list",
  MessageGet: "message.get",
  MessageOnline: "message.online"
} as const;

/** 服务端 push 给 keymaster 的完整消息事件名（硬切换 001 后唯一事件）。 */
export const HUBMSG_EVENT = {
  MessageReceived: "message.received"
} as const;

/* ============== HubMsg wire 内部类型（**不**暴露给上层） ============== */

/**
 * HubMsg 服务端内部消息记录（plugin-hubmsg 内部使用，与 HubMsg wire /
 * store 对齐）。
 *
 * **不**作为公开类型导出。本模块**只**在内部把 `HubMsgMessageRecord`
 * 翻译成标准化 `AppMsgMessage` 后再返回 / 推送。
 */
export interface HubMsgMessageRecord {
  messageId: string;
  clientMessageId: string;
  senderOwnerPublicKeyHex: string;
  senderEndpoint: { kind: "origin" | "plugin"; id: string };
  recipientOwnerPublicKeyHex: string;
  recipientEndpoint: { kind: "origin" | "plugin"; id: string };
  contentType: AppMsgContentType;
  body: string;
  createdAtMs: number;
  insertedAtMs: number;
}

/** `message.received` 事件 data 形态（HubMsg wire）。 */
export interface HubMsgMessageReceivedData {
  message: HubMsgMessageRecord;
}

/** `message.online` 入参（HubMsg wire）。 */
export interface HubMsgOnlineParams {
  publicKeyHexes: string[];
}

/** `message.online` 出参（HubMsg wire）。 */
export interface HubMsgOnlineResult {
  onlinePublicKeyHexes: string[];
}

/** 单条 result 帧。 */
export interface HubMsgResultFrame<T> {
  ok: boolean;
  result?: T;
  error?: { code: string; message: string };
}

/** 连接状态。 */
export type HubMsgConnectionState = "idle" | "connecting" | "bound" | "closed";

/* ============== HubMsg 单 WSS 客户端接口（**仅**本模块内部使用） ============== */

/**
 * HubMsg 单 WSS 客户端接口（**仅**本模块内部使用）。
 *
 * **不**作为公开契约导出。对外暴露的是 `MessageProviderOperations`
 * typed 方法。
 */
export interface HubMsgConnection {
  state(): HubMsgConnectionState;
  /**
   * 异步 connect + bind。
   *
   * 流程：
   *   1. 打开 WSS；
   *   2. 等 server_open；
   *   3. 用 signer 签出 client_bind；
   *   4. 等 bind_ready → state = "bound"。
   */
  connect(signer: HubMsgBindSigner): Promise<void>;
  /** 关闭连接；幂等。 */
  close(): void;
  /**
   * 同步发出 request；用消息 id 与 promise 解耦。
   *
   * 失败语义：
   *   - 超时：reject；调用方决定如何降级；
   *   - 服务端 result(ok=false)：reject with code / message；
   *   - 连接断开中：reject。
   */
  request<TParams, TResult>(
    method: string,
    params: TParams,
    options?: { timeoutMs?: number }
  ): Promise<TResult>;
  /** 订阅服务端推送的 event；返回取消订阅函数。 */
  subscribeEvent<TData>(eventName: string, handler: (data: TData) => void): () => void;
}

/* ============== HubMsg 单 WSS 客户端实现 ============== */

export class HubMsgConnectionImpl implements HubMsgConnection {
  private readonly cfg: HubMsgConnectionConfig;
  /** 注入 socket；默认用浏览器 WebSocket；测试可注入 fake。 */
  private socket: WebSocketLike | null = null;
  private stateValue: HubMsgConnectionState = "idle";
  /** 当前 sessionId（来自 server_open）；bind 后不变。 */
  private sessionId: string | null = null;
  private nonce: string | null = null;
  /** pending request 等待表。 */
  private readonly pendingById = new Map<
    string,
    {
      resolve: (v: unknown) => void;
      reject: (err: unknown) => void;
      timer: ReturnType<typeof setTimeout> | null;
    }
  >();
  /** 事件订阅表。 */
  private readonly eventHandlers = new Map<string, Set<(data: unknown) => void>>();
  private pingHandle: ReturnType<typeof setInterval> | null = null;
  /** 默认请求超时 30s。 */
  private static readonly DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

  constructor(cfg: HubMsgConnectionConfig) {
    this.cfg = { heartbeatSec: 30, ...cfg };
  }

  state(): HubMsgConnectionState {
    return this.stateValue;
  }

  async connect(signer: HubMsgBindSigner): Promise<void> {
    if (this.stateValue === "bound") return;
    if (this.stateValue === "connecting") {
      // 简化：当前实现不做并发 connect 排队；第二次 connect 抛错。
      throw new Error("HubMsg: connect already in progress");
    }
    this.stateValue = "connecting";
    const sock = createWebSocket(this.cfg.url);
    this.socket = sock;
    const serverOpen = new Promise<void>((resolve, reject) => {
      const onMessage = (raw: unknown) => {
        let frame: unknown;
        try {
          frame = typeof raw === "string" ? JSON.parse(raw) : null;
        } catch {
          return;
        }
        if (!isObject(frame)) return;
        if (frame.type === "server_open") {
          if (typeof frame.sessionId !== "string" || typeof frame.nonce !== "string") {
            reject(new Error("HubMsg: server_open invalid"));
            return;
          }
          this.sessionId = frame.sessionId;
          this.nonce = frame.nonce;
          sock.removeEventListener("message", onMessage);
          resolve();
        }
      };
      sock.addEventListener("message", onMessage);
      sock.addEventListener("error", (err) =>
        reject(err instanceof Error ? err : new Error(String(err)))
      );
    });
    await serverOpen;

    // 2) client_bind：原文拼接走本模块**内部**的 `canonicalBindText`
    //    （HubMsg 特有协议拼接收口，**不**泄漏给通用 ProviderSigner）；
    //    调用通用 signer.signChallenge({challenge: utf8(canonicalBindText)})。
    const issuedAtMs = Date.now();
    const plainText = canonicalBindText(
      this.sessionId ?? "",
      this.nonce ?? "",
      signer.publicKeyHex,
      issuedAtMs
    );
    const plainBytes = new TextEncoder().encode(plainText);
    const sigHex = await signer.signChallenge({ challenge: plainBytes });
    const bindFrame = {
      v: 1,
      type: "client_bind",
      sessionId: this.sessionId,
      publicKeyHex: signer.publicKeyHex,
      issuedAtMs,
      sigHex
    };
    const bindReady = new Promise<void>((resolve, reject) => {
      const onMessage = (raw: unknown) => {
        let frame: unknown;
        try {
          frame = typeof raw === "string" ? JSON.parse(raw) : null;
        } catch {
          return;
        }
        if (!isObject(frame)) return;
        if (frame.type === "bind_ready" && frame.sessionId === this.sessionId) {
          sock.removeEventListener("message", onMessage);
          resolve();
        } else if (frame.type === "close") {
          reject(new Error(`HubMsg: bind closed (${String(frame.reason ?? "unknown")})`));
        }
      };
      sock.addEventListener("message", onMessage);
    });
    sock.send(JSON.stringify(bindFrame));
    await bindReady;
    this.stateValue = "bound";

    // 3) 启动 read pump（result / event）
    sock.addEventListener("message", (raw: unknown) => this.onSocketMessage(raw));
    sock.addEventListener("close", () => this.onSocketClose());
    // 4) ping/pong 心跳
    this.startHeartbeat();
  }

  close(): void {
    this.stopHeartbeat();
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // ignore
      }
    }
    this.socket = null;
    this.stateValue = "closed";
    this.sessionId = null;
    this.nonce = null;
    // 拒绝所有 pending
    for (const [, p] of this.pendingById) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error("HubMsg: connection closed"));
    }
    this.pendingById.clear();
  }

  async request<TParams, TResult>(
    method: string,
    params: TParams,
    options?: { timeoutMs?: number }
  ): Promise<TResult> {
    if (this.stateValue !== "bound" || !this.socket) {
      throw new Error("HubMsg: not bound");
    }
    const id = newId();
    const frame = { v: 1, type: "request", id, method, params: params ?? {} };
    const timeoutMs = options?.timeoutMs ?? HubMsgConnectionImpl.DEFAULT_REQUEST_TIMEOUT_MS;
    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingById.delete(id);
        reject(new Error(`HubMsg: request timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingById.set(id, {
        resolve: (v) => resolve(v as TResult),
        reject,
        timer
      });
      try {
        this.socket!.send(JSON.stringify(frame));
      } catch (err) {
        if (timer) clearTimeout(timer);
        this.pendingById.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  subscribeEvent<TData>(eventName: string, handler: (data: TData) => void): () => void {
    let set = this.eventHandlers.get(eventName);
    if (!set) {
      set = new Set();
      this.eventHandlers.set(eventName, set);
    }
    set.add(handler as (data: unknown) => void);
    return () => {
      const s = this.eventHandlers.get(eventName);
      if (!s) return;
      s.delete(handler as (data: unknown) => void);
    };
  }

  private onSocketMessage(raw: unknown): void {
    if (typeof raw !== "string") return;
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isObject(frame)) return;
    if (frame.type === "pong") return;
    if (frame.type === "result" && typeof frame.id === "string") {
      const p = this.pendingById.get(frame.id);
      if (!p) return;
      this.pendingById.delete(frame.id);
      if (p.timer) clearTimeout(p.timer);
      if (frame.ok) {
        p.resolve(frame.result ?? null);
      } else {
        const err = frame.error;
        const msg = isObject(err) ? String(err.message ?? "HubMsg: request failed") : "HubMsg: request failed";
        const code = isObject(err) ? String(err.code ?? "unknown") : "unknown";
        const e = new Error(`${code}: ${msg}`);
        (e as Error & { code?: string }).code = code;
        p.reject(e);
      }
      return;
    }
    if (frame.type === "event" && typeof frame.event === "string") {
      const set = this.eventHandlers.get(frame.event);
      if (!set) return;
      for (const h of set) {
        try {
          h(frame.data);
        } catch {
          // ignore
        }
      }
    }
  }

  private onSocketClose(): void {
    this.stateValue = "closed";
    this.stopHeartbeat();
    for (const [, p] of this.pendingById) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error("HubMsg: socket closed"));
    }
    this.pendingById.clear();
    this.socket = null;
    this.sessionId = null;
    this.nonce = null;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const sec = Math.max(1, this.cfg.heartbeatSec ?? 30);
    this.pingHandle = setInterval(() => {
      if (!this.socket || this.stateValue !== "bound") return;
      try {
        this.socket.send(JSON.stringify({ v: 1, type: "ping", tsMs: Date.now() }));
      } catch {
        // ignore
      }
    }, sec * 1000);
  }

  private stopHeartbeat(): void {
    if (this.pingHandle) {
      clearInterval(this.pingHandle);
      this.pingHandle = null;
    }
  }
}

/** WebSocketLike：抽象出最小可用接口。 */
export interface WebSocketLike {
  send(message: string): void;
  close(): void;
  addEventListener(
    type: "message" | "error" | "close",
    handler: (ev: unknown) => void
  ): void;
  removeEventListener(
    type: "message" | "error" | "close",
    handler: (ev: unknown) => void
  ): void;
}

function createWebSocket(url: string): WebSocketLike {
  if (typeof WebSocket === "undefined") {
    throw new Error("HubMsg: WebSocket is not available in this environment");
  }
  const ws = new WebSocket(url);
  const listeners = new Map<string, Set<(ev: unknown) => void>>();
  const dispatch = (type: string, ev: unknown): void => {
    const set = listeners.get(type);
    if (!set) return;
    for (const h of set) {
      try {
        h(ev);
      } catch {
        // ignore
      }
    }
  };
  ws.addEventListener("message", (ev) => {
    const data = (ev as MessageEvent).data;
    dispatch("message", data);
  });
  ws.addEventListener("error", (ev) => dispatch("error", ev));
  ws.addEventListener("close", (ev) => dispatch("close", ev));
  return {
    send: (msg) => ws.send(msg),
    close: () => ws.close(),
    addEventListener: (type, handler) => {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(handler);
    },
    removeEventListener: (type, handler) => {
      const set = listeners.get(type);
      if (!set) return;
      set.delete(handler);
    }
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/* ============== wire record → 标准化 AppMsgMessage 翻译（**仅**本模块内部） ============== */

/**
 * HubMsg wire `HubMsgMessageRecord` → 标准化 `AppMsgMessage`。
 *
 * **本模块唯一**允许做这个翻译的地方。plugin-appmsg 拿到的永远是
 * `AppMsgMessage`，**不**直接看到 `HubMsgMessageRecord`。
 */
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

/* ============== wire request 形态（**仅**本模块内部） ============== */

interface WireSendParams {
  clientMessageId: string;
  senderOwnerPublicKeyHex: string;
  senderEndpoint: { kind: "origin" | "plugin"; id: string };
  recipientOwnerPublicKeyHex: string;
  recipientEndpoint: { kind: "origin" | "plugin"; id: string };
  contentType: AppMsgContentType;
  body: string;
  createdAtMs: number;
}

interface WireMessageListParams {
  ownerPublicKeyHex: string;
  scopeEndpoint: { kind: "origin" | "plugin"; id: string };
  afterMessageId?: string;
  limit?: number;
}

interface WireMessageListResult {
  items: HubMsgMessageRecord[];
  hasMore: boolean;
}

interface WireMessageGetParams {
  ownerPublicKeyHex: string;
  scopeEndpoint: { kind: "origin" | "plugin"; id: string };
  messageId: string;
}

/* ============== 对外 typed 接口（HubMsgProviderOperations） ============== */

/**
 * `MessageProviderOperations` typed handle 的 HubMsg 实现。
 *
 * 设计缘由：
 *   - 本类把 wire 层 `HubMsgConnection` 包装成 typed `MessageProviderOperations`：
 *     - `sendMessage(input)` → wire `message.send`；
 *     - `listMessages(input)` → wire `message.list`，返回标准化结果；
 *     - `getMessage(input)` → wire `message.get`，scope 外返回 null；
 *     - `subscribeMessages(handler)` → wire `message.received`，handler
 *       收到标准化 `AppMsgMessage`；
 *     - `checkOnline(input)` → wire `message.online`，失败 → 所有
 *       `"unknown"`。
 *   - plugin-appmsg **不**直接接触 `HubMsgConnection`；它只接触
 *     `MessageProviderOperations`。
 */
export class HubMsgProviderOperations {
  private readonly conn: HubMsgConnection;
  /** wire 端 endpointId 派生函数（plugin-endpoint → hubmsg wire scope）。 */
  private static readonly providerId = "hubmsg";

  constructor(conn: HubMsgConnection) {
    this.conn = conn;
  }

  state(): "idle" | "connecting" | "bound" | "closed" {
    return this.conn.state();
  }

  close(): void {
    this.conn.close();
  }

  async sendMessage(input: ProviderSendInput): Promise<ProviderSendResult> {
    if (this.conn.state() !== "bound") {
      throw new Error("HubMsg: not bound; cannot send");
    }
    const senderEp = senderProjectionToEndpoint(input.sender);
    const recipientEp = recipientProjectionToEndpoint(input);
    const wireParams: WireSendParams = {
      clientMessageId: input.clientMessageId,
      senderOwnerPublicKeyHex: input.sender.senderPublicKeyHex,
      senderEndpoint: senderEp,
      recipientOwnerPublicKeyHex: input.recipientPublicKeyHex,
      recipientEndpoint: recipientEp,
      contentType: input.contentType,
      body: input.body,
      createdAtMs: input.createdAtMs
    };
    const res = await this.conn.request<
      WireSendParams,
      { messageId: string; createdAtMs: number }
    >(HUBMSG_METHOD.MessageSend, wireParams);
    return { messageId: res.messageId, createdAtMs: res.createdAtMs };
  }

  async listMessages(input: ProviderListInput): Promise<ProviderListResult> {
    if (this.conn.state() !== "bound") {
      return { items: [], hasMore: false };
    }
    const wireParams: WireMessageListParams = {
      ownerPublicKeyHex: input.ownerPublicKeyHex,
      scopeEndpoint: providerEndpointToWire(input.scopeEndpoint),
      afterMessageId: input.afterMessageId,
      limit: input.limit
    };
    const res = await this.conn.request<WireMessageListParams, WireMessageListResult>(
      HUBMSG_METHOD.MessageList,
      wireParams
    );
    return {
      items: res.items.map(wireRecordToPublic),
      hasMore: res.hasMore
    };
  }

  async getMessage(input: ProviderGetInput): Promise<AppMsgMessage | null> {
    if (this.conn.state() !== "bound") {
      return null;
    }
    const wireParams: WireMessageGetParams = {
      ownerPublicKeyHex: input.ownerPublicKeyHex,
      scopeEndpoint: providerEndpointToWire(input.scopeEndpoint),
      messageId: input.messageId
    };
    try {
      const rec = await this.conn.request<WireMessageGetParams, HubMsgMessageRecord | null>(
        HUBMSG_METHOD.MessageGet,
        wireParams
      );
      if (!rec) return null;
      return wireRecordToPublic(rec);
    } catch {
      // 失败按"scope 外 / 不存在"处理；不向上抛。
      return null;
    }
  }

  subscribeMessages(handler: (msg: AppMsgMessage) => void): () => void {
    return this.conn.subscribeEvent<HubMsgMessageReceivedData>(
      HUBMSG_EVENT.MessageReceived,
      (data) => {
        if (!data?.message) return;
        try {
          handler(wireRecordToPublic(data.message));
        } catch {
          // ignore
        }
      }
    );
  }

  async checkOnline(input: ProviderOnlineInput): Promise<ProviderOnlineResult> {
    if (this.conn.state() !== "bound") {
      const out: ProviderOnlineResult = {};
      for (const h of input.publicKeyHexes) out[h] = "unknown" satisfies AppMsgOnlineStatus;
      return out;
    }
    try {
      const res = await this.conn.request<HubMsgOnlineParams, HubMsgOnlineResult>(
        HUBMSG_METHOD.MessageOnline,
        { publicKeyHexes: input.publicKeyHexes }
      );
      const onlineSet = new Set(res.onlinePublicKeyHexes ?? []);
      const out: ProviderOnlineResult = {};
      for (const h of input.publicKeyHexes) {
        out[h] = (onlineSet.has(h) ? "online" : "offline") satisfies AppMsgOnlineStatus;
      }
      return out;
    } catch {
      const out: ProviderOnlineResult = {};
      for (const h of input.publicKeyHexes) out[h] = "unknown" satisfies AppMsgOnlineStatus;
      return out;
    }
  }
}

/** provider id 字面量；plugin-appmsg 在调用 `providers().list()` 时看到。 */
export const HUBMSG_PROVIDER_ID = "hubmsg";

function providerEndpointToWire(ep: ProviderEndpointRef): {
  kind: "origin" | "plugin";
  id: string;
} {
  return { kind: ep.kind, id: ep.id };
}

function senderProjectionToEndpoint(sender: ProviderSenderProjection): {
  kind: "origin" | "plugin";
  id: string;
} {
  if (sender.senderOrigin) return { kind: "origin", id: sender.senderOrigin };
  if (sender.senderAppId) return { kind: "plugin", id: sender.senderAppId };
  // 兜底为空 endpoint；调用方应该在 endpoint service 层就拒绝这种输入。
  return { kind: "plugin", id: "" };
}

function recipientProjectionToEndpoint(input: {
  recipientOrigin?: string;
  recipientAppId?: string;
}): { kind: "origin" | "plugin"; id: string } {
  if (input.recipientOrigin) return { kind: "origin", id: input.recipientOrigin };
  if (input.recipientAppId) return { kind: "plugin", id: input.recipientAppId };
  return { kind: "plugin", id: "" };
}