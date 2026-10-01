// 单 Key 钱包的本地格式契约。
//
// 这一层只描述「逻辑根路径」和「钱包元数据」,不涉及任何远程介质:
// 正式持久介质只有本 Origin 的 IndexedDB,对象主键是规范化的相对
// `path`,不含桶身份或钱包 Owner 前缀。

/** 唯一钱包 Key 的固定逻辑路径;这是结构约束,不是可配置项。 */
export const WALLET_KEYHOLD_PATH = "key.json";

/** 本地格式与初始化状态的固定路径。 */
export const WALLET_META_PATH = ".keymaster/meta";

/** 系统保留区根前缀;普通插件不得读写其中的内容。 */
export const WALLET_SYSTEM_ROOT = ".keymaster/system/";

/** 第三方 App 存储根前缀。 */
export const WALLET_APPS_ROOT = "apps/";

/** 钱包元数据格式标识。 */
export const WALLET_META_FORMAT = "keymaster.wallet-meta";

/**
 * 当前实现写入的本地 schema 版本。
 *
 * 新格式内部的版本升级与「旧桶迁移」是不同问题:这里只支持单调升级,并且
 * 升级失败或版本过新时不得退回创建空钱包。
 */
export const WALLET_CURRENT_SCHEMA_VERSION = 1;

/** 冷启动可观察到的钱包状态。 */
export type WalletState =
  /** 还没有钱包 Key;只能创建或导入。 */
  | "uninitialized"
  /** 已初始化,正常启动应处于锁定状态。 */
  | "ready"
  /** 元数据或 KeyHold 损坏/不完整;禁止静默创建空钱包覆盖。 */
  | "corrupt"
  /** 本地格式版本高于当前实现,不能退回创建空钱包。 */
  | "unsupported";

/**
 * `.keymaster/meta` 的完整结构。
 *
 * `walletGeneration` 是持久的钱包身份世代:重置或重新初始化后必须改变,
 * 即使重新导入的是同一把私钥。这样重置前的异步结果、grant 和 Connect 运行
 * 绑定无法写入新钱包。
 */
export interface WalletMetaV1 {
  format: typeof WALLET_META_FORMAT;
  version: 1;
  /** 当前本地 schema 版本;只支持升级,不做回退。 */
  schemaVersion: number;
  /** 是否已完成原子初始化提交。 */
  initialized: boolean;
  /** 钱包身份世代;每次重置/重新初始化都产生新值。 */
  walletGeneration: string;
  /** 初始化完成时间(ISO-8601)。 */
  createdAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** 校验并复制一份钱包元数据。 */
export function validateWalletMeta(value: unknown): WalletMetaV1 {
  if (!isRecord(value)) throw new TypeError("Wallet meta is invalid");
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "createdAt,format,initialized,schemaVersion,version,walletGeneration") {
    throw new TypeError("Wallet meta fields are invalid");
  }
  if (value.format !== WALLET_META_FORMAT || value.version !== 1) throw new TypeError("Wallet meta format is invalid");
  if (typeof value.initialized !== "boolean") throw new TypeError("Wallet meta initialized is invalid");
  if (!Number.isSafeInteger(value.schemaVersion) || (value.schemaVersion as number) < 1) {
    throw new TypeError("Wallet meta schemaVersion is invalid");
  }
  const walletGeneration = value.walletGeneration;
  if (typeof walletGeneration !== "string" || !/^[0-9a-f-]{36}$/u.test(walletGeneration)) {
    throw new TypeError("Wallet meta walletGeneration is invalid");
  }
  const createdAt = value.createdAt;
  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) throw new TypeError("Wallet meta createdAt is invalid");
  return {
    format: WALLET_META_FORMAT,
    version: 1,
    schemaVersion: value.schemaVersion as number,
    initialized: value.initialized,
    walletGeneration,
    createdAt,
  };
}

/**
 * 冷启动结果:Worker 只读 meta 与固定 KeyHold 后得到的状态。
 * 冷启动不列举 Key 目录、不恢复 selected Key、不建立远程连接。
 */
export interface WalletColdStartState {
  state: WalletState;
  /** state 为 ready 时携带的元数据。 */
  meta?: WalletMetaV1;
  /** 仅用于界面提示的脱敏原因。 */
  reason?: string;
}

const STORAGE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/u;

/** 校验稳定模块身份。 */
function assertStorageModuleId(moduleId: string): string {
  if (typeof moduleId !== "string" || !STORAGE_ID_PATTERN.test(moduleId)) throw new Error("moduleId is invalid");
  return moduleId;
}

/** 校验稳定用途身份。 */
function assertStoragePurposeId(purposeId: string): string {
  if (typeof purposeId !== "string" || !STORAGE_ID_PATTERN.test(purposeId)) throw new Error("purposeId is invalid");
  return purposeId;
}

/**
 * 规范化第三方 App 的平台登记存储名称。
 *
 * name 由平台登记并绑定「已验证的 publisher 公钥 + appId」;显示名称变化
 * 或本地化不改变它。冲突分配见 `resolveAppStorageNameConflict`。
 */
export function normalizeAppStorageName(value: string): string {
  const normalized = value.normalize("NFKC").toLowerCase();
  if (!STORAGE_ID_PATTERN.test(normalized)) throw new Error("appStorageName is invalid");
  return normalized;
}

/**
 * 为「同名但身份不同」的 App 分配带稳定身份后缀的独立 name。
 *
 * 两个不同验证身份绝不共用目录:冲突方得到 `<base>-<digest8>`,digest 来自
 * publisher 公钥与 appId,因此跨设备、跨重启结果一致。
 */
export function resolveAppStorageNameConflict(input: {
  requestedName: string;
  publisherPublicKeyHex: string;
  appId: string;
}): string {
  const base = normalizeAppStorageName(input.requestedName);
  if (!/^(02|03)[0-9a-f]{64}$/u.test(input.publisherPublicKeyHex)) throw new Error("publisherPublicKeyHex is invalid");
  if (!STORAGE_ID_PATTERN.test(input.appId)) throw new Error("appId is invalid");
  const digest = appIdentityDigestHex(input.publisherPublicKeyHex, input.appId);
  return (base.slice(0, 54) + "-" + digest.slice(0, 8));
}

/**
 * 没有显式登记 name 时，由验证身份派生出稳定的 App 目录名。
 *
 * 这保证「同名不同身份绝不共用目录」在没有登记记录时也成立：目录名完全来自
 * 身份摘要，跨设备、跨重启结果一致，显示名称或本地化不影响它。平台一旦有
 * 正式登记记录，就应使用登记值并在本函数之外做冲突分配。
 */
export function deriveAppStorageName(input: {
  publisherPublicKeyHex: string;
  appId: string;
}): string {
  if (!/^(02|03)[0-9a-f]{64}$/u.test(input.publisherPublicKeyHex)) throw new Error("publisherPublicKeyHex is invalid");
  if (!STORAGE_ID_PATTERN.test(input.appId)) throw new Error("appId is invalid");
  const digest = appIdentityDigestHex(input.publisherPublicKeyHex.toLowerCase(), input.appId);
  return ("app-" + digest.slice(0, 24));
}

/** 与 appIdentity 同族的稳定摘要;只需短后缀,用于目录名去冲突。 */
function appIdentityDigestHex(publisherPublicKeyHex: string, appId: string): string {
  const bytes = new TextEncoder().encode(
    "keymaster.app-storage-name.v1\u0000" + publisherPublicKeyHex.toLowerCase() + "\u0000" + appId
  );
  return Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// 保持与其它 contracts 源文件一致的依赖位置:类型与常量在前,实现依赖在后。
import { sha256 } from "@noble/hashes/sha2.js";

/**
 * 逻辑根规划的唯一入口。
 *
 * 系统数据、模块数据、第三方 App 数据按授权主体分别落在固定根下;调用方
 * 只能提供中央声明坐标,不能自报根目录。`purposeId` 为空串表示模块根。
 */
export function buildWalletStorageRoot(input: {
  authority: "platform-only" | "built-in-module" | "third-party-app";
  moduleId: string;
  purposeId: string;
  /** 仅 third-party-app 需要:平台登记并规范化后的存储名称。 */
  appStorageName?: string;
}): string {
  const moduleId = assertStorageModuleId(input.moduleId);
  const purposeId = input.purposeId === "" ? "" : assertStoragePurposeId(input.purposeId);
  if (input.authority === "platform-only") {
    return WALLET_SYSTEM_ROOT + moduleId + "/" + purposeId + "/";
  }
  if (input.authority === "built-in-module") {
    return purposeId === "" ? moduleId + "/" : moduleId + "/" + purposeId + "/";
  }
  if (input.appStorageName === undefined) throw new Error("third-party-app storage requires a registered appStorageName");
  const name = normalizeAppStorageName(input.appStorageName);
  if (purposeId !== "") throw new Error("third-party-app storage cannot use a purpose segment");
  return WALLET_APPS_ROOT + name + "/";
}

/**
 * 规范化一个存储路径并拒绝越界输入。
 *
 * 业务侧路径永远相对于某个已绑定根;这里只做「相对片段」的最终校验:
 * 绝对路径、`.`/`..` 段、空段、反斜杠和 NUL 一律拒绝。
 */
export function normalizeRelativeStoragePath(value: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("storage path is invalid");
  if (value.startsWith("/") || value.includes("\\") || value.includes("\u0000")) throw new Error("storage path is invalid");
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("storage path is invalid");
  }
  return segments.join("/");
}

/** 某个相对路径是否落在系统保留区;保留区只允许平台专属权限。 */
export function isPlatformReservedPath(path: string): boolean {
  return path === WALLET_KEYHOLD_PATH || path === ".keymaster" || path.startsWith(".keymaster/");
}

/** 某个相对路径是否落在第三方 App 根;App 不能列举或跨目录读写。 */
export function isThirdPartyAppPath(path: string): boolean {
  return path.startsWith(WALLET_APPS_ROOT);
}

// ============================================================
// 2. 初始化、冷启动与重置
// ============================================================

import type { KeyImportMaterial } from "../keyImport.js";

/** 首次初始化可以选择的唯一 Key 来源。 */
export type WalletFirstKeyDraft =
  | {
      /** 由受信任的 Coordinator 在提交边界内生成随机私钥。 */
      kind: "generate";
      /** Key 的显示标签。 */
      label: string;
      /** 这把 Key 的公开能力，例如 p2pkh。 */
      capabilities: string[];
      /** 这把 Key 自己的密码；这是本系统唯一的持久秘密认证域。 */
      password: string;
    }
  | {
      /** 导入由页面 importer 解析并校验过的私钥材料。 */
      kind: "import";
      /** Key 的显示标签。 */
      label: string;
      /** 只在本次提交调用期间存在的私钥材料。 */
      material: KeyImportMaterial;
      /** importer 识别出的格式标识。 */
      format: string;
      /** 可选的公开导入来源说明。 */
      source?: string;
      /** 这把 Key 的公开能力。 */
      capabilities: string[];
      /** 这把 Key 自己的密码。 */
      password: string;
    };

/**
 * 创建或导入钱包的单一原子提交计划。
 *
 * 页面不能在提交前分步写入：密码和私钥材料只存在于页面内存，Coordinator
 * 在一个 IndexedDB 事务里同时写入 `key.json`、`.keymaster/meta` 和必要初始
 * 系统数据。只有事务完成后才报告成功。
 */
export interface WalletInitializePlan {
  /** 本次初始化操作 ID；只用于幂等与诊断，不是身份。 */
  transactionId: string;
  /** 唯一钱包 Key 的草稿。 */
  firstKey: WalletFirstKeyDraft;
}

/** 初始化成功后公开的 Key 摘要；不包含私钥。 */
export interface WalletKeySummary {
  /** 压缩公钥 hex。 */
  publicKeyHex: string;
  /** 显示标签。 */
  label: string;
  /** 展示用地址。 */
  address: string;
  /** 导入或生成格式。 */
  format: string;
  /** 公开能力列表。 */
  capabilities: string[];
  /** 创建时间 ISO 字符串。 */
  createdAt: string;
  /** 可选的公开来源说明。 */
  source?: string;
}

/** 初始化失败的阶段；用于界面提示与工单定位。 */
export type WalletInitializePhase =
  | "validate"
  | "derive-key"
  | "commit"
  | "rollback"
  | "complete";

/** 面向用户的可行动错误；diagnostic 已由统一脱敏器生成。 */
export interface WalletUserFacingError {
  /** 中文短标题。 */
  title: string;
  /** 说明失败阶段与当前数据状态。 */
  summary: string;
  /** 用户可以执行的下一步。 */
  action?: string;
  /** 稳定错误码。 */
  code: string;
  /** 一次失败的公开关联 ID，不是秘密。 */
  incidentId: string;
  /** 脱敏、默认折叠的技术诊断。 */
  diagnostic: string;
  /** 失败发生在哪个阶段。 */
  phase: WalletInitializePhase;
}

/** 初始化高层事务结果；失败也作为业务结果返回。 */
export type WalletInitializeResult =
  | {
      /** 提交已完成：Key、meta 与初始系统数据都在同一事务内落盘。 */
      ok: true;
      /** 已提交的唯一 Key 公开摘要。 */
      key: WalletKeySummary;
      /** 本次初始化确立的钱包身份世代。 */
      walletGeneration: string;
    }
  | {
      /** 提交失败；页面不得继续进入业务界面。 */
      ok: false;
      /** 可行动错误。 */
      error: WalletUserFacingError;
    };

/**
 * 冷启动快照。
 *
 * Worker 启动时只读 `meta` 与固定 KeyHold，然后进入 locked；不列举 Key 目录、
 * 不恢复 selected Key，也不建立任何远程连接。
 */
export interface WalletColdStartSnapshot {
  state: WalletState;
  /** state 为 ready 时的元数据。 */
  meta?: WalletMetaV1;
  /** ready 状态下的唯一 Key 公开信息；不解密。 */
  key?: { publicKeyHex: string; label: string };
  /** 仅用于界面提示的脱敏原因。 */
  reason?: string;
}

/** 解锁结果；明文私钥只在 Worker 内存中短暂存在。 */
export interface WalletUnlockResult {
  /** 解锁后确立的会话世代。 */
  sessionEpoch: string;
  /** 当前钱包身份世代。 */
  walletGeneration: string;
  /** 唯一 Key 的压缩公钥。 */
  publicKeyHex: string;
}

/**
 * 面向 Coordinator 与页面的钱包生命周期服务。
 *
 * 这是单 Key 产品的唯一入口：没有桶、没有 Key 列表、没有切换。
 */
export interface WalletLifecycleService {
  /** 冷启动只读 meta 与固定 KeyHold。 */
  coldStart(): Promise<WalletColdStartSnapshot>;
  /** 创建或导入唯一 Key；同一事务提交 Key、meta 与初始系统数据。 */
  initialize(plan: WalletInitializePlan): Promise<WalletInitializeResult>;
  /** 用 Key 密码解锁唯一 Key。 */
  unlock(password: string): Promise<WalletUnlockResult>;
  /**
   * 只校验 Key 密码，不改变任何状态。
   *
   * 认证语义与 `unlock` 完全一致（都由 `key.json` 的 KeyHold 文档验证），
   * 但不解锁、不换会话世代、不建立会话、不授予任何授权：解出的私钥立刻
   * 清零。需要密码确认的流程（appView 会话、改密确认）统一走这里，业务
   * 插件不自己复制一套密码校验逻辑。未初始化状态必须 fail closed。
   */
  verifyPassword(password: string): Promise<void>;
  /** 锁定：撤销会话、grant 与任务授权。 */
  lock(): Promise<void>;
  /** 修改 Key 密码；使用 revision 条件写防止陈旧覆盖。 */
  changePassword(input: { oldPassword: string; newPassword: string }): Promise<void>;
  /** 只修改显示名称。 */
  rename(label: string): Promise<void>;
  /** 原样导出加密 KeyHold；不是完整钱包备份。 */
  exportKeyHold(): Promise<Uint8Array>;
  /**
   * 重置钱包：撤销授权后原子清空新格式全部数据。
   *
   * 失败时不得报告完成，旧授权也不得因失败自动恢复。
   */
  resetWallet(input: { confirmationLabel: string }): Promise<{ walletGeneration: string; clearedAt: string }>;
  /** 订阅跨 Tab 生命周期事件。 */
  subscribe(listener: (event: WalletLifecycleEvent) => void): () => void;
}

/** 跨 Tab 发布的生命周期事件。 */
export type WalletLifecycleEvent =
  | { type: "initialized"; walletGeneration: string }
  | { type: "unlocked"; sessionEpoch: string; walletGeneration: string }
  | { type: "locked" }
  | { type: "password-changed" }
  | { type: "renamed"; label: string }
  | { type: "reset"; walletGeneration: string }
  | { type: "app-revoked"; appStorageName: string };
