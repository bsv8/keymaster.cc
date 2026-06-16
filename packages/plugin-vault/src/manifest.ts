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
//   - /settings/vault 不再向 route.registry + menu.registry 双注册；
//     改为通过 settings.registry.register() 注册单一真值。
//   - breadcrumb 第一段改为不可点击"设置"分类节点（不带 path）。
//
// 硬切换 002：
//   - /settings/vault 路由 label 改为"Key 管理"，与 VaultSettingsPage 标题一致。

import type {
  BreadcrumbRegistry,
  CommandRegistry,
  I18nPluginResources,
  MessageBus,
  PluginManifest,
  RouteRegistry,
  SettingsRegistry,
  TopbarRegistry
} from "@keymaster/contracts";
import { KEYSPACE_SERVICE_CAPABILITY } from "@keymaster/contracts";
import { VaultCreatePage } from "./VaultCreatePage.js";
import { VaultSettingsPage } from "./VaultSettingsPage.js";
import { VaultUnlockPage } from "./VaultUnlockPage.js";
import { createKeyspaceService, type KeyspaceHandle } from "./keyspaceService.js";
import { createVaultService } from "./vaultService.js";
import { KeySwitchWidget } from "./KeySwitchWidget.js";

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
      "vault.crumb.settings": "Settings",
      "vault.crumb.keys": "Key management",
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
      "vault.settings.action.delete": "Delete",
      "vault.settings.action.new": "New key",
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
      "vault.keyCreate.title": "New key",
      "vault.keyCreate.successTitle": "Key created and set as active",
      "vault.keyCreate.cancel": "Cancel",
      "vault.keyCreate.submit": "Create key",
      "vault.keyCreate.later": "Later",
      "vault.keyCreate.exportBackup": "Export encrypted backup",
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
      "vault.keyExport.title": "Export private key",
      "vault.keyExport.cancel": "Cancel",
      "vault.keyExport.submit": "Download backup file",
      "vault.keyExport.hint": "The backup is an encrypted JSON (bsv8 envelope). Keep the password and the file safe — the key cannot be recovered from this device after deletion.",
      "vault.keyExport.passwordNew": "Backup password",
      "vault.keyExport.passwordConfirm": "Confirm password",
      "vault.keyExport.err.empty": "Please enter a backup password",
      "vault.keyExport.err.mismatch": "Passwords do not match",
      "vault.keyExport.err.failed": "Export failed"
    },
    "zh-CN": {
      "vault.route.unlock": "解锁钱包",
      "vault.route.create": "创建钱包",
      "vault.route.settings": "Key 管理",
      "vault.crumb.settings": "设置",
      "vault.crumb.keys": "Key 管理",
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
      "vault.settings.action.delete": "删除",
      "vault.settings.action.new": "新建 Key",
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
      "vault.keyCreate.title": "新建 Key",
      "vault.keyCreate.successTitle": "Key 已创建并设为 active",
      "vault.keyCreate.cancel": "取消",
      "vault.keyCreate.submit": "新建 Key",
      "vault.keyCreate.later": "稍后",
      "vault.keyCreate.exportBackup": "导出加密备份",
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
      "vault.keyExport.title": "导出私钥",
      "vault.keyExport.cancel": "取消",
      "vault.keyExport.submit": "下载备份文件",
      "vault.keyExport.hint": "备份文件是加密 JSON（bsv8 envelope），需要用这个密码解密。请妥善保存密码与文件，删除 key 后本机无法恢复。",
      "vault.keyExport.passwordNew": "备份密码",
      "vault.keyExport.passwordConfirm": "确认密码",
      "vault.keyExport.err.empty": "请输入备份密码",
      "vault.keyExport.err.mismatch": "两次密码不一致",
      "vault.keyExport.err.failed": "导出失败"
    }
  }
};

export const vaultPlugin: PluginManifest = {
  id: "vault",
  name: "Vault",
  description: "本地密码 Vault，管理私钥加解密、内存会话与 active key 状态。",
  meta: {
    kind: "core",
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
    // 先建一个未绑定 keyspace 的 vault 实例占位；keyspace 创建后再回填。
    let keyspaceHandle: KeyspaceHandle | undefined = undefined;
    const service = createVaultService({ messageBus, get keyspace() { return keyspaceHandle; } });
    ctx.provide(VAULT_CAPABILITY, service);

    // 创建 keyspace：依赖 vault.service。
    keyspaceHandle = createKeyspaceService({ messageBus, vault: service });
    ctx.provide(KEYSPACE_SERVICE_CAPABILITY, keyspaceHandle);

    const routes = ctx.get<RouteRegistry>("route.registry");
    routes.register({
      id: "vault.unlock",
      path: "/vault/unlock",
      label: { key: "vault.route.unlock", fallback: "Unlock wallet" },
      component: VaultUnlockPage,
      inMenu: false
    });
    routes.register({
      id: "vault.create",
      path: "/vault/create",
      label: { key: "vault.route.create", fallback: "New wallet" },
      component: VaultCreatePage,
      inMenu: false
    });

    // 硬切换 003：/settings/vault 不再注册到 route.registry / menu.registry。
    // 改为 settings.registry.register() 一处真值；shell 走 settings 分组渲染。
    const settings = ctx.get<SettingsRegistry>("settings.registry");
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

    // 硬切换 003：面包屑第一段固定为不可点击的"设置"分类节点。
    const breadcrumbs = ctx.get<BreadcrumbRegistry>("breadcrumb.registry");
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
        await service.lock();
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
