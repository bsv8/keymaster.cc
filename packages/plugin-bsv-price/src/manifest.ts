// packages/plugin-bsv-price/src/manifest.ts
// BSV 价格业务插件 manifest（施工单 2026-07-08 001）。
//
// 设计缘由：
//   - 本插件是**第一个**真实广播业务插件；
//   - 直接消费 `BroadcastCore`，**不**经 `appmsg` 中转；
//   - 注册能力：`bsv-price.service` capability；
//   - 注册路由：`/bsv-price` 单页面（业务页），**不**注册首页 widget
//     （施工单 §7.4.4 收口成单页面，避免多表面状态分叉）；
//   - `pricePublisherPublicKeyHex` 由装配层通过 `manifest.config`
//     注入，只作为首次 seed；运行时编辑器走 `/settings/bsv-price`；
//   - **不**接触 provider handle / wire。

import type {
  BroadcastCore,
  I18nPluginResources,
  PluginManifest,
  ResourceRegistry
} from "@keymaster/contracts";
import { BROADCAST_CORE_CAPABILITY, RESOURCE_REGISTRY_CAPABILITY, type SettingsRegistry } from "@keymaster/contracts";
import {
  BSV_PRICE_CONFIG_KEY,
  BSV_PRICE_SETTINGS_PATH
} from "./constants.js";
import { createBsvPriceService, type BsvPriceService, type BsvPriceServiceSnapshot } from "./bsvPriceService.js";
import { BsvPricePage } from "./BsvPricePage.js";
import { BsvPriceSettingsPage } from "./BsvPriceSettingsPage.js";

/** plugin-bsv-price 插件 id。 */
export const BSV_PRICE_PLUGIN_ID = "bsv-price";
/** 插件对外 service capability key。 */
export const BSV_PRICE_SERVICE_CAPABILITY = "bsv-price.service";

const bsvPriceResources: I18nPluginResources = {
  namespace: "bsv-price",
  resources: {
    en: {
      "bsv-price.menu": "BSV Price",
      "bsv-price.breadcrumb": "BSV Price",
      "bsv-price.page.title": "BSV / USDT prices",
      "bsv-price.page.connection.label": "Connection",
      "bsv-price.page.connection.ready": "Receiving",
      "bsv-price.page.connection.idle": "Idle",
      "bsv-price.page.connection.offline": "Disconnected",
      "bsv-price.page.connection.noPublisherKey":
        "No active broadcast provider",
      "bsv-price.page.connection.notConfigured":
        "Publisher public key not configured",
      "bsv-price.page.channel.label": "Subscribed channel",
      "bsv-price.page.quotes.label": "Quotes",
      "bsv-price.page.table.exchange": "Exchange",
      "bsv-price.page.table.price": "Price (USDT)",
      "bsv-price.page.empty": "(waiting for next snapshot)",
      "bsv-price.page.error.lastParse": "Last parse error:",
      "bsv-price.settings.title": "BSV Price settings",
      "bsv-price.settings.desc":
        "Edit the PriceCast publisher public key. Saving an empty value clears the configuration and stops subscription.",
      "bsv-price.settings.save": "Save",
      "bsv-price.settings.saved": "Saved",
      "bsv-price.settings.savedCleared": "Configuration cleared",
      "bsv-price.settings.field.publisher.label": "PriceCast publisher public key hex",
      "bsv-price.settings.field.publisher.desc":
        "Trimmed and lowercased before saving. Empty string clears the config.",
      "bsv-price.settings.field.publisher.placeholder": "02... (66 hex chars)",
      "bsv-price.settings.channel.label": "Current subscribed channel",
      "bsv-price.settings.status.label": "Current status",
      "bsv-price.settings.status.ready": "Receiving",
      "bsv-price.settings.status.offline": "Disconnected",
      "bsv-price.settings.status.idle": "Idle",
      "bsv-price.settings.status.noPublisherKey": "Broadcast provider unavailable",
      "bsv-price.settings.status.notConfigured": "Not configured",
      "bsv-price.settings.clearHint":
        "Clearing the field will unsubscribe the current channel and put /bsv-price into not configured state.",
      "bsv-price.settings.error": "Save failed:"
    },
    "zh-CN": {
      "bsv-price.menu": "BSV 价格",
      "bsv-price.breadcrumb": "BSV 价格",
      "bsv-price.page.title": "BSV / USDT 价格",
      "bsv-price.page.connection.label": "连接",
      "bsv-price.page.connection.ready": "正在接收",
      "bsv-price.page.connection.idle": "空闲",
      "bsv-price.page.connection.offline": "已断开",
      "bsv-price.page.connection.noPublisherKey": "未配置 active broadcast provider",
      "bsv-price.page.connection.notConfigured": "未配置 publisher 公钥",
      "bsv-price.page.channel.label": "当前订阅频道",
      "bsv-price.page.quotes.label": "报价",
      "bsv-price.page.table.exchange": "交易所",
      "bsv-price.page.table.price": "价格 (USDT)",
      "bsv-price.page.empty": "（等待下一次快照）",
      "bsv-price.page.error.lastParse": "最近一次解析错误：",
      "bsv-price.settings.title": "BSV Price 设置",
      "bsv-price.settings.desc":
        "编辑 PriceCast 订阅方公钥。保存为空值会清空配置并停止订阅。",
      "bsv-price.settings.save": "保存",
      "bsv-price.settings.saved": "已保存",
      "bsv-price.settings.savedCleared": "已清空配置",
      "bsv-price.settings.field.publisher.label": "PriceCast publisher 公钥 hex",
      "bsv-price.settings.field.publisher.desc":
        "保存前会 trim 并转小写。空字符串会清空配置。",
      "bsv-price.settings.field.publisher.placeholder": "02...（66 位 hex）",
      "bsv-price.settings.channel.label": "当前实际订阅频道",
      "bsv-price.settings.status.label": "当前状态",
      "bsv-price.settings.status.ready": "正在接收",
      "bsv-price.settings.status.offline": "已断开",
      "bsv-price.settings.status.idle": "空闲",
      "bsv-price.settings.status.noPublisherKey": "广播源不可用",
      "bsv-price.settings.status.notConfigured": "未配置",
      "bsv-price.settings.clearHint":
        "清空输入框会取消当前频道订阅，并让 /bsv-price 进入未配置状态。",
      "bsv-price.settings.error": "保存失败："
    }
  }
};

/**
 * plugin-bsv-price manifest。
 *
 * 关键约束（施工单 §7.4 + §5.4）：
 *   - 本插件**只**消费 `BroadcastCore` 不依赖 `appmsg.core`；
 *   - 提供能力：`bsv-price.service`；
 *   - 注册路由：`/bsv-price`；
 *   - 不注册任何首页 widget；
 *   - 不接触 provider handle / wire 细节。
 *
 * 配置面（施工单 2026-07-08 001）：
 *   - `pricePublisherPublicKeyHex`：由装配层在 `manifest.config` 显式
 *     注入；hex 字符串来自 PriceCast 服务端运营私钥导出的压缩公钥；
 *   - 缺值 → `bsv-price.service` 立即进入 `not_configured` 状态，
 *     页面持续空态（**不**构造伪频道占位）；
 *   - 配置来源**唯一**接受 `manifest.config`，不再支持 `globalThis`
 *     隐式注入路径，避免"`globalThis.__PRICECAST_PUBLISHER_PUBKEY__`
 *     被忽略谁知道写了什么"这类部署歧义。
 */
export const bsvPricePlugin: PluginManifest = {
  id: BSV_PRICE_PLUGIN_ID,
  name: "BSV Price",
  description:
    "BSV 价格业务插件：消费 BroadcastCore，订阅 PriceCast publisher 公钥频道，展示交易所价格快照。",
  i18n: bsvPriceResources,
  meta: {
    kind: "business",
    defaultEnabled: true,
    canDisable: true,
    providesCapabilities: [BSV_PRICE_SERVICE_CAPABILITY],
    displayGroup: "business"
  },
  // 由装配层在 host.register 之前注入；plugin 自己的 setup 不回写。
  config: {
    // 缺省空对象 → plugin 进入 not_configured 状态。
    pricePublisherPublicKeyHex: ""
  },
  dependencies: [
    {
      capability: BROADCAST_CORE_CAPABILITY,
      reason:
        "plugin-broadcast 在 setup 阶段 provide broadcast.core；本插件直接消费"
    },
    { capability: "route.registry", reason: "注册 /bsv-price 业务页" },
    { capability: "menu.registry", reason: "注册「BSV 价格」菜单项" },
    {
      capability: "breadcrumb.registry",
      reason: "为 /bsv-price 与 /settings/bsv-price 提供面包屑"
    },
    {
      capability: "settings.registry",
      reason: "注册 /settings/bsv-price 设置详情页"
    },
    {
      capability: RESOURCE_REGISTRY_CAPABILITY,
      reason: "注册 BSV Price 状态资源"
    }
  ],
  setup(ctx) {
    /**
     * 关键约束（施工单 §4.1.1 + §8.六）：
     *   - 不从 keyspace / vault 推断；
     *   - 配置缺失 → 业务页持续空态（**不**构造伪频道占位）；
     *   - `pricePublisherPublicKeyHex` **首次 seed** 仅来自 `ctx.config`，
     *     由装配层在 `manifest.config` 注入；运行时真值由
     *     `localStorage["bsv-price.settings"]` 承担；
     *   - 取值后做类型校验：非字符串视为未配置。
     */
    const cfg = ctx.config ?? {};
    const publisherHex =
      typeof cfg[BSV_PRICE_CONFIG_KEY] === "string" &&
      (cfg[BSV_PRICE_CONFIG_KEY] as string).length > 0
        ? (cfg[BSV_PRICE_CONFIG_KEY] as string)
        : "";

    const core = ctx.get<BroadcastCore>(BROADCAST_CORE_CAPABILITY);
    const service = createBsvPriceService(core, {
      seedPublisherPublicKeyHex: publisherHex
    });
    ctx.provide(BSV_PRICE_SERVICE_CAPABILITY, service);
    const resources = ctx.has(RESOURCE_REGISTRY_CAPABILITY)
      ? ctx.get<ResourceRegistry>(RESOURCE_REGISTRY_CAPABILITY)
      : undefined;
    resources?.register<BsvPriceServiceSnapshot, readonly string[]>({
      id: "bsv-price.snapshot",
      scope: "global",
      key: () => ["bsv-price.snapshot"],
      load: async (_args, context) => context.getCapability<BsvPriceService>(BSV_PRICE_SERVICE_CAPABILITY)!.snapshot(),
      subscribe: (_args, context, invalidate) => context.getCapability<BsvPriceService>(BSV_PRICE_SERVICE_CAPABILITY)?.subscribe(invalidate) ?? (() => {}),
      equals: (a, b) => JSON.stringify(a) === JSON.stringify(b),
      invalidation: "immediate"
    });

    const routes = ctx.get<{
      register(input: {
        id: string;
        path: string;
        component: unknown;
        inMenu?: boolean;
        menuGroup?: string;
        order?: number;
        icon?: string;
        label: { key: string; fallback: string };
      }): void;
    }>("route.registry");
    const menus = ctx.get<{
      register(input: {
        id: string;
        path: string;
        group: string;
        order?: number;
        icon?: string;
        label: { key: string; fallback: string };
      }): void;
    }>("menu.registry");
    const breadcrumbs = ctx.get<{
      register(input: {
        id: string;
        order?: number;
        match: (path: string) => boolean;
        resolve: () => Array<{ label: { key: string; fallback: string } }>;
      }): void;
    }>("breadcrumb.registry");
    const settings = ctx.get<SettingsRegistry>("settings.registry");

    routes.register({
      id: "bsv-price.page",
      path: "/bsv-price",
      label: { key: "bsv-price.menu", fallback: "BSV Price" },
      component: BsvPricePage,
      inMenu: true,
      menuGroup: "tools",
      order: 10,
      icon: "LineChart"
    });

    menus.register({
      id: "bsv-price.page",
      path: "/bsv-price",
      group: "tools",
      order: 10,
      icon: "LineChart",
      label: { key: "bsv-price.menu", fallback: "BSV Price" }
    });

    breadcrumbs.register({
      id: "bsv-price.page",
      order: 10,
      match: (path: string) => path === "/bsv-price",
      resolve: () => [
        { label: { key: "bsv-price.breadcrumb", fallback: "BSV Price" } }
      ]
    });
    breadcrumbs.register({
      id: "bsv-price.settings.crumbs",
      order: 10,
      match: (path: string) => path === BSV_PRICE_SETTINGS_PATH,
      resolve: () => [
        {
          label: {
            key: "bsv-price.settings.title",
            fallback: "BSV Price settings"
          }
        }
      ]
    });

    settings.register({
      id: "bsv-price.settings",
      path: BSV_PRICE_SETTINGS_PATH,
      label: {
        key: "bsv-price.settings.title",
        fallback: "BSV Price settings"
      },
      description: {
        key: "bsv-price.settings.desc",
        fallback:
          "Edit the PriceCast publisher public key. Saving an empty value clears the configuration and stops subscription."
      },
      component: BsvPriceSettingsPage,
      order: 130,
      icon: "LineChart",
      visibleWhen: ({ unlocked }) => unlocked
    });

    return () => {
      service.dispose();
    };
  }
};
