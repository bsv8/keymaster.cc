// 应用启动装配状态契约。
import { defineCapability } from "webloom-framework";
//
// 这个状态与 Vault 状态、Storage 健康状态分开。启动不是一个简单的
// loading/ready 二态，而是几个有明确前置条件的门禁：本地钱包就绪、
// Vault 能力、owner apps、Connect apps。
//
// 单 Key 本地存储（docs/存储.md）之后没有远程连接与独立的存储认证阶段：
// 正常冷启动只会是 `uninitialized`（走创建/导入）或 `locked`（走解锁），
// 两者由 Vault 状态机区分，不再需要 `storage-authentication`。

export type ApplicationBootstrapPhase =
  | "storage-onboarding"
  | "vault-selection"
  | "owner-apps-ready"
  | "connect-apps-ready"
  | "error";

export interface ApplicationBootstrapSnapshot {
  /** 当前装配阶段。 */
  phase: ApplicationBootstrapPhase;
  /**
   * 本地钱包结构是否完整到可以继续装配（ready 或 locked）。
   *
   * uninitialized 仍需先创建或导入唯一 Key；corrupt / unsupported /
   * degraded 都必须 fail closed，不能折算成本字段为 true。
   */
  storageReady: boolean;
  /** Vault 和 WalletState capability 是否都已注册。 */
  vaultCapabilityReady: boolean;
  /** 是否已经存在 unlocked active key；owner apps 的前置条件。 */
  hasUnlockedActiveKey: boolean;
  /** Vault selection 阶段的插件是否已完成装配。 */
  vaultSelectionReady: boolean;
  /** owner apps 是否已经完成装配。 */
  ownerAppsReady: boolean;
  /** Connect apps 是否已经完成装配。 */
  connectAppsReady: boolean;
  /** 资产与藏品目录插件是否已经就绪。 */
  assetCatalogsReady: boolean;
  /** 装配失败时的脱敏错误信息。 */
  error?: string;
}

export type ApplicationBootstrapListener = (snapshot: ApplicationBootstrapSnapshot) => void;

/** App 只读的启动状态服务；不暴露内部的 set 方法。 */
export interface ApplicationBootstrapStatus {
  snapshot(): ApplicationBootstrapSnapshot;
  subscribe(listener: ApplicationBootstrapListener): () => void;
  /** 显式重试当前失败的应用装配流水线。 */
  retry(): Promise<void>;
}

/** 全局 capability：提供只读启动状态与装配重试入口。 */
export const APPLICATION_BOOTSTRAP_READY_CAPABILITY = defineCapability<ApplicationBootstrapStatus>({
  kind: "local",
  id: "application-bootstrap.ready",
  version: "1",
});

/** 全局 ResourceDefinition：React 只能通过 Resource Store 读取此状态。 */
export const APPLICATION_BOOTSTRAP_RESOURCE_ID = "shell.application-bootstrap";
