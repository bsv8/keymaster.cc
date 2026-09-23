// MSFile 的 Window P2P lane。
//
// MSFile 只注册业务 lane；唯一 Host、lease、MessagePort bridge 由
// `plugin-window-p2p` 管理。这样 MSFile 不会在每个页面或每个业务实例
// 重复创建网络 Host。

import type {
  WindowP2pExecutorLane,
  WindowP2pExecutorLaneContext
} from "@keymaster/contracts";
import { BitfsStreamRuntime } from "./bitfs/sellerStreamRuntime.js";
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

  start(context: WindowP2pExecutorLaneContext): void {
    this.runtime = new MsFileSupplierRuntime(context.host as MsFileHost);
    // BitFS stream 与供应商读取共用唯一 Host；owner/session epoch 写入事件 fence。
    this.bitfs = new BitfsStreamRuntime({
      host: context.host as MsFileHost,
      emit: (event, transfer) => context.emit(event, transfer),
      ownerSessionEpoch: context.ownerSessionEpoch ?? "",
    });
  }

  async stop(): Promise<void> {
    const runtime = this.runtime;
    const bitfs = this.bitfs;
    this.runtime = undefined;
    this.bitfs = undefined;
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
    if (value.type === "bitfs-seller-open") {
      const bitfs = this.bitfs;
      if (!bitfs) throw new Error("MSFile lane is not attached");
      this.assertBitfsOpen(value, signal);
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
    if (value.type === "bitfs-seller-send") {
      const bitfs = this.bitfs;
      if (!bitfs) throw new Error("MSFile lane is not attached");
      if (typeof value.sessionId !== "string" || !(value.frame instanceof Uint8Array)) {
        throw new Error("MSFile lane BitFS send operation is invalid");
      }
      await bitfs.send(value.sessionId, value.frame);
      return null;
    }
    if (value.type === "bitfs-seller-close") {
      const bitfs = this.bitfs;
      if (!bitfs) throw new Error("MSFile lane is not attached");
      if (typeof value.sessionId !== "string" || value.sessionId.length === 0) {
        throw new Error("MSFile lane BitFS close operation is invalid");
      }
      await bitfs.close(value.sessionId, typeof value.reason === "string" ? value.reason : "worker_closed");
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
    if (!Array.isArray(value.addresses) || value.addresses.length === 0 || value.addresses.length > 16
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
}
