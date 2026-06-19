// 重新导出底层 db 工具：供 plugin-settings 测试夹具使用。
// 设计缘由：plugin-settings 的 LogSettingsPage.test.tsx 需要在每个用例
// 前后清理日志 DB；runtime 的统一入口不暴露 disposeLogDb（生产代码
// 不应直接拿到 DB 句柄），但测试夹具用浅 re-export 拿到 disposeLogDb /
// LOG_DB_NAME 是更克制的方案——业务插件仍只能走 log.service。
export { disposeLogDb, LOG_DB_NAME } from "./logDb.js";

// packages/runtime/src/log/logService.ts
// LogService 实现（施工单 002 硬切换）。
//
// 关键不变量：
//   1. 唯一入口：业务插件通过 ctx.logger（即 forPlugin(...) 拿到）；
//      禁止 plugin 自己 new logger 或绕过 runtime 直接 indexedDB。
//   2. debugEnabled=false 时 logger.debug() 直接返回，不写库、不排队、不补历史。
//   3. forPlugin() 返回的 logger 已天然绑定 pluginId，child(scope) 只追加 scope。
//   4. append 内部统一做：归一化、敏感字段过滤、长度截断。
//   5. 写库失败不能反向阻断业务：catch 后只向 console.error 打一次摘要。
//   6. retentionDays 从大改小：保存配置后立即 best-effort prune。
//   7. config 变化会通过 onConfigChange 通知订阅者；append 内部会重新读 config。
//   8. service 不理解任何业务语义，只处理统一字段。

import {
  DEFAULT_LOG_CONFIG,
  type LogAppendInput,
  type LogClearQuery,
  type LogConfig,
  type LogEntry,
  type LogError,
  type LogLevel,
  type LogListItem,
  type LogQuery,
  type LogService,
  type LogWriteInput,
  type PluginLogger
} from "@keymaster/contracts";
import {
  deleteWhere,
  disposeLogDb,
  getConfigRow,
  listAllEntries,
  listByPlugin,
  LOG_STORE_ENTRIES,
  putConfigRow,
  putEntry,
  type LogConfigRow,
  type LogEntryRow
} from "./logDb.js";

/** 单条 entry 中 data / error.stack 截断长度上限。 */
const MAX_FIELD_LENGTH = 2000;
/** message 截断长度上限。 */
const MAX_MESSAGE_LENGTH = 500;
/** 单条 entry data 的字段数上限。 */
const MAX_DATA_KEYS = 32;

/** data / error.stack 中禁止出现的敏感 key 列表（大小写不敏感）。 */
const FORBIDDEN_DATA_KEYS = new Set([
  "privatekey",
  "private_key",
  "privkey",
  "priv",
  "secret",
  "mnemonic",
  "seed",
  "passphrase",
  "password",
  "wif",
  "rawtxhex",
  "rawtx",
  "rawtxjson",
  "cipher",
  "ciphertext",
  "cipherb64",
  "envelope",
  "importjson",
  "importpayload",
  "keystore"
]);

function nowIso(): string {
  return new Date().toISOString();
}

function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `l_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/** 把任意 value 截断到 limit 字符内。 */
function truncateString(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}…[truncated ${value.length - limit} chars]`;
}

/**
 * 把 data 浅拷贝一遍：
 *   - 删除 FORBIDDEN_DATA_KEYS 中的 key；
 *   - 超过 MAX_DATA_KEYS 时截断并附 truncated=true 语义；
 *   - 字符串字段超长时截断。
 */
function sanitizeData(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!data) return undefined;
  const out: Record<string, unknown> = {};
  const keys = Object.keys(data);
  const limited = keys.slice(0, MAX_DATA_KEYS);
  const dropped = keys.length - limited.length;
  for (const k of limited) {
    const lower = k.toLowerCase();
    if (FORBIDDEN_DATA_KEYS.has(lower)) continue;
    const v = data[k];
    if (typeof v === "string") {
      out[k] = truncateString(v, MAX_FIELD_LENGTH);
    } else if (v && typeof v === "object") {
      // 复杂对象不深挖；toString 后截断。
      try {
        out[k] = truncateString(JSON.stringify(v), MAX_FIELD_LENGTH);
      } catch {
        out[k] = "[unserializable]";
      }
    } else {
      out[k] = v;
    }
  }
  if (dropped > 0) {
    out.__truncatedKeys = dropped;
  }
  return out;
}

function sanitizeError(error: LogError | undefined): LogError | undefined {
  if (!error) return undefined;
  const out: LogError = {
    name: error.name ? truncateString(String(error.name), 200) : undefined,
    message: truncateString(String(error.message ?? ""), MAX_FIELD_LENGTH)
  };
  if (error.stack) {
    out.stack = truncateString(String(error.stack), MAX_FIELD_LENGTH);
  }
  return out;
}

function sanitizeMessage(message: string): string {
  return truncateString(String(message ?? ""), MAX_MESSAGE_LENGTH);
}

/** 把输入归一化成完整 LogEntry。 */
function toEntry(input: LogAppendInput, pluginId: string): LogEntry {
  return {
    id: makeId(),
    ts: input.ts ?? nowIso(),
    level: input.level,
    pluginId,
    scope: String(input.scope ?? ""),
    event: String(input.event ?? ""),
    message: sanitizeMessage(input.message),
    data: sanitizeData(input.data),
    keyScope: input.keyScope,
    error: sanitizeError(input.error)
  };
}

function rowToEntry(row: LogEntryRow): LogEntry {
  return {
    id: row.id,
    ts: row.ts,
    level: row.level as LogLevel,
    pluginId: row.pluginId,
    scope: row.scope,
    event: row.event,
    message: row.message,
    data: row.data,
    keyScope: row.keyScope,
    error: row.error
  };
}

function matchesQuery(entry: LogEntry, q: LogQuery): boolean {
  if (q.pluginId && entry.pluginId !== q.pluginId) return false;
  if (q.level && entry.level !== q.level) return false;
  if (q.from && entry.ts < q.from) return false;
  if (q.to && entry.ts > q.to) return false;
  if (q.scopePrefix && !entry.scope.startsWith(q.scopePrefix)) return false;
  if (q.keyword) {
    const kw = q.keyword.toLowerCase();
    const hay = `${entry.message} ${entry.event} ${entry.scope}`.toLowerCase();
    if (!hay.includes(kw)) return false;
  }
  return true;
}

function matchesClear(entry: LogEntry, q: LogClearQuery): boolean {
  if (q.pluginId && entry.pluginId !== q.pluginId) return false;
  if (q.level && entry.level !== q.level) return false;
  if (q.olderThan && entry.ts >= q.olderThan) return false;
  return true;
}

export interface CreateLogServiceOptions {
  /**
   * 初始配置；缺省使用 DEFAULT_LOG_CONFIG。
   * service 第一次 getConfig 时会尝试从 DB 读；DB 还不存在时使用 init。
   */
  init?: LogConfig;
  /**
   * 写库失败时调用：仅用于一次性 console.error 提示。
   * 设计缘由：日志写失败不能反向阻断业务，但开发环境需要看见。
   */
  onWriteError?: (err: unknown) => void;
  /**
   * 测试夹具：跳过构造结束时的 best-effort 启动 prune。
   * 生产代码不应使用；本选项仅供单测避免误删历史 fixture。
   */
  skipStartupPrune?: boolean;
}

export interface LogServiceHandle extends LogService {
  /** 关闭 db 句柄并清掉 listeners；仅测试 / dispose 使用。 */
  dispose(): void;
}

export function createLogService(options: CreateLogServiceOptions = {}): LogServiceHandle {
  let config: LogConfig = { ...(options.init ?? DEFAULT_LOG_CONFIG) };
  const listeners = new Set<(c: LogConfig) => void>();
  const onWriteError = options.onWriteError ?? ((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error("[log] persist failed", err);
  });

  // 共享 in-flight Promise：所有调用 await 同一个 Promise。
  // 修复前用布尔 `initialized` 短路，后续 append/list/updateConfig 在首次
  // ensureInit 还没完成时就立刻返回，会基于默认 config 做判断 / 写操作，
  // 错过 DB 真值（debugEnabled / retentionDays）。改成共享 Promise 后，
  // 任意调用方在 DB 读取完成前都会被挂起，等首次 init 落定才继续。
  let initPromise: Promise<void> | null = null;
  function ensureInit(): Promise<void> {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      let shouldEmit = false;
      try {
        const row = await getConfigRow();
        if (row) {
          const next: LogConfig = {
            retentionDays: typeof row.retentionDays === "number" ? row.retentionDays : config.retentionDays,
            debugEnabled: Boolean(row.debugEnabled)
          };
          // 仅在 DB 真值与 init 不一致时更新并通知订阅者；避免每次启动
          // 都推送一次等价事件。
          if (next.retentionDays !== config.retentionDays || next.debugEnabled !== config.debugEnabled) {
            config = next;
            shouldEmit = true;
          }
        } else {
          // 第一次使用：把当前 config 持久化。
          await persistConfig();
        }
      } catch (err) {
        onWriteError(err);
      }
      if (shouldEmit) emitConfigChange();
    })();
    return initPromise;
  }
  /** 强制重新从 DB 读取（清掉 initPromise 缓存）；测试 / dispose 后用。 */
  function resetInit(): void {
    initPromise = null;
  }

  async function persistConfig(): Promise<void> {
    const row: LogConfigRow = {
      id: "singleton",
      retentionDays: config.retentionDays,
      debugEnabled: config.debugEnabled
    };
    try {
      await putConfigRow(row);
    } catch (err) {
      onWriteError(err);
    }
  }

  function emitConfigChange(): void {
    for (const l of listeners) {
      try {
        l(config);
      } catch (err) {
        onWriteError(err);
      }
    }
  }

  async function pruneIfRetentionShrunk(prevRetention: number): Promise<void> {
    if (config.retentionDays >= prevRetention) return;
    try {
      const cutoffMs = Date.now() - config.retentionDays * 24 * 60 * 60 * 1000;
      if (!Number.isFinite(cutoffMs)) return;
      const cutoff = new Date(cutoffMs).toISOString();
      await deleteWhere((row) => row.ts < cutoff);
    } catch (err) {
      onWriteError(err);
    }
  }

  async function appendInternal(input: LogAppendInput): Promise<void> {
    await ensureInit();
    // debug 关闭时直接 no-op；不写库、不排队。
    if (input.level === "debug" && !config.debugEnabled) {
      return;
    }
    const entry = toEntry(input, input.pluginId ?? "runtime");
    try {
      await putEntry(entry);
    } catch (err) {
      // 关键：日志写失败不能反向阻断业务。
      onWriteError(err);
    }
  }

  function makeLogger(pluginId: string, baseScope: string): PluginLogger {
    function fullScope(child: string | undefined): string {
      if (!child) return baseScope;
      if (!baseScope) return child;
      return `${baseScope}.${child}`;
    }
    function build(childScope: string | undefined): PluginLogger {
      // child 自身的 scope：仅当 child 已经被显式 child(...) 时才视为
      // "logger 自己的 scope 声明"。baseScope = "" 时 logger 没有自带
      // scope，调用方传 input.scope 仍然有效。
      const ownScope = childScope ?? (baseScope || undefined);
      function composeScope(inputScope: string | undefined): string {
        if (ownScope) {
          // 已经有 logger / child 的 scope 声明；input.scope 拼到 ownScope 之后。
          if (inputScope) return `${ownScope}.${inputScope}`;
          return ownScope;
        }
        // logger 没有自带 scope；只采用 input.scope（不写空串，避免统一日志
        // /settings/logs 出现大量 scope="" 的噪音行）。
        return inputScope ?? "";
      }
      function write(level: LogLevel, input: LogWriteInput): void {
        // 关键：debug 判断也要等 ensureInit 完成；否则首次 init 未结束时
        // 会基于默认 debugEnabled=false 把用户的 debug 调用直接丢掉。
        // 整体仍走 fire-and-forget：业务侧 logger.debug() 同步返回，
        // 内部 await 一次确保 DB 真值。
        void (async () => {
          await ensureInit();
          if (level === "debug" && !config.debugEnabled) return;
          const entry: LogAppendInput = {
            level,
            pluginId,
            scope: composeScope(input.scope),
            event: input.event,
            message: input.message,
            data: input.data,
            keyScope: input.keyScope,
            error: input.error
          };
          // 业务侧不等；append 内部吞掉错误。
          void appendInternal(entry);
        })();
      }
      return {
        debug: (i) => write("debug", i),
        info: (i) => write("info", i),
        warn: (i) => write("warn", i),
        error: (i) => write("error", i),
        child(scope: string) {
          return build(fullScope(scope));
        }
      };
    }
    return build(undefined);
  }

  const service: LogServiceHandle = {
    getConfig() {
      return { ...config };
    },

    async updateConfig(patch) {
      // 关键顺序：先 await ensureInit 让内存 config 与 DB 真值对齐；
      // 然后再读取 / 合并 patch。否则首次 init 还没完成时，patch 会基于
      // 默认 init 计算，init 完成后反而用 DB 真值覆盖用户的 update。
      await ensureInit();
      const prevRetention = config.retentionDays;
      const next: LogConfig = {
        retentionDays:
          typeof patch.retentionDays === "number" && Number.isFinite(patch.retentionDays) && patch.retentionDays > 0
            ? Math.floor(patch.retentionDays)
            : config.retentionDays,
        debugEnabled:
          typeof patch.debugEnabled === "boolean" ? patch.debugEnabled : config.debugEnabled
      };
      config = next;
      await persistConfig();
      emitConfigChange();
      void pruneIfRetentionShrunk(prevRetention);
      return { ...config };
    },

    async listEntries(query) {
      await ensureInit();
      const q = query ?? {};
      const limit = typeof q.limit === "number" && q.limit > 0 ? q.limit : 200;
      const desc = q.descending !== false;
      try {
        const rows = await listAllEntries();
        const out: LogEntry[] = [];
        for (const row of rows) {
          if (matchesQuery(rowToEntry(row), q)) {
            out.push(rowToEntry(row));
            if (out.length >= limit) break;
          }
        }
        if (!desc) out.reverse();
        return out;
      } catch (err) {
        onWriteError(err);
        return [];
      }
    },

    append(input) {
      return appendInternal(input);
    },

    async clearEntries(query) {
      await ensureInit();
      const q = query ?? {};
      // 安全兜底：必须至少有一个限制条件。
      if (!q.pluginId && !q.level && !q.olderThan) {
        throw new Error("clearEntries requires at least one of: pluginId, level, olderThan");
      }
      try {
        const removed = await deleteWhere((row) => matchesClear(rowToEntry(row), q));
        return removed;
      } catch (err) {
        onWriteError(err);
        return 0;
      }
    },

    async clearAllEntries() {
      await ensureInit();
      try {
        const removed = await deleteWhere(() => true);
        return removed;
      } catch (err) {
        onWriteError(err);
        return 0;
      }
    },

    async pruneExpired(now) {
      await ensureInit();
      const nowStr = now ?? nowIso();
      const cutoffMs = Date.parse(nowStr) - config.retentionDays * 24 * 60 * 60 * 1000;
      if (!Number.isFinite(cutoffMs)) return 0;
      const cutoff = new Date(cutoffMs).toISOString();
      try {
        const removed = await deleteWhere((row) => row.ts < cutoff);
        return removed;
      } catch (err) {
        onWriteError(err);
        return 0;
      }
    },

    forPlugin(pluginId, baseScope) {
      return makeLogger(pluginId, baseScope ?? "");
    },

    onConfigChange(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },

    dispose() {
      listeners.clear();
      void disposeLogDb();
    }
  };

  // 触发一次 ensureInit（不等待）。第一次 append / list 时也会兜底 init。
  // ensureInit 完成后 best-effort 做一次启动 prune，遵循施工单
  // "retentionDays 过期删除是 best-effort，不因为清理失败阻断系统启动"
  // 的语义。失败只走 onWriteError，不冒泡。
  //
  // 顺序：先 ensureInit 让 DB 真值与内存对齐；再 prune。
  // skipStartupPrune 仅跳过 prune；ensureInit 仍然要跑，否则内存 config
  // 一直是 init 值，订阅者也收不到 DB 真值。
  void (async () => {
    await ensureInit();
    if (options.skipStartupPrune) return;
    try {
      const cutoffMs = Date.now() - config.retentionDays * 24 * 60 * 60 * 1000;
      if (!Number.isFinite(cutoffMs)) return;
      const cutoff = new Date(cutoffMs).toISOString();
      await deleteWhere((row) => row.ts < cutoff);
    } catch (err) {
      onWriteError(err);
    }
  })();

  return service;
}

// 抑制 unused 警告：listByPlugin 仅供未来扩展清理工具使用，本期不消费。
void listByPlugin;
void LOG_STORE_ENTRIES;

// 类型守卫 / 帮助：明确 LogListItem 别名。
export type { LogListItem };
