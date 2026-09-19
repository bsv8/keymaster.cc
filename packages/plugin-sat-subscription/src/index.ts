// SatSubscription 插件公共出口。

export {
  satSubscriptionPlugin,
  satSubscriptionSetup,
  SAT_SUBSCRIPTION_ROUTE_PATH,
  SAT_SUBSCRIPTION_PLUGIN_ID
} from "./manifest.js";
export {
  SatSubscriptionProvider,
  createSatSubscriptionProvider,
  type SatSubscriptionProviderConfig,
  type SatSubscriptionTransport,
  type SatSupplierConnection
} from "./satProvider.js";
export {
  createSatSubscriptionState,
  type SatSubscriptionStateStore,
  type SatSubscriptionStateSnapshot
} from "./satState.js";
export {
  applyDefaultSatSupplier,
  createDefaultSatSupplierConfig,
  SAT_DEFAULT_SUPPLIER_ID,
  SAT_DEFAULT_SUPPLIER_MULTIADDRS,
  SAT_DEFAULT_SUPPLIER_NAME,
  SAT_DEFAULT_SUPPLIER_PUBLIC_KEY_HEX,
  isBuiltInDefaultSupplierConfig,
  type SatDefaultNetwork
} from "./defaults.js";
export {
  SatSpiService,
  createSatSpiService,
  mapSpiBsvNetwork,
  type SatP2pkhService,
  type SatSpiServiceConfig
} from "./satSpi.js";
export {
  createSatWorkerAdminService,
  createSatWorkerChannelRuntime,
  createSatWorkerSpiService,
  subscribeSatIncoming
} from "./satWorkerProxy.js";
