// PriceCast v1 的 Channel 业务内容校验。

import type { JSONValue } from "@keymaster/contracts";
import { PRICECAST_PROTOCOL_ID } from "./constants.js";

export interface BsvPriceQuote {
  /** 稳定的小写交易所编号。 */
  exchange: string;
  /** 十进制价格字符串。 */
  price: string;
}

export interface BsvPriceSnapshot {
  quotes: readonly BsvPriceQuote[];
  receivedAtMs: number;
}

const decimalStringRE = /^[0-9]+(\.[0-9]+)?$/;

/** 验证已由 ChannelProtocol 验签的 PriceCast JSON 内容。 */
export function decodePriceContent(content: JSONValue): BsvPriceSnapshot | null {
  if (!isObject(content) || content.protocolId !== PRICECAST_PROTOCOL_ID) return null;
  if (!Array.isArray(content.quotes)) return null;
  const quotes: BsvPriceQuote[] = [];
  for (const value of content.quotes) {
    if (!isObject(value)) return null;
    if (typeof value.exchange !== "string" || !value.exchange || typeof value.price !== "string") return null;
    if (!decimalStringRE.test(value.price)) return null;
    quotes.push({ exchange: value.exchange, price: value.price });
  }
  quotes.sort((a, b) => a.exchange.localeCompare(b.exchange));
  return { quotes, receivedAtMs: Date.now() };
}

/** 保留显式时间参数的单元测试辅助函数。 */
export function decodePriceBody(
  content: JSONValue,
  receivedAtMs: number,
  options: { expectedProtocolId?: string } = {}
): BsvPriceSnapshot | null {
  if (options.expectedProtocolId && (!isObject(content) || content.protocolId !== options.expectedProtocolId)) return null;
  const decoded = decodePriceContent(content);
  return decoded ? { ...decoded, receivedAtMs } : null;
}

function isObject(value: JSONValue): value is { [key: string]: JSONValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
