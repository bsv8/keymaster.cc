import { describe, expect, it } from "vitest";
import { createInMemoryKeyValueStore } from "@keymaster/runtime";
import { openMultipartUploadRepository } from "./multipartUploadRepository.js";
import type { StoredMultipartUploadRecord } from "./multipartUploadRepository.js";

function sampleUpload(): StoredMultipartUploadRecord {
  return {
    internalUploadId: "upload-1",
    connectSessionId: "session-1",
    transportOrigin: "https://app.example",
    ownerPublicKeyHex: "02" + "a".repeat(64),
    applicationStorageId: "app-storage",
    bucketId: "test-memory",
    bucketGeneration: 1,
    sessionEpoch: "epoch-1",
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

describe("MultipartUploadRepository rotation barrier", () => {
  it("rejects provider and multipart writes while a rotation journal exists", async () => {
    const storage = createInMemoryKeyValueStore({ scope: "platform", applicationStorageId: "storage", schemaVersion: 1, bucketId: "test-memory", bucketGeneration: 1 });
    const db = await openMultipartUploadRepository(storage);
    await storage.put("provider/rotation", { phase: "prepared", old: { uploads: [] } }, { partition: "storage" });

    await expect(db.putMultipart(sampleUpload())).rejects.toMatchObject({ code: "storage_unavailable" });
    await expect(db.clearProviderConfig()).rejects.toMatchObject({ code: "storage_unavailable" });
    db.close();
  });

  it("allows an explicit reset to remove a stuck rotation barrier", async () => {
    const storage = createInMemoryKeyValueStore({ scope: "platform", applicationStorageId: "storage", schemaVersion: 1, bucketId: "test-memory", bucketGeneration: 1 });
    const db = await openMultipartUploadRepository(storage);
    await storage.put("provider/rotation", { phase: "prepared", old: { uploads: [] } }, { partition: "storage" });
    await storage.put("uploads/upload-1", sampleUpload(), { partition: "storage" });

    await db.resetStorage();
    await expect(db.getProviderConfig()).resolves.toBeNull();
    await expect(db.listMultiparts()).resolves.toEqual([]);
    db.close();
  });
});
