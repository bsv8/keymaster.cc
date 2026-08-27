// packages/plugin-msfile/src/contentValidation.ts
// 内容校验（wire 规范 §4.3）。所有检查通过后才能把内容交给调用方。

import {
  MSFILE_BLOCK_SIZE_BYTES,
  MSFILE_DIGEST_SIZE_BYTES,
  MSFILE_MAX_BLOCK_BYTES,
  MSFILE_MAX_SEED_BYTES,
} from "@keymaster/contracts";
import { sha256 } from "./sha256.js";

export class ContentValidationError extends Error {
  constructor(public readonly code: "hash-mismatch" | "size-limit" | "size-alignment" | "size-exact") {
    super(`content validation failed: ${code}`);
    this.name = "ContentValidationError";
  }
}

export interface SeedValidationOptions {
  /** 可信文件尺寸。提供时必须校验 Seed 精确长度 = block_count * 32。 */
  fileSizeBytes?: bigint;
}

/** Seed 校验：hash 相等、≤16MiB、32 字节整除、已知 file size 时精确长度。 */
export async function validateSeedContent(
  contentBytes: Uint8Array,
  expectedSeedHashHex: string,
  options: SeedValidationOptions = {}
): Promise<void> {
  if (contentBytes.length > MSFILE_MAX_SEED_BYTES) throw new ContentValidationError("size-limit");
  if (contentBytes.length % MSFILE_DIGEST_SIZE_BYTES !== 0) throw new ContentValidationError("size-alignment");
  if (options.fileSizeBytes !== undefined) {
    const expected = expectedSeedLength(options.fileSizeBytes);
    if (BigInt(contentBytes.length) !== expected) throw new ContentValidationError("size-exact");
  }
  await assertHash(contentBytes, expectedSeedHashHex);
}

/** Block 校验：hash 相等、≤256KiB。本 API 不掌握 blockIndex/file size，不声称最后块精确长度。 */
export async function validateBlockContent(
  contentBytes: Uint8Array,
  expectedBlockHashHex: string
): Promise<void> {
  if (contentBytes.length > MSFILE_MAX_BLOCK_BYTES) throw new ContentValidationError("size-limit");
  if (contentBytes.length > MSFILE_BLOCK_SIZE_BYTES) throw new ContentValidationError("size-limit");
  await assertHash(contentBytes, expectedBlockHashHex);
}

async function assertHash(contentBytes: Uint8Array, expectedHashHex: string): Promise<void> {
  const digest = await sha256(contentBytes);
  const actualHex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  if (actualHex !== expectedHashHex) throw new ContentValidationError("hash-mismatch");
}

/** wire 规范 §4.2：block_count = floor((file_size - 1)/262144) + 1；空文件为 0。 */
export function expectedSeedLength(fileSizeBytes: bigint): bigint {
  if (fileSizeBytes < 0n) return 0n;
  if (fileSizeBytes === 0n) return 0n;
  return ((fileSizeBytes - 1n) / BigInt(MSFILE_BLOCK_SIZE_BYTES) + 1n) * BigInt(MSFILE_DIGEST_SIZE_BYTES);
}
