// packages/plugin-msfile/src/sha256.test.ts
// 增量 SHA-256 与 WebCrypto 一次性摘要交叉验证（含跨块边界与长度分档）。

import { describe, expect, it } from "vitest";
import { IncrementalSha256, sha256, sha256Chunks } from "./sha256.js";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("IncrementalSha256", () => {
  it("matches known vectors", () => {
    const empty = new IncrementalSha256().digest();
    expect(hex(empty)).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    const abc = new IncrementalSha256().update(new TextEncoder().encode("abc")).digest();
    expect(hex(abc)).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    // 448-bit 消息（FIPS 示例，两轮压缩）。
    const twoBlocks = new IncrementalSha256().update(new TextEncoder().encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).digest();
    expect(hex(twoBlocks)).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });

  it("matches WebCrypto across chunk boundaries and length classes", async () => {
    // 覆盖 <64、=64、=55/56/119/120 等填充边界与多块长度。
    for (const size of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 262144]) {
      const bytes = new Uint8Array(size).map((_, i) => (i * 31 + size) & 0xff);
      const expected = hex(await sha256(bytes));
      // 单次 update
      expect(hex(new IncrementalSha256().update(bytes).digest())).toBe(expected);
      // 逐 16 字节分片
      const chunks: Uint8Array[] = [];
      for (let i = 0; i < bytes.length; i += 16) chunks.push(bytes.subarray(i, i + 16));
      if (chunks.length === 0) chunks.push(bytes);
      expect(hex(await sha256Chunks(chunks))).toBe(expected);
      // 不规则分片
      const irregular = [bytes.subarray(0, 5), bytes.subarray(5, 70), bytes.subarray(70)];
      expect(hex(await sha256Chunks(irregular.filter((c) => c.length > 0)))).toBe(expected);
    }
  });

  it("rejects reuse after digest", () => {
    const hasher = new IncrementalSha256();
    hasher.update(new Uint8Array(8));
    hasher.digest();
    expect(() => hasher.update(new Uint8Array(1))).toThrow(/finalized/);
    expect(() => hasher.digest()).toThrow(/finalized/);
  });
});
