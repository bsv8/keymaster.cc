import type { CentralBroadcastService, CoordinatorP2pkhBroadcastResult, OneShotBroadcastInput, P2pkhBroadcastAssemblyControl } from "@keymaster/contracts";

/** Transport only. Selection, durable dispatch and exact recovery belong to manager. */
export interface CentralBroadcastServiceDeps {
  coordinator: P2pkhBroadcastAssemblyControl;
}
export function createCentralBroadcastService(deps: CentralBroadcastServiceDeps): CentralBroadcastService {
  return {
    async submitOnce(input: OneShotBroadcastInput): Promise<CoordinatorP2pkhBroadcastResult> {
      if (!input.managerAllocationId) return { status: "not-dispatched", reason: "coordinator-not-dispatched" };
      const result = await deps.coordinator.p2pkhBroadcast({
        ownerPublicKeyHex: input.ownerPublicKeyHex, network: input.network, submissionId: input.submissionId,
        submission: { resourceId: input.resourceId, txid: input.txid, rawTxHex: input.rawTxHex, managerAllocationId: input.managerAllocationId },
      });
      if (result.status === "ok") return result.value as CoordinatorP2pkhBroadcastResult;
      if (result.status === "transport-error" && result.dispatchStatus !== "not-dispatched") return { status: "isolated", txid: input.txid, reason: result.message || "broadcast transport result unknown" };
      return { status: "not-dispatched", reason: "coordinator-not-dispatched" };
    },
  };
}
