import type { WalletStore } from "@keymaster/contracts/storage-internal";
/** Only aggregate activity crosses the UI boundary; no paths, contents or history are retained. */
export function createWalletStoreActivity(changed: () => void) {
  let reads = 0, writes = 0, queued = false;
  const notify = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; changed(); });
  };
  const run = async <T>(kind: "read" | "write", operation: () => Promise<T>): Promise<T> => {
    if (kind === "read") reads++; else writes++;
    notify();
    try { return await operation(); }
    finally { if (kind === "read") reads--; else writes--; notify(); }
  };
  return {
    snapshot: () => ({ reads: Math.min(reads, 1_024), writes: Math.min(writes, 1_024) }),
    wrap(store: WalletStore): WalletStore {
      return Object.freeze({
        readMeta: () => run("read", () => store.readMeta()), readKeyHold: () => run("read", () => store.readKeyHold()),
        get: (...args: Parameters<WalletStore["get"]>) => run("read", () => store.get(...args)),
        getRange: (...args: Parameters<WalletStore["getRange"]>) => run("read", () => store.getRange(...args)),
        list: (...args: Parameters<WalletStore["list"]>) => run("read", () => store.list(...args)),
        put: (...args: Parameters<WalletStore["put"]>) => run("write", () => store.put(...args)),
        delete: (...args: Parameters<WalletStore["delete"]>) => run("write", () => store.delete(...args)),
        batch: (...args: Parameters<WalletStore["batch"]>) => run("write", () => store.batch(...args)),
        resetWallet: (...args: Parameters<WalletStore["resetWallet"]>) => run("write", () => store.resetWallet(...args)),
        persistence: () => store.persistence(), close: () => store.close(),
      });
    },
  };
}
