// packages/runtime/src/registries/topbarRegistry.ts
// Topbar 扩展点注册表。
// 设计缘由：Shell 通过 topbar.registry 渲染扩展项；注册表只放通用能力，
// 不认识具体插件类型；id 重复抛英文错误；list 按 order 排序。
// 硬切换 001：unregister 走 owner 回收。

import type { TopbarItem, TopbarRegistry as ITopbarRegistry } from "@keymaster/contracts";

export function createTopbarRegistry(): ITopbarRegistry & {
  /** 硬切换 001：注销 Topbar item。id 不存在时抛错。 */
  unregister(id: string): void;
  /** 仅用于 host owner diff 捕获。 */
  _ids(): string[];
} {
  const items = new Map<string, TopbarItem>();

  return {
    register(item) {
      if (items.has(item.id)) {
        throw new Error(`Topbar item id "${item.id}" is already registered`);
      }
      items.set(item.id, item);
    },
    unregister(id) {
      if (!items.has(id)) {
        throw new Error(`Topbar item id "${id}" is not registered`);
      }
      items.delete(id);
    },
    list() {
      return [...items.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    },
    _ids() {
      return [...items.keys()];
    }
  };
}

export type { ITopbarRegistry as TopbarRegistry };
