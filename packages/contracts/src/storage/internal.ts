import { defineCapability } from "webloom-framework";
import type { OwnerAppStore } from "./access.js";
import type { KeyValueStore } from "./kv.js";
import type { ModuleFileStore } from "./files.js";
import type { PluginStorageDeclaration } from "./access.js";

/**
 * Host/Coordinator 内部的存储绑定权威。
 *
 * 该接口不放进公开 VaultWalletState：业务插件只能拿到 Host 已绑定的
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
  getRunGeneration?(): string | undefined;
  openOwnerAppStore(input: { pluginId: string; declaration: PluginStorageDeclaration }): Promise<OwnerAppStore>;
  /** 打开模块文件根（model: "files"）。 */
  openOwnerFileStore(input: { pluginId: string; declaration: PluginStorageDeclaration }): Promise<ModuleFileStore>;
  /** 清空一个已绑定根下的全部对象；只由重置与单 App 清理流程调用。 */
  clearStorageRoot(input: { declaration: PluginStorageDeclaration; appStorageName?: string }): Promise<void>;
}

export const STORAGE_BINDING_AUTHORITY_CAPABILITY = defineCapability<StorageBindingAuthority>({
  kind: "local",
  id: "storage.binding-authority",
  version: "1",
});

/** 页面到 Coordinator 的内部模块数据面；请求携带装配层绑定的用途与钱包运行身份。 */
export type CoordinatorOwnerStorageData =
  | { type: "owner.get"; binding: StorageOwnerBinding; key: string; partition?: string }
  | { type: "owner.list"; binding: StorageOwnerBinding; input?: { prefix?: string; cursor?: string; limit?: number; partition?: string } }
  | { type: "owner.put"; binding: StorageOwnerBinding; key: string; value: unknown; condition?: { ifRevision?: number; partition?: string } }
  | { type: "owner.delete"; binding: StorageOwnerBinding; key: string; condition?: { ifRevision?: number; partition?: string } }
  | { type: "owner.commit"; binding: StorageOwnerBinding; partition: string; ifRevision?: number; operations: import("./kv.js").KeyValueCommitOperation[] }
  /** 模块文件根（model: "files"）：一文件一对象，路径都是模块根下的相对路径。 */
  | { type: "owner.file-list"; binding: StorageOwnerBinding; input?: { prefix?: string; cursor?: string; limit?: number } }
  | { type: "owner.file-get"; binding: StorageOwnerBinding; path: string; ifRevision?: string }
  | { type: "owner.file-range"; binding: StorageOwnerBinding; path: string; range: { offset: number; length: number }; ifRevision?: string }
  | { type: "owner.file-put"; binding: StorageOwnerBinding; path: string; bytes: Uint8Array; ifNoneMatch?: boolean; ifRevision?: string; contentType?: string }
  | { type: "owner.file-delete"; binding: StorageOwnerBinding; path: string; ifRevision?: string }
  | {
    type: "owner.file-batch";
    binding: StorageOwnerBinding;
    operations: Array<{ type: "put"; path: string; bytes: Uint8Array; contentType?: string } | { type: "delete"; path: string }>;
    conditions?: Array<{ path: string; ifRevision?: string; ifNoneMatch?: boolean }>;
  };

export interface StorageBindingCoordinatorClient {
  storageOwnerData(data: CoordinatorOwnerStorageData, transfer?: ArrayBuffer[], signal?: AbortSignal): Promise<import("../sessionCoordinator.js").CoordinatorValueResult<unknown>>;
  storageClearRoot(input: { declaration: PluginStorageDeclaration; appStorageName?: string }): Promise<import("../sessionCoordinator.js").CoordinatorValueResult<unknown>>;
}

/** 由可信装配根据真实 consumer 与中央声明构造；不是每次解锁签发的许可。 */
export interface StorageOwnerBinding {
  /** 钱包运行实例标识；遮罩与改密不变，重置后重新激活必然不同。 */
  sessionEpoch: string;
  walletGeneration: string;
  runGeneration: string;
  moduleId: string;
  purposeId: string;
  authority: "built-in-module";
  model: "kv" | "files";
  schemaVersion: number;
}

export type { WalletStore, WalletObject, WalletObjectMeta, WalletWriteCondition, WalletPutResult, WalletBatchOperation, WalletBatchCondition, WalletBatchInput, WalletBatchResult } from "./walletStoreInternal.js";
export { StorageRuntimeError, storageErrorCode, type StorageDiagnostic } from "./runtimeError.js";

export { WALLET_INITIALIZATION_PATH, type WalletVaultKeyStore, type WalletVaultLifecycleStore } from "./walletStoreInternal.js";
