// packages/plugin-bsv-price/src/index.ts
// BSV 价格业务插件统一入口（施工单 2026-07-08 001）。

export {
  bsvPricePlugin,
  BSV_PRICE_PLUGIN_ID,
  BSV_PRICE_SERVICE_CAPABILITY
} from "./manifest.js";
export {
  createBsvPriceService,
  type BsvPriceService,
  type BsvPriceServiceSnapshot,
  type BsvPriceServiceStatus
} from "./bsvPriceService.js";
export {
  BSV_PRICE_SETTINGS_STORAGE_KEY,
  createLocalStorageBsvPriceSettingsStore,
  normalizePublisherPublicKeyHex,
  readBsvPriceGlobalConfig,
  writeBsvPriceGlobalConfig,
  type BsvPriceGlobalConfig,
  type BsvPricePublicKeyCheck,
  type BsvPriceSettingsStore
} from "./bsvPriceSettings.js";
export {
  decodePriceBody,
  type BsvPriceQuote,
  type BsvPriceSnapshot
} from "./bsvPriceProtocol.js";
export {
  PRICECAST_PROTOCOL_ID,
  PRICECAST_CHANNEL_SUFFIX,
  BSV_PRICE_SETTINGS_PATH,
  BSV_PRICE_CONFIG_KEY,
  buildPriceChannelId
} from "./constants.js";
export { BsvPricePage } from "./BsvPricePage.js";
export { BsvPriceSettingsPage } from "./BsvPriceSettingsPage.js";
export { BsvPriceHomeWidget } from "./BsvPriceHomeWidget.js";
