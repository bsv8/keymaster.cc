import { deriveThirdPartyStorageModuleId } from "../appIdentity.js";
import type { StorageBucketRef } from "./bucket.js";
import type { KeyValueStore } from "./kv.js";
import type { SnapshotStore, StorageSnapshotJsonCompatible } from "./snapshot.js";

/**
 * 中央存储声明的物理作用域。
 *
 * `bucket` 是桶级、与 owner 无关的系统数据；`owner` 必须绑定当前
 * active owner。调用方不能把 scope 当成路径或自由选择的权限。
 */
export type StorageScope = "bucket" | "owner";

/** 中央存储声明的授权主体。 */
export type StorageAuthority = "platform-only" | "built-in-module" | "third-party-app";

/** 中央存储声明的数据模型。 */
export type StorageModel = "snapshot" | "kv" | "files";

/**
 * Host/Coordinator 使用的 V1 中央存储声明。
 *
 * 这是逻辑身份，不是物理目录名。moduleId + purposeId 是稳定的业务
 * 坐标；bucket、owner、authority 和 model 由平台在绑定时一起校验。
 */
export interface PluginStorageDeclaration {
  /** 稳定模块身份，例如 `coordinator`、`p2pkh` 或派生的第三方 App UUID。 */
  moduleId: string;
  /** 模块内稳定用途，例如 `selection`、`settings` 或 `state`。 */
  purposeId: string;
  /** bucket：桶级；owner：当前 owner 级。 */
  scope: StorageScope;
  /** 平台专属、内置模块或已验证第三方 App。 */
  authority: StorageAuthority;
  /** 固定单对象快照或 unique-value-id K-V。 */
  model: StorageModel;
  /** 当前数据 schema 版本；V1 不提供迁移回退。 */
  schemaVersion: number;
}

/** 装配层发放的最终存储绑定；调用方不能修改这些字段。 */
export interface StorageNamespaceBinding extends PluginStorageDeclaration {
  /** 抽象桶身份，不是物理路径。 */
  bucketId: string;
  /** 当前桶运行世代；切桶后旧绑定必须失效。 */
  bucketGeneration: number;
  /** owner 作用域的当前压缩公钥；bucket 作用域不得携带 owner。 */
  ownerPublicKeyHex?: string;
  /**
   * 三方 App 身份作用域：app settings 等 Keymaster 管理的文件落在
   * `<owner>/app.<publisherPublicKeyHex>/`；只有 model "files" 允许。
   */
  appPublisherPublicKeyHex?: string;
}

const STORAGE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/u;
const PUBLIC_KEY_PATTERN = /^(02|03)[0-9a-f]{64}$/u;

function validateStableId(value: string, field: "moduleId" | "purposeId"): string {
  if (typeof value !== "string" || value.length > 63 || !STORAGE_ID_PATTERN.test(value)) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

/** 校验稳定模块身份。 */
export function validateStorageModuleId(moduleId: string): string {
  return validateStableId(moduleId, "moduleId");
}

/** 校验稳定用途身份。 */
export function validateStoragePurposeId(purposeId: string): string {
  return validateStableId(purposeId, "purposeId");
}

/** 校验压缩公钥 owner 根。 */
export function validateOwnerPublicKeyHex(ownerPublicKeyHex: string): string {
  if (typeof ownerPublicKeyHex !== "string" || !PUBLIC_KEY_PATTERN.test(ownerPublicKeyHex)) {
    throw new Error("ownerPublicKeyHex is invalid");
  }
  return ownerPublicKeyHex.toLowerCase();
}

/** 校验并规范化一个中央存储声明。 */
export function validatePluginStorageDeclaration(input: PluginStorageDeclaration): PluginStorageDeclaration {
  if (!input || (input.scope !== "bucket" && input.scope !== "owner")) {
    throw new Error("storage declaration scope is invalid");
  }
  if (input.authority !== "platform-only" && input.authority !== "built-in-module" && input.authority !== "third-party-app") {
    throw new Error("storage declaration authority is invalid");
  }
  if (input.model !== "snapshot" && input.model !== "kv" && input.model !== "files") {
    throw new Error("storage declaration model is invalid");
  }
  const moduleId = validateStorageModuleId(input.moduleId);
  // files 模型允许空 purposeId,表示"模块根"(例如 <owner>/p2pkh/)；
  // kv/snapshot 仍必须有具体 purpose 段。
  if (input.model === "files" && input.purposeId === "") {
    // 跳过 purpose 校验,保留空串。
  }
  const purposeId = input.purposeId === "" && input.model === "files" ? "" : validateStoragePurposeId(input.purposeId);
  if (!Number.isSafeInteger(input.schemaVersion) || input.schemaVersion < 1) {
    throw new Error("storage declaration schemaVersion is invalid");
  }
  if (input.scope === "bucket" && input.authority === "third-party-app") {
    throw new Error("bucket storage cannot use third-party-app authority");
  }
  if (input.scope === "owner" && input.authority === "platform-only") {
    throw new Error("owner storage cannot use platform-only authority");
  }
  if (input.model === "files" && input.scope !== "owner") {
    throw new Error("file storage must use owner scope");
  }
  return { moduleId, purposeId, scope: input.scope, authority: input.authority, model: input.model, schemaVersion: input.schemaVersion };
}

/**
 * 由 verified identity 派生三方 App 的稳定模块身份。
 *
 * 这是三方 App 唯一可用的 moduleId 来源；caller 不能在 grant 中自报
 * 另一个 moduleId、owner 或 bucket。
 */
export { deriveThirdPartyStorageModuleId };

/** 中央 path planner 使用的 owner 模块根；文件 API 也必须复用这一坐标。 */
export function buildOwnerStorageModuleRoot(input: {
  ownerPublicKeyHex: string;
  moduleId: string;
  purposeId: string;
}): string {
  return `${validateOwnerPublicKeyHex(input.ownerPublicKeyHex)}/.keymaster/modules/${validateStorageModuleId(input.moduleId)}/${validateStoragePurposeId(input.purposeId)}/`;
}

/**
 * `model: "files"` 的 owner 模块根：`<owner>/<moduleId>/<purposeId>/`。
 *
 * purposeId 为空串时表示"模块根"：`<owner>/<moduleId>/`（p2pkh 这类
 * 整个模块共享一个目录的格式）。文件模型按 KeymasterFormats 的扁平
 * 布局直接落在 owner 下；K-V 模型继续使用 `.keymaster/modules/…`。
 */
export function buildOwnerStorageFileRoot(input: {
  ownerPublicKeyHex: string;
  moduleId: string;
  purposeId: string;
}): string {
  const owner = validateOwnerPublicKeyHex(input.ownerPublicKeyHex);
  const moduleId = validateStorageModuleId(input.moduleId);
  if (input.purposeId === "") return `${owner}/${moduleId}/`;
  return `${owner}/${moduleId}/${validateStoragePurposeId(input.purposeId)}/`;
}

/**
 * 三方 App 的 Keymaster 管理文件根：`<owner>/app.<publisherPublicKeyHex>/`。
 *
 * `settings.json` 由 Keymaster 读写；`storage/` 留给 App 自己（见
 * KeymasterFormats 的 app.publickeyhex 目录）。publisher 公钥必须是
 * 33 字节压缩公钥的小写 hex。
 */
export function buildOwnerAppPublisherRoot(input: {
  ownerPublicKeyHex: string;
  appPublisherPublicKeyHex: string;
}): string {
  return `${validateOwnerPublicKeyHex(input.ownerPublicKeyHex)}/app.${validateOwnerPublicKeyHex(input.appPublisherPublicKeyHex)}/`;
}

/** 构造绑定后的逻辑 namespace 根；Provider 仍由 Coordinator 私有持有。 */
export function buildStorageNamespaceRoot(binding: StorageNamespaceBinding): string {
  const declaration = validatePluginStorageDeclaration(binding);
  if (typeof binding.bucketId !== "string" || binding.bucketId.length === 0 || binding.bucketId.includes("/")) {
    throw new Error("bucketId is invalid");
  }
  if (!Number.isSafeInteger(binding.bucketGeneration) || binding.bucketGeneration < 0) {
    throw new Error("bucketGeneration is invalid");
  }
  if (declaration.scope === "owner") {
    if (!binding.ownerPublicKeyHex) throw new Error("owner storage requires ownerPublicKeyHex");
    // 三方 App 身份根优先于模块/用途根；只有文件模型允许携带 publisher。
    if (binding.appPublisherPublicKeyHex !== undefined) {
      if (declaration.model !== "files") throw new Error("app publisher storage requires the files model");
      return buildOwnerAppPublisherRoot({
        ownerPublicKeyHex: binding.ownerPublicKeyHex,
        appPublisherPublicKeyHex: binding.appPublisherPublicKeyHex,
      });
    }
    // 文件模型直接落在 owner 下（KeymasterFormats 扁平布局）；K-V/snapshot
    // 模型继续使用 `.keymaster/modules` 保留区。
    if (declaration.model === "files") {
      return buildOwnerStorageFileRoot({
        ownerPublicKeyHex: binding.ownerPublicKeyHex,
        moduleId: declaration.moduleId,
        purposeId: declaration.purposeId,
      });
    }
    return buildOwnerStorageModuleRoot({ ownerPublicKeyHex: binding.ownerPublicKeyHex, moduleId: declaration.moduleId, purposeId: declaration.purposeId });
  }
  if (binding.ownerPublicKeyHex !== undefined) throw new Error("bucket storage must not contain an owner");
  // 系统对象的固定路径由 moduleId + purposeId 决定，绝不接受调用方传入
  // 任意 physical path。K-V engine 会在此根下继续使用 heads/values。
  return `.keymaster/system/${declaration.moduleId}/${declaration.purposeId}/`;
}

/** 固定 snapshot 对象的逻辑路径；只有平台实现使用此函数执行 Provider I/O。 */
export function buildStorageSnapshotPath(binding: StorageNamespaceBinding): string {
  return `${buildStorageNamespaceRoot(binding)}current`;
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
    relative.length === 0
    || relative.split("/").some((segment) => !segment || segment === "." || segment === "..")
    || relative.split("/").includes(".keymaster")
  ) {
    throw new Error("storage key is outside namespace");
  }
}

/** 已绑定当前 owner 与内置/三方模块的受限 K-V 句柄。 */
export interface OwnerAppStore extends KeyValueStore {}

/** 平台根存储权威；Provider、ETag 和物理路径不会穿过此接口进入插件。 */
export interface PlatformRootStore {
  /** 当前抽象桶。 */
  readonly bucket: StorageBucketRef;
  /** 打开 Host 已预绑定的 owner 模块 K-V。 */
  openKeyValueStore(input: { ownerPublicKeyHex: string; declaration: PluginStorageDeclaration; keyspaceGeneration?: number }): Promise<OwnerAppStore>;
  /** 打开 Host 已预绑定的 owner 模块文件根（model: "files"，扁平布局）。 */
  openOwnerFileStore(input: {
    ownerPublicKeyHex: string;
    declaration: PluginStorageDeclaration;
    /** 三方 App 身份根：落在 `<owner>/app.<publisher>/`，只有 files 模型允许。 */
    appPublisherPublicKeyHex?: string;
    keyspaceGeneration?: number;
  }): Promise<import("./files.js").OwnerFileStore>;
  /**
   * 枚举 owner 下已存在的三方 App publisher 公钥（`app.<publisher>/` 目录）。
   * 只读取目录名，不返回 App 文件内容；平台内部使用。
   */
  listOwnerAppPublishers(input: { ownerPublicKeyHex: string; keyspaceGeneration?: number }): Promise<string[]>;
  /** 打开 bucket 级内置 snapshot；返回值不含 Provider/ETag/path。 */
  openPlatformSnapshot<T>(input: { declaration: PluginStorageDeclaration; validate: (value: unknown) => StorageSnapshotJsonCompatible<T> }): Promise<SnapshotStore<T>>;
  /** 打开 bucket 级平台 K-V（Vault purpose、protocol、multipart 等）。 */
  openPlatformStore(input: { declaration: PluginStorageDeclaration }): Promise<KeyValueStore>;
  /** 删除指定 owner 根下全部模块的 K-V；只由 Key 删除流程调用。 */
  deleteOwnerStorage(input: { ownerPublicKeyHex: string }): Promise<void>;
}
