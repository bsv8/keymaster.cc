// packages/plugin-hubcast/src/index.ts
// HubCast provider 插件入口（施工单 2026-07-06 001 硬切换）。
//
//   - 唯一对外入口：`hubcastPlatformPlugin`；
//   - 工厂：`createHubCastProvider` 给测试 / 高级场景使用；
//   - 不导出 wire 类型（`HubCastConnection` 等）：这些仅在 plugin-hubcast
//     内部使用。

export { hubcastPlatformPlugin, HUBCAST_PLUGIN_ID } from "./manifest.js";
export {
  createHubCastProvider,
  HUBCAST_PROVIDER_ID,
  HUBCAST_PROVIDER_DISPLAY_NAME,
  DEFAULT_HUBCAST_URL,
  type HubCastProvider,
  type HubCastProviderConfig
} from "./hubcastProvider.js";