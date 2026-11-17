import { useId, useMemo, useState } from "react";
import { Button, Modal, PageHeader, TextInput } from "@keymaster/ui";
import { sanitizeDiagnosticText, sanitizeDiagnosticValue } from "@keymaster/contracts";
import { usePluginI18n } from "@keymaster/runtime";
import { useSettingsDiagnostics } from "./SettingsDiagnosticsContext.js";
import { buildDependencyGraph, FUNCTION_DEPENDENCIES, layoutDependencyGraph } from "./dependencyGraph.js";

/** 插件总览显示依赖关系；函数明细来自源码调用点，而非启停开关或运行次数。 */
export function PluginManagerPage() {
  const runtime = useSettingsDiagnostics();
  const { t } = usePluginI18n();
  const graph = useMemo(buildDependencyGraph, []);
  const layout = useMemo(() => layoutDependencyGraph(graph.nodes, graph.edges), [graph]);
  const marker = useId().replaceAll(":", "");
  const [selected, setSelected] = useState<string>();
  const [hovered, setHovered] = useState<string>();
  const [query, setQuery] = useState("");
  const [functionQuery, setFunctionQuery] = useState("");
  const [direction, setDirection] = useState<"outgoing" | "incoming">("outgoing");
  const [zoom, setZoom] = useState(1);
  const [showPageDependencies, setShowPageDependencies] = useState(false);
  const [showVaultDependencies, setShowVaultDependencies] = useState(false);
  const visibleEdges = graph.edges.filter(edge => (showPageDependencies || (edge.consumer !== "page" && edge.provider !== "page")) && (showVaultDependencies || (edge.consumer !== "vault" && edge.provider !== "vault")));
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const needle = query.trim().toLowerCase();
  const matching = new Set(graph.nodes.filter(node => `${node.id} ${node.name}`.toLowerCase().includes(needle)).map(node => node.id));
  const focus = hovered ?? selected;
  const related = new Set(focus ? [focus, ...visibleEdges.filter(edge => edge.consumer === focus || edge.provider === focus).flatMap(edge => [edge.consumer, edge.provider])] : graph.nodes.map(node => node.id));
  const state = runtime.plugins.find(plugin => plugin.id === selected);
  const calls = FUNCTION_DEPENDENCIES.filter(call => (direction === "outgoing" ? call.consumer : call.provider) === selected);
  const filtered = calls.filter(call => `${call.caller} ${call.capability} ${call.method} ${call.consumer} ${call.provider} ${call.file}`.toLowerCase().includes(functionQuery.trim().toLowerCase()));
  const declarations = graph.edges.filter(edge => (direction === "outgoing" ? edge.consumer : edge.provider) === selected);
  const open = (id: string) => { setSelected(id); setFunctionQuery(""); setDirection("outgoing"); setError(undefined); };
  const problems = runtime.plugins.filter(plugin => plugin.kind === "failed" || plugin.kind === "blocked" || plugin.units?.some(unit => unit.kind === "failed" || unit.kind === "blocked"));
  const dependencyPaths = (id: string, path: string[] = []): string[] => {
    if (path.includes(id)) return [[...path, id].join(" → ") + " (cycle)"];
    const next = [...path, id];
    const providers = [...new Set((runtime.graph.dependencies[id] ?? []).filter(capability => !(runtime.graph.optionalDependencies?.[id] ?? []).includes(capability)).flatMap(capability =>
      Object.entries(runtime.graph.provides).filter(([provider, capabilities]) => capabilities.includes(capability) && provider !== id && problems.some(problem => problem.id === provider)).map(([provider]) => provider)))];
    return providers.length ? providers.flatMap(provider => dependencyPaths(provider, next)) : [next.join(" → ")];
  };
  const [copyStatus, setCopyStatus] = useState("");
  const copyDiagnostics = async () => {
    setCopyStatus("");
    try {
      await navigator.clipboard.writeText(JSON.stringify(sanitizeDiagnosticValue({ plugins: problems, dependencyPaths: Object.fromEntries(problems.map(plugin => [plugin.id, dependencyPaths(plugin.id)])), graph: runtime.graph }), null, 2));
      setCopyStatus(t("pluginManager.diagnostics.copied"));
    } catch { setCopyStatus(t("pluginManager.diagnostics.copyFailed")); }
  };
  const retry = async (id: string) => {
    setBusy(id); setError(undefined);
    try { await runtime.retry(id); } catch (cause) { setError(sanitizeDiagnosticText(cause instanceof Error ? cause.message : String(cause))); } finally { setBusy(undefined); }
  };
  return <div className="plugin-manager">
    <PageHeader title={t("pluginManager.title")} description={t("pluginManager.description")} />
    {problems.length > 0 && <section aria-label={t("pluginManager.diagnostics.title")}>
      <div className="dependency-toolbar"><strong>{t("pluginManager.diagnostics.title")} ({problems.length})</strong><Button variant="ghost" onClick={() => void copyDiagnostics()}>{t("pluginManager.diagnostics.copy")}</Button><span role="status">{copyStatus}</span></div>
      {problems.map(plugin => <div key={plugin.id} className="dependency-diagnostic">
        <div><button type="button" onClick={() => open(plugin.id)}>{plugin.name} · {plugin.id}</button> · {t(plugin.kind === "blocked" ? "pluginManager.diagnostics.blocked" : plugin.kind === "failed" ? "pluginManager.diagnostics.failed" : "pluginManager.diagnostics.unitFailed")}</div>
        {plugin.error && <pre>{plugin.error}</pre>}
        {plugin.blockedBy?.map(reason => <pre key={reason}>{reason}</pre>)}
        {plugin.units?.filter(unit => unit.kind !== "enabled").map(unit => <pre key={unit.unitId}>{unit.unitId} · {unit.runtime} · {unit.kind}{unit.error ? `: ${unit.error}` : ""}</pre>)}
        <div>{t("pluginManager.diagnostics.dependencies")}: {dependencyPaths(plugin.id).filter(path => path !== plugin.id).join("; ") || "—"}</div>
        <Button variant="ghost" disabled={busy !== undefined} onClick={() => void retry(plugin.id)}>{t(busy === plugin.id ? "pluginManager.action.retrying" : "pluginManager.action.retry")}</Button>
      </div>)}
      {error && <p role="alert">{error}</p>}
    </section>}
    <div className="dependency-toolbar">
      <TextInput aria-label={t("pluginManager.graph.search")} placeholder={t("pluginManager.graph.search")} value={query} onChange={event => setQuery(event.currentTarget.value)} />
      <label className="dependency-page-toggle"><input type="checkbox" checked={showPageDependencies} onChange={event => setShowPageDependencies(event.currentTarget.checked)} />{t("pluginManager.graph.showPage")}</label>
      <label className="dependency-page-toggle"><input type="checkbox" checked={showVaultDependencies} onChange={event => setShowVaultDependencies(event.currentTarget.checked)} />{t("pluginManager.graph.showVault")}</label>
      <div className="dependency-zoom">
        <Button variant="ghost" aria-label={t("pluginManager.graph.zoomOut")} disabled={zoom <= 0.6} onClick={() => setZoom(value => Math.max(0.6, value - 0.2))}>−</Button>
        <Button variant="ghost" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</Button>
        <Button variant="ghost" aria-label={t("pluginManager.graph.zoomIn")} disabled={zoom >= 2} onClick={() => setZoom(value => Math.min(2, value + 0.2))}>+</Button>
      </div>
    </div>
    <p className="dependency-legend">{t("pluginManager.graph.legend")} <span>{graph.nodes.length} {t("pluginManager.graph.plugins")} · {visibleEdges.length} {t("pluginManager.graph.links")}</span></p>
    {matching.size === 0 && <p role="status">{t("pluginManager.graph.empty")}</p>}
    <div className="dependency-canvas" tabIndex={0} aria-label={t("pluginManager.graph.canvas")}>
      <svg className="dependency-graph" viewBox={`0 0 ${layout.width} ${layout.height}`} style={{ width: `${zoom * 100}%`, minWidth: `${zoom * Math.min(layout.width, 1100)}px` }} role="group" aria-label={t("pluginManager.graph.canvas")}>
        <defs><marker id={marker} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L8,4 L0,8 Z" /></marker></defs>
        {visibleEdges.map(edge => {
          const from = layout.positions.get(edge.consumer)!, to = layout.positions.get(edge.provider)!;
          const sameColumn = from.x === to.x;
          const x1 = from.x + (sameColumn ? 100 : 190), y1 = from.y + (sameColumn ? 60 : 30);
          const x2 = to.x + (sameColumn ? 100 : 0), y2 = to.y + (sameColumn ? 0 : 30);
          const highlighted = focus ? edge.consumer === focus || edge.provider === focus : needle ? matching.has(edge.consumer) || matching.has(edge.provider) : false;
          return <path key={`${edge.consumer}:${edge.provider}`} data-dependency-consumer={edge.consumer} data-dependency-provider={edge.provider} d={sameColumn ? `M${x1},${y1} C${x1 + 95},${y1 + 25} ${x2 + 95},${y2 - 25} ${x2},${y2}` : `M${x1},${y1} C${x1 + 40},${y1} ${x2 - 40},${y2} ${x2},${y2}`} className={`dependency-edge ${edge.optional ? "is-optional" : ""} ${highlighted ? "is-highlighted" : ""} ${focus && !highlighted || needle && !highlighted ? "is-dimmed" : ""}`} markerEnd={`url(#${marker})`}><title>{edge.consumer} → {edge.provider}: {edge.capabilities.join(", ")}</title></path>;
        })}
        {graph.nodes.map(node => {
          const position = layout.positions.get(node.id)!;
          const problem = runtime.plugins.find(plugin => plugin.id === node.id);
          const failed = problem?.kind === "failed" || problem?.kind === "blocked";
          return <g key={node.id} data-plugin-id={node.id} role="button" tabIndex={0} aria-label={`${node.name}: ${t("pluginManager.graph.details")}`} transform={`translate(${position.x},${position.y})`} className={`dependency-node ${!matching.has(node.id) || !related.has(node.id) ? "is-dimmed" : ""} ${focus === node.id ? "is-focused" : ""}`} onClick={() => open(node.id)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(node.id); } }} onFocus={() => setHovered(node.id)} onBlur={() => setHovered(undefined)} onMouseEnter={() => setHovered(node.id)} onMouseLeave={() => setHovered(undefined)}>
            <rect width="190" height="60" rx="10" />
            <text x="14" y="25" className="dependency-node__name">{node.name.length > 23 ? node.name.slice(0, 21) + "…" : node.name}</text>
            <text x="14" y="45" className="dependency-node__id">{node.id}</text>
            {failed && <circle cx="176" cy="15" r="4" className="dependency-node__failure"><title>{problem?.error ?? t("pluginManager.error")}</title></circle>}
          </g>;
        })}
      </svg>
    </div>
    {selected && <Modal open title={`${graph.nodes.find(node => node.id === selected)?.name ?? selected} · ${t("pluginManager.graph.details")}`} onClose={() => { setSelected(undefined); setHovered(undefined); }} closeButtonLabel={t("pluginManager.graph.close")} data-testid="plugin-function-dependencies">
      <p className="dependency-detail-note">{t("pluginManager.graph.staticNote")}</p>
      <div className="dependency-detail-tabs" role="group" aria-label={t("pluginManager.graph.direction")}>
        <Button variant="ghost" aria-pressed={direction === "outgoing"} onClick={() => setDirection("outgoing")}>{t("pluginManager.graph.outgoing")}</Button>
        <Button variant="ghost" aria-pressed={direction === "incoming"} onClick={() => setDirection("incoming")}>{t("pluginManager.graph.incoming")}</Button>
      </div>
      <TextInput aria-label={t("pluginManager.graph.functionSearch")} placeholder={t("pluginManager.graph.functionSearch")} value={functionQuery} onChange={event => setFunctionQuery(event.currentTarget.value)} />
      <div className="dependency-detail-summary">{declarations.map(edge => <button key={`${edge.consumer}:${edge.provider}`} type="button" onClick={() => open(direction === "outgoing" ? edge.provider : edge.consumer)}>{direction === "outgoing" ? edge.provider : edge.consumer}<span>{edge.capabilities.join(", ")}</span></button>)}</div>
      <p className="dependency-detail-count">{filtered.length} / {calls.length} {t("pluginManager.graph.callSites")}</p>
      <div className="function-dependency-list">
        {filtered.map((call, i) => <div className="function-dependency" key={`${call.file}:${call.line}:${call.capability}:${call.method}:${call.providerUnit}:${i}`}>
          <div className="function-dependency__flow">
            <div className="function-dependency__caller"><strong>{call.consumer}</strong><code>{call.caller}()</code></div>
            <span aria-hidden="true" className="function-dependency__arrow">→</span>
            <div className="function-dependency__method"><span>{call.capability}</span><code>{call.method}()</code></div>
            <span aria-hidden="true" className="function-dependency__arrow">→</span>
            <button className="function-dependency__provider" type="button" onClick={() => open(call.provider)}><strong>{call.provider}</strong><span>{call.providerUnit}</span></button>
          </div>
          <div className="function-dependency__source"><code>{call.file}:{call.line}</code><span>{call.runtime}</span></div>
        </div>)}
        {!filtered.length && <p role="status">{t(calls.length ? "pluginManager.graph.empty" : "pluginManager.graph.noCalls")}</p>}
      </div>
      {state?.error && <p role="alert">{state.error}</p>}
      {error && <p role="alert">{error}</p>}
      {(state?.kind === "failed" || state?.kind === "blocked") && <Button disabled={busy !== undefined} onClick={() => void retry(selected)}>{t(busy === selected ? "pluginManager.action.retrying" : "pluginManager.action.retry")}</Button>}
    </Modal>}
  </div>;
}
