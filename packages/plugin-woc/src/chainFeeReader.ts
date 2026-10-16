import type { ChainFeeReader, ChainFeeSnapshots, P2pkhCoordinatorControl } from "@keymaster/contracts";
export function createChainFeeReader(coordinator: Pick<P2pkhCoordinatorControl, "getChainFeeSnapshots" | "subscribeTopic">): ChainFeeReader {
  let values: ChainFeeSnapshots = coordinator.getChainFeeSnapshots();
  const listeners = new Set<() => void>();
  const off = coordinator.subscribeTopic("chain.fees", event => {
    values = structuredClone(event.chainFees);
    for (const listener of [...listeners]) { try { listener(); } catch { /* observer isolation */ } }
  });
  return { get: network => structuredClone(values[network]), subscribe(listener) { listeners.add(listener); listener(); return () => { listeners.delete(listener); }; }, dispose() { off(); listeners.clear(); } };
}
