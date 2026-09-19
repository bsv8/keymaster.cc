// MSFile 桶存储服务：Window 单元使用 Host 预绑定的 owner 文件句柄，对本桶
// `msfiles/` 下的 seeds、storage、meta 执行上传、列表、读回校验与删除。
//
// 服务不接触 Provider、凭据或浏览器持久化；所有远程 I/O 都由 Worker 侧的
// OwnerFileStore 完成。MasterSeed 算法全部来自 `masterseed` 官方 SDK。

import { defineCapability } from "webloom-framework";
import type { MsFileCoordinatorControl, OwnerFileStore } from "@keymaster/contracts";
import {
  MsFileSeedStoreError,
  deleteMsFileSeed,
  listMsFileSeeds,
  readMsFileSeed,
  storeMsFileSeed,
  verifyMsFileSeed,
  type MsFileSeedEntry,
  type MsFileSeedReadResult,
  type MsFileSeedSource,
  type MsFileSeedStoreProgress,
  type MsFileSeedUploadResult,
  type MsFileSeedVerifyResult,
} from "./storage/msfileSeedStore.js";
import { toArrayBuffer } from "./sha256.js";

/** 单次上传/读取的浏览器分片大小。 */
export const MSFILE_BUCKET_READ_CHUNK_BYTES = 1024 * 1024;

export interface MsFileBucketOperationOptions {
  signal?: AbortSignal;
  onProgress?(progress: MsFileSeedStoreProgress): void;
}

export interface MsFileBucketService {
  list(options?: { signal?: AbortSignal }): Promise<MsFileSeedEntry[]>;
  upload(source: MsFileSeedSource, options?: MsFileBucketOperationOptions): Promise<MsFileSeedUploadResult>;
  read(seedHashHex: string, options?: MsFileBucketOperationOptions): Promise<MsFileSeedReadResult>;
  verify(seedHashHex: string, options?: MsFileBucketOperationOptions): Promise<MsFileSeedVerifyResult>;
  remove(seedHashHex: string, options?: { signal?: AbortSignal }): Promise<void>;
}

export const MSFILE_BUCKET_SERVICE_CAPABILITY = defineCapability<MsFileBucketService>({
  kind: "local",
  id: "msfile.bucket.service",
  version: "1",
});

/**
 * 浏览器 `File` -> 上传源。`File` 只在当前窗口内存中使用；`stream()` 供
 * 种子生成使用，`read()` 供逐块写入使用，两次都直接读本地文件。
 */
export function createBrowserMsFileSeedSource(file: File): MsFileSeedSource {
  if (!file || typeof file.slice !== "function") throw new Error("a browser File is required");
  const size = BigInt(file.size);
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("file is too large for this browser");
  const chunkBytes = BigInt(MSFILE_BUCKET_READ_CHUNK_BYTES);
  return {
    name: typeof file.name === "string" ? file.name : "",
    mediaType: typeof file.type === "string" ? file.type : "",
    size,
    async *stream({ signal } = {}) {
      for (let offset = 0n; offset < size; offset += chunkBytes) {
        if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
        const end = offset + chunkBytes < size ? offset + chunkBytes : size;
        yield new Uint8Array(await file.slice(Number(offset), Number(end)).arrayBuffer());
      }
    },
    async read(offset, length, { signal } = {}) {
      if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
      const end = offset + BigInt(length);
      const buffer = await file.slice(Number(offset), Number(end)).arrayBuffer();
      return new Uint8Array(buffer);
    },
  };
}

export interface MsFileBucketServiceDeps {
  /** Host 预绑定的 owner 文件根句柄（`<owner>/msfiles/`）。 */
  store: OwnerFileStore;
  /** Coordinator 控制面：块写入绕过页面 storage 数据面的端口并发上限。 */
  coordinator: MsFileCoordinatorControl;
  now?(): number;
}

/** 用 Host 预绑定的文件句柄构造服务；句柄生命周期由 Host 拥有。 */
export function createMsFileBucketService(deps: MsFileBucketServiceDeps): MsFileBucketService {
  const { store, coordinator } = deps;
  if (!store || typeof store.put !== "function" || typeof store.list !== "function") {
    throw new Error("MSFile bucket file storage handle is required");
  }
  // 生产环境始终提供 msfileControl；旧夹具缺省时退回句柄逐块写入。
  const canUseWorkerBlocks = typeof coordinator?.msfileControl === "function";
  const now = deps.now;
  const withSignal = (signal: AbortSignal | undefined): { signal?: AbortSignal } =>
    signal === undefined ? {} : { signal };
  const putBlock = async (
    seedHashHex: string,
    blockHashHex: string,
    bytes: Uint8Array,
    signal: AbortSignal | undefined,
  ): Promise<void> => {
    if (signal?.aborted) throw new MsFileSeedStoreError("cancelled", "block write was cancelled");
    // 块字节必须以 ArrayBuffer 过 RPC：Uint8Array 的 DTO 校验是 O(bytes)。
    const result = await coordinator.msfileControl({ type: "bucket.put-block", seedHashHex, blockHashHex, bytes: toArrayBuffer(bytes) });
    if (result.status === "ok") return;
    if (result.status === "locked" || result.status === "stale-epoch") {
      throw new MsFileSeedStoreError("cancelled", "MSFile session changed during block write");
    }
    const message = "message" in result && typeof result.message === "string" ? result.message : "MSFile block write failed";
    throw new MsFileSeedStoreError("storage", message);
  };
  const getBlock = async (
    seedHashHex: string,
    blockHashHex: string,
    signal: AbortSignal | undefined,
  ): Promise<Uint8Array | undefined> => {
    if (signal?.aborted) throw new MsFileSeedStoreError("cancelled", "block read was cancelled");
    const result = await coordinator.msfileControl({ type: "bucket.get-block", seedHashHex, blockHashHex });
    if (result.status === "ok") {
      const value = (result as { value?: unknown }).value;
      if (value instanceof ArrayBuffer) return new Uint8Array(value);
      throw new MsFileSeedStoreError("storage", "MSFile block read returned an invalid payload");
    }
    if (result.status === "locked" || result.status === "stale-epoch") {
      throw new MsFileSeedStoreError("cancelled", "MSFile session changed during block read");
    }
    if ("code" in result && result.code === "msfile_content_not_found") return undefined;
    const message = "message" in result && typeof result.message === "string" ? result.message : "MSFile block read failed";
    throw new MsFileSeedStoreError("storage", message);
  };
  return {
    list: (listOptions = {}) => listMsFileSeeds({ store, ...withSignal(listOptions.signal) }),
    upload: (source, uploadOptions = {}) => storeMsFileSeed({
      store,
      source,
      ...(canUseWorkerBlocks
        ? { putBlock: (seedHashHex: string, blockHashHex: string, bytes: Uint8Array, signal: AbortSignal | undefined) => putBlock(seedHashHex, blockHashHex, bytes, signal) }
        : {}),
      ...withSignal(uploadOptions.signal),
      ...(uploadOptions.onProgress === undefined ? {} : { onProgress: uploadOptions.onProgress }),
      ...(now === undefined ? {} : { now }),
    }),
    read: (seedHashHex, readOptions = {}) => readMsFileSeed({
      store,
      seedHashHex,
      ...(canUseWorkerBlocks
        ? { getBlock: (hash: string, blockHash: string, signal: AbortSignal | undefined) => getBlock(hash, blockHash, signal) }
        : {}),
      ...withSignal(readOptions.signal),
      ...(readOptions.onProgress === undefined ? {} : { onProgress: readOptions.onProgress }),
    }),
    verify: (seedHashHex, verifyOptions = {}) => verifyMsFileSeed({
      store,
      seedHashHex,
      ...(canUseWorkerBlocks
        ? { getBlock: (hash: string, blockHash: string, signal: AbortSignal | undefined) => getBlock(hash, blockHash, signal) }
        : {}),
      ...withSignal(verifyOptions.signal),
      ...(verifyOptions.onProgress === undefined ? {} : { onProgress: verifyOptions.onProgress }),
    }),
    remove: async (seedHashHex, removeOptions = {}) => {
      await deleteMsFileSeed({ store, seedHashHex, ...withSignal(removeOptions.signal) });
    },
  };
}
