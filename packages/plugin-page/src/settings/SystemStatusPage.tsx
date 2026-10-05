import { useSyncExternalStore } from "react";
import { usePluginCapability } from "webloom-framework/react";
import { PAGE_UI_RENDERER_CAPABILITY } from "@keymaster/contracts";
import { PageHeader } from "@keymaster/ui";
import { usePluginI18n } from "@keymaster/runtime";

/** page 的组合出口保留贡献实例边界，Settings 不取得网关组件或私有服务。 */
export function SystemStatusPage() {
  const { t } = usePluginI18n();
  const pages = usePluginCapability(PAGE_UI_RENDERER_CAPABILITY);
  useSyncExternalStore(pages.subscribe, pages.revision, pages.revision);
  const path = "/settings/system-status";
  return <div className="system-status-page">
    <PageHeader
      title={t("settings.systemStatus.title", { defaultValue: "Broadcast gateway" })}
      description={t("settings.systemStatus.description", { defaultValue: "Manage broadcast gateway suppliers and service status." })}
    />
    {pages.hasSettings(path)
      ? <div className="system-status-page__modules">{pages.renderSettings(path)}</div>
      : <p className="system-status-page__empty">{t("settings.systemStatus.empty", { defaultValue: "No broadcast gateway modules are available." })}</p>}
  </div>;
}
