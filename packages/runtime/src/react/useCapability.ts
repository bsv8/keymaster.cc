// packages/runtime/src/react/useCapability.ts
// 组件读取 capability 的唯一入口。
// 设计缘由：业务组件不得直接调用 host.capabilities.get()，
// 一律通过 hook 走，确保调用路径可观察。

import { usePluginHost } from "./PluginHostProvider.js";

export function useCapability<T>(key: string): T {
  return usePluginHost().capabilities.get<T>(key);
}

export function useHasCapability(key: string): boolean {
  return usePluginHost().capabilities.has(key);
}
