import type { PluginManifest, RuntimeUnitImplementationRegistry } from "@keymaster/contracts";
import { WEB_PLUGIN_IMPLEMENTATIONS } from "./pluginCatalogSource.js";

/** Window assembly never imports any Worker implementation entry. */
export function createWebRuntimeUnitImplementationRegistry(manifests: readonly PluginManifest[]): RuntimeUnitImplementationRegistry {
  const implementations = new Map<string, typeof WEB_PLUGIN_IMPLEMENTATIONS[number]>(WEB_PLUGIN_IMPLEMENTATIONS.map(entry => [entry.manifest.id, entry]));
  const units = new Map(manifests.map(manifest => [manifest.id, new Set((manifest.units ?? []).filter(unit => unit.runtime === "window-main").map(unit => unit.id))]));
  return { get(pluginId, unitId) {
    if (!unitId || !units.get(pluginId)?.has(unitId)) return undefined;
    return implementations.get(pluginId)?.setup;
  } };
}
