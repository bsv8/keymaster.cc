import type {
  NormalizedStorageProviderConfig,
  StorageBucketListPage,
  StorageBucketObject,
  StorageBucketProbeResult,
  StorageBucketProvider
} from "@keymaster/contracts";
import { createS3BucketObjectStore } from "./s3BucketObjectStore.js";
import type { BucketObjectStore, BucketObjectStoreCapabilityState } from "../bucketObjectStore.js";
import { createBucketObjectStoreCapabilityState } from "../bucketObjectStore.js";
import { StorageRuntimeError } from "../../runtime/storageRuntimeError.js";
import { assertProviderPath, normalizeProviderLimit } from "../bucketProvider.js";

export interface S3BucketProviderOptions {
  /** 测试时注入桶对象实现，生产默认创建 AWS/R2 client。 */
  store?: BucketObjectStore;
  capabilityState?: BucketObjectStoreCapabilityState;
  bucketId?: string;
  now?: () => number;
}

function mapError(error: unknown): StorageRuntimeError {
  if (error instanceof StorageRuntimeError) return error;
  return new StorageRuntimeError("storage_provider_error", "S3 provider operation failed", "provider");
}

/**
 * 把 AWS/R2/S3-compatible 对象实现收敛为统一 Provider 契约。
 * 物理 S3 client 只在 s3BucketObjectStore.ts 出现；K-V 引擎不依赖 SDK。
 */
export function createS3BucketProvider(
  config: NormalizedStorageProviderConfig,
  options: S3BucketProviderOptions = {}
): StorageBucketProvider {
  const capabilityState = options.capabilityState ?? createBucketObjectStoreCapabilityState();
  const store = options.store ?? createS3BucketObjectStore(config, { capabilityState });
  const bucketId = options.bucketId ?? `s3:${config.providerId}:${(config.connection as { bucket: string }).bucket}`;
  const now = options.now ?? (() => Date.now());
  let disposed = false;
  const root = "";

  function assertOpen(path: string): void {
    if (disposed) throw new StorageRuntimeError("storage_unavailable", "Storage provider is closed");
    assertProviderPath(path);
  }

  return {
    provider: "s3",
    bucketId,
    async probe(signal): Promise<StorageBucketProbeResult> {
      const started = now();
      try {
        await store.probe("", signal);
        const probePath = `.keymaster/probes/${crypto.randomUUID()}`;
        const bytes = new TextEncoder().encode("keymaster-s3-probe");
        // This is deliberately strict. The generic S3 ObjectStore may still
        // support a best-effort mode for the old Connect file API, but a
        // Keymaster system bucket must prove native CAS before activation.
        await store.put({ namespaceRoot: root, key: probePath, bytes, ifNoneMatch: "*", signal });
        if (capabilityState.put.mode !== "native") {
          await store.delete({ namespaceRoot: root, key: probePath, signal }).catch(() => undefined);
          throw new StorageRuntimeError("storage_provider_error", "S3 provider does not support native conditional writes", "provider");
        }
        const value = await store.get({ namespaceRoot: root, key: probePath, signal });
        if (!value || value.bytes.byteLength !== bytes.byteLength) throw new StorageRuntimeError("storage_provider_error", "S3 provider probe readback failed", "provider");
        try {
          await store.put({ namespaceRoot: root, key: probePath, bytes, ifMatch: "keymaster-invalid-etag", signal });
          throw new StorageRuntimeError("storage_provider_error", "S3 provider ignored If-Match", "provider");
        } catch (caught) {
          if (!(caught instanceof StorageRuntimeError) || caught.code !== "storage_conflict") throw caught;
        }
        await store.delete({ namespaceRoot: root, key: probePath, signal });
        return { ok: true, conditionalWrites: "native", latencyMs: Math.max(0, now() - started) };
      } catch (caught) {
        if (caught instanceof StorageRuntimeError) throw caught;
        throw mapError(caught);
      }
    },
    async get(path, input = {}): Promise<StorageBucketObject | undefined> {
      assertOpen(path);
      try {
        const value = await store.get({ namespaceRoot: root, key: path, ifMatch: input.ifMatch, signal: input.signal });
        if (!value) return undefined;
        return { path, bytes: value.bytes, size: value.bytes.byteLength, etag: value.etag, lastModified: value.lastModified?.toISOString() };
      } catch (caught) {
        const mapped = mapError(caught);
        if (mapped.code === "storage_not_found") return undefined;
        throw mapped;
      }
    },
    async list(input = {}): Promise<StorageBucketListPage> {
      const prefix = input.prefix ?? "";
      if (prefix) assertProviderPath(prefix.endsWith("/") ? prefix.slice(0, -1) : prefix);
      const page = await store.list({ namespaceRoot: root, prefix, continuationToken: input.cursor, maxKeys: normalizeProviderLimit(input.limit), signal: input.signal });
      const objects = await Promise.all(page.objects
        .map(async (object): Promise<StorageBucketObject> => ({
          path: object.key,
          // Listing only returns metadata from S3. Keep bytes empty; callers
          // needing content must call get(path), preserving bounded reads.
          bytes: new Uint8Array(0),
          size: object.size,
          etag: object.etag,
          lastModified: object.lastModified?.toISOString()
        })));
      return { objects, nextCursor: page.nextContinuationToken };
    },
    async put(path, bytes, condition = {}) {
      assertOpen(path);
      try {
        return await store.put({ namespaceRoot: root, key: path, bytes, ifMatch: condition.ifMatch, ifNoneMatch: condition.ifNoneMatch, signal: condition.signal }).then((result) => ({ etag: result.etag, lastModified: result.lastModified?.toISOString() }));
      } catch (caught) {
        throw mapError(caught);
      }
    },
    async delete(path, input = {}) {
      assertOpen(path);
      try {
        await store.delete({ namespaceRoot: root, key: path, ifMatch: input.ifMatch, signal: input.signal });
      } catch (caught) {
        throw mapError(caught);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      store.dispose();
    }
  };
}
