import { describe, expect, it } from "vitest";
import { MSFILE_BLOCK_SIZE_BYTES, type MsFileReadResult } from "@keymaster/contracts";
import {
  assembleMsFileBytes,
  assembleMsFileParts,
  createMsFileBlockPlan,
  FileAssemblyError,
  parseSeedBlockPlan,
  readMsFileBlocksWithWorkerPool,
  sanitizeMsFileFilename,
  validateMsFileBlockResponse,
} from "./fileAssembly.js";

const HASH_A = "aa".repeat(32);
const HASH_B = "bb".repeat(32);

function uniqueHash(index: number): string {
  return index.toString(16).padStart(64, "0");
}

function response(contentHashHex: string, bytes: Uint8Array): MsFileReadResult {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return { contentHashHex, content: { $type: "binary", bytes: copy } };
}

describe("MSFile home file assembly", () => {
  it("accepts an empty file and an empty Seed", () => {
    const plan = parseSeedBlockPlan(new Uint8Array(), "0");
    expect(plan).toMatchObject({ fileSizeBytes: 0n, blockCount: 0, blocks: [] });
    expect(assembleMsFileBytes(plan, [])).toHaveLength(0);
  });

  it("requires Seed alignment and exact Block count", () => {
    expect(() => parseSeedBlockPlan(new Uint8Array(31), "1")).toThrowError(
      new FileAssemblyError("seed-size-alignment"),
    );
    expect(() => parseSeedBlockPlan(new Uint8Array(32), "0")).toThrowError(
      new FileAssemblyError("seed-block-count"),
    );
    expect(() => createMsFileBlockPlan("262145", [HASH_A])).toThrowError(
      new FileAssemblyError("block-count-mismatch"),
    );
  });

  it("calculates a full final block and a one-byte final block exactly", () => {
    const full = createMsFileBlockPlan("262144", [HASH_A]);
    const split = createMsFileBlockPlan("262145", [HASH_A, HASH_B]);
    expect(full.blocks[0]?.expectedSizeBytes).toBe(262144);
    expect(split.blocks.map((block) => block.expectedSizeBytes)).toEqual([262144, 1]);
  });

  it("preserves duplicate Block Hash positions and byte order", () => {
    const plan = createMsFileBlockPlan(String(MSFILE_BLOCK_SIZE_BYTES + 2), [HASH_A, HASH_A]);
    const first = new Uint8Array(MSFILE_BLOCK_SIZE_BYTES);
    first.fill(1);
    const second = new Uint8Array([5, 6]);
    const expected = new Uint8Array(MSFILE_BLOCK_SIZE_BYTES + 2);
    expected.set(first);
    expected.set(second, first.length);
    const parts = assembleMsFileParts(plan, [first, second]);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toHaveLength(first.length);
    expect(parts[0]?.[0]).toBe(1);
    expect(parts[0]?.[first.length - 1]).toBe(1);
    expect(parts[1]).toEqual(second);

    const assembled = assembleMsFileBytes(plan, [first, second]);
    expect(assembled).toHaveLength(expected.length);
    expect(assembled[0]).toBe(1);
    expect(assembled[first.length - 1]).toBe(1);
    expect(assembled[first.length]).toBe(5);
    expect(assembled[assembled.length - 1]).toBe(6);
  });

  it("fails closed for a wrong response hash or position length", () => {
    const plan = createMsFileBlockPlan("3", [HASH_A]);
    expect(() => validateMsFileBlockResponse(response(HASH_B, new Uint8Array([1, 2, 3])), plan.blocks[0]!)).toThrowError(
      new FileAssemblyError("invalid-block-response"),
    );
    expect(() => validateMsFileBlockResponse(response(HASH_A, new Uint8Array([1, 2])), plan.blocks[0]!)).toThrowError(
      new FileAssemblyError("block-size-mismatch"),
    );
    expect(() => assembleMsFileParts(plan, [undefined])).toThrowError(
      new FileAssemblyError("block-size-mismatch"),
    );
  });

  it("uses a bounded worker pool and reports only verified Blocks", async () => {
    const blockCount = 20;
    const plan = createMsFileBlockPlan(String(blockCount * 262144), Array.from({ length: blockCount }, (_, index) => uniqueHash(index)));
    let active = 0;
    let maxActive = 0;
    let started = 0;
    let verified = 0;
    const block = new Uint8Array(262144);
    const parts = await readMsFileBlocksWithWorkerPool(
      plan,
      async (hash, signal) => {
        started += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 2);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        });
        active -= 1;
        return response(hash, block.slice());
      },
      { maxConcurrency: 100, onVerified: () => { verified += 1; } },
    );
    expect(maxActive).toBeLessThanOrEqual(8);
    expect(started).toBe(blockCount);
    expect(verified).toBe(blockCount);
    expect(parts).toHaveLength(blockCount);
    expect(active).toBe(0);
  });

  it("reads a duplicate Block Hash once and verifies every position", async () => {
    const plan = createMsFileBlockPlan(String(3 * 262144), [HASH_A, HASH_A, HASH_B]);
    const reads: string[] = [];
    let verified = 0;
    const parts = await readMsFileBlocksWithWorkerPool(plan, async (hash) => {
      reads.push(hash);
      return response(hash, new Uint8Array(262144));
    }, { onVerified: () => { verified += 1; } });

    expect(reads).toEqual([HASH_A, HASH_B]);
    expect(verified).toBe(3);
    expect(parts).toHaveLength(3);
  });

  it("cancels remaining workers after the first failure", async () => {
    const blockCount = 16;
    const plan = createMsFileBlockPlan(String(blockCount * 262144), Array.from({ length: blockCount }, (_, index) => uniqueHash(index)));
    let started = 0;
    let aborted = 0;
    await expect(readMsFileBlocksWithWorkerPool(plan, async (hash, signal) => {
      started += 1;
      if (started === 1) {
        // 让其它 7 个 worker 先进入在途读取，再触发失败取消。
        await Promise.resolve();
        throw new Error("failed block");
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 100);
        signal.addEventListener("abort", () => {
          aborted += 1;
          clearTimeout(timer);
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
      return response(hash, new Uint8Array(262144));
    })).rejects.toThrow("failed block");
    expect(started).toBeLessThanOrEqual(8);
    expect(aborted).toBeGreaterThan(0);
  });

  it("sanitizes basename, controls, fallback names, and UTF-8 length", () => {
    const seedHash = "cc".repeat(32);
    expect(sanitizeMsFileFilename("../../private\\report\u0000.txt", seedHash)).toBe("report.txt");
    expect(sanitizeMsFileFilename(".", seedHash)).toBe(seedHash);
    expect(sanitizeMsFileFilename("..", seedHash)).toBe(seedHash);
    expect(sanitizeMsFileFilename("\u0001\u0002", seedHash)).toBe(seedHash);
    const long = sanitizeMsFileFilename("界".repeat(200), seedHash);
    expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(255);
    expect(long).not.toContain("\ufffd");
  });
});
