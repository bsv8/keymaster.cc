// Keymaster 生命周期领域扩展。
//
// WebLoom 已经提供通用 Scope、权限租约、服务桥、任务和升级门禁契约；
// 这里仅保留 Keymaster 自己的 Vault 身份、权限 allowlist 和 legacy wire
// 目录类型。业务字段不进入 WebLoom 公共包。

import type { RuntimeKind } from "webloom-framework";

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

/** Keymaster 服务目录中的 legacy 引用；owner/session 字段保持 wire 兼容。 */
export interface KeymasterRemoteServiceReference {
  /** 服务契约标识。 */
  capabilityId: string;
  /** 提供该服务的运行实例；实例重建后必须变化。 */
  providerInstanceId: string;
  /** 提供者所在执行环境。 */
  runtime: RuntimeKind;
  /** 服务契约版本。 */
  contractVersion: string;
  /** 提供环境的启动身份。 */
  authorityInstanceId: string;
  /** 提供者作用域身份。 */
  scopeId: string;
  /** 提供者所在 Coordinator 的升级接管世代。 */
  handoverGeneration: number;
  /** owner / Connect 会话世代；常驻服务明确为 null。 */
  sessionEpoch: string | null;
  /** owner 公钥；非 owner 服务明确为 null。 */
  ownerPublicKeyHex: string | null;
  /** owner 持久存储世代；非 owner 服务明确为 null。 */
  ownerGeneration: number | null;
  /** 当前服务目录状态。 */
  status: "starting" | "ready" | "unavailable" | "failed";
  /** 当前权威目录流修订号。 */
  snapshotRevision: number;
  /** 外部授权标识；引用不是授权本身。 */
  grantId?: string;
  /** 服务端授权策略修订。 */
  authorizationRevision?: number;
}

/** Keymaster legacy 服务快照；只用于 wire 边界，不作为 WebLoom Bridge 类型。 */
export interface KeymasterRemoteServiceSnapshot {
  /** 快照来自哪条端口连接。 */
  connectionId: string;
  /** 快照来自哪个权威启动身份。 */
  authorityInstanceId: string;
  /** 同一连接和权威下单调递增。 */
  snapshotRevision: number;
  /** 是否包含完整订阅范围的基线。 */
  baseline: boolean;
  /** 当前订阅范围内的 legacy 服务引用。 */
  services: readonly KeymasterRemoteServiceReference[];
}

/** Keymaster legacy 服务桥控制消息；type 字符串不可在本批次改变。 */
export type KeymasterRemoteServicePortControlMessage =
  | {
      type: "keymaster.remote-service.handshake";
      handshake: { connectionId: string; authorityInstanceId: string; protocolVersion: string };
    }
  | {
      type: "keymaster.remote-service.snapshot";
      snapshot: KeymasterRemoteServiceSnapshot;
    }
  | {
      type: "keymaster.remote-service.invalidate";
      reason?: string;
    }
  | {
      type: "keymaster.remote-service.disconnect";
      reason?: string;
    };

/** Coordinator 内置服务的稳定契约标识和版本。 */
export const COORDINATOR_OWNER_STORAGE_SERVICE = "coordinator.owner-storage";
export const COORDINATOR_CRYPTO_SERVICE = "coordinator.crypto";
export const COORDINATOR_SERVICE_CONTRACT_VERSION = "1.0.0";
export const COORDINATOR_SERVICE_PROTOCOL_VERSION = "1";
