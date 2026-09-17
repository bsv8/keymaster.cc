import { defineCapability } from "webloom-framework";
import type { OwnerAppStore } from "./access.js";
import type { KeyValueStore } from "./kv.js";
import type { PluginStorageDeclaration } from "./access.js";
import type { SessionEpoch } from "../sessionCoordinator.js";

/**
 * Host/Coordinator 内部的存储绑定权威。
 *
 * 该接口不放进公开 KeyspaceService：业务插件只能拿到 Host 已绑定的
 * ctx.storage，不能通过 moduleId/purposeId 自己选择其它 namespace。
 */
export interface StorageBindingAuthority {
  /** 当前 active owner；锁定或切 key 时返回最新状态，供 Host 使句柄失效。 */
  getActivePublicKeyHex?(): string | undefined;
  openOwnerAppStore(input: { pluginId: string; declaration: PluginStorageDeclaration }): Promise<OwnerAppStore>;
  /** 打开 owner 文件根（model: "files"）；数据面仍走 storageOwnerData 的文件操作。 */
  openOwnerFileStore(input: { pluginId: string; declaration: PluginStorageDeclaration }): Promise<import("./files.js").OwnerFileStore>;
  openPlatformStore(input: { pluginId: string; declaration: PluginStorageDeclaration }): Promise<KeyValueStore>;
  deleteOwnerStorage(input: { ownerPublicKeyHex: string }): Promise<void>;
}

export const STORAGE_BINDING_AUTHORITY_CAPABILITY = defineCapability<StorageBindingAuthority>({
  kind: "local",
  id: "storage.binding-authority",
  version: "1",
});

/** 页面到 Coordinator 的内部 owner/platform 数据面；请求只携带不透明 grant。 */
export type CoordinatorOwnerStorageData =
  | { type: "owner.get"; storageGrantId: string; key: string; partition?: string }
  | { type: "owner.list"; storageGrantId: string; input?: { prefix?: string; cursor?: string; limit?: number; partition?: string } }
  | { type: "owner.put"; storageGrantId: string; key: string; value: unknown; condition?: { ifRevision?: number; partition?: string } }
  | { type: "owner.delete"; storageGrantId: string; key: string; condition?: { ifRevision?: number; partition?: string } }
  | { type: "owner.commit"; storageGrantId: string; partition: string; ifRevision?: number; operations: import("./kv.js").KeyValueCommitOperation[] }
  /** owner 文件根（model: "files"）：一文件一对象,路径都是模块根下的相对路径。 */
  | { type: "owner.file-list"; storageGrantId: string; input?: { prefix?: string; cursor?: string; limit?: number } }
  | { type: "owner.file-get"; storageGrantId: string; path: string }
  | { type: "owner.file-put"; storageGrantId: string; path: string; bytes: Uint8Array; ifNoneMatch?: boolean; ifMatch?: string }
  | { type: "owner.file-delete"; storageGrantId: string; path: string; ifMatch?: string };

export type CoordinatorPlatformStorageData =
  | { type: "platform.get"; platformGrantId: string; key: string; partition?: string }
  | { type: "platform.list"; platformGrantId: string; input?: { prefix?: string; cursor?: string; limit?: number; partition?: string } }
  | { type: "platform.put"; platformGrantId: string; key: string; value: unknown; condition?: { ifRevision?: number; partition?: string } }
  | { type: "platform.delete"; platformGrantId: string; key: string; condition?: { ifRevision?: number; partition?: string } }
  | { type: "platform.commit"; platformGrantId: string; partition: string; ifRevision?: number; operations: import("./kv.js").KeyValueCommitOperation[] };

/** 平台 K-V 授权；物理路径、Provider 和 ETag 只保存在 Worker 内。 */
export interface StoragePlatformGrant {
  platformGrantId: string;
  bucketId: string;
  bucketGeneration: number;
  moduleId: string;
  purposeId: string;
  authority: "platform-only" | "built-in-module";
  model: "kv";
  schemaVersion: number;
  sessionEpoch: SessionEpoch;
}

export interface StorageBindingCoordinatorClient {
  storageBindOwner(input: { pluginId: string; declaration: PluginStorageDeclaration }): Promise<import("../sessionCoordinator.js").CoordinatorValueResult<StorageOwnerGrant>>;
  storageBindPlatform(input: { pluginId: string; declaration: PluginStorageDeclaration }): Promise<import("../sessionCoordinator.js").CoordinatorValueResult<StoragePlatformGrant>>;
  storageOwnerData(data: CoordinatorOwnerStorageData, transfer?: ArrayBuffer[], signal?: AbortSignal): Promise<import("../sessionCoordinator.js").CoordinatorValueResult<unknown>>;
  storagePlatformData(data: CoordinatorPlatformStorageData): Promise<import("../sessionCoordinator.js").CoordinatorValueResult<unknown>>;
  storageDeleteOwner(ownerPublicKeyHex: string): Promise<import("../sessionCoordinator.js").CoordinatorValueResult<unknown>>;
}

/** Worker 为某个 pluginId 发放的 owner 存储不透明授权。 */
export interface StorageOwnerGrant {
  storageGrantId: string;
  bucketId: string;
  bucketGeneration: number;
  ownerPublicKeyHex: string;
  moduleId: string;
  purposeId: string;
  authority: "built-in-module" | "third-party-app";
  /** owner 数据模型：K-V 或文件根。 */
  model: "kv" | "files";
  schemaVersion: number;
  /** 发放时绑定的桶级 owner 世代；重导入后旧授权不能写入新世代。 */
  ownerStorageGeneration: number;
  sessionEpoch: SessionEpoch;
}
