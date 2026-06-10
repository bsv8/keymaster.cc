// packages/runtime/src/registries/breadcrumbRegistry.ts
// 面包屑注册表：插件实现 BreadcrumbProvider 解析动态资源名。
// 设计缘由：动态资源名（key 标签、联系人名）必须由对应 provider resolve，
// shell 禁止只靠路径字符串硬拼。

import type { BreadcrumbProvider } from "@keymaster/contracts";

export interface BreadcrumbRegistry {
  register(provider: BreadcrumbProvider): void;
  list(): BreadcrumbProvider[];
  /** 找到第一个匹配 path 的 provider（按 order 升序）。 */
  match(path: string): BreadcrumbProvider | undefined;
}

export function createBreadcrumbRegistry(): BreadcrumbRegistry {
  const providers = new Map<string, BreadcrumbProvider>();

  return {
    register(provider) {
      if (providers.has(provider.id)) {
        throw new Error(`Breadcrumb provider id "${provider.id}" is already registered`);
      }
      providers.set(provider.id, provider);
    },
    list() {
      return [...providers.values()].sort((a, b) => a.order - b.order);
    },
    match(path) {
      return [...providers.values()]
        .sort((a, b) => a.order - b.order)
        .find((p) => p.match(path));
    }
  };
}
