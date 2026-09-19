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
 * 这里只作为首次 seed，运行时真值存放在 BSV Price owner/App K-V。
 */
export const BSV_PRICE_CONFIG_KEY = "pricePublisherPublicKeyHex";

/** 缺省价格发布服务器编号；该服务器不可删除。 */
export const DEFAULT_PRICE_SERVER_ID = "default";
/** 缺省价格发布服务器显示名。 */
export const DEFAULT_PRICE_SERVER_NAME = "bsv8";
/** 缺省 PriceCast 生产发布器公钥。 */
export const DEFAULT_PRICE_PUBLISHER_PUBLIC_KEY_HEX =
  "03c95123471587fbb4690fe85e748b39bd09d97a7c92ebe539530d454b2b8ef53a";
/** 缺省交易所编号。 */
export const DEFAULT_PRICE_MARKET = "gate";
/** 缺省交易对编号。 */
export const DEFAULT_PRICE_PAIR = "bsvusdt";
