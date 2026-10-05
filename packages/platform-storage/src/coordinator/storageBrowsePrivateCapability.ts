import { defineCapability } from "webloom-framework";
import { COORDINATOR_RPC_CAPABILITY, type CoordinatorRpcResponse, type SessionEpoch } from "@keymaster/contracts";
import { type StorageBrowseEntry, type StorageBrowseKvPayload, type StorageBrowsePage, type StorageBrowsePreview, type StorageBrowseSession, type StoragePreviewFormat, STORAGE_BROWSE_PREVIEW_MAX_BYTES } from "../runtime/storageBrowseTypes.js";

/** Storage 包内协议，不属于公共 Coordinator 命令。 */
export type StorageBrowsePrivateData =
 | { type: "browse.list"; browseSessionId: string; prefix: string; cursor?: string; limit?: number }
 | { type: "browse.preview"; browseSessionId: string; path: string; ifRevision?: string };
export type StorageBrowsePrivateRequest =
 | { kind: "storage.browse.open"; expectedSessionEpoch: SessionEpoch }
 | { kind: "storage.browse.data"; data: StorageBrowsePrivateData; expectedSessionEpoch: SessionEpoch }
 | { kind: "storage.browse.close"; browseSessionId: string };
export type StorageBrowsePrivateCommand = StorageBrowsePrivateRequest & { clientId: string; requestId: string };
type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  return Object.getOwnPropertyNames(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return Boolean(descriptor && descriptor.enumerable && "value" in descriptor);
  });
}

function text(value: unknown, field: string, maximum = 4_096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new TypeError(`Coordinator ${field} is invalid`);
  }
  return value;
}

function integer(value: unknown, field: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new TypeError(`Coordinator ${field} is invalid`);
  }
  return value as number;
}

const STORAGE_BROWSE_DATA_TYPES = [
  "browse.list", "browse.preview",
] as const satisfies readonly StorageBrowsePrivateData["type"][];

const STORAGE_PREVIEW_FORMATS = [
  "json", "json-broken", "markdown", "text", "empty", "kv-value", "kv-invalid", "binary", "truncated",
] as const satisfies readonly StoragePreviewFormat[];

const STORAGE_BROWSE_KV_ERRORS = [
  "envelope-invalid", "version-unsupported", "hash-mismatch", "payload-unsupported",
] as const satisfies readonly NonNullable<StorageBrowsePreview["kvError"]>[];

function expectRecord(value: unknown, field: string): RecordValue {
  if (!record(value)) throw new TypeError(`Coordinator ${field} must be an object`);
  return value;
}

function optionalText(value: unknown, field: string, maximum = 4_096): string | undefined {
  if (value === undefined) return undefined;
  return text(value, field, maximum);
}

function optionalFilePathPrefix(value: unknown, field: string, maximum = 4_096): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maximum) throw new TypeError(`Coordinator ${field} is invalid`);
  return value;
}

function boundedNumber(value: unknown, field: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`Coordinator ${field} is invalid`);
  }
  return value as number;
}

function optionalBoundedNumber(value: unknown, field: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  if (value === undefined) return undefined;
  return boundedNumber(value, field, minimum, maximum);
}

function uint8ArrayValue(value: unknown, field: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new TypeError(`Coordinator ${field} must be a Uint8Array`);
  return value.slice();
}

function parseStorageBrowseData(value: unknown): StorageBrowsePrivateData {
  const data = expectRecord(value, "storage browse data");
  const type = enumValue(data.type, STORAGE_BROWSE_DATA_TYPES, "storage browse data.type");
  const browseSessionId = text(data.browseSessionId, "storage browse data.browseSessionId", 256);
  if (type === "browse.list") {
    // 空串是逻辑根，必须原样放行：optionalText 会经 text() 拒绝空串，那样
    // 浏览根目录这一唯一一次必然请求就会在客户端校验阶段失败，用户看到的
    // 只会是「加载中」和一个不指向根因的 storage_unavailable。
    const prefix = optionalFilePathPrefix(data.prefix, "storage browse data.browse.list.prefix", 4_096) ?? "";
    const cursor = optionalText(data.cursor, "storage browse data.browse.list.cursor", 8_192);
    const limit = optionalBoundedNumber(data.limit, "storage browse data.browse.list.limit", 1, 1_000);
    return { type, browseSessionId, prefix, ...(cursor === undefined ? {} : { cursor }), ...(limit === undefined ? {} : { limit }) };
  }
  const path = text(data.path, "storage browse data.browse.preview.path", 4_096);
  const ifRevision = optionalText(data.ifRevision, "storage browse data.browse.preview.ifRevision", 512);
  return { type, browseSessionId, path, ...(ifRevision === undefined ? {} : { ifRevision }) };
}

function parseStorageBrowseEntry(value: unknown, field: string): StorageBrowseEntry {
  const entry = expectRecord(value, field);
  const contentType = optionalText(entry.contentType, field + ".contentType", 256);
  return {
    path: text(entry.path, field + ".path", 4_096),
    size: integer(entry.size, field + ".size"),
    lastModified: text(entry.lastModified, field + ".lastModified", 128),
    revision: text(entry.revision, field + ".revision", 512),
    ...(contentType === undefined ? {} : { contentType }),
  };
}

function parseStorageBrowsePage(value: unknown, field: string): StorageBrowsePage {
  const page = expectRecord(value, field);
  if (!Array.isArray(page.entries) || page.entries.length > 1_000) {
    throw new TypeError(`Coordinator ${field}.entries is invalid`);
  }
  const nextCursor = optionalText(page.nextCursor, field + ".nextCursor", 8_192);
  return {
    entries: page.entries.map((entry, index) => parseStorageBrowseEntry(entry, `${field}.entries[${index}]`)),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

function parseStorageBrowseKvPayload(value: unknown, field: string): StorageBrowseKvPayload {
  const payload = expectRecord(value, field);
  const json = payload.json;
  if (typeof json !== "boolean") throw new TypeError(`Coordinator ${field}.json is invalid`);
  const jsonText = optionalText(payload.jsonText, field + ".jsonText", STORAGE_BROWSE_PREVIEW_MAX_BYTES);
  if (jsonText !== undefined && !json) throw new TypeError(`Coordinator ${field}.jsonText is invalid`);
  return {
    valueId: text(payload.valueId, field + ".valueId", 256),
    partition: text(payload.partition, field + ".partition", 256),
    payloadFingerprint: text(payload.payloadFingerprint, field + ".payloadFingerprint", 256),
    json,
    ...(jsonText === undefined ? {} : { jsonText }),
  };
}

function parseStorageBrowsePreview(value: unknown, field: string): StorageBrowsePreview {
  const preview = expectRecord(value, field);
  const format = enumValue(preview.format, STORAGE_PREVIEW_FORMATS, field + ".format");
  const contentType = optionalText(preview.contentType, field + ".contentType", 256);
  const kvPayload = preview.kvPayload === undefined ? undefined : parseStorageBrowseKvPayload(preview.kvPayload, field + ".kvPayload");
  const kvError = preview.kvError === undefined
    ? undefined
    : enumValue(preview.kvError, STORAGE_BROWSE_KV_ERRORS, field + ".kvError");
  return {
    path: text(preview.path, field + ".path", 4_096),
    format,
    bytes: uint8ArrayValue(preview.bytes, field + ".bytes"),
    totalSize: integer(preview.totalSize, field + ".totalSize"),
    returnedSize: integer(preview.returnedSize, field + ".returnedSize"),
    truncated: preview.truncated === true,
    revision: text(preview.revision, field + ".revision", 512),
    lastModified: text(preview.lastModified, field + ".lastModified", 128),
    ...(contentType === undefined ? {} : { contentType }),
    ...(kvPayload === undefined ? {} : { kvPayload }),
    ...(kvError === undefined ? {} : { kvError }),
  };
}

function parseStorageBrowseSession(value: unknown, field: string): StorageBrowseSession {
  const session = expectRecord(value, field);
  return {
    browseSessionId: text(session.browseSessionId, field + ".browseSessionId", 256),
    walletGeneration: text(session.walletGeneration, field + ".walletGeneration", 256),
    sessionEpoch: text(session.sessionEpoch, field + ".sessionEpoch", 256),
    runGeneration: text(session.runGeneration, field + ".runGeneration", 256),
  };
}

function enumValue<const Values extends readonly string[]>(value: unknown, values: Values, field: string): Values[number] {
  const parsed = text(value, field, 128);
  if (!(values as readonly string[]).includes(parsed)) throw new TypeError(`Coordinator ${field} is invalid`);
  return parsed as Values[number];
}
function parseStorageBrowsePrivateRequest(value: unknown): StorageBrowsePrivateRequest {
 const request = expectRecord(value, "Storage private browse request");
 const kind = enumValue(request.kind, ["storage.browse.open", "storage.browse.data", "storage.browse.close"] as const, "kind");
 if (kind === "storage.browse.close") return { kind, browseSessionId: text(request.browseSessionId, "browseSessionId", 256) };
 const expectedSessionEpoch = text(request.expectedSessionEpoch, "expectedSessionEpoch", 256);
 return kind === "storage.browse.open" ? { kind, expectedSessionEpoch } : { kind, expectedSessionEpoch, data: parseStorageBrowseData(request.data) };
}

/** 所有请求结果按具体操作验证，不让公共协议重新接受私有命令。 */
export function parseStorageBrowsePrivateResponse(request: StorageBrowsePrivateRequest, value: unknown): CoordinatorRpcResponse {
 const response = COORDINATOR_RPC_CAPABILITY.response.parse(value);
 const hasResult = Object.prototype.hasOwnProperty.call(response, "operationResult");
 if (Object.prototype.hasOwnProperty.call(response, "cryptoResult")) throw new TypeError("Storage browse response contains cryptoResult");
 if (response.ack.status !== "ok" || request.kind === "storage.browse.close") {
   if (hasResult) throw new TypeError("Storage browse failure/close contains operationResult");
   return response;
 }
 if (!hasResult) throw new TypeError("Storage browse response is missing operationResult");
 const field = "response.operationResult";
 const operationResult = request.kind === "storage.browse.open" ? parseStorageBrowseSession(response.operationResult, field)
   : request.data.type === "browse.list" ? parseStorageBrowsePage(response.operationResult, field) : parseStorageBrowsePreview(response.operationResult, field);
 return { ...response, operationResult };
}

export const STORAGE_PRIVATE_BROWSE_CAPABILITY = defineCapability<StorageBrowsePrivateRequest, CoordinatorRpcResponse>({
 kind: "rpc", id: "storage.private.browse", version: "1",
 request: { parse: parseStorageBrowsePrivateRequest },
 response: COORDINATOR_RPC_CAPABILITY.response,
});
