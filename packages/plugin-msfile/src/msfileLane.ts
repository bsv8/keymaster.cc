// MSFile 的 Window P2P lane。
//
// MSFile 只注册业务 lane；唯一 Host、lease、MessagePort bridge 由
// `plugin-window-p2p` 管理。这样 MSFile 不会在每个页面或每个业务实例
// 重复创建网络 Host。

import type {
  WindowP2pExecutorLane,
  WindowP2pExecutorLaneContext
} from "@keymaster/contracts";
import { MsFileSupplierRuntime } from "./supplierRuntime.js";
import type {
  MsFileP2pLaneOperation,
  WindowP2pExecutorConcurrencyConfig
} from "./executorTransport.js";

type MsFileHost = ConstructorParameters<typeof MsFileSupplierRuntime>[0];

export class MsFileP2pLane implements WindowP2pExecutorLane {
  readonly laneId = "msfile";
  private runtime?: MsFileSupplierRuntime;

  start(context: WindowP2pExecutorLaneContext): void {
    this.runtime = new MsFileSupplierRuntime(context.host as MsFileHost);
  }

  async stop(): Promise<void> {
    const runtime = this.runtime;
    this.runtime = undefined;
    await runtime?.dispose();
  }

  configure(config: unknown): void {
    if (!this.runtime) return;
    this.runtime.setConcurrencyConfig(config as WindowP2pExecutorConcurrencyConfig);
  }

  async handle(operation: unknown, signal: AbortSignal): Promise<unknown> {
    const runtime = this.runtime;
    if (!runtime) throw new Error("MSFile lane is not attached");
    const value = operation as MsFileP2pLaneOperation;
    switch (value.type) {
      case "stat": return runtime.stat({ ...value, signal });
      case "read": return runtime.read({ ...value, signal });
      case "probe": return runtime.probe({ ...value, signal });
      case "invalidate": await runtime.invalidate(value.supplierPublicKeyHex); return null;
      default: throw new Error("MSFile lane operation is invalid");
    }
  }
}
