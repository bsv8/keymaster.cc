// packages/runtime/src/registries/homeRegistry.ts
// 首页注册表：按 order 排序，size 决定栅格。
// 设计缘由：首页只来自 home.registry，禁止直接 import 业务 widget。

import type { HomeWidget } from "@keymaster/contracts";

export interface HomeRegistry {
  register(widget: HomeWidget): void;
  list(): HomeWidget[];
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
    list() {
      return [...widgets.values()].sort((a, b) => a.order - b.order);
    }
  };
}
