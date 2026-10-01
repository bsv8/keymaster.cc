// 单 Key 本地钱包存储的平台实现导出。
//
// 这里只导出受限句柄的工厂与错误类型：物理路径、数据库连接和 Provider 细节
// 一律不越过这些边界。旧桶 UI、S3 Provider、multipart 与多 Key 仓储已随远程
// 存储体系一起移除，不再有兼容导出。

// 正式本地介质：唯一允许直接操作 IndexedDB 的实现。
export {
  createIndexedDbWalletStore,
  isReservedWalletPath,
  WALLET_DATABASE_NAME,
  WALLET_INDEX_STORE,
  WALLET_LIST_DEFAULT_LIMIT,
  WALLET_LIST_MAX_LIMIT,
  WALLET_OBJECT_STORE,
  WALLET_SCHEMA_VERSION,
} from "./local/indexedDbWalletStore.js";
export type {
  IndexedDbWalletStoreOptions,
  WalletBatchCondition,
  WalletBatchInput,
  WalletBatchOperation,
  WalletBatchResult,
  WalletObject,
  WalletObjectMeta,
  WalletPutResult,
  WalletStore,
  WalletWriteCondition,
} from "./local/indexedDbWalletStore.js";

// 唯一钱包 Key：固定 key.json，没有 list/readAll/delete，也没有切换。
export { createWalletKeyRepository, WALLET_KEYHOLD_FILE_PATH } from "./keys/walletKeyRepository.js";
export type { UnlockedWalletKey, WalletKeyFile, WalletKeyRepository } from "./keys/walletKeyRepository.js";
export {
  createKeyHoldDocument,
  decryptKeyHoldDocument,
  parseKeyHoldDocument,
  serializeKeyHoldDocument,
} from "./keys/keyholdDocument.js";

// 钱包生命周期：冷启动、创建/导入、解锁、锁定、改密、改名、导出与重置。
export { createWalletLifecycleService } from "./wallet/walletLifecycleService.js";
export type { WalletLifecycleDeps } from "./wallet/walletLifecycleService.js";

// 句柄工厂：K-V、模块文件根与平台固定 CAS snapshot。
export { createKeyValueStore } from "./kv-engine/walletKvEngine.js";
export type { KeyValueStoreOptions } from "./kv-engine/walletKvEngine.js";
export { createModuleFileStore } from "./storage-access/wallet/moduleFileStore.js";
export type { ModuleFileStoreOptions } from "./storage-access/wallet/moduleFileStore.js";
export { createFixedCasSnapshotStore } from "./snapshot/fixedCasSnapshotStore.js";
export type { FixedCasSnapshotStoreOptions } from "./snapshot/fixedCasSnapshotStore.js";
export { createPlatformRootStore } from "./storage-access/platform-root/platformRootStore.js";
export type { PlatformRootStoreOptions } from "./storage-access/platform-root/platformRootStore.js";

// 运行时：Worker 侧控制器与页面侧 RPC 门面。
export {
  createStorageRuntimeController,
  StorageRuntimeControllerImpl,
} from "./runtime/storageController.js";
export type { StorageRuntimeControllerDeps } from "./runtime/storageController.js";
export { StorageRuntimeError, storageErrorCode } from "./runtime/storageError.js";
export type { StorageDiagnostic } from "./runtime/storageError.js";

// 页面装配层：manifest 与只读状态守卫。
// 这两个入口会加载页面侧代码，因此不与 Worker-safe 的 ./coordinator 混用。
export { STORAGE_PLATFORM_PLUGIN_ID, storagePlatformPlugin, storagePlatformSetup } from "./manifest.js";
export { StorageUnavailableGuard } from "./ui/StorageUnavailableGuard.js";
