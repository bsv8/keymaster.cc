import type {
  StorageAppContext,
  StorageService,
  StorageListResult
} from "@keymaster/contracts";
import { STORAGE_PART_SIZE_BYTES } from "@keymaster/contracts";

/**
 * Small ObjectStore-shaped facade used by the S3Disk migration contract tests.
 *
 * It deliberately accepts an already-bound Connect context and never accepts
 * provider config or credentials. S3Disk can therefore test its directory and
 * transfer code against Connect Storage without gaining a second credential
 * path.
 */
export interface ConnectObjectStoreDisplay {
  providerLabel: "Keymaster Connect Storage";
  bucket: "managed-by-keymaster";
  rootPrefix: "managed-by-app-identity";
}

export interface ConnectDirectoryListing {
  prefix: string;
  parentPrefix: string;
  directories: Array<{ kind: "directory"; key: string; name: string }>;
  files: Array<{ kind: "file"; key: string; name: string; size: number; lastModified: string | null; etag: string | null }>;
  markerKey: string | null;
  nextContinuationToken?: string | null;
}

export interface ConnectObjectReadStream {
  stream: ReadableStream<Uint8Array>;
  contentLength: number | null;
}

export interface ConnectObjectStoreFixture {
  readonly display: ConnectObjectStoreDisplay;
  dispose(): void;
  probe(options?: { abortSignal?: AbortSignal }): Promise<void>;
  listDirectory(prefix: string, options?: { abortSignal?: AbortSignal; continuationToken?: string }): Promise<ConnectDirectoryListing>;
  hasAnyObject(prefix: string, options?: { abortSignal?: AbortSignal }): Promise<boolean>;
  createDirectory(prefix: string, name: string, options?: { overwrite?: boolean; abortSignal?: AbortSignal }): Promise<string>;
  putObject(prefix: string, file: File, options?: {
    objectName?: string;
    overwrite?: boolean;
    onProgress?: (progress: { loaded: number; total: number | null; progress: number | null }) => void;
    abortSignal?: AbortSignal;
  }): Promise<string>;
  getObjectStream(key: string, options?: { abortSignal?: AbortSignal }): Promise<ConnectObjectReadStream>;
  getObjectBlob(key: string, options?: { abortSignal?: AbortSignal }): Promise<Blob>;
  deleteObject(key: string, options?: { abortSignal?: AbortSignal }): Promise<void>;
  deleteDirectoryMarker(key: string, options?: { abortSignal?: AbortSignal }): Promise<void>;
}

export interface ConnectObjectStoreFixtureInput {
  service: StorageService;
  context: StorageAppContext;
  /** Defaults to the Connect protocol's 16 MiB multipart boundary. */
  multipartThresholdBytes?: number;
}

function abortIfRequested(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}

function asBinary(bytes: ArrayBuffer): { $type: "binary"; bytes: ArrayBuffer } {
  return { $type: "binary", bytes };
}

function mapListing(result: StorageListResult): ConnectDirectoryListing {
  return {
    prefix: result.prefix,
    parentPrefix: result.parentPrefix,
    directories: result.directories.map((entry) => ({ kind: "directory", key: entry.path, name: entry.name })),
    files: result.files.map((entry) => ({
      kind: "file",
      key: entry.path,
      name: entry.name,
      size: entry.size,
      lastModified: entry.lastModified ?? null,
      etag: entry.etag ?? null
    })),
    markerKey: result.markerPath ?? null,
    ...(result.nextCursor ? { nextContinuationToken: result.nextCursor } : { nextContinuationToken: null })
  };
}

async function fileBytes(file: Blob, signal?: AbortSignal): Promise<ArrayBuffer> {
  abortIfRequested(signal);
  const bytes = await file.arrayBuffer();
  abortIfRequested(signal);
  return bytes;
}

export function createConnectObjectStoreFixture(input: ConnectObjectStoreFixtureInput): ConnectObjectStoreFixture {
  const threshold = input.multipartThresholdBytes ?? STORAGE_PART_SIZE_BYTES;
  let disposed = false;
  const context = input.context;
  const service = input.service;
  const display: ConnectObjectStoreDisplay = {
    providerLabel: "Keymaster Connect Storage",
    bucket: "managed-by-keymaster",
    rootPrefix: "managed-by-app-identity"
  };

  function assertLive(): void {
    if (disposed) throw new Error("object_store_disposed");
  }

  return {
    display,
    dispose() { disposed = true; },
    async probe(options = {}) {
      assertLive();
      abortIfRequested(options.abortSignal);
      // A Connect caller has no provider-level probe method. A bounded list
      // is the equivalent readiness check and remains inside the namespace.
      await service.list(context, { prefix: "", limit: 1, signal: options.abortSignal });
    },
    async listDirectory(prefix, options = {}) {
      assertLive();
      abortIfRequested(options.abortSignal);
      return mapListing(await service.list(context, { prefix, cursor: options.continuationToken, signal: options.abortSignal }));
    },
    async hasAnyObject(prefix, options = {}) {
      const listing = await this.listDirectory(prefix, { abortSignal: options.abortSignal });
      return listing.files.length > 0 || listing.directories.length > 0 || listing.markerKey !== null;
    },
    async createDirectory(prefix, name, options = {}) {
      assertLive();
      abortIfRequested(options.abortSignal);
      const path = prefix ? `${prefix.replace(/\/$/u, "")}/${name}` : name;
      const result = await service.createDirectory(context, { path, overwrite: options.overwrite, signal: options.abortSignal });
      return result.path;
    },
    async putObject(prefix, file, options = {}) {
      assertLive();
      const path = `${prefix.replace(/\/$/u, "")}${prefix ? "/" : ""}${options.objectName ?? file.name}`;
      if (file.size <= threshold) {
        const bytes = await fileBytes(file, options.abortSignal);
        await service.put(context, { path, content: asBinary(bytes), contentType: file.type || undefined, overwrite: options.overwrite, signal: options.abortSignal });
        options.onProgress?.({ loaded: file.size, total: file.size, progress: 1 });
        return path;
      }

      const upload = await service.beginUpload(context, { path, contentType: file.type || undefined, size: file.size, overwrite: options.overwrite, signal: options.abortSignal });
      let completed = 0;
      try {
        for (let offset = 0, partNumber = 1; offset < file.size; offset += upload.partSize, partNumber += 1) {
          abortIfRequested(options.abortSignal);
          const bytes = await fileBytes(file.slice(offset, Math.min(offset + upload.partSize, file.size)), options.abortSignal);
          await service.uploadPart(context, { uploadId: upload.uploadId, partNumber, content: asBinary(bytes), signal: options.abortSignal });
          completed += bytes.byteLength;
          options.onProgress?.({ loaded: completed, total: file.size, progress: completed / file.size });
        }
        await service.completeUpload(context, { uploadId: upload.uploadId, signal: options.abortSignal });
        return path;
      } catch (error) {
        try { await service.abortUpload(context, { uploadId: upload.uploadId }); } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Connect multipart cleanup failed");
        }
        throw error;
      }
    },
    async getObjectStream(key, options = {}) {
      assertLive();
      abortIfRequested(options.abortSignal);
      let offset = 0;
      const first = await service.getRange(context, { path: key, offset, length: STORAGE_PART_SIZE_BYTES, signal: options.abortSignal });
      let pending: typeof first | undefined = first;
      let totalSize: number | null = first.totalSize;
      const etag = first.etag;
      if ((first.totalSize ?? 0) > STORAGE_PART_SIZE_BYTES && !etag) throw new Error("storage_conflict");
      let done = false;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            if (done) { controller.close(); return; }
            abortIfRequested(options.abortSignal);
            const result = pending ?? await service.getRange(context, { path: key, offset, length: STORAGE_PART_SIZE_BYTES, ifMatch: etag, signal: options.abortSignal });
            pending = undefined;
            const bytes = new Uint8Array(result.content.bytes);
            totalSize = result.totalSize;
            offset += bytes.byteLength;
            controller.enqueue(bytes);
            if (result.eof || bytes.byteLength === 0) { done = true; controller.close(); }
          } catch (error) {
            controller.error(error);
          }
        },
        cancel() { done = true; }
      });
      return { stream, contentLength: totalSize };
    },
    async getObjectBlob(key, options = {}) {
      const result = await this.getObjectStream(key, options);
      const reader = result.stream.getReader();
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          abortIfRequested(options.abortSignal);
          const next = await reader.read();
          if (next.done) break;
          if (next.value) chunks.push(next.value);
        }
      } finally { reader.releaseLock(); }
      return new Blob(chunks.map((chunk) => chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer));
    },
    async deleteObject(key, options = {}) {
      assertLive();
      abortIfRequested(options.abortSignal);
      await service.delete(context, { path: key, signal: options.abortSignal });
    },
    async deleteDirectoryMarker(key, options = {}) {
      assertLive();
      abortIfRequested(options.abortSignal);
      await service.deleteDirectory(context, { path: key, signal: options.abortSignal });
    }
  };
}
