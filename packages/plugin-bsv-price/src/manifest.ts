// packages/plugin-bsv-price/src/manifest.ts
// BSV 价格业务插件 manifest（施工单 2026-07-08 001）。
//
// 设计缘由：
//   - 本插件是**第一个**真实广播业务插件；
//   - 直接消费 `BroadcastCore`，**不**经 `appmsg` 中转；
//   - 注册能力：`bsv-price.service` capability；
//   - 注册路由：`/bsv-price` 单页面（业务页），**不**注册首页 widget
//     （施工单 §7.4.4 收口成单页面，避免多表面状态分叉）；
//   - 配置 `pricePublisherPublicKeyHex` 由装配层通过 `manifest.config`
//     注入；本插件**不**走运行时编辑器；
//   - **不**接触 provider handle / wire。

import type {
  BroadcastCore,
  I18nPluginResources,
  PluginManifest
} from "@keymaster/contracts";
import { BROADCAST_CORE_CAPABILITY } from "@keymaster/contracts";
import { buildPriceChannelId, BSV_PRICE_CONFIG_KEY } from "./constants.js";
import { createBsvPriceService } from "./bsvPriceService.js";
import { BsvPricePage } from "./BsvPricePage.js";

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
      "bsv-price.page.error.lastParse": "Last parse error:"
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
      "bsv-price.page.error.lastParse": "最近一次解析错误："
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
      reason: "为 /bsv-price 提供面包屑"
    }
  ],
  setup(ctx) {
    /**
     * 关键约束（施工单 §4.1.1 + §8.六）：
     *   - 不从 keyspace / vault 推断；
     *   - 配置缺失 → 业务页持续空态（**不**构造伪频道占位）；
     *   - `pricePublisherPublicKeyHex` **唯一**来源：`ctx.config`，
     *     由装配层在 `manifest.config` 注入；plugin 自己**不**接受
     *     `globalThis` / `localStorage` / 任何隐式注入路径；
     *   - 取值后做类型校验：非字符串视为未配置。
     */
    const cfg = ctx.config ?? {};
    const publisherHex =
      typeof cfg[BSV_PRICE_CONFIG_KEY] === "string" &&
      (cfg[BSV_PRICE_CONFIG_KEY] as string).length > 0
        ? (cfg[BSV_PRICE_CONFIG_KEY] as string)
        : "";

    const core = ctx.get<BroadcastCore>(BROADCAST_CORE_CAPABILITY);
    const service = createBsvPriceService(core, publisherHex);
    ctx.provide(BSV_PRICE_SERVICE_CAPABILITY, service);

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

    return () => {
      // service 自己的订阅在页面卸载时被浏览器回收；本处不持有额外资源。
    };
  }
};
