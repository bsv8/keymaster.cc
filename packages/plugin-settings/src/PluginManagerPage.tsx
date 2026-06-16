// packages/plugin-settings/src/PluginManagerPage.tsx
// 系统级插件管理页：列出所有 plugin manifest，按依赖图展示
// - 名称、描述
// - 当前状态（enabled / disabled / blocked / error-disabled）
// - 是否允许禁用
// - 提供 capability、依赖 capability
// - 反向依赖它的启用中插件
// - 启停按钮 + 查看设置入口
//
// 设计原则（硬切换 001）：
//   - 不做自动依赖 enable / disable；
//   - 反向依赖阻止 disable，UI 显示阻塞者；
//   - canDisable=false 时禁用按钮置灰；
//   - 当前路由属于被 disable 的 plugin 时，由 host 负责先跳走；本页不重复处理。

import { useMemo, useState } from "react";
import { Button, PageHeader } from "@keymaster/ui";
import { useI18n, usePluginRuntime } from "@keymaster/runtime";
import type { PluginGraph, PluginManifest, PluginReverseDep, PluginStateKind } from "@keymaster/contracts";

function describeState(s: PluginStateKind): { en: string; zh: string; cls: string } {
  switch (s) {
    case "enabled":
      return { en: "Enabled", zh: "已启用", cls: "pm-state pm-state--on" };
    case "disabled":
      return { en: "Disabled", zh: "已禁用", cls: "pm-state pm-state--off" };
    case "blocked":
      return { en: "Blocked (missing dependency)", zh: "被阻塞（依赖缺失）", cls: "pm-state pm-state--warn" };
    case "error-disabled":
      return { en: "Error-disabled", zh: "错误已禁用", cls: "pm-state pm-state--err" };
    case "registered":
      return { en: "Registered", zh: "已注册", cls: "pm-state" };
  }
}

function groupLabel(g: string | undefined, t: (k: string) => string): string {
  if (!g) return t("pluginManager.group.other");
  return t(`pluginManager.group.${g}`);
}

export function PluginManagerPage() {
  const runtime = usePluginRuntime();
  const { t, language } = useI18n();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const graph = useMemo<PluginGraph>(() => runtime.graph(), [runtime, runtime.version()]);
  const ids = graph.plugins;

  // 按 displayGroup 排序；同组内按 id 字典序
  const sorted = useMemo(() => {
    return [...ids]
      .map((id) => runtime.getManifest(id))
      .filter((m): m is PluginManifest => Boolean(m))
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
      await runtime.enable(id);
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
      const r = await runtime.disable(id);
      if (!r.ok) setError(r.reason);
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
            "System-level plugin management. Changes take effect immediately. Disabled plugins are unloaded from the host."
        })}
      />
      {error ? <div className="plugin-manager__error">{error}</div> : null}
      <div className="plugin-manager__list">
        {sorted.map((m) => {
          const state = runtime.state(m.id);
          const d = describeState(state.kind);
          const enabled = state.kind === "enabled";
          const canDisable = m.meta?.canDisable !== false;
          const deps = graph.dependencies[m.id] ?? [];
          const provides = graph.provides[m.id] ?? [];
          const reverse = runtime.reverseDeps(m.id);
          const blockers = reverse.filter((d) => d.enabled);
          // 依赖列表里是 capability key（如 "route.registry"），不是 plugin id。
          // 必须用 host.capabilities.has() 判断；不能误用 getManifest(pluginId)。
          const missingDeps = deps.filter((c) => !runtime.hasCapability(c));
          const depsSatisfied = missingDeps.length === 0;
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
                  <span className="plugin-card__group">
                    {groupLabel(m.meta?.displayGroup ?? m.meta?.kind, (k) =>
                      t(k, { defaultValue: m.meta?.displayGroup ?? m.meta?.kind ?? "other" })
                    )}
                  </span>
                </div>
                <div className={d.cls}>
                  {language() === "zh-CN" ? d.zh : d.en}
                </div>
              </header>
              {m.description ? <p className="plugin-card__desc">{m.description}</p> : null}
              {state.error ? (
                <p className="plugin-card__error">
                  {t("pluginManager.error", { defaultValue: "Error" })}: {state.error}
                </p>
              ) : null}
              <dl className="plugin-card__meta">
                <div>
                  <dt>
                    {t("pluginManager.meta.id", { defaultValue: "Id" })}
                  </dt>
                  <dd>
                    <code>{m.id}</code>
                  </dd>
                </div>
                <div>
                  <dt>
                    {t("pluginManager.meta.provides", { defaultValue: "Provides" })}
                  </dt>
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
                  <dt>
                    {t("pluginManager.meta.depends", { defaultValue: "Depends on" })}
                  </dt>
                  <dd>
                    {deps.length === 0 ? (
                      <span className="muted">
                        {t("pluginManager.meta.none", { defaultValue: "—" })}
                      </span>
                    ) : (
                      deps.map((c) => (
                        <code key={c} className="plugin-card__cap">
                          {c}
                        </code>
                      ))
                    )}
                  </dd>
                </div>
                <div>
                  <dt>
                    {t("pluginManager.meta.reverse", { defaultValue: "Used by" })}
                  </dt>
                  <dd>
                    {reverse.length === 0 ? (
                      <span className="muted">
                        {t("pluginManager.meta.none", { defaultValue: "—" })}
                      </span>
                    ) : (
                      reverse.map((d: PluginReverseDep) => (
                        <span
                          key={d.pluginId}
                          className={`plugin-card__dep ${d.enabled ? "is-on" : "is-off"}`}
                          title={d.capabilities.join(", ")}
                        >
                          {d.pluginId}
                          {d.enabled ? "" : " (disabled)"}
                        </span>
                      ))
                    )}
                  </dd>
                </div>
                {blockers.length > 0 ? (
                  <div className="plugin-card__blockers">
                    <dt>
                      {t("pluginManager.meta.blockers", { defaultValue: "Blocking dependents" })}
                    </dt>
                    <dd>
                      {t("pluginManager.meta.blockersHint", {
                        defaultValue:
                          "Disable these first (or use other tooling) to disable this plugin."
                      })}
                      <ul>
                        {blockers.map((b) => (
                          <li key={b.pluginId}>{b.pluginId}</li>
                        ))}
                      </ul>
                    </dd>
                  </div>
                ) : null}
              </dl>
              <footer className="plugin-card__actions">
                {enabled ? (
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={busyId === m.id || !canDisable || blockers.length > 0}
                    onClick={() => doDisable(m.id)}
                    title={
                      !canDisable
                        ? "canDisable=false"
                        : blockers.length > 0
                          ? "Blocked by enabled dependents"
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
              </footer>
            </article>
          );
        })}
      </div>
    </div>
  );
}
