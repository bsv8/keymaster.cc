import { WINDOW_P2P_WORKER_BRIDGE_CAPABILITY, type WindowP2pExecutorBridge } from "@keymaster/contracts/window-p2p";
import {
  defineBuiltinWorkerPlugin, SAT_SUBSCRIPTION_SERVICE_CAPABILITY, SAT_SUBSCRIPTION_SPI_SERVICE_CAPABILITY,
  P2PKH_WORKER_TRANSFER_CAPABILITY, STORAGE_FILE_CLIENTS_CAPABILITY,
  type BorrowedModuleFileStore, type P2pkhWorkerTransfer,
  type SatSubscriptionAdminService, type SatSubscriptionSpiService,
} from "@keymaster/contracts";

export function createSatSubscriptionWorkerPlugin(ports: {
  bindBridge(bridge: () => WindowP2pExecutorBridge | undefined): () => void;
  bindP2pkh(access: () => Promise<P2pkhWorkerTransfer | null>): () => void;
  start(instanceId: string, storage: BorrowedModuleFileStore, assertActive: () => void): Promise<{
    admin: SatSubscriptionAdminService; spi: SatSubscriptionSpiService;
    revoke(): void; dispose(): Promise<void>;
  }>;
}) {
  return defineBuiltinWorkerPlugin("sat-subscription", [SAT_SUBSCRIPTION_SERVICE_CAPABILITY, SAT_SUBSCRIPTION_SPI_SERVICE_CAPABILITY], async context => {
    const offBridge = ports.bindBridge(() => { context.scope.assertActive(); return context.optionalCapability(WINDOW_P2P_WORKER_BRIDGE_CAPABILITY)?.bind(context.consumer, context.scope); });
    context.scope.onRevoke(offBridge);
    const unbind = ports.bindP2pkh(async () => {
      context.scope.assertActive();
      const transfer = context.optionalCapability(P2PKH_WORKER_TRANSFER_CAPABILITY);
      return transfer ? transfer.getService() : null;
    });
    context.scope.onRevoke(unbind);
    const runtime = await ports.start(context.instanceId, context.capability(STORAGE_FILE_CLIENTS_CAPABILITY).bind(context.consumer, context.scope, ""), () => context.scope.assertActive());
    // Host 等待真正的退出 Promise；清理失败进入生命周期错误状态。
    context.scope.onRevoke(runtime.revoke);
    context.onDispose(runtime.dispose);
    context.scope.assertActive();
    context.provide(SAT_SUBSCRIPTION_SERVICE_CAPABILITY, runtime.admin);
    context.provide(SAT_SUBSCRIPTION_SPI_SERVICE_CAPABILITY, runtime.spi);
  });
}

export { createSatWorkerLifecycle, type SatWorkerRuntimeState, type SatCleanupPhase } from "./workerLifecycle.js";

export { createChannelWorkerRuntime } from "./workerChannel.js";
