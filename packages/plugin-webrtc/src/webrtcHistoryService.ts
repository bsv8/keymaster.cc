// WebRTC 历史服务。
//
// 设计缘由：
//   - 只负责 key-scoped 历史读写；
//   - 不管理通话状态机；
//   - 不持久化临时协商态，只记录终态。

import type { KeyspaceService } from "@keymaster/contracts";
import {
  openWebrtcHistoryDb,
  type WebrtcCallHistoryRow,
  type WebrtcTransferBlobRow,
  type WebrtcTransferHistoryRow
} from "./webrtcHistoryDb.js";

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
}): WebrtcHistoryService {
  async function withDb<T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T | null> {
    const owner = input.ownerPublicKeyHex();
    if (!owner) return null;
    const opened = await openWebrtcHistoryDb({ keyspace: input.keyspace, publicKeyHex: owner });
    if (!opened) return null;
    try {
      return await fn(opened.handle.db);
    } finally {
      opened.close();
    }
  }

  return {
    async listForPeer(peerPublicKeyHex) {
      const owner = input.ownerPublicKeyHex();
      if (!owner) return [];
      const opened = await openWebrtcHistoryDb({ keyspace: input.keyspace, publicKeyHex: owner });
      if (!opened) return [];
      try {
        const db = opened.handle.db;
        const calls = await readAll<WebrtcCallHistoryRow>(db, "call_records");
        const transfers = await readAll<WebrtcTransferHistoryRow>(db, "transfer_records");
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
      } finally {
        opened.close();
      }
    },
    async appendCall(inputRow) {
      await withDb(async (db) => {
        await putRecord(db, "call_records", inputRow);
      });
    },
    async appendTransfer(inputRow, blob) {
      await withDb(async (db) => {
        await putRecord(db, "transfer_records", inputRow);
        if (blob && inputRow.blobKey) {
          await putRecord<WebrtcTransferBlobRow>(db, "blobs", { blobKey: inputRow.blobKey, blob });
        }
      });
    },
    async getBlob(blobKey) {
      const owner = input.ownerPublicKeyHex();
      if (!owner) return null;
      const opened = await openWebrtcHistoryDb({ keyspace: input.keyspace, publicKeyHex: owner });
      if (!opened) return null;
      try {
        return await getRecord<WebrtcTransferBlobRow>(opened.handle.db, "blobs", blobKey).then((row) => row?.blob ?? null);
      } finally {
        opened.close();
      }
    }
  };
}

async function putRecord<T>(db: IDBDatabase, storeName: string, value: T): Promise<void> {
  const tx = db.transaction(storeName, "readwrite");
  tx.objectStore(storeName).put(value as never);
  await txDone(tx);
}

async function getRecord<T>(db: IDBDatabase, storeName: string, key: IDBValidKey): Promise<T | null> {
  const tx = db.transaction(storeName, "readonly");
  const req = tx.objectStore(storeName).get(key);
  const value = await reqAsPromise<T | undefined>(req);
  await txDone(tx);
  return value ?? null;
}

async function readAll<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  const tx = db.transaction(storeName, "readonly");
  const req = tx.objectStore(storeName).getAll();
  const value = await reqAsPromise<T[]>(req);
  await txDone(tx);
  return value ?? [];
}

function reqAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
