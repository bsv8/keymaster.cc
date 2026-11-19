// MSFile 桶存储服务：Window 单元使用 Host 预绑定的 owner 文件句柄，对本桶
// `msfiles/` 下的 seeds、storage、meta 执行上传、列表、读回校验与删除。
//
// 服务不接触 Provider、凭据或浏览器持久化；所有远程 I/O 都由 Worker 侧的
// ModuleFileStore 完成。MasterSeed 算法全部来自 `masterseed` 官方 SDK。

import { defineCapability } from "webloom-framework";
import type { MsFileBitfsTaskSnapshot, MsFileCoordinatorControl, BorrowedModuleFileStore } from "@keymaster/contracts";
import {
  MsFileSeedStoreError,
  listMsFileSeeds,
  readMsFileSeed,
  storeMsFileSeed,
  updateMsFileSeedFileName,
  verifyMsFileSeed,
  type MsFileSeedEntry,
  type MsFileSeedMeta,
  type MsFileSeedReadResult,
  type MsFileSeedSource,
  type MsFileSeedStoreProgress,
  type MsFileSeedUploadResult,
  type MsFileSeedVerifyResult,
} from "./storage/msfileSeedStore.js";

/** 单次上传/读取的浏览器分片大小。 */
export const MSFILE_BUCKET_READ_CHUNK_BYTES = 1024 * 1024;

export interface MsFileBucketOperationOptions {
  signal?: AbortSignal;
  onProgress?(progress: MsFileSeedStoreProgress): void;
}

export interface MsFileBucketService {
  list(options?: { signal?: AbortSignal }): Promise<MsFileSeedEntry[]>;
  /** 读取 Worker 持久化的买方任务摘要；报价、交易和签名原文不会返回页面。 */
  readDemandMonitor?(): Promise<import("@keymaster/contracts").MsFileDemandMonitorSnapshot>;
  listBitfsTasks?(): Promise<MsFileBitfsTaskSnapshot[]>;
  listBitfsFundingPools?(): Promise<import("@keymaster/contracts").MsFileBitfsFundingPoolSnapshot[]>;
  deleteBitfsDownload?(seedHashHex: string): Promise<{ recoveryPending: boolean }>;
  deleteBitfsHistory?(seedHashHex: string, sessionId: string): Promise<void>;
  /** 对仍有在线卖方会话的任务发起取消；Worker 负责写日志与关池。 */
  cancelBitfsTask?(seedHashHex: string, sessionId: string): Promise<void>;
  /** 用户主动核对旧费用池资金。 */
  reconcileBitfsTask?(seedHashHex: string, sessionId: string): Promise<void>;
  /** 从任务页选择报价并开始购买；单块最高价按当前文件单独固定。 */
  startBitfsTask?(seedHashHex: string, sessionId: string, maxFullBlockPriceSatoshis: string): Promise<void>;
  /** 停止当前 Seed 继续接收报价；已开始购买的资金恢复责任保留。 */
  cancelBitfsDemand?(seedHashHex: string): Promise<void>;
  upload(source: MsFileSeedSource, options?: MsFileBucketOperationOptions): Promise<MsFileSeedUploadResult>;
  read(seedHashHex: string, options?: MsFileBucketOperationOptions): Promise<MsFileSeedReadResult>;
  verify(seedHashHex: string, options?: MsFileBucketOperationOptions): Promise<MsFileSeedVerifyResult>;
  remove(seedHashHex: string, options?: { signal?: AbortSignal }): Promise<void>;
  /** 重命名自有文件并通知采集队列；购买/下载所得不经此入口。 */
  rename?(seedHashHex: string, fileName: string, options?: { signal?: AbortSignal }): Promise<MsFileSeedMeta>;
  /** 设置文件介绍（采集自有存储，不改动原始内容）并通知采集队列。 */
  updateDescription?(seedHashHex: string, description: string): Promise<void>;
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
  store: BorrowedModuleFileStore;
  /** 钱包控制和只读资金视图。 */
  coordinator: MsFileCoordinatorControl;
  buyer?: Pick<import("./bitfs/buyerWindowRuntime.js").BitfsBuyerWindowRuntime, "startBitfsPurchase" | "cancelBitfsPurchase" | "cancelBitfsDemand" | "deleteBitfsDownload">;
  now?(): number;
  /**
   * 自有文件完整入库后的通知（上传成功、重命名成功时调用）。
   * 购买/下载经 commitPurchasedMsFileContent 入库的不经过此回调。
   * 失败只影响本次通知时机，每小时调度会补齐。
   */
  onStored?(meta: MsFileSeedMeta): void;
}

/** 用 Host 预绑定的文件句柄构造服务；句柄生命周期由 Host 拥有。 */
export function createMsFileBucketService(deps: MsFileBucketServiceDeps): MsFileBucketService {
  const { store, coordinator } = deps;
  if (!store || typeof store.put !== "function" || typeof store.list !== "function") {
    throw new Error("MSFile bucket file storage handle is required");
  }
  const now = deps.now;
  const withSignal = (signal: AbortSignal | undefined): { signal?: AbortSignal } =>
    signal === undefined ? {} : { signal };
  return {
    list: (listOptions = {}) => listMsFileSeeds({ store, ...withSignal(listOptions.signal) }),
    async readDemandMonitor() {
      const result = await coordinator.msfileControl({ type: "bitfs.demands.monitor" });
      if (result.status !== "ok") throw new Error("message" in result ? result.message : "文件需求观察当前不可用");
      return result.value as import("@keymaster/contracts").MsFileDemandMonitorSnapshot;
    },
    async listBitfsTasks() {
      const result = await coordinator.msfileControl({ type: "bitfs.purchase.tasks.list" });
      if (result.status !== "ok") throw new MsFileSeedStoreError("storage", "无法读取 BitFS 购买任务摘要");
      if (!Array.isArray(result.value)) throw new MsFileSeedStoreError("storage", "BitFS 购买任务摘要格式无效");
      return result.value as MsFileBitfsTaskSnapshot[];
    },
    async listBitfsFundingPools() {
      const result = await coordinator.msfileControl({ type: "bitfs.funding.pools.list" });
      if (result.status !== "ok") throw new MsFileSeedStoreError("storage", "无法读取费用池账本");
      return result.value as import("@keymaster/contracts").MsFileBitfsFundingPoolSnapshot[];
    },
    async deleteBitfsDownload(seedHashHex) {
      if (!deps.buyer) throw new MsFileSeedStoreError("storage", "下载页面不可用");
      return deps.buyer.deleteBitfsDownload(seedHashHex);
    },
    async deleteBitfsHistory(seedHashHex, sessionId) {
      const result = await coordinator.msfileControl({ type: "bitfs.purchase.history.delete", seedHashHex, sessionId });
      if (result.status !== "ok") throw new MsFileSeedStoreError("storage", "message" in result ? String(result.message) : "采购历史删除失败");
    },
    async cancelBitfsTask(seedHashHex) {
      if (!deps.buyer) throw new MsFileSeedStoreError("storage", "下载页面不可用");
      await deps.buyer.cancelBitfsPurchase(seedHashHex);
    },
    async reconcileBitfsTask(seedHashHex, sessionId) {
      const result = await coordinator.msfileControl({ type: "bitfs.purchase.reconcile", seedHashHex, sessionId });
      if (result.status !== "ok") throw new MsFileSeedStoreError("storage", "message" in result ? String(result.message) : "核对资金状态失败");
    },
    async startBitfsTask(seedHashHex, sessionId, maxFullBlockPriceSatoshis) {
      if (!deps.buyer) throw new MsFileSeedStoreError("storage", "下载页面不可用");
      await deps.buyer.startBitfsPurchase(seedHashHex, sessionId, maxFullBlockPriceSatoshis);
    },
    async cancelBitfsDemand(seedHashHex) {
      await deps.buyer?.cancelBitfsDemand(seedHashHex);
    },
    upload: (source, uploadOptions = {}) => storeMsFileSeed({
      store,
      source,
      ...withSignal(uploadOptions.signal),
      ...(uploadOptions.onProgress === undefined ? {} : { onProgress: uploadOptions.onProgress }),
      ...(now === undefined ? {} : { now }),
    }).then((result) => {
      // 只有自有导入走此路径：完整入库后通知采集队列。
      // 购买/下载经 commitPurchasedMsFileContent 入库，不触发。
      try {
        deps.onStored?.(result.meta);
      } catch {
        // 通知失败只影响本次时机，每小时调度会补齐，不污染上传结果。
      }
      return result;
    }),
    read: (seedHashHex, readOptions = {}) => readMsFileSeed({
      store,
      seedHashHex,
      ...withSignal(readOptions.signal),
      ...(readOptions.onProgress === undefined ? {} : { onProgress: readOptions.onProgress }),
    }),
    verify: (seedHashHex, verifyOptions = {}) => verifyMsFileSeed({
      store,
      seedHashHex,
      ...withSignal(verifyOptions.signal),
      ...(verifyOptions.onProgress === undefined ? {} : { onProgress: verifyOptions.onProgress }),
    }),
    remove: async (seedHashHex, removeOptions = {}) => {
      if (removeOptions.signal?.aborted) throw new MsFileSeedStoreError("cancelled", "删除已取消");
      const result = await coordinator.msfileControl({ type: "bucket.delete-file", seedHashHex });
      if (result.status !== "ok") throw new MsFileSeedStoreError("storage", "message" in result ? String(result.message) : "文件与采购历史删除失败");
    },
    rename: async (seedHashHex, fileName, renameOptions = {}) => {
      const meta = await updateMsFileSeedFileName({ store, seedHashHex, fileName, ...withSignal(renameOptions.signal) });
      try {
        deps.onStored?.(meta);
      } catch {
        // 同上传：通知失败不污染重命名结果。
      }
      return meta;
    },
    updateDescription: async (seedHashHex, description) => {
      const result = await coordinator.msfileControl({ type: "collector.description.set", seedHashHex, description });
      if (result.status !== "ok") throw new MsFileSeedStoreError("storage", "message" in result ? String(result.message) : "介绍保存失败");
    },
  };
}
