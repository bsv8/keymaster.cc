import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { BUILTIN_PLUGIN_PRODUCT_IDS } from "@keymaster/contracts";
import { buildDependencyGraph, FUNCTION_DEPENDENCIES, layoutDependencyGraph } from "./dependencyGraph.js";

describe("plugin dependency facts", () => {
  it("keeps every product and matches method calls to declared cross-plugin edges", () => {
    const graph = buildDependencyGraph();
    // 节点集合必须与中央产品目录一一对应：数量与 id 都不允许漂移，
    // 这样新增产品时这条断言自动跟随目录，而不是靠改魔法数字。
    expect([...graph.nodes.map(node => node.id)].sort()).toEqual([...BUILTIN_PLUGIN_PRODUCT_IDS].sort());
    const pairs = new Set(graph.edges.map(edge => `${edge.consumer}:${edge.provider}`));
    for (const call of FUNCTION_DEPENDENCIES) {
      expect(pairs.has(`${call.consumer}:${call.provider}`), JSON.stringify(call)).toBe(true);
      expect(call.consumer).not.toBe(call.provider);
      expect(call.line).toBeGreaterThan(0);
    }
    expect(FUNCTION_DEPENDENCIES.some(call => call.consumer === "protocol" && call.provider === "vault" && call.method === "unlock")).toBe(true);
    expect(FUNCTION_DEPENDENCIES.some(call => call.consumer === "apps" && call.provider === "protocol" && call.method === "launchAppView")).toBe(true);
    expect(FUNCTION_DEPENDENCIES.some(call => call.provider === "page" && call.method === "register")).toBe(true);
  });
  it("points Vault unlock relationships at actual source calls", () => {
    const calls = FUNCTION_DEPENDENCIES.filter(call => call.consumer === "protocol" && call.capability === "vault.service" && call.method === "unlock");
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(readFileSync(call.file, "utf8").split("\n")[call.line - 1]).toContain(".unlock(");
  });
  it("lays out cyclic and disconnected nodes once within a bounded overview", () => {
    const graph = buildDependencyGraph();
    const layout = layoutDependencyGraph(graph.nodes, graph.edges);
    expect(layout.positions.size).toBe(graph.nodes.length);
    expect(layout.height).toBeLessThan(800);
    expect(new Set([...layout.positions.values()].map(point => `${point.x}:${point.y}`)).size).toBe(graph.nodes.length);
    const cycle = layoutDependencyGraph([{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }], [{ consumer: "a", provider: "b", capabilities: [], optional: false }, { consumer: "b", provider: "a", capabilities: [], optional: false }]);
    expect(cycle.positions.size).toBe(3);
  });
});
