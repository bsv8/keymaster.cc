import { WALLET_KEYHOLD_PATH, WALLET_META_PATH } from "@keymaster/contracts";
import { StorageRuntimeError, WALLET_INITIALIZATION_PATH, WALLET_MIGRATION_PATH, WALLET_PAYMENT_POLICY_PATH, type WalletStore, type WalletVaultKeyStore, type WalletVaultLifecycleStore, type WalletVaultMigrationStore } from "@keymaster/contracts/storage-internal";

/**
 * 冷启动在 storage scope 创建前执行，故使用私有装配端口，不能发布整份 WalletStore。
 * Key 写入限于固定 KeyHold；初始化只允许三个固定对象在同一事务提交。
 */
export function createVaultBootstrapStorage(store: WalletStore): {
  keys: WalletVaultKeyStore;
  lifecycle: WalletVaultLifecycleStore;
  migration: WalletVaultMigrationStore;
} {
  function assertKey(path: string): void {
    if (path !== WALLET_KEYHOLD_PATH) throw new StorageRuntimeError("storage_forbidden", "Vault key path is not allowed");
  }
  // 迁移端口只允许明确身份下的核心付款账本，不开放模块存储根。
  const isPolicyPath = (path: string) => /^(main|test)\/(02|03)[0-9a-f]{64}\//u.test(path) && path.split("/").slice(2).join("/") === WALLET_PAYMENT_POLICY_PATH;
  const paths = new Set([WALLET_KEYHOLD_PATH, WALLET_META_PATH, WALLET_INITIALIZATION_PATH]);
  return Object.freeze({
    migration: Object.freeze({
      get: (path, options) => {
        if (path !== WALLET_MIGRATION_PATH && path !== WALLET_KEYHOLD_PATH && path !== WALLET_META_PATH && !isPolicyPath(path)) throw new StorageRuntimeError("storage_forbidden", "Vault migration read path is not allowed");
        return store.get(path, options);
      },
      batch: (input, options) => {
        const allowed = {has: (path: string) => path === WALLET_MIGRATION_PATH || path === WALLET_KEYHOLD_PATH || isPolicyPath(path)};
        const unique = new Set(input.operations.map(operation => operation.path));
        // Every write has a journal operation and explicit CAS conditions. Meta is
        // a read/condition only: migrating the backend must preserve the wallet generation.
        if (unique.size !== input.operations.length || !unique.has(WALLET_KEYHOLD_PATH)
          || input.operations.some(operation => !allowed.has(operation.path) || (operation.path !== WALLET_MIGRATION_PATH && operation.type !== "put"))
          || !input.conditions?.length || input.conditions.some(condition => !allowed.has(condition.path) && condition.path !== WALLET_META_PATH)
          || [...unique].some(path => !input.conditions!.some(condition => condition.path === path && (condition.ifNoneMatch === true || condition.ifRevision !== undefined)))) {
          throw new StorageRuntimeError("storage_forbidden", "Vault migration transaction is not allowed");
        }
        return store.batch(input, options);
      },
    } satisfies WalletVaultMigrationStore),
    keys: Object.freeze({
      get: (path, options) => { assertKey(path); return store.get(path, options); },
      put: (path, bytes, options) => { assertKey(path); return store.put(path, bytes, options); },
    } satisfies WalletVaultKeyStore),
    lifecycle: Object.freeze({
      readMeta: () => store.readMeta(),
      cleanupLegacyMarkers: () => store.cleanupLegacyMarkers?.() ?? Promise.resolve(),
      batch: (input, options) => {
        const unique = new Set(input.operations.map(operation => operation.path));
        if (input.operations.length !== 1 || unique.size !== 1 || input.operations.some(operation => operation.type !== "put" || operation.path !== WALLET_KEYHOLD_PATH) || input.conditions?.some(condition => condition.path !== WALLET_KEYHOLD_PATH)) {
          throw new StorageRuntimeError("storage_forbidden", "Vault initialization paths are not allowed");
        }
        return store.batch(input, options);
      },
      resetWallet: options => store.resetWallet(options),
    } satisfies WalletVaultLifecycleStore),
  });
}
