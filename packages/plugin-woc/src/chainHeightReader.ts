import { emptyChainHeightSnapshot, type bindWalletIdentity, type ChainHeightReader, type ChainHeightSnapshot, type CoordinatorChainHeightEvent } from "@keymaster/contracts";

export interface ChainHeightCoordinatorClientLike {
  getChainHeightSnapshot(): ChainHeightSnapshot;
  subscribeTopic(topic: string, listener: (event: unknown) => void): () => void;
}
export interface ChainHeightReaderDeps {
  coordinatorClient: ChainHeightCoordinatorClientLike;
  wallet: ReturnType<typeof bindWalletIdentity>;
}

/** One current-wallet projection and one unsubscribe mechanism. No polling. */
export function createChainHeightReader({ coordinatorClient, wallet }: ChainHeightReaderDeps): ChainHeightReader {
  wallet.assertActive();
  let disposed = false;
  const handlers = new Set<(snapshot: ChainHeightSnapshot) => void>();
  const assertActive = () => { wallet.assertActive(); if (disposed) throw new Error("Chain height reader is disposed"); };
  const project = (value: ChainHeightSnapshot): ChainHeightSnapshot => value.network === wallet.identity.bsvNetwork
    ? { ...value } : emptyChainHeightSnapshot(wallet.identity.bsvNetwork);
  let cached = project(coordinatorClient.getChainHeightSnapshot());
  const notify = (handler: (snapshot: ChainHeightSnapshot) => void) => {
    try { handler({ ...cached }); } catch { /* observer isolation */ }
  };
  const off = coordinatorClient.subscribeTopic("chain.height", (event: unknown) => {
    if (disposed || !wallet.isActive()) return;
    const candidate = (event as CoordinatorChainHeightEvent | undefined)?.chainHeight;
    if (!candidate || !Number.isSafeInteger(candidate.height) || candidate.height < 0
      || typeof candidate.available !== "boolean" || (candidate.network !== "main" && candidate.network !== "test")) return;
    cached = project(candidate);
    for (const handler of [...handlers]) notify(handler);
  });
  return {
    get(...args: []) {
      assertActive();
      if (args.length) throw new TypeError("Chain height queries do not accept wallet selectors");
      return { ...cached };
    },
    subscribe(handler) { assertActive(); handlers.add(handler); notify(handler); return () => { handlers.delete(handler); }; },
    dispose() { if (disposed) return; disposed = true; off(); handlers.clear(); },
  };
}
