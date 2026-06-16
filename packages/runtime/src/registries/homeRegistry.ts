// packages/runtime/src/registries/homeRegistry.ts
// 首页注册表：按 order 排序，size 决定栅格。
// 设计缘由：首页只来自 home.registry，禁止直接 import 业务 widget。
// 硬切换 001：unregister 走 owner 回收。

import type { HomeWidget } from "@keymaster/contracts";

export interface HomeRegistry {
  register(widget: HomeWidget): void;
  /** 硬切换 001：注销 widget。id 不存在时抛错。 */
  unregister(id: string): void;
  list(): HomeWidget[];
  /** 仅用于 host owner diff 捕获。 */
  _ids(): string[];
}

export function createHomeRegistry(): HomeRegistry {
  const widgets = new Map<string, HomeWidget>();

  return {
    register(widget) {
      if (widgets.has(widget.id)) {
        throw new Error(`Home widget id "${widget.id}" is already registered`);
      }
      widgets.set(widget.id, widget);
    },
    unregister(id) {
      if (!widgets.has(id)) {
        throw new Error(`Home widget id "${id}" is not registered`);
      }
      widgets.delete(id);
    },
    list() {
      return [...widgets.values()].sort((a, b) => a.order - b.order);
    },
    _ids() {
      return [...widgets.keys()];
    }
  };
}
