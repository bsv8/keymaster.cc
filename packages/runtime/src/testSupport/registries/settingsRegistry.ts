// packages/runtime/src/registries/settingsRegistry.ts
// 设置详情页注册表（硬切换 003）。
//
// 设计缘由：
//   - settings.registry 只承载"设置详情页"的注册；不再支持 registerField /
//     聚合 page.component 拼装。
//   - shell 走 host.settings.list() 同时获得侧边栏菜单和路由匹配真值。
//   - 同一 path 只允许一处真值：
//       - settings.registry 内部：重复 register(path) 抛错；
//       - 与 route.registry 交叉：通过 setRoutePathProbe(probe) 在 host 装配阶段
//         注入 route.registry 的 path 探测函数，避免循环 import；register 时
//         探测到 path 已被 route.registry 占用也抛错。
//         这一约束是硬切换 003 的硬约束：settings 详情页是受约束的应用路由，
//         不能再以"独立业务路由"的形式同时挂到 route.registry。

import type { SettingsRoute } from "@keymaster/contracts";

export interface SettingsRegistry {
  register(route: SettingsRoute): void;
  /** 硬切换 003：注销设置详情页。id 不存在时抛错。 */
  unregister(id: string): void;
  /** 按 order 升序返回全部注册详情页。 */
  list(): SettingsRoute[];
  byId(id: string): SettingsRoute | undefined;
  byPath(path: string): SettingsRoute | undefined;
  /** 仅用于 host owner diff 捕获。 */
  _ids(): string[];
  /**
   * 注入 route.registry 的 path 探测函数。
   * host 在 createPluginHost 装配阶段调用一次，避免 runtime 包循环 import
   * 业务 registry。具体语义：返回 true 表示该 path 已被 route.registry 占用。
   */
  setRoutePathProbe(probe: (path: string) => boolean): void;
}

export function createSettingsRegistry(): SettingsRegistry {
  const routes = new Map<string, SettingsRoute>();
  const pathIndex = new Map<string, string>();
  // 由 host 在装配时注入；未注入时跳过跨 registry 校验（保留旧行为兜底）。
  let routePathProbe: ((path: string) => boolean) | undefined;

  function register(route: SettingsRoute): void {
    if (routes.has(route.id)) {
      throw new Error(`Settings route id "${route.id}" is already registered`);
    }
    if (pathIndex.has(route.path)) {
      throw new Error(
        `Settings route path "${route.path}" is already registered by "${pathIndex.get(route.path)}"`
      );
    }
    if (routePathProbe && routePathProbe(route.path)) {
      throw new Error(
        `Settings route path "${route.path}" collides with an existing route.registry entry; each path must have a single source of truth`
      );
    }
    routes.set(route.id, route);
    pathIndex.set(route.path, route.id);
  }

  function unregister(id: string): void {
    const existing = routes.get(id);
    if (!existing) {
      throw new Error(`Settings route id "${id}" is not registered`);
    }
    routes.delete(id);
    pathIndex.delete(existing.path);
  }

  function list(): SettingsRoute[] {
    return [...routes.values()].sort((a, b) => a.order - b.order);
  }

  function byId(id: string): SettingsRoute | undefined {
    return routes.get(id);
  }

  function byPath(path: string): SettingsRoute | undefined {
    const id = pathIndex.get(path);
    if (id === undefined) return undefined;
    return routes.get(id);
  }

  function _ids(): string[] {
    return [...routes.keys()];
  }

  function setRoutePathProbe(probe: (path: string) => boolean): void {
    routePathProbe = probe;
  }

  return { register, unregister, list, byId, byPath, _ids, setRoutePathProbe };
}
