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
      "shell.primaryNavigation": "Primary navigation",
      "shell.topbar.openMenu": "Open menu",
      "shell.topbar.statusLabel": "Status: ",
      "shell.topbar.language.label": "Switch language",
      "shell.locked.welcome.title": "Welcome to Keymaster",
      "shell.locked.welcome.subtitle": "Welcome. Pick a flow to start:",
      "shell.locked.card.newTitle": "New wallet",
      "shell.locked.card.newBody":
        "Set a Key password and generate your wallet Key. Data is stored only in this browser IndexedDB.",
      "shell.locked.card.newCta": "Set password →",
      "shell.locked.card.importTitle": "Import a wallet Key",
      // 硬切换 010：导入文案必须明确"先解析、再一次性建 Vault + 落首把导入 key"，
      // 不再暗示"先创建密码保存 vault、再导入"。
      "shell.locked.card.importBody":
        "Already have a WIF / Hex / encrypted KeyHold file? Parse it, set a Key password, and commit it as the only Key of this wallet in one step.",
      "shell.locked.card.importCta": "Start import →",
      "shell.locked.notice.title": "Your keys never leave the browser",
      "shell.locked.notice.body":
        "The wallet Key is stored encrypted in this browser IndexedDB; the Key password is never uploaded to any server. Clearing browser data deletes the wallet.",
      "shell.locked.notice.persisted":
        "Wallet is ready, but the first Key could not be set as active automatically. Please switch it manually in Key management.",
      "shell.locked.passwordTooShort": "Password must be at least 8 characters",
      "shell.locked.passwordMismatch": "Passwords do not match",
      "shell.locked.createFailed": "Create failed",
      "shell.locked.createInitialKeyFailed": "Failed to create the first Key",
      "shell.locked.unlockFailed": "Unlock failed",
      "shell.locked.passwordNew": "New password",
      "shell.locked.passwordConfirm": "Confirm password",
      "shell.locked.password": "Key password",
      "shell.locked.newWallet": "New wallet",
      "shell.locked.defaultKeyLabel": "My Wallet",
      // 硬切换 010：明确"立即生成第一把 Key"，与施工单"新建钱包"语义对齐。
      "shell.locked.newWalletDesc":
        "Set a Key password. The wallet Key is written in the same IndexedDB transaction as the initialization marker; a failed submit leaves nothing behind.",
      "shell.locked.lockedTitle": "Wallet locked",
      // 硬切换 010：locked 状态说明，明确"需要先解锁才能导入或管理私钥"。
      "shell.locked.lockedDesc":
        "Enter the Key password to unlock this browser wallet. Changing identity requires resetting the wallet first.",
            "shell.locked.create": "Create",
      "shell.locked.menuItem": "Menu",
            "shell.unlocked.notice.dismiss": "Got it",
      "shell.appShell.diagnostic.title": "Unable to read the wallet Key",
      "shell.appShell.diagnostic.desc": "An error occurred while reading the wallet Key; automatic recovery is paused to avoid accidental data deletion.",
      "shell.appShell.diagnostic.errorTitle": "Read failed",
      "shell.appShell.diagnostic.retry": "Retry",
            "shell.appShell.repair.title": "Key state needs repair",
      "shell.appShell.repair.desc": "The wallet is unlocked, but the only wallet Key could not be read. Business pages stay blocked rather than writing data under an unknown identity.",
      "shell.appShell.repair.emptyTitle": "Cannot read the wallet Key",
      "shell.appShell.repair.emptyDesc": "Lock and unlock again; if it still fails, reset the wallet and create or import a Key again. Resetting deletes the current Key and all local wallet data.",
      "shell.appShell.repair.summary": "Wallet Key: {{publicKey}}",
      // 首启导入向导文案。业务顺序固定为：先选导入方式 → 输入 / 解析 →
      // 确认 → 设置 Key 密码。导入源密码与 Key 密码是两个独立字段，
      // UI 允许"使用同一密码"勾选。
      "shell.import.wizard.pickImporterTitle": "Import a key: 1. Pick a format",
      "shell.import.wizard.pickImporterDesc":
        "Choose a format. Your private key is parsed locally and never uploaded.",
      "shell.import.wizard.inputTitle": "Import a key: 2. Input",
      "shell.import.wizard.inputDesc": "Paste or upload your private key material.",
      "shell.import.wizard.confirmKeyTitle": "Import a key: 3. Confirm the parsed key",
      "shell.import.wizard.confirmKeyDesc":
        "Confirm the label, then continue to set the Key password.",
      "shell.import.wizard.setPasswordTitle": "Import a key: 4. Set the Key password",
      "shell.import.wizard.setPasswordDesc":
        "The Key password never leaves this browser. It is used to encrypt the imported key. The import-source password and the Key password are two independent fields.",
      "shell.import.wizard.useSamePassword":
        "Use the import-source password as the Key password",
      "shell.import.wizard.importPassword":
        "Import-source password (also used as the Key password)",
      // 硬切换 010 修复：模式 1（importer 不需要密码）下需要单独
      // 的"Key 密码"label，与"新密码"区分以避免歧义。
      "shell.import.wizard.vaultPasswordOnly": "Key password",
      "shell.import.wizard.placeholder.vaultPassword": "At least 8 characters",
      "shell.import.wizard.confirm": "Create wallet and import",
      "shell.import.wizard.confirmInitial": "Use this Key",
      // 硬切换 011：第 4 步复用导入源密码时显示的说明文案；UI 隐藏
      // 密码输入框并把密码以"已应用"形式提示用户。
      "shell.import.wizard.reuseNotice":
        "Reusing the import-source password you entered in step 2. The wallet will be created and unlocked with this password.",
      "shell.import.wizard.reuseLabel": "Password to use",
      "shell.import.wizard.reuseOrigin":
        "From step 2 (import-source password, kept in this wizard's memory only).",
      "shell.import.wizard.newPasswordTitle": "Set a new Key password",
      "shell.import.wizard.newPasswordDesc":
        "This password replaces the import-source password. It is stored only on this device.",
      // 硬切换 011：onboarding 共享 header 文案。welcome / 新建钱包 /
      // 解锁 / 首启导入各 step 都使用同一套文案。
      "shell.onboarding.brandSubtitle": "Local key vault",
      "shell.onboarding.securityNote":
        "Your keys never leave the browser. The password is never uploaded.",
      "shell.persistence.label": "IndexedDB persistent storage authorization",
      "shell.persistence.message":
        "This browser has not granted persistent IndexedDB storage yet. Local data may be cleared when storage is tight.",
      "shell.persistence.denied":
        "Storage was not granted. Local data can still be cleared when storage is tight. Allow persistent storage for this site and try again.",
      "shell.persistence.authorize": "Allow persistent storage",
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
      "shell.noticeRail.label": "Emergency notices",
      "shell.noticeRail.title": "Emergency notices",
      "shell.noticeRail.dismiss": "Dismiss",
      "common.action.back": "Back",
      "common.action.next": "Next"
    },
    "zh-CN": {
      "shell.primaryNavigation": "主导航",
      "shell.topbar.openMenu": "打开菜单",
      "shell.topbar.statusLabel": "状态：",
      "shell.topbar.language.label": "切换语言",
      "shell.locked.welcome.title": "欢迎使用 Keymaster",
      "shell.locked.welcome.subtitle": "欢迎。选择你要开始的流程：",
      "shell.locked.card.newTitle": "新建钱包",
      "shell.locked.card.newBody": "设置一个 Key 密码，生成你的钱包 Key。数据只保存在本机浏览器的 IndexedDB。",
      "shell.locked.card.newCta": "设置密码 →",
      "shell.locked.card.importTitle": "导入钱包 Key",
      "shell.locked.card.importBody":
        "已经有 WIF / Hex / 加密 KeyHold 文件？解析并设置 Key 密码，一次性提交为钱包的唯一 Key。",
      "shell.locked.card.importCta": "开始导入 →",
      "shell.locked.notice.title": "私钥不会离开你的浏览器",
      "shell.locked.notice.body": "钱包 Key 以加密形式保存在本机 IndexedDB；Key 密码不会上传到任何服务器。清除浏览器数据会一并删除钱包。",
      "shell.locked.notice.persisted": "钱包已建好，但首把 Key 未能自动设为 active，请在 Key 管理中手动切换。",
      "shell.locked.passwordTooShort": "密码至少 8 位",
      "shell.locked.passwordMismatch": "两次密码不一致",
      "shell.locked.createFailed": "创建失败",
      "shell.locked.createInitialKeyFailed": "创建首把 Key 失败",
      "shell.locked.unlockFailed": "解锁失败",
      "shell.locked.passwordNew": "新密码",
      "shell.locked.passwordConfirm": "确认密码",
      "shell.locked.password": "该 Key 的密码",
      "shell.locked.newWallet": "新建钱包",
      "shell.locked.defaultKeyLabel": "我的钱包",
      "shell.locked.newWalletDesc": "设置一个 Key 密码。钱包 Key 会和初始化标记在同一个 IndexedDB 事务里写入；提交失败不会留下半成品。",
      "shell.locked.lockedTitle": "钱包已锁定",
      "shell.locked.lockedDesc": "输入 Key 密码解锁本机钱包。更换身份需要先重置钱包。",
            "shell.locked.create": "创建",
      "shell.locked.menuItem": "菜单",
            "shell.unlocked.notice.dismiss": "知道了",
      "shell.appShell.diagnostic.title": "无法读取钱包 Key",
      "shell.appShell.diagnostic.desc": "读取钱包 Key 时出错；为避免误删数据，壳层守卫已暂停自动恢复路径。",
      "shell.appShell.diagnostic.errorTitle": "读取失败",
      "shell.appShell.diagnostic.retry": "重试",
            "shell.appShell.repair.title": "需要修复 Key 状态",
      "shell.appShell.repair.desc": "钱包已解锁，但读不到唯一 Key 的公开身份。已阻断其它业务页，以免在身份不明时修改数据。",
      "shell.appShell.repair.emptyTitle": "读不到钱包 Key",
      "shell.appShell.repair.emptyDesc": "请先锁定再解锁；如果仍然失败，需要重置钱包后重新创建或导入。重置会删除当前 Key 和全部本地钱包数据。",
      "shell.appShell.repair.summary": "钱包 Key：{{publicKey}}",
      "shell.import.wizard.pickImporterTitle": "导入私钥：1. 选择导入方式",
      "shell.import.wizard.pickImporterDesc": "请先选择一种导入格式。私钥材料在本地解析，不会上传到任何服务器。",
      "shell.import.wizard.inputTitle": "导入私钥：2. 输入",
      "shell.import.wizard.inputDesc": "粘贴或选择你的私钥材料。",
      "shell.import.wizard.confirmKeyTitle": "导入私钥：3. 确认解析结果",
      "shell.import.wizard.confirmKeyDesc": "确认标签后继续设置 Key 密码。",
      "shell.import.wizard.setPasswordTitle": "导入私钥：4. 设置 Key 密码",
      "shell.import.wizard.setPasswordDesc":
        "该密码不会离开浏览器，用于加密你导入的私钥。导入源密码与 Key 密码是两个独立字段。",
      "shell.import.wizard.useSamePassword": "使用导入源密码作为 Key 密码",
      "shell.import.wizard.importPassword": "导入源密码（同时作为 Key 密码）",
      "shell.import.wizard.vaultPasswordOnly": "Key 密码",
      "shell.import.wizard.placeholder.vaultPassword": "至少 8 位",
      "shell.import.wizard.confirm": "创建并导入",
      "shell.import.wizard.confirmInitial": "使用这把 Key",
      "shell.import.wizard.reuseNotice":
        "将复用第 2 步已输入的导入源密码，钱包将使用该密码创建并解锁。",
      "shell.import.wizard.reuseLabel": "将使用的密码",
      "shell.import.wizard.reuseOrigin": "来源：第 2 步（导入源密码，仅保存在本次向导内存中）。",
      "shell.import.wizard.newPasswordTitle": "设置新的 Key 密码",
      "shell.import.wizard.newPasswordDesc":
        "此密码将取代导入源密码，仅保存在本机设备。",
      "shell.onboarding.brandSubtitle": "本地私钥保险箱",
      "shell.onboarding.securityNote": "私钥不会离开浏览器，密码不会上传到任何服务器。",
      "shell.persistence.label": "IndexedDB 永久存储授权",
      "shell.persistence.message": "浏览器尚未授予 IndexedDB 永久存储权限，存储空间紧张时本地数据可能被清理。",
      "shell.persistence.denied": "未获授权，浏览器仍可能在存储空间紧张时清理本地数据。请允许本站持久化存储后重试。",
      "shell.persistence.authorize": "授权永久存储",
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
      "shell.noticeRail.label": "紧急通知",
      "shell.noticeRail.title": "紧急通知",
      "shell.noticeRail.dismiss": "关闭",
      "common.action.back": "返回",
      "common.action.next": "下一步"
    }
  }
};
