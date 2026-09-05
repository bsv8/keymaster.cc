// 全局存储运行状态与平台运行时契约。
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

/** Provider 运行状态；由 Coordinator 统一发布。 */
export type StorageRuntimeStatus = "unselected" | "authentication" | "checking" | "ready" | "degraded" | "incompatible";

/** Storage 控制器对外状态。 */
export type StorageRuntimeControllerStatus = "unconfigured" | "locked" | "checking" | "ready" | "reconfiguring" | "degraded";

/** 稳定、脱敏的 Storage 错误分类。 */
export type StorageErrorCode =
  | "storage_not_configured" | "storage_unavailable" | "storage_invalid_path" | "storage_not_found"
  | "storage_conflict" | "storage_forbidden" | "storage_limit_exceeded" | "storage_invalid_upload"
  | "storage_provider_error" | "storage_identity_required";

/** 独立于 Vault 的运行时密文；用于封装 Provider 配置和 multipart ID。 */
export interface StorageSecretEnvelope {
  /** 当前本地密文协议版本。 */
  version: 2;
  /** 随机 salt，hex 编码。 */
  saltHex: string;
  /** 随机 nonce，hex 编码。 */
  nonceHex: string;
  /** AES-GCM 密文，hex 编码。 */
  ciphertextHex: string;
}

/** Storage Runtime 使用的独立密钥服务。 */
export interface StorageSecretService {
  seal(scope: string, plaintext: Uint8Array): Promise<StorageSecretEnvelope>;
  open(scope: string, sealed: StorageSecretEnvelope): Promise<Uint8Array>;
}

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
  /** Provider 配置世代。 */
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
export interface StorageProbeResult {
  /** 是否通过探测。 */
  ok: boolean;
  /** Provider 类型。 */
  providerId: StorageProviderId;
  /** 探测延迟（毫秒）。 */
  latencyMs: number;
  /** 脱敏诊断分类。 */
  diagnostic?: "configuration" | "authentication" | "forbidden" | "not-found" | "cors" | "network" | "provider";
}

/** 首次绑定 S3 桶的结果；绑定完成后不能再调用运行期 activateProvider。 */
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
  getProviderSummary(): Promise<StorageProviderSummary | null>;
  getProviderConnection(): Promise<StorageProviderConnectionView | null>;
  cancelProbe(): void;
  probeProvider(config: StorageProviderConfigDraft): Promise<StorageProbeResult>;
  /** 使用独立 Storage Profile 密码恢复已保存的 Provider 配置。 */
  unlockStorageProfile(password: string): Promise<StorageProbeResult>;
  /** 选择并验证本地 OPFS；成功后才允许创建平台根。 */
  selectOpfs(): Promise<StorageProbeResult>;
  /** 导入本机加密 Profile 并完成冷启动恢复。 */
  importStorageProfile(envelope: import("./profile.js").StorageProfileEnvelopeV1, password: string): Promise<StorageProbeResult>;
  getConditionalCapabilities(): BucketConditionalCapabilitiesView | null;
  probeConditionalCapabilities(signal?: AbortSignal): Promise<BucketConditionalCapabilityProbeResult>;
  activateProvider(config: StorageProviderConfigDraft): Promise<StorageActivationResult>;
  clearProviderConfig(): Promise<void>;
  resetStorage(): Promise<void>;
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

export const STORAGE_RUNTIME_CONTROLLER_CAPABILITY = "storage.runtime-controller";
export const VAULT_LOCAL_SECRET_CAPABILITY = "vault.local-secret";
