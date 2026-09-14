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
