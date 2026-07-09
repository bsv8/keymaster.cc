// packages/plugin-hubmsg/src/hubmsgConnection.ts
// HubMsg 单 WSS 连接管理（v1；施工单 2026-07-04 004 硬切换）。
//
// 设计缘由：
//   - 单一 WSS 入口：HubMsg 真值层提供的 `wss://<host>/ws/v1`；
//   - 握手顺序严格固定：服务端首帧 `ServerOpen` → 客户端响应 `ClientBind`
//     → 服务端确认 `BindReady`（**不**再混用 `BindReady` 充当首帧或兜底）；
//   - 业务帧：`Request` / `Result` / `Event`；心跳 `Ping` / `Pong`；控制
//     帧 `Close`；所有 frame body / method params / results 均为固定
//     顺序数组（施工单 §2.3 锁定："固定顺序数组，不用 map"）；
//   - frame kind / method id / event id / endpoint kind / scope kind 全
//     部整数常量（无字符串方法名 / 无字符串 event 名）；
//   - 推送事件：`message.received`（HubMsg → keymaster），本模块内部
//     把 wire sealed record 翻译为标准化 `ProviderSealedMessageRecord`，
//     对外只暴露标准化输出——**plugin-appmsg 不再接触 wire record**；
//   - 协议 RPC：message.send / message.list / message.get / message.online
//     ——本模块把它们包装成 typed `MessageProviderOperations` 业务方法
//     （sendMessage / listMessages / getMessage / subscribeMessages /
//     checkOnline），**不**暴露字符串方法名给上层；
//   - 本模块**不**做 seal / open / 验签 / 解密——sealed record 对本模块
//     是不透明字节；
//   - 本模块**不**依赖具体签名 / 私钥操作；client_bind 的签名由 caller
//     （plugin-appmsg 在 setup 阶段借 owner 私钥）通过 `ProviderSigner`
//     提供。
//
// 边界（施工单 §4 + §5.4 / §5.5）：
//   - WebSocket 上只传二进制 frame：`HubFrame = [frameVersion, frameKind,
//     frameBody]`，整型 frameVersion / frameKind；
//   - 不再传 JSON 文本业务帧 / 不再传 base64；
//   - message.send / list / get / received 全部走 sealed envelope
//     record（`SignedAppMsgEnvelopeV1`）；HubMsg 持久化的真值也是
//     envelope 真值字节 + signature；
//   - 本模块**不**做持久化（消息本地库在 plugin-appmsg）；
//   - 本模块**不**做未读计数（v1 不做）；
//   - 本模块**不**做群聊 / 附件 / 撤回 / 编辑 / 已读回执。

import {
  formatShortPublicKey,
  HUB_FRAME_KIND,
  HUB_FRAME_VERSION,
  HUBMSG_EVENT,
  HUBMSG_METHOD,
  cborDecode,
  cborEncode,
  type HubFrame,
  type HubFrameBindReadyBody,
  type HubFrameClientBindBody,
  type HubFrameCloseBody,
  type HubFrameEventBody,
  type HubFramePingBody,
  type HubFrameRequestBody,
  type HubFrameResultBody,
  type HubFrameServerOpenBody,
  type HubMsgWireGetParams,
  type HubMsgWireListParams,
  type HubMsgWireOnlineParams,
  type HubMsgWireOnlineResult,
  type HubMsgWireSealedRecord,
  type HubMsgWireSendParams,
  type HubMsgWireSendResult
} from "@keymaster/contracts";
import { canonicalBindText } from "@keymaster/contracts";
import type {
  AppMsgOnlineStatus,
  ProviderEndpointRef,
  ProviderGetInput,
  ProviderListInput,
  ProviderListResult,
  ProviderOnlineInput,
  ProviderOnlineResult,
  ProviderSealedMessageRecord,
  ProviderSendInput,
  ProviderSendResult,
  ProviderSigner,
  SignedAppMsgEnvelopeV1
} from "@keymaster/contracts";

/** HubMsg 单 WSS 入口配置。 */
export interface HubMsgConnectionConfig {
  /** 形如 `wss://host/ws/v1`。 */
  url: string;
  /** 心跳秒数；缺省 30s。 */
  heartbeatSec?: number;
  /** 握手超时毫秒；缺省 10s。 */
  handshakeTimeoutMs?: number;
  /** 可选日志出口；供系统日志页追连接阶段。 */
  logger?: HubMsgConnectionLogger;
}

/** HubMsg 连接层日志出口。 */
export interface HubMsgConnectionLogger {
  info(input: { scope: string; event: string; message: string; data?: Record<string, unknown> }): void;
  warn(input: { scope: string; event: string; message: string; data?: Record<string, unknown> }): void;
  error(input: { scope: string; event: string; message: string; data?: Record<string, unknown> }): void;
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

/* ============== frame 工具：编码 / 解码 HubFrame（CBOR） ============== */

/**
 * 把 `HubFrame` 编码为 CBOR 真值字节。
 *
 * 最终 wire 形式 = `cborEncode([frameVersion, frameKind, cborEncode(frameBody)])`。
 *
 * frame body 自身**也**是 CBOR 编码的真值字节；内部固定顺序数组。
 */
function encodeHubFrame(frame: HubFrame): Uint8Array {
  return cborEncode([frame.frameVersion, frame.frameKind, frame.frameBody]);
}

function decodeHubFrame(bytes: Uint8Array): HubFrame {
  const raw = cborDecode(bytes);
  if (!Array.isArray(raw) || raw.length !== 3) {
    throw new Error("HubMsg: malformed frame (not a 3-element array)");
  }
  const [frameVersion, frameKind, frameBody] = raw;
  if (typeof frameVersion !== "number" || typeof frameKind !== "number") {
    throw new Error("HubMsg: malformed frame (non-integer header fields)");
  }
  if (frameVersion !== HUB_FRAME_VERSION) {
    throw new Error(
      `HubMsg: unsupported frame version ${frameVersion}; expected ${HUB_FRAME_VERSION}`
    );
  }
  if (!(frameBody instanceof Uint8Array)) {
    throw new Error("HubMsg: malformed frame (body must be bytes)");
  }
  return {
    frameVersion,
    frameKind: frameKind as HubFrame["frameKind"],
    frameBody
  };
}

/* ============== frame body 编 / 解码（固定顺序数组） ============== */

function encodeServerOpenBody(body: HubFrameServerOpenBody): Uint8Array {
  return cborEncode([body[0], body[1], body[2]]);
}

function decodeServerOpenBody(body: Uint8Array): HubFrameServerOpenBody {
  const v = cborDecode(body);
  if (!Array.isArray(v) || v.length !== 3) {
    throw new Error("HubMsg: server_open body must be [sessionId, nonce, heartbeatSec]");
  }
  if (
    typeof v[0] !== "string" ||
    typeof v[1] !== "string" ||
    typeof v[2] !== "number"
  ) {
    throw new Error("HubMsg: server_open body field types invalid");
  }
  return [v[0], v[1], v[2]];
}

function encodeClientBindBody(body: HubFrameClientBindBody): Uint8Array {
  return cborEncode([body[0], body[1], body[2], body[3]]);
}

function decodeClientBindBody(body: Uint8Array): HubFrameClientBindBody {
  const v = cborDecode(body);
  if (!Array.isArray(v) || v.length !== 4) {
    throw new Error("HubMsg: client_bind body must be 4-element array");
  }
  if (
    typeof v[0] !== "string" ||
    typeof v[1] !== "string" ||
    typeof v[2] !== "number" ||
    typeof v[3] !== "string"
  ) {
    throw new Error("HubMsg: client_bind body field types invalid");
  }
  return [v[0], v[1], v[2], v[3]];
}

function encodeBindReadyBody(body: HubFrameBindReadyBody): Uint8Array {
  return cborEncode([body[0]]);
}

function decodeBindReadyBody(body: Uint8Array): HubFrameBindReadyBody {
  const v = cborDecode(body);
  if (!Array.isArray(v) || v.length !== 1 || typeof v[0] !== "string") {
    throw new Error("HubMsg: bind_ready body must be [sessionId]");
  }
  return [v[0]];
}

function encodeRequestBody(body: HubFrameRequestBody): Uint8Array {
  return cborEncode([body[0], body[1], body[2]]);
}

function decodeRequestBody(body: Uint8Array): HubFrameRequestBody {
  const v = cborDecode(body);
  if (
    !Array.isArray(v) ||
    v.length !== 3 ||
    typeof v[0] !== "string" ||
    typeof v[1] !== "number" ||
    !(v[2] instanceof Uint8Array)
  ) {
    throw new Error("HubMsg: request body must be [requestId, methodId, methodPayloadBytes]");
  }
  return [v[0], v[1], v[2] as Uint8Array];
}

function encodeResultBody(body: HubFrameResultBody): Uint8Array {
  return cborEncode([body[0], body[1], body[2], body[3]]);
}

function decodeResultBody(body: Uint8Array): HubFrameResultBody {
  const v = cborDecode(body);
  if (
    !Array.isArray(v) ||
    v.length !== 4 ||
    typeof v[0] !== "string" ||
    typeof v[1] !== "boolean"
  ) {
    throw new Error("HubMsg: result body must be [requestId, ok, resultBytes, errorBytes]");
  }
  const resultBytes = normalizeOptionalBytes(v[2]);
  const errorBytes = normalizeOptionalBytes(v[3]);
  if (!resultBytes || !errorBytes) {
    throw new Error("HubMsg: result body field types invalid");
  }
  return [v[0], v[1], resultBytes, errorBytes];
}

function encodeEventBody(body: HubFrameEventBody): Uint8Array {
  return cborEncode([body[0], body[1]]);
}

function decodeEventBody(body: Uint8Array): HubFrameEventBody {
  const v = cborDecode(body);
  if (
    !Array.isArray(v) ||
    v.length !== 2 ||
    typeof v[0] !== "number" ||
    !(v[1] instanceof Uint8Array)
  ) {
    throw new Error("HubMsg: event body must be [eventId, dataBytes]");
  }
  return [v[0], v[1] as Uint8Array];
}

function encodeCloseBody(body: HubFrameCloseBody): Uint8Array {
  return cborEncode([body[0]]);
}

function decodeCloseBody(body: Uint8Array): HubFrameCloseBody {
  const v = cborDecode(body);
  if (!Array.isArray(v) || v.length !== 1 || typeof v[0] !== "string") {
    throw new Error("HubMsg: close body must be [reason]");
  }
  return [v[0]];
}

function encodePingBody(body: HubFramePingBody): Uint8Array {
  return cborEncode([body[0]]);
}

function decodePingBody(body: Uint8Array): HubFramePingBody {
  const v = cborDecode(body);
  if (!Array.isArray(v) || v.length !== 1 || typeof v[0] !== "number") {
    throw new Error("HubMsg: ping/pong body must be [tsMs]");
  }
  return [v[0]];
}

/* ============== wire sealed record ↔ 标准化 sealed record ============== */

function wireSealedToPublic(rec: HubMsgWireSealedRecord): ProviderSealedMessageRecord {
  if (rec.length !== 4) {
    throw new Error(`HubMsg: wire sealed record length must be 4, got ${rec.length}`);
  }
  const [messageId, insertedAtMs, envelopeBytes, signatureBytes] = rec;
  const summary = decodeEnvelopeSummary(envelopeBytes);
  const envelope: SignedAppMsgEnvelopeV1 = { envelopeBytes, signatureBytes };
  return {
    messageId,
    clientMessageId: summary.clientMessageId,
    senderPublicKeyHex: summary.senderPublicKeyHex,
    senderEndpointKind:
      summary.senderEndpointKind === APPMSG_ENVELOPE_ENDPOINT_KIND_ORIGIN
        ? "origin"
        : "plugin",
    senderEndpointId: summary.senderEndpointId,
    recipientPublicKeyHex: summary.recipientPublicKeyHex,
    recipientEndpointKind:
      summary.recipientEndpointKind === APPMSG_ENVELOPE_ENDPOINT_KIND_ORIGIN
        ? "origin"
        : "plugin",
    recipientEndpointId: summary.recipientEndpointId,
    createdAtMs: summary.createdAtMs,
    insertedAtMs,
    envelope
  };
}

function decodeWireSealedRecordBytes(bytes: Uint8Array): HubMsgWireSealedRecord {
  const raw = cborDecode(bytes);
  if (
    !Array.isArray(raw) ||
    raw.length !== 4 ||
    typeof raw[0] !== "string" ||
    typeof raw[1] !== "number" ||
    !(raw[2] instanceof Uint8Array) ||
    !(raw[3] instanceof Uint8Array)
  ) {
    throw new Error("HubMsg: malformed stored envelope record");
  }
  return [raw[0], raw[1], raw[2] as Uint8Array, raw[3] as Uint8Array];
}

function decodeWireListResult(value: unknown): { items: Uint8Array[]; hasMore: boolean } {
  if (!Array.isArray(value) || value.length < 1) {
    throw new Error("HubMsg: malformed message.list result");
  }
  const hasMore = value[value.length - 1];
  if (typeof hasMore !== "boolean") {
    throw new Error("HubMsg: malformed message.list result tail");
  }
  const items: Uint8Array[] = [];
  for (let i = 0; i < value.length - 1; i++) {
    const item = value[i];
    if (!(item instanceof Uint8Array)) {
      throw new Error("HubMsg: malformed message.list record bytes");
    }
    items.push(item);
  }
  return { items, hasMore };
}

function decodeOnlineResult(value: unknown): HubMsgWireOnlineResult {
  if (!Array.isArray(value)) {
    throw new Error("HubMsg: malformed message.online result");
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error("HubMsg: malformed message.online result item");
    }
    out.push(item);
  }
  return out;
}

function decodeEnvelopeSummary(bytes: Uint8Array): {
  senderPublicKeyHex: string;
  senderEndpointKind: number;
  senderEndpointId: string;
  recipientPublicKeyHex: string;
  recipientEndpointKind: number;
  recipientEndpointId: string;
  clientMessageId: string;
  createdAtMs: number;
} {
  const raw = cborDecode(bytes);
  if (
    !Array.isArray(raw) ||
    raw.length !== 12 ||
    typeof raw[0] !== "number" ||
    !(raw[1] instanceof Uint8Array) ||
    typeof raw[2] !== "number" ||
    typeof raw[3] !== "string" ||
    !(raw[4] instanceof Uint8Array) ||
    typeof raw[5] !== "number" ||
    typeof raw[6] !== "string" ||
    typeof raw[7] !== "string" ||
    typeof raw[8] !== "number"
  ) {
    throw new Error("HubMsg: malformed envelope bytes");
  }
  return {
    senderPublicKeyHex: bytesToHex(raw[1] as Uint8Array),
    senderEndpointKind: raw[2],
    senderEndpointId: raw[3],
    recipientPublicKeyHex: bytesToHex(raw[4] as Uint8Array),
    recipientEndpointKind: raw[5],
    recipientEndpointId: raw[6],
    clientMessageId: raw[7],
    createdAtMs: raw[8]
  };
}

function describeUnknownEvent(ev: unknown): string {
  if (ev instanceof Error && ev.message) return ` (${ev.message})`;
  if (typeof ev === "object" && ev !== null) {
    const obj = ev as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof obj.type === "string" && obj.type) parts.push(`type=${obj.type}`);
    if (typeof obj.code === "number") parts.push(`code=${obj.code}`);
    if (typeof obj.reason === "string" && obj.reason) parts.push(`reason=${obj.reason}`);
    if (typeof obj.message === "string" && obj.message) parts.push(`message=${obj.message}`);
    if (typeof obj.wasClean === "boolean") parts.push(`wasClean=${obj.wasClean}`);
    if (parts.length > 0) return ` (${parts.join(", ")})`;
  }
  return "";
}

/* ============== endpoint kind 字面量在 wire 上的整数映射 ============== */

import {
  APPMSG_ENVELOPE_ENDPOINT_KIND_ORIGIN,
  APPMSG_ENVELOPE_ENDPOINT_KIND_PLUGIN
} from "@keymaster/contracts";

/* ============== 连接状态 ============== */

export type HubMsgConnectionState = "idle" | "connecting" | "bound" | "closed";

/* ============== HubMsg 单 WSS 客户端接口（**仅**本模块内部使用） ============== */

export interface HubMsgConnection {
  state(): HubMsgConnectionState;
  connect(signer: HubMsgBindSigner): Promise<void>;
  close(): void;
  /**
   * 同步发出 request；用消息 id 与 promise 解耦。
   *
   * 失败语义：
   *   - 超时：reject；
   *   - 服务端 result(ok=false)：reject with code / message；
   *   - 连接断开中：reject。
   */
  request<TResult>(
    methodId: number,
    params: Uint8Array,
    options?: { timeoutMs?: number }
  ): Promise<TResult>;
  subscribeEvent(
    eventId: number,
    handler: (data: Uint8Array) => void
  ): () => void;
  onClose(handler: () => void): () => void;
}

/* ============== HubMsg 单 WSS 客户端实现 ============== */

export class HubMsgConnectionImpl implements HubMsgConnection {
  private readonly cfg: HubMsgConnectionConfig;
  private socket: WebSocketLike | null = null;
  private stateValue: HubMsgConnectionState = "idle";
  /** 当前 sessionId（来自 server_open）。 */
  private sessionId: string | null = null;
  /** 当前 nonce（来自 server_open；bind challenge 必用）。 */
  private nonce: string | null = null;
  private readonly pendingById = new Map<
    string,
    {
      methodId: number;
      startedAtMs: number;
      resolve: (v: unknown) => void;
      reject: (err: unknown) => void;
      timer: ReturnType<typeof setTimeout> | null;
    }
  >();
  private readonly eventHandlers = new Map<number, Set<(data: Uint8Array) => void>>();
  private readonly closeHandlers = new Set<() => void>();
  private pingHandle: ReturnType<typeof setInterval> | null = null;
  private negotiatedHeartbeatSec: number | null = null;
  private static readonly DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
  private static readonly DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
  // 在线查询是轻量探针，不应沿用通用 30s 请求超时；否则页面会长期停在
  // “查询中...”，而真正的问题信号被拖迟。
  static readonly ONLINE_REQUEST_TIMEOUT_MS = 5_000;

  constructor(cfg: HubMsgConnectionConfig) {
    this.cfg = { heartbeatSec: 30, ...cfg };
  }

  state(): HubMsgConnectionState {
    return this.stateValue;
  }

  private emitLog(
    level: "info" | "warn" | "error",
    event: string,
    data?: Record<string, unknown>
  ): void {
    const logger = this.cfg.logger;
    if (!logger) return;
    try {
      logger[level]({
        scope: "hubmsg.connection",
        event,
        message: "",
        data
      });
    } catch {
      // ignore
    }
  }

  private resetAfterFailedConnect(): void {
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
    this.negotiatedHeartbeatSec = null;
  }

  private waitForHandshakeStage<T>(args: {
    socket: WebSocketLike;
    stage: "server_open" | "bind_ready";
    timeoutMs: number;
    onMessage(frame: HubFrame): T;
  }): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = (): void => {
        args.socket.removeEventListener("message", onMessage);
        args.socket.removeEventListener("error", onError);
        args.socket.removeEventListener("close", onClose);
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      };

      const fail = (err: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      const succeed = (value: T): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };

      const onMessage = (raw: unknown): void => {
        try {
          const bytes = ensureBytes(raw);
          const frame = decodeHubFrame(bytes);
          this.emitLog("info", "hubmsg.handshake.frame.received", {
            stage: args.stage,
            frameKind: frame.frameKind,
            frameBytes: bytes.length
          });
          succeed(args.onMessage(frame));
        } catch (err) {
          this.emitLog("warn", "hubmsg.handshake.frame.invalid", {
            stage: args.stage,
            err: err instanceof Error ? err.message : String(err)
          });
          fail(err);
        }
      };

      const onError = (ev: unknown): void => {
        this.emitLog("warn", "hubmsg.handshake.socket_error", {
          stage: args.stage,
          detail: describeUnknownEvent(ev)
        });
        fail(new Error(`HubMsg: websocket error during ${args.stage}${describeUnknownEvent(ev)}`));
      };

      const onClose = (ev: unknown): void => {
        this.emitLog("warn", "hubmsg.handshake.socket_close", {
          stage: args.stage,
          detail: describeUnknownEvent(ev)
        });
        fail(new Error(`HubMsg: websocket closed during ${args.stage}${describeUnknownEvent(ev)}`));
      };

      timer = setTimeout(() => {
        this.emitLog("error", "hubmsg.handshake.timeout", {
          stage: args.stage,
          timeoutMs: args.timeoutMs
        });
        fail(new Error(`HubMsg: ${args.stage} timeout after ${args.timeoutMs}ms`));
      }, args.timeoutMs);

      args.socket.addEventListener("message", onMessage);
      args.socket.addEventListener("error", onError);
      args.socket.addEventListener("close", onClose);
    });
  }

  async connect(signer: HubMsgBindSigner): Promise<void> {
    if (this.stateValue === "bound") return;
    if (this.stateValue === "connecting") {
      throw new Error("HubMsg: connect already in progress");
    }
    this.stateValue = "connecting";
    const handshakeTimeoutMs = Math.max(
      1,
      this.cfg.handshakeTimeoutMs ?? HubMsgConnectionImpl.DEFAULT_HANDSHAKE_TIMEOUT_MS
    );
    this.emitLog("info", "hubmsg.connect.started", {
      url: this.cfg.url,
      handshakeTimeoutMs,
      publicKeyHex: signer.publicKeyHex
    });
    const sock = createWebSocket(this.cfg.url);
    this.socket = sock;
    this.emitLog("info", "hubmsg.connect.socket.created", {
      url: this.cfg.url
    });
    let stage: "server_open" | "sign_challenge" | "send_client_bind" | "bind_ready" =
      "server_open";
    try {
      this.emitLog("info", "hubmsg.connect.server_open.waiting", {
        url: this.cfg.url,
        timeoutMs: handshakeTimeoutMs
      });
      const so = await this.waitForHandshakeStage({
        socket: sock,
        stage: "server_open",
        timeoutMs: handshakeTimeoutMs,
        onMessage: (frame) => {
          if (frame.frameKind !== HUB_FRAME_KIND.ServerOpen) {
            throw new Error(
              `HubMsg: expected server_open (kind=${HUB_FRAME_KIND.ServerOpen}), got kind=${frame.frameKind}`
            );
          }
          const body = decodeServerOpenBody(frame.frameBody);
          return { sessionId: body[0], nonce: body[1], heartbeatSec: body[2] };
        }
      });
      this.sessionId = so.sessionId;
      this.nonce = so.nonce;
      this.negotiatedHeartbeatSec = so.heartbeatSec;
      this.emitLog("info", "hubmsg.connect.server_open", {
        sessionId: so.sessionId,
        heartbeatSec: so.heartbeatSec
      });

      stage = "sign_challenge";
      const issuedAtMs = Date.now();
      const plainText = canonicalBindText(
        this.sessionId,
        this.nonce,
        signer.publicKeyHex,
        issuedAtMs
      );
      const plainBytes = new TextEncoder().encode(plainText);
      this.emitLog("info", "hubmsg.connect.sign.begin", {
        sessionId: this.sessionId,
        publicKeyHex: signer.publicKeyHex,
        challengeBytes: plainBytes.length
      });
      const sigHex = await signer.signChallenge({ challenge: plainBytes });
      this.emitLog("info", "hubmsg.connect.sign.done", {
        sessionId: this.sessionId,
        publicKeyHex: signer.publicKeyHex,
        challengeBytes: plainBytes.length,
        signatureHexLength: sigHex.length
      });
      const clientBindBody: HubFrameClientBindBody = [
        this.sessionId,
        signer.publicKeyHex,
        issuedAtMs,
        sigHex
      ];
      const clientBindFrame: HubFrame = {
        frameVersion: HUB_FRAME_VERSION,
        frameKind: HUB_FRAME_KIND.ClientBind,
        frameBody: encodeClientBindBody(clientBindBody)
      };

      stage = "send_client_bind";
      sock.send(encodeHubFrame(clientBindFrame));
      this.emitLog("info", "hubmsg.connect.bind_sent", {
        sessionId: this.sessionId,
        publicKeyHex: signer.publicKeyHex
      });

      stage = "bind_ready";
      this.emitLog("info", "hubmsg.connect.bind_ready.waiting", {
        sessionId: this.sessionId,
        timeoutMs: handshakeTimeoutMs
      });
      await this.waitForHandshakeStage<void>({
        socket: sock,
        stage: "bind_ready",
        timeoutMs: handshakeTimeoutMs,
        onMessage: (frame) => {
          if (frame.frameKind === HUB_FRAME_KIND.BindReady) {
            const body = decodeBindReadyBody(frame.frameBody);
            if (body[0] !== this.sessionId) {
              throw new Error(
                `HubMsg: bind_ready session mismatch; expected ${this.sessionId}, got ${body[0]}`
              );
            }
            return;
          }
          if (frame.frameKind === HUB_FRAME_KIND.Close) {
            const body = decodeCloseBody(frame.frameBody);
            throw new Error(`HubMsg: bind closed (${body[0]})`);
          }
          throw new Error(
            `HubMsg: expected bind_ready (kind=${HUB_FRAME_KIND.BindReady}), got kind=${frame.frameKind}`
          );
        }
      });
      this.stateValue = "bound";

      sock.addEventListener("message", (raw: unknown) => this.onSocketMessage(raw));
      sock.addEventListener("close", (ev: unknown) => this.onSocketClose("socket_event", ev));
      this.startHeartbeat();
      this.emitLog("info", "hubmsg.connect.bound", {
        sessionId: this.sessionId,
        heartbeatSec: this.negotiatedHeartbeatSec,
        publicKeyHex: signer.publicKeyHex
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emitLog("error", "hubmsg.connect.failed", {
        stage,
        url: this.cfg.url,
        sessionId: this.sessionId,
        err: error.message
      });
      this.resetAfterFailedConnect();
      throw error;
    }
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
    this.negotiatedHeartbeatSec = null;
    for (const [, p] of this.pendingById) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error("HubMsg: connection closed"));
    }
    this.pendingById.clear();
  }

  async request<TResult>(
    methodId: number,
    params: Uint8Array,
    options?: { timeoutMs?: number }
  ): Promise<TResult> {
    if (this.stateValue !== "bound" || !this.socket) {
      throw new Error("HubMsg: not bound");
    }
    const requestId = newId();
    const reqBody: HubFrameRequestBody = [requestId, methodId, params];
    const frame: HubFrame = {
      frameVersion: HUB_FRAME_VERSION,
      frameKind: HUB_FRAME_KIND.Request,
      frameBody: encodeRequestBody(reqBody)
    };
    const timeoutMs = options?.timeoutMs ?? HubMsgConnectionImpl.DEFAULT_REQUEST_TIMEOUT_MS;
    return new Promise<TResult>((resolve, reject) => {
      const startedAtMs = Date.now();
      const timer = setTimeout(() => {
        this.pendingById.delete(requestId);
        this.emitLog("error", "hubmsg.request.timeout", {
          requestId,
          methodId,
          methodName: describeMethodId(methodId),
          timeoutMs,
          durationMs: Date.now() - startedAtMs,
          pendingRequestCount: this.pendingById.size,
          pendingPreview: previewPendingRequestIds(this.pendingById)
        });
        reject(new Error(`HubMsg: request timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      const pendingBefore = this.pendingById.size;
      this.pendingById.set(requestId, {
        methodId,
        startedAtMs,
        resolve: (v) => resolve(v as TResult),
        reject,
        timer
      });
      this.emitLog("info", "hubmsg.request.sent", {
        requestId,
        methodId,
        methodName: describeMethodId(methodId),
        timeoutMs,
        payloadBytes: params.length,
        pendingBeforeCount: pendingBefore,
        pendingAfterCount: this.pendingById.size
      });
      try {
        this.socket!.send(encodeHubFrame(frame));
      } catch (err) {
        if (timer) clearTimeout(timer);
        this.pendingById.delete(requestId);
        this.emitLog("error", "hubmsg.request.send_failed", {
          requestId,
          methodId,
          methodName: describeMethodId(methodId),
          pendingAfterCount: this.pendingById.size,
          err: err instanceof Error ? err.message : String(err)
        });
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  subscribeEvent(eventId: number, handler: (data: Uint8Array) => void): () => void {
    let set = this.eventHandlers.get(eventId);
    if (!set) {
      set = new Set();
      this.eventHandlers.set(eventId, set);
    }
    set.add(handler);
    return () => {
      const s = this.eventHandlers.get(eventId);
      if (!s) return;
      s.delete(handler);
    };
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => {
      this.closeHandlers.delete(handler);
    };
  }

  private emitClose(): void {
    for (const h of this.closeHandlers) {
      try {
        h();
      } catch {
        // ignore
      }
    }
  }

  private onSocketMessage(raw: unknown): void {
    let bytes: Uint8Array;
    try {
      bytes = ensureBytes(raw);
    } catch (err) {
      this.emitLog("warn", "hubmsg.socket.message.invalid_bytes", {
        err: err instanceof Error ? err.message : String(err)
      });
      return;
    }
    let frame: HubFrame;
    try {
      frame = decodeHubFrame(bytes);
    } catch (err) {
      this.emitLog("warn", "hubmsg.socket.message.invalid_frame", {
        frameBytes: bytes.length,
        err: err instanceof Error ? err.message : String(err)
      });
      return;
    }
    this.emitLog("info", "hubmsg.socket.message.received", {
      frameKind: frame.frameKind,
      frameBytes: bytes.length,
      sessionId: this.sessionId
    });
    if (frame.frameKind === HUB_FRAME_KIND.Ping) {
      const body = decodePingBody(frame.frameBody);
      if (!this.socket || this.stateValue !== "bound") return;
      const pongFrame: HubFrame = {
        frameVersion: HUB_FRAME_VERSION,
        frameKind: HUB_FRAME_KIND.Pong,
        frameBody: encodePingBody(body)
      };
      try {
        this.socket.send(encodeHubFrame(pongFrame));
        this.emitLog("info", "hubmsg.socket.pong_sent", {
          tsMs: body[0],
          sessionId: this.sessionId
        });
      } catch {
        // ignore
      }
      return;
    }
    if (frame.frameKind === HUB_FRAME_KIND.Pong) {
      // 心跳响应——无需任何业务处理。
      this.emitLog("info", "hubmsg.socket.pong_received", {
        sessionId: this.sessionId
      });
      return;
    }
    if (frame.frameKind === HUB_FRAME_KIND.Result) {
      let body: HubFrameResultBody;
      try {
        body = decodeResultBody(frame.frameBody);
      } catch (err) {
        this.emitLog("warn", "hubmsg.request.result_decode_failed", {
          frameBytes: bytes.length,
          frameBodyBytes: frame.frameBody.length,
          pendingRequestCount: this.pendingById.size,
          pendingPreview: previewPendingRequestIds(this.pendingById),
          err: err instanceof Error ? err.message : String(err)
        });
        return;
      }
      const p = this.pendingById.get(body[0]);
      if (!p) {
        this.emitLog("warn", "hubmsg.request.result_orphaned", {
          requestId: body[0],
          ok: body[1],
          resultBytes: body[2].length,
          errorBytes: body[3].length,
          pendingRequestCount: this.pendingById.size,
          pendingPreview: previewPendingRequestIds(this.pendingById)
        });
        return;
      }
      this.pendingById.delete(body[0]);
      if (p.timer) clearTimeout(p.timer);
      if (body[1]) {
        this.emitLog("info", "hubmsg.request.result", {
          requestId: body[0],
          methodId: p.methodId,
          methodName: describeMethodId(p.methodId),
          ok: true,
          durationMs: Date.now() - p.startedAtMs,
          resultBytes: body[2].length,
          pendingAfterCount: this.pendingById.size
        });
        p.resolve(body[2]);
      } else {
        const errInfo = decodeResultError(body[3]);
        const e = new Error(`${errInfo.code}: ${errInfo.message}`);
        (e as Error & { code?: string }).code = errInfo.code;
        this.emitLog("warn", "hubmsg.request.result", {
          requestId: body[0],
          methodId: p.methodId,
          methodName: describeMethodId(p.methodId),
          ok: false,
          durationMs: Date.now() - p.startedAtMs,
          errorCode: errInfo.code,
          errorMessage: errInfo.message,
          pendingAfterCount: this.pendingById.size
        });
        p.reject(e);
      }
      return;
    }
    if (frame.frameKind === HUB_FRAME_KIND.Event) {
      const body = decodeEventBody(frame.frameBody);
      const set = this.eventHandlers.get(body[0]);
      this.emitLog("info", "hubmsg.socket.event.received", {
        eventId: body[0],
        payloadBytes: body[1].length,
        handlerCount: set?.size ?? 0
      });
      if (!set) return;
      for (const h of set) {
        try {
          h(body[1]);
        } catch {
          // ignore
        }
      }
      return;
    }
    if (frame.frameKind === HUB_FRAME_KIND.Close) {
      const body = decodeCloseBody(frame.frameBody);
      this.emitLog("warn", "hubmsg.socket.close_frame", {
        reason: body[0],
        pendingRequestCount: this.pendingById.size
      });
      // 业务流上收到的 close：触发所有 pending 失败 + 远端断线事件。
      for (const [, p] of this.pendingById) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(new Error(`HubMsg: server closed (${body[0]})`));
      }
      this.pendingById.clear();
      this.onSocketClose("close_frame", { reason: body[0] });
      return;
    }
    this.emitLog("warn", "hubmsg.socket.message.unhandled_kind", {
      frameKind: frame.frameKind,
      sessionId: this.sessionId
    });
  }

  private onSocketClose(source: "socket_event" | "close_frame", ev?: unknown): void {
    if (this.stateValue === "closed") return;
    this.emitLog("warn", "hubmsg.socket.closed", {
      source,
      state: this.stateValue,
      sessionId: this.sessionId,
      pendingRequestCount: this.pendingById.size,
      detail: describeUnknownEvent(ev)
    });
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
    this.negotiatedHeartbeatSec = null;
    this.emitClose();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const sec = Math.max(1, this.negotiatedHeartbeatSec ?? this.cfg.heartbeatSec ?? 30);
    this.pingHandle = setInterval(() => {
      if (!this.socket || this.stateValue !== "bound") return;
      const pingBody: HubFramePingBody = [Date.now()];
      const frame: HubFrame = {
        frameVersion: HUB_FRAME_VERSION,
        frameKind: HUB_FRAME_KIND.Ping,
        frameBody: encodePingBody(pingBody)
      };
      try {
        this.socket.send(encodeHubFrame(frame));
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

/* ============== WebSocketLike ============== */

export interface WebSocketLike {
  /** v1 wire 只传二进制。 */
  send(message: Uint8Array): void;
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
  ws.binaryType = "arraybuffer";
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
    send: (msg) => {
      ws.send(msg);
    },
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

/* ============== 工具 ============== */

function ensureBytes(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (typeof raw === "string") {
    throw new Error("HubMsg: received string frame (not allowed in v1 wire)");
  }
  throw new Error("HubMsg: unknown message payload type");
}

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] ?? 0).toString(16).padStart(2, "0");
  }
  return out;
}

function decodeResultError(bytes: Uint8Array): { code: string; message: string } {
  if (bytes.length === 0) {
    return { code: "unknown", message: "HubMsg: request failed" };
  }
  const raw = cborDecode(bytes);
  if (
    !Array.isArray(raw) ||
    raw.length !== 2 ||
    typeof raw[0] !== "string" ||
    typeof raw[1] !== "string"
  ) {
    return { code: "unknown", message: "HubMsg: request failed" };
  }
  return { code: raw[0], message: raw[1] };
}

function normalizeOptionalBytes(value: unknown): Uint8Array | null {
  if (value === null) return new Uint8Array();
  if (value instanceof Uint8Array) return value;
  return null;
}

/* ============== 对外 typed 接口（HubMsgProviderOperations） ============== */

/**
 * `MessageProviderOperations` typed handle 的 HubMsg 实现。
 *
 * 设计缘由：
 *   - 本类把 wire 层 `HubMsgConnection` 包装成 typed `MessageProviderOperations`；
 *     wire 上所有 frame body / method params / results 均为固定顺序数组；
 *   - 本模块**不**做 seal / open / 验签 / 解密——plugin-appmsg 在入站
 *     边界完成 verify → decrypt → 公开 `AppMsgMessage`。
 */
export class HubMsgProviderOperations {
  private readonly conn: HubMsgConnection;
  private readonly logger?: HubMsgConnectionLogger;

  constructor(conn: HubMsgConnection, logger?: HubMsgConnectionLogger) {
    this.conn = conn;
    this.logger = logger;
  }

  private emitLog(
    level: "info" | "warn" | "error",
    event: string,
    data?: Record<string, unknown>
  ): void {
    if (!this.logger) return;
    try {
      this.logger[level]({
        scope: "hubmsg.provider",
        event,
        message: "",
        data
      });
    } catch {
      // ignore
    }
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
    const r = input.record;
    this.emitLog("info", "hubmsg.provider.send.begin", {
      clientMessageId: r.clientMessageId,
      recipientPublicKeyHex: r.recipientPublicKeyHex,
      envelopeBytes: r.envelope.envelopeBytes.length,
      signatureBytes: r.envelope.signatureBytes.length
    });
    const wireParams: HubMsgWireSendParams = [
      r.envelope.envelopeBytes,
      r.envelope.signatureBytes
    ];
    try {
      const resBytes = await this.conn.request<Uint8Array>(
        HUBMSG_METHOD.MessageSend,
        cborEncode([...wireParams])
      );
      const res = cborDecode(resBytes) as unknown;
      if (!Array.isArray(res) || res.length !== 2) {
        throw new Error("HubMsg: malformed message.send result");
      }
      const [messageId, insertedAtMs] = res as unknown as HubMsgWireSendResult;
      this.emitLog("info", "hubmsg.provider.send.ok", {
        clientMessageId: r.clientMessageId,
        messageId,
        insertedAtMs
      });
      return { messageId, insertedAtMs };
    } catch (err) {
      this.emitLog("warn", "hubmsg.provider.send.failed", {
        clientMessageId: r.clientMessageId,
        recipientPublicKeyHex: r.recipientPublicKeyHex,
        err: err instanceof Error ? err.message : String(err)
      });
      throw err;
    }
  }

  async listMessages(input: ProviderListInput): Promise<ProviderListResult> {
    if (this.conn.state() !== "bound") {
      return { items: [], hasMore: false };
    }
    const scopeKind =
      input.scopeEndpoint.kind === "origin"
        ? APPMSG_ENVELOPE_ENDPOINT_KIND_ORIGIN
        : APPMSG_ENVELOPE_ENDPOINT_KIND_PLUGIN;
    const wireParams: HubMsgWireListParams = [
      input.ownerPublicKeyHex,
      scopeKind,
      input.scopeEndpoint.id,
      "all",
      input.afterMessageId ?? "",
      "",
      input.limit ?? 0
    ];
    const resBytes = await this.conn.request<Uint8Array>(
      HUBMSG_METHOD.MessageList,
      cborEncode([...wireParams])
    );
    const { items, hasMore } = decodeWireListResult(cborDecode(resBytes) as unknown);
    return {
      items: items.map((recordBytes) =>
        wireSealedToPublic(decodeWireSealedRecordBytes(recordBytes))
      ),
      hasMore
    };
  }

  async getMessage(input: ProviderGetInput): Promise<ProviderSealedMessageRecord | null> {
    if (this.conn.state() !== "bound") {
      return null;
    }
    const scopeKind =
      input.scopeEndpoint.kind === "origin"
        ? APPMSG_ENVELOPE_ENDPOINT_KIND_ORIGIN
        : APPMSG_ENVELOPE_ENDPOINT_KIND_PLUGIN;
    const wireParams: HubMsgWireGetParams = [
      input.messageId,
      input.ownerPublicKeyHex,
      scopeKind,
      input.scopeEndpoint.id
    ];
    try {
      const resBytes = await this.conn.request<Uint8Array>(
        HUBMSG_METHOD.MessageGet,
        cborEncode([...wireParams])
      );
      const res = cborDecode(resBytes) as unknown;
      if (!Array.isArray(res) || res.length !== 1 || !(res[0] instanceof Uint8Array)) {
        return null;
      }
      return wireSealedToPublic(decodeWireSealedRecordBytes(res[0] as Uint8Array));
    } catch {
      return null;
    }
  }

  subscribeMessages(handler: (rec: ProviderSealedMessageRecord) => void): () => void {
    return this.conn.subscribeEvent(
      HUBMSG_EVENT.MessageReceived,
      (dataBytes) => {
        try {
          const rec = wireSealedToPublic(decodeWireSealedRecordBytes(dataBytes));
          this.emitLog("info", "hubmsg.provider.event.delivered", {
            messageId: rec.messageId,
            clientMessageId: rec.clientMessageId,
            payloadBytes: dataBytes.length
          });
          handler(rec);
        } catch (err) {
          this.emitLog("warn", "hubmsg.provider.event.decode_failed", {
            payloadBytes: dataBytes.length,
            err: err instanceof Error ? err.message : String(err)
          });
        }
      }
    );
  }

  /**
   * 远端断线订阅（硬切换 003 反馈"必改"）。
   */
  onClose(handler: () => void): () => void {
    return this.conn.onClose(handler);
  }

  async checkOnline(input: ProviderOnlineInput): Promise<ProviderOnlineResult> {
    if (this.conn.state() !== "bound") {
      const out: ProviderOnlineResult = {};
      for (const h of input.publicKeyHexes) out[h] = "unknown" satisfies AppMsgOnlineStatus;
      this.emitLog("warn", "hubmsg.provider.online.skipped_not_bound", {
        requestedCount: input.publicKeyHexes.length,
        connState: this.conn.state(),
        keyPreview: previewPublicKeyHexes(input.publicKeyHexes)
      });
      return out;
    }
    this.emitLog("info", "hubmsg.provider.online.begin", {
      requestedCount: input.publicKeyHexes.length,
      connState: this.conn.state(),
      timeoutMs: HubMsgConnectionImpl.ONLINE_REQUEST_TIMEOUT_MS,
      keyPreview: previewPublicKeyHexes(input.publicKeyHexes)
    });
    try {
      const wireParams: HubMsgWireOnlineParams = [...input.publicKeyHexes];
      const resBytes = await this.conn.request<Uint8Array>(
        HUBMSG_METHOD.MessageOnline,
        cborEncode([...wireParams]),
        { timeoutMs: HubMsgConnectionImpl.ONLINE_REQUEST_TIMEOUT_MS }
      );
      const onlinePublicKeyHexes = decodeOnlineResult(cborDecode(resBytes) as unknown);
      const onlineSet = new Set(onlinePublicKeyHexes);
      const out: ProviderOnlineResult = {};
      let onlineCount = 0;
      for (const h of input.publicKeyHexes) {
        const status = (onlineSet.has(h) ? "online" : "offline") satisfies AppMsgOnlineStatus;
        if (status === "online") onlineCount += 1;
        out[h] = status;
      }
      this.emitLog("info", "hubmsg.provider.online.completed", {
        requestedCount: input.publicKeyHexes.length,
        onlineCount,
        offlineCount: input.publicKeyHexes.length - onlineCount,
        keyPreview: previewPublicKeyHexes(input.publicKeyHexes)
      });
      return out;
    } catch (err) {
      this.emitLog("warn", "hubmsg.provider.online.failed", {
        requestedCount: input.publicKeyHexes.length,
        connState: this.conn.state(),
        timeoutMs: HubMsgConnectionImpl.ONLINE_REQUEST_TIMEOUT_MS,
        keyPreview: previewPublicKeyHexes(input.publicKeyHexes),
        err: err instanceof Error ? err.message : String(err)
      });
      throw err;
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

function previewPublicKeyHexes(publicKeyHexes: readonly string[]): string[] {
  return publicKeyHexes.slice(0, 3).map((h) => formatShortPublicKey(h));
}

function previewPendingRequestIds(
  pendingById: ReadonlyMap<string, { methodId: number }>
): string[] {
  const out: string[] = [];
  for (const [requestId, pending] of pendingById.entries()) {
    out.push(`${requestId.slice(0, 8)}…:${describeMethodId(pending.methodId)}`);
    if (out.length >= 5) break;
  }
  return out;
}

function describeMethodId(methodId: number): string {
  switch (methodId) {
    case HUBMSG_METHOD.MessageSend:
      return "message.send";
    case HUBMSG_METHOD.MessageList:
      return "message.list";
    case HUBMSG_METHOD.MessageGet:
      return "message.get";
    case HUBMSG_METHOD.MessageOnline:
      return "message.online";
    default:
      return `unknown(${methodId})`;
  }
}
