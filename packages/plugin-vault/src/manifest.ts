import { createPublicVaultService } from "./publicVaultService.js";
import { createVaultImporters } from "./VaultInternalContext.js";
import { keyImportResources, hexResources, wifResources, jsonFileResources } from "./import/resources.js";
import { VAULT_WORKER_CRYPTO_CAPABILITY, P2PKH_WORKER_TRANSFER_CAPABILITY } from "@keymaster/contracts";
import { COORDINATOR_CRYPTO_RPC_CAPABILITY } from "@keymaster/contracts";
import { CENTRAL_STORAGE_DECLARATIONS } from "@keymaster/contracts";
import { evaluateShellGuard, areShellGuardStatesEqual } from "./walletGuard.js";
import { VAULT_COORDINATOR_CLIENT_BINDING_CAPABILITY } from "@keymaster/contracts";
import { VaultWalletGuard, type WalletGuard } from "./VaultWalletGuard.js";
import { VaultLockButton } from "./VaultLockButton.js";
import { VaultWalletEntry } from "./VaultWalletEntry.js";
import { PAGE_UI_RENDERER_CAPABILITY } from "@keymaster/contracts";
import { createElement } from "react";
import { bindVaultUi } from "./VaultResourceContext.js";
import { OWNED_RESOURCE_ACCESS_CAPABILITY, I18N_SERVICE_CAPABILITY } from "@keymaster/contracts";
// packages/plugin-vault/src/manifest.ts
// vault 插件清单。
// 设计缘由：vault 是平台依赖，必须最先注册；它不依赖任何其他 plugin capability。
//
// 单 Key 本地存储（docs/存储.md）后的结构：
//   - Key 状态资源只投影"唯一 Key 是谁"，没有 keys[]、没有 active 切换、
//     没有 key.created / key.deleted 事件。
//   - Key 管理页只有改名、改密、导出 KeyHold、锁定和重置钱包；创建/导入
//     只发生在未初始化状态，替换身份必须先重置。
//   - vault 不再持有 MessageBus 依赖：唯一 Key 的变化由 session.state 事件
//     表达，没有需要额外广播的 Key 生命周期事件。

import type {
  AutoLockService,
  AutoLockSettings,
  BreadcrumbRegistry,
  BusinessFeatureRegistry,
  CommandRegistry,
  I18nPluginResources,
  VaultWalletState,
  PluginManifest,
  PluginSetup,
  ResourceRegistry,
  RouteRegistry,
  SettingsRegistry,
  VaultService,
} from "@keymaster/contracts";
import {
  AUTOLOCK_SERVICE_CAPABILITY,
  BREADCRUMB_REGISTRY_CAPABILITY,
  BUSINESS_REGISTRY_CAPABILITY,
  COMMAND_REGISTRY_CAPABILITY,
  VAULT_WALLET_STATE_CAPABILITY, VAULT_WORKER_WALLET_CONTROL_CAPABILITY,
  RESOURCE_REGISTRY_CAPABILITY,
  PAGE_UI_REGISTRY_CAPABILITY,
  VAULT_LOCAL_SECRET_CAPABILITY,
  VAULT_SERVICE_CAPABILITY,
  type VaultCoordinatorControl,
} from "@keymaster/contracts";
import { VaultCreatePage } from "./VaultCreatePage.js";
import { CurrentKeySettingsPage } from "./CurrentKeySettingsPage.js";
import { VaultUnlockPage } from "./VaultUnlockPage.js";
import { AutoLockSettingsPage } from "./AutoLockSettingsSection.js";
import { createVaultServiceCoordinator } from "./vaultServiceCoordinator.js";
import { createWalletStateAccess } from "./walletStateAccess.js";
import { createAutoLockServiceCoordinator } from "./autoLockServiceCoordinator.js";
import { SessionStateMirror } from "./sessionStateMirror.js";
import { createVaultLocalSecretService } from "./localSecretService.js";

/** 唯一 Key 的只读资源投影。 */
export interface VaultKeyResourceState {
  status: import("@keymaster/contracts").VaultStatus;
  /** 唯一钱包 Key 的公钥；未初始化或锁定时缺省。 */
  activePublicKeyHex?: string;
  /** Worker 运行世代；Worker 重启后变化。 */
  runGeneration: string;
  /** 钱包身份世代；重置后变化。 */
  walletGeneration?: string;
  /** lifecycle 快照修订号，页面据此丢弃乱序结果。 */
  revision: number;
}

/** Vault setup 所需的 Coordinator contract 子集。 */
type CoordinatorClientLike = VaultCoordinatorControl;

export const VAULT_CAPABILITY = VAULT_SERVICE_CAPABILITY;

/** vault i18n 资源。覆盖 route / breadcrumb / command
 * 的 label 与页面内展示文案。 */
const vaultResources: I18nPluginResources = {
  namespace: "vault",
  resources: {
    en: {
      "vault.lock.cleaning": "Locking wallet. Waiting for services to exit before unlocking is available.",
      "vault.lock.cleanupFailed": "Wallet locked. Some services could not finish cleaning up. Retry cleanup before unlocking.",
      "vault.lock.details": "Lock error details",
      "vault.lock.retry": "Retry cleanup",
      "vault.lock.retryFailed": "Cleanup retry failed. Please try again.",
      "vault.lock.requestFailed": "Lock request failed. Please try again.",
      "vault.lock.cleanupBlocked": "Wallet cleanup has not completed. Retry cleanup before unlocking.",

      "vault.import.title": "Move to RocKey",
      "vault.import.cancel": "Cancel",
      "vault.import.start": "Continue migration",
      "vault.import.connectionRequired": "Connect RocKey, compare the pairing codes on both screens, then confirm on RocKey.",
      "vault.import.pending": "Migrating. Keep USB connected and follow the device prompts.",
      "vault.import.instructions": "Connect an empty RocKey from its home screen and verify the pairing code on the device. Continue migration; after receiving the key, RocKey asks you to set and repeat a PIN before saving. RocKey must have no private key, including a matching key. Interrupting before commit keeps the original software wallet. No software password is required while unlocked.",
      "vault.import.preserve": "Identity, network, business data and channel ledger are preserved. Only after verifying the hardware save proof does Keymaster replace the software envelope with the hardware backend. No second hardware-wallet enrollment is needed.",

      "vault.migration.erasedInstructions":"The old device key is absent. Match the pairing code and migration record. Confirm any remaining cleanup on the device.",
      "vault.migration.failure": "Previous migration failed:",
      "vault.migration.action": "Move back to software wallet",
      "vault.migration.title": "Move back to software wallet",
      "vault.migration.cancel": "Cancel",
      "vault.migration.start": "Continue migration",
      "vault.migration.instructions": "Set a new software wallet password. This page requests migration from the connected RocKey, preserving identity, business data and spending limits.",
      "vault.migration.saved": "The encrypted wallet and spending ledger are saved. Migration to software is complete.",
      "vault.migration.confirmations": "Hold to approve migration on RocKey. After saving, the device independently offers to erase the old key; deny to keep a backup.",
      "vault.migration.finish": "After saving, the software wallet opens automatically. The device erase decision does not block wallet use.",
      "vault.migration.password": "New password (at least 8 characters)",
      "vault.migration.repeat": "Repeat new password",
      "vault.migration.pending": "Hold to approve migration on RocKey and keep USB connected while the encrypted wallet is saved.",
      "vault.migration.recoveryTitle": "Resume unfinished migration",
      "vault.migration.recoveryHelp": "Connect the original RocKey and resume the same identity migration. Ordinary wallet operations stay locked during recovery.",
      "vault.migration.resume": "Resume migration",
      "vault.migration.erasedOption": "The original device has already erased its key; recover its commit receipt only",

      "vault.currentKey.hardwareSecurity": "Manage the PIN and device backups on RocKey.",
      "vault.panel.wallet": "My wallet",
      "vault.notifications.title": "Notification history",
      "vault.signing.register": "Register signing channel",
      "vault.signing.approve": "Approve signature",
      "vault.notifications.approve": "Approve",
      "vault.notifications.deny": "Do not approve",
      "vault.notifications.waiting": "Awaiting approval",
      "vault.notifications.processing": "Processing",
      "vault.notifications.approved": "Approved",
      "vault.notifications.denied": "Denied",
      "vault.notifications.cancelled": "Cancelled",
      "vault.notifications.failed": "Failed",
      "vault.notifications.unknown": "Unknown outcome",
      "vault.notifications.loading": "Loading notifications…",
      "vault.notifications.empty": "No notifications yet",
      "vault.notifications.registration": "Channel registration",
      "vault.notifications.payment": "Payment request",
      "vault.notifications.signature": "Signature request",
      "vault.notifications.device": "Approve or deny on RocKey",
      "vault.notifications.automatic": "Automatic approval",
      "vault.notifications.manual": "Manual approval",
      "vault.notifications.modeAutomatic": "Automatic",
      "vault.notifications.modeManual": "Manual",
      "vault.notifications.modeUnknown": "Method unreported",
      "vault.panel.hardware": "RocKey hardware wallet",
      "vault.panel.software": "Software wallet",
      "vault.panel.channels": "Spending channels and limits",
      "vault.panel.deviceOnly": "Enter the PIN, approve and deny on the device.",
      "vault.panel.awaiting-user": "Read and confirm on RocKey",
      "vault.panel.executing": "Device is executing",
      "vault.panel.completed": "Device operation completed",
      "vault.panel.denied": "Device denied the operation",
      "vault.panel.cancelled": "Operation cancelled",
      "vault.panel.unknown": "Outcome unknown. Do not retry automatically.",
      "vault.panel.failed": "Device operation failed",
      "vault.signatureHistory.connectIdentity": "App connection identity signature",
      "vault.signatureHistory.connectIntent": "App intent signature",
      "vault.signatureHistory.bitfsWire": "BitFS protocol signature",
      "vault.signatureHistory.publicMessage": "Public channel signature",
      "vault.signatureHistory.hashRequest": "Channel digest signature",
      "vault.signatureHistory.privateMessage": "Private channel signature",
      "vault.signatureHistory.digest": "Digest signature",
      "vault.signatureHistory.records": "Records",
      "vault.signatureHistory.filter": "Filter records",
      "vault.signatureHistory.time": "Requested",
      "vault.signatureHistory.purpose": "Purpose / Channel",
      "vault.signatureHistory.source": "Source / Key",
      "vault.signatureHistory.amount": "Amount (sat)",
      "vault.signatureHistory.authorization": "Authorization",
      "vault.signatureHistory.result": "Result",
      "vault.signatureHistory.perPage": "10 per page",
      "vault.signatureHistory.pagination": "Signature record pages",
      "vault.signatureHistory.previous": "Previous",
      "vault.signatureHistory.next": "Next",
      "vault.signatureHistory.title": "Signature records",
      "vault.signatureHistory.scope": "Requests handled by Keymaster; no history is stored on the device.",
      "vault.signatureHistory.automatic": "Automatic",
      "vault.signatureHistory.manual": "Manual confirmation",
      "vault.signatureHistory.unreported": "Not reported",
      "vault.signatureHistory.pending": "Waiting for result",
      "vault.signatureHistory.completed": "Signature completed",
      "vault.signatureHistory.denied": "Denied",
      "vault.signatureHistory.cancelled": "Cancelled",
      "vault.signatureHistory.failed": "Failed",
      "vault.signatureHistory.unknown": "Result unknown",
      "vault.signatureHistory.all": "All",
      "vault.signatureHistory.abnormal": "Issues",
      "vault.signatureHistory.empty": "No signature records",
      "vault.signatureHistory.software": "Software key",
      "vault.signatureHistory.hardware": "Hardware key",
      "vault.signatureHistory.finished": "Completed at",
      "vault.signatureHistory.noise": "Network handshake identity",
      "vault.signatureHistory.peerRecord": "Network identity broadcast",
      "vault.signatureHistory.p2pkh": "P2PKH transaction",
      "vault.signatureHistory.standard": "BSV transaction",
      "vault.signatureHistory.feepool": "Fee pool transaction",
      "vault.signatureHistory.feepoolBitfs": "BitFS fee pool transaction",
      "vault.hardware.title": "Connect hardware wallet",
      "vault.hardware.enrollBody": "Create a wallet using the Key on RocKey. The device manages its PIN and private key.",
      "vault.hardware.instructions": "Unlock RocKey with its PIN on the device, then connect by USB and compare the pairing codes.",
      "vault.hardware.unavailable": "This browser does not support the required USB serial connection.",
      "vault.hardware.pairing": "Compare both pairing codes, then hold to confirm on RocKey:",
      "vault.hardware.connect": "Connect RocKey",
      "vault.hardware.disconnect": "Disconnect",
      "vault.hardware.connected": "RocKey connection verified.",
      "vault.payment.change": "Change to this key (satoshis)",
      "vault.payment.fee": "Miner fee (satoshis, included in actual spend)",
      "vault.payment.spendApproval": "Spend signature confirmation",
      "vault.payment.automaticNotice": "Automatic spend within single limit",
      "vault.payment.actualSpend": "Actual spend including miner fee (satoshis)",
      "vault.payment.feeIncluded": "Miner fee (satoshis, included in actual spend)",
      "vault.payment.ownReturn": "All wallet-owned P2PKH returns (satoshis)",
      "vault.payment.wallet": "Current wallet",
      "vault.payment.network": "Network",
      "vault.payment.businessAmount": "Business amount excluding fee (satoshis)",
      "vault.payment.soundUnavailable": "Sound was not played. Check browser audio permissions and output devices. The signing policy is unchanged.",
      "vault.payment.retrySound": "Retry sound",
      "vault.payment.soundScheduled": "Audio playback requested (physical speaker output is not verified)",
      "vault.payment.soundPending": "Requesting audio playback…",
      "vault.payment.dismissNotice": "Dismiss notice",
      "vault.payment.pool": "Fee pool",
      "vault.payment.poolFund": "Funding",
      "vault.payment.poolState": "Cumulative state transaction",
      "vault.payment.poolPaid": "Pool cumulative external payment (sats)",
      "vault.payment.poolLocked": "Amount added to pool (sats)",
      "vault.payment.outputs": "Actual transaction outputs (including change)",
      "vault.channels.title": "Wallet authorization channels",
      "vault.channels.description": "Manage signature approval and payment limits by channel. Payments over a limit can still be approved manually.",
      "vault.channels.hardware": "RocKey · Read only",
      "vault.channels.software": "Software wallet · Editable",
      "vault.channels.loading": "Loading channels…",
      "vault.channels.signing": "Signature authorization",
      "vault.channels.channel": "Channel",
      "vault.channels.owner": "Source",
      "vault.channels.strategy": "Approval policy",
      "vault.channels.action": "Action",
      "vault.channels.signingEmpty": "No registered signing channels",
      "vault.channels.onDevice": "Set on device",
      "vault.channels.sessionHint": "Only each actual spend including fees is checked. Sessions provide identity and revocation, not a cumulative allowance. Amounts are in satoshis (sat).",
      "vault.channels.single": "Per-payment approval limit",
      "vault.channels.session": "New session approval total",
      "vault.channels.status": "Automatic approval",
      "vault.channels.app": "External App",
      "vault.channels.plugin": "Internal plugin",
      "vault.channels.enabled": "Enabled",
      "vault.channels.disabled": "Disabled",
      "vault.channels.editHint": "Actual spend includes miner fees. An enabled single-spend limit permits automatic signing; exceeding it or leaving it unconfigured requires approval.",
      "vault.payment.channels": "Payment channels",
      "vault.payment.empty": "No registered payment channels",
      "vault.payment.single": "Single payment automatic approval limit (satoshis)",
      "vault.payment.default": "New session cumulative automatic approval limit (satoshis)",
      "vault.payment.edit": "Edit limits",
      "vault.payment.cancel": "Cancel",
      "vault.payment.save": "Save limits",
      "vault.payment.enabled": "Enable automatic approval",
      "vault.payment.approval": "Payment exceeds automatic approval limits",
      "vault.payment.deny": "Deny",
      "vault.payment.once": "Approve this payment only",
      "vault.payment.raiseApprove": "Raise this session limit and approve",
      "vault.payment.amount": "Payment amount (satoshis)",
      "vault.payment.cumulative": "Session used / total after payment / limit",
      "vault.payment.singleExceeded": "Single payment limit exceeded",
      "vault.payment.sessionExceeded": "Session cumulative limit exceeded",
      "vault.payment.disabled": "Automatic approval disabled",
      "vault.payment.raise": "Raise current session cumulative limit (satoshis)",

      "vault.route.unlock": "Unlock wallet",
      "vault.route.create": "New wallet",
      "vault.route.currentKey": "Wallet key",
      "vault.route.autoLock": "Auto lock",
      "vault.crumb.settings": "Settings",
      "vault.crumb.currentKey": "Wallet key",
      "vault.crumb.autoLock": "Auto lock",
      "vault.command.lock": "Lock wallet",
      "vault.unlock.title": "Unlock wallet",
      "vault.unlock.description": "Enter the wallet key password to unlock. Only one key is kept in this browser.",
      "vault.unlock.password": "Password",
      "vault.unlock.submit": "Unlock",
      "vault.create.title": "New wallet",
      "vault.create.description": "Set a password and Keymaster will generate the one wallet key for this browser. The password never leaves this device and cannot be recovered if lost.",
      "vault.create.passwordNew": "New password",
      "vault.create.passwordConfirm": "Confirm password",
      "vault.create.submit": "Create wallet",
      "vault.create.err.tooShort": "Password must be at least 8 characters",
      "vault.create.err.mismatch": "Passwords do not match",
      "vault.create.err.failed": "Create failed",
      "vault.unlock.err.failed": "Unlock failed",
      "vault.currentKey.title": "Wallet key",
      "vault.currentKey.description": "This browser keeps exactly one wallet key. Replacing it requires resetting the wallet, which deletes all local wallet data.",
      "vault.currentKey.locked.hint": "The wallet is locked. Unlock it to manage the key.",
      "vault.currentKey.identity.label": "Current key",
      "vault.currentKey.export.title": "Encrypted KeyHold export",
      "vault.currentKey.export.description": "Export a standard KeyHold file containing the existing encrypted key material.",
      "vault.currentKey.export.notBackup": "This file contains the wallet key only \u2014 not contacts, messages, settings or other local data. It is not a full wallet backup.",
      "vault.currentKey.export.action": "Export KeyHold",
      "vault.settings.empty.label": "Unnamed",
      "vault.settings.actions.title": "Key actions",
      "vault.settings.action.rename": "Rename",
      "vault.settings.action.changePassword": "Change password",
      "vault.settings.action.resetWallet": "Reset wallet",
      "vault.settings.rename.title": "Rename key",
      "vault.settings.rename.label": "Name",
      "vault.settings.rename.submit": "Save",
      "vault.settings.err.rename": "Rename failed",
      "vault.settings.err.renameEmpty": "Name cannot be empty",
      "vault.keyHoldExport.title": "Export encrypted KeyHold",
      "vault.keyHoldExport.submit": "Export",
      "vault.keyHoldExport.hint": "Download the encrypted KeyHold for the current key. The file never contains a plaintext key, but it must be kept together with its password.",
      "vault.keyHoldExport.notBackup": "This file holds the wallet key only, not contacts, messages or settings. It is not a full wallet backup.",
      "vault.keyHoldExport.err.failed": "Export failed",
      "vault.changePassword.title": "Change password",
      "vault.changePassword.submit": "Confirm change",
      "vault.changePassword.hint": "Changing the password locks the wallet immediately. You will need to unlock again with the new password.",
      "vault.changePassword.oldPassword": "Current password",
      "vault.changePassword.newPassword": "New password",
      "vault.changePassword.confirmPassword": "Confirm new password",
      "vault.changePassword.err.oldRequired": "Enter the current password",
      "vault.changePassword.err.tooShort": "New password must be at least 8 characters",
      "vault.changePassword.err.mismatch": "The new passwords do not match",
      "vault.changePassword.err.failed": "Change password failed",
      "vault.resetWallet.title": "Reset wallet",
      "vault.resetWallet.submit": "Permanently delete local wallet data",
      "vault.resetWallet.danger": "Resetting deletes the current wallet key and all local wallet data in the new storage layout: contacts, message evidence, settings, module data and third-party app data. This cannot be undone.",
      "vault.resetWallet.scope": "It does not undo on-chain transactions or operations a server has already accepted; those follow their own recovery rules. Existing KeyHold export files stay valid on their own.",
      "vault.resetWallet.replace": "Afterwards you can create a new key or import an existing private key. The new wallet inherits none of this data.",
      "vault.resetWallet.confirmPrompt": "Type the current wallet name to confirm:",
      "vault.resetWallet.err.failed": "Reset failed",
      "vault.autolock.page.title": "Auto lock",
      "vault.autolock.page.description": "Lock the wallet automatically after inactivity. Changes take effect immediately.",
      "vault.autolock.summary.title": "Current policy",
      "vault.autolock.summary.enabled": "Enabled",
      "vault.autolock.summary.disabled": "Off",
      "vault.autolock.current.never": "Current: never auto-lock (stay unlocked).",
      "vault.autolock.current.timeout": "Current: auto-lock after {{minutes}} minutes of inactivity.",
      "vault.autolock.current.timeoutHours": "Current: auto-lock after {{hours}} hours of inactivity.",
      "vault.autolock.presets.label": "Lock duration",
      "vault.autolock.presets.title": "Lock after inactivity",
      "vault.autolock.presets.description": "Choose how long the wallet may stay unlocked. Changes take effect immediately.",
      "vault.autolock.presets.optionHint": "After inactivity",
      "vault.autolock.presets.neverHint": "Keep unlocked",
      "vault.autolock.presets.customHint": "Enter a precise duration",
      "vault.autolock.preset.minutes": "{{minutes}} minutes",
      "vault.autolock.preset.hours": "{{hours}} hours",
      "vault.autolock.preset.never": "Never",
      "vault.autolock.preset.custom": "Custom",
      "vault.autolock.back.label": "Back to quick options",
      "vault.autolock.custom.modalTitle": "Custom auto-lock duration",
      "vault.autolock.custom.modalDescription": "Enter a whole number of minutes between 1 and 1440.",
      "vault.autolock.custom.label": "Custom minutes (1-1440 minutes)",
      "vault.autolock.custom.placeholder": "e.g. 10",
      "vault.autolock.custom.unit": "minutes",
      "vault.autolock.custom.apply": "Apply",
      "vault.autolock.custom.applying": "Saving\u2026",
      "vault.autolock.custom.required": "Enter minutes (at least 1).",
      "vault.autolock.custom.invalid": "Enter a valid number of minutes.",
      "vault.autolock.custom.min": "At least 1 minute.",
      "vault.autolock.custom.max": "Up to 24 hours (1440 minutes); longer means \"Never\".",
      "vault.autolock.custom.tooLarge": "The number is too large. Try a smaller value.",
      "vault.autolock.saveFailed": "Save failed. Please try again later."
    },
    "zh-CN": {
      "vault.lock.cleaning": "正在锁定钱包，等待服务退出…完成后可解锁。",
      "vault.lock.cleanupFailed": "钱包已锁定，但部分服务清理失败。请重试清理，完成后才能解锁。",
      "vault.lock.details": "锁定错误详情",
      "vault.lock.retry": "重试清理",
      "vault.lock.retryFailed": "重试清理失败，请再次重试",
      "vault.lock.requestFailed": "锁定请求失败，请重试",
      "vault.lock.cleanupBlocked": "钱包清理尚未完成，请重试清理后再解锁",

      "vault.import.title": "迁入 RocKey",
      "vault.import.cancel": "取消",
      "vault.import.start": "继续迁移",
      "vault.import.connectionRequired": "请先连接 RocKey，核对两端配对码并在 RocKey 上确认。",
      "vault.import.pending": "正在迁移，请保持 USB 连接并按设备提示确认。",
      "vault.import.instructions": "空 RocKey 停留在首页即可连接。核对配对码并在设备上确认，随后继续迁移；设备收到原私钥后提示设置并重复确认 PIN，保存成功后才切换为硬件私钥。RocKey 已有私钥时不能迁入，包括相同私钥。提交前中断或刷新会保留原软件钱包；已解锁时无需再次输入软件钱包密码。",
      "vault.import.preserve": "迁移保留身份、网络、业务数据和渠道账本。只有核验硬件保存成功证明后，才移除软件私钥封装并将当前私钥改为硬件私钥，无需再次添加硬件钱包。",

      "vault.migration.erasedInstructions":"原设备已无旧私钥。请核对配对码和迁移记录；如仍需清理，请在设备上确认。",
      "vault.migration.failure": "上次迁回失败：",
      "vault.migration.action": "迁回软件钱包",
      "vault.migration.title": "迁回软件钱包",
      "vault.migration.cancel": "取消",
      "vault.migration.start": "继续迁移",
      "vault.migration.instructions": "请为软件钱包设置新密码。网页会向已连接的 RocKey 发起迁回请求，迁移保留当前身份、业务数据和渠道额度。",
      "vault.migration.saved": "浏览器已保存加密钱包和额度账本，软件钱包迁移已完成。",
      "vault.migration.confirmations": "请在 RocKey 上长按确认迁回。保存成功后，设备会独立询问是否擦除旧私钥；可以否决，保留设备备份。",
      "vault.migration.finish": "保存成功后自动进入软件钱包首页，无需再次输入密码。设备擦除决定不影响钱包使用。",
      "vault.migration.password": "新密码（至少 8 位）",
      "vault.migration.repeat": "再次输入新密码",
      "vault.migration.pending": "正在迁回，请在 RocKey 上长按授权并保持 USB 连接，等待加密钱包保存。",
      "vault.migration.recoveryTitle": "恢复未完成的迁移",
      "vault.migration.recoveryHelp": "请连接原 RocKey，继续同一身份的迁移。恢复连接期间，其它钱包业务保持锁定。",
      "vault.migration.resume": "继续迁移",
      "vault.migration.erasedOption": "原设备已经擦除私钥，仅恢复提交回执",

      "vault.currentKey.hardwareSecurity": "PIN 和设备备份请在 RocKey 上管理。",
      "vault.panel.wallet": "我的钱包",
      "vault.notifications.title": "通知历史",
      "vault.signing.register": "注册签名渠道",
      "vault.signing.approve": "请求签名授权",
      "vault.notifications.approve": "批准",
      "vault.notifications.deny": "不批准",
      "vault.notifications.waiting": "等待批准",
      "vault.notifications.processing": "正在处理",
      "vault.notifications.approved": "已批准",
      "vault.notifications.denied": "已拒绝",
      "vault.notifications.cancelled": "已取消",
      "vault.notifications.failed": "失败",
      "vault.notifications.unknown": "结果未知",
      "vault.notifications.loading": "正在读取通知…",
      "vault.notifications.empty": "暂无通知",
      "vault.notifications.registration": "渠道注册",
      "vault.notifications.payment": "支付请求",
      "vault.notifications.signature": "签名请求",
      "vault.notifications.device": "请在 RocKey 上批准或拒绝",
      "vault.notifications.automatic": "自动授权",
      "vault.notifications.manual": "手动确认",
      "vault.notifications.modeAutomatic": "自动",
      "vault.notifications.modeManual": "手动",
      "vault.notifications.modeUnknown": "方式未报告",
      "vault.panel.hardware": "RocKey 硬件钱包",
      "vault.panel.software": "软件钱包",
      "vault.panel.channels": "消费渠道与额度",
      "vault.panel.deviceOnly": "PIN、批准和否决在设备上操作。",
      "vault.panel.awaiting-user": "请在 RocKey 上阅读并确认",
      "vault.panel.executing": "设备正在执行",
      "vault.panel.completed": "设备操作已完成",
      "vault.panel.denied": "设备已否决",
      "vault.panel.cancelled": "操作已取消",
      "vault.panel.unknown": "操作结果未知，请勿自动重试",
      "vault.panel.failed": "设备操作失败",
      "vault.signatureHistory.connectIdentity": "App 连接身份签名",
      "vault.signatureHistory.connectIntent": "App 意图签名",
      "vault.signatureHistory.bitfsWire": "BitFS 协议签名",
      "vault.signatureHistory.publicMessage": "公开通信签名",
      "vault.signatureHistory.hashRequest": "通信摘要签名",
      "vault.signatureHistory.privateMessage": "私密通信签名",
      "vault.signatureHistory.digest": "摘要签名",
      "vault.signatureHistory.records": "记录数",
      "vault.signatureHistory.filter": "筛选记录",
      "vault.signatureHistory.time": "请求时间",
      "vault.signatureHistory.purpose": "用途 / 渠道",
      "vault.signatureHistory.source": "来源 / 私钥",
      "vault.signatureHistory.amount": "金额 (sat)",
      "vault.signatureHistory.authorization": "授权方式",
      "vault.signatureHistory.result": "结果",
      "vault.signatureHistory.perPage": "每页 10 条",
      "vault.signatureHistory.pagination": "签名记录分页",
      "vault.signatureHistory.previous": "上一页",
      "vault.signatureHistory.next": "下一页",
      "vault.signatureHistory.title": "签名记录",
      "vault.signatureHistory.scope": "这里只记录 Keymaster 经手的请求，硬件不保存历史。",
      "vault.signatureHistory.automatic": "自动授权",
      "vault.signatureHistory.manual": "手动确认",
      "vault.signatureHistory.unreported": "未报告",
      "vault.signatureHistory.pending": "等待结果",
      "vault.signatureHistory.completed": "签名成功",
      "vault.signatureHistory.denied": "已拒绝",
      "vault.signatureHistory.cancelled": "已取消",
      "vault.signatureHistory.failed": "失败",
      "vault.signatureHistory.unknown": "结果未知",
      "vault.signatureHistory.all": "全部",
      "vault.signatureHistory.abnormal": "异常",
      "vault.signatureHistory.empty": "暂无签名记录",
      "vault.signatureHistory.software": "软私钥",
      "vault.signatureHistory.hardware": "硬私钥",
      "vault.signatureHistory.finished": "完成时间",
      "vault.signatureHistory.noise": "网络握手身份",
      "vault.signatureHistory.peerRecord": "网络身份广播",
      "vault.signatureHistory.p2pkh": "P2PKH 交易",
      "vault.signatureHistory.standard": "BSV 交易",
      "vault.signatureHistory.feepool": "费用池交易",
      "vault.signatureHistory.feepoolBitfs": "BitFS 费用池交易",
      "vault.hardware.title": "连接硬件钱包",
      "vault.hardware.enrollBody": "使用 RocKey 上的 Key 建立钱包。PIN 和私钥由设备管理。",
      "vault.hardware.instructions": "先在设备上输入 PIN 解锁 RocKey，再连接 USB 并核对两端配对码。",
      "vault.hardware.unavailable": "此浏览器不支持所需的 USB 串口连接。",
      "vault.hardware.pairing": "核对两端配对码，在 RocKey 上长按确认：",
      "vault.hardware.connect": "连接 RocKey",
      "vault.hardware.disconnect": "断开连接",
      "vault.hardware.connected": "RocKey 已验证连接。",
      "vault.payment.change": "本 Key 找零（聪）",
      "vault.payment.fee": "矿工费（聪，计入实际花费）",
      "vault.payment.spendApproval": "花费签名确认",
      "vault.payment.automaticNotice": "额度内自动花费签名",
      "vault.payment.actualSpend": "实际花费（含矿工费，聪）",
      "vault.payment.feeIncluded": "矿工费（聪，已计入实际花费）",
      "vault.payment.ownReturn": "本钱包所有 P2PKH 返还（聪）",
      "vault.payment.wallet": "当前钱包",
      "vault.payment.network": "网络",
      "vault.payment.businessAmount": "业务金额（不含矿工费，聪）",
      "vault.payment.soundUnavailable": "提示音未播放；检查浏览器音频权限或输出设备。签名策略不因此改变。",
      "vault.payment.retrySound": "重试提示音",
      "vault.payment.soundScheduled": "已请求播放提示音（不代表实体扬声器已发声）",
      "vault.payment.soundPending": "正在请求播放提示音…",
      "vault.payment.dismissNotice": "关闭提示",
      "vault.payment.pool": "费用池",
      "vault.payment.poolFund": "资金存入",
      "vault.payment.poolState": "累计状态交易",
      "vault.payment.poolPaid": "池内累计对外付款（聪）",
      "vault.payment.poolLocked": "本次存入池内金额（聪）",
      "vault.payment.outputs": "实际交易输出（含找零）",
      "vault.channels.title": "钱包授权渠道",
      "vault.channels.description": "按渠道管理签名授权和支付额度；超过免确认额度仍可手动批准。",
      "vault.channels.hardware": "RocKey · 只读",
      "vault.channels.software": "软件钱包 · 可设置",
      "vault.channels.loading": "正在读取渠道…",
      "vault.channels.signing": "签名授权",
      "vault.channels.channel": "渠道",
      "vault.channels.owner": "来源",
      "vault.channels.strategy": "授权策略",
      "vault.channels.action": "操作",
      "vault.channels.signingEmpty": "尚无已注册的签名渠道",
      "vault.channels.onDevice": "设备上设置",
      "vault.channels.sessionHint": "仅检查每笔实际花费（含矿工费）；会话只用于身份与撤权，不累计限制。金额单位：聪（sat）。",
      "vault.channels.single": "单笔免确认",
      "vault.channels.session": "新会话免确认总额",
      "vault.channels.status": "免确认",
      "vault.channels.app": "外部 App",
      "vault.channels.plugin": "内部插件",
      "vault.channels.enabled": "已开启",
      "vault.channels.disabled": "已关闭",
      "vault.channels.editHint": "实际花费含矿工费，不超过已启用的单笔额度免确认；超出或未设置会请求确认。",
      "vault.payment.channels": "支付渠道",
      "vault.payment.empty": "尚无已注册的支付渠道",
      "vault.payment.single": "单笔免确认额度（聪）",
      "vault.payment.default": "新会话累计免确认额度（聪）",
      "vault.payment.edit": "修改额度",
      "vault.payment.cancel": "取消",
      "vault.payment.save": "保存额度",
      "vault.payment.enabled": "启用免确认",
      "vault.payment.approval": "付款超过免确认额度",
      "vault.payment.deny": "拒绝",
      "vault.payment.once": "仅批准本次",
      "vault.payment.raiseApprove": "提高本会话额度并批准",
      "vault.payment.amount": "支付金额（聪）",
      "vault.payment.cumulative": "会话已用／本次后累计／额度",
      "vault.payment.singleExceeded": "超过单笔额度",
      "vault.payment.sessionExceeded": "超过会话累计额度",
      "vault.payment.disabled": "免确认已关闭",
      "vault.payment.raise": "提高当前会话累计额度（聪）",

      "vault.route.unlock": "解锁钱包",
      "vault.route.create": "创建钱包",
      "vault.route.currentKey": "钱包 Key",
      "vault.route.autoLock": "自动锁屏",
      "vault.crumb.settings": "设置",
      "vault.crumb.currentKey": "钱包 Key",
      "vault.crumb.autoLock": "自动锁屏",
      "vault.command.lock": "锁定钱包",
      "vault.unlock.title": "解锁钱包",
      "vault.unlock.description": "输入钱包 Key 密码解锁。本浏览器只保存这一把 Key。",
      "vault.unlock.password": "密码",
      "vault.unlock.submit": "解锁",
      "vault.create.title": "新建钱包",
      "vault.create.description": "设置一个本地密码，Keymaster 会为本浏览器生成唯一一把钱包 Key。该密码不会离开本机，丢失后无法找回。",
      "vault.create.passwordNew": "新密码",
      "vault.create.passwordConfirm": "确认密码",
      "vault.create.submit": "新建钱包",
      "vault.create.err.tooShort": "密码至少 8 位",
      "vault.create.err.mismatch": "两次密码不一致",
      "vault.create.err.failed": "创建失败",
      "vault.unlock.err.failed": "解锁失败",
      "vault.currentKey.title": "钱包 Key",
      "vault.currentKey.description": "本浏览器只保存一把钱包 Key。更换身份需要先重置钱包，那会删除全部本地钱包数据。",
      "vault.currentKey.locked.hint": "钱包当前处于锁定状态，解锁后可管理 Key。",
      "vault.currentKey.identity.label": "当前 Key",
      "vault.currentKey.export.title": "加密 KeyHold 导出",
      "vault.currentKey.export.description": "导出标准 KeyHold 文件，保留原有加密密钥材料。",
      "vault.currentKey.export.notBackup": "该文件只含钱包 Key，不含联系人、消息、设置等本地业务数据，不能当作完整钱包备份。",
      "vault.currentKey.export.action": "导出 KeyHold",
      "vault.settings.empty.label": "未命名",
      "vault.settings.actions.title": "Key 操作",
      "vault.settings.action.rename": "重命名",
      "vault.settings.action.changePassword": "修改密码",
      "vault.settings.action.resetWallet": "重置钱包",
      "vault.settings.rename.title": "重命名 Key",
      "vault.settings.rename.label": "名称",
      "vault.settings.rename.submit": "保存",
      "vault.settings.err.rename": "重命名失败",
      "vault.settings.err.renameEmpty": "名称不能为空",
      "vault.keyHoldExport.title": "导出加密 KeyHold",
      "vault.keyHoldExport.submit": "导出",
      "vault.keyHoldExport.hint": "将下载当前 Key 的加密 KeyHold 文件。文件不包含明文私钥，但必须与对应密码一起妥善保管。",
      "vault.keyHoldExport.notBackup": "该文件只含钱包 Key，不含联系人、消息或设置，不能当作完整钱包备份。",
      "vault.keyHoldExport.err.failed": "导出失败",
      "vault.changePassword.title": "修改密码",
      "vault.changePassword.submit": "确认修改",
      "vault.changePassword.hint": "修改密码后钱包会立即锁定，你需要用新密码重新解锁。",
      "vault.changePassword.oldPassword": "当前密码",
      "vault.changePassword.newPassword": "新密码",
      "vault.changePassword.confirmPassword": "确认新密码",
      "vault.changePassword.err.oldRequired": "请输入当前密码",
      "vault.changePassword.err.tooShort": "新密码至少 8 位",
      "vault.changePassword.err.mismatch": "两次新密码不一致",
      "vault.changePassword.err.failed": "修改密码失败",
      "vault.resetWallet.title": "重置钱包",
      "vault.resetWallet.submit": "永久删除本地钱包数据",
      "vault.resetWallet.danger": "重置会删除当前钱包 Key 以及新存储结构中的全部本地钱包数据：联系人、消息记录、设置、模块数据和第三方 App 数据都将被清空，且无法撤销。",
      "vault.resetWallet.scope": "这不会撤销链上交易或服务端已经接受的操作；那类结果按对应业务的恢复规则处理。已有的 KeyHold 导出文件不会因此失效。",
      "vault.resetWallet.replace": "之后可以重新创建一把新 Key，或导入已有私钥；新钱包不会继承这里的任何数据。",
      "vault.resetWallet.confirmPrompt": "输入当前钱包名称以确认：",
      "vault.resetWallet.err.failed": "重置失败",
      "vault.autolock.page.title": "自动锁屏",
      "vault.autolock.page.description": "无操作一段时间后自动锁屏，修改立即生效。",
      "vault.autolock.summary.title": "当前策略",
      "vault.autolock.summary.enabled": "已启用",
      "vault.autolock.summary.disabled": "已关闭",
      "vault.autolock.current.never": "当前：永不自动锁定（一直不锁）。",
      "vault.autolock.current.timeout": "当前：无操作 {{minutes}} 分钟后自动锁定。",
      "vault.autolock.current.timeoutHours": "当前：无操作 {{hours}} 小时后自动锁定。",
      "vault.autolock.presets.label": "锁定时长",
      "vault.autolock.presets.title": "无操作后锁定",
      "vault.autolock.presets.description": "选择钱包保持解锁的时长，设置会立即生效。",
      "vault.autolock.presets.optionHint": "无操作后",
      "vault.autolock.presets.neverHint": "一直保持解锁",
      "vault.autolock.presets.customHint": "输入精确时长",
      "vault.autolock.preset.minutes": "{{minutes}} 分钟",
      "vault.autolock.preset.hours": "{{hours}} 小时",
      "vault.autolock.preset.never": "永不",
      "vault.autolock.preset.custom": "自定义",
      "vault.autolock.back.label": "返回快捷选项",
      "vault.autolock.custom.modalTitle": "自定义自动锁屏",
      "vault.autolock.custom.modalDescription": "输入 1 到 1440 分钟之间的整数时长。",
      "vault.autolock.custom.label": "自定义分钟数（1～1440 分钟）",
      "vault.autolock.custom.placeholder": "例如：10",
      "vault.autolock.custom.unit": "分钟",
      "vault.autolock.custom.apply": "应用",
      "vault.autolock.custom.applying": "保存中…",
      "vault.autolock.custom.required": "请输入分钟数（至少 1 分钟）。",
      "vault.autolock.custom.invalid": "请输入有效的分钟数。",
      "vault.autolock.custom.min": "至少 1 分钟。",
      "vault.autolock.custom.max": "最多 24 小时（1440 分钟），更长请选择「永不」。",
      "vault.autolock.custom.tooLarge": "数值过大，请缩小后重试。",
      "vault.autolock.saveFailed": "保存失败，请稍后重试。"
    }
  }
};

const vaultPluginDefinition = {
  id: "vault",
  name: "Vault",
  description: "单 Key 本地钱包：管理唯一钱包 Key 的加密存储、内存解密与生命周期。",


  // Vault 必须最早可用：未初始化时它是「创建 / 导入钱包 Key」的唯一入口，
  // locked 时是解锁页的唯一入口。这两种状态都发生在本地钱包 Root 就绪
  // 之前或之后的冷启动路径上，晚于第一阶段就拿不到 vault.service。

  units: [{
    id: "vault.window",
    runtime: "window-main",
    connect: { providerMethods: ["identity.get", "intent.sign", "cipher.encrypt", "cipher.decrypt", "payment.channel.register"] },
    scopeKind: "root",
    provides: [VAULT_CAPABILITY, VAULT_WALLET_STATE_CAPABILITY, VAULT_LOCAL_SECRET_CAPABILITY, AUTOLOCK_SERVICE_CAPABILITY],
    dependencies: [
      { capability: VAULT_COORDINATOR_CLIENT_BINDING_CAPABILITY, sourceRuntime: "window-main", reason: "声明本插件的受限 Coordinator 连接" },
      { capability: PAGE_UI_RENDERER_CAPABILITY, sourceRuntime: "window-main", reason: "Page onboarding 布局" },
      { capability: RESOURCE_REGISTRY_CAPABILITY, sourceRuntime: "window-main", reason: "vault key resource" },
      { capability: PAGE_UI_REGISTRY_CAPABILITY, sourceRuntime: "window-main", reason: "vault routes" },
      { capability: OWNED_RESOURCE_ACCESS_CAPABILITY, sourceRuntime: "window-main", reason: "Vault 私有 UI 资源" },
      { capability: I18N_SERVICE_CAPABILITY, sourceRuntime: "window-main", reason: "Vault UI 文案" },
      { capability: BUSINESS_REGISTRY_CAPABILITY, sourceRuntime: "window-main", reason: "vault settings navigation" },
      { capability: BREADCRUMB_REGISTRY_CAPABILITY, sourceRuntime: "window-main", reason: "vault breadcrumbs" },
    ],
  }, {
    id: "vault.coordinator-worker",
    storage: CENTRAL_STORAGE_DECLARATIONS.vaultPayments,
    runtime: "shared-worker",
    scopeKind: "root",
    provides: [COORDINATOR_CRYPTO_RPC_CAPABILITY, VAULT_WALLET_STATE_CAPABILITY, VAULT_WORKER_CRYPTO_CAPABILITY, VAULT_WORKER_WALLET_CONTROL_CAPABILITY],
  }],
  i18n: { namespace: "vault", resources: Object.fromEntries((["en", "zh-CN"] as const).map(language => [language, Object.assign({}, vaultResources.resources[language], ...[keyImportResources, hexResources, wifResources, jsonFileResources].map(resource => resource.resources[language]))])) },
  setup(ctx) {
    // 两个 facade 都只从同一个已提交的 session 镜像派生：vault 管生命周期，
    // walletState 只投影当前唯一 Key 的公钥身份。
    const coordinatorClient = ctx.capability(VAULT_COORDINATOR_CLIENT_BINDING_CAPABILITY).bind(ctx.consumer, ctx.scope) as VaultCoordinatorControl | undefined;
    if (!coordinatorClient) throw new Error("Session Coordinator is unavailable");
    if (!coordinatorClient.getIsConnected()) throw new Error("Session Coordinator is unavailable");

    const sessionStateMirror = new SessionStateMirror(coordinatorClient);
    const service = createVaultServiceCoordinator({ coordinatorClient, sessionStateMirror });
    ctx.scope.onRevoke(() => service.dispose?.());
    const importers = createVaultImporters();
    const walletStateAccess = createWalletStateAccess({ snapshot: () => service.walletSnapshot(), subscribe: handler => service.subscribeWalletState(handler) }, ctx.scope);

    ctx.provide(VAULT_CAPABILITY, createPublicVaultService(service));
    ctx.provide(VAULT_WALLET_STATE_CAPABILITY, walletStateAccess);
    ctx.provide(VAULT_LOCAL_SECRET_CAPABILITY, createVaultLocalSecretService(coordinatorClient));

    // 自动锁 facade：真值在 Coordinator，页面经 session.state 收敛多 tab。
    const autoLockService: AutoLockService = createAutoLockServiceCoordinator({ coordinatorClient });
    ctx.provide(AUTOLOCK_SERVICE_CAPABILITY, autoLockService);

    const resources = ctx.capability(RESOURCE_REGISTRY_CAPABILITY);
    resources.register<AutoLockSettings, readonly string[]>({
      id: "vault.autoLockSettings",
      scope: "global",
      key: () => ["vault.autoLockSettings"],
      load: async () => autoLockService.getSettings(),
      subscribe: (_args, _ctx, invalidate) => autoLockService.onSettingsChanged(invalidate),
      equals: (prev, next) => {
        if (!prev || !next) return prev === next;
        return prev.timeoutMs === next.timeoutMs;
      },
      invalidation: "immediate"
    });
    resources.register<VaultKeyResourceState, readonly string[]>({
      id: "vault.key-state",
      // 资源键绑定运行世代与钱包身份世代：Worker 重启或钱包重置后必须重新
      // 加载，否则 UI 会继续展示上一轮运行的旧授权与旧身份。
      scope: "global",
      key: (_args, context) => {
        const state = context.activePublicKeyHex;
        return ["vault.key-state", state ?? "no-wallet-key"];
      },
      load: async () => {
        const snapshot = service.walletSnapshot();
        return {
          // 锁定时不投影公钥：页面不应在未解锁时继续持有身份。
          ...(snapshot.status === "unlocked" && snapshot.activePublicKeyHex
            ? { activePublicKeyHex: snapshot.activePublicKeyHex }
            : {}),
          status: snapshot.status,
          runGeneration: snapshot.runGeneration,
          ...(snapshot.walletGeneration === undefined ? {} : { walletGeneration: snapshot.walletGeneration }),
          revision: snapshot.vaultLifecycleRevision,
        };
      },
      subscribe: (_args, _ctx, invalidate) => service.subscribeWalletState(invalidate),
      equals: (a, b) => (a !== undefined && b !== undefined && (
        a.status === b.status
        && a.activePublicKeyHex === b.activePublicKeyHex
        && a.runGeneration === b.runGeneration
        && a.walletGeneration === b.walletGeneration
        && a.revision === b.revision
      )),
      invalidation: "immediate"
    });

    resources.register<WalletGuard, readonly string[]>({ id: "vault.wallet-guard", scope: "active-key", key: (_args, context) => ["vault.wallet-guard", context.activePublicKeyHex ?? "none"],
      load: () => evaluateShellGuard({ vaultStatus: service.status(), getCurrentKey: () => service.getCurrentKey(), projectedPublicKeyHex: service.walletSnapshot().activePublicKeyHex }),
      equals: areShellGuardStatesEqual, subscribe: (_args, _context, invalidate) => service.subscribeWalletState(invalidate), invalidation: "immediate" });

    const pages = ctx.capability(PAGE_UI_REGISTRY_CAPABILITY).bind(ctx.consumer, ctx.scope).view;
    const Guard = bindVaultUi(ctx, VaultWalletGuard, service, importers);
    const Lock = bindVaultUi(ctx, VaultLockButton, service, importers);
    const sendActivity = () => coordinatorClient.sendActivity();
    pages.register({ kind: "frame", slot: "wallet-guard", id: "vault.wallet-guard", label: "Wallet", render: location => createElement(Guard, { children: location.children, sendActivity }) });
    pages.register({ kind: "header", slot: "topbar", id: "vault.lock-button", order: 1000, label: "Lock", render: () => createElement(Lock) });
    const WalletEntry = bindVaultUi(ctx, VaultWalletEntry, service, importers);
    pages.register({ kind: "frame", slot: "wallet-entry", id: "vault.wallet-entry", label: "Wallet", render: () => createElement(WalletEntry) });
    const Unlock = bindVaultUi(ctx, VaultUnlockPage, service, importers);
    const Create = bindVaultUi(ctx, VaultCreatePage, service, importers);
    const CurrentKey = bindVaultUi(ctx, CurrentKeySettingsPage, service, importers);
    const AutoLock = bindVaultUi(ctx, AutoLockSettingsPage, service, importers);
    for (const [id, path, label, Component] of [
      ["vault.unlock", "/vault/unlock", { key: "vault.route.unlock", fallback: "Unlock wallet" }, Unlock],
      ["vault.create", "/vault/create", { key: "vault.route.create", fallback: "New wallet" }, Create],
      ["vault.current-key", "/settings/current-key", { key: "vault.route.currentKey", fallback: "Wallet key" }, CurrentKey],
      ["vault.auto-lock", "/settings/auto-lock", { key: "vault.route.autoLock", fallback: "Auto lock" }, AutoLock],
    ] as const) pages.register({ kind: "page", id, path, label, render: () => createElement(Component) });

    const business = ctx.capability(BUSINESS_REGISTRY_CAPABILITY);
    business.registerFeature("vault", "settings", {
      id: "settings.current-key",
      label: { key: "vault.route.currentKey", fallback: "Wallet key" },
      description: { key: "vault.currentKey.description", fallback: "Manage the single wallet key kept in this browser." },
      order: 12,
      icon: "ShieldCheck",
      entry: { path: "/settings/current-key", routeId: "vault.current-key" }
    });
    business.registerFeature("vault", "settings", {
      id: "settings.auto-lock",
      label: { key: "vault.route.autoLock", fallback: "Auto lock" },
      description: { key: "vault.autolock.page.description", fallback: "Lock the wallet automatically after inactivity." },
      order: 13,
      icon: "LockKeyhole",
      entry: { path: "/settings/auto-lock", routeId: "vault.auto-lock" }
    });

    // 面包屑第一段固定为不可点击的「设置」分类节点。
    const breadcrumbs = ctx.capability(BREADCRUMB_REGISTRY_CAPABILITY);
    breadcrumbs.register({
      id: "breadcrumb.vault.current-key",
      order: 0,
      match: (path) => path === "/settings/current-key",
      resolve: () => [
        { label: { key: "vault.crumb.settings", fallback: "Settings" } },
        { label: { key: "vault.crumb.currentKey", fallback: "Wallet key" } }
      ]
    });
    breadcrumbs.register({
      id: "breadcrumb.vault.auto-lock",
      order: 1,
      match: (path) => path === "/settings/auto-lock",
      resolve: () => [
        { label: { key: "vault.crumb.settings", fallback: "Settings" } },
        { label: { key: "vault.crumb.autoLock", fallback: "Auto lock" } }
      ]
    });


    // 实例释放时收回本实例服务；service.lock()
    // 等动作由 vault 命令触发，不属于 ownership 回收范围。
    return () => {
      service.dispose?.();
      autoLockService.dispose?.();
    };
  }
} satisfies PluginManifest & { setup: PluginSetup };

const { setup: vaultSetup, ...vaultPlugin } = vaultPluginDefinition;
export { vaultSetup, vaultPlugin };
export type { VaultWalletState, VaultService };
