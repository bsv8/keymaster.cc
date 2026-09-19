// packages/contracts/src/price.ts
// BSV 价格展示契约（price.get / price.changed）。
//
// 设计缘由：
//   - 对外只暴露"BSV 当前价格"的展示语义：金额 + 单位；
//   - **不**暴露交易对、行情源、频道或发布者信息，避免把展示数据变成业务数据；
//   - 未就绪（未配置 / 未收到快照 / 订阅出错）时统一返回 amount "0" 与
//     updatedAtMs 0，调用方只做显示，不需要错误分支；
//   - 价格只用于和 sats 相乘做参考显示，不作为任何业务判断的输入。

import { defineCapability } from "webloom-framework";

/** Connect App 的 `price.get` 入参。 */
export interface PriceGetParams {
  /** 已验证 Connect session 编号。 */
  connectSessionId: string;
}

/**
 * 展示用 BSV 价格：金额 + 单位。
 *
 * 设计缘由：单位随 Keymaster 价格设置里选择的交易对变化（如 USDT / CNY）。
 */
export interface PriceValue {
  /** 十进制金额字符串，例如 "45.12"；未就绪时为 "0"。 */
  amount: string;
  /** 计价单位，例如 "USDT"；未就绪时仍给出当前配置推导出的单位。 */
  unit: string;
  /** 行情快照生成的 Unix 毫秒时间；未就绪时为 0。 */
  updatedAtMs: number;
}

/** `price.get` 结果。 */
export type PriceGetResult = PriceValue;

/** `price.subscribe` / `price.unsubscribe` 入参。 */
export interface PriceSubscribeParams {
  /** 已验证 Connect session 编号。 */
  connectSessionId: string;
}

/** `price.subscribe` / `price.unsubscribe` 结果。 */
export interface PriceSubscriptionResult {
  /** 调用完成后该会话是否处于价格推送订阅态。 */
  subscribed: boolean;
}

/** `price.changed` 事件数据；形状与 `price.get` 结果一致。 */
export type PriceChangedEventData = PriceValue;

/**
 * 跨包只读价格展示能力。
 *
 * 设计缘由：
 *   - 首页、资产页、P2PKH 钱包页只需要读取当前展示价，订阅变化；
 *   - 设置编辑（服务器 / 激活项）留在 plugin-bsv-price 自己的
 *     `bsv-price.service` capability，不暴露给其他包；
 *   - 未就绪时 `get()` 也返回 amount "0.00"，消费方不需要错误分支。
 */
export interface BsvPriceReader {
  /** 一次获取当前展示价格。 */
  get(): PriceValue;
  /** 订阅展示价格变化；返回取消订阅函数。 */
  subscribe(handler: (price: PriceValue) => void): () => void;
}

/** 只读价格展示能力 key。 */
export const BSV_PRICE_READER_CAPABILITY = defineCapability<BsvPriceReader>({
  kind: "local",
  id: "bsv-price.reader",
  version: "1"
});
