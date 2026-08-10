import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { openStorageDb, STORAGE_DB_NAME } from "./storageDb.js";
import type { StoredMultipartUploadRecord } from "./storageDb.js";

function deleteDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(STORAGE_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Storage database deletion was blocked"));
  });
}

function sampleUpload(): StoredMultipartUploadRecord {
  return {
    internalUploadId: "upload-1",
    connectSessionId: "session-1",
    transportOrigin: "https://app.example",
    publisherPublicKeyHex: "a".repeat(66),
    appId: "app",
    relativePath: "file.bin",
    physicalKey: "root/file.bin",
    sealedS3UploadId: { version: 2, saltHex: "00", nonceHex: "00", ciphertextHex: "00" },
    providerGeneration: 1,
    expectedSize: 1,
    overwrite: true,
    parts: [],
    expiresAt: Date.now() + 60_000,
    createdAt: Date.now()
  };
}

afterEach(async () => {
  await deleteDatabase();
});

describe("StorageDb rotation barrier", () => {
  it("rejects provider and multipart writes while a rotation journal exists", async () => {
    const db = await openStorageDb();
    const raw = indexedDB.open(STORAGE_DB_NAME);
    const rawDb = await new Promise<IDBDatabase>((resolve, reject) => {
      raw.onsuccess = () => resolve(raw.result);
      raw.onerror = () => reject(raw.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = rawDb.transaction("providerConfig", "readwrite");
      tx.objectStore("providerConfig").put({ key: "rotation", phase: "prepared", old: { uploads: [] } });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    await expect(db.putMultipart(sampleUpload())).rejects.toMatchObject({ code: "storage_unavailable" });
    await expect(db.clearProviderConfig()).rejects.toMatchObject({ code: "storage_unavailable" });
    rawDb.close();
    db.close();
  });

  it("allows an explicit reset to remove a stuck rotation barrier", async () => {
    const db = await openStorageDb();
    const raw = indexedDB.open(STORAGE_DB_NAME);
    const rawDb = await new Promise<IDBDatabase>((resolve, reject) => {
      raw.onsuccess = () => resolve(raw.result);
      raw.onerror = () => reject(raw.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = rawDb.transaction(["providerConfig", "multipartUploads"], "readwrite");
      tx.objectStore("providerConfig").put({ key: "rotation", phase: "prepared", old: { uploads: [] } });
      tx.objectStore("multipartUploads").put(sampleUpload());
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    await db.resetStorage();
    await expect(db.getProviderConfig()).resolves.toBeNull();
    await expect(db.listMultiparts()).resolves.toEqual([]);
    rawDb.close();
    db.close();
  });
});
