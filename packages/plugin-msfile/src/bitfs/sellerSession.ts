// BitFS 卖方会话（Coordinator Worker 侧）。
//
// 中文说明：
//   - 本模块只编排「会话生命周期 + 严格帧解析 + 会话状态」，不接触 libp2p
//     Host、不读取私钥、不自行计算协议密码学；
//   - 网络收发由 Window P2P executor 的 BitFS stream 端口完成；
//   - 报价、开池、交付与收款由受限协议端口完成，且端口必须遵守
//     persist-before-send：返回的每一条出站帧都必须先落盘再交给本模块发送；
//   - 私钥只经 Vault 的受限签名能力进入协议端口，不进入本模块。

import { MAX_WIRE_FRAME_BYTES, parse, type WireKind } from "go-bitfs";

/** Window lane 提供的 BitFS stream 端口；只在 Window 侧持有 Host。 */
export interface BitfsSellerStreamTransport {
  /** 按选定 locator 建立连接，并在通道打开后发送首帧（报价）。 */
  open(input: {
    /** 本次销售会话的稳定编号。 */
    sessionId: string;
    /** 本次销售连接使用的 locator 类型。 */
    transport: "multiaddr" | "webrtc-sdp";
    /** ChannelProtocol Hash 请求的真实 message_id；SDP 模式必填。 */
    requestMessageId: string;
    /** 已通过白名单与 PeerId 校验的候选 multiaddr 列表；SDP 模式为空。 */
    addresses: string[];
    /** ChannelProtocol WebRTC session_id；SDP 模式必填。 */
    webrtcSessionId: string;
    /** 请求者已验证的 33 字节压缩公钥 hex。 */
    publicKeyHex: string;
    /** 请求者已验证公钥派生出的 PeerId。 */
    expectedPeerId: string;
    /** 已持久化的 exact Kind 1 报价字节。 */
    firstFrame: Uint8Array;
    signal?: AbortSignal;
  }): Promise<void>;
  /** 发送一条已由协议端口持久化的 exact Artifact 字节。 */
  send(sessionId: string, frame: Uint8Array, signal?: AbortSignal): Promise<void>;
  /** 关闭会话连接；必须幂等。 */
  close(sessionId: string, reason?: string): Promise<void>;
}

/** 协议端口对一条已严格解析入站帧的处理结果。 */
export type BitfsSellerProtocolResult =
  /** 无需回复（例如 Kind 4 已验收并进入广播对账）。 */
  | { type: "none" }
  /** 发送这些已持久化的 exact Artifact 字节。 */
  | { type: "send"; frames: Uint8Array[] }
  /** 终止会话；reason 必须是稳定分类，不得携带协议字节。 */
  | { type: "close"; reason: string };

/** 卖方协议端口；实现负责 SDK 角色调用、journal 与内容读取。 */
export interface BitfsSellerProtocolPort {
  /**
   * 当前端口是否具备完成一次销售的能力。
   *
   * 中文说明：为 false 时 Coordinator 不得对外报价——报价意味着库存、价格
   * 与交付承诺，端口未就绪时只能保持静默。
   */
  readonly ready: boolean;
  /** 拨号前先建立应用会话并持久化 exact 报价。 */
  openSession?(input: {
    /** 本次销售会话编号。 */
    sessionId: string;
    /** 已持久化的 exact Kind 1。 */
    quoteBytes: Uint8Array;
    /** 报价绑定的 Seed Hash。 */
    seedHashHex: string;
    /** 已验证买方公钥。 */
    counterpartyPublicKeyHex: string;
  }): Promise<void>;
  /** 处理一条已严格解析的入站 Artifact。 */
  onFrame(input: {
    /** 本次销售会话编号。 */
    sessionId: string;
    /** 入站 Artifact Kind。 */
    kind: WireKind;
    /** exact canonical Artifact 字节副本。 */
    bytes: Uint8Array;
  }): Promise<BitfsSellerProtocolResult>;
}

/** 会话关闭的稳定原因分类；用于日志与运行状态，不进入 wire。 */
export type BitfsSellerSessionCloseReason =
  | "idle_timeout"
  | "malformed_wire"
  | "transport_error"
  | "protocol_error"
  | "generation_revoked"
  | "capacity";

export interface BitfsSellerSessionManagerDeps {
  /** Window BitFS stream 端口。 */
  transport: BitfsSellerStreamTransport;
  /** 受限协议端口。 */
  protocol: BitfsSellerProtocolPort;
  /** 显式可信时钟。 */
  nowMs(): number;
  /** 单会话空闲上限（毫秒）。 */
  idleTimeoutMs(): number;
  /** 同时销售会话上限。 */
  maxSessions(): number;
  /** 会话数量变化；0 表示可以回到 ready。 */
  onActiveSessionsChanged(activeCount: number): void;
  /** 当前管理器是否仍属于当前 generation。 */
  isCurrent(): boolean;
  /** 生产诊断；协议错误仍由管理器关闭会话。 */
  onProtocolError?(input: { sessionId: string; message: string; stack?: string }): void | Promise<void>;
  onSessionClosed?(input: { sessionId: string; reason: string; atMs: number }): void | Promise<void>;
}

interface SellerSessionEntry {
  sessionId: string;
  /** 最近一次活动时间，用于空闲超时。 */
  lastActivityMs: number;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  closing: boolean;
}

/** 卖方会话管理器；所有异步回调都复核 generation，迟到结果不得写入新会话。 */
export class BitfsSellerSessionManager {
  private readonly frameQueues = new Map<string, Promise<void>>();
  private readonly sessions = new Map<string, SellerSessionEntry>();
  private epoch = 0;

  constructor(private readonly deps: BitfsSellerSessionManagerDeps) {}

  /** 当前活跃会话数。 */
  activeCount(): number {
    return this.sessions.size;
  }

  /** 会话编号是否属于当前 manager。 */
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * 建立一次销售会话并发送已持久化的报价。
   *
   * 返回 false 表示容量已满或 generation 已变化；调用方不得把 false 当成
   * 已报价。
   */
  async start(input: {
    /** 会话编号。 */
    sessionId: string;
    /** 本次销售连接使用的 locator 类型。 */
    transport?: "multiaddr" | "webrtc-sdp";
    /** ChannelProtocol Hash 请求的真实 message_id。 */
    requestMessageId?: string;
    /** 已验证的候选 multiaddr。 */
    addresses: string[];
    /** ChannelProtocol WebRTC session_id。 */
    webrtcSessionId?: string;
    /** 请求者已验证的 33 字节压缩公钥 hex。 */
    publicKeyHex: string;
    /** 由同一公钥派生的 PeerId。 */
    expectedPeerId: string;
    /** 已持久化的 exact Kind 1 报价字节。 */
    quoteBytes: Uint8Array;
    /** 报价绑定的 Seed Hash。 */
    seedHashHex: string;
  }): Promise<boolean> {
    if (!this.deps.isCurrent()) return false;
    if (this.sessions.has(input.sessionId)) return false;
    if (this.sessions.size >= this.deps.maxSessions()) return false;
    const transport = input.transport ?? "multiaddr";
    if (transport === "webrtc-sdp" && (!input.requestMessageId || !input.webrtcSessionId)) return false;
    if (transport === "multiaddr" && input.addresses.length === 0) return false;
    if (!(input.quoteBytes instanceof Uint8Array) || input.quoteBytes.byteLength === 0) return false;
    const entry: SellerSessionEntry = {
      sessionId: input.sessionId,
      lastActivityMs: this.deps.nowMs(),
      idleTimer: undefined,
      closing: false,
    };
    this.sessions.set(input.sessionId, entry);
    this.notifyCount();
    this.touch(entry);
    const epochAtStart = this.epoch;
    try {
      await this.deps.protocol.openSession?.({
        sessionId: input.sessionId,
        quoteBytes: input.quoteBytes.slice(),
        seedHashHex: input.seedHashHex,
        counterpartyPublicKeyHex: input.publicKeyHex,
      });
      await this.deps.transport.open({
        sessionId: input.sessionId,
        transport,
        requestMessageId: input.requestMessageId ?? "",
        addresses: [...input.addresses],
        webrtcSessionId: input.webrtcSessionId ?? "",
        publicKeyHex: input.publicKeyHex,
        expectedPeerId: input.expectedPeerId,
        firstFrame: input.quoteBytes.slice(),
      });
    } catch (error) {
      if (this.sessions.get(input.sessionId) === entry) {
        this.sessions.delete(input.sessionId);
        this.clearIdleTimer(entry);
        this.notifyCount();
      }
      throw error;
    }
    if (epochAtStart !== this.epoch || !this.sessions.has(input.sessionId) || !this.deps.isCurrent()) {
      // 拨号期间发生锁定/切 Key/关闭卖方：不得留下已连接会话。
      await this.deps.transport.close(input.sessionId, "generation_revoked").catch(() => undefined);
      return false;
    }
    return true;
  }

  /** 处理一条来自 Window lane 的入站帧。 */
  async handleFrame(event: { sessionId: string; frame: Uint8Array }): Promise<void> {
    const prior = this.frameQueues.get(event.sessionId) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(() => this.handleFrameNow(event));
    this.frameQueues.set(event.sessionId, next);
    try {
      await next;
    } finally {
      if (this.frameQueues.get(event.sessionId) === next) this.frameQueues.delete(event.sessionId);
    }
  }

  private async handleFrameNow(event: { sessionId: string; frame: Uint8Array }): Promise<void> {
    const entry = this.sessions.get(event.sessionId);
    if (!entry || entry.closing || !this.deps.isCurrent()) return;
    if (!(event.frame instanceof Uint8Array) || event.frame.byteLength === 0) {
      await this.close(event.sessionId, "malformed_wire");
      return;
    }
    if (event.frame.byteLength > MAX_WIRE_FRAME_BYTES) {
      await this.close(event.sessionId, "malformed_wire");
      return;
    }
    let artifact: { kind: WireKind; bytes(): Uint8Array };
    try {
      // parse 是入站唯一末端门禁：非规范编码、结构错误、越界字段全部在此拒绝。
      artifact = parse(event.frame.slice());
    } catch {
      await this.close(event.sessionId, "malformed_wire");
      return;
    }
    this.touch(entry);
    let result: BitfsSellerProtocolResult;
    try {
      result = await this.deps.protocol.onFrame({ sessionId: event.sessionId, kind: artifact.kind, bytes: artifact.bytes() });
    } catch (error) {
      console.warn("[msfile] seller protocol frame failed", error instanceof Error ? error.message : String(error));
      await Promise.resolve(this.deps.onProtocolError?.({
        sessionId: event.sessionId,
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
      })).catch(() => undefined);
      await this.close(event.sessionId, "protocol_error");
      return;
    }
    if (this.sessions.get(event.sessionId) !== entry || entry.closing || !this.deps.isCurrent()) return;
    this.touch(entry);
    if (result.type === "none") return;
    if (result.type === "close") {
      await this.close(event.sessionId, normalizeCloseReason(result.reason));
      return;
    }
    for (const frame of result.frames) {
      if (this.sessions.get(event.sessionId) !== entry || entry.closing || !this.deps.isCurrent()) return;
      if (!(frame instanceof Uint8Array) || frame.byteLength === 0 || frame.byteLength > MAX_WIRE_FRAME_BYTES) {
        await this.close(event.sessionId, "protocol_error");
        return;
      }
      try {
        await this.deps.transport.send(event.sessionId, frame.slice());
      } catch {
        await this.close(event.sessionId, "transport_error");
        return;
      }
      this.touch(entry);
    }
  }

  /** 关闭一个会话；重复调用幂等。 */
  async close(sessionId: string, reason: BitfsSellerSessionCloseReason | string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.closing = true;
    this.sessions.delete(sessionId);
    this.clearIdleTimer(entry);
    this.notifyCount();
    await Promise.resolve(this.deps.onSessionClosed?.({ sessionId, reason, atMs: this.deps.nowMs() })).catch(() => undefined);
    await this.deps.transport.close(sessionId, reason).catch(() => undefined);
  }

  /**
   * 撤销全部会话：锁定、切 Key、切存储、关闭卖方或 Worker 重建时调用。
   * 迟到帧在 clear 之后不再进入协议端口。
   */
  clear(): void {
    this.epoch += 1;
    const entries = [...this.sessions.values()];
    this.sessions.clear();
    for (const entry of entries) {
      entry.closing = true;
      this.clearIdleTimer(entry);
      void this.deps.transport.close(entry.sessionId, "generation_revoked").catch(() => undefined);
    }
    this.notifyCount();
  }

  private touch(entry: SellerSessionEntry): void {
    entry.lastActivityMs = this.deps.nowMs();
    this.clearIdleTimer(entry);
    const timeout = this.deps.idleTimeoutMs();
    if (!Number.isFinite(timeout) || timeout <= 0) return;
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = undefined;
      if (this.sessions.get(entry.sessionId) !== entry || entry.closing || !this.deps.isCurrent()) return;
      // 空闲超时只关闭本次连接，不改变本地 Seed 可用性。
      void this.close(entry.sessionId, "idle_timeout");
    }, timeout);
  }

  private clearIdleTimer(entry: SellerSessionEntry): void {
    if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }

  private notifyCount(): void {
    this.deps.onActiveSessionsChanged(this.sessions.size);
  }
}

/** 协议端口给出的关闭原因只允许白名单，避免把内部字节带进日志/状态。 */
function normalizeCloseReason(reason: string): string {
  return /^[a-z0-9_]{1,64}$/u.test(reason) ? reason : "protocol_error";
}

/** 协议端口未就绪时的缺省实现：不报价、不处理入站帧。 */
export function createUnavailableBitfsSellerProtocolPort(): BitfsSellerProtocolPort {
  return {
    ready: false,
    async onFrame() {
      return { type: "close", reason: "seller_protocol_unavailable" };
    },
  };
}
