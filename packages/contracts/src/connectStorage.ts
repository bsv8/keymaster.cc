// Connect 文件 API 契约。
//
// 这里保留 Connect 的文件/Multipart wire shape；它与 platform-storage 的
// Provider、K-V 引擎和 OwnerAppStore 契约分离，Connect 调用方不能接触物理 Provider。

import type { BinaryField } from "./protocol.js";
import { STORAGE_PART_SIZE_BYTES, STORAGE_MAX_PARTS } from "./storage/kv.js";
import type { AppIdentitySnapshot } from "./appIdentity.js";

/** 已验证 Connect App 的 owner 访问授权。 */
export interface OwnerAppStorageGrant {
  /** Connect 会话 ID。 */
  connectSessionId: string;
  /** 发起请求的精确 Origin。 */
  transportOrigin: string;
  /** 装配层验证后的 App 身份。 */
  appIdentity: AppIdentitySnapshot;
  /** 当前统一抽象桶 ID。 */
  bucketId: string;
  /** 当前统一抽象桶世代；切桶后旧授权必须失效。 */
  bucketGeneration: number;
  /** 当前 Keymaster owner 公钥；不能使用 App 发布者公钥替代。 */
  ownerPublicKeyHex: string;
  /** 从验证后的 App 身份派生的稳定 App 存储 ID。 */
  applicationStorageId: string;
  /** 发放授权时的 Coordinator session 世代。 */
  sessionEpoch: string;
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
  /** Provider 版本标签。 */
  etag?: string;
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
  /** Provider 版本标签。 */
  etag?: string;
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
  /** 期望的 Provider 版本标签。 */
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
  /** Provider 版本标签。 */
  etag?: string;
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

export interface StorageUploadBeginParams {
  /** Connect 会话 ID。 */
  connectSessionId: string;
  /** 目标文件路径。 */
  path: string;
  /** MIME 类型。 */
  contentType?: string;
  /** 声明的文件大小（字节）。 */
  size: number;
  /** 是否覆盖已有对象。 */
  overwrite?: boolean;
}

export interface StorageUploadBeginResult {
  /** 逻辑上传 ID。 */
  uploadId: string;
  /** 固定分片大小（字节）。 */
  partSize: typeof STORAGE_PART_SIZE_BYTES;
  /** 最大分片数。 */
  maxParts: typeof STORAGE_MAX_PARTS;
}

export interface StorageUploadPartParams {
  /** Connect 会话 ID。 */
  connectSessionId: string;
  /** 逻辑上传 ID。 */
  uploadId: string;
  /** 从 1 开始的分片编号。 */
  partNumber: number;
  /** 分片二进制内容。 */
  content: BinaryField;
}

export interface StorageUploadPartResult {
  /** 逻辑上传 ID。 */
  uploadId: string;
  /** 分片编号。 */
  partNumber: number;
  /** 分片大小（字节）。 */
  size: number;
}

export interface StorageUploadCompleteParams {
  /** Connect 会话 ID。 */
  connectSessionId: string;
  /** 逻辑上传 ID。 */
  uploadId: string;
}

export interface StorageUploadAbortParams {
  /** Connect 会话 ID。 */
  connectSessionId: string;
  /** 逻辑上传 ID。 */
  uploadId: string;
}

export interface StorageUploadAbortResult {
  /** 逻辑上传 ID。 */
  uploadId: string;
  /** 固定成功标记。 */
  aborted: true;
}
