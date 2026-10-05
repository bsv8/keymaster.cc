import { URI_ACTION_REGISTRY_CAPABILITY, URI_ACTION_RESOLVER_CAPABILITY, SCAN_UI_CAPABILITY, PAGE_UI_REGISTRY_CAPABILITY, I18N_SERVICE_CAPABILITY, defineRuntimeUnitDependencies, type PluginManifest } from "@keymaster/contracts";
import { scanResources } from "./resources.js";
const scanPluginDefinition = { id: "scan", name: "Scan", description: "Unified local scanning and scoped URI action routing; business UI remains with its provider.",
 units: [{ id: "scan.window", runtime: "window-main", scopeKind: "root", provides: [URI_ACTION_REGISTRY_CAPABILITY, URI_ACTION_RESOLVER_CAPABILITY, SCAN_UI_CAPABILITY], dependencies: defineRuntimeUnitDependencies([{ capability: PAGE_UI_REGISTRY_CAPABILITY }, { capability: I18N_SERVICE_CAPABILITY }]) }], i18n: scanResources,
} satisfies PluginManifest;
export const scanPlugin = scanPluginDefinition;
export { scanSetup } from "./manifestUi.js";
