// 统一抽象桶启动控制器：OPFS/S3 只能二选一，并在通过探测后创建一个桶引用。
import type { NormalizedStorageProviderConfig, StorageBootstrapState, StorageBucketProvider, StorageBucketRef, StorageRuntimeStatus } from "@keymaster/contracts";
import { createOpfsBucketProvider, type OpfsBucketProviderOptions } from "../bucket-providers/opfs/opfsBucketObjectStore.js";
import { createS3BucketProvider, type S3BucketProviderOptions } from "../bucket-providers/s3/s3BucketProvider.js";
import { createLocalStorageBucketProvider, type LocalStorageBucketProviderOptions } from "../bucket-providers/local/localStorageBucketProvider.js";
import { decryptStorageProfile } from "./storageProfileRepository.js";
import { StorageHealthController, type StorageHealthSnapshot } from "../runtime/storageHealthController.js";
import { decryptBucketConfig, deriveBucketCryptoContext } from "../hold/keymasterHoldAdapter.js";
import { StorageRuntimeError } from "../runtime/storageRuntimeError.js";

export interface StorageBootstrapControllerOptions {
  /** 页面通过 hello 传入的本机启动状态；Worker 不直接读取 localStorage。 */
  state: StorageBootstrapState | null;
  opfs?: OpfsBucketProviderOptions;
  local?: Omit<LocalStorageBucketProviderOptions, "bucketId">;
  s3?: S3BucketProviderOptions;
  generation?: number;
  /** Coordinator 全局唯一健康控制器；未注入时仅用于独立单测。 */
  health?: StorageHealthController;
  /** Provider 成功后完成 Coordinator-owned Root/Journal/任务恢复。 */
  afterProviderReady?: () => Promise<void>;
  /** 冷启动时交由上层完成应用装配后再发布 ready。 */
  deferReady?: boolean;
}

export interface StorageBootstrapResult extends StorageHealthSnapshot {
  provider?: StorageBucketProvider;
  bucket?: StorageBucketRef;
}

export class StorageBootstrapController {
  private readonly health: StorageHealthController;
  private readonly ownsHealth: boolean;
  private provider?: StorageBucketProvider;
  private bucket?: StorageBucketRef;
  private readonly generation: number;

  constructor(private readonly options: StorageBootstrapControllerOptions) { this.generation = options.generation ?? 1; this.ownsHealth = !options.health; this.health = options.health ?? new StorageHealthController(); }
  status(): StorageRuntimeStatus { return this.health.status(); }
  snapshot(): StorageHealthSnapshot { return this.health.snapshot(); }

  async bootstrap(profilePassword?: string): Promise<StorageBootstrapResult> {
    const state = this.options.state;
    const backend = state?.selectedBackend;
    if (!backend) {
      this.health.setStatus("unselected", "Storage backend has not been selected");
      return this.result();
    }
    if (backend === "s3" && !state?.selectedBucket && !state?.encryptedStorageProfileEnvelope) {
      this.health.setStatus("unselected", "S3 Storage Profile is not selected");
      return this.result();
    }
    if (backend === "s3" && !state?.selectedBucket && !profilePassword) {
      this.health.setStatus("authentication", "Storage Profile password is required");
      return this.result();
    }
    // 新版桶目录已经在“测试 → 保存”阶段完成连接测试。启动时只恢复
    // 已选桶并让后续真实 Root 读写报告错误，不再重复执行健康探测。
    if (state?.selectedBucket) {
      const provider = await this.createCatalogProvider(state.selectedBucket, profilePassword);
      try {
        this.health.setStatus("checking");
        this.provider = provider;
        this.bucket = Object.freeze({ bucketId: provider.bucketId, bucketGeneration: this.generation, provider: backend });
        await this.options.afterProviderReady?.();
        if (!this.options.deferReady) this.health.setStatus("ready");
      } catch (error) {
        provider.dispose();
        this.provider = undefined;
        this.bucket = undefined;
        this.health.setStatus("degraded", error instanceof Error ? error.message : String(error));
        throw error;
      }
      return this.result();
    }
    const result = await this.health.probe(async () => {
      const provider = backend === "s3"
        ? createS3BucketProvider(await decryptStorageProfile(state!.encryptedStorageProfileEnvelope!, profilePassword!), this.options.s3)
        : backend === "local"
          ? createLocalStorageBucketProvider({ ...this.options.local, bucketId: state?.selectedProfileId ?? "local-default" })
          : createOpfsBucketProvider(this.options.opfs);
      try {
        const probe = await provider.probe();
        if (!probe.ok || probe.conditionalWrites !== "native") throw Object.assign(new Error("Storage bucket does not support required conditional writes"), { code: "storage_provider_error" });
        this.provider?.dispose();
        this.provider = provider;
        this.bucket = Object.freeze({ bucketId: provider.bucketId, bucketGeneration: this.generation, provider: backend });
      } catch (error) {
        provider.dispose();
        throw error;
      }
    }, this.options.afterProviderReady, { publishReady: !this.options.deferReady });
    return this.result(result);
  }

  getProvider(): StorageBucketProvider | undefined { return this.provider; }
  getBucket(): StorageBucketRef | undefined { return this.bucket; }
  dispose(): void { if (this.ownsHealth) this.health.dispose(); this.provider?.dispose(); this.provider = undefined; this.bucket = undefined; }
  private result(snapshot = this.health.snapshot()): StorageBootstrapResult { return { ...snapshot, ...(this.provider ? { provider: this.provider } : {}), ...(this.bucket ? { bucket: this.bucket } : {}) }; }

  private async createCatalogProvider(entry: NonNullable<StorageBootstrapState["selectedBucket"]>, password?: string): Promise<StorageBucketProvider> {
    if (entry.backend === "local") {
      return createLocalStorageBucketProvider({ ...this.options.local, bucketId: entry.bucketId });
    }
    if (!password) throw new StorageRuntimeError("storage_identity_required", "Bucket password is required");
    const context = await deriveBucketCryptoContext(password, entry.keyDerivation);
    try {
      const config = await decryptBucketConfig(entry.encryptedConfig, context);
      if (config.kind !== "s3") throw new StorageRuntimeError("storage_provider_error", "S3 bucket configuration is invalid");
      const normalized: NormalizedStorageProviderConfig = {
        version: 1,
        providerId: "s3-compatible",
        connection: {
          endpoint: config.endpoint,
          region: config.region,
          bucket: config.bucket,
          forcePathStyle: config.forcePathStyle === true,
          ...(config.sessionToken === undefined ? {} : { sessionToken: config.sessionToken }),
          ...(config.prefix === undefined ? {} : { prefix: config.prefix })
        },
        credentials: { kind: "access-key", accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }
      };
      return createS3BucketProvider(normalized, { bucketId: entry.bucketId });
    } finally {
      context.dispose();
    }
  }
}
