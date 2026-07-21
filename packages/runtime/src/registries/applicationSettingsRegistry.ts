import type { ApplicationSettingsItem } from "@keymaster/contracts";

export interface ApplicationSettingsRegistry {
  register(item: ApplicationSettingsItem): void;
  unregister(id: string): void;
  list(): ApplicationSettingsItem[];
  _ids(): string[];
}

/** 应用设置入口钩子：只记录可进入的应用，不承载具体设置页面。 */
export function createApplicationSettingsRegistry(): ApplicationSettingsRegistry {
  const items = new Map<string, ApplicationSettingsItem>();
  return {
    register(item) {
      if (items.has(item.id)) throw new Error(`Application settings item id "${item.id}" is already registered`);
      items.set(item.id, item);
    },
    unregister(id) {
      if (!items.delete(id)) throw new Error(`Application settings item id "${id}" is not registered`);
    },
    list: () => [...items.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)),
    _ids: () => [...items.keys()]
  };
}
