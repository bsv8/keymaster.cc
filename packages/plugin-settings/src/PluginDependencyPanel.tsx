// packages/plugin-settings/src/PluginDependencyPanel.tsx
// 极简依赖图预览：只展示"我依赖谁 / 被谁依赖"，
// 不做 enable / disable 操作；操作在 PluginManagerPage 完成。

import { useMemo } from "react";
import { useI18n, usePluginRuntime } from "@keymaster/runtime";

export function PluginDependencyPanel({ pluginId }: { pluginId: string }) {
  const runtime = usePluginRuntime();
  const { t } = useI18n();
  const graph = useMemo(() => runtime.graph(), [runtime, runtime.version()]);
  const deps = graph.dependencies[pluginId] ?? [];
  const reverse = runtime.reverseDeps(pluginId);

  return (
    <div className="plugin-dep-panel">
      <h4>{t("pluginManager.dep.title", { defaultValue: "Dependencies" })}</h4>
      <p>
        {t("pluginManager.dep.dependsOn", { defaultValue: "Depends on" })}:{" "}
        {deps.length === 0 ? (
          <em>—</em>
        ) : (
          deps.map((c) => (
            <code key={c} className="plugin-card__cap">
              {c}
            </code>
          ))
        )}
      </p>
      <p>
        {t("pluginManager.dep.usedBy", { defaultValue: "Used by" })}:{" "}
        {reverse.length === 0 ? (
          <em>—</em>
        ) : (
          reverse.map((d) => (
            <span
              key={d.pluginId}
              className={`plugin-card__dep ${d.enabled ? "is-on" : "is-off"}`}
            >
              {d.pluginId}
            </span>
          ))
        )}
      </p>
    </div>
  );
}
