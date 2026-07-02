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
      "shell.locked.welcome.title": "Welcome to Keymaster",
      "shell.locked.welcome.subtitle": "Welcome. Pick a flow to start:",
      "shell.locked.card.newTitle": "New wallet",
      "shell.locked.card.newBody":
        "Set a local password and immediately generate your first Key. You can import more keys later.",
      "shell.locked.card.newCta": "Set password →",
      "shell.locked.card.importTitle": "Import a key",
      // 硬切换 010：导入文案必须明确"先解析、再一次性建 Vault + 落首把导入 key"，
      // 不再暗示"先创建密码保存 vault、再导入"。
      "shell.locked.card.importBody":
        "Already have a WIF / Hex / JSON file? Parse it first, then set a local password. The Vault and your first imported Key are created together in one step.",
      "shell.locked.card.importCta": "Start import →",
      "shell.locked.notice.title": "Your keys never leave the browser",
      "shell.locked.notice.body":
        "All private keys are encrypted locally with WebCrypto AES-GCM. The password is never uploaded.",
      "shell.locked.notice.persisted":
        "Wallet is ready, but the first Key could not be set as active automatically. Please switch it manually in Key management.",
      "shell.locked.passwordTooShort": "Password must be at least 8 characters",
      "shell.locked.passwordMismatch": "Passwords do not match",
      "shell.locked.createFailed": "Create failed",
      "shell.locked.createInitialKeyFailed": "Failed to create the first Key",
      "shell.locked.unlockFailed": "Unlock failed",
      "shell.locked.passwordNew": "New password",
      "shell.locked.passwordConfirm": "Confirm password",
      "shell.locked.password": "Password",
      "shell.locked.newWallet": "New wallet",
      // 硬切换 010：明确"立即生成第一把 Key"，与施工单"新建钱包"语义对齐。
      "shell.locked.newWalletDesc":
        "Set a local password. The Vault will then immediately generate your first Key and set it as active. The password is stored only on this device and is used to encrypt your keys.",
      "shell.locked.lockedTitle": "Wallet locked",
      // 硬切换 010：locked 状态说明，明确"需要先解锁才能导入或管理私钥"。
      "shell.locked.lockedDesc":
        "Unlock the local Vault first. After unlocking you can import more keys or manage them.",
      "shell.locked.create": "Create",
      "shell.locked.menuItem": "Menu",
      "shell.unlocked.notice.activationPending":
        "First Key was saved, but it could not be set as active automatically. Please switch it manually in Key management.",
      "shell.unlocked.notice.dismiss": "Got it",
      // 硬切换 010：首启导入向导文案。业务顺序固定为：先选导入方式 →
      // 输入 / 解析 → 确认 → 设置本机系统锁屏密码。导入源密码与本机
      // 系统锁屏密码是两个独立字段，UI 允许"使用同一密码"勾选。
      "shell.import.wizard.pickImporterTitle": "Import a key: 1. Pick a format",
      "shell.import.wizard.pickImporterDesc":
        "Choose a format. Your private key is parsed locally and never uploaded.",
      "shell.import.wizard.inputTitle": "Import a key: 2. Input",
      "shell.import.wizard.inputDesc": "Paste or upload your private key material.",
      "shell.import.wizard.confirmKeyTitle": "Import a key: 3. Confirm the parsed key",
      "shell.import.wizard.confirmKeyDesc":
        "Confirm the label, then continue to set the local Vault password.",
      "shell.import.wizard.setPasswordTitle": "Import a key: 4. Set a local Vault password",
      "shell.import.wizard.setPasswordDesc":
        "The Vault password is stored only on this device. It is used to encrypt the imported key. The import-source password and the local Vault password are two independent fields.",
      "shell.import.wizard.useSamePassword":
        "Use the import-source password as the local Vault password",
      "shell.import.wizard.importPassword":
        "Import-source password (also used as the local Vault password)",
      // 硬切换 010 修复：模式 1（importer 不需要密码）下需要单独
      // 的"本机系统锁屏密码"label，与"新密码"区分以避免歧义。
      "shell.import.wizard.vaultPasswordOnly": "Local Vault password",
      "shell.import.wizard.placeholder.vaultPassword": "At least 8 characters",
      "shell.import.wizard.confirm": "Create Vault and import",
      // 硬切换 011：第 4 步复用导入源密码时显示的说明文案；UI 隐藏
      // 密码输入框并把密码以"已应用"形式提示用户。
      "shell.import.wizard.reuseNotice":
        "Reusing the import-source password you entered in step 2. The Vault will be created and unlocked with this password.",
      "shell.import.wizard.reuseLabel": "Password to use",
      "shell.import.wizard.reuseOrigin":
        "From step 2 (import-source password, kept in this wizard's memory only).",
      "shell.import.wizard.newPasswordTitle": "Set a new local Vault password",
      "shell.import.wizard.newPasswordDesc":
        "This password replaces the import-source password. It is stored only on this device.",
      // 硬切换 011：onboarding 共享 header 文案。welcome / 新建钱包 /
      // 解锁 / 首启导入各 step 都使用同一套文案。
      "shell.onboarding.brandSubtitle": "Local key vault",
      "shell.onboarding.securityNote":
        "Your keys never leave the browser. The password is never uploaded.",
      "shell.onboarding.theme.toggle": "Switch theme",
      "shell.onboarding.theme.auto": "Auto",
      "shell.onboarding.theme.autoHint": "Follow the system",
      "shell.onboarding.theme.light": "Light",
      "shell.onboarding.theme.lightHint": "Light theme",
      "shell.onboarding.theme.dark": "Dark",
      "shell.onboarding.theme.darkHint": "Dark theme",
      "shell.onboarding.theme.autoActive": "Auto (currently {theme})",
      // 硬切换 011：step progress 文案（四步向导）。
      "shell.onboarding.step.pickImporter": "Pick a format",
      "shell.onboarding.step.input": "Provide material",
      "shell.onboarding.step.confirmKey": "Confirm result",
      "shell.onboarding.step.setPassword": "Set lock password",
      "shell.onboarding.step.state.current": "Current",
      "shell.onboarding.step.state.done": "Done",
      "shell.onboarding.step.state.upcoming": "Upcoming",
      // 硬切换 011 修复：步骤进度 `<nav>` 的 aria-label 也必须 i18n，
      // 辅助技术读到的导航名才能跟随语言切换。
      "shell.onboarding.step.navLabel": "Import wizard steps",
      // 施工单 2026-07-02 001：sidebar group 走 i18n 解析，未注册时
      // 回退到原 group id。`settings` 由 plugin-settings 的 menu / 路由
      // 注入时已经走 Sidebar 特殊分支，这里补的 key 仅供"普通 menu
      // 分组"使用；settings 分组仍然由 host.settings.list() 单独渲染。
      "shell.menu.group.system": "System",
      "common.action.back": "Back",
      "common.action.next": "Next"
    },
    "zh-CN": {
      "shell.topbar.openMenu": "打开菜单",
      "shell.topbar.statusLabel": "状态：",
      "shell.topbar.language.label": "切换语言",
      "shell.locked.welcome.title": "欢迎使用 Keymaster",
      "shell.locked.welcome.subtitle": "欢迎。选择你要开始的流程：",
      "shell.locked.card.newTitle": "新建钱包",
      "shell.locked.card.newBody": "设置一个本地密码，并立即生成你的第一把 Key。之后可以继续导入其他私钥。",
      "shell.locked.card.newCta": "设置密码 →",
      "shell.locked.card.importTitle": "导入私钥",
      "shell.locked.card.importBody":
        "已经有 WIF / Hex / JSON 文件私钥？先解析导入材料，再设置本机系统锁屏密码，一次性创建 Vault 并落首把导入 Key。",
      "shell.locked.card.importCta": "开始导入 →",
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
      "shell.locked.newWalletDesc": "设置一个本地密码。Vault 接下来会立即生成你的第一把 Key 并自动设为 active。该密码仅保存在本机，用于加密你的私钥。",
      "shell.locked.lockedTitle": "钱包已锁定",
      "shell.locked.lockedDesc": "需要先解锁本地 Vault，解锁后才能导入或管理私钥。",
      "shell.locked.create": "创建",
      "shell.locked.menuItem": "菜单",
      "shell.unlocked.notice.activationPending": "首把 Key 已保存，但未能自动设为 active。请在 Key 管理中手动切换。",
      "shell.unlocked.notice.dismiss": "知道了",
      "shell.import.wizard.pickImporterTitle": "导入私钥：1. 选择导入方式",
      "shell.import.wizard.pickImporterDesc": "请先选择一种导入格式。私钥材料在本地解析，不会上传到任何服务器。",
      "shell.import.wizard.inputTitle": "导入私钥：2. 输入",
      "shell.import.wizard.inputDesc": "粘贴或选择你的私钥材料。",
      "shell.import.wizard.confirmKeyTitle": "导入私钥：3. 确认解析结果",
      "shell.import.wizard.confirmKeyDesc": "确认标签后继续设置本机系统锁屏密码。",
      "shell.import.wizard.setPasswordTitle": "导入私钥：4. 设置本机系统锁屏密码",
      "shell.import.wizard.setPasswordDesc":
        "该密码仅保存在本机，用于加密你导入的私钥。导入源密码与本机系统锁屏密码是两个独立字段。",
      "shell.import.wizard.useSamePassword": "使用导入源密码作为本机系统锁屏密码",
      "shell.import.wizard.importPassword": "导入源密码（同时作为本机系统锁屏密码）",
      "shell.import.wizard.vaultPasswordOnly": "本机系统锁屏密码",
      "shell.import.wizard.placeholder.vaultPassword": "至少 8 位",
      "shell.import.wizard.confirm": "创建 Vault 并导入",
      "shell.import.wizard.reuseNotice":
        "将复用第 2 步已输入的导入源密码，Vault 将使用该密码创建并解锁。",
      "shell.import.wizard.reuseLabel": "将使用的密码",
      "shell.import.wizard.reuseOrigin": "来源：第 2 步（导入源密码，仅保存在本次向导内存中）。",
      "shell.import.wizard.newPasswordTitle": "设置新的本机系统锁屏密码",
      "shell.import.wizard.newPasswordDesc":
        "此密码将取代导入源密码，仅保存在本机设备。",
      "shell.onboarding.brandSubtitle": "本地私钥保险箱",
      "shell.onboarding.securityNote": "私钥不会离开浏览器，密码不会上传到任何服务器。",
      "shell.onboarding.theme.toggle": "切换主题",
      "shell.onboarding.theme.auto": "跟随系统",
      "shell.onboarding.theme.autoHint": "跟随系统当前设置",
      "shell.onboarding.theme.light": "浅色",
      "shell.onboarding.theme.lightHint": "浅色主题",
      "shell.onboarding.theme.dark": "深色",
      "shell.onboarding.theme.darkHint": "深色主题",
      "shell.onboarding.theme.autoActive": "跟随系统 (当前 {theme})",
      "shell.onboarding.step.pickImporter": "选择方式",
      "shell.onboarding.step.input": "输入材料",
      "shell.onboarding.step.confirmKey": "确认结果",
      "shell.onboarding.step.setPassword": "设置锁屏密码",
      "shell.onboarding.step.state.current": "当前",
      "shell.onboarding.step.state.done": "已完成",
      "shell.onboarding.step.state.upcoming": "未开始",
      "shell.onboarding.step.navLabel": "首启导入向导步骤",
      // 施工单 2026-07-02 001：sidebar group 走 i18n 解析。
      "shell.menu.group.system": "系统",
      "common.action.back": "返回",
      "common.action.next": "下一步"
    }
  }
};
