import { PageHeader } from "@keymaster/ui";
import { useI18n, usePluginHost, useRegistry } from "@keymaster/runtime";

/** 广播网关的统一管理入口。 */
export function SystemStatusPage() {
  const { t } = useI18n();
  const host = usePluginHost();
  const modules = useRegistry((runtime) => runtime.systemStatus.list());

  return (
    <div className="system-status-page">
      <PageHeader
        title={t("settings.systemStatus.title", { defaultValue: "Broadcast gateway" })}
        description={t("settings.systemStatus.description", {
          defaultValue: "Manage broadcast gateway suppliers and service status."
        })}
      />
      {modules.length === 0 ? (
        <p className="system-status-page__empty">
          {t("settings.systemStatus.empty", { defaultValue: "No broadcast gateway modules are available." })}
        </p>
      ) : (
        <div className="system-status-page__modules">
          {modules.map((module) => {
            const Module = module.component;
            const headingId = `system-status-${module.id}-title`;
            return (
              <section
                key={module.id}
                className="system-status-page__module"
                aria-labelledby={headingId}
                data-system-status-module={module.id}
              >
                <header className="system-status-page__module-header">
                  <h2 id={headingId}>{host.i18n.text(module.label)}</h2>
                  {module.description ? <p>{host.i18n.text(module.description)}</p> : null}
                </header>
                <Module />
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
