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
  verifySeed,
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
export const MSFILE_SEED_BLOCK_READ_CONCURRENCY = 4;

const SEED_FILE_PATTERN = /^seeds\/([0-9a-f]{64})\.ms$/u;
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

/** 列表条目：种子存在为准，元数据缺失/损坏时为 null。 */
export interface MsFileSeedEntry {
  seedHashHex: string;
  /** Provider 报告的种子文件字节数；Provider 不提供时省略。 */
  seedFileSizeBytes?: string;
  meta: MsFileSeedMeta | null;
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

export interface MsFileSeedVerifyResult {
  /** 元数据是否存在且合法；缺失时只验证种子本身。 */
  metaAvailable: boolean;
  blockCount: string;
  verifiedBlocks: number;
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
}): Promise<MsFileSeedUploadResult> {
  const { store, source, signal, onProgress } = input;
  const now = input.now ?? Date.now;
  try {
    assertSource(source);
    const seed = await createSeedBytesFromSource(source, signal, onProgress);
    const seedHashHex = seed.seedHashHex;
    const randomAccess = createSeedRandomAccess(seed.seedBytes);
    const totalBlocks = Number(seed.blockCount);
    const totalBytes = seed.sourceSize.toString();
    let completedBlocks = 0;
    await runPool(totalBlocks, MSFILE_SEED_BLOCK_WRITE_CONCURRENCY, signal, async (index, blockSignal) => {
      const blockIndex = BigInt(index);
      const digest = await readBlockHash(randomAccess, seed.seedSize, blockIndex, blockSignal);
      const expectedSize = Number(expectedBlockSize(seed.sourceSize, blockIndex));
      const bytes = await source.read(blockIndex * BLOCK_SIZE_BIGINT, expectedSize, { signal: blockSignal });
      if (bytes.byteLength !== expectedSize) throw new MsFileSeedStoreError("source-changed", "source block size changed while storing");
      verifyBlock(bytes, digest, blockSignal);
      await putFile(store, blockPath(seedHashHex, digest.toHex()), bytes, blockSignal);
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
    return { entry: { seedHashHex, seedFileSizeBytes: meta.seedSizeBytes, meta }, meta };
  } catch (cause) {
    throw toStoreError(cause, "storage");
  }
}

/** 列出全部种子条目：`seeds/` 为真值，`meta/` 按 hash join，损坏按缺失处理。 */
export async function listMsFileSeeds(input: {
  store: OwnerFileStore;
  signal?: AbortSignal;
}): Promise<MsFileSeedEntry[]> {
  const { store, signal } = input;
  try {
    const [seedFiles, metaFiles] = await Promise.all([
      listPrefix(store, "seeds/", signal),
      listPrefix(store, "meta/", signal),
    ]);
    const seedSizes = new Map<string, number | undefined>();
    for (const file of seedFiles) {
      const match = SEED_FILE_PATTERN.exec(file.path);
      if (match?.[1]) seedSizes.set(match[1], file.size);
    }
    const metaHashes = new Set<string>();
    for (const file of metaFiles) {
      const match = META_FILE_PATTERN.exec(file.path);
      if (match?.[1] && seedSizes.has(match[1])) metaHashes.add(match[1]);
    }
    const metas = new Map<string, MsFileSeedMeta>();
    const hashes = [...metaHashes];
    await runPool(hashes.length, MSFILE_SEED_BLOCK_READ_CONCURRENCY, signal, async (index, itemSignal) => {
      const hash = hashes[index]!;
      try {
        const bytes = await getFile(store, metaPath(hash), itemSignal);
        if (!bytes) return;
        const meta = parseMsFileSeedMeta(bytes, hash);
        const seedSize = seedSizes.get(hash);
        if (seedSize !== undefined && BigInt(meta.seedSizeBytes) !== BigInt(seedSize)) return;
        metas.set(hash, meta);
      } catch {
        // 损坏或不可读的元数据按缺失处理；不影响其它条目。
      }
    });
    const entries: MsFileSeedEntry[] = [...seedSizes.entries()].map(([hash, size]) => ({
      seedHashHex: hash,
      ...(size === undefined ? {} : { seedFileSizeBytes: String(size) }),
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
 * 读取并完整校验一个条目：元数据 -> 种子（`verifySeedForSourceSize`）-> 逐块
 * `verifyBlock` 后组装。任何缺块、长度或摘要不符都会失败，不返回部分内容。
 */
export async function readMsFileSeed(input: {
  store: OwnerFileStore;
  seedHashHex: string;
  signal?: AbortSignal;
  onProgress?(progress: MsFileSeedStoreProgress): void;
}): Promise<MsFileSeedReadResult> {
  const { store, signal, onProgress } = input;
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
    const parts: Uint8Array[] = new Array(totalBlocks);
    let completedBlocks = 0;
    await runPool(totalBlocks, MSFILE_SEED_BLOCK_READ_CONCURRENCY, signal, async (index, blockSignal) => {
      const blockIndex = BigInt(index);
      const digest = await readBlockHash(randomAccess, info.seedSize, blockIndex, blockSignal);
      const expectedSize = Number(expectedBlockSize(sourceSize, blockIndex));
      const bytes = await getFile(store, blockPath(seedHashHex, digest.toHex()), blockSignal);
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

/** 校验条目。元数据缺失时只验证种子文件本身；返回块数供 UI 展示。 */
export async function verifyMsFileSeed(input: {
  store: OwnerFileStore;
  seedHashHex: string;
  signal?: AbortSignal;
  onProgress?(progress: MsFileSeedStoreProgress): void;
}): Promise<MsFileSeedVerifyResult> {
  const { store, signal, onProgress } = input;
  const seedHashHex = assertSeedHashHex(input.seedHashHex);
  try {
    const metaBytes = await getFile(store, metaPath(seedHashHex), signal);
    if (!metaBytes) {
      const seedBytes = await getFile(store, seedPath(seedHashHex), signal);
      if (!seedBytes) throw new MsFileSeedStoreError("missing-seed", "seed file is missing");
      const info = await verifySeed([seedBytes], Digest.fromHex(seedHashHex), signal);
      return { metaAvailable: false, blockCount: info.blockCount.toString(), verifiedBlocks: 0 };
    }
    const result = await readMsFileSeed({ store, seedHashHex, signal, ...(onProgress === undefined ? {} : { onProgress }) });
    return { metaAvailable: true, blockCount: String(result.meta.blockCount), verifiedBlocks: result.meta.blockCount };
  } catch (cause) {
    throw toStoreError(cause, "storage");
  }
}

/** 删除条目：先种子、再元数据、最后该种子目录下的全部块。 */
export async function deleteMsFileSeed(input: {
  store: OwnerFileStore;
  seedHashHex: string;
  signal?: AbortSignal;
}): Promise<void> {
  const { store, signal } = input;
  const seedHashHex = assertSeedHashHex(input.seedHashHex);
  try {
    await deleteFile(store, seedPath(seedHashHex), signal);
    await deleteFile(store, metaPath(seedHashHex), signal);
    const blocks = await listPrefix(store, `storage/${seedHashHex}/`, signal);
    await runPool(blocks.length, MSFILE_SEED_BLOCK_WRITE_CONCURRENCY, signal, async (index, blockSignal) => {
      await deleteFile(store, blocks[index]!.path, blockSignal);
    });
  } catch (cause) {
    throw toStoreError(cause, "storage");
  }
}
