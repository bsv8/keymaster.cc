// packages/plugin-vault/src/crypto.ts
// WebCrypto 封装：PBKDF2 派生 key + AES-GCM 加解密。
//
// Chromium 在任意主机的 HTTP 页面上仍提供 getRandomValues，但会隐藏
// crypto.subtle。密码加密因此可以使用经过审计的 noble 实现降级，不能因为
// 这个 fallback 而被误认为不可用。

import { gcm } from "@noble/ciphers/aes.js";
import { hmac } from "@noble/hashes/hmac.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { pbkdf2Async } from "@noble/hashes/pbkdf2.js";
import { sha256 } from "@noble/hashes/sha2.js";

export type EffectiveCryptoMode = "native" | "insecure-context-fallback" | "unavailable";

export interface EffectiveCryptoCapability {
  mode: EffectiveCryptoMode;
  /** true 表示密码/本地加密链可用。 */
  subtle: boolean;
  /** fallback 模式明确是单独的本地实现，不是浏览器 secure-context API。 */
  secureContext: boolean;
}

const FALLBACK_KEY = Symbol("keymaster.fallback-crypto-key");
const fallbackSubtles = new WeakSet<object>();

interface FallbackCryptoKey {
  readonly [FALLBACK_KEY]: true;
  readonly algorithm: { name: string; length?: number; hash?: { name: string } };
  readonly extractable: boolean;
  readonly type: "secret";
  readonly usages: readonly KeyUsage[];
}

const fallbackKeyMaterials = new WeakMap<object, Uint8Array>();

type CryptoLike = Crypto & { subtle?: SubtleCrypto; randomUUID?: () => string };

function isFallbackKey(value: CryptoKey): value is CryptoKey & FallbackCryptoKey {
  return (value as unknown as Partial<FallbackCryptoKey>)[FALLBACK_KEY] === true;
}

function fallbackKeyMaterial(value: CryptoKey): Uint8Array {
  if (!isFallbackKey(value)) throw new Error("Invalid fallback CryptoKey");
  const material = fallbackKeyMaterials.get(value);
  if (!material) throw new Error("Fallback CryptoKey material is unavailable");
  return material;
}

function bytes(value: BufferSource): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  throw new TypeError("Unsupported BufferSource");
}

function algorithmName(algorithm: AlgorithmIdentifier | KeyAlgorithm): string {
  return typeof algorithm === "string" ? algorithm.toUpperCase() : algorithm.name.toUpperCase();
}

function algorithmLength(algorithm: Algorithm): number | undefined {
  const length = (algorithm as Algorithm & { length?: unknown }).length;
  return typeof length === "number" ? length : undefined;
}

function cryptoOperationError(): Error {
  // Keep the failure generic just like native AES-GCM authentication failures.
  return new Error("OperationError");
}

function asArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

function createFallbackSubtle(): SubtleCrypto {
  const importKey = async (
    format: KeyFormat,
    keyData: BufferSource,
    algorithm: AlgorithmIdentifier | RsaHashedImportParams | EcKeyImportParams | HmacImportParams | AesKeyAlgorithm,
    extractable: boolean,
    keyUsages: KeyUsage[]
  ): Promise<CryptoKey> => {
    if (format !== "raw") throw new Error(`Unsupported fallback key format: ${format}`);
    const name = algorithmName(algorithm);
    if (name !== "PBKDF2" && name !== "HKDF" && name !== "AES-GCM" && name !== "HMAC") {
      throw new Error(`Unsupported fallback key algorithm: ${name}`);
    }
    const hash = name === "HMAC" ? (algorithm as HmacImportParams).hash : undefined;
    if (name === "HMAC" && (!hash || algorithmName(hash) !== "SHA-256")) {
      throw new Error("Unsupported fallback HMAC hash");
    }
    const material = bytes(keyData);
    if (name === "AES-GCM" && material.byteLength !== 16 && material.byteLength !== 24 && material.byteLength !== 32) {
      throw new Error("AES-GCM key material must be 128, 192, or 256 bits");
    }
    const key: FallbackCryptoKey = {
      [FALLBACK_KEY]: true,
      algorithm: {
        name,
        ...(algorithmLength(algorithm as Algorithm) ? { length: algorithmLength(algorithm as Algorithm) } : {}),
        ...(hash ? { hash: { name: algorithmName(hash) } } : {})
      },
      extractable,
      type: "secret",
      usages: [...keyUsages]
    };
    fallbackKeyMaterials.set(key, material);
    return key as unknown as CryptoKey;
  };

  const deriveBits = async (
    algorithm: AlgorithmIdentifier | Pbkdf2Params | HkdfParams,
    baseKey: CryptoKey,
    length: number
  ): Promise<ArrayBuffer> => {
    if (!isFallbackKey(baseKey)) throw new Error("Fallback subtle cannot consume a native CryptoKey");
    if (!Number.isSafeInteger(length) || length < 0 || length % 8 !== 0) throw new Error("Invalid deriveBits length");
    const name = algorithmName(algorithm);
    const params = algorithm as Pbkdf2Params | HkdfParams;
    let output: Uint8Array;
    if (name === "PBKDF2") {
      const hash = algorithmName(params.hash);
      if (hash !== "SHA-256") throw new Error(`Unsupported fallback PBKDF2 hash: ${hash}`);
      const pbkdf2Params = params as Pbkdf2Params;
      output = await pbkdf2Async(sha256, fallbackKeyMaterial(baseKey), bytes(pbkdf2Params.salt), {
        c: pbkdf2Params.iterations,
        dkLen: length / 8
      });
    } else if (name === "HKDF") {
      const hash = algorithmName(params.hash);
      if (hash !== "SHA-256") throw new Error(`Unsupported fallback HKDF hash: ${hash}`);
      const hkdfParams = params as HkdfParams;
      output = hkdf(sha256, fallbackKeyMaterial(baseKey), bytes(hkdfParams.salt), bytes(hkdfParams.info), length / 8);
    } else {
      throw new Error(`Unsupported fallback deriveBits algorithm: ${name}`);
    }
    return asArrayBuffer(output);
  };

  const encrypt = async (
    algorithm: AlgorithmIdentifier | AesGcmParams,
    key: CryptoKey,
    data: BufferSource
  ): Promise<ArrayBuffer> => {
    if (!isFallbackKey(key) || key.algorithm.name !== "AES-GCM") throw new Error("Invalid fallback AES-GCM key");
    const params = algorithm as AesGcmParams;
    if (algorithmName(params) !== "AES-GCM") throw new Error("Unsupported fallback encryption algorithm");
    const tagLength = params.tagLength ?? 128;
    if (tagLength !== 128) throw new Error("Fallback AES-GCM supports only a 128-bit tag");
    const iv = bytes(params.iv);
    if (iv.byteLength === 0) throw new Error("AES-GCM IV must not be empty");
    const aad = params.additionalData === undefined ? undefined : bytes(params.additionalData);
    return asArrayBuffer(gcm(fallbackKeyMaterial(key), iv, aad).encrypt(bytes(data)));
  };

  const decrypt = async (
    algorithm: AlgorithmIdentifier | AesGcmParams,
    key: CryptoKey,
    data: BufferSource
  ): Promise<ArrayBuffer> => {
    if (!isFallbackKey(key) || key.algorithm.name !== "AES-GCM") throw new Error("Invalid fallback AES-GCM key");
    const params = algorithm as AesGcmParams;
    if (algorithmName(params) !== "AES-GCM") throw new Error("Unsupported fallback decryption algorithm");
    const tagLength = params.tagLength ?? 128;
    if (tagLength !== 128) throw new Error("Fallback AES-GCM supports only a 128-bit tag");
    try {
      return asArrayBuffer(gcm(fallbackKeyMaterial(key), bytes(params.iv), params.additionalData === undefined ? undefined : bytes(params.additionalData)).decrypt(bytes(data)));
    } catch {
      throw cryptoOperationError();
    }
  };

  const sign = async (
    algorithm: AlgorithmIdentifier | HmacImportParams,
    key: CryptoKey,
    data: BufferSource
  ): Promise<ArrayBuffer> => {
    if (!isFallbackKey(key) || key.algorithm.name !== "HMAC" || key.algorithm.hash?.name !== "SHA-256") {
      throw new Error("Invalid fallback HMAC key");
    }
    if (algorithmName(algorithm) !== "HMAC") throw new Error("Unsupported fallback signing algorithm");
    return asArrayBuffer(hmac(sha256, fallbackKeyMaterial(key), bytes(data)));
  };

  const subtle = {
    digest: async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
      if (algorithmName(algorithm) !== "SHA-256") throw new Error("Fallback subtle supports only SHA-256");
      return asArrayBuffer(sha256(bytes(data)));
    },
    importKey,
    deriveBits,
    deriveKey: async (
      algorithm: AlgorithmIdentifier | Pbkdf2Params | HkdfParams,
      baseKey: CryptoKey,
      derivedKeyAlgorithm: AlgorithmIdentifier | AesKeyAlgorithm,
      extractable: boolean,
      keyUsages: KeyUsage[]
    ) => {
      const length = algorithmName(derivedKeyAlgorithm) === "AES-GCM"
        ? (algorithmLength(derivedKeyAlgorithm as Algorithm) ?? 256)
        : undefined;
      if (length === undefined) throw new Error("Fallback deriveKey supports AES-GCM only");
      const bits = new Uint8Array(await deriveBits(algorithm, baseKey, length));
      return importKey("raw", bits, derivedKeyAlgorithm, extractable, keyUsages);
    },
    generateKey: async (
      algorithm: AlgorithmIdentifier | AesKeyGenParams,
      extractable: boolean,
      keyUsages: KeyUsage[]
    ) => {
      if (algorithmName(algorithm) !== "AES-GCM") throw new Error("Fallback generateKey supports AES-GCM only");
      const length = algorithmLength(algorithm as Algorithm) ?? 256;
      if (length !== 128 && length !== 192 && length !== 256) throw new Error("Invalid AES-GCM key length");
      const material = new Uint8Array(length / 8);
      const native = (globalThis as typeof globalThis & { crypto?: CryptoLike }).crypto;
      if (!native?.getRandomValues) throw new Error("Secure random source is unavailable");
      native.getRandomValues(material);
      return importKey("raw", material, algorithm, extractable, keyUsages);
    },
    encrypt,
    decrypt,
    sign
  } as unknown as SubtleCrypto;
  fallbackSubtles.add(subtle as object);
  return subtle;
}

function fallbackRandomUUID(getRandomValues: Crypto["getRandomValues"]): string {
  const value = new Uint8Array(16);
  getRandomValues(value);
  value[6] = ((value[6] ?? 0) & 0x0f) | 0x40;
  value[8] = ((value[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Installs the narrow insecure-HTTP crypto compatibility layer.
 *
 * The native Crypto object is preserved on HTTPS/localhost. This function is
 * intentionally opt-in to `isSecureContext === false`; a missing native
 * implementation in a secure context remains a hard failure.
 */
export function installInsecureContextCryptoFallback(): EffectiveCryptoCapability {
  const current = (globalThis as typeof globalThis & { crypto?: CryptoLike }).crypto;
  if (current?.subtle) {
    return {
      mode: fallbackSubtles.has(current.subtle as object) ? "insecure-context-fallback" : "native",
      subtle: true,
      secureContext: globalThis.isSecureContext === true
    };
  }
  if (globalThis.isSecureContext !== false || !current?.getRandomValues) {
    return { mode: "unavailable", subtle: false, secureContext: globalThis.isSecureContext === true };
  }

  const subtle = createFallbackSubtle();
  const facade = new Proxy(current, {
    get(target, property, receiver) {
      if (property === "subtle") return subtle;
      if (property === "randomUUID") return () => fallbackRandomUUID(target.getRandomValues.bind(target));
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  try {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: facade });
  } catch {
    return { mode: "unavailable", subtle: false, secureContext: false };
  }
  return globalThis.crypto?.subtle === subtle
    ? { mode: "insecure-context-fallback", subtle: true, secureContext: false }
    : { mode: "unavailable", subtle: false, secureContext: false };
}

export function getEffectiveCryptoCapability(): EffectiveCryptoCapability {
  const current = (globalThis as typeof globalThis & { crypto?: CryptoLike }).crypto;
  if (current?.subtle) {
    return {
      mode: fallbackSubtles.has(current.subtle as object) ? "insecure-context-fallback" : "native",
      subtle: true,
      secureContext: globalThis.isSecureContext === true
    };
  }
  return { mode: "unavailable", subtle: false, secureContext: globalThis.isSecureContext === true };
}

/** 启动期守卫：先安装 HTTP fallback，再在没有有效后端时明确失败。 */
export function assertWebCryptoAvailable(): void {
  installInsecureContextCryptoFallback();
  if (!globalThis.crypto?.subtle) {
    throw new Error(
      "An effective WebCrypto backend is unavailable. Serve the app over HTTPS, localhost, or an HTTP host with the local compatibility backend enabled."
    );
  }
}

/**
 * PBKDF2 派生参数（200k 迭代 + SHA-256）。
 *
 * 设计缘由（施工单 2026-06-29 001）：派生参数必须在 launcher 与
 * Session Window 之间完全一致；统一收敛在一处常量。
 */
export const PBKDF2_PARAMS = {
  iterations: 200_000,
  hash: "SHA-256"
} as const;

/** PBKDF2 派生 raw 256-bit key material。 */
export async function deriveKeyRawBits(password: string, salt: Uint8Array): Promise<Uint8Array> {
  assertWebCryptoAvailable();
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(password) as BufferSource,
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: PBKDF2_PARAMS.iterations,
      hash: PBKDF2_PARAMS.hash
    },
    baseKey,
    256
  );
  return new Uint8Array(bits);
}

/** 从 raw 256-bit key material 导入 AES-GCM CryptoKey。 */
export async function aesGcmKeyFromRawBits(rawBits: Uint8Array): Promise<CryptoKey> {
  assertWebCryptoAvailable();
  if (rawBits.byteLength !== 32) {
    throw new Error("AES-GCM key material must be exactly 32 bytes");
  }
  return crypto.subtle.importKey(
    "raw",
    rawBits as BufferSource,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/** 派生 AES-GCM key（用于私钥加密）。 */
export async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const rawBits = await deriveKeyRawBits(password, salt);
  return aesGcmKeyFromRawBits(rawBits);
}

export interface EncryptedBlob {
  /** 16 字节随机 salt。 */
  salt: Uint8Array;
  /** 12 字节随机 IV。 */
  iv: Uint8Array;
  /** AES-GCM 密文（包含 tag）。 */
  ciphertext: Uint8Array;
  /** 当前加密协议版本。 */
  version?: "v2";
}

/** Vault v2 固定 verifier AAD。 */
export const VAULT_VERIFIER_AAD = "keymaster:v2|vault-verifier";

/** Vault v2 固定 key AAD 前缀。 */

/** 加密任意 bytes。 */
export async function encryptBytes(key: CryptoKey, plaintext: Uint8Array): Promise<EncryptedBlob> {
  return encryptBytesWithAad(key, plaintext, undefined);
}

/** 加密任意 bytes，并显式指定 AAD。 */
export async function encryptBytesWithAad(
  key: CryptoKey,
  plaintext: Uint8Array,
  aad: string | undefined
): Promise<EncryptedBlob> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const additionalData = aad ? new TextEncoder().encode(aad) : undefined;
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: iv as BufferSource,
        additionalData: additionalData as BufferSource | undefined
      },
      key,
      plaintext as BufferSource
    )
  );
  return { salt, iv, ciphertext, version: "v2" };
}

/** 解密。失败抛错（密码错误、篡改都会触发）。 */
export async function decryptBytesWithAad(
  key: CryptoKey,
  blob: EncryptedBlob,
  aad: string | undefined
): Promise<Uint8Array> {
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: blob.iv as BufferSource,
      additionalData: aad ? new TextEncoder().encode(aad) as BufferSource : undefined
    },
    key,
    blob.ciphertext as BufferSource
  );
  return new Uint8Array(plain);
}

/**
 * Local-secret envelope variant whose random salt is authenticated as part of
 * the encryption input. It uses an explicit entry point so plugin-owned
 * secrets can opt into the versioned local-secret AAD contract.
 */
function saltBoundAdditionalData(aad: string | undefined, salt: Uint8Array): Uint8Array {
  const prefix = aad ? new TextEncoder().encode(aad) : new Uint8Array(0);
  const output = new Uint8Array(prefix.length + 1 + salt.length);
  output.set(prefix);
  output[prefix.length] = 0;
  output.set(salt, prefix.length + 1);
  return output;
}

export async function encryptBytesWithSaltBoundAad(
  key: CryptoKey,
  plaintext: Uint8Array,
  aad: string | undefined
): Promise<EncryptedBlob> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource, additionalData: saltBoundAdditionalData(aad, salt) as BufferSource },
    key,
    plaintext as BufferSource
  ));
  return { salt, iv, ciphertext, version: "v2" };
}

export async function decryptBytesWithSaltBoundAad(
  key: CryptoKey,
  blob: EncryptedBlob,
  aad: string | undefined
): Promise<Uint8Array> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: blob.iv as BufferSource, additionalData: saltBoundAdditionalData(aad, blob.salt) as BufferSource },
    key,
    blob.ciphertext as BufferSource
  );
  return new Uint8Array(plaintext);
}

/** 便捷：hex 字符串 <-> bytes。 */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "").trim();
  if (clean.length % 2 !== 0) throw new Error("Invalid hex length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 验证密码：保存一份 verifier，密码错误时 verifier 也对不上。 */
export async function encryptVerifier(key: CryptoKey): Promise<EncryptedBlob> {
  const marker = new TextEncoder().encode(VAULT_VERIFIER_AAD);
  return encryptBytesWithAad(key, marker, VAULT_VERIFIER_AAD);
}

export async function verifyVerifier(key: CryptoKey, blob: EncryptedBlob): Promise<boolean> {
  try {
    const plain = await decryptBytesWithAad(key, blob, VAULT_VERIFIER_AAD);
    return new TextDecoder().decode(plain) === VAULT_VERIFIER_AAD;
  } catch {
    return false;
  }
}
