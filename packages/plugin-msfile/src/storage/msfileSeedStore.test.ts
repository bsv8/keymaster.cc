// MSFile 桶内种子存储的核心语义：MasterSeed 官方 SDK 计算、KeymasterFormats
// 路径布局、元数据严格解析、列表 join、读回校验与删除顺序。
//
// 向量取自 MasterSeed 官方黄金向量（keymaster-seed-v1）：
//   - UTF-8 "abc"；
//   - 空文件。

import { describe, expect, it } from "vitest";
import {
  MSFILE_SEED_META_FORMAT,
  MsFileSeedStoreError,
  deleteMsFileSeed,
  listMsFileSeeds,
  normalizeMsFileSeedMediaType,
  parseMsFileSeedMeta,
  readMsFileSeed,
  sanitizeMsFileSeedFileName,
  serializeMsFileSeedMeta,
  storeMsFileSeed,
  verifyMsFileSeed,
  type MsFileSeedMeta,
  type MsFileSeedSource,
} from "./msfileSeedStore.js";
import { createInMemoryOwnerFileStore } from "./inMemoryOwnerFileStore.testutil.js";

/** `abc` 的 seed_hash（MasterSeed 官方向量）。 */
const ABC_SEED_HASH = "4f8b42c22dd3729b519ba6f68d2da7cc5b2d606d05daed5ad5128cc03e6c6358";
/** `abc` 的块摘要。 */
const ABC_BLOCK_HASH = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
/** 空文件的 seed_hash。 */
const EMPTY_SEED_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const ABC_BYTES = new TextEncoder().encode("abc");
const BLOCK_SIZE = 262144;

function createMemorySource(bytes: Uint8Array, options: { name?: string; mediaType?: string } = {}): MsFileSeedSource {
  return {
    name: options.name ?? "sample.bin",
    mediaType: options.mediaType ?? "application/octet-stream",
    size: BigInt(bytes.byteLength),
    async *stream({ signal } = {}) {
      const chunkBytes = 1024 * 1024;
      for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
        if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
        yield bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.byteLength));
      }
    },
    async read(offset, length, { signal } = {}) {
      if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
      const start = Number(offset);
      if (start < 0 || start + length > bytes.byteLength) throw new Error("read outside source");
      return bytes.slice(start, start + length);
    },
  };
}

function toHex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

function sampleMeta(overrides: Partial<MsFileSeedMeta> = {}): MsFileSeedMeta {
  return {
    seedHashHex: ABC_SEED_HASH,
    fileName: "abc.txt",
    mediaType: "text/plain",
    fileSizeBytes: "3",
    blockCount: 1,
    seedSizeBytes: "32",
    storedAt: "2026-09-19T08:00:00.000Z",
    ...overrides,
  };
}

describe("MSFile seed metadata", () => {
  it("round-trips a canonical meta file", () => {
    const bytes = serializeMsFileSeedMeta(sampleMeta());
    expect(parseMsFileSeedMeta(bytes, ABC_SEED_HASH)).toEqual(sampleMeta());
  });

  it("rejects unknown fields, wrong identity and inconsistent sizes", () => {
    const base = sampleMeta();
    const withUnknown = { ...base, extra: true };
    expect(() => parseMsFileSeedMeta(new TextEncoder().encode(JSON.stringify(withUnknown)), ABC_SEED_HASH)).toThrow(MsFileSeedStoreError);
    expect(() => parseMsFileSeedMeta(serializeMsFileSeedMeta(base), EMPTY_SEED_HASH)).toThrow(MsFileSeedStoreError);
    expect(() => parseMsFileSeedMeta(serializeMsFileSeedMeta({ ...base, blockCount: 2, seedSizeBytes: "64" }), ABC_SEED_HASH)).toThrow(MsFileSeedStoreError);
    expect(() => parseMsFileSeedMeta(serializeMsFileSeedMeta({ ...base, fileName: "../escape" }), ABC_SEED_HASH)).toThrow(MsFileSeedStoreError);
    expect(() => parseMsFileSeedMeta(serializeMsFileSeedMeta({ ...base, mediaType: "Text/Plain" }), ABC_SEED_HASH)).toThrow(MsFileSeedStoreError);
    expect(() => parseMsFileSeedMeta(serializeMsFileSeedMeta({ ...base, storedAt: "2026-09-19 08:00:00" }), ABC_SEED_HASH)).toThrow(MsFileSeedStoreError);
  });

  it("sanitizes browser provided names and media types", () => {
    expect(sanitizeMsFileSeedFileName("C:\\Users\\a\\photo.JPG", ABC_SEED_HASH)).toBe("photo.JPG");
    expect(sanitizeMsFileSeedFileName("..", ABC_SEED_HASH)).toBe(ABC_SEED_HASH);
    expect(normalizeMsFileSeedMediaType("IMAGE/PNG; charset=binary")).toBe("image/png");
    expect(normalizeMsFileSeedMediaType("nonsense")).toBe("application/octet-stream");
  });
});

describe("MSFile bucket seed storage", () => {
  it("stores abc with official vectors and the documented layout", async () => {
    const store = createInMemoryOwnerFileStore();
    const result = await storeMsFileSeed({ store, source: createMemorySource(ABC_BYTES, { name: "abc.txt", mediaType: "text/plain" }) });
    expect(result.entry.seedHashHex).toBe(ABC_SEED_HASH);
    expect(result.meta).toMatchObject({
      seedHashHex: ABC_SEED_HASH,
      fileName: "abc.txt",
      mediaType: "text/plain",
      fileSizeBytes: "3",
      blockCount: 1,
      seedSizeBytes: "32",
    });
    expect([...store.objects.keys()].sort()).toEqual([
      `meta/${ABC_SEED_HASH}.json`,
      `seeds/${ABC_SEED_HASH}.ms`,
      `storage/${ABC_SEED_HASH}/${ABC_BLOCK_HASH}`,
    ]);
    // 种子文件必须是 32 字节原始摘要，不是 64 字符 hex 文本。
    const seedBytes = store.objects.get(`seeds/${ABC_SEED_HASH}.ms`)!;
    expect(seedBytes.byteLength).toBe(32);
    expect(toHex(seedBytes)).toBe(ABC_BLOCK_HASH);
    // 块内容就是源字节。
    expect(toHex(store.objects.get(`storage/${ABC_SEED_HASH}/${ABC_BLOCK_HASH}`)!)).toBe("616263");
  });

  it("lists, reads and verifies a stored entry", async () => {
    const store = createInMemoryOwnerFileStore();
    await storeMsFileSeed({ store, source: createMemorySource(ABC_BYTES, { name: "abc.txt", mediaType: "text/plain" }) });
    const entries = await listMsFileSeeds({ store });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.seedHashHex).toBe(ABC_SEED_HASH);
    expect(entries[0]!.meta?.fileName).toBe("abc.txt");

    const read = await readMsFileSeed({ store, seedHashHex: ABC_SEED_HASH });
    expect(read.meta.fileSizeBytes).toBe("3");
    expect(read.parts).toHaveLength(1);
    expect(new TextDecoder().decode(read.parts[0]!)).toBe("abc");

    const verified = await verifyMsFileSeed({ store, seedHashHex: ABC_SEED_HASH });
    expect(verified).toEqual({ metaAvailable: true, blockCount: "1", verifiedBlocks: 1 });
  });

  it("keeps empty files legal", async () => {
    const store = createInMemoryOwnerFileStore();
    const result = await storeMsFileSeed({ store, source: createMemorySource(new Uint8Array(), { name: "", mediaType: "" }) });
    expect(result.entry.seedHashHex).toBe(EMPTY_SEED_HASH);
    expect(result.meta).toMatchObject({ fileName: EMPTY_SEED_HASH, mediaType: "application/octet-stream", fileSizeBytes: "0", blockCount: 0, seedSizeBytes: "0" });
    const read = await readMsFileSeed({ store, seedHashHex: EMPTY_SEED_HASH });
    expect(read.parts).toEqual([]);
  });

  it("deduplicates repeated blocks and preserves their positions", async () => {
    const store = createInMemoryOwnerFileStore();
    const bytes = new Uint8Array(BLOCK_SIZE * 2 + 100);
    bytes.fill(0x61, BLOCK_SIZE * 2);
    const result = await storeMsFileSeed({ store, source: createMemorySource(bytes, { name: "repeat.bin" }) });
    const blockPaths = [...store.objects.keys()].filter((path) => path.startsWith(`storage/${result.entry.seedHashHex}/`));
    // 两个相同的 256 KiB 块只存一个对象。
    expect(blockPaths).toHaveLength(2);
    const read = await readMsFileSeed({ store, seedHashHex: result.entry.seedHashHex });
    expect(read.parts.map((part) => part.byteLength)).toEqual([BLOCK_SIZE, BLOCK_SIZE, 100]);
    expect(read.parts[0]!).toEqual(read.parts[1]!);
    expect(new Uint8Array(read.parts[2]!).every((byte) => byte === 0x61)).toBe(true);
  });

  it("drops damaged metadata from the list and rejects damaged blocks on read", async () => {
    const store = createInMemoryOwnerFileStore();
    await storeMsFileSeed({ store, source: createMemorySource(ABC_BYTES, { name: "abc.txt", mediaType: "text/plain" }) });
    store.objects.set(`meta/${ABC_SEED_HASH}.json`, new TextEncoder().encode("{not json"));
    const entries = await listMsFileSeeds({ store });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.meta).toBeNull();

    store.objects.set(`meta/${ABC_SEED_HASH}.json`, serializeMsFileSeedMeta(sampleMeta()));
    store.objects.set(`storage/${ABC_SEED_HASH}/${ABC_BLOCK_HASH}`, new TextEncoder().encode("abd"));
    await expect(readMsFileSeed({ store, seedHashHex: ABC_SEED_HASH })).rejects.toMatchObject({ code: "integrity" });
  });

  it("fails closed when a block is missing and reports the stable code", async () => {
    const store = createInMemoryOwnerFileStore();
    await storeMsFileSeed({ store, source: createMemorySource(ABC_BYTES, { name: "abc.txt", mediaType: "text/plain" }) });
    store.objects.delete(`storage/${ABC_SEED_HASH}/${ABC_BLOCK_HASH}`);
    await expect(readMsFileSeed({ store, seedHashHex: ABC_SEED_HASH })).rejects.toMatchObject({ code: "missing-block" });
  });

  it("deletes seed, metadata and blocks in order", async () => {
    const store = createInMemoryOwnerFileStore();
    await storeMsFileSeed({ store, source: createMemorySource(ABC_BYTES, { name: "abc.txt", mediaType: "text/plain" }) });
    await deleteMsFileSeed({ store, seedHashHex: ABC_SEED_HASH });
    expect(store.objects.size).toBe(0);
  });

  it("aborts on an already-aborted signal and on a changed source", async () => {
    const store = createInMemoryOwnerFileStore();
    const controller = new AbortController();
    controller.abort();
    await expect(storeMsFileSeed({ store, source: createMemorySource(ABC_BYTES), signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });

    const mutable = new Uint8Array(ABC_BYTES);
    const changingSource: MsFileSeedSource = {
      ...createMemorySource(mutable),
      async read(offset, length) {
        return new Uint8Array(length).fill(0x62);
      },
    };
    await expect(storeMsFileSeed({ store, source: changingSource })).rejects.toMatchObject({ code: "integrity" });
  });
});
