import type {
  NormalizedStorageProviderConfig,
  StorageAwsConnection,
  StorageCompatibleConnection,
  StorageProviderConfigDraft,
  StorageProviderId,
  StorageProviderSummary,
  StorageR2Connection
} from "@keymaster/contracts";
import { normalizeProviderPrefix } from "./storagePath.js";
import { StorageServiceError } from "./storageErrors.js";

function text(value: unknown, field: string, max = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new StorageServiceError("storage_invalid_path", `${field} is invalid`);
  }
  return value;
}

function bucket(value: unknown): string {
  const result = text(value, "bucket", 63);
  if (!/^[a-z0-9](?:[a-z0-9.-]{1,61})[a-z0-9]$/u.test(result)) {
    throw new StorageServiceError("storage_provider_error", "bucket is invalid");
  }
  return result;
}

function endpoint(value: unknown): string {
  const raw = text(value, "endpoint", 2048);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new StorageServiceError("storage_provider_error", "endpoint must be an absolute HTTPS URL");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash || parsed.search || (raw !== parsed.toString() && raw !== parsed.toString().replace(/\/$/u, ""))) {
    throw new StorageServiceError("storage_provider_error", "endpoint must be an HTTPS URL without credentials");
  }
  return parsed.toString().replace(/\/$/u, "");
}

function credentials(draft: StorageProviderConfigDraft, existing?: NormalizedStorageProviderConfig): { accessKeyId: string; secretAccessKey: string } {
  if (draft.credentials.mode === "retain") {
    if (!existing || existing.providerId !== draft.providerId) throw new StorageServiceError("storage_provider_error", "credentials must be replaced for a new provider");
    return { ...existing.credentials };
  }
  const accessKeyId = text(draft.credentials.accessKeyId, "accessKeyId", 256);
  const secretAccessKey = text(draft.credentials.secretAccessKey, "secretAccessKey", 1024);
  return { accessKeyId, secretAccessKey };
}

function connection(providerId: StorageProviderId, value: StorageProviderConfigDraft["connection"]): NormalizedStorageProviderConfig["connection"] {
  if (providerId === "aws-s3") {
    const input = value as StorageAwsConnection;
    return { region: text(input.region, "region", 64), bucket: bucket(input.bucket), prefix: normalizeProviderPrefix(input.prefix) };
  }
  if (providerId === "cloudflare-r2") {
    const input = value as StorageR2Connection;
    const accountId = text(input.accountId, "accountId", 64);
    if (!/^[a-f0-9]{32}$/iu.test(accountId)) throw new StorageServiceError("storage_provider_error", "accountId is invalid");
    if (!["default", "eu", "fedramp"].includes(input.endpointVariant)) throw new StorageServiceError("storage_provider_error", "endpointVariant is invalid");
    return { accountId: accountId.toLowerCase(), endpointVariant: input.endpointVariant, bucket: bucket(input.bucket), prefix: normalizeProviderPrefix(input.prefix) };
  }
  const input = value as StorageCompatibleConnection;
  return {
    endpoint: endpoint(input.endpoint),
    region: text(input.region, "region", 64),
    bucket: bucket(input.bucket),
    prefix: normalizeProviderPrefix(input.prefix),
    forcePathStyle: input.forcePathStyle === true
  };
}

export function normalizeProviderConfig(draft: StorageProviderConfigDraft, existing?: NormalizedStorageProviderConfig): NormalizedStorageProviderConfig {
  if (!draft || !["aws-s3", "cloudflare-r2", "s3-compatible"].includes(draft.providerId)) throw new StorageServiceError("storage_provider_error", "providerId is invalid");
  return { version: 1, providerId: draft.providerId, connection: connection(draft.providerId, draft.connection), credentials: { kind: "access-key", ...credentials(draft, existing) } };
}

export function providerEndpoint(config: NormalizedStorageProviderConfig): string | undefined {
  if (config.providerId === "s3-compatible") return (config.connection as StorageCompatibleConnection).endpoint;
  if (config.providerId !== "cloudflare-r2") return undefined;
  const input = config.connection as StorageR2Connection;
  const variant = input.endpointVariant === "default" ? "" : `.${input.endpointVariant}`;
  return `https://${input.accountId}${variant}.r2.cloudflarestorage.com`;
}

export function summaryForConfig(config: NormalizedStorageProviderConfig, generation: number, updatedAt: number): StorageProviderSummary {
  const bucketValue = (config.connection as { bucket: string }).bucket;
  const key = config.credentials.accessKeyId;
  return {
    providerId: config.providerId,
    bucketHint: bucketValue.length <= 6 ? "••••" : `${bucketValue.slice(0, 2)}••••${bucketValue.slice(-2)}`,
    endpointHint: providerEndpoint(config),
    prefix: (config.connection as { prefix: string }).prefix,
    accessKeyHint: key.length <= 4 ? "••••" : `••••${key.slice(-4)}`,
    secretConfigured: true,
    generation,
    updatedAt
  };
}

export function configToBytes(config: NormalizedStorageProviderConfig): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(config));
}

export function configFromBytes(bytes: Uint8Array): NormalizedStorageProviderConfig {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new StorageServiceError("storage_provider_error", "stored provider config is invalid"); }
  if (!parsed || typeof parsed !== "object") throw new StorageServiceError("storage_provider_error", "stored provider config is invalid");
  const value = parsed as NormalizedStorageProviderConfig;
  if (value.version !== 1 || !value.credentials || value.credentials.kind !== "access-key") throw new StorageServiceError("storage_provider_error", "stored provider config is invalid");
  return normalizeProviderConfig({ providerId: value.providerId, connection: value.connection, credentials: { mode: "replace", accessKeyId: value.credentials.accessKeyId, secretAccessKey: value.credentials.secretAccessKey } });
}
