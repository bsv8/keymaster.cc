import { describe, expect, it } from "vitest";
import type { StorageBucketProvider } from "@keymaster/contracts";
import { openMultipartUploadRepository } from "../bootstrap/multipartUploadRepository.js";
import { createInMemoryKeyValueStore } from "@keymaster/runtime/storage";
import { CENTRAL_STORAGE_DECLARATIONS } from "@keymaster/contracts";
import { createStorageRuntimeController } from "./storageController.js";

function createProvider(): StorageBucketProvider {
  const objects = new Map<string, Uint8Array>();
  return {
    provider: "s3",
    bucketId: "bucket-v1",
    async probe() { return { ok: true, conditionalWrites: "native", latencyMs: 0 }; },
    async get(path) {
      const bytes = objects.get(path);
      return bytes === undefined ? undefined : { path, bytes: bytes.slice(), size: bytes.byteLength, etag: `etag-${path}` };
    },
    async list(input = {}) {
      const prefix = input.prefix ?? "";
      return {
        objects: [...objects.entries()]
          .filter(([path]) => path.startsWith(prefix))
          .map(([path, bytes]) => ({ path, bytes: new Uint8Array(0), size: bytes.byteLength, etag: `etag-${path}` }))
          .sort((left, right) => left.path.localeCompare(right.path)),
      };
    },
    async put(path, bytes) {
      objects.set(path, bytes.slice());
      return { etag: `etag-${path}` };
    },
    async delete(path) { objects.delete(path); },
    dispose() { objects.clear(); },
  };
}

async function createRuntime() {
  const store = createInMemoryKeyValueStore({
    ...CENTRAL_STORAGE_DECLARATIONS.storageMultipartUploads,
    bucketId: "bucket-v1",
    bucketGeneration: 1,
  });
  const multipart = await openMultipartUploadRepository(store);
  const runtime = await createStorageRuntimeController({
    multipartUploadRepository: multipart,
    bucketProvider: createProvider(),
    bucketGeneration: 1,
  });
  return { runtime, multipart };
}

describe("StorageRuntimeController V1", () => {
  it("uses the injected bucket provider and starts without provider configuration", async () => {
    const { runtime, multipart } = await createRuntime();
    expect(runtime.status()).toBe("ready");
    expect(await runtime.getProviderSummary()).toMatchObject({ bucketHint: "bucket-v1", accessKeyHint: "unified" });
    expect(await runtime.getProviderConnection()).toBeNull();
    expect(await multipart.listMultiparts()).toEqual([]);
    runtime.dispose();
  });

  it("does not expose a provider switching API", async () => {
    const { runtime } = await createRuntime();
    expect("activateProvider" in runtime).toBe(false);
    expect("clearProviderConfig" in runtime).toBe(false);
    expect("resetStorage" in runtime).toBe(false);
    runtime.dispose();
  });
});
