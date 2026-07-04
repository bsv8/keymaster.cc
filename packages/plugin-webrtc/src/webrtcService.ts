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
import { KEYMASTER_WEBRTC_APP_ID } from "./constants.js";
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
  type WebrtcSignal
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
  startCall(input: StartCallInput): Promise<void>;
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
  replaceLocalStream(stream: MediaStreamLike | null): void;
  /** 创建一个 data channel；测试 / 诊断路径使用。真实业务连接不需要主动开。 */
  createDataChannel(label: string): unknown;
  close(): void;
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
  let localStream: MediaStream | null = null;

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
    replaceLocalStream: (stream) => {
      const senders = pc.getSenders();
      if (stream === null) {
        for (const s of senders) s.replaceTrack(null).catch(() => undefined);
        localStream?.getTracks().forEach((t) => t.stop());
        localStream = null;
        return;
      }
      const ms = stream.native;
      if (!(ms instanceof MediaStream)) return;
      const tracks = ms.getTracks();
      for (const s of senders) {
        const kind = s.track?.kind;
        const track = kind ? tracks.find((t) => t.kind === kind) : undefined;
        if (track) s.replaceTrack(track).catch(() => undefined);
      }
      localStream?.getTracks().forEach((t) => t.stop());
      localStream = ms;
    },
    createDataChannel: (label) => pc.createDataChannel(label),
    close: () => pc.close()
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
  configStore: WebrtcConfigStore;
  env?: WebrtcEnvironment;
  logger?: WebrtcLogger;
}): WebrtcService {
  const endpoint = input.endpointService;
  const store = input.configStore;
  const env = input.env ?? createBrowserWebrtcEnvironment();
  const log: WebrtcLogger = input.logger ?? silentLogger();

  interface ActiveSession {
    sessionId: string;
    direction: "outgoing" | "incoming";
    mode: WebrtcMode;
    remotePublicKeyHex: string;
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

  /** `ended` 过渡态：UI 在 ttl 内可见，过了之后清空回 idle。 */
  let endedDeadlineAt: number | null = null;

  let remoteNotice: WebrtcRemoteNotice | null = null;
  let lastError: WebrtcBlockReason | null = null;
  const subscribers = new Set<WebrtcSubscriber>();

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
    const localSession = active?.sessionId ?? null;
    if (!isAcceptableRemoteSessionId(sig, localSession)) return;
    const remote = msg.senderPublicKeyHex;
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
        localStream: stream,
        pc: null,
        remoteStream: null,
        pendingOffer: parsedOffer,
        pcConnected: false,
        negotiated: false
      };
      emit();
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
        localStream: stream,
        pc: null,
        remoteStream: null,
        pendingOffer: parsedOfferVideo,
        pcConnected: false,
        negotiated: false
      };
      emit();
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
      void sendIce(session.sessionId, session.remotePublicKeyHex, c).catch(() => undefined);
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
    candidate: RTCIceCandidateInit
  ): Promise<void> {
    if (!active || active.sessionId !== sessionId) return;
    const envBase = buildEnvelopeBase({ sessionId, nowMs: env.now() });
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
        clientMessageId: `km-wbrtc-ice-${sessionId}`,
        createdAtMs: envBase.createdAtMs
      });
    } catch {
      // ignore
    }
  }

  /* ----- 出站（拨号）----- */

  async function startCall(input: StartCallInput): Promise<void> {
    if (!endpoint.isReady()) {
      lastError = "service_not_ready";
      throw new Error("service_not_ready");
    }
    if (active) {
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
      throw new Error(
        `device_unavailable: ${err instanceof Error ? err.message : String(err)}`
      );
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
      throw err;
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
      throw new Error(
        `send_invite_failed: ${err instanceof Error ? err.message : String(err)}`
      );
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
    startCall,
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
