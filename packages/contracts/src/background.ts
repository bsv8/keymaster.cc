// packages/contracts/src/background.ts
// 后台任务通用契约。
import { defineCapability } from "webloom-framework";
// 设计缘由：后台任务由 plugin-background 拥有，业务插件只注册任务并
// 订阅 snapshot；不直接持久化业务游标。

import type { I18nText } from "./i18n.js";

/**
 * 可在「智能调度 → 同步管理」中单独配置同步间隔的后台任务。
 * 设计缘由（2026-09-20）：
 *   - 这些任务按各自配置的间隔自动运行，用户可以设 30 秒 / 1 分钟 /
 *     5 分钟，也可以关闭（0）。
 *   - UTXO 余额快照不在这个列表里：它是 smart 任务，由 WoC 空闲 2 秒
 *     的智能调度驱动，永远保持最新。
 */
export const BACKGROUND_MANAGED_SYNC_TASK_IDS = [
  "p2pkh.transactions-sync",
  "token-bsv21.sync",
  "token-stas.sync",
  "collectible-1satordinals.sync",
  "contacts.presence-probe"
] as const;

/** 用户可选的同步间隔（毫秒）；0 = 关闭该任务的自动同步（手动仍可触发）。 */
export const BACKGROUND_SYNC_INTERVAL_OPTIONS_MS = [30_000, 60_000, 300_000, 0] as const;

/** 任务缺省同步间隔：5 分钟。 */
export const BACKGROUND_SYNC_DEFAULT_INTERVAL_MS = 300_000;

/**
 * 后台同步设置。
 * 设计缘由：同步管理只描述「任务 id -> 间隔毫秒」；平台不保存业务字段。
 * 0 表示关闭自动同步；未列出的任务使用平台缺省值。
 */
export interface BackgroundSyncSettings {
  taskIntervals: Record<string, number>;
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
  /**
   * 实际运行单元标识；例如 `contacts.coordinator-worker`。
   * 产品 id 只表示用户启停对象，不能代替 Worker / Window 单元身份。
   */
  unitId?: string;
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
  /** 任务所属的稳定运行单元标识。 */
  unitId?: string;
  /** 当前运行实例标识；任务重建后必须变化。 */
  instanceId?: string;
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
  /** 注销当前插件登记的任务；不存在时抛错，Host facade 会绑定归属。 */
  unregister?(id: string): void;
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
   * 读取同步管理设置（任务 id -> 间隔毫秒）。
   * 设计缘由：同步管理属于后台任务平台，影响所有资产 provider。
   */
  getScheduleSettings(): BackgroundSyncSettings;
  /**
   * 更新同步管理设置。
   * 设计缘由：保存后重算 managed 任务的定时器；0 表示关闭自动同步。
   * 持久化成功前不得让新值生效。
   */
  updateScheduleSettings(settings: BackgroundSyncSettings): Promise<BackgroundCommandResult>;
}

/**
 * 后台任务触发原因常量。
 * 设计缘由：统一业务插件使用的 reason 字符串，避免拼写不一致；
 * backgroundService 内部对 "manual" / "first-sync" 做冷却白名单，
 * 业务插件应使用这些常量而非硬编码字符串。
 *
 * 智能调度（2026-09-20）：资产余额同步不再由固定周期驱动，改由
 * WoC 空闲事件驱动：
 *   - UNLOCK：Vault 解锁 / Key 初始化完成后立即同步一次；
 *   - INIT：后台任务在已解锁状态下完成注册后立即同步一次；
 *   - IDLE_SYNC：WoC 队列空闲满 2 秒后同步一轮（持续利用空闲时间）。
 */
export const BACKGROUND_TRIGGER_REASON = {
  /** 手动触发（用户点击）。跳过冷却。 */
  MANUAL: "manual",
  /** 首次同步（无 snapshot 时）。跳过冷却。 */
  FIRST_SYNC: "first-sync",
  /** 解锁 / 初始化后立即同步。 */
  UNLOCK: "unlock",
  /** 任务注册完成后立即同步。 */
  INIT: "init",
  /** WoC 空闲 2 秒后由智能调度触发。 */
  IDLE_SYNC: "idle-sync",
} as const;

/** capability keys。 */
export const BACKGROUND_REGISTRY_CAPABILITY = defineCapability<BackgroundRegistry>({
  kind: "local",
  id: "background.registry",
  version: "1",
});
export const BACKGROUND_SERVICE_CAPABILITY = defineCapability<BackgroundService>({
  kind: "local",
  id: "background.service",
  version: "1",
});
