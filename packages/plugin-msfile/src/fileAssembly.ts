// packages/plugin-msfile/src/fileAssembly.ts
// 首页文件获取的文件级安全边界。
//
// 这里不实现 wire、hash 或付款逻辑；`msfile.service` 已经负责单个 Seed/
// Block 的内容校验。本文件只负责把已验证的内容按 Stat 元数据重组为文件，
// 并在转换 BigInt -> number 前确认数值落在本模块的安全边界内。

import {
  isValidMsFileHashHex,
  MSFILE_BLOCK_SIZE_BYTES,
  MSFILE_DIGEST_SIZE_BYTES,
  MSFILE_MAX_BLOCK_BYTES,
  MSFILE_MAX_SEED_BYTES,
  type MsFileReadResult,
} from "@keymaster/contracts";

/** 首页 Block Read 固定并发上限。 */
export const FILE_ASSEMBLY_MAX_BLOCK_CONCURRENCY = 8;

export type FileAssemblyErrorCode =
  | "invalid-file-size"
  | "seed-size-limit"
  | "seed-size-alignment"
  | "seed-block-count"
  | "invalid-block-hash"
  | "invalid-block-response"
  | "block-size-mismatch"
  | "block-count-mismatch"
  | "total-size-mismatch";

/** 文件组装失败时只携带稳定诊断码，不把远端原始错误带入 UI。 */
export class FileAssemblyError extends Error {
  constructor(public readonly code: FileAssemblyErrorCode) {
    super(`MSFile file assembly failed: ${code}`);
    this.name = "FileAssemblyError";
  }
}

export interface FileBlockPlanEntry {
  /** Block 在 Seed 中的位置；重复 hash 也会保留不同的位置。 */
  index: number;
  blockHashHex: string;
  /** 该位置必须返回的字节数。 */
  expectedSizeBytes: number;
}

export interface FileBlockPlan {
  fileSizeBytes: bigint;
  /** 规范计算出的 Block 数；通过长度校验后才转换为 number。 */
  blockCount: number;
  blocks: readonly FileBlockPlanEntry[];
}

/** 解析规范 uint64 十进制字符串；不接受空值、前导零或超出 uint64 的值。 */
export function parseMsFileUint64(input: unknown): bigint {
  if (typeof input !== "string" || !/^(0|[1-9][0-9]*)$/.test(input)) {
    throw new FileAssemblyError("invalid-file-size");
  }
  let value: bigint;
  try {
    value = BigInt(input);
  } catch {
    throw new FileAssemblyError("invalid-file-size");
  }
  if (value > 0xffffffffffffffffn) throw new FileAssemblyError("invalid-file-size");
  return value;
}

const UTF8_FILENAME_LIMIT_BYTES = 255;

/**
 * 把供应商建议文件名收敛为安全 basename，并执行 wire 的 255 UTF-8 字节上限。
 * 该函数不根据 MIME 猜扩展名；非法或清理后为空时直接回退到 Seed Hash。
 */
export function sanitizeMsFileFilename(
  recommendedFilename: unknown,
  seedHashHex: string,
): string {
  const fallback = seedHashHex;
  if (typeof recommendedFilename !== "string") return fallback;

  // 先取最后一个路径片段；再删除 NUL、C0/C1 控制字符和 DEL。这里不
  // `trim()`，避免静默改变一个本来合法的显示名，只在空结果时回退。
  let basename = recommendedFilename.split(/[\\/]/).at(-1) ?? "";
  basename = basename.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  if (basename === "." || basename === ".." || basename.length === 0) return fallback;

  const encoder = new TextEncoder();
  let safe = "";
  for (const character of Array.from(basename)) {
    const next = safe + character;
    if (encoder.encode(next).length > UTF8_FILENAME_LIMIT_BYTES) break;
    safe = next;
  }
  return safe.length > 0 && safe !== "." && safe !== ".." ? safe : fallback;
}

/** 按 MSFile 规范计算文件所需的 Block 数；空文件的 Block 数为 0。 */
export function expectedMsFileBlockCount(fileSizeBytes: bigint): bigint {
  if (fileSizeBytes < 0n) throw new FileAssemblyError("invalid-file-size");
  if (fileSizeBytes === 0n) return 0n;
  return (fileSizeBytes - 1n) / BigInt(MSFILE_BLOCK_SIZE_BYTES) + 1n;
}

function asBytes(input: Uint8Array | ArrayBuffer): Uint8Array {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

/**
 * 由 Seed 字节解析有序 Block Hash，并同时校验 Seed 长度与 Stat 文件大小。
 * 返回的 hash 数组不去重，保证重复 Block Hash 的每个位置都参与组装。
 */
export function parseSeedBlockPlan(
  seedContent: Uint8Array | ArrayBuffer,
  fileSizeInput: string | bigint,
): FileBlockPlan {
  const fileSizeBytes = typeof fileSizeInput === "bigint"
    ? fileSizeInput
    : parseMsFileUint64(fileSizeInput);
  if (fileSizeBytes < 0n || fileSizeBytes > 0xffffffffffffffffn) {
    throw new FileAssemblyError("invalid-file-size");
  }

  const bytes = asBytes(seedContent);
  if (bytes.length > MSFILE_MAX_SEED_BYTES) throw new FileAssemblyError("seed-size-limit");
  if (bytes.length % MSFILE_DIGEST_SIZE_BYTES !== 0) {
    throw new FileAssemblyError("seed-size-alignment");
  }

  const expectedCount = expectedMsFileBlockCount(fileSizeBytes);
  const actualCount = BigInt(bytes.length / MSFILE_DIGEST_SIZE_BYTES);
  if (actualCount !== expectedCount) throw new FileAssemblyError("seed-block-count");
  // Seed 的 wire 上限使这里的数组长度天然很小；显式检查后才转 number。
  if (actualCount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new FileAssemblyError("seed-block-count");
  }

  const hashes: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += MSFILE_DIGEST_SIZE_BYTES) {
    let hash = "";
    for (let i = 0; i < MSFILE_DIGEST_SIZE_BYTES; i += 1) {
      hash += bytes[offset + i]!.toString(16).padStart(2, "0");
    }
    hashes.push(hash);
  }
  return createMsFileBlockPlan(fileSizeBytes, hashes);
}

/**
 * 校验 Block 数量并建立每个位置的精确长度计划。
 * 只有剩余长度已确认不超过 256 KiB 后，才把它转换为 JS number。
 */
export function createMsFileBlockPlan(
  fileSizeInput: string | bigint,
  blockHashes: readonly string[],
): FileBlockPlan {
  const fileSizeBytes = typeof fileSizeInput === "bigint"
    ? fileSizeInput
    : parseMsFileUint64(fileSizeInput);
  const expectedCount = expectedMsFileBlockCount(fileSizeBytes);
  if (BigInt(blockHashes.length) !== expectedCount) {
    throw new FileAssemblyError("block-count-mismatch");
  }
  if (blockHashes.length > Number.MAX_SAFE_INTEGER) {
    throw new FileAssemblyError("block-count-mismatch");
  }

  const blocks: FileBlockPlanEntry[] = [];
  const blockSize = BigInt(MSFILE_BLOCK_SIZE_BYTES);
  for (let index = 0; index < blockHashes.length; index += 1) {
    const blockHashHex = blockHashes[index];
    if (!isValidMsFileHashHex(blockHashHex)) {
      throw new FileAssemblyError("invalid-block-hash");
    }
    const offset = BigInt(index) * blockSize;
    const remaining = fileSizeBytes - offset;
    if (remaining <= 0n) throw new FileAssemblyError("block-count-mismatch");
    const expectedSize = remaining < blockSize ? remaining : blockSize;
    if (expectedSize > BigInt(MSFILE_MAX_BLOCK_BYTES)) {
      throw new FileAssemblyError("block-size-mismatch");
    }
    // expectedSize <= 256 KiB，转换不会丢失精度。
    blocks.push({
      index,
      blockHashHex,
      expectedSizeBytes: Number(expectedSize),
    });
  }
  return { fileSizeBytes, blockCount: blockHashes.length, blocks };
}

/** 从 service 返回值提取严格的 BinaryField；不接受字符串或隐式类型。 */
export function extractMsFileReadBytes(
  response: MsFileReadResult,
  expectedHashHex: string,
): Uint8Array {
  if (!response || response.contentHashHex !== expectedHashHex) {
    throw new FileAssemblyError("invalid-block-response");
  }
  const content = response.content;
  if (!content || content.$type !== "binary" || !(content.bytes instanceof ArrayBuffer)) {
    throw new FileAssemblyError("invalid-block-response");
  }
  return new Uint8Array(content.bytes);
}

/** 校验一个 Block 响应的内容哈希字段和精确位置长度。 */
export function validateMsFileBlockResponse(
  response: MsFileReadResult,
  block: FileBlockPlanEntry,
): Uint8Array {
  const bytes = extractMsFileReadBytes(response, block.blockHashHex);
  if (bytes.length !== block.expectedSizeBytes) {
    throw new FileAssemblyError("block-size-mismatch");
  }
  return bytes;
}

/**
 * 按计划顺序验证并返回 Blob 可用的有序 parts。
 * 这里再次验证长度，避免调用方绕过 worker pool 直接提交不完整数组。
 */
export function assembleMsFileParts(
  plan: FileBlockPlan,
  blockBytes: readonly (Uint8Array | undefined)[],
): Uint8Array[] {
  if (plan.blocks.length !== plan.blockCount || blockBytes.length !== plan.blockCount) {
    throw new FileAssemblyError("block-count-mismatch");
  }
  const parts: Uint8Array[] = [];
  let total = 0n;
  for (const block of plan.blocks) {
    const bytes = blockBytes[block.index];
    if (!bytes || bytes.length !== block.expectedSizeBytes) {
      throw new FileAssemblyError("block-size-mismatch");
    }
    parts.push(bytes);
    total += BigInt(bytes.length);
  }
  if (total !== plan.fileSizeBytes) throw new FileAssemblyError("total-size-mismatch");
  return parts;
}

export interface VerifiedBlockProgress {
  index: number;
  verifiedBytes: number;
}

export interface ReadMsFileBlocksOptions {
  signal?: AbortSignal;
  onVerified?(progress: VerifiedBlockProgress): void;
  /** 生产代码固定使用 8；参数仅供单测验证有界 worker 行为。 */
  maxConcurrency?: number;
}

function createAbortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

/**
 * 固定大小 worker pool 读取 Block。
 *
 * 关键不变量：最多 8 个不同 Hash 的 `readBlock` 同时 active；失败或 Abort
 * 后立即停止继续取新 Hash，并取消仍在途的旧请求。Seed 允许多个位置引用
 * 同一个 Block Hash，因此同 Hash 只发起一次网络读取，再复用到每个位置，
 * 避免触发供应商“同 Hash 新请求取消旧请求”的协议语义。
 */
export async function readMsFileBlocksWithWorkerPool(
  plan: FileBlockPlan,
  readBlock: (blockHashHex: string, signal: AbortSignal) => Promise<MsFileReadResult>,
  options: ReadMsFileBlocksOptions = {},
): Promise<Uint8Array[]> {
  if (plan.blockCount === 0) return [];
  const requestedConcurrency = options.maxConcurrency === undefined
    ? FILE_ASSEMBLY_MAX_BLOCK_CONCURRENCY
    : Number.isFinite(options.maxConcurrency)
      ? Math.floor(options.maxConcurrency)
      : 1;
  const maxConcurrency = Math.max(
    1,
    Math.min(FILE_ASSEMBLY_MAX_BLOCK_CONCURRENCY, requestedConcurrency),
  );

  const controller = new AbortController();
  const parentSignal = options.signal;
  const abortFromParent = () => controller.abort();
  if (parentSignal?.aborted) controller.abort();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });

  const positionsByHash = new Map<string, number[]>();
  const uniqueBlocks: FileBlockPlanEntry[] = [];
  for (const block of plan.blocks) {
    const positions = positionsByHash.get(block.blockHashHex);
    if (positions) {
      positions.push(block.index);
    } else {
      positionsByHash.set(block.blockHashHex, [block.index]);
      uniqueBlocks.push(block);
    }
  }

  const results: Array<Uint8Array | undefined> = new Array(plan.blockCount);
  let nextIndex = 0;
  let firstFailure: unknown;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (controller.signal.aborted) throw createAbortError();
      const index = nextIndex;
      nextIndex += 1;
      if (index >= uniqueBlocks.length) return;
      const block = uniqueBlocks[index]!;
      try {
        const response = await readBlock(block.blockHashHex, controller.signal);
        if (controller.signal.aborted) throw createAbortError();
        const bytes = validateMsFileBlockResponse(response, block);
        if (controller.signal.aborted) throw createAbortError();
        for (const position of positionsByHash.get(block.blockHashHex) ?? []) {
          const positionedBlock = plan.blocks[position]!;
          // 位置的期望长度可能不同；即使 Hash 相同也要逐位置复核，
          // 不允许把一个不匹配的响应静默复制到最终文件。
          const positionedBytes = position === block.index
            ? bytes
            : validateMsFileBlockResponse(response, positionedBlock);
          results[position] = positionedBytes;
          options.onVerified?.({ index: position, verifiedBytes: positionedBytes.length });
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          firstFailure = error;
          controller.abort();
        }
        throw error;
      }
    }
  };

  try {
    const workers = Array.from({ length: Math.min(maxConcurrency, uniqueBlocks.length) }, () => worker());
    const settled = await Promise.allSettled(workers);
    if (parentSignal?.aborted) throw createAbortError();
    if (firstFailure !== undefined) throw firstFailure;
    const rejected = settled.find((entry): entry is PromiseRejectedResult => entry.status === "rejected");
    if (rejected) throw rejected.reason;
    return assembleMsFileParts(plan, results);
  } finally {
    parentSignal?.removeEventListener("abort", abortFromParent);
    controller.abort();
  }
}

/** 仅在单元测试或后续调用方需要时提供一个连续副本；首页下载优先使用 parts。 */
export function assembleMsFileBytes(
  plan: FileBlockPlan,
  blockBytes: readonly (Uint8Array | undefined)[],
): Uint8Array {
  const parts = assembleMsFileParts(plan, blockBytes);
  // 首页允许的文件上限远低于 JS TypedArray 的安全索引范围；调用方应先做
  // 256 MiB 边界判断，再调用这个会产生连续副本的辅助函数。
  if (plan.fileSizeBytes > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new FileAssemblyError("total-size-mismatch");
  }
  const result = new Uint8Array(Number(plan.fileSizeBytes));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
