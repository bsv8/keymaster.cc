// Connect 文件 API 契约。
//
// 这里保留 Connect 的文件 wire shape；它与 platform-storage 的本地引擎、
// K-V 引擎和受限句柄契约分离，Connect 调用方不能接触物理路径或数据库。
//
// S3 multipart 已随远程存储体系一起移除：纯本地介质没有分片续传语义，
// 一次性 put 已经是完整写入。大文件调用方改用分多次 put 或自带业务传输。

import type { BinaryField } from "./protocol.js";
import type { AppIdentitySnapshot } from "./appIdentity.js";

/** 已验证 Connect App 的 owner 访问授权。 */
export interface OwnerAppStorageGrant {
  /** Connect 会话 ID。 */
  connectSessionId: string;
  /** 发起请求的精确 Origin。 */
  transportOrigin: string;
  /** 装配层验证后的 App 身份。 */
  appIdentity: AppIdentitySnapshot;
  /** 平台登记并规范化后的稳定存储名称；决定该 App 的独立目录。 */
  appStorageName: string;
  /** 从验证后的 App 身份派生的稳定中央 moduleId。 */
  moduleId: string;
  /** Connect 文件 namespace 的固定用途坐标。 */
  purposeId: "files";
  /** 发放授权时的 Coordinator session 世代。 */
  sessionEpoch: string;
  /** 发放授权时的钱包身份世代；重置后旧授权永久失效。 */
  walletGeneration: string;
  /** 发放授权时的 Worker 运行世代。 */
  runGeneration: string;
}

export interface StorageListParams {
  /** Connect 会话 ID。 */
  connectSessionId: string;
  /** 目录前缀。 */
  prefix?: string;
  /** 分页游标。 */
  cursor?: string;
  /** 每页数量。 */
  limit?: number;
}

export interface StorageListEntry {
  /** Connect 可见的相对路径。 */
  path: string;
  /** 当前目录下的文件名。 */
  name: string;
  /** 文件大小（字节）。 */
  size: number;
  /** 抽象版本标签。 */
  revision?: string;
  /** 最后修改时间。 */
  lastModified?: string;
}

export interface StorageListResult {
  /** 当前目录前缀。 */
  prefix: string;
  /** 父目录前缀。 */
  parentPrefix: string;
  /** 虚拟目录列表。 */
  directories: Array<{ path: string; name: string }>;
  /** 当前页文件。 */
  files: StorageListEntry[];
  /** 目录 marker 路径。 */
  markerPath?: string;
  /** 下一页游标。 */
  nextCursor?: string;
}

export interface StorageDirectoryParams {
  /** Connect 会话 ID。 */
  connectSessionId: string;
  /** 目录路径。 */
  path: string;
  /** 是否允许覆盖已有 marker。 */
  overwrite?: boolean;
}

export interface StorageDirectoryResult {
  /** 目录路径。 */
  path: string;
  /** 是否创建。 */
  created?: boolean;
  /** 是否删除。 */
  deleted?: boolean;
}

export interface StoragePutParams {
  /** Connect 会话 ID。 */
  connectSessionId: string;
  /** 文件路径。 */
  path: string;
  /** 二进制文件内容。 */
  content: BinaryField;
  /** MIME 类型。 */
  contentType?: string;
  /** 是否覆盖已有对象。 */
  overwrite?: boolean;
}

export interface StoragePutResult {
  /** 文件路径。 */
  path: string;
  /** 写入大小（字节）。 */
  size: number;
  /** 抽象版本标签。 */
  revision?: string;
  /** 写入时间戳（毫秒）。 */
  updatedAt: number;
}

export interface StorageGetParams {
  /** Connect 会话 ID。 */
  connectSessionId: string;
  /** 文件路径。 */
  path: string;
  /** 起始偏移（字节）。 */
  offset?: number;
  /** 读取长度（字节）。 */
  length?: number;
  /** 期望的抽象版本标签。 */
  ifMatch?: string;
}

export interface StorageGetResult {
  /** 文件路径。 */
  path: string;
  /** 二进制内容。 */
  content: BinaryField;
  /** MIME 类型。 */
  contentType?: string;
  /** 实际起始偏移。 */
  offset: number;
  /** 文件总大小（字节）。 */
  totalSize: number;
  /** 是否已读到文件结尾。 */
  eof: boolean;
  /** 抽象版本标签。 */
  revision?: string;
  /** 最后修改时间。 */
  lastModified?: string;
}

export interface StorageDeleteParams {
  /** Connect 会话 ID。 */
  connectSessionId: string;
  /** 文件路径。 */
  path: string;
}

export interface StorageDeleteResult {
  /** 文件路径。 */
  path: string;
  /** 固定成功标记。 */
  deleted: true;
  /** 删除时间戳（毫秒）。 */
  updatedAt: number;
}
