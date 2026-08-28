// Core 单测/本地 E2E 使用的假 Reader。默认模拟“供应商返回已验证内容”，
// 但仍保留调用计数、并发计数和延迟，方便证明 Block 窗口没有偷偷越界。

import { MsFileMediaError } from "../core/errors.js";
import type { MsFileMediaBlockReader } from "../core/types.js";

export interface FakeMsFileReaderOptions {
  seed: Uint8Array;
  blocks: ReadonlyMap<string, Uint8Array>;
  delayMs?: number;
  failBlockHash?: string;
}

export class FakeMsFileReader implements MsFileMediaBlockReader {
  readonly seedReads = 0;
  readonly blockReads = new Map<string, number>();
  activeReads = 0;
  peakActiveReads = 0;
  private seedReadCount = 0;
  private readonly options: FakeMsFileReaderOptions;

  constructor(options: FakeMsFileReaderOptions) {
    this.options = options;
  }

  get seedReadCalls(): number { return this.seedReadCount; }

  private async delay(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new MsFileMediaError("msfile_media_cancelled");
    const delay = this.options.delayMs ?? 0;
    if (delay <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, delay);
      const abort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        reject(new MsFileMediaError("msfile_media_cancelled"));
      };
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  async readSeed(input: { signal: AbortSignal }): Promise<Uint8Array> {
    this.seedReadCount += 1;
    await this.delay(input.signal);
    return this.options.seed.slice();
  }

  async readBlock(input: { blockHashHex: string; signal: AbortSignal }): Promise<Uint8Array> {
    this.blockReads.set(input.blockHashHex, (this.blockReads.get(input.blockHashHex) ?? 0) + 1);
    this.activeReads += 1;
    this.peakActiveReads = Math.max(this.peakActiveReads, this.activeReads);
    try {
      await this.delay(input.signal);
      if (input.blockHashHex === this.options.failBlockHash) throw new MsFileMediaError("msfile_media_network");
      const bytes = this.options.blocks.get(input.blockHashHex);
      if (!bytes) throw new MsFileMediaError("msfile_media_integrity");
      return bytes.slice();
    } finally {
      this.activeReads -= 1;
    }
  }
}
