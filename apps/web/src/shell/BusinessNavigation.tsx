import { useCurrentPath, usePluginHost, useRegistry, useRuntimeStatus } from "@keymaster/runtime";
import type { BusinessFeature } from "@keymaster/contracts";
import { router } from "./RouteRenderer.js";

export function sortBusinessDomains<T extends { id: string; order: number }>(domains: readonly T[]): T[] {
  return [...domains].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function BusinessNavigation({ onClose }: { onClose: () => void }) {
  const host = usePluginHost();
  const { vault } = useRuntimeStatus();
  const path = useCurrentPath();
  const unlocked = vault === "unlocked";
  const domains = useRegistry((h) => h.business.listDomains());
  return <div className="app-sidebar__business" aria-label={host.i18n.text({ key: "shell.businessNavigation", fallback: "业务导航" })}>
    <h4>{host.i18n.text({ key: "shell.businessNavigation", fallback: "业务导航" })}</h4>
    {sortBusinessDomains(domains).map((domain) => <div key={domain.id} className="app-sidebar__group">
      <h5>{host.i18n.text(domain.label)}</h5>
      <ul>{[...domain.features].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)).filter((feature) => feature.entry.visibleWhen ? feature.entry.visibleWhen({ unlocked }) : true).map((feature: BusinessFeature) => <li key={feature.id}>
        <button type="button" className={`app-sidebar__item ${path === feature.entry.path ? "is-active" : ""}`} onClick={() => { router.push(feature.entry.path); onClose(); }}>
          {host.i18n.text(feature.label)}
        </button>
      </li>)}</ul>
    </div>)}
  </div>;
}
