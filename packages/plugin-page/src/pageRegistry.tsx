import { useInstanceActive } from "@keymaster/runtime";
import { Fragment, createElement, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import { ScopedPluginConsumerProvider as PluginConsumerProvider } from "@keymaster/runtime";
import { createScopedRegistryView } from "webloom-framework/advanced";
import type { PluginConsumer } from "webloom-framework";
import { isIssuedKeymasterConsumer } from "@keymaster/runtime";
import { PAGE_UI_REGISTRY_CAPABILITY } from "@keymaster/contracts";
import type { PageUiContribution, PageUiRegistry, PageUiRenderer, PageUiLocation, I18nText } from "@keymaster/contracts";
import { comparePagePaths, matchPagePath, pagePathShape, validatePagePath } from "./pagePath.js";

interface OwnedEntry { entry: PageUiContribution; consumer: PluginConsumer; ownerInstanceId: string; component: ComponentType<{ location: PageUiLocation }> }
function validate(entry: PageUiContribution): void {
  if (!entry || typeof entry.id !== "string" || !entry.id || typeof entry.render !== "function") throw new TypeError("Invalid page contribution");
  if (entry.order !== undefined && !Number.isFinite(entry.order)) throw new TypeError("Invalid contribution order");
  if (!entry.label || (typeof entry.label !== "string" && typeof entry.label.key !== "string")) throw new TypeError("Invalid contribution label");
  if (entry.kind === "page" || entry.kind === "settings-block") {
    if (entry.kind === "page" && entry.settingsPlacement !== undefined && entry.settingsPlacement !== "after" && entry.settingsPlacement !== "embedded") throw new TypeError("Invalid settings placement");
    if (typeof entry.path !== "string") throw new TypeError("Invalid page path");
    validatePagePath(entry.path);
  } else if (entry.kind === "home") {
    if (entry.slot !== "main" && entry.slot !== "aside") throw new TypeError("Invalid home slot");
    if (entry.space && (!entry.space.id || !Number.isFinite(entry.space.order) || !entry.space.label)) throw new TypeError("Invalid home space");
  } else if (entry.kind === "frame") {
    if (!["unlocked-shell", "wallet-entry", "wallet-guard", "storage-guard", "protocol-popup", "onboarding", "uri-action"].includes(entry.slot)) throw new TypeError("Invalid frame slot");
  } else if (entry.kind !== "header" || (entry.slot !== "topbar" && entry.slot !== "above-header")) throw new TypeError("Invalid contribution kind or slot");
}
function Contents({ entry, location }: { entry: PageUiContribution; location: PageUiLocation }) { return <>{entry.render(location)}</>; }

/** 注册表、可执行条目与 renderer 都由 page 实例拥有，外界不能枚举原始条目。 */
export function createPageRegistry(resolveText: (label: I18nText) => string = label => typeof label === "string" ? label : label.fallback ?? label.key): { registry: PageUiRegistry; renderer: PageUiRenderer; dispose(): void } {
  const entries = new Map<string, OwnedEntry>();
  const bindings = new WeakMap<PluginConsumer, ReturnType<PageUiRegistry["bind"]>>();
  const listeners = new Set<() => void>();
  let disposed = false;
  let revision = 0;
  const changed = () => {
    revision++;
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* 观察方故障不能破坏注册提交或撤销清理。 */ }
    }
  };
  const active = () => { if (disposed) throw new Error("Page registry is disposed"); };
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  const snapshot = () => revision;
  const render = (owned: OwnedEntry, location: PageUiLocation): ReactNode => createElement(owned.component, {
    key: owned.ownerInstanceId + ":" + owned.entry.id,
    location,
  });
  const matching = (predicate: (entry: PageUiContribution) => boolean) => [...entries.values()]
    .filter(owned => owned.consumer.status === "active" && predicate(owned.entry))
    .sort((a, b) => (a.entry.order ?? 0) - (b.entry.order ?? 0) || a.entry.id.localeCompare(b.entry.id));
  const registry: PageUiRegistry = {
    bind(consumer, scope) {
      active();
      if (!isIssuedKeymasterConsumer(consumer, scope) || consumer.status !== "active"
        || scope.identity.instanceId !== consumer.instanceId || scope.identity.pluginId !== consumer.pluginId) throw new Error("Page contribution requires its own issued consumer and Scope");
      scope.assertActive();
      consumer.capability(PAGE_UI_REGISTRY_CAPABILITY);
      const existing = bindings.get(consumer);
      if (existing) return existing;
      const target = {
        register(entry: PageUiContribution & { ownerInstanceId?: string }) {
          active(); scope.assertActive(); validate(entry);
          if (entry.ownerInstanceId !== consumer.instanceId) throw new Error("Page contribution owner mismatch");
          if (entries.has(entry.id)) throw new Error(`Page contribution id already registered: ${entry.id}`);
          if (entry.kind === "page" && matching(candidate => candidate.kind === "page" && pagePathShape(candidate.path) === pagePathShape(entry.path)).length) {
            throw new Error(`Page contribution path already registered: ${entry.path}`);
          }
          if (entry.kind === "frame" && matching(candidate => candidate.kind === "frame" && candidate.slot === entry.slot).length) throw new Error(`Page frame slot already registered: ${entry.slot}`);
          const contribution = Object.freeze({ ...entry });
          // 出口不携带 consumer/私有闭包作为 props；缓存过的渲染节点也随条目撤下。
          function MountedContribution({ location }: { location: PageUiLocation }) {
            useSyncExternalStore(subscribe, snapshot, snapshot);
            const instanceActive = useInstanceActive(consumer, scope);
            if (!instanceActive || disposed || entries.get(contribution.id)?.component !== MountedContribution) return null;
            return createElement(PluginConsumerProvider, { consumer,
              children: createElement(Contents, { entry: contribution, location }),
            });
          }
          entries.set(entry.id, { entry: contribution, consumer, ownerInstanceId: consumer.instanceId, component: MountedContribution }); changed();
        },
        unregister(id: string) {
          // 框架的条件清理与 scope 所属实例双重校验，旧清理不能移除同名新条目。
          const owned = entries.get(id);
          if (!owned || owned.ownerInstanceId !== consumer.instanceId) throw new Error("Page contribution is not owned by this instance");
          entries.delete(id); changed();
        },
      };
      const binding = createScopedRegistryView(target, scope, { name: "page.ui",
        registrations: [{ method: "register", idArgument: 0, unregisterMethod: "unregister", ownerInstanceIdProperty: "ownerInstanceId" }],
      });
      bindings.set(consumer, binding);
      return binding;
    },
  };
  const renderer: PageUiRenderer = {
    revision: () => revision,
    hasPage(path) { active(); return matching(entry => entry.kind === "page" && !!matchPagePath(entry.path, path)).length > 0; },
    hasSettings(path) { active(); return matching(entry => entry.kind === "settings-block" && !!matchPagePath(entry.path, path)).length > 0; },
    renderPage(path) {
      active();
      const entry = matching(entry => entry.kind === "page" && !!matchPagePath(entry.path, path))
        .sort((a, b) => a.entry.kind === "page" && b.entry.kind === "page" ? comparePagePaths(a.entry.path, b.entry.path) : 0)[0];
      if (!entry || entry.entry.kind !== "page") return null;
      const location = matchPagePath(entry.entry.path, path)!;
      return createElement(Fragment, null, render(entry, location),
        entry.entry.settingsPlacement === "embedded" ? null : renderer.renderSettings(path));
    },
    renderSettings(path) { active(); return matching(entry => entry.kind === "settings-block" && !!matchPagePath(entry.path, path)).map(entry => render(entry, matchPagePath((entry.entry as Extract<PageUiContribution, { kind: "settings-block" }>).path, path)!)); },
    renderFrame(slot, children, width) { active(); return matching(entry => entry.kind === "frame" && entry.slot === slot).map(entry => render(entry, { path: "", params: {}, children, width })); },
    renderHome(slot, unlocked) {
      active();
      const items = matching(entry => entry.kind === "home" && entry.slot === slot && (!entry.visibleWhen || entry.visibleWhen({ unlocked })));
      const groups = new Map<string, OwnedEntry[]>();
      const ungrouped: OwnedEntry[] = [];
      for (const item of items) {
        if (item.entry.kind !== "home") continue;
        if (!item.entry.space) { ungrouped.push(item); continue; }
        const group = groups.get(item.entry.space.id) ?? [];
        group.push(item); groups.set(item.entry.space.id, group);
      }
      const location = { path: "/", params: {} };
      const cell = (item: OwnedEntry) => createElement("div", { key: item.entry.id, className: "home-layout__cell" }, render(item, location));
      const spaces = [...groups.values()].sort((a, b) => {
        const x = (a[0]!.entry as Extract<PageUiContribution, { kind: "home" }>).space!;
        const y = (b[0]!.entry as Extract<PageUiContribution, { kind: "home" }>).space!;
        return x.order - y.order || x.id.localeCompare(y.id);
      });
      return createElement(Fragment, null, ...ungrouped.map(cell), ...spaces.map(group => {
        const space = (group[0]!.entry as Extract<PageUiContribution, { kind: "home" }>).space!;
        return createElement("section", { key: space.id, className: "business-home__space" }, createElement("h2", null, resolveText(space.label)), ...group.map(cell));
      }));
    },
    renderHeader(slot) { active(); return matching(entry => entry.kind === "header" && entry.slot === slot).map(entry => render(entry, Object.freeze({ path: "", params: Object.freeze({}) }))); },
    subscribe(listener) { active(); listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return { registry, renderer, dispose() { if (disposed) return; disposed = true; entries.clear(); changed(); listeners.clear(); } };
}
