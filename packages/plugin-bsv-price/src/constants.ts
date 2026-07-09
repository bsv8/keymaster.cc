// packages/plugin-bsv-price/src/constants.ts
// BSV 价格广播业务插件常量（施工单 2026-07-08 001）。
//
// 设计缘由：
//   - 业务协议 id 固定为 "pricecast.bsv_price.v1"；插件只接受该
//     protocolId 的消息，其它一律丢弃；
//   - 频道名是动态拼接：由 `pricePublisherPublicKeyHex` + 后缀
//     `.pricecast.bsvusdt`；不允许写死完整常量化整个频道；
//   - 后缀稳定不变；只在配置层暴露公钥真值。

export const PRICECAST_PROTOCOL_ID = "pricecast.bsv_price.v1";
export const PRICECAST_CHANNEL_SUFFIX = ".pricecast.bsvusdt";

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
 * 本次**不**走运行时 UI 编辑器，**不**走任何自动发现路径。
 */
export const BSV_PRICE_CONFIG_KEY = "pricePublisherPublicKeyHex";
