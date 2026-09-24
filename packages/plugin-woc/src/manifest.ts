// packages/plugin-woc/src/manifest.ts
// WOC 插件清单：注册 woc.service；设置区由 Web 装配层的 BSV 链页面承载。
//
// 设计缘由（硬切换 008 收尾）：
//   - actor 必须挂到 runtime messageBus 才能与其它插件在同一总线上。
//   - 因此本插件显式声明对 RUNTIME_MESSAGE_BUS capability 的依赖。
//   - 业务插件仍只依赖 wocService，不再接触 messageBus。
//
// 硬切换 003：所有展示文案走 i18n；WOC 设置不再注入「设置 → 系统」。

import type {
  I18nPluginResources,
  PluginManifest,
  PluginSetup,
  Woc1SatOrdinalsService,
  WocBsv21Service,
  WocConfig,
  WocService,
  WocStasService
} from "@keymaster/contracts";
import type { MessageBus } from "webloom-framework";
import {
  RUNTIME_MESSAGE_BUS,
  WOC_COORDINATOR_CONTROL_CAPABILITY,
  type P2pkhCoordinatorControl,
  WOC_1SAT_ORDINALS_CAPABILITY,
  WOC_BSV21_CAPABILITY,
  WOC_CAPABILITY,
  WOC_STAS_CAPABILITY,
  capabilityDescriptor,
  defineRuntimeUnitDependencies,
} from "@keymaster/contracts";
import { createWoc1SatOrdinalsService } from "./woc1SatOrdinalsService.js";
import { createWocBsv21Service } from "./wocBsv21Service.js";
import { createWocService } from "./wocService.js";
import { createWocStasService } from "./wocStasService.js";

const wocResources: I18nPluginResources = {
  namespace: "woc",
  resources: {
    en: {
      "woc.crumb.settings": "Settings",
      "woc.crumb.woc": "WOC",
      "woc.page.title": "WOC settings",
      "woc.page.desc": "Configure requests per second. The WhatsOnChain endpoint is fixed.",
      "woc.settings.unavailable": "Wallet is locked or the WOC service is temporarily unavailable; unlock to continue configuring.",
      "woc.field.baseUrl": "WOC base URL",
      "woc.field.baseUrlDesc": "Fixed address: https://api.whatsonchain.com/v1/bsv",
      "woc.field.rps": "Requests per second",
      "woc.field.rpsDesc": "Public API recommends 2; custom proxy may allow higher.",
      "woc.action.save": "Save",
      "woc.action.reset": "Reset to default",
      "woc.action.saved": "Saved",
      "woc.status.section": "Queue status",
      "woc.status.queued": "Queued: ",
      "woc.status.inFlight": "In flight: ",
      "woc.status.lastError": "Last error: ",
      "woc.status.backoffLine": "WOC global backoff lifted at {{time}}",
      "woc.status.noBackoff": "No backoff",
      "woc.status.coordinated.ok": "Multi-tab coordination: enabled (Web Locks)",
      "woc.status.coordinated.warn": "Multi-tab coordination: disabled. The current browser does not support Web Locks, so cross-tab rate limiting cannot be guaranteed. Open only one wallet tab at a time, or switch to a Web-Locks-capable browser, to avoid triggering WOC rate limits."
    },
    "zh-CN": {
      "woc.crumb.settings": "设置",
      "woc.crumb.woc": "WOC",
      "woc.page.title": "WOC 设置",
      "woc.page.desc": "配置每秒请求数。WhatsOnChain 地址固定不可修改。",
      "woc.settings.unavailable": "钱包已锁定或 WOC 服务暂不可用；解锁后可继续配置。",
      "woc.field.baseUrl": "WOC base URL",
      "woc.field.baseUrlDesc": "固定地址：https://api.whatsonchain.com/v1/bsv",
      "woc.field.rps": "每秒请求数",
      "woc.field.rpsDesc": "公共 API 建议默认 2；自定义代理可提高。",
      "woc.action.save": "保存",
      "woc.action.reset": "恢复缺省",
      "woc.action.saved": "已保存",
      "woc.status.section": "队列状态",
      "woc.status.queued": "排队：",
      "woc.status.inFlight": "飞行中：",
      "woc.status.lastError": "最近错误：",
      "woc.status.backoffLine": "WOC 全局 backoff 解除于 {{time}}",
      "woc.status.noBackoff": "无 backoff",
      "woc.status.coordinated.ok": "多标签页协调：已启用（Web Locks）",
      "woc.status.coordinated.warn": "多标签页协调：未启用。当前浏览器不支持 Web Locks，跨标签页限流无法保证；请只开一个钱包标签页或换用支持 Web Locks 的浏览器以避免触发 WOC 限流。"
    }
  }
};

const wocPluginDefinition = {
  id: "woc",
  name: "WOC",
  description: "WhatsOnChain API 代理：唯一 WOC 入口、全局限流、优先级队列、429 backoff、多标签页协调。",
  kind: "platform",
  startup: "optional",
  bootstrapStage: "owner-apps-ready",
  defaultEnabled: true,
  canDisable: true,
  displayGroup: "platform",
  units: [{
    id: "woc.window",
    runtime: "window-main",
    scopeKind: "owner-session",
    provides: [
      capabilityDescriptor(WOC_CAPABILITY),
      capabilityDescriptor(WOC_BSV21_CAPABILITY),
      capabilityDescriptor(WOC_STAS_CAPABILITY),
      capabilityDescriptor(WOC_1SAT_ORDINALS_CAPABILITY),
      capabilityDescriptor(WOC_COORDINATOR_CONTROL_CAPABILITY),
    ],
    dependencies: defineRuntimeUnitDependencies([
      { capability: RUNTIME_MESSAGE_BUS, sourceRuntime: "window-main", reason: "注册 WOC actor handlers（target=woc）" },
    ]),
  }, {
    id: "woc.coordinator-worker",
    runtime: "shared-worker",
    scopeKind: "owner-session",
  }],
  i18n: wocResources,
  async setup(ctx) {
    const coordinator = ctx.coordinator as P2pkhCoordinatorControl | undefined;
    if (!coordinator) throw new Error("WOC Coordinator control is unavailable");
    ctx.provide(WOC_COORDINATOR_CONTROL_CAPABILITY, coordinator);
    const messageBus = ctx.capability(RUNTIME_MESSAGE_BUS);
    const bootstrap: Partial<WocConfig> = {};
    const bootstrapResult = await coordinator.p2pkhProviderConfigGet("woc");
    if (bootstrapResult.status === "ok") {
      const endpoint = bootstrapResult.value.endpoint;
      const requestsPerSecond = bootstrapResult.value.requestsPerSecond;
      if (typeof endpoint === "string" && endpoint.trim()) {
        bootstrap.baseUrl = endpoint.trim().replace(/\/+$/, "");
      }
      if (typeof requestsPerSecond === "number" && Number.isFinite(requestsPerSecond) && requestsPerSecond > 0) {
        bootstrap.requestsPerSecond = requestsPerSecond;
      }
    }
    const service = createWocService({ messageBus, initialConfig: bootstrap });
    await service.ready();
    // WOC capability 只向页面插件暴露只读方法。完整句柄仍由 Worker
    // 自己保留并用于注册物理广播 Provider，页面即使拿到运行时对象也
    // 不存在 `broadcast` 出口。
    const { broadcast: _workerBroadcast, ...readOnlyService } = service;
    void _workerBroadcast;
    ctx.provide(WOC_CAPABILITY, readOnlyService);

    // BSV-21 / STAS / 1Sat Ordinals 的 WOC capability。
    // 全部共享同一个 actor（service 内的 createWocService 持有 actor 并
    // 已 attach 到 messageBus），因此 token / collectible 业务插件继承
    // 同一套限流 / 优先级 / 429 backoff / 多标签页协调，不复制第二套队列。
    const bsv21Service = createWocBsv21Service({ messageBus });
    ctx.provide(WOC_BSV21_CAPABILITY, bsv21Service);
    const stasService = createWocStasService({ messageBus });
    ctx.provide(WOC_STAS_CAPABILITY, stasService);
    const oneSatService = createWoc1SatOrdinalsService({ messageBus });
    ctx.provide(WOC_1SAT_ORDINALS_CAPABILITY, oneSatService);

    return () => {
      // 硬切换 001：bridge 到 service.dispose()。
      // actor detach + 取消 messageBus handle 都在 dispose 内。
      service.dispose();
    };
  }
} satisfies PluginManifest & { setup: PluginSetup };

const { setup: wocSetup, ...wocPlugin } = wocPluginDefinition;

export { wocPlugin, wocSetup };
