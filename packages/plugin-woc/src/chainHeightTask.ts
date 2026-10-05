import type { BackgroundTaskDefinition, BsvNetwork, ChainHeightSnapshot } from "@keymaster/contracts";
import { CHAIN_HEIGHT_SYNC_TASK_ID } from "@keymaster/contracts";

export interface ChainHeightTaskDependencies {
  network(): BsvNetwork;
  readHeight(network: BsvNetwork, signal: AbortSignal): Promise<number>;
  snapshot(): ChainHeightSnapshot;
  publish(snapshot: ChainHeightSnapshot): void;
}

/** The provider owns validation and projection; the host owns scheduling and I/O leases. */
export function createChainHeightTask(deps: ChainHeightTaskDependencies): BackgroundTaskDefinition & { unitId: string } {
  return {
    id: CHAIN_HEIGHT_SYNC_TASK_ID,
    pluginId: "woc",
    unitId: "woc.coordinator-worker",
    label: { key: "woc.task.chainHeight", fallback: "Chain height" },
    async run(context) {
      const network = deps.network();
      const height = await deps.readHeight(network, context.signal);
      context.assertSessionFresh?.();
      if (context.signal.aborted) throw new Error("Chain height read was aborted");
      if (!Number.isSafeInteger(height) || height < 0) throw new Error(`Chain height provider returned an invalid height: ${String(height)}`);
      const previous = deps.snapshot();
      const changed = height !== previous.height || !previous.available || previous.network !== network;
      deps.publish({ height, network, available: true, updatedAtMs: Date.now(), revision: changed ? previous.revision + 1 : previous.revision });
    },
  };
}
