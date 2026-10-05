import { BUILTIN_PLUGIN_DEFINITIONS } from "@keymaster/contracts";
import { PLUGIN_FUNCTION_CALLS } from "./generated/functionDependencies.js";

export interface DependencyNode { id: string; name: string }
export interface DependencyEdge { consumer: string; provider: string; capabilities: string[]; optional: boolean }
export interface FunctionDependency {
  consumer: string; provider: string; providerUnit: string; runtime: string;
  capability: string; method: string; caller: string; file: string; line: number;
}
const identity = (cap: { kind: string; id: string; version: string }) => `${cap.kind}:${cap.id}@${cap.version}`;

/** 从完整发行清单构图，保留 Window / Worker 来源并合并同一对插件的边。 */
export function buildDependencyGraph() {
  const nodes: DependencyNode[] = BUILTIN_PLUGIN_DEFINITIONS.map(plugin => ({ id: plugin.id, name: plugin.name }));
  const edges = new Map<string, DependencyEdge>();
  for (const plugin of BUILTIN_PLUGIN_DEFINITIONS) for (const unit of plugin.units) for (const dependency of unit.dependencies) {
    const providerIds = new Set(BUILTIN_PLUGIN_DEFINITIONS.filter(provider => provider.id !== plugin.id && provider.units.some(candidate => {
      const provides = [...candidate.provides, ...candidate.privateProvides];
      const source = "source" in dependency && dependency.source === "peer" ? candidate.runtime !== unit.runtime : candidate.runtime === ("sourceRuntime" in dependency ? dependency.sourceRuntime : unit.runtime);
      return source && provides.some(capability => identity(capability) === identity(dependency.capability));
    })).map(provider => provider.id));
    for (const provider of providerIds) {
      const key = `${plugin.id}:${provider}`;
      const edge = edges.get(key) ?? { consumer: plugin.id, provider, capabilities: [], optional: true };
      if (!edge.capabilities.includes(dependency.capability.id)) edge.capabilities.push(dependency.capability.id);
      edge.optional &&= "optional" in dependency && dependency.optional === true;
      edges.set(key, edge);
    }
  }
  return { nodes, edges: [...edges.values()] };
}
export const FUNCTION_DEPENDENCIES: readonly FunctionDependency[] = PLUGIN_FUNCTION_CALLS;

/** 强连通分量折叠后按依赖层排布，循环不会造成无限递归或丢失节点。 */
export function layoutDependencyGraph(nodes: readonly DependencyNode[], edges: readonly DependencyEdge[]) {
  const ids = new Set(nodes.map(node => node.id));
  const adjacency = new Map(nodes.map(node => [node.id, edges.filter(edge => edge.consumer === node.id && ids.has(edge.provider)).map(edge => edge.provider)]));
  let index = 0;
  const indices = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], onStack = new Set<string>();
  const components: string[][] = [];
  function visit(id: string) {
    indices.set(id, index); low.set(id, index++); stack.push(id); onStack.add(id);
    for (const next of adjacency.get(id) ?? []) {
      if (!indices.has(next)) { visit(next); low.set(id, Math.min(low.get(id)!, low.get(next)!)); }
      else if (onStack.has(next)) low.set(id, Math.min(low.get(id)!, indices.get(next)!));
    }
    if (low.get(id) === indices.get(id)) {
      const component: string[] = []; let next: string;
      do { next = stack.pop()!; onStack.delete(next); component.push(next); } while (next !== id);
      components.push(component);
    }
  }
  for (const node of nodes) if (!indices.has(node.id)) visit(node.id);
  const componentOf = new Map(components.flatMap((component, i) => component.map(id => [id, i] as const)));
  const levels = new Map<number, number>();
  function level(component: number): number {
    if (levels.has(component)) return levels.get(component)!;
    const providers = new Set(components[component]!.flatMap(id => adjacency.get(id) ?? []).map(id => componentOf.get(id)!).filter(id => id !== component));
    const value = providers.size ? Math.max(...[...providers].map(level)) + 1 : 0;
    levels.set(component, value); return value;
  }
  const ordered = [...nodes].sort((a, b) => level(componentOf.get(b.id)!) - level(componentOf.get(a.id)!) || a.name.localeCompare(b.name));
  // 分量内可能有大环；按依赖层排序后平衡列高，保证总览不退化为长列表。
  const columnCount = Math.min(4, Math.max(1, Math.ceil(nodes.length / 5)));
  const rowCount = Math.max(1, Math.ceil(nodes.length / columnCount));
  const positions = new Map<string, { x: number; y: number }>();
  ordered.forEach((node, i) => positions.set(node.id, { x: 36 + Math.floor(i / rowCount) * 240, y: 40 + (i % rowCount) * 90 }));
  return { positions, width: 280 + (columnCount - 1) * 240, height: 70 + rowCount * 90 };
}
