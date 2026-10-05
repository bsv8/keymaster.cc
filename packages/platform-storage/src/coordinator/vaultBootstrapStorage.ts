import { WALLET_KEYHOLD_PATH, WALLET_META_PATH } from "@keymaster/contracts";
import { StorageRuntimeError, WALLET_INITIALIZATION_PATH, type WalletStore, type WalletVaultKeyStore, type WalletVaultLifecycleStore } from "@keymaster/contracts/storage-internal";

/**
 * 冷启动在 storage scope 创建前执行，故使用私有装配端口，不能发布整份 WalletStore。
 * Key 写入限于固定 KeyHold；初始化只允许三个固定对象在同一事务提交。
 */
export function createVaultBootstrapStorage(store: WalletStore): {
  keys: WalletVaultKeyStore;
  lifecycle: WalletVaultLifecycleStore;
} {
  function assertKey(path: string): void {
    if (path !== WALLET_KEYHOLD_PATH) throw new StorageRuntimeError("storage_forbidden", "Vault key path is not allowed");
  }
  const paths = new Set([WALLET_KEYHOLD_PATH, WALLET_META_PATH, WALLET_INITIALIZATION_PATH]);
  return Object.freeze({
    keys: Object.freeze({
      get: (path, options) => { assertKey(path); return store.get(path, options); },
      put: (path, bytes, options) => { assertKey(path); return store.put(path, bytes, options); },
    } satisfies WalletVaultKeyStore),
    lifecycle: Object.freeze({
      readMeta: () => store.readMeta(),
      batch: (input, options) => {
        const unique = new Set(input.operations.map(operation => operation.path));
        if (input.operations.length !== 3 || unique.size !== 3 || input.operations.some(operation => operation.type !== "put" || !paths.has(operation.path)) || input.conditions?.some(condition => !paths.has(condition.path))) {
          throw new StorageRuntimeError("storage_forbidden", "Vault initialization paths are not allowed");
        }
        return store.batch(input, options);
      },
      resetWallet: options => store.resetWallet(options),
    } satisfies WalletVaultLifecycleStore),
  });
}
