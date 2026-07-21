// packages/plugin-bsv-price/src/constants.ts
// BSV 价格广播业务插件常量（施工单 2026-07-08 001）。
//
// 设计缘由：
//   - 业务协议 id 固定为 "pricecast.bsv_price.v1"；插件只接受该
//     protocolId 的消息，其它一律丢弃；
//   - 频道名是动态拼接：由 `pricePublisherPublicKeyHex` + 后缀
//     `.pricecast.bsvusdt`；不允许写死完整常量化整个频道；
//   - 后缀稳定不变；只在配置层暴露公钥真值；
//   - `pricePublisherPublicKeyHex` 的长期运行时真值现在由
//     `localStorage["bsv-price.settings"]` 承担；`manifest.config` 只作首次 seed。

export const PRICECAST_PROTOCOL_ID = "pricecast.bsv_price.v1";
export const PRICECAST_CHANNEL_SUFFIX = ".pricecast.bsvusdt";
/** BSV Price 在「设置 → 应用设置」下的详情页路径。 */
export const BSV_PRICE_SETTINGS_PATH = "/settings/apps/bsv-price";

/** 由 publisher 公钥 hex 拼出订阅频道名。 */
export function buildPriceChannelId(publisherPublicKeyHex: string): string {
  if (
    typeof publisherPublicKeyHex !== "string" ||
    publisherPublicKeyHex.length === 0
  ) {
    throw new Error("buildPriceChannelId: publisherPublicKeyHex must be non-empty");
  }
  return publisherPublicKeyHex + PRICECAST_CHANNEL_SUFFIX;
}

/**
 * plugin-bsv-price 配置 key 名（用于 manifest 装配）。
 *
 * 持久化路径：装配时由运维人员注入 `pricePublisherPublicKeyHex`；
 * 这里只作为首次 seed，不再是长期运行时真值。
 */
export const BSV_PRICE_CONFIG_KEY = "pricePublisherPublicKeyHex";
