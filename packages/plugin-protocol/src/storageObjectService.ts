// packages/plugin-protocol/src/storageObjectService.ts
// storage.* 协议方法的物理对象层：虚拟桶 key 派生 + AES-GCM 透明加解密
// + 最小 S3-compatible 适配。
//
// 设计缘由（施工单 2026-06-29 001 硬切换）：
//   - 物理上只一份全局 S3 provider 配置；逻辑上按
//     `/{originEncoded}/{ownerPublicKeyHex}/{relativePath}` 划分虚拟桶。
//   - 透明加解密：每个对象独立随机 nonce（AES-GCM-256）；相同路径重复
//     写入密文**必**不同；domain separation = `"keymaster.storage.v1" || ownerPublicKeyHex`，
//     与 `cipher.*` 站点密钥同 PBKDF2 但 HKDF 隔域。
//   - 不做块级增量 / 不做去重 / 不做路径名加密。V1 明文路径名 S3 可见。
//   - 不引入 aws-sdk；最小 S3-compatible fetch 适配走 SigV4 path-style。
//   - storageObjectService 不依赖 React；单元测试可直接 import。
//   - 入口 `createStorageObjectService(deps)` 接收 S3 adapter 注入；
//     单元测试可传 fake adapter。

import type {
  BinaryField,
  StorageDeleteParams,
  StorageDeleteResult,
  StorageGetParams,
  StorageGetResult,
  StorageListAllParams,
  StorageListEntry,
  StorageListParams,
  StorageListResult,
  StorageProviderConfig,
  StoragePutParams,
  StoragePutResult
} from "@keymaster/contracts";
import { encodeOrigin, normalizeStoragePath } from "./sessionWindowBootstrap.js";

/** storage 内容加密 / 解密需要的服务：可访问 vault withPrivateKey。 */
export interface StorageCryptoBridge {
  /**
   * 派生 owner 绑定的 storage 内容加密 key。
   *
   * 设计缘由：与 cipher 站点密钥同源但隔域；domain separation =
   * `"keymaster.storage.v1" || ownerPublicKeyHex`。实现走 PBKDF2 →
   * HKDF（在 vault 闭包内 withPrivateKey 完成）。
   */
  deriveStorageContentKey(ownerPublicKeyHex: string): Promise<Uint8Array>;
}

/* ============== 物理对象 key 派生 ============== */

/**
 * 把 (origin, ownerPublicKeyHex, relativePath) 派生为物理对象 key。
 *
 * 物理 key 形状：`/{originEncoded}/{ownerPublicKeyHex}/{relativePath}`。
 *  - `originEncoded` = base64url(origin)（不含 padding）；
 *  - `relativePath` = 已经 normalize 过的相对路径（不含 `/` 开头）。
 *
 * 设计缘由：把 origin 与 owner 写入 key 是 V1 明确接受的取舍——
 * S3 侧能看到 origin（base64 形式）+ owner public key + 路径名。
 * 这是为了 `list/listAll` 不需要额外索引；路径加密 / 索引方案会拉爆
 * 系统复杂度，V1 不做。
 */
export function buildObjectKey(input: {
  origin: string;
  ownerPublicKeyHex: string;
  relativePath: string;
}): string {
  if (!input.origin) throw new Error("object key: origin required");
  if (!input.ownerPublicKeyHex) throw new Error("object key: owner required");
  const normalized = normalizeStoragePath(input.relativePath);
  return `/${encodeOrigin(input.origin)}/${input.ownerPublicKeyHex}/${normalized}`;
}

/* ============== 内容加密 / 解密 ============== */

const STORAGE_DOMAIN = new TextEncoder().encode("keymaster.storage.v1");
/** 加密时随机 12 字节 nonce。 */
const NONCE_BYTES = 12;
/** AES-GCM key 长度：256 bit。 */
const KEY_BYTES = 32;

async function importStorageKey(rawKey: Uint8Array): Promise<CryptoKey> {
  if (rawKey.byteLength !== KEY_BYTES) {
    throw new Error(`storage key must be ${KEY_BYTES} bytes`);
  }
  return crypto.subtle.importKey(
    "raw",
    rawKey as BufferSource,
    { name: "AES-GCM", length: KEY_BYTES * 8 },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * 加密明文：layout = `[version:1][nonce:12][ciphertext]`，version 固定 0x01。
 * 设计缘由：单字节 version 留扩展位；nonce 与 ciphertext 拼一起方便整段
 * 作为对象内容写入。
 */
async function encryptObjectContent(
  key: Uint8Array,
  contentType: string | undefined,
  plaintext: Uint8Array
): Promise<Uint8Array> {
  const ck = await importStorageKey(key);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const aad = new TextEncoder().encode(contentType ?? "");
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: nonce as BufferSource,
        additionalData: aad as BufferSource
      },
      ck,
      plaintext as BufferSource
    )
  );
  const out = new Uint8Array(1 + nonce.length + cipher.length);
  out[0] = 0x01;
  out.set(nonce, 1);
  out.set(cipher, 1 + nonce.length);
  return out;
}

async function decryptObjectContent(
  key: Uint8Array,
  contentType: string | undefined,
  blob: Uint8Array
): Promise<{ contentType?: string; content: Uint8Array }> {
  if (blob.byteLength < 1 + NONCE_BYTES) {
    throw new Error("storage object content too short");
  }
  const version = blob[0];
  if (version !== 0x01) {
    throw new Error(`storage object content unknown version ${version}`);
  }
  const nonce = blob.slice(1, 1 + NONCE_BYTES);
  const cipher = blob.slice(1 + NONCE_BYTES);
  const ck = await importStorageKey(key);
  const aad = new TextEncoder().encode(contentType ?? "");
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce as BufferSource, additionalData: aad as BufferSource },
      ck,
      cipher as BufferSource
    )
  );
  return { content: plain, contentType };
}

/* ============== S3 adapter interface ============== */

/**
 * S3-compatible 适配器接口。
 *
 * 设计缘由：V1 只暴露最小能力（PUT / GET / DELETE / LIST-v2-prefix）；
 * 不引入 multipart / presigned URL / SSE-KMS。**单元测试可传 fake**；
 * 生产环境注入 `createSigV4Adapter(config)`。
 */
export interface S3Adapter {
  putObject(input: {
    key: string;
    body: Uint8Array;
    contentType?: string;
  }): Promise<{ etag?: string; updatedAt: number }>;
  getObject(input: {
    key: string;
  }): Promise<{ body: Uint8Array; updatedAt?: number } | null>;
  deleteObject(input: { key: string }): Promise<void>;
  listObjects(input: {
    prefix: string;
  }): Promise<Array<{ key: string; updatedAt?: number }>>;
}

/* ============== StorageObjectService ============== */

export interface StorageObjectServiceDeps {
  /** 当前全局 storage provider 配置；不存在时 storage.* fail-closed。 */
  getProviderConfig(): Promise<StorageProviderConfig | null>;
  /** 提供 S3 适配器；测试可注入 fake。 */
  resolveAdapter(config: StorageProviderConfig): S3Adapter;
  /** 提供透明加解密需要的 owner-bound key；测试可注入 fake。 */
  cryptoBridge: StorageCryptoBridge;
}

export interface StorageObjectService {
  put(input: {
    origin: string;
    ownerPublicKeyHex: string;
    params: StoragePutParams;
  }): Promise<StoragePutResult>;
  get(input: {
    origin: string;
    ownerPublicKeyHex: string;
    params: StorageGetParams;
  }): Promise<StorageGetResult | null>;
  list(input: {
    origin: string;
    ownerPublicKeyHex: string;
    params: StorageListParams;
  }): Promise<StorageListResult>;
  listAll(input: {
    origin: string;
    ownerPublicKeyHex: string;
    params: StorageListAllParams;
  }): Promise<StorageListResult>;
  delete(input: {
    origin: string;
    ownerPublicKeyHex: string;
    params: StorageDeleteParams;
  }): Promise<StorageDeleteResult | null>;
}

/** 错误：`provider not configured`。 */
export class StorageProviderNotConfiguredError extends Error {
  constructor() {
    super("Storage provider not configured");
    this.name = "StorageProviderNotConfiguredError";
  }
}

/** 错误：对象不存在。 */
export class StorageObjectNotFoundError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`Storage object not found: ${key}`);
    this.name = "StorageObjectNotFoundError";
    this.key = key;
  }
}

export function createStorageObjectService(deps: StorageObjectServiceDeps): StorageObjectService {
  async function getAdapter(): Promise<S3Adapter> {
    const cfg = await deps.getProviderConfig();
    if (!cfg) {
      throw new StorageProviderNotConfiguredError();
    }
    if (cfg.provider !== "s3-compatible") {
      throw new StorageProviderNotConfiguredError();
    }
    if (!cfg.endpoint || !cfg.bucket || !cfg.accessKeyId || !cfg.secretAccessKey) {
      throw new StorageProviderNotConfiguredError();
    }
    return deps.resolveAdapter(cfg);
  }

  async function getOwnerKey(ownerPublicKeyHex: string): Promise<Uint8Array> {
    return deps.cryptoBridge.deriveStorageContentKey(ownerPublicKeyHex);
  }

  return {
    async put({ origin, ownerPublicKeyHex, params }) {
      const path = normalizeStoragePath(params.path);
      const key = buildObjectKey({ origin, ownerPublicKeyHex, relativePath: path });
      const adapter = await getAdapter();
      const ownerKey = await getOwnerKey(ownerPublicKeyHex);
      const cipher = await encryptObjectContent(
        ownerKey,
        params.contentType,
        new Uint8Array(params.content.bytes)
      );
      const out = await adapter.putObject({
        key,
        body: cipher,
        contentType: "application/octet-stream"
      });
      return { objectKey: key, updatedAt: out.updatedAt };
    },

    async get({ origin, ownerPublicKeyHex, params }) {
      const path = normalizeStoragePath(params.path);
      const key = buildObjectKey({ origin, ownerPublicKeyHex, relativePath: path });
      const adapter = await getAdapter();
      const ownerKey = await getOwnerKey(ownerPublicKeyHex);
      const obj = await adapter.getObject({ key });
      if (!obj) return null;
      const decoded = await decryptObjectContent(ownerKey, undefined, obj.body);
      const srcBuf = decoded.content.buffer;
      const sliced = srcBuf.slice(
        decoded.content.byteOffset,
        decoded.content.byteOffset + decoded.content.byteLength
      );
      const bytes: ArrayBuffer = (() => {
        if (sliced instanceof ArrayBuffer) return sliced;
        // SharedArrayBuffer 兜底：copy 到新 ArrayBuffer。
        const u8 = new Uint8Array(sliced as ArrayBufferLike);
        const out = new ArrayBuffer(u8.byteLength);
        new Uint8Array(out).set(u8);
        return out;
      })();
      const binary: BinaryField = {
        $type: "binary",
        bytes,
        mime: decoded.contentType
      };
      return {
        content: binary,
        contentType: decoded.contentType,
        updatedAt: obj.updatedAt
      };
    },

    async list({ origin, ownerPublicKeyHex, params }) {
      const prefixRaw = params.prefix ? normalizeStoragePath(params.prefix) : "";
      const prefix = `/${encodeOrigin(origin)}/${ownerPublicKeyHex}/${prefixRaw}`;
      const adapter = await getAdapter();
      const items = await adapter.listObjects({ prefix });
      const entries: StorageListEntry[] = [];
      const relPrefix = `${encodeOrigin(origin)}/${ownerPublicKeyHex}/`;
      for (const item of items) {
        const rel = relativePathFromKey(item.key, relPrefix);
        if (rel === null) continue;
        entries.push({ path: rel, updatedAt: item.updatedAt });
      }
      return { entries };
    },

    async listAll({ origin, ownerPublicKeyHex }) {
      const prefix = `/${encodeOrigin(origin)}/${ownerPublicKeyHex}/`;
      const adapter = await getAdapter();
      const items = await adapter.listObjects({ prefix });
      const entries: StorageListEntry[] = [];
      const relPrefix = `${encodeOrigin(origin)}/${ownerPublicKeyHex}/`;
      for (const item of items) {
        const rel = relativePathFromKey(item.key, relPrefix);
        if (rel === null) continue;
        entries.push({ path: rel, updatedAt: item.updatedAt });
      }
      return { entries };
    },

    async delete({ origin, ownerPublicKeyHex, params }) {
      const path = normalizeStoragePath(params.path);
      const key = buildObjectKey({ origin, ownerPublicKeyHex, relativePath: path });
      const adapter = await getAdapter();
      // 先 GET 探一次：S3 DELETE 是幂等成功（即使对象不存在也回 204），
      // 这里由 storageObjectService 显式区分"对象不存在"。
      const probe = await adapter.getObject({ key });
      if (!probe) {
        throw new StorageObjectNotFoundError(key);
      }
      await adapter.deleteObject({ key });
      return { deleted: true, updatedAt: Date.now() };
    }
  };
}

/** 把物理对象 key 拆回相对路径；无法拆（origin / owner 维度不匹配）返回 null。 */
function relativePathFromKey(key: string, ownerPrefix: string): string | null {
  if (!key.startsWith("/" + ownerPrefix)) return null;
  return key.slice(1 + ownerPrefix.length);
}

/* ============== 最小 SigV4 path-style S3 fetch adapter ============== */

/**
 * 构造一个最小 S3-compatible fetch adapter。
 *
 * 设计缘由：V1 不引入 aws-sdk；本 adapter 仅覆盖 PUT/GET/DELETE/LIST-v2
 * 四个最小操作；只走 SigV4 path-style，兼容 AWS S3 / minio / Cloudflare R2。
 *
 * 限制（明确接受）：
 *   - 不支持 SSE-KMS / SSE-S3 / multipart；
 *   - 不支持 presigned URL；
 *   - 不支持 accelerate / dualstack；
 *   - 只支持 path-style（virtual-hosted 风格在 TLS + 复杂 bucket naming
 *     下容易踩坑，V1 不引入）。
 */
export function createSigV4Adapter(config: StorageProviderConfig): S3Adapter {
  const endpoint = (config.endpoint || "").replace(/\/+$/, "");
  const region = config.region || "us-east-1";
  const bucket = config.bucket;
  const forcePathStyle = config.forcePathStyle ?? true;
  const accessKey = config.accessKeyId;
  const secretKey = config.secretAccessKey;

  return {
    async putObject({ key, body, contentType }) {
      const url = buildUrl(endpoint, forcePathStyle, bucket, key);
      const headers = await signRequest({
        method: "PUT",
        url,
        body,
        contentType,
        region,
        accessKey,
        secretKey
      });
      const res = await fetch(url, {
        method: "PUT",
        headers,
        body: body as unknown as BodyInit
      });
      if (!res.ok) {
        throw new Error(`S3 PUT failed: ${res.status} ${await res.text()}`);
      }
      return { updatedAt: Date.now() };
    },
    async getObject({ key }) {
      const url = buildUrl(endpoint, forcePathStyle, bucket, key);
      const headers = await signRequest({
        method: "GET",
        url,
        region,
        accessKey,
        secretKey
      });
      const res = await fetch(url, { method: "GET", headers });
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`S3 GET failed: ${res.status} ${await res.text()}`);
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      const lm = res.headers.get("last-modified");
      const updatedAt = lm ? Date.parse(lm) : undefined;
      return { body: buf, updatedAt: Number.isFinite(updatedAt) ? updatedAt : undefined };
    },
    async deleteObject({ key }) {
      const url = buildUrl(endpoint, forcePathStyle, bucket, key);
      const headers = await signRequest({
        method: "DELETE",
        url,
        region,
        accessKey,
        secretKey
      });
      const res = await fetch(url, { method: "DELETE", headers });
      if (!res.ok && res.status !== 404) {
        throw new Error(`S3 DELETE failed: ${res.status} ${await res.text()}`);
      }
    },
    async listObjects({ prefix }) {
      // 用 S3 ListObjectsV2（最广泛支持）。prefix 形如
      // "/{originEnc}/{ownerHex}/..."，需要去掉开头的 `/`（S3 key 不含
      // 前导 `/`）。
      const s3Prefix = prefix.startsWith("/") ? prefix.slice(1) : prefix;
      const baseUrl = buildUrl(endpoint, forcePathStyle, bucket, "");
      const url = `${baseUrl}?list-type=2&prefix=${encodeURIComponent(s3Prefix)}`;
      const headers = await signRequest({
        method: "GET",
        url,
        region,
        accessKey,
        secretKey
      });
      const res = await fetch(url, { method: "GET", headers });
      if (!res.ok) {
        throw new Error(`S3 LIST failed: ${res.status} ${await res.text()}`);
      }
      const text = await res.text();
      // 最小 XML 解析：只挑 <Contents><Key>...</Key><LastModified>...</LastModified></Contents>
      // 的成对标签。V1 不引入 XML 库；手写正则足够。
      const out: Array<{ key: string; updatedAt?: number }> = [];
      const re = /<Contents>([\s\S]*?)<\/Contents>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const block = m[1] ?? "";
        const keyMatch = /<Key>([^<]+)<\/Key>/.exec(block);
        const lmMatch = /<LastModified>([^<]+)<\/LastModified>/.exec(block);
        if (!keyMatch || !keyMatch[1]) continue;
        const k = keyMatch[1];
        const lm = lmMatch && lmMatch[1] ? Date.parse(lmMatch[1]) : undefined;
        out.push({ key: "/" + k, updatedAt: Number.isFinite(lm) ? lm : undefined });
      }
      return out;
    }
  };
}

function buildUrl(endpoint: string, forcePathStyle: boolean, bucket: string, key: string): string {
  const normalizedKey = key.startsWith("/") ? key.slice(1) : key;
  if (forcePathStyle) {
    return `${endpoint}/${bucket}/${normalizedKey}`;
  }
  // virtual-hosted；endpoint 形如 https://s3.amazonaws.com
  const host = endpoint.replace(/^https?:\/\//, "");
  return `https://${bucket}.${host}/${normalizedKey}`;
}

/* ============== AWS SigV4 签名最小实现 ============== */

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const ck = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return crypto.subtle.sign("HMAC", ck, new TextEncoder().encode(data));
}

async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const buf =
    typeof data === "string" ? new TextEncoder().encode(data) : (data as Uint8Array);
  const hash = await crypto.subtle.digest("SHA-256", buf as BufferSource);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function signRequest(input: {
  method: string;
  url: string;
  body?: Uint8Array;
  contentType?: string;
  region: string;
  accessKey: string;
  secretKey: string;
}): Promise<Record<string, string>> {
  const u = new URL(input.url);
  const host = u.host;
  const path = u.pathname || "/";
  const search = u.search.startsWith("?") ? u.search.slice(1) : u.search;
  // canonical query string：按字典序。
  const canonicalQuery = search
    .split("&")
    .filter(Boolean)
    .sort()
    .join("&");
  const bodyHash = input.body ? await sha256Hex(input.body) : await sha256Hex("");
  const amzDate = formatAmzDate(new Date());
  const dateStamp = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    host,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": bodyHash
  };
  if (input.contentType) headers["content-type"] = input.contentType;
  const sortedHeaderKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaderKeys
    .map((k) => `${k}:${headers[k]}\n`)
    .join("");
  const signedHeaders = sortedHeaderKeys.join(";");
  const canonicalRequest = [
    input.method,
    path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    bodyHash
  ].join("\n");
  const credentialScope = `${dateStamp}/${input.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest)
  ].join("\n");
  const kDate = await hmac(
    new TextEncoder().encode(`AWS4${input.secretKey}`),
    dateStamp
  );
  const kRegion = await hmac(kDate, input.region);
  const kService = await hmac(kRegion, "s3");
  const kSigning = await hmac(kService, "aws4_request");
  const sigBytes = await hmac(kSigning, stringToSign);
  const sig = Array.from(new Uint8Array(sigBytes), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${input.accessKey}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${sig}`;
  return {
    ...headers,
    authorization
  };
}

function formatAmzDate(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z"
  );
}