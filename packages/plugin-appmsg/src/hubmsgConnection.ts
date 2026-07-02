// packages/plugin-appmsg/src/hubmsgConnection.ts
// HubMsg 单 WSS 连接管理。
//
// 设计缘由（施工单 2026-07-01 002 硬切换 + HubMsg 施工单 001）：
//   - 单一 WSS 入口：HubMsg 真值层提供的 `wss://<host>/ws/v1`；
//   - 三步握手：server_open -> client_bind -> bind_ready；
//   - 业务帧：request / result / event；
//   - 内部缓存：最近消息列表（按 owner + endpoint 分片）；
//   - 推送分发：服务端 event → 本地缓存 → dirty event → 调用方订阅者。
//
// 边界：
//   - 本模块**不**依赖具体签名 / 私钥操作；client_bind 的签名由 caller
//     （本插件 setup 阶段借 owner 私钥）提供；
//   - 断线重连 / afterMessageId 补拉交给 `recover()`；
//   - 本文件**不**做未读计数（v1 不做）；
//   - 本文件**不**做群聊 / 附件 / 撤回 / 编辑 / 已读回执。

import type { AppMsgContentType, AppMsgEndpoint, AppMsgListBox, AppMsgMessage } from "@keymaster/contracts";

/** HubMsg 单 WSS 入口配置。 */
export interface HubMsgConnectionConfig {
  /** 形如 `wss://host/ws/v1`。 */
  url: string;
  /** 心跳秒数；缺省 30s。 */
  heartbeatSec?: number;
}

/** 客户端 bind 时的签名材料（由 owner runtime 提供）。 */
export interface HubMsgBindSigner {
  publicKeyHex: string;
  /**
   * 用 owner 私钥对 (sessionId, nonce, publicKeyHex, issuedAtMs) 这四元组
   * 做 secp256k1 compact 64-byte 签名，返回 hex 字符串。
   *
   * 设计缘由：原文拼接规则是"两仓共用常数"，由
   * `packages/contracts/src/appmsgBind.ts::canonicalBindText` 给出；
   * 这里**不**让 caller 拼好 message 再传入——避免两仓拼接不一致。
   *
   * 实现：本插件调用 vault.withPrivateKey 借 owner 私钥 hex 后，
   * 走 `signCompactSecp256k1(privHex, sessionId, nonce, publicKeyHex,
   * issuedAtMs)` 派生签名。
   */
  sign(args: {
    sessionId: string;
    nonce: string;
    publicKeyHex: string;
    issuedAtMs: number;
  }): Promise<string>;
}

/** 消息帧：从 HubMsg 服务端返回的 message 主表行（与 HubMsg `Message` 对齐）。 */
export interface HubMsgMessageRecord {
  messageId: string;
  clientMessageId: string;
  senderOwnerPublicKeyHex: string;
  senderEndpoint: AppMsgEndpoint;
  recipientOwnerPublicKeyHex: string;
  recipientEndpoint: AppMsgEndpoint;
  contentType: AppMsgContentType;
  body: string;
  createdAtMs: number;
  insertedAtMs: number;
}

/** 单条 result 帧。 */
export interface HubMsgResultFrame<T> {
  ok: boolean;
  result?: T;
  error?: { code: string; message: string };
}

/** 连接状态。 */
export type HubMsgConnectionState =
  | "idle"
  | "connecting"
  | "bound"
  | "closed";

/**
 * HubMsg 单 WSS 客户端。
 *
 * 边界：
 *   - **不**直接持有 owner 私钥：bind 时通过 `HubMsgBindSigner` 闭包借用；
 *   - **不**做持久化：消息列表 / inbox / sent 只在内存；
 *   - **不**做缓存淘汰策略：v1 不实现 LRU（设计缘由：保持简单）。
 */
export interface HubMsgConnection {
  /** 当前连接状态。 */
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
   *   - 连接断开中：reject；
   */
  request<TParams, TResult>(
    method: string,
    params: TParams,
    options?: { timeoutMs?: number }
  ): Promise<TResult>;

  /** 订阅服务端推送的 event；返回取消订阅函数。 */
  subscribeEvent<TData>(eventName: string, handler: (data: TData) => void): () => void;
}

/**
 * HubMsg 单 WSS 客户端实现。
 *
 * 设计缘由：
 *   - 保持最小：仅实现"建连 + bind + request + event"四件套；
 *   - 真实浏览器侧走 `WebSocket`；Node / 测试可注入 fake socket；
 *   - ping/pong 由内部 timer 自动维护；
 *   - 重连由 `recover()` 单独驱动，**不**内置指数退避（保持简单）。
 */
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
    { resolve: (v: unknown) => void; reject: (err: unknown) => void; timer: ReturnType<typeof setTimeout> | null }
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
      sock.addEventListener("error", (err) => reject(err instanceof Error ? err : new Error(String(err))));
    });
    await serverOpen;

    // 2) client_bind
    // 原文拼接由 signer 内部走 `canonicalBindText`（两仓共用）；这里
    // 只把四元组透传给 signer，避免两仓拼接规则漂移。
    const issuedAtMs = Date.now();
    const sigHex = await signer.sign({
      sessionId: this.sessionId ?? "",
      nonce: this.nonce ?? "",
      publicKeyHex: signer.publicKeyHex,
      issuedAtMs
    });
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
        this.socket.send(
          JSON.stringify({ v: 1, type: "ping", tsMs: Date.now() })
        );
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
  // 适配最小 WebSocketLike 形状：监听"message"时拿到的 raw 形参是 unknown，
  // 内部按 string / ArrayBufferLike 分支处理。
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

/** list 参数的 box；与 `appmsg.ts` 同语义。 */
export type HubMsgListBox = AppMsgListBox;

/** list 返回 items；service 内部转 AppMsgMessage。 */
export interface HubMsgListResult {
  items: HubMsgMessageRecord[];
  hasMore: boolean;
}

/** 把 HubMsg 内部 record 转成 contracts 暴露的 AppMsgMessage。 */
export function toAppMsgMessage(rec: HubMsgMessageRecord): AppMsgMessage {
  return {
    messageId: rec.messageId,
    clientMessageId: rec.clientMessageId,
    sender: { ownerPublicKeyHex: rec.senderOwnerPublicKeyHex, endpoint: rec.senderEndpoint },
    recipient: { ownerPublicKeyHex: rec.recipientOwnerPublicKeyHex, endpoint: rec.recipientEndpoint },
    contentType: rec.contentType,
    body: rec.body,
    createdAtMs: rec.createdAtMs,
    insertedAtMs: rec.insertedAtMs
  };
}