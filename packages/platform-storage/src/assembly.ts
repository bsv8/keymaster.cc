// 仅供可信运行时装配引用；业务插件不能导入本入口。
export { STORAGE_PRIVATE_BROWSE_CAPABILITY, parseStorageBrowsePrivateResponse } from "./coordinator/storageBrowsePrivateCapability.js";
export type { StorageBrowsePrivateRequest, StorageBrowsePrivateCommand } from "./coordinator/storageBrowsePrivateCapability.js";
export { removeRetiredPluginIntent } from "./runtime/removeRetiredPluginIntent.js";
export { StorageBrowseCoordinator } from "./coordinator/storageBrowseCoordinator.js";

export { createScopedStorageClients } from "./coordinator/scopedStorageClients.js";

export { createVaultBootstrapStorage } from "./coordinator/vaultBootstrapStorage.js";
