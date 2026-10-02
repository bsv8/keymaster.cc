import { deriveThirdPartyStorageModuleId } from "../appIdentity.js";
import type { KeyValueStore } from "./kv.js";
import type { SnapshotStore, StorageSnapshotJsonCompatible } from "./snapshot.js";
import {
  buildWalletStorageRoot,
  isPlatformReservedPath,
  isThirdPartyAppPath,
  normalizeRelativeStoragePath,
} from "./wallet.js";

/**
 * 中央存储声明的授权主体。
 *
 * 物理数据不再按桶和 Owner 隔离，权限仍然隔离：系统管理数据、内置模块数据和
 * 第三方 App 数据只能通过各自绑定的句柄访问。三类主体对应三个固定根，不能
 * 互相访问对方的保留区。
 */
export type StorageAuthority = "platform-only" | "built-in-module" | "third-party-app";

/** 中央存储声明的数据模型。 */
export type StorageModel = "snapshot" | "kv" | "files";

/**
 * Host/Coordinator 使用的中央存储声明。
 *
 * 这是逻辑身份，不是物理目录名。moduleId + purposeId 是稳定的业务坐标；
 * authority 决定落在哪个固定根，model 决定使用哪种句柄。声明里不再有
 * bucketId、bucketGeneration 或 ownerPublicKeyHex。
 */
export interface PluginStorageDeclaration {
  /** 稳定模块身份，例如 `coordinator`、`p2pkh` 或派生的第三方 App UUID。 */
  moduleId: string;
  /** 模块内稳定用途，例如 `settings` 或 `state`；文件模型允许空串表示模块根。 */
  purposeId: string;
  /** 平台专属、内置模块或已验证第三方 App。 */
  authority: StorageAuthority;
  /** 固定单对象快照或 unique-value-id K-V。 */
  model: StorageModel;
  /** 当前数据 schema 版本；V1 不提供迁移回退。 */
  schemaVersion: number;
}

/**
 * 装配层发放的最终存储绑定。
 *
 * 句柄绑定的四件事：
 *   - 钱包身份世代：重置后旧句柄永久失效；
 *   - 会话 epoch：锁定/解锁后旧授权失效；
 *   - Worker 运行世代：Worker 重启后旧句柄不再可用；
 *   - 已验证 App 身份与平台登记的存储 name。
 * 调用方不能修改这些字段，也没有桶或 Owner 前缀。
 */
export interface StorageNamespaceBinding extends PluginStorageDeclaration {
  /** 持久的钱包身份世代，来自 `.keymaster/meta`。 */
  walletGeneration: string;
  /** 发放授权时的 Coordinator session 世代。 */
  sessionEpoch: string;
  /** 发放授权时的 Worker 运行世代。 */
  runGeneration: string;
  /** 仅 third-party-app 需要：平台登记并规范化后的稳定存储名称。 */
  appStorageName?: string;
  /** 仅 third-party-app 需要：验证后的 App 身份摘要。 */
  verifiedAppIdentity?: { publisherPublicKeyHex: string; appId: string };
}

const STORAGE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/u;

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

/** 校验并规范化一个中央存储声明。 */
export function validatePluginStorageDeclaration(input: PluginStorageDeclaration): PluginStorageDeclaration {
  if (!input) throw new Error("storage declaration is invalid");
  if (input.authority !== "platform-only" && input.authority !== "built-in-module" && input.authority !== "third-party-app") {
    throw new Error("storage declaration authority is invalid");
  }
  if (input.model !== "snapshot" && input.model !== "kv" && input.model !== "files") {
    throw new Error("storage declaration model is invalid");
  }
  const moduleId = validateStorageModuleId(input.moduleId);
  // files 模型允许空 purposeId，表示「模块根」（例如 p2pkh/）；
  // kv/snapshot 仍必须有具体 purpose 段。
  const purposeId = input.purposeId === "" && input.model === "files" ? "" : validateStoragePurposeId(input.purposeId);
  if (!Number.isSafeInteger(input.schemaVersion) || input.schemaVersion < 1) {
    throw new Error("storage declaration schemaVersion is invalid");
  }
  // 第三方 App 只能拿到自己目录里的文件读写；K-V 与 snapshot 属于平台和内置
  // 模块的模型，不对 App 开放。
  if (input.authority === "third-party-app" && input.model !== "files") {
    throw new Error("third-party-app storage must use the files model");
  }
  return { moduleId, purposeId, authority: input.authority, model: input.model, schemaVersion: input.schemaVersion };
}

/**
 * 由 verified identity 派生三方 App 的稳定模块身份。
 *
 * 这是三方 App 唯一可用的 moduleId 来源；caller 不能在 grant 中自报另一个
 * moduleId 或目标 name。
 */
export { deriveThirdPartyStorageModuleId };

/**
 * 构造绑定后的逻辑 namespace 根。
 *
 * 根路径完全由 authority 与中央声明坐标决定，调用方不能自报物理路径：
 *   - platform-only → `.keymaster/system/<moduleId>/<purposeId>/`
 *   - built-in-module → `<moduleId>/<purposeId>/`（空 purpose 即模块根）
 *   - third-party-app → `apps/<appStorageName>/`
 */
export function buildStorageNamespaceRoot(binding: StorageNamespaceBinding): string {
  const declaration = validatePluginStorageDeclaration(binding);
  if (typeof binding.walletGeneration !== "string" || binding.walletGeneration.length === 0) {
    throw new Error("walletGeneration is invalid");
  }
  if (typeof binding.sessionEpoch !== "string" || binding.sessionEpoch.length === 0) {
    throw new Error("sessionEpoch is invalid");
  }
  if (typeof binding.runGeneration !== "string" || binding.runGeneration.length === 0) {
    throw new Error("runGeneration is invalid");
  }
  if (declaration.authority === "third-party-app") {
    if (binding.appStorageName === undefined) throw new Error("third-party-app storage requires a registered appStorageName");
    if (!binding.verifiedAppIdentity) throw new Error("third-party-app storage requires a verified app identity");
    return buildWalletStorageRoot({
      authority: "third-party-app",
      moduleId: declaration.moduleId,
      purposeId: declaration.purposeId,
      appStorageName: binding.appStorageName,
    });
  }
  if (binding.appStorageName !== undefined || binding.verifiedAppIdentity !== undefined) {
    throw new Error("app storage identity is only valid for third-party-app authority");
  }
  return buildWalletStorageRoot({
    authority: declaration.authority,
    moduleId: declaration.moduleId,
    purposeId: declaration.purposeId,
  });
}

/** 固定 snapshot 对象的逻辑路径；只有平台实现使用此函数执行本地 I/O。 */
export function buildStorageSnapshotPath(binding: StorageNamespaceBinding): string {
  return `${buildStorageNamespaceRoot(binding)}current`;
}

/**
 * 最终路径 guard：只允许 namespace 内的相对键。
 *
 * 拒绝父目录、空段、反斜杠、NUL、系统保留段和 `apps/` 跨目录。相同前缀的
 * 相似目录（例如对 `apps/a/` 访问 `apps/a-evil/`）不会因为字符串前缀通过。
 */
export function assertStorageKeyInNamespace(root: string, key: string): void {
  if (typeof root !== "string" || !root.endsWith("/") || root.startsWith("/") || root.includes("//")) {
    throw new Error("storage namespace root is invalid");
  }
  if (typeof key !== "string" || key.length === 0 || key.startsWith("/") || key.includes("\\") || key.includes("\u0000")) {
    throw new Error("storage key is outside namespace");
  }
  if (!key.startsWith(root)) throw new Error("storage key is outside namespace");
  const relative = key.slice(root.length);
  if (relative.length === 0) throw new Error("storage key is outside namespace");
  const segments = relative.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("storage key is outside namespace");
  }
  const normalizedRelative = segments.join("/");
  // 规范化之后必须逐段一致：防止百分号编码、Unicode 折叠等绕过在下游被
  // 再次解析成别的段。
  if (normalizeRelativeStoragePath(normalizedRelative) !== normalizedRelative) {
    throw new Error("storage key is outside namespace");
  }
  if (root.startsWith(".keymaster/")) {
    // 系统根内只允许访问自己坐标下的数据，不能下降到别的 system 目录，
    // 也不能触碰固定 KeyHold 与 meta。
    if (isPlatformReservedPath(normalizedRelative)) throw new Error("storage key is outside namespace");
    return;
  }
  if (root.startsWith("apps/")) {
    // App 目录内不允许再出现 apps 段：App 不能通过 apps/x/… 跳到别的 App。
    if (normalizedRelative.split("/").includes("apps")) throw new Error("storage key is outside namespace");
    return;
  }
  // 内置模块根不能下降到系统保留区或第三方 App 区。
  if (isThirdPartyAppPath(root + normalizedRelative) || isPlatformReservedPath(root + normalizedRelative)) {
    throw new Error("storage key is outside namespace");
  }
}

/** 已绑定模块根与 App 目录的受限 K-V 句柄。 */
export interface OwnerAppStore extends KeyValueStore {}

/** 平台根存储权威；物理路径、数据库连接和内部实现不会穿过此接口进入插件。 */
export interface PlatformRootStore {
  /** 当前钱包身份世代。 */
  readonly walletGeneration: string;
  /**
   * 平台只读元数据/字节视图；仅供 Coordinator 自带的存储浏览器使用。
   *
   * 它返回完整逻辑路径而不是命名空间受限路径，因此不能经由任何插件可见的
   * capability 暴露：普通模块与 Connect App 的栅栏仍然只经由上面三个 open*。
   */
  openBrowseStore(): Promise<import("./browse.js").StorageBrowseWallet>;
  /** 打开 Host 已预绑定的模块 K-V。 */
  openKeyValueStore(input: { declaration: PluginStorageDeclaration }): Promise<OwnerAppStore>;
  /** 打开 Host 已预绑定的文件根(model: "files")。 */
  openModuleFileStore(input: {
    declaration: PluginStorageDeclaration;
    /** 三方 App 目录：仅 third-party-app 声明允许携带。 */
    appStorageName?: string;
    /** 三方 App 已验证身份：仅 third-party-app 声明允许携带。 */
    verifiedAppIdentity?: { publisherPublicKeyHex: string; appId: string };
  }): Promise<import("./files.js").ModuleFileStore>;
  /** 打开平台专属 snapshot。 */
  openPlatformSnapshot<T>(input: {
    declaration: PluginStorageDeclaration;
    validate: (value: unknown) => StorageSnapshotJsonCompatible<T>;
  }): Promise<SnapshotStore<T>>;
  /** 打开平台 K-V。 */
  openPlatformStore(input: { declaration: PluginStorageDeclaration }): Promise<KeyValueStore>;
  /** 删除一个已绑定目录下的全部对象；只由重置和单 App 清理流程调用。 */
  clearStorageRoot(input: { declaration: PluginStorageDeclaration; appStorageName?: string }): Promise<void>;
}
