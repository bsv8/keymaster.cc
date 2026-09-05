import type { StorageBucketProvider } from "@keymaster/contracts";
import { sha256 } from "@noble/hashes/sha2.js";
import type { BucketGetOutput, BucketListOutput, BucketObjectStore, BucketObjectStoreCapabilityState } from "./bucketObjectStore.js";
import { createBucketObjectStoreCapabilityState } from "./bucketObjectStore.js";
import { assertKeyInRoot, normalizeRoot } from "./bucketPath.js";
import { assertProviderPath } from "./bucketProvider.js";
import { StorageRuntimeError } from "../runtime/storageRuntimeError.js";

/**
 * 将统一抽象桶 Provider 适配成 Connect 文件运行时使用的对象接口。
 *
 * 该适配器不创建第二个 Provider：文件 API、平台 K-V 和系统 App K-V
 * 都直接落到传入的同一个 OPFS/S3 桶。Multipart 在 Provider 原语之上
 * 使用 `.keymaster/uploads/` 临时对象实现，因此 OPFS 与 S3 具有相同语义。
 */
export function createProviderBackedBucketObjectStore(
  provider: StorageBucketProvider,
  capabilityState: BucketObjectStoreCapabilityState = createBucketObjectStoreCapabilityState()
): BucketObjectStore {
  let disposed = false;
  const uploadRoot = (namespaceRoot: string, uploadId: string): string => `${normalizeRoot(namespaceRoot)}.keymaster/uploads/${uploadId}`;

  function assertOpen(): void {
    if (disposed) throw new StorageRuntimeError("storage_unavailable", "Storage object store is closed");
  }

  function assertVisibleKey(namespaceRoot: string, key: string): void {
    assertKeyInRoot(namespaceRoot, key);
    const root = normalizeRoot(namespaceRoot);
    const relative = key.slice(root.length);
    if (relative === ".keymaster" || relative.startsWith(".keymaster/")) {
      throw new StorageRuntimeError("storage_forbidden", "Storage internal path is not visible");
    }
  }

  function partPath(namespaceRoot: string, uploadId: string, partNumber: number): string {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(uploadId) || !Number.isSafeInteger(partNumber) || partNumber < 1) {
      throw new StorageRuntimeError("storage_invalid_upload", "Multipart upload part is invalid");
    }
    const path = `${uploadRoot(namespaceRoot, uploadId)}/${partNumber}`;
    assertProviderPath(path);
    return path;
  }

  function mapObject(object: { path: string; bytes: Uint8Array; size?: number; etag?: string; lastModified?: string }): { key: string; size: number; etag?: string; lastModified?: Date } {
    return {
      key: object.path,
      size: object.size ?? object.bytes.byteLength,
      ...(object.etag ? { etag: object.etag } : {}),
      ...(object.lastModified ? { lastModified: new Date(object.lastModified) } : {})
    };
  }

  function etag(bytes: Uint8Array): string {
    return Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  return {
    async probe(_prefix, signal) {
      assertOpen();
      const result = await provider.probe(signal);
      if (!result.ok || result.conditionalWrites !== "native") throw new StorageRuntimeError("storage_provider_error", "Storage bucket does not support native conditional writes");
    },

    async list(input): Promise<BucketListOutput> {
      assertOpen();
      assertKeyInRoot(input.namespaceRoot, input.prefix);
      const page = await provider.list({ prefix: input.prefix, cursor: input.continuationToken, limit: input.maxKeys, signal: input.signal });
      const root = normalizeRoot(input.namespaceRoot);
      const prefix = input.prefix.endsWith("/") ? input.prefix : `${input.prefix}/`;
      const commonPrefixes = new Set<string>();
      const objects = page.objects.flatMap((object) => {
        const relative = object.path.slice(prefix.length);
        if (relative.startsWith(".keymaster/") || relative === ".keymaster") return [];
        if (input.delimiter === "/") {
          const separator = relative.indexOf("/");
          if (separator >= 0) {
            commonPrefixes.add(`${prefix}${relative.slice(0, separator + 1)}`);
            return [];
          }
        }
        assertKeyInRoot(root, object.path);
        return [mapObject(object)];
      });
      return { objects, commonPrefixes: [...commonPrefixes].sort(), nextContinuationToken: page.nextCursor };
    },

    async put(input) {
      assertOpen();
      assertVisibleKey(input.namespaceRoot, input.key);
      const result = await provider.put(input.key, input.bytes, { ifMatch: input.ifMatch, ...(input.ifNoneMatch === "*" ? { ifNoneMatch: "*" as const } : {}), signal: input.signal });
      return { etag: result.etag ?? etag(input.bytes), ...(result.lastModified ? { lastModified: new Date(result.lastModified) } : {}) };
    },

    async head(input) {
      assertOpen();
      assertVisibleKey(input.namespaceRoot, input.key);
      return (await provider.get(input.key, { signal: input.signal })) !== undefined;
    },

    async get(input): Promise<BucketGetOutput> {
      assertOpen();
      assertVisibleKey(input.namespaceRoot, input.key);
      const object = await provider.get(input.key, { ifMatch: input.ifMatch, signal: input.signal });
      if (!object) throw new StorageRuntimeError("storage_not_found", "Storage object was not found");
      const totalSize = object.size ?? object.bytes.byteLength;
      let bytes = object.bytes;
      let offset = 0;
      if (input.range) {
        const match = /^bytes=(\d+)-(\d+)$/u.exec(input.range);
        if (!match) throw new StorageRuntimeError("storage_invalid_path", "Storage range is invalid");
        offset = Number(match[1]);
        const end = Number(match[2]);
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || offset < 0 || end < offset) throw new StorageRuntimeError("storage_invalid_path", "Storage range is invalid");
        bytes = object.bytes.slice(offset, Math.min(end + 1, object.bytes.byteLength));
      }
      return {
        bytes,
        offset,
        contentLength: bytes.byteLength,
        totalSize,
        ...(object.etag ? { etag: object.etag } : {}),
        ...(object.lastModified ? { lastModified: new Date(object.lastModified) } : {})
      };
    },

    async delete(input) {
      assertOpen();
      assertVisibleKey(input.namespaceRoot, input.key);
      await provider.delete(input.key, { ifMatch: input.ifMatch, signal: input.signal });
    },

    async createMultipart(input) {
      assertOpen();
      assertVisibleKey(input.namespaceRoot, input.key);
      return crypto.randomUUID();
    },

    async uploadPart(input) {
      assertOpen();
      assertVisibleKey(input.namespaceRoot, input.key);
      const path = partPath(input.namespaceRoot, input.uploadId, input.partNumber);
      const result = await provider.put(path, input.bytes, { signal: input.signal });
      return result.etag ?? etag(input.bytes);
    },

    async completeMultipart(input) {
      assertOpen();
      assertVisibleKey(input.namespaceRoot, input.key);
      if (input.parts.length === 0) throw new StorageRuntimeError("storage_invalid_upload", "Multipart upload has no parts");
      const chunks: Uint8Array[] = [];
      for (const part of [...input.parts].sort((a, b) => a.partNumber - b.partNumber)) {
        const object = await provider.get(partPath(input.namespaceRoot, input.uploadId, part.partNumber), { signal: input.signal });
        if (!object) throw new StorageRuntimeError("storage_invalid_upload", "Multipart upload part is missing");
        chunks.push(object.bytes);
      }
      const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const result = await provider.put(input.key, bytes, { ifMatch: input.ifMatch, ...(input.ifNoneMatch === "*" ? { ifNoneMatch: "*" as const } : {}), signal: input.signal });
      for (const part of input.parts) await provider.delete(partPath(input.namespaceRoot, input.uploadId, part.partNumber), { signal: input.signal }).catch(() => undefined);
      return { etag: result.etag ?? etag(bytes), ...(result.lastModified ? { lastModified: new Date(result.lastModified) } : {}) };
    },

    async abortMultipart(input) {
      assertOpen();
      assertVisibleKey(input.namespaceRoot, input.key);
      const prefix = `${uploadRoot(input.namespaceRoot, input.uploadId)}/`;
      let cursor: string | undefined;
      do {
        const page = await provider.list({ prefix, cursor, limit: 1000, signal: input.signal });
        for (const object of page.objects) await provider.delete(object.path, { signal: input.signal }).catch(() => undefined);
        cursor = page.nextCursor;
      } while (cursor);
    },

    dispose() { disposed = true; }
  };
}
