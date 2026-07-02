// packages/contracts/src/appmsgBind.ts
// HubMsg bind 握手原文拼接工具。
//
// 设计缘由（施工单 2026-07-01/002 / HubMsg 002 共同冻结）：
//   - HubMsg 与 keymaster 必须共享同一份 bind 原文拼接函数；
//     任何修改必须两仓同步。
//   - 原文 = `sessionId|nonce|publicKeyHex|issuedAtMs`，UTF-8 字节；
//   - ECDSA 实际输入是 SHA-256(原文)——保持 ECDSA 本身的 256-bit
//     digest 约束；与 noble `secp256k1.sign(..., { prehash: false })`
//     和 Go `ecdsa.Sign(SHA256(...))` 同时对齐；
//   - 分隔符 `|`、顺序 `sessionId -> nonce -> publicKeyHex -> issuedAtMs`、
//     `issuedAtMs` 十进制无前导零。
//   - 不做 envelope / 不做 JSON 包装 / 不做二次编码 / 不在 HubMsg 引入
//     第二套 P-256 或 DER。

/**
 * 拼接 bind 原文。
 *
 * @param sessionId 由 HubMsg 服务端 `server_open` 返回的 sessionId。
 * @param nonce 由 HubMsg 服务端 `server_open` 返回的 nonce。
 * @param publicKeyHex 当前 owner 的 SEC1 compressed secp256k1 公钥 hex。
 * @param issuedAtMs 客户端声明的 unix 毫秒时间戳。
 * @returns 用于 ECDSA 签名的 UTF-8 字符串原文。
 *
 * 设计缘由：本函数是 bind 协议真值的"唯一"拼接方式。
 * `plugin-appmsg/src/signing.ts` 与 HubMsg `internal/ws/bind.go`
 * 的 `CanonicalBindText` 必须 bit 级一致。
 */
export function canonicalBindText(
  sessionId: string,
  nonce: string,
  publicKeyHex: string,
  issuedAtMs: number
): string {
  // issuedAtMs 必须是合法正整数；这里只校验类型 + 范围，避免把
  // NaN / Infinity / 负数拼进原文。
  if (!Number.isInteger(issuedAtMs) || issuedAtMs < 0) {
    throw new Error(`canonicalBindText: issuedAtMs must be a non-negative integer, got ${issuedAtMs}`);
  }
  return `${sessionId}|${nonce}|${publicKeyHex}|${issuedAtMs.toString(10)}`;
}