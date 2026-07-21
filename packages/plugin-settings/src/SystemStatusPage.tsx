import { useEffect, useState } from "react";
import { PageHeader } from "@keymaster/ui";
import { useI18n, usePluginHost, useRegistry } from "@keymaster/runtime";

/** 常驻系统模块的统一实时状态工作区。 */
export function SystemStatusPage() {
  const { t } = useI18n();
  const host = usePluginHost();
  const modules = useRegistry((runtime) => runtime.systemStatus.list());
  const [activeId, setActiveId] = useState<string | undefined>(() => modules[0]?.id);

  useEffect(() => {
    if (!modules.some((module) => module.id === activeId)) {
      setActiveId(modules[0]?.id);
    }
  }, [activeId, modules]);

  const active = modules.find((module) => module.id === activeId) ?? modules[0];
  const ActiveModule = active?.component;

  return (
    <div className="system-status-page">
      <PageHeader
        title={t("settings.systemStatus.title", { defaultValue: "System status" })}
        description={t("settings.systemStatus.description", {
          defaultValue: "Live status for always-on system modules."
        })}
      />
      {modules.length === 0 ? (
        <p className="system-status-page__empty">
          {t("settings.systemStatus.empty", { defaultValue: "No system status modules are available." })}
        </p>
      ) : (
        <>
          <div className="system-status-page__tabs" role="tablist" aria-label={t("settings.systemStatus.title", { defaultValue: "System status" })}>
            {modules.map((module) => (
              <button
                key={module.id}
                type="button"
                role="tab"
                aria-selected={active?.id === module.id}
                className={`system-status-page__tab ${active?.id === module.id ? "is-active" : ""}`}
                onClick={() => setActiveId(module.id)}
              >
                {host.i18n.text(module.label)}
              </button>
            ))}
          </div>
          <section className="system-status-page__module" role="tabpanel">
            <header className="system-status-page__module-header">
              <h2>{active ? host.i18n.text(active.label) : ""}</h2>
              {active?.description ? <p>{host.i18n.text(active.description)}</p> : null}
            </header>
            {ActiveModule ? <ActiveModule /> : null}
          </section>
        </>
      )}
    </div>
  );
}
