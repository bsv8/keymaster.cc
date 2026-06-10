// apps/web/src/i18n/resources.ts
// apps/web shell 层的 i18n 资源：app shell 的展示文案（sidebar group / topbar / LockedShell 等）。
// 设计缘由：apps/web 是装配层，可以提供 shell 专用 namespace `shell`，
// 在 bootstrap 之前通过 initialResources 注入到 i18n service，
// 让 Topbar / LockedShell 的 t() 调用能命中。

import type { I18nPluginResources } from "@keymaster/contracts";

export const SHELL_RESOURCES: I18nPluginResources = {
  namespace: "shell",
  resources: {
    en: {
      "shell.topbar.openMenu": "Open menu",
      "shell.topbar.statusLabel": "Status: ",
      "shell.topbar.language.label": "Switch language",
      "shell.locked.welcome.subtitle": "Welcome. Pick a flow to start:",
      "shell.locked.card.newTitle": "New wallet",
      "shell.locked.card.newBody": "Set a local password and immediately generate your first Key. You can import more keys later.",
      "shell.locked.card.newCta": "Set password →",
      "shell.locked.card.importTitle": "Import a key",
      "shell.locked.card.importBody": "Already have a WIF / Hex / JSON file? Set a password to store the vault first, then pick a format.",
      "shell.locked.card.importCta": "Set password and import →",
      "shell.locked.notice.title": "Your keys never leave the browser",
      "shell.locked.notice.body": "All private keys are encrypted locally with WebCrypto AES-GCM. The password is never uploaded.",
      "shell.locked.notice.persisted": "Wallet is ready, but the first Key could not be set as active automatically. Please switch it manually in Key management.",
      "shell.locked.passwordTooShort": "Password must be at least 8 characters",
      "shell.locked.passwordMismatch": "Passwords do not match",
      "shell.locked.createFailed": "Create failed",
      "shell.locked.createInitialKeyFailed": "Failed to create the first Key",
      "shell.locked.unlockFailed": "Unlock failed",
      "shell.locked.passwordNew": "New password",
      "shell.locked.passwordConfirm": "Confirm password",
      "shell.locked.password": "Password",
      "shell.locked.newWallet": "New wallet",
      "shell.locked.newWalletDesc": "Set a local password. The Vault will then generate your first Key and set it as active. The password is stored only on this device and is used to encrypt your keys.",
      "shell.locked.createForImport": "Create a password, then import a key",
      "shell.locked.createForImportDesc": "Importing a key requires a local vault to store it first.",
      "shell.locked.lockedTitle": "Wallet locked",
      "shell.locked.lockedDesc": "Unlock the local Vault first. After unlocking you can import or manage keys.",
      "shell.locked.create": "Create",
      "shell.locked.createContinueImport": "Create and continue import",
      "shell.locked.menuItem": "Menu",
      "shell.unlocked.notice.activationPending": "First Key was saved, but it could not be set as active automatically. Please switch it manually in Key management.",
      "shell.unlocked.notice.dismiss": "Got it",
      "common.action.back": "Back"
    },
    "zh-CN": {
      "shell.topbar.openMenu": "打开菜单",
      "shell.topbar.statusLabel": "状态：",
      "shell.topbar.language.label": "切换语言",
      "shell.locked.welcome.subtitle": "欢迎。选择你要开始的流程：",
      "shell.locked.card.newTitle": "新建钱包",
      "shell.locked.card.newBody": "设置一个本地密码，并立即生成你的第一把 Key。之后可以继续导入其他私钥。",
      "shell.locked.card.newCta": "设置密码 →",
      "shell.locked.card.importTitle": "导入私钥",
      "shell.locked.card.importBody": "已经有 WIF / Hex / JSON 文件私钥？先设置密码保存 vault，再选择格式导入。",
      "shell.locked.card.importCta": "设置密码并导入 →",
      "shell.locked.notice.title": "私钥不会离开你的浏览器",
      "shell.locked.notice.body": "所有私钥在本地用 WebCrypto AES-GCM 加密，密码不会上传到任何服务器。",
      "shell.locked.notice.persisted": "钱包已建好，但首把 Key 未能自动设为 active，请在 Key 管理中手动切换。",
      "shell.locked.passwordTooShort": "密码至少 8 位",
      "shell.locked.passwordMismatch": "两次密码不一致",
      "shell.locked.createFailed": "创建失败",
      "shell.locked.createInitialKeyFailed": "创建首把 Key 失败",
      "shell.locked.unlockFailed": "解锁失败",
      "shell.locked.passwordNew": "新密码",
      "shell.locked.passwordConfirm": "确认密码",
      "shell.locked.password": "密码",
      "shell.locked.newWallet": "新建钱包",
      "shell.locked.newWalletDesc": "设置一个本地密码。Vault 接下来会生成你的第一把 Key 并自动设为 active。该密码仅保存在本机，用于加密你的私钥。",
      "shell.locked.createForImport": "创建密码后导入私钥",
      "shell.locked.createForImportDesc": "导入私钥需要先创建一个本地 vault 来保存它。",
      "shell.locked.lockedTitle": "钱包已锁定",
      "shell.locked.lockedDesc": "需要先解锁本地 Vault，解锁后可以导入或管理私钥。",
      "shell.locked.create": "创建",
      "shell.locked.createContinueImport": "创建并继续导入",
      "shell.locked.menuItem": "菜单",
      "shell.unlocked.notice.activationPending": "首把 Key 已保存，但未能自动设为 active。请在 Key 管理中手动切换。",
      "shell.unlocked.notice.dismiss": "知道了",
      "common.action.back": "返回"
    }
  }
};
