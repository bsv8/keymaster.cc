// MasterSeed `keymaster-seed-v1` 摘要：消息证据文件名的内容身份。
//
// 源文件按 256 KiB 分块，每块 SHA-256 的原始 32 字节摘要按顺序拼接成
// seed_bytes，再对 seed_bytes 取 SHA-256 得到 seed_hash。消息通常远小于
// 一个块，但实现保持通用：文件更大时按同一规则分块。

import { sha256 } from "@noble/hashes/sha2.js";

/** MasterSeed V1 固定块大小（256 KiB，不是 256000 字节）。 */
export const MASTER_SEED_BLOCK_SIZE = 262144;

function bytesToHex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

/** 计算文件内容的 MasterSeed seed_hash，返回 64 位小写 hex。 */
export function masterSeedHashHex(bytes: Uint8Array): string {
  const digests: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += MASTER_SEED_BLOCK_SIZE) {
    digests.push(sha256(bytes.subarray(offset, Math.min(offset + MASTER_SEED_BLOCK_SIZE, bytes.byteLength))));
  }
  const seedBytes = new Uint8Array(digests.length * 32);
  for (let index = 0; index < digests.length; index += 1) seedBytes.set(digests[index]!, index * 32);
  return bytesToHex(sha256(seedBytes));
}
