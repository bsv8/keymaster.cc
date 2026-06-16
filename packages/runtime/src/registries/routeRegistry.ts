// packages/runtime/src/registries/routeRegistry.ts
// 路由注册表：插件注册的页面入口。id/path 重复必须抛错。
// 硬切换 001：unregister 走 owner 回收；不存在的 id 抛错，避免静默失败。

import type { AppRoute } from "@keymaster/contracts";

export interface RouteRegistry {
  register(route: AppRoute): void;
  /** 硬切换 001：注销路由。id 不存在时抛错。 */
  unregister(id: string): void;
  list(): AppRoute[];
  byPath(path: string): AppRoute | undefined;
  byId(id: string): AppRoute | undefined;
  /** 仅用于 host owner diff 捕获；不暴露为契约。 */
  _ids(): string[];
}

export function createRouteRegistry(): RouteRegistry {
  const byId = new Map<string, AppRoute>();
  const byPath = new Map<string, AppRoute>();

  return {
    register(route) {
      if (byId.has(route.id)) {
        throw new Error(`Route id "${route.id}" is already registered`);
      }
      if (byPath.has(route.path)) {
        throw new Error(`Route path "${route.path}" is already registered`);
      }
      byId.set(route.id, route);
      byPath.set(route.path, route);
    },
    unregister(id) {
      const r = byId.get(id);
      if (!r) {
        throw new Error(`Route id "${id}" is not registered`);
      }
      byId.delete(id);
      byPath.delete(r.path);
    },
    list() {
      return [...byId.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    },
    byPath(path) {
      return byPath.get(path);
    },
    byId(id) {
      return byId.get(id);
    },
    _ids() {
      return [...byId.keys()];
    }
  };
}
