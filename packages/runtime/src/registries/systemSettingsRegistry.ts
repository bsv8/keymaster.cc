import type { SystemSettingsItem } from "@keymaster/contracts";

export interface SystemSettingsRegistry {
  register(item: SystemSettingsItem): void;
  unregister(id: string): void;
  list(): SystemSettingsItem[];
  _ids(): string[];
}

/** 由 /settings/system 消费的插件设置钩子。 */
export function createSystemSettingsRegistry(): SystemSettingsRegistry {
  const items = new Map<string, SystemSettingsItem>();
  const groups = new Map<string, SystemSettingsItem["group"]>();

  function register(item: SystemSettingsItem): void {
    if (items.has(item.id)) {
      throw new Error(`System settings item id "${item.id}" is already registered`);
    }
    const existingGroup = groups.get(item.group.id);
    if (
      existingGroup &&
      (existingGroup.order !== item.group.order ||
        JSON.stringify(existingGroup.label) !== JSON.stringify(item.group.label))
    ) {
      throw new Error(`System settings group "${item.group.id}" has conflicting definitions`);
    }
    groups.set(item.group.id, item.group);
    items.set(item.id, item);
  }

  function unregister(id: string): void {
    const item = items.get(id);
    if (!item) throw new Error(`System settings item id "${id}" is not registered`);
    items.delete(id);
    if (![...items.values()].some((candidate) => candidate.group.id === item.group.id)) {
      groups.delete(item.group.id);
    }
  }

  function list(): SystemSettingsItem[] {
    return [...items.values()].sort(
      (a, b) =>
        a.group.order - b.group.order ||
        a.group.id.localeCompare(b.group.id) ||
        a.order - b.order ||
        a.id.localeCompare(b.id)
    );
  }

  return { register, unregister, list, _ids: () => [...items.keys()] };
}
