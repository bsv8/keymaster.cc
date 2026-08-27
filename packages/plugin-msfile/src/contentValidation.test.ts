// packages/plugin-msfile/src/contentValidation.test.ts
// Seed/Block 尺寸与 hash 校验规则（wire 规范 §4.3）。

import { describe, expect, it } from "vitest";
import {
  ContentValidationError,
  expectedSeedLength,
  validateBlockContent,
  validateSeedContent,
} from "./contentValidation.js";
import { sha256 } from "./sha256.js";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("expectedSeedLength", () => {
  it("computes block_count * 32 per the wire spec", () => {
    expect(expectedSeedLength(0n)).toBe(0n);
    expect(expectedSeedLength(1n)).toBe(32n);
    expect(expectedSeedLength(262144n)).toBe(32n);
    expect(expectedSeedLength(262145n)).toBe(64n);
    // MAX_SOURCE_FILE_BYTES = 128 GiB = 524288 块。
    expect(expectedSeedLength(137438953472n)).toBe(524288n * 32n);
  });
});

describe("validateSeedContent", () => {
  const emptySha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

  it("accepts content whose SHA-256 matches", async () => {
    const aligned = new Uint8Array(32);
    await expect(validateSeedContent(aligned, hex(await sha256(aligned)))).resolves.toBeUndefined();
    await expect(validateSeedContent(new Uint8Array(0), emptySha)).resolves.toBeUndefined();
  });

  it("rejects hash mismatch", async () => {
    await expect(validateSeedContent(new Uint8Array(32), "ab".repeat(32))).rejects.toMatchObject({
      code: "hash-mismatch",
    });
  });

  it("enforces 32-byte alignment and the 16 MiB cap", async () => {
    const misaligned = new Uint8Array(33);
    await expect(validateSeedContent(misaligned, hex(await sha256(misaligned)))).rejects.toMatchObject({
      code: "size-alignment",
    });
    const oversized = new Uint8Array(16 * 1024 * 1024 + 1);
    await expect(validateSeedContent(oversized, hex(await sha256(oversized)))).rejects.toMatchObject({
      code: "size-limit",
    });
  });

  it("checks the exact seed length when a trusted file size is known", async () => {
    // file size 262144 → 1 个块 → Seed 长度必须恰为 32 字节。
    const good = new Uint8Array(32);
    await expect(validateSeedContent(good, hex(await sha256(good)), { fileSizeBytes: 262144n })).resolves.toBeUndefined();
    // 64 字节满足对齐但与已知 file size 不符 → 精确长度失败。
    const long = new Uint8Array(64);
    await expect(
      validateSeedContent(long, hex(await sha256(long)), { fileSizeBytes: 262144n })
    ).rejects.toMatchObject({ code: "size-exact" });
  });
});

describe("validateBlockContent", () => {
  it("accepts any length up to 256 KiB with matching hash (no last-block claim)", async () => {
    for (const size of [0, 1, 255, 262144]) {
      const bytes = new Uint8Array(size);
      await expect(validateBlockContent(bytes, hex(await sha256(bytes)))).resolves.toBeUndefined();
    }
  });

  it("rejects blocks above 256 KiB and hash mismatch", async () => {
    const big = new Uint8Array(262145);
    await expect(validateBlockContent(big, hex(await sha256(big)))).rejects.toBeInstanceOf(ContentValidationError);
    await expect(validateBlockContent(new Uint8Array(4), "cd".repeat(32))).rejects.toMatchObject({
      code: "hash-mismatch",
    });
  });
});
