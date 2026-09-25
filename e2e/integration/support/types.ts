import type { Page } from "@playwright/test";

/** 集成测试证据层级；按主要测试对象分类，低层级结果不能自动提升高层级结论。 */
export type IntegrationLevel =
  | "local-integration"
  | "p2pkh"
  | "satsubscription"
  | "s3"
  | "msfile"
  | "bitfs"
  | "deployment-acceptance";

/** 场景使用的资源类型；`none` 表示不读取仓库外资源。 */
export type ResourceProfile =
  | "none"
  | "local-browser"
  | "s3"
  | "testnet"
  | "satsubscription"
  | "p2p"
  | "deployment";

/** Journey/Gate 的稳定说明，供矩阵和报告读取。 */
export interface IntegrationScenarioMetadata {
  /** 稳定场景编号，不使用 Playwright 自动生成的行号。 */
  readonly id: string;
  /** 证据层级。 */
  readonly level: IntegrationLevel;
  /** 该场景负责关闭的需求编号。 */
  readonly requirementIds: readonly string[];
  /** 用户或系统开始时的业务状态。 */
  readonly startingState: string;
  /** 成功时的业务结论。 */
  readonly successCriteria: readonly string[];
  /** 资源声明；不是运行时秘密。 */
  readonly resourceProfile: ResourceProfile;
}

/** 尚未建立 Keymaster 身份的全新浏览器状态。 */
export interface FreshUserState {
  readonly page: Page;
}

/** 已完成 Local 初始化、解锁并选中第一把 Key 的业务状态。 */
export interface ReadyUserState {
  readonly page: Page;
  /** 本机桶 ID(= device 记录键名,local 也是对象前缀)。 */
  readonly bucketId: string;
  /** 用户可读的逻辑桶名称，不是物理 S3 目标。 */
  readonly bucketLabel: string;
  /** 用户可读的 Key 标签。 */
  readonly keyLabel: string;
  /** 当前 active Key 的完整压缩公钥；不是私钥。 */
  readonly publicKeyHex: string;
}

/** 浏览器错误只保留脱敏后的文本，不能放入页面业务状态。 */
export interface BrowserErrorEvidence {
  readonly pageErrors: string[];
  readonly consoleErrors: string[];
  readonly workerErrors: string[];
}

/** 一轮 Journey 的非敏感上下文。 */
export interface IntegrationRunContext {
  readonly runId: string;
  readonly scenarioId: string;
  readonly level: IntegrationLevel;
  readonly resourceProfile: ResourceProfile;
}

/** 统一的脱敏外部资源结果；不允许附带凭据或私钥。 */
export interface RedactedResourceOutcome {
  readonly resource: ResourceProfile;
  readonly status: "prepared" | "passed" | "failed" | "blocked" | "uncertain" | "cleaned";
  readonly code: string;
  readonly runId: string;
  readonly scenarioId?: string;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
}
