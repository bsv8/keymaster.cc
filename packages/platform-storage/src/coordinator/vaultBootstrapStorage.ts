import type { WalletStore, WalletVaultKeyStore, WalletVaultLifecycleStore } from "@keymaster/contracts/storage-internal";

/**
 * 私有 Worker 装配：直接使用可信 Vault 调用，不发布整份 WalletStore。
 * 初始化仍委托底层的一次 batch 事务；不把可信内部调用者当作路径攻击者。
 */
export function createVaultBootstrapStorage(store: WalletStore): {
  keys: WalletVaultKeyStore;
  lifecycle: WalletVaultLifecycleStore;
} {
  return Object.freeze({
    keys: Object.freeze({
      get: (path, options) => store.get(path, options),
      put: (path, bytes, options) => store.put(path, bytes, options),
    } satisfies WalletVaultKeyStore),
    lifecycle: Object.freeze({
      readMeta: () => store.readMeta(),
      cleanupLegacyMarkers: () => store.cleanupLegacyMarkers?.() ?? Promise.resolve(),
      batch: (input, options) => store.batch(input, options),
      resetWallet: options => store.resetWallet(options),
    } satisfies WalletVaultLifecycleStore),
  });
}
