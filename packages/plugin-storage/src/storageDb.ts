import type { VaultSealedSecret } from "@keymaster/contracts";
import { StorageServiceError } from "./storageErrors.js";

export const STORAGE_DB_NAME = "keymaster.storage";
export const STORAGE_DB_VERSION = 1;

export interface StoredProviderConfigRecord {
  key: "active";
  providerId: string;
  publicSummary: { bucketHint: string; endpointHint?: string; prefix: string; accessKeyHint: string };
  sealedConfig: VaultSealedSecret;
  generation: number;
  updatedAt: number;
}

export interface StoredMultipartUploadRecord {
  internalUploadId: string;
  connectSessionId: string;
  transportOrigin: string;
  publisherPublicKeyHex: string;
  appId: string;
  relativePath: string;
  physicalKey: string;
  sealedS3UploadId: VaultSealedSecret;
  providerGeneration: number;
  contentType?: string;
  expectedSize: number;
  overwrite: boolean;
  parts: Array<{ partNumber: number; etag: string; size: number }>;
  expiresAt: number;
  createdAt: number;
}

const STORAGE_ROTATION_KEY = "rotation";

function rotationInProgressError(): StorageServiceError {
  return new StorageServiceError("storage_unavailable", "Storage is temporarily unavailable during password rotation");
}

function guardedWrite(
  db: IDBDatabase,
  stores: "providerConfig" | ["providerConfig", "multipartUploads"],
  write: (transaction: IDBTransaction) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    let rejectedForRotation = false;
    try {
      const transaction = db.transaction(stores, "readwrite");
      const provider = transaction.objectStore("providerConfig");
      const rotation = provider.get(STORAGE_ROTATION_KEY);
      rotation.onsuccess = () => {
        if (rotation.result) {
          rejectedForRotation = true;
          reject(rotationInProgressError());
          transaction.abort();
          return;
        }
        write(transaction);
      };
      rotation.onerror = () => {
        if (!rejectedForRotation) reject(rotation.error);
        transaction.abort();
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => {
        if (!rejectedForRotation) reject(transaction.error);
      };
      transaction.onabort = () => {
        if (!rejectedForRotation) reject(transaction.error ?? new Error("Storage transaction aborted"));
      };
    } catch (error) {
      reject(error);
    }
  });
}

export interface StorageDb {
  getProviderConfig(): Promise<StoredProviderConfigRecord | null>;
  replaceProviderConfig(record: StoredProviderConfigRecord): Promise<void>;
  clearProviderConfig(): Promise<void>;
  /** Explicit, user-confirmed reset that also removes a stuck rotation journal. */
  resetStorage(): Promise<void>;
  putMultipart(record: StoredMultipartUploadRecord): Promise<void>;
  getMultipart(id: string): Promise<StoredMultipartUploadRecord | null>;
  deleteMultipart(id: string): Promise<void>;
  listMultiparts(): Promise<StoredMultipartUploadRecord[]>;
  close(): void;
}

export function openStorageDb(): Promise<StorageDb> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB is unavailable"));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(STORAGE_DB_NAME, STORAGE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("providerConfig")) db.createObjectStore("providerConfig", { keyPath: "key" });
      if (!db.objectStoreNames.contains("multipartUploads")) db.createObjectStore("multipartUploads", { keyPath: "internalUploadId" });
    };
    request.onerror = () => reject(request.error ?? new Error("Failed to open storage database"));
    request.onblocked = () => reject(new Error("Opening storage database was blocked"));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      const store = (name: "providerConfig" | "multipartUploads", mode: IDBTransactionMode) => db.transaction(name, mode).objectStore(name);
      resolve({
        getProviderConfig: () => new Promise((res, rej) => {
          const req = store("providerConfig", "readonly").get("active");
          req.onsuccess = () => res((req.result as StoredProviderConfigRecord | undefined) ?? null);
          req.onerror = () => rej(req.error);
        }),
        replaceProviderConfig: (record) => guardedWrite(db, "providerConfig", (transaction) => {
          transaction.objectStore("providerConfig").put(record);
        }),
        clearProviderConfig: () => guardedWrite(db, ["providerConfig", "multipartUploads"], (transaction) => {
          transaction.objectStore("providerConfig").delete("active");
          transaction.objectStore("multipartUploads").clear();
        }),
        resetStorage: () => new Promise((resolve, reject) => {
          try {
            const transaction = db.transaction(["providerConfig", "multipartUploads"], "readwrite");
            transaction.objectStore("providerConfig").clear();
            transaction.objectStore("multipartUploads").clear();
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error ?? new Error("Storage reset failed"));
            transaction.onabort = () => reject(transaction.error ?? new Error("Storage reset aborted"));
          } catch (error) {
            reject(error);
          }
        }),
        putMultipart: (record) => guardedWrite(db, ["providerConfig", "multipartUploads"], (transaction) => {
          transaction.objectStore("multipartUploads").put(record);
        }),
        getMultipart: (id) => new Promise((res, rej) => {
          const req = store("multipartUploads", "readonly").get(id);
          req.onsuccess = () => res((req.result as StoredMultipartUploadRecord | undefined) ?? null);
          req.onerror = () => rej(req.error);
        }),
        deleteMultipart: (id) => guardedWrite(db, ["providerConfig", "multipartUploads"], (transaction) => {
          transaction.objectStore("multipartUploads").delete(id);
        }),
        listMultiparts: () => new Promise((res, rej) => {
          const req = store("multipartUploads", "readonly").getAll();
          req.onsuccess = () => res((req.result as StoredMultipartUploadRecord[]) ?? []);
          req.onerror = () => rej(req.error);
        }),
        close: () => db.close()
      });
    };
  });
}
