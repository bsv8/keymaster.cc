import type { BackgroundTaskDefinition, BsvNetwork, ChainHeightSnapshot, ChainTip } from "@keymaster/contracts";
import { CHAIN_HEIGHT_SYNC_TASK_ID } from "@keymaster/contracts";

export interface ChainHeightTaskDependencies {
  network(): BsvNetwork;
  readTip(network: BsvNetwork, signal: AbortSignal): Promise<ChainTip>;
  snapshot(): ChainHeightSnapshot;
  commit(snapshot: ChainHeightSnapshot, changed: boolean): void;
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
      const { height, blockHash } = await deps.readTip(network, context.signal);
      context.assertSessionFresh?.();
      if (context.signal.aborted) throw new Error("Chain height read was aborted");
      if (!Number.isSafeInteger(height) || height < 0) throw new Error(`Chain height provider returned an invalid height: ${String(height)}`);
      if (typeof blockHash !== "string" || !/^[0-9a-f]{64}$/u.test(blockHash)) throw new Error("Chain height provider returned an invalid block hash");
      const previous = deps.snapshot();
      const changed = !previous.available || previous.network !== network || previous.height !== height || previous.blockHash !== blockHash;
      deps.commit({ height, blockHash, network, available: true, updatedAtMs: Date.now(), revision: changed ? previous.revision + 1 : previous.revision }, changed);
    },
  };
}
