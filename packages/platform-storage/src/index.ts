// Window assembly exports only the plugin definition and setup.
// Engines and private browsing remain in trusted Worker/assembly entrypoints.
export { STORAGE_PLATFORM_PLUGIN_ID, storagePlatformPlugin, storagePlatformSetup } from "./manifest.js";
