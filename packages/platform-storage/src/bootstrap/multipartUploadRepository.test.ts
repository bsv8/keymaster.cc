import { describe, expect, it } from "vitest";
import { CENTRAL_STORAGE_DECLARATIONS, deriveThirdPartyStorageModuleId } from "@keymaster/contracts";
import { createInMemoryKeyValueStore } from "@keymaster/runtime/storage";
import { openMultipartUploadRepository, type StoredMultipartUploadRecord } from "./multipartUploadRepository.js";

function sampleUpload(): StoredMultipartUploadRecord {
  return {
    internalUploadId: "upload-1",
    connectSessionId: "session-1",
    transportOrigin: "https://app.example",
    ownerPublicKeyHex: "02" + "a".repeat(64),
    moduleId: deriveThirdPartyStorageModuleId("02" + "a".repeat(64), "app-a"),
    purposeId: "files",
    bucketId: "test-memory",
    bucketGeneration: 1,
    sessionEpoch: "epoch-1",
    relativePath: "file.bin",
    physicalKey: "root/file.bin",
    uploadId: "provider-upload-1",
    providerGeneration: 1,
    expectedSize: 1,
    overwrite: true,
    parts: [],
    expiresAt: Date.now() + 60_000,
    createdAt: Date.now(),
  };
}

function openStore() {
  return createInMemoryKeyValueStore({
    ...CENTRAL_STORAGE_DECLARATIONS.storageMultipartUploads,
    bucketId: "test-memory",
    bucketGeneration: 1,
  });
}

describe("MultipartUploadRepository", () => {
  it("persists only multipart recovery metadata in its declared purpose", async () => {
    const store = openStore();
    const repository = await openMultipartUploadRepository(store);
    await repository.putMultipart(sampleUpload());
    expect(await repository.getMultipart("upload-1")).toMatchObject({ internalUploadId: "upload-1" });
    expect(await store.list({ partition: "storage", prefix: "uploads/" })).toMatchObject({ entries: [{ key: "uploads/upload-1" }] });
    await repository.deleteMultipart("upload-1");
    await expect(repository.listMultiparts()).resolves.toEqual([]);
    repository.close();
  });

  it("only exposes multipart recovery entries", async () => {
    const store = openStore();
    const repository = await openMultipartUploadRepository(store);
    await expect(repository.listMultiparts()).resolves.toEqual([]);
    await repository.putMultipart(sampleUpload());
    const entries = await store.list({ partition: "storage" });
    expect(entries.entries.every(({ key }) => key.startsWith("uploads/"))).toBe(true);
    repository.close();
  });
});
