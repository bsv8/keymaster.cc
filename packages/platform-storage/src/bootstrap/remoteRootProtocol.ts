// 远端 Keymaster namespace 根协议。
//
// Provider 只提供慢速 bytes/CAS 原语；本模块负责固定入口、严格 manifest
// 解析、完整性认证和错误分类。其它对象即使存在，也不能被解释成已初始化
// 的 Keymaster namespace。

import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type {
  DeviceRemoteStorageLocationV1,
  RemoteRootIntegrityV1,
  RemoteStorageRootManifestV1,
  StorageKeyDerivationV1,
} from "@keymaster/contracts";
import {
  REMOTE_STORAGE_INITIALIZATION_TRANSACTION_PREFIX,
  REMOTE_STORAGE_ROOT_MANIFEST_PATH,
  REMOTE_STORAGE_STAGING_PREFIX,
  deviceRemoteStorageLocationFingerprint,
  validateDeviceRemoteStorageLocation,
} from "@keymaster/contracts";
import type { StorageBucketProvider } from "@keymaster/contracts";
import { StorageRuntimeError, storageErrorCode } from "../runtime/storageError.js";
import { assertProviderPath } from "../bucket-providers/bucketProvider.js";

export const REMOTE_ROOT_MANIFEST_MAX_BYTES = 64 * 1024;
export const REMOTE_INITIALIZATION_RECORD_MAX_BYTES = 32 * 1024;

export interface RemoteStorageRootManifestInput {
  remoteStorageId: string;
  namespaceVersion: 1;
  createdAt: number;
  keyDerivation: StorageKeyDerivationV1;
  rootHead: RemoteStorageRootManifestV1["rootHead"];
  system: RemoteStorageRootManifestV1["system"];
  initializationTransactionId: string;
}

type UnsignedManifest = Omit<RemoteStorageRootManifestV1, "integrity">;

/** 根 manifest 的认证器；secret 只应存在于当前 Worker/调用栈内存。 */
export interface RemoteRootAuthenticator {
  sign(payload: Uint8Array): Uint8Array | Promise<Uint8Array>;
  verify(payload: Uint8Array, tagB64Url: string): void | Promise<void>;
  dispose?(): void;
}

export interface RemoteRootObject {
  manifest: RemoteStorageRootManifestV1;
  etag?: string;
  fingerprint: string;
}

export type RemoteRootDiscoveryResult =
  | { status: "absent" }
  | { status: "present"; object: RemoteRootObject }
  | { status: "forbidden"; diagnostic?: "authentication" | "forbidden" }
  | { status: "unavailable"; diagnostic?: "network" | "cors" | "timeout" | "unknown" }
  | { status: "corrupt"; diagnostic?: string }
  | { status: "incompatible"; diagnostic?: string };

function fail(code: "storage_provider_error" | "storage_remote_corrupt" | "storage_remote_incompatible", message: string): StorageRuntimeError {
  return new StorageRuntimeError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function text(value: unknown, field: string, max: number, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || (pattern && !pattern.test(value))) throw fail("storage_remote_corrupt", `Remote root ${field} is invalid`);
  return value;
}

function integer(value: unknown, field: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw fail("storage_remote_corrupt", `Remote root ${field} is invalid`);
  return value;
}

function exact(value: Record<string, unknown>, fields: readonly string[], field: string): void {
  const allowed = new Set(fields);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw fail("storage_remote_corrupt", `Remote root ${field} contains unknown fields`);
}

function path(value: unknown, field: string): string {
  const result = text(value, field, 1_024);
  try { assertProviderPath(result); } catch { throw fail("storage_remote_corrupt", `Remote root ${field} is outside the namespace`); }
  if (!result.startsWith(".keymaster/")) throw fail("storage_remote_corrupt", `Remote root ${field} is outside the Keymaster namespace`);
  return result;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

/** 用确定性 JSON 序列化 manifest，避免字段顺序成为认证输入。 */
export function serializeRemoteRootManifestUnsigned(value: RemoteStorageRootManifestInput): Uint8Array {
  const unsigned: UnsignedManifest = {
    format: "keymaster.remote-root",
    version: 1,
    remoteStorageId: value.remoteStorageId,
    namespaceVersion: value.namespaceVersion,
    createdAt: value.createdAt,
    keyDerivation: { ...value.keyDerivation },
    rootHead: { ...value.rootHead },
    system: { ...value.system },
    initializationTransactionId: value.initializationTransactionId,
  };
  return new TextEncoder().encode(JSON.stringify(canonicalize(unsigned)));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = typeof btoa === "function" ? btoa(binary) : Buffer.from(bytes).toString("base64");
  return base64.replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string, field: string, minimumLength: number, maximumLength: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw fail("storage_remote_corrupt", `Remote root ${field} is invalid`);
  const base64 = value.replace(/-/gu, "+").replace(/_/gu, "/") + "=".repeat((4 - value.length % 4) % 4);
  try {
    let decoded: Uint8Array;
    if (typeof atob === "function") {
      const binary = atob(base64);
      decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    } else {
      decoded = new Uint8Array(Buffer.from(base64, "base64"));
    }
    if (decoded.byteLength < minimumLength || decoded.byteLength > maximumLength) throw new Error("length");
    return decoded;
  } catch {
    throw fail("storage_remote_corrupt", `Remote root ${field} is invalid`);
  }
}

function base64UrlToBytes(value: string): Uint8Array {
  if (value.length !== 43) throw fail("storage_remote_corrupt", "Remote root integrity tag is invalid");
  return decodeBase64Url(value, "integrity tag", 32, 32);
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

/** 创建用于根 manifest 的 HMAC-SHA-256 认证器。 */
export function createHmacRemoteRootAuthenticator(secret: Uint8Array): RemoteRootAuthenticator {
  if (!(secret instanceof Uint8Array) || secret.byteLength < 16 || secret.byteLength > 128) {
    throw new StorageRuntimeError("storage_identity_required", "Remote root authentication key is invalid");
  }
  const key = secret.slice();
  return {
    sign(payload) {
      return hmac(sha256, key, payload);
    },
    verify(payload, tagB64Url) {
      const expected = hmac(sha256, key, payload);
      const actual = base64UrlToBytes(tagB64Url);
      if (!constantTimeEqual(expected, actual)) throw new StorageRuntimeError("storage_forbidden", "Remote root manifest authentication failed", "authentication");
    },
    dispose() { key.fill(0); },
  };
}

/**
 * Derive the root-manifest authentication key from the bucket password and
 * public Hold KDF descriptor. The extra salt domain keeps this key separate
 * from the Hold encryption and authentication subkeys.
 */
export async function deriveRemoteRootAuthenticator(
  password: string,
  keyDerivation: StorageKeyDerivationV1,
): Promise<RemoteRootAuthenticator> {
  if (typeof password !== "string" || password.length < 8) {
    throw new StorageRuntimeError("storage_identity_required", "Remote root password is invalid");
  }
  if (keyDerivation.algorithm !== "pbkdf2-hmac-sha-256"
    || keyDerivation.passwordEncoding !== "utf-8"
    || keyDerivation.outputLengthBits !== 256
    || !Number.isSafeInteger(keyDerivation.iterations)
    || keyDerivation.iterations < 100_000
    || keyDerivation.iterations > 2_000_000) {
    throw new StorageRuntimeError("storage_remote_corrupt", "Remote root key derivation is invalid");
  }
  const baseSalt = decodeBase64Url(keyDerivation.saltB64Url, "key derivation salt", 8, 64);
  const domain = new TextEncoder().encode("keymaster.remote-root.hmac.v1");
  const saltInput = new Uint8Array(baseSalt.byteLength + domain.byteLength);
  saltInput.set(baseSalt);
  saltInput.set(domain, baseSalt.byteLength);
  const salt = sha256(saltInput);
  saltInput.fill(0);
  baseSalt.fill(0);
  const encodedPassword = new TextEncoder().encode(password);
  try {
    const material = await crypto.subtle.importKey("raw", encodedPassword, "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: keyDerivation.iterations }, material, 256);
    const secret = new Uint8Array(bits);
    try { return createHmacRemoteRootAuthenticator(secret); }
    finally { secret.fill(0); }
  } finally {
    encodedPassword.fill(0);
    salt.fill(0);
  }
}

/** 严格校验根 manifest 的结构和 namespace 路径。 */
export function validateRemoteRootManifest(value: unknown): RemoteStorageRootManifestV1 {
  if (!isRecord(value)) throw fail("storage_remote_corrupt", "Remote root manifest is invalid");
  exact(value, ["createdAt", "format", "initializationTransactionId", "integrity", "keyDerivation", "namespaceVersion", "remoteStorageId", "rootHead", "system", "version"], "manifest");
  if (value.format !== "keymaster.remote-root") throw fail("storage_remote_corrupt", "Remote root manifest format is invalid");
  if (value.version !== 1 || value.namespaceVersion !== 1) throw fail("storage_remote_incompatible", "Remote root manifest version is unsupported");
  const remoteStorageId = text(value.remoteStorageId, "remoteStorageId", 128, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
  const createdAt = integer(value.createdAt, "createdAt");
  if (!isRecord(value.keyDerivation)) throw fail("storage_remote_corrupt", "Remote root keyDerivation is invalid");
  exact(value.keyDerivation, ["algorithm", "iterations", "outputLengthBits", "passwordEncoding", "saltB64Url"], "keyDerivation");
  if (value.keyDerivation.algorithm !== "pbkdf2-hmac-sha-256" || value.keyDerivation.passwordEncoding !== "utf-8" || value.keyDerivation.outputLengthBits !== 256) throw fail("storage_remote_incompatible", "Remote root key derivation is unsupported");
  const iterations = integer(value.keyDerivation.iterations, "keyDerivation.iterations", 100_000);
  if (iterations > 2_000_000) throw fail("storage_remote_corrupt", "Remote root keyDerivation.iterations is invalid");
  const saltB64Url = text(value.keyDerivation.saltB64Url, "keyDerivation.saltB64Url", 128, /^[A-Za-z0-9_-]+$/u);
  decodeBase64Url(saltB64Url, "key derivation salt", 8, 64);
  const keyDerivation: StorageKeyDerivationV1 = { algorithm: "pbkdf2-hmac-sha-256", passwordEncoding: "utf-8", iterations, outputLengthBits: 256, saltB64Url };
  const initializationTransactionId = text(value.initializationTransactionId, "initializationTransactionId", 128, /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u);
  if (!isRecord(value.rootHead)) throw fail("storage_remote_corrupt", "Remote root rootHead is invalid");
  exact(value.rootHead, ["path", "revision"], "rootHead");
  const rootHead = { path: path(value.rootHead.path, "rootHead.path"), revision: integer(value.rootHead.revision, "rootHead.revision") };
  if (!isRecord(value.system)) throw fail("storage_remote_corrupt", "Remote root system is invalid");
  exact(value.system, ["holdHeadPath", "schemaPath"], "system");
  const system = { schemaPath: path(value.system.schemaPath, "system.schemaPath"), holdHeadPath: path(value.system.holdHeadPath, "system.holdHeadPath") };
  if (!isRecord(value.integrity)) throw fail("storage_remote_corrupt", "Remote root integrity is invalid");
  exact(value.integrity, ["algorithm", "tagB64Url"], "integrity");
  if (value.integrity.algorithm !== "hmac-sha-256") throw fail("storage_remote_incompatible", "Remote root integrity algorithm is unsupported");
  const integrity: RemoteRootIntegrityV1 = { algorithm: "hmac-sha-256", tagB64Url: text(value.integrity.tagB64Url, "integrity.tagB64Url", 128) };
  if (base64UrlToBytes(integrity.tagB64Url).byteLength !== 32) throw fail("storage_remote_corrupt", "Remote root integrity tag has an invalid length");
  return { format: "keymaster.remote-root", version: 1, remoteStorageId, namespaceVersion: 1, createdAt, keyDerivation, rootHead, system, initializationTransactionId, integrity };
}

/** 对根 manifest 进行 HMAC 签名。 */
export async function sealRemoteRootManifest(input: RemoteStorageRootManifestInput, authenticator: RemoteRootAuthenticator): Promise<RemoteStorageRootManifestV1> {
  const unsigned: RemoteStorageRootManifestInput = {
    remoteStorageId: input.remoteStorageId,
    namespaceVersion: input.namespaceVersion,
    createdAt: input.createdAt,
    keyDerivation: { ...input.keyDerivation },
    rootHead: { ...input.rootHead },
    system: { ...input.system },
    initializationTransactionId: input.initializationTransactionId,
  };
  // Validate the unsigned shape before asking the authenticator to sign it.
  validateRemoteRootManifest({ ...unsigned, format: "keymaster.remote-root", version: 1, integrity: { algorithm: "hmac-sha-256", tagB64Url: bytesToBase64Url(new Uint8Array(32)) } });
  const tag = await authenticator.sign(serializeRemoteRootManifestUnsigned(unsigned));
  const manifest = validateRemoteRootManifest({ ...unsigned, format: "keymaster.remote-root", version: 1, integrity: { algorithm: "hmac-sha-256", tagB64Url: bytesToBase64Url(tag) } });
  return manifest;
}

/** 解析并验证根 manifest 的完整性。 */
export async function verifyRemoteRootManifest(value: unknown, authenticator: RemoteRootAuthenticator): Promise<RemoteStorageRootManifestV1> {
  const manifest = validateRemoteRootManifest(value);
  await authenticator.verify(serializeRemoteRootManifestUnsigned(manifest), manifest.integrity.tagB64Url);
  return manifest;
}

export function encodeRemoteRootManifest(manifest: RemoteStorageRootManifestV1): Uint8Array {
  const checked = validateRemoteRootManifest(manifest);
  const bytes = new TextEncoder().encode(JSON.stringify(checked));
  if (bytes.byteLength > REMOTE_ROOT_MANIFEST_MAX_BYTES) throw new StorageRuntimeError("storage_limit_exceeded", "Remote root manifest is too large");
  return bytes;
}

export function decodeRemoteRootManifest(bytes: Uint8Array): unknown {
  if (bytes.byteLength > REMOTE_ROOT_MANIFEST_MAX_BYTES) throw fail("storage_remote_corrupt", "Remote root manifest is too large");
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; } catch { throw fail("storage_remote_corrupt", "Remote root manifest JSON is invalid"); }
}

export function remoteRootManifestFingerprint(manifestOrBytes: RemoteStorageRootManifestV1 | Uint8Array): string {
  const bytes = manifestOrBytes instanceof Uint8Array ? manifestOrBytes : encodeRemoteRootManifest(manifestOrBytes);
  return Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 规范化 endpoint/region/bucket/prefix 后生成物理位置指纹。 */
export function physicalLocationFingerprint(location: DeviceRemoteStorageLocationV1): string {
  return deviceRemoteStorageLocationFingerprint(validateDeviceRemoteStorageLocation(location));
}

function transactionPath(transactionId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(transactionId)) throw new StorageRuntimeError("storage_provider_error", "Initialization transaction ID is invalid");
  return `${REMOTE_STORAGE_INITIALIZATION_TRANSACTION_PREFIX}${transactionId}`;
}

function stagingPath(transactionId: string, suffix = ""): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(transactionId) || (suffix !== "" && (!/^[A-Za-z0-9._/-]{1,512}$/u.test(suffix) || suffix.split("/").some((segment) => !segment || segment === "." || segment === "..")))) {
    throw new StorageRuntimeError("storage_invalid_path", "Initialization staging path is invalid");
  }
  const result = `${REMOTE_STORAGE_STAGING_PREFIX}${transactionId}${suffix ? `/${suffix}` : ""}`;
  assertProviderPath(result);
  return result;
}

export const remoteInitializationTransactionPath = transactionPath;
export const remoteInitializationStagingPath = stagingPath;

function discoveryUnavailable(error: unknown): RemoteRootDiscoveryResult {
  const code = storageErrorCode(error);
  const diagnostic = error && typeof error === "object" ? (error as { diagnostic?: unknown }).diagnostic : undefined;
  if (code === "storage_forbidden") return { status: "forbidden", ...(diagnostic === "authentication" || diagnostic === "forbidden" ? { diagnostic } : {}) };
  if (code === "storage_unavailable") return { status: "unavailable", ...(diagnostic === "network" || diagnostic === "cors" ? { diagnostic } : {}) };
  if (code === "storage_not_found") return { status: "absent" };
  return { status: "unavailable", diagnostic: "unknown" };
}

/** 只读取固定 root manifest；绝不扫描候选对象或写入远端。 */
export async function discoverRemoteStorageRoot(
  provider: StorageBucketProvider,
  options: { authenticator?: RemoteRootAuthenticator; password?: string; expectedRemoteStorageId?: string; signal?: AbortSignal } = {},
): Promise<RemoteRootDiscoveryResult> {
  let object;
  try {
    object = await provider.get(REMOTE_STORAGE_ROOT_MANIFEST_PATH, { signal: options.signal });
  } catch (error) {
    return discoveryUnavailable(error);
  }
  if (!object) return { status: "absent" };
  if (object.bytes.byteLength > REMOTE_ROOT_MANIFEST_MAX_BYTES) return { status: "corrupt", diagnostic: "size" };
  let parsed: unknown;
  try { parsed = decodeRemoteRootManifest(object.bytes); } catch (error) {
    return { status: "corrupt", diagnostic: error instanceof Error ? error.message : "json" };
  }
  let manifest: RemoteStorageRootManifestV1;
  let derivedAuthenticator: RemoteRootAuthenticator | undefined;
  try {
    const parsedManifest = validateRemoteRootManifest(parsed);
    derivedAuthenticator = options.authenticator === undefined && options.password !== undefined
      ? await deriveRemoteRootAuthenticator(options.password, parsedManifest.keyDerivation)
      : undefined;
    const authenticator = options.authenticator ?? derivedAuthenticator;
    if (!authenticator) return { status: "incompatible", diagnostic: "root-authenticator-required" };
    manifest = await verifyRemoteRootManifest(parsedManifest, authenticator);
  } catch (error) {
    if (error instanceof StorageRuntimeError && error.code === "storage_remote_incompatible") return { status: "incompatible", diagnostic: error.message };
    if (error instanceof StorageRuntimeError && error.code === "storage_forbidden" && error.diagnostic === "authentication") return { status: "forbidden", diagnostic: "authentication" };
    return { status: "corrupt", diagnostic: "authentication" };
  } finally {
    derivedAuthenticator?.dispose?.();
  }
  if (options.expectedRemoteStorageId !== undefined && manifest.remoteStorageId !== options.expectedRemoteStorageId) {
    return { status: "incompatible", diagnostic: "remote-storage-id-mismatch" };
  }
  return { status: "present", object: { manifest, etag: object.etag, fingerprint: remoteRootManifestFingerprint(object.bytes) } };
}
