// raw 十六进制串的长度换算。
//
// 序列化后的 raw 用 hex 承载时，字节数是 hex 长度的一半。费用预算与实际费率
// 复核都按字节计算，所以这里单独给一个函数，避免各处重复 `length / 2` 而在奇数
// 长度（非法 hex）上悄悄得到小数。

import { ProtocolEncodingError } from "./bytes.js";

/** raw tx hex 的字节长度；非法 hex 直接拒绝，不返回近似值。 */
export function rawTxHexByteLength(rawTxHex: string): number {
  if (rawTxHex.length === 0 || rawTxHex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/u.test(rawTxHex)) {
    throw new ProtocolEncodingError("raw-hex", `raw tx hex 长度必须是正偶数且只含十六进制字符，实际 ${rawTxHex.length}`);
  }
  return rawTxHex.length / 2;
}