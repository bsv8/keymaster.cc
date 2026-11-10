// 仅供可信运行时装配引用；业务插件不能导入本入口。
export { STORAGE_PRIVATE_S3_CAPABILITY } from "./connect-s3/protocol.js";
export { STORAGE_PRIVATE_BROWSE_CAPABILITY, projectStorageBrowseResponse } from "./coordinator/storageBrowsePrivateCapability.js";
export type { StorageBrowsePrivateRequest, StorageBrowsePrivateCommand } from "./coordinator/storageBrowsePrivateCapability.js";
export { removeRetiredPluginIntent } from "./runtime/removeRetiredPluginIntent.js";
export { StorageBrowseCoordinator } from "./coordinator/storageBrowseCoordinator.js";

export { createScopedStorageClients } from "./coordinator/scopedStorageClients.js";

export { createVaultBootstrapStorage } from "./coordinator/vaultBootstrapStorage.js";
export type { ConnectS3Config, ConnectS3Summary, ConnectS3Request, ConnectS3Response, ConnectS3Failure } from "./connect-s3/protocol.js";
export type { ConnectFileStore } from "./connect-s3/fileStore.js";
