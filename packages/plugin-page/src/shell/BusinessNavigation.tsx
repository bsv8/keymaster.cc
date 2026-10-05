import { usePageResources } from "../PageResourceContext.js";
import type { BusinessDomain } from "@keymaster/contracts";
import { useCurrentPath, usePluginI18n, useResourceViewSelector } from "@keymaster/runtime";
import type { BusinessFeature } from "@keymaster/contracts";
import { router } from "./RouteRenderer.js";

export function sortBusinessDomains<T extends { id: string; order: number }>(domains: readonly T[]): T[] {
  return [...domains].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/** 入口可声明自己的子路由激活范围（例如联系人列表下的某个详情页）。 */
export function isBusinessFeatureActive(feature: BusinessFeature, path: string): boolean {
  return path === feature.entry.path || feature.entry.activeWhen?.(path) === true;
}

export function BusinessNavigation({ onClose }: { onClose: () => void }) {
  const resources = usePageResources();
  const { text } = usePluginI18n();
  const path = useCurrentPath();
  const unlocked = true;
  const domains = useResourceViewSelector<BusinessDomain[], BusinessDomain[]>(resources, "page.navigation", [], s => s.data ?? []);
  return <nav className="app-sidebar__business" aria-label={text({ key: "shell.primaryNavigation", fallback: "Primary navigation" })}>
    {sortBusinessDomains(domains).map((domain) => <div key={domain.id} className="app-sidebar__group">
      <h5>{text(domain.label)}</h5>
      <ul>{[...domain.features].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)).filter((feature) => feature.entry.visibleWhen ? feature.entry.visibleWhen({ unlocked }) : true).map((feature: BusinessFeature) => <li key={feature.id}>
        <button type="button" className={`app-sidebar__item ${isBusinessFeatureActive(feature, path) ? "is-active" : ""}`} onClick={() => { router.push(feature.entry.path); onClose(); }}>
          {text(feature.label)}
        </button>
      </li>)}</ul>
    </div>)}
  </nav>;
}
