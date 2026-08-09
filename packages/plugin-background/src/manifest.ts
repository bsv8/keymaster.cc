// packages/plugin-background/src/manifest.ts
// 后台任务平台清单：注册 background.registry + background.service + Topbar 托盘。

import type {
  BackgroundRegistry,
  BackgroundService,
  BackgroundSyncSettings,
  BackgroundTaskSnapshot,
  I18nPluginResources,
  PluginManifest,
  ResourceRegistry,
  SystemSettingsRegistry,
  TopbarRegistry
} from "@keymaster/contracts";
import {
  BACKGROUND_REGISTRY_CAPABILITY,
  BACKGROUND_SERVICE_CAPABILITY,
  KEYSPACE_SERVICE_CAPABILITY,
  RESOURCE_REGISTRY_CAPABILITY,
  SESSION_COORDINATOR_CLIENT_CAPABILITY,
  TOPBAR_REGISTRY_CAPABILITY
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
      "background.settings.title": "Background sync settings",
      "background.settings.description": "Background sync is always maintained by the system. You can adjust the sync interval or click \"Sync once now\" in the tray to manually trigger a sync.",
      "background.settings.assetHoldingsInterval": "Asset balance sync interval",
      "background.settings.save": "Save",
      "background.settings.option.5min": "5 minutes",
      "background.settings.option.15min": "15 minutes (default)",
      "background.settings.option.30min": "30 minutes",
      "background.settings.option.60min": "1 hour",
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
      "background.settings.title": "后台同步设置",
      "background.settings.description": "后台同步始终由系统维持。您可以调整同步频率，或在托盘中点击「立即同步一次」手动触发一轮同步。",
      "background.settings.assetHoldingsInterval": "资产余额同步频率",
      "background.settings.save": "保存",
      "background.settings.option.5min": "5 分钟",
      "background.settings.option.15min": "15 分钟（缺省）",
      "background.settings.option.30min": "30 分钟",
      "background.settings.option.60min": "1 小时",
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

export const backgroundPlugin: PluginManifest = {
  id: "background",
  name: "Background",
  description: "通用后台任务平台：注册、调度、去重、Topbar 托盘。",
  meta: {
    kind: "platform",
    startup: "optional",
    defaultEnabled: true,
    canDisable: true,
    providesCapabilities: [BACKGROUND_REGISTRY_CAPABILITY, BACKGROUND_SERVICE_CAPABILITY],
    displayGroup: "platform"
  },
  i18n: backgroundResources,
  dependencies: [
    { capability: TOPBAR_REGISTRY_CAPABILITY, reason: "需要向 Topbar 注册任务托盘" },
    { capability: "system-settings.registry", reason: "注册后台同步系统设置" }
  ],
  setup(ctx) {
    // 施工单 002：优先使用 Coordinator facade
    let registry: BackgroundRegistry;
    let service: BackgroundService;

    const coordinatorClient = ctx.get<CoordinatorClientLike>(SESSION_COORDINATOR_CLIENT_CAPABILITY);
    if (coordinatorClient.getIsConnected()) {
      // 使用 Coordinator facade
      service = createBackgroundServiceCoordinator({ coordinatorClient });
      // 保留旧 capability 契约，但 Coordinator 模式下 registry 永远不接受
      // 页面任务注册；唯一任务注册表和执行权属于 SharedWorker。
      registry = { register: () => undefined, list: () => [], get: () => undefined };
    } else throw new Error("Session Coordinator is unavailable");

    ctx.provide<BackgroundService>(BACKGROUND_SERVICE_CAPABILITY, service);
    ctx.provide<BackgroundRegistry>(BACKGROUND_REGISTRY_CAPABILITY, registry);

    // 注册资源定义（硬切换 003）
    const resources = ctx.get<ResourceRegistry>(RESOURCE_REGISTRY_CAPABILITY);

    // background.scheduleSettings：后台同步设置
    resources.register<BackgroundSyncSettings, readonly string[]>({
      id: "background.scheduleSettings",
      scope: "global",
      key: () => ["background.scheduleSettings"],
      load: async () => service.getScheduleSettings(),
      subscribe: (_args, _ctx, invalidate) => service.onTaskSnapshotsChanged(invalidate),
      equals: (prev, next) => {
        if (!prev || !next) return prev === next;
        return prev.assetHoldingsIntervalMs === next.assetHoldingsIntervalMs;
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

    if (ctx.has(KEYSPACE_SERVICE_CAPABILITY)) {
      const ks = ctx.get<{
        attachBackgroundService?(s: BackgroundService): void;
      }>(KEYSPACE_SERVICE_CAPABILITY);
      ks.attachBackgroundService?.(service);
    }

    const topbar = ctx.get<TopbarRegistry>(TOPBAR_REGISTRY_CAPABILITY);
    topbar.register({
      id: "background.tray",
      label: { key: "background.topbar.label", fallback: "Background tasks" },
      component: BackgroundTray,
      order: 100
    });

    const systemSettings = ctx.get<SystemSettingsRegistry>("system-settings.registry");
    systemSettings.register({
      id: "background.system-settings.schedule",
      group: {
        id: "background-sync",
        label: { key: "background.settings.title", fallback: "Background sync" },
        order: 20
      },
      label: { key: "background.settings.assetHoldingsInterval", fallback: "Asset balance sync interval" },
      description: { key: "background.settings.description", fallback: "Adjust the asset balance sync interval." },
      component: BackgroundSettingsPage,
      order: 10,
      replacesSettingsRouteId: "background.settings",
      visibleWhen: ({ unlocked }) => unlocked
    });

    return () => {
      (service as BackgroundService & { dispose?: () => void }).dispose?.();
    };
  }
};
