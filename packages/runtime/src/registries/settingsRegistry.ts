// packages/runtime/src/registries/settingsRegistry.ts
// 设置注册表：插件注册整页设置页或独立字段。
// 设计缘由：设置页只来自 settings.registry，shell 不硬编码业务设置项。

import type { SettingsField, SettingsPage } from "@keymaster/contracts";

export interface SettingsRegistry {
  registerPage(page: SettingsPage): void;
  registerField(field: SettingsField): void;
  listPages(): SettingsPage[];
  listFields(): SettingsField[];
}

export function createSettingsRegistry(): SettingsRegistry {
  const pages = new Map<string, SettingsPage>();
  const fields = new Map<string, SettingsField>();

  return {
    registerPage(page) {
      if (pages.has(page.id)) {
        throw new Error(`Settings page id "${page.id}" is already registered`);
      }
      pages.set(page.id, page);
    },
    registerField(field) {
      if (fields.has(field.id)) {
        throw new Error(`Settings field id "${field.id}" is already registered`);
      }
      fields.set(field.id, field);
    },
    listPages() {
      return [...pages.values()].sort((a, b) => a.order - b.order);
    },
    listFields() {
      return [...fields.values()];
    }
  };
}
