// packages/plugin-background/src/manifest.ts
// 后台任务平台清单：注册 background.registry + background.service + Topbar 托盘。

import type {
  BackgroundRegistry,
  BackgroundService,
  I18nPluginResources,
  PluginManifest,
  SettingsRegistry,
  TopbarRegistry
} from "@keymaster/contracts";
import {
  BACKGROUND_REGISTRY_CAPABILITY,
  BACKGROUND_SERVICE_CAPABILITY,
  KEYSPACE_SERVICE_CAPABILITY,
  TOPBAR_REGISTRY_CAPABILITY
} from "@keymaster/contracts";
import { createBackgroundBundle } from "./backgroundService.js";
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
      "background.settings.option.60min": "1 hour"
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
      "background.settings.option.60min": "1 小时"
    }
  }
};

export const backgroundPlugin: PluginManifest = {
  id: "background",
  name: "Background",
  description: "通用后台任务平台：注册、调度、去重、Topbar 托盘。",
  meta: {
    kind: "platform",
    defaultEnabled: true,
    canDisable: true,
    providesCapabilities: [BACKGROUND_REGISTRY_CAPABILITY, BACKGROUND_SERVICE_CAPABILITY],
    displayGroup: "platform"
  },
  i18n: backgroundResources,
  dependencies: [
    { capability: TOPBAR_REGISTRY_CAPABILITY, reason: "需要向 Topbar 注册任务托盘" },
    { capability: "settings.registry", reason: "注册后台同步设置页" }
  ],
  setup(ctx) {
    const { registry, service } = createBackgroundBundle({ logger: ctx.logger });
    ctx.provide<BackgroundRegistry>(BACKGROUND_REGISTRY_CAPABILITY, registry);
    ctx.provide<BackgroundService>(BACKGROUND_SERVICE_CAPABILITY, service);

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

    // 注册后台同步设置页
    const settings = ctx.get<SettingsRegistry>("settings.registry");
    settings.register({
      id: "background.settings",
      path: "/settings/background",
      label: { key: "background.settings.title", fallback: "后台同步设置" },
      component: BackgroundSettingsPage,
      order: 50
    });

    return () => {
      // 硬切换 001：service.dispose 停止 interval / visibility / leader lock。
      service.dispose();
    };
  }
};
