// packages/plugin-token-bsv21/src/bsv21MintHistoryDb.ts
// BSV-21 铸造历史 DB（key-scoped）。
//
// 设计缘由：
//   - 保存每次 prepare / submit 的参数和最终广播结果；
//   - 数据跟随当前 active key namespace；
//   - 页面可直接读取最近历史，无需再依赖 WOC / memcache。

import type { KeyspaceService, ProtocolSpendPreview, ProtocolSpendResult } from "@keymaster/contracts";
import type { Bsv21Payload } from "./bsv21Script.js";

export type Bsv21MintHistoryStatus = "prepared" | ProtocolSpendResult["status"];

export interface Bsv21MintHistoryRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: Bsv21MintHistoryStatus;
  request: {
    network: "main" | "test";
    amount: string;
    sym?: string;
    dec?: number;
    feeRateSatoshisPerKb: number;
    changeAddress?: string;
    ownerPublicKeyHex: string;
  };
  payload: Bsv21Payload;
  preview: {
    tokenId: string;
    spend: ProtocolSpendPreview;
  };
  submit?: {
    tokenId: string;
    spend: ProtocolSpendResult;
    submittedAt: string;
  };
}

export interface Bsv21MintHistoryDb {
  get(id: string): Promise<Bsv21MintHistoryRecord | undefined>;
  put(record: Bsv21MintHistoryRecord): Promise<void>;
  list(): Promise<Bsv21MintHistoryRecord[]>;
  findByTokenId(tokenId: string): Promise<Bsv21MintHistoryRecord | undefined>;
  close(): void;
}

const STORAGE_ID = "mint-history";
const DB_VERSION = 1;
const STORE_NAME = "history";

function upgrade(db: IDBDatabase): void {
  if (db.objectStoreNames.contains(STORE_NAME)) {
    db.deleteObjectStore(STORE_NAME);
  }
  const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
  store.createIndex("updatedAt", "updatedAt", { unique: false });
}

export function createBsv21MintHistoryDb(keyspace: KeyspaceService): Bsv21MintHistoryDb {
  async function getHandle(): Promise<{ db: IDBDatabase }> {
    const state = keyspace.active();
    if (!state.activePublicKeyHex) {
      throw new Error("createBsv21MintHistoryDb: no active key");
    }
    const handle = await keyspace.openKeyStorage({
      publicKeyHex: state.activePublicKeyHex,
      pluginId: "plugin-token-bsv21",
      storageId: STORAGE_ID,
      version: DB_VERSION,
      upgrade
    });
    return { db: handle.db };
  }

  async function listAll(): Promise<Bsv21MintHistoryRecord[]> {
    const { db } = await getHandle();
    return new Promise<Bsv21MintHistoryRecord[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const request = tx.objectStore(STORE_NAME).getAll();
      request.onsuccess = () => {
        const items = [...request.result];
        items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        resolve(items);
      };
      request.onerror = () => reject(request.error);
    });
  }

  return {
    async get(id) {
      const { db } = await getHandle();
      return new Promise<Bsv21MintHistoryRecord | undefined>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const request = tx.objectStore(STORE_NAME).get(id);
        request.onsuccess = () => resolve((request.result as Bsv21MintHistoryRecord | undefined) ?? undefined);
        request.onerror = () => reject(request.error);
      });
    },
    async put(record) {
      const { db } = await getHandle();
      return new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },
    async list() {
      return listAll();
    },
    async findByTokenId(tokenId) {
      const all = await listAll();
      return all.find((record) => record.preview.tokenId === tokenId || record.submit?.tokenId === tokenId);
    },
    close() {
      // no-op
    }
  };
}
