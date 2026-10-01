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
  KeyspaceService,
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
  KEYSPACE_SERVICE_CAPABILITY,
  RESOURCE_REGISTRY_CAPABILITY,
  ROUTE_REGISTRY_CAPABILITY,
  SETTINGS_REGISTRY_CAPABILITY,
  VAULT_COORDINATOR_CONTROL_CAPABILITY,
  VAULT_LOCAL_SECRET_CAPABILITY,
  VAULT_SERVICE_CAPABILITY,
  type VaultCoordinatorControl,
} from "@keymaster/contracts";
import { VaultCreatePage } from "./VaultCreatePage.js";
import { CurrentKeySettingsPage } from "./CurrentKeySettingsPage.js";
import { VaultUnlockPage } from "./VaultUnlockPage.js";
import { AutoLockSettingsPage } from "./AutoLockSettingsSection.js";
import { createVaultServiceCoordinator } from "./vaultServiceCoordinator.js";
import { createKeyspaceServiceCoordinator } from "./keyspaceServiceCoordinator.js";
import { createAutoLockServiceCoordinator } from "./autoLockServiceCoordinator.js";
import { SessionStateMirror } from "./sessionStateMirror.js";
import { createVaultLocalSecretService } from "./localSecretService.js";

/** 唯一 Key 的只读资源投影。 */
export interface VaultKeyResourceState {
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
      "vault.currentKey.export.description": "The downloaded file is a copy of the local key.json and keeps the existing encrypted format.",
      "vault.currentKey.export.notBackup": "This file contains the wallet key only \u2014 not contacts, messages, settings or other local data. It is not a full wallet backup.",
      "vault.currentKey.export.action": "Export KeyHold",
      "vault.settings.empty.label": "Unnamed",
      "vault.settings.actions.title": "Key actions",
      "vault.settings.action.rename": "Rename",
      "vault.settings.action.changePassword": "Change password",
      "vault.settings.action.lock": "Lock wallet",
      "vault.settings.action.resetWallet": "Reset wallet",
      "vault.settings.rename.title": "Rename key",
      "vault.settings.rename.label": "Name",
      "vault.settings.rename.submit": "Save",
      "vault.settings.err.rename": "Rename failed",
      "vault.settings.err.renameEmpty": "Name cannot be empty",
      "vault.settings.err.lock": "Lock failed",
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
      "vault.currentKey.export.description": "导出文件就是本地 key.json 的原样副本，保持既有加密格式。",
      "vault.currentKey.export.notBackup": "该文件只含钱包 Key，不含联系人、消息、设置等本地业务数据，不能当作完整钱包备份。",
      "vault.currentKey.export.action": "导出 KeyHold",
      "vault.settings.empty.label": "未命名",
      "vault.settings.actions.title": "Key 操作",
      "vault.settings.action.rename": "重命名",
      "vault.settings.action.changePassword": "修改密码",
      "vault.settings.action.lock": "锁定钱包",
      "vault.settings.action.resetWallet": "重置钱包",
      "vault.settings.rename.title": "重命名 Key",
      "vault.settings.rename.label": "名称",
      "vault.settings.rename.submit": "保存",
      "vault.settings.err.rename": "重命名失败",
      "vault.settings.err.renameEmpty": "名称不能为空",
      "vault.settings.err.lock": "锁定失败",
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
  kind: "core",
  startup: "required",
  // Vault 必须最早可用：未初始化时它是「创建 / 导入钱包 Key」的唯一入口，
  // locked 时是解锁页的唯一入口。这两种状态都发生在本地钱包 Root 就绪
  // 之前或之后的冷启动路径上，晚于第一阶段就拿不到 vault.service。
  bootstrapStage: "storage-onboarding",
  defaultEnabled: true,
  canDisable: false,
  displayGroup: "core",
  units: [{
    id: "vault.window",
    runtime: "window-main",
    scopeKind: "root",
    provides: [VAULT_CAPABILITY, KEYSPACE_SERVICE_CAPABILITY, VAULT_LOCAL_SECRET_CAPABILITY, VAULT_COORDINATOR_CONTROL_CAPABILITY, AUTOLOCK_SERVICE_CAPABILITY],
    dependencies: [
      { capability: RESOURCE_REGISTRY_CAPABILITY, sourceRuntime: "window-main", reason: "vault key resource" },
      { capability: ROUTE_REGISTRY_CAPABILITY, sourceRuntime: "window-main", reason: "vault routes" },
      { capability: SETTINGS_REGISTRY_CAPABILITY, sourceRuntime: "window-main", reason: "vault settings" },
      { capability: BUSINESS_REGISTRY_CAPABILITY, sourceRuntime: "window-main", reason: "vault settings navigation" },
      { capability: BREADCRUMB_REGISTRY_CAPABILITY, sourceRuntime: "window-main", reason: "vault breadcrumbs" },
      { capability: COMMAND_REGISTRY_CAPABILITY, sourceRuntime: "window-main", reason: "vault lock command" },
    ],
  }, {
    id: "vault.coordinator-worker",
    runtime: "shared-worker",
    scopeKind: "root",
  }],
  i18n: vaultResources,
  setup(ctx) {
    // 两个 facade 都只从同一个已提交的 session 镜像派生：vault 管生命周期，
    // keyspace 只投影当前唯一 Key 的公钥身份。
    const coordinatorClient = ctx.coordinator as VaultCoordinatorControl | undefined;
    if (!coordinatorClient) throw new Error("Session Coordinator is unavailable");
    if (coordinatorClient.getIsConnected()) ctx.provide(VAULT_COORDINATOR_CONTROL_CAPABILITY, coordinatorClient);
    if (!coordinatorClient.getIsConnected()) throw new Error("Session Coordinator is unavailable");

    const sessionStateMirror = new SessionStateMirror(coordinatorClient);
    const service = createVaultServiceCoordinator({ coordinatorClient, sessionStateMirror });
    const keyspaceHandle = createKeyspaceServiceCoordinator(sessionStateMirror);

    ctx.provide(VAULT_CAPABILITY, service);
    ctx.provide(KEYSPACE_SERVICE_CAPABILITY, keyspaceHandle);
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
        const snapshot = service.getLifecycleSnapshot();
        return {
          // 锁定时不投影公钥：页面不应在未解锁时继续持有身份。
          ...(snapshot.status === "unlocked" && snapshot.activePublicKeyHex
            ? { activePublicKeyHex: snapshot.activePublicKeyHex }
            : {}),
          runGeneration: snapshot.runGeneration,
          ...(snapshot.walletGeneration === undefined ? {} : { walletGeneration: snapshot.walletGeneration }),
          revision: snapshot.vaultLifecycleRevision,
        };
      },
      subscribe: (_args, _ctx, invalidate) => service.onLifecycleChange(invalidate),
      equals: (a, b) => (a !== undefined && b !== undefined && (
        a.activePublicKeyHex === b.activePublicKeyHex
        && a.runGeneration === b.runGeneration
        && a.walletGeneration === b.walletGeneration
        && a.revision === b.revision
      )),
      invalidation: "immediate"
    });

    const routes = ctx.capability(ROUTE_REGISTRY_CAPABILITY);
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

    // /settings/* 走 settings.registry 作为页面路由真值，同时作为一个 feature
    // 挂入「设置」业务域。vault 在 settings 之前启动，因此 registry 支持先
    // 注册入口、等待 settings 域出现后再投影到业务导航。
    const settings = ctx.capability(SETTINGS_REGISTRY_CAPABILITY);
    settings.register({
      id: "vault.current-key",
      path: "/settings/current-key",
      label: { key: "vault.route.currentKey", fallback: "Wallet key" },
      description: { key: "vault.currentKey.description", fallback: "Manage the single wallet key kept in this browser." },
      component: CurrentKeySettingsPage,
      order: 0,
      icon: "ShieldCheck",
      visibleWhen: ({ unlocked }) => unlocked
    });
    settings.register({
      id: "vault.auto-lock",
      path: "/settings/auto-lock",
      label: { key: "vault.route.autoLock", fallback: "Auto lock" },
      description: { key: "vault.autolock.page.description", fallback: "Lock the wallet automatically after inactivity." },
      component: AutoLockSettingsPage,
      order: 1,
      icon: "LockKeyhole",
      visibleWhen: ({ unlocked }) => unlocked
    });

    const business = ctx.capability(BUSINESS_REGISTRY_CAPABILITY);
    business.registerFeature("vault", "settings", {
      id: "settings.current-key",
      label: { key: "vault.route.currentKey", fallback: "Wallet key" },
      description: { key: "vault.currentKey.description", fallback: "Manage the single wallet key kept in this browser." },
      order: 12,
      icon: "ShieldCheck",
      entry: { path: "/settings/current-key", component: CurrentKeySettingsPage }
    });
    business.registerFeature("vault", "settings", {
      id: "settings.auto-lock",
      label: { key: "vault.route.autoLock", fallback: "Auto lock" },
      description: { key: "vault.autolock.page.description", fallback: "Lock the wallet automatically after inactivity." },
      order: 13,
      icon: "LockKeyhole",
      entry: { path: "/settings/auto-lock", component: AutoLockSettingsPage }
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

    const commands = ctx.capability(COMMAND_REGISTRY_CAPABILITY);
    commands.register({
      id: "vault.lock",
      label: { key: "vault.command.lock", fallback: "Lock wallet" },
      run: async () => {
        const result = await service.lock();
        // 锁定事件本身会把所有页面收敛到最新 lifecycle 快照。若另一页面
        // 恰好先完成了同一轮锁定，stale-epoch 是可恢复的竞态结果，不能抛到
        // global.unhandledrejection 并把整个应用判为致命错误。
        if (result.status !== "accepted" && result.status !== "ok" && result.status !== "stale-epoch") {
          throw new Error("message" in result ? result.message : `Lock failed: ${result.status}`);
        }
      }
    });

    // vault 是 core 插件，不会被 disable。这里只释放内存句柄引用；service.lock()
    // 等动作由 vault 命令触发，不属于 ownership 回收范围。
    return () => {
      service.dispose?.();
      autoLockService.dispose?.();
    };
  }
} satisfies PluginManifest & { setup: PluginSetup };

const { setup: vaultSetup, ...vaultPlugin } = vaultPluginDefinition;
export { vaultSetup, vaultPlugin };
export type { KeyspaceService, VaultService };
