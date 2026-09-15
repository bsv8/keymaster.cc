// 设备引导 Repository。
//
// 这是生产代码中唯一直接接触浏览器设备持久化 API 的模块。它只读写
// DeviceBootstrapCatalogV1；远端对象、业务数据和 Worker 运行态不得经过这里。

import type {
  DeviceBootstrapCatalogV1,
  DevicePasswordRotationRecordV1,
  DeviceRemoteConnectionV1,
  DeviceRemoteRecoveryPointerV1,
} from "@keymaster/contracts";
import {
  createEmptyDeviceBootstrapCatalog,
  DEVICE_BOOTSTRAP_LIMITS,
  deviceRemoteStorageLocationFingerprint,
  validateDeviceBootstrapCatalog,
  validateDevicePasswordRotationRecord,
  validateDeviceRemoteStorageLocation,
  validateDeviceRemoteConnection,
  validateDeviceRemoteRecoveryPointer,
} from "@keymaster/contracts";
import { StorageRuntimeError } from "../runtime/storageError.js";
import { browserStorageLocks } from "../runtime/browserLocks.js";

export const DEVICE_BOOTSTRAP_KEY = "keymaster.device-bootstrap.v1";
export const DEVICE_BOOTSTRAP_LOCK = "keymaster.device-bootstrap.v1.lock";

export interface DeviceBootstrapStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface DeviceBootstrapLocks {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

export interface DeviceBootstrapRepositoryOptions {
  storage?: DeviceBootstrapStorage;
  locks?: DeviceBootstrapLocks;
  generateId?: () => string;
}

function bootstrapError(message: string, code: "storage_provider_error" | "storage_unavailable" | "storage_limit_exceeded" = "storage_provider_error"): StorageRuntimeError {
  return new StorageRuntimeError(code, message);
}

function defaultStorage(): DeviceBootstrapStorage {
  const storage = (globalThis as typeof globalThis & { localStorage?: DeviceBootstrapStorage }).localStorage;
  if (!storage) throw bootstrapError("Device bootstrap storage is unavailable", "storage_unavailable");
  return storage;
}

/** 供兼容 Repository 复用的默认设备存储句柄；实际 API 仍集中在本模块。 */
export function defaultDeviceBootstrapStorage(): DeviceBootstrapStorage {
  return defaultStorage();
}

function defaultId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

function profileId(generateId: () => string): string {
  const suffix = generateId().replace(/[^A-Za-z0-9_-]/gu, "-").slice(0, 120);
  if (!suffix) throw bootstrapError("Device bootstrap worker profile ID could not be generated");
  return `profile-${suffix}`;
}

function cloneCatalog(catalog: DeviceBootstrapCatalogV1): DeviceBootstrapCatalogV1 {
  return validateDeviceBootstrapCatalog(structuredClone(catalog));
}

function readRaw(storage: DeviceBootstrapStorage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    throw bootstrapError("Device bootstrap storage could not be read", "storage_unavailable");
  }
}

function writeRaw(storage: DeviceBootstrapStorage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch (caught) {
    const name = caught && typeof caught === "object" ? (caught as { name?: unknown }).name : undefined;
    throw bootstrapError(name === "QuotaExceededError" ? "Device bootstrap storage limit was exceeded" : "Device bootstrap storage could not be saved", name === "QuotaExceededError" ? "storage_limit_exceeded" : "storage_unavailable");
  }
}

function removeRaw(storage: DeviceBootstrapStorage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    throw bootstrapError("Device bootstrap storage could not be cleared", "storage_unavailable");
  }
}

function parseCatalog(raw: string | null): DeviceBootstrapCatalogV1 | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw bootstrapError("Device bootstrap catalog JSON is invalid");
  }
  try {
    return validateDeviceBootstrapCatalog(value);
  } catch {
    throw bootstrapError("Device bootstrap catalog is invalid or incompatible");
  }
}

function serializedCatalog(catalog: DeviceBootstrapCatalogV1): string {
  const checked = validateDeviceBootstrapCatalog(catalog);
  const serialized = JSON.stringify(checked);
  if (new TextEncoder().encode(serialized).byteLength > DEVICE_BOOTSTRAP_LIMITS.maxSerializedBytes) {
    throw bootstrapError("Device bootstrap catalog exceeds its size limit", "storage_limit_exceeded");
  }
  return serialized;
}

function validateConnectionInput(input: unknown): DeviceRemoteConnectionV1 {
  // Give callers a stable location error before the contract's generic shape
  // validator rejects a mismatched fingerprint.
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const candidate = input as { location?: unknown; physicalLocationFingerprint?: unknown };
    if (candidate.location !== undefined && typeof candidate.physicalLocationFingerprint === "string") {
      try {
        const location = validateDeviceRemoteStorageLocation(candidate.location);
        if (deviceRemoteStorageLocationFingerprint(location) !== candidate.physicalLocationFingerprint) {
          throw new StorageRuntimeError("storage_remote_location_mismatch", "The device bootstrap physical location fingerprint is invalid");
        }
      } catch (caught) {
        if (caught instanceof StorageRuntimeError) throw caught;
      }
    }
  }
  try {
    return validateDeviceRemoteConnection(input);
  } catch {
    throw bootstrapError("Device bootstrap connection is invalid");
  }
}

/** 读取设备引导；尚未初始化设备时返回 null。 */
export function readDeviceBootstrap(storage: DeviceBootstrapStorage = defaultStorage()): DeviceBootstrapCatalogV1 | null {
  return parseCatalog(readRaw(storage, DEVICE_BOOTSTRAP_KEY));
}

/** 写入完整设备引导；调用方若需要并发保护应使用 Repository.mutate。 */
export function writeDeviceBootstrap(catalog: DeviceBootstrapCatalogV1, storage: DeviceBootstrapStorage = defaultStorage()): void {
  writeRaw(storage, DEVICE_BOOTSTRAP_KEY, serializedCatalog(catalog));
}

/** 删除完整设备引导；只用于显式的设备清理流程。 */
export function clearDeviceBootstrap(storage: DeviceBootstrapStorage = defaultStorage()): void {
  removeRaw(storage, DEVICE_BOOTSTRAP_KEY);
}

/** 创建严格串行的设备引导操作 Repository。 */
export interface DeviceBootstrapRepository {
  read(): DeviceBootstrapCatalogV1 | null | Promise<DeviceBootstrapCatalogV1 | null>;
  upsertConnection(input: DeviceRemoteConnectionV1, select?: boolean): Promise<DeviceRemoteConnectionV1>;
  upsertRecovery(input: DeviceRemoteRecoveryPointerV1): Promise<DeviceRemoteRecoveryPointerV1>;
  removeRecovery(operationId: string): Promise<DeviceBootstrapCatalogV1>;
  upsertRotation(input: DevicePasswordRotationRecordV1): Promise<DevicePasswordRotationRecordV1>;
  removeRotation(operationId: string): Promise<DeviceBootstrapCatalogV1>;
}

export function createDeviceBootstrapRepository(options: DeviceBootstrapRepositoryOptions = {}) {
  const storage = options.storage ?? defaultStorage();
  const locks = options.locks ?? browserStorageLocks();
  const generateId = options.generateId ?? defaultId;

  async function withLock<T>(operation: () => Promise<T>): Promise<T> {
    if (!locks) throw bootstrapError("Device bootstrap locking is unavailable", "storage_unavailable");
    try {
      return await locks.request(DEVICE_BOOTSTRAP_LOCK, operation);
    } catch (caught) {
      if (caught instanceof StorageRuntimeError) throw caught;
      throw bootstrapError("Device bootstrap operation could not be serialized", "storage_unavailable");
    }
  }

  async function mutate(mutator: (catalog: DeviceBootstrapCatalogV1 | null) => DeviceBootstrapCatalogV1 | null | Promise<DeviceBootstrapCatalogV1 | null>): Promise<DeviceBootstrapCatalogV1 | null> {
    return withLock(async () => {
      const current = readDeviceBootstrap(storage);
      const next = await mutator(current === null ? null : cloneCatalog(current));
      if (next === null) {
        clearDeviceBootstrap(storage);
        return null;
      }
      writeDeviceBootstrap(next, storage);
      return cloneCatalog(next);
    });
  }

  async function ensure(): Promise<DeviceBootstrapCatalogV1> {
    return (await mutate((current) => current ?? createEmptyDeviceBootstrapCatalog(profileId(generateId))))!;
  }

  /** 为同一设备存储上下文分配稳定的 SharedWorker profile 标识。 */
  async function ensureWorkerProfileId(): Promise<string> {
    const current = await ensure();
    return current.workerProfileId;
  }

  async function upsertConnection(input: DeviceRemoteConnectionV1, select = true): Promise<DeviceRemoteConnectionV1> {
    const checked = validateConnectionInput(input);
    let result: DeviceRemoteConnectionV1 | undefined;
    await mutate((current) => {
      const catalog = current ?? createEmptyDeviceBootstrapCatalog(profileId(generateId));
      const index = catalog.connections.findIndex((connection) => connection.remoteStorageId === checked.remoteStorageId);
      const sameLocation = index < 0 || catalog.connections[index]!.physicalLocationFingerprint === checked.physicalLocationFingerprint;
      if (!sameLocation) throw new StorageRuntimeError("storage_remote_location_mismatch", "The remote storage ID is already bound to another physical location");
      if (checked.location && deviceRemoteStorageLocationFingerprint(checked.location) !== checked.physicalLocationFingerprint) {
        throw new StorageRuntimeError("storage_remote_location_mismatch", "The device bootstrap physical location fingerprint is invalid");
      }
      const duplicateLocation = catalog.connections.find((connection) => connection.remoteStorageId !== checked.remoteStorageId && connection.physicalLocationFingerprint === checked.physicalLocationFingerprint);
      if (duplicateLocation) throw new StorageRuntimeError("storage_remote_location_mismatch", "The physical location is already bound to another remote storage ID");
      const existing = index < 0 ? undefined : catalog.connections[index]!;
      const nextConnection = existing
        ? { ...checked, createdAt: existing.createdAt, source: existing.source }
        : checked;
      const connections = [...catalog.connections];
      if (index < 0) connections.push(nextConnection);
      else connections[index] = nextConnection;
      result = cloneCatalog({
        ...catalog,
        ...(select ? { selectedRemoteStorageId: checked.remoteStorageId } : {}),
        connections,
      }).connections.find((connection) => connection.remoteStorageId === checked.remoteStorageId);
      return {
        ...catalog,
        ...(select ? { selectedRemoteStorageId: checked.remoteStorageId } : {}),
        connections,
      };
    });
    if (!result) throw bootstrapError("Device bootstrap connection was not committed");
    return result;
  }

  async function select(remoteStorageId: string): Promise<DeviceBootstrapCatalogV1> {
    return (await mutate((current) => {
      if (!current) throw new StorageRuntimeError("storage_not_found", "Device bootstrap connection was not found");
      if (!current.connections.some((connection) => connection.remoteStorageId === remoteStorageId)) throw new StorageRuntimeError("storage_not_found", "Device bootstrap connection was not found");
      return { ...current, selectedRemoteStorageId: remoteStorageId };
    }))!;
  }

  async function removeConnection(remoteStorageId: string): Promise<DeviceBootstrapCatalogV1> {
    return (await mutate((current) => {
      if (!current) throw new StorageRuntimeError("storage_not_found", "Device bootstrap connection was not found");
      if (!current.connections.some((connection) => connection.remoteStorageId === remoteStorageId)) throw new StorageRuntimeError("storage_not_found", "Device bootstrap connection was not found");
      const connections = current.connections.filter((connection) => connection.remoteStorageId !== remoteStorageId);
      const next: DeviceBootstrapCatalogV1 = { ...current, connections };
      if (current.selectedRemoteStorageId === remoteStorageId) delete next.selectedRemoteStorageId;
      return next;
    }))!;
  }

  async function upsertRecovery(input: DeviceRemoteRecoveryPointerV1): Promise<DeviceRemoteRecoveryPointerV1> {
    const checked = validateDeviceRemoteRecoveryPointer(input);
    let result: DeviceRemoteRecoveryPointerV1 | undefined;
    await mutate((current) => {
      const catalog = current ?? createEmptyDeviceBootstrapCatalog(profileId(generateId));
      const recoveries = [...catalog.recoveries];
      const index = recoveries.findIndex((recovery) => recovery.operationId === checked.operationId);
      if (index < 0) recoveries.push(checked);
      else recoveries[index] = checked;
      result = checked;
      return { ...catalog, recoveries };
    });
    return result!;
  }

  async function removeRecovery(operationId: string): Promise<DeviceBootstrapCatalogV1> {
    return (await mutate((current) => {
      if (!current) return null;
      return { ...current, recoveries: current.recoveries.filter((recovery) => recovery.operationId !== operationId) };
    })) ?? createEmptyDeviceBootstrapCatalog(profileId(generateId));
  }

  function validateRotationInput(input: unknown): DevicePasswordRotationRecordV1 {
    try {
      return validateDevicePasswordRotationRecord(input);
    } catch {
      throw bootstrapError("Device bootstrap password rotation record is invalid");
    }
  }

  async function upsertRotation(input: DevicePasswordRotationRecordV1): Promise<DevicePasswordRotationRecordV1> {
    const checked = validateRotationInput(input);
    let result: DevicePasswordRotationRecordV1 | undefined;
    await mutate((current) => {
      const catalog = current ?? createEmptyDeviceBootstrapCatalog(profileId(generateId));
      const rotations = [...(catalog.rotations ?? [])];
      const index = rotations.findIndex((rotation) => rotation.operationId === checked.operationId);
      if (index < 0) rotations.push(checked);
      else rotations[index] = checked;
      result = checked;
      return { ...catalog, rotations };
    });
    if (!result) throw bootstrapError("Device bootstrap password rotation record was not committed");
    return result;
  }

  async function removeRotation(operationId: string): Promise<DeviceBootstrapCatalogV1> {
    return (await mutate((current) => {
      if (!current) return null;
      return { ...current, rotations: (current.rotations ?? []).filter((rotation) => rotation.operationId !== operationId) };
    })) ?? createEmptyDeviceBootstrapCatalog(profileId(generateId));
  }

  return {
    read: () => readDeviceBootstrap(storage),
    write: (catalog: DeviceBootstrapCatalogV1) => writeDeviceBootstrap(catalog, storage),
    mutate,
    withLock,
    ensure,
    ensureWorkerProfileId,
    upsertConnection,
    select,
    removeConnection,
    upsertRecovery,
    removeRecovery,
    upsertRotation,
    removeRotation,
  };
}
