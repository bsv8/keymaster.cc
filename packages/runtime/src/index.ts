// packages/runtime/src/index.ts
// 运行时包统一导出。
// 设计缘由：业务组件只 import 这个入口，不直接 deep import 内部模块。

// 重新导出 MessageBus 类型，让 plugin-vault 等包可以
// `import type { MessageBus } from "@keymaster/runtime"`。
export type { MessageBus } from "@keymaster/contracts";
export * from "./createPluginHost.js";
export * from "./capabilityRegistry.js";
export * from "./messageBus.js";
export * from "./registries/routeRegistry.js";
export * from "./registries/menuRegistry.js";
export * from "./registries/breadcrumbRegistry.js";
export * from "./registries/settingsRegistry.js";
export * from "./registries/homeRegistry.js";
export * from "./registries/commandRegistry.js";
export * from "./registries/importerRegistry.js";
export * from "./registries/transferRegistry.js";
export * from "./registries/assetRegistry.js";
export * from "./registries/topbarRegistry.js";
export * from "./navigate.js";
export * from "./react/PluginHostProvider.js";
export * from "./react/useCapability.js";
export * from "./react/useRegistry.js";
export * from "./react/useRuntimeStatus.js";
export * from "./react/useI18n.js";
export * from "./react/useCurrentPath.js";
export * from "./i18n/i18nStore.js";
export * from "./i18n/languageMap.js";
export * from "./i18n/createI18nService.js";
