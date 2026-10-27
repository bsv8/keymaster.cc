import type { ChainFeeReader, ChainFeeSnapshots, P2pkhCoordinatorControl, bindWalletIdentity } from "@keymaster/contracts";

/** Current-wallet projection; transport snapshots retain explicit network evidence. */
export function createChainFeeReader(
  coordinator: Pick<P2pkhCoordinatorControl, "getChainFeeSnapshots" | "subscribeTopic">,
  wallet: ReturnType<typeof bindWalletIdentity>,
): ChainFeeReader {
  wallet.assertActive();
  let disposed = false;
  let values: ChainFeeSnapshots = structuredClone(coordinator.getChainFeeSnapshots());
  const listeners = new Set<() => void>();
  const assertActive = () => { wallet.assertActive(); if (disposed) throw new Error("Chain fee reader is disposed"); };
  const off = coordinator.subscribeTopic("chain.fees", event => {
    if (disposed || !wallet.isActive()) return;
    values = structuredClone(event.chainFees);
    for (const listener of [...listeners]) { try { listener(); } catch { /* observer isolation */ } }
  });
  return {
    get(...args: []) {
      assertActive();
      if (args.length) throw new TypeError("Chain fee queries do not accept wallet selectors");
      const value = values[wallet.identity.bsvNetwork];
      if (!value || value.network !== wallet.identity.bsvNetwork) throw new Error("Chain fee identity mismatch");
      return structuredClone(value);
    },
    subscribe(listener) {
      assertActive(); listeners.add(listener);
      try { listener(); } catch { /* observer isolation */ }
      return () => { listeners.delete(listener); };
    },
    dispose() { if (disposed) return; disposed = true; off(); listeners.clear(); },
  };
}
