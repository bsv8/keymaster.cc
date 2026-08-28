// MSFile VOD BlockSource：Seed 不可变，Block Hash 顺序固定，读取窗口有界。
//
// 这层只消费已经绑定好的 reader，不知道金额、身份、Coordinator 或 transport。
// 它是媒体解析器与 MSFile 之间唯一的字节适配层。

import {
  isValidMsFileHashHex,
  isValidMsFileSupplierPublicKeyHex,
  MSFILE_BLOCK_SIZE_BYTES,
  MSFILE_DIGEST_SIZE_BYTES,
  MSFILE_MAX_BLOCK_BYTES,
  MSFILE_MAX_SEED_BYTES,
  MSFILE_MEDIA_PREFETCH_BLOCKS_DEFAULT,
  MSFILE_MEDIA_PREFETCH_BLOCKS_MAX,
  MSFILE_MEDIA_PREFETCH_BLOCKS_MIN,
} from "@keymaster/contracts";
import {
  MsFileMediaError,
  normalizeMediaError,
  throwIfMediaAborted,
} from "./errors.js";
import type {
  MsFileMediaBlockReader,
  MsFileVodSourceInput,
  MsFileVodSourceOptions,
  MsFileVodSourceSnapshot,
} from "./types.js";

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
/** readRange 只服务头部/随机索引；大媒体数据必须使用 readStream。 */
const MAX_READ_RANGE_BYTES = 8 * MSFILE_BLOCK_SIZE_BYTES;
const MAX_READ_RANGE_BLOCKS = 8;

interface BlockEntry {
  hash: string;
  expectedSizeBytes: number;
  bytes?: Uint8Array;
  promise?: Promise<Uint8Array>;
  users: number;
  lastUsed: number;
}

interface CapacityWaiter {
  resolve: () => void;
  reject: (error: MsFileMediaError) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

function isSafeRange(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function createAbortSignalError(): MsFileMediaError {
  return new MsFileMediaError("msfile_media_cancelled");
}

function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(createAbortSignalError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(createAbortSignalError());
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { cleanup(); resolve(value); },
      (error: unknown) => { cleanup(); reject(error); },
    );
  });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new MsFileMediaError("msfile_media_browser_capability");
  const digest = await subtle.digest("SHA-256", bytes.slice());
  let result = "";
  for (const byte of new Uint8Array(digest)) result += byte.toString(16).padStart(2, "0");
  return result;
}

function validatePrefetchBlocks(value: number): number {
  if (!Number.isSafeInteger(value) || value < MSFILE_MEDIA_PREFETCH_BLOCKS_MIN || value > MSFILE_MEDIA_PREFETCH_BLOCKS_MAX) {
    throw new MsFileMediaError("msfile_media_configuration");
  }
  return value;
}

function linkSignal(parent: AbortSignal | undefined, local: AbortController): () => void {
  if (!parent) return () => undefined;
  const abort = () => local.abort();
  if (parent.aborted) local.abort();
  else parent.addEventListener("abort", abort, { once: true });
  return () => parent.removeEventListener("abort", abort);
}

export class MsFileVodSource {
  private readonly input: MsFileVodSourceInput;
  private readonly reader: MsFileMediaBlockReader;
  private readonly parallelReads: number;
  private readonly maxProbeBlocks: number;
  private prefetchBlocks: number;
  private initialized = false;
  private disposed = false;
  private failed: MsFileMediaError | undefined;
  private internalAbort = new AbortController();
  private seedBytes: Uint8Array | undefined;
  private blockHashes: string[] = [];
  private blockSizes: number[] = [];
  private readonly entries = new Map<string, BlockEntry>();
  private readonly waiters = new Set<CapacityWaiter>();
  private clock = 0;
  private activeReadCount = 0;
  private readCount = 0;
  private verifiedBlockCount = 0;
  private readonly listeners = new Set<() => void>();
  private initializing: Promise<void> | undefined;

  constructor(input: MsFileVodSourceInput, options: MsFileVodSourceOptions = {}) {
    if (!isValidMsFileHashHex(input.seedHashHex) || !isValidMsFileSupplierPublicKeyHex(input.supplierPublicKeyHex)) {
      throw new MsFileMediaError("msfile_media_configuration");
    }
    if (typeof input.fileSizeBytes !== "bigint" || input.fileSizeBytes < 0n || input.fileSizeBytes > MAX_SAFE_BIGINT) {
      // 浏览器 byte range API 使用 safe integer；更大的文件必须等待 File
      // System Access / 分段保存能力，不能在此处发生精度截断。
      throw new MsFileMediaError("msfile_media_configuration");
    }
    if (typeof input.declaredMediaType !== "string" || input.declaredMediaType.length > 256) {
      throw new MsFileMediaError("msfile_media_configuration");
    }
    if (!input.reader || typeof input.reader.readSeed !== "function" || typeof input.reader.readBlock !== "function") {
      throw new MsFileMediaError("msfile_media_configuration");
    }
    this.input = input;
    this.reader = input.reader;
    this.prefetchBlocks = validatePrefetchBlocks(options.prefetchBlocks ?? MSFILE_MEDIA_PREFETCH_BLOCKS_DEFAULT);
    this.parallelReads = Number.isSafeInteger(options.parallelReads) && options.parallelReads && options.parallelReads > 0
      ? Math.min(2, options.parallelReads)
      : 2;
    this.maxProbeBlocks = Number.isSafeInteger(options.maxProbeBlocks) && options.maxProbeBlocks && options.maxProbeBlocks > 0
      ? Math.min(8, options.maxProbeBlocks)
      : 8;
  }

  get fileSizeBytes(): bigint { return this.input.fileSizeBytes; }
  get fileSizeNumber(): number { return Number(this.input.fileSizeBytes); }
  get declaredMediaType(): string { return this.input.declaredMediaType; }
  get maxProbeBlocksAllowed(): number { return this.maxProbeBlocks; }
  get maxCacheBytes(): number { return this.prefetchBlocks * MSFILE_BLOCK_SIZE_BYTES; }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): MsFileVodSourceSnapshot {
    return {
      initialized: this.initialized,
      disposed: this.disposed,
      blockWindowOccupancy: this.entries.size,
      blockWindowLimit: this.prefetchBlocks,
      activeReadCount: this.activeReadCount,
      readCount: this.readCount,
      verifiedBlockCount: this.verifiedBlockCount,
      fileSizeBytes: this.input.fileSizeBytes,
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private ensureUsable(): void {
    if (this.disposed) throw new MsFileMediaError("msfile_media_cancelled");
    if (this.failed) throw this.failed;
  }

  private fail(error: unknown): MsFileMediaError {
    const normalized = normalizeMediaError(error, this.internalAbort.signal);
    if (normalized.code !== "msfile_media_cancelled" && !this.failed) {
      this.failed = normalized;
      this.internalAbort.abort();
      this.entries.clear();
      for (const waiter of [...this.waiters]) waiter.reject(normalized);
      this.waiters.clear();
      this.emit();
    }
    return this.failed ?? normalized;
  }

  private rejectIfAborted(signal?: AbortSignal): void {
    this.ensureUsable();
    if (this.internalAbort.signal.aborted) throw this.failed ?? createAbortSignalError();
    throwIfMediaAborted(signal);
  }

  /** 读取 Seed、校验 Seed Hash，并建立每个位置的精确 Block 长度。 */
  private async performInitialize(): Promise<void> {
    try {
      const bytes = await this.reader.readSeed({ signal: this.internalAbort.signal });
      this.rejectIfAborted();
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > MSFILE_MAX_SEED_BYTES || bytes.byteLength % MSFILE_DIGEST_SIZE_BYTES !== 0) {
        throw new MsFileMediaError("msfile_media_integrity");
      }
      if (await sha256Hex(bytes) !== this.input.seedHashHex) throw new MsFileMediaError("msfile_media_integrity");
      const expectedBlocks = this.input.fileSizeBytes === 0n
        ? 0n
        : (this.input.fileSizeBytes - 1n) / BigInt(MSFILE_BLOCK_SIZE_BYTES) + 1n;
      if (BigInt(bytes.byteLength / MSFILE_DIGEST_SIZE_BYTES) !== expectedBlocks) {
        throw new MsFileMediaError("msfile_media_integrity");
      }
      const hashes: string[] = [];
      const sizes: number[] = [];
      for (let index = 0; index < bytes.byteLength; index += MSFILE_DIGEST_SIZE_BYTES) {
        let hash = "";
        for (let offset = 0; offset < MSFILE_DIGEST_SIZE_BYTES; offset += 1) {
          hash += bytes[index + offset]!.toString(16).padStart(2, "0");
        }
        if (!isValidMsFileHashHex(hash)) throw new MsFileMediaError("msfile_media_integrity");
        const start = BigInt(hashes.length) * BigInt(MSFILE_BLOCK_SIZE_BYTES);
        const remaining = this.input.fileSizeBytes - start;
        if (remaining <= 0n) throw new MsFileMediaError("msfile_media_integrity");
        const size = remaining < BigInt(MSFILE_BLOCK_SIZE_BYTES) ? remaining : BigInt(MSFILE_BLOCK_SIZE_BYTES);
        if (size > BigInt(MSFILE_MAX_BLOCK_BYTES)) throw new MsFileMediaError("msfile_media_integrity");
        hashes.push(hash);
        sizes.push(Number(size));
      }
      // 同一个 Hash 若被两个位置引用，位置长度必须一致；否则一个缓存项
      // 无法同时满足两个安全长度，不能静默复用。
      const sizeByHash = new Map<string, number>();
      for (let index = 0; index < hashes.length; index += 1) {
        const hash = hashes[index]!;
        const previous = sizeByHash.get(hash);
        if (previous !== undefined && previous !== sizes[index]) throw new MsFileMediaError("msfile_media_integrity");
        sizeByHash.set(hash, sizes[index]!);
      }
      this.seedBytes = bytes.slice();
      this.blockHashes = hashes;
      this.blockSizes = sizes;
      this.initialized = true;
      this.emit();
    } catch (error) {
      throw this.fail(error);
    }
  }

  async initialize(signal?: AbortSignal): Promise<void> {
    if (this.initialized) {
      this.rejectIfAborted(signal);
      return;
    }
    this.ensureUsable();
    throwIfMediaAborted(signal);
    let initializing = this.initializing;
    if (!initializing) {
      initializing = this.performInitialize();
      this.initializing = initializing;
      void initializing.then(
        () => { if (this.initializing === initializing) this.initializing = undefined; },
        () => { if (this.initializing === initializing) this.initializing = undefined; },
      );
    }
    await awaitWithAbort(initializing, signal);
    this.rejectIfAborted(signal);
  }

  async readSeed(signal?: AbortSignal): Promise<Uint8Array> {
    await this.initialize(signal);
    this.rejectIfAborted(signal);
    return this.seedBytes!.slice();
  }

  blockCount(): number {
    this.ensureUsable();
    if (!this.initialized) throw new MsFileMediaError("msfile_media_configuration");
    return this.blockHashes.length;
  }

  blockHashAt(index: number): string {
    this.ensureUsable();
    if (!this.initialized || !Number.isSafeInteger(index) || index < 0 || index >= this.blockHashes.length) {
      throw new MsFileMediaError("msfile_media_configuration");
    }
    return this.blockHashes[index]!;
  }

  blockSizeAt(index: number): number {
    this.ensureUsable();
    if (!this.initialized || !Number.isSafeInteger(index) || index < 0 || index >= this.blockSizes.length) {
      throw new MsFileMediaError("msfile_media_configuration");
    }
    return this.blockSizes[index]!;
  }

  /** 探测器用的只读缓存查询，不会触发新的 MSFile Read。 */
  isBlockCachedAt(index: number): boolean {
    if (!this.initialized || !Number.isSafeInteger(index) || index < 0 || index >= this.blockHashes.length) return false;
    return this.entries.has(this.blockHashes[index]!);
  }

  private evictIdleEntries(): boolean {
    let candidate: BlockEntry | undefined;
    for (const entry of this.entries.values()) {
      if (entry.users > 0 || entry.promise) continue;
      if (!candidate || entry.lastUsed < candidate.lastUsed) candidate = entry;
    }
    if (!candidate) return false;
    this.entries.delete(candidate.hash);
    this.emit();
    return true;
  }

  private notifyCapacity(): void {
    for (const waiter of [...this.waiters]) {
      this.waiters.delete(waiter);
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve();
    }
  }

  private async waitForCapacity(signal?: AbortSignal): Promise<void> {
    this.rejectIfAborted(signal);
    while (this.entries.size >= this.prefetchBlocks && !this.evictIdleEntries()) {
      await new Promise<void>((resolve, reject) => {
        const waiter: CapacityWaiter = { resolve, reject, signal };
        const onAbort = () => {
          this.waiters.delete(waiter);
          reject(createAbortSignalError());
        };
        waiter.onAbort = onAbort;
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        this.waiters.add(waiter);
      });
      this.rejectIfAborted(signal);
    }
  }

  private async loadEntry(entry: BlockEntry): Promise<Uint8Array> {
    this.activeReadCount += 1;
    this.readCount += 1;
    this.emit();
    try {
      const bytes = await this.reader.readBlock({ blockHashHex: entry.hash, signal: this.internalAbort.signal });
      if (this.internalAbort.signal.aborted) throw this.failed ?? createAbortSignalError();
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== entry.expectedSizeBytes) {
        throw new MsFileMediaError("msfile_media_integrity");
      }
      if (await sha256Hex(bytes) !== entry.hash) throw new MsFileMediaError("msfile_media_integrity");
      entry.bytes = bytes.slice();
      this.verifiedBlockCount += 1;
      return entry.bytes;
    } catch (error) {
      throw this.fail(error);
    } finally {
      this.activeReadCount -= 1;
      this.emit();
    }
  }

  private async acquire(hash: string, expectedSizeBytes: number, signal?: AbortSignal): Promise<BlockEntry> {
    this.rejectIfAborted(signal);
    let entry = this.entries.get(hash);
    if (entry && entry.expectedSizeBytes !== expectedSizeBytes) throw new MsFileMediaError("msfile_media_integrity");
    if (!entry) {
      await this.waitForCapacity(signal);
      this.rejectIfAborted(signal);
      // 另一个并发调用可能刚刚等到同一个窗口槽位并创建了该 Hash；
      // 必须在等待返回后再次查表，否则会把 in-flight 合并错误地变成两个 Read。
      entry = this.entries.get(hash);
      if (entry && entry.expectedSizeBytes !== expectedSizeBytes) {
        throw new MsFileMediaError("msfile_media_integrity");
      }
    }
    if (!entry) {
      entry = { hash, expectedSizeBytes, users: 0, lastUsed: ++this.clock };
      this.entries.set(hash, entry);
      entry.promise = this.loadEntry(entry).finally(() => {
        entry!.promise = undefined;
        this.notifyCapacity();
      });
    }
    entry.users += 1;
    entry.lastUsed = ++this.clock;
    return entry;
  }

  private release(entry: BlockEntry): void {
    entry.users = Math.max(0, entry.users - 1);
    entry.lastUsed = ++this.clock;
    while (this.entries.size > this.prefetchBlocks && this.evictIdleEntries()) {
      // 设置调小时后，释放最后一个使用者即可立即回收到新窗口。
    }
    this.notifyCapacity();
    this.emit();
  }

  /** 先验证指定位置的完整 Block，再返回副本；允许随机读取尾部位置。 */
  async readBlockAt(index: number, signal?: AbortSignal): Promise<Uint8Array> {
    await this.initialize(signal);
    this.rejectIfAborted(signal);
    const hash = this.blockHashAt(index);
    const entry = await this.acquire(hash, this.blockSizeAt(index), signal);
    try {
      const bytes = entry.bytes ?? (entry.promise
        ? await entry.promise
        : (() => { throw new MsFileMediaError("msfile_media_integrity"); })());
      this.rejectIfAborted(signal);
      return bytes.slice();
    } finally {
      this.release(entry);
    }
  }

  /** 首播入口：Seed 后强制先取 Block 0，再以最多 2 路补齐窗口。 */
  async bootstrap(signal?: AbortSignal): Promise<void> {
    await this.initialize(signal);
    if (this.blockCount() === 0) return;
    await this.readBlockAt(0, signal);
    await this.prefetchWindow(0, "forward", signal);
  }

  /** 只启动固定数量 worker，绝不把整个 VOD 映射成 Promise 数组。 */
  async prefetchWindow(centerIndex: number, direction: "forward" | "backward" = "forward", signal?: AbortSignal): Promise<void> {
    await this.initialize(signal);
    if (this.blockCount() === 0) return;
    if (!Number.isSafeInteger(centerIndex) || centerIndex < 0 || centerIndex >= this.blockCount()) {
      throw new MsFileMediaError("msfile_media_configuration");
    }
    const indexes: number[] = [];
    const step = direction === "forward" ? 1 : -1;
    for (let offset = 0; offset < this.prefetchBlocks; offset += 1) {
      const index = centerIndex + step * offset;
      if (index < 0 || index >= this.blockCount()) break;
      indexes.push(index);
    }
    let cursor = 0;
    const worker = async () => {
      while (cursor < indexes.length) {
        const index = indexes[cursor++];
        if (index === undefined) return;
        await this.readBlockAt(index, signal);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.parallelReads, indexes.length) }, () => worker()));
  }

  /** 供 demuxer 使用的 byte range；大范围调用应优先使用 readStream。 */
  async readRange(start: number, end: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (!isSafeRange(start) || !isSafeRange(end) || end < start || end > this.fileSizeNumber) {
      throw new MsFileMediaError("msfile_media_configuration");
    }
    if (end - start > MAX_READ_RANGE_BYTES) {
      throw new MsFileMediaError("msfile_media_configuration");
    }
    if (end === start) {
      await this.initialize(signal);
      return new Uint8Array();
    }
    const firstBlock = Math.floor(start / MSFILE_BLOCK_SIZE_BYTES);
    const lastBlock = Math.floor((end - 1) / MSFILE_BLOCK_SIZE_BYTES);
    if (lastBlock - firstBlock + 1 > MAX_READ_RANGE_BLOCKS) {
      throw new MsFileMediaError("msfile_media_configuration");
    }
    await this.initialize(signal);
    const result = new Uint8Array(end - start);
    let outputOffset = 0;
    let position = start;
    while (position < end) {
      this.rejectIfAborted(signal);
      const index = Math.floor(position / MSFILE_BLOCK_SIZE_BYTES);
      const bytes = await this.readBlockAt(index, signal);
      const from = position % MSFILE_BLOCK_SIZE_BYTES;
      const length = Math.min(bytes.length - from, end - position);
      result.set(bytes.subarray(from, from + length), outputOffset);
      outputOffset += length;
      position += length;
    }
    return result;
  }

  /** 流式 range：每次只把一个已验证 Block 的必要切片交给下游。 */
  readStream(start: number, end: number, signal?: AbortSignal): ReadableStream<Uint8Array> {
    if (!isSafeRange(start) || !isSafeRange(end) || end < start || end > this.fileSizeNumber) {
      throw new MsFileMediaError("msfile_media_configuration");
    }
    let position = start;
    const local = new AbortController();
    const unlink = linkSignal(signal, local);
    let closed = false;
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (closed || position >= end) {
          if (!closed) controller.close();
          closed = true;
          unlink();
          return;
        }
        try {
          const index = Math.floor(position / MSFILE_BLOCK_SIZE_BYTES);
          const bytes = await this.readBlockAt(index, local.signal);
          const from = position % MSFILE_BLOCK_SIZE_BYTES;
          const length = Math.min(bytes.length - from, end - position);
          controller.enqueue(bytes.slice(from, from + length));
          position += length;
        } catch (error) {
          closed = true;
          unlink();
          controller.error(error);
        }
      },
      cancel: () => {
        closed = true;
        local.abort();
        unlink();
      },
    });
  }

  setPrefetchBlocks(value: number): void {
    this.prefetchBlocks = validatePrefetchBlocks(value);
    while (this.entries.size > this.prefetchBlocks && this.evictIdleEntries()) {
      // 尽快满足新窗口；仍在使用/读取的 Block 等待自然释放。
    }
    this.notifyCapacity();
    this.emit();
  }

  abort(): void {
    if (this.disposed) return;
    this.internalAbort.abort();
    for (const waiter of [...this.waiters]) waiter.reject(createAbortSignalError());
    this.waiters.clear();
    this.entries.clear();
    this.emit();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.internalAbort.abort();
    for (const waiter of [...this.waiters]) waiter.reject(createAbortSignalError());
    this.waiters.clear();
    this.entries.clear();
    this.listeners.clear();
  }
}
