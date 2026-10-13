import { defineBuiltinWorkerPlugin, VAULT_WALLET_STATE_CAPABILITY, P2PKH_ASSET_READER_CAPABILITY, WOC_CAPABILITY, WOC_1SAT_ORDINALS_CAPABILITY, type WorkerTaskRegistrar, type AssetDataInvalidationEvent } from "@keymaster/contracts";
import { createOrdinalsCoordinatorTask } from "./coordinator.js";

/** 资产插件拥有任务定义与实例，公共调度器只负责运行和排空。 */
export function createCollectible1SatordinalsWorkerPlugin(ports: { tasks: WorkerTaskRegistrar; emit(event: AssetDataInvalidationEvent): void }) {
  return defineBuiltinWorkerPlugin("collectible-1satordinals", [], async context => {
    const walletState = context.capability(VAULT_WALLET_STATE_CAPABILITY).bind(context.consumer, context.scope);
    const task = createOrdinalsCoordinatorTask({
      walletState, p2pkh: context.capability(P2PKH_ASSET_READER_CAPABILITY),
      vault: { status: () => walletState.snapshot().status },

      woc: context.capability(WOC_1SAT_ORDINALS_CAPABILITY), wocService: context.capability(WOC_CAPABILITY),
      notifier: { emit: ports.emit, subscribe: () => () => undefined },
    });
    const registration = await ports.tasks.register(task, () => context.scope.assertActive());
    context.scope.onRevoke(registration.revoke);
    context.onDispose(registration.dispose);
  });
}
