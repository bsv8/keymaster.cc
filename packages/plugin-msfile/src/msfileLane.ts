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
import { createBitfsArbitrationClient, type BitfsArbitrationTransport } from "./bitfs/arbitrationClient.js";
import { BitfsStreamRuntime } from "./bitfs/sellerStreamRuntime.js";
import type { WindowWebRtcInterconnectContext } from "@keymaster/contracts/window-p2p";
import { BitfsWebRtcStreamRuntime, type BitfsWebRtcHost } from "./bitfs/webrtcStreamRuntime.js";
import { MsFileSupplierRuntime } from "./supplierRuntime.js";
import type {
  MsFileP2pLaneOperation,
  WindowP2pExecutorConcurrencyConfig
} from "./executorTransport.js";

type MsFileHost = ConstructorParameters<typeof MsFileSupplierRuntime>[0];

export class MsFileP2pLane implements WindowP2pExecutorLane {
  readonly laneId = "msfile";
  private runtime?: MsFileSupplierRuntime;
  private arbitration?: BitfsArbitrationTransport;
  private bitfs?: BitfsStreamRuntime;
  private bitfsWebRtc?: BitfsWebRtcStreamRuntime;
  private ownerSessionEpoch = "";

  constructor(
    /** P2PKH 受控预签能力；P2PKH 未启用时专款准备保持不可用。 */
    private readonly protocolSpend?: ProtocolSpendService | (() => ProtocolSpendService | undefined),
    /** WebRTC DataChannel 的 STUN 配置；当前使用项目默认 STUN。 */
    private readonly stunServers: () => readonly string[] = () => ["stun:stun.l.google.com:19302"],
  ) {}

  start(context: WindowP2pExecutorLaneContext): void {
    this.ownerSessionEpoch = context.ownerSessionEpoch ?? "";
    this.runtime = new MsFileSupplierRuntime(context.host as MsFileHost);
    this.arbitration = createBitfsArbitrationClient({
      host: context.host as MsFileHost,
      allowLoopbackWs: (import.meta as ImportMeta & { env?: { VITE_BITFS_ALLOW_LOOPBACK_WS?: string } }).env?.VITE_BITFS_ALLOW_LOOPBACK_WS === "true",
    });
    this.bitfs = new BitfsStreamRuntime({
      host: context.host as MsFileHost,
      emit: (event, transfer) => context.emit(event, transfer),
      ownerSessionEpoch: context.ownerSessionEpoch ?? "",
    });
    const interconnect = (context as WindowP2pExecutorLaneContext & { webRtcInterconnect?: WindowWebRtcInterconnectContext }).webRtcInterconnect;
    if (interconnect != null) {
      this.bitfsWebRtc = new BitfsWebRtcStreamRuntime({
        interconnect,
        host: context.host as BitfsWebRtcHost,
        stunServers: this.stunServers,
        emit: (event, transfer) => context.emit(event, transfer),
        onError: (error, errorContext) => {
          const eventError = error && typeof error === "object" && "error" in error
            ? (error as { error?: unknown }).error
            : undefined;
          void context.emit({
            type: "bitfs-webrtc-runtime-error",
            sessionId: errorContext.sessionId,
            webrtcSessionId: errorContext.webrtcSessionId,
            ownerSessionEpoch: context.ownerSessionEpoch ?? "",
            direction: errorContext.direction,
            message: error instanceof Error ? error.message : eventError === undefined ? String(error) : String(eventError),
            name: error instanceof Error ? error.name : eventError === undefined ? typeof error : "RTCErrorEvent",
          });
        },
        ownerSessionEpoch: context.ownerSessionEpoch ?? "",
        streamMeter: (input) => {
          // 字节与帧计量在流建立处挂载；按 500ms 聚合上报，避免逐块过桥。
          const record = { bytesIn: 0, bytesOut: 0, lastActivityAt: 0 };
          let pending: ReturnType<typeof setTimeout> | undefined;
          const flush = () => {
            pending = undefined;
            Promise.resolve(context.emit({
              type: "bitfs-webrtc-meter",
              sessionId: input.sessionId,
              webrtcSessionId: input.webrtcSessionId,
              ownerSessionEpoch: context.ownerSessionEpoch ?? "",
              bytesIn: record.bytesIn,
              bytesOut: record.bytesOut,
              lastActivityAt: record.lastActivityAt,
            })).catch(() => undefined);
          };
          const schedule = () => { if (pending === undefined) pending = setTimeout(flush, 500); };
          return {
            bytesIn(bytes: number) { record.bytesIn += bytes; record.lastActivityAt = Date.now(); schedule(); },
            bytesOut(bytes: number) { record.bytesOut += bytes; record.lastActivityAt = Date.now(); schedule(); },
            frameReceived() { schedule(); },
            frameSent() { schedule(); },
          };
        },
      });
    }
  }

  async stop(): Promise<void> {
    const runtime = this.runtime;
    const bitfs = this.bitfs;
    const bitfsWebRtc = this.bitfsWebRtc;
    this.runtime = undefined;
    this.arbitration = undefined;
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
    if (value.type === "bitfs-arbitration-info") {
      if (!this.arbitration?.info) throw new Error("仲裁网络未就绪");
      return this.arbitration.info({ endpoint: value.endpoint, signal });
    }
    if (value.type === "bitfs-arbitration-exchange") {
      if (!this.arbitration) throw new Error("MSFile 仲裁传输未挂载");
      return this.arbitration.exchange({ endpoint: value.endpoint, request: value.request, signal });
    }
    if (value.type === "bitfs-funding-prepare") {
      const protocolSpend = this.getProtocolSpend();
      if (!protocolSpend) throw new Error("P2PKH protocol spend capability is unavailable");
      if (signal.aborted) throw new DOMException("BitFS funding prepare was cancelled", "AbortError");
      const preview = await protocolSpend.presign(value.input);
      if (signal.aborted) {
        await protocolSpend.releasePrepared?.(preview);
        throw new DOMException("BitFS funding prepare was cancelled", "AbortError");
      }
      return preview;
    }
    if (value.type === "bitfs-funding-release") {
      const protocolSpend = this.getProtocolSpend();
      if (!protocolSpend?.releasePrepared) throw new Error("P2PKH prepared-spend release is unavailable");
      await protocolSpend.releasePrepared(value.preview);
      return null;
    }
    if (value.type === "bitfs-funding-release-submission") {
      const protocolSpend = this.getProtocolSpend();
      if (!protocolSpend?.releasePreparedSubmission) throw new Error("P2PKH prepared-submission release is unavailable");
      await protocolSpend.releasePreparedSubmission({
        txid: value.txid,
        submissionId: value.submissionId,
      });
      return null;
    }
    if (value.type === "bitfs-seller-open") {
      const bitfs = this.bitfs;
      if (!bitfs) throw new Error("MSFile lane is not attached");
      if (signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
      if (value.transport === "webrtc-sdp") {
        const bitfsWebRtc = this.bitfsWebRtc;
        if (!bitfsWebRtc) throw new Error("MSFile lane WebRTC runtime is not attached");
        return bitfsWebRtc.createOffer({
          sessionId: value.sessionId,
          requestMessageId: value.requestMessageId!,
          webrtcSessionId: value.webrtcSessionId!,
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
    if (value.type === "bitfs-webrtc-buyer-offer") {
      const bitfsWebRtc = this.bitfsWebRtc;
      if (!bitfsWebRtc) throw new Error("MSFile lane WebRTC runtime is not attached");
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
      if (bitfsWebRtc?.has(value.sessionId)) await bitfsWebRtc.send(value.sessionId, value.frame);
      else if (bitfs) await bitfs.send(value.sessionId, value.frame);
      else throw new Error("MSFile lane BitFS session is not open");
      return null;
    }
    if (value.type === "bitfs-seller-close") {
      const bitfs = this.bitfs;
      const bitfsWebRtc = this.bitfsWebRtc;
      if (!bitfs && !bitfsWebRtc) throw new Error("MSFile lane is not attached");
      if (bitfsWebRtc?.has(value.sessionId)) await bitfsWebRtc.close(value.sessionId, value.reason ?? "worker_closed");
      else await bitfs?.close(value.sessionId, value.reason ?? "worker_closed");
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

  private getProtocolSpend(): ProtocolSpendService | undefined {
    return typeof this.protocolSpend === "function" ? this.protocolSpend() : this.protocolSpend;
  }

  private bitfsOwnerSessionEpoch(): string {
    return this.ownerSessionEpoch;
  }
}
