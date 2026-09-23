// MSFile 的 Window P2P lane。
//
// MSFile 只注册业务 lane；唯一 Host、lease、MessagePort bridge 由
// `plugin-window-p2p` 管理。这样 MSFile 不会在每个页面或每个业务实例
// 重复创建网络 Host。

import type {
  WindowP2pExecutorLane,
  WindowP2pExecutorLaneContext,
  ProtocolSpendService,
} from "@keymaster/contracts";
import { BitfsStreamRuntime } from "./bitfs/sellerStreamRuntime.js";
import { BitfsWebRtcStreamRuntime } from "./bitfs/webrtcStreamRuntime.js";
import { MsFileSupplierRuntime } from "./supplierRuntime.js";
import type {
  MsFileP2pLaneOperation,
  WindowP2pExecutorConcurrencyConfig
} from "./executorTransport.js";

type MsFileHost = ConstructorParameters<typeof MsFileSupplierRuntime>[0];

export class MsFileP2pLane implements WindowP2pExecutorLane {
  readonly laneId = "msfile";
  private runtime?: MsFileSupplierRuntime;
  private bitfs?: BitfsStreamRuntime;
  private bitfsWebRtc?: BitfsWebRtcStreamRuntime;
  private ownerSessionEpoch = "";

  constructor(
    /** P2PKH 受控预签能力；P2PKH 未启用时专款准备保持不可用。 */
    private readonly protocolSpend?: ProtocolSpendService,
    /** 当前 WebRTC 插件的 STUN 配置；未启用插件时使用项目默认 STUN。 */
    private readonly stunServers: () => readonly string[] = () => ["stun:stun.l.google.com:19302"],
  ) {}

  start(context: WindowP2pExecutorLaneContext): void {
    this.ownerSessionEpoch = context.ownerSessionEpoch ?? "";
    this.runtime = new MsFileSupplierRuntime(context.host as MsFileHost);
    // BitFS stream 与供应商读取共用唯一 Host；owner/session epoch 写入事件 fence。
    this.bitfs = new BitfsStreamRuntime({
      host: context.host as MsFileHost,
      emit: (event, transfer) => context.emit(event, transfer),
      ownerSessionEpoch: context.ownerSessionEpoch ?? "",
    });
    this.bitfsWebRtc = new BitfsWebRtcStreamRuntime({
      stunServers: this.stunServers,
      emit: (event, transfer) => context.emit(event, transfer),
      ownerSessionEpoch: context.ownerSessionEpoch ?? "",
    });
  }

  async stop(): Promise<void> {
    const runtime = this.runtime;
    const bitfs = this.bitfs;
    const bitfsWebRtc = this.bitfsWebRtc;
    this.runtime = undefined;
    this.bitfs = undefined;
    this.bitfsWebRtc = undefined;
    this.ownerSessionEpoch = "";
    await bitfsWebRtc?.dispose().catch(() => undefined);
    await bitfs?.dispose().catch(() => undefined);
    await runtime?.dispose();
  }

  configure(config: unknown): void {
    if (!this.runtime) return;
    this.runtime.setConcurrencyConfig(config as WindowP2pExecutorConcurrencyConfig);
  }

  async handle(operation: unknown, signal: AbortSignal): Promise<unknown> {
    const runtime = this.runtime;
    const value = operation as MsFileP2pLaneOperation;
    if (value.type === "bitfs-funding-prepare") {
      if (!this.protocolSpend) throw new Error("P2PKH protocol spend capability is unavailable");
      if (signal.aborted) throw new DOMException("BitFS funding prepare was cancelled", "AbortError");
      const preview = await this.protocolSpend.prepare(value.input);
      if (signal.aborted) {
        await this.protocolSpend.releasePrepared?.(preview);
        throw new DOMException("BitFS funding prepare was cancelled", "AbortError");
      }
      return preview;
    }
    if (value.type === "bitfs-funding-release") {
      if (!this.protocolSpend?.releasePrepared) throw new Error("P2PKH prepared-spend release is unavailable");
      await this.protocolSpend.releasePrepared(value.preview);
      return null;
    }
    if (value.type === "bitfs-funding-release-submission") {
      if (!this.protocolSpend?.releasePreparedSubmission) throw new Error("P2PKH prepared-submission release is unavailable");
      await this.protocolSpend.releasePreparedSubmission({
        ownerPublicKeyHex: value.ownerPublicKeyHex,
        network: value.network,
        txid: value.txid,
        submissionId: value.submissionId,
      });
      return null;
    }
    if (value.type === "bitfs-seller-open") {
      const bitfs = this.bitfs;
      if (!bitfs) throw new Error("MSFile lane is not attached");
      this.assertBitfsOpen(value, signal);
      if (value.transport === "webrtc-sdp") {
        const bitfsWebRtc = this.bitfsWebRtc;
        if (!bitfsWebRtc || !value.requestMessageId || !value.webrtcSessionId) {
          throw new Error("MSFile lane WebRTC request relation is incomplete");
        }
        return bitfsWebRtc.createOffer({
          sessionId: value.sessionId,
          requestMessageId: value.requestMessageId,
          webrtcSessionId: value.webrtcSessionId,
          peerPublicKeyHex: value.publicKeyHex,
          firstFrame: value.firstFrame,
          ownerSessionEpoch: this.bitfsOwnerSessionEpoch(),
          signal,
        });
      }
      await bitfs.open({
        sessionId: value.sessionId,
        addresses: value.addresses,
        publicKeyHex: value.publicKeyHex,
        expectedPeerId: value.expectedPeerId,
        firstFrame: value.firstFrame,
        signal,
      });
      return null;
    }
    if (value.type === "bitfs-webrtc-buyer-answer") {
      const bitfsWebRtc = this.bitfsWebRtc;
      if (!bitfsWebRtc) throw new Error("MSFile lane WebRTC runtime is not attached");
      if (typeof value.sessionId !== "string" || typeof value.requestMessageId !== "string"
        || typeof value.webrtcSessionId !== "string" || typeof value.publicKeyHex !== "string"
        || typeof value.offerSdp !== "string") throw new Error("MSFile lane WebRTC buyer offer is invalid");
      return bitfsWebRtc.acceptOffer({
        sessionId: value.sessionId,
        requestMessageId: value.requestMessageId,
        webrtcSessionId: value.webrtcSessionId,
        peerPublicKeyHex: value.publicKeyHex,
        offerSdp: value.offerSdp,
        ownerSessionEpoch: this.bitfsOwnerSessionEpoch(),
        signal,
      });
    }
    if (value.type === "bitfs-webrtc-signal") {
      const bitfsWebRtc = this.bitfsWebRtc;
      if (!bitfsWebRtc) throw new Error("MSFile lane WebRTC runtime is not attached");
      if (typeof value.sessionId !== "string" || typeof value.requestMessageId !== "string"
        || typeof value.webrtcSessionId !== "string" || typeof value.publicKeyHex !== "string"
        || !value.signal || typeof value.signal !== "object") throw new Error("MSFile lane WebRTC signal is invalid");
      await bitfsWebRtc.applySignal({
        sessionId: value.sessionId,
        requestMessageId: value.requestMessageId,
        webrtcSessionId: value.webrtcSessionId,
        peerPublicKeyHex: value.publicKeyHex,
        signal: value.signal,
        ownerSessionEpoch: this.bitfsOwnerSessionEpoch(),
      });
      return null;
    }
    if (value.type === "bitfs-seller-send") {
      const bitfs = this.bitfs;
      const bitfsWebRtc = this.bitfsWebRtc;
      if (!bitfs && !bitfsWebRtc) throw new Error("MSFile lane is not attached");
      if (typeof value.sessionId !== "string" || !(value.frame instanceof Uint8Array)) {
        throw new Error("MSFile lane BitFS send operation is invalid");
      }
      if (bitfsWebRtc?.has(value.sessionId)) await bitfsWebRtc.send(value.sessionId, value.frame);
      else if (bitfs) await bitfs.send(value.sessionId, value.frame);
      else throw new Error("MSFile lane BitFS session is not open");
      return null;
    }
    if (value.type === "bitfs-seller-close") {
      const bitfs = this.bitfs;
      const bitfsWebRtc = this.bitfsWebRtc;
      if (!bitfs && !bitfsWebRtc) throw new Error("MSFile lane is not attached");
      if (typeof value.sessionId !== "string" || value.sessionId.length === 0) {
        throw new Error("MSFile lane BitFS close operation is invalid");
      }
      if (bitfsWebRtc?.has(value.sessionId)) await bitfsWebRtc.close(value.sessionId, typeof value.reason === "string" ? value.reason : "worker_closed");
      else await bitfs?.close(value.sessionId, typeof value.reason === "string" ? value.reason : "worker_closed");
      return null;
    }
    if (!runtime) throw new Error("MSFile lane is not attached");
    switch (value.type) {
      case "stat": return runtime.stat({ ...value, signal });
      case "read": return runtime.read({ ...value, signal });
      case "probe": return runtime.probe({ ...value, signal });
      case "invalidate": await runtime.invalidate(value.supplierPublicKeyHex); return null;
      default: throw new Error("MSFile lane operation is invalid");
    }
  }

  /** BitFS open 的输入形状门禁；字节内容仍由 stream runtime 严格解析。 */
  private assertBitfsOpen(
    value: Extract<MsFileP2pLaneOperation, { type: "bitfs-seller-open" }>,
    signal: AbortSignal,
  ): void {
    if (typeof value.sessionId !== "string" || value.sessionId.length === 0 || value.sessionId.length > 128) {
      throw new Error("MSFile lane BitFS session id is invalid");
    }
    if (value.transport === "webrtc-sdp") {
      if (!value.requestMessageId || value.requestMessageId.length > 128 || !value.webrtcSessionId || value.webrtcSessionId.length > 128) {
        throw new Error("MSFile lane BitFS WebRTC request relation is invalid");
      }
    } else if (!Array.isArray(value.addresses) || value.addresses.length === 0 || value.addresses.length > 16
      || value.addresses.some((address) => typeof address !== "string" || address.length === 0 || address.length > 512)) {
      throw new Error("MSFile lane BitFS locator list is invalid");
    }
    if (typeof value.publicKeyHex !== "string" || !/^(02|03)[0-9a-f]{64}$/u.test(value.publicKeyHex)) {
      throw new Error("MSFile lane BitFS public key is invalid");
    }
    if (typeof value.expectedPeerId !== "string" || value.expectedPeerId.length === 0 || value.expectedPeerId.length > 128) {
      throw new Error("MSFile lane BitFS PeerId is invalid");
    }
    if (!(value.firstFrame instanceof Uint8Array) || value.firstFrame.byteLength === 0) {
      throw new Error("MSFile lane BitFS first frame is invalid");
    }
    if (signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
  }

  private bitfsOwnerSessionEpoch(): string {
    return this.ownerSessionEpoch;
  }
}
