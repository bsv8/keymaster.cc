// packages/runtime/src/registries/breadcrumbRegistry.ts
// 面包屑注册表：插件实现 BreadcrumbProvider 解析动态资源名。
// 设计缘由：动态资源名（key 标签、联系人名）必须由对应 provider resolve，
// shell 禁止只靠路径字符串硬拼。
// 硬切换 001：unregister 走 owner 回收。

import type { BreadcrumbProvider } from "@keymaster/contracts";

export interface BreadcrumbRegistry {
  register(provider: BreadcrumbProvider): void;
  /** 硬切换 001：注销 provider。id 不存在时抛错。 */
  unregister(id: string): void;
  list(): BreadcrumbProvider[];
  /** 找到第一个匹配 path 的 provider（按 order 升序）。 */
  match(path: string): BreadcrumbProvider | undefined;
  /** 仅用于 host owner diff 捕获。 */
  _ids(): string[];
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
    unregister(id) {
      if (!providers.has(id)) {
        throw new Error(`Breadcrumb provider id "${id}" is not registered`);
      }
      providers.delete(id);
    },
    list() {
      return [...providers.values()].sort((a, b) => a.order - b.order);
    },
    match(path) {
      return [...providers.values()]
        .sort((a, b) => a.order - b.order)
        .find((p) => p.match(path));
    },
    _ids() {
      return [...providers.keys()];
    }
  };
}
