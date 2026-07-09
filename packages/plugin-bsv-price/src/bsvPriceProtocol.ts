// packages/plugin-bsv-price/src/bsvPriceProtocol.ts
// PriceCast v1 body 解码与校验（施工单 §4.2）。
//
// 设计缘由：
//   - body 形状 = `{"quotes": [{exchange, price(decimal string)} ...]}`；
//   - 这是业务层 decode；core 不解析；
//   - 校验失败的 body 让 service 整体忽略（不 throw），原快照保留；
//   - 校验通过的 quotes 列表按 exchange 字典序稳定排序后返回。

import { PRICECAST_PROTOCOL_ID } from "./constants.js";

/**
 * 单条报价（业务层视图）。
 */
export interface BsvPriceQuote {
  /** 稳定小写交易所 id（gate / bitget / htx 等）。 */
  exchange: string;
  /** 十进制字符串价格。 */
  price: string;
}

/** 已校验快照。 */
export interface BsvPriceSnapshot {
  quotes: readonly BsvPriceQuote[];
  receivedAtMs: number;
}

const decimalStringRE = /^[0-9]+(\.[0-9]+)?$/;

/**
 * 把 broadcast body 字节解析成快照。
 *
 * 失败语义：返回 `null`（**不** throw）；业务 service 据此忽略本条
 * 消息并保留上一份合法快照。
 */
export function decodePriceBody(
  bodyBytes: Uint8Array,
  receivedAtMs: number,
  options: { expectedProtocolId: string } = { expectedProtocolId: PRICECAST_PROTOCOL_ID }
): BsvPriceSnapshot | null {
  if (!(bodyBytes instanceof Uint8Array)) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes);
  } catch {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(raw)) return null;
  const quotes = raw.quotes;
  if (!Array.isArray(quotes)) return null;
  const out: BsvPriceQuote[] = [];
  for (const q of quotes) {
    if (!isObject(q)) return null;
    const exchange = q.exchange;
    const price = q.price;
    if (typeof exchange !== "string" || exchange.length === 0) return null;
    if (typeof price !== "string" || !decimalStringRE.test(price)) return null;
    out.push({ exchange, price });
  }
  // 排序保持稳定
  out.sort((a, b) => (a.exchange < b.exchange ? -1 : a.exchange > b.exchange ? 1 : 0));
  void options; // 当前签名仅作未来协议兼容位预留
  return { quotes: out, receivedAtMs };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
