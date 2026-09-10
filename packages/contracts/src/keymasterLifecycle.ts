// Keymaster 生命周期领域扩展。
//
// WebLoom 已经提供通用 Scope、权限租约、服务桥、任务和升级门禁契约；
// 这里仅保留 Keymaster 自己的 Vault 身份、权限 allowlist 和服务常量。
// owner/session 等领域字段在服务引用 attributes 中传输，但不进入 WebLoom
// 公共包的通用字段集合。

/** Keymaster 领域仍需区分的 Scope 绑定类别；不进入 WebLoom Runtime 契约。 */
export type KeymasterScopeKind = "root" | "storage" | "owner-session" | "connect-session";

/** Coordinator/Vault 对外发布的身份状态。 */
export type RuntimeVaultStatus = "booting" | "uninitialized" | "locked" | "unlocked" | "fatal";

/** Window Host 重建领域 Scope 所需的最小身份快照。 */
export interface RuntimeIdentityTransition {
  /** 当前 Vault 状态；只有 unlocked 才允许创建 owner-session 实例。 */
  vaultStatus: RuntimeVaultStatus;
  /** 当前 owner 公钥；锁定时必须为空或不可用于创建 owner 实例。 */
  ownerPublicKeyHex?: string | null;
  /** 当前会话世代；unlock、lock、切 Key、Worker 接管都会变化。 */
  sessionEpoch: string;
  /** 当前存储桶世代；桶切换时重建 storage Scope 绑定实例。 */
  bucketGeneration?: number;
}

/** Keymaster 平台定义的权限 allowlist；WebLoom 只把权限当开放字符串。 */
export type PluginPermission =
  | "identity.read"
  | "storage.read"
  | "storage.write"
  | "storage.platform"
  | "crypto.signIntent"
  | "crypto.signTransaction"
  | "crypto.channel"
  | "vault.exportBackup"
  | "vault.manage";

/** Coordinator 内置服务的稳定契约标识和版本。 */
export const COORDINATOR_OWNER_STORAGE_SERVICE = "coordinator.owner-storage";
export const COORDINATOR_CRYPTO_SERVICE = "coordinator.crypto";
export const COORDINATOR_SERVICE_CONTRACT_VERSION = "1.0.0";
/** MessagePort call protocol; directory snapshots use WebLoom RuntimeSnapshot. */
export const COORDINATOR_SERVICE_PROTOCOL_VERSION = "webloom.remote-service.v2";
