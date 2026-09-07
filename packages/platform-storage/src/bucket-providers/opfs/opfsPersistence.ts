import { StorageRuntimeError } from "../../runtime/storageRuntimeError.js";

interface OpfsStorageManager {
  persisted?: () => Promise<boolean>;
  persist?: () => Promise<boolean>;
}

/**
 * 在拥有 OPFS Provider 语义的模块内申请 Origin 持久化授权。
 *
 * `StorageManager.persist()` 只能由 Window 发起；SharedWorker 只负责在
 * Provider 探测时查询结果。因此调用方不能直接访问 navigator.storage，
 * 只能通过这个窄适配函数表达“请求 OPFS 持久化”意图。
 */
export async function requestOpfsPersistence(): Promise<void> {
  const manager = (globalThis as typeof globalThis & {
    navigator?: { storage?: OpfsStorageManager };
  }).navigator?.storage;
  if (!manager) throw new StorageRuntimeError("storage_unavailable", "OPFS storage API is unavailable");
  if (typeof manager.persisted === "function" && await manager.persisted()) return;
  if (typeof manager.persist !== "function" || await manager.persist() !== true) {
    throw new StorageRuntimeError("storage_unavailable", "OPFS persistence permission was not granted");
  }
}
