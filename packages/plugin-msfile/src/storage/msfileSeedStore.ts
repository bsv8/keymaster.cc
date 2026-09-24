// MSFile 桶内种子存储：按 KeymasterFormats 的 msfiles/seeds、storage、meta
// 组织内容。MasterSeed 的分块、摘要、种子哈希与校验全部调用 `masterseed`
// (`keymaster-seed-v1`) 官方 SDK；本文件只编排：
//   - 源文件两遍读取的上传顺序（先算种子，再写块、种子、元数据）；
//   - 桶内路径、元数据格式的严格解析与序列化；
//   - 列表 join、读回组装与删除顺序。
//
// 布局（owner 模块根 `<owner>/msfiles/` 下的相对路径）：
//   - seeds/<seedhash>.ms                 原始种子字节
//   - storage/<seedhash>/<blockhash>      原始块字节，文件名为块 SHA-256 小写 hex
//   - meta/<seedhash>.json                文件名/类型/大小/块数/写入时间
//
// 本文件不接触 Provider、凭据或浏览器持久化，只使用受限 OwnerFileStore。

import {
  BLOCK_SIZE_BIGINT,
  Digest,
  ERROR_CODES,
  blockCountForSourceSize,
  createSeed,
  expectedBlockSize,
  isMasterSeedError,
  readBlockHash,
  verifyBlock,
  verifySeedForSourceSize,
  type RandomAccessSeed,
} from "masterseed";
import type { OwnerFileListEntry, OwnerFileStore } from "@keymaster/contracts";
import { sanitizeMsFileFilename } from "../fileAssembly.js";
import { normalizeMsFileMediaType } from "../filePreviewPolicy.js";

export const MSFILE_SEED_META_FORMAT = "keymaster.msfiles-meta";
export const MSFILE_SEED_META_VERSION = 1;
export const MSFILE_SEED_META_MAX_BYTES = 4 * 1024;
export const MSFILE_SEED_BLOCK_WRITE_CONCURRENCY = 4;
/** 经 Worker 直读/直写块时的并行度；Provider 往返延迟是主要成本。 */
export const MSFILE_SEED_WORKER_BLOCK_CONCURRENCY = 8;
export const MSFILE_SEED_BLOCK_READ_CONCURRENCY = 4;

const META_FILE_PATTERN = /^meta\/([0-9a-f]{64})\.json$/u;
const HASH_HEX_PATTERN = /^[0-9a-f]{64}$/u;
const MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u;
const MAX_FILE_NAME_BYTES = 255;
const MAX_MEDIA_TYPE_BYTES = 255;
const UINT64_MAX = 0xffffffffffffffffn;
const DEFAULT_MEDIA_TYPE = "application/octet-stream";
const LIST_PAGE_LIMIT = 200;

/** 稳定错误码；页面按码映射 i18n，不解析 message。 */
export type MsFileSeedStoreErrorCode =
  | "invalid-hash"
  | "invalid-source"
  | "source-changed"
  | "missing-seed"
  | "missing-meta"
  | "missing-block"
  | "invalid-meta"
  | "integrity"
  | "cancelled"
  | "storage"
  | "internal";

export class MsFileSeedStoreError extends Error {
  constructor(public readonly code: MsFileSeedStoreErrorCode, message?: string) {
    super(message ?? code);
    this.name = "MsFileSeedStoreError";
  }
}

export function isMsFileSeedStoreError(value: unknown): value is MsFileSeedStoreError {
  return value instanceof MsFileSeedStoreError;
}

/** KeymasterFormats《msfiles/meta/<seedhash>.json》的完整字段。 */
export interface MsFileSeedMeta {
  seedHashHex: string;
  fileName: string;
  mediaType: string;
  fileSizeBytes: string;
  blockCount: number;
  seedSizeBytes: string;
  storedAt: string;
}

/**
 * 列表条目：`meta/` 是列表真值，一个 meta 文件就是一个条目。
 *
 * 列表阶段只读 `meta/`：不检查种子、不检查块，避免“一来就翻整桶”。
 * 缺失检查是懒的：读取/校验失败后调用方可以把 `seedPresent` 标记为 false；
 * undefined 表示“尚未检查”，不是“存在”。
 */
export interface MsFileSeedEntry {
  seedHashHex: string;
  meta: MsFileSeedMeta | null;
  /**
   * 种子是否存在：懒检测。列表不填；读取/校验/删除发现种子缺失后由调用方标记。
   */
  seedPresent?: boolean;
}

/** 上传源。核心逻辑不依赖浏览器 File，测试用内存实现。 */
export interface MsFileSeedSource {
  readonly name: string;
  readonly mediaType: string;
  readonly size: bigint;
  stream(options: { signal?: AbortSignal }): AsyncIterable<Uint8Array>;
  read(offset: bigint, length: number, options?: { signal?: AbortSignal }): Promise<Uint8Array>;
}

export interface MsFileSeedStoreProgress {
  phase: "hashing" | "storing-blocks" | "reading-blocks";
  completedBytes: string;
  totalBytes: string;
  completedBlocks?: number;
  totalBlocks?: number;
}

export interface MsFileSeedUploadResult {
  entry: MsFileSeedEntry;
  /** 元数据写入成功；与 entry.meta 相同，便于调用方直接展示。 */
  meta: MsFileSeedMeta;
}

export interface MsFileSeedReadResult {
  meta: MsFileSeedMeta;
  seedBytes: Uint8Array;
  /** 按块顺序的已验证内容。 */
  parts: Uint8Array[];
}

/**
 * 桶内“校验”结果：只做存在性与结构完整性检查，不计算任何 SHA-256。
 *
 * 检查项：meta 是否可用且与种子一致、种子是否存在且长度合法、
 * 种子引用的每个块 hash 文件是否存在。内容是否与 hash 相符留给下载路径。
 */
export interface MsFileSeedVerifyResult {
  metaAvailable: boolean;
  seedPresent: boolean;
  /** 种子长度是 32 的整数倍（结构性合法）。 */
  seedValid: boolean;
  /** 元数据存在时与种子长度/块数一致；元数据缺失时视为未检查（true）。 */
  metaConsistent: boolean;
  blockCount: string;
  /** 缺失的块文件个数（按去重后的 hash 位置统计）。 */
  missingBlocks: number;
  complete: boolean;
}

/** local MSFile Stat 成功后的已验证内容摘要。 */
export interface MsFileLocalSeedDescriptor {
  /** 严格解析并与 Seed 对账后的元数据。 */
  meta: MsFileSeedMeta;
  /** 通过 Seed Hash 与文件大小验证的原始 Seed 字节。 */
  seedBytes: Uint8Array;
}

function fail(code: MsFileSeedStoreErrorCode, message: string): never {
  throw new MsFileSeedStoreError(code, message);
}

export function isMsFileSeedHashHex(value: unknown): value is string {
  return typeof value === "string" && HASH_HEX_PATTERN.test(value);
}

function assertSeedHashHex(value: string): string {
  if (!isMsFileSeedHashHex(value)) fail("invalid-hash", "seed hash must be 64 lower-case hex characters");
  return value;
}

function seedPath(seedHashHex: string): string {
  return `seeds/${seedHashHex}.ms`;
}

function metaPath(seedHashHex: string): string {
  return `meta/${seedHashHex}.json`;
}

function blockPath(seedHashHex: string, blockHashHex: string): string {
  return `storage/${seedHashHex}/${blockHashHex}`;
}

function parseCanonicalUint64(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) fail("invalid-meta", `${label} must be a canonical decimal string`);
  if (BigInt(value) > UINT64_MAX) fail("invalid-meta", `${label} exceeds uint64`);
  return value;
}

function parseMetaFileName(value: unknown): string {
  if (typeof value !== "string") fail("invalid-meta", "fileName must be a string");
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_FILE_NAME_BYTES) fail("invalid-meta", "fileName length is invalid");
  if (value === "." || value === ".." || value.includes("/") || value.includes("\\")) fail("invalid-meta", "fileName must be a basename");
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) fail("invalid-meta", "fileName contains control characters");
  return value;
}

function parseMetaMediaType(value: unknown): string {
  if (typeof value !== "string") fail("invalid-meta", "mediaType must be a string");
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_MEDIA_TYPE_BYTES) fail("invalid-meta", "mediaType length is invalid");
  if (!MEDIA_TYPE_PATTERN.test(value)) fail("invalid-meta", "mediaType must be lower-case type/subtype");
  return value;
}

function parseMetaStoredAt(value: unknown): string {
  if (typeof value !== "string") fail("invalid-meta", "storedAt must be a string");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail("invalid-meta", "storedAt must be a canonical ISO-8601 UTC timestamp");
  return value;
}

/**
 * 严格解析元数据；未知字段、字段不一致或与文件名不符时拒绝。
 * 校验通过后，`blockCount` 与 `seedSizeBytes` 已和 `fileSizeBytes` 自洽。
 */
export function parseMsFileSeedMeta(bytes: Uint8Array, expectedSeedHashHex: string): MsFileSeedMeta {
  const seedHashHex = assertSeedHashHex(expectedSeedHashHex);
  if (bytes.byteLength === 0 || bytes.byteLength > MSFILE_SEED_META_MAX_BYTES) fail("invalid-meta", "meta file size is invalid");
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("invalid-meta", "meta file is not valid UTF-8");
  }
  let value: unknown;
  try {
    value = JSON.parse(decoded);
  } catch {
    fail("invalid-meta", "meta file is not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("invalid-meta", "meta file must be a JSON object");
  const record = value as Record<string, unknown>;
  const allowed = ["format", "version", "seedHashHex", "fileName", "mediaType", "fileSizeBytes", "blockCount", "seedSizeBytes", "storedAt"];
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) fail("invalid-meta", `meta file has an unknown field: ${key}`);
  }
  if (record.format !== MSFILE_SEED_META_FORMAT || record.version !== MSFILE_SEED_META_VERSION) fail("invalid-meta", "meta format/version is invalid");
  if (record.seedHashHex !== seedHashHex) fail("invalid-meta", "meta seedHashHex does not match its file name");
  const fileName = parseMetaFileName(record.fileName);
  const mediaType = parseMetaMediaType(record.mediaType);
  const fileSizeBytes = parseCanonicalUint64(record.fileSizeBytes, "fileSizeBytes");
  const rawBlockCount = record.blockCount;
  if (typeof rawBlockCount !== "number" || !Number.isSafeInteger(rawBlockCount) || rawBlockCount < 0) fail("invalid-meta", "blockCount is invalid");
  const expectedBlockCount = Number(blockCountForSourceSize(BigInt(fileSizeBytes)));
  if (rawBlockCount !== expectedBlockCount) fail("invalid-meta", "blockCount does not match fileSizeBytes");
  const seedSizeBytes = parseCanonicalUint64(record.seedSizeBytes, "seedSizeBytes");
  if (seedSizeBytes !== (BigInt(rawBlockCount) * 32n).toString()) fail("invalid-meta", "seedSizeBytes does not match blockCount");
  const storedAt = parseMetaStoredAt(record.storedAt);
  return { seedHashHex, fileName, mediaType, fileSizeBytes, blockCount: rawBlockCount, seedSizeBytes, storedAt };
}

export function serializeMsFileSeedMeta(meta: MsFileSeedMeta): Uint8Array {
  const record = {
    format: MSFILE_SEED_META_FORMAT,
    version: MSFILE_SEED_META_VERSION,
    seedHashHex: meta.seedHashHex,
    fileName: meta.fileName,
    mediaType: meta.mediaType,
    fileSizeBytes: meta.fileSizeBytes,
    blockCount: meta.blockCount,
    seedSizeBytes: meta.seedSizeBytes,
    storedAt: meta.storedAt,
  };
  return new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`);
}

/** 把浏览器提供的信息收敛为规范内允许的 fileName。 */
export function sanitizeMsFileSeedFileName(value: string, fallback: string): string {
  return sanitizeMsFileFilename(value, fallback);
}

/** 把浏览器提供的信息收敛为规范内允许的 mediaType。 */
export function normalizeMsFileSeedMediaType(value: string): string {
  const normalized = normalizeMsFileMediaType(value);
  if (normalized.length < 1 || normalized.length > MAX_MEDIA_TYPE_BYTES || !MEDIA_TYPE_PATTERN.test(normalized)) return DEFAULT_MEDIA_TYPE;
  return normalized;
}

function toStoreError(cause: unknown, fallback: MsFileSeedStoreErrorCode): MsFileSeedStoreError {
  if (isMsFileSeedStoreError(cause)) return cause;
  if (isMasterSeedError(cause)) {
    switch (cause.code) {
      case ERROR_CODES.ABORTED: return new MsFileSeedStoreError("cancelled", cause.message);
      case ERROR_CODES.READ_FAILED:
      case ERROR_CODES.WRITE_FAILED: return new MsFileSeedStoreError("storage", cause.message);
      default: return new MsFileSeedStoreError("integrity", cause.message);
    }
  }
  if (cause instanceof DOMException && cause.name === "AbortError") return new MsFileSeedStoreError("cancelled", cause.message);
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/abort|cancel/iu.test(message)) return new MsFileSeedStoreError("cancelled", message);
  return new MsFileSeedStoreError(fallback, message);
}

function assertSource(source: MsFileSeedSource): void {
  if (!source || typeof source !== "object") fail("invalid-source", "source is invalid");
  if (typeof source.name !== "string" || typeof source.mediaType !== "string") fail("invalid-source", "source name/mediaType is invalid");
  if (typeof source.size !== "bigint" || source.size < 0n || source.size > UINT64_MAX) fail("invalid-source", "source size is invalid");
  if (source.size > BigInt(Number.MAX_SAFE_INTEGER)) fail("invalid-source", "source is too large for this browser");
  if (typeof source.stream !== "function" || typeof source.read !== "function") fail("invalid-source", "source must provide stream() and read()");
}

function createSeedRandomAccess(seedBytes: Uint8Array): RandomAccessSeed {
  return {
    async readAt(offset: bigint, length: number): Promise<Uint8Array> {
      const start = Number(offset);
      const end = start + length;
      if (!Number.isSafeInteger(start) || start < 0 || length < 0 || end > seedBytes.byteLength) {
        throw new MsFileSeedStoreError("integrity", "seed offset is outside the seed file");
      }
      return seedBytes.subarray(start, end);
    },
  };
}

/**
 * 固定大小并发池。首个失败取消其余任务并保留原始错误；父信号取消时
 * 以 `cancelled` 收尾。空任务直接返回。
 */
async function runPool(
  count: number,
  concurrency: number,
  signal: AbortSignal | undefined,
  worker: (index: number, signal: AbortSignal) => Promise<void>,
): Promise<void> {
  if (count <= 0) return;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  let next = 0;
  let firstError: unknown;
  const runWorker = async (): Promise<void> => {
    for (;;) {
      if (controller.signal.aborted) return;
      const index = next;
      next += 1;
      if (index >= count) return;
      try {
        await worker(index, controller.signal);
      } catch (error) {
        firstError ??= error;
        controller.abort();
        return;
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, count) }, () => runWorker()));
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  if (firstError !== undefined) throw firstError;
  if (signal?.aborted) fail("cancelled", "operation was cancelled");
}

async function putFile(store: OwnerFileStore, path: string, bytes: Uint8Array, signal: AbortSignal | undefined): Promise<void> {
  try {
    await store.put(path, bytes, signal === undefined ? {} : { signal });
  } catch (cause) {
    throw toStoreError(cause, "storage");
  }
}

async function deleteFile(store: OwnerFileStore, path: string, signal: AbortSignal | undefined): Promise<void> {
  try {
    await store.delete(path, signal === undefined ? {} : { signal });
  } catch (cause) {
    throw toStoreError(cause, "storage");
  }
}

async function getFile(store: OwnerFileStore, path: string, signal: AbortSignal | undefined): Promise<Uint8Array | undefined> {
  try {
    const object = await store.get(path, signal === undefined ? {} : { signal });
    return object?.bytes;
  } catch (cause) {
    throw toStoreError(cause, "storage");
  }
}

async function listPrefix(store: OwnerFileStore, prefix: string, signal: AbortSignal | undefined): Promise<OwnerFileListEntry[]> {
  const files: OwnerFileListEntry[] = [];
  let cursor: string | undefined;
  try {
    do {
      const page = await store.list({
        prefix,
        ...(cursor === undefined ? {} : { cursor }),
        limit: LIST_PAGE_LIMIT,
        ...(signal === undefined ? {} : { signal }),
      });
      files.push(...page.files);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
  } catch (cause) {
    throw toStoreError(cause, "storage");
  }
  return files;
}

async function createSeedBytesFromSource(
  source: MsFileSeedSource,
  signal: AbortSignal | undefined,
  onProgress: ((progress: MsFileSeedStoreProgress) => void) | undefined,
): Promise<{ seedBytes: Uint8Array; seedHashHex: string; sourceSize: bigint; seedSize: bigint; blockCount: bigint }> {
  const digests: Uint8Array[] = [];
  const totalBytes = source.size.toString();
  let readBytes = 0n;
  const countingStream = async function* (): AsyncIterable<Uint8Array> {
    for await (const chunk of source.stream({ ...(signal === undefined ? {} : { signal }) })) {
      if (!(chunk instanceof Uint8Array)) throw new MsFileSeedStoreError("invalid-source", "source stream yielded a non-Uint8Array chunk");
      readBytes += BigInt(chunk.byteLength);
      if (readBytes > source.size) throw new MsFileSeedStoreError("source-changed", "source grew while hashing");
      onProgress?.({ phase: "hashing", completedBytes: readBytes.toString(), totalBytes });
      yield chunk;
    }
  };
  const info = await createSeed(countingStream(), { write: (bytes) => { digests.push(bytes); } }, signal);
  if (info.sourceSize !== source.size || readBytes !== source.size) {
    throw new MsFileSeedStoreError("source-changed", "source size changed while hashing");
  }
  const seedSize = Number(info.seedSize);
  const seedBytes = new Uint8Array(seedSize);
  let offset = 0;
  for (const digest of digests) {
    seedBytes.set(digest, offset);
    offset += digest.byteLength;
  }
  if (offset !== seedSize) throw new MsFileSeedStoreError("internal", "seed assembly mismatch");
  return { seedBytes, seedHashHex: info.seedHashHex, sourceSize: info.sourceSize, seedSize: info.seedSize, blockCount: info.blockCount };
}

/**
 * 上传一个源文件：两遍读取。
 *   1. `createSeed` 流式计算种子文件与 seed_hash；
 *   2. 按种子摘要逐块读源文件，`verifyBlock` 后写入块对象；
 *   3. 写种子文件，最后写元数据。
 * 重复上传同内容幂等覆盖；中断只留下无害孤儿块。
 */
export async function storeMsFileSeed(input: {
  store: OwnerFileStore;
  source: MsFileSeedSource;
  signal?: AbortSignal;
  onProgress?(progress: MsFileSeedStoreProgress): void;
  now?(): number;
  /**
   * 可选块写入通道：由 Coordinator 直写 owner 文件根。缺省时逐块写
   * `store`（测试与降级路径）。无论哪条通道，块路径都由本模块决定。
   */
  putBlock?(seedHashHex: string, blockHashHex: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
}): Promise<MsFileSeedUploadResult> {
  const { store, source, signal, onProgress, putBlock } = input;
  const now = input.now ?? Date.now;
  try {
    assertSource(source);
    const seed = await createSeedBytesFromSource(source, signal, onProgress);
    const seedHashHex = seed.seedHashHex;
    const randomAccess = createSeedRandomAccess(seed.seedBytes);
    const totalBlocks = Number(seed.blockCount);
    const totalBytes = seed.sourceSize.toString();
    const writeBlock = putBlock === undefined
      ? (seedHash: string, blockHash: string, bytes: Uint8Array, blockSignal: AbortSignal) => putFile(store, blockPath(seedHash, blockHash), bytes, blockSignal)
      : async (seedHash: string, blockHash: string, bytes: Uint8Array, blockSignal: AbortSignal) => {
        try {
          await putBlock(seedHash, blockHash, bytes, blockSignal);
        } catch (cause) {
          throw toStoreError(cause, "storage");
        }
      };
    const writeConcurrency = putBlock === undefined ? MSFILE_SEED_BLOCK_WRITE_CONCURRENCY : MSFILE_SEED_WORKER_BLOCK_CONCURRENCY;
    let completedBlocks = 0;
    await runPool(totalBlocks, writeConcurrency, signal, async (index, blockSignal) => {
      const blockIndex = BigInt(index);
      const digest = await readBlockHash(randomAccess, seed.seedSize, blockIndex, blockSignal);
      const expectedSize = Number(expectedBlockSize(seed.sourceSize, blockIndex));
      const bytes = await source.read(blockIndex * BLOCK_SIZE_BIGINT, expectedSize, { signal: blockSignal });
      if (bytes.byteLength !== expectedSize) throw new MsFileSeedStoreError("source-changed", "source block size changed while storing");
      verifyBlock(bytes, digest, blockSignal);
      await writeBlock(seedHashHex, digest.toHex(), bytes, blockSignal);
      completedBlocks += 1;
      onProgress?.({
        phase: "storing-blocks",
        completedBytes: (completedBlocks === totalBlocks ? seed.sourceSize : BigInt(completedBlocks) * BLOCK_SIZE_BIGINT).toString(),
        totalBytes,
        completedBlocks,
        totalBlocks,
      });
    });
    await putFile(store, seedPath(seedHashHex), seed.seedBytes, signal);
    const meta: MsFileSeedMeta = {
      seedHashHex,
      fileName: sanitizeMsFileSeedFileName(source.name, seedHashHex),
      mediaType: normalizeMsFileSeedMediaType(source.mediaType),
      fileSizeBytes: seed.sourceSize.toString(),
      blockCount: totalBlocks,
      seedSizeBytes: seed.seedSize.toString(),
      storedAt: new Date(now()).toISOString(),
    };
    await putFile(store, metaPath(seedHashHex), serializeMsFileSeedMeta(meta), signal);
    return { entry: { seedHashHex, seedPresent: true, meta }, meta };
  } catch (cause) {
    throw toStoreError(cause, "storage");
  }
}

/**
 * 提交经 BitFS 买方验货后的 Seed/Block。
 *
 * 写入顺序固定为 Block → Seed → meta；meta 是 available 的最后提交点。
 * 函数仍使用 masterseed 重验 Seed Hash、文件大小、块长度和每块 Hash，
 * 不信任网络层“已验证”声明。
 */
export async function commitPurchasedMsFileContent(input: {
  /** 当前 Owner 的 `msfiles/` 根。 */
  store: OwnerFileStore;
  /** 报价与购买会话绑定的 Seed Hash。 */
  seedHashHex: string;
  /** exact Seed 原文。 */
  seedBytes: Uint8Array;
  /** 按 Seed 摘要顺序的全部 Block。 */
  blocks: readonly Uint8Array[];
  /** 报价中绑定的原文件字节数。 */
  fileSizeBytes: string;
  /** 用户可见文件名。 */
  fileName: string;
  /** 用户可见 MIME 类型。 */
  mediaType: string;
  /** 取消本次提交。 */
  signal?: AbortSignal;
  /** 显式时钟，仅用于 meta.storedAt。 */
  now?(): number;
}): Promise<MsFileSeedUploadResult> {
  const { store, signal } = input;
  const seedHashHex = assertSeedHashHex(input.seedHashHex);
  if (!(input.seedBytes instanceof Uint8Array) || input.seedBytes.byteLength === 0) fail("invalid-source", "purchased seed is empty");
  if (!/^(0|[1-9][0-9]*)$/u.test(input.fileSizeBytes)) fail("invalid-source", "purchased file size is invalid");
  const sourceSize = BigInt(input.fileSizeBytes);
  const now = input.now ?? Date.now;
  try {
    const info = await verifySeedForSourceSize([input.seedBytes], Digest.fromHex(seedHashHex), sourceSize, signal);
    const totalBlocks = Number(info.blockCount);
    if (input.blocks.length !== totalBlocks) throw new MsFileSeedStoreError("integrity", "purchased block count does not match seed");
    const randomAccess = createSeedRandomAccess(input.seedBytes);
    await runPool(totalBlocks, MSFILE_SEED_BLOCK_WRITE_CONCURRENCY, signal, async (index, blockSignal) => {
      const bytes = input.blocks[index];
      if (!(bytes instanceof Uint8Array)) throw new MsFileSeedStoreError("integrity", "purchased block is not bytes");
      const blockIndex = BigInt(index);
      const digest = await readBlockHash(randomAccess, info.seedSize, blockIndex, blockSignal);
      const expectedSize = Number(expectedBlockSize(sourceSize, blockIndex));
      if (bytes.byteLength !== expectedSize) throw new MsFileSeedStoreError("integrity", "purchased block length does not match seed");
      verifyBlock(bytes, digest, blockSignal);
      await putFile(store, blockPath(seedHashHex, digest.toHex()), bytes, blockSignal);
    });
    // meta 尚未存在，因此中断留下的块/Seed 不会被列表或 Stat 当成 available。
    await putFile(store, seedPath(seedHashHex), input.seedBytes, signal);
    const meta: MsFileSeedMeta = {
      seedHashHex,
      fileName: sanitizeMsFileSeedFileName(input.fileName, seedHashHex),
      mediaType: normalizeMsFileSeedMediaType(input.mediaType),
      fileSizeBytes: sourceSize.toString(),
      blockCount: totalBlocks,
      seedSizeBytes: info.seedSize.toString(),
      storedAt: new Date(now()).toISOString(),
    };
    await putFile(store, metaPath(seedHashHex), serializeMsFileSeedMeta(meta), signal);
    return { entry: { seedHashHex, seedPresent: true, meta }, meta };
  } catch (cause) {
    throw toStoreError(cause, "storage");
  }
}

/** 校验已购 Seed 并返回其按文件顺序引用的 Block Hash。 */
export async function inspectPurchasedMsFileSeed(input: {
  /** 文件 Seed Hash。 */
  seedHashHex: string;
  /** exact Seed 原文。 */
  seedBytes: Uint8Array;
  /** 报价中绑定的原文件大小。 */
  fileSizeBytes: string;
}): Promise<{ blockHashesHex: string[]; seedSizeBytes: string }> {
  const seedHashHex = assertSeedHashHex(input.seedHashHex);
  if (!(input.seedBytes instanceof Uint8Array) || input.seedBytes.byteLength === 0) {
    fail("invalid-source", "purchased seed is empty");
  }
  if (!/^(0|[1-9][0-9]*)$/u.test(input.fileSizeBytes)) fail("invalid-source", "purchased file size is invalid");
  const sourceSize = BigInt(input.fileSizeBytes);
  try {
    const info = await verifySeedForSourceSize([input.seedBytes], Digest.fromHex(seedHashHex), sourceSize);
    if (info.blockCount > BigInt(Number.MAX_SAFE_INTEGER)) fail("invalid-source", "purchased seed block count is too large");
    const randomAccess = createSeedRandomAccess(input.seedBytes);
    const blockHashesHex: string[] = [];
    for (let index = 0; index < Number(info.blockCount); index += 1) {
      const digest = await readBlockHash(randomAccess, info.seedSize, BigInt(index));
      blockHashesHex.push(digest.toHex());
    }
    return { blockHashesHex, seedSizeBytes: info.seedSize.toString(10) };
  } catch (cause) {
    throw toStoreError(cause, "integrity");
  }
}

/**
 * 列出全部条目：只读 `meta/` 前缀，一个 meta 文件对应一个条目。
 *
 * 列表阶段不做任何缺失检查：不列 `seeds/`、不读种子、不读块。seeds/ 与
 * storage/ 的存在性、块是否完整都留到读取/校验时懒检测。
 */
export async function listMsFileSeeds(input: {
  store: OwnerFileStore;
  signal?: AbortSignal;
}): Promise<MsFileSeedEntry[]> {
  const { store, signal } = input;
  try {
    const metaFiles = await listPrefix(store, "meta/", signal);
    const hashes: string[] = [];
    for (const file of metaFiles) {
      const match = META_FILE_PATTERN.exec(file.path);
      if (match?.[1]) hashes.push(match[1]);
    }
    const metas = new Map<string, MsFileSeedMeta | null>();
    await runPool(hashes.length, MSFILE_SEED_BLOCK_READ_CONCURRENCY, signal, async (index, itemSignal) => {
      const hash = hashes[index]!;
      try {
        const bytes = await getFile(store, metaPath(hash), itemSignal);
        if (!bytes) {
          metas.set(hash, null);
          return;
        }
        metas.set(hash, parseMsFileSeedMeta(bytes, hash));
      } catch {
        // 损坏或不可读的元数据：条目保留为 meta = null，不影响其它条目。
        metas.set(hash, null);
      }
    });
    const entries: MsFileSeedEntry[] = hashes.map((hash) => ({
      seedHashHex: hash,
      meta: metas.get(hash) ?? null,
    }));
    entries.sort((a, b) => {
      const left = a.meta?.storedAt ?? "";
      const right = b.meta?.storedAt ?? "";
      return right.localeCompare(left) || a.seedHashHex.localeCompare(b.seedHashHex);
    });
    return entries;
  } catch (cause) {
    throw toStoreError(cause, "storage");
  }
}

/**
 * 校验 local 内容是否可报告 available。
 *
 * 与页面的轻量 `verifyMsFileSeed` 不同，本入口会验证 Seed Hash、Seed 长度、
 * 文件大小关系以及全部 Block 的存在性；Block 字节 Hash 仍在每次读取时验证。
 */
export async function inspectLocalMsFileSeed(input: {
  /** 当前 Owner 的 `msfiles/` 文件根。 */
  store: OwnerFileStore;
  /** 要检查的 Seed Hash。 */
  seedHashHex: string;
  /** 取消当前索引或读取操作。 */
  signal?: AbortSignal;
}): Promise<MsFileLocalSeedDescriptor | null> {
  const { store, signal } = input;
  const seedHashHex = assertSeedHashHex(input.seedHashHex);
  try {
    const metaBytes = await getFile(store, metaPath(seedHashHex), signal);
    if (!metaBytes) return null;
    const meta = parseMsFileSeedMeta(metaBytes, seedHashHex);
    const seedBytes = await getFile(store, seedPath(seedHashHex), signal);
    if (!seedBytes) return null;
    const info = await verifySeedForSourceSize(
      [seedBytes],
      Digest.fromHex(seedHashHex),
      BigInt(meta.fileSizeBytes),
      signal,
    );
    if (Number(info.blockCount) !== meta.blockCount || info.seedSize.toString() !== meta.seedSizeBytes) return null;
    const randomAccess = createSeedRandomAccess(seedBytes);
    const files = await listPrefix(store, `storage/${seedHashHex}/`, signal);
    const present = new Set(files.map((file) => file.path));
    for (let index = 0; index < meta.blockCount; index += 1) {
      const digest = await readBlockHash(randomAccess, info.seedSize, BigInt(index), signal);
      if (!present.has(blockPath(seedHashHex, digest.toHex()))) return null;
    }
    return { meta, seedBytes };
  } catch (cause) {
    if (isMsFileSeedStoreError(cause) && cause.code === "cancelled") throw cause;
    return null;
  }
}

/** 从 local MSFile 读取并验证一个 Seed，不加载 Block 内容。 */
export async function readLocalMsFileSeed(input: {
  /** 当前 Owner 的 `msfiles/` 文件根。 */
  store: OwnerFileStore;
  /** 要读取的 Seed Hash。 */
  seedHashHex: string;
  /** 取消读取。 */
  signal?: AbortSignal;
}): Promise<MsFileLocalSeedDescriptor> {
  const descriptor = await inspectLocalMsFileSeed(input);
  if (!descriptor) throw new MsFileSeedStoreError("missing-seed", "local Seed 不存在或内容不完整");
  return descriptor;
}

/**
 * 按 `Seed Hash + Block Hash` 精确读取 local Block，并验证归属、长度和 Hash。
 */
export async function readLocalMsFileBlock(input: {
  /** 当前 Owner 的 `msfiles/` 文件根。 */
  store: OwnerFileStore;
  /** Block 所属 Seed Hash。 */
  seedHashHex: string;
  /** 要读取的 Block Hash。 */
  blockHashHex: string;
  /** 取消读取。 */
  signal?: AbortSignal;
}): Promise<Uint8Array> {
  const { store, signal } = input;
  const seedHashHex = assertSeedHashHex(input.seedHashHex);
  const blockHashHex = assertSeedHashHex(input.blockHashHex);
  const descriptor = await readLocalMsFileSeed({ store, seedHashHex, ...(signal === undefined ? {} : { signal }) });
  const sourceSize = BigInt(descriptor.meta.fileSizeBytes);
  const seedSize = BigInt(descriptor.seedBytes.byteLength);
  const randomAccess = createSeedRandomAccess(descriptor.seedBytes);
  let matchedIndex = -1;
  for (let index = 0; index < descriptor.meta.blockCount; index += 1) {
    const digest = await readBlockHash(randomAccess, seedSize, BigInt(index), signal);
    if (digest.toHex() === blockHashHex) {
      matchedIndex = index;
      break;
    }
  }
  if (matchedIndex < 0) throw new MsFileSeedStoreError("missing-block", "Block 不属于指定 Seed");
  const bytes = await getFile(store, blockPath(seedHashHex, blockHashHex), signal);
  if (!bytes) throw new MsFileSeedStoreError("missing-block", "local Block 不存在");
  const expectedSize = Number(expectedBlockSize(sourceSize, BigInt(matchedIndex)));
  if (bytes.byteLength !== expectedSize) throw new MsFileSeedStoreError("integrity", "local Block 长度不正确");
  verifyBlock(bytes, Digest.fromHex(blockHashHex), signal);
  return bytes;
}

/**
 * 一次加载并验证 Seed 后，批量读取授权所需的 Block，避免每个 Block 都重读整份 Seed。
 */
export async function readLocalMsFileBlocks(input: {
  /** 当前 Owner 的 `msfiles/` 文件根。 */
  store: OwnerFileStore;
  /** 所有 Block 共同所属的 Seed Hash。 */
  seedHashHex: string;
  /** 按调用方需要的顺序提交的 Block Hash 清单；返回 Map 按 Hash 查询。 */
  blockHashHexes: readonly string[];
  /** 取消批量读取。 */
  signal?: AbortSignal;
}): Promise<Map<string, Uint8Array>> {
  const seedHashHex = assertSeedHashHex(input.seedHashHex);
  if (input.blockHashHexes.length === 0) return new Map();
  if (input.blockHashHexes.length > 64) fail("invalid-hash", "a local block batch cannot exceed 64 hashes");

  const requested = new Set<string>();
  for (const rawHash of input.blockHashHexes) {
    const hash = assertSeedHashHex(rawHash);
    if (requested.has(hash)) fail("invalid-hash", "a local block batch cannot contain duplicate hashes");
    requested.add(hash);
  }

  const descriptor = await readLocalMsFileSeed({
    store: input.store,
    seedHashHex,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const sourceSize = BigInt(descriptor.meta.fileSizeBytes);
  const seedSize = BigInt(descriptor.seedBytes.byteLength);
  const randomAccess = createSeedRandomAccess(descriptor.seedBytes);
  const blockIndices = new Map<string, bigint>();

  for (let index = 0; index < descriptor.meta.blockCount && blockIndices.size < requested.size; index += 1) {
    const digest = await readBlockHash(randomAccess, seedSize, BigInt(index), input.signal);
    const hash = digest.toHex();
    if (requested.has(hash)) blockIndices.set(hash, BigInt(index));
  }
  if (blockIndices.size !== requested.size) fail("missing-block", "one or more requested Blocks do not belong to the Seed");

  const hashes = [...requested];
  const blocks = new Map<string, Uint8Array>();
  await runPool(hashes.length, MSFILE_SEED_BLOCK_READ_CONCURRENCY, input.signal, async (index, signal) => {
    const hash = hashes[index]!;
    const blockIndex = blockIndices.get(hash);
    if (blockIndex === undefined) fail("missing-block", "requested Block does not belong to the Seed");
    const bytes = await getFile(input.store, blockPath(seedHashHex, hash), signal);
    if (!bytes) fail("missing-block", `local Block ${hash} is missing`);
    const expectedSize = Number(expectedBlockSize(sourceSize, blockIndex));
    if (bytes.byteLength !== expectedSize) fail("integrity", `local Block ${hash} has an unexpected size`);
    verifyBlock(bytes, Digest.fromHex(hash), signal);
    blocks.set(hash, bytes.slice());
  });
  return blocks;
}

/**
 * 读取并完整校验一个条目：元数据 -> 种子（`verifySeedForSourceSize`）-> 逐块
 * `verifyBlock` 后组装。任何缺块、长度或摘要不符都会失败，不返回部分内容。
 */
export async function readMsFileSeed(input: {
  store: OwnerFileStore;
  seedHashHex: string;
  signal?: AbortSignal;
  onProgress?(progress: MsFileSeedStoreProgress): void;
  /** 可选块读取通道：由 Coordinator 直读 owner 文件根，绕过页面端口并发上限。 */
  getBlock?(seedHashHex: string, blockHashHex: string, signal?: AbortSignal): Promise<Uint8Array | undefined>;
}): Promise<MsFileSeedReadResult> {
  const { store, signal, onProgress, getBlock } = input;
  const seedHashHex = assertSeedHashHex(input.seedHashHex);
  try {
    const metaBytes = await getFile(store, metaPath(seedHashHex), signal);
    if (!metaBytes) throw new MsFileSeedStoreError("missing-meta", "seed metadata is missing");
    const meta = parseMsFileSeedMeta(metaBytes, seedHashHex);
    const seedBytes = await getFile(store, seedPath(seedHashHex), signal);
    if (!seedBytes) throw new MsFileSeedStoreError("missing-seed", "seed file is missing");
    const sourceSize = BigInt(meta.fileSizeBytes);
    const info = await verifySeedForSourceSize([seedBytes], Digest.fromHex(seedHashHex), sourceSize, signal);
    const totalBlocks = Number(info.blockCount);
    const randomAccess = createSeedRandomAccess(seedBytes);
    const totalBytes = sourceSize.toString();
    const readBlock = getBlock === undefined
      ? (seedHash: string, blockHash: string, blockSignal: AbortSignal) => getFile(store, blockPath(seedHash, blockHash), blockSignal)
      : async (seedHash: string, blockHash: string, blockSignal: AbortSignal) => {
        try {
          return await getBlock(seedHash, blockHash, blockSignal);
        } catch (cause) {
          throw toStoreError(cause, "storage");
        }
      };
    const readConcurrency = getBlock === undefined ? MSFILE_SEED_BLOCK_READ_CONCURRENCY : MSFILE_SEED_WORKER_BLOCK_CONCURRENCY;
    const parts: Uint8Array[] = new Array(totalBlocks);
    let completedBlocks = 0;
    await runPool(totalBlocks, readConcurrency, signal, async (index, blockSignal) => {
      const blockIndex = BigInt(index);
      const digest = await readBlockHash(randomAccess, info.seedSize, blockIndex, blockSignal);
      const expectedSize = Number(expectedBlockSize(sourceSize, blockIndex));
      const bytes = await readBlock(seedHashHex, digest.toHex(), blockSignal);
      if (!bytes) throw new MsFileSeedStoreError("missing-block", `block ${index} is missing`);
      if (bytes.byteLength !== expectedSize) throw new MsFileSeedStoreError("integrity", `block ${index} has an unexpected size`);
      verifyBlock(bytes, digest, blockSignal);
      parts[index] = bytes;
      completedBlocks += 1;
      onProgress?.({
        phase: "reading-blocks",
        completedBytes: (completedBlocks === totalBlocks ? sourceSize : BigInt(completedBlocks) * BLOCK_SIZE_BIGINT).toString(),
        totalBytes,
        completedBlocks,
        totalBlocks,
      });
    });
    return { meta, seedBytes, parts };
  } catch (cause) {
    throw toStoreError(cause, "storage");
  }
}

/**
 * 校验条目：只做存在性与结构完整性检查，不计算 SHA-256。
 *
 * 1. 读 meta（缺失或损坏时按未检查处理，不当作失败）；
 * 2. 读种子：存在性 + 长度必须是 32 的整数倍；只有拿到合法种子才能解析块路径；
 * 3. 与 meta 交叉校验块数/种子长度（meta 存在时）；
 * 4. 列 `storage/<seedhash>/` 一次，按种子里的去重 hash 逐一比对块文件是否存在。
 */
export async function verifyMsFileSeed(input: {
  store: OwnerFileStore;
  seedHashHex: string;
  signal?: AbortSignal;
}): Promise<MsFileSeedVerifyResult> {
  const { store, signal } = input;
  const seedHashHex = assertSeedHashHex(input.seedHashHex);
  try {
    const metaBytes = await getFile(store, metaPath(seedHashHex), signal);
    let meta: MsFileSeedMeta | null = null;
    if (metaBytes) {
      try {
        meta = parseMsFileSeedMeta(metaBytes, seedHashHex);
      } catch {
        meta = null;
      }
    }
    const seedBytes = await getFile(store, seedPath(seedHashHex), signal);
    if (!seedBytes) {
      return {
        metaAvailable: meta !== null,
        seedPresent: false,
        seedValid: false,
        metaConsistent: meta !== null,
        blockCount: meta?.blockCount !== undefined ? String(meta.blockCount) : "0",
        missingBlocks: 0,
        complete: false,
      };
    }
    const seedValid = seedBytes.byteLength % 32 === 0;
    const blockCount = seedValid ? seedBytes.byteLength / 32 : 0;
    const metaConsistent = meta === null
      || (meta.blockCount === blockCount && BigInt(meta.seedSizeBytes) === BigInt(seedBytes.byteLength));
    if (!seedValid) {
      return { metaAvailable: meta !== null, seedPresent: true, seedValid: false, metaConsistent, blockCount: "0", missingBlocks: 0, complete: false };
    }
    const randomAccess = createSeedRandomAccess(seedBytes);
    const seedSize = BigInt(seedBytes.byteLength);
    const files = await listPrefix(store, `storage/${seedHashHex}/`, signal);
    const prefix = `storage/${seedHashHex}/`;
    const present = new Set<string>();
    for (const file of files) {
      if (file.path.startsWith(prefix)) present.add(file.path.slice(prefix.length));
    }
    const seen = new Set<string>();
    let missingBlocks = 0;
    for (let index = 0; index < blockCount; index += 1) {
      const digest = await readBlockHash(randomAccess, seedSize, BigInt(index), signal);
      const hex = digest.toHex();
      if (seen.has(hex)) continue;
      seen.add(hex);
      if (!present.has(hex)) missingBlocks += 1;
    }
    return {
      metaAvailable: meta !== null,
      seedPresent: true,
      seedValid: true,
      metaConsistent,
      blockCount: String(blockCount),
      missingBlocks,
      complete: metaConsistent && missingBlocks === 0,
    };
  } catch (cause) {
    throw toStoreError(cause, "storage");
  }
}

/**
 * 删除条目：先读种子（块路径的唯一权威），再删种子与元数据，最后按种子里的
 * 摘要逐个删除块。用摘要而不是列举 `storage/<hash>/`，避免一次性把所有块
 * 字节读进内存（Local IndexedDB 的列表会加载匹配对象的完整字节）。
 * 种子缺失或结构损坏时退回前缀列举。
 */
export async function deleteMsFileSeed(input: {
  store: OwnerFileStore;
  seedHashHex: string;
  signal?: AbortSignal;
}): Promise<void> {
  const { store, signal } = input;
  const seedHashHex = assertSeedHashHex(input.seedHashHex);
  try {
    const seedBytes = await getFile(store, seedPath(seedHashHex), signal);
    // 列表真值是 meta：先删它，条目立即从列表消失；再删种子和块。
    await deleteFile(store, metaPath(seedHashHex), signal);
    await deleteFile(store, seedPath(seedHashHex), signal);
    if (seedBytes && seedBytes.byteLength % 32 === 0) {
      const randomAccess = createSeedRandomAccess(seedBytes);
      const blockCount = seedBytes.byteLength / 32;
      const paths: string[] = [];
      const seen = new Set<string>();
      for (let index = 0; index < blockCount; index += 1) {
        const digest = await readBlockHash(randomAccess, BigInt(seedBytes.byteLength), BigInt(index), signal);
        const path = blockPath(seedHashHex, digest.toHex());
        if (seen.has(path)) continue;
        seen.add(path);
        paths.push(path);
      }
      await runPool(paths.length, MSFILE_SEED_BLOCK_WRITE_CONCURRENCY, signal, async (index, blockSignal) => {
        await deleteFile(store, paths[index]!, blockSignal);
      });
      return;
    }
    const blocks = await listPrefix(store, `storage/${seedHashHex}/`, signal);
    await runPool(blocks.length, MSFILE_SEED_BLOCK_WRITE_CONCURRENCY, signal, async (index, blockSignal) => {
      await deleteFile(store, blocks[index]!.path, blockSignal);
    });
  } catch (cause) {
    throw toStoreError(cause, "storage");
  }
}
