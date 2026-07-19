// packages/plugin-vault/src/index.ts
// vault 插件统一入口。
// apps/web 通过 import 这个文件来装配插件，不直接 import 内部模块。

export { vaultPlugin, VAULT_CAPABILITY } from "./manifest.js";
export { VaultKeyExportModal } from "./VaultKeyExportModal.js";
export { VaultKeyBackupImportModal } from "./VaultKeyBackupImportModal.js";
export { VaultChangePasswordModal } from "./VaultChangePasswordModal.js";
export { VaultKeyDeleteModal } from "./VaultKeyDeleteModal.js";
export { KeySwitchWidget } from "./KeySwitchWidget.js";
export { vaultDb } from "./vaultDb.js";
export type { VaultMetaRecord, VaultKeyRecord } from "./vaultDb.js";
export * from "./crypto.js";
export { deriveP2pkhAddress, signDigestBytes, decryptSessionPrivateKeyBytes, verifySessionKeyPair, bytesToHex, hexToBytes } from "./sessionCryptoCore.js";
export { sealAppMessageLocalBytes, openAppMessageLocalBytes } from "./sessionCryptoCore.js";
export * from "./vaultCoordinator.js";
