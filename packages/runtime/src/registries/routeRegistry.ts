// packages/runtime/src/registries/routeRegistry.ts
// 路由注册表：插件注册的页面入口。id/path 重复必须抛错。

import type { AppRoute } from "@keymaster/contracts";

export interface RouteRegistry {
  register(route: AppRoute): void;
  list(): AppRoute[];
  byPath(path: string): AppRoute | undefined;
  byId(id: string): AppRoute | undefined;
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
    list() {
      return [...byId.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    },
    byPath(path) {
      return byPath.get(path);
    },
    byId(id) {
      return byId.get(id);
    }
  };
}
