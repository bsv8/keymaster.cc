// packages/plugin-poker/src/pokerCrypto.ts
// Poker 签名工具：基于 vault.withPrivateKey 受控借用明文私钥。
//
// 设计缘由：
//   - 硬切换文档要求 "plugin-poker 不能把私钥、明文种子、长期签名材料泄
//     露到 proxy"。本模块确保签名只在 withPrivateKey 闭包内完成。
//   - 签名算法：对 nonce / tableId announce 等做 secp256k1 ECDSA；
//     proxy 仅做形式校验，签名算法本身与 bsv-poker 保持一致即可。
//   - 浏览器侧用 @noble/curves/secp256k1，签名结果以 hex 形式交给 proxy。

import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 as nobleSha256 } from "@noble/hashes/sha256";
import type { VaultService } from "@keymaster/contracts";

/**
 * 在 withPrivateKey 闭包内对 digest 做 ECDSA 签名。
 *
 * 设计缘由：bsv-poker 的 challenge / announce / table close payload 都是
 * 二进制（可能含可变长度字段），先 sha256 再 secp256k1.sign 形成
 * "digest signature"；proxy 端 verify 时同样 sha256 再 verify。
 *
 * 注意：使用 secp256k1.sign 的低层 API，digest 必须已经是 hash bytes；
 * 调用方负责 sha256。
 */
export async function signDigestWithVault(
  vault: VaultService,
  keyId: string,
  digest: Uint8Array
): Promise<string> {
  return vault.withPrivateKey(keyId, async (material) => {
    if (!material.hex) {
      throw new Error("Empty private key material");
    }
    const sig = secp256k1.sign(digest, material.hex);
    // @noble/curves 返回 ECDSASigRecovered；转 Uint8Array 再 hex。
    const raw = sig instanceof Uint8Array ? sig : Uint8Array.from(sig as unknown as ArrayLike<number>);
    return toHex(raw);
  });
}

/** 把 Uint8Array 编码为 hex 字符串。 */
function toHex(bytes: Uint8Array): string {
  // 使用预计算的 nibble 表避免 noUncheckedIndexedAccess 触发。
  const nibble = (n: number): string => "0123456789abcdef"[n & 0xf] ?? "0";
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const c = (bytes[i] as number) & 0xff;
    out += nibble(c >> 4) + nibble(c);
  }
  return out;
}

/** sha256 helper。 */
export function sha256(input: Uint8Array): Uint8Array {
  return nobleSha256(input);
}
