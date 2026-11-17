// packages/plugin-market/src/index.ts
// plugin-market 统一出口（显示名 Market，持久身份 apps）。

export { marketPlugin, marketSetup } from "./manifest.js";
export {
  APP_DIRECTORY_CAPABILITY,
  APP_DIRECTORY_TTL_MS,
  canonicalAppOrigin,
  createAppDirectoryService,
  useAppDirectory,
} from "./catalog.js";
export type {
  AppDirectoryEntry,
  AppDirectoryService,
  AppDirectoryServiceOptions,
  AppDirectorySnapshot,
  AppLocalInput,
  AppMarketEntryInput,
} from "./catalog.js";
