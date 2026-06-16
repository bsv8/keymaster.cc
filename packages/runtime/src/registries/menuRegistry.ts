// packages/runtime/src/registries/menuRegistry.ts
// 菜单注册表：id 冲突必须抛错；列出时按 group/order 排序。
// 设计缘由：菜单只来自 menu.registry，shell 不再硬编码业务入口。
// 硬切换 001：unregister 走 owner 回收；id 不存在时抛错。

import type { MenuItem } from "@keymaster/contracts";

export interface MenuRegistry {
  register(item: MenuItem): void;
  /** 硬切换 001：注销菜单项。id 不存在时抛错。 */
  unregister(id: string): void;
  list(): MenuItem[];
  /** 仅用于 host owner diff 捕获。 */
  _ids(): string[];
}

export function createMenuRegistry(): MenuRegistry {
  const items = new Map<string, MenuItem>();

  return {
    register(item) {
      if (items.has(item.id)) {
        throw new Error(`Menu item id "${item.id}" is already registered`);
      }
      items.set(item.id, item);
    },
    unregister(id) {
      if (!items.has(id)) {
        throw new Error(`Menu item id "${id}" is not registered`);
      }
      items.delete(id);
    },
    list() {
      return [...items.values()].sort((a, b) => {
        if (a.group !== b.group) return a.group.localeCompare(b.group);
        return a.order - b.order;
      });
    },
    _ids() {
      return [...items.keys()];
    }
  };
}
