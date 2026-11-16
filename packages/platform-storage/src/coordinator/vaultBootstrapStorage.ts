import type { WalletStore, WalletVaultKeyStore, WalletVaultLifecycleStore } from "@keymaster/contracts/storage-internal";
import { WALLET_KEYHOLD_PATH } from "@keymaster/contracts";

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
      readKey: () => store.get(WALLET_KEYHOLD_PATH),
      writeKey: (bytes, condition) => store.put(WALLET_KEYHOLD_PATH, bytes, { ...condition, contentType: "application/json" }),
    } satisfies WalletVaultKeyStore),
    lifecycle: Object.freeze({
      cleanupLegacyMarkers: () => store.cleanupLegacyMarkers?.() ?? Promise.resolve(),
      async initializeKey(bytes) {
        await store.batch({
          operations: [{ type: "put", path: WALLET_KEYHOLD_PATH, bytes, contentType: "application/json" }],
          conditions: [{ path: WALLET_KEYHOLD_PATH, ifNoneMatch: true }],
        });
      },
      resetWallet: () => store.resetWallet(),
    } satisfies WalletVaultLifecycleStore),
  });
}
