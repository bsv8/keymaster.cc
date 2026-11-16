// packages/plugin-apps/src/index.ts
// plugin-apps 统一出口。

export { appsPlugin, appsSetup } from "./manifest.js";
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
