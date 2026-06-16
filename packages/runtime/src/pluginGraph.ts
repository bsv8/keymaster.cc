// packages/runtime/src/pluginGraph.ts
// 插件依赖图工具：从 manifest 列表推导 dependencies / provides / reverse。
// 设计缘由（硬切换 001）：
//   - 反向依赖只能从 "X provides C" ∩ "Y depends on C" 推导；
//   - 不允许手写反向依赖；这是 UI 阻断 disable 的唯一真值。

import type { PluginGraph, PluginManifest, PluginReverseDep } from "@keymaster/contracts";

export function buildPluginGraph(manifests: PluginManifest[]): PluginGraph {
  const provides: Record<string, string[]> = {};
  const dependencies: Record<string, string[]> = {};
  for (const m of manifests) {
    const providesList = m.meta?.providesCapabilities ?? [];
    const depsList = (m.dependencies ?? []).map((d) => d.capability);
    provides[m.id] = [...providesList];
    dependencies[m.id] = [...depsList];
  }

  // 反向：capability -> provides pluginId 列表
  const capabilityToProviders = new Map<string, string[]>();
  for (const [pluginId, caps] of Object.entries(provides)) {
    for (const cap of caps) {
      let list = capabilityToProviders.get(cap);
      if (!list) {
        list = [];
        capabilityToProviders.set(cap, list);
      }
      list.push(pluginId);
    }
  }

  // 反向依赖：pluginId -> 哪些 enabled 插件声明依赖其提供的 capability
  const reverse: Record<string, PluginReverseDep[]> = {};
  for (const m of manifests) {
    const deps = dependencies[m.id] ?? [];
    if (deps.length === 0) continue;
    const enabledSet = new Set(manifests.filter((x) => x.meta?.defaultEnabled).map((x) => x.id));
    const dependents = new Map<string, { capabilities: string[] }>();
    for (const cap of deps) {
      const providers = capabilityToProviders.get(cap) ?? [];
      for (const providerId of providers) {
        if (providerId === m.id) continue;
        let entry = dependents.get(providerId);
        if (!entry) {
          entry = { capabilities: [] };
          dependents.set(providerId, entry);
        }
        entry.capabilities.push(cap);
      }
      // 任何 enabled 插件对 m 的依赖也会被这里捕获到 enabled 集合判断
      void enabledSet;
    }
    // 注意：reverse 不再仅过滤"启用中"——所有反向依赖者都列出来，
    // enabled 状态由调用方（host）通过 manifest.meta.defaultEnabled 与 config store
    // 联合判断。
    for (const [providerId, { capabilities }] of dependents) {
      let arr = reverse[providerId];
      if (!arr) {
        arr = [];
        reverse[providerId] = arr;
      }
      arr.push({
        pluginId: m.id,
        // defaultEnabled 在 host 阶段会被 config store 覆盖；这里只是初值
        enabled: m.meta?.defaultEnabled ?? false,
        capabilities
      });
    }
  }

  return {
    plugins: manifests.map((m) => m.id),
    dependencies,
    provides,
    reverse
  };
}

/**
 * 计算"被 X 启用中的依赖者"。
 * 设计缘由：disable 阻止条件只看"被谁依赖 + 该依赖者是否当前 enabled"。
 */
export function reverseDependentsOf(
  graph: PluginGraph,
  pluginId: string,
  enabledSet: ReadonlySet<string>
): PluginReverseDep[] {
  const list = graph.reverse[pluginId] ?? [];
  return list.filter((d) => enabledSet.has(d.pluginId));
}
