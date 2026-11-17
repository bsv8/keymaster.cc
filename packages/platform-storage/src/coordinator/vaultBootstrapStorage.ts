import type { WalletStore, WalletVaultFiles, WalletVaultKeyStore, WalletVaultLifecycleStore, WalletWriteCondition } from "@keymaster/contracts/storage-internal";
import { WALLET_KEYHOLD_PATH, WALLET_NETWORK_PATH } from "@keymaster/contracts";

/** Only these two fixed root files are available before identity binding. */
export function createVaultBootstrapStorage(store: WalletStore): { keys: WalletVaultKeyStore; lifecycle: WalletVaultLifecycleStore } {
  async function write(files: WalletVaultFiles, condition: WalletWriteCondition) {
    const before = await store.readBootstrapFiles();
    const result = await store.batch({
      operations: [
        { type: "put", path: WALLET_KEYHOLD_PATH, bytes: files.key, contentType: "application/json" },
        { type: "put", path: WALLET_NETWORK_PATH, bytes: files.network, contentType: "application/json" },
      ],
      conditions: [
        { path: WALLET_KEYHOLD_PATH, ...condition, ...(condition.ifNoneMatch ? {} : { ifRevision: condition.ifRevision ?? before.key?.revision ?? 0 }) },
        { path: WALLET_NETWORK_PATH, ...(condition.ifNoneMatch ? { ifNoneMatch: true as const } : { ifRevision: before.network?.revision ?? 0 }) },
      ],
    });
    return { path: WALLET_KEYHOLD_PATH, size: files.key.byteLength, revision: (before.key?.revision ?? 0) + 1, lastModified: result.committedAt, contentType: "application/json" };
  }
  return Object.freeze({
    keys: Object.freeze({ readKey: () => store.readBootstrapFiles(), writeKey: write }),
    lifecycle: Object.freeze({
      cleanupLegacyMarkers: () => store.cleanupLegacyMarkers?.() ?? Promise.resolve(),
      async initializeKey(files: WalletVaultFiles) { await write(files, { ifNoneMatch: true }); },
      resetWallet: () => store.resetWallet(),
    }),
  });
}
