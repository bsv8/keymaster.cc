// packages/plugin-hubcast/src/hubcastConnection.ts
// HubCast 单 WSS 连接管理（v1）。
//
// 设计缘由：
//   - 与 plugin-hubmsg 风格同构：单一 WSS 入口 `wss://<host>/ws/v1`；
//   - 握手顺序严格固定：服务端首帧 `ServerOpen` → 客户端响应
//     `ClientBind` → 服务端确认 `BindReady`；
//   - 业务帧：`Request` / `Result` / `Event`；心跳 `Ping` / `Pong`；控制
//     帧 `Close`；所有 frame body / method params / results 均为固定
//     顺序数组；
//   - 帧 kind / method id / event id 全部整数常量；
//   - 顶层 wire frame 是 `[frameKind, payloadBytes]` 二元组——
//     **不**带 version 字段（版本信息在 server_open body 内）；
//   - 推送事件：`broadcast.received`（HubCast → keymaster），本模块内部
//     把 wire payload 翻译为标准化 `ProviderBroadcastEvent`，对外只
//     暴露标准化输出；
//   - 协议 RPC：`subscription.set` / `subscription.list` /
//     `broadcast.publish` ——本模块把它们包装成 typed
//     `BroadcastProviderOperations` 业务方法；
//   - 本模块**不**做 envelope 编 / 解 / 验签——envelope 对本模块是不
//     透明字节；envelope 真值由 plugin-broadcast 内部 core 解释。
//
// 边界（施工单 §7.3）：
//   - 不 import `plugin-appmsg`；不 import `plugin-hubmsg` 的业务类型；
//   - 不复用 `MessageProvider`；不借用 `appmsg` 的 sealed message record；
//   - 只共享：binary frame 风格 + CBOR 编码原则 + 整数 frame kind；
//   - bind challenge 拼接 = `canonicalBindText`（与 HubMsg 共享，但
//     本模块不耦合 plugin-hubmsg 的实现——直接 import contracts 的
//     `canonicalBindText` 工具）。

import {
  HUB_FRAME_KIND,
  HUBCAST_EVENT,
  HUBCAST_METHOD,
  canonicalBindText,
  cborDecode,
  cborEncode,
  type BroadcastProviderSigner,
  type HubCastFrameBindReadyBody,
  type HubCastFrameClientBindBody,
  type HubCastFrameCloseBody,
  type HubCastFrameEventBody,
  type HubCastFramePingBody,
  type HubCastFrameRequestBody,
  type HubCastFrameResultBody,
  type HubCastFrameServerOpenBody,
  type HubCastWireBroadcastReceivedEvent,
  type HubCastWirePublishParams,
  type HubCastWireSubscriptionSetParams,
  type ProviderBroadcastEvent,
  type ProviderListSubscriptionsResult,
  type ProviderPublishInput,
  type ProviderReplaceSubscriptionsInput
} from "@keymaster/contracts";

/* ============== Provider 绑定阶段 ============== */

/**
 * HubCast bind signer 抽象（plugin-broadcast 在 setup 阶段提供）。
 *
 * 设计缘由：bind 阶段的 `(sessionId, nonce, publicKeyHex, issuedAtMs)`
 * 四元组拼接规则（`canonicalBindText`）**下沉**到本模块；plugin-broadcast
 * 通过通用 `BroadcastProviderSigner` 提供 `signChallenge({challenge})`
 * 闭包，本模块自行拼接 challenge。
 */
export interface HubCastBindSigner {
  publicKeyHex: string;
  /**
   * 用 owner 私钥对 `challenge` 字节做 secp256k1 签名（SHA-256 +
   * compact 64-byte），返回小写 hex。
   */
  signChallenge(args: { challenge: Uint8Array }): Promise<string>;
}

/**
 * 把通用 `BroadcastProviderSigner` 适配到 HubCast 内部
 * `HubCastBindSigner`。
 */
export class HubCastBindSignerAdapter implements HubCastBindSigner {
  constructor(private readonly providerSigner: BroadcastProviderSigner) {}
  get publicKeyHex(): string {
    return this.providerSigner.publicKeyHex;
  }
  async signChallenge(args: { challenge: Uint8Array }): Promise<string> {
    return this.providerSigner.signChallenge({ challenge: args.challenge });
  }
}

/* ============== 配置 / 日志 ============== */

export interface HubCastConnectionConfig {
  /** 形如 `wss://host/ws/v1`。 */
  url: string;
  /** 心跳秒数；缺省 30s。 */
  heartbeatSec?: number;
  /** 握手超时毫秒；缺省 10s。 */
  handshakeTimeoutMs?: number;
  /** 可选日志出口。 */
  logger?: HubCastConnectionLogger;
}

export interface HubCastConnectionLogger {
  info(input: {
    scope: string;
    event: string;
    message: string;
    data?: Record<string, unknown>;
  }): void;
  warn(input: {
    scope: string;
    event: string;
    message: string;
    data?: Record<string, unknown>;
  }): void;
  error(input: {
    scope: string;
    event: string;
    message: string;
    data?: Record<string, unknown>;
  }): void;
}

/* ============== frame 编 / 解码工具 ============== */

// 顶层 wire frame 是 `[frameKind (uint), payloadBytes (bytes)]` 二元组
// ——与 HubCast 服务端 `encodeTopFrame` 对齐。注意：**不**带 version 字
// 段；版本信息在 server_open body 内。

/**
 * 把 `(frameKind, payloadBytes)` 编码为顶层 CBOR wire 帧。
 */
function encodeTopFrame(frameKind: number, payload: Uint8Array): Uint8Array {
  return cborEncode([frameKind, payload]);
}

/**
 * 解码顶层 CBOR wire 帧为 `(frameKind, payloadBytes)`。
 *
 * 严格校验：必须是 2 元素数组；`frameKind` 必须是整数；`payloadBytes`
 * 必须是字节串。任何不符一律抛错——握手阶段会把它转成 bind 失败，运行
 * 阶段会丢弃该帧。
 */
function decodeTopFrame(bytes: Uint8Array): { frameKind: number; frameBody: Uint8Array } {
  const raw = cborDecode(bytes);
  if (!Array.isArray(raw) || raw.length !== 2) {
    throw new Error("HubCast: top frame must be a 2-element array");
  }
  const [frameKind, frameBody] = raw;
  if (typeof frameKind !== "number") {
    throw new Error("HubCast: top frame[0] must be integer");
  }
  if (!(frameBody instanceof Uint8Array)) {
    throw new Error("HubCast: top frame[1] must be bytes");
  }
  return { frameKind, frameBody };
}

/* ============== frame body codec ============== */

// 所有 frame body / method params / method results 都用确定性 CBOR 固
// 定顺序数组，**不**用 map（施工单 §2.3）。下面这一组 codec 严格对齐
// HubCast 服务端 frames.go 的 wire shape。

function encodeServerOpenBody(body: HubCastFrameServerOpenBody): Uint8Array {
  return cborEncode([body[0], body[1], body[2], body[3]]);
}

function decodeServerOpenBody(body: Uint8Array): HubCastFrameServerOpenBody {
  const v = cborDecode(body);
  if (!Array.isArray(v) || v.length !== 4) {
    throw new Error("HubCast: server_open body must be [version, sessionId, issuedAtMs, nonce]");
  }
  if (
    typeof v[0] !== "string" ||
    typeof v[1] !== "string" ||
    typeof v[2] !== "number" ||
    typeof v[3] !== "string"
  ) {
    throw new Error("HubCast: server_open body field types invalid");
  }
  return [v[0], v[1], v[2], v[3]];
}

function encodeClientBindBody(body: HubCastFrameClientBindBody): Uint8Array {
  // wire：[nonce (text), publicKey (33B raw bytes), issuedAtMs (uint), signature64 (64B raw bytes)]
  return cborEncode([body[0], body[1], body[2], body[3]]);
}

function decodeBindReadyBody(body: Uint8Array): HubCastFrameBindReadyBody {
  // wire：[ownerPublicKey (33B raw bytes), boundAtMs (uint)]
  const v = cborDecode(body);
  if (!Array.isArray(v) || v.length !== 2) {
    throw new Error("HubCast: bind_ready body must be [ownerPublicKey, boundAtMs]");
  }
  if (!(v[0] instanceof Uint8Array) || v[0].length !== 33) {
    throw new Error("HubCast: bind_ready ownerPublicKey must be 33 bytes");
  }
  if (typeof v[1] !== "number") {
    throw new Error("HubCast: bind_ready boundAtMs must be integer");
  }
  return [v[0], v[1]];
}

function encodeRequestBody(body: HubCastFrameRequestBody): Uint8Array {
  // wire：[requestId (uint), methodId (uint), paramsBytes]
  return cborEncode([body[0], body[1], body[2]]);
}

function decodeResultBody(body: Uint8Array): HubCastFrameResultBody {
  // wire：[requestId (uint), isError (bool), payloadBytes]
  const raw = cborDecode(body);
  if (!Array.isArray(raw) || raw.length !== 3) {
    throw new Error("HubCast: result body must be [requestId, isError, payloadBytes]");
  }
  const v = raw as unknown[];
  if (typeof v[0] !== "number" || typeof v[1] !== "boolean" || !(v[2] instanceof Uint8Array)) {
    throw new Error("HubCast: result body field types invalid");
  }
  return [v[0], v[1], v[2] as Uint8Array];
}

function encodeEventBody(_body: HubCastFrameEventBody): Uint8Array {
  throw new Error("HubCast: event body encode is not used on the client side");
}

function decodeEventBody(body: Uint8Array): HubCastFrameEventBody {
  // wire：[eventId (uint), payloadBytes]
  const v = cborDecode(body);
  if (!Array.isArray(v) || v.length !== 2) {
    throw new Error("HubCast: event body must be [eventId, payloadBytes]");
  }
  if (typeof v[0] !== "number" || !(v[1] instanceof Uint8Array)) {
    throw new Error("HubCast: event body field types invalid");
  }
  return [v[0], v[1] as Uint8Array];
}

function decodeCloseBody(body: Uint8Array): HubCastFrameCloseBody {
  // wire：[code (uint), reason (text)]
  const v = cborDecode(body);
  if (!Array.isArray(v) || v.length !== 2) {
    throw new Error("HubCast: close body must be [code, reason]");
  }
  if (typeof v[0] !== "number" || typeof v[1] !== "string") {
    throw new Error("HubCast: close body field types invalid");
  }
  return [v[0], v[1]];
}

function encodePingBody(body: HubCastFramePingBody): Uint8Array {
  // wire：[nonce (uint)]
  return cborEncode([body[0]]);
}

function decodePingBody(body: Uint8Array): HubCastFramePingBody {
  const v = cborDecode(body);
  if (!Array.isArray(v) || v.length !== 1 || typeof v[0] !== "number") {
    throw new Error("HubCast: ping/pong body must be [nonce]");
  }
  return [v[0]];
}

/* ============== 连接状态 ============== */

export type HubCastConnectionState = "idle" | "connecting" | "bound" | "closed";

/* ============== 接口 ============== */

export interface HubCastConnection {
  state(): HubCastConnectionState;
  connect(signer: HubCastBindSigner): Promise<void>;
  close(): void;
  /**
   * 发送一个 RPC 请求。
   *
   * requestId 由本模块内部生成（uint64 风格：单调递增 + 随机高位），请
   * 求 / 响应通过 requestId 匹配；resolve 时返回 result body 的
   * payloadBytes（成功）/ reject 一个错误对象（失败）。
   */
  request(
    methodId: number,
    params: Uint8Array,
    options?: { timeoutMs?: number }
  ): Promise<Uint8Array>;
  subscribeEvent(eventId: number, handler: (data: Uint8Array) => void): () => void;
  onClose(handler: () => void): () => void;
}

/* ============== WebSocketLike ============== */

export interface WebSocketLike {
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
    throw new Error("HubCast: WebSocket is not available in this environment");
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
        set = new Set<(ev: unknown) => void>();
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

function ensureBytes(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (typeof raw === "string") {
    throw new Error("HubCast: received string frame (not allowed in v1 wire)");
  }
  throw new Error("HubCast: unknown message payload type");
}

/**
 * 生成下一个 requestId（uint64 风格）。
 *
 * 序号高 32 位 = 当前 `Date.now()` 的低 32 位（保证短时间窗口内单调递
 * 增）；低 32 位 = `Math.floor(Math.random() * 0x1_000_000_00)`（同一
 * 毫秒内的去重空间）。
 *
 * 服务端无去重 / 无排序要求——只要保证单连接内不重复即可。
 */
function newRequestId(): number {
  const hi = (Date.now() & 0xffff_ffff) >>> 0;
  const lo = Math.floor(Math.random() * 0x1_000_000_00) >>> 0;
  return ((hi << 16) >>> 0) * 0x1_0000 + (lo & 0xffff_ffff);
}

function decodeResultError(bytes: Uint8Array): { code: string; message: string } {
  if (bytes.length === 0) {
    return { code: "unknown", message: "HubCast: request failed" };
  }
  const raw = cborDecode(bytes);
  if (
    !Array.isArray(raw) ||
    raw.length !== 2 ||
    typeof raw[0] !== "string" ||
    typeof raw[1] !== "string"
  ) {
    return { code: "unknown", message: "HubCast: request failed" };
  }
  return { code: raw[0], message: raw[1] };
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("hex length must be even");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return out;
}

function bytesToHexLower(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += (bytes[i] ?? 0).toString(16).padStart(2, "0");
  }
  return s;
}

/* ============== 单 WSS 客户端实现 ============== */

export class HubCastConnectionImpl implements HubCastConnection {
  private readonly cfg: HubCastConnectionConfig;
  private socket: WebSocketLike | null = null;
  private stateValue: HubCastConnectionState = "idle";
  private sessionId: string | null = null;
  private nonce: string | null = null;
  /** bind 后服务端确认的 owner 公钥（33B raw）。与当前 signer 公钥 hex 比对。 */
  private boundOwnerBytes: Uint8Array | null = null;
  private readonly pendingById = new Map<
    number,
    {
      methodId: number;
      startedAtMs: number;
      resolve: (v: Uint8Array) => void;
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

  constructor(cfg: HubCastConnectionConfig) {
    this.cfg = { heartbeatSec: 30, ...cfg };
  }

  state(): HubCastConnectionState {
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
        scope: "hubcast.connection",
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
    this.boundOwnerBytes = null;
    this.negotiatedHeartbeatSec = null;
  }

  private waitForHandshakeStage<T>(args: {
    socket: WebSocketLike;
    stage: "server_open" | "bind_ready";
    timeoutMs: number;
    onMessage(frame: { frameKind: number; frameBody: Uint8Array }): T;
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
          const frame = decodeTopFrame(bytes);
          this.emitLog("info", "hubcast.handshake.frame.received", {
            stage: args.stage,
            frameKind: frame.frameKind,
            frameBytes: bytes.length
          });
          succeed(args.onMessage(frame));
        } catch (err) {
          this.emitLog("warn", "hubcast.handshake.frame.invalid", {
            stage: args.stage,
            err: err instanceof Error ? err.message : String(err)
          });
          fail(err);
        }
      };

      const onError = (ev: unknown): void => {
        this.emitLog("warn", "hubcast.handshake.socket_error", {
          stage: args.stage,
          detail: describeUnknownEvent(ev)
        });
        fail(
          new Error(`HubCast: websocket error during ${args.stage}${describeUnknownEvent(ev)}`)
        );
      };

      const onClose = (ev: unknown): void => {
        this.emitLog("warn", "hubcast.handshake.socket_close", {
          stage: args.stage,
          detail: describeUnknownEvent(ev)
        });
        fail(
          new Error(`HubCast: websocket closed during ${args.stage}${describeUnknownEvent(ev)}`)
        );
      };

      timer = setTimeout(() => {
        this.emitLog("error", "hubcast.handshake.timeout", {
          stage: args.stage,
          timeoutMs: args.timeoutMs
        });
        fail(new Error(`HubCast: ${args.stage} timeout after ${args.timeoutMs}ms`));
      }, args.timeoutMs);

      args.socket.addEventListener("message", onMessage);
      args.socket.addEventListener("error", onError);
      args.socket.addEventListener("close", onClose);
    });
  }

  async connect(signer: HubCastBindSigner): Promise<void> {
    if (this.stateValue === "bound") return;
    if (this.stateValue === "connecting") {
      throw new Error("HubCast: connect already in progress");
    }
    this.stateValue = "connecting";
    const handshakeTimeoutMs = Math.max(
      1,
      this.cfg.handshakeTimeoutMs ?? HubCastConnectionImpl.DEFAULT_HANDSHAKE_TIMEOUT_MS
    );
    this.emitLog("info", "hubcast.connect.started", {
      url: this.cfg.url,
      handshakeTimeoutMs,
      publicKeyHex: signer.publicKeyHex
    });
    const sock = createWebSocket(this.cfg.url);
    this.socket = sock;
    let stage: "server_open" | "sign_challenge" | "send_client_bind" | "bind_ready" =
      "server_open";
    try {
      // stage 1: server_open → 拿 sessionId + serverNonce
      const so = await this.waitForHandshakeStage({
        socket: sock,
        stage: "server_open",
        timeoutMs: handshakeTimeoutMs,
        onMessage: (frame) => {
          if (frame.frameKind !== HUB_FRAME_KIND.ServerOpen) {
            throw new Error(
              `HubCast: expected server_open (kind=${HUB_FRAME_KIND.ServerOpen}), got kind=${frame.frameKind}`
            );
          }
          const body = decodeServerOpenBody(frame.frameBody);
          // server_open body = [serverVersion, sessionId, issuedAtMs, serverNonce]
          // heartbeatSec 不在 server_open 内，沿用本地配置。
          return { sessionId: body[1], nonce: body[3] };
        }
      });
      this.sessionId = so.sessionId;
      this.nonce = so.nonce;

      // stage 2: 拼 challenge → sign
      stage = "sign_challenge";
      const issuedAtMs = Date.now();
      const plainText = canonicalBindText(
        this.sessionId,
        this.nonce,
        signer.publicKeyHex,
        issuedAtMs
      );
      const plainBytes = new TextEncoder().encode(plainText);
      const sigHex = await signer.signChallenge({ challenge: plainBytes });
      const sigBytes = hexToBytes(sigHex);
      if (sigBytes.length !== 64) {
        throw new Error(
          `HubCast: bind signature must be 64 bytes (compact secp256k1), got ${sigBytes.length}`
        );
      }
      const pubkeyBytes = hexToBytes(signer.publicKeyHex);
      if (pubkeyBytes.length !== 33) {
        throw new Error(
          `HubCast: bind publicKey must be 33 bytes (compressed secp256k1), got ${pubkeyBytes.length}`
        );
      }
      // client_bind wire = [nonce, publicKey (33B raw), issuedAtMs, signature64 (64B raw)]
      const clientBindBody: HubCastFrameClientBindBody = [
        this.nonce,
        pubkeyBytes,
        issuedAtMs,
        sigBytes
      ];

      stage = "send_client_bind";
      sock.send(encodeTopFrame(HUB_FRAME_KIND.ClientBind, encodeClientBindBody(clientBindBody)));

      // stage 3: bind_ready → 校验服务端回传的 owner 与本连接 signer 一致
      stage = "bind_ready";
      const { ownerPubkey33 } = await this.waitForHandshakeStage<{ ownerPubkey33: Uint8Array }>({
        socket: sock,
        stage: "bind_ready",
        timeoutMs: handshakeTimeoutMs,
        onMessage: (frame) => {
          if (frame.frameKind === HUB_FRAME_KIND.BindReady) {
            const body = decodeBindReadyBody(frame.frameBody);
            return { ownerPubkey33: body[0] };
          }
          if (frame.frameKind === HUB_FRAME_KIND.Close) {
            const body = decodeCloseBody(frame.frameBody);
            throw new Error(`HubCast: bind closed (code=${body[0]}, reason=${body[1]})`);
          }
          throw new Error(
            `HubCast: expected bind_ready (kind=${HUB_FRAME_KIND.BindReady}), got kind=${frame.frameKind}`
          );
        }
      });
      // 服务端 bind_ready 回的 ownerPublicKey 必须等于本地 signer 公钥
      if (bytesToHexLower(ownerPubkey33) !== signer.publicKeyHex.toLowerCase()) {
        throw new Error(
          `HubCast: bind_ready owner mismatch; expected ${signer.publicKeyHex}, got ${bytesToHexLower(ownerPubkey33)}`
        );
      }
      this.boundOwnerBytes = ownerPubkey33;
      this.stateValue = "bound";

      sock.addEventListener("message", (raw: unknown) => this.onSocketMessage(raw));
      sock.addEventListener("close", (ev: unknown) => this.onSocketClose("socket_event", ev));
      this.startHeartbeat();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emitLog("error", "hubcast.connect.failed", {
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
    this.boundOwnerBytes = null;
    this.negotiatedHeartbeatSec = null;
    for (const [, p] of this.pendingById) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error("HubCast: connection closed"));
    }
    this.pendingById.clear();
  }

  async request(
    methodId: number,
    params: Uint8Array,
    options?: { timeoutMs?: number }
  ): Promise<Uint8Array> {
    if (this.stateValue !== "bound" || !this.socket) {
      throw new Error("HubCast: not bound");
    }
    const requestId = newRequestId();
    const reqBody: HubCastFrameRequestBody = [requestId, methodId, params];
    const payload = encodeRequestBody(reqBody);
    const timeoutMs = options?.timeoutMs ?? HubCastConnectionImpl.DEFAULT_REQUEST_TIMEOUT_MS;
    return new Promise<Uint8Array>((resolve, reject) => {
      const startedAtMs = Date.now();
      const timer = setTimeout(() => {
        this.pendingById.delete(requestId);
        this.emitLog("error", "hubcast.request.timeout", {
          requestId,
          methodId,
          timeoutMs,
          durationMs: Date.now() - startedAtMs
        });
        reject(new Error(`HubCast: request timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingById.set(requestId, {
        methodId,
        startedAtMs,
        resolve,
        reject,
        timer
      });
      try {
        this.socket!.send(encodeTopFrame(HUB_FRAME_KIND.Request, payload));
      } catch (err) {
        if (timer) clearTimeout(timer);
        this.pendingById.delete(requestId);
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
    } catch {
      return;
    }
    let frame: { frameKind: number; frameBody: Uint8Array };
    try {
      frame = decodeTopFrame(bytes);
    } catch {
      return;
    }
    if (frame.frameKind === HUB_FRAME_KIND.Ping) {
      const body = decodePingBody(frame.frameBody);
      if (!this.socket || this.stateValue !== "bound") return;
      // pong body = [nonce] 与 ping 同形
      const pongPayload = encodePingBody(body);
      try {
        this.socket.send(encodeTopFrame(HUB_FRAME_KIND.Pong, pongPayload));
      } catch {
        // ignore
      }
      return;
    }
    if (frame.frameKind === HUB_FRAME_KIND.Pong) {
      return;
    }
    if (frame.frameKind === HUB_FRAME_KIND.Result) {
      const body = decodeResultBody(frame.frameBody);
      const p = this.pendingById.get(body[0]);
      if (!p) return;
      this.pendingById.delete(body[0]);
      if (p.timer) clearTimeout(p.timer);
      if (body[1]) {
        // isError === true：payload 是 ErrorBody [code, message]
        const errInfo = decodeResultError(body[2]);
        const e = new Error(`${errInfo.code}: ${errInfo.message}`);
        (e as Error & { code?: string }).code = errInfo.code;
        p.reject(e);
      } else {
        // isError === false：payload 是 success result body
        p.resolve(body[2]);
      }
      return;
    }
    if (frame.frameKind === HUB_FRAME_KIND.Event) {
      const body = decodeEventBody(frame.frameBody);
      const set = this.eventHandlers.get(body[0]);
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
      for (const [, p] of this.pendingById) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(new Error(`HubCast: server closed (code=${body[0]}, reason=${body[1]})`));
      }
      this.pendingById.clear();
      this.onSocketClose("close_frame", { code: body[0], reason: body[1] });
      return;
    }
  }

  private onSocketClose(source: "socket_event" | "close_frame", ev?: unknown): void {
    if (this.stateValue === "closed") return;
    this.stateValue = "closed";
    this.stopHeartbeat();
    for (const [, p] of this.pendingById) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error("HubCast: socket closed"));
    }
    this.pendingById.clear();
    this.socket = null;
    this.sessionId = null;
    this.nonce = null;
    this.boundOwnerBytes = null;
    this.negotiatedHeartbeatSec = null;
    this.emitClose();
    void source;
    void ev;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const sec = Math.max(1, this.cfg.heartbeatSec ?? 30);
    this.pingHandle = setInterval(() => {
      if (!this.socket || this.stateValue !== "bound") return;
      const pingBody: HubCastFramePingBody = [Date.now() & 0xffff_ffff];
      try {
        this.socket.send(
          encodeTopFrame(HUB_FRAME_KIND.Ping, encodePingBody(pingBody))
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

/* ============== 对外 typed 接口（HubCastProviderOperations） ============== */

/**
 * `BroadcastProviderOperations` typed handle 的 HubCast 实现。
 *
 * 设计缘由：本类把 wire 层 `HubCastConnection` 包装成 typed
 * `BroadcastProviderOperations`；wire 上所有 frame body / method
 * params / results 均为固定顺序数组。
 *
 * v1 服务端 success 路径返回空数组——`publish` / `replaceSubscriptions`
 * resolve 时**不**携带业务字段。`subscribeBroadcasts` 收到事件时直接
 * 透传 `SignedHubCastEnvelopeV1` 二元组给 handler。
 */
export class HubCastProviderOperations {
  private readonly conn: HubCastConnection;

  constructor(conn: HubCastConnection) {
    this.conn = conn;
  }

  state(): "idle" | "connecting" | "bound" | "closed" {
    return this.conn.state();
  }

  close(): void {
    this.conn.close();
  }

  async publish(input: ProviderPublishInput): Promise<void> {
    if (this.conn.state() !== "bound") {
      throw new Error("HubCast: not bound; cannot publish");
    }
    // broadcast.publish params = [envelopeBytes, signatureBytes]
    const wireParams: HubCastWirePublishParams = [input.envelopeBytes, input.signatureBytes];
    await this.conn.request(
      HUBCAST_METHOD.BroadcastPublish,
      cborEncode(wireParams as unknown as [Uint8Array, Uint8Array])
    );
    // 服务端 success 返回空数组，resolve 即视为已接受。
  }

  async replaceSubscriptions(input: ProviderReplaceSubscriptionsInput): Promise<void> {
    if (this.conn.state() !== "bound") {
      throw new Error("HubCast: not bound; cannot replaceSubscriptions");
    }
    // subscription.set params = [channelIds]（**不**是裸 string[]）
    const wireParams: HubCastWireSubscriptionSetParams = [[...input.channelIds]];
    await this.conn.request(
      HUBCAST_METHOD.SubscriptionSet,
      cborEncode(wireParams as unknown as [string[]])
    );
    // 服务端 success 返回空数组，resolve 即视为已接受；**不**回包 channel 列表。
  }

  async listSubscriptions(): Promise<ProviderListSubscriptionsResult> {
    if (this.conn.state() !== "bound") {
      return { channelIds: [] };
    }
    // subscription.list params = []（无参数）
    const resBytes = await this.conn.request(
      HUBCAST_METHOD.SubscriptionList,
      cborEncode([])
    );
    // success result = [channelId1, channelId2, ...]（裸 string[]）
    const res = cborDecode(resBytes);
    if (!Array.isArray(res)) {
      throw new Error("HubCast: malformed subscription.list result");
    }
    const channelIds: string[] = [];
    for (const item of res) {
      if (typeof item !== "string") {
        throw new Error("HubCast: subscription.list channelId must be text");
      }
      channelIds.push(item);
    }
    return { channelIds };
  }

  subscribeBroadcasts(handler: (ev: ProviderBroadcastEvent) => void): () => void {
    return this.conn.subscribeEvent(HUBCAST_EVENT.BroadcastReceived, (dataBytes) => {
      try {
        // 服务端直接推送原始 SignedHubCastEnvelopeV1 二元组
        //   [envelopeBytes, signature64]
        const raw = cborDecode(dataBytes) as unknown as HubCastWireBroadcastReceivedEvent;
        if (!Array.isArray(raw) || raw.length !== 2) {
          return;
        }
        const [envelopeBytes, signatureBytes] = raw;
        if (!(envelopeBytes instanceof Uint8Array) || !(signatureBytes instanceof Uint8Array)) {
          return;
        }
        if (signatureBytes.length !== 64) {
          return;
        }
        handler({ envelopeBytes, signatureBytes });
      } catch {
        // ignore decode failure
      }
    });
  }

  onClose(handler: () => void): () => void {
    return this.conn.onClose(handler);
  }
}
