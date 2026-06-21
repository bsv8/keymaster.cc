// packages/contracts/src/log.ts
// 统一日志契约（施工单 002 硬切换）。
//
// 设计缘由：
//   - 日志是平台级能力，不是业务插件私货。runtime 内建 LogService，
//     业务插件只能通过 ctx.logger 记录，不允许自行 new 一份。
//   - 不做 per-plugin 日志 DB / 日志 store / 日志 schema 注册点；
//     全局一份 IndexedDB（keymaster.logs），统一 entry schema。
//   - debug 开关是系统级单开关：false 时 debug 调用不写库、不能补历史。
//   - entry 默认禁止写入敏感原文：私钥、助记词、密码、完整 rawTxHex、
//     完整导入 JSON、完整网络响应体。data 字段只允许放摘要字段。
//   - message 保持简短可读，是统一日志页的主文案；data / error 只是补充。

/** 日志级别。debug 关闭时不写入持久化存储。 */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** 单条 entry 的可选 key-scope 摘要。 */
export interface LogKeyScope {
  publicKeyHex: string;
}

/** 单条 entry 中的错误摘要（截断后的 name / message / stack）。 */
export interface LogError {
  name?: string;
  message: string;
  stack?: string;
}

/** 统一日志 entry schema。 */
export interface LogEntry {
  /** entry 唯一 id（uuid 风格）。 */
  id: string;
  /** ISO 字符串时间戳。 */
  ts: string;
  level: LogLevel;
  /** entry 所属 pluginId；runtime 系统日志统一使用 "runtime"。 */
  pluginId: string;
  /** 行为分组，例如 "vault"、"background.task"、"woc.request"。 */
  scope: string;
  /** 行为事件名，例如 "unlock"、"request.completed"。 */
  event: string;
  /** 一行可读主文案。 */
  message: string;
  /** 摘要字段集合，禁止放敏感原文或大对象。 */
  data?: Record<string, unknown>;
  /** 仅当 entry 关联某把 key 时设置。 */
  keyScope?: LogKeyScope;
  /** 关联错误摘要；仅记录 message / 截断 stack。 */
  error?: LogError;
}

/** 日志系统配置。 */
export interface LogConfig {
  /** 保留天数；过期日志在 prune 时被 best-effort 删除。 */
  retentionDays: number;
  /** debug 开关；false 时 logger.debug() 直接 no-op，不写库。 */
  debugEnabled: boolean;
}

/** 写入日志的 input。pluginId 由平台注入，业务插件不传。 */
export interface LogWriteInput {
  scope: string;
  event: string;
  message: string;
  data?: Record<string, unknown>;
  keyScope?: LogKeyScope;
  error?: LogError;
}

/** 内部 append 入口使用的 input（pluginId 由 service 注入）。 */
export interface LogAppendInput extends LogWriteInput {
  level: LogLevel;
  /** 内部：service / 业务插件可显式传 pluginId；缺省时 service 内部用 "runtime"。 */
  pluginId?: string;
  /** 内部：显式 ts 覆盖；缺省由 service 取 new Date().toISOString()。 */
  ts?: string;
}

/** 列表查询条件。所有字段都可选。 */
export interface LogQuery {
  pluginId?: string;
  level?: LogLevel;
  /** 包含 pluginId 在内的前缀匹配。 */
  scopePrefix?: string;
  /** 模糊匹配 message / event / scope（大小写不敏感）。 */
  keyword?: string;
  /** 起始时间（包含）。 */
  from?: string;
  /** 截止时间（包含）。 */
  to?: string;
  /** 最多返回条数；缺省 200。 */
  limit?: number;
  /** 倒序返回。 */
  descending?: boolean;
}

/** 清理条件。至少要有一个限制，避免误清空全部。 */
export interface LogClearQuery {
  pluginId?: string;
  level?: LogLevel;
  olderThan?: string;
}

/** 列表返回元素。 */
export type LogListItem = LogEntry;

/**
 * 业务插件拿到的 logger。
 *   - pluginId 已经天然绑定，插件作者禁止再手工传 pluginId。
 *   - debug() 在系统级 debug 关闭时直接 no-op，不写库。
 *   - child(scope) 用于在同一插件内细分模块；不允许覆盖 pluginId。
 */
export interface PluginLogger {
  debug(input: LogWriteInput): void;
  info(input: LogWriteInput): void;
  warn(input: LogWriteInput): void;
  error(input: LogWriteInput): void;
  child(scope: string): PluginLogger;
}

/**
 * 平台级 LogService（runtime 内建 capability）。
 *   - getConfig / updateConfig：配置读写；updateConfig 内做归一化与 best-effort prune。
 *   - append：内部归一化与截断入口；debug 关闭时 reject debug level。
 *   - listEntries：按 query 过滤、按 ts 倒序。
 *   - clearEntries：按 query 清理；返回删除条数。
 *   - pruneExpired：删除 ts < now - retentionDays 的 entry。
 *   - forPlugin：返回绑定 pluginId 的 PluginLogger（plugin 入口）。
 *   - onConfigChange：订阅配置变化。
 */
export interface LogService {
  getConfig(): LogConfig;
  updateConfig(patch: Partial<LogConfig>): Promise<LogConfig>;
  listEntries(query?: LogQuery): Promise<LogListItem[]>;
  append(input: LogAppendInput): Promise<void>;
  clearEntries(query?: LogClearQuery): Promise<number>;
  /** 清空全部 entry。无 query；UI 上"清空全部"按钮用。 */
  clearAllEntries(): Promise<number>;
  pruneExpired(now?: string): Promise<number>;
  forPlugin(pluginId: string, baseScope?: string): PluginLogger;
  onConfigChange(handler: (config: LogConfig) => void): () => void;
}

/** 日志 service 的 capability key。 */
export const LOG_SERVICE_CAPABILITY = "log.service";

/** 默认配置。runtime 启动时写入 config store；用户可改写。 */
export const DEFAULT_LOG_CONFIG: LogConfig = {
  retentionDays: 30,
  debugEnabled: false
};
