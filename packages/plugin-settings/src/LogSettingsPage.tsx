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
//   - 不为某个插件开专属 store / 专属 DB / 专属设置。
//   - 列表只展示统一 LogEntry schema，不解析任何业务"扩展字段"。
//   - 清理操作必须让用户明确知道影响范围（pluginId / level / 全部）。

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, PageHeader, TextInput } from "@keymaster/ui";
import { useI18n } from "@keymaster/runtime";
import {
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

export function LogSettingsPage() {
  const { t } = useI18n();
  const log = useCapability<LogService>(LOG_SERVICE_CAPABILITY);

  // 配置：本地草稿；保存后写入 service。
  const [configDraft, setConfigDraft] = useState<LogConfig>(() => log.getConfig());
  const [savedConfig, setSavedConfig] = useState<LogConfig>(() => log.getConfig());
  const [configDirty, setConfigDirty] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);

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

  // 订阅 config 变化：其它标签页 / 自身保存后刷新。
  useEffect(() => {
    const off = log.onConfigChange((c) => {
      setConfigDraft(c);
      setSavedConfig(c);
      setConfigDirty(false);
    });
    return off;
  }, [log]);

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

  // query 变化自动 refresh；config 变化也 refresh（debug toggle 后已存在的列表是 stale）。
  useEffect(() => {
    void refresh();
  }, [refresh, savedConfig]);

  function updateConfigDraft(patch: Partial<LogConfig>) {
    setConfigDraft((prev) => ({ ...prev, ...patch }));
    setConfigDirty(true);
  }

  async function saveConfig() {
    setBusy(true);
    setConfigError(null);
    try {
      const next = await log.updateConfig({
        retentionDays: Math.max(1, Math.floor(configDraft.retentionDays)),
        debugEnabled: configDraft.debugEnabled
      });
      setSavedConfig(next);
      setConfigDraft(next);
      setConfigDirty(false);
    } catch (err) {
      setConfigError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

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

  async function pruneNow() {
    setBusy(true);
    setClearedHint(null);
    try {
      const removed = await log.pruneExpired();
      setClearedHint(
        t("logSettings.pruned", {
          defaultValue: `Pruned ${removed} expired entries`
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
            "Inspect and configure the unified system log. Plugins record their activity via ctx.logger; entries are stored in a single global IndexedDB."
        })}
      />

      <section className="log-settings-card">
        <h2 className="log-settings-card__title">
          {t("logSettings.config.title", { defaultValue: "Configuration" })}
        </h2>
        <p className="log-settings-card__hint">
          {t("logSettings.config.retentionHint", {
            defaultValue:
              "Retention applies to all entries. Decreasing the value prunes the oldest entries immediately (best-effort)."
          })}
        </p>
        <div className="log-settings-config">
          <label className="log-settings-toggle">
            <input
              type="checkbox"
              checked={configDraft.debugEnabled}
              onChange={(e) => updateConfigDraft({ debugEnabled: e.target.checked })}
            />
            <span>
              {t("logSettings.config.debug", { defaultValue: "Enable debug logs" })}
            </span>
          </label>
          <p className="log-settings-card__hint">
            {t("logSettings.config.debugHint", {
              defaultValue:
                "Debug is off by default. When off, logger.debug() does not write to storage. Turning it on affects future entries only — past debug entries are not back-filled."
            })}
          </p>
          <TextInput
            type="number"
            min={1}
            step={1}
            value={String(configDraft.retentionDays)}
            label={t("logSettings.config.retention", { defaultValue: "Retention (days)" })}
            onChange={(e) => {
              const v = Number(e.currentTarget.value);
              if (Number.isFinite(v) && v > 0) {
                updateConfigDraft({ retentionDays: Math.floor(v) });
              }
            }}
          />
          <div className="log-settings-actions">
            <Button
              size="sm"
              onClick={saveConfig}
              disabled={busy || !configDirty}
              loading={busy && configDirty}
            >
              {t("logSettings.config.save", { defaultValue: "Save" })}
            </Button>
            <Button size="sm" variant="ghost" onClick={pruneNow} disabled={busy}>
              {t("logSettings.config.pruneNow", { defaultValue: "Prune now" })}
            </Button>
          </div>
          {configError ? <p className="log-settings-card__error">{configError}</p> : null}
        </div>
      </section>

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
                      <code>{e.keyScope.publicKeyHex.slice(0, 16)}…</code>
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
