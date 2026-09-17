// 远端 Keymaster namespace 的稳定根入口契约。

import type { StorageKeyDerivationV1 } from "./catalog.js";

/** 根 manifest 的固定路径；其它对象不能替代它宣告 namespace 已存在。 */
export const REMOTE_STORAGE_ROOT_MANIFEST_PATH = ".keymaster/root/v1";
/** 初始事务的固定路径前缀。 */
export const REMOTE_STORAGE_INITIALIZATION_TRANSACTION_PREFIX = ".keymaster/transactions/initialization/";
/** 初始化候选对象的固定路径前缀。 */
export const REMOTE_STORAGE_STAGING_PREFIX = ".keymaster/staging/";
/** Committed Hold head authenticated by the root manifest. */
export const REMOTE_STORAGE_HOLD_HEAD_PATH = ".keymaster/hold/v1/head.json";

export interface RemoteRootIntegrityV1 {
  algorithm: "hmac-sha-256";
  /** 对不含 integrity 字段的 canonical manifest 计算的 Base64URL HMAC。 */
  tagB64Url: string;
}

export interface RemoteRootHeadV1 {
  /** 当前 Hold/root head 的相对对象路径。 */
  path: string;
  /** 当前 head 的逻辑修订号。 */
  revision: number;
}

export interface RemoteRootSystemEntrypointsV1 {
  /** Hold 提交头入口。 */
  holdHeadPath: string;
}

/** 远端固定 namespace 的唯一身份和最小系统入口。 */
export interface RemoteStorageRootManifestV1 {
  format: "keymaster.remote-root";
  version: 1;
  remoteStorageId: string;
  namespaceVersion: 1;
  createdAt: number;
  /** 用密码派生 root HMAC key 的公开参数；不包含密码或派生密钥。 */
  keyDerivation: StorageKeyDerivationV1;
  rootHead: RemoteRootHeadV1;
  system: RemoteRootSystemEntrypointsV1;
  /** 发布根 manifest 的初始化事务；用于响应丢失后的同事务恢复。 */
  initializationTransactionId: string;
  integrity: RemoteRootIntegrityV1;
}

export function isRemoteRootManifest(value: unknown): value is RemoteStorageRootManifestV1 {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && (value as { format?: unknown }).format === "keymaster.remote-root"
    && (value as { version?: unknown }).version === 1);
}
