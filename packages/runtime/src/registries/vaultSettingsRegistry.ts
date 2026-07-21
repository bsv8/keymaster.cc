import type { VaultSettingsSection } from "@keymaster/contracts";

export interface VaultSettingsRegistry {
  register(section: VaultSettingsSection): void;
  unregister(id: string): void;
  list(): VaultSettingsSection[];
  _ids(): string[];
}

/** Key 管理页的插件工作区钩子。 */
export function createVaultSettingsRegistry(): VaultSettingsRegistry {
  const sections = new Map<string, VaultSettingsSection>();

  return {
    register(section) {
      if (sections.has(section.id)) {
        throw new Error(`Vault settings section id "${section.id}" is already registered`);
      }
      sections.set(section.id, section);
    },
    unregister(id) {
      if (!sections.delete(id)) {
        throw new Error(`Vault settings section id "${id}" is not registered`);
      }
    },
    list: () => [...sections.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)),
    _ids: () => [...sections.keys()]
  };
}
