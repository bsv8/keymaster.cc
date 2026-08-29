// MSFile 原生 Range 数据源。
//
// 这个实现故意不保留已完成 Block：每个 HTTP 请求只在需要时读取完整 Block，
// 校验后把当前切片交给 ReadableStream，消费者释放后该 Block 就从内存中消失。
// 仅有两类状态可以跨请求保留：已经校验的 Seed/Block 计划，以及当前 in-flight
// Promise。这样浏览器回跳时可以重新读取并重新付费，但两个重叠 Range 不会重复
// 读取同一个正在执行的 Block。

import {
  isValidMsFileHashHex,
  isValidMsFileSupplierPublicKeyHex,
  MSFILE_BLOCK_SIZE_BYTES,
  MSFILE_DIGEST_SIZE_BYTES,
  MSFILE_MEDIA_BLOCK_READ_CONCURRENCY_DEFAULT,
  MSFILE_MEDIA_BLOCK_READ_CONCURRENCY_MAX,
  MSFILE_MAX_BLOCK_BYTES,
  MSFILE_MAX_SEED_BYTES,
} from "@keymaster/contracts";
import {
  MsFileMediaError,
  normalizeMediaError,
  throwIfMediaAborted,
} from "../core/errors.js";
import type {
  MsFileMediaBlockReader,
  MsFileMediaDebugValue,
  MsFileVodSourceInput,
} from "../core/types.js";
import {
  describeByteRange,
  type MsFileRangeInvalidReason,
  type MsFileRangeResponseDescription,
} from "./rangeParser.js";

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
/** 保留给未来索引辅助读取的上限；当前原生播放路径不调用该接口。 */
const MAX_AUXILIARY_RANGE_BYTES = 8 * MSFILE_BLOCK_SIZE_BYTES;
const DEFAULT_MAX_CONCURRENT_READS = MSFILE_MEDIA_BLOCK_READ_CONCURRENCY_DEFAULT;

export type MsFileNativeMediaContainer =
  | "mp3"
  | "wave"
  | "mp4"
  | "webm"
  | "matroska"
  | "ogg"
  | "flac";

export interface MsFileRangeSourceSnapshot {
  initialized: boolean;
  disposed: boolean;
  /** 当前 HTTP 请求数量，不是历史请求数量。 */
  activeRequestCount: number;
  /** 当前仍有消费者的 in-flight Block 数量，不是已完成缓存数量。 */
  inFlightBlockCount: number;
  /** 当前实际进入 supplier reader 的并发数。 */
  activeReadCount: number;
  /** 当前媒体 Session 固定采用的 Block Read 并发上限。 */
  maxConcurrentReads: number;
  /** 从 supplier 发起过的 Block Read 总数；只用于当前 session 诊断。 */
  supplierReadCount: number;
  /** 已完成完整性校验的 Block 次数；只保留计数，不保留 Block 字节。 */
  verifiedBlockCount: number;
  /** 已确认的白名单媒体类型；缺失表示还没有完成 MIME 收敛。 */
  mediaType?: string;
  /** 白名单 MIME 对应的原生容器。 */
  container?: MsFileNativeMediaContainer;
  error?: { code: string; message: string };
}

export interface MsFileRangeSourceOptions {
  /** 运输层并发上限；由创建媒体 Session 时的设置固定。 */
  maxConcurrentReads?: number;
  /** 默认开启的安全诊断回调；回调参数不得包含 Hash、媒体字节或凭据。 */
  onDebug?(action: string, details: Record<string, MsFileMediaDebugValue>): void;
}

export interface MsFileRangeResponse extends MsFileRangeResponseDescription {
  /** 经白名单收敛后的 MIME。416 没有该字段。 */
  mediaType?: string;
}

interface BlockFlight {
  hash: string;
  expectedSizeBytes: number;
  controller: AbortController;
  promise: Promise<Uint8Array>;
  users: number;
  settled: boolean;
}

interface PermitWaiter {
  operation: () => Promise<Uint8Array>;
  resolve: (value: Uint8Array) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal;
  onAbort: () => void;
}

function isSafeRange(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function normalizeDeclaredMediaType(input: string): string {
  return input.split(";", 1)[0]!.trim().toLowerCase();
}

interface NativeMediaTypeDescription {
  mediaType: string;
  container: MsFileNativeMediaContainer;
}

const NATIVE_MEDIA_TYPES: ReadonlyMap<string, NativeMediaTypeDescription> = new Map([
  ["audio/mpeg", { mediaType: "audio/mpeg", container: "mp3" }],
  ["audio/wav", { mediaType: "audio/wav", container: "wave" }],
  ["audio/x-wav", { mediaType: "audio/wav", container: "wave" }],
  ["audio/mp4", { mediaType: "audio/mp4", container: "mp4" }],
  ["video/mp4", { mediaType: "video/mp4", container: "mp4" }],
  ["audio/webm", { mediaType: "audio/webm", container: "webm" }],
  ["video/webm", { mediaType: "video/webm", container: "webm" }],
  ["application/webm", { mediaType: "video/webm", container: "webm" }],
  ["audio/ogg", { mediaType: "audio/ogg", container: "ogg" }],
  ["video/ogg", { mediaType: "video/ogg", container: "ogg" }],
  ["audio/flac", { mediaType: "audio/flac", container: "flac" }],
  ["audio/x-matroska", { mediaType: "audio/x-matroska", container: "matroska" }],
  ["video/x-matroska", { mediaType: "video/x-matroska", container: "matroska" }],
  ["audio/mkv", { mediaType: "audio/x-matroska", container: "matroska" }],
  ["video/mkv", { mediaType: "video/x-matroska", container: "matroska" }],
  ["application/x-matroska", { mediaType: "video/x-matroska", container: "matroska" }],
]);

/**
 * 只对白名单 MIME 做规范化；容器、Codec 和文件头解析交给浏览器原生管线。
 * 不在白名单的声明直接失败，由上层保留下载入口，避免为确认 MIME 重复读取 Block 0。
 */
export function nativeMediaTypeDescription(declaredMediaType: string): NativeMediaTypeDescription {
  const description = NATIVE_MEDIA_TYPES.get(normalizeDeclaredMediaType(declaredMediaType));
  if (!description) throw new MsFileMediaError("msfile_media_unsupported_container");
  return description;
}

function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return Promise.reject(new MsFileMediaError("msfile_media_browser_capability"));
  return subtle.digest("SHA-256", bytes.slice()).then((digest) => {
    let value = "";
    for (const byte of new Uint8Array(digest)) value += byte.toString(16).padStart(2, "0");
    return value;
  });
}

function abortError(): MsFileMediaError {
  return new MsFileMediaError("msfile_media_cancelled");
}

function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { cleanup(); resolve(value); },
      (error: unknown) => { cleanup(); reject(error); },
    );
  });
}

function linkSignal(parent: AbortSignal, child: AbortController): () => void {
  const onAbort = () => child.abort();
  if (parent.aborted) child.abort();
  else parent.addEventListener("abort", onAbort, { once: true });
  return () => parent.removeEventListener("abort", onAbort);
}

export class MsFileRangeSource {
  private readonly input: MsFileVodSourceInput;
  private readonly reader: MsFileMediaBlockReader;
  private readonly maxConcurrentReads: number;
  private readonly onDebug?: MsFileRangeSourceOptions["onDebug"];
  private readonly internalAbort = new AbortController();
  private readonly flights = new Map<string, BlockFlight>();
  private readonly permitWaiters: PermitWaiter[] = [];
  private readonly listeners = new Set<() => void>();
  private initialized = false;
  private disposed = false;
  private failed: MsFileMediaError | undefined;
  private initializing: Promise<void> | undefined;
  private blockHashes: string[] = [];
  private blockSizes: number[] = [];
  private activeRequestCount = 0;
  private activeReadCount = 0;
  private supplierReadCount = 0;
  private verifiedBlockCount = 0;
  private mediaType: string | undefined;
  private container: MsFileNativeMediaContainer | undefined;

  constructor(input: MsFileVodSourceInput, options: MsFileRangeSourceOptions = {}) {
    if (!isValidMsFileHashHex(input.seedHashHex) || !isValidMsFileSupplierPublicKeyHex(input.supplierPublicKeyHex)) {
      throw new MsFileMediaError("msfile_media_configuration");
    }
    if (typeof input.fileSizeBytes !== "bigint" || input.fileSizeBytes < 0n || input.fileSizeBytes > MAX_SAFE_BIGINT) {
      throw new MsFileMediaError("msfile_media_configuration");
    }
    if (typeof input.declaredMediaType !== "string" || input.declaredMediaType.length > 256) {
      throw new MsFileMediaError("msfile_media_configuration");
    }
    if (!input.reader || typeof input.reader.readSeed !== "function" || typeof input.reader.readBlock !== "function") {
      throw new MsFileMediaError("msfile_media_configuration");
    }
    const requested = options.maxConcurrentReads ?? DEFAULT_MAX_CONCURRENT_READS;
    if (!Number.isSafeInteger(requested) || requested < 1 || requested > MSFILE_MEDIA_BLOCK_READ_CONCURRENCY_MAX) {
      throw new MsFileMediaError("msfile_media_configuration");
    }
    this.input = input;
    this.reader = input.reader;
    this.maxConcurrentReads = requested;
    this.onDebug = options.onDebug;
  }

  get fileSizeBytes(): bigint { return this.input.fileSizeBytes; }
  get fileSizeNumber(): number { return Number(this.input.fileSizeBytes); }
  get declaredMediaType(): string { return this.input.declaredMediaType; }
  get confirmedMediaType(): string | undefined { return this.mediaType; }
  get confirmedContainer(): MsFileNativeMediaContainer | undefined { return this.container; }
  get maxConcurrentReadCount(): number { return this.maxConcurrentReads; }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): MsFileRangeSourceSnapshot {
    return {
      initialized: this.initialized,
      disposed: this.disposed,
      activeRequestCount: this.activeRequestCount,
      inFlightBlockCount: this.flights.size,
      activeReadCount: this.activeReadCount,
      maxConcurrentReads: this.maxConcurrentReads,
      supplierReadCount: this.supplierReadCount,
      verifiedBlockCount: this.verifiedBlockCount,
      mediaType: this.mediaType,
      container: this.container,
      error: this.failed ? { code: this.failed.code, message: this.failed.message } : undefined,
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private debug(action: string, details: Record<string, MsFileMediaDebugValue> = {}): void {
    this.onDebug?.(action, details);
  }

  private ensureUsable(): void {
    if (this.disposed || this.internalAbort.signal.aborted) throw this.failed ?? abortError();
    if (this.failed) throw this.failed;
  }

  private fail(error: unknown): MsFileMediaError {
    const normalized = normalizeMediaError(error);
    if (normalized.code === "msfile_media_cancelled") return normalized;
    if (!this.failed) {
      this.failed = normalized;
      this.internalAbort.abort();
      for (const waiter of this.permitWaiters.splice(0)) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
        waiter.reject(normalized);
      }
      for (const flight of this.flights.values()) flight.controller.abort();
      this.emit();
    }
    return this.failed;
  }

  private async performInitialize(): Promise<void> {
    try {
      const seedBytes = await this.reader.readSeed({ signal: this.internalAbort.signal });
      this.ensureUsable();
      if (!(seedBytes instanceof Uint8Array) || seedBytes.byteLength > MSFILE_MAX_SEED_BYTES || seedBytes.byteLength % MSFILE_DIGEST_SIZE_BYTES !== 0) {
        throw new MsFileMediaError("msfile_media_integrity");
      }
      if (await sha256Hex(seedBytes) !== this.input.seedHashHex) throw new MsFileMediaError("msfile_media_integrity");
      const expectedBlockCount = this.input.fileSizeBytes === 0n
        ? 0n
        : (this.input.fileSizeBytes - 1n) / BigInt(MSFILE_BLOCK_SIZE_BYTES) + 1n;
      if (BigInt(seedBytes.byteLength / MSFILE_DIGEST_SIZE_BYTES) !== expectedBlockCount) {
        throw new MsFileMediaError("msfile_media_integrity");
      }

      const hashes: string[] = [];
      const sizes: number[] = [];
      const sizeByHash = new Map<string, number>();
      for (let offset = 0; offset < seedBytes.byteLength; offset += MSFILE_DIGEST_SIZE_BYTES) {
        let hash = "";
        for (let index = 0; index < MSFILE_DIGEST_SIZE_BYTES; index += 1) {
          hash += seedBytes[offset + index]!.toString(16).padStart(2, "0");
        }
        if (!isValidMsFileHashHex(hash)) throw new MsFileMediaError("msfile_media_integrity");
        const start = BigInt(hashes.length) * BigInt(MSFILE_BLOCK_SIZE_BYTES);
        const remaining = this.input.fileSizeBytes - start;
        if (remaining <= 0n) throw new MsFileMediaError("msfile_media_integrity");
        const expectedSize = remaining < BigInt(MSFILE_BLOCK_SIZE_BYTES) ? remaining : BigInt(MSFILE_BLOCK_SIZE_BYTES);
        if (expectedSize <= 0n || expectedSize > BigInt(MSFILE_MAX_BLOCK_BYTES)) throw new MsFileMediaError("msfile_media_integrity");
        const size = Number(expectedSize);
        const previousSize = sizeByHash.get(hash);
        if (previousSize !== undefined && previousSize !== size) throw new MsFileMediaError("msfile_media_integrity");
        sizeByHash.set(hash, size);
        hashes.push(hash);
        sizes.push(size);
      }
      this.blockHashes = hashes;
      this.blockSizes = sizes;
      this.initialized = true;
      this.emit();
    } catch (error) {
      if (this.internalAbort.signal.aborted && !this.failed) throw abortError();
      throw this.fail(error);
    }
  }

  async initialize(signal: AbortSignal = new AbortController().signal): Promise<void> {
    this.ensureUsable();
    throwIfMediaAborted(signal);
    if (!this.initializing) {
      const initializing = this.performInitialize();
      this.initializing = initializing;
      void initializing.then(
        () => { if (this.initializing === initializing) this.initializing = undefined; },
        () => { if (this.initializing === initializing) this.initializing = undefined; },
      );
    }
    await awaitWithAbort(this.initializing, signal);
    this.ensureUsable();
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

  private drainPermits(): void {
    while (this.activeReadCount < this.maxConcurrentReads && this.permitWaiters.length > 0) {
      const waiter = this.permitWaiters.shift()!;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.reject(abortError());
        continue;
      }
      this.activeReadCount += 1;
      void waiter.operation().then(waiter.resolve, waiter.reject).finally(() => {
        this.activeReadCount = Math.max(0, this.activeReadCount - 1);
        this.emit();
        this.drainPermits();
      });
    }
    this.emit();
  }

  private withPermit(operation: () => Promise<Uint8Array>, signal: AbortSignal): Promise<Uint8Array> {
    this.ensureUsable();
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise<Uint8Array>((resolve, reject) => {
      const waiter: PermitWaiter = {
        operation,
        resolve,
        reject,
        signal,
        onAbort: () => {
          const index = this.permitWaiters.indexOf(waiter);
          if (index >= 0) this.permitWaiters.splice(index, 1);
          reject(abortError());
        },
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.permitWaiters.push(waiter);
      this.drainPermits();
    });
  }

  private async loadFlight(flight: BlockFlight, blockIndex: number): Promise<Uint8Array> {
    const startedAt = typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
    try {
      return await this.withPermit(async () => {
        this.supplierReadCount += 1;
        this.debug("range.block.read", { blockIndex, inflightHit: false });
        this.emit();
        try {
          const bytes = await this.reader.readBlock({ blockHashHex: flight.hash, signal: flight.controller.signal });
          if (this.internalAbort.signal.aborted || flight.controller.signal.aborted) throw abortError();
          if (!(bytes instanceof Uint8Array) || bytes.byteLength !== flight.expectedSizeBytes) {
            throw new MsFileMediaError("msfile_media_integrity");
          }
          if (await sha256Hex(bytes) !== flight.hash) throw new MsFileMediaError("msfile_media_integrity");
          const verified = bytes.slice();
          this.verifiedBlockCount += 1;
          const elapsedMs = Math.max(0, Math.round((typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now()) - startedAt));
          this.debug("range.block.done", { blockIndex, byteLength: verified.byteLength, elapsedMs });
          return verified;
        } catch (error) {
          const normalized = normalizeMediaError(error);
          if (normalized.code === "msfile_media_cancelled" || flight.controller.signal.aborted || this.internalAbort.signal.aborted) {
            throw normalized.code === "msfile_media_cancelled" ? normalized : abortError();
          }
          throw this.fail(error);
        }
      }, flight.controller.signal);
    } catch (error) {
      if (flight.controller.signal.aborted && !this.failed) throw abortError();
      throw error;
    }
  }

  private maybeDeleteFlight(flight: BlockFlight): void {
    if (flight.settled && flight.users === 0 && this.flights.get(flight.hash) === flight) {
      this.flights.delete(flight.hash);
      this.emit();
    }
  }

  private releaseFlight(flight: BlockFlight): void {
    flight.users = Math.max(0, flight.users - 1);
    if (flight.users === 0 && !flight.settled) flight.controller.abort();
    this.maybeDeleteFlight(flight);
    this.emit();
  }

  private async acquireBlock(index: number, signal: AbortSignal): Promise<{ bytes: Uint8Array; release: () => void }> {
    await this.initialize(signal);
    this.ensureUsable();
    const hash = this.blockHashAt(index);
    const expectedSizeBytes = this.blockSizeAt(index);
    let flight = this.flights.get(hash);
    const inflightHit = flight !== undefined;
    if (flight && flight.expectedSizeBytes !== expectedSizeBytes) throw new MsFileMediaError("msfile_media_integrity");
    if (!flight) {
      const controller = new AbortController();
      const unlink = linkSignal(this.internalAbort.signal, controller);
      flight = {
        hash,
        expectedSizeBytes,
        controller,
        promise: Promise.resolve(new Uint8Array()),
        users: 0,
        settled: false,
      };
      flight.promise = this.loadFlight(flight, index).finally(() => {
        unlink();
        flight!.settled = true;
        this.maybeDeleteFlight(flight!);
        this.emit();
      });
      this.flights.set(hash, flight);
    }
    flight.users += 1;
    if (inflightHit) this.debug("range.block.read", { blockIndex: index, inflightHit: true });
    this.emit();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.releaseFlight(flight!);
    };
    try {
      const bytes = await awaitWithAbort(flight.promise, signal);
      this.ensureUsable();
      return { bytes, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  /** 只根据白名单声明收敛 MIME；容器/Codec 由 HTMLMediaElement 原生解析。 */
  async confirmMediaType(signal?: AbortSignal): Promise<{ mediaType: string; container: MsFileNativeMediaContainer }> {
    this.ensureUsable();
    if (this.mediaType && this.container) return { mediaType: this.mediaType, container: this.container };
    if (this.fileSizeNumber <= 0) throw new MsFileMediaError("msfile_media_unsupported_container");
    try {
      throwIfMediaAborted(signal);
      const detected = nativeMediaTypeDescription(this.input.declaredMediaType);
      // MIME 不在白名单时在此处直接失败；Seed/Block 读取只由实际正文
      // pull 触发，避免 HEAD 或错误 MIME 查询产生供应商读取。
      this.mediaType = detected.mediaType;
      this.container = detected.container;
      this.emit();
      return detected;
    } catch (error) {
      if (error instanceof MsFileMediaError && error.code === "msfile_media_cancelled") throw error;
      throw this.fail(error);
    }
  }

  /** 为 HTTP HEAD/GET 生成精确响应描述；416 在此处结束，不触发 Seed/Block 读取。 */
  async describeResponse(method: string, rangeHeader: string | null | undefined, signal?: AbortSignal): Promise<MsFileRangeResponse> {
    this.ensureUsable();
    const normalizedMethod = method.toUpperCase();
    if (normalizedMethod !== "GET" && normalizedMethod !== "HEAD") throw new MsFileMediaError("msfile_media_range_invalid");
    // 施工单固定 HEAD 返回完整文件描述，不按 Range 头改变状态码。
    const description = describeByteRange(this.fileSizeNumber, normalizedMethod === "HEAD" ? undefined : rangeHeader);
    if (description.status === 416) return description;
    const { mediaType } = await this.confirmMediaType(signal);
    return { ...description, mediaType };
  }

  /** 供 Range Host 使用的当前 HTTP 请求计数。 */
  beginRequest(): void {
    this.ensureUsable();
    this.activeRequestCount += 1;
    this.emit();
  }

  endRequest(): void {
    this.activeRequestCount = Math.max(0, this.activeRequestCount - 1);
    this.emit();
  }

  /** 仅用于有限头部/索引辅助读取；正文必须使用 readStream。 */
  async readRange(startByte: number, endByteExclusive: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (!isSafeRange(startByte) || !isSafeRange(endByteExclusive) || endByteExclusive < startByte || endByteExclusive > this.fileSizeNumber) {
      throw new MsFileMediaError("msfile_media_range_invalid");
    }
    if (endByteExclusive - startByte > MAX_AUXILIARY_RANGE_BYTES) {
      throw new MsFileMediaError("msfile_media_range_invalid");
    }
    await this.initialize(signal);
    if (endByteExclusive === startByte) return new Uint8Array();
    const result = new Uint8Array(endByteExclusive - startByte);
    let position = startByte;
    let outputOffset = 0;
    while (position < endByteExclusive) {
      throwIfMediaAborted(signal);
      const blockIndex = Math.floor(position / MSFILE_BLOCK_SIZE_BYTES);
      const acquired = await this.acquireBlock(blockIndex, signal ?? new AbortController().signal);
      try {
        const from = position % MSFILE_BLOCK_SIZE_BYTES;
        const length = Math.min(acquired.bytes.byteLength - from, endByteExclusive - position);
        if (length <= 0) throw new MsFileMediaError("msfile_media_integrity");
        result.set(acquired.bytes.subarray(from, from + length), outputOffset);
        outputOffset += length;
        position += length;
      } finally {
        acquired.release();
      }
    }
    return result;
  }

  /**
   * 按 Range 逐块输出。每次 pull 最多持有一个 Block；cancel 会停止后续 Block Read。
   */
  readStream(startByte: number, endByteExclusive: number, signal?: AbortSignal): ReadableStream<Uint8Array> {
    if (!isSafeRange(startByte) || !isSafeRange(endByteExclusive) || endByteExclusive < startByte || endByteExclusive > this.fileSizeNumber) {
      throw new MsFileMediaError("msfile_media_range_invalid");
    }
    const local = new AbortController();
    const unlinkParent = signal ? linkSignal(signal, local) : () => undefined;
    const unlinkSource = linkSignal(this.internalAbort.signal, local);
    let position = startByte;
    let closed = false;
    let pulling = false;
    const close = () => {
      if (closed) return;
      closed = true;
      local.abort();
      unlinkParent();
      unlinkSource();
    };
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (closed || pulling) return;
        if (position >= endByteExclusive) {
          controller.close();
          close();
          return;
        }
        pulling = true;
        let acquired: { bytes: Uint8Array; release: () => void } | undefined;
        try {
          const blockIndex = Math.floor(position / MSFILE_BLOCK_SIZE_BYTES);
          acquired = await this.acquireBlock(blockIndex, local.signal);
          if (closed || local.signal.aborted) throw abortError();
          const from = position % MSFILE_BLOCK_SIZE_BYTES;
          const length = Math.min(acquired.bytes.byteLength - from, endByteExclusive - position);
          if (length <= 0) throw new MsFileMediaError("msfile_media_integrity");
          // slice 让 Source 不保留下游队列所持有的 Block 引用。
          controller.enqueue(acquired.bytes.slice(from, from + length));
          position += length;
          if (position >= endByteExclusive) {
            // 让最后一个 chunk 先进入队列；下一次 pull 负责 close，兼容各浏览器
            // 对 enqueue 后立即 close 的差异。
          }
        } catch (error) {
          if (!closed && (!local.signal.aborted || this.failed)) {
            closed = true;
            unlinkParent();
            unlinkSource();
            // Source 发生完整性/网络失败时，internalAbort 会同时取消 local
            // signal；此时仍必须把稳定错误交给 SW，不能把 ReadableStream 留在
            // pending 状态。只有没有失败原因的主动 cancel/dispose 才正常关闭。
            controller.error(this.failed ?? error);
          } else {
            close();
            try { controller.close(); } catch { /* reader.cancel 已经关闭了流 */ }
          }
        } finally {
          acquired?.release();
          pulling = false;
        }
      },
      cancel: () => close(),
    });
  }

  abort(): void {
    if (this.disposed) return;
    this.internalAbort.abort();
    for (const waiter of this.permitWaiters.splice(0)) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject(abortError());
    }
    for (const flight of this.flights.values()) flight.controller.abort();
    this.emit();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.internalAbort.abort();
    for (const waiter of this.permitWaiters.splice(0)) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject(abortError());
    }
    for (const flight of this.flights.values()) flight.controller.abort();
    this.flights.clear();
    this.emit();
    this.listeners.clear();
  }
}

export function rangeInvalidReasonToCode(_reason: MsFileRangeInvalidReason): "msfile_media_range_invalid" {
  return "msfile_media_range_invalid";
}
