// K-V 值信封的纯编解码。
//
// 这里不含任何 I/O：head、value object 与游标的字节格式只有这一份实现，
// 写入引擎与存储浏览器共用它。浏览功能因此不会长出第二套 K-V 格式判断，
// 格式校验（键名校验、版本、载荷哈希）与写路径保持完全一致。

import type { KeyValueJson, KeyValueValue, StorageErrorCode } from "@keymaster/contracts";
import { sha256 } from "@noble/hashes/sha2.js";
import { StorageRuntimeError } from "../runtime/storageError.js";

export const KV_JSON_PREFIX = new TextEncoder().encode("keymaster-kv-v1:json\n");
export const KV_BINARY_PREFIX = new TextEncoder().encode("keymaster-kv-v1:binary\n");
export const KV_VALUE_OBJECT_HEADER_PREFIX = new TextEncoder().encode("keymaster-kv-value-v1:");
export const KV_VALUE_OBJECT_FORMAT = "keymaster.kv-value";
export const KV_VALUE_OBJECT_VERSION = 1;
export const KV_HEAD_FORMAT = "keymaster.kv-head";
export const KV_HEAD_VERSION = 2;
export const KV_VALUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
export const KV_DEFAULT_PARTITION = "default";
export const KV_MAX_KEY_LENGTH = 1024;
export const KV_MAX_PARTITION_LENGTH = 128;

export function kvFail(code: StorageErrorCode, message: string = code): StorageRuntimeError {
  return new StorageRuntimeError(code, message);
}

export function kvHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function kvConcatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.byteLength + b.byteLength);
  result.set(a, 0);
  result.set(b, a.byteLength);
  return result;
}

export function kvStartsWithBytes(value: Uint8Array, prefix: Uint8Array): boolean {
  return value.byteLength >= prefix.byteLength && prefix.every((byte, index) => value[index] === byte);
}

export function kvExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

export function kvJsonBytes(value: unknown): Uint8Array {
  try {
    return new TextEncoder().encode(JSON.stringify(value));
  } catch {
    throw kvFail("storage_provider_error", "K-V head is not serializable");
  }
}

export function kvParseJson<T>(bytes: Uint8Array, message: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw kvFail("storage_provider_error", message);
  }
}

export interface KvEncodedValue {
  bytes: Uint8Array;
  valueHash: string;
}

export function kvEncodeValue(value: unknown): KvEncodedValue {
  let bytes: Uint8Array;
  if (value instanceof Uint8Array) {
    bytes = kvConcatBytes(KV_BINARY_PREFIX, value);
  } else {
    try {
      bytes = kvConcatBytes(KV_JSON_PREFIX, new TextEncoder().encode(JSON.stringify(value)));
    } catch {
      throw kvFail("storage_provider_error", "K-V value is not serializable");
    }
  }
  return { bytes, valueHash: kvHex(sha256(bytes)) };
}

export function kvDecodeValue(bytes: Uint8Array): KeyValueValue {
  if (kvStartsWithBytes(bytes, KV_BINARY_PREFIX)) return new Uint8Array(bytes.slice(KV_BINARY_PREFIX.byteLength));
  if (!kvStartsWithBytes(bytes, KV_JSON_PREFIX)) throw kvFail("storage_provider_error", "K-V value envelope is invalid");
  try {
    return JSON.parse(new TextDecoder().decode(bytes.slice(KV_JSON_PREFIX.byteLength))) as KeyValueJson;
  } catch {
    throw kvFail("storage_provider_error", "K-V JSON value is invalid");
  }
}

/**
 * value 载荷的语义分类，供浏览器在不重建业务值的情况下决定呈现方式。
 *
 * 这不是新的格式：它只是把 `kvDecodeValue` 会走的两条分支提前暴露出来，
 * 因此浏览器与写引擎永远对同一份字节给出一致判断。
 */
export type KvPayloadShape =
  | { kind: "json"; value: KeyValueJson; text: string }
  | { kind: "binary"; bytes: Uint8Array };

/** 只解析载荷前缀，不重建完整 K-V 值。 */
export function kvDecodePayloadShape(payload: Uint8Array): KvPayloadShape {
  if (kvStartsWithBytes(payload, KV_BINARY_PREFIX)) {
    return { kind: "binary", bytes: payload.slice(KV_BINARY_PREFIX.byteLength) };
  }
  if (!kvStartsWithBytes(payload, KV_JSON_PREFIX)) throw kvFail("storage_provider_error", "K-V value envelope is invalid");
  const textBytes = payload.slice(KV_JSON_PREFIX.byteLength);
  try {
    return { kind: "json", value: JSON.parse(new TextDecoder().decode(textBytes)) as KeyValueJson, text: new TextDecoder().decode(textBytes) };
  } catch {
    throw kvFail("storage_provider_error", "K-V JSON value is invalid");
  }
}

export interface KvValueObjectRecord {
  format: typeof KV_VALUE_OBJECT_FORMAT;
  version: typeof KV_VALUE_OBJECT_VERSION;
  valueId: string;
  partition: string;
  valueHash: string;
  createdAt: number;
  payload: Uint8Array;
}

/** value object 信封被拒绝的原因；浏览器据此区分损坏、版本过新与哈希不符。 */
export type KvValueObjectError =
  | "envelope-invalid"
  | "version-unsupported"
  | "hash-mismatch"
  | "payload-unsupported";

export type KvValueObjectDecode =
  | { ok: true; record: KvValueObjectRecord }
  | { ok: false; error: KvValueObjectError };

export function kvValidateValueId(valueId: string): string {
  if (typeof valueId !== "string" || !KV_VALUE_ID_PATTERN.test(valueId)) throw kvFail("storage_provider_error", "K-V value object ID is invalid");
  return valueId;
}

export function kvValidatePartition(partition: string | undefined): string {
  const value = partition ?? KV_DEFAULT_PARTITION;
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > KV_MAX_PARTITION_LENGTH
    || value.startsWith(".")
    || value.includes("/")
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
  ) throw kvFail("storage_invalid_path", "K-V partition is invalid");
  return value;
}

export function kvValidateKey(key: string): string {
  if (
    typeof key !== "string"
    || key.length === 0
    || key.length > KV_MAX_KEY_LENGTH
    || key.startsWith("/")
    || key.includes("\\")
    || key.includes("\u0000")
    || key.split("/").some((segment) => !segment || segment === "." || segment === ".." || segment === ".keymaster")
  ) throw kvFail("storage_invalid_path", "K-V key is invalid");
  return key;
}

export function kvEncodeValueObject(valueId: string, partition: string, encoded: KvEncodedValue, createdAt: number): Uint8Array {
  kvValidateValueId(valueId);
  kvValidatePartition(partition);
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw kvFail("storage_provider_error", "K-V value object timestamp is invalid");
  const header = new TextEncoder().encode(
    new TextDecoder().decode(KV_VALUE_OBJECT_HEADER_PREFIX)
    + JSON.stringify({ format: KV_VALUE_OBJECT_FORMAT, version: KV_VALUE_OBJECT_VERSION, valueId, partition, valueHash: encoded.valueHash, createdAt })
    + "\n"
  );
  return kvConcatBytes(header, encoded.bytes);
}

/**
 * 解析 value object 信封；错误以值返回而不是抛出。
 *
 * 写路径需要「失败即抛错」，浏览器需要「说明为什么不支持」——两者共用同一份
 * 解析，但只有这个纯函数把结果分成两种形状。
 */
export function kvDecodeValueObject(bytes: Uint8Array): KvValueObjectDecode {
  if (!kvStartsWithBytes(bytes, KV_VALUE_OBJECT_HEADER_PREFIX)) return { ok: false, error: "envelope-invalid" };
  let separator = -1;
  for (let index = KV_VALUE_OBJECT_HEADER_PREFIX.byteLength; index < bytes.byteLength; index += 1) {
    if (bytes[index] === 0x0a) { separator = index; break; }
  }
  if (separator < 0) return { ok: false, error: "envelope-invalid" };
  let header: unknown;
  try {
    header = JSON.parse(new TextDecoder().decode(bytes.slice(KV_VALUE_OBJECT_HEADER_PREFIX.byteLength, separator)));
  } catch {
    return { ok: false, error: "envelope-invalid" };
  }
  if (!header || typeof header !== "object" || Array.isArray(header)
    || !kvExactKeys(header, ["format", "version", "valueId", "partition", "valueHash", "createdAt"])) {
    return { ok: false, error: "envelope-invalid" };
  }
  const candidate = header as Partial<KvValueObjectRecord>;
  if (candidate.format !== KV_VALUE_OBJECT_FORMAT) return { ok: false, error: "envelope-invalid" };
  if (candidate.version !== KV_VALUE_OBJECT_VERSION) return { ok: false, error: "version-unsupported" };
  if (typeof candidate.valueId !== "string" || typeof candidate.partition !== "string" || typeof candidate.valueHash !== "string"
    || !KV_VALUE_ID_PATTERN.test(candidate.valueId)
    || !/^[0-9a-f]{64}$/u.test(candidate.valueHash)
    || !Number.isSafeInteger(candidate.createdAt) || (candidate.createdAt as number) < 0) {
    return { ok: false, error: "envelope-invalid" };
  }
  try { kvValidatePartition(candidate.partition); } catch { return { ok: false, error: "envelope-invalid" }; }
  const payload = bytes.slice(separator + 1);
  if (kvHex(sha256(payload)) !== candidate.valueHash) return { ok: false, error: "hash-mismatch" };
  return {
    ok: true,
    record: {
      format: KV_VALUE_OBJECT_FORMAT,
      version: KV_VALUE_OBJECT_VERSION,
      valueId: candidate.valueId,
      partition: candidate.partition,
      valueHash: candidate.valueHash,
      createdAt: candidate.createdAt as number,
      payload,
    },
  };
}

export function kvParseValueObject(bytes: Uint8Array, expectedValueId: string, expectedPartition: string, expectedValueHash: string): KvValueObjectRecord {
  if (!KV_VALUE_ID_PATTERN.test(expectedValueId) || !/^[0-9a-f]{64}$/u.test(expectedValueHash)) {
    throw kvFail("storage_provider_error", "K-V value reference is invalid");
  }
  const decoded = kvDecodeValueObject(bytes);
  if (!decoded.ok) throw kvFail("storage_provider_error", "K-V value object envelope is invalid");
  const record = decoded.record;
  if (record.valueId !== expectedValueId || record.partition !== expectedPartition || record.valueHash !== expectedValueHash) {
    throw kvFail("storage_provider_error", "K-V value object reference mismatch");
  }
  return record;
}

export interface KvHeadRecord {
  format: typeof KV_HEAD_FORMAT;
  version: typeof KV_HEAD_VERSION;
  partition: string;
  revision: number;
  committedAt: number;
  entries: Array<{ key: string; valueId: string; valueHash: string; updatedAt: number }>;
}

export function kvParseHead(bytes: Uint8Array, partition: string): KvHeadRecord {
  const value = kvParseJson<unknown>(bytes, "K-V partition head is invalid");
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !kvExactKeys(value, ["format", "version", "partition", "revision", "committedAt", "entries"])) {
    throw kvFail("storage_provider_error", "K-V partition head is invalid");
  }
  const candidate = value as Partial<KvHeadRecord>;
  if (candidate.format !== KV_HEAD_FORMAT || candidate.version !== KV_HEAD_VERSION || candidate.partition !== partition
    || !Number.isSafeInteger(candidate.revision) || (candidate.revision as number) < 1
    || !Number.isSafeInteger(candidate.committedAt) || (candidate.committedAt as number) < 0
    || !Array.isArray(candidate.entries)) throw kvFail("storage_provider_error", "K-V partition head is invalid");
  const entries: KvHeadRecord["entries"] = [];
  const seen = new Set<string>();
  for (const item of candidate.entries) {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || !kvExactKeys(item, ["key", "valueId", "valueHash", "updatedAt"])) throw kvFail("storage_provider_error", "K-V partition head entry is invalid");
    const entry = item as { key?: unknown; valueId?: unknown; valueHash?: unknown; updatedAt?: unknown };
    if (typeof entry.key !== "string" || seen.has(entry.key)) throw kvFail("storage_provider_error", "K-V partition head entry is invalid");
    kvValidateKey(entry.key);
    if (typeof entry.valueId !== "string" || !KV_VALUE_ID_PATTERN.test(entry.valueId)) throw kvFail("storage_provider_error", "K-V value object ID is invalid");
    if (typeof entry.valueHash !== "string" || !/^[0-9a-f]{64}$/u.test(entry.valueHash)) throw kvFail("storage_provider_error", "K-V value reference is invalid");
    if (!Number.isSafeInteger(entry.updatedAt) || (entry.updatedAt as number) < 0) throw kvFail("storage_provider_error", "K-V partition head timestamp is invalid");
    seen.add(entry.key);
    entries.push({ key: entry.key, valueId: entry.valueId, valueHash: entry.valueHash, updatedAt: entry.updatedAt as number });
  }
  return { format: KV_HEAD_FORMAT, version: KV_HEAD_VERSION, partition, revision: candidate.revision as number, committedAt: candidate.committedAt as number, entries };
}
