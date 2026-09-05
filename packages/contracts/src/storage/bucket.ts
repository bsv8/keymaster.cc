// 抽象桶 Provider 契约：OPFS 与 S3 只在这一层对外呈现统一对象接口。

/** 统一存储支持的物理 Provider 类型。 */
export type StorageBucketProviderId = "opfs" | "s3";

/** 抽象桶身份，不是 S3 bucket name，也不是 OPFS 物理目录名。 */
export interface StorageBucketRef {
  /** 抽象桶身份，由 Keymaster 分配或从 Profile 恢复。 */
  bucketId: string;
  /** 当前选中桶的运行世代；切桶后旧请求必须失效。 */
  bucketGeneration: number;
  /** Provider 类型。 */
  provider: StorageBucketProviderId;
}

/** Provider 探测结果；通过后才能把桶状态提升为 ready。 */
export interface StorageBucketProbeResult {
  /** 是否通过全部必需探测。 */
  ok: boolean;
  /** 是否支持原生条件写；不支持时系统桶不能激活。 */
  conditionalWrites: "native" | "unsupported";
  /** 探测延迟（毫秒）。 */
  latencyMs: number;
  /** 脱敏诊断分类。 */
  diagnostic?: "configuration" | "authentication" | "forbidden" | "not-found" | "cors" | "network" | "provider";
  /** 可选 quota 摘要，不包含凭据或物理路径。 */
  quota?: { usageBytes?: number; quotaBytes?: number };
}

/** Provider 层的对象元数据；Provider 只处理 bytes，不理解业务 K-V。 */
export interface StorageBucketObject {
  /** 桶内相对物理路径；不会向 App 层暴露。 */
  path: string;
  /** 对象字节数；list 可以只返回元数据而不返回 bytes。 */
  size?: number;
  /** 对象内容。 */
  bytes: Uint8Array;
  /** Provider 返回的版本标签或 ETag。 */
  etag?: string;
  /** Provider 返回的最后修改时间。 */
  lastModified?: string;
}

/** Provider list 的一页结果。 */
export interface StorageBucketListPage {
  /** 当前页对象，按 path 升序。 */
  objects: StorageBucketObject[];
  /** 下一页游标；undefined 表示结束。 */
  nextCursor?: string;
}

/** Provider 条件写选项。 */
export interface StorageBucketWriteCondition {
  /** 仅当目标 ETag 等于该值时替换。 */
  ifMatch?: string;
  /** 仅当目标不存在时创建。 */
  ifNoneMatch?: "*";
}

/** Provider 层最小契约；只有 Storage Runtime 可以持有它。 */
export interface StorageBucketProvider {
  /** Provider 类型。 */
  readonly provider: StorageBucketProviderId;
  /** 抽象桶身份，不是物理 bucket name。 */
  readonly bucketId: string;
  /** 验证读写、条件写和 quota 的能力。 */
  probe(signal?: AbortSignal): Promise<StorageBucketProbeResult>;
  /** 读取桶内对象；不存在时返回 undefined。 */
  get(path: string, options?: { signal?: AbortSignal; ifMatch?: string }): Promise<StorageBucketObject | undefined>;
  /** 分页列出桶内对象。 */
  list(input?: { prefix?: string; cursor?: string; limit?: number; signal?: AbortSignal }): Promise<StorageBucketListPage>;
  /** 写入对象，支持原生 CAS。 */
  put(path: string, bytes: Uint8Array, condition?: StorageBucketWriteCondition & { signal?: AbortSignal }): Promise<{ etag?: string; lastModified?: string }>;
  /** 删除对象。 */
  delete(path: string, options?: { signal?: AbortSignal; ifMatch?: string }): Promise<void>;
  /** 释放 Provider 资源。 */
  dispose(): void;
}
