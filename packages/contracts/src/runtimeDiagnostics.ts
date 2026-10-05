import { defineCapability, type LifecycleScope, type PluginConsumer } from "webloom-framework";
import type { PluginGraph, PluginState } from "./plugin.js";
export interface RuntimeDiagnosticEntry {
  id: string;
  name: string;
  description?: string;
  kind: PluginState["kind"];
  error?: string;
  blockedBy?: string[];
  units?: { unitId: string; kind: string; error?: string }[];
}
export interface RuntimeDiagnosticSnapshot {
  graph: PluginGraph;
  plugins: RuntimeDiagnosticEntry[];
}
/** 只提供运行诊断与恢复，不返回 manifest 的 setup、UI 或服务对象。 */
export interface RuntimeDiagnosticsView {
  revision(): number;
  snapshot(): RuntimeDiagnosticSnapshot;
  subscribe(listener: () => void): () => void;
  retry(pluginId: string): Promise<void>;
}
export interface RuntimeDiagnosticsAccess {
  bind(consumer: PluginConsumer, scope: LifecycleScope): RuntimeDiagnosticsView;
}
export const RUNTIME_DIAGNOSTICS_CAPABILITY = defineCapability<RuntimeDiagnosticsAccess>({ kind: "local", id: "runtime.diagnostics", version: "1" });
