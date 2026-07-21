import { PageHeader } from "@keymaster/ui";
import { useI18n, usePluginHost, useRegistry, useRuntimeStatus } from "@keymaster/runtime";
import type { SystemSettingsItem } from "@keymaster/contracts";

interface SettingsGroup {
  id: string;
  label: SystemSettingsItem["group"]["label"];
  order: number;
  items: SystemSettingsItem[];
}

function groupItems(items: readonly SystemSettingsItem[], unlocked: boolean): SettingsGroup[] {
  const groups = new Map<string, SettingsGroup>();
  for (const item of items) {
    if (item.visibleWhen && !item.visibleWhen({ unlocked })) continue;
    const group = groups.get(item.group.id) ?? {
      id: item.group.id,
      label: item.group.label,
      order: item.group.order,
      items: []
    };
    group.items.push(item);
    groups.set(group.id, group);
  }
  return [...groups.values()]
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((group) => ({
      ...group,
      items: [...group.items].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    }));
}

/** 由插件设置钩子拼出的系统设置工作区。 */
export function SystemSettingsPage() {
  const { t } = useI18n();
  const host = usePluginHost();
  const { vault } = useRuntimeStatus();
  const items = useRegistry((host) => host.systemSettings.list());
  const groups = groupItems(items, vault === "unlocked");

  return (
    <div className="system-settings-page">
      <PageHeader
        title={t("settings.system.title", { defaultValue: "System" })}
        description={t("settings.system.description", {
          defaultValue: "Changes take effect immediately."
        })}
      />
      <div className="system-settings-page__groups">
        {groups.map((group) => (
          <section
            className="system-settings-page__group"
            id={group.id}
            key={group.id}
          >
            <header className="system-settings-page__group-header">
              <h2>{host.i18n.text(group.label)}</h2>
            </header>
            {group.items.map((item) => {
              const Item = item.component;
              return (
                <div className="system-settings-page__item" key={item.id}>
                  {group.items.length > 1 ? <h3>{host.i18n.text(item.label)}</h3> : null}
                  {item.description ? <p className="system-settings-page__description">{host.i18n.text(item.description)}</p> : null}
                  <Item />
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}
