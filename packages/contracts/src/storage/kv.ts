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

function canonicalKeyValueJson(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("K-V value is not JSON serializable");
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || value instanceof Uint8Array) {
    throw new TypeError("K-V value is not JSON serializable");
  }
  if (seen.has(value)) throw new TypeError("K-V value is cyclic");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) throw new TypeError("K-V array is sparse");
        items.push(canonicalKeyValueJson(value[index], seen));
      }
      return `[${items.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("K-V value is not a JSON object");
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalKeyValueJson((value as Record<string, unknown>)[key], seen)}`);
    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

/** JSON 键序无关、Uint8Array 按字节比较的 K-V 语义身份。 */
export function keyValueSemanticFingerprint(value: unknown): string {
  if (value instanceof Uint8Array) {
    return `binary:${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  return `json:${canonicalKeyValueJson(value, new Set())}`;
}

/** 与语义身份相同的 canonical JSON 文本，供 unique-value-id 编码。 */
export function canonicalizeKeyValueJson(value: unknown): string {
  return canonicalKeyValueJson(value, new Set());
}

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
  /** 本次调用的操作身份；V1 不把 commit 对象持久化。 */
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
  /** owner 句柄的压缩公钥 hex；bucket 句柄没有 owner。 */
  readonly ownerPublicKeyHex?: string;
  /** 中央声明绑定的稳定模块身份。 */
  readonly moduleId: string;
  /** 中央声明绑定的稳定用途身份。 */
  readonly purposeId: string;
  /** 中央声明作用域。 */
  readonly scope: "bucket" | "owner";
  /** 中央声明授权主体。 */
  readonly authority: "platform-only" | "built-in-module" | "third-party-app";
  /** 中央声明数据模型；此句柄必须是 kv。 */
  readonly model: "kv";
  /** 中央声明 schema 版本。 */
  readonly schemaVersion: number;
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

/** Host-owned K-V view injected into plugins; lifecycle close remains with the Host. */
export type BorrowedKeyValueStore = Omit<KeyValueStore, "close">;
