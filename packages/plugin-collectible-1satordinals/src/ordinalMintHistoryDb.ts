// packages/plugin-collectible-1satordinals/src/ordinalMintHistoryDb.ts
// 1Sat Ordinals 铸造历史 DB（key-scoped）。

import type { KeyspaceService, ProtocolSpendPreview, ProtocolSpendResult } from "@keymaster/contracts";
import type { OrdinalEnvelopeEntry } from "./ordinalScript.js";

export type OrdinalMintHistoryStatus = "prepared" | ProtocolSpendResult["status"];

export interface OrdinalMintHistoryRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: OrdinalMintHistoryStatus;
  request: {
    network: "main" | "test";
    contentType: string;
    dataBase64: string;
    dataSize: number;
    metadata?: OrdinalEnvelopeEntry[];
    feeRateSatoshisPerKb: number;
    changeAddress?: string;
    ownerPublicKeyHex: string;
  };
  preview: {
    inscriptionId: string;
    outputScriptHex: string;
    spend: ProtocolSpendPreview;
  };
  submit?: {
    inscriptionId: string;
    spend: ProtocolSpendResult;
    submittedAt: string;
  };
}

export interface OrdinalMintHistoryDb {
  get(id: string): Promise<OrdinalMintHistoryRecord | undefined>;
  put(record: OrdinalMintHistoryRecord): Promise<void>;
  list(): Promise<OrdinalMintHistoryRecord[]>;
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

export function createOrdinalMintHistoryDb(keyspace: KeyspaceService): OrdinalMintHistoryDb {
  async function getHandle(): Promise<{ db: IDBDatabase }> {
    const state = keyspace.active();
    if (!state.activePublicKeyHex) {
      throw new Error("createOrdinalMintHistoryDb: no active key");
    }
    const handle = await keyspace.openKeyStorage({
      publicKeyHex: state.activePublicKeyHex,
      pluginId: "plugin-collectible-1satordinals",
      storageId: STORAGE_ID,
      version: DB_VERSION,
      upgrade
    });
    return { db: handle.db };
  }

  return {
    async get(id) {
      const { db } = await getHandle();
      return new Promise<OrdinalMintHistoryRecord | undefined>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const request = tx.objectStore(STORE_NAME).get(id);
        request.onsuccess = () => resolve((request.result as OrdinalMintHistoryRecord | undefined) ?? undefined);
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
      const { db } = await getHandle();
      return new Promise<OrdinalMintHistoryRecord[]>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const request = tx.objectStore(STORE_NAME).getAll();
        request.onsuccess = () => {
          const items = [...request.result];
          items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
          resolve(items);
        };
        request.onerror = () => reject(request.error);
      });
    },
    close() {}
  };
}
