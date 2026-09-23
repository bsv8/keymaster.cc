// BitFS 的 SDP WebRTC DataChannel 承载层。
//
// 中文说明：ChannelProtocol 负责验证 Hash 请求与私密 SDP/ICE 信令；本模块
// 只创建浏览器 PeerConnection，并在 DataChannel 中收发 go-bitfs Artifact。

import { MAX_WIRE_FRAME_BYTES, parse } from "go-bitfs";

/** BitFS SDP 会话发回 Worker 的事件。 */
export type BitfsWebRtcStreamEvent =
  | {
    /** 一条经过 go-bitfs parser 校验的入站 Artifact。 */
    type: "bitfs-webrtc-frame";
    /** Worker 侧 BitFS 销售或发现会话编号。 */
    sessionId: string;
    /** ChannelProtocol offer 中的 session_id。 */
    webrtcSessionId: string;
    /** 创建连接时的 owner 会话世代。 */
    ownerSessionEpoch: string;
    /** canonical Artifact 精确字节。 */
    frame: Uint8Array;
  }
  | {
    /** 连接不可继续使用。 */
    type: "bitfs-webrtc-session-closed";
    /** Worker 侧 BitFS 销售或发现会话编号。 */
    sessionId: string;
    /** ChannelProtocol offer 中的 session_id。 */
    webrtcSessionId: string;
    /** 创建连接时的 owner 会话世代。 */
    ownerSessionEpoch: string;
    /** 稳定关闭原因。 */
    reason: string;
  };

interface WebRtcEntry {
  /** Worker 侧 BitFS 会话编号。 */
  sessionId: string;
  /** ChannelProtocol offer 中的 session_id。 */
  webrtcSessionId: string;
  /** 关联的 Hash 请求 message_id。 */
  requestMessageId: string;
  /** 已验签信令发送者公钥。 */
  peerPublicKeyHex: string;
  /** 创建连接时的 owner 会话世代。 */
  ownerSessionEpoch: string;
  /** 浏览器 PeerConnection。 */
  peerConnection: RTCPeerConnection;
  /** BitFS 二进制 DataChannel。 */
  dataChannel?: RTCDataChannel;
  /** 卖方在 DataChannel 打开后要发送的精确 Kind 1 报价。 */
  firstFrame?: Uint8Array;
  /** 是否已经发送首帧报价。 */
  firstFrameSent: boolean;
  /** 本地关闭标记。 */
  closed: boolean;
}

export interface BitfsWebRtcStreamRuntimeOptions {
  /** 浏览器配置的 STUN 地址；每次建连时读取当前值。 */
  stunServers(): readonly string[];
  /** 会话事件回传 Coordinator Worker。 */
  emit(event: BitfsWebRtcStreamEvent, transfer?: Transferable[]): Promise<void> | void;
  /** 当前 owner 会话世代；用于丢弃旧 Key 的迟到事件。 */
  ownerSessionEpoch: string;
  /** SDP ICE gathering 等待上限，默认 20 秒。 */
  gatherTimeoutMs?: number;
}

/** 只提供 WebRTC SDP 模式，不包含 libp2p Host 或 Channel 密钥。 */
export class BitfsWebRtcStreamRuntime {
  private readonly sessions = new Map<string, WebRtcEntry>();
  private disposed = false;

  constructor(private readonly options: BitfsWebRtcStreamRuntimeOptions) {}

  /** 会话编号是否属于当前 WebRTC runtime。 */
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** 创建卖方 offer，并在 DataChannel 打开后发送已持久化报价。 */
  async createOffer(input: {
    /** Worker 侧 BitFS 销售会话编号。 */
    sessionId: string;
    /** ChannelProtocol Hash 请求 message_id。 */
    requestMessageId: string;
    /** ChannelProtocol offer/answer/ICE 共用的 session_id。 */
    webrtcSessionId: string;
    /** Hash 请求的已验签发布者公钥。 */
    peerPublicKeyHex: string;
    /** 先落盘的 exact Kind 1 报价字节。 */
    firstFrame: Uint8Array;
    /** 当前 Window lease 的 owner 世代。 */
    ownerSessionEpoch: string;
    /** 取消本次建连。 */
    signal?: AbortSignal;
  }): Promise<{ sdp: string }> {
    this.assertOpen(input.sessionId, input.ownerSessionEpoch, input.signal);
    if (this.sessions.has(input.sessionId)) throw new Error("BitFS WebRTC session id already exists");
    const quote = parse(input.firstFrame.slice()).bytes();
    if (quote.byteLength === 0 || quote.byteLength > MAX_WIRE_FRAME_BYTES) throw new Error("BitFS WebRTC quote frame is invalid");
    const entry = this.createEntry(input);
    entry.firstFrame = quote;
    this.sessions.set(input.sessionId, entry);
    try {
      const channel = entry.peerConnection.createDataChannel("bitfs");
      this.attachDataChannel(entry, channel);
      const offer = await entry.peerConnection.createOffer();
      await entry.peerConnection.setLocalDescription(offer);
      await this.waitForIceGathering(entry, input.signal);
      this.assertEntryCurrent(entry);
      const sdp = entry.peerConnection.localDescription?.sdp;
      if (!sdp) throw new Error("BitFS WebRTC offer SDP is empty");
      return { sdp };
    } catch (error) {
      await this.closeEntry(entry, "offer_failed", false);
      throw error;
    }
  }

  /** 接受买方需求对应的已验签 offer，并返回含完整 ICE 候选的 answer。 */
  async acceptOffer(input: {
    /** Worker 侧 BitFS 购买会话编号。 */
    sessionId: string;
    /** ChannelProtocol Hash 请求 message_id。 */
    requestMessageId: string;
    /** ChannelProtocol offer/answer/ICE 共用的 session_id。 */
    webrtcSessionId: string;
    /** 已验签 offer 发送者公钥。 */
    peerPublicKeyHex: string;
    /** ChannelProtocol 已解码的 offer SDP。 */
    offerSdp: string;
    /** 当前 Window lease 的 owner 世代。 */
    ownerSessionEpoch: string;
    /** 取消本次建连。 */
    signal?: AbortSignal;
  }): Promise<{ sdp: string }> {
    this.assertOpen(input.sessionId, input.ownerSessionEpoch, input.signal);
    if (this.sessions.has(input.sessionId)) throw new Error("BitFS WebRTC session id already exists");
    if (typeof input.offerSdp !== "string" || input.offerSdp.length === 0 || input.offerSdp.length > 256_000) {
      throw new Error("BitFS WebRTC offer SDP is invalid");
    }
    const entry = this.createEntry(input);
    this.sessions.set(input.sessionId, entry);
    entry.peerConnection.ondatachannel = (event) => {
      if (this.sessions.get(entry.sessionId) !== entry || entry.closed) return;
      if (event.channel.label !== "bitfs" || entry.dataChannel) {
        void this.closeEntry(entry, "invalid_datachannel", true);
        return;
      }
      this.attachDataChannel(entry, event.channel);
    };
    try {
      await entry.peerConnection.setRemoteDescription({ type: "offer", sdp: input.offerSdp });
      const answer = await entry.peerConnection.createAnswer();
      await entry.peerConnection.setLocalDescription(answer);
      await this.waitForIceGathering(entry, input.signal);
      this.assertEntryCurrent(entry);
      const sdp = entry.peerConnection.localDescription?.sdp;
      if (!sdp) throw new Error("BitFS WebRTC answer SDP is empty");
      return { sdp };
    } catch (error) {
      await this.closeEntry(entry, "answer_failed", false);
      throw error;
    }
  }

  /** 应用同一 ChannelProtocol WebRTC 会话的 answer、ICE 或结束标记。 */
  async applySignal(input: {
    /** Worker 侧 BitFS 会话编号。 */
    sessionId: string;
    /** 必须与已建立连接完全相同。 */
    requestMessageId: string;
    /** 必须与已建立连接完全相同。 */
    webrtcSessionId: string;
    /** 已验签信令发送者公钥。 */
    peerPublicKeyHex: string;
    /** ChannelProtocol 校验过的非 offer 信令。 */
    signal: Record<string, unknown>;
    /** 当前 Window lease 的 owner 世代。 */
    ownerSessionEpoch: string;
  }): Promise<void> {
    const entry = this.sessions.get(input.sessionId);
    if (!entry || entry.closed) throw new Error("BitFS WebRTC session is not open");
    this.assertEntryCurrent(entry);
    if (entry.requestMessageId !== input.requestMessageId || entry.webrtcSessionId !== input.webrtcSessionId
      || entry.peerPublicKeyHex !== input.peerPublicKeyHex.toLowerCase()
      || entry.ownerSessionEpoch !== input.ownerSessionEpoch) {
      throw new Error("BitFS WebRTC signal relation does not match the session");
    }
    if (input.signal.type === "answer") {
      if (entry.peerConnection.remoteDescription) throw new Error("BitFS WebRTC answer was already applied");
      const sdp = input.signal.sdp;
      if (typeof sdp !== "string" || sdp.length === 0 || sdp.length > 256_000) throw new Error("BitFS WebRTC answer SDP is invalid");
      await entry.peerConnection.setRemoteDescription({ type: "answer", sdp });
      return;
    }
    if (input.signal.type === "ice-candidate") {
      const candidate = input.signal.candidate as { candidate?: unknown; sdp_mid?: unknown; sdp_m_line_index?: unknown } | undefined;
      if (!candidate || typeof candidate.candidate !== "string") throw new Error("BitFS WebRTC ICE candidate is invalid");
      await entry.peerConnection.addIceCandidate({
        candidate: candidate.candidate,
        sdpMid: typeof candidate.sdp_mid === "string" ? candidate.sdp_mid : null,
        sdpMLineIndex: typeof candidate.sdp_m_line_index === "number" ? candidate.sdp_m_line_index : null,
      });
      return;
    }
    if (input.signal.type === "end-of-candidates") {
      await entry.peerConnection.addIceCandidate({ candidate: "" });
      return;
    }
    throw new Error("BitFS WebRTC signal type is invalid");
  }

  /** 通过已打开的 DataChannel 发送一条 exact Artifact。 */
  async send(sessionId: string, frame: Uint8Array): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.closed || !entry.dataChannel) throw new Error("BitFS WebRTC DataChannel is not open");
    const artifact = parse(frame.slice()).bytes();
    if (artifact.byteLength === 0 || artifact.byteLength > MAX_WIRE_FRAME_BYTES) throw new Error("BitFS WebRTC frame size is invalid");
    if (entry.dataChannel.readyState !== "open") throw new Error("BitFS WebRTC DataChannel is not open");
    // RTCDataChannel 的 TypeScript 类型不接受可能由 SharedArrayBuffer
    // 支撑的 Uint8Array；复制成独立 ArrayBuffer 后再交给浏览器发送。
    entry.dataChannel.send(Uint8Array.from(artifact).buffer);
  }

  /** 关闭一条 WebRTC 会话；重复调用幂等。 */
  async close(sessionId: string, reason = "closed"): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (entry) await this.closeEntry(entry, reason, false);
  }

  /** 关闭全部会话并拒绝新建。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const entry of [...this.sessions.values()]) await this.closeEntry(entry, "runtime_disposed", false);
  }

  private createEntry(input: {
    sessionId: string;
    requestMessageId: string;
    webrtcSessionId: string;
    peerPublicKeyHex: string;
    ownerSessionEpoch: string;
    firstFrame?: Uint8Array;
  }): WebRtcEntry {
    const stunServers = this.options.stunServers().filter((url) => typeof url === "string" && url.startsWith("stun:"));
    const peerConnection = new RTCPeerConnection({ iceServers: stunServers.map((url) => ({ urls: [url] })) });
    const entry: WebRtcEntry = {
      sessionId: input.sessionId,
      webrtcSessionId: input.webrtcSessionId,
      requestMessageId: input.requestMessageId,
      peerPublicKeyHex: input.peerPublicKeyHex.toLowerCase(),
      ownerSessionEpoch: input.ownerSessionEpoch,
      peerConnection,
      ...(input.firstFrame === undefined ? {} : { firstFrame: input.firstFrame.slice() }),
      firstFrameSent: false,
      closed: false,
    };
    peerConnection.onconnectionstatechange = () => {
      if (entry.closed) return;
      if (["failed", "disconnected", "closed"].includes(peerConnection.connectionState)) {
        void this.closeEntry(entry, "connection_failed", true);
      }
    };
    return entry;
  }

  private attachDataChannel(entry: WebRtcEntry, channel: RTCDataChannel): void {
    if (entry.dataChannel || channel.label !== "bitfs") {
      void this.closeEntry(entry, "invalid_datachannel", true);
      return;
    }
    entry.dataChannel = channel;
    channel.binaryType = "arraybuffer";
    channel.onopen = () => {
      if (this.sessions.get(entry.sessionId) !== entry || entry.closed) return;
      if (!entry.firstFrame || entry.firstFrameSent) return;
      entry.firstFrameSent = true;
      try {
        channel.send(Uint8Array.from(entry.firstFrame).buffer);
      } catch {
        void this.closeEntry(entry, "first_frame_send_failed", true);
      }
    };
    channel.onmessage = (event) => {
      if (this.sessions.get(entry.sessionId) !== entry || entry.closed) return;
      if (!(event.data instanceof ArrayBuffer)) {
        void this.closeEntry(entry, "malformed_wire", true);
        return;
      }
      const frame = new Uint8Array(event.data.slice(0));
      if (frame.byteLength === 0 || frame.byteLength > MAX_WIRE_FRAME_BYTES) {
        void this.closeEntry(entry, "malformed_wire", true);
        return;
      }
      try {
        const exact = parse(frame.slice()).bytes();
        if (exact.byteLength !== frame.byteLength || exact.some((byte, index) => byte !== frame[index])) {
          throw new Error("Non-canonical BitFS Artifact");
        }
        void this.options.emit({
          type: "bitfs-webrtc-frame",
          sessionId: entry.sessionId,
          webrtcSessionId: entry.webrtcSessionId,
          ownerSessionEpoch: entry.ownerSessionEpoch,
          frame,
        }, [frame.buffer]);
      } catch {
        void this.closeEntry(entry, "malformed_wire", true);
      }
    };
    channel.onerror = () => { void this.closeEntry(entry, "datachannel_error", true); };
    channel.onclose = () => { void this.closeEntry(entry, "datachannel_closed", true); };
  }

  private async waitForIceGathering(entry: WebRtcEntry, signal?: AbortSignal): Promise<void> {
    const pc = entry.peerConnection;
    if (pc.iceGatheringState === "complete") return;
    const timeoutMs = this.options.gatherTimeoutMs ?? 20_000;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error("BitFS WebRTC ICE gathering timed out")), timeoutMs);
      const onState = (): void => {
        if (pc.iceGatheringState === "complete") finish();
      };
      const onAbort = (): void => finish(new DOMException("BitFS WebRTC setup was cancelled", "AbortError"));
      const finish = (error?: Error): void => {
        clearTimeout(timeout);
        pc.removeEventListener("icegatheringstatechange", onState);
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve();
      };
      pc.addEventListener("icegatheringstatechange", onState);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
    this.assertEntryCurrent(entry);
  }

  private assertOpen(sessionId: string, ownerSessionEpoch: string, signal?: AbortSignal): void {
    if (this.disposed) throw new Error("BitFS WebRTC runtime is disposed");
    if (signal?.aborted) throw new DOMException("BitFS WebRTC setup was cancelled", "AbortError");
    if (!sessionId || sessionId.length > 128) throw new TypeError("BitFS WebRTC session id is invalid");
    if (ownerSessionEpoch !== this.options.ownerSessionEpoch) throw new Error("BitFS WebRTC owner generation changed");
  }

  private assertEntryCurrent(entry: WebRtcEntry): void {
    if (this.disposed || entry.closed || this.sessions.get(entry.sessionId) !== entry
      || entry.ownerSessionEpoch !== this.options.ownerSessionEpoch) {
      throw new Error("BitFS WebRTC session is stale");
    }
  }

  private async closeEntry(entry: WebRtcEntry, reason: string, notify: boolean): Promise<void> {
    if (entry.closed) return;
    entry.closed = true;
    this.sessions.delete(entry.sessionId);
    try { entry.dataChannel?.close(); } catch { /* 本地已经关闭。 */ }
    try { entry.peerConnection.close(); } catch { /* 本地已经关闭。 */ }
    if (notify) {
      try {
        await this.options.emit({
          type: "bitfs-webrtc-session-closed",
          sessionId: entry.sessionId,
          webrtcSessionId: entry.webrtcSessionId,
          ownerSessionEpoch: entry.ownerSessionEpoch,
          reason: /^[a-z0-9_]{1,64}$/u.test(reason) ? reason : "transport_error",
        });
      } catch {
        // Worker unavailable 时由 lease 清理连接。
      }
    }
  }
}
