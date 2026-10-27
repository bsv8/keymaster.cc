import type { CentralBroadcastService, CoordinatorP2pkhBroadcastResult, OneShotBroadcastInput, P2pkhBroadcastAssemblyControl } from "@keymaster/contracts";

/** Transport only. Selection, durable dispatch and exact recovery belong to manager. */
export interface CentralBroadcastServiceDeps {
  coordinator: P2pkhBroadcastAssemblyControl;
  binding: { readonly identity: { publicKeyHex: string; bsvNetwork: "main" | "test" }; assertActive(): void };
}
export function createCentralBroadcastService(deps: CentralBroadcastServiceDeps): CentralBroadcastService {
  deps.binding.assertActive();
  const { publicKeyHex, bsvNetwork } = deps.binding.identity;
  return {
    async submitOnce(input: OneShotBroadcastInput): Promise<CoordinatorP2pkhBroadcastResult> {
      deps.binding.assertActive();
      if (input.ownerPublicKeyHex.toLowerCase() !== publicKeyHex.toLowerCase() || input.network !== bsvNetwork) throw new Error("Signed submission differs from its captured wallet identity");
      const submission = structuredClone(input);
      if (!input.managerAllocationId) return { status: "not-dispatched", reason: "coordinator-not-dispatched" };
      const result = await deps.coordinator.p2pkhBroadcast({
        ownerPublicKeyHex: submission.ownerPublicKeyHex, network: submission.network, submissionId: submission.submissionId,
        submission: { resourceId: submission.resourceId, txid: submission.txid, rawTxHex: submission.rawTxHex, managerAllocationId: submission.managerAllocationId },
      });
      deps.binding.assertActive();
      if (result.status === "ok") return result.value as CoordinatorP2pkhBroadcastResult;
      if (result.status === "transport-error" && result.dispatchStatus !== "not-dispatched") return { status: "isolated", txid: input.txid, reason: result.message || "broadcast transport result unknown" };
      return { status: "not-dispatched", reason: "coordinator-not-dispatched" };
    },
  };
}
