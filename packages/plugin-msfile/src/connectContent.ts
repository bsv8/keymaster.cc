import type { BinaryField, BorrowedModuleFileStore, MsFileBitfsDemandSnapshot, MsFileService } from "@keymaster/contracts";
import type { WindowP2pExecutorBridge } from "@keymaster/contracts/window-p2p";
import { createBrowserMsFileSeedSource } from "./msfileBucketService.js";
import { MsFileSeedStoreError, readMsFileSeed, storeMsFileSeed } from "./storage/msfileSeedStore.js";
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
    discover: (seedHashHex, signal) => buyer({ type: "bitfs-connect-buyer", action: "discover", seedHashHex }, signal),
    snapshot: (seedHashHex, signal) => buyer({ type: "bitfs-connect-buyer", action: "snapshot", seedHashHex }, signal),
    purchase: (seedHashHex, quote, signal) => buyer({ type: "bitfs-connect-buyer", action: "purchase", seedHashHex,
      sessionId: quote.sessionId, maxFullBlockPriceSatoshis: quote.fullBlockPriceSatoshis }, signal),
  };
}
