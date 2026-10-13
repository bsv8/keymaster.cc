import { defineBuiltinWorkerPlugin, VAULT_WALLET_STATE_CAPABILITY, P2PKH_ASSET_READER_CAPABILITY, STORAGE_KV_CLIENTS_CAPABILITY, WOC_STAS_CAPABILITY, type WorkerTaskRegistrar, type AssetDataInvalidationEvent } from "@keymaster/contracts";
import { createStasCoordinatorTask } from "./coordinator.js";

/** 资产插件拥有任务定义与实例，公共调度器只负责运行和排空。 */
export function createTokenStasWorkerPlugin(ports: { tasks: WorkerTaskRegistrar; emit(event: AssetDataInvalidationEvent): void }) {
  return defineBuiltinWorkerPlugin("token-stas", [], async context => {
    const walletState = context.capability(VAULT_WALLET_STATE_CAPABILITY).bind(context.consumer, context.scope);
    const task = createStasCoordinatorTask({
      walletState, p2pkh: context.capability(P2PKH_ASSET_READER_CAPABILITY),
      vault: { status: () => walletState.snapshot().status },
      stateStore: context.capability(STORAGE_KV_CLIENTS_CAPABILITY).bind(context.consumer, context.scope, "token-state"),
      woc: context.capability(WOC_STAS_CAPABILITY),
      notifier: { emit: ports.emit, subscribe: () => () => undefined },
    });
    const registration = await ports.tasks.register(task, () => context.scope.assertActive());
    context.scope.onRevoke(registration.revoke);
    context.onDispose(registration.dispose);
  });
}
