// packages/plugin-settings/src/LogSettingsPage.tsx
// 系统级统一日志页：/settings/logs（施工单 002 硬切换）。
//
// 设计缘由：
//   - 唯一正式日志查看入口。业务插件不得再做"自己的日志页"。
//   - 只通过 ctx.get("log.service") 访问日志能力，**不** import 任何业务插件
//     内部日志类型 / 解析器。
//   - 文案中文，错误原文英文。
//   - debug 关闭时 UI 必须显式说明：debug 不写库、开启后只对未来日志生效。
//
// 关键不变量：
//   - 不为某个插件开专属 store / 专属 K-V / 专属设置。
//   - 列表只展示统一 LogEntry schema，不解析任何业务"扩展字段"。
//   - 清理操作必须让用户明确知道影响范围（pluginId / level / 全部）。

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, PageHeader, TextInput } from "@keymaster/ui";
import { useI18n } from "@keymaster/runtime";
import {
  formatShortPublicKey,
  LOG_SERVICE_CAPABILITY,
  type LogConfig,
  type LogEntry,
  type LogLevel,
  type LogQuery,
  type LogService
} from "@keymaster/contracts";
import { useCapability } from "@keymaster/runtime";

const LEVELS: ReadonlyArray<LogLevel> = ["debug", "info", "warn", "error"];

function formatTs(ts: string): string {
  // 简化为本地时区展示；不做相对时间，避免语言切换时跳变。
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString();
}

function describeEntry(entry: LogEntry): string {
  return entry.message || `${entry.event}`;
}

function summaryFor(entry: LogEntry): string | null {
  if (entry.data && typeof entry.data === "object") {
    const obj = entry.data as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return null;
    return keys
      .slice(0, 6)
      .map((k) => {
        const v = obj[k];
        if (v === undefined || v === null) return `${k}=`;
        if (typeof v === "string") return `${k}=${v.length > 32 ? `${v.slice(0, 32)}…` : v}`;
        if (typeof v === "object") return `${k}=${JSON.stringify(v).slice(0, 32)}`;
        return `${k}=${String(v)}`;
      })
      .join("  ");
  }
  return null;
}

/** 系统页中的日志配置设置；每项变更均立即写入统一日志服务。 */
export function LogConfigurationSettings() {
  const { t } = useI18n();
  const log = useCapability<LogService>(LOG_SERVICE_CAPABILITY);
  const [config, setConfig] = useState<LogConfig>(() => log.getConfig());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => log.onConfigChange(setConfig), [log]);

  function applyConfig(patch: Partial<LogConfig>) {
    const next = {
      ...config,
      ...patch,
      retentionDays: Math.max(1, Math.floor((patch.retentionDays ?? config.retentionDays)))
    };
    setConfig(next);
    setBusy(true);
    setError(null);
    void log.updateConfig(next).then(setConfig).catch((err: unknown) => {
      setConfig(log.getConfig());
      setError(err instanceof Error ? err.message : String(err));
    }).finally(() => setBusy(false));
  }

  function pruneNow() {
    setBusy(true);
    setError(null);
    void log.pruneExpired().catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    }).finally(() => setBusy(false));
  }

  return (
    <div className="log-settings-config">
      <p className="log-settings-card__hint">
        {t("logSettings.config.retentionHint", {
          defaultValue: "Retention applies to all entries. Decreasing the value prunes the oldest entries immediately (best-effort)."
        })}
      </p>
      <label className="log-settings-toggle">
        <input
          type="checkbox"
          checked={config.debugEnabled}
          disabled={busy}
          onChange={(e) => applyConfig({ debugEnabled: e.target.checked })}
        />
        <span>{t("logSettings.config.debug", { defaultValue: "Enable debug logs" })}</span>
      </label>
      <p className="log-settings-card__hint">
        {t("logSettings.config.debugHint", {
          defaultValue: "Debug is off by default. When off, logger.debug() does not write to storage."
        })}
      </p>
      <TextInput
        type="number"
        min={1}
        step={1}
        value={String(config.retentionDays)}
        disabled={busy}
        label={t("logSettings.config.retention", { defaultValue: "Retention (days)" })}
        onChange={(e) => {
          const value = Number(e.currentTarget.value);
          if (Number.isFinite(value) && value > 0) applyConfig({ retentionDays: value });
        }}
      />
      <div className="log-settings-actions">
        <Button size="sm" variant="ghost" onClick={pruneNow} disabled={busy}>
          {t("logSettings.config.pruneNow", { defaultValue: "Prune now" })}
        </Button>
      </div>
      {error ? <p className="log-settings-card__error">{error}</p> : null}
    </div>
  );
}

export function LogSettingsPage() {
  const { t } = useI18n();
  const log = useCapability<LogService>(LOG_SERVICE_CAPABILITY);

  // 过滤条件
  const [filterPluginId, setFilterPluginId] = useState("");
  const [filterLevel, setFilterLevel] = useState<"" | LogLevel>("");
  const [filterKeyword, setFilterKeyword] = useState("");

  // 列表 / 加载
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 展开 / 清理反馈
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [clearedHint, setClearedHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const query = useMemo<LogQuery>(() => {
    const q: LogQuery = { limit: 200 };
    if (filterPluginId.trim()) q.pluginId = filterPluginId.trim();
    if (filterLevel) q.level = filterLevel;
    if (filterKeyword.trim()) q.keyword = filterKeyword.trim();
    return q;
  }, [filterPluginId, filterLevel, filterKeyword]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const list = await log.listEntries(query);
      setEntries(list);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [log, query]);

  // query 变化自动 refresh。
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function clearWith(predicate: { pluginId?: string; level?: LogLevel }) {
    setBusy(true);
    setClearedHint(null);
    try {
      const removed = await log.clearEntries(predicate);
      setClearedHint(
        t("logSettings.cleared", {
          defaultValue: `Cleared ${removed} entries`
        }).replace("${removed}", String(removed))
      );
      await refresh();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function clearAll() {
    setBusy(true);
    setClearedHint(null);
    try {
      const removed = await log.clearAllEntries();
      setClearedHint(
        t("logSettings.cleared", {
          defaultValue: `Cleared ${removed} entries`
        }).replace("${removed}", String(removed))
      );
      await refresh();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }


  const filterPredicate = useMemo(
    () => ({
      pluginId: filterPluginId.trim() || undefined,
      level: filterLevel || undefined
    }),
    [filterPluginId, filterLevel]
  );

  return (
    <div className="log-settings-page">
      <PageHeader
        title={t("logSettings.title", { defaultValue: "System logs" })}
        description={t("logSettings.description", {
          defaultValue:
            "Inspect and configure the unified system log. Plugins record their activity via ctx.logger; entries are stored in a single global platform K-V repository."
        })}
      />

      <section className="log-settings-card">
        <h2 className="log-settings-card__title">
          {t("logSettings.filter.title", { defaultValue: "Filters" })}
        </h2>
        <div className="log-settings-filters">
          <TextInput
            label={t("logSettings.filter.pluginId", { defaultValue: "Plugin id" })}
            placeholder={t("logSettings.filter.pluginIdPh", { defaultValue: "e.g. woc, p2pkh, runtime" })}
            value={filterPluginId}
            onChange={(e) => setFilterPluginId(e.currentTarget.value)}
          />
          <label className="log-settings-field">
            <span className="log-settings-field__label">
              {t("logSettings.filter.level", { defaultValue: "Level" })}
            </span>
            <select
              className="log-settings-select"
              value={filterLevel}
              onChange={(e) => setFilterLevel((e.currentTarget.value as LogLevel | "") || "")}
            >
              <option value="">
                {t("logSettings.filter.levelAll", { defaultValue: "All" })}
              </option>
              {LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <TextInput
            label={t("logSettings.filter.keyword", { defaultValue: "Keyword" })}
            placeholder={t("logSettings.filter.keywordPh", {
              defaultValue: "Match message / event / scope"
            })}
            value={filterKeyword}
            onChange={(e) => setFilterKeyword(e.currentTarget.value)}
          />
        </div>
        <div className="log-settings-actions">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => clearWith(filterPredicate)}
            disabled={busy || (!filterPredicate.pluginId && !filterPredicate.level)}
            title={
              !filterPredicate.pluginId && !filterPredicate.level
                ? t("logSettings.filter.needOne", {
                    defaultValue: "Set a plugin id or level first"
                  })
                : undefined
            }
          >
            {t("logSettings.actions.clearFiltered", { defaultValue: "Clear filtered" })}
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => {
              if (window.confirm(t("logSettings.actions.clearAllConfirm", { defaultValue: "Clear ALL log entries? This cannot be undone." }))) {
                void clearAll();
              }
            }}
            disabled={busy}
          >
            {t("logSettings.actions.clearAll", { defaultValue: "Clear all" })}
          </Button>
        </div>
      </section>

      {clearedHint ? <p className="log-settings-card__hint">{clearedHint}</p> : null}
      {loadError ? <p className="log-settings-card__error">{loadError}</p> : null}

      <section className="log-settings-card">
        <h2 className="log-settings-card__title">
          {t("logSettings.list.title", { defaultValue: "Entries" })}
          <span className="log-settings-card__count">{entries.length}</span>
        </h2>
        {loading ? (
          <p className="log-settings-card__hint">
            {t("common.status.loading", { defaultValue: "Loading…" })}
          </p>
        ) : entries.length === 0 ? (
          <p className="log-settings-card__hint">
            {t("logSettings.list.empty", { defaultValue: "No entries match the current filters." })}
          </p>
        ) : (
          <ul className="log-settings-list">
            {entries.map((e) => {
              const isOpen = expanded[e.id] === true;
              const summary = summaryFor(e);
              return (
                <li key={e.id} className={`log-entry log-entry--${e.level}`}>
                  <div className="log-entry__head">
                    <span className={`log-entry__level log-entry__level--${e.level}`}>
                      {e.level}
                    </span>
                    <span className="log-entry__ts">{formatTs(e.ts)}</span>
                    <code className="log-entry__plugin">{e.pluginId}</code>
                    <code className="log-entry__scope">
                      {e.scope}
                      {e.event ? ` / ${e.event}` : ""}
                    </code>
                  </div>
                  <div className="log-entry__msg">{describeEntry(e)}</div>
                  {summary ? <div className="log-entry__summary">{summary}</div> : null}
                  {e.keyScope?.publicKeyHex ? (
                    <div className="log-entry__key">
                      <span className="muted">key</span>{" "}
                      <code>{formatShortPublicKey(e.keyScope.publicKeyHex)}</code>
                    </div>
                  ) : null}
                  <div className="log-entry__actions">
                    {(e.data || e.error) ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setExpanded((prev) => ({ ...prev, [e.id]: !isOpen }))
                        }
                        aria-expanded={isOpen}
                      >
                        {isOpen
                          ? t("logSettings.entry.hide", { defaultValue: "Hide" })
                          : t("logSettings.entry.details", { defaultValue: "Details" })}
                      </Button>
                    ) : null}
                  </div>
                  {isOpen ? (
                    <dl className="log-entry__detail">
                      {e.data ? (
                        <div>
                          <dt>{t("logSettings.entry.data", { defaultValue: "data" })}</dt>
                          <dd>
                            <pre className="log-entry__pre">{JSON.stringify(e.data, null, 2)}</pre>
                          </dd>
                        </div>
                      ) : null}
                      {e.error ? (
                        <div>
                          <dt>{t("logSettings.entry.error", { defaultValue: "error" })}</dt>
                          <dd>
                            <pre className="log-entry__pre">
                              {[
                                e.error.name ? `${e.error.name}: ` : "",
                                e.error.message,
                                e.error.stack ? `\n${e.error.stack}` : ""
                              ].join("")}
                            </pre>
                          </dd>
                        </div>
                      ) : null}
                    </dl>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
