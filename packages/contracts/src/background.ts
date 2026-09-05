// packages/contracts/src/background.ts
// 后台任务通用契约。
// 设计缘由：后台任务由 plugin-background 拥有，业务插件只注册任务并
// 订阅 snapshot；不直接持久化业务游标。

import type { I18nText } from "./i18n.js";

/**
 * 后台同步设置。
 * 设计缘由：统一管理资产同步频率，避免各业务插件自行创建 interval。
 * 设置属于后台任务平台，而不是某个业务插件。
 */
export interface BackgroundSyncSettings {
  /** 资产持仓同步周期毫秒。默认 900_000（15 分钟）。 */
  assetHoldingsIntervalMs: number;
}

/**
 * 任务状态。
 * 设计缘由：删除 paused/failed 作为用户可操作的稳态。
 * - failed 不再是稳态：失败后保留错误信息，自动回到 idle 等待下一周期
 * - paused 完全删除：用户不应管理轮询开关
 * - blocked 新增：任务被门禁阻塞（Vault 锁定、keyspace 初始化中、无 active key）
 */
export type BackgroundTaskState =
  | "idle"
  | "queued"
  | "running"
  | "blocked";

/**
 * 后台任务运行资格判定。
 * 设计缘由：canRun 从简单的 boolean 改为结构化结果，
 * 让 UI 能展示明确的阻塞原因，而不是静默返回 idle。
 */
export type BackgroundRunEligibility =
  | { ready: true }
  | { ready: false; reason: I18nText; retryOn: "unlock" | "key-ready" | "interval" };

export type BackgroundCommandResult =
  | { status: "accepted" }
  | { status: "already-running" }
  | { status: "blocked"; reason: I18nText }
  | { status: "locked" | "not-ready" | "stale-epoch" }
  | { status: "validation-error" | "error" | "transport-error"; message: string };

/**
 * 任务归属的 key namespace（硬切换 007 / 008 / 001 收口）。
 * 设计缘由：删除 key 时由 keyspace 取消该 key 下所有 task；active key
 * 切换不影响其他 key 的后台收尾。background 平台不应理解业务字段。
 *
 * 硬切换 001 收口：平台身份根字段统一为 publicKeyHex；`publicKeyHash`
 * 不再作为任务 scope 字段。cancelByKey 等 API 入参也对应改为
 * `publicKeyHex`。
 *
 * 硬切换 003 收尾：若任务需要展示 key 上下文，UI 应在拿到本 scope 后
 * 调 `formatShortPublicKey(publicKeyHex)` 现算短公钥；本接口**不**持
 * 有 `fingerprint` 字段，也**不**通过 MessageBus 透传短公钥。
 */
export interface BackgroundTaskKeyScope {
  publicKeyHex: string;
  label?: string;
}

/** 任务进度（可空）。 */
export interface BackgroundTaskProgress {
  /** 0..1 总进度；不适用时省略。 */
  ratio?: number;
  /** 通用计数/说明。 */
  count?: number;
  /** 人类可读标签。硬切换后为 I18nText，runtime 渲染时调用 i18n.text() 解析。 */
  label?: I18nText;
}

/**
 * 任务调度组配置。
 * 设计缘由：把同类任务归入同一个调度组，由 BackgroundService 统一管理
 * 频率、冷却和配置变更。业务插件不得自行创建 interval 或 timer。
 */
export interface BackgroundTaskSchedule {
  /** 调度组名称，例如 "asset-holdings"。 */
  group: string;
  /** 组默认周期毫秒。 */
  defaultIntervalMs?: number;
  /** 组最小周期毫秒；用户配置不得低于此值。 */
  minIntervalMs?: number;
}

/** 任务定义：业务插件在 setup 阶段注册。 */
export interface BackgroundTaskDefinition {
  /** 任务 id，全局唯一，使用命名空间。 */
  id: string;
  /** 所属 plugin id。 */
  pluginId: string;
  /** 展示名。硬切换后为 I18nText，runtime 渲染时调用 i18n.text() 解析。 */
  label: I18nText;
  /** 描述。 */
  description?: I18nText;
  /** 周期毫秒；缺省不自动调度。 */
  intervalMs?: number;
  /** 调度组配置；与 intervalMs 互斥，优先使用 schedule.group。 */
  schedule?: BackgroundTaskSchedule;
  /**
   * 任务归属的 key namespace（硬切换 007 / 008）。
   * 设计缘由：删除 key 时由 keyspace 取消该 key 下所有 task；active key
   * 切换不影响其他 key 的后台收尾。background 平台不应理解业务字段。
   *
   * 008：允许传函数以延迟求值。注册时只存函数引用；snapshot / cancelByKey
   * 在调用时再求值，避免 active key 切换后 task 仍指向旧 key 的 hash。
   */
  keyScope?: BackgroundTaskKeyScope | (() => BackgroundTaskKeyScope | undefined);
  /**
   * 运行资格判定。
   * 设计缘由：返回结构化结果让 UI 展示阻塞原因，而不是静默返回 idle。
   * 返回 { ready: true } 表示可以运行；返回 { ready: false, reason, retryOn }
   * 表示被门禁阻塞，reason 是用户可见的 I18nText。
   */
  canRun?(): BackgroundRunEligibility | Promise<BackgroundRunEligibility>;
  /** 任务执行体。 */
  run(context: BackgroundTaskContext): Promise<void> | void;
}

/** 任务执行上下文。 */
export interface BackgroundTaskContext {
  /** 取消信号：cancel()/abort 都会触发。 */
  signal: AbortSignal;
  /** 触发原因，例如 "interval"/"manual"/"after-unlock"。 */
  reason: string;
  /** 上报进度。 */
  reportProgress(progress: BackgroundTaskProgress): void;
  /** Coordinator 任务在任何 K-V commit 前调用，epoch/key/generation 失效时抛错。 */
  assertSessionFresh?: () => void;
}

/** 任务快照：UI 展示用。 */
export interface BackgroundTaskSnapshot {
  id: string;
  pluginId: string;
  /**
   * 展示名（已经解析为可显示字符串）。设计缘由：snapshot 一次性在
   * 内部用当前 i18n language 解析，UI 渲染点只看到 string；
   * 切换语言后 i18n.onChange 触发 snapshot 重发，UI 自动重渲染。
   */
  label: string;
  state: BackgroundTaskState;
  progress?: BackgroundTaskProgress;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  /** 上次尝试时间（无论成功或失败）。 */
  lastAttemptAt?: string;
  nextRunAt?: string;
  /** 上次错误信息；下次成功后清除。 */
  error?: string;
  /**
   * 阻塞原因（仅 state="blocked" 时有值）。
   * 设计缘由：让用户理解为什么任务没有运行，而不是静默等待。
   */
  blockedReason?: I18nText;
  /**
   * key 上下文（硬切换 007 / 008 / 005）：任务归属哪个 key namespace。
   * 硬切换 005 收尾：BackgroundTray 只按当前 active key 展示任务；不再有
   * "all 模式按 key 分组"的语义——平台 active key 模型收窄为唯一一把
   * ready key。background 平台不应理解业务字段（UTXO / 地址 / 私钥）。
   *
   * 008：始终是解析后的对象。动态 keyScope 会在 snapshot 时通过
   * resolveKeyScope 求值后再写到这里。
   */
  keyScope?: BackgroundTaskKeyScope;
}

/** 注册表接口。 */
export interface BackgroundRegistry {
  register(task: BackgroundTaskDefinition): void;
  list(): BackgroundTaskDefinition[];
  get(id: string): BackgroundTaskDefinition | undefined;
}

/** Service 接口。 */
export interface BackgroundService {
  /** 释放 Coordinator 订阅；页面卸载/热重载时调用。 */
  dispose?(): void;
  listTaskSnapshots(): BackgroundTaskSnapshot[];
  onTaskSnapshotsChanged(handler: (snapshots: BackgroundTaskSnapshot[]) => void): () => void;

  /**
   * 立即同步一次（UI 手动 API）。
   * 设计缘由：托盘唯一的手动动作，绕过普通冷却但不绕过门禁。
   * 等价于 trigger(taskId, "manual")，但语义更清晰。
   */
  runNow(taskId: string): Promise<BackgroundCommandResult>;

  /**
   * 触发任务运行（内部领域事件 API）。
   * 设计缘由：业务插件用于后台领域事件触发，不是 UI 控制 API。
   * 页面不应调用此方法。
   */
  trigger(taskId: string, reason?: string): void;

  /**
   * 取消当前运行。
   * 设计缘由：只中止当前 instance，不会禁用任务、不会取消未来定时。
   * 取消后以取消完成时为新周期起点。
   */
  cancel(taskId: string): Promise<BackgroundCommandResult>;

  /**
   * 取消指定 key namespace 下所有 task（硬切换 007 / 001 收口）。
   * 设计缘由：keyspace.deleteKey 通知 background 停止该 key 的所有收尾,
   * 防止迟到写入重建被删 namespace。返回的 Promise resolve 时表示
   * 所有目标 task 旧实例均已退出。
   *
   * 硬切换 001 收口：入参是 publicKeyHex。
   */
  cancelByKey(publicKeyHex: string): Promise<void | BackgroundCommandResult>;

  /**
   * 获取后台同步设置。
   * 设计缘由：设置属于后台任务平台，影响所有资产 provider。
   */
  getScheduleSettings(): BackgroundSyncSettings;
  /**
   * 更新后台同步设置。
   * 设计缘由：保存后重新计算 asset-holdings 组任务的 nextRunAt，
   * 新周期从保存时刻开始计时，不立即触发网络同步。
   */
  updateScheduleSettings(settings: BackgroundSyncSettings): Promise<BackgroundCommandResult>;
}

/**
 * 后台任务触发原因常量。
 * 设计缘由：统一业务插件使用的 reason 字符串，避免拼写不一致；
 * backgroundService 内部对 "manual" / "first-sync" 做冷却白名单，
 * 业务插件应使用这些常量而非硬编码字符串。
 */
export const BACKGROUND_TRIGGER_REASON = {
  /** 手动触发（用户点击）。跳过冷却。 */
  MANUAL: "manual",
  /** 首次同步（无 snapshot 时）。跳过冷却。 */
  FIRST_SYNC: "first-sync",
} as const;

/** capability keys。 */
export const BACKGROUND_REGISTRY_CAPABILITY = "background.registry";
export const BACKGROUND_SERVICE_CAPABILITY = "background.service";
