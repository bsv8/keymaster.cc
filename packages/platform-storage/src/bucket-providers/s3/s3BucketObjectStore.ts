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
import { DOMParser as XmlDomParser } from "@xmldom/xmldom";
import { STORAGE_MAX_PAYLOAD_BYTES } from "@keymaster/contracts";
import type { NormalizedStorageProviderConfig } from "@keymaster/contracts";
import { providerEndpoint } from "./s3ClientFactory.js";
import { StorageRuntimeError } from "../../runtime/storageRuntimeError.js";
import { assertKeyInRoot } from "../bucketPath.js";

export interface BucketObject {
  key: string;
  size: number;
  etag?: string;
  lastModified?: Date;
}

export interface BucketListOutput {
  objects: BucketObject[];
  commonPrefixes: string[];
  nextContinuationToken?: string;
}

export interface BucketGetOutput {
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

export interface BucketObjectStore {
  probe(prefix: string, signal?: AbortSignal): Promise<void>;
  list(input: { namespaceRoot: string; prefix: string; delimiter?: string; continuationToken?: string; maxKeys: number; signal?: AbortSignal }): Promise<BucketListOutput>;
  put(input: { namespaceRoot: string; key: string; bytes: Uint8Array; contentType?: string; ifNoneMatch?: string; ifMatch?: string; signal?: AbortSignal }): Promise<{ etag?: string; lastModified?: Date }>;
  head(input: { namespaceRoot: string; key: string; signal?: AbortSignal }): Promise<boolean>;
  get(input: { namespaceRoot: string; key: string; range?: string; ifMatch?: string; signal?: AbortSignal }): Promise<BucketGetOutput>;
  delete(input: { namespaceRoot: string; key: string; ifMatch?: string; signal?: AbortSignal }): Promise<void>;
  createMultipart(input: { namespaceRoot: string; key: string; contentType?: string; signal?: AbortSignal }): Promise<string>;
  uploadPart(input: { namespaceRoot: string; key: string; uploadId: string; partNumber: number; bytes: Uint8Array; signal?: AbortSignal }): Promise<string>;
  completeMultipart(input: { namespaceRoot: string; key: string; uploadId: string; parts: Array<{ partNumber: number; etag: string }>; ifNoneMatch?: string; ifMatch?: string; signal?: AbortSignal }): Promise<{ etag?: string; lastModified?: Date }>;
  abortMultipart(input: { namespaceRoot: string; key: string; uploadId: string; signal?: AbortSignal }): Promise<void>;
  dispose(): void;
}

export interface BucketClientAdapter {
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
  destroy(): void;
}

export type BucketConditionalWriteMode = "unknown" | "native" | "best-effort";
export type BucketConditionalCapabilitySource = "automatic" | "manual";

export interface BucketConditionalCapability {
  mode: BucketConditionalWriteMode;
  source?: BucketConditionalCapabilitySource;
  updatedAt?: number;
  revision: number;
  /** In-flight unknown-mode probe; it gates only capability classification. */
  probe?: Promise<unknown>;
}

/** Runtime capability state shared by every store for one provider generation. */
export interface BucketObjectStoreCapabilityState {
  put: BucketConditionalCapability;
  complete: BucketConditionalCapability;
  subscribe?: (listener: () => void) => () => void;
}

export function createBucketObjectStoreCapabilityState(): BucketObjectStoreCapabilityState {
  const listeners = new Set<() => void>();
  const state: BucketObjectStoreCapabilityState = {
    put: { mode: "unknown", revision: 0 },
    complete: { mode: "unknown", revision: 0 },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  };
  Object.defineProperty(state, "_notify", { value: () => { for (const listener of listeners) listener(); }, enumerable: false });
  return state;
}

function notifyCapabilityState(state: BucketObjectStoreCapabilityState): void {
  const notify = (state as BucketObjectStoreCapabilityState & { _notify?: () => void })._notify;
  notify?.();
}

export function setBucketObjectStoreCapabilityMode(state: BucketObjectStoreCapabilityState, capability: "put" | "complete", mode: BucketConditionalWriteMode, source: BucketConditionalCapabilitySource): void {
  const target = state[capability];
  if (source === "manual") target.revision += 1;
  target.mode = mode;
  target.source = source;
  target.updatedAt = Date.now();
  notifyCapabilityState(state);
}

export function commitAutomaticBucketObjectStoreCapability(state: BucketObjectStoreCapabilityState, capability: "put" | "complete", mode: BucketConditionalWriteMode, revision: number): boolean {
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

/**
 * AWS SDK v3's browser XML protocol uses DOMParser and Node constants. Those
 * globals exist in Window but not in SharedWorkerGlobalScope, even though
 * fetch/Response are available there. Install the smallest required XML DOM
 * surface before the first S3 response is deserialized.
 */
export function ensureS3XmlRuntime(): void {
  const runtime = globalThis as unknown as {
    DOMParser?: typeof DOMParser;
    Node?: typeof Node;
  };
  if (typeof runtime.DOMParser !== "function") runtime.DOMParser = XmlDomParser as unknown as typeof DOMParser;
  if (typeof runtime.Node === "undefined") {
    class WorkerXmlNode {
      static readonly ELEMENT_NODE = 1;
      static readonly TEXT_NODE = 3;
    }
    runtime.Node = WorkerXmlNode as unknown as typeof Node;
  }
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

export function mapS3Error(error: unknown): StorageRuntimeError {
  if (error instanceof StorageRuntimeError) return error;
  const value = error as { $metadata?: { httpStatusCode?: number }; name?: string; Code?: string; message?: string; cause?: unknown } | undefined;
  const status = value?.$metadata?.httpStatusCode;
  const name = value?.name ?? value?.Code;
  const cause = value?.cause as { name?: string; message?: string } | undefined;
  const networkText = `${value?.message ?? ""} ${cause?.message ?? ""}`.toLowerCase();
  if (status === 401 || name === "InvalidAccessKeyId" || name === "SignatureDoesNotMatch" || name === "InvalidToken") return new StorageRuntimeError("storage_forbidden", "Storage provider authentication failed", "authentication");
  if (status === 403 || name === "AccessDenied") return new StorageRuntimeError("storage_forbidden", "Storage provider denied the operation", "forbidden");
  if (status === 404 || name === "NoSuchKey" || name === "NoSuchBucket") return new StorageRuntimeError("storage_not_found", "Storage object was not found");
  if (status === 409 || name === "ConditionalRequestConflict") return new StorageRuntimeError("storage_conflict", "Storage object changed during a conditional operation", "provider");
  if (status === 412 || name === "PreconditionFailed") return new StorageRuntimeError("storage_conflict", "Storage object already exists or changed", "provider");
  if (name === "AbortError" || (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError")) return new StorageRuntimeError("storage_unavailable", "Storage operation was cancelled");
  // Smithy may copy a browser fetch TypeError into an Error-shaped object,
  // which loses the native prototype across its retry/deserialization path.
  // Check both the name/message and a nested cause instead of relying only on
  // instanceof, otherwise an R2 CORS preflight failure becomes an opaque
  // "provider operation failed" message.
  if (error instanceof TypeError || name === "TypeError" || cause?.name === "TypeError" || /failed to fetch|fetch failed|network(?:error| error| request| failed)|load failed|\bcors\b/iu.test(networkText)) {
    return networkText.includes("cors")
      ? new StorageRuntimeError("storage_unavailable", "Storage provider CORS request failed", "cors")
      : new StorageRuntimeError("storage_unavailable", "Storage provider network or CORS request failed", "network");
  }
  const safeName = typeof name === "string" && /^[a-z][a-z0-9_.-]{0,63}$/iu.test(name) ? name : undefined;
  const safeCauseName = typeof cause?.name === "string" && /^[a-z][a-z0-9_.-]{0,63}$/iu.test(cause.name) ? cause.name : undefined;
  const safeReason = typeof value?.message === "string"
    ? value.message
      .replace(/https?:\/\/\S+/giu, "[url]")
      .replace(/\b[a-z0-9_+/=-]{16,}\b/giu, "[redacted]")
      .replace(/[\u0000-\u001f\u007f]+/gu, " ")
      .trim()
      .slice(0, 180)
    : "";
  const details = [status ? `HTTP ${status}` : "", safeName ? `error ${safeName}` : "", safeCauseName && safeCauseName !== safeName ? `cause ${safeCauseName}` : "", safeReason && safeReason !== safeName ? safeReason : ""].filter(Boolean);
  return new StorageRuntimeError("storage_provider_error", details.length ? `Storage provider operation failed (${details.join("; ")})` : "Storage provider operation failed", "provider");
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

function conditionalConflictError(): StorageRuntimeError {
  return new StorageRuntimeError("storage_conflict", "Storage object already exists or changed", "provider");
}

function isConditionalConflictProviderError(error: unknown): boolean {
  const value = error as { $metadata?: { httpStatusCode?: number }; name?: string; Code?: string } | undefined;
  const status = value?.$metadata?.httpStatusCode;
  return status === 409 || status === 412 || value?.name === "ConditionalRequestConflict" || value?.Code === "ConditionalRequestConflict" || value?.name === "PreconditionFailed" || value?.Code === "PreconditionFailed";
}

async function awaitCapabilityProbe(probe: Promise<unknown>, signal?: AbortSignal): Promise<void> {
  if (!signal) { await probe.catch(() => undefined); return; }
  if (signal.aborted) throw new StorageRuntimeError("storage_unavailable", "Storage operation was cancelled");
  let aborted = false;
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => { aborted = true; reject(new StorageRuntimeError("storage_unavailable", "Storage operation was cancelled")); };
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
    if (body.byteLength > maxBytes) throw new StorageRuntimeError("storage_limit_exceeded", "Storage provider returned too many bytes");
    return new Uint8Array(body);
  }
  if (body instanceof ArrayBuffer) {
    if (body.byteLength > maxBytes) throw new StorageRuntimeError("storage_limit_exceeded", "Storage provider returned too many bytes");
    return new Uint8Array(body);
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    if (body.size > maxBytes) throw new StorageRuntimeError("storage_limit_exceeded", "Storage provider returned too many bytes");
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
        if (length > maxBytes) throw new StorageRuntimeError("storage_limit_exceeded", "Storage provider returned too many bytes");
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
      if (length > maxBytes) throw new StorageRuntimeError("storage_limit_exceeded", "Storage provider returned too many bytes");
      chunks.push(chunk);
    }
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
    return output;
  }
  throw new StorageRuntimeError("storage_provider_error", "Storage provider returned an invalid body");
}

export function parseContentRange(value: string | undefined, fallbackSize: number | undefined, fallbackOffset = 0): { offset: number; end: number; totalSize: number } {
  if (!value) return { offset: fallbackOffset, end: fallbackOffset + (fallbackSize ?? 0) - 1, totalSize: fallbackOffset + (fallbackSize ?? 0) };
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/u.exec(value);
  if (!match) throw new StorageRuntimeError("storage_provider_error", "Storage provider returned an invalid Content-Range");
  const offset = Number(match[1]);
  const end = Number(match[2]);
  if (match[3] === "*") {
    throw new StorageRuntimeError("storage_provider_error", "Storage provider returned Content-Range with an unknown total size");
  }
  const totalSize = Number(match[3]);
  if (![offset, end, totalSize].every(Number.isSafeInteger) || end < offset || totalSize < end + 1) throw new StorageRuntimeError("storage_provider_error", "Storage provider returned an invalid Content-Range");
  return { offset, end, totalSize };
}

function missingExposedHeaderError(header: string): StorageRuntimeError {
  return new StorageRuntimeError(
    "storage_provider_error",
    `Storage provider did not expose ${header}; add ${header} to CORS Access-Control-Expose-Headers`,
    "cors"
  );
}

export function createS3BucketObjectStore(config: NormalizedStorageProviderConfig, options?: { client?: BucketClientAdapter; capabilityState?: BucketObjectStoreCapabilityState }): BucketObjectStore {
  ensureS3XmlRuntime();
  const details = connectionDetails(config);
  const client: BucketClientAdapter = options?.client ?? new S3Client({
    region: details.region,
    endpoint: details.endpoint,
    forcePathStyle: details.forcePathStyle,
    credentials: { accessKeyId: details.accessKeyId, secretAccessKey: details.secretAccessKey },
    requestHandler: new FetchHttpHandler({ requestInit: s3FetchRequestInit })
  }) as unknown as BucketClientAdapter;
  const send = async <T>(command: unknown, signal?: AbortSignal): Promise<T> => {
    try { return await client.send(command as never, signal ? { abortSignal: signal } : undefined) as T; } catch (error) { throw mapS3Error(error); }
  };
  const sendRaw = async <T>(command: unknown, signal?: AbortSignal): Promise<T> => {
    return await client.send(command as never, signal ? { abortSignal: signal } : undefined) as T;
  };
  const capabilityState = options?.capabilityState ?? createBucketObjectStoreCapabilityState();
  const bucketName = details.bucket;
  const head = async (input: { namespaceRoot: string; key: string; signal?: AbortSignal }): Promise<boolean> => {
    assertKeyInRoot(input.namespaceRoot, input.key);
    try {
      await send(new HeadObjectCommand({ Bucket: bucketName, Key: input.key }), input.signal);
      return true;
    } catch (error) {
      if (error instanceof StorageRuntimeError && error.code === "storage_not_found") return false;
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
      const put = async (ifNoneMatch?: string, ifMatch?: string) => {
        const result = await send<{ ETag?: string }>(new PutObjectCommand({ Bucket: bucketName, Key: input.key, Body: input.bytes, ContentType: input.contentType, ...(ifNoneMatch === undefined ? {} : { IfNoneMatch: ifNoneMatch }), ...(ifMatch === undefined ? {} : { IfMatch: ifMatch }) }), input.signal);
        return { etag: result.ETag?.replace(/^"|"$/gu, ""), lastModified: new Date() };
      };
      // Updating a partition head is a strict CAS operation. It is never
      // downgraded to HEAD -> PUT because that would allow two writers to
      // publish different commits over each other.
      if (input.ifMatch !== undefined) return await put(undefined, input.ifMatch);
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
            commitAutomaticBucketObjectStoreCapability(capabilityState, "put", "native", probeRevision);
            return { etag: result.ETag?.replace(/^"|"$/gu, ""), lastModified: new Date() };
          } catch (error) {
            if (isConditionalConflictProviderError(error)) {
              commitAutomaticBucketObjectStoreCapability(capabilityState, "put", "native", probeRevision);
              throw conditionalConflictError();
            }
            if (!isUnsupportedConditionalWriteError(error)) throw mapS3Error(error);
            commitAutomaticBucketObjectStoreCapability(capabilityState, "put", "best-effort", probeRevision);
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
      if (!result.Body) throw new StorageRuntimeError("storage_not_found", "Storage object was not found");
      const requestedOffset = input.range ? Number(/^bytes=(\d+)-/u.exec(input.range)?.[1] ?? 0) : 0;
      if (input.range && !result.ContentRange) throw new StorageRuntimeError("storage_provider_error", "Storage provider omitted Content-Range for a ranged response");
      if (result.ContentLength !== undefined && result.ContentLength > STORAGE_MAX_PAYLOAD_BYTES) throw new StorageRuntimeError("storage_limit_exceeded", "Storage provider returned too many bytes");
      const bytes = await readBody(result.Body);
      if (result.ContentLength !== undefined && bytes.byteLength !== result.ContentLength) throw new StorageRuntimeError("storage_provider_error", "Storage provider returned an invalid Content-Length");
      const range = parseContentRange(result.ContentRange, result.ContentLength, requestedOffset);
      if (result.ContentRange && bytes.byteLength !== range.end - range.offset + 1) throw new StorageRuntimeError("storage_provider_error", "Storage provider returned an invalid ranged body");
      return { bytes, offset: range.offset, contentType: result.ContentType, contentRange: result.ContentRange, contentLength: result.ContentLength, totalSize: range.totalSize, etag: result.ETag?.replace(/^"|"$/gu, ""), lastModified: result.LastModified };
    },
    async delete(input) { assertKeyInRoot(input.namespaceRoot, input.key); await send(new DeleteObjectCommand({ Bucket: bucketName, Key: input.key, ...(input.ifMatch ? { IfMatch: input.ifMatch } : {}) }), input.signal); },
    async createMultipart(input) {
      assertKeyInRoot(input.namespaceRoot, input.key);
      const result = await send<{ UploadId?: string }>(new CreateMultipartUploadCommand({ Bucket: bucketName, Key: input.key, ContentType: input.contentType }), input.signal);
      if (!result.UploadId) throw new StorageRuntimeError("storage_provider_error", "Storage provider did not return an upload id");
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
      const complete = async (ifNoneMatch?: string, ifMatch?: string) => {
        const result = await send<{ ETag?: string }>(new CompleteMultipartUploadCommand({ Bucket: bucketName, Key: input.key, UploadId: input.uploadId, ...(ifNoneMatch === undefined ? {} : { IfNoneMatch: ifNoneMatch }), ...(ifMatch === undefined ? {} : { IfMatch: ifMatch }), MultipartUpload: { Parts: input.parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })) } }), input.signal);
        return { etag: result.ETag?.replace(/^"|"$/gu, ""), lastModified: new Date() };
      };
      if (input.ifMatch !== undefined) return await complete(undefined, input.ifMatch);
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
            commitAutomaticBucketObjectStoreCapability(capabilityState, "complete", "native", probeRevision);
            return { etag: result.ETag?.replace(/^"|"$/gu, ""), lastModified: new Date() };
          } catch (error) {
            if (isConditionalConflictProviderError(error)) {
              commitAutomaticBucketObjectStoreCapability(capabilityState, "complete", "native", probeRevision);
              throw conditionalConflictError();
            }
            if (!isUnsupportedConditionalWriteError(error)) throw mapS3Error(error);
            commitAutomaticBucketObjectStoreCapability(capabilityState, "complete", "best-effort", probeRevision);
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
