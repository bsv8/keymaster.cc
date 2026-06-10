// packages/runtime/src/registries/menuRegistry.ts
// 菜单注册表：id 冲突必须抛错；列出时按 group/order 排序。
// 设计缘由：菜单只来自 menu.registry，shell 不再硬编码业务入口。

import type { MenuItem } from "@keymaster/contracts";

export interface MenuRegistry {
  register(item: MenuItem): void;
  list(): MenuItem[];
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
    list() {
      return [...items.values()].sort((a, b) => {
        if (a.group !== b.group) return a.group.localeCompare(b.group);
        return a.order - b.order;
      });
    }
  };
}
