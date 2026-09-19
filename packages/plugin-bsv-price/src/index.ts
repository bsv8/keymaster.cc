// packages/plugin-bsv-price/src/index.ts
// BSV 价格业务插件统一入口。

export {
  bsvPricePlugin,
  bsvPriceSetup,
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
  createDefaultBsvPriceConfig,
  createKeyValueBsvPriceSettingsStore,
  createMemoryBsvPriceSettingsStore,
  deriveUnitFromPair,
  normalizeMarketIdentifier,
  normalizePublisherPublicKeyHex,
  normalizeServerName,
  type BsvPriceActiveOption,
  type BsvPriceGlobalConfig,
  type BsvPricePublicKeyCheck,
  type BsvPriceServerConfig,
  type BsvPriceSettingsStore,
  type BsvPriceTextCheck
} from "./bsvPriceSettings.js";
export {
  decodePriceContent,
  decodePriceBody,
  formatPriceAmount,
  PRICE_DISPLAY_DECIMALS,
  PRICE_DISPLAY_ZERO,
  selectMarketPrice,
  type BsvPriceSnapshot
} from "./bsvPriceProtocol.js";
export {
  BSV_PRICE_CHANNEL_PREFIX,
  BSV_PRICE_PROTOCOL,
  BSV_PRICE_SETTINGS_PATH,
  BSV_PRICE_CONFIG_KEY,
  DEFAULT_PRICE_MARKET,
  DEFAULT_PRICE_PAIR,
  DEFAULT_PRICE_PUBLISHER_PUBLIC_KEY_HEX,
  DEFAULT_PRICE_SERVER_NAME
} from "./constants.js";
export { BsvPricePage } from "./BsvPricePage.js";
export { BsvPriceSettingsPage } from "./BsvPriceSettingsPage.js";
export { BsvPriceHomeWidget } from "./BsvPriceHomeWidget.js";
