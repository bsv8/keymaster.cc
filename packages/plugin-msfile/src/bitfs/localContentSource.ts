// Coordinator Worker 内的 local MSFile 内容来源。
//
// 本模块只持有 Host 预绑定的当前 Owner `msfiles/` 文件句柄，不接触 Provider、
// React 或 libp2p。local 读取永远不编码 `/msfile/1.0.0` Frame。

import type { OwnerFileStore, MsFileSourceStat } from "@keymaster/contracts";
import { MSFILE_LOCAL_SOURCE_ID } from "@keymaster/contracts";
import {
  inspectLocalMsFileSeed,
  isMsFileSeedStoreError,
  readLocalMsFileBlock,
  readLocalMsFileSeed,
} from "../storage/msfileSeedStore.js";

/** Worker-safe 的本地内容读取端口。 */
export interface MsFileLocalContentSource {
  /** 检查完整内容；缺失或损坏时返回 null，不能误报 available。 */
  stat(seedHashHex: string, signal?: AbortSignal): Promise<Extract<MsFileSourceStat, { sourceKind: "local-bitfs"; status: "available" }> | null>;
  /** 读取并验证原始 Seed 字节。 */
  readSeed(seedHashHex: string, signal?: AbortSignal): Promise<Uint8Array>;
  /** 在指定 Seed 路径下读取并验证 Block。 */
  readBlock(seedHashHex: string, blockHashHex: string, signal?: AbortSignal): Promise<Uint8Array>;
}

/** 使用当前 Owner 文件根创建 local 来源。 */
export function createMsFileLocalContentSource(store: OwnerFileStore): MsFileLocalContentSource {
  if (!store || typeof store.get !== "function" || typeof store.list !== "function") {
    throw new TypeError("local MSFile 需要当前 Owner 的文件存储句柄");
  }
  // 已发现的完整性失败只保存在当前 Worker 派生状态；重建 runtime 或后续
  // 明确的内容变更会重建来源。这样失败后的 Stat 不会再次误报 available。
  const invalidSeeds = new Set<string>();
  const rememberFailure = (seedHashHex: string, error: unknown): never => {
    if (!(error instanceof DOMException && error.name === "AbortError")
      && !(isMsFileSeedStoreError(error) && error.code === "cancelled")) invalidSeeds.add(seedHashHex);
    throw error;
  };
  return {
    async stat(seedHashHex, signal) {
      if (invalidSeeds.has(seedHashHex)) return null;
      const descriptor = await inspectLocalMsFileSeed({
        store,
        seedHashHex,
        ...(signal === undefined ? {} : { signal }),
      });
      if (!descriptor) return null;
      return {
        sourceId: MSFILE_LOCAL_SOURCE_ID,
        sourceKind: "local-bitfs",
        status: "available",
        recommendedFilename: descriptor.meta.fileName,
        fileSizeBytes: descriptor.meta.fileSizeBytes,
        mediaType: descriptor.meta.mediaType,
      };
    },
    async readSeed(seedHashHex, signal) {
      try {
        const descriptor = await readLocalMsFileSeed({
          store,
          seedHashHex,
          ...(signal === undefined ? {} : { signal }),
        });
        return descriptor.seedBytes.slice();
      } catch (error) {
        return rememberFailure(seedHashHex, error);
      }
    },
    async readBlock(seedHashHex, blockHashHex, signal) {
      try {
        const bytes = await readLocalMsFileBlock({
          store,
          seedHashHex,
          blockHashHex,
          ...(signal === undefined ? {} : { signal }),
        });
        return bytes.slice();
      } catch (error) {
        return rememberFailure(seedHashHex, error);
      }
    },
  };
}
