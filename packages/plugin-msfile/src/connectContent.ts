import type { BinaryField, BorrowedModuleFileStore, MsFileBitfsDemandSnapshot, MsFileService } from "@keymaster/contracts";
import type { WindowP2pExecutorBridge } from "@keymaster/contracts/window-p2p";
import { createBrowserMsFileSeedSource } from "./msfileBucketService.js";
import { inspectLocalMsFileSeed, MsFileSeedStoreError, readLocalMsFileRange, readMsFileSeed, storeMsFileSeed } from "./storage/msfileSeedStore.js";
import type { MsFileP2pLaneOperation } from "./executorTransport.js";

function binary(bytes: Uint8Array, mime?: string): BinaryField {
  return { $type: "binary", bytes: Uint8Array.from(bytes).buffer, mime };
}

export function createConnectContent(
  store: BorrowedModuleFileStore,
  bridge: WindowP2pExecutorBridge,
  sellerReady: () => boolean,
  refreshSellerIndex: (hash: string, signal?: AbortSignal) => Promise<void>,
): NonNullable<MsFileService["connectContent"]> {
  const buyer = (operation: MsFileP2pLaneOperation, signal?: AbortSignal) =>
    bridge.request({ type: "lane", laneId: "msfile", operation }, signal) as Promise<MsFileBitfsDemandSnapshot>;
  return {
    sellerStatus: () => ({ ready: sellerReady() }),
    async importFile(input, signal) {
      if (!sellerReady()) throw new Error("BitFS seller is not ready");
      const source = createBrowserMsFileSeedSource(new File([input.content.bytes], input.fileName, { type: input.content.mime }));
      const { meta } = await storeMsFileSeed({ store, source, signal });
      await refreshSellerIndex(meta.seedHashHex, signal);
      return { seedHashHex: meta.seedHashHex };
    },
    async hasLocal(seedHashHex, signal) {
      return Boolean(await inspectLocalMsFileSeed({ store, seedHashHex, signal }));
    },
    async readRange(seedHashHex, taskId, offset, length, signal) {
      let result: { fileSizeBytes?: number; mediaType?: string; bytes?: Uint8Array } | undefined =
        await readLocalMsFileRange({ store, seedHashHex, offset, length, signal });
      if (!result && taskId) {
        const range = await bridge.request({ type: "lane", laneId: "msfile",
          operation: { type: "bitfs-connect-range", seedHashHex, taskId, offset, length } satisfies MsFileP2pLaneOperation,
        }, signal) as { fileSizeBytes?: number; mediaType?: string; content?: Uint8Array };
        result = { fileSizeBytes: range.fileSizeBytes, mediaType: range.mediaType, bytes: range.content };
      }
      if (!result) return {};
      const { fileSizeBytes, mediaType, bytes } = result;
      return { fileSizeBytes, mediaType, ...(bytes ? { content: binary(bytes) } : {}) };
    },
    async readLocal(seedHashHex, signal) {
      try {
        const { seedBytes, parts, meta } = await readMsFileSeed({ store, seedHashHex, signal });
        const content = new Uint8Array(Number(meta.fileSizeBytes));
        let offset = 0;
        for (const part of parts) {
          content.set(part, offset);
          offset += part.length;
        }
        return { seed: binary(seedBytes), content: binary(content, meta.mediaType) };
      } catch (error) {
        if (error instanceof MsFileSeedStoreError && ["missing-meta", "missing-seed", "missing-block"].includes(error.code)) return undefined;
        throw error;
      }
    },
    discover: (seedHashHex, signal, manualPurchase) => buyer({ type: "bitfs-connect-buyer", action: "discover", seedHashHex, manualPurchase }, signal),
    snapshot: (seedHashHex, signal, taskId) => buyer({ type: "bitfs-connect-buyer", action: "snapshot", seedHashHex, taskId }, signal),
    purchase: (seedHashHex, quote, signal, maxFullBlockPriceSatoshis) =>
      buyer({ type: "bitfs-connect-buyer", action: "purchase", seedHashHex,
        sessionId: quote.sessionId, maxFullBlockPriceSatoshis: maxFullBlockPriceSatoshis ?? quote.fullBlockPriceSatoshis,
        requireNew: maxFullBlockPriceSatoshis !== undefined }, signal),
    async setDownloadPrice(seedHashHex, taskId, maxFullBlockPriceSatoshis, signal) {
      await bridge.request({ type: "lane", laneId: "msfile",
        operation: { type: "bitfs-connect-price", seedHashHex, taskId, maxFullBlockPriceSatoshis } satisfies MsFileP2pLaneOperation,
      }, signal);
    },
  };
}
