import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand
} from "@aws-sdk/client-s3";
import { FetchHttpHandler } from "@smithy/fetch-http-handler";
import { STORAGE_MAX_PAYLOAD_BYTES } from "@keymaster/contracts";
import type { NormalizedStorageProviderConfig } from "@keymaster/contracts";
import { providerEndpoint } from "./providerConfig.js";
import { StorageServiceError } from "./storageErrors.js";
import { assertKeyInRoot } from "./storagePath.js";

export interface S3Object {
  key: string;
  size: number;
  etag?: string;
  lastModified?: Date;
}

export interface S3ListOutput {
  objects: S3Object[];
  commonPrefixes: string[];
  nextContinuationToken?: string;
}

export interface S3GetOutput {
  bytes: Uint8Array;
  /** Actual byte offset returned by the provider, when a range was requested. */
  offset?: number;
  contentType?: string;
  contentRange?: string;
  contentLength?: number;
  totalSize?: number;
  etag?: string;
  lastModified?: Date;
}

export interface S3ObjectStore {
  probe(prefix: string, signal?: AbortSignal): Promise<void>;
  list(input: { namespaceRoot: string; prefix: string; delimiter?: string; continuationToken?: string; maxKeys: number; signal?: AbortSignal }): Promise<S3ListOutput>;
  put(input: { namespaceRoot: string; key: string; bytes: Uint8Array; contentType?: string; ifNoneMatch?: string; signal?: AbortSignal }): Promise<{ etag?: string; lastModified?: Date }>;
  head(input: { namespaceRoot: string; key: string; signal?: AbortSignal }): Promise<boolean>;
  get(input: { namespaceRoot: string; key: string; range?: string; ifMatch?: string; signal?: AbortSignal }): Promise<S3GetOutput>;
  delete(input: { namespaceRoot: string; key: string; signal?: AbortSignal }): Promise<void>;
  createMultipart(input: { namespaceRoot: string; key: string; contentType?: string; signal?: AbortSignal }): Promise<string>;
  uploadPart(input: { namespaceRoot: string; key: string; uploadId: string; partNumber: number; bytes: Uint8Array; signal?: AbortSignal }): Promise<string>;
  completeMultipart(input: { namespaceRoot: string; key: string; uploadId: string; parts: Array<{ partNumber: number; etag: string }>; ifNoneMatch?: string; signal?: AbortSignal }): Promise<{ etag?: string; lastModified?: Date }>;
  abortMultipart(input: { namespaceRoot: string; key: string; uploadId: string; signal?: AbortSignal }): Promise<void>;
  dispose(): void;
}

export interface S3ClientAdapter {
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
  destroy(): void;
}

export type S3ConditionalWriteMode = "unknown" | "native" | "best-effort";
export type S3ConditionalCapabilitySource = "automatic" | "manual";

export interface S3ConditionalCapability {
  mode: S3ConditionalWriteMode;
  source?: S3ConditionalCapabilitySource;
  updatedAt?: number;
  revision: number;
  /** In-flight unknown-mode probe; it gates only capability classification. */
  probe?: Promise<unknown>;
}

/** Runtime capability state shared by every store for one provider generation. */
export interface S3ObjectStoreCapabilityState {
  put: S3ConditionalCapability;
  complete: S3ConditionalCapability;
  subscribe?: (listener: () => void) => () => void;
}

export function createS3ObjectStoreCapabilityState(): S3ObjectStoreCapabilityState {
  const listeners = new Set<() => void>();
  const state: S3ObjectStoreCapabilityState = {
    put: { mode: "unknown", revision: 0 },
    complete: { mode: "unknown", revision: 0 },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  };
  Object.defineProperty(state, "_notify", { value: () => { for (const listener of listeners) listener(); }, enumerable: false });
  return state;
}

function notifyCapabilityState(state: S3ObjectStoreCapabilityState): void {
  const notify = (state as S3ObjectStoreCapabilityState & { _notify?: () => void })._notify;
  notify?.();
}

export function setS3ObjectStoreCapabilityMode(state: S3ObjectStoreCapabilityState, capability: "put" | "complete", mode: S3ConditionalWriteMode, source: S3ConditionalCapabilitySource): void {
  const target = state[capability];
  if (source === "manual") target.revision += 1;
  target.mode = mode;
  target.source = source;
  target.updatedAt = Date.now();
  notifyCapabilityState(state);
}

export function commitAutomaticS3ObjectStoreCapability(state: S3ObjectStoreCapabilityState, capability: "put" | "complete", mode: S3ConditionalWriteMode, revision: number): boolean {
  const target = state[capability];
  if (target.revision !== revision || target.mode !== "unknown") return false;
  target.mode = mode;
  target.source = "automatic";
  target.updatedAt = Date.now();
  notifyCapabilityState(state);
  return true;
}

/**
 * Signed S3 requests must never be replayed to a redirect target. Rejecting all
 * redirects is intentionally stricter than the cross-origin requirement: a
 * legitimate S3 endpoint should answer the signed request directly, while even
 * a same-origin redirect can change the canonical path covered by SigV4.
 */
export function s3FetchRequestInit(): RequestInit {
  return { redirect: "error" };
}

function connectionDetails(config: NormalizedStorageProviderConfig): { region: string; endpoint?: string; forcePathStyle?: boolean; bucket: string; accessKeyId: string; secretAccessKey: string } {
  const connection = config.connection as { bucket: string; region?: string; forcePathStyle?: boolean };
  return {
    region: config.providerId === "cloudflare-r2" ? "auto" : connection.region ?? "us-east-1",
    endpoint: providerEndpoint(config),
    forcePathStyle: connection.forcePathStyle,
    bucket: connection.bucket,
    accessKeyId: config.credentials.accessKeyId,
    secretAccessKey: config.credentials.secretAccessKey
  };
}

export function mapS3Error(error: unknown): StorageServiceError {
  const value = error as { $metadata?: { httpStatusCode?: number }; name?: string; Code?: string } | undefined;
  const status = value?.$metadata?.httpStatusCode;
  const name = value?.name ?? value?.Code;
  if (status === 401 || name === "InvalidAccessKeyId" || name === "SignatureDoesNotMatch" || name === "InvalidToken") return new StorageServiceError("storage_forbidden", "Storage provider authentication failed", "authentication");
  if (status === 403 || name === "AccessDenied") return new StorageServiceError("storage_forbidden", "Storage provider denied the operation", "forbidden");
  if (status === 404 || name === "NoSuchKey" || name === "NoSuchBucket") return new StorageServiceError("storage_not_found", "Storage object was not found");
  if (status === 409 || name === "ConditionalRequestConflict") return new StorageServiceError("storage_conflict", "Storage object changed during a conditional operation", "provider");
  if (status === 412 || name === "PreconditionFailed") return new StorageServiceError("storage_conflict", "Storage object already exists or changed", "provider");
  if (name === "AbortError" || (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError")) return new StorageServiceError("storage_unavailable", "Storage operation was cancelled");
  if (error instanceof TypeError) {
    const message = error.message.toLowerCase();
    return message.includes("cors")
      ? new StorageServiceError("storage_unavailable", "Storage provider CORS request failed", "cors")
      : new StorageServiceError("storage_unavailable", "Storage provider network request failed", "network");
  }
  return new StorageServiceError("storage_provider_error", "Storage provider operation failed");
}

/**
 * Some S3-compatible providers (notably Backblaze B2) reject If-None-Match
 * with an explicit 501/NotImplemented response. Keep this check deliberately
 * narrow: only that response means that the provider lacks conditional-write
 * support and is safe to probe for a best-effort fallback.
 */
function isUnsupportedConditionalWriteError(error: unknown): boolean {
  const value = error as { $metadata?: { httpStatusCode?: number }; name?: string; Code?: string } | undefined;
  return value?.$metadata?.httpStatusCode === 501 && (value.name === "NotImplemented" || value.Code === "NotImplemented");
}

function conditionalConflictError(): StorageServiceError {
  return new StorageServiceError("storage_conflict", "Storage object already exists or changed", "provider");
}

function isConditionalConflictProviderError(error: unknown): boolean {
  const value = error as { $metadata?: { httpStatusCode?: number }; name?: string; Code?: string } | undefined;
  const status = value?.$metadata?.httpStatusCode;
  return status === 409 || status === 412 || value?.name === "ConditionalRequestConflict" || value?.Code === "ConditionalRequestConflict" || value?.name === "PreconditionFailed" || value?.Code === "PreconditionFailed";
}

async function awaitCapabilityProbe(probe: Promise<unknown>, signal?: AbortSignal): Promise<void> {
  if (!signal) { await probe.catch(() => undefined); return; }
  if (signal.aborted) throw new StorageServiceError("storage_unavailable", "Storage operation was cancelled");
  let aborted = false;
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => { aborted = true; reject(new StorageServiceError("storage_unavailable", "Storage operation was cancelled")); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    try { await Promise.race([probe, cancelled]); }
    catch (error) { if (aborted) throw error; /* The next request may reprobe after an ordinary failure. */ }
  }
  finally { signal.removeEventListener("abort", onAbort); }
}

export async function readBody(body: unknown, maxBytes = STORAGE_MAX_PAYLOAD_BYTES): Promise<Uint8Array> {
  if (body instanceof Uint8Array) {
    if (body.byteLength > maxBytes) throw new StorageServiceError("storage_limit_exceeded", "Storage provider returned too many bytes");
    return new Uint8Array(body);
  }
  if (body instanceof ArrayBuffer) {
    if (body.byteLength > maxBytes) throw new StorageServiceError("storage_limit_exceeded", "Storage provider returned too many bytes");
    return new Uint8Array(body);
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    if (body.size > maxBytes) throw new StorageServiceError("storage_limit_exceeded", "Storage provider returned too many bytes");
    return new Uint8Array(await body.arrayBuffer());
  }
  const streamBody = body as { transformToWebStream?: () => ReadableStream<Uint8Array> } | undefined;
  if (streamBody && typeof streamBody.transformToWebStream === "function") {
    const reader = streamBody.transformToWebStream().getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.byteLength;
        if (length > maxBytes) throw new StorageServiceError("storage_limit_exceeded", "Storage provider returned too many bytes");
        chunks.push(next.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
    return output;
  }
  if (body && typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === "function") {
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      length += chunk.byteLength;
      if (length > maxBytes) throw new StorageServiceError("storage_limit_exceeded", "Storage provider returned too many bytes");
      chunks.push(chunk);
    }
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
    return output;
  }
  throw new StorageServiceError("storage_provider_error", "Storage provider returned an invalid body");
}

export function parseContentRange(value: string | undefined, fallbackSize: number | undefined, fallbackOffset = 0): { offset: number; end: number; totalSize: number } {
  if (!value) return { offset: fallbackOffset, end: fallbackOffset + (fallbackSize ?? 0) - 1, totalSize: fallbackOffset + (fallbackSize ?? 0) };
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/u.exec(value);
  if (!match) throw new StorageServiceError("storage_provider_error", "Storage provider returned an invalid Content-Range");
  const offset = Number(match[1]);
  const end = Number(match[2]);
  if (match[3] === "*") {
    throw new StorageServiceError("storage_provider_error", "Storage provider returned Content-Range with an unknown total size");
  }
  const totalSize = Number(match[3]);
  if (![offset, end, totalSize].every(Number.isSafeInteger) || end < offset || totalSize < end + 1) throw new StorageServiceError("storage_provider_error", "Storage provider returned an invalid Content-Range");
  return { offset, end, totalSize };
}

function missingExposedHeaderError(header: string): StorageServiceError {
  return new StorageServiceError(
    "storage_provider_error",
    `Storage provider did not expose ${header}; add ${header} to CORS Access-Control-Expose-Headers`,
    "cors"
  );
}

export function createS3ObjectStore(config: NormalizedStorageProviderConfig, options?: { client?: S3ClientAdapter; capabilityState?: S3ObjectStoreCapabilityState }): S3ObjectStore {
  const details = connectionDetails(config);
  const client: S3ClientAdapter = options?.client ?? new S3Client({
    region: details.region,
    endpoint: details.endpoint,
    forcePathStyle: details.forcePathStyle,
    credentials: { accessKeyId: details.accessKeyId, secretAccessKey: details.secretAccessKey },
    requestHandler: new FetchHttpHandler({ requestInit: s3FetchRequestInit })
  }) as unknown as S3ClientAdapter;
  const send = async <T>(command: unknown, signal?: AbortSignal): Promise<T> => {
    try { return await client.send(command as never, signal ? { abortSignal: signal } : undefined) as T; } catch (error) { throw mapS3Error(error); }
  };
  const sendRaw = async <T>(command: unknown, signal?: AbortSignal): Promise<T> => {
    return await client.send(command as never, signal ? { abortSignal: signal } : undefined) as T;
  };
  const capabilityState = options?.capabilityState ?? createS3ObjectStoreCapabilityState();
  const bucketName = details.bucket;
  const head = async (input: { namespaceRoot: string; key: string; signal?: AbortSignal }): Promise<boolean> => {
    assertKeyInRoot(input.namespaceRoot, input.key);
    try {
      await send(new HeadObjectCommand({ Bucket: bucketName, Key: input.key }), input.signal);
      return true;
    } catch (error) {
      if (error instanceof StorageServiceError && error.code === "storage_not_found") return false;
      throw error;
    }
  };
  return {
    async probe(prefix, signal) {
      await send(new ListObjectsV2Command({ Bucket: bucketName, Prefix: prefix, MaxKeys: 1 }), signal);
    },
    async list(input) {
      assertKeyInRoot(input.namespaceRoot, input.prefix);
      const result = await send<{ Contents?: Array<{ Key?: string; Size?: number; ETag?: string; LastModified?: Date }>; CommonPrefixes?: Array<{ Prefix?: string }>; NextContinuationToken?: string }>(new ListObjectsV2Command({ Bucket: bucketName, Prefix: input.prefix, Delimiter: input.delimiter, ContinuationToken: input.continuationToken, MaxKeys: input.maxKeys }), input.signal);
      return {
        objects: (result.Contents ?? []).filter((entry): entry is { Key: string; Size?: number; ETag?: string; LastModified?: Date } => typeof entry.Key === "string").map((entry) => ({ key: entry.Key, size: entry.Size ?? 0, etag: entry.ETag?.replace(/^"|"$/gu, ""), lastModified: entry.LastModified })),
        commonPrefixes: (result.CommonPrefixes ?? []).flatMap((entry) => typeof entry.Prefix === "string" ? [entry.Prefix] : []),
        nextContinuationToken: result.NextContinuationToken
      };
    },
    async put(input) {
      assertKeyInRoot(input.namespaceRoot, input.key);
      const put = async (ifNoneMatch?: string) => {
        const result = await send<{ ETag?: string }>(new PutObjectCommand({ Bucket: bucketName, Key: input.key, Body: input.bytes, ContentType: input.contentType, ...(ifNoneMatch === undefined ? {} : { IfNoneMatch: ifNoneMatch }) }), input.signal);
        return { etag: result.ETag?.replace(/^"|"$/gu, ""), lastModified: new Date() };
      };
      if (input.ifNoneMatch === undefined) return await put();
      const capability = capabilityState.put;
      const bestEffortPut = async () => {
        if (await head({ namespaceRoot: input.namespaceRoot, key: input.key, signal: input.signal })) throw conditionalConflictError();
        return await put();
      };
      const conditionalPut = async (): Promise<{ etag?: string; lastModified?: Date }> => {
        if (capability.mode === "best-effort") return await bestEffortPut();
        if (capability.mode === "native") return await put(input.ifNoneMatch);
        if (capability.probe) {
          await awaitCapabilityProbe(capability.probe, input.signal);
          return await conditionalPut();
        }
        const probeRevision = capability.revision;
        const probe = (async () => {
          try {
            const result = await sendRaw<{ ETag?: string }>(new PutObjectCommand({ Bucket: bucketName, Key: input.key, Body: input.bytes, ContentType: input.contentType, IfNoneMatch: input.ifNoneMatch }), input.signal);
            commitAutomaticS3ObjectStoreCapability(capabilityState, "put", "native", probeRevision);
            return { etag: result.ETag?.replace(/^"|"$/gu, ""), lastModified: new Date() };
          } catch (error) {
            if (isConditionalConflictProviderError(error)) {
              commitAutomaticS3ObjectStoreCapability(capabilityState, "put", "native", probeRevision);
              throw conditionalConflictError();
            }
            if (!isUnsupportedConditionalWriteError(error)) throw mapS3Error(error);
            commitAutomaticS3ObjectStoreCapability(capabilityState, "put", "best-effort", probeRevision);
            return await bestEffortPut();
          }
        })();
        const gate = probe.then(() => undefined, () => undefined);
        capability.probe = gate;
        try { return await probe; }
        finally { if (capability.probe === gate) capability.probe = undefined; }
      };
      return await conditionalPut();
    },
    head,
    async get(input) {
      assertKeyInRoot(input.namespaceRoot, input.key);
      let result: { Body?: unknown; ContentType?: string; ContentRange?: string; ContentLength?: number; ContentLengthRange?: string; ETag?: string; LastModified?: Date };
      try {
        result = await sendRaw<{ Body?: unknown; ContentType?: string; ContentRange?: string; ContentLength?: number; ContentRangeLength?: string; ETag?: string; LastModified?: Date }>(new GetObjectCommand({ Bucket: bucketName, Key: input.key, Range: input.range, IfMatch: input.ifMatch }), input.signal);
      } catch (error) {
        const raw = error as { $metadata?: { httpStatusCode?: number }; name?: string };
        const requestedOffset = input.range ? Number(/^bytes=(\d+)-/u.exec(input.range)?.[1] ?? 0) : 0;
        if (input.range && requestedOffset === 0 && (raw.$metadata?.httpStatusCode === 416 || raw.name === "InvalidRange")) {
          const headResult = await sendRaw<{ ContentLength?: number; ContentType?: string; ETag?: string; LastModified?: Date }>(new HeadObjectCommand({ Bucket: bucketName, Key: input.key, IfMatch: input.ifMatch }), input.signal);
          if (headResult.ContentLength === 0) return { bytes: new Uint8Array(0), offset: 0, totalSize: 0, contentLength: 0, contentType: headResult.ContentType, etag: headResult.ETag?.replace(/^"|"$/gu, ""), lastModified: headResult.LastModified };
        }
        throw mapS3Error(error);
      }
      if (!result.Body) throw new StorageServiceError("storage_not_found", "Storage object was not found");
      const requestedOffset = input.range ? Number(/^bytes=(\d+)-/u.exec(input.range)?.[1] ?? 0) : 0;
      if (input.range && !result.ContentRange) throw new StorageServiceError("storage_provider_error", "Storage provider omitted Content-Range for a ranged response");
      if (result.ContentLength !== undefined && result.ContentLength > STORAGE_MAX_PAYLOAD_BYTES) throw new StorageServiceError("storage_limit_exceeded", "Storage provider returned too many bytes");
      const bytes = await readBody(result.Body);
      if (result.ContentLength !== undefined && bytes.byteLength !== result.ContentLength) throw new StorageServiceError("storage_provider_error", "Storage provider returned an invalid Content-Length");
      const range = parseContentRange(result.ContentRange, result.ContentLength, requestedOffset);
      if (result.ContentRange && bytes.byteLength !== range.end - range.offset + 1) throw new StorageServiceError("storage_provider_error", "Storage provider returned an invalid ranged body");
      return { bytes, offset: range.offset, contentType: result.ContentType, contentRange: result.ContentRange, contentLength: result.ContentLength, totalSize: range.totalSize, etag: result.ETag?.replace(/^"|"$/gu, ""), lastModified: result.LastModified };
    },
    async delete(input) { assertKeyInRoot(input.namespaceRoot, input.key); await send(new DeleteObjectCommand({ Bucket: bucketName, Key: input.key }), input.signal); },
    async createMultipart(input) {
      assertKeyInRoot(input.namespaceRoot, input.key);
      const result = await send<{ UploadId?: string }>(new CreateMultipartUploadCommand({ Bucket: bucketName, Key: input.key, ContentType: input.contentType }), input.signal);
      if (!result.UploadId) throw new StorageServiceError("storage_provider_error", "Storage provider did not return an upload id");
      return result.UploadId;
    },
    async uploadPart(input) {
      assertKeyInRoot(input.namespaceRoot, input.key);
      const result = await send<{ ETag?: string }>(new UploadPartCommand({ Bucket: bucketName, Key: input.key, UploadId: input.uploadId, PartNumber: input.partNumber, Body: input.bytes }), input.signal);
      if (!result.ETag) throw missingExposedHeaderError("ETag");
      return result.ETag.replace(/^"|"$/gu, "");
    },
    async completeMultipart(input) {
      assertKeyInRoot(input.namespaceRoot, input.key);
      const complete = async (ifNoneMatch?: string) => {
        const result = await send<{ ETag?: string }>(new CompleteMultipartUploadCommand({ Bucket: bucketName, Key: input.key, UploadId: input.uploadId, ...(ifNoneMatch === undefined ? {} : { IfNoneMatch: ifNoneMatch }), MultipartUpload: { Parts: input.parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })) } }), input.signal);
        return { etag: result.ETag?.replace(/^"|"$/gu, ""), lastModified: new Date() };
      };
      if (input.ifNoneMatch === undefined) return await complete();
      const capability = capabilityState.complete;
      const bestEffortComplete = async () => {
        if (await head({ namespaceRoot: input.namespaceRoot, key: input.key, signal: input.signal })) throw conditionalConflictError();
        return await complete();
      };
      const conditionalComplete = async (): Promise<{ etag?: string; lastModified?: Date }> => {
        if (capability.mode === "best-effort") return await bestEffortComplete();
        if (capability.mode === "native") return await complete(input.ifNoneMatch);
        if (capability.probe) {
          await awaitCapabilityProbe(capability.probe, input.signal);
          return await conditionalComplete();
        }
        const probeRevision = capability.revision;
        const probe = (async () => {
          try {
            const result = await sendRaw<{ ETag?: string }>(new CompleteMultipartUploadCommand({ Bucket: bucketName, Key: input.key, UploadId: input.uploadId, IfNoneMatch: input.ifNoneMatch, MultipartUpload: { Parts: input.parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })) } }), input.signal);
            commitAutomaticS3ObjectStoreCapability(capabilityState, "complete", "native", probeRevision);
            return { etag: result.ETag?.replace(/^"|"$/gu, ""), lastModified: new Date() };
          } catch (error) {
            if (isConditionalConflictProviderError(error)) {
              commitAutomaticS3ObjectStoreCapability(capabilityState, "complete", "native", probeRevision);
              throw conditionalConflictError();
            }
            if (!isUnsupportedConditionalWriteError(error)) throw mapS3Error(error);
            commitAutomaticS3ObjectStoreCapability(capabilityState, "complete", "best-effort", probeRevision);
            return await bestEffortComplete();
          }
        })();
        const gate = probe.then(() => undefined, () => undefined);
        capability.probe = gate;
        try { return await probe; }
        finally { if (capability.probe === gate) capability.probe = undefined; }
      };
      return await conditionalComplete();
    },
    async abortMultipart(input) { assertKeyInRoot(input.namespaceRoot, input.key); await send(new AbortMultipartUploadCommand({ Bucket: bucketName, Key: input.key, UploadId: input.uploadId }), input.signal); },
    dispose() { client.destroy(); }
  };
}
