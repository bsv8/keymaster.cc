import { deriveThirdPartyApplicationStorageId } from "../appIdentity.js";
import type { StorageBucketRef } from "./bucket.js";
import type { KeyValueStore } from "./kv.js";

/** App 存储声明的权限范围。普通插件不能声明 platform。 */
export type StorageScope = "key" | "platform";

/** 插件 manifest 对存储能力的自声明。 */
export interface PluginStorageDeclaration {
  /** key：限制到当前 owner；platform：仅平台装配层可授权。 */
  scope: StorageScope;
  /** 稳定的 App 存储目录 ID，例如 `Contacts`、`UTXOS`。 */
  applicationStorageId: string;
  /** 数据 schema 版本。 */
  schemaVersion: number;
}

/** 装配层发放的最终存储绑定。调用方不能修改这些字段。 */
export interface StorageNamespaceBinding extends PluginStorageDeclaration {
  /** 抽象桶身份，不是物理路径。 */
  bucketId: string;
  /** 当前桶运行世代。 */
  bucketGeneration: number;
  /** key scope 的当前 owner；platform scope 不应携带 owner。 */
  ownerPublicKeyHex?: string;
}

const STORAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}[A-Za-z0-9]$/u;
const PUBLIC_KEY_PATTERN = /^(02|03)[0-9a-f]{64}$/u;

/** 校验不会穿透 owner/App namespace 的业务存储 ID。 */
export function validateApplicationStorageId(applicationStorageId: string): string {
  if (
    typeof applicationStorageId !== "string" ||
    applicationStorageId.length > 63 ||
    !STORAGE_ID_PATTERN.test(applicationStorageId) ||
    applicationStorageId === ".keymaster" ||
    applicationStorageId.toLowerCase() === "keys"
  ) {
    throw new Error("applicationStorageId is invalid");
  }
  return applicationStorageId;
}

/** 校验平台根 ID；平台根允许专用的 `keys` 命名空间。 */
export function validatePlatformStorageId(applicationStorageId: string): string {
  if (
    typeof applicationStorageId !== "string" ||
    applicationStorageId.length > 63 ||
    !STORAGE_ID_PATTERN.test(applicationStorageId) ||
    applicationStorageId === ".keymaster"
  ) {
    throw new Error("platform storage ID is invalid");
  }
  return applicationStorageId;
}

/** 校验压缩公钥 owner 根。 */
export function validateOwnerPublicKeyHex(ownerPublicKeyHex: string): string {
  if (!PUBLIC_KEY_PATTERN.test(ownerPublicKeyHex)) throw new Error("ownerPublicKeyHex is invalid");
  return ownerPublicKeyHex.toLowerCase();
}

/** 校验并规范化一个 manifest 存储声明。 */
export function validatePluginStorageDeclaration(input: PluginStorageDeclaration): PluginStorageDeclaration {
  if (!input || (input.scope !== "key" && input.scope !== "platform")) {
    throw new Error("storage declaration scope is invalid");
  }
  const applicationStorageId = input.scope === "platform"
    ? validatePlatformStorageId(input.applicationStorageId)
    : validateApplicationStorageId(input.applicationStorageId);
  if (!Number.isSafeInteger(input.schemaVersion) || input.schemaVersion < 1) {
    throw new Error("storage declaration schemaVersion is invalid");
  }
  return { scope: input.scope, applicationStorageId, schemaVersion: input.schemaVersion };
}

/**
 * 由 verified identity 派生三方 App 的稳定目录 ID。
 * 这是唯一允许三方 App 得到 applicationStorageId 的入口。
 */
export { deriveThirdPartyApplicationStorageId };

/** 构造绑定后的物理 namespace 根；bucketId 由 Provider 绑定，不进入路径。 */
export function buildStorageNamespaceRoot(binding: StorageNamespaceBinding): string {
  const declaration = validatePluginStorageDeclaration(binding);
  if (typeof binding.bucketId !== "string" || binding.bucketId.length === 0 || binding.bucketId.includes("/")) {
    throw new Error("bucketId is invalid");
  }
  if (!Number.isSafeInteger(binding.bucketGeneration) || binding.bucketGeneration < 0) {
    throw new Error("bucketGeneration is invalid");
  }
  if (declaration.scope === "key") {
    if (!binding.ownerPublicKeyHex) throw new Error("key storage requires ownerPublicKeyHex");
    return `${validateOwnerPublicKeyHex(binding.ownerPublicKeyHex)}/${declaration.applicationStorageId}/`;
  }
  if (binding.ownerPublicKeyHex !== undefined) throw new Error("platform storage must not contain an owner");
  return `${declaration.applicationStorageId}/`;
}

/** 最终路径 guard：只允许 namespace 内的相对键，拒绝父目录和保留区。 */
export function assertStorageKeyInNamespace(root: string, key: string): void {
  if (typeof root !== "string" || !root.endsWith("/") || root.startsWith("/") || root.includes("//")) {
    throw new Error("storage namespace root is invalid");
  }
  if (typeof key !== "string" || key.length === 0 || key.startsWith("/") || key.includes("\\") || key.includes("\u0000")) {
    throw new Error("storage key is outside namespace");
  }
  if (!key.startsWith(root)) throw new Error("storage key is outside namespace");
  const relative = key.slice(root.length);
  if (
    relative.length === 0 ||
    relative.split("/").some((segment) => !segment || segment === "." || segment === "..") ||
    relative.split("/").includes(".keymaster")
  ) {
    throw new Error("storage key is outside namespace");
  }
}

/** 已绑定当前 owner 与业务 App 的受限存储句柄。 */
export interface OwnerAppStore extends KeyValueStore {}

/** 打开 owner/App 存储时唯一允许调用方提供的参数。 */
export interface OwnerAppStoreOpenInput {
  /** 业务 App 的稳定存储标识。 */
  applicationStorageId: string;
  /** 业务 schema 版本；不承载迁移回调。 */
  schemaVersion: number;
}

/** 一次 owner 重新导入/重新绑定后的桶级世代。 */
export interface OwnerStorageActivation {
  /** 同一公钥每次从 deleted 重新激活都会递增；旧句柄不能跨世代写入。 */
  generation: number;
}

/** 平台根只能访问此类受限 K-V；平台物理 Provider 不向业务传递。 */
export interface PlatformRootStore {
  /** 当前抽象桶。 */
  readonly bucket: StorageBucketRef;
  /**
   * 打开 owner/App 受限 K-V；owner 和 App ID 由装配层绑定。
   * keyspaceGeneration 只供 Coordinator 内部绑定世代，业务插件不能提供。
   */
  openKeyValueStore(input: { ownerPublicKeyHex: string; applicationStorageId: string; schemaVersion: number; keyspaceGeneration?: number }): Promise<OwnerAppStore>;
  /** 为新导入的 owner 建立/恢复桶级 active 记录；普通解锁不会调用此方法。 */
  activateOwnerStorage(input: { ownerPublicKeyHex: string }): Promise<OwnerStorageActivation>;
  /** 读取现有 owner 世代；缺失记录只初始化 active，不会复活 deleted owner。 */
  getOwnerStorageGeneration(input: { ownerPublicKeyHex: string }): Promise<number>;
  /** 在文件 API 等非 K-V 请求的物理 I/O 前后检查 owner 生命周期。 */
  assertOwnerStorageCurrent(input: { ownerPublicKeyHex: string; generation?: number }): Promise<void>;
  /** 删除指定 owner 根下全部 App 的 K-V；只由 Key 删除流程调用。 */
  deleteOwnerStorage(input: { ownerPublicKeyHex: string }): Promise<void>;
  /** 打开平台全局 K-V；只能由平台内部调用。 */
  openPlatformStore(input: { applicationStorageId: string; schemaVersion: number }): Promise<KeyValueStore>;
  /** 专用 keys/ 根；不会把 `keys` 再拼成 `keys/keys/`。 */
  openPlatformKeysStore(schemaVersion: number): Promise<KeyValueStore>;
}
