// packages/contracts/src/background.ts
// 后台任务通用契约。
// 设计缘由：后台任务由 plugin-background 拥有，业务插件只注册任务并
// 订阅 snapshot；不直接持久化业务游标。

import type { I18nText } from "./i18n.js";

/** 任务状态。 */
export type BackgroundTaskState =
  | "idle"
  | "queued"
  | "running"
  | "paused"
  | "failed";

/**
 * 任务归属的 key namespace（硬切换 007 / 008）。
 * 设计缘由：删除 key 时由 keyspace 取消该 key 下所有 task；active key
 * 切换不影响其他 key 的后台收尾。background 平台不应理解业务字段。
 */
export interface BackgroundTaskKeyScope {
  publicKeyHash: string;
  label?: string;
  fingerprint?: string;
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
  /** 默认是否启用。 */
  defaultEnabled?: boolean;
  /**
   * 任务归属的 key namespace（硬切换 007 / 008）。
   * 设计缘由：删除 key 时由 keyspace 取消该 key 下所有 task；active key
   * 切换不影响其他 key 的后台收尾。background 平台不应理解业务字段。
   *
   * 008：允许传函数以延迟求值。注册时只存函数引用；snapshot / cancelByKey
   * 在调用时再求值，避免 active key 切换后 task 仍指向旧 key 的 hash。
   */
  keyScope?: BackgroundTaskKeyScope | (() => BackgroundTaskKeyScope | undefined);
  /** 当前是否允许运行；返回 false 时任务保持 idle/queued。 */
  canRun?(): boolean | Promise<boolean>;
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
  nextRunAt?: string;
  error?: string;
  /** 是否启用（与 paused 区分）。 */
  enabled: boolean;
  /**
   * key 上下文（硬切换 007 / 008）：任务归属哪个 key namespace。
   * BackgroundTray 在 single 模式默认优先显示当前 active key 的任务；
   * all 模式按 key 分组。background 平台不应理解业务字段（UTXO / 地址 / 私钥）。
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
  listSnapshots(): BackgroundTaskSnapshot[];
  onChange(handler: (snapshots: BackgroundTaskSnapshot[]) => void): () => void;

  /** 触发任务；运行中再次触发时合并为一次后续 rerun。 */
  trigger(taskId: string, reason?: string): void;

  /**
   * 暂停任务：阻止后续自动触发并 abort 当前实例；返回的 Promise
   * resolve 时表示旧实例已真正退出，可以安全进入 paused 状态。
   * 关键设计：必须 await，否则后续 trigger 会启动第二个实例。
   */
  pause(taskId: string): Promise<void>;
  /** 继续任务：恢复自动触发。 */
  resume(taskId: string): void;
  /**
   * 取消当前运行；返回的 Promise resolve 时表示旧实例已退出。
   * cancel 不影响 enabled；后续仍可能被 trigger。
   */
  cancel(taskId: string): Promise<void>;
  /** 重试：仅重试失败任务。 */
  retry(taskId: string): void;
  /**
   * 取消指定 key namespace 下所有 task（硬切换 007）。
   * 设计缘由：keyspace.deleteKey 通知 background 停止该 key 的所有收尾，
   * 防止迟到写入重建被删 namespace。返回的 Promise resolve 时表示
   * 所有目标 task 旧实例均已退出。
   */
  cancelByKey(publicKeyHash: string): Promise<void>;
}

/** capability keys。 */
export const BACKGROUND_REGISTRY_CAPABILITY = "background.registry";
export const BACKGROUND_SERVICE_CAPABILITY = "background.service";
