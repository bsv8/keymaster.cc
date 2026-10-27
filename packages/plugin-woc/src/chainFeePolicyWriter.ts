import { parseChainFeePolicy } from "@keymaster/contracts";
import type { ChainFeePolicyCoordinatorControl, ChainFeePolicyWriter, bindWalletIdentity } from "@keymaster/contracts";

/** Writes only the currently bound wallet network's fee policy. */
export function createChainFeePolicyWriter(
  coordinator: ChainFeePolicyCoordinatorControl,
  wallet: ReturnType<typeof bindWalletIdentity>,
): ChainFeePolicyWriter {
  return {
    async setPolicy(policy) {
      wallet.assertActive();
      const result = await coordinator.chainFeePolicyUpdate(parseChainFeePolicy(policy));
      wallet.assertActive();
      if (result.status !== "accepted" && result.status !== "ok") {
        const detail = "message" in result && typeof result.message === "string" ? result.message : "";
        throw new Error(`Saving fee policy failed (${result.status})${detail ? `: ${detail}` : ""}`);
      }
    },
  };
}
