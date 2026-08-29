import { describe, expect, it } from "vitest";
import { MSFILE_BLOCK_SIZE_BYTES } from "@keymaster/contracts";
import { MsFileRangeSource } from "./rangeSource.js";

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function seedFor(hashes: readonly string[]): Uint8Array {
  const seed = new Uint8Array(hashes.length * 32);
  hashes.forEach((hash, hashIndex) => {
    for (let index = 0; index < 32; index += 1) {
      seed[hashIndex * 32 + index] = Number.parseInt(hash.slice(index * 2, index * 2 + 2), 16);
    }
  });
  return seed;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

async function fixture(options: { delayMs?: number; invalidBlock?: boolean; maxConcurrentReads?: number } = {}) {
  const first = new Uint8Array(MSFILE_BLOCK_SIZE_BYTES);
  first.fill(0x11);
  // 测试正文使用 MP3 声明 MIME；容器和 Codec 由浏览器原生解析。
  first[0] = 0xff;
  first[1] = 0xfb;
  const second = new Uint8Array(MSFILE_BLOCK_SIZE_BYTES);
  second.fill(0x22);
  const firstHash = await sha256(first);
  const secondHash = await sha256(second);
  const seed = seedFor([firstHash, secondHash]);
  const seedHash = await sha256(seed);
  const blockReads = new Map<string, number>();
  let activeReads = 0;
  let peakReads = 0;
  let abortedReads = 0;
  const reader = {
    readSeed: async () => seed.slice(),
    readBlock: async ({ blockHashHex, signal }: { blockHashHex: string; signal: AbortSignal }) => {
      blockReads.set(blockHashHex, (blockReads.get(blockHashHex) ?? 0) + 1);
      activeReads += 1;
      peakReads = Math.max(peakReads, activeReads);
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, options.delayMs ?? 0);
          const abort = () => {
            clearTimeout(timer);
            abortedReads += 1;
            reject(new Error("aborted"));
          };
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
        if (blockHashHex === firstHash) return first.slice();
        if (blockHashHex === secondHash) return options.invalidBlock ? new Uint8Array(3) : second.slice();
        throw new Error("unknown block");
      } finally {
        activeReads -= 1;
      }
    },
  };
  const source = new MsFileRangeSource({
    seedHashHex: seedHash,
    supplierPublicKeyHex: `02${"11".repeat(32)}`,
    fileSizeBytes: BigInt(MSFILE_BLOCK_SIZE_BYTES * 2),
    declaredMediaType: "audio/mpeg",
    reader,
  }, { maxConcurrentReads: options.maxConcurrentReads });
  return { source, reader, first, second, firstHash, secondHash, blockReads, get peakReads() { return peakReads; }, get abortedReads() { return abortedReads; } };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    parts.push(next.value);
  }
  return concat(parts);
}

describe("MsFileRangeSource", () => {
  it("按 Block 切片输出，响应长度与实际正文一致", async () => {
    const { source, first, second, blockReads, firstHash, secondHash } = await fixture();
    const response = await source.describeResponse("GET", `bytes=${String(MSFILE_BLOCK_SIZE_BYTES - 2)}-${String(MSFILE_BLOCK_SIZE_BYTES + 2)}`);
    expect(response).toMatchObject({
      status: 206,
      startByte: MSFILE_BLOCK_SIZE_BYTES - 2,
      endByteExclusive: MSFILE_BLOCK_SIZE_BYTES + 3,
      contentLength: 5,
      mediaType: "audio/mpeg",
    });
    const output = await readAll(source.readStream(response.startByte, response.endByteExclusive));
    expect(output).toEqual(concat([first.slice(-2), second.slice(0, 3)]));
    expect(output.byteLength).toBe(response.contentLength);
    expect(source.snapshot().inFlightBlockCount).toBe(0);
    expect(blockReads.get(firstHash)).toBe(1); // MIME 只做白名单收敛，正文 Block 只读一次
    expect(blockReads.get(secondHash)).toBe(1);
    await source.dispose();
  });

  it("重叠 Range 共享 in-flight Block，但完成后不保留历史缓存", async () => {
    const fixtureData = await fixture({ delayMs: 10 });
    const { source, firstHash, blockReads } = fixtureData;
    const firstStart = source.readStream(0, 32).getReader();
    const secondStart = source.readStream(16, 48).getReader();
    const [firstChunk, secondChunk] = await Promise.all([firstStart.read(), secondStart.read()]);
    expect(firstChunk.done).toBe(false);
    expect(secondChunk.done).toBe(false);
    expect(blockReads.get(firstHash)).toBe(1);
    expect(fixtureData.peakReads).toBeLessThanOrEqual(2);
    await firstStart.cancel();
    await secondStart.cancel();
    expect(source.snapshot().inFlightBlockCount).toBe(0);

    const again = source.readStream(0, 1).getReader();
    await again.read();
    expect(blockReads.get(firstHash)).toBe(2);
    await again.cancel();
    await source.dispose();
  });

  it("使用创建时的媒体并发设置，并始终限制实际 supplier Read", async () => {
    const fixtureData = await fixture({ delayMs: 20, maxConcurrentReads: 1 });
    const first = readAll(fixtureData.source.readStream(0, 1));
    const second = readAll(fixtureData.source.readStream(MSFILE_BLOCK_SIZE_BYTES, MSFILE_BLOCK_SIZE_BYTES + 1));
    await Promise.all([first, second]);
    expect(fixtureData.source.snapshot()).toMatchObject({ maxConcurrentReads: 1 });
    expect(fixtureData.peakReads).toBeLessThanOrEqual(1);
    await fixtureData.source.dispose();
  });

  it("Range 非法时不读取 supplier，Block 长度错误时不输出字节", async () => {
    const fixtureData = await fixture({ invalidBlock: true });
    const invalid = await fixtureData.source.describeResponse("GET", "bytes=999999999-");
    expect(invalid.status).toBe(416);
    expect(fixtureData.reader).toBeTruthy();
    expect(fixtureData.source.snapshot().supplierReadCount).toBe(0);

    const stream = fixtureData.source.readStream(MSFILE_BLOCK_SIZE_BYTES, MSFILE_BLOCK_SIZE_BYTES + 1);
    await expect(stream.getReader().read()).rejects.toMatchObject({ code: "msfile_media_integrity" });
    await fixtureData.source.dispose();
  });

  it("未知 MIME 直接失败，且不会读取 Block 0", async () => {
    const fixtureData = await fixture();
    const source = new MsFileRangeSource({
      seedHashHex: await sha256(seedFor([fixtureData.firstHash, fixtureData.secondHash])),
      supplierPublicKeyHex: `02${"11".repeat(32)}`,
      fileSizeBytes: BigInt(MSFILE_BLOCK_SIZE_BYTES * 2),
      declaredMediaType: "application/octet-stream",
      reader: fixtureData.reader,
    });
    await expect(source.describeResponse("GET", "bytes=0-3")).rejects.toMatchObject({ code: "msfile_media_unsupported_container" });
    expect(source.snapshot().supplierReadCount).toBe(0);
    await source.dispose();
  });

  it("dispose 会 Abort 正在进行的 supplier Read，并清理 in-flight Block", async () => {
    const fixtureData = await fixture({ delayMs: 10_000 });
    const pending = fixtureData.source.readStream(0, 1).getReader().read();
    for (let attempt = 0; attempt < 100 && fixtureData.source.snapshot().activeReadCount === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await fixtureData.source.dispose();
    await expect(pending).resolves.toMatchObject({ done: true });
    expect(fixtureData.abortedReads).toBeGreaterThan(0);
    expect(fixtureData.source.snapshot().inFlightBlockCount).toBe(0);
  });
});
