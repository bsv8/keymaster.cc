// packages/plugin-poker/src/pokerCrypto.ts
// Poker 签名工具：基于 vault.createActiveKeyCrypto 受控借用签名 capability。
//
// 设计缘由：
//   - 硬切换文档要求 "plugin-poker 不能把私钥、明文种子、长期签名材料泄
//     露到 proxy"。本模块确保签名只通过受控 capability 完成。
//   - 签名算法：对 nonce / tableId announce 等做 secp256k1 ECDSA；
//     proxy 仅做形式校验，签名算法本身与 bsv-poker 保持一致即可。
//   - 浏览器侧用 @noble/curves/secp256k1，签名结果以 hex 形式交给 proxy。

import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 as nobleSha256 } from "@noble/hashes/sha256";
import type { VaultService } from "@keymaster/contracts";

/**
 * 在受控 active-key capability 内对 digest 做 ECDSA 签名。
 *
 * 设计缘由：bsv-poker 的 challenge / announce / table close payload 都是
 * 二进制（可能含可变长度字段），先 sha256 再 secp256k1.sign 形成
 * "digest signature"；proxy 端 verify 时同样 sha256 再 verify。
 */
export async function signDigestWithVault(
  vault: VaultService,
  publicKeyHex: string,
  digest: Uint8Array
): Promise<string> {
  const crypto = await resolveActiveKeyCrypto(vault, publicKeyHex);
  const sig = await crypto.signDigest({
    publicKeyHex,
    digest: new Uint8Array(digest).buffer
  });
  return toHex(new Uint8Array(sig.signature));
}

async function resolveActiveKeyCrypto(vault: VaultService, publicKeyHex: string) {
  const anyVault = vault as VaultService & {
    createActiveKeyCrypto?: (hex: string) => Promise<{
      signDigest: (input: { publicKeyHex: string; digest: ArrayBuffer }) => Promise<{
        publicKeyHex: string;
        signature: ArrayBuffer;
      }>;
    }>;
  };
  if (typeof anyVault.createActiveKeyCrypto === "function") {
    return await anyVault.createActiveKeyCrypto(publicKeyHex);
  }
  throw new Error("Vault does not provide createActiveKeyCrypto");
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
