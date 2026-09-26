// packages/plugin-background/src/manifest.ts
// 后台任务平台清单：注册 background.registry + background.service + Topbar 托盘。

import type {
  BackgroundRegistry,
  BackgroundService,
  BackgroundSyncSettings,
  BackgroundTaskSnapshot,
  I18nPluginResources,
  PluginManifest,
  PluginSetup,
  ResourceRegistry,
  TopbarRegistry,
  BackgroundCoordinatorControl
} from "@keymaster/contracts";
import {
  BACKGROUND_REGISTRY_CAPABILITY,
  BACKGROUND_SERVICE_CAPABILITY,
  BACKGROUND_COORDINATOR_CONTROL_CAPABILITY,
  BREADCRUMB_REGISTRY_CAPABILITY,
  BUSINESS_REGISTRY_CAPABILITY,
  KEYSPACE_SERVICE_CAPABILITY,
  RESOURCE_REGISTRY_CAPABILITY,
  SETTINGS_REGISTRY_CAPABILITY,
  TOPBAR_REGISTRY_CAPABILITY,
  capabilityDescriptor,
  defineRuntimeUnitDependencies,
} from "@keymaster/contracts";
import { createBackgroundServiceCoordinator } from "./backgroundServiceCoordinator.js";

export const BACKGROUND_TASK_SNAPSHOTS_RESOURCE_ID = "background.taskSnapshots";
import type { CoordinatorClientLike } from "./backgroundServiceCoordinator.js";
import { BackgroundTray } from "./BackgroundTray.js";
import { BackgroundSettingsPage } from "./BackgroundSettingsPage.js";

const backgroundResources: I18nPluginResources = {
  namespace: "background",
  resources: {
    en: {
      "background.topbar.label": "Background tasks",
      "background.tray.title": "Background tasks",
      "background.tray.close": "Close",
      "background.tray.empty": "No background tasks registered.",
      "background.tray.lastCompletePrefix": "Last completed ",
      "background.tray.lastAttemptPrefix": "Last attempt ",
      "background.tray.lastSyncFailed": "Last sync failed: ",
      "background.tray.neverRun": "Never run",
      "background.tray.nextPrefix": " · next ",
      "background.tray.action.runOnce": "Sync once now",
      "background.tray.action.requesting": "Requesting sync…",
      "background.tray.action.cancelCurrentSync": "Cancel current sync",
      "background.tray.state.running": "Syncing",
      "background.tray.state.queued": "Queued",
      "background.tray.state.blocked": "Waiting for condition",
      "background.tray.state.idle": "Waiting to sync",
      "background.settings.title": "Smart scheduling",
      "background.settings.crumb.settings": "Settings",
      "background.settings.description": "Smart scheduling refreshes the BSV balance snapshot immediately after unlock and then every time the WoC queue stays idle for 2 seconds, so idle time is always used without competing with your actions. The sync management below controls the other background tasks.",
      "background.settings.syncManagement": "Sync management",
      "background.settings.syncManagementDesc": "Each task can have its own sync interval; \"Custom\" accepts any whole-second interval between 10 seconds and 24 hours. \"Off\" disables automatic sync for that task; the tray's \"Sync once now\" still works.",
      "background.settings.smartTitle": "BSV balance snapshot (smart)",
      "background.settings.smartDesc": "The balance comes from the in-memory UTXO snapshot: refreshed right after unlock and every time the WoC queue is idle for 2 seconds. This interval is not configurable.",
      "background.settings.task.chain.chain-height-sync": "Blockchain height",
      "background.settings.task.p2pkh.transactions-sync": "P2PKH on-chain history",
      "background.settings.task.token-bsv21.sync": "BSV-21 token holdings",
      "background.settings.task.token-stas.sync": "STAS token holdings",
      "background.settings.task.collectible-1satordinals.sync": "1Sat collectibles",
      "background.settings.task.contacts.presence-probe": "Contacts presence probe",
      "background.settings.chainHeightTitle": "Current blockchain height",
      "background.settings.chainHeightValue": "Mainnet height {{height}}",
      "background.settings.chainHeightPending": "No height from the node yet: waiting for the background sync task to complete its first read.",
      "background.settings.option.30s": "30 seconds",
      "background.settings.option.1min": "1 minute",
      "background.settings.option.2min": "2 minutes",
      "background.settings.option.5min": "5 minutes",
      "background.settings.option.off": "Off",
      "background.settings.option.custom": "Custom",
      "background.settings.interval.seconds": "{{seconds}} seconds",
      "background.settings.interval.minutes": "{{minutes}} minutes",
      "background.settings.interval.hours": "{{hours}} hours",
      "background.settings.custom.modalTitle": "Custom sync interval: {{task}}",
      "background.settings.custom.modalDescription": "Enter a whole number of seconds between 10 and 86400. The new cycle starts counting from the moment you save.",
      "background.settings.custom.label": "Custom interval (10-86400 seconds)",
      "background.settings.custom.placeholder": "e.g. 45",
      "background.settings.custom.unit": "seconds",
      "background.settings.custom.apply": "Apply",
      "background.settings.custom.applying": "Saving…",
      "background.settings.custom.required": "Enter a number of seconds (at least 10).",
      "background.settings.custom.invalid": "Enter a valid number of seconds.",
      "background.settings.custom.min": "At least {{seconds}} seconds; for anything shorter choose \"Off\".",
      "background.settings.custom.max": "At most 24 hours ({{seconds}} seconds); for anything longer choose \"Off\".",
      "background.settings.saveFailed": "Save failed. Please try again later.",
      "background.tray.requestFailed": "Request failed. Please try again later.",
      "background.tray.cancelFailed": "Cancel failed. Please try again later.",
      "background.blocked.canRunError": "Unable to check whether this task can run.",
      "background.blocked.unlock": "Vault is locked",
      "background.blocked.keyReady": "Initializing key space",
      "background.blocked.noActiveKey": "No active key",
      "background.blocked.task": "Task is blocked"
    },
    "zh-CN": {
      "background.topbar.label": "后台任务",
      "background.tray.title": "后台任务",
      "background.tray.close": "关闭",
      "background.tray.empty": "没有已注册的后台任务。",
      "background.tray.lastCompletePrefix": "上次完成 ",
      "background.tray.lastAttemptPrefix": "上次尝试 ",
      "background.tray.lastSyncFailed": "上次同步失败：",
      "background.tray.neverRun": "尚未运行",
      "background.tray.nextPrefix": " · 下次 ",
      "background.tray.action.runOnce": "立即同步一次",
      "background.tray.action.requesting": "正在请求同步…",
      "background.tray.action.cancelCurrentSync": "取消本次同步",
      "background.tray.state.running": "同步中",
      "background.tray.state.queued": "排队中",
      "background.tray.state.blocked": "等待条件",
      "background.tray.state.idle": "等待同步",
      "background.settings.title": "智能调度",
      "background.settings.crumb.settings": "设置",
      "background.settings.description": "智能调度在解锁后立即刷新一次 BSV 余额快照，之后只要 WoC 队列空闲满 2 秒就自动刷新：所有闲暇时间都用来获取余额，用户操作时自动让路。下面的「同步管理」控制其余后台任务。",
      "background.settings.syncManagement": "同步管理",
      "background.settings.syncManagementDesc": "每个任务可以单独设置同步间隔；「自定义」可输入 10 秒～24 小时之间的任意整秒间隔。选择「关闭」后该任务不再自动同步，托盘的「立即同步一次」仍然可用。",
      "background.settings.smartTitle": "BSV 余额快照（智能）",
      "background.settings.smartDesc": "余额来自内存 UTXO 快照：解锁后立即刷新，之后每次 WoC 队列空闲满 2 秒自动刷新，间隔不可配置。",
      "background.settings.task.chain.chain-height-sync": "区块链高度",
      "background.settings.task.p2pkh.transactions-sync": "P2PKH 链上交易历史",
      "background.settings.task.token-bsv21.sync": "BSV-21 代币持仓",
      "background.settings.task.token-stas.sync": "STAS 代币持仓",
      "background.settings.task.collectible-1satordinals.sync": "1Sat 收藏品",
      "background.settings.task.contacts.presence-probe": "联系人在线探测",
      "background.settings.chainHeightTitle": "当前区块链高度",
      "background.settings.chainHeightValue": "主网高度 {{height}}",
      "background.settings.chainHeightPending": "尚未取得节点高度：等待后台同步任务完成第一次读取。",
      "background.settings.option.30s": "30 秒",
      "background.settings.option.1min": "1 分钟",
      "background.settings.option.2min": "2 分钟",
      "background.settings.option.5min": "5 分钟",
      "background.settings.option.off": "关闭",
      "background.settings.option.custom": "自定义",
      "background.settings.interval.seconds": "{{seconds}} 秒",
      "background.settings.interval.minutes": "{{minutes}} 分钟",
      "background.settings.interval.hours": "{{hours}} 小时",
      "background.settings.custom.modalTitle": "自定义同步间隔：{{task}}",
      "background.settings.custom.modalDescription": "输入 10 到 86400 秒之间的整数间隔；保存后新周期从保存时刻开始计时。",
      "background.settings.custom.label": "自定义间隔（10～86400 秒）",
      "background.settings.custom.placeholder": "例如：45",
      "background.settings.custom.unit": "秒",
      "background.settings.custom.apply": "应用",
      "background.settings.custom.applying": "保存中…",
      "background.settings.custom.required": "请输入秒数（至少 10 秒）。",
      "background.settings.custom.invalid": "请输入有效的秒数。",
      "background.settings.custom.min": "至少 {{seconds}} 秒，更短的间隔请选择「关闭」。",
      "background.settings.custom.max": "最多 24 小时（{{seconds}} 秒），更长请选择「关闭」。",
      "background.settings.saveFailed": "保存失败，请稍后重试。",
      "background.tray.requestFailed": "请求失败，请稍后重试。",
      "background.tray.cancelFailed": "取消失败，请稍后重试。",
      "background.blocked.canRunError": "无法检查任务是否可以运行。",
      "background.blocked.unlock": "保险箱已锁定",
      "background.blocked.keyReady": "密钥空间初始化中",
      "background.blocked.noActiveKey": "没有活跃密钥",
      "background.blocked.task": "任务已阻塞"
    }
  }
};

const backgroundPluginDefinition = {
  id: "background",
  name: "Background",
  description: "通用后台任务平台：注册、调度、去重、Topbar 托盘。",
  kind: "platform",
  startup: "optional",
  bootstrapStage: "owner-apps-ready",
  defaultEnabled: true,
  canDisable: true,
  displayGroup: "platform",
  units: [{
    id: "background.window",
    runtime: "window-main",
    scopeKind: "owner-session",
    provides: [
      capabilityDescriptor(BACKGROUND_REGISTRY_CAPABILITY),
      capabilityDescriptor(BACKGROUND_SERVICE_CAPABILITY),
      capabilityDescriptor(BACKGROUND_COORDINATOR_CONTROL_CAPABILITY),
    ],
    dependencies: defineRuntimeUnitDependencies([
      { capability: TOPBAR_REGISTRY_CAPABILITY, sourceRuntime: "window-main", reason: "需要向 Topbar 注册任务托盘" },
      { capability: BUSINESS_REGISTRY_CAPABILITY, sourceRuntime: "window-main", reason: "注册智能调度设置入口" },
      { capability: BREADCRUMB_REGISTRY_CAPABILITY, sourceRuntime: "window-main", reason: "注册智能调度设置面包屑" },
      { capability: SETTINGS_REGISTRY_CAPABILITY, sourceRuntime: "window-main", reason: "注册智能调度设置路由" },
    ]),
  }],
  i18n: backgroundResources,
  setup(ctx) {
    // 施工单 002：优先使用 Coordinator facade
    let registry: BackgroundRegistry;
    let service: BackgroundService;

    const coordinatorClient = ctx.coordinator as BackgroundCoordinatorControl | undefined;
    if (!coordinatorClient) throw new Error("Background Coordinator control is unavailable");
    ctx.provide(BACKGROUND_COORDINATOR_CONTROL_CAPABILITY, coordinatorClient);
    if (coordinatorClient.getIsConnected()) {
      // 使用 Coordinator facade
      service = createBackgroundServiceCoordinator({ coordinatorClient });
      // 保留旧 capability 契约，但 Coordinator 模式下 registry 永远不接受
      // 页面任务注册；唯一任务注册表和执行权属于 SharedWorker。
      registry = { register: () => undefined, list: () => [], get: () => undefined };
    } else throw new Error("Session Coordinator is unavailable");

    ctx.provide(BACKGROUND_SERVICE_CAPABILITY, service);
    ctx.provide(BACKGROUND_REGISTRY_CAPABILITY, registry);

    // 注册资源定义（硬切换 003）
    const resources = ctx.capability(RESOURCE_REGISTRY_CAPABILITY);

    // background.scheduleSettings：同步管理设置（任务 id -> 间隔毫秒）
    resources.register<BackgroundSyncSettings, readonly string[]>({
      id: "background.scheduleSettings",
      scope: "global",
      key: () => ["background.scheduleSettings"],
      load: async () => service.getScheduleSettings(),
      subscribe: (_args, _ctx, invalidate) => service.onTaskSnapshotsChanged(invalidate),
      equals: (prev, next) => {
        if (!prev || !next) return prev === next;
        return JSON.stringify(prev.taskIntervals ?? {}) === JSON.stringify(next.taskIntervals ?? {});
      },
      invalidation: "immediate"
    });

    // background.taskSnapshots：后台任务快照列表
    resources.register<BackgroundTaskSnapshot[], readonly string[]>({
      id: BACKGROUND_TASK_SNAPSHOTS_RESOURCE_ID,
      scope: "global",
      key: () => [BACKGROUND_TASK_SNAPSHOTS_RESOURCE_ID],
      load: async () => service.listTaskSnapshots(),
      subscribe: (_args, _ctx, invalidate) => service.onTaskSnapshotsChanged(invalidate),
      equals: (prev, next) => {
        if (!prev || !next) return prev === next;
        if (prev.length !== next.length) return false;
        for (let i = 0; i < prev.length; i++) {
          const a = prev[i];
          const b = next[i];
          if (!a || !b) return a === b;
          if (a.id !== b.id || a.state !== b.state) return false;
        }
        return true;
      },
      invalidation: "immediate"
    });

    const ks = ctx.optionalCapability(KEYSPACE_SERVICE_CAPABILITY) as {
      attachBackgroundService?(s: BackgroundService): void;
    } | undefined;
    if (ks) {
      ks.attachBackgroundService?.(service);
    }

    const topbar = ctx.capability(TOPBAR_REGISTRY_CAPABILITY);
    topbar.register({
      id: "background.tray",
      label: { key: "background.topbar.label", fallback: "Background tasks" },
      component: BackgroundTray,
      order: 100
    });

    const settings = ctx.capability(SETTINGS_REGISTRY_CAPABILITY);
    settings.register({
      id: "background.smart-scheduling",
      path: "/settings/smart-scheduling",
      label: { key: "background.settings.title", fallback: "Smart scheduling" },
      description: { key: "background.settings.description", fallback: "Smart scheduling and per-task sync intervals." },
      component: BackgroundSettingsPage,
      order: 10,
      icon: "Activity",
      visibleWhen: ({ unlocked }) => unlocked
    });

    const business = ctx.capability(BUSINESS_REGISTRY_CAPABILITY);
    business.registerFeature("background", "settings", {
      id: "settings.smart-scheduling",
      label: { key: "background.settings.title", fallback: "Smart scheduling" },
      description: { key: "background.settings.description", fallback: "Smart scheduling and per-task sync intervals." },
      order: 14,
      icon: "Activity",
      entry: {
        path: "/settings/smart-scheduling",
        component: BackgroundSettingsPage,
        visibleWhen: ({ unlocked }) => unlocked
      }
    });
    const breadcrumbs = ctx.capability(BREADCRUMB_REGISTRY_CAPABILITY);
    breadcrumbs.register({
      id: "background.settings.crumbs",
      order: 14,
      match: (path) => path === "/settings/smart-scheduling",
      resolve: () => [
        { label: { key: "background.settings.crumb.settings", fallback: "Settings" } },
        { label: { key: "background.settings.title", fallback: "Smart scheduling" } }
      ]
    });

    return () => {
      (service as BackgroundService & { dispose?: () => void }).dispose?.();
    };
  }
} satisfies PluginManifest & { setup: PluginSetup };

const { setup: backgroundSetup, ...backgroundPlugin } = backgroundPluginDefinition;
export { backgroundSetup, backgroundPlugin };
