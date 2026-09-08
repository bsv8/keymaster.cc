import type {
  NormalizedStorageProviderConfig,
  StorageBootstrapState,
  StorageProfileEnvelopeV1
} from "@keymaster/contracts";
import { configFromBytes, configToBytes, normalizeProviderConfig } from "../bucket-providers/s3/s3ClientFactory.js";
import { StorageRuntimeError } from "../runtime/storageRuntimeError.js";
import { STORAGE_CATALOG_KEY, validateStorageCatalog } from "./storageCatalogRepository.js";

export const STORAGE_PROFILE_KDF_ITERATIONS = 210_000;
export const STORAGE_BOOTSTRAP_KEY = "keymaster.storage.bootstrap.v1";
const PROFILE_AAD = new TextEncoder().encode("keymaster:storage-profile:v1");

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string, expectedBytes?: number): Uint8Array {
  if (!/^[0-9a-f]+$/u.test(value) || value.length % 2 !== 0 || (expectedBytes !== undefined && value.length !== expectedBytes * 2)) {
    throw new StorageRuntimeError("storage_provider_error", "Storage Profile envelope is invalid");
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function requireCrypto(): SubtleCrypto {
  if (!globalThis.crypto?.subtle) throw new StorageRuntimeError("storage_unavailable", "WebCrypto is unavailable");
  return globalThis.crypto.subtle;
}

function asBufferSource(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource;
}

async function deriveProfileKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  if (typeof password !== "string" || password.length === 0) throw new StorageRuntimeError("storage_provider_error", "Storage Profile password is required");
  const subtle = requireCrypto();
  const material = await subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: asBufferSource(salt), iterations }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

function assertEnvelope(value: unknown): asserts value is StorageProfileEnvelopeV1 {
  if (!value || typeof value !== "object") throw new StorageRuntimeError("storage_provider_error", "Storage Profile envelope is invalid");
  const envelope = value as Partial<StorageProfileEnvelopeV1>;
  const iterations = envelope.iterations;
  if (envelope.format !== "keymaster.storage-profile" || envelope.version !== 1 || envelope.kdf !== "pbkdf2-sha256" || typeof iterations !== "number" || !Number.isSafeInteger(iterations) || iterations < 100_000 || iterations > 1_000_000) {
    throw new StorageRuntimeError("storage_provider_error", "Storage Profile envelope is invalid");
  }
  hexToBytes(envelope.saltHex ?? "", 16);
  hexToBytes(envelope.nonceHex ?? "", 12);
  hexToBytes(envelope.ciphertextHex ?? "");
}

/** 用独立存储密码加密 Profile；不经过 Vault，也不依赖任何业务 Key。 */
export async function encryptStorageProfile(config: NormalizedStorageProviderConfig, password: string): Promise<StorageProfileEnvelopeV1> {
  const subtle = requireCrypto();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveProfileKey(password, salt, STORAGE_PROFILE_KDF_ITERATIONS);
  const plaintext = configToBytes(config);
  try {
    const ciphertext = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: asBufferSource(nonce), additionalData: asBufferSource(PROFILE_AAD) }, key, asBufferSource(plaintext)));
    return { format: "keymaster.storage-profile", version: 1, kdf: "pbkdf2-sha256", iterations: STORAGE_PROFILE_KDF_ITERATIONS, saltHex: bytesToHex(salt), nonceHex: bytesToHex(nonce), ciphertextHex: bytesToHex(ciphertext) };
  } finally {
    plaintext.fill(0);
  }
}

/** 解密并规范化 Profile；密码错误和格式错误都不会泄露凭据细节。 */
export async function decryptStorageProfile(envelope: StorageProfileEnvelopeV1, password: string): Promise<NormalizedStorageProviderConfig> {
  assertEnvelope(envelope);
  const salt = hexToBytes(envelope.saltHex, 16);
  const nonce = hexToBytes(envelope.nonceHex, 12);
  const ciphertext = hexToBytes(envelope.ciphertextHex);
  const iterations = envelope.iterations;
  try {
    const plaintext = new Uint8Array(await requireCrypto().decrypt({ name: "AES-GCM", iv: asBufferSource(nonce), additionalData: asBufferSource(PROFILE_AAD) }, await deriveProfileKey(password, salt, iterations), asBufferSource(ciphertext)));
    try {
      return configFromBytes(plaintext);
    } finally {
      plaintext.fill(0);
    }
  } catch (caught) {
    if (caught instanceof StorageRuntimeError) throw caught;
    throw new StorageRuntimeError("storage_forbidden", "Storage Profile password is invalid", "authentication");
  }
}

export function exportStorageProfileEnvelope(envelope: StorageProfileEnvelopeV1): Uint8Array {
  assertEnvelope(envelope);
  return new TextEncoder().encode(JSON.stringify(envelope));
}

export function importStorageProfileEnvelope(bytes: Uint8Array): StorageProfileEnvelopeV1 {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    assertEnvelope(parsed);
    return structuredClone(parsed);
  } catch (caught) {
    if (caught instanceof StorageRuntimeError) throw caught;
    throw new StorageRuntimeError("storage_provider_error", "Storage Profile file is invalid");
  }
}

function validateBootstrapState(state: StorageBootstrapState): StorageBootstrapState {
  if (!state || typeof state !== "object") throw new StorageRuntimeError("storage_provider_error", "Storage bootstrap state is invalid");
  const allowed = new Set(["selectedBackend", "selectedProfileId", "selectedBucket", "encryptedStorageProfileEnvelope", "language", "theme"]);
  for (const key of Object.keys(state)) if (!allowed.has(key)) throw new StorageRuntimeError("storage_forbidden", "Storage bootstrap state contains a forbidden field");
  if (state.selectedBackend !== "local" && state.selectedBackend !== "opfs" && state.selectedBackend !== "s3") throw new StorageRuntimeError("storage_provider_error", "Storage backend must be selected");
  if (state.selectedProfileId !== undefined && (typeof state.selectedProfileId !== "string" || state.selectedProfileId.length > 128)) throw new StorageRuntimeError("storage_provider_error", "Storage bootstrap profile ID is invalid");
  if (state.language !== undefined && (typeof state.language !== "string" || state.language.length > 32)) throw new StorageRuntimeError("storage_provider_error", "Storage bootstrap language is invalid");
  if (state.theme !== undefined && (typeof state.theme !== "string" || state.theme.length > 32)) throw new StorageRuntimeError("storage_provider_error", "Storage bootstrap theme is invalid");
  if (state.encryptedStorageProfileEnvelope) assertEnvelope(state.encryptedStorageProfileEnvelope);
  if (state.selectedBucket) {
    if (!state.selectedBucket || typeof state.selectedBucket !== "object" || state.selectedBucket.bucketId !== state.selectedProfileId || state.selectedBucket.backend !== state.selectedBackend) {
      throw new StorageRuntimeError("storage_provider_error", "Selected storage bucket is invalid");
    }
    // 复用配置目录的严格校验，避免 Worker 收到未经验证的密文形状。
    validateStorageCatalog({ format: "keymaster.storage.catalog", version: 2, buckets: [state.selectedBucket] });
  }
  return {
    selectedBackend: state.selectedBackend,
    ...(state.selectedProfileId === undefined ? {} : { selectedProfileId: state.selectedProfileId }),
    ...(state.selectedBucket === undefined ? {} : { selectedBucket: structuredClone(state.selectedBucket) }),
    ...(state.encryptedStorageProfileEnvelope === undefined ? {} : { encryptedStorageProfileEnvelope: structuredClone(state.encryptedStorageProfileEnvelope) }),
    ...(state.language === undefined ? {} : { language: state.language }),
    ...(state.theme === undefined ? {} : { theme: state.theme })
  };
}

/** 本机 bootstrap 仅保存连接器 envelope 与首帧偏好，不保存业务真值。 */
export function readStorageBootstrap(storage: Storage = localStorage): StorageBootstrapState | null {
  // 新版多桶目录是首选真值；只把当前桶的最小密文快照交给 Worker，
  // 不把本机其它桶或任何 Keys 列表复制进启动消息。
  const catalogRaw = storage.getItem(STORAGE_CATALOG_KEY);
  if (catalogRaw !== null) {
    let catalog;
    try {
      catalog = validateStorageCatalog(JSON.parse(catalogRaw) as unknown);
    } catch (caught) {
      // 新目录一旦存在就是真值边界；损坏时必须停在明确错误，不能
      // 回退到旧 OPFS/Profile bootstrap，避免把旧业务数据误当成新桶。
      if (caught instanceof StorageRuntimeError) throw caught;
      throw new StorageRuntimeError("storage_provider_error", "Storage catalog JSON is invalid");
    }
    const selected = catalog.selectedBucketId ? catalog.buckets.find((bucket) => bucket.bucketId === catalog.selectedBucketId) : undefined;
    if (selected) {
      return validateBootstrapState({
        selectedBackend: selected.backend,
        selectedProfileId: selected.bucketId,
        selectedBucket: selected
      });
    }
    // 有效的新目录即使当前没有选中桶，也会遮蔽旧 bootstrap。旧格式
    // 不应在用户明确使用新桶目录后重新成为启动真值。
    return null;
  }
  const raw = storage.getItem(STORAGE_BOOTSTRAP_KEY);
  if (!raw) return null;
  try {
    return validateBootstrapState(JSON.parse(raw) as StorageBootstrapState);
  } catch {
    // 损坏的本机连接器按未选择处理；绝不尝试从旧业务 K-V 恢复。
    return null;
  }
}

/**
 * 读取旧版单桶启动记录，专供迁移/导出提示使用。
 *
 * 新版多桶目录存在时，`readStorageBootstrap` 会有意隐藏旧记录，避免
 * Worker 把旧 OPFS/Profile 当成新桶启动。迁移页仍需要知道旧记录是否
 * 留在浏览器中，因此这里绕过目录优先级，只识别旧 OPFS 或旧独立
 * Storage Profile；绝不修改、删除或自动映射它们。
 */
export function readLegacyStorageBootstrap(storage: Storage = localStorage): StorageBootstrapState | null {
  const raw = storage.getItem(STORAGE_BOOTSTRAP_KEY);
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; }
  catch { throw new StorageRuntimeError("storage_provider_error", "Legacy storage bootstrap JSON is invalid"); }
  const state = validateBootstrapState(parsed as StorageBootstrapState);
  if (state.selectedBucket) return null;
  if (state.selectedBackend === "opfs" || state.encryptedStorageProfileEnvelope !== undefined) return state;
  return null;
}

export function writeStorageBootstrap(state: StorageBootstrapState, storage: Storage = localStorage): void {
  const validated = validateBootstrapState(state);
  storage.setItem(STORAGE_BOOTSTRAP_KEY, JSON.stringify(validated));
}

export function clearStorageBootstrap(storage: Storage = localStorage): void {
  storage.removeItem(STORAGE_BOOTSTRAP_KEY);
}
