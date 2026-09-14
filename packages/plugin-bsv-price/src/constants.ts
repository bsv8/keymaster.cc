// packages/plugin-bsv-price/src/constants.ts
// BSV 价格广播业务插件常量。
// 协议和频道规则由独立的 ChannelProtocol SDK 维护，插件只保存发布者配置并订阅。

import {
  BSV_PRICE_CHANNEL_PREFIX,
  BSV_PRICE_PROTOCOL
} from "bsv8-channel-protocol/bsv-price";

export { BSV_PRICE_CHANNEL_PREFIX, BSV_PRICE_PROTOCOL };
/** BSV Price 在「设置 → 应用设置」下的详情页路径。 */
export const BSV_PRICE_SETTINGS_PATH = "/settings/apps/bsv-price";

/**
 * plugin-bsv-price 配置 key 名（用于 manifest 装配）。
 *
 * 持久化路径：装配时由运维人员注入 `pricePublisherPublicKeyHex`；
 * 这里只作为首次 seed，不再是长期运行时真值。
 */
export const BSV_PRICE_CONFIG_KEY = "pricePublisherPublicKeyHex";
