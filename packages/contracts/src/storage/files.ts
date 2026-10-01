// 模块文件存储契约（model: "files"）。
//
// 一文件一对象：文件名与 JSON 内容由业务自己的格式规范定义（例如
// `contacts/<稳定业务ID>.json`、`p2pkh/<net>/tx/<txid>.json`）。
// 平台只提供三件事：
//   - 绑定当前身份世代与模块/App 目录的固定根（见 buildStorageNamespaceRoot）；
//   - 路径 guard：不许越出根、不许使用系统保留段；
//   - 本地事务内的条件写与失效栅栏。
// 文件之间没有索引、没有跨文件事务；并发覆盖按《存储规则》最后写入者胜。

/** 列表一页的默认上限。 */
export const MODULE_FILE_LIST_DEFAULT_LIMIT = 200;
/** 列表一页的硬上限。 */
export const MODULE_FILE_LIST_MAX_LIMIT = 1000;

/** 抽象版本标签。
 *
 * IndexedDB 不提供 ETag，这里用本地对象 revision 承担同一职责：内容哈希不能
 * 替代运行世代校验，所以标签只是并发检测的一部分。
 */
export type StorageObjectRevision = string;

/** 列表条目：只有元数据，不含内容。 */
export interface ModuleFileListEntry {
  /** 根下的相对路径，例如 `<稳定业务ID>.json` 或 `tx/<txid>.json`。 */
  path: string;
  /** 字节数。 */
  size: number;
  /** 抽象版本标签。 */
  revision: StorageObjectRevision;
  /** 最近修改时间，ISO-8601。 */
  lastModified: string;
}

/** 列表一页。 */
export interface ModuleFileListPage {
  files: ModuleFileListEntry[];
  /** 下一页游标；没有更多时省略。 */
  nextCursor?: string;
}

/** 单个文件。 */
export interface ModuleFileObject {
  /** 根下的相对路径。 */
  path: string;
  /** 文件字节；解析与格式校验由业务负责。 */
  bytes: Uint8Array;
  /** 抽象版本标签。 */
  revision: StorageObjectRevision;
  /** 最近修改时间，ISO-8601。 */
  lastModified: string;
}

/** 固定对象的条件写。 */
export interface StorageWriteCondition {
  /** 仅当目标 revision 等于该值时替换。 */
  ifRevision?: StorageObjectRevision;
  /** 仅当目标不存在时创建。 */
  ifNoneMatch?: true;
}

/** 写入结果。 */
export interface ModuleFileWriteResult {
  revision: StorageObjectRevision;
  lastModified: string;
}

/**
 * 已绑定身份世代与模块根（或 App 目录）的文件句柄。
 *
 * 数据库连接、物理路径和完整对象键都不得暴露给业务调用方；这里出现的所有
 * `path` 都是已绑定根下的相对路径。
 */
export interface ModuleFileStore {
  /** 打开句柄时的钱包身份世代。 */
  readonly walletGeneration: string;
  /** 打开句柄时的会话世代。 */
  readonly sessionEpoch: string;
  /** 打开句柄时的 Worker 运行世代。 */
  readonly runGeneration: string;
  /** 分页列出根下文件；`prefix` 是根下的相对前缀。 */
  list(input?: { prefix?: string; cursor?: string; limit?: number; signal?: AbortSignal }): Promise<ModuleFileListPage>;
  /** 读取单个文件；不存在返回 undefined。 */
  get(path: string, options?: { ifRevision?: StorageObjectRevision; signal?: AbortSignal }): Promise<ModuleFileObject | undefined>;
  /** 按偏移与长度读取一段字节，供流式读取使用。 */
  getRange(
    path: string,
    range: { offset: number; length: number },
    options?: { ifRevision?: StorageObjectRevision; signal?: AbortSignal },
  ): Promise<ModuleFileObject | undefined>;
  /** 写入（整文件替换）；支持原生条件写。 */
  put(
    path: string,
    bytes: Uint8Array,
    options?: StorageWriteCondition & { contentType?: string; signal?: AbortSignal },
  ): Promise<ModuleFileWriteResult>;
  /** 删除单个文件；不存在视为成功。 */
  delete(path: string, options?: { ifRevision?: StorageObjectRevision; signal?: AbortSignal }): Promise<void>;
  /** 在同一事务内原子提交多个 put/delete；任一条件不满足则整体失败。 */
  batch(input: {
    operations: Array<{ type: "put"; path: string; bytes: Uint8Array; contentType?: string } | { type: "delete"; path: string }>;
    conditions?: Array<{ path: string; ifRevision?: StorageObjectRevision; ifNoneMatch?: true }>;
  }, options?: { signal?: AbortSignal }): Promise<{ paths: string[]; committedAt: string }>;
  /** 关闭句柄；关闭后所有请求 fail closed。 */
  close(): void;
}

/** 插件/Host 借用的文件句柄；生命周期由 Host 拥有。 */
export type BorrowedModuleFileStore = Omit<ModuleFileStore, "close">;

/** @deprecated 使用 {@link ModuleFileStore}。 */
export type OwnerFileStore = ModuleFileStore;
/** @deprecated 使用 {@link BorrowedModuleFileStore}。 */
export type BorrowedOwnerFileStore = BorrowedModuleFileStore;
/** @deprecated 使用 {@link ModuleFileListEntry}。 */
export type OwnerFileListEntry = ModuleFileListEntry;
/** @deprecated 使用 {@link ModuleFileListPage}。 */
export type OwnerFileListPage = ModuleFileListPage;
/** @deprecated 使用 {@link ModuleFileObject}。 */
export type OwnerFileObject = ModuleFileObject;
/** @deprecated 使用 {@link MODULE_FILE_LIST_DEFAULT_LIMIT}。 */
export const OWNER_FILE_LIST_DEFAULT_LIMIT = MODULE_FILE_LIST_DEFAULT_LIMIT;
/** @deprecated 使用 {@link MODULE_FILE_LIST_MAX_LIMIT}。 */
export const OWNER_FILE_LIST_MAX_LIMIT = MODULE_FILE_LIST_MAX_LIMIT;
