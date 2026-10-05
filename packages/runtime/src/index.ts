// packages/runtime/src/index.ts
// 运行时包统一导出。
// 设计缘由：业务组件只 import 这个入口，不直接 deep import 内部模块。

// Keymaster 的唯一生产 Host 装配入口：通用生命周期由 WebLoom 创建，
// 这里仅组合 Keymaster Registry、Storage、i18n 和 Coordinator。
export type { PluginHost, CreatePluginHostOptions } from "./pluginHostContract.js";
export * from "./keyValueSettingsStore.js";
export * from "./navigate.js";
export * from "./react/useI18n.js";
export * from "./react/useBsvPrice.js";
export * from "./react/useOptionalResource.js";
export * from "./react/useCurrentPath.js";
export * from "./react/AppLink.js";
export * from "./i18n/i18nStore.js";
export * from "./i18n/languageMap.js";
export * from "./i18n/createI18nService.js";
export * from "./storage/inMemoryKeyValueStore.js";
export * from "./lifecycle/scopedChannelRuntime.js";

// 施工单 2026-06-30 001：全局 fatal store。apps/web 与 plugin-vault 等
// 都通过本入口上报 / 订阅 fatal 错误。`resetFatalErrorForTest` 作为测试
// 夹具浅 re-export 暴露，业务代码不依赖。
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

export { isIssuedKeymasterConsumer } from "./consumerAuthority.js";

export { INSTANCE_REGISTRY_BINDING, createInstanceRegistry, createInstanceRegistryService } from "./instanceRegistry.js";
export { createScopedClientBinding } from "./scopedClientBinding.js";

export { useInstanceActive } from "./react/useInstanceActive.js";
export { observeOptionalCapability } from "./observeOptionalCapability.js";

export { ScopedPluginConsumerProvider } from "./react/ScopedPluginConsumerProvider.js";

export { useWalletState } from "./react/useWalletState.js";
