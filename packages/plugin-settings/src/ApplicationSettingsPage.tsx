import { EmptyState, PageHeader } from "@keymaster/ui";
import { router, useI18n, usePluginHost, useRegistry } from "@keymaster/runtime";

/** 可选应用的设置目录；点击应用后才进入其具体设置页。 */
export function ApplicationSettingsPage() {
  const { t } = useI18n();
  const host = usePluginHost();
  const apps = useRegistry((runtime) => runtime.applicationSettings.list());

  return (
    <div className="application-settings-page">
      <PageHeader
        title={t("settings.applicationSettings.title", { defaultValue: "Application settings" })}
        description={t("settings.applicationSettings.description", {
          defaultValue: "Choose an application to configure."
        })}
      />
      {apps.length === 0 ? (
        <EmptyState
          title={t("settings.applicationSettings.empty.title", { defaultValue: "No application settings" })}
          description={t("settings.applicationSettings.empty.description", {
            defaultValue: "Enabled applications with settings will appear here."
          })}
        />
      ) : (
        <section
          className="application-settings-page__directory"
          aria-label={t("settings.applicationSettings.directory", {
            defaultValue: "Configured applications"
          })}
        >
          <header className="application-settings-page__directory-head">
            <span className="application-settings-page__directory-label">
              {t("settings.applicationSettings.directory", {
                defaultValue: "Configured applications"
              })}
            </span>
            <span className="application-settings-page__directory-count">
              {t("settings.applicationSettings.count", {
                defaultValue: "{{count}} apps",
                count: apps.length
              })}
            </span>
          </header>
          <ul className="application-settings-page__list">
            {apps.map((app, index) => {
              const name = host.i18n.text(app.label);
              return (
                <li key={app.id}>
                  <button
                    type="button"
                    className="application-settings-page__item"
                    aria-label={t("settings.applicationSettings.open", {
                      defaultValue: "Open {{name}} settings",
                      name
                    })}
                    onClick={() => router.push(app.path)}
                  >
                    <span className="application-settings-page__item-index" aria-hidden="true">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className="application-settings-page__item-content">
                      <span className="application-settings-page__item-title">{name}</span>
                      {app.description ? (
                        <span className="application-settings-page__item-description">
                          {host.i18n.text(app.description)}
                        </span>
                      ) : null}
                    </span>
                    <span className="application-settings-page__item-arrow" aria-hidden="true">↗</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
