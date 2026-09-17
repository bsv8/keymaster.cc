// 设备桶记录仓储（keymaster.device.<ID>）。
//
// 一个桶一条记录，直接以键名区分；没有连接列表外壳，也没有 selected 字段。
// 记录与 session 同放在 localStorage：写入是同步的整条替换，同一个 Worker 内
// 不会交错；跨标签页/跨浏览器按《存储规则》接受最后写入者胜。

import type { DeviceRecordV1 } from "@keymaster/contracts";
import {
  DEVICE_KEY_PREFIX,
  DEVICE_LIMITS,
  deviceKeyFor,
  deviceLocationCanonical,
  parseDeviceKey,
  validateDeviceRecord,
} from "@keymaster/contracts";
import { StorageRuntimeError } from "../runtime/storageError.js";
import { defaultDeviceStorage, listStorageKeys, type DeviceLocalStorage } from "./deviceStorage.js";

export interface DeviceRecordEntry {
  /** 键名里的 `<ID>`，即 remoteStorageId。 */
  remoteStorageId: string;
  /** 已严格校验的记录。 */
  record: DeviceRecordV1;
}

export interface DeviceRecordListResult {
  /** 可解析的设备桶记录。 */
  entries: DeviceRecordEntry[];
  /** 前缀下无法解析的键；不自动删除。 */
  invalidKeys: string[];
}

export interface DeviceRecordRepository {
  /** 枚举全部设备桶记录。 */
  list(): DeviceRecordListResult;
  /** 读取指定桶记录；不存在返回 undefined。 */
  read(remoteStorageId: string): DeviceRecordV1 | undefined;
  /** 写入一条记录；已有同 ID 记录时必须显式 replace。 */
  put(remoteStorageId: string, record: DeviceRecordV1, options?: { replace?: boolean }): void;
  /** 删除一条记录；不存在时静默返回。 */
  delete(remoteStorageId: string): void;
}

function repositoryError(
  message: string,
  code: "storage_conflict" | "storage_provider_error" | "storage_limit_exceeded" | "storage_remote_corrupt" = "storage_remote_corrupt",
): StorageRuntimeError {
  return new StorageRuntimeError(code, message);
}

function parseRecord(raw: string): DeviceRecordV1 | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  try {
    return validateDeviceRecord(value);
  } catch {
    return undefined;
  }
}

/** 创建绑定某个设备本地存储的仓储；默认使用全局 localStorage。 */
export function createDeviceRecordRepository(storage: DeviceLocalStorage = defaultDeviceStorage()): DeviceRecordRepository {
  function list(): DeviceRecordListResult {
    const entries: DeviceRecordEntry[] = [];
    const invalidKeys: string[] = [];
    for (const key of listStorageKeys(storage)) {
      if (!key.startsWith(DEVICE_KEY_PREFIX)) continue;
      const remoteStorageId = parseDeviceKey(key);
      if (!remoteStorageId) {
        invalidKeys.push(key);
        continue;
      }
      const raw = storage.getItem(key);
      const record = raw === null ? undefined : parseRecord(raw);
      if (!record) {
        invalidKeys.push(key);
        continue;
      }
      entries.push({ remoteStorageId, record });
    }
    entries.sort((left, right) => left.remoteStorageId.localeCompare(right.remoteStorageId));
    invalidKeys.sort();
    return { entries, invalidKeys };
  }

  function read(remoteStorageId: string): DeviceRecordV1 | undefined {
    const raw = storage.getItem(deviceKeyFor(remoteStorageId));
    return raw === null ? undefined : parseRecord(raw);
  }

  function put(remoteStorageId: string, record: DeviceRecordV1, options: { replace?: boolean } = {}): void {
    let checked: DeviceRecordV1;
    try {
      checked = validateDeviceRecord(record);
    } catch {
      throw repositoryError("Device bucket record is invalid", "storage_remote_corrupt");
    }
    const key = deviceKeyFor(remoteStorageId);
    const serialized = JSON.stringify(checked);
    if (new TextEncoder().encode(serialized).byteLength > DEVICE_LIMITS.maxSerializedBytes) {
      throw repositoryError("Device bucket record exceeds its size limit", "storage_limit_exceeded");
    }
    const existing = storage.getItem(key);
    if (existing !== null && options.replace !== true) {
      throw repositoryError("Device bucket record already exists", "storage_conflict");
    }
    if (existing === null) {
      const { entries } = list();
      if (entries.length >= DEVICE_LIMITS.maxRecords) throw repositoryError("Device bucket record limit was reached", "storage_limit_exceeded");
    }
    if (checked.location.providerId === "s3") {
      const canonical = deviceLocationCanonical(checked.location);
      for (const entry of list().entries) {
        if (entry.remoteStorageId === remoteStorageId) continue;
        if (entry.record.location.providerId !== "s3") continue;
        if (deviceLocationCanonical(entry.record.location) === canonical) {
          throw repositoryError("Device bucket location is already registered", "storage_conflict");
        }
      }
    }
    try {
      storage.setItem(key, serialized);
    } catch {
      throw repositoryError("Device bucket record could not be saved", "storage_provider_error");
    }
  }

  function remove(remoteStorageId: string): void {
    try {
      storage.removeItem(deviceKeyFor(remoteStorageId));
    } catch {
      throw repositoryError("Device bucket record could not be removed", "storage_provider_error");
    }
  }

  return { list, read, put, delete: remove };
}
