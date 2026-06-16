// packages/runtime/src/registries/settingsRegistry.ts
// 设置注册表：插件注册整页设置页或独立字段。
// 设计缘由：设置页只来自 settings.registry，shell 不硬编码业务设置项。
// 硬切换 001：unregisterPage / unregisterField 走 owner 回收。

import type { SettingsField, SettingsPage } from "@keymaster/contracts";

export interface SettingsRegistry {
  registerPage(page: SettingsPage): void;
  registerField(field: SettingsField): void;
  /** 硬切换 001：注销设置页。id 不存在时抛错。 */
  unregisterPage(id: string): void;
  /** 硬切换 001：注销设置字段。id 不存在时抛错。 */
  unregisterField(id: string): void;
  listPages(): SettingsPage[];
  listFields(): SettingsField[];
  /** 仅用于 host owner diff 捕获。 */
  _pageIds(): string[];
  _fieldIds(): string[];
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
    unregisterPage(id) {
      if (!pages.has(id)) {
        throw new Error(`Settings page id "${id}" is not registered`);
      }
      pages.delete(id);
    },
    unregisterField(id) {
      if (!fields.has(id)) {
        throw new Error(`Settings field id "${id}" is not registered`);
      }
      fields.delete(id);
    },
    listPages() {
      return [...pages.values()].sort((a, b) => a.order - b.order);
    },
    listFields() {
      return [...fields.values()];
    },
    _pageIds() {
      return [...pages.keys()];
    },
    _fieldIds() {
      return [...fields.keys()];
    }
  };
}
