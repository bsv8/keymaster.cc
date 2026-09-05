// 统一抽象桶启动控制器：OPFS/S3 只能二选一，并在通过探测后创建一个桶引用。
import type { StorageBootstrapState, StorageBucketProvider, StorageBucketRef, StorageRuntimeStatus } from "@keymaster/contracts";
import { createOpfsBucketProvider, type OpfsBucketProviderOptions } from "../bucket-providers/opfs/opfsBucketObjectStore.js";
import { createS3BucketProvider, type S3BucketProviderOptions } from "../bucket-providers/s3/s3BucketProvider.js";
import { decryptStorageProfile } from "./storageProfileRepository.js";
import { StorageHealthController, type StorageHealthSnapshot } from "../runtime/storageHealthController.js";

export interface StorageBootstrapControllerOptions {
  /** 页面通过 hello 传入的本机启动状态；Worker 不直接读取 localStorage。 */
  state: StorageBootstrapState | null;
  opfs?: OpfsBucketProviderOptions;
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
    if (backend === "s3" && !state?.encryptedStorageProfileEnvelope) {
      this.health.setStatus("unselected", "S3 Storage Profile is not selected");
      return this.result();
    }
    if (backend === "s3" && !profilePassword) {
      this.health.setStatus("authentication", "Storage Profile password is required");
      return this.result();
    }
    const result = await this.health.probe(async () => {
      const provider = backend === "s3"
        ? createS3BucketProvider(await decryptStorageProfile(state!.encryptedStorageProfileEnvelope!, profilePassword!), this.options.s3)
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
}
