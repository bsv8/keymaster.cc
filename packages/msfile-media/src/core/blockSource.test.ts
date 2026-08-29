import { describe, expect, it } from "vitest";
import { MSFILE_BLOCK_SIZE_BYTES } from "@keymaster/contracts";
import { MsFileMediaError } from "./errors.js";
import { MsFileVodSource } from "./blockSource.js";
import { FakeMsFileReader } from "../testing/fakeReader.js";

async function hash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function seedFor(hashes: readonly string[]): Uint8Array {
  const result = new Uint8Array(hashes.length * 32);
  hashes.forEach((value, index) => value.match(/../g)!.forEach((hex, offset) => { result[index * 32 + offset] = Number.parseInt(hex, 16); }));
  return result;
}

describe("MsFileVodSource", () => {
  it("先读 Seed/Block 0，重复 Hash 只发一个 Read，并限制窗口占用", async () => {
    // 这里使用小 Block 不可改变生产 Block 大小；文件大小决定最后块的
    // 精确长度，所以测试内容以一个真实 256 KiB block 作为计划。
    const first = new Uint8Array(MSFILE_BLOCK_SIZE_BYTES);
    first.fill(9);
    const firstHash = await hash(first);
    const second = new Uint8Array(MSFILE_BLOCK_SIZE_BYTES);
    second.fill(7);
    const secondHash = await hash(second);
    const testReader = new FakeMsFileReader({
      seed: seedFor([firstHash, secondHash, firstHash]),
      blocks: new Map([[firstHash, first], [secondHash, second]]),
      delayMs: 1,
    });
    const source = new MsFileVodSource({
      seedHashHex: await hash(seedFor([firstHash, secondHash, firstHash])),
      supplierPublicKeyHex: `02${"11".repeat(32)}`,
      fileSizeBytes: BigInt(MSFILE_BLOCK_SIZE_BYTES * 3),
      declaredMediaType: "audio/mpeg",
      reader: testReader,
    }, { prefetchBlocks: 2, parallelReads: 2 });

    await source.initialize();
    await source.readBlockAt(0);
    await Promise.all([source.readBlockAt(0), source.readBlockAt(1)]);
    expect(testReader.seedReadCalls).toBe(1);
    expect(testReader.blockReads.get(firstHash)).toBe(1);
    expect(source.snapshot().blockWindowOccupancy).toBeLessThanOrEqual(2);
    expect(source.snapshot().activeReadCount).toBe(0);
    await source.dispose();
  });

  it("错误长度或错误 Hash 不会把字节交给下游", async () => {
    const block = new Uint8Array(MSFILE_BLOCK_SIZE_BYTES);
    const expectedHash = await hash(block);
    const seed = seedFor([expectedHash]);
    const reader = new FakeMsFileReader({
      seed,
      blocks: new Map([[expectedHash, new Uint8Array([1])]]),
    });
    const source = new MsFileVodSource({
      seedHashHex: await hash(seed),
      supplierPublicKeyHex: `03${"22".repeat(32)}`,
      fileSizeBytes: BigInt(MSFILE_BLOCK_SIZE_BYTES),
      declaredMediaType: "audio/mpeg",
      reader,
    });
    await expect(source.readBlockAt(0)).rejects.toMatchObject({ code: "msfile_media_integrity" });
    expect(source.snapshot().blockWindowOccupancy).toBe(0);
  });

  it("并发首次读取只读取一次 Seed，并合并同一个 in-flight Block", async () => {
    const block = new Uint8Array(MSFILE_BLOCK_SIZE_BYTES);
    block.fill(8);
    const blockHash = await hash(block);
    const seed = seedFor([blockHash]);
    const reader = new FakeMsFileReader({ seed, blocks: new Map([[blockHash, block]]), delayMs: 3 });
    const source = new MsFileVodSource({
      seedHashHex: await hash(seed),
      supplierPublicKeyHex: `02${"77".repeat(32)}`,
      fileSizeBytes: BigInt(MSFILE_BLOCK_SIZE_BYTES),
      declaredMediaType: "audio/mpeg",
      reader,
    });

    await Promise.all([source.readBlockAt(0), source.readBlockAt(0)]);
    expect(reader.seedReadCalls).toBe(1);
    expect(reader.blockReads.get(blockHash)).toBe(1);
    await source.dispose();
  });

  it("缩小窗口时不启动超出新上限的 Read，直到已有占用释放", async () => {
    const block = new Uint8Array(MSFILE_BLOCK_SIZE_BYTES);
    block.fill(4);
    const blockHash = await hash(block);
    const seed = seedFor([blockHash, blockHash]);
    const reader = new FakeMsFileReader({ seed, blocks: new Map([[blockHash, block]]), delayMs: 4 });
    const source = new MsFileVodSource({
      seedHashHex: await hash(seed),
      supplierPublicKeyHex: `02${"33".repeat(32)}`,
      fileSizeBytes: BigInt(MSFILE_BLOCK_SIZE_BYTES * 2),
      declaredMediaType: "audio/mpeg",
      reader,
    }, { prefetchBlocks: 2 });
    await source.initialize();
    source.setPrefetchBlocks(2);
    await source.readBlockAt(0);
    source.setPrefetchBlocks(2);
    await source.readBlockAt(1);
    expect(source.snapshot().blockWindowOccupancy).toBeLessThanOrEqual(2);
    await source.dispose();
  });

  it("预取并发最多为 2，且不会为整个文件创建任务数组", async () => {
    const blocks = await Promise.all([0, 1, 2].map(async (value) => {
      const bytes = new Uint8Array(MSFILE_BLOCK_SIZE_BYTES);
      bytes.fill(value + 1);
      return { bytes, hash: await hash(bytes) };
    }));
    const seed = seedFor(blocks.map((entry) => entry.hash));
    const reader = new FakeMsFileReader({
      seed,
      blocks: new Map(blocks.map((entry) => [entry.hash, entry.bytes])),
      delayMs: 3,
    });
    const source = new MsFileVodSource({
      seedHashHex: await hash(seed),
      supplierPublicKeyHex: `02${"66".repeat(32)}`,
      fileSizeBytes: BigInt(MSFILE_BLOCK_SIZE_BYTES * blocks.length),
      declaredMediaType: "video/webm",
      reader,
    }, { prefetchBlocks: 3, parallelReads: 2 });

    await source.prefetchWindow(0);
    expect(reader.peakActiveReads).toBeLessThanOrEqual(2);
    expect(source.snapshot().blockWindowOccupancy).toBeLessThanOrEqual(3);
    expect(reader.blockReads.size).toBe(3);
    await source.dispose();
  });

  it("窗口只剩一个槽位时，两个并发 Hash 不会突破缓存上限", async () => {
    const blocks = await Promise.all([1, 2, 3].map(async (value) => {
      const bytes = new Uint8Array(MSFILE_BLOCK_SIZE_BYTES);
      bytes.fill(value);
      return { bytes, hash: await hash(bytes) };
    }));
    const seed = seedFor(blocks.map((entry) => entry.hash));
    const reader = new FakeMsFileReader({
      seed,
      blocks: new Map(blocks.map((entry) => [entry.hash, entry.bytes])),
      delayMs: 5,
    });
    const source = new MsFileVodSource({
      seedHashHex: await hash(seed),
      supplierPublicKeyHex: `02${"88".repeat(32)}`,
      fileSizeBytes: BigInt(MSFILE_BLOCK_SIZE_BYTES * blocks.length),
      declaredMediaType: "video/mp4",
      reader,
    }, { prefetchBlocks: 2, parallelReads: 2 });
    let peakOccupancy = 0;
    source.subscribe(() => { peakOccupancy = Math.max(peakOccupancy, source.snapshot().blockWindowOccupancy); });

    await source.readBlockAt(0);
    await Promise.all([source.readBlockAt(1), source.readBlockAt(2)]);

    expect(peakOccupancy).toBeLessThanOrEqual(2);
    expect(source.snapshot().blockWindowOccupancy).toBeLessThanOrEqual(2);
    await source.dispose();
  });

  it("拒绝无法映射到浏览器 safe integer 的超大文件", () => {
    expect(() => new MsFileVodSource({
      seedHashHex: "aa".repeat(32),
      supplierPublicKeyHex: `02${"44".repeat(32)}`,
      fileSizeBytes: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      declaredMediaType: "audio/mpeg",
      reader: { readSeed: async () => new Uint8Array(), readBlock: async () => new Uint8Array() },
    })).toThrowError(new MsFileMediaError("msfile_media_configuration"));
  });

  it("限制随机 range 的一次性分配，长数据必须走流", async () => {
    const block = new Uint8Array(MSFILE_BLOCK_SIZE_BYTES);
    const blockHash = await hash(block);
    const seed = seedFor([blockHash, blockHash, blockHash, blockHash, blockHash, blockHash, blockHash, blockHash, blockHash]);
    const reader = new FakeMsFileReader({ seed, blocks: new Map([[blockHash, block]]) });
    const source = new MsFileVodSource({
      seedHashHex: await hash(seed),
      supplierPublicKeyHex: `02${"55".repeat(32)}`,
      fileSizeBytes: BigInt(MSFILE_BLOCK_SIZE_BYTES * 9),
      declaredMediaType: "audio/mpeg",
      reader,
    });
    await expect(source.readRange(0, MSFILE_BLOCK_SIZE_BYTES * 8 + 1)).rejects.toMatchObject({
      code: "msfile_media_configuration",
    });
    expect(reader.seedReadCalls).toBe(0);
    await source.dispose();
  });
});
