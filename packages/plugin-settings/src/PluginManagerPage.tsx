// packages/plugin-settings/src/PluginManagerPage.tsx
// 系统级插件管理页：列出所有 plugin manifest，按依赖图展示
// - 名称、描述
// - 当前状态（enabled / disabled / blocked / error-disabled）
// - 是否允许禁用
// - 提供 capability、依赖 capability
// - 反向依赖它的启用中插件（禁用时由 Host 自动级联停止）
// - 启停按钮
//
// 设计原则（硬切换 001 + 002）：
//   - 不做自动依赖 enable / disable；
//   - 反向依赖只用于展示受影响列表，disable 由 Host 自动级联；
//   - canDisable=false 时禁用按钮置灰；
//   - 当前路由属于被 disable 的 plugin 时，由 host 负责先跳走；本页不重复处理。
//   - 信息层级"先可扫描，再展开细节"：默认只渲染 name / group / state /
//     action；provides / depends / reverse / blockers 进可折叠明细区。
//   - 不在 /settings 聚合页中渲染本组件（硬切换 002）；本组件只由
//     /settings/plugins 路由加载。

import { useMemo, useState } from "react";
import { Button, PageHeader } from "@keymaster/ui";
import { useI18n, usePluginRuntime } from "@keymaster/runtime";
import type { PluginHost } from "@keymaster/runtime";
import type { PluginGraph, PluginManifest, PluginReverseDep, PluginStateKind } from "@keymaster/contracts";

function describeState(s: PluginStateKind): { key: string; cls: string } {
  switch (s) {
    case "enabled":
      return { key: "pluginManager.state.enabled", cls: "pm-state pm-state--on" };
    case "starting":
      return { key: "pluginManager.state.starting", cls: "pm-state pm-state--warn" };
    case "stopping":
      return { key: "pluginManager.state.stopping", cls: "pm-state pm-state--warn" };
    case "disabled":
      return { key: "pluginManager.state.disabled", cls: "pm-state pm-state--off" };
    case "blocked":
      return { key: "pluginManager.state.blocked", cls: "pm-state pm-state--warn" };
    case "error-disabled":
      return { key: "pluginManager.state.errorDisabled", cls: "pm-state pm-state--err" };
    case "cleanup-pending":
      return { key: "pluginManager.state.cleanupPending", cls: "pm-state pm-state--err" };
    case "unknown":
      return { key: "pluginManager.state.unknown", cls: "pm-state pm-state--warn" };
    case "registered":
      return { key: "pluginManager.state.registered", cls: "pm-state" };
  }
}

function groupLabel(g: string | undefined, t: (k: string) => string): string {
  if (!g) return t("pluginManager.group.other");
  return t(`pluginManager.group.${g}`);
}

export function PluginManagerPage() {
  const runtime = usePluginRuntime();
  const { t } = useI18n();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 默认收起所有 plugin 的明细，符合"先可扫描"原则。
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const graph = useMemo<PluginGraph>(() => runtime.graph(), [runtime, runtime.version()]);
  const ids = graph.plugins;

  // 按 displayGroup 排序；同组内按 id 字典序
  const sorted = useMemo(() => {
    return [...ids]
      .map((id) => runtime.getManifest(id))
      .filter((m): m is PluginManifest => Boolean(m))
      .filter((m) => m.meta?.canDisable === true)
      .sort((a, b) => {
        const ga = a.meta?.displayGroup ?? a.meta?.kind ?? "business";
        const gb = b.meta?.displayGroup ?? b.meta?.kind ?? "business";
        if (ga !== gb) return ga.localeCompare(gb);
        return a.id.localeCompare(b.id);
      });
  }, [ids, runtime, runtime.version()]);

  async function doEnable(id: string) {
    setError(null);
    setBusyId(id);
    try {
      const result = await runtime.submitIntent(id, true);
      if (result.status !== "accepted" && result.status !== "duplicate") {
        setError(intentResultMessage(result));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function doDisable(id: string) {
    setError(null);
    setBusyId(id);
    try {
      const result = await runtime.submitIntent(id, false);
      if (result.status !== "accepted" && result.status !== "duplicate") {
        setError(intentResultMessage(result));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="plugin-manager">
      <PageHeader
        title={t("pluginManager.title", { defaultValue: "Plugins" })}
        description={t("pluginManager.description", {
          defaultValue:
            "Manage enabled optional plugins. System modules are always available and are not listed here."
        })}
      />
      {error ? <div className="plugin-manager__error">{error}</div> : null}
      <div className="plugin-manager__list">
        {sorted.map((m) => {
          const state = runtime.state(m.id);
          const d = describeState(state.kind);
          const enabled = state.kind === "enabled";
          const activeLike = state.kind === "enabled" || state.kind === "starting" || state.kind === "stopping";
          const transitionInProgress = state.kind === "starting" || state.kind === "stopping";
          const canDisable = m.meta?.canDisable !== false;
          const deps = graph.dependencies[m.id] ?? [];
          const provides = graph.provides[m.id] ?? [];
          const reverse = runtime.reverseDeps(m.id);
          const affectedDependents = reverse.filter((d) => d.enabled);
          // 依赖列表里是 capability key（如 "route.registry"），不是 plugin id。
          // 必须用 host.capabilities.has() 判断；不能误用 getManifest(pluginId)。
          const optionalDeps = new Set(graph.optionalDependencies?.[m.id] ?? []);
          const missingDeps = deps.filter((c) => !optionalDeps.has(c) && !runtime.hasCapability(c));
          const depsSatisfied = missingDeps.length === 0;
          const pageUnits = state.units?.filter((unit) => unit.runtime === "window-main") ?? [];
          const backendUnits = state.units?.filter((unit) => unit.runtime === "shared-worker") ?? [];
          const isOpen = expanded[m.id] === true;
          const hasDetails =
            provides.length > 0 || deps.length > 0 || reverse.length > 0 || affectedDependents.length > 0
            || pageUnits.length > 0 || backendUnits.length > 0;
          return (
            <article
              key={m.id}
              className={`plugin-card ${enabled ? "is-on" : "is-off"} ${
                state.kind === "error-disabled" ? "is-err" : ""
              }`}
              data-plugin-id={m.id}
            >
              <header className="plugin-card__head">
                <div className="plugin-card__title">
                  <h3>{m.name}</h3>
                  <span className="plugin-card__id">
                    <code>{m.id}</code>
                  </span>
                  <span className="plugin-card__group">
                    {groupLabel(m.meta?.displayGroup ?? m.meta?.kind, (k) =>
                      t(k, { defaultValue: m.meta?.displayGroup ?? m.meta?.kind ?? "other" })
                    )}
                  </span>
                </div>
                <div className={d.cls}>
                  {t(d.key, { defaultValue: d.key.split(".").pop() ?? d.key })}
                </div>
              </header>
              {m.description ? <p className="plugin-card__desc">{m.description}</p> : null}
              {state.error ? (
                <p className="plugin-card__error">
                  {t("pluginManager.error", { defaultValue: "Error" })}: {state.error}
                </p>
              ) : null}
              {state.desiredEnabled !== undefined && state.desiredEnabled !== enabled ? (
                <p className="plugin-card__blockers-line">
                  {t("pluginManager.state.intentPending", { defaultValue: "Enable intent is pending runtime state" })}
                </p>
              ) : null}
              {affectedDependents.length > 0 ? (
                <p className="plugin-card__blockers-line">
                  <span className="pm-state pm-state--warn">{t("pluginManager.meta.cascade", { defaultValue: "Will stop dependents" })}</span>
                  <span className="plugin-card__blockers-list">
                    {affectedDependents.map((b) => (
                      <span key={b.pluginId} className="plugin-card__dep is-on">{b.pluginId}</span>
                    ))}
                  </span>
                </p>
              ) : null}
              <footer className="plugin-card__actions">
                {activeLike ? (
                  <Button
                    size="sm"
                    variant="danger"
                    loading={transitionInProgress && busyId === m.id}
                    disabled={busyId === m.id || transitionInProgress || !canDisable}
                    onClick={() => doDisable(m.id)}
                    title={
                      !canDisable
                        ? "canDisable=false"
                        : affectedDependents.length > 0
                          ? t("pluginManager.meta.cascadeHint", { defaultValue: "Disabling this plugin will stop the listed dependents; their enable intent is preserved." })
                          : undefined
                    }
                  >
                    {t("pluginManager.action.disable", { defaultValue: "Disable" })}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    loading={busyId === m.id}
                    onClick={() => doEnable(m.id)}
                    disabled={busyId === m.id || !depsSatisfied}
                    title={
                      !depsSatisfied
                        ? t("pluginManager.dep.missing", {
                            defaultValue: "Missing dependencies: " + missingDeps.join(", ")
                          })
                        : undefined
                    }
                  >
                    {t("pluginManager.action.enable", { defaultValue: "Enable" })}
                  </Button>
                )}
                {!canDisable ? (
                  <span className="plugin-card__cannot">
                    {t("pluginManager.action.cannotDisable", { defaultValue: "Cannot disable" })}
                  </span>
                ) : null}
                {hasDetails ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setExpanded((prev) => ({ ...prev, [m.id]: !isOpen }))
                    }
                    aria-expanded={isOpen}
                  >
                    {isOpen
                      ? t("pluginManager.details.hide", { defaultValue: "Hide details" })
                      : t("pluginManager.details", { defaultValue: "Details" })}
                  </Button>
                ) : null}
              </footer>
              {isOpen && hasDetails ? (
                <dl className="plugin-card__meta">
                  <div>
                    <dt>{t("pluginManager.meta.id", { defaultValue: "Id" })}</dt>
                    <dd>
                      <code>{m.id}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>{t("pluginManager.meta.provides", { defaultValue: "Provides" })}</dt>
                    <dd>
                      {provides.length === 0 ? (
                        <span className="muted">
                          {t("pluginManager.meta.none", { defaultValue: "—" })}
                        </span>
                      ) : (
                        provides.map((c) => (
                          <code key={c} className="plugin-card__cap">
                            {c}
                          </code>
                        ))
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("pluginManager.meta.depends", { defaultValue: "Depends on" })}</dt>
                    <dd>
                      {deps.length === 0 ? (
                        <span className="muted">
                          {t("pluginManager.meta.none", { defaultValue: "—" })}
                        </span>
                      ) : (
                        deps.map((c) => (
                          <code
                            key={c}
                            className={`plugin-card__cap ${missingDeps.includes(c) ? "is-missing" : ""}`}
                          >
                            {c}
                          </code>
                        ))
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("pluginManager.meta.reverse", { defaultValue: "Used by" })}</dt>
                    <dd>
                      {reverse.length === 0 ? (
                        <span className="muted">
                          {t("pluginManager.meta.none", { defaultValue: "—" })}
                        </span>
                      ) : (
                        reverse.map((rev: PluginReverseDep) => (
                          <span
                            key={rev.pluginId}
                            className={`plugin-card__dep ${rev.enabled ? "is-on" : "is-off"}`}
                            title={rev.capabilities.join(", ")}
                          >
                            {rev.pluginId}
                            {rev.enabled ? "" : " (disabled)"}
                          </span>
                        ))
                      )}
                    </dd>
                  </div>
                  {affectedDependents.length > 0 ? (
                    <div className="plugin-card__blockers">
                      <dt>
                        {t("pluginManager.meta.cascade", { defaultValue: "Will stop dependents" })}
                      </dt>
                      <dd>
                        {t("pluginManager.meta.blockersHint", {
                          defaultValue:
                            "These dependents will stop automatically and keep their enable intent."
                        })}
                        <ul>
                          {affectedDependents.map((b) => (
                            <li key={b.pluginId}>{b.pluginId}</li>
                          ))}
                        </ul>
                      </dd>
                    </div>
                  ) : null}
                  {backendUnits.length > 0 ? (
                    <div>
                      <dt>{t("pluginManager.meta.backendUnits", { defaultValue: "后台单元状态" })}</dt>
                      <dd>
                        {backendUnits.map((unit) => {
                          const unitState = describeState(unit.kind);
                          return (
                            <span key={unit.unitId} className="plugin-card__dep" title={unit.error}>
                              <code>{unit.unitId}</code>: {t(unitState.key, { defaultValue: unitState.key.split(".").pop() ?? unitState.key })}
                              {unit.instanceId ? ` (${unit.instanceId})` : ""}
                            </span>
                          );
                        })}
                      </dd>
                    </div>
                  ) : null}
                  {pageUnits.length > 0 ? (
                    <div>
                      <dt>{t("pluginManager.meta.pageUnits", { defaultValue: "当前页面单元状态" })}</dt>
                      <dd>
                        {pageUnits.map((unit) => {
                          const unitState = describeState(unit.kind);
                          return (
                            <span key={unit.unitId} className="plugin-card__dep" title={unit.error}>
                              <code>{unit.unitId}</code>: {t(unitState.key, { defaultValue: unitState.key.split(".").pop() ?? unitState.key })}
                              {unit.instanceId ? ` (${unit.instanceId})` : ""}
                            </span>
                          );
                        })}
                      </dd>
                    </div>
                  ) : null}
                </dl>
              ) : null}
            </article>
          );
        })}
      </div>
    </div>
  );
}

function intentResultMessage(result: Awaited<ReturnType<PluginHost["submitIntent"]>>): string {
  switch (result.status) {
    case "revision-conflict":
      return `启停命令修订已过期（当前修订 ${result.snapshot.revision}），请重试`;
    case "stale-authority":
      return "Coordinator 已重启，请重试";
    case "persistence-failed":
    case "command-conflict":
    case "transport-error":
      return result.message;
    default:
      return `启停命令未接受：${result.status}`;
  }
}
