import { defineCapability, type PluginConsumer, type LifecycleScope } from "webloom-framework";
import type { AppIdentitySnapshot } from "./appIdentity.js";
import type { StorageRuntimeController } from "./storage/runtime.js";

/** Verified session facts; callers cannot choose a module, purpose or physical App directory. */
export interface AppStorageBinding {
  connectSessionId: string;
  transportOrigin: string;
  appIdentity: AppIdentitySnapshot;
  sessionEpoch: string;
  walletGeneration: string;
  runGeneration: string;
}
export interface AppStorageClient {
  list(input: Parameters<StorageRuntimeController["list"]>[1]): ReturnType<StorageRuntimeController["list"]>;
  createDirectory(input: Parameters<StorageRuntimeController["createDirectory"]>[1]): ReturnType<StorageRuntimeController["createDirectory"]>;
  deleteDirectory(input: Parameters<StorageRuntimeController["deleteDirectory"]>[1]): ReturnType<StorageRuntimeController["deleteDirectory"]>;
  put(input: Parameters<StorageRuntimeController["put"]>[1]): ReturnType<StorageRuntimeController["put"]>;
  getRange(input: Parameters<StorageRuntimeController["getRange"]>[1]): ReturnType<StorageRuntimeController["getRange"]>;
  delete(input: Parameters<StorageRuntimeController["delete"]>[1]): ReturnType<StorageRuntimeController["delete"]>;
}
export interface AppStorageClients {
  /** The gateway's issued consumer is distinct from the verified App session identity. */
  bind(consumer: PluginConsumer, scope: LifecycleScope, binding: AppStorageBinding): AppStorageClient;
}
export const APP_STORAGE_CLIENTS_CAPABILITY = defineCapability<AppStorageClients>({ kind: "local", id: "storage.app-clients", version: "1" });
