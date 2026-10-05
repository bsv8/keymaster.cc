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
export { createKeyValueStore } from "../kv-engine/walletKvEngine.js";
export { createModuleFileStore } from "../storage-access/wallet/moduleFileStore.js";
export { createFixedCasSnapshotStore } from "../snapshot/fixedCasSnapshotStore.js";
export { createPlatformRootStore } from "../storage-access/platform-root/platformRootStore.js";
export type { PlatformRootStoreOptions, StoragePrivateRootStore } from "../storage-access/platform-root/platformRootStore.js";
export { createStorageRuntimeController, StorageRuntimeControllerImpl } from "../runtime/storageController.js";
export type { StorageRuntimeControllerDeps } from "../runtime/storageController.js";
export { StorageRuntimeError, storageErrorCode } from "../runtime/storageError.js";
// 存储浏览服务留在 Worker-safe 入口内：它读 WalletStore，不含 React 与 Markdown
// 展示，因此可以安全地被 SharedWorker 引入。
export { createStorageBrowseService } from "../runtime/storageBrowseService.js";
export type { StorageBrowseAuthorization, StorageBrowseRuntime, StorageBrowseServiceOptions } from "../runtime/storageBrowseService.js";
export { detectBrowsePreview } from "../runtime/storageBrowsePreview.js";
export { DIRECTORY_CONTENT_TYPE, DIRECTORY_MARKER_NAME } from "../runtime/storageBrowsePaths.js";

export { createWalletStoreActivity } from "./walletStoreActivity.js";
export { createStorageDataQueue, STORAGE_DATA_CONCURRENCY, STORAGE_DATA_MAX_QUEUE } from "./storageDataQueue.js";

export { createStorageDataExecutor } from "./storageDataExecutor.js";
export { createWorkerStorageClients } from "./workerStorageClients.js";
export { createStorageRpcHandlers } from "./storageRpcHandlers.js";
export { createStorageGrantAuthority } from "./storageGrantAuthority.js";
export { createScopedStorageClients } from "./scopedStorageClients.js";
export { createKeyValueMaintenance } from "./keyValueMaintenance.js";
