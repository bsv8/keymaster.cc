// 全局存储运行状态与平台运行时契约。
//
// 正式介质只有本 Origin 的 IndexedDB：这里没有桶、没有 Provider 选择、没有
// endpoint/region/凭据，也没有条件写能力探测。条件创建、版本比较与批量提交
// 由 IndexedDB 事务原生保证，运行态只报告事务与配额层面的健康度。
import { defineCapability } from "webloom-framework";
import type { OwnerAppStorageGrant } from "../connectStorage.js";
import type {
  StorageDeleteResult,
  StorageDirectoryResult,
  StorageGetResult,
  StorageListResult,
  StoragePutResult,
} from "../connectStorage.js";
import type {
  WalletColdStartSnapshot,
  WalletInitializePlan,
  WalletInitializeResult,
  WalletUnlockResult,
} from "./wallet.js";

/** 稳定、脱敏的存储错误分类。 */
export type StorageErrorCode =
  | "storage_not_configured"
  | "storage_unavailable"
  | "storage_invalid_path"
  | "storage_not_found"
  | "storage_conflict"
  | "storage_forbidden"
  | "storage_limit_exceeded"
  | "storage_persistence_unavailable"
  | "storage_provider_error"
  | "storage_identity_required"
  /** 本地格式损坏；不能退回创建空钱包覆盖。 */
  | "storage_wallet_corrupt"
  /** 本地 schema 版本高于当前实现。 */
  | "storage_wallet_unsupported";

/**
 * Storage 控制器对外状态。
 *
 * 没有 `unconfigured`：本地介质永远配置正确，可失败的原因只有
 * uninitialized（还没有 Key）、locked（需要密码）、corrupt 和 unavailable。
 */
export type StorageRuntimeControllerStatus =
  | "uninitialized"
  | "locked"
  | "ready"
  | "degraded"
  | "corrupt"
  | "unsupported";

/** 浏览器持久存储授权状态。
 *
 * 授权成功不等于备份或跨设备同步：数据仍然只在本浏览器本 Origin 内。
 */
export interface StoragePersistenceView {
  /** 是否已获得持久化授权。 */
  persisted: boolean;
  /** 配额使用量（字节）；宿主不支持时省略。 */
  usageBytes?: number;
  /** 配额上限（字节）；宿主不支持时省略。 */
  quotaBytes?: number;
}

/** 设置页与 Vault 可读的非敏感本地存储摘要。 */
export interface StorageRuntimeSummary {
  status: StorageRuntimeControllerStatus;
  /** 固定介质名；不是业务 API，仅用于界面说明。 */
  medium: "indexeddb";
  /** 唯一 Key 的压缩公钥；未初始化时省略。 */
  publicKeyHex?: string;
  /** 唯一 Key 的显示标签；未初始化时省略。 */
  label?: string;
  /** 当前钱包身份世代。 */
  walletGeneration?: string;
  /** 浏览器持久化授权状态。 */
  persistence: StoragePersistenceView;
}

/** Storage 控制器。
 *
 * 生命周期入口（初始化、解锁、改密、导出、重置）来自
 * {@link import("./wallet.js").WalletLifecycleService}；这里只保留控制器需要
 * 暴露的运行时包装，便于页面用一个对象读取状态。
 */
export interface StorageRuntimeController {
  status(): StorageRuntimeControllerStatus;
  subscribe(listener: () => void): () => void;
  /** 读取本地存储摘要；不接触 Provider 或物理路径。 */
  summary(): Promise<StorageRuntimeSummary>;
  /** 冷启动只读 meta 与固定 KeyHold。 */
  coldStart?(): Promise<WalletColdStartSnapshot>;
  /** 创建或导入唯一 Key；同一事务提交 Key、meta 与初始系统数据。 */
  initialize?(plan: WalletInitializePlan): Promise<WalletInitializeResult>;
  /** 用 Key 密码解锁唯一 Key。 */
  unlock?(password: string): Promise<WalletUnlockResult>;
  /** 锁定：撤销会话、grant 与任务授权。 */
  lock?(): Promise<void>;
  /** 修改 Key 密码。 */
  changeKeyPassword?(input: { oldPassword: string; newPassword: string }): Promise<void>;
  /** 只修改显示名称。 */
  renameKey?(label: string): Promise<void>;
  /** 原样导出加密 KeyHold；不是完整钱包备份。 */
  exportKeyHold?(): Promise<Uint8Array>;
  /** 重置钱包：撤销授权后原子清空新格式全部数据。 */
  resetWallet?(input: { confirmationLabel: string }): Promise<{ walletGeneration: string; clearedAt: string }>;
  abortSession(connectSessionId: string): Promise<void>;
  list(ctx: OwnerAppStorageGrant, input: { prefix?: string; cursor?: string; limit?: number; signal?: AbortSignal }): Promise<StorageListResult>;
  createDirectory(ctx: OwnerAppStorageGrant, input: { path: string; overwrite?: boolean; signal?: AbortSignal }): Promise<StorageDirectoryResult>;
  deleteDirectory(ctx: OwnerAppStorageGrant, input: { path: string; signal?: AbortSignal }): Promise<StorageDirectoryResult>;
  put(ctx: OwnerAppStorageGrant, input: { path: string; content: { $type: "binary"; bytes: ArrayBuffer; mime?: string }; contentType?: string; overwrite?: boolean; signal?: AbortSignal }): Promise<StoragePutResult>;
  getRange(ctx: OwnerAppStorageGrant, input: { path: string; offset?: number; length?: number; ifMatch?: string; signal?: AbortSignal }): Promise<StorageGetResult>;
  delete(ctx: OwnerAppStorageGrant, input: { path: string; signal?: AbortSignal }): Promise<StorageDeleteResult>;
}

export type StorageRuntimeStatusService = Pick<StorageRuntimeController, "status" | "subscribe" | "summary" | "abortSession">;

export const STORAGE_RUNTIME_CONTROLLER_CAPABILITY = defineCapability<StorageRuntimeStatusService>({
  kind: "local",
  id: "storage.runtime-controller",
  version: "1",
});
export const VAULT_LOCAL_SECRET_CAPABILITY = defineCapability<import("../vault.js").VaultLocalSecretService>({
  kind: "local",
  id: "vault.local-secret",
  version: "1",
});
