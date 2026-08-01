// packages/plugin-vault/src/manifest.ts
// vault 插件清单。
// 设计缘由：vault 是平台依赖，必须最先注册；它不依赖任何其他 plugin capability。
//
// 硬切换 007：
//   - vault 同时提供 vault.service 与 keyspace.service；KeySwitchWidget 由
//     vault 直接注册到 topbar.registry（order 90），位置在 background.tray
//     (order 100) 左侧。
//   - manifest 声明 keyScopedStorages（meta），让 runtime 在装载时自动调用
//     keyspace.registerPluginStorage。
//   - keyspace service 通过 capability "keyspace.service" 暴露；key 状态
//     切换由 keyspace 维护，shell 与业务插件只读不写。
//
// 硬切换 003：
//   - /settings/vault 不再走旧菜单注册；
//     改为通过 settings.registry.register() 注册单一真值。
//   - breadcrumb 第一段改为不可点击"设置"分类节点（不带 path）。
//
// 硬切换 002：
//   - /settings/vault 路由 label 改为"Key 管理"，与 VaultSettingsPage 标题一致。

import type {
  BreadcrumbRegistry,
  BusinessFeatureRegistry,
  CommandRegistry,
  I18nPluginResources,
  MessageBus,
  PluginManifest,
  RouteRegistry,
  SettingsRegistry,
  TopbarRegistry
  ,ResourceRegistry
  ,ActiveKeyState
  ,KeyIdentity
  , VaultService
  , CoordinatorValueResult
  , CoordinatorCommandResult
  , CoordinatorCryptoOperation
  , CoordinatorCryptoResult
  , CoordinatorVaultStatus
  , SessionCoordinatorClient
} from "@keymaster/contracts";
import { KEYSPACE_SERVICE_CAPABILITY, SESSION_COORDINATOR_CLIENT_CAPABILITY } from "@keymaster/contracts";
import { VaultCreatePage } from "./VaultCreatePage.js";
import { VaultSettingsPage } from "./VaultSettingsPage.js";
import { CurrentKeySettingsPage } from "./CurrentKeySettingsPage.js";
import { VaultUnlockPage } from "./VaultUnlockPage.js";
import { createKeyspaceService, type KeyspaceHandle } from "./keyspaceService.js";
import { createVaultServiceCoordinator } from "./vaultServiceCoordinator.js";
import { createKeyspaceServiceCoordinator } from "./keyspaceServiceCoordinator.js";
import { SessionStateMirror } from "./sessionStateMirror.js";
import { KeySwitchWidget } from "./KeySwitchWidget.js";

export interface VaultKeyResourceState {
  keys: KeyIdentity[];
  active: ActiveKeyState;
  initializing: boolean;
  notice: { label: string } | null;
}

/** Vault setup 所需的 Coordinator contract 子集。 */
type CoordinatorClientLike = Pick<
  SessionCoordinatorClient,
  "getIsConnected" | "getBootstrapSnapshot" | "subscribeTopic" | "unlock" | "lock" | "activateKey" | "vaultOperation" | "crypto" | "backgroundCancelByKey"
>;

export const VAULT_CAPABILITY = "vault.service";

/** vault i18n 资源。覆盖 route / breadcrumb / topbar / command
 * 的 label 与 VaultSettingsPage 内的展示文案。 */
const vaultResources: I18nPluginResources = {
  namespace: "vault",
  resources: {
    en: {
      "vault.route.unlock": "Unlock wallet",
      "vault.route.create": "New wallet",
      "vault.route.settings": "Key management",
      "vault.route.currentKey": "Current private key",
      "vault.crumb.settings": "Settings",
      "vault.crumb.keys": "Key management",
      "vault.crumb.currentKey": "Current private key",
      "vault.command.lock": "Lock wallet",
      "vault.topbar.keySwitch": "Switch key",
      "vault.unlock.title": "Unlock wallet",
      "vault.unlock.description": "Enter your password to unlock the local Vault.",
      "vault.unlock.password": "Password",
      "vault.unlock.submit": "Unlock",
      "vault.create.title": "New wallet",
      "vault.create.description": "Set a local password. The Vault will then generate your first Key and set it as active. The password is never sent to any server and cannot be recovered if lost.",
      "vault.create.passwordNew": "New password",
      "vault.create.passwordConfirm": "Confirm password",
      "vault.create.submit": "Create wallet",
      "vault.create.err.tooShort": "Password must be at least 8 characters",
      "vault.create.err.mismatch": "Passwords do not match",
      "vault.create.err.failed": "Create failed",
      "vault.create.err.initialKeyFailed": "Failed to create the first Key",
      "vault.unlock.err.failed": "Unlock failed",
      "vault.keySwitch.label": "Switch key",
      "vault.keySwitch.initializing": "Initializing",
      "vault.keySwitch.noKey": "No key",
      "vault.keySwitch.noReadyKey": "No ready key",
      "vault.keySwitch.unnamed": "Unnamed",
      "vault.keySwitch.notReady": "Identity not ready",
      "vault.keySwitch.empty": "No keys yet. Go to Import to add one.",
      "vault.keySwitch.manage": "Manage keys",
      "vault.keySwitch.confirmTitle": "Confirm switch",
      "vault.keySwitch.confirm": "Confirm",
      "vault.keySwitch.confirmHint": "Enter the Vault password to unlock the selected key.",
      "vault.keySwitch.password": "Password",
      "vault.keySwitch.orPasskey": "Or use a passkey",
      "vault.keySwitch.usePassword": "Use password",
      "vault.keySwitch.passwordHint": "Enter the Vault password to unlock and switch to this private key.",
      "vault.keySwitch.passwordSubmit": "Unlock with password",
      "vault.keySwitch.or": "or",
      "vault.keySwitch.usePasskey": "Use Passkey",
      "vault.keySwitch.passkeyHint": "Choose a Passkey configured for this private key.",
      "vault.keySwitch.noPasskeys": "This private key has no Passkeys yet.",
      "vault.keySwitch.passkeyFailed": "Passkey verification failed",
      "vault.keySwitch.err.failed": "Failed to switch key",
      "vault.settings.title": "Key management",
      "vault.settings.description": "Manage local Vault keys, the active identity, and encrypted backups.",
      "vault.settings.col.label": "Label",
      "vault.settings.col.status": "Status",
      "vault.settings.col.pubkey": "Public key",
      "vault.settings.col.caps": "Capabilities",
      "vault.settings.col.created": "Created at",
      "vault.settings.col.actions": "Actions",
      "vault.settings.empty.label": "Unnamed",
      "vault.settings.empty.fingerprint": "Identity not available",
      "vault.settings.status.failed": "Identity failed",
      "vault.settings.status.initializing": "Initializing",
      "vault.settings.status.ready": "Ready",
      "vault.settings.action.expand": "Expand",
      "vault.settings.action.expandPubkey": "Expand public key",
      "vault.settings.action.collapsePubkey": "Collapse",
      "vault.settings.action.copyPubkey": "Copy full public key",
      "vault.settings.action.setActive": "Set active",
      "vault.settings.action.current": "Current key",
      "vault.settings.action.export": "Export",
      "vault.settings.action.passkeys": "Passkeys",
      "vault.settings.action.delete": "Delete",
      "vault.settings.action.new": "New key",
      "vault.settings.action.changePassword": "Change password",
      "vault.settings.action.importBackup": "Import backup",
      "vault.settings.action.import": "Import key",
      "vault.settings.action.lock": "Lock wallet",
      "vault.settings.empty.title": "No keys yet",
      "vault.settings.empty.desc": "Generate a new key locally or import an existing private key.",
      "vault.settings.notice.persisted": "Key saved, but could not be set as active automatically. Switch it manually in the list.",
      "vault.settings.notice.copied": "Copied full public key",
      "vault.settings.err.load": "Failed to load keys",
      "vault.settings.err.delete": "Delete failed",
      "vault.settings.err.setActive": "Failed to switch key",
      "vault.settings.err.create": "Create failed",
      "vault.settings.err.copy": "Copy failed",
      "vault.settings.activate.title": "Confirm switch",
      "vault.settings.activate.submit": "Confirm",
      "vault.settings.activate.hint": "Enter the Vault password to switch the active key.",
      "vault.settings.activate.password": "Password",
      "vault.settings.activate.orPasskey": "Or use a passkey",
      "vault.settings.activate.err.failed": "Failed to switch key",
      "vault.keyCreate.title": "New key",
      "vault.keyCreate.successTitle": "Key created and set as active",
      "vault.keyCreate.cancel": "Cancel",
      "vault.keyCreate.submit": "Create key",
      "vault.keyCreate.later": "Later",
      "vault.keyCreate.exportBackup": "Export encrypted backup",
      "vault.keyCreate.addPasskey": "Add passkey",
      "vault.keyCreate.hint": "The Vault will securely generate a new secp256k1 private key in the browser and immediately encrypt it with the current password. The key is set as active automatically after generation.",
      "vault.keyCreate.label": "Label",
      "vault.keyCreate.placeholder": "e.g. Key 2026-06-06 14:30",
      "vault.keyCreate.note": "Labels do not need to be unique. Keys are distinguished by their public key.",
      "vault.keyCreate.copyPubkey": "Copy full public key",
      "vault.keyCreate.success.label": "Label",
      "vault.keyCreate.success.publicKey": "Public key",
      "vault.keyCreate.warning": "This key is stored only in the current browser's local Vault. Clearing browser data, device damage, or losing the Vault password can make it unrecoverable. Export an encrypted backup as soon as possible.",
      "vault.keyCreate.err.empty": "Label cannot be empty",
      "vault.keyCreate.err.tooLong": "Label must be at most {{max}} characters",
      "vault.keyCreate.err.failed": "Create failed",
      "vault.keyDelete.title.warn": "Delete key",
      "vault.keyDelete.title.final": "Confirm again",
      "vault.keyDelete.cancel": "Cancel",
      "vault.keyDelete.exportBackup": "Export backup",
      "vault.keyDelete.next": "Next: delete",
      "vault.keyDelete.back": "Back",
      "vault.keyDelete.confirm": "Confirm delete",
      "vault.keyDelete.danger": "Deleting will remove the key's private key and every plugin's local namespace data (asset cache, history, contacts, etc.). Without a backup or copy in another wallet, related assets will be permanently inaccessible.",
      "vault.keyDelete.target": "Target: ",
      "vault.keyDelete.confirmPrompt1": "Really delete ",
      "vault.keyDelete.confirmPrompt2": "? This action is irreversible.",
      "vault.keyDelete.typedPrompt1": "Type ",
      "vault.keyDelete.typedPrompt2": " to confirm:",
      "vault.keyDelete.err.failed": "Delete failed",
      "vault.keyExport.title": "Export backup",
      "vault.keyExport.cancel": "Cancel",
      "vault.keyExport.submit": "Download backup file",
      "vault.keyExport.hint": "The JSON backup contains a password protector and every configured passkey protector. Any available protector can recover the same private key.",
      "vault.keyExport.err.failed": "Export failed",
      "vault.keyImportBackup.title": "Import backup",
      "vault.keyImportBackup.submit": "Restore backup",
      "vault.keyImportBackup.hint": "Paste the exported single Key Backup JSON. Restoring it requires the source backup password and the current Vault password.",
      "vault.keyImportBackup.backup": "Backup JSON",
      "vault.keyImportBackup.backupPlaceholder": "{\"backupVersion\":2,\"protectors\":{...}}",
      "vault.keyImportBackup.sourcePassword": "Source password",
      "vault.keyImportBackup.targetPassword": "Target Vault password",
      "vault.keyImportBackup.notice": "Backup restored: {{label}}",
      "vault.keyImportBackup.err.emptyBackup": "Backup JSON cannot be empty",
      "vault.keyImportBackup.err.emptySourcePassword": "Enter the source password",
      "vault.keyImportBackup.err.emptyTargetPassword": "Enter the target Vault password",
      "vault.keyImportBackup.err.unavailable": "This Vault does not support backup restore",
      "vault.keyImportBackup.err.failed": "Import failed",
      "vault.changePassword.title": "Change password",
      "vault.changePassword.submit": "Confirm change",
      "vault.changePassword.hint": "The Vault will lock immediately after the password is updated. You will need to unlock again with the new password.",
      "vault.changePassword.oldPassword": "Current password",
      "vault.changePassword.newPassword": "New password",
      "vault.changePassword.confirmPassword": "Confirm new password",
      "vault.changePassword.err.oldRequired": "Enter the current password",
      "vault.changePassword.err.tooShort": "New password must be at least 8 characters",
      "vault.changePassword.err.mismatch": "The new passwords do not match",
      "vault.changePassword.err.failed": "Change password failed",
      "vault.passkey.title": "Passkey protection",
      "vault.passkey.hint": "Each passkey uses WebAuthn PRF to encrypt the same private key independently. The Vault password protector is always retained.",
      "vault.passkey.password": "Vault password",
      "vault.passkey.recovery": "Recovery method · always retained",
      "vault.passkey.name": "Passkey name",
      "vault.passkey.namePlaceholder": "e.g. MacBook Touch ID",
      "vault.passkey.passwordConfirm": "Vault password (required only when adding)",
      "vault.passkey.add": "Add passkey",
      "vault.passkey.remove": "Remove",
      "vault.passkey.unsupported": "This browser or context does not support WebAuthn PRF. Use HTTPS and a compatible passkey device.",
      "vault.passkey.err.add": "Failed to add passkey",
      "vault.passkey.err.singleStepRequired": "This Passkey creation did not return PRF directly. This does not mean Chrome lacks PRF support. KeyMaster did not add it in strict single-step mode; your Passkey manager may still contain the newly created credential.",
      "vault.passkey.err.remove": "Failed to remove passkey",
      "vault.currentKey.title": "Current private key",
      "vault.currentKey.description": "Manage protection methods and encrypted backups for the active private key.",
      "vault.currentKey.empty.title": "No current private key",
      "vault.currentKey.empty.description": "Create, import, or activate a key in Key management first.",
      "vault.currentKey.empty.action": "Open Key management",
      "vault.currentKey.identity.active": "Current active private key",
      "vault.currentKey.protection.title": "Private key protection",
      "vault.currentKey.protection.description": "Each protection method can independently recover the same private key.",
      "vault.currentKey.protection.available": "Available",
      "vault.currentKey.passkeys.added": "Passkey added to the current private key.",
      "vault.currentKey.passkeys.removed": "Passkey removed.",
      "vault.currentKey.backup.title": "Encrypted backup",
      "vault.currentKey.backup.action": "Export current key backup"
    },
    "zh-CN": {
      "vault.route.unlock": "解锁钱包",
      "vault.route.create": "创建钱包",
      "vault.route.settings": "Key 管理",
      "vault.route.currentKey": "当前私钥",
      "vault.crumb.settings": "设置",
      "vault.crumb.keys": "Key 管理",
      "vault.crumb.currentKey": "当前私钥",
      "vault.command.lock": "锁定钱包",
      "vault.topbar.keySwitch": "切换 Key",
      "vault.unlock.title": "解锁钱包",
      "vault.unlock.description": "输入密码以解锁本地 Vault。",
      "vault.unlock.password": "密码",
      "vault.unlock.submit": "解锁",
      "vault.create.title": "新建钱包",
      "vault.create.description": "设置一个本地密码。Vault 接下来会生成你的第一把 Key 并自动设为 active。该密码不会发送到任何服务器，丢失后无法找回。",
      "vault.create.passwordNew": "新密码",
      "vault.create.passwordConfirm": "确认密码",
      "vault.create.submit": "新建钱包",
      "vault.create.err.tooShort": "密码至少 8 位",
      "vault.create.err.mismatch": "两次密码不一致",
      "vault.create.err.failed": "创建失败",
      "vault.create.err.initialKeyFailed": "创建首把 Key 失败",
      "vault.unlock.err.failed": "解锁失败",
      "vault.keySwitch.label": "切换 key",
      "vault.keySwitch.initializing": "初始化中",
      "vault.keySwitch.noKey": "无 key",
      "vault.keySwitch.noReadyKey": "无可切换 key",
      "vault.keySwitch.unnamed": "未命名",
      "vault.keySwitch.notReady": "身份尚未就绪",
      "vault.keySwitch.empty": "还没有 key，前往 导入 添加。",
      "vault.keySwitch.manage": "管理 key",
      "vault.keySwitch.confirmTitle": "确认切换",
      "vault.keySwitch.confirm": "确认",
      "vault.keySwitch.confirmHint": "请输入 Vault 密码以解锁所选 key。",
      "vault.keySwitch.password": "密码",
      "vault.keySwitch.orPasskey": "或使用 passkey",
      "vault.keySwitch.usePassword": "使用密码",
      "vault.keySwitch.passwordHint": "输入 Vault 密码解锁并切换到这把私钥。",
      "vault.keySwitch.passwordSubmit": "使用密码解锁",
      "vault.keySwitch.or": "或",
      "vault.keySwitch.usePasskey": "使用 Passkey",
      "vault.keySwitch.passkeyHint": "选择这把私钥已经配置的 Passkey。",
      "vault.keySwitch.noPasskeys": "这把私钥尚未配置 Passkey。",
      "vault.keySwitch.passkeyFailed": "Passkey 验证失败",
      "vault.keySwitch.err.failed": "切换 key 失败",
      "vault.settings.title": "Key 管理",
      "vault.settings.description": "管理本地 Vault 中的 Key、active 身份和加密备份。",
      "vault.settings.col.label": "标签",
      "vault.settings.col.status": "状态",
      "vault.settings.col.pubkey": "公钥",
      "vault.settings.col.caps": "能力",
      "vault.settings.col.created": "创建时间",
      "vault.settings.col.actions": "操作",
      "vault.settings.empty.label": "未命名",
      "vault.settings.empty.fingerprint": "身份不可用",
      "vault.settings.status.failed": "身份失败",
      "vault.settings.status.initializing": "初始化中",
      "vault.settings.status.ready": "可用",
      "vault.settings.action.expand": "展开",
      "vault.settings.action.expandPubkey": "展开公钥",
      "vault.settings.action.collapsePubkey": "收起",
      "vault.settings.action.copyPubkey": "复制完整公钥",
      "vault.settings.action.setActive": "设为 active",
      "vault.settings.action.current": "当前 key",
      "vault.settings.action.export": "导出",
      "vault.settings.action.passkeys": "Passkeys",
      "vault.settings.action.delete": "删除",
      "vault.settings.action.new": "新建 Key",
      "vault.settings.action.changePassword": "修改密码",
      "vault.settings.action.importBackup": "导入备份",
      "vault.settings.action.import": "导入 Key",
      "vault.settings.action.lock": "锁定钱包",
      "vault.settings.empty.title": "还没有 Key",
      "vault.settings.empty.desc": "可以在本地安全生成一把新 Key，也可以导入已有私钥。",
      "vault.settings.notice.persisted": "Key 已保存，但未能自动设为 active。请在列表中手动切换。",
      "vault.settings.notice.copied": "已复制完整公钥",
      "vault.settings.err.load": "加载 keys 失败",
      "vault.settings.err.delete": "删除失败",
      "vault.settings.err.setActive": "切换 key 失败",
      "vault.settings.err.create": "创建失败",
      "vault.settings.err.copy": "复制失败",
      "vault.settings.activate.title": "确认切换",
      "vault.settings.activate.submit": "确认",
      "vault.settings.activate.hint": "请输入 Vault 密码以切换 active key。",
      "vault.settings.activate.password": "密码",
      "vault.settings.activate.orPasskey": "或使用 passkey",
      "vault.settings.activate.err.failed": "切换 key 失败",
      "vault.keyCreate.title": "新建 Key",
      "vault.keyCreate.successTitle": "Key 已创建并设为 active",
      "vault.keyCreate.cancel": "取消",
      "vault.keyCreate.submit": "新建 Key",
      "vault.keyCreate.later": "稍后",
      "vault.keyCreate.exportBackup": "导出加密备份",
      "vault.keyCreate.addPasskey": "添加 passkey",
      "vault.keyCreate.hint": "Vault 会在浏览器内安全生成一把新的 secp256k1 私钥，并立即用当前密码加密保存。生成成功后会自动设为 active key。",
      "vault.keyCreate.label": "标签",
      "vault.keyCreate.placeholder": "例如：Key 2026-06-06 14:30",
      "vault.keyCreate.note": "标签不要求唯一；后续管理列表按公钥区分。",
      "vault.keyCreate.copyPubkey": "复制完整公钥",
      "vault.keyCreate.success.label": "标签",
      "vault.keyCreate.success.publicKey": "公钥",
      "vault.keyCreate.warning": "该 Key 只保存在当前浏览器的本地 Vault 中。清除浏览器数据、设备损坏或忘记 Vault 密码都可能导致无法恢复，请尽快导出加密备份。",
      "vault.keyCreate.err.empty": "标签不能为空",
      "vault.keyCreate.err.tooLong": "标签最长 {{max}} 个字符",
      "vault.keyCreate.err.failed": "创建失败",
      "vault.keyDelete.title.warn": "删除 key",
      "vault.keyDelete.title.final": "再次确认",
      "vault.keyDelete.cancel": "取消",
      "vault.keyDelete.exportBackup": "导出备份",
      "vault.keyDelete.next": "下一步删除",
      "vault.keyDelete.back": "返回",
      "vault.keyDelete.confirm": "确认删除",
      "vault.keyDelete.danger": "删除会同时移除该 key 的私钥以及所有插件在本地的命名空间数据（资产缓存、历史、联系人等）。没有备份或在其他钱包中有副本时，相关资产将永久无法使用。",
      "vault.keyDelete.target": "目标：",
      "vault.keyDelete.confirmPrompt1": "真的要删除 ",
      "vault.keyDelete.confirmPrompt2": " 吗？此操作不可撤销。",
      "vault.keyDelete.typedPrompt1": "请输入 ",
      "vault.keyDelete.typedPrompt2": " 以确认：",
      "vault.keyDelete.err.failed": "删除失败",
      "vault.keyExport.title": "导出备份",
      "vault.keyExport.cancel": "取消",
      "vault.keyExport.submit": "下载备份文件",
      "vault.keyExport.hint": "JSON 备份包含密码保护器和已配置的全部 passkey 保护器；任一可用保护器都能恢复同一把私钥。",
      "vault.keyExport.err.failed": "导出失败",
      "vault.keyImportBackup.title": "导入备份",
      "vault.keyImportBackup.submit": "恢复备份",
      "vault.keyImportBackup.hint": "粘贴导出的单 Key Backup JSON。恢复时需要备份来源密码，以及当前 Vault 的目标密码。",
      "vault.keyImportBackup.backup": "备份 JSON",
      "vault.keyImportBackup.backupPlaceholder": "{\"backupVersion\":2,\"protectors\":{...}}",
      "vault.keyImportBackup.sourcePassword": "源密码",
      "vault.keyImportBackup.targetPassword": "目标 Vault 密码",
      "vault.keyImportBackup.notice": "备份已恢复：{{label}}",
      "vault.keyImportBackup.err.emptyBackup": "备份内容不能为空",
      "vault.keyImportBackup.err.emptySourcePassword": "请输入源密码",
      "vault.keyImportBackup.err.emptyTargetPassword": "请输入目标 Vault 密码",
      "vault.keyImportBackup.err.unavailable": "当前 Vault 不支持备份恢复",
      "vault.keyImportBackup.err.failed": "导入失败",
      "vault.changePassword.title": "修改密码",
      "vault.changePassword.submit": "确认修改",
      "vault.changePassword.hint": "密码更新后 Vault 会立即锁定。你需要用新密码重新解锁。",
      "vault.changePassword.oldPassword": "当前密码",
      "vault.changePassword.newPassword": "新密码",
      "vault.changePassword.confirmPassword": "确认新密码",
      "vault.changePassword.err.oldRequired": "请输入当前密码",
      "vault.changePassword.err.tooShort": "新密码至少 8 位",
      "vault.changePassword.err.mismatch": "两次新密码不一致",
      "vault.changePassword.err.failed": "修改密码失败",
      "vault.passkey.title": "Passkey 保护",
      "vault.passkey.hint": "每个 passkey 使用 WebAuthn PRF 独立加密同一把私钥；Vault 密码保护器会一直保留。",
      "vault.passkey.password": "Vault 密码",
      "vault.passkey.recovery": "恢复方式 · 始终保留",
      "vault.passkey.name": "Passkey 名称",
      "vault.passkey.namePlaceholder": "例如：MacBook Touch ID",
      "vault.passkey.passwordConfirm": "Vault 密码（仅添加时需要）",
      "vault.passkey.add": "添加 passkey",
      "vault.passkey.remove": "移除",
      "vault.passkey.unsupported": "当前浏览器或上下文不支持 WebAuthn PRF；请使用 HTTPS 和兼容的 passkey 设备。",
      "vault.passkey.err.add": "添加 passkey 失败",
      "vault.passkey.err.singleStepRequired": "本次 Passkey 创建没有直接返回 PRF（不代表 Chrome 不支持 PRF），严格单次模式下 KeyMaster 未添加它；Passkey 管理器中可能仍保留刚创建的凭证。",
      "vault.passkey.err.remove": "移除 passkey 失败",
      "vault.currentKey.title": "当前私钥管理",
      "vault.currentKey.description": "管理当前 active 私钥的保护方式与加密备份。",
      "vault.currentKey.empty.title": "当前没有可管理的私钥",
      "vault.currentKey.empty.description": "请先到 Key 管理中创建、导入或激活一把 Key。",
      "vault.currentKey.empty.action": "前往 Key 管理",
      "vault.currentKey.identity.active": "当前 active 私钥",
      "vault.currentKey.protection.title": "私钥保护",
      "vault.currentKey.protection.description": "每种保护方式都能独立恢复同一把私钥。",
      "vault.currentKey.protection.available": "可用",
      "vault.currentKey.passkeys.added": "Passkey 已添加到当前私钥。",
      "vault.currentKey.passkeys.removed": "Passkey 已移除。",
      "vault.currentKey.backup.title": "加密备份",
      "vault.currentKey.backup.action": "导出当前私钥备份"
    }
  }
};

export const vaultPlugin: PluginManifest = {
  id: "vault",
  name: "Vault",
  description: "本地密码 Vault，管理私钥加解密、内存会话与 active key 状态。",
  meta: {
    kind: "core",
    startup: "required",
    defaultEnabled: true,
    canDisable: false,
    providesCapabilities: [VAULT_CAPABILITY, "keyspace.service"],
    displayGroup: "core"
  },
  i18n: vaultResources,
  keyScopedStorages: [
    { storageId: "meta", description: "Vault 自身元数据（不参与 key namespace）" }
  ],
  setup(ctx) {
    const messageBus = ctx.get<MessageBus>("runtime.messageBus");

    // 施工单 002：优先使用 Coordinator facade
    let service!: VaultService;
    let keyspaceHandle: KeyspaceHandle | undefined = undefined;

    // 尝试获取 Coordinator client（通过 capability）
    let coordinatorClient: CoordinatorClientLike | undefined;
    coordinatorClient = ctx.get<CoordinatorClientLike>(SESSION_COORDINATOR_CLIENT_CAPABILITY);
    if (coordinatorClient.getIsConnected()) {
      // Both facades derive from one already-committed session mirror.
      const sessionStateMirror = new SessionStateMirror(coordinatorClient);
      service = createVaultServiceCoordinator({ coordinatorClient, sessionStateMirror });
      keyspaceHandle = createKeyspaceServiceCoordinator(coordinatorClient as unknown as Parameters<typeof createKeyspaceServiceCoordinator>[0], sessionStateMirror) as unknown as KeyspaceHandle;
    }

    ctx.provide(VAULT_CAPABILITY, service);

    // 创建 keyspace：依赖 vault.service。
    if (!keyspaceHandle) throw new Error("Session Coordinator is unavailable");
    ctx.provide(KEYSPACE_SERVICE_CAPABILITY, keyspaceHandle);
    const resources = ctx.get<ResourceRegistry>("resource.registry");
    resources.register<VaultKeyResourceState, readonly string[]>({
      id: "vault.key-state",
      scope: "global",
      key: () => ["vault.key-state"],
      load: async (_args, context) => {
        const keyspace = context.getCapability<KeyspaceHandle>(KEYSPACE_SERVICE_CAPABILITY);
        const vault = context.getCapability<VaultService>(VAULT_CAPABILITY);
        const keys = keyspace ? await keyspace.listKeys() : [];
        return {
          keys,
          active: keyspace?.active() ?? { activePublicKeyHex: undefined },
          initializing: keyspace?.isInitializing() ?? false,
          notice: vault?.getInitialActivationNotice?.() ?? null
        };
      },
      subscribe: (_args, context, invalidate) => {
        const keyspace = context.getCapability<KeyspaceHandle>(KEYSPACE_SERVICE_CAPABILITY);
        const vault = context.getCapability<VaultService>(VAULT_CAPABILITY);
        const bus = context.getCapability<MessageBus>("runtime.messageBus");
        const offs = [
          keyspace?.onActiveKeyChanged(invalidate),
          keyspace?.onInitializationChange(invalidate),
          vault?.onInitialActivationNoticeChange?.(invalidate),
          bus?.subscribe("key.created", invalidate),
          bus?.subscribe("key.deleted", invalidate),
          bus?.subscribe("key.identity.ready", invalidate),
          bus?.subscribe("key.identity.failed", invalidate)
        ].filter((off): off is () => void => typeof off === "function");
        return () => { for (const off of offs) off(); };
      },
      equals: (a, b) => JSON.stringify(a) === JSON.stringify(b),
      invalidation: "immediate"
    });

    const routes = ctx.get<RouteRegistry>("route.registry");
    routes.register({
      id: "vault.unlock",
      path: "/vault/unlock",
      label: { key: "vault.route.unlock", fallback: "Unlock wallet" },
      component: VaultUnlockPage
    });
    routes.register({
      id: "vault.create",
      path: "/vault/create",
      label: { key: "vault.route.create", fallback: "New wallet" },
      component: VaultCreatePage
    });

    // 硬切换 003：/settings/vault 不再注册到旧菜单体系。
    // 改为 settings.registry.register() 一处真值；shell 走 settings 分组渲染。
    const settings = ctx.get<SettingsRegistry>("settings.registry");
    settings.register({
      id: "vault.current-key",
      path: "/settings/current-key",
      label: { key: "vault.route.currentKey", fallback: "Current private key" },
      description: {
        key: "vault.currentKey.description",
        fallback: "Manage protection methods and encrypted backups for the active private key."
      },
      component: CurrentKeySettingsPage,
      order: 0,
      icon: "ShieldCheck",
      visibleWhen: ({ unlocked }) => unlocked
    });
    settings.register({
      id: "vault.settings",
      path: "/settings/vault",
      label: { key: "vault.route.settings", fallback: "Key management" },
      description: {
        key: "vault.settings.description",
        fallback: "Manage local Vault keys, the active identity, and encrypted backups."
      },
      component: VaultSettingsPage,
      order: 0,
      icon: "KeyRound",
      visibleWhen: ({ unlocked }) => unlocked
    });

    // 密钥管理沿用 settings.registry 作为页面路由真值，同时作为一个 feature
    // 挂入新的「设置」业务域。vault 在 settings 之前启动，因此 registry 支持
    // 先注册入口、等待 settings 域出现后再投影到业务导航。
    const business = ctx.get<BusinessFeatureRegistry>("business.registry");
    business.registerFeature("vault", "settings", {
      id: "settings.current-key",
      label: { key: "vault.route.currentKey", fallback: "Current private key" },
      description: {
        key: "vault.currentKey.description",
        fallback: "Manage protection methods and encrypted backups for the active private key."
      },
      order: 12,
      icon: "ShieldCheck",
      entry: { path: "/settings/current-key", component: CurrentKeySettingsPage }
    });
    business.registerFeature("vault", "settings", {
      id: "settings.vault",
      label: { key: "vault.route.settings", fallback: "Key management" },
      description: {
        key: "vault.settings.description",
        fallback: "Manage local Vault keys, the active identity, and encrypted backups."
      },
      order: 15,
      icon: "KeyRound",
      entry: { path: "/settings/vault", component: VaultSettingsPage }
    });

    // 硬切换 003：面包屑第一段固定为不可点击的"设置"分类节点。
    const breadcrumbs = ctx.get<BreadcrumbRegistry>("breadcrumb.registry");
    breadcrumbs.register({
      id: "breadcrumb.vault.current-key",
      order: 0,
      match: (path) => path === "/settings/current-key",
      resolve: () => [
        { label: { key: "vault.crumb.settings", fallback: "Settings" } },
        { label: { key: "vault.crumb.currentKey", fallback: "Current private key" } }
      ]
    });
    breadcrumbs.register({
      id: "breadcrumb.vault.keys",
      order: 0,
      match: (path) => path === "/settings/vault",
      resolve: () => [
        { label: { key: "vault.crumb.settings", fallback: "Settings" } },
        { label: { key: "vault.crumb.keys", fallback: "Key management" } }
      ]
    });

    const commands = ctx.get<CommandRegistry>("command.registry");
    commands.register({
      id: "vault.lock",
      label: { key: "vault.command.lock", fallback: "Lock wallet" },
      run: async () => {
        const result = await service.lock();
        // 锁定事件本身会把所有页面收敛到最新 lifecycle snapshot。若另一
        // 页面恰好先完成了同一轮锁定，stale-epoch 是可恢复的竞态结果，不能
        // 抛到浏览器的 global.unhandledrejection 并把整个应用判为致命错误。
        if (result.status !== "accepted" && result.status !== "ok" && result.status !== "stale-epoch") {
          throw new Error("message" in result ? result.message : `Lock failed: ${result.status}`);
        }
      }
    });

    // 注册 KeySwitchWidget 到 topbar（order 90 < background.tray 100）。
    const topbar = ctx.get<TopbarRegistry>("topbar.registry");
    topbar.register({
      id: "vault.key-switch",
      label: { key: "vault.topbar.keySwitch", fallback: "Switch key" },
      component: KeySwitchWidget,
      order: 90
    });

    // 硬切换 001：vault 是 core 插件，理论上不会被 disable。
    // 但 host 仍会要求 setup 返回 teardown。vault 自身不持有后台资源，
    // 返回幂等空函数即可。service.lock() 等动作由 vault 命令触发，
    // 不属于 ownership 回收范围。
    return () => {
      // 幂等：清空内存 vault 句柄引用。
      service.dispose?.();
    };
  }
};
