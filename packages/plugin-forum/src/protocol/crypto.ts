// 协议侧密码学原语：SHA-256、DER 签名验证。
//
// 签名仍然由 Vault Worker 完成（私钥不离开 Worker）；本模块只负责摘要计算
// 和**验证**，验证在客户端是必需的：indexSig 是服务端对报价的承诺，客户端在
// 广播前必须自己确认它覆盖了将要上链的字段。

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha256";

import { bytesToHex, isCanonicalDer } from "./bytes.js";

/** 单次 SHA-256；业务签名用一次，双 SHA-256 只用于 txid 与 FORKID sighash。 */
export function sha256Digest(data: Uint8Array): Uint8Array {
  return sha256(data);
}

/** 双 SHA-256。 */
export function sha256Twice(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

function toFixedWidth(value: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let rest = value;
  for (let index = length - 1; index >= 0; index -= 1) {
    out[index] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

/**
 * 验证严格 DER low-S 签名。
 *
 * 格式不合规、非 low-S、不在曲线上的公钥、签名不匹配，全部返回 false 而不是
 * 抛异常：调用方把「验签不通过」当作一个正常结论处理。
 */
export function verifyDerSignature(publicKey: Uint8Array, digest: Uint8Array, signature: Uint8Array): boolean {
  if (!isCanonicalDer(signature)) return false;
  if (publicKey.length !== 33 || digest.length !== 32) return false;
  const body = decodeDer(signature);
  if (body === undefined) return false;
  const raw = Uint8Array.from([...toFixedWidth(body.r, 32), ...toFixedWidth(body.s, 32)]);
  try {
    return secp256k1.verify(raw, digest, publicKey, { prehash: false, lowS: true });
  } catch {
    return false;
  }
}

function decodeDer(signature: Uint8Array): { r: bigint; s: bigint } | undefined {
  // 这里重复一份最小解析，因为 bytes.ts 的解析器需要抛错原因，而验证路径只需要
  // 一个布尔结论；两者对同一串字节的接受集合由 interopVectors.test.ts 交叉约束。
  try {
    if (signature[0] !== 0x30 || signature[1] !== signature.length - 2) return undefined;
    let offset = 2;
    const read = (): bigint | undefined => {
      if (signature[offset] !== 0x02) return undefined;
      const length = signature[offset + 1];
      if (length === undefined || length < 1 || length > 33) return undefined;
      let value = 0n;
      for (let index = 0; index < length; index += 1) value = (value << 8n) | BigInt(signature[offset + 2 + index] as number);
      offset += 2 + length;
      return value;
    };
    const r = read();
    const s = read();
    if (r === undefined || s === undefined || offset !== signature.length) return undefined;
    return { r, s };
  } catch {
    return undefined;
  }
}

/** 验证「对 bytes 的单次 SHA-256 摘要」的 DER 签名。 */
export function verifyBytes(publicKey: Uint8Array, bytes: Uint8Array, signature: Uint8Array): boolean {
  return verifyDerSignature(publicKey, sha256Digest(bytes), signature);
}

/** 调试用：稳定呈现签名者身份。 */
export function signerLabel(publicKey: Uint8Array): string {
  return bytesToHex(publicKey).slice(0, 16);
}