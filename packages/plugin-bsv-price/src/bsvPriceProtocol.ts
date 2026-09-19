// BSV 价格业务正文适配。
//
// ChannelProtocol Coordinator 已经完成公开消息壳的验签；这里只把 body
// 交给正式 bsv-price SDK 做强类型校验，不重复维护协议常量和价格正则。

import type { JSONValue } from "@keymaster/contracts";
import {
  BSV_PRICE_PROTOCOL,
  parseBody,
  type BSVPriceBody
} from "bsv8-channel-protocol/bsv-price";

/** keymaster 页面使用的不可变价格快照。 */
export interface BsvPriceSnapshot {
  /** 固定的 ChannelProtocol 价格协议标识。 */
  protocol: typeof BSV_PRICE_PROTOCOL;
  /** 行情源生成该完整快照的 Unix 毫秒时间。 */
  snapshotAtMs: number;
  /** 市场编号到交易对价格的映射。 */
  markets: BSVPriceBody["markets"];
}

/** 使用 ChannelProtocol SDK 校验已验签的价格 body。 */
export function decodePriceContent(content: JSONValue): BsvPriceSnapshot | null {
  try {
    const body = parseBody(content);
    return toSnapshot(body);
  } catch {
    return null;
  }
}

/** 保留旧的测试辅助函数名；排序依据现在是 body.snapshot_at_ms。 */
export function decodePriceBody(
  content: JSONValue,
  _receivedAtMs: number,
  options: { expectedProtocolId?: string } = {}
): BsvPriceSnapshot | null {
  if (options.expectedProtocolId && options.expectedProtocolId !== BSV_PRICE_PROTOCOL) return null;
  return decodePriceContent(content);
}

function toSnapshot(body: BSVPriceBody): BsvPriceSnapshot {
  return {
    protocol: body.protocol,
    snapshotAtMs: body.snapshot_at_ms,
    markets: body.markets
  };
}

/** 展示价格固定保留的小数位。 */
export const PRICE_DISPLAY_DECIMALS = 2;
/** 价格不可用时的展示金额。 */
export const PRICE_DISPLAY_ZERO = "0.00";

/**
 * 把协议里的非负十进制价格字符串格式化为固定小数位的展示值。
 *
 * 设计缘由：
 *   - 展示参考值统一 2 位小数，mainnet / testnet / 未就绪形态一致；
 *   - 纯字符串四舍五入，不经过 `Number`，避免大数或浮点误差；
 *   - 非法输入回落到 "0.00"，调用方不需要错误分支。
 */
export function formatPriceAmount(raw: string, decimals = PRICE_DISPLAY_DECIMALS): string {
  if (typeof raw !== "string") return PRICE_DISPLAY_ZERO;
  const value = raw.trim();
  if (!/^[0-9]+(\.[0-9]+)?$/u.test(value)) return PRICE_DISPLAY_ZERO;
  const digits = Math.max(1, Math.trunc(decimals));
  const [rawInt = "0", rawFrac = ""] = value.split(".");
  const intPart = rawInt.replace(/^0+(?=\d)/u, "") || "0";
  const padded = `${rawFrac}${"0".repeat(digits + 1)}`.slice(0, digits + 1);
  let keep = padded.slice(0, digits);
  const roundDigit = padded.charCodeAt(digits) - 48;
  if (roundDigit >= 5) {
    const bumped = (BigInt(keep.length > 0 ? keep : "0") + 1n).toString().padStart(digits, "0");
    if (bumped.length > digits) {
      const carry = bumped.slice(0, bumped.length - digits);
      keep = bumped.slice(bumped.length - digits);
      return `${(BigInt(intPart) + BigInt(carry)).toString()}.${keep}`;
    }
    keep = bumped;
  }
  return `${intPart}.${keep}`;
}

/** 从快照里取指定 市场 / 交易对 的原始价格；缺失时返回 null。 */
export function selectMarketPrice(
  snapshot: BsvPriceSnapshot | null,
  market: string,
  pair: string
): string | null {
  const quotes = snapshot?.markets[market];
  if (!quotes) return null;
  const price = quotes[pair];
  return typeof price === "string" ? price : null;
}
