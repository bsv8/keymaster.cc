// 全局存储运行状态与平台运行时契约。
import { defineCapability } from "webloom-framework";
import type { OwnerAppStorageGrant } from "../connectStorage.js";
import type {
  StorageDeleteResult,
  StorageDirectoryResult,
  StorageGetResult,
  StorageListResult,
  StoragePutResult,
  StorageUploadAbortResult,
  StorageUploadBeginResult,
  StorageUploadPartResult
} from "../connectStorage.js";
import type { StorageConnection, StorageProviderConfigDraft, StorageProviderId } from "./profile.js";
import type { ExistingRemoteStorageConnectPlan, ExistingRemoteStorageConnectResult, InitialSetupPlan, InitialSetupRecoveryRecordV1, InitialSetupRecoveryResult, InitialSetupResult, StorageBucketPasswordRotationResultV1, StorageBucketPasswordRotationResumeResultV1, StorageBucketSwitchResultV1, StorageBucketCatalogEntryV2, StorageBucketConnectionConfigV1 } from "./catalog.js";
import type { PendingPasswordRotationViewV1 } from "./deviceBootstrap.js";

/** Provider 运行状态；由 Coordinator 统一发布。 */
export type StorageRuntimeStatus = "unselected" | "authentication" | "checking" | "ready" | "degraded" | "incompatible";

/** Storage 控制器对外状态。 */
export type StorageRuntimeControllerStatus = "unconfigured" | "locked" | "checking" | "ready" | "reconfiguring" | "degraded";

/** 稳定、脱敏的 Storage 错误分类。 */
export type StorageErrorCode =
  | "storage_not_configured" | "storage_unavailable" | "storage_invalid_path" | "storage_not_found"
  | "storage_conflict" | "storage_forbidden" | "storage_limit_exceeded" | "storage_invalid_upload"
  | "storage_provider_error" | "storage_identity_required"
  | "storage_remote_not_initialized" | "storage_remote_already_initialized"
  | "storage_remote_incompatible" | "storage_remote_corrupt"
  | "storage_remote_unknown_result" | "storage_remote_location_mismatch";

/** Provider 连接摘要。 */
export interface StorageProviderSummary {
  /** Provider 类型。 */
  providerId: StorageProviderId;
  /** 脱敏 Bucket 名称。 */
  bucketHint: string;
  /** 脱敏 Endpoint。 */
  endpointHint?: string;
  /** 脱敏 Access Key ID。 */
  accessKeyHint: string;
  /** 当前始终存在密钥配置。 */
  secretConfigured: true;
  /** 当前抽象桶绑定世代。 */
  generation: number;
  /** 最后更新时间戳（毫秒）。 */
  updatedAt: number;
}

/** 设置页可读的非敏感连接字段。 */
export interface StorageProviderConnectionView {
  /** Provider 类型。 */
  providerId: StorageProviderId;
  /** 连接位置。 */
  connection: StorageConnection;
}

/** Provider 探测结果。 */
export type StorageProbeDiagnostic = "configuration" | "authentication" | "forbidden" | "not-found" | "cors" | "network" | "provider";

export interface StorageProbeResult {
  /** 是否通过探测。 */
  ok: boolean;
  /** Provider 类型。 */
  providerId: StorageProviderId;
  /** 探测延迟（毫秒）。 */
  latencyMs: number;
  /** 脱敏诊断分类。 */
  diagnostic?: StorageProbeDiagnostic;
}

/** 首次绑定 S3 桶的结果；绑定完成后不再提供运行期 Provider 选择。 */
export interface StorageSelectedResult {
  status: "selected";
  backend: "s3";
  requiresRuntimeBootstrap: true;
}
export type StorageActivationResult = StorageProbeResult | StorageSelectedResult;

/** 条件写能力模式。 */
export type BucketConditionalWriteMode = "unknown" | "native" | "best-effort";
export type BucketCapabilitySource = "automatic" | "manual";

export interface BucketConditionalCapabilityView {
  /** 条件写能力。 */
  mode: BucketConditionalWriteMode;
  /** 能力来源。 */
  source?: BucketCapabilitySource;
  /** 探测更新时间（毫秒）。 */
  updatedAt?: number;
}

export interface BucketConditionalCapabilitiesView {
  /** 能力对应的 Provider 配置世代。 */
  generation: number;
  /** 单对象写能力。 */
  put: BucketConditionalCapabilityView;
  /** Multipart complete 能力。 */
  complete: BucketConditionalCapabilityView;
}

/** 条件写能力探测结果。 */
export interface BucketConditionalCapabilityProbeResult {
  /** 探测对应的 Provider 配置世代。 */
  generation: number;
  /** 单对象写探测结果。 */
  put: "native" | "best-effort" | "inconclusive";
  /** Multipart 完成探测结果。 */
  complete: "native" | "best-effort" | "inconclusive";
  /** 探测清理是否出现警告。 */
  cleanupWarning: boolean;
}

export interface StorageRuntimeController {
  status(): StorageRuntimeControllerStatus;
  subscribe(listener: () => void): () => void;
  /** 是否存在新版桶目录；旧版 Vault 顶栏据此让位给桶树。 */
  hasCatalogBuckets?(): boolean;
  /** Current catalog bucket mode, exposed by the coordinator proxy. */
  isCatalogBucket?(): boolean;
  /** Current local catalog selection, if the coordinator has one. */
  selectedBucketId?(): string | undefined;
  /** Unlock the current catalog bucket and restore the owner session. */
  unlockBucket?(password: string): Promise<unknown>;
  /** Export the committed current bucket Hold snapshot. */
  coldExportBucket?(): Promise<Uint8Array>;
  getProviderSummary(): Promise<StorageProviderSummary | null>;
  getProviderConnection(): Promise<StorageProviderConnectionView | null>;
  /**
   * 首次初始化的唯一高层入口：完整计划在 Worker 内一次性暂存、提交并安装
   * Storage/Vault/active Key；页面不得拆成多个持久化调用。
   */
  initialSetup?(plan: InitialSetupPlan): Promise<InitialSetupResult>;
  /** 明确连接已存在的远端；该流程不会退化为创建。 */
  connectExistingRemote?(plan: ExistingRemoteStorageConnectPlan): Promise<ExistingRemoteStorageConnectResult>;
  /** 查询响应丢失或 Worker 重启后的同事务结果。 */
  getInitialSetupResult?(transactionId: string): Promise<InitialSetupResult | undefined>;
  /** 页面重载后发现 pending/unconfirmed 初始化；返回值不包含秘密。 */
  listInitialSetupRecoveries?(): Promise<InitialSetupRecoveryRecordV1[]>;
  /** 重试同一事务的候选清理；密码/连接只在本次调用中使用，不进入恢复记录。 */
  retryInitialSetupCleanup?(transactionId: string, input?: { password?: string; connection?: StorageBucketConnectionConfigV1 }): Promise<InitialSetupRecoveryResult>;
  cancelProbe(): void;
  /** 当前新版桶的配置、Hold 快照和桶内 Key records 全量改密。 */
  changeBucketPassword?(oldPassword: string, newPassword: string): Promise<StorageBucketPasswordRotationResultV1>;
  /** 页面重载或 Worker 重启后查询尚未收敛的密码轮转安全投影；不含内部恢复字段。 */
  listPendingPasswordRotations?(): Promise<PendingPasswordRotationViewV1[]>;
  /** 使用用户本次输入的新旧密码收敛指定的密码轮转事务。 */
  resumeBucketPasswordRotation?(operationId: string, oldPassword: string, newPassword: string): Promise<StorageBucketPasswordRotationResumeResultV1>;
  /** 先认证目标桶，再原子切换 Coordinator 与本机目录的当前桶。 */
  switchBucket?(bucket: StorageBucketCatalogEntryV2, password: string): Promise<StorageBucketSwitchResultV1>;
  /** 当前桶连接配置与名称的原子重配置。 */
  changeBucketConnectionConfig?(config: StorageBucketConnectionConfigV1, password: string, label?: string): Promise<StorageBucketCatalogEntryV2>;
  /** 当前桶名称的原子目录 CAS；页面不能直接改当前桶目录。 */
  renameBucket?(label: string): Promise<StorageBucketCatalogEntryV2>;
  getConditionalCapabilities(): BucketConditionalCapabilitiesView | null;
  probeConditionalCapabilities(signal?: AbortSignal): Promise<BucketConditionalCapabilityProbeResult>;
  abortSession(connectSessionId: string): Promise<void>;
  list(ctx: OwnerAppStorageGrant, input: { prefix?: string; cursor?: string; limit?: number; signal?: AbortSignal }): Promise<StorageListResult>;
  createDirectory(ctx: OwnerAppStorageGrant, input: { path: string; overwrite?: boolean; signal?: AbortSignal }): Promise<StorageDirectoryResult>;
  deleteDirectory(ctx: OwnerAppStorageGrant, input: { path: string; signal?: AbortSignal }): Promise<StorageDirectoryResult>;
  put(ctx: OwnerAppStorageGrant, input: { path: string; content: { $type: "binary"; bytes: ArrayBuffer; mime?: string }; contentType?: string; overwrite?: boolean; signal?: AbortSignal }): Promise<StoragePutResult>;
  getRange(ctx: OwnerAppStorageGrant, input: { path: string; offset?: number; length?: number; ifMatch?: string; signal?: AbortSignal }): Promise<StorageGetResult>;
  delete(ctx: OwnerAppStorageGrant, input: { path: string; signal?: AbortSignal }): Promise<StorageDeleteResult>;
  beginUpload(ctx: OwnerAppStorageGrant, input: { path: string; contentType?: string; size: number; overwrite?: boolean; signal?: AbortSignal }): Promise<StorageUploadBeginResult>;
  uploadPart(ctx: OwnerAppStorageGrant, input: { uploadId: string; partNumber: number; content: { $type: "binary"; bytes: ArrayBuffer; mime?: string }; signal?: AbortSignal }): Promise<StorageUploadPartResult>;
  completeUpload(ctx: OwnerAppStorageGrant, input: { uploadId: string; signal?: AbortSignal }): Promise<StoragePutResult>;
  abortUpload(ctx: OwnerAppStorageGrant, input: { uploadId: string; signal?: AbortSignal }): Promise<StorageUploadAbortResult>;
}

export const STORAGE_RUNTIME_CONTROLLER_CAPABILITY = defineCapability<StorageRuntimeController>({
  kind: "local",
  id: "storage.runtime-controller",
  version: "1",
});
export const VAULT_LOCAL_SECRET_CAPABILITY = defineCapability<import("../vault.js").VaultLocalSecretService>({
  kind: "local",
  id: "vault.local-secret",
  version: "1",
});
