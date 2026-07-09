// packages/plugin-webrtc/src/webrtcService.ts
// WebRTC 业务 service（施工单 2026-07-04 002 硬切换）。
//
// 设计缘由：
//   - 单活会话：整个 plugin-webrtc 实例同时只允许一通会话占位；占位期间包括
//     「拨号中 / 响铃中 / 已接通 / 挂断清理中」；
//   - 入站 / 出站信令统一走 `AppMsgEndpointService` 的 `text/plain` body；
//   - 拨号前必须通过 `endpointService.checkOnline([target])` 拿到 `online` 才
//     允许继续；`offline` / `unknown` 一律 fail-closed（施工单 §5.4）；
//   - 设备能力以真实 `getUserMedia(...)` 结果为准：接收方在收到 `invite`
//     时按 mode 立刻做能力测试，按结果决定 allow / fallback_required / reject；
//   - 模式协商：接收方有视频 → 允许；只有音频 → 回送 `fallback_required`；
//     连音频都没有 → 回送 `reject(audio_unavailable)`；
//   - 不持久化任何媒体 / SDP / ICE 累积态；页面刷新 / disable / 挂断都立刻
//     释放本地 tracks + RTCPeerConnection；
//   - phase 状态机：idle / inviting / incoming / connecting / connected / ended；
//     ended 是挂断后短时间存在的过渡态，之后自动回 idle；
//   - 媒体流真值通过 `attachToVideo(...)` 显式绑给 UI，避免 UI 猜 `_native`；
//   - 单测友好：所有浏览器 API 走抽象层 `WebrtcEnvironment`，测试可注入 fake。

import type {
  AppMsgEndpointId,
  AppMsgEndpointService,
  AppMsgMessage
} from "@keymaster/contracts";
import type { KeyspaceService, NoticeRegistry } from "@keymaster/contracts";
import { KEYMASTER_WEBRTC_APP_ID } from "./constants.js";
import type { WebrtcHistoryItem, WebrtcHistoryService } from "./webrtcHistoryService.js";
import {
  isAcceptableRemoteSessionId,
  isSignalExpired,
  serializeSignal,
  tryParseSignal,
  buildEnvelopeBase,
  type WebrtcRejectSignal,
  type WebrtcFallbackRequiredSignal,
  type WebrtcBusySignal,
  type WebrtcHangupSignal,
  type WebrtcIceSignal,
  type WebrtcInviteSignal,
  type WebrtcAnswerSignal,
  type WebrtcSignal,
  type WebrtcTransferAnswerSignal,
  type WebrtcTransferInviteSignal,
  type WebrtcTransferRejectSignal
} from "./webrtcSignal.js";
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
  | "target_offline"
  | "target_unknown"
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
  /** service 整体是否可用（endpoint ready + 设备环境）。 */
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
  checkPeerOnline(publicKeyHex: string): Promise<import("@keymaster/contracts").AppMsgOnlineStatus>;
  listHistoryForPeer(peerPublicKeyHex: string): Promise<WebrtcHistoryItem[]>;
  getTransferBlob(blobKey: string): Promise<Blob | null>;
  startCall(input: StartCallInput): Promise<void>;
  sendImage(input: { targetPublicKeyHex: string; file: Blob | File }): Promise<void>;
  sendFile(input: { targetPublicKeyHex: string; file: Blob | File }): Promise<void>;
  acceptIncoming(): Promise<void>;
  rejectIncoming(): Promise<void>;
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
  generateSessionId(): string;
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
    generateSessionId: () =>
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? `km-wbrtc-${crypto.randomUUID()}`
        : `km-wbrtc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
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

export function createWebrtcService(input: {
  endpointId?: AppMsgEndpointId;
  endpointService: AppMsgEndpointService;
  keyspace?: KeyspaceService;
  historyService?: WebrtcHistoryService;
  noticeRegistry?: NoticeRegistry;
  configStore: WebrtcConfigStore;
  env?: WebrtcEnvironment;
  logger?: WebrtcLogger;
}): WebrtcService {
  const endpoint = input.endpointService;
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

  const MAX_WEBRTC_TRANSFER_BYTES = 16 * 1024 * 1024;

  interface ActiveSession {
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
    /** peer connection 已 connected 标志位；用于区分 `connecting` 与 `connected`。 */
    pcConnected: boolean;
    /**
     * 是否已完成"协商"：呼出端收到 answer 且 setRemoteDescription 成功；接听端已
     * 发 answer 后。完成协商 → 即使 pc 尚未 connected 也进入 `connecting`，
     * 而不是停留在 `inviting` / `incoming`。
     */
    negotiated: boolean;
  }
  let active: ActiveSession | null = null;

  interface ActiveTransfer {
    sessionId: string;
    direction: "outgoing" | "incoming";
    remotePublicKeyHex: string;
    ownerPublicKeyHex: string | null;
    startedAtMs: number;
    kind: "image" | "file";
    fileName?: string;
    mimeType?: string;
    byteLength: number;
    pc: RTCPeerConnectionLike;
    channel: DataChannelLike | null;
    pendingOffer: RTCSessionDescriptionInit | null;
    pendingChunks: Uint8Array[];
    pendingMeta: { kind: "image" | "file"; fileName?: string; mimeType?: string; byteLength: number } | null;
    blob?: Blob;
    settled: boolean;
    resolve?: () => void;
    reject?: (err: Error) => void;
  }
  let activeTransfer: ActiveTransfer | null = null;

  /** `ended` 过渡态：UI 在 ttl 内可见，过了之后清空回 idle。 */
  let endedDeadlineAt: number | null = null;

  let remoteNotice: WebrtcRemoteNotice | null = null;
  let lastError: WebrtcBlockReason | null = null;
  const subscribers = new Set<WebrtcSubscriber>();
  const owner = () => keyspace.active().activePublicKeyHex ?? null;

  function currentOwnerPublicKeyHex(): string | null {
    return owner();
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
    reason?: WebrtcHangupSignal["reason"];
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
      serviceReady: endpoint.isReady(),
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

  function clearTransfer(): void {
    const session = activeTransfer;
    activeTransfer = null;
    if (!session) return;
    try {
      session.channel?.close();
    } catch {
      // ignore
    }
    try {
      session.pc.close();
    } catch {
      // ignore
    }
  }

  /**
   * 主动挂断：先把 ended 标记打开，再异步发 hangup 信令；发完（或失败）
   * **不**再做额外 emit——`clearActive` 已经 emit 了一次给 UI。
   */
  async function doHangup(reason: WebrtcHangupSignal["reason"]): Promise<void> {
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
    // 先同步清场 + emit，再异步发 hangup；UI 立刻看到 ended，不再卡 inviting。
    clearActive({ showEndedPhase: true });
    const envBase = buildEnvelopeBase({ sessionId: session.sessionId, nowMs: env.now() });
    const body = serializeSignal({
      ...envBase,
      type: "hangup",
      reason
    });
    try {
      await endpoint.sendMessage({
        recipientPublicKeyHex: session.remotePublicKeyHex,
        recipientAppId: KEYMASTER_WEBRTC_APP_ID,
        contentType: "text/plain",
        body,
        clientMessageId: `km-wbrtc-hangup-${envBase.sessionId}`,
        createdAtMs: envBase.createdAtMs
      });
    } catch (err) {
      log.warn("webrtc.service", "hangup_send_failed", err);
    }
  }

  /* ----- 入站信令处理 ----- */

  function handleIncoming(msg: AppMsgMessage): void {
    const sig = tryParseSignal(msg);
    if (!sig) return;
    if (isSignalExpired(sig, env.now())) return;
    const remote = msg.senderPublicKeyHex;
    if (
      sig.type === "transfer_invite" ||
      sig.type === "transfer_answer" ||
      sig.type === "transfer_reject" ||
      sig.type === "ice"
    ) {
      switch (sig.type) {
        case "transfer_invite":
          void onRemoteTransferInvite(sig, remote).catch((err) => {
            log.warn("webrtc.service", "on_remote_transfer_invite_failed", err);
          });
          return;
        case "transfer_answer":
        case "transfer_reject":
        case "ice": {
          const localTransferSession = activeTransfer?.sessionId ?? null;
          if (localTransferSession === sig.sessionId) {
            if (sig.type === "transfer_answer") {
              void onRemoteTransferAnswer(sig).catch((err) => {
                log.warn("webrtc.service", "on_remote_transfer_answer_failed", err);
              });
              return;
            }
            if (sig.type === "transfer_reject") {
              void onRemoteTransferReject(sig).catch((err) => {
                log.warn("webrtc.service", "on_remote_transfer_reject_failed", err);
              });
              return;
            }
            void onRemoteTransferIce(sig).catch((err) => {
              log.warn("webrtc.service", "on_remote_transfer_ice_failed", err);
            });
            return;
          }
          if (sig.type !== "ice") return;
          break;
        }
      }
    }
    const localSession = active?.sessionId ?? null;
    if (!isAcceptableRemoteSessionId(sig, localSession)) return;
    switch (sig.type) {
      case "invite":
        void onRemoteInvite(sig, remote).catch((err) => {
          log.warn("webrtc.service", "on_remote_invite_failed", err);
          lastError = "invalid_state";
          emit();
        });
        return;
      case "answer":
        void onRemoteAnswer(sig).catch((err) => {
          log.warn("webrtc.service", "on_remote_answer_failed", err);
          lastError = "invalid_state";
        });
        return;
      case "ice":
        void onRemoteIce(sig).catch((err) => {
          log.warn("webrtc.service", "on_remote_ice_failed", err);
        });
        return;
      case "reject":
        onRemoteReject(sig, remote);
        return;
      case "busy":
        onRemoteBusy(remote);
        return;
      case "hangup":
        onRemoteHangup(sig);
        return;
      case "fallback_required":
        onRemoteFallbackRequired(sig, remote);
        return;
    }
  }

  async function onRemoteInvite(
    sig: WebrtcInviteSignal,
    remote: string
  ): Promise<void> {
    if (active) {
      await sendSimpleSignal(remote, "busy", sig.sessionId, "busy");
      return;
    }
    if (sig.mode === "audio") {
      let stream: MediaStreamLike;
      try {
        stream = await env.getUserMedia({ audio: true, video: false });
      } catch {
        await sendSimpleSignal(
          remote,
          "reject",
          sig.sessionId,
          "audio_unavailable"
        );
        return;
      }
      let parsedOffer: RTCSessionDescriptionInit;
      try {
        parsedOffer = JSON.parse(sig.sdp) as RTCSessionDescriptionInit;
      } catch {
        stream.stop();
        await sendSimpleSignal(remote, "reject", sig.sessionId, "invalid_state");
        return;
      }
      active = {
        sessionId: sig.sessionId,
        direction: "incoming",
        mode: "audio",
        remotePublicKeyHex: remote,
        ownerPublicKeyHex: currentOwnerPublicKeyHex(),
        startedAtMs: env.now(),
        localStream: stream,
        pc: null,
        remoteStream: null,
        pendingOffer: parsedOffer,
        pcConnected: false,
        negotiated: false
      };
      emit();
      upsertIncomingNotice(active);
      return;
    }
    // mode === "video"
    let parsedOfferVideo: RTCSessionDescriptionInit;
    try {
      parsedOfferVideo = JSON.parse(sig.sdp) as RTCSessionDescriptionInit;
    } catch {
      await sendSimpleSignal(remote, "reject", sig.sessionId, "invalid_state");
      return;
    }
    try {
      const stream = await env.getUserMedia({ audio: true, video: true });
      active = {
        sessionId: sig.sessionId,
        direction: "incoming",
        mode: "video",
        remotePublicKeyHex: remote,
        ownerPublicKeyHex: currentOwnerPublicKeyHex(),
        startedAtMs: env.now(),
        localStream: stream,
        pc: null,
        remoteStream: null,
        pendingOffer: parsedOfferVideo,
        pcConnected: false,
        negotiated: false
      };
      emit();
      upsertIncomingNotice(active);
      return;
    } catch {
      try {
        const audioOnly = await env.getUserMedia({ audio: true, video: false });
        audioOnly.stop();
        await sendSimpleSignal(
          remote,
          "fallback_required",
          sig.sessionId,
          "video_unavailable",
          { suggestedMode: "audio" }
        );
        return;
      } catch {
        await sendSimpleSignal(remote, "reject", sig.sessionId, "audio_unavailable");
        return;
      }
    }
  }

  /**
   * 接收方接受 incoming 会话：建 pc、接入本地流、setRemoteDescription(offer)、
   * createAnswer、发 answer。
   */
  async function acceptIncoming(): Promise<void> {
    if (!active || active.direction !== "incoming") {
      throw new Error("service_not_ready");
    }
    const session = active;
    if (!session.pendingOffer || !session.localStream) {
      throw new Error("invalid_state");
    }
    const offer = session.pendingOffer;
    const cfg = configToRTCConfig(store.snapshot());
    const pc = env.createPeerConnection(cfg);
    pc.replaceLocalStream(session.localStream);
    pc.onIceCandidate((c) => {
      void sendIce(session.sessionId, session.remotePublicKeyHex, c, "call").catch(() => undefined);
    });
    pc.onConnectionStateChange((s) => {
      const cur = active;
      if (!cur || cur.sessionId !== session.sessionId) return;
      if (s === "connected") {
        cur.pcConnected = true;
        emit();
        return;
      }
      if (s === "failed" || s === "disconnected" || s === "closed") {
        void doHangup("ice_disconnected");
      }
    });
    pc.onTrack((stream) => {
      const cur = active;
      if (cur && cur.sessionId === session.sessionId) {
        cur.remoteStream = stream;
        cur.pcConnected = true;
        emit();
      }
    });
    try {
      await pc.setRemoteDescription(offer);
    } catch {
      // 失败回滚都统一走 clearActive —— 确保 UI 立刻看到 idle。
      clearActive();
      await sendSimpleSignal(
        session.remotePublicKeyHex,
        "reject",
        session.sessionId,
        "invalid_state"
      );
      return;
    }
    let answer: RTCSessionDescriptionInit;
    try {
      answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
    } catch {
      clearActive();
      return;
    }
    session.pc = pc;
    session.pendingOffer = null;
    const envBase = buildEnvelopeBase({ sessionId: session.sessionId, nowMs: env.now() });
    const body = serializeSignal({
      ...envBase,
      type: "answer",
      mode: session.mode,
      sdp: JSON.stringify(answer)
    });
    try {
      await endpoint.sendMessage({
        recipientPublicKeyHex: session.remotePublicKeyHex,
        recipientAppId: KEYMASTER_WEBRTC_APP_ID,
        contentType: "text/plain",
        body,
        clientMessageId: `km-wbrtc-answer-${envBase.sessionId}`,
        createdAtMs: envBase.createdAtMs
      });
    } catch (err) {
      log.warn("webrtc.service", "send_answer_failed", err);
      clearActive();
      return;
    }
    // 接听端已经发出 answer → 已进入协商阶段；UI 立刻从 `incoming` 切到
    // `connecting`，不再卡 `incoming`。
    session.negotiated = true;
    emit();
  }

  async function rejectIncoming(): Promise<void> {
    if (!active || active.direction !== "incoming") return;
    const session = active;
    await recordCallEnd(session, "rejected");
    await sendSimpleSignal(
      session.remotePublicKeyHex,
      "reject",
      session.sessionId,
      "declined"
    );
    clearActive();
  }

  async function onRemoteAnswer(sig: WebrtcAnswerSignal): Promise<void> {
    if (!active || active.sessionId !== sig.sessionId) return;
    if (!active.pc) return;
    let parsed: RTCSessionDescriptionInit;
    try {
      parsed = JSON.parse(sig.sdp) as RTCSessionDescriptionInit;
    } catch {
      return;
    }
    try {
      await active.pc.setRemoteDescription(parsed);
      // 呼出端：answer 接收并 setRemoteDescription 成功 → 协商完成，UI
      // 从 `inviting` 切到 `connecting`。
      if (active && active.sessionId === sig.sessionId) {
        active.negotiated = true;
        emit();
      }
    } catch {
      // 非法 answer 静默；超时自然挂断。
    }
  }

  async function onRemoteIce(sig: WebrtcIceSignal): Promise<void> {
    if (!active || active.sessionId !== sig.sessionId) return;
    if (!active.pc) return;
    try {
      await active.pc.addIceCandidate(sig.candidate);
    } catch {
      // ignore
    }
  }

  function onRemoteReject(sig: WebrtcRejectSignal, remote: string): void {
    if (!active) return;
    void recordCallEnd(active, "rejected");
    clearActive({ showEndedPhase: true });
    remoteNotice = {
      kind: "rejected",
      message: `peer rejected: ${sig.reason}`
    };
    void remote;
    emit();
  }

  function onRemoteBusy(remote: string): void {
    if (!active) return;
    void recordCallEnd(active, "missed");
    clearActive({ showEndedPhase: true });
    remoteNotice = {
      kind: "busy",
      message: "peer is busy"
    };
    void remote;
    emit();
  }

  function onRemoteHangup(sig: WebrtcHangupSignal): void {
    if (!active) return;
    void recordCallEnd(active, resolveCallEndStatus({ session: active, origin: "remote", reason: sig.reason }));
    clearActive({ showEndedPhase: true });
    if (sig.reason === "ice_disconnected") {
      // 走诊断通道；UI 自行决定是否展示。
    }
  }

  function onRemoteFallbackRequired(
    sig: WebrtcFallbackRequiredSignal,
    remote: string
  ): void {
    if (!active) return;
    void recordCallEnd(active, "missed");
    clearActive({ showEndedPhase: true });
    remoteNotice = {
      kind: "fallback_suggested",
      message:
        "peer has no video capability; you can fall back to audio chat",
      suggestedMode: sig.suggestedMode
    };
    void remote;
    emit();
  }

  function isTransferActive(): boolean {
    return activeTransfer !== null;
  }

  function finalizeTransferWithFailure(session: ActiveTransfer, err: Error): void {
    if (session.settled) return;
    session.settled = true;
    if (activeTransfer?.sessionId === session.sessionId) {
      activeTransfer = null;
    }
    try {
      session.channel?.close();
    } catch {
      // ignore
    }
    try {
      session.pc.close();
    } catch {
      // ignore
    }
    void recordTransferEnd({ session, status: "failed", blob: session.blob }).catch(() => undefined);
    session.reject?.(err);
    emit();
  }

  function finalizeTransferWithSuccess(session: ActiveTransfer, blob?: Blob): void {
    if (session.settled) return;
    session.settled = true;
    if (activeTransfer?.sessionId === session.sessionId) {
      activeTransfer = null;
    }
    void recordTransferEnd({
      session,
      status: "completed",
      blob: blob ?? session.blob
    }).catch(() => undefined);
    session.resolve?.();
    emit();
  }

  function decodeTransferBytes(data: string): Uint8Array {
    return base64ToBytes(data);
  }

  function encodeTransferBytes(bytes: Uint8Array): string {
    return bytesToBase64(bytes);
  }

  async function sendTransferSignal(
    remotePublicKeyHex: string,
    sessionId: string,
    type: "transfer_invite" | "transfer_answer" | "transfer_reject",
    payload: Record<string, unknown>
  ): Promise<void> {
    const envBase = buildEnvelopeBase({ sessionId, nowMs: env.now() });
    const body = serializeSignal({
      ...envBase,
      type,
      ...payload
    } as WebrtcTransferInviteSignal | WebrtcTransferAnswerSignal | WebrtcTransferRejectSignal);
    await endpoint.sendMessage({
      recipientPublicKeyHex: remotePublicKeyHex,
      recipientAppId: KEYMASTER_WEBRTC_APP_ID,
      contentType: "text/plain",
      body,
      clientMessageId: `km-wrtc-${type}-${sessionId}`,
      createdAtMs: envBase.createdAtMs
    });
  }

  function attachTransferDataChannel(session: ActiveTransfer, channel: DataChannelLike): void {
    session.channel = channel;
    channel.onOpen(() => {
      if (session.settled || activeTransfer?.sessionId !== session.sessionId) return;
      if (session.direction === "outgoing") {
        void sendOutgoingTransferPayload(session).catch((err) => {
          finalizeTransferWithFailure(session, err instanceof Error ? err : new Error(String(err)));
        });
      }
    });
    channel.onMessage((data) => {
      if (session.settled || activeTransfer?.sessionId !== session.sessionId) return;
      if (typeof data !== "string") {
        finalizeTransferWithFailure(session, new Error("transfer_invalid_message"));
        return;
      }
      const msg = parseTransferWireMessage(data);
      if (!msg || msg.sessionId !== session.sessionId) {
        finalizeTransferWithFailure(session, new Error("transfer_invalid_message"));
        return;
      }
      if (msg.type === "transfer_begin") {
        session.pendingMeta = {
          kind: msg.kind,
          fileName: msg.fileName,
          mimeType: msg.mimeType,
          byteLength: msg.byteLength
        };
        session.pendingChunks = [];
        return;
      }
      if (msg.type === "transfer_chunk") {
        session.pendingChunks.push(decodeTransferBytes(msg.data));
        return;
      }
      if (msg.type === "transfer_end") {
        const meta = session.pendingMeta;
        if (!meta) {
          finalizeTransferWithFailure(session, new Error("transfer_invalid_message"));
          return;
        }
        const blobParts = session.pendingChunks.map((chunk) =>
          chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer
        );
        const blob = new Blob(blobParts, { type: meta.mimeType || "application/octet-stream" });
        if (blob.size !== meta.byteLength) {
          finalizeTransferWithFailure(session, new Error("transfer_size_mismatch"));
          return;
        }
        session.blob = blob;
        finalizeTransferWithSuccess(session, blob);
        return;
      }
      if (msg.type === "transfer_cancel") {
        finalizeTransferWithFailure(session, new Error(`transfer_cancel: ${msg.reason}`));
      }
    });
    channel.onClose(() => {
      if (session.settled) return;
      finalizeTransferWithFailure(session, new Error("transfer_channel_closed"));
    });
    channel.onError((err) => {
      if (session.settled) return;
      finalizeTransferWithFailure(session, err instanceof Error ? err : new Error(String(err)));
    });
  }

  async function sendOutgoingTransferPayload(session: ActiveTransfer): Promise<void> {
    if (!session.channel || session.direction !== "outgoing") {
      throw new Error("transfer_invalid_state");
    }
    const blob = session.blob;
    if (!blob) {
      throw new Error("transfer_invalid_state");
    }
    const begin = serializeTransferWireMessage({
      type: "transfer_begin",
      sessionId: session.sessionId,
      kind: session.kind,
      fileName: session.fileName,
      mimeType: session.mimeType,
      byteLength: session.byteLength
    });
    session.channel.send(begin);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const chunkSize = 16 * 1024;
    for (let offset = 0, seq = 0; offset < bytes.length; offset += chunkSize, seq += 1) {
      const chunk = bytes.slice(offset, offset + chunkSize);
      const payload = serializeTransferWireMessage({
        type: "transfer_chunk",
        sessionId: session.sessionId,
        seq,
        data: encodeTransferBytes(chunk)
      });
      session.channel.send(payload);
    }
    session.channel.send(
      serializeTransferWireMessage({
        type: "transfer_end",
        sessionId: session.sessionId
      })
    );
    finalizeTransferWithSuccess(session, blob);
  }

  async function startOutgoingTransfer(input: {
    targetPublicKeyHex: string;
    kind: "image" | "file";
    file: Blob | File;
  }): Promise<void> {
    if (!endpoint.isReady()) {
      lastError = "service_not_ready";
      throw new Error("service_not_ready");
    }
    if (active || isTransferActive()) {
      throw new Error("busy_local");
    }
    const sessionId = env.generateSessionId();
    const pc = env.createPeerConnection(configToRTCConfig(store.snapshot()));
    const session: ActiveTransfer = {
      sessionId,
      direction: "outgoing",
      remotePublicKeyHex: input.targetPublicKeyHex,
      ownerPublicKeyHex: currentOwnerPublicKeyHex(),
      startedAtMs: env.now(),
      kind: input.kind,
      fileName: "name" in input.file ? input.file.name : undefined,
      mimeType: input.file.type || undefined,
      byteLength: input.file.size,
      pc,
      channel: null,
      pendingOffer: null,
      pendingChunks: [],
      pendingMeta: null,
      blob: input.file,
      settled: false
    };
    activeTransfer = session;
    const done = new Promise<void>((resolve, reject) => {
      session.resolve = resolve;
      session.reject = reject;
    });
    pc.onIceCandidate((c) => {
      void sendIce(session.sessionId, session.remotePublicKeyHex, c, "transfer").catch(() => undefined);
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
    const channel = pc.createDataChannel("transfer");
    attachTransferDataChannel(session, channel);
    let offer: RTCSessionDescriptionInit;
    try {
      offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
    } catch (err) {
      finalizeTransferWithFailure(session, err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
    session.pendingOffer = offer;
    try {
      await sendTransferSignal(session.remotePublicKeyHex, session.sessionId, "transfer_invite", {
        kind: session.kind,
        fileName: session.fileName,
        mimeType: session.mimeType,
        byteLength: session.byteLength,
        sdp: JSON.stringify(offer)
      });
    } catch (err) {
      finalizeTransferWithFailure(session, err instanceof Error ? err : new Error(String(err)));
      throw new Error(
        `transfer_invite_failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    const timeout = env.delay(15_000).then(() => {
      if (session.settled) return;
      finalizeTransferWithFailure(session, new Error("transfer_timeout"));
      throw new Error("transfer_timeout");
    });
    await Promise.race([done, timeout]);
  }

  async function onRemoteTransferInvite(sig: WebrtcTransferInviteSignal, remote: string): Promise<void> {
    if (active || isTransferActive()) {
      await sendTransferSignal(remote, sig.sessionId, "transfer_reject", { reason: "busy" });
      return;
    }
    if (sig.byteLength > MAX_WEBRTC_TRANSFER_BYTES) {
      await sendTransferSignal(remote, sig.sessionId, "transfer_reject", { reason: "file_too_large" });
      return;
    }
    let parsedOffer: RTCSessionDescriptionInit;
    try {
      parsedOffer = JSON.parse(sig.sdp) as RTCSessionDescriptionInit;
    } catch {
      await sendTransferSignal(remote, sig.sessionId, "transfer_reject", { reason: "invalid_state" });
      return;
    }
    const pc = env.createPeerConnection(configToRTCConfig(store.snapshot()));
    const session: ActiveTransfer = {
      sessionId: sig.sessionId,
      direction: "incoming",
      remotePublicKeyHex: remote,
      ownerPublicKeyHex: currentOwnerPublicKeyHex(),
      startedAtMs: env.now(),
      kind: sig.kind,
      fileName: sig.fileName,
      mimeType: sig.mimeType,
      byteLength: sig.byteLength,
      pc,
      channel: null,
      pendingOffer: parsedOffer,
      pendingChunks: [],
      pendingMeta: null,
      settled: false
    };
    activeTransfer = session;
    pc.onIceCandidate((c) => {
      void sendIce(session.sessionId, session.remotePublicKeyHex, c, "transfer").catch(() => undefined);
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
      await sendTransferSignal(remote, sig.sessionId, "transfer_answer", {
        sdp: JSON.stringify(answer)
      });
    } catch (err) {
      finalizeTransferWithFailure(session, err instanceof Error ? err : new Error(String(err)));
      return;
    }
  }

  async function onRemoteTransferAnswer(sig: WebrtcTransferAnswerSignal): Promise<void> {
    if (!activeTransfer || activeTransfer.direction !== "outgoing") return;
    if (activeTransfer.sessionId !== sig.sessionId) return;
    let parsed: RTCSessionDescriptionInit;
    try {
      parsed = JSON.parse(sig.sdp) as RTCSessionDescriptionInit;
    } catch {
      finalizeTransferWithFailure(activeTransfer, new Error("transfer_invalid_state"));
      return;
    }
    try {
      await activeTransfer.pc.setRemoteDescription(parsed);
    } catch (err) {
      finalizeTransferWithFailure(activeTransfer, err instanceof Error ? err : new Error(String(err)));
    }
  }

  async function onRemoteTransferIce(sig: WebrtcIceSignal): Promise<void> {
    if (!activeTransfer || activeTransfer.sessionId !== sig.sessionId) return;
    if (!activeTransfer.pc) return;
    try {
      await activeTransfer.pc.addIceCandidate(sig.candidate);
    } catch {
      // ignore
    }
  }

  async function onRemoteTransferReject(sig: WebrtcTransferRejectSignal): Promise<void> {
    if (!activeTransfer || activeTransfer.sessionId !== sig.sessionId) return;
    finalizeTransferWithFailure(activeTransfer, new Error(`transfer_reject: ${sig.reason}`));
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
        type: "transfer_cancel";
        sessionId: string;
        reason: "busy" | "invalid_state" | "file_too_large" | "send_failed";
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
        Number.isFinite(msg.byteLength)
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
        Number.isFinite(msg.seq) &&
        typeof msg.data === "string"
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
    if (msg.type === "transfer_cancel") {
      if (
        typeof msg.sessionId === "string" &&
        typeof msg.reason === "string" &&
        (msg.reason === "busy" ||
          msg.reason === "invalid_state" ||
          msg.reason === "file_too_large" ||
          msg.reason === "send_failed")
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

  async function sendSimpleSignal(
    remotePublicKeyHex: string,
    type: "reject" | "busy" | "fallback_required",
    sessionId: string,
    reason: WebrtcRejectSignal["reason"] | "busy" | WebrtcFallbackRequiredSignal["reason"],
    extra: { suggestedMode?: WebrtcMode } = {}
  ): Promise<void> {
    const envBase = buildEnvelopeBase({ sessionId, nowMs: env.now() });
    let body: string;
    if (type === "reject") {
      body = serializeSignal({
        ...envBase,
        type: "reject",
        reason: reason as WebrtcRejectSignal["reason"]
      });
    } else if (type === "busy") {
      body = serializeSignal({
        ...envBase,
        type: "busy",
        reason: "busy"
      });
    } else {
      body = serializeSignal({
        ...envBase,
        type: "fallback_required",
        reason: "video_unavailable",
        suggestedMode: extra.suggestedMode ?? "audio"
      });
    }
    try {
      await endpoint.sendMessage({
        recipientPublicKeyHex: remotePublicKeyHex,
        recipientAppId: KEYMASTER_WEBRTC_APP_ID,
        contentType: "text/plain",
        body,
        clientMessageId: `km-wbrtc-${type}-${sessionId}`,
        createdAtMs: envBase.createdAtMs
      });
    } catch {
      // 静默——对端离线也无所谓
    }
  }

  async function sendIce(
    sessionId: string,
    remotePublicKeyHex: string,
    candidate: RTCIceCandidateInit,
    scope: "call" | "transfer" = "call"
  ): Promise<void> {
    const matchesCall = active?.sessionId === sessionId;
    const matchesTransfer = activeTransfer?.sessionId === sessionId;
    if (!matchesCall && !matchesTransfer) return;
    const envBase = buildEnvelopeBase({ sessionId, nowMs: env.now() });
    // 通话与传输共用同一套 ICE 信令，scope 只用于诊断命名。
    const body = serializeSignal({
      ...envBase,
      type: "ice",
      candidate
    });
    try {
      await endpoint.sendMessage({
        recipientPublicKeyHex: remotePublicKeyHex,
        recipientAppId: KEYMASTER_WEBRTC_APP_ID,
        contentType: "text/plain",
        body,
        clientMessageId: `km-wrtc-ice-${scope}-${sessionId}`,
        createdAtMs: envBase.createdAtMs
      });
    } catch {
      // ignore
    }
  }

  /* ----- 出站（拨号）----- */

  async function checkPeerOnline(publicKeyHex: string): Promise<import("@keymaster/contracts").AppMsgOnlineStatus> {
    try {
      const result = await endpoint.checkOnline([publicKeyHex]);
      return result[publicKeyHex] ?? "unknown";
    } catch {
      return "unknown";
    }
  }

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
    if (!endpoint.isReady()) {
      throw new Error("service_not_ready");
    }
    if (active || isTransferActive()) {
      throw new Error("busy_local");
    }
    const online = await checkPeerOnline(targetPublicKeyHex);
    if (online !== "online") {
      throw new Error(online === "offline" ? "target_offline" : "target_unknown");
    }
    await startOutgoingTransfer({ targetPublicKeyHex, kind, file });
  }

  async function startCall(input: StartCallInput): Promise<void> {
    if (!endpoint.isReady()) {
      lastError = "service_not_ready";
      throw new Error("service_not_ready");
    }
    if (active || isTransferActive()) {
      lastError = "busy_local";
      throw new Error("busy_local");
    }
    const target = input.targetPublicKeyHex.trim();
    if (!/^[0-9a-f]{66}$/i.test(target)) {
      lastError = "invalid_target";
      throw new Error("invalid_target");
    }
    let online: Awaited<ReturnType<typeof endpoint.checkOnline>>;
    try {
      online = await endpoint.checkOnline([target]);
    } catch {
      online = { [target]: "unknown" };
    }
    const status = online[target];
    if (status !== "online") {
      lastError = status === "offline" ? "target_offline" : "target_unknown";
      throw new Error(
        status === "offline" ? "target_offline" : "target_unknown"
      );
    }
    let localStream: MediaStreamLike;
    try {
      localStream =
        input.mode === "audio"
          ? await env.getUserMedia({ audio: true, video: false })
          : await env.getUserMedia({ audio: true, video: true });
    } catch (err) {
      lastError = "device_unavailable";
      throw new Error("device_unavailable");
    }
    const sessionId = env.generateSessionId();
    const cfg = configToRTCConfig(store.snapshot());
    const pc = env.createPeerConnection(cfg);
    pc.replaceLocalStream(localStream);
    pc.onIceCandidate((c) => {
      void sendIce(sessionId, target, c).catch(() => undefined);
    });
    pc.onConnectionStateChange((s) => {
      const cur = active;
      if (!cur || cur.sessionId !== sessionId) return;
      if (s === "connected") {
        cur.pcConnected = true;
        emit();
        return;
      }
      if (s === "failed" || s === "disconnected" || s === "closed") {
        void doHangup("ice_disconnected");
      }
    });
    pc.onTrack((stream) => {
      const cur = active;
      if (cur && cur.sessionId === sessionId) {
        cur.remoteStream = stream;
        cur.pcConnected = true;
        emit();
      }
    });

    const newSession: ActiveSession = {
      sessionId,
      direction: "outgoing",
      mode: input.mode,
      remotePublicKeyHex: target,
      ownerPublicKeyHex: currentOwnerPublicKeyHex(),
      startedAtMs: env.now(),
      localStream,
      pc,
      remoteStream: null,
      pendingOffer: null,
      pcConnected: false,
      negotiated: false
    };
    active = newSession;
    emit();

    let offer: RTCSessionDescriptionInit;
    try {
      offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
    } catch (err) {
      log.warn("webrtc.service", "create_offer_failed", err);
      lastError = "create_offer_failed";
      // 统一走 clearActive → 释放本地 + 关 pc + emit（让 UI 看到 idle）。
      clearActive();
      throw new Error("create_offer_failed");
    }
    const envBase = buildEnvelopeBase({ sessionId, nowMs: env.now() });
    const body = serializeSignal({
      ...envBase,
      type: "invite",
      mode: input.mode,
      sdp: JSON.stringify(offer)
    });
    try {
      await endpoint.sendMessage({
        recipientPublicKeyHex: target,
        recipientAppId: KEYMASTER_WEBRTC_APP_ID,
        contentType: "text/plain",
        body,
        clientMessageId: `km-wbrtc-invite-${sessionId}`,
        createdAtMs: envBase.createdAtMs
      });
    } catch (err) {
      log.warn("webrtc.service", "send_invite_failed", err);
      lastError = "send_invite_failed";
      // invite 失败回滚——同一 clearActive 路径。
      clearActive();
      throw new Error("send_invite_failed");
    }
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

  /* ----- 订阅 endpointService + dispose ----- */

  const off = endpoint.subscribeMessages((m) => handleIncoming(m));

  function dispose(): void {
    // 单一清理路径：本地先清（截断 UI / 释放 tracks / 关 pc / 取消订阅），
    // 异步发 hangup 信令这一步仅 fire-and-forget——失败就失败。
    const session = active;
    clearActive({ showEndedPhase: true });
    off();
    subscribers.clear();
    if (session) {
      const envBase = buildEnvelopeBase({
        sessionId: session.sessionId,
        nowMs: env.now()
      });
      const body = serializeSignal({
        ...envBase,
        type: "hangup",
        reason: "page_unload"
      });
      void endpoint
        .sendMessage({
          recipientPublicKeyHex: session.remotePublicKeyHex,
          recipientAppId: KEYMASTER_WEBRTC_APP_ID,
          contentType: "text/plain",
          body,
          clientMessageId: `km-wbrtc-hangup-${envBase.sessionId}`,
          createdAtMs: envBase.createdAtMs
        })
        .catch((err) => {
          log.warn("webrtc.service", "dispose_hangup_send_failed", err);
        });
    }
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
    isReady: () => endpoint.isReady(),
    checkPeerOnline,
    listHistoryForPeer: (peerPublicKeyHex) => historyService.listForPeer(peerPublicKeyHex),
    getTransferBlob: (blobKey) => historyService.getBlob(blobKey),
    startCall,
    sendImage,
    sendFile,
    acceptIncoming,
    rejectIncoming,
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
