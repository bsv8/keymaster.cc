// packages/plugin-vault/src/index.ts
// vault 插件统一入口。
// apps/web 通过 import 这个文件来装配插件，不直接 import 内部模块。

export { vaultPlugin, vaultSetup, VAULT_CAPABILITY } from "./manifest.js";
export { AutoLockSettingsPage, AutoLockSettingsSection } from "./AutoLockSettingsSection.js";
export { createAutoLockServiceCoordinator } from "./autoLockServiceCoordinator.js";
export { VaultKeyExportModal } from "./VaultKeyExportModal.js";
export { VaultKeyBackupImportModal } from "./VaultKeyBackupImportModal.js";
export { VaultChangePasswordModal } from "./VaultChangePasswordModal.js";
export { VaultKeyDeleteModal } from "./VaultKeyDeleteModal.js";
export * from "./crypto.js";
export { deriveP2pkhAddress, signEcdsaDigest, verifySessionKeyPair, bytesToHex, hexToBytes } from "./sessionCryptoCore.js";
export { createSessionCryptoEngine } from "./sessionCryptoClient.js";
export type { SessionCryptoClientOptions, SessionCryptoEngine } from "./sessionCryptoClient.js";
export * from "./vaultCoordinator.js";
export * from "./storage/vaultStorageRepository.js";
export { createVaultLocalSecretService } from "./localSecretService.js";
