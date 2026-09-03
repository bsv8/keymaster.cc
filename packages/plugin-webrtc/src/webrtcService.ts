// packages/plugin-webrtc/src/webrtcService.ts
// WebRTC 业务 service（施工单 2026-07-04 002 硬切换）。
//
// 设计缘由：
//   - 单活会话：整个 plugin-webrtc 实例同时只允许一通会话占位；占位期间包括
//     「拨号中 / 响铃中 / 已接通 / 挂断清理中」；
//   - 文件传输信令统一走 Channel 的固定 `bsv8.webrtc.signal.v1` 私信协议；
//   - 音视频呼叫暂时关闭：ChannelProtocol 尚未提供正式的呼叫会合请求，不能
//     用自定义摘要冒充文件 Hash，也不能接受没有前置关系的媒体 offer；
//   - 收到旧版呼叫请求或媒体 offer 只丢弃，不创建来电、不申请设备权限；
//   - 不持久化任何媒体 / SDP / ICE 累积态；页面刷新 / disable / 挂断都立刻
//     释放本地 tracks + RTCPeerConnection；
//   - phase 状态机：idle / inviting / incoming / connecting / connected / ended；
//     ended 是挂断后短时间存在的过渡态，之后自动回 idle；
//   - 媒体流真值通过 `attachToVideo(...)` 显式绑给 UI，避免 UI 猜 `_native`；
//   - 单测友好：所有浏览器 API 走抽象层 `WebrtcEnvironment`，测试可注入 fake。

import type {
  ChannelPrivateMessageEvent,
  ChannelRuntime,
  JSONValue
} from "@keymaster/contracts";
import type { KeyspaceService, NoticeRegistry } from "@keymaster/contracts";
import { WEBRTC_SIGNAL_PROTOCOL } from "./constants.js";
import { APP_MESSAGE_PROTOCOL } from "bsv8-channel-protocol/app-message";
import { HASH_REQUEST_CHANNEL } from "bsv8-channel-protocol/hash-request";
import type { WebrtcHistoryItem, WebrtcHistoryService } from "./webrtcHistoryService.js";
import {
  isAcceptableRemoteSession,
  newAnswerSignal,
  newEndOfCandidatesSignal,
  newIceSignal,
  newOfferSignal,
  parseSignalValue,
  tryParseSignal,
  type WebrtcHangupReason,
  type WebrtcIceSignal,
  type WebrtcInviteSignal,
  type WebrtcAnswerSignal,
  type WebrtcSignal,
  type WebrtcEndOfCandidatesSignal
} from "./webrtcSignal.js";
import { newMessageID, newSessionID, parseSessionID } from "bsv8-channel-protocol";
import {
  DEFAULT_STUN_SERVERS,
  type WebrtcConfig,
  type WebrtcConfigStore
} from "./webrtcConfig.js";

/* ============== 公共类型 ============== */

export type WebrtcMode = "audio" | "video";

/**
 * 会话 phase 真值（内嵌在 snapshot 中）：
 *   - idle：无活动会话；
 *   - inviting：已发 invite，等待对端 answer；
 *   - incoming：收到 invite，等待本地 accept / decline；
 *   - connecting：本地已确认 / 已发 answer，RTC 尚未到 connected；
 *   - connected：RTC connectionState 已 connected 且持有远端流；
 *   - ended：刚挂断（远端 / 本地 / ICE 断开），短时间保留供 UI 展示，
 *            一段 tick 后自动回到 idle。
 */
export type WebrtcSessionPhase =
  | "idle"
  | "inviting"
  | "incoming"
  | "connecting"
  | "connected"
  | "ended";

/** 拨号门禁失败原因。 */
export type WebrtcBlockReason =
  | "service_not_ready"
  | "invalid_target"
  | "call_protocol_unavailable"
  | "device_unavailable"
  | "send_invite_failed"
  | "create_offer_failed"
  | "busy_local"
  | "invalid_state";

/** 入站远端提示（一次性，UI 消费后清）。 */
export type WebrtcRemoteNoticeKind = "fallback_suggested" | "rejected" | "busy";

export interface WebrtcRemoteNotice {
  kind: WebrtcRemoteNoticeKind;
  message: string;
  /** 仅 fallback_suggested 时有值。 */
  suggestedMode?: WebrtcMode;
}

export interface WebrtcSessionSnapshot {
  phase: WebrtcSessionPhase;
  remotePublicKeyHex: string | null;
  direction: "outgoing" | "incoming" | null;
  mode: WebrtcMode | null;
  /** 当前是否持有本地 stream。 */
  hasLocalStream: boolean;
  /** 当前是否已收到远端 stream。 */
  hasRemoteStream: boolean;
  /** 入站远端一次性提示；UI 消费后清空（消费动作仍由 UI 决定）。 */
  remoteNotice: WebrtcRemoteNotice | null;
  /** service 整体是否可用（Channel ready + 设备环境）。 */
  serviceReady: boolean;
  /** 最近一次错误（仅诊断；UI 默认不展示 raw 字符串，会走 i18n）。 */
  lastError: WebrtcBlockReason | null;
}

export type WebrtcSubscriber = (snapshot: WebrtcSessionSnapshot) => void;

export interface StartCallInput {
  targetPublicKeyHex: string;
  mode: WebrtcMode;
}

export interface WebrtcService {
  snapshot(): WebrtcSessionSnapshot;
  subscribe(handler: WebrtcSubscriber): () => void;
  isReady(): boolean;
  listHistoryForPeer(peerPublicKeyHex: string): Promise<WebrtcHistoryItem[]>;
  getTransferBlob(blobKey: string): Promise<Blob | null>;
  startCall(input: StartCallInput): Promise<void>;
  sendImage(input: { targetPublicKeyHex: string; file: Blob | File }): Promise<void>;
  sendFile(input: { targetPublicKeyHex: string; file: Blob | File }): Promise<void>;
  acceptIncoming(): Promise<void>;
  rejectIncoming(): Promise<void>;
  /** 用户明确确认后，才允许为入站文件请求签名并发布 Hash。 */
  acceptIncomingTransfer(sessionId: string): Promise<void>;
  /** 拒绝一个尚未建立 WebRTC 连接的入站文件请求。 */
  rejectIncomingTransfer(sessionId: string): Promise<void>;
  hangup(): Promise<void>;
  consumeRemoteNotice(): void;

  /**
   * 把本地 / 远端媒体流绑到一个 `<video>` 元素上。`srcObject` 写入 +
   * `muted` 设置（local 强制 muted 防回授）。返回清理函数，重新调用 /
   * 通话结束 / 服务释放时 UI 必须调用以解绑。**不**依赖 UI 访问
   * `MediaStreamLike` 的内部字段。
   */
  attachToVideo(direction: "local" | "remote", videoEl: HTMLVideoElement): () => void;

  runStunDiagnostics(): Promise<StunDiagnosticResult[]>;
  getStunServers(): readonly string[];
  applyStunServers(input: string[]): Promise<void>;
  dispose(): void;
}

/* ============== 环境抽象 ============== */

export interface WebrtcEnvironment {
  createPeerConnection(config: RTCConfiguration): RTCPeerConnectionLike;
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStreamLike>;
  /** 可选的测试 session_id 生成器；返回值必须是 ChannelProtocol 的 32-byte base64url。 */
  generateSessionId?(): string;
  /** 可选的 SHA-256 注入点，仅用于在测试中控制大文件 Hash 的异步边界。 */
  hashSha256?(bytes: Uint8Array): Promise<string>;
  now(): number;
  delay(ms: number): Promise<void>;
  /**
   * 仅 STUN 自检使用：创建完成后必须立即开始 ICE gathering，以便真实
   * 触发 srflx 候选。返回 dialTimeoutMs——超过该时间未拿到 srflx 视为 timeout。
   */
  stunDiagnosticTimeoutMs?: number;
}

export interface RTCPeerConnectionLike {
  readonly connectionState: RTCPeerConnectionState | string;
  setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void>;
  createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit>;
  createAnswer(): Promise<RTCSessionDescriptionInit>;
  addIceCandidate(candidate: RTCIceCandidateInit): Promise<void>;
  onIceCandidate(cb: (init: RTCIceCandidateInit) => void): void;
  onIceGatheringStateChange(cb: (state: string) => void): void;
  onConnectionStateChange(cb: (state: string) => void): void;
  onTrack(cb: (stream: MediaStreamLike) => void): void;
  onDataChannel(cb: (channel: DataChannelLike) => void): void;
  replaceLocalStream(stream: MediaStreamLike | null): void;
  /** 创建一个 data channel；测试 / 诊断路径使用。真实业务连接不需要主动开。 */
  createDataChannel(label: string): DataChannelLike;
  close(): void;
}

export interface DataChannelLike {
  readonly label: string;
  readonly readyState: "connecting" | "open" | "closing" | "closed";
  /** 浏览器 RTCDataChannel 的发送缓冲字节数；测试 fake 可以不提供。 */
  readonly bufferedAmount?: number;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(): void;
  onOpen(cb: () => void): void;
  onMessage(cb: (data: string | ArrayBuffer | ArrayBufferView) => void): void;
  onClose(cb: () => void): void;
  onError(cb: (err: unknown) => void): void;
}

export interface MediaStreamLike {
  stop(): void;
  isLive(): boolean;
  /** 浏览器侧的原始 `MediaStream`；node / test 环境下为 undefined。 */
  readonly native: unknown;
}

export interface StunDiagnosticResult {
  url: string;
  status: "ok" | "timeout" | "error";
  /** `error` 时有英文一句话。 */
  error?: string;
}

/* ============== 默认 browser env ============== */

export function createBrowserWebrtcEnvironment(): WebrtcEnvironment {
  return {
    createPeerConnection: (config) => {
      const pc = new RTCPeerConnection(config);
      return createBrowserRTCPeerConnectionLike(pc);
    },
    getUserMedia: async (constraints) => {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      return createBrowserMediaStreamLike(stream);
    },
    generateSessionId: () => newSessionID(),
    now: () => Date.now(),
    delay: (ms) => new Promise((r) => setTimeout(r, ms)),
    stunDiagnosticTimeoutMs: 4000
  };
}

function createBrowserRTCPeerConnectionLike(pc: RTCPeerConnection): RTCPeerConnectionLike {
  let iceCb: ((c: RTCIceCandidateInit) => void) | null = null;
  let gatherCb: ((s: string) => void) | null = null;
  let stateCb: ((s: string) => void) | null = null;
  let trackCb: ((s: MediaStreamLike) => void) | null = null;
  let dataChannelCb: ((channel: DataChannelLike) => void) | null = null;
  let localStream: MediaStream | null = null;
  /**
   * sender 真值缓存。
   *
   * 设计缘由：
   *   - 新建 `RTCPeerConnection` 时 `pc.getSenders()` 为空；如果只做
   *     `replaceTrack()`，不会自动把本地 track 加进连接；
   *   - 这正是“看起来连上了，但远端没声音没画面”的根因：本地预览来自
   *     `getUserMedia()`，不是来自对端真正收到的媒体；
   *   - 因此浏览器侧必须在第一次接入本地流时，对缺失 kind 显式
   *     `pc.addTrack(track, stream)`，之后同 kind 才走 `replaceTrack()`。
   */
  const senderByKind = new Map<string, RTCRtpSender>();

  pc.onicecandidate = (ev) => {
    if (!iceCb) return;
    if (ev.candidate === null) return;
    iceCb({
      candidate: ev.candidate.candidate,
      sdpMid: ev.candidate.sdpMid,
      sdpMLineIndex: ev.candidate.sdpMLineIndex,
      usernameFragment: ev.candidate.usernameFragment
    });
  };
  pc.onicegatheringstatechange = () => {
    if (gatherCb) gatherCb(pc.iceGatheringState);
  };
  pc.onconnectionstatechange = () => {
    if (stateCb) stateCb(pc.connectionState);
  };
  pc.ontrack = (ev) => {
    if (!trackCb) return;
    const incoming = ev.streams[0];
    if (incoming) trackCb(createBrowserMediaStreamLike(incoming));
  };
  pc.ondatachannel = (ev) => {
    if (!dataChannelCb) return;
    dataChannelCb(createBrowserDataChannelLike(ev.channel));
  };

  return {
    get connectionState() {
      return pc.connectionState;
    },
    setLocalDescription: (d) => pc.setLocalDescription(d),
    setRemoteDescription: (d) => pc.setRemoteDescription(d),
    createOffer: (opts) => pc.createOffer(opts),
    createAnswer: () => pc.createAnswer(),
    addIceCandidate: (c) => pc.addIceCandidate(c),
    onIceCandidate: (cb) => {
      iceCb = cb;
    },
    onIceGatheringStateChange: (cb) => {
      gatherCb = cb;
    },
    onConnectionStateChange: (cb) => {
      stateCb = cb;
    },
    onTrack: (cb) => {
      trackCb = cb;
    },
    onDataChannel: (cb) => {
      dataChannelCb = cb;
    },
    replaceLocalStream: (stream) => {
      if (stream === null) {
        for (const sender of senderByKind.values()) {
          sender.replaceTrack(null).catch(() => undefined);
        }
        localStream?.getTracks().forEach((t) => t.stop());
        localStream = null;
        return;
      }
      const ms = stream.native;
      if (!(ms instanceof MediaStream)) return;
      const tracks = ms.getTracks();
      const nextKinds = new Set(tracks.map((t) => t.kind));

      // 先把新流中存在的 kind 对上：已有 sender → replace；缺 sender → addTrack。
      for (const track of tracks) {
        const existing = senderByKind.get(track.kind);
        if (existing) {
          existing.replaceTrack(track).catch(() => undefined);
          continue;
        }
        try {
          const sender = pc.addTrack(track, ms);
          senderByKind.set(track.kind, sender);
        } catch {
          // addTrack 失败时不抛到 UI；后续 SDP/连接失败会走现有错误路径。
        }
      }

      // 新流里已没有的 kind 要主动摘掉，否则旧 sender 仍继续发旧轨。
      for (const [kind, sender] of senderByKind.entries()) {
        if (nextKinds.has(kind)) continue;
        sender.replaceTrack(null).catch(() => undefined);
      }

      localStream?.getTracks().forEach((t) => t.stop());
      localStream = ms;
    },
    createDataChannel: (label) => createBrowserDataChannelLike(pc.createDataChannel(label)),
    close: () => pc.close()
  };
}

function createBrowserDataChannelLike(channel: RTCDataChannel): DataChannelLike {
  let openCb: (() => void) | null = null;
  let messageCb: ((data: string | ArrayBuffer | ArrayBufferView) => void) | null = null;
  let closeCb: (() => void) | null = null;
  let errorCb: ((err: unknown) => void) | null = null;
  channel.onopen = () => {
    if (openCb) openCb();
  };
  channel.onmessage = (ev) => {
    if (!messageCb) return;
    messageCb(ev.data as string | ArrayBuffer | ArrayBufferView);
  };
  channel.onclose = () => {
    if (closeCb) closeCb();
  };
  channel.onerror = (ev) => {
    if (errorCb) errorCb(ev);
  };
  return {
    get label() {
      return channel.label;
    },
    get readyState() {
      return channel.readyState as DataChannelLike["readyState"];
    },
    get bufferedAmount() {
      return channel.bufferedAmount;
    },
    send(data) {
      channel.send(data as never);
    },
    close: () => channel.close(),
    onOpen: (cb) => {
      openCb = cb;
    },
    onMessage: (cb) => {
      messageCb = cb;
    },
    onClose: (cb) => {
      closeCb = cb;
    },
    onError: (cb) => {
      errorCb = cb;
    }
  };
}

function createBrowserMediaStreamLike(stream: MediaStream): MediaStreamLike {
  return {
    stop: () => stream.getTracks().forEach((t) => t.stop()),
    isLive: () => stream.getTracks().some((t) => t.readyState === "live"),
    get native(): unknown {
      return stream;
    }
  };
}

/* ============== Service 实现 ============== */

const ENDED_PHASE_TTL_MS = 1500;

/** 文件传输允许的最大总字节数；入站和出站都必须使用同一个上限。 */
export const MAX_WEBRTC_TRANSFER_BYTES = 16 * 1024 * 1024;
/** DataChannel 单个分片的最大原始字节数。 */
const WEBRTC_TRANSFER_CHUNK_BYTES = 16 * 1024;
/** 单次传输最多允许的分片数，防止用大量 1-byte 分片耗尽内存。 */
const MAX_WEBRTC_TRANSFER_CHUNKS = Math.ceil(MAX_WEBRTC_TRANSFER_BYTES / WEBRTC_TRANSFER_CHUNK_BYTES);
/** 入站传输请求在本地待确认队列中的最长保留时间。 */
const TRANSFER_REQUEST_TTL_MS = 2 * 60 * 1000;
/** 同一 WebRTC service 的待确认请求总数上限。 */
const MAX_PENDING_TRANSFER_REQUESTS = 32;
/** 单个发送者同时进入待确认队列的请求数上限。 */
const MAX_PENDING_TRANSFER_REQUESTS_PER_SENDER = 2;
/** 同时执行通讯录准入查询的总数上限。 */
const MAX_TRANSFER_ADMISSION_IN_FLIGHT = 8;
/** 单个发送者同时执行通讯录准入查询的数量上限。 */
const MAX_TRANSFER_ADMISSION_IN_FLIGHT_PER_SENDER = 2;
/** 通讯录准入查询的最长等待时间；超时按拒绝处理。 */
const TRANSFER_ADMISSION_TIMEOUT_MS = 5 * 1000;
/** 单个发送者在一个限流窗口内允许建立的请求数。 */
const TRANSFER_REQUEST_RATE_LIMIT = 4;
const TRANSFER_REQUEST_RATE_WINDOW_MS = 60 * 1000;
/** DataChannel 没有活动时释放连接，避免传输槽永久占用。 */
const TRANSFER_IDLE_TIMEOUT_MS = 30 * 1000;
/** 出站 DataChannel 的高水位；超过后等待浏览器发送缓冲下降。 */
const TRANSFER_BUFFER_HIGH_WATER_MARK = 1024 * 1024;
/** 出站 DataChannel 等待恢复时的低水位。 */
const TRANSFER_BUFFER_LOW_WATER_MARK = 512 * 1024;
/** 发送缓冲长期不下降时主动失败，避免占用传输槽。 */
const TRANSFER_BUFFER_WAIT_TIMEOUT_MS = 10 * 1000;
const MAX_TRANSFER_METADATA_LENGTH = 256;
const MAX_TRANSFER_MIME_LENGTH = 128;

function createProtocolSessionId(env: WebrtcEnvironment): string {
  const supplied = env.generateSessionId?.();
  if (supplied) {
    try {
      return parseSessionID(supplied);
    } catch {
      // 旧测试环境可能仍返回可读 session 字符串；线上绝不能把它发到 wire。
    }
  }
  return newSessionID();
}

function encodeDescription(description: RTCSessionDescriptionInit): string {
  // ChannelProtocol 的 signal.sdp 就是 SDP 文本，不再把整个 description
  // 对象 JSON 塞进字符串。测试 fake 若没有 SDP 文本才保留可解析的 fallback。
  return typeof description.sdp === "string" && description.sdp.length > 0
    ? description.sdp
    : JSON.stringify(description);
}

function decodeDescription(sdp: string, type: "offer" | "answer"): RTCSessionDescriptionInit {
  // 兼容没有实现真实 SDP 的 fake peer；真实浏览器 SDP 直接走文本分支。
  if (sdp.trimStart().startsWith("{")) {
    try {
      const parsed = JSON.parse(sdp) as RTCSessionDescriptionInit;
      if (parsed && typeof parsed === "object" && typeof parsed.sdp === "string") {
        return { ...parsed, type: parsed.type ?? type };
      }
    } catch {
      // 不是 JSON 就按真实 SDP 文本处理。
    }
  }
  return { type, sdp };
}

function isDataChannelOffer(sdp: string): boolean {
  // 浏览器 data channel offer 有 m=application；fake 可用常见 SCTP 标志。
  return /(?:^|\r?\n)m=application(?:\s|$)/.test(sdp) || /(?:^|\r?\n)a=sctp(?:\s|$)/.test(sdp);
}

function toProtocolCandidate(candidate: RTCIceCandidateInit): {
  candidate: string;
  sdp_mid: string | null;
  sdp_m_line_index: number | null;
} {
  if (typeof candidate.candidate !== "string" || candidate.candidate.length === 0) {
    throw new Error("invalid_ice_candidate");
  }
  return {
    candidate: candidate.candidate,
    sdp_mid: candidate.sdpMid ?? null,
    sdp_m_line_index: candidate.sdpMLineIndex ?? null
  };
}

function fromProtocolCandidate(candidate: WebrtcIceSignal["signal"]["candidate"]): RTCIceCandidateInit {
  return {
    candidate: candidate.candidate,
    sdpMid: candidate.sdp_mid,
    sdpMLineIndex: candidate.sdp_m_line_index
  };
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // 只 Hash 当前 Uint8Array view，不能把带有 offset/更大容量的底层
  // ArrayBuffer 一并 Hash，否则请求关系会因调用方的 buffer 布局而改变。
  const viewBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", viewBuffer);
  return bytesToHex(new Uint8Array(digest));
}

export function createWebrtcService(input: {
  channel: ChannelRuntime;
  keyspace?: KeyspaceService;
  historyService?: WebrtcHistoryService;
  noticeRegistry?: NoticeRegistry;
  configStore: WebrtcConfigStore;
  /** 只允许已知联系人/业务准入的发送者进入用户确认队列；缺省为拒绝。 */
  isTransferSenderAllowed?: (publicKeyHex: string, signal?: AbortSignal) => boolean | Promise<boolean>;
  env?: WebrtcEnvironment;
  logger?: WebrtcLogger;
}): WebrtcService {
  const channel = input.channel;
  const store = input.configStore;
  const env = input.env ?? createBrowserWebrtcEnvironment();
  const log: WebrtcLogger = input.logger ?? silentLogger();
  const keyspace = input.keyspace ?? ({ active: () => ({}) } as KeyspaceService);
  const historyService =
    input.historyService ??
    ({
      listForPeer: async () => [],
      appendCall: async () => undefined,
      appendTransfer: async () => undefined,
      getBlob: async () => null
    } as WebrtcHistoryService);
  const noticeRegistry =
    input.noticeRegistry ??
    ({
      upsert: () => undefined,
      dismiss: () => undefined,
      list: () => [],
      subscribe: () => () => undefined,
      removeBySourcePluginId: () => undefined
    } as NoticeRegistry);

  async function calculateSha256(bytes: Uint8Array): Promise<string> {
    return env.hashSha256 ? env.hashSha256(bytes) : sha256Hex(bytes);
  }

  /** 通过固定 WebRTC 私信协议发布精确 ChannelProtocol body。 */
  async function publishSignalBody(recipientPublicKeyHex: string, body: WebrtcSignal): Promise<void> {
    // 先在插件侧走同一个 parser，确保不会把旧 envelope 交给 Coordinator。
    const parsed = parseSignalValue(body);
    if (!parsed.ok) throw new Error(`invalid_signal_body: ${parsed.reason}`);
    await channel.publishPrivate({
      recipientPublicKeyHex,
      protocol: WEBRTC_SIGNAL_PROTOCOL,
      content: parsed.signal as unknown as JSONValue
    });
  }

  async function publishHashRequest(hash: string): Promise<string> {
    if (!channel.publishHashRequest) throw new Error("hash_request_required");
    const result = await channel.publishHashRequest({ hash, locator: "webrtc-sdp" });
    if (!result || typeof result.messageId !== "string" || result.messageId.length === 0) {
      throw new Error("invalid_hash_request_result");
    }
    return result.messageId;
  }

  interface ActiveSession {
    /** 对应本次 offer 的真实 Hash 请求编号；握手完成前为空。 */
    requestMessageId: string | null;
    /** ChannelProtocol 32-byte base64url session_id。 */
    sessionId: string;
    direction: "outgoing" | "incoming";
    mode: WebrtcMode;
    remotePublicKeyHex: string;
    ownerPublicKeyHex: string | null;
    startedAtMs: number;
    localStream: MediaStreamLike | null;
    pc: RTCPeerConnectionLike | null;
    remoteStream: MediaStreamLike | null;
    pendingOffer: RTCSessionDescriptionInit | null;
    /** 收到 call request 后，用户已接受但仍在等待 Hash/offer。 */
    callRequestAccepted: boolean;
    /** 已为本次 call 发布 Hash 请求，等待对端 offer。 */
    hashRequestPublished: boolean;
    /** peer connection 已 connected 标志位；用于区分 `connecting` 与 `connected`。 */
    pcConnected: boolean;
    /**
     * 是否已完成"协商"：呼出端收到 answer 且 setRemoteDescription 成功；接听端已
     * 发 answer 后。完成协商 → 即使 pc 尚未 connected 也进入 `connecting`，
     * 而不是停留在 `inviting` / `incoming`。
     */
    negotiated: boolean;
    /** 防止来电通知和迟到 offer 同时触发两次媒体授权。 */
    acceptPromise?: Promise<void>;
  }
  let active: ActiveSession | null = null;
  interface KnownHashRequest {
    publisherPublicKeyHex: string;
    hash: string;
    expiresAtMs: number;
  }
  /** Coordinator 已验签的 Hash 请求；只保存短期关系证据，不保存文件内容。 */
  const knownHashRequests = new Map<string, KnownHashRequest>();

  interface ActiveTransfer {
    /** 对应本次 DataChannel offer 的真实 Hash 请求编号；握手完成前为空。 */
    requestMessageId: string | null;
    /** ChannelProtocol 32-byte base64url session_id。 */
    sessionId: string;
    direction: "outgoing" | "incoming";
    remotePublicKeyHex: string;
    ownerPublicKeyHex: string | null;
    /** 创建时捕获的 owner generation，防止切换密钥后旧异步操作继续推进。 */
    ownerGeneration: number;
    startedAtMs: number;
    kind: "image" | "file";
    fileName?: string;
    mimeType?: string;
    byteLength: number;
    /** 文件字节 Hash；只有目标发布该 Hash 请求后才创建 offer。 */
    contentHash: string;
    pc: RTCPeerConnectionLike | null;
    channel: DataChannelLike | null;
    pendingOffer: RTCSessionDescriptionInit | null;
    /** 目标 owner 已发布 Hash 请求后才允许创建 offer。 */
    hashRequestPublished: boolean;
    pendingChunks: Uint8Array[];
    pendingMeta: { kind: "image" | "file"; fileName?: string; mimeType?: string; byteLength: number } | null;
    /** 已按序接收的下一个分片序号。 */
    expectedSeq: number;
    /** 已接收的原始字节数，始终不得超过 byteLength。 */
    receivedBytes: number;
    /** 出站端已发送 transfer_end，等待接收端验证后的完成确认。 */
    awaitingCompletion: boolean;
    /** 防止 DataChannel open 回调和 readyState 检查重复发送。 */
    payloadSending: boolean;
    /** 最近一次传输活动的释放定时器。 */
    idleTimer?: ReturnType<typeof setTimeout>;
    blob?: Blob;
    settled: boolean;
    resolve?: () => void;
    reject?: (err: Error) => void;
  }
  let activeTransfer: ActiveTransfer | null = null;
  interface PendingTransferRequest {
    requesterPublicKeyHex: string;
    ownerPublicKeyHex: string;
    /** 收到请求时捕获的 owner generation。 */
    ownerGeneration: number;
    hash: string;
    kind: "image" | "file";
    byteLength: number;
    fileName?: string;
    mimeType?: string;
    /** 只有用户明确确认后才变为 true。 */
    accepted: boolean;
    hashRequestMessageId?: string;
    /** Hash Publish 尚未返回时先暂存合法 offer，待真实 message_id 确认后处理。 */
    pendingOffer?: WebrtcInviteSignal;
    expiresAtMs: number;
  }
  interface TransferAcceptanceToken {
    sessionId: string;
    ownerGeneration: number;
    request: PendingTransferRequest;
  }
  const pendingTransferRequests = new Map<string, PendingTransferRequest>();
  const transferRequestRates = new Map<string, { windowStartedAtMs: number; count: number }>();
  /** 联系人查询是异步的；记录 generation，避免旧查询 finally 删除新 owner 的同键检查。 */
  const transferRequestChecks = new Map<string, number>();
  const transferAdmissionInFlightBySender = new Map<string, number>();
  const transferAdmissionControllers = new Set<AbortController>();
  let transferAdmissionInFlight = 0;
  /** 同一时刻只允许一个入站请求进入 Hash Publish；用对象身份防止复用 sessionId 误清理。 */
  let transferAcceptanceInFlight: TransferAcceptanceToken | null = null;
  const isTransferSenderAllowed = input.isTransferSenderAllowed ?? (() => false);
  let pendingTransferPruneTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  /** 每次 active owner 变化或 service dispose 都递增，作为异步操作的生命周期栅栏。 */
  let ownerGeneration = 0;

  function pruneKnownHashRequests(): void {
    const now = env.now();
    for (const [messageId, request] of knownHashRequests) {
      if (request.expiresAtMs <= now) knownHashRequests.delete(messageId);
    }
    while (knownHashRequests.size > 512) {
      const first = knownHashRequests.keys().next().value as string | undefined;
      if (first === undefined) break;
      knownHashRequests.delete(first);
    }
  }

  function rememberKnownHashRequest(message: { publisherPublicKeyHex: string; messageId: string; content: JSONValue }): void {
    if (message.content === null || typeof message.content !== "object" || Array.isArray(message.content)) return;
    const hash = message.content.hash;
    const locators = message.content.locators;
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)
      || !Array.isArray(locators)
      || !locators.some((locator) => locator !== null && typeof locator === "object" && !Array.isArray(locator) && locator.kind === "webrtc-sdp")) return;
    const publisherPublicKeyHex = message.publisherPublicKeyHex.trim().toLowerCase();
    knownHashRequests.set(`${publisherPublicKeyHex}\u0000${message.messageId}`, {
      publisherPublicKeyHex,
      hash,
      expiresAtMs: env.now() + 10 * 60 * 1000
    });
    pruneKnownHashRequests();
  }

  const TRANSFER_REQUEST_TYPE = "keymaster.webrtc.transfer.request";

  function isObject(value: JSONValue): value is { [key: string]: JSONValue } {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function isBoundedMetadata(value: unknown, maxLength: number): value is string {
    return typeof value === "string"
      && value.length <= maxLength
      && ![...value].some((char) => char < " " || char === "\u007f");
  }

  function parseTransferRequest(content: JSONValue): {
    sessionId: string;
    hash: string;
    kind: "image" | "file";
    byteLength: number;
    fileName?: string;
    mimeType?: string;
  } | null {
    if (!isObject(content)
      || content.type !== TRANSFER_REQUEST_TYPE
      || typeof content.session_id !== "string"
      || typeof content.hash !== "string"
      || (content.kind !== "image" && content.kind !== "file")
      || typeof content.byte_length !== "number"
      || !Number.isSafeInteger(content.byte_length)
      || content.byte_length < 0
      || content.byte_length > MAX_WEBRTC_TRANSFER_BYTES) return null;
    if (!/^[0-9a-f]{64}$/.test(content.hash)) return null;
    try { parseSessionID(content.session_id); } catch { return null; }
    if (content.file_name !== undefined && !isBoundedMetadata(content.file_name, MAX_TRANSFER_METADATA_LENGTH)) return null;
    if (content.mime_type !== undefined && !isBoundedMetadata(content.mime_type, MAX_TRANSFER_MIME_LENGTH)) return null;
    return {
      sessionId: content.session_id,
      hash: content.hash,
      kind: content.kind,
      byteLength: content.byte_length,
      ...(typeof content.file_name === "string" ? { fileName: content.file_name } : {}),
      ...(typeof content.mime_type === "string" ? { mimeType: content.mime_type } : {})
    };
  }

  function dismissTransferNotice(sessionId: string): void {
    noticeRegistry.dismiss(`webrtc-transfer-${sessionId}`);
  }

  function removePendingTransferRequest(sessionId: string): void {
    if (!pendingTransferRequests.delete(sessionId)) return;
    dismissTransferNotice(sessionId);
    if (pendingTransferRequests.size === 0 && pendingTransferPruneTimer !== undefined) {
      clearTimeout(pendingTransferPruneTimer);
      pendingTransferPruneTimer = undefined;
    }
  }

  function removePendingTransferRequestIfCurrent(
    sessionId: string,
    expected: PendingTransferRequest
  ): void {
    if (pendingTransferRequests.get(sessionId) !== expected) return;
    removePendingTransferRequest(sessionId);
  }

  function schedulePendingTransferPrune(): void {
    if (disposed || pendingTransferPruneTimer !== undefined || pendingTransferRequests.size === 0) return;
    pendingTransferPruneTimer = setTimeout(() => {
      pendingTransferPruneTimer = undefined;
      prunePendingTransferRequests();
      schedulePendingTransferPrune();
    }, TRANSFER_REQUEST_TTL_MS);
  }

  function prunePendingTransferRequests(): void {
    const now = env.now();
    for (const [sessionId, request] of pendingTransferRequests) {
      if (request.expiresAtMs <= now) removePendingTransferRequest(sessionId);
    }
    for (const [sender, rate] of transferRequestRates) {
      if (rate.windowStartedAtMs + TRANSFER_REQUEST_RATE_WINDOW_MS <= now) transferRequestRates.delete(sender);
    }
    while (pendingTransferRequests.size > MAX_PENDING_TRANSFER_REQUESTS) {
      const first = pendingTransferRequests.keys().next().value as string | undefined;
      if (first === undefined) break;
      removePendingTransferRequest(first);
    }
    while (transferRequestRates.size > 512) {
      const first = transferRequestRates.keys().next().value as string | undefined;
      if (first === undefined) break;
      transferRequestRates.delete(first);
    }
    if (!disposed) schedulePendingTransferPrune();
  }

  function pendingTransferCountForSender(senderPublicKeyHex: string): number {
    let count = 0;
    for (const request of pendingTransferRequests.values()) {
      if (request.requesterPublicKeyHex === senderPublicKeyHex) count += 1;
    }
    return count;
  }

  function consumeTransferRequestRate(senderPublicKeyHex: string): boolean {
    prunePendingTransferRequests();
    const now = env.now();
    const current = transferRequestRates.get(senderPublicKeyHex);
    if (!current || current.windowStartedAtMs + TRANSFER_REQUEST_RATE_WINDOW_MS <= now) {
      transferRequestRates.set(senderPublicKeyHex, { windowStartedAtMs: now, count: 1 });
      return true;
    }
    if (current.count >= TRANSFER_REQUEST_RATE_LIMIT) return false;
    current.count += 1;
    return true;
  }

  function admissionInFlightForSender(senderPublicKeyHex: string): number {
    return transferAdmissionInFlightBySender.get(senderPublicKeyHex) ?? 0;
  }

  function reserveTransferAdmission(senderPublicKeyHex: string): boolean {
    if (disposed
      || transferAdmissionInFlight >= MAX_TRANSFER_ADMISSION_IN_FLIGHT
      || admissionInFlightForSender(senderPublicKeyHex) >= MAX_TRANSFER_ADMISSION_IN_FLIGHT_PER_SENDER) {
      return false;
    }
    transferAdmissionInFlight += 1;
    transferAdmissionInFlightBySender.set(
      senderPublicKeyHex,
      admissionInFlightForSender(senderPublicKeyHex) + 1
    );
    return true;
  }

  function releaseTransferAdmission(senderPublicKeyHex: string): void {
    transferAdmissionInFlight = Math.max(0, transferAdmissionInFlight - 1);
    const next = admissionInFlightForSender(senderPublicKeyHex) - 1;
    if (next <= 0) {
      transferAdmissionInFlightBySender.delete(senderPublicKeyHex);
    } else {
      transferAdmissionInFlightBySender.set(senderPublicKeyHex, next);
    }
  }

  function cancelTransferAdmissions(): void {
    for (const controller of transferAdmissionControllers) controller.abort();
  }

  async function checkTransferSenderAllowed(senderPublicKeyHex: string): Promise<boolean> {
    const controller = new AbortController();
    transferAdmissionControllers.add(controller);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const decision = Promise.resolve().then(() =>
        isTransferSenderAllowed(senderPublicKeyHex, controller.signal)
      );
      const timedOut = new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), TRANSFER_ADMISSION_TIMEOUT_MS);
      });
      const cancelled = new Promise<boolean>((resolve) => {
        onAbort = () => resolve(false);
        if (controller.signal.aborted) onAbort();
        else controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      return await Promise.race([decision, timedOut, cancelled]);
    } catch (error) {
      log.warn("webrtc.service", "transfer_sender_admission_failed", error);
      return false;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (onAbort !== undefined) controller.signal.removeEventListener("abort", onAbort);
      transferAdmissionControllers.delete(controller);
      controller.abort();
    }
  }

  async function handleIncomingHashRequest(message: {
    channel: string;
    publisherPublicKeyHex: string;
    messageId: string;
    content: JSONValue;
  }): Promise<void> {
    if (disposed) return;
    if (message.channel !== HASH_REQUEST_CHANNEL) return;
    rememberKnownHashRequest(message);
    const publisher = message.publisherPublicKeyHex.trim().toLowerCase();
    const current = currentOwnerPublicKeyHex();
    if (!current || publisher === current) return;

    if (activeTransfer && isTransferCurrent(activeTransfer) && activeTransfer.direction === "outgoing"
      && activeTransfer.requestMessageId === null
      && activeTransfer.remotePublicKeyHex === publisher
      && activeTransfer.contentHash === (knownHashRequests.get(`${publisher}\u0000${message.messageId}`)?.hash ?? "")) {
      activeTransfer.requestMessageId = message.messageId;
      activeTransfer.hashRequestPublished = true;
      await beginOutgoingTransferOffer(activeTransfer);
    }
  }

  /** `ended` 过渡态：UI 在 ttl 内可见，过了之后清空回 idle。 */
  let endedDeadlineAt: number | null = null;

  let remoteNotice: WebrtcRemoteNotice | null = null;
  let lastError: WebrtcBlockReason | null = null;
  const subscribers = new Set<WebrtcSubscriber>();
  const owner = () => keyspace.active().activePublicKeyHex?.trim().toLowerCase() ?? null;
  let observedOwnerPublicKeyHex = owner();

  function currentOwnerPublicKeyHex(): string | null {
    return owner();
  }

  function isOwnerFenceCurrent(ownerPublicKeyHex: string | null, generation: number): boolean {
    return !disposed
      && ownerGeneration === generation
      && currentOwnerPublicKeyHex() === ownerPublicKeyHex;
  }

  function isTransferCurrent(session: ActiveTransfer): boolean {
    return activeTransfer === session
      && !session.settled
      && isOwnerFenceCurrent(session.ownerPublicKeyHex, session.ownerGeneration);
  }

  function transferFenceError(session: ActiveTransfer): Error {
    if (disposed) return new Error("service_disposed");
    if (!isOwnerFenceCurrent(session.ownerPublicKeyHex, session.ownerGeneration)) {
      return new Error("transfer_owner_changed");
    }
    return new Error("transfer_stale");
  }

  async function recordCallEnd(session: ActiveSession, status: "completed" | "missed" | "rejected" | "failed"): Promise<void> {
    const ownerPublicKeyHex = session.ownerPublicKeyHex;
    if (!ownerPublicKeyHex) return;
    await historyService.appendCall({
      recordId: `km-wrtc-call-${session.sessionId}-${status}`,
      ownerPublicKeyHex,
      peerPublicKeyHex: session.remotePublicKeyHex,
      kind: session.mode === "audio" ? "audio_call" : "video_call",
      direction: session.direction,
      status,
      startedAtMs: session.startedAtMs,
      endedAtMs: env.now(),
      durationSec: Math.max(0, Math.floor((env.now() - session.startedAtMs) / 1000))
    });
  }

  async function recordTransferEnd(input: {
    session: ActiveTransfer;
    status: "completed" | "failed";
    blob?: Blob;
  }): Promise<void> {
    const ownerPublicKeyHex = input.session.ownerPublicKeyHex;
    if (!ownerPublicKeyHex) return;
    const recordId = `km-wrtc-transfer-${input.session.sessionId}-${input.status}`;
    const blobKey = input.blob ? `${recordId}.blob` : undefined;
    await historyService.appendTransfer(
      {
        recordId,
        ownerPublicKeyHex,
        peerPublicKeyHex: input.session.remotePublicKeyHex,
        kind: input.session.kind,
        direction: input.session.direction,
        status: input.status,
        startedAtMs: input.session.startedAtMs,
        endedAtMs: env.now(),
        durationSec: Math.max(0, Math.floor((env.now() - input.session.startedAtMs) / 1000)),
        fileName: input.session.fileName,
        mimeType: input.session.mimeType,
        byteLength: input.session.byteLength,
        blobKey
      },
      input.blob
    );
  }

  function resolveCallEndStatus(input: {
    session: ActiveSession;
    origin: "local" | "remote";
    reason?: WebrtcHangupReason;
  }): "completed" | "missed" | "rejected" | "failed" {
    const { session, origin, reason } = input;
    const established = session.negotiated || session.pcConnected;
    if (origin === "remote") {
      if (!established) {
        return session.direction === "incoming" ? "missed" : "failed";
      }
      return "completed";
    }
    if (reason === "ice_disconnected") {
      return "failed";
    }
    if (established) {
      return "completed";
    }
    return session.direction === "incoming" ? "rejected" : "failed";
  }

  function dismissAllNotices(): void {
    noticeRegistry.removeBySourcePluginId("webrtc");
  }

  function upsertIncomingNotice(session: ActiveSession): void {
    noticeRegistry.upsert({
      id: `webrtc-incoming-${session.sessionId}`,
      sourcePluginId: "webrtc",
      priority: 100,
      title: {
        key: "webrtc.notice.incoming.title",
        fallback: session.mode === "video" ? "Video call incoming" : "Audio call incoming"
      },
      body: {
        key: "webrtc.notice.incoming.body",
        fallback: session.remotePublicKeyHex
      },
      createdAtMs: env.now(),
      routeTo: `/message/${encodeURIComponent(session.remotePublicKeyHex)}`,
      dismissible: false,
      actions: [
        {
          id: "accept",
          label: { key: "webrtc.notice.accept", fallback: "Accept" },
          variant: "primary",
          run: async () => {
            await acceptIncoming();
          },
          navigateTo: `/message/${encodeURIComponent(session.remotePublicKeyHex)}`,
          autoDismiss: true
        },
        {
          id: "reject",
          label: { key: "webrtc.notice.reject", fallback: "Decline" },
          variant: "secondary",
          run: async () => {
            await rejectIncoming();
          },
          autoDismiss: true
        }
      ]
    });
  }

  function upsertIncomingTransferNotice(sessionId: string, request: PendingTransferRequest): void {
    const fileDescription = request.fileName
      ? `${request.fileName} (${request.byteLength} bytes)`
      : `${request.byteLength} bytes`;
    noticeRegistry.upsert({
      id: `webrtc-transfer-${sessionId}`,
      sourcePluginId: "webrtc",
      priority: 90,
      title: {
        key: "webrtc.notice.transfer.title",
        fallback: "Incoming file transfer"
      },
      body: {
        key: "webrtc.notice.transfer.body",
        fallback: `${request.requesterPublicKeyHex}: ${request.kind} ${fileDescription}`
      },
      createdAtMs: env.now(),
      routeTo: `/message/${encodeURIComponent(request.requesterPublicKeyHex)}`,
      dismissible: false,
      actions: [
        {
          id: "accept-transfer",
          label: { key: "webrtc.notice.transfer.accept", fallback: "Accept transfer" },
          variant: "primary",
          run: async () => {
            // 通知可能在 owner 切换后才执行；捕获请求对象，不能只用远端可复用的 sessionId。
            await acceptIncomingTransferForRequest(sessionId, request);
          },
        },
        {
          id: "reject-transfer",
          label: { key: "webrtc.notice.transfer.reject", fallback: "Reject transfer" },
          variant: "secondary",
          run: async () => {
            // 旧通知的拒绝动作也只能删除它创建的那一个请求。
            await rejectIncomingTransferForRequest(sessionId, request);
          },
        }
      ]
    });
  }

  function snapshot(): WebrtcSessionSnapshot {
    let phase: WebrtcSessionPhase = "idle";
    if (active) {
      if (!active.negotiated) {
        phase = active.direction === "outgoing" ? "inviting" : "incoming";
      } else if (active.pcConnected && active.remoteStream) {
        phase = "connected";
      } else {
        phase = "connecting";
      }
    } else if (endedDeadlineAt !== null) {
      phase = "ended";
    }
    return {
      phase,
      remotePublicKeyHex: active?.remotePublicKeyHex ?? null,
      direction: active?.direction ?? null,
      mode: active?.mode ?? null,
      hasLocalStream: !!active?.localStream,
      hasRemoteStream: !!active?.remoteStream,
      remoteNotice,
      serviceReady: channel.isReady(),
      lastError
    };
  }

  function emit(): void {
    const snap = snapshot();
    for (const handler of subscribers) {
      try {
        handler(snap);
      } catch {
        // 防御：handler 异常不影响 service 真值。
      }
    }
  }

  /**
   * 统一清场入口。所有本地释放（关闭 pc、停 tracks、清 active）都走这里，
   * 失败回滚也走这里。统一 emit 以保证 UI 永远能看到终态。
   */
  function clearActive(opts: { showEndedPhase?: boolean } = {}): void {
    const session = active;
    active = null;
    dismissAllNotices();
    if (session) {
      try {
        session.localStream?.stop();
      } catch {
        // ignore
      }
      try {
        session.pc?.close();
      } catch {
        // ignore
      }
    }
    if (opts.showEndedPhase) {
      endedDeadlineAt = env.now() + ENDED_PHASE_TTL_MS;
      env
        .delay(ENDED_PHASE_TTL_MS)
        .then(() => {
          if (endedDeadlineAt !== null && env.now() >= endedDeadlineAt) {
            endedDeadlineAt = null;
            emit();
          }
        })
        .catch(() => undefined);
    }
    emit();
  }

  /**
   * 主动挂断只改变本地会话和 RTCPeerConnection 状态。
   * ChannelProtocol WebRTC V1 没有 hangup 分支，不能发送私造控制消息。
   */
  async function doHangup(reason: WebrtcHangupReason): Promise<void> {
    const session = active;
    if (!session) {
      // 没有活动会话时，如果 UI 点了 hangup → 至少不要让 UI 卡住；走清场。
      endedDeadlineAt = env.now() + ENDED_PHASE_TTL_MS;
      env
        .delay(ENDED_PHASE_TTL_MS)
        .then(() => {
          if (endedDeadlineAt !== null && env.now() >= endedDeadlineAt) {
            endedDeadlineAt = null;
            emit();
          }
        })
        .catch(() => undefined);
      emit();
      return;
    }
    await recordCallEnd(session, resolveCallEndStatus({ session, origin: "local", reason }));
    // 先同步清场 + emit；V1 没有 hangup wire 分支，远端依靠 RTC 状态/超时收敛。
    clearActive({ showEndedPhase: true });
    void reason;
  }

  /* ----- 入站信令处理 ----- */

  async function handleIncomingTransferRequest(
    transferRequest: ReturnType<typeof parseTransferRequest> & object,
    remotePublicKeyHex: string
  ): Promise<void> {
    if (disposed) return;
    const currentOwner = currentOwnerPublicKeyHex();
    if (!currentOwner || currentOwner === remotePublicKeyHex) return;
    const capturedOwnerGeneration = ownerGeneration;
    prunePendingTransferRequests();
    if (active || activeTransfer || pendingTransferRequests.has(transferRequest.sessionId)) return;
    if (pendingTransferCountForSender(remotePublicKeyHex) >= MAX_PENDING_TRANSFER_REQUESTS_PER_SENDER) return;
    if (!consumeTransferRequestRate(remotePublicKeyHex)) return;
    const checkKey = `${remotePublicKeyHex}\u0000${transferRequest.sessionId}`;
    if (transferRequestChecks.has(checkKey)) return;
    if (!reserveTransferAdmission(remotePublicKeyHex)) return;
    transferRequestChecks.set(checkKey, capturedOwnerGeneration);
    try {
      // 联系人准入在用户确认之前执行；即使准入通过，也只建立本地
      // 有界通知，不调用 publishHashRequest、不签名、不创建 PeerConnection。
      if (!isOwnerFenceCurrent(currentOwner, capturedOwnerGeneration)) return;
      if (!await checkTransferSenderAllowed(remotePublicKeyHex)) return;
      if (!isOwnerFenceCurrent(currentOwner, capturedOwnerGeneration)) return;
      const ownerAfterCheck = currentOwnerPublicKeyHex();
      if (!ownerAfterCheck || ownerAfterCheck !== currentOwner
        || ownerGeneration !== capturedOwnerGeneration || disposed) return;
      prunePendingTransferRequests();
      if (active || activeTransfer || pendingTransferRequests.size >= MAX_PENDING_TRANSFER_REQUESTS) return;
      if (pendingTransferCountForSender(remotePublicKeyHex) >= MAX_PENDING_TRANSFER_REQUESTS_PER_SENDER) return;
      const request: PendingTransferRequest = {
        requesterPublicKeyHex: remotePublicKeyHex,
        ownerPublicKeyHex: ownerAfterCheck,
        ownerGeneration: capturedOwnerGeneration,
        hash: transferRequest.hash,
        kind: transferRequest.kind,
        byteLength: transferRequest.byteLength,
        fileName: transferRequest.fileName,
        mimeType: transferRequest.mimeType,
        accepted: false,
        expiresAtMs: env.now() + TRANSFER_REQUEST_TTL_MS
      };
      pendingTransferRequests.set(transferRequest.sessionId, request);
      schedulePendingTransferPrune();
      upsertIncomingTransferNotice(transferRequest.sessionId, request);
    } finally {
      if (transferRequestChecks.get(checkKey) === capturedOwnerGeneration) {
        transferRequestChecks.delete(checkKey);
      }
      releaseTransferAdmission(remotePublicKeyHex);
    }
  }

  function handleIncoming(msg: ChannelPrivateMessageEvent): void {
    if (disposed) return;
    const remote = msg.publisherPublicKeyHex.trim().toLowerCase();
    if (msg.protocol === APP_MESSAGE_PROTOCOL) {
      // 旧版呼叫请求没有对应的正式 ChannelProtocol 会合协议；不能把它
      // 转换成 Hash 请求或来电状态，也不能因此触发设备权限申请。
      if (isObject(msg.content) && msg.content.type === "keymaster.webrtc.call.request") return;
      const transferRequest = parseTransferRequest(msg.content);
      if (transferRequest) {
        void handleIncomingTransferRequest(transferRequest, remote).catch((error) => {
          log.warn("webrtc.service", "incoming_transfer_request_failed", error);
        });
        return;
      }
      return;
    }
    if (msg.protocol !== WEBRTC_SIGNAL_PROTOCOL) return;
    const sig = tryParseSignal(msg.content);
    if (!sig) return;
    if (sig.signal.type === "offer") {
      if (activeTransfer) return;
      if (isDataChannelOffer(sig.signal.sdp)) {
        void onRemoteTransferOffer(sig as WebrtcInviteSignal, remote).catch((err) => {
          log.warn("webrtc.service", "on_remote_transfer_offer_failed", err);
        });
      } else {
        // 音视频呼叫协议未正式注册；尤其不能接受没有前置呼叫请求的
        // 直接 offer。文件传输仍走独立的 data-channel + 文件 Hash 关系。
        return;
      }
      return;
    }

    const transferLocal = activeTransfer?.requestMessageId
      ? { requestMessageId: activeTransfer.requestMessageId, sessionId: activeTransfer.sessionId }
      : null;
    if (transferLocal
      && activeTransfer
      && remote === activeTransfer.remotePublicKeyHex
      && isAcceptableRemoteSession(sig, transferLocal)) {
      if (sig.signal.type === "answer") {
        void onRemoteTransferAnswer(sig as WebrtcAnswerSignal).catch((err) => {
          log.warn("webrtc.service", "on_remote_transfer_answer_failed", err);
        });
        return;
      }
      if (sig.signal.type === "ice-candidate") {
        void onRemoteTransferIce(sig as WebrtcIceSignal).catch((err) => {
          log.warn("webrtc.service", "on_remote_transfer_ice_failed", err);
        });
        return;
      }
      if (sig.signal.type === "end-of-candidates") {
        void onRemoteTransferEndOfCandidates(sig as WebrtcEndOfCandidatesSignal).catch(() => undefined);
      }
    }
  }

  async function acceptIncoming(): Promise<void> {
    // ChannelProtocol 目前只有文件 Hash 请求的会合关系；没有正式的
    // 呼叫请求子协议，因此用户接受动作也必须 fail-closed，不能申请设备。
    lastError = "call_protocol_unavailable";
    emit();
    throw new Error("call_protocol_unavailable");
  }

  async function rejectIncoming(): Promise<void> {
    if (!active || active.direction !== "incoming") return;
    const session = active;
    await recordCallEnd(session, "rejected");
    // ChannelProtocol WebRTC V1 没有 reject 分支；拒接只在本地清理会话。
    clearActive();
  }

  async function acceptIncomingTransferForRequest(
    sessionId: string,
    expectedRequest?: PendingTransferRequest
  ): Promise<void> {
    if (disposed) throw new Error("service_disposed");
    prunePendingTransferRequests();
    const request = pendingTransferRequests.get(sessionId);
    if (expectedRequest !== undefined && request !== expectedRequest) {
      // 这是旧 owner / 旧通知的晚到操作；不能观察或修改同 sessionId 的新请求。
      return;
    }
    if (!request || request.expiresAtMs <= env.now()) {
      if (request) removePendingTransferRequestIfCurrent(sessionId, request);
      else removePendingTransferRequest(sessionId);
      throw new Error("transfer_request_expired");
    }
    const currentOwner = currentOwnerPublicKeyHex();
    if (!currentOwner
      || currentOwner !== request.ownerPublicKeyHex
      || request.ownerGeneration !== ownerGeneration) {
      removePendingTransferRequestIfCurrent(sessionId, request);
      throw new Error("transfer_owner_changed");
    }
    if (active || activeTransfer) throw new Error("busy_local");
    if (request.accepted) return;
    if (transferAcceptanceInFlight !== null) throw new Error("busy_local");

    const acceptanceToken: TransferAcceptanceToken = {
      sessionId,
      ownerGeneration,
      request
    };
    transferAcceptanceInFlight = acceptanceToken;
    request.accepted = true;
    dismissTransferNotice(sessionId);
    try {
      // 只有这一条显式用户确认路径可以触发 owner 签名和公开 Hash Publish。
      const hashRequestMessageId = await publishHashRequest(request.hash);
      const current = pendingTransferRequests.get(sessionId);
      if (!current
        || current !== request
        || current.expiresAtMs <= env.now()
        || current.ownerPublicKeyHex !== currentOwnerPublicKeyHex()
        || current.ownerGeneration !== ownerGeneration
        || disposed) {
        removePendingTransferRequestIfCurrent(sessionId, request);
        throw new Error("transfer_owner_changed");
      }
      current.hashRequestMessageId = hashRequestMessageId;
      const pendingOffer = current.pendingOffer;
      current.pendingOffer = undefined;
      if (pendingOffer) {
        await onRemoteTransferOffer(pendingOffer, current.requesterPublicKeyHex);
      }
    } catch (error) {
      removePendingTransferRequestIfCurrent(sessionId, request);
      log.warn("webrtc.service", "transfer_hash_request_failed", error);
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      if (transferAcceptanceInFlight === acceptanceToken) transferAcceptanceInFlight = null;
    }
  }

  async function acceptIncomingTransfer(sessionId: string): Promise<void> {
    const expectedRequest = pendingTransferRequests.get(sessionId);
    await acceptIncomingTransferForRequest(sessionId, expectedRequest);
  }

  async function rejectIncomingTransferForRequest(
    sessionId: string,
    expectedRequest?: PendingTransferRequest
  ): Promise<void> {
    // 拒绝不发送自定义 reject wire；删除本地待确认状态即可，避免引入
    // ChannelProtocol 未定义的业务信令分支。
    if (expectedRequest !== undefined) {
      removePendingTransferRequestIfCurrent(sessionId, expectedRequest);
      return;
    }
    removePendingTransferRequest(sessionId);
  }

  async function rejectIncomingTransfer(sessionId: string): Promise<void> {
    await rejectIncomingTransferForRequest(sessionId, pendingTransferRequests.get(sessionId));
  }

  function isTransferActive(): boolean {
    return activeTransfer !== null;
  }

  function closeTransferResources(session: ActiveTransfer): void {
    if (session.idleTimer !== undefined) {
      clearTimeout(session.idleTimer);
      session.idleTimer = undefined;
    }
    try {
      session.channel?.close();
    } catch {
      // ignore
    }
    try {
      session.pc?.close();
    } catch {
      // ignore
    }
    session.channel = null;
    session.pc = null;
    session.pendingChunks = [];
    session.pendingMeta = null;
    session.receivedBytes = 0;
    session.awaitingCompletion = false;
    session.payloadSending = false;
    session.blob = undefined;
  }

  function touchTransferActivity(session: ActiveTransfer): void {
    if (session.settled || activeTransfer?.sessionId !== session.sessionId) return;
    if (session.idleTimer !== undefined) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      if (session.settled || activeTransfer?.sessionId !== session.sessionId) return;
      finalizeTransferWithFailure(session, new Error("transfer_idle_timeout"));
    }, TRANSFER_IDLE_TIMEOUT_MS);
  }

  async function waitForTransferBuffer(session: ActiveTransfer, payloadLength: number): Promise<void> {
    const channel = session.channel;
    if (!channel || typeof channel.bufferedAmount !== "number" || !Number.isFinite(channel.bufferedAmount)) return;
    if (channel.bufferedAmount + payloadLength <= TRANSFER_BUFFER_HIGH_WATER_MARK) return;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let pollTimer: ReturnType<typeof setTimeout> | undefined;
      let timeout: ReturnType<typeof setTimeout>;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (pollTimer !== undefined) clearTimeout(pollTimer);
        if (error) reject(error); else resolve();
      };
      timeout = setTimeout(() => finish(new Error("transfer_backpressure_timeout")), TRANSFER_BUFFER_WAIT_TIMEOUT_MS);
      const check = (): void => {
        if (!isTransferCurrent(session) || session.channel !== channel) {
          finish(transferFenceError(session));
          return;
        }
        const bufferedAmount = channel.bufferedAmount;
        if (typeof bufferedAmount !== "number" || !Number.isFinite(bufferedAmount)
          || bufferedAmount + payloadLength <= TRANSFER_BUFFER_LOW_WATER_MARK) {
          finish();
          return;
        }
        pollTimer = setTimeout(check, 25);
      };
      check();
    });
  }

  async function sendTransferPayload(session: ActiveTransfer, payload: string): Promise<void> {
    const channel = session.channel;
    if (!channel || channel.readyState !== "open") throw new Error("transfer_invalid_state");
    await waitForTransferBuffer(session, payload.length);
    if (!isTransferCurrent(session) || session.channel !== channel || channel.readyState !== "open") {
      throw transferFenceError(session);
    }
    channel.send(payload);
    touchTransferActivity(session);
  }

  function finalizeTransferWithFailure(session: ActiveTransfer, err: Error): void {
    if (session.settled) return;
    session.settled = true;
    if (activeTransfer?.sessionId === session.sessionId) {
      activeTransfer = null;
    }
    closeTransferResources(session);
    void recordTransferEnd({ session, status: "failed" }).catch(() => undefined);
    session.reject?.(err);
    emit();
  }

  function finalizeTransferWithSuccess(session: ActiveTransfer, blob?: Blob): void {
    if (session.settled) return;
    session.settled = true;
    if (activeTransfer?.sessionId === session.sessionId) {
      activeTransfer = null;
    }
    const completedBlob = blob ?? session.blob;
    void recordTransferEnd({
      session,
      status: "completed",
      blob: completedBlob
    }).catch(() => undefined);
    closeTransferResources(session);
    session.resolve?.();
    emit();
  }

  function decodeTransferBytes(data: string): Uint8Array {
    return base64ToBytes(data);
  }

  function encodeTransferBytes(bytes: Uint8Array): string {
    return bytesToBase64(bytes);
  }

  async function handleTransferWireMessage(session: ActiveTransfer, data: string | ArrayBuffer | ArrayBufferView): Promise<void> {
    if (session.settled || activeTransfer?.sessionId !== session.sessionId) return;
    if (typeof data !== "string") throw new Error("transfer_invalid_message");
    const msg = parseTransferWireMessage(data);
    if (!msg || msg.sessionId !== session.sessionId) throw new Error("transfer_invalid_message");
    touchTransferActivity(session);

    if (msg.type === "transfer_begin") {
      if (session.direction !== "incoming"
        || session.pendingMeta !== null
        || msg.kind !== session.kind
        || msg.byteLength !== session.byteLength) {
        throw new Error("transfer_invalid_begin");
      }
      session.pendingMeta = {
        kind: session.kind,
        fileName: session.fileName,
        mimeType: session.mimeType,
        byteLength: session.byteLength
      };
      session.pendingChunks = [];
      session.expectedSeq = 0;
      session.receivedBytes = 0;
      return;
    }

    if (msg.type === "transfer_chunk") {
      if (session.direction !== "incoming" || session.pendingMeta === null) {
        throw new Error("transfer_invalid_chunk");
      }
      if (msg.seq !== session.expectedSeq) throw new Error("transfer_invalid_sequence");
      if (session.expectedSeq >= MAX_WEBRTC_TRANSFER_CHUNKS) throw new Error("transfer_too_many_chunks");
      let chunk: Uint8Array;
      try {
        chunk = decodeTransferBytes(msg.data);
      } catch {
        throw new Error("transfer_invalid_chunk");
      }
      if (chunk.byteLength === 0 || chunk.byteLength > WEBRTC_TRANSFER_CHUNK_BYTES) {
        throw new Error("transfer_chunk_too_large");
      }
      if (session.receivedBytes + chunk.byteLength > session.byteLength
        || session.receivedBytes + chunk.byteLength > MAX_WEBRTC_TRANSFER_BYTES) {
        throw new Error("transfer_size_mismatch");
      }
      session.pendingChunks.push(chunk);
      session.receivedBytes += chunk.byteLength;
      session.expectedSeq += 1;
      return;
    }

    if (msg.type === "transfer_end") {
      if (session.direction !== "incoming" || !session.pendingMeta) {
        throw new Error("transfer_invalid_end");
      }
      if (session.receivedBytes !== session.byteLength) {
        throw new Error("transfer_size_mismatch");
      }
      const blobParts = session.pendingChunks.map((chunk) =>
        chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer
      );
      const blob = new Blob(blobParts, { type: session.mimeType || "application/octet-stream" });
      if (blob.size !== session.byteLength) throw new Error("transfer_size_mismatch");
      // 先释放分片数组，再进行 Web Crypto Hash，避免同时长期保留两份完整内容。
      session.pendingChunks = [];
      const receivedHash = await calculateSha256(new Uint8Array(await blob.arrayBuffer()));
      if (receivedHash !== session.contentHash) throw new Error("transfer_hash_mismatch");
      await sendTransferPayload(session, serializeTransferWireMessage({
        type: "transfer_complete",
        sessionId: session.sessionId,
        hash: receivedHash,
        byteLength: session.byteLength
      }));
      session.blob = blob;
      finalizeTransferWithSuccess(session, blob);
      return;
    }

    if (msg.type === "transfer_complete") {
      if (session.direction !== "outgoing" || !session.awaitingCompletion) {
        throw new Error("transfer_unexpected_complete");
      }
      if (msg.byteLength !== session.byteLength || msg.hash !== session.contentHash) {
        throw new Error("transfer_hash_mismatch");
      }
      session.awaitingCompletion = false;
      finalizeTransferWithSuccess(session, session.blob);
      return;
    }

    if (msg.type === "transfer_cancel") {
      throw new Error(`transfer_cancel: ${msg.reason}`);
    }
  }

  function attachTransferDataChannel(session: ActiveTransfer, channel: DataChannelLike): void {
    if (session.settled || activeTransfer?.sessionId !== session.sessionId) return;
    if (session.channel && session.channel !== channel) {
      try { channel.close(); } catch { /* ignore */ }
      finalizeTransferWithFailure(session, new Error("transfer_multiple_channels"));
      return;
    }
    session.channel = channel;
    touchTransferActivity(session);
    const startOutgoing = (): void => {
      if (session.settled || activeTransfer?.sessionId !== session.sessionId || session.direction !== "outgoing") return;
      if (session.payloadSending) return;
      void sendOutgoingTransferPayload(session).catch((err) => {
        finalizeTransferWithFailure(session, err instanceof Error ? err : new Error(String(err)));
      });
    };
    channel.onOpen(() => {
      touchTransferActivity(session);
      startOutgoing();
    });
    channel.onMessage((data) => {
      void handleTransferWireMessage(session, data).catch((err) => {
        finalizeTransferWithFailure(session, err instanceof Error ? err : new Error(String(err)));
      });
    });
    channel.onClose(() => {
      if (session.settled) return;
      finalizeTransferWithFailure(session, new Error("transfer_channel_closed"));
    });
    channel.onError((err) => {
      if (session.settled) return;
      finalizeTransferWithFailure(session, err instanceof Error ? err : new Error(String(err)));
    });
    if (channel.readyState === "open") startOutgoing();
  }

  async function sendOutgoingTransferPayload(session: ActiveTransfer): Promise<void> {
    if (!session.channel || session.direction !== "outgoing") {
      throw new Error("transfer_invalid_state");
    }
    const blob = session.blob;
    if (!blob) {
      throw new Error("transfer_invalid_state");
    }
    if (session.payloadSending) return;
    if (session.channel.readyState !== "open") throw new Error("transfer_invalid_state");
    session.payloadSending = true;
    touchTransferActivity(session);
    try {
      const begin = serializeTransferWireMessage({
        type: "transfer_begin",
        sessionId: session.sessionId,
        kind: session.kind,
        fileName: session.fileName,
        mimeType: session.mimeType,
        byteLength: session.byteLength
      });
      await sendTransferPayload(session, begin);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (session.settled || activeTransfer?.sessionId !== session.sessionId || !session.channel) return;
      if (bytes.byteLength !== session.byteLength || bytes.byteLength > MAX_WEBRTC_TRANSFER_BYTES) {
        throw new Error("transfer_size_mismatch");
      }
      for (let offset = 0, seq = 0; offset < bytes.length; offset += WEBRTC_TRANSFER_CHUNK_BYTES, seq += 1) {
        if (session.settled || activeTransfer?.sessionId !== session.sessionId) return;
        const chunk = bytes.slice(offset, offset + WEBRTC_TRANSFER_CHUNK_BYTES);
        const payload = serializeTransferWireMessage({
          type: "transfer_chunk",
          sessionId: session.sessionId,
          seq,
          data: encodeTransferBytes(chunk)
        });
        await sendTransferPayload(session, payload);
      }
      // 必须先建立等待状态，再发送 end，防止测试 fake 同步回传 complete 时产生竞态。
      session.awaitingCompletion = true;
      await sendTransferPayload(session,
        serializeTransferWireMessage({
          type: "transfer_end",
          sessionId: session.sessionId
        })
      );
    } finally {
      session.payloadSending = false;
    }
  }

  async function beginOutgoingTransferOffer(session: ActiveTransfer): Promise<void> {
    if (!isTransferCurrent(session) || session.direction !== "outgoing" || !session.requestMessageId || session.pc) return;
    const requestMessageId = session.requestMessageId;
    const pc = env.createPeerConnection(configToRTCConfig(store.snapshot()));
    session.pc = pc;
    pc.onIceCandidate((c) => {
      const currentRequest = session.requestMessageId;
      if (currentRequest) void sendIce(currentRequest, session.sessionId, session.remotePublicKeyHex, c).catch(() => undefined);
    });
    pc.onIceGatheringStateChange((state) => {
      if (state === "complete" && session.requestMessageId) {
        void sendEndOfCandidates(session.requestMessageId, session.sessionId, session.remotePublicKeyHex).catch(() => undefined);
      }
    });
    pc.onConnectionStateChange((s) => {
      if (activeTransfer?.sessionId !== session.sessionId || session.settled) return;
      if (s === "failed" || s === "disconnected" || s === "closed") {
        finalizeTransferWithFailure(session, new Error("transfer_connection_failed"));
      }
    });
    pc.onDataChannel((dataChannel) => {
      if (activeTransfer?.sessionId !== session.sessionId || session.settled) return;
      attachTransferDataChannel(session, dataChannel);
    });
    const dataChannel = pc.createDataChannel("transfer");
    attachTransferDataChannel(session, dataChannel);
    let offer: RTCSessionDescriptionInit;
    try {
      offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
    } catch (err) {
      finalizeTransferWithFailure(session, err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (!isTransferCurrent(session) || session.requestMessageId !== requestMessageId) {
      if (!session.settled) finalizeTransferWithFailure(session, transferFenceError(session));
      return;
    }
    session.pendingOffer = offer;
    try {
      await publishSignalBody(
        session.remotePublicKeyHex,
        newOfferSignal(requestMessageId, session.sessionId, encodeDescription(offer))
      );
    } catch (err) {
      finalizeTransferWithFailure(session, err instanceof Error ? err : new Error(String(err)));
    }
  }

  async function startOutgoingTransfer(input: {
    targetPublicKeyHex: string;
    kind: "image" | "file";
    file: Blob | File;
  }): Promise<void> {
    if (disposed) throw new Error("service_disposed");
    if (!channel.isReady()) {
      lastError = "service_not_ready";
      throw new Error("service_not_ready");
    }
    if (active || isTransferActive()) {
      throw new Error("busy_local");
    }
    const ownerPublicKeyHex = currentOwnerPublicKeyHex();
    if (!ownerPublicKeyHex) throw new Error("owner_unavailable");
    const capturedOwnerGeneration = ownerGeneration;
    const sessionId = createProtocolSessionId(env);
    const session: ActiveTransfer = {
      requestMessageId: null,
      sessionId,
      direction: "outgoing",
      remotePublicKeyHex: input.targetPublicKeyHex,
      ownerPublicKeyHex,
      ownerGeneration: capturedOwnerGeneration,
      startedAtMs: env.now(),
      kind: input.kind,
      fileName: "name" in input.file ? input.file.name : undefined,
      mimeType: input.file.type || undefined,
      byteLength: input.file.size,
      // Hash 尚未完成；session 已先占槽，计算完成后在 owner fence 通过时写入。
      contentHash: "",
      pc: null,
      channel: null,
      pendingOffer: null,
      hashRequestPublished: false,
      pendingChunks: [],
      pendingMeta: null,
      expectedSeq: 0,
      receivedBytes: 0,
      awaitingCompletion: false,
      payloadSending: false,
      blob: input.file,
      settled: false
    };
    activeTransfer = session;
    const done = new Promise<void>((resolve, reject) => {
      session.resolve = resolve;
      session.reject = reject;
    });
    // Hash / publish 可能在 done 参与 Promise.race 前就失败；预先挂一个
    // rejection handler，避免 dispose / owner 切换造成未处理拒绝。
    void done.catch(() => undefined);
    try {
      // activeTransfer 已在第一次 await 前写入；此后任何并发 sendFile 都会看到 busy。
      const bytes = new Uint8Array(await input.file.arrayBuffer());
      if (!isTransferCurrent(session)) throw transferFenceError(session);
      const contentHash = await calculateSha256(bytes);
      if (!isTransferCurrent(session)) throw transferFenceError(session);
      session.contentHash = contentHash;
      // 先请目标 owner 发布 Hash 请求；随后 offer 才能引用真实的
      // request_message_id，并通过 Coordinator 的关系审查。
      await channel.publishPrivate({
        recipientPublicKeyHex: input.targetPublicKeyHex,
        protocol: APP_MESSAGE_PROTOCOL,
        content: {
          type: TRANSFER_REQUEST_TYPE,
          session_id: sessionId,
          hash: contentHash,
          kind: input.kind,
          byte_length: input.file.size,
          ...(session.fileName ? { file_name: session.fileName } : {}),
          ...(session.mimeType ? { mime_type: session.mimeType } : {})
        }
      });
      if (!isTransferCurrent(session)) throw transferFenceError(session);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      finalizeTransferWithFailure(session, error);
      if (error.message === "service_disposed" || error.message === "transfer_owner_changed") {
        throw error;
      }
      throw new Error("transfer_request_failed");
    }
    const timeout = env.delay(15_000).then(() => {
      if (session.settled) return;
      finalizeTransferWithFailure(session, new Error("transfer_timeout"));
      throw new Error("transfer_timeout");
    });
    await Promise.race([done, timeout]);
  }

  async function onRemoteTransferOffer(sig: WebrtcInviteSignal, remote: string): Promise<void> {
    if (disposed) return;
    if (active || isTransferActive()) return;
    prunePendingTransferRequests();
    const request = pendingTransferRequests.get(sig.session_id);
    const currentOwner = currentOwnerPublicKeyHex();
    if (request && (request.ownerPublicKeyHex !== currentOwner || request.ownerGeneration !== ownerGeneration)) {
      removePendingTransferRequest(sig.session_id);
      return;
    }
    if (!request || request.requesterPublicKeyHex !== remote || !request.accepted) {
      // 在用户确认前可以暂存至一个已经有界的请求记录，但绝不建立
      // PeerConnection；未匹配真实 Hash message_id 的 offer 后续仍会被丢弃。
      if (request && !request.accepted && !request.pendingOffer) request.pendingOffer = sig;
      return;
    }
    if (request.hashRequestMessageId === undefined) {
      // Coordinator 已经完成 Hash/offer 关系审查，但本地发布 Hash 的
      // Promise 可能尚未返回真实 message_id。不能丢 offer，也不能用
      // offer 自带的 request_message_id 冒充本地 Hash 结果。
      if (!request.pendingOffer) request.pendingOffer = sig;
      return;
    }
    if (request.hashRequestMessageId !== sig.request_message_id) return;
    removePendingTransferRequest(sig.session_id);
    const parsedOffer = decodeDescription(sig.signal.sdp, "offer");
    const pc = env.createPeerConnection(configToRTCConfig(store.snapshot()));
    const session: ActiveTransfer = {
      requestMessageId: sig.request_message_id,
      sessionId: sig.session_id,
      direction: "incoming",
      remotePublicKeyHex: remote,
      ownerPublicKeyHex: currentOwner,
      ownerGeneration: request.ownerGeneration,
      startedAtMs: env.now(),
      // 这些字段来自用户确认前展示并校验过的 APP 请求；DataChannel
      // 的 transfer_begin 只能与它们一致，不能重新定义传输边界。
      kind: request.kind,
      fileName: request.fileName,
      mimeType: request.mimeType,
      byteLength: request.byteLength,
      contentHash: request.hash,
      pc,
      channel: null,
      pendingOffer: parsedOffer,
      hashRequestPublished: true,
      pendingChunks: [],
      pendingMeta: null,
      expectedSeq: 0,
      receivedBytes: 0,
      awaitingCompletion: false,
      payloadSending: false,
      settled: false
    };
    activeTransfer = session;
    touchTransferActivity(session);
    const requestMessageId = sig.request_message_id;
    pc.onIceCandidate((c) => {
      void sendIce(requestMessageId, session.sessionId, session.remotePublicKeyHex, c).catch(() => undefined);
    });
    pc.onIceGatheringStateChange((state) => {
      if (state === "complete") {
        void sendEndOfCandidates(requestMessageId, session.sessionId, session.remotePublicKeyHex).catch(() => undefined);
      }
    });
    pc.onConnectionStateChange((s) => {
      if (activeTransfer?.sessionId !== session.sessionId || session.settled) return;
      if (s === "failed" || s === "disconnected" || s === "closed") {
        finalizeTransferWithFailure(session, new Error("transfer_connection_failed"));
      }
    });
    pc.onDataChannel((channel) => {
      if (activeTransfer?.sessionId !== session.sessionId || session.settled) return;
      attachTransferDataChannel(session, channel);
    });
    try {
      await pc.setRemoteDescription(parsedOffer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (!isTransferCurrent(session)) {
        finalizeTransferWithFailure(session, transferFenceError(session));
        return;
      }
      await publishSignalBody(
        remote,
        newAnswerSignal(requestMessageId, session.sessionId, encodeDescription(answer))
      );
    } catch (err) {
      finalizeTransferWithFailure(session, err instanceof Error ? err : new Error(String(err)));
      return;
    }
  }

  async function onRemoteTransferAnswer(sig: WebrtcAnswerSignal): Promise<void> {
    if (!activeTransfer
      || !isTransferCurrent(activeTransfer)
      || activeTransfer.direction !== "outgoing"
      || activeTransfer.requestMessageId !== sig.request_message_id
      || activeTransfer.sessionId !== sig.session_id) return;
    if (!activeTransfer.pc) return;
    const parsed = decodeDescription(sig.signal.sdp, "answer");
    try {
      await activeTransfer.pc.setRemoteDescription(parsed);
    } catch (err) {
      finalizeTransferWithFailure(activeTransfer, err instanceof Error ? err : new Error(String(err)));
    }
  }

  async function onRemoteTransferIce(sig: WebrtcIceSignal): Promise<void> {
    if (!activeTransfer
      || !isTransferCurrent(activeTransfer)
      || activeTransfer.requestMessageId !== sig.request_message_id
      || activeTransfer.sessionId !== sig.session_id) return;
    if (!activeTransfer.pc) return;
    try {
      await activeTransfer.pc.addIceCandidate(fromProtocolCandidate(sig.signal.candidate));
    } catch {
      // ignore
    }
  }

  async function onRemoteTransferEndOfCandidates(sig: WebrtcEndOfCandidatesSignal): Promise<void> {
    if (!activeTransfer
      || activeTransfer.requestMessageId !== sig.request_message_id
      || activeTransfer.sessionId !== sig.session_id) return;
    if (!activeTransfer.pc) return;
    try {
      await activeTransfer.pc.addIceCandidate({ candidate: "" });
    } catch {
      // ignore
    }
  }

  type TransferWireMessage =
    | {
        type: "transfer_begin";
        sessionId: string;
        kind: "image" | "file";
        fileName?: string;
        mimeType?: string;
        byteLength: number;
      }
    | {
        type: "transfer_chunk";
        sessionId: string;
        seq: number;
        data: string;
      }
    | {
        type: "transfer_end";
        sessionId: string;
      }
    | {
        type: "transfer_complete";
        sessionId: string;
        hash: string;
        byteLength: number;
      }
    | {
        type: "transfer_cancel";
        sessionId: string;
        reason: "busy" | "invalid_state" | "file_too_large" | "send_failed" | "invalid_payload" | "hash_mismatch" | "timeout";
      };

  function serializeTransferWireMessage(message: TransferWireMessage): string {
    return JSON.stringify(message);
  }

  function parseTransferWireMessage(data: string): TransferWireMessage | null {
    if (typeof data !== "string") return null;
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      return null;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const msg = raw as Record<string, unknown>;
    if (msg.type === "transfer_begin") {
      if (
        typeof msg.sessionId === "string" &&
        typeof msg.kind === "string" &&
        (msg.kind === "image" || msg.kind === "file") &&
        typeof msg.byteLength === "number" &&
        Number.isSafeInteger(msg.byteLength) &&
        msg.byteLength >= 0 &&
        msg.byteLength <= MAX_WEBRTC_TRANSFER_BYTES &&
        (msg.fileName === undefined || isBoundedMetadata(msg.fileName, MAX_TRANSFER_METADATA_LENGTH)) &&
        (msg.mimeType === undefined || isBoundedMetadata(msg.mimeType, MAX_TRANSFER_MIME_LENGTH))
      ) {
        const out: TransferWireMessage = {
          type: "transfer_begin",
          sessionId: msg.sessionId,
          kind: msg.kind,
          byteLength: msg.byteLength
        };
        if (typeof msg.fileName === "string") out.fileName = msg.fileName;
        if (typeof msg.mimeType === "string") out.mimeType = msg.mimeType;
        return out;
      }
      return null;
    }
    if (msg.type === "transfer_chunk") {
      if (
        typeof msg.sessionId === "string" &&
        typeof msg.seq === "number" &&
        Number.isSafeInteger(msg.seq) &&
        msg.seq >= 0 &&
        typeof msg.data === "string" &&
        msg.data.length > 0 &&
        msg.data.length <= 4 * Math.ceil(WEBRTC_TRANSFER_CHUNK_BYTES / 3) &&
        msg.data.length % 4 === 0 &&
        /^[A-Za-z0-9+/]*={0,2}$/.test(msg.data)
      ) {
        return {
          type: "transfer_chunk",
          sessionId: msg.sessionId,
          seq: msg.seq,
          data: msg.data
        };
      }
      return null;
    }
    if (msg.type === "transfer_end") {
      if (typeof msg.sessionId === "string") {
        return { type: "transfer_end", sessionId: msg.sessionId };
      }
      return null;
    }
    if (msg.type === "transfer_complete") {
      if (
        typeof msg.sessionId === "string" &&
        typeof msg.hash === "string" &&
        /^[0-9a-f]{64}$/.test(msg.hash) &&
        typeof msg.byteLength === "number" &&
        Number.isSafeInteger(msg.byteLength) &&
        msg.byteLength >= 0 &&
        msg.byteLength <= MAX_WEBRTC_TRANSFER_BYTES
      ) {
        return {
          type: "transfer_complete",
          sessionId: msg.sessionId,
          hash: msg.hash,
          byteLength: msg.byteLength
        };
      }
      return null;
    }
    if (msg.type === "transfer_cancel") {
      if (
        typeof msg.sessionId === "string" &&
        typeof msg.reason === "string" &&
        (msg.reason === "busy" ||
          msg.reason === "invalid_state" ||
          msg.reason === "file_too_large" ||
          msg.reason === "send_failed" ||
          msg.reason === "invalid_payload" ||
          msg.reason === "hash_mismatch" ||
          msg.reason === "timeout")
      ) {
        return {
          type: "transfer_cancel",
          sessionId: msg.sessionId,
          reason: msg.reason
        };
      }
      return null;
    }
    return null;
  }

  function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i] ?? 0);
    }
    if (typeof btoa === "function") {
      return btoa(binary);
    }
    throw new Error("base64_encode_unavailable");
  }

  function base64ToBytes(base64: string): Uint8Array {
    if (typeof atob === "function") {
      const binary = atob(base64);
      const out = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        out[i] = binary.charCodeAt(i);
      }
      return out;
    }
    throw new Error("base64_decode_unavailable");
  }

  async function sendIce(
    requestMessageId: string,
    sessionId: string,
    remotePublicKeyHex: string,
    candidate: RTCIceCandidateInit
  ): Promise<void> {
    const matchesTransfer = activeTransfer?.requestMessageId === requestMessageId && activeTransfer.sessionId === sessionId;
    if (!matchesTransfer) return;
    const body = newIceSignal(requestMessageId, sessionId, toProtocolCandidate(candidate));
    try {
      await publishSignalBody(remotePublicKeyHex, body);
    } catch {
      // ignore
    }
  }

  async function sendEndOfCandidates(
    requestMessageId: string,
    sessionId: string,
    remotePublicKeyHex: string
  ): Promise<void> {
    const matchesTransfer = activeTransfer?.requestMessageId === requestMessageId && activeTransfer.sessionId === sessionId;
    if (!matchesTransfer) return;
    try {
      await publishSignalBody(
        remotePublicKeyHex,
        newEndOfCandidatesSignal(requestMessageId, sessionId)
      );
    } catch {
      // 候选结束通知丢失时，浏览器仍可依据已有候选继续连接。
    }
  }

  /* ----- 出站（拨号）----- */

  async function sendImage(input: { targetPublicKeyHex: string; file: Blob | File }): Promise<void> {
    await sendTransferFileLike(input.targetPublicKeyHex, "image", input.file);
  }

  async function sendFile(input: { targetPublicKeyHex: string; file: Blob | File }): Promise<void> {
    await sendTransferFileLike(input.targetPublicKeyHex, "file", input.file);
  }

  async function sendTransferFileLike(
    targetPublicKeyHex: string,
    kind: "image" | "file",
    file: Blob | File
  ): Promise<void> {
    if (file.size > MAX_WEBRTC_TRANSFER_BYTES) {
      throw new Error("transfer_too_large");
    }
    if (!channel.isReady()) {
      throw new Error("service_not_ready");
    }
    if (active || isTransferActive()) {
      throw new Error("busy_local");
    }
    await startOutgoingTransfer({ targetPublicKeyHex: targetPublicKeyHex.trim().toLowerCase(), kind, file });
  }

  async function startCall(input: StartCallInput): Promise<void> {
    void input;
    lastError = "call_protocol_unavailable";
    emit();
    throw new Error("call_protocol_unavailable");
  }

  /* ----- STUN 自检 ----- */

  /**
   * 批量 STUN 诊断：每个 STUN 单独发起临时 RTCPeerConnection，按是否拿到
   * srflx candidate 判定 ok / timeout / error。
   *
   * 修复要点（施工单 2026-07-04 002 / 反馈）：单纯 `new RTCPeerConnection`
   * 不会触发 ICE gathering；必须先 `createDataChannel` + `createOffer()` +
   * `setLocalDescription()` 才能让浏览器真的开始收集 srflx 候选。fake env
   * 的实现也必须遵循这一行为以让测试有意义。
   */
  async function runStunDiagnostics(): Promise<StunDiagnosticResult[]> {
    const cfg = store.snapshot();
    const urls = cfg.stunServers.filter((u) => u.trim().length > 0);
    const result: StunDiagnosticResult[] = [];
    for (const url of urls) {
      result.push(await testOneStun(url));
    }
    return result;
  }

  async function testOneStun(url: string): Promise<StunDiagnosticResult> {
    let pc: RTCPeerConnectionLike | null = null;
    try {
      pc = env.createPeerConnection({ iceServers: [{ urls: [url] }] });
    } catch (err) {
      return {
        url,
        status: "error",
        error: err instanceof Error ? err.message : String(err)
      };
    }
    const timeoutMs = env.stunDiagnosticTimeoutMs ?? 4000;
    return new Promise<StunDiagnosticResult>((resolve) => {
      let settled = false;
      const settle = (r: StunDiagnosticResult): void => {
        if (settled) return;
        settled = true;
        try {
          pc?.close();
        } catch {
          // ignore
        }
        resolve(r);
      };
      // 触发真正的 ICE gathering：dataChannel + createOffer + setLocalDescription
      void (async () => {
        try {
          pc!.createDataChannel("stun-probe");
          const offer = await pc!.createOffer();
          await pc!.setLocalDescription(offer);
        } catch (err) {
          settle({
            url,
            status: "error",
            error: err instanceof Error ? err.message : String(err)
          });
        }
      })();
      env
        .delay(timeoutMs)
        .then(() => settle({ url, status: "timeout" }))
        .catch(() => undefined);
      pc!.onIceCandidate((c) => {
        if (typeof c.candidate === "string" && c.candidate.includes("typ srflx")) {
          settle({ url, status: "ok" });
        }
      });
      pc!.onIceGatheringStateChange((s) => {
        if (s === "failed") {
          settle({ url, status: "error", error: "ice_gathering_failed" });
          return;
        }
        if (s === "complete") {
          settle({ url, status: "timeout" });
        }
      });
    });
  }

  /* ----- 媒体绑定 ----- */

  /**
   * 把本地 / 远端媒体流绑到 UI 的 `<video>` 上。返回解绑函数。
   *
   * 不让 UI 访问 `MediaStreamLike.native` 的具体类型（避免 `_native` 之类
   * 私有字段猜出来），由 service 在浏览器侧自动走 `MediaStream` 类型转换。
   * 节点 / 测试环境下 `native` 为 undefined，UI 端会看到空 srcObject。
   */
  function attachToVideo(
    direction: "local" | "remote",
    videoEl: HTMLVideoElement
  ): () => void {
    const cur = active;
    const stream =
      !cur
        ? null
        : direction === "local"
          ? cur.localStream
          : cur.remoteStream;
    const native = stream?.native ?? null;
    if (native instanceof MediaStream) {
      videoEl.srcObject = native;
    } else if (stream && stream.isLive()) {
      // 浏览器侧却拿不到原生 MediaStream——不应发生；用空流兜底。
      videoEl.srcObject = null;
    } else {
      videoEl.srcObject = null;
    }
    // local 强制 muted（防回授）；remote 不动。
    videoEl.muted = direction === "local";
    videoEl.autoplay = true;
    videoEl.playsInline = true;
    return () => {
      if (videoEl.srcObject === (native instanceof MediaStream ? native : null)) {
        videoEl.srcObject = null;
      }
    };
  }

  /* ----- 订阅 Channel 私信 + dispose ----- */

  const off = channel.subscribePrivate((message) => handleIncoming(message));
  const offHashRequests = channel.subscribe((message) => {
    void handleIncomingHashRequest(message).catch((error) => {
      log.warn("webrtc.service", "hash_request_handler_failed", error);
    });
  });
  const subscribeOwnerInbox = (): void => {
    if (disposed) return;
    const ownerPublicKeyHex = currentOwnerPublicKeyHex();
    if (!ownerPublicKeyHex) return;
    void channel.subscriptionSet([`bsv8.inbox.${ownerPublicKeyHex}`, HASH_REQUEST_CHANNEL]).catch((error) => {
      log.warn("webrtc.service", "owner_inbox_subscription_failed", error);
    });
  };
  subscribeOwnerInbox();
  const offOwnerChanged = typeof keyspace.onActiveKeyChanged === "function"
    ? keyspace.onActiveKeyChanged((state) => {
      const nextOwner = state.activePublicKeyHex?.trim().toLowerCase() ?? null;
      if (nextOwner !== observedOwnerPublicKeyHex) {
        observedOwnerPublicKeyHex = nextOwner;
        ownerGeneration += 1;
      }
      cancelTransferAdmissions();
      if (active && active.ownerPublicKeyHex !== nextOwner) {
        clearActive({ showEndedPhase: true });
      }
      if (activeTransfer && activeTransfer.ownerPublicKeyHex !== nextOwner) {
        finalizeTransferWithFailure(activeTransfer, new Error("transfer_owner_changed"));
      }
      for (const sessionId of pendingTransferRequests.keys()) removePendingTransferRequest(sessionId);
      transferRequestChecks.clear();
      transferRequestRates.clear();
      transferAcceptanceInFlight = null;
      subscribeOwnerInbox();
    })
    : undefined;

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    ownerGeneration += 1;
    cancelTransferAdmissions();
    // 单一清理路径：本地截断 UI、释放 tracks、关闭 pc、取消订阅。
    // V1 没有 hangup wire 分支；远端会由 RTC connection state/超时收敛。
    clearActive({ showEndedPhase: true });
    if (activeTransfer) {
      finalizeTransferWithFailure(activeTransfer, new Error("service_disposed"));
    }
    for (const sessionId of pendingTransferRequests.keys()) removePendingTransferRequest(sessionId);
    transferRequestChecks.clear();
    transferRequestRates.clear();
    transferAcceptanceInFlight = null;
    transferAdmissionInFlightBySender.clear();
    transferAdmissionInFlight = 0;
    if (pendingTransferPruneTimer !== undefined) {
      clearTimeout(pendingTransferPruneTimer);
      pendingTransferPruneTimer = undefined;
    }
    off();
    offHashRequests();
    offOwnerChanged?.();
    void channel.subscriptionSet([]).catch(() => undefined);
    subscribers.clear();
    endedDeadlineAt = null;
  }

  return {
    snapshot,
    subscribe(handler) {
      subscribers.add(handler);
      handler(snapshot());
      return () => {
        subscribers.delete(handler);
      };
    },
    isReady: () => channel.isReady(),
    listHistoryForPeer: (peerPublicKeyHex) => historyService.listForPeer(peerPublicKeyHex),
    getTransferBlob: (blobKey) => historyService.getBlob(blobKey),
    startCall,
    sendImage,
    sendFile,
    acceptIncoming,
    rejectIncoming,
    acceptIncomingTransfer,
    rejectIncomingTransfer,
    hangup: () => doHangup("hangup"),
    consumeRemoteNotice: () => {
      if (remoteNotice !== null) {
        remoteNotice = null;
        emit();
      }
    },
    attachToVideo,
    runStunDiagnostics,
    getStunServers: () => store.snapshot().stunServers.slice(),
    applyStunServers: async (input: string[]): Promise<void> => {
      store.save({ stunServers: input });
    },
    dispose
  };
}

/** 把 `WebrtcConfig.stunServers` 转成 `RTCConfiguration`。 */
function configToRTCConfig(cfg: WebrtcConfig): RTCConfiguration {
  const urls = cfg.stunServers.filter((u) => u.trim().length > 0);
  if (urls.length === 0) {
    return { iceServers: [{ urls: [...DEFAULT_STUN_SERVERS] }] };
  }
  return { iceServers: [{ urls }] };
}

/* ============== logger 抽象 ============== */

export interface WebrtcLogger {
  info(scope: string, msg: string, data?: unknown): void;
  warn(scope: string, msg: string, err?: unknown): void;
  error(scope: string, msg: string, err?: unknown): void;
}

function silentLogger(): WebrtcLogger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  };
}
