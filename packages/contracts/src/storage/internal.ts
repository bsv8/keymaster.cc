import { defineCapability } from "webloom-framework";
import type { OwnerAppStore } from "./access.js";
import type { KeyValueStore } from "./kv.js";
import type { ModuleFileStore } from "./files.js";
import type { PluginStorageDeclaration } from "./access.js";
import type { SessionEpoch } from "../sessionCoordinator.js";
import type { AppIdentitySnapshot } from "../appIdentity.js";

/**
 * Host/Coordinator 内部的存储绑定权威。
 *
 * 该接口不放进公开 KeyspaceService：业务插件只能拿到 Host 已绑定的
 * ctx.storage，不能通过 moduleId/purposeId 自己选择其它 namespace。
 */
export interface StorageBindingAuthority {
  /** 当前钱包公钥；锁定或重置时返回最新状态，供 Host 使句柄失效。 */
  getActivePublicKeyHex?(): string | undefined;
  /**
   * 当前钱包身份世代。
   *
   * 重置或重新初始化后必须改变，即使重新导入同一私钥；Host 用它判断已打开
   * 的句柄是否还属于当前钱包。
   */
  getWalletGeneration?(): string | undefined;
  openOwnerAppStore(input: { pluginId: string; declaration: PluginStorageDeclaration }): Promise<OwnerAppStore>;
  /** 打开模块文件根（model: "files"）。 */
  openOwnerFileStore(input: { pluginId: string; declaration: PluginStorageDeclaration }): Promise<ModuleFileStore>;
  openPlatformStore(input: { pluginId: string; declaration: PluginStorageDeclaration }): Promise<KeyValueStore>;
  /** 清空一个已绑定根下的全部对象；只由重置与单 App 清理流程调用。 */
  clearStorageRoot(input: { declaration: PluginStorageDeclaration; appStorageName?: string }): Promise<void>;
}

export const STORAGE_BINDING_AUTHORITY_CAPABILITY = defineCapability<StorageBindingAuthority>({
  kind: "local",
  id: "storage.binding-authority",
  version: "1",
});

/** 页面到 Coordinator 的内部模块数据面；请求只携带不透明 grant。 */
export type CoordinatorOwnerStorageData =
  | { type: "owner.get"; storageGrantId: string; key: string; partition?: string }
  | { type: "owner.list"; storageGrantId: string; input?: { prefix?: string; cursor?: string; limit?: number; partition?: string } }
  | { type: "owner.put"; storageGrantId: string; key: string; value: unknown; condition?: { ifRevision?: number; partition?: string } }
  | { type: "owner.delete"; storageGrantId: string; key: string; condition?: { ifRevision?: number; partition?: string } }
  | { type: "owner.commit"; storageGrantId: string; partition: string; ifRevision?: number; operations: import("./kv.js").KeyValueCommitOperation[] }
  /** 模块文件根（model: "files"）：一文件一对象，路径都是模块根下的相对路径。 */
  | { type: "owner.file-list"; storageGrantId: string; input?: { prefix?: string; cursor?: string; limit?: number } }
  | { type: "owner.file-get"; storageGrantId: string; path: string; ifRevision?: string }
  | { type: "owner.file-range"; storageGrantId: string; path: string; range: { offset: number; length: number }; ifRevision?: string }
  | { type: "owner.file-put"; storageGrantId: string; path: string; bytes: Uint8Array; ifNoneMatch?: boolean; ifRevision?: string; contentType?: string }
  | { type: "owner.file-delete"; storageGrantId: string; path: string; ifRevision?: string }
  | {
    type: "owner.file-batch";
    storageGrantId: string;
    operations: Array<{ type: "put"; path: string; bytes: Uint8Array; contentType?: string } | { type: "delete"; path: string }>;
    conditions?: Array<{ path: string; ifRevision?: string; ifNoneMatch?: boolean }>;
  };

export type CoordinatorPlatformStorageData =
  | { type: "platform.get"; platformGrantId: string; key: string; partition?: string }
  | { type: "platform.list"; platformGrantId: string; input?: { prefix?: string; cursor?: string; limit?: number; partition?: string } }
  | { type: "platform.put"; platformGrantId: string; key: string; value: unknown; condition?: { ifRevision?: number; partition?: string } }
  | { type: "platform.delete"; platformGrantId: string; key: string; condition?: { ifRevision?: number; partition?: string } }
  | { type: "platform.commit"; platformGrantId: string; partition: string; ifRevision?: number; operations: import("./kv.js").KeyValueCommitOperation[] };

/** 平台 K-V 授权；物理路径、数据库连接和内部 revision 只保存在 Worker 内。 */
export interface StoragePlatformGrant {
  platformGrantId: string;
  walletGeneration: string;
  runGeneration: string;
  moduleId: string;
  purposeId: string;
  authority: "platform-only" | "built-in-module";
  model: "kv";
  schemaVersion: number;
  sessionEpoch: SessionEpoch;
}

export interface StorageBindingCoordinatorClient {
  storageBindOwner(input: { pluginId: string; declaration: PluginStorageDeclaration }): Promise<import("../sessionCoordinator.js").CoordinatorValueResult<StorageOwnerGrant | ThirdPartyAppStorageGrant>>;
  storageBindPlatform(input: { pluginId: string; declaration: PluginStorageDeclaration }): Promise<import("../sessionCoordinator.js").CoordinatorValueResult<StoragePlatformGrant>>;
  storageOwnerData(data: CoordinatorOwnerStorageData, transfer?: ArrayBuffer[], signal?: AbortSignal): Promise<import("../sessionCoordinator.js").CoordinatorValueResult<unknown>>;
  storagePlatformData(data: CoordinatorPlatformStorageData): Promise<import("../sessionCoordinator.js").CoordinatorValueResult<unknown>>;
  storageClearRoot(input: { declaration: PluginStorageDeclaration; appStorageName?: string }): Promise<import("../sessionCoordinator.js").CoordinatorValueResult<unknown>>;
}

/**
 * Worker 为某个内置模块发放的不透明存储授权。
 *
 * 授权只描述逻辑坐标（moduleId + purposeId）与四件世代身份；物理路径、
 * 数据库连接和 revision 编号留在 Worker 内，不穿过 wire。
 */
export interface StorageOwnerGrant {
  storageGrantId: string;
  walletGeneration: string;
  runGeneration: string;
  moduleId: string;
  purposeId: string;
  authority: "built-in-module";
  /** 模块数据模型：K-V 或文件根。 */
  model: "kv" | "files";
  schemaVersion: number;
  sessionEpoch: SessionEpoch;
}

/**
 * Worker 为一个已验证第三方 App 发放的目录不透明授权。
 *
 * 目录由平台登记的 `appStorageName` 决定，访问权由验证后的 App 身份决定；
 * 两者都不可由调用方自报，因此同名的两个 App 不可能共用目录。
 */
export interface ThirdPartyAppStorageGrant {
  storageGrantId: string;
  walletGeneration: string;
  runGeneration: string;
  /** 平台登记并规范化后的稳定存储名称；决定目录。 */
  appStorageName: string;
  /** 验证后的 App 身份；决定谁有权访问，不能只靠 name。 */
  verifiedAppIdentity: Pick<AppIdentitySnapshot, "publisherPublicKeyHex" | "appId">;
  authority: "third-party-app";
  model: "files";
  schemaVersion: number;
  sessionEpoch: SessionEpoch;
}

/** `storage.owner.bind` 的结果：内置模块授权或第三方 App 目录授权。 */
export type StorageBindingGrant = StorageOwnerGrant | ThirdPartyAppStorageGrant;
