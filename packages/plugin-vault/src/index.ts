// packages/plugin-vault/src/index.ts
// vault 插件统一入口。
// apps/web 通过 import 这个文件来装配插件，不直接 import 内部模块。

export { vaultPlugin, VAULT_CAPABILITY } from "./manifest.js";
export { VaultKeyExportModal } from "./VaultKeyExportModal.js";
export { VaultKeyDeleteModal } from "./VaultKeyDeleteModal.js";
export { KeySwitchWidget } from "./KeySwitchWidget.js";
