import type { ChainFeeReader, P2pkhCoordinatorControl, bindWalletIdentity } from "@keymaster/contracts";

/** 当前钱包投影：直接读 Coordinator 已有同步缓存，不保存第二份快照。 */
export function createChainFeeReader(
  coordinator: Pick<P2pkhCoordinatorControl, "getChainFeeSnapshots" | "subscribeTopic">,
  wallet: ReturnType<typeof bindWalletIdentity>,
): ChainFeeReader {
  wallet.assertActive();
  let disposed = false;
  const listeners = new Set<() => void>();
  const assertActive = () => { wallet.assertActive(); if (disposed) throw new Error("Chain fee reader is disposed"); };
  const off = coordinator.subscribeTopic("chain.fees", () => {
    if (disposed || !wallet.isActive()) return;
    for (const listener of [...listeners]) { try { listener(); } catch { /* observer isolation */ } }
  });
  return {
    get(...args: []) {
      assertActive();
      if (args.length) throw new TypeError("Chain fee queries do not accept wallet selectors");
      // 同步读取 Coordinator 已有缓存 → 选网与身份校验 → 返回副本；本层不保存快照。
      const snapshots = coordinator.getChainFeeSnapshots();
      const value = snapshots[wallet.identity.bsvNetwork];
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
