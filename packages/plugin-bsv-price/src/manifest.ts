// packages/plugin-bsv-price/src/manifest.ts
// BSV 价格业务插件 manifest。
//
// 设计缘由：
//   - 本插件直接消费 Coordinator Channel runtime；
//   - 注册能力：`bsv-price.service`（设置 + 业务页）与 `bsv-price.reader`
//     （跨包只读展示价，供首页 / 资产页 / Connect 使用）；
//   - 注册路由：`/bsv-price` 单页面（业务页），并在首页右侧栏提供价格 widget；
//   - 缺省配置是生产 PriceCast 发布器 + `gate/bsvusdt`；
//   - 设置里可以登记多个发布服务器，但只订阅当前激活服务器的频道；
//   - **不**接触 provider handle / wire。

import { defineCapability } from "webloom-framework";
import type {
  ChannelRuntimeFactory,
  I18nPluginResources,
  PluginManifest,
  PluginSetup,
  ResourceRegistry
} from "@keymaster/contracts";
import {
  BSV_PRICE_READER_CAPABILITY,
  CHANNEL_RUNTIME_CAPABILITY,
  ROUTE_REGISTRY_CAPABILITY,
  BREADCRUMB_REGISTRY_CAPABILITY,
  BUSINESS_REGISTRY_CAPABILITY,
  HOME_REGISTRY_CAPABILITY,
  KEYSPACE_SERVICE_CAPABILITY,
  RESOURCE_REGISTRY_CAPABILITY,
  capabilityDescriptor,
  defineRuntimeUnitDependencies,
} from "@keymaster/contracts";
import {
  BSV_PRICE_CONFIG_KEY,
  BSV_PRICE_SETTINGS_PATH,
  DEFAULT_PRICE_PUBLISHER_PUBLIC_KEY_HEX
} from "./constants.js";
import { createBsvPriceService, type BsvPriceService, type BsvPriceServiceSnapshot } from "./bsvPriceService.js";
import { BsvPricePage } from "./BsvPricePage.js";
import { BsvPriceSettingsPage } from "./BsvPriceSettingsPage.js";
import { BsvPriceHomeWidget } from "./BsvPriceHomeWidget.js";
import { CENTRAL_STORAGE_DECLARATIONS } from "@keymaster/contracts";

/** plugin-bsv-price 插件 id。 */
export const BSV_PRICE_PLUGIN_ID = "bsv-price";
/** 插件对外完整 service capability key（含设置编辑）。 */
export const BSV_PRICE_SERVICE_CAPABILITY = defineCapability<BsvPriceService>({
  kind: "local",
  id: "bsv-price.service",
  version: "1",
});

const bsvPriceResources: I18nPluginResources = {
  namespace: "bsv-price",
  resources: {
    en: {
      "bsv-price.menu": "BSV Price",
      "bsv-price.breadcrumb": "BSV Price",
      "bsv-price.page.title": "BSV market price",
      "bsv-price.page.connection.label": "Connection",
      "bsv-price.page.connection.idle": "Idle",
      "bsv-price.page.connection.offline": "Disconnected",
      "bsv-price.page.connection.notConfigured": "No active publisher configured",
      "bsv-price.page.connection.satNotConfigured": "SatSubscription is not configured",
      "bsv-price.page.connection.satConnecting": "Connecting to SatSubscription",
      "bsv-price.page.connection.satBalanceRequired": "SatSubscription balance is insufficient",
      "bsv-price.page.connection.satIdentityError": "SatSubscription identity error",
      "bsv-price.page.connection.satSubscriptionError": "SatSubscription subscription failed",
      "bsv-price.page.connection.subscriptionUnknown": "Subscription result is unknown; waiting to retry",
      "bsv-price.page.connection.waitingSnapshot": "Waiting for a BSV price snapshot",
      "bsv-price.page.connection.receiving": "Receiving",
      "bsv-price.page.publisher.label": "Publisher",
      "bsv-price.page.channel.label": "Subscribed channel",
      "bsv-price.page.quote.label": "Active option",
      "bsv-price.page.unit.label": "Unit",
      "bsv-price.page.price.label": "Display price",
      "bsv-price.page.snapshotAt.label": "Snapshot time",
      "bsv-price.page.quotes.label": "Received quotes",
      "bsv-price.page.table.market": "Market",
      "bsv-price.page.table.pair": "Trading pair",
      "bsv-price.page.table.price": "Price",
      "bsv-price.page.empty.waitingSnapshot": "(waiting for the next snapshot)",
      "bsv-price.page.empty.receiving": "(no quote for the active option in the current snapshot)",
      "bsv-price.page.empty.notConfigured": "No active publisher is configured.",
      "bsv-price.page.empty.offline": "Wallet or Channel service is unavailable; unlock or re-enter the current owner.",
      "bsv-price.page.empty.satNotConfigured": "SatSubscription is not configured; enable a receive Supplier.",
      "bsv-price.page.empty.satConnecting": "Connecting to SatSubscription; check the Supplier address and connection.",
      "bsv-price.page.empty.satBalanceRequired": "Top up SatSubscription before subscribing.",
      "bsv-price.page.empty.satIdentityError": "Check the Supplier public key, Peer ID, and address.",
      "bsv-price.page.empty.satSubscriptionError": "SatSubscription could not create this subscription; use the stable error code above.",
      "bsv-price.page.empty.subscriptionUnknown": "Subscription result is unknown; wait for reconciliation.",
      "bsv-price.page.empty.idle": "Price subscription is idle.",
      "bsv-price.page.error.lastParse": "Last parse error:",
      "bsv-price.page.error.subscription": "Subscription error",
      "bsv-price.page.error.balanceHint": "Top up SatSubscription before retrying.",
      "bsv-price.page.error.unknownHint": "Do not manually retry or duplicate-charge; wait for reconciliation.",
      "bsv-price.home.title": "BSV Price",
      "bsv-price.home.unavailable": "Price service is temporarily unavailable for this session.",
      "bsv-price.home.price.label": "Current price",
      "bsv-price.home.updatedAt": "Updated {{time}}",
      "bsv-price.home.empty.waitingSnapshot": "Waiting for a BSV price snapshot",
      "bsv-price.home.empty.receiving": "No quote for the active option",
      "bsv-price.home.empty.notConfigured": "No active publisher configured",
      "bsv-price.home.empty.offline": "Unlock or re-enter the current owner",
      "bsv-price.home.empty.satNotConfigured": "Configure and enable a receive Supplier",
      "bsv-price.home.empty.satConnecting": "Check the Supplier address and connection",
      "bsv-price.home.empty.satBalanceRequired": "Top up SatSubscription before subscribing",
      "bsv-price.home.empty.satIdentityError": "Check the Supplier key, Peer ID, and address",
      "bsv-price.home.empty.satSubscriptionError": "Handle the stable subscription error code",
      "bsv-price.home.empty.subscriptionUnknown": "Subscription result unknown; waiting for reconciliation",
      "bsv-price.home.empty.idle": "Price subscription is idle",
      "bsv-price.home.status.idle": "Idle",
      "bsv-price.home.status.offline": "Offline",
      "bsv-price.home.status.not_configured": "Not configured",
      "bsv-price.home.status.sat_not_configured": "SatSubscription not configured",
      "bsv-price.home.status.sat_connecting": "Connecting",
      "bsv-price.home.status.sat_balance_required": "Balance required",
      "bsv-price.home.status.sat_identity_error": "Identity error",
      "bsv-price.home.status.sat_subscription_error": "Subscription error",
      "bsv-price.home.status.subscription_unknown": "Result unknown",
      "bsv-price.home.status.waiting_snapshot": "Waiting for snapshot",
      "bsv-price.home.status.receiving": "Receiving",
      "bsv-price.home.error.subscription": "Subscription error",
      "bsv-price.home.error.balanceHint": "Top up SatSubscription before retrying.",
      "bsv-price.home.error.unknownHint": "Wait for reconciliation before retrying.",
      "bsv-price.settings.title": "BSV Price settings",
      "bsv-price.settings.desc":
        "Manage price publisher servers and the active quote. The price is display-only and never used for business decisions.",
      "bsv-price.settings.servers.label": "Price publisher servers",
      "bsv-price.settings.servers.desc":
        "Only the active server is subscribed. The price channel is `bsvprice.<publisher public key>`.",
      "bsv-price.settings.server.name": "Name",
      "bsv-price.settings.server.key": "Publisher public key hex",
      "bsv-price.settings.server.add": "Add server",
      "bsv-price.settings.server.delete": "Delete",
      "bsv-price.settings.server.default": "Default",
      "bsv-price.settings.active.label": "Active option",
      "bsv-price.settings.active.server": "Server",
      "bsv-price.settings.active.market": "Market",
      "bsv-price.settings.active.pair": "Trading pair",
      "bsv-price.settings.active.apply": "Apply option",
      "bsv-price.settings.active.unit": "Unit",
      "bsv-price.settings.active.waiting": "(waiting for the active server's received list)",
      "bsv-price.settings.price.label": "Current price",
      "bsv-price.settings.channel.label": "Subscribed channel",
      "bsv-price.settings.status.label": "Status",
      "bsv-price.settings.snapshotAt.label": "Snapshot time",
      "bsv-price.settings.data.label": "Received data",
      "bsv-price.settings.data.desc":
        "Everything this page received from the subscription: runtime state, snapshot and all quotes.",
      "bsv-price.settings.coreState.label": "Channel runtime",
      "bsv-price.settings.configured.label": "Configured",
      "bsv-price.settings.configured.true": "Yes",
      "bsv-price.settings.configured.false": "No",
      "bsv-price.settings.active.key.label": "Active publisher key",
      "bsv-price.settings.snapshot.protocol.label": "Snapshot protocol",
      "bsv-price.settings.snapshot.sourceAt.label": "Source snapshot time",
      "bsv-price.settings.lastError.label": "Last parse error",
      "bsv-price.settings.quotes.label": "Received quotes",
      "bsv-price.settings.quotes.empty": "(waiting for the active server's snapshot)",
      "bsv-price.settings.quotes.table.market": "Market",
      "bsv-price.settings.quotes.table.pair": "Trading pair",
      "bsv-price.settings.quotes.table.price": "Price",
      "bsv-price.settings.restore": "Restore original settings",
      "bsv-price.settings.restored": "Original settings restored",
      "bsv-price.settings.serverAdded": "Server added",
      "bsv-price.settings.serverRemoved": "Server removed",
      "bsv-price.settings.activeSaved": "Active option saved",
      "bsv-price.settings.subscriptionError": "Subscription error",
      "bsv-price.settings.balanceHint": "Top up SatSubscription before retrying.",
      "bsv-price.settings.unknownHint": "Do not manually duplicate-charge; wait for reconciliation.",
      "bsv-price.settings.error.invalid_type": "Input must be a string",
      "bsv-price.settings.error.invalid_empty": "This field is required",
      "bsv-price.settings.error.invalid_length": "Value is too long",
      "bsv-price.settings.error.invalid_hex": "Public key hex may only contain 0-9 and a-f",
      "bsv-price.settings.error.invalid_prefix": "A compressed public key must start with 02 or 03",
      "bsv-price.settings.error.invalid_public_key": "Not a valid secp256k1 compressed public key",
      "bsv-price.settings.error.invalid_identifier": "Only lowercase letters, digits, dot, hyphen and underscore are allowed",
      "bsv-price.settings.error.invalid_character": "Control characters are not allowed",
      "bsv-price.settings.error.server_exists": "A server with this public key already exists",
      "bsv-price.settings.error.server_not_found": "Server not found",
      "bsv-price.settings.error.default_server_required": "The default bsv8 server cannot be removed",
      "bsv-price.settings.error.last_server_required": "At least one server must remain",
      "bsv-price.settings.error.invalid_bsv_price_config": "Settings are invalid",
      "bsv-price.settings.status.idle": "Idle",
      "bsv-price.settings.status.offline": "Disconnected",
      "bsv-price.settings.status.notConfigured": "Not configured",
      "bsv-price.settings.status.satNotConfigured": "SatSubscription is not configured",
      "bsv-price.settings.status.satConnecting": "Connecting to SatSubscription",
      "bsv-price.settings.status.satBalanceRequired": "SatSubscription balance is insufficient",
      "bsv-price.settings.status.satIdentityError": "SatSubscription identity error",
      "bsv-price.settings.status.satSubscriptionError": "SatSubscription subscription failed",
      "bsv-price.settings.status.subscriptionUnknown": "Subscription result is unknown; waiting to retry",
      "bsv-price.settings.status.waitingSnapshot": "Waiting for a BSV price snapshot",
      "bsv-price.settings.status.receiving": "Receiving",
      "bsv-price.settings.clearHint":
        "The price is only a display reference for multiplying with sats; it is never used for business decisions."
    },
    "zh-CN": {
      "bsv-price.menu": "BSV 价格",
      "bsv-price.breadcrumb": "BSV 价格",
      "bsv-price.page.title": "BSV 市场价格",
      "bsv-price.page.connection.label": "连接",
      "bsv-price.page.connection.idle": "空闲",
      "bsv-price.page.connection.offline": "已断开",
      "bsv-price.page.connection.notConfigured": "未配置激活发布器",
      "bsv-price.page.connection.satNotConfigured": "SatSubscription 未配置",
      "bsv-price.page.connection.satConnecting": "正在连接 SatSubscription",
      "bsv-price.page.connection.satBalanceRequired": "SatSubscription 余额不足，请充值",
      "bsv-price.page.connection.satIdentityError": "SatSubscription 身份错误",
      "bsv-price.page.connection.satSubscriptionError": "SatSubscription 订阅失败",
      "bsv-price.page.connection.subscriptionUnknown": "订阅结果未知，等待重试",
      "bsv-price.page.connection.waitingSnapshot": "等待 BSV 价格快照",
      "bsv-price.page.connection.receiving": "正在接收",
      "bsv-price.page.publisher.label": "发布服务器",
      "bsv-price.page.channel.label": "当前订阅频道",
      "bsv-price.page.quote.label": "激活选项",
      "bsv-price.page.unit.label": "单位",
      "bsv-price.page.price.label": "当前显示价格",
      "bsv-price.page.snapshotAt.label": "快照时间",
      "bsv-price.page.quotes.label": "收到的行情",
      "bsv-price.page.table.market": "交易所",
      "bsv-price.page.table.pair": "交易对",
      "bsv-price.page.table.price": "价格",
      "bsv-price.page.empty.waitingSnapshot": "（等待下一次快照）",
      "bsv-price.page.empty.receiving": "（当前快照没有激活选项的报价）",
      "bsv-price.page.empty.notConfigured": "未配置激活发布服务器。",
      "bsv-price.page.empty.offline": "钱包或 Channel 服务不可用，请解锁或重新进入当前 Owner。",
      "bsv-price.page.empty.satNotConfigured": "未配置 SatSubscription，请配置并启用接收 Supplier。",
      "bsv-price.page.empty.satConnecting": "正在连接 SatSubscription，请检查 Supplier 地址及连接状态。",
      "bsv-price.page.empty.satBalanceRequired": "请先为 SatSubscription 充值后再订阅。",
      "bsv-price.page.empty.satIdentityError": "请检查 Supplier 公钥、Peer ID 和地址。",
      "bsv-price.page.empty.satSubscriptionError": "SatSubscription 无法建立此订阅，请根据上方稳定错误码处理。",
      "bsv-price.page.empty.subscriptionUnknown": "订阅结果未知，请等待系统对账。",
      "bsv-price.page.empty.idle": "价格订阅处于空闲状态。",
      "bsv-price.page.error.lastParse": "最近一次解析错误：",
      "bsv-price.page.error.subscription": "订阅错误",
      "bsv-price.page.error.balanceHint": "请先为 SatSubscription 充值后再重试。",
      "bsv-price.page.error.unknownHint": "请勿手动重复重试或重复扣费，等待系统对账。",
      "bsv-price.home.title": "BSV 价格",
      "bsv-price.home.unavailable": "当前会话暂时无法提供行情。",
      "bsv-price.home.price.label": "当前价格",
      "bsv-price.home.updatedAt": "更新于 {{time}}",
      "bsv-price.home.empty.waitingSnapshot": "等待 BSV 价格快照",
      "bsv-price.home.empty.receiving": "当前快照没有激活选项的报价",
      "bsv-price.home.empty.notConfigured": "未配置激活发布服务器",
      "bsv-price.home.empty.offline": "请解锁或重新进入当前 Owner",
      "bsv-price.home.empty.satNotConfigured": "请配置并启用接收 Supplier",
      "bsv-price.home.empty.satConnecting": "请检查 Supplier 地址及连接状态",
      "bsv-price.home.empty.satBalanceRequired": "请先为 SatSubscription 充值",
      "bsv-price.home.empty.satIdentityError": "请检查 Supplier 公钥、Peer ID 和地址",
      "bsv-price.home.empty.satSubscriptionError": "请根据稳定订阅错误码处理",
      "bsv-price.home.empty.subscriptionUnknown": "订阅结果未知，等待系统对账",
      "bsv-price.home.empty.idle": "价格订阅处于空闲状态",
      "bsv-price.home.status.idle": "空闲",
      "bsv-price.home.status.offline": "已断开",
      "bsv-price.home.status.not_configured": "未配置",
      "bsv-price.home.status.sat_not_configured": "SatSubscription 未配置",
      "bsv-price.home.status.sat_connecting": "正在连接",
      "bsv-price.home.status.sat_balance_required": "余额不足",
      "bsv-price.home.status.sat_identity_error": "身份错误",
      "bsv-price.home.status.sat_subscription_error": "订阅失败",
      "bsv-price.home.status.subscription_unknown": "结果未知",
      "bsv-price.home.status.waiting_snapshot": "等待快照",
      "bsv-price.home.status.receiving": "正在接收",
      "bsv-price.home.error.subscription": "订阅错误",
      "bsv-price.home.error.balanceHint": "请先为 SatSubscription 充值后再重试。",
      "bsv-price.home.error.unknownHint": "请等待系统对账后再重试。",
      "bsv-price.settings.title": "BSV Price 设置",
      "bsv-price.settings.desc":
        "管理价格发布服务器和激活交易对。价格只作显示参考，不用于任何业务判断。",
      "bsv-price.settings.servers.label": "价格发布服务器",
      "bsv-price.settings.servers.desc":
        "只订阅当前激活的服务器；价格频道为 `bsvprice.<发布器公钥>`。",
      "bsv-price.settings.server.name": "名称",
      "bsv-price.settings.server.key": "发布器公钥 hex",
      "bsv-price.settings.server.add": "添加服务器",
      "bsv-price.settings.server.delete": "删除",
      "bsv-price.settings.server.default": "默认",
      "bsv-price.settings.active.label": "激活选项",
      "bsv-price.settings.active.server": "服务器",
      "bsv-price.settings.active.market": "交易所",
      "bsv-price.settings.active.pair": "交易对",
      "bsv-price.settings.active.apply": "应用选项",
      "bsv-price.settings.active.unit": "单位",
      "bsv-price.settings.active.waiting": "（等待激活服务器收到行情列表）",
      "bsv-price.settings.price.label": "当前价格",
      "bsv-price.settings.channel.label": "当前订阅频道",
      "bsv-price.settings.status.label": "当前状态",
      "bsv-price.settings.snapshotAt.label": "快照时间",
      "bsv-price.settings.data.label": "收到的数据",
      "bsv-price.settings.data.desc":
        "本次订阅拿到的全部数据：运行状态、快照与全部行情。",
      "bsv-price.settings.coreState.label": "Channel 运行状态",
      "bsv-price.settings.configured.label": "已配置",
      "bsv-price.settings.configured.true": "是",
      "bsv-price.settings.configured.false": "否",
      "bsv-price.settings.active.key.label": "激活发布器公钥",
      "bsv-price.settings.snapshot.protocol.label": "快照协议",
      "bsv-price.settings.snapshot.sourceAt.label": "源快照时间",
      "bsv-price.settings.lastError.label": "最近解析错误",
      "bsv-price.settings.quotes.label": "收到的行情",
      "bsv-price.settings.quotes.empty": "（等待激活服务器的快照）",
      "bsv-price.settings.quotes.table.market": "交易所",
      "bsv-price.settings.quotes.table.pair": "交易对",
      "bsv-price.settings.quotes.table.price": "价格",
      "bsv-price.settings.restore": "恢复原始设置",
      "bsv-price.settings.restored": "已恢复原始设置",
      "bsv-price.settings.serverAdded": "已添加服务器",
      "bsv-price.settings.serverRemoved": "已删除服务器",
      "bsv-price.settings.activeSaved": "已保存激活选项",
      "bsv-price.settings.subscriptionError": "订阅错误",
      "bsv-price.settings.balanceHint": "请先为 SatSubscription 充值后再重试。",
      "bsv-price.settings.unknownHint": "请勿手动重复扣费，等待系统对账。",
      "bsv-price.settings.error.invalid_type": "输入必须是字符串",
      "bsv-price.settings.error.invalid_empty": "该字段必填",
      "bsv-price.settings.error.invalid_length": "输入过长",
      "bsv-price.settings.error.invalid_hex": "公钥 hex 只能包含 0-9 和 a-f",
      "bsv-price.settings.error.invalid_prefix": "压缩公钥前缀必须是 02 或 03",
      "bsv-price.settings.error.invalid_public_key": "公钥不是有效的 secp256k1 压缩公钥",
      "bsv-price.settings.error.invalid_identifier": "只能使用小写字母、数字、点、短横线和下划线",
      "bsv-price.settings.error.invalid_character": "不允许控制字符",
      "bsv-price.settings.error.server_exists": "该公钥的服务器已存在",
      "bsv-price.settings.error.server_not_found": "服务器不存在",
      "bsv-price.settings.error.default_server_required": "默认 bsv8 服务器不能删除",
      "bsv-price.settings.error.last_server_required": "至少保留一个服务器",
      "bsv-price.settings.error.invalid_bsv_price_config": "设置无效",
      "bsv-price.settings.status.idle": "空闲",
      "bsv-price.settings.status.offline": "已断开",
      "bsv-price.settings.status.notConfigured": "未配置",
      "bsv-price.settings.status.satNotConfigured": "SatSubscription 未配置",
      "bsv-price.settings.status.satConnecting": "正在连接 SatSubscription",
      "bsv-price.settings.status.satBalanceRequired": "SatSubscription 余额不足，请充值",
      "bsv-price.settings.status.satIdentityError": "SatSubscription 身份错误",
      "bsv-price.settings.status.satSubscriptionError": "SatSubscription 订阅失败",
      "bsv-price.settings.status.subscriptionUnknown": "订阅结果未知，等待重试",
      "bsv-price.settings.status.waitingSnapshot": "等待 BSV 价格快照",
      "bsv-price.settings.status.receiving": "正在接收",
      "bsv-price.settings.clearHint":
        "价格只用于和 sats 相乘做参考显示，不作为业务输入。"
    }
  }
};

/**
 * plugin-bsv-price manifest。
 *
 * 关键约束：
 *   - 本插件只消费 Channel runtime；
 *   - 提供能力：`bsv-price.service`（完整设置面）与 `bsv-price.reader`
 *     （跨包只读展示价）；
 *   - 注册路由：`/bsv-price`；
 *   - 首页 widget 只展示当前价格，不维护第二份行情状态；
 *   - 不接触 provider handle / wire 细节。
 */
const bsvPricePluginDefinition = {
  id: BSV_PRICE_PLUGIN_ID,
  name: "BSV Price",
  description:
    "BSV 价格业务插件：消费 Coordinator Channel，订阅 PriceCast 发布服务器频道，展示金额 + 单位形式的参考价格。",
  i18n: bsvPriceResources,
  kind: "business",
  startup: "optional",
  bootstrapStage: "owner-apps-ready",
  defaultEnabled: true,
  canDisable: true,
  displayGroup: "business",
  units: [{
    id: "bsv-price.window",
    runtime: "window-main",
    scopeKind: "owner-session",
    provides: [
      capabilityDescriptor(BSV_PRICE_SERVICE_CAPABILITY),
      capabilityDescriptor(BSV_PRICE_READER_CAPABILITY)
    ],
    storage: CENTRAL_STORAGE_DECLARATIONS.bsvPrice,
    config: {
      // 缺省空对象 → plugin 使用内置生产 PriceCast 默认值。
      pricePublisherPublicKeyHex: ""
    },
    dependencies: defineRuntimeUnitDependencies([
      {
        capability: CHANNEL_RUNTIME_CAPABILITY, sourceRuntime: "window-main",
        reason: "通过 Coordinator Channel runtime 订阅精确价格频道"
      },
      { capability: ROUTE_REGISTRY_CAPABILITY, sourceRuntime: "window-main", reason: "注册行情页与设置详情页" },
      { capability: BREADCRUMB_REGISTRY_CAPABILITY, sourceRuntime: "window-main", reason: "为行情页与设置详情页提供面包屑" },
      { capability: BUSINESS_REGISTRY_CAPABILITY, sourceRuntime: "window-main", reason: "将行情页挂入首页业务域、设置页挂入设置域" },
      { capability: HOME_REGISTRY_CAPABILITY, sourceRuntime: "window-main", reason: "将 BSV 价格显示在首页右侧栏" },
      { capability: RESOURCE_REGISTRY_CAPABILITY, sourceRuntime: "window-main", reason: "注册 BSV Price 状态资源" },
    ]),
  }],
  async setup(ctx) {
    /**
     * 关键约束：
     *   - 不从 keyspace / vault 推断；
     *   - `pricePublisherPublicKeyHex` 只作为首次 seed；缺省使用内置生产
     *     PriceCast 发布器，设置里可以登记更多服务器；
     *   - 运行时真值由 Host 注入的 BSV Price owner/App K-V 承担。
     */
    const cfg = ctx.config ?? {};
    const publisherHex =
      typeof cfg[BSV_PRICE_CONFIG_KEY] === "string" &&
      (cfg[BSV_PRICE_CONFIG_KEY] as string).length > 0
        ? (cfg[BSV_PRICE_CONFIG_KEY] as string)
        : DEFAULT_PRICE_PUBLISHER_PUBLIC_KEY_HEX;

    const channel = ctx.capability(CHANNEL_RUNTIME_CAPABILITY).forPlugin(BSV_PRICE_PLUGIN_ID);
    const service = createBsvPriceService(channel, {
      seedPublisherPublicKeyHex: publisherHex,
      storage: ctx.storageFor("settings")
    });
    await service.ready();
    ctx.provide(BSV_PRICE_SERVICE_CAPABILITY, service);
    // 同一实例以只读能力暴露给首页 / 资产页 / Connect 读取展示价。
    ctx.provide(BSV_PRICE_READER_CAPABILITY, service);
    const resources = ctx.optionalCapability(RESOURCE_REGISTRY_CAPABILITY);
    resources?.register<BsvPriceServiceSnapshot, readonly string[]>({
      id: "bsv-price.snapshot",
      scope: "global",
      key: () => ["bsv-price.snapshot"],
      load: async () => service.snapshot(),
      subscribe: (_args, _context, invalidate) => service.subscribe(invalidate),
      equals: (a, b) => JSON.stringify(a) === JSON.stringify(b),
      invalidation: "immediate"
    });

    const routes = ctx.capability(ROUTE_REGISTRY_CAPABILITY);
    const breadcrumbs = ctx.capability(BREADCRUMB_REGISTRY_CAPABILITY);
    const business = ctx.capability(BUSINESS_REGISTRY_CAPABILITY);
    const home = ctx.capability(HOME_REGISTRY_CAPABILITY);

    routes.register({
      id: "bsv-price.page",
      path: "/bsv-price",
      label: { key: "bsv-price.menu", fallback: "BSV Price" },
      component: BsvPricePage
    });

    routes.register({
      id: "bsv-price.settings",
      path: BSV_PRICE_SETTINGS_PATH,
      label: { key: "bsv-price.settings.title", fallback: "BSV Price settings" },
      component: BsvPriceSettingsPage
    });

    business.registerFeature(BSV_PRICE_PLUGIN_ID, "home", {
      id: "home.bsv-price",
      label: { key: "bsv-price.menu", fallback: "BSV Price" },
      description: { key: "bsv-price.page.title", fallback: "BSV market price" },
      order: 10,
      icon: "LineChart",
      entry: { path: "/bsv-price", routeId: "bsv-price.page" }
    });

    business.registerFeature(BSV_PRICE_PLUGIN_ID, "settings", {
      id: "settings.bsv-price",
      label: { key: "bsv-price.menu", fallback: "BSV Price" },
      description: {
        key: "bsv-price.settings.desc",
        fallback: "Manage price publisher servers and the active quote. The price is display-only and never used for business decisions."
      },
      order: 20,
      icon: "LineChart",
      entry: { path: BSV_PRICE_SETTINGS_PATH, routeId: "bsv-price.settings" }
    });

    home.register({
      id: "bsv-price.snapshot",
      title: { key: "bsv-price.home.title", fallback: "BSV Price" },
      component: BsvPriceHomeWidget,
      order: 40,
      slot: "aside",
      refreshHint: "realtime"
    });

    breadcrumbs.register({
      id: "bsv-price.page",
      order: 10,
      match: (path: string) => path === "/bsv-price",
      resolve: () => [
        { label: { key: "home.menu.label", fallback: "Home" } },
        { label: { key: "bsv-price.breadcrumb", fallback: "BSV Price" } }
      ]
    });
    breadcrumbs.register({
      id: "bsv-price.settings.crumbs",
      order: 10,
      match: (path: string) => path === BSV_PRICE_SETTINGS_PATH,
      resolve: () => [
        { label: { key: "settings.crumb.settings", fallback: "Settings" } },
        { label: { key: "bsv-price.settings.title", fallback: "BSV Price settings" } }
      ]
    });

    return () => {
      service.dispose();
    };
  }
} satisfies PluginManifest & { setup: PluginSetup };

const { setup: bsvPriceSetup, ...bsvPricePlugin } = bsvPricePluginDefinition;

export { bsvPricePlugin, bsvPriceSetup };
