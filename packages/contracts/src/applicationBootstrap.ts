// 应用启动装配状态契约。
//
// 这个状态与 Vault 状态、Storage 健康状态分开。启动不是一个简单的
// loading/ready 二态，而是四个有明确前置条件的门禁：Storage onboarding、
// Vault selection、owner apps、Connect apps。

export type ApplicationBootstrapPhase =
  | "storage-onboarding"
  | "vault-selection"
  | "owner-apps-ready"
  | "connect-apps-ready"
  | "error";

export interface ApplicationBootstrapSnapshot {
  /** 当前装配阶段。 */
  phase: ApplicationBootstrapPhase;
  /** Coordinator Root 是否已经可读写。 */
  storageReady: boolean;
  /** Vault 和 Keyspace capability 是否都已注册。 */
  vaultCapabilityReady: boolean;
  /** 是否已经存在 unlocked active key；owner apps 的前置条件。 */
  hasUnlockedActiveKey: boolean;
  /** Vault selection 阶段的插件是否已完成装配。 */
  vaultSelectionReady: boolean;
  /** owner apps 是否已经完成装配。 */
  ownerAppsReady: boolean;
  /** Connect apps 是否已经完成装配。 */
  connectAppsReady: boolean;
  /** Asset Workspace 是否已经完成注册。 */
  assetWorkspaceReady: boolean;
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
export const APPLICATION_BOOTSTRAP_READY_CAPABILITY = "application-bootstrap.ready";

/** 全局 ResourceDefinition：React 只能通过 Resource Store 读取此状态。 */
export const APPLICATION_BOOTSTRAP_RESOURCE_ID = "shell.application-bootstrap";
