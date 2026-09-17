// owner 文件存储契约（model: "files"）。
//
// 一文件一对象：文件名与 JSON 内容由业务自己的格式规范定义（例如
// `contacts/address-book/<公钥>.json`、`p2pkh/<net>/tx/<txid>.json`）。
// 平台只提供三件事：
//   - 绑定 owner/module/purpose 的固定根路径（见 buildStorageNamespaceRoot）；
//   - 路径 guard：不许越出根、不许使用 `.keymaster` 保留段；
//   - Provider 原生条件写与失效栅栏。
// 文件之间没有索引、没有跨文件事务；并发覆盖按《存储规则》最后写入者胜。

import type { StorageBucketWriteCondition } from "./bucket.js";

/** 列表一页的默认上限。 */
export const OWNER_FILE_LIST_DEFAULT_LIMIT = 200;
/** 列表一页的硬上限。 */
export const OWNER_FILE_LIST_MAX_LIMIT = 1000;

/** 列表条目：只有元数据，不含内容。 */
export interface OwnerFileListEntry {
  /** 根下的相对路径，例如 `02ab….json` 或 `tx/<txid>.json`。 */
  path: string;
  /** 字节数（来自 Provider 元数据）；Provider 不提供时省略。 */
  size?: number;
  /** Provider ETag；不支持时省略。 */
  etag?: string;
  /** 最近修改时间，ISO-8601；Provider 不提供时省略。 */
  lastModified?: string;
}

/** 列表一页。 */
export interface OwnerFileListPage {
  files: OwnerFileListEntry[];
  /** 下一页游标；没有更多时省略。 */
  nextCursor?: string;
}

/** 单个文件。 */
export interface OwnerFileObject {
  /** 根下的相对路径。 */
  path: string;
  /** 文件字节；解析与格式校验由业务负责。 */
  bytes: Uint8Array;
  /** Provider ETag；不支持时省略。 */
  etag?: string;
  /** 最近修改时间，ISO-8601；Provider 不提供时省略。 */
  lastModified?: string;
}

/**
 * 已绑定 owner/module/purpose 的文件句柄。
 *
 * Provider、物理 bucket 与完整物理路径都不得暴露给业务调用方；这里
 * 出现的所有 `path` 都是模块根下的相对路径。
 */
export interface OwnerFileStore {
  /** 分页列出根下文件；`prefix` 是根下的相对前缀。 */
  list(input?: { prefix?: string; cursor?: string; limit?: number; signal?: AbortSignal }): Promise<OwnerFileListPage>;
  /** 读取单个文件；不存在返回 undefined。 */
  get(path: string, options?: { signal?: AbortSignal }): Promise<OwnerFileObject | undefined>;
  /** 写入（整文件替换）；支持原生条件写。 */
  put(
    path: string,
    bytes: Uint8Array,
    options?: StorageBucketWriteCondition & { signal?: AbortSignal },
  ): Promise<{ etag?: string; lastModified?: string }>;
  /** 删除单个文件；不存在视为成功。 */
  delete(path: string, options?: { signal?: AbortSignal; ifMatch?: string }): Promise<void>;
}

/** 插件/Host 借用的文件句柄；生命周期由 Host 拥有。 */
export type BorrowedOwnerFileStore = OwnerFileStore;
