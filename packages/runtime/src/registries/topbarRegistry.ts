// packages/runtime/src/registries/topbarRegistry.ts
// Topbar 扩展点注册表。
// 设计缘由：Shell 通过 topbar.registry 渲染扩展项；注册表只放通用能力，
// 不认识具体插件类型；id 重复抛英文错误；list 按 order 排序。

import type { TopbarItem, TopbarRegistry as ITopbarRegistry } from "@keymaster/contracts";

export function createTopbarRegistry(): ITopbarRegistry {
  const items = new Map<string, TopbarItem>();

  return {
    register(item) {
      if (items.has(item.id)) {
        throw new Error(`Topbar item id "${item.id}" is already registered`);
      }
      items.set(item.id, item);
    },
    list() {
      return [...items.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    }
  };
}

export type { ITopbarRegistry as TopbarRegistry };
