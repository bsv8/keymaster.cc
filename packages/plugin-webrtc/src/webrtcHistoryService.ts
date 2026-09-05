// WebRTC 历史服务。
//
// 设计缘由：
//   - 只负责 key-scoped 历史读写；
//   - 不管理通话状态机；
//   - 不持久化临时协商态，只记录终态。

import type { KeyspaceService, KeyValueStore } from "@keymaster/contracts";
import {
  CALL_PARTITION,
  TRANSFER_PARTITION,
  createWebrtcHistoryRepository,
  getWebrtcBlob,
  listWebrtcRows,
  putWebrtcBlob,
  putWebrtcRow,
  type WebrtcCallHistoryRow,
  type WebrtcTransferHistoryRow
} from "./storage/webrtcHistoryRepository.js";

export interface WebrtcHistoryService {
  listForPeer(peerPublicKeyHex: string): Promise<WebrtcHistoryItem[]>;
  appendCall(input: WebrtcCallHistoryRow): Promise<void>;
  appendTransfer(input: WebrtcTransferHistoryRow, blob?: Blob): Promise<void>;
  getBlob(blobKey: string): Promise<Blob | null>;
}

export type WebrtcHistoryItem =
  | (WebrtcCallHistoryRow & { kind: "audio_call" | "video_call"; itemType: "call" })
  | (WebrtcTransferHistoryRow & { kind: "image" | "file"; itemType: "transfer" });

export function createWebrtcHistoryService(input: {
  keyspace: KeyspaceService;
  ownerPublicKeyHex: () => string | null;
  storage?: KeyValueStore;
}): WebrtcHistoryService {
  const repository = input.storage ? createWebrtcHistoryRepository(input.storage) : undefined;
  async function withRepository<T>(fn: (store: KeyValueStore) => Promise<T>): Promise<T | null> {
    const owner = input.ownerPublicKeyHex();
    if (!owner || !repository) return null;
    return fn(repository.store);
  }

  return {
    async listForPeer(peerPublicKeyHex) {
      const owner = input.ownerPublicKeyHex();
      if (!owner || !repository) return [];
      {
        const calls = await listWebrtcRows<WebrtcCallHistoryRow>(repository.store, CALL_PARTITION);
        const transfers = await listWebrtcRows<WebrtcTransferHistoryRow>(repository.store, TRANSFER_PARTITION);
        const merged: WebrtcHistoryItem[] = [
          ...calls.map((item) => ({ ...item, itemType: "call" as const })),
          ...transfers.map((item) => ({ ...item, itemType: "transfer" as const }))
        ];
        return merged
          .filter((item) => item.peerPublicKeyHex === peerPublicKeyHex)
          .sort((a, b) => {
            const ta = "endedAtMs" in a && a.endedAtMs ? a.endedAtMs : a.startedAtMs;
            const tb = "endedAtMs" in b && b.endedAtMs ? b.endedAtMs : b.startedAtMs;
            return tb - ta;
          }) as WebrtcHistoryItem[];
      }
    },
    async appendCall(inputRow) {
      await withRepository(async (store) => {
        await putWebrtcRow(store, CALL_PARTITION, inputRow.recordId, inputRow);
      });
    },
    async appendTransfer(inputRow, blob) {
      await withRepository(async (store) => {
        await putWebrtcRow(store, TRANSFER_PARTITION, inputRow.recordId, inputRow);
        if (blob && inputRow.blobKey) {
          await putWebrtcBlob(store, inputRow.blobKey, blob);
        }
      });
    },
    async getBlob(blobKey) {
      const owner = input.ownerPublicKeyHex();
      if (!owner || !repository) return null;
      return getWebrtcBlob(repository.store, blobKey);
    }
  };
}
