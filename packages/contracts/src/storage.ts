import type { AppIdentitySnapshot } from "./appIdentity.js";
import type { BinaryField } from "./protocol.js";

/** Hard protocol limits. Keep these in contracts so both layers enforce them. */
export const STORAGE_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
export const STORAGE_PART_SIZE_BYTES = 16 * 1024 * 1024;
export const STORAGE_MAX_PARTS = 10_000;
export const STORAGE_DEFAULT_LIST_LIMIT = 200;
export const STORAGE_MAX_LIST_LIMIT = 1_000;
export const STORAGE_CURSOR_TTL_MS = 10 * 60 * 1000;
export const STORAGE_MAX_CURSORS_GLOBAL = 512;
export const STORAGE_MAX_CURSORS_PER_SESSION = 64;
export const STORAGE_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

export type StorageProviderId = "cloudflare-r2" | "aws-s3" | "s3-compatible";

export interface StorageAccessKeyAuth {
  kind: "access-key";
  accessKeyId: string;
  secretAccessKey: string;
}

export interface StorageR2Connection {
  accountId: string;
  endpointVariant: "default" | "eu" | "fedramp";
  bucket: string;
  prefix: string;
}

export interface StorageAwsConnection {
  region: string;
  bucket: string;
  prefix: string;
}

export interface StorageCompatibleConnection {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  forcePathStyle: boolean;
}

export type StorageConnection =
  | StorageR2Connection
  | StorageAwsConnection
  | StorageCompatibleConnection;

export type StorageSecretUpdate =
  | { mode: "retain" }
  | { mode: "replace"; accessKeyId: string; secretAccessKey: string };

/** Settings input. It is never exposed to Connect callers. */
export interface StorageProviderConfigDraft {
  providerId: StorageProviderId;
  connection: StorageConnection;
  credentials: StorageSecretUpdate;
}

/** Normalized internal configuration; credentials stay behind the Vault boundary. */
export interface NormalizedStorageProviderConfig {
  version: 1;
  providerId: StorageProviderId;
  connection: StorageConnection;
  credentials: StorageAccessKeyAuth;
}

export interface StorageProviderSummary {
  providerId: StorageProviderId;
  bucketHint: string;
  endpointHint?: string;
  prefix: string;
  accessKeyHint: string;
  secretConfigured: true;
  generation: number;
  updatedAt: number;
}

/** Non-secret connection fields used by the trusted Settings UI to edit an existing config. */
export interface StorageProviderConnectionView {
  providerId: StorageProviderId;
  connection: StorageConnection;
}

export type StorageServiceStatus =
  | "unconfigured"
  | "locked"
  | "checking"
  | "ready"
  | "reconfiguring"
  | "degraded";

export interface StorageProbeResult {
  ok: boolean;
  providerId: StorageProviderId;
  latencyMs: number;
  diagnostic?: "configuration" | "authentication" | "forbidden" | "not-found" | "cors" | "network" | "provider";
}

export type StorageConditionalWriteMode = "unknown" | "native" | "best-effort";
export type StorageCapabilitySource = "automatic" | "manual";

export interface StorageConditionalCapabilityView {
  mode: StorageConditionalWriteMode;
  source?: StorageCapabilitySource;
  updatedAt?: number;
}

export interface StorageConditionalCapabilitiesView {
  generation: number;
  put: StorageConditionalCapabilityView;
  complete: StorageConditionalCapabilityView;
}

export interface StorageConditionalCapabilityProbeResult {
  generation: number;
  put: "native" | "best-effort" | "inconclusive";
  complete: "native" | "best-effort" | "inconclusive";
  cleanupWarning: boolean;
}

export interface StorageAppContext {
  connectSessionId: string;
  transportOrigin: string;
  appIdentity: AppIdentitySnapshot;
}

export interface StorageListParams {
  connectSessionId: string;
  prefix?: string;
  cursor?: string;
  limit?: number;
}

export interface StorageListEntry {
  path: string;
  name: string;
  size: number;
  etag?: string;
  lastModified?: string;
}

export interface StorageListResult {
  prefix: string;
  parentPrefix: string;
  directories: Array<{ path: string; name: string }>;
  files: StorageListEntry[];
  markerPath?: string;
  nextCursor?: string;
}

export interface StorageDirectoryParams {
  connectSessionId: string;
  path: string;
  overwrite?: boolean;
}

export interface StorageDirectoryResult {
  path: string;
  created?: boolean;
  deleted?: boolean;
}

export interface StoragePutParams {
  connectSessionId: string;
  path: string;
  content: BinaryField;
  contentType?: string;
  overwrite?: boolean;
}

export interface StoragePutResult {
  path: string;
  size: number;
  etag?: string;
  updatedAt: number;
}

export interface StorageGetParams {
  connectSessionId: string;
  path: string;
  offset?: number;
  length?: number;
  ifMatch?: string;
}

export interface StorageGetResult {
  path: string;
  content: BinaryField;
  contentType?: string;
  offset: number;
  totalSize: number;
  eof: boolean;
  etag?: string;
  lastModified?: string;
}

export interface StorageDeleteParams {
  connectSessionId: string;
  path: string;
}

export interface StorageDeleteResult {
  path: string;
  deleted: true;
  updatedAt: number;
}

export interface StorageUploadBeginParams {
  connectSessionId: string;
  path: string;
  contentType?: string;
  size: number;
  overwrite?: boolean;
}

export interface StorageUploadBeginResult {
  uploadId: string;
  partSize: typeof STORAGE_PART_SIZE_BYTES;
  maxParts: typeof STORAGE_MAX_PARTS;
}

export interface StorageUploadPartParams {
  connectSessionId: string;
  uploadId: string;
  partNumber: number;
  content: BinaryField;
}

export interface StorageUploadPartResult {
  uploadId: string;
  partNumber: number;
  size: number;
}

export interface StorageUploadCompleteParams {
  connectSessionId: string;
  uploadId: string;
}

export interface StorageUploadAbortParams {
  connectSessionId: string;
  uploadId: string;
}

export interface StorageUploadAbortResult {
  uploadId: string;
  aborted: true;
}

/** Stable errors used by protocol and service. Error messages remain generic. */
export type StorageErrorCode =
  | "storage_not_configured"
  | "storage_unavailable"
  | "storage_invalid_path"
  | "storage_not_found"
  | "storage_conflict"
  | "storage_forbidden"
  | "storage_limit_exceeded"
  | "storage_invalid_upload"
  | "storage_provider_error"
  | "storage_identity_required";

export interface StorageService {
  status(): StorageServiceStatus;
  subscribe(listener: () => void): () => void;
  getProviderSummary(): Promise<StorageProviderSummary | null>;
  getProviderConnection(): Promise<StorageProviderConnectionView | null>;
  cancelProbe(): void;
  probeProvider(config: StorageProviderConfigDraft): Promise<StorageProbeResult>;
  getConditionalCapabilities(): StorageConditionalCapabilitiesView | null;
  probeConditionalCapabilities(signal?: AbortSignal): Promise<StorageConditionalCapabilityProbeResult>;
  activateProvider(config: StorageProviderConfigDraft): Promise<StorageProbeResult>;
  clearProviderConfig(): Promise<void>;
  /** Explicit, user-confirmed reset for unrecoverable Storage state. */
  resetStorage(): Promise<void>;
  abortSession(connectSessionId: string): Promise<void>;
  list(ctx: StorageAppContext, input: Omit<StorageListParams, "connectSessionId"> & { signal?: AbortSignal }): Promise<StorageListResult>;
  createDirectory(ctx: StorageAppContext, input: Omit<StorageDirectoryParams, "connectSessionId"> & { signal?: AbortSignal }): Promise<StorageDirectoryResult>;
  deleteDirectory(ctx: StorageAppContext, input: Omit<StorageDirectoryParams, "connectSessionId"> & { signal?: AbortSignal }): Promise<StorageDirectoryResult>;
  put(ctx: StorageAppContext, input: Omit<StoragePutParams, "connectSessionId"> & { signal?: AbortSignal }): Promise<StoragePutResult>;
  getRange(ctx: StorageAppContext, input: Omit<StorageGetParams, "connectSessionId"> & { signal?: AbortSignal }): Promise<StorageGetResult>;
  delete(ctx: StorageAppContext, input: Omit<StorageDeleteParams, "connectSessionId"> & { signal?: AbortSignal }): Promise<StorageDeleteResult>;
  beginUpload(ctx: StorageAppContext, input: Omit<StorageUploadBeginParams, "connectSessionId"> & { signal?: AbortSignal }): Promise<StorageUploadBeginResult>;
  uploadPart(ctx: StorageAppContext, input: Omit<StorageUploadPartParams, "connectSessionId"> & { signal?: AbortSignal }): Promise<StorageUploadPartResult>;
  completeUpload(ctx: StorageAppContext, input: Omit<StorageUploadCompleteParams, "connectSessionId"> & { signal?: AbortSignal }): Promise<StoragePutResult>;
  abortUpload(ctx: StorageAppContext, input: Omit<StorageUploadAbortParams, "connectSessionId"> & { signal?: AbortSignal }): Promise<StorageUploadAbortResult>;
}

export const STORAGE_SERVICE_CAPABILITY = "storage.service";
export const VAULT_LOCAL_SECRET_CAPABILITY = "vault.local-secret";
