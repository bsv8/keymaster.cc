import { useEffect, useRef } from "react";
import { usePageRenderer } from "./PageOutlet.js";
import { router, useCurrentPath, usePluginI18n } from "@keymaster/runtime";
export { router };
export function RouteRenderer() {
  const pages = usePageRenderer();
  const path = useCurrentPath();
  const { t } = usePluginI18n();
  const location = typeof window === "undefined" ? path : path + window.location.search + window.location.hash;
  const matched = !!pages?.hasPage(location);
  const previous = useRef<{ location: string; matched: boolean }>();
  useEffect(() => {
    const current = previous.current;
    previous.current = { location, matched };
    if (!matched && current?.matched && current.location === location) {
      const fallback = pages?.hasPage("/settings/plugins") ? "/settings/plugins" : pages?.hasPage("/") ? "/" : undefined;
      if (fallback) router.push(fallback);
    }
  });
  return matched ? <>{pages!.renderPage(location)}</> : <div className="route-not-found"><h2>404</h2><p>{t("common.status.empty", { defaultValue: "Page not found" })}</p></div>;
}
