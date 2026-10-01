// Worker-safe 存储运行时导出。
//
// 这个入口会被打进 SharedWorker，所以它不含页面 manifest 与 React 设置界面；
// 旧实现里的 S3 客户端、桶 Provider 与 multipart 仓储已全部移除。
export {
  createIndexedDbWalletStore,
  WALLET_DATABASE_NAME,
  WALLET_OBJECT_STORE,
  WALLET_INDEX_STORE,
  WALLET_LIST_DEFAULT_LIMIT,
  WALLET_LIST_MAX_LIMIT,
  WALLET_SCHEMA_VERSION,
} from "../local/indexedDbWalletStore.js";
export type { WalletStore } from "../local/indexedDbWalletStore.js";
export { createWalletKeyRepository, WALLET_KEYHOLD_FILE_PATH } from "../keys/walletKeyRepository.js";
export type { UnlockedWalletKey, WalletKeyFile, WalletKeyRepository } from "../keys/walletKeyRepository.js";
export { createWalletLifecycleService } from "../wallet/walletLifecycleService.js";
export type { WalletLifecycleDeps } from "../wallet/walletLifecycleService.js";
export { createKeyValueStore } from "../kv-engine/walletKvEngine.js";
export { createModuleFileStore } from "../storage-access/wallet/moduleFileStore.js";
export { createFixedCasSnapshotStore } from "../snapshot/fixedCasSnapshotStore.js";
export { createPlatformRootStore } from "../storage-access/platform-root/platformRootStore.js";
export type { PlatformRootStoreOptions } from "../storage-access/platform-root/platformRootStore.js";
export { createStorageRuntimeController, StorageRuntimeControllerImpl } from "../runtime/storageController.js";
export type { StorageRuntimeControllerDeps } from "../runtime/storageController.js";
export { StorageRuntimeError, storageErrorCode } from "../runtime/storageError.js";
