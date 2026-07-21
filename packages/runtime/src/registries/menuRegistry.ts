// packages/runtime/src/registries/menuRegistry.ts
// Legacy 菜单注册表：id 冲突必须抛错；只按旧 group/order 语义排序。
// 设计缘由：菜单只来自 plugin 的业务声明，shell 不再硬编码业务入口。
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
      // 旧 group 只作为兼容输入；从注册表流出的永远是业务 section，
      // 所有 consumer 因而共享同一套分区与排序规则。
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
        const groupOrder = (a.group ?? "").localeCompare(b.group ?? "");
        if (groupOrder !== 0) return groupOrder;
        if (a.order !== b.order) return a.order - b.order;
        return a.id.localeCompare(b.id);
      });
    },
    _ids() {
      return [...items.keys()];
    }
  };
}
