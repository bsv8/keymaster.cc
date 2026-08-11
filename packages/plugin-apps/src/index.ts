// packages/plugin-apps/src/index.ts
// plugin-apps 统一出口。

export { appsPlugin } from "./manifest.js";
export { createCatalogResolver, loadCatalog, validateAppEntry, validateAppIdentityProof, validateCatalog } from "./catalog.js";
export type { AppCatalogEntry, AppCatalogInvalidEntry } from "./catalog.js";
