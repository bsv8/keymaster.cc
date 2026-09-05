// K-V、partition、commit 和 revision 契约。

/** K-V 引擎的硬限制；字段名和单位均在此集中定义。 */
export const STORAGE_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
export const STORAGE_PART_SIZE_BYTES = 16 * 1024 * 1024;
export const STORAGE_MAX_PARTS = 10_000;
export const STORAGE_DEFAULT_LIST_LIMIT = 200;
export const STORAGE_MAX_LIST_LIMIT = 1_000;
export const STORAGE_CURSOR_TTL_MS = 10 * 60 * 1000;
export const STORAGE_MAX_CURSORS_GLOBAL = 512;
export const STORAGE_MAX_CURSORS_PER_SESSION = 64;
export const STORAGE_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

/** JSON K-V 值；二进制值使用 Uint8Array，不做 Base64 放大。 */
export type KeyValueJson = null | boolean | number | string | KeyValueJson[] | { [key: string]: KeyValueJson };
export type KeyValueValue = KeyValueJson | Uint8Array;

/** K-V 读结果。revision 属于当前 App namespace 的单调版本。 */
export interface KeyValueEntry<T = KeyValueValue> {
  /** App 命名空间内的相对 K-V 键，不是物理对象路径。 */
  key: string;
  /** JSON 或原始二进制值。 */
  value: T;
  /** 产生该值的 partition revision。 */
  revision: number;
  /** 写入时间戳（毫秒）。 */
  updatedAt: number;
}

/** 不携带值的 K-V 元数据。 */
export interface KeyValueEntryMeta {
  /** App 命名空间内的相对 K-V 键。 */
  key: string;
  /** 新值所在的 revision。 */
  revision: number;
  /** 写入时间戳（毫秒）。 */
  updatedAt: number;
}

/** K-V 分页读取参数。 */
export interface KeyValueListInput {
  /** 可选的相对键前缀。 */
  prefix?: string;
  /** 由平台生成和解析的分页游标。 */
  cursor?: string;
  /** 每页数量。 */
  limit?: number;
  /** 读取哪个原子分区的快照。 */
  partition?: string;
}

/** K-V 分页读取结果。 */
export interface KeyValueListResult {
  /** 当前快照 revision。 */
  revision: number;
  /** 当前页 K-V 条目。 */
  entries: Array<KeyValueEntry>;
  /** 下一页游标。 */
  nextCursor?: string;
}

/** 单次 K-V 写入的乐观并发条件。 */
export interface KeyValueWriteCondition {
  /** 仅当当前值 revision 一致时写入；undefined 表示不限制。 */
  ifRevision?: number;
  /** 写入所属原子分区，默认 default。 */
  partition?: string;
}

/** 原子提交中的单条操作。 */
export type KeyValueCommitOperation =
  | { type: "put"; key: string; value: unknown }
  | { type: "delete"; key: string };

/** 同一 partition 的原子提交请求。 */
export interface KeyValueCommitInput {
  /** 需要一起原子发布的 K-V 集合。 */
  partition: string;
  /** 期望的当前 partition revision。 */
  ifRevision?: number;
  /** 原子提交操作。 */
  operations: KeyValueCommitOperation[];
}

/** 原子提交结果。 */
export interface KeyValueCommitResult {
  /** 新的 partition revision。 */
  revision: number;
  /** 不可变 commit 身份。 */
  commitId: string;
  /** 提交时间戳（毫秒）。 */
  committedAt: number;
}

/** 已绑定 bucket + owner + App 的受限 K-V 句柄。 */
export interface KeyValueStore {
  /** 抽象桶身份；只读，调用者不能替换。 */
  readonly bucketId: string;
  /** 打开句柄时的桶运行世代。 */
  readonly bucketGeneration: number;
  /** 当前 owner 的压缩公钥 hex。平台句柄为空字符串。 */
  readonly ownerPublicKeyHex: string;
  /** 平台验证后的 App 存储 ID。 */
  readonly applicationStorageId: string;
  /** 读取 K-V。 */
  get<T = KeyValueValue>(key: string, options?: { partition?: string }): Promise<KeyValueEntry<T> | undefined>;
  /** 分页列出 K-V；不会返回 `.keymaster/` 保留区。 */
  list(input?: KeyValueListInput): Promise<KeyValueListResult>;
  /** 写入单个 K-V，内部仍通过一次 commit 发布。 */
  put<T = KeyValueValue>(key: string, value: T, condition?: KeyValueWriteCondition): Promise<KeyValueEntryMeta>;
  /** 删除单个 K-V，内部仍通过一次 commit 发布。 */
  delete(key: string, condition?: KeyValueWriteCondition): Promise<void>;
  /** 在同一 partition 原子发布多个 put/delete。 */
  commit(input: KeyValueCommitInput): Promise<KeyValueCommitResult>;
  /** 关闭句柄；关闭后所有请求 fail closed。 */
  close(): void;
}
