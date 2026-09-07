// packages/runtime/src/index.ts
// 运行时包统一导出。
// 设计缘由：业务组件只 import 这个入口，不直接 deep import 内部模块。

// Keymaster 的唯一生产 Host 装配入口：通用生命周期由 WebLoom 创建，
// 这里仅组合 Keymaster Registry、Storage、i18n、日志和 Coordinator。
export * from "./keymasterHostAdapter.js";
export type { PluginHost, CreatePluginHostOptions } from "./pluginHostContract.js";
export { bindWebLoomHost, getWebLoomHost } from "./pluginHostContract.js";
export * from "./pluginConfigStore.js";
export * from "./pluginConfigStoreContract.js";
export * from "./keyValueSettingsStore.js";
export * from "./registries/routeRegistry.js";
export * from "./registries/breadcrumbRegistry.js";
export * from "./registries/settingsRegistry.js";
export * from "./registries/systemSettingsRegistry.js";
export * from "./registries/systemStatusRegistry.js";
export * from "./registries/homeRegistry.js";
export * from "./registries/businessFeatureRegistry.js";
export * from "./registries/commandRegistry.js";
export * from "./registries/importerRegistry.js";
export * from "./registries/vaultSettingsRegistry.js";
export * from "./registries/transferRegistry.js";
export * from "./registries/assetRegistry.js";
export * from "./registries/applicationSettingsRegistry.js";
export * from "./registries/topbarRegistry.js";
export * from "./registries/noticeRegistry.js";
export * from "./navigate.js";
export * from "./react/PluginHostProvider.js";
export * from "./react/useRegistry.js";
export * from "./react/useRuntimeStatus.js";
export * from "./react/useI18n.js";
export * from "./react/useCurrentPath.js";
export * from "./react/usePluginRuntime.js";
export * from "./react/AppLink.js";
export * from "./i18n/i18nStore.js";
export * from "./i18n/languageMap.js";
export * from "./i18n/createI18nService.js";
// 硬切换 002：统一日志 service 由 runtime 内建。
// 业务插件只通过 ctx.logger 写入；本入口只暴露 createLogService 供 host
// 装配和测试夹具使用，K-V 层不外暴露。
export * from "./log/logService.js";
export * from "./storage/inMemoryKeyValueStore.js";
export * from "./lifecycle/scopedChannelRuntime.js";

// 施工单 2026-06-30 001：全局 fatal store。apps/web 与 plugin-vault 等
// 都通过本入口上报 / 订阅 fatal 错误。`resetFatalErrorForTest` 与
// disposeLogRepository 同样作为测试夹具浅 re-export 暴露，业务代码不依赖。
export {
  reportFatalError,
  getFatalError,
  getFatalTail,
  subscribeFatalError,
  resetFatalErrorForTest,
  type FatalErrorReportInput,
  type FatalErrorSnapshot,
  type FatalPhase,
  type FatalScope,
  type FatalSource
} from "./fatalErrorStore.js";
