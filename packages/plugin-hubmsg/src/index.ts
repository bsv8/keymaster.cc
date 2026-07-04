// packages/plugin-hubmsg/src/index.ts
// HubMsg provider 插件入口（施工单 2026-07-04 001 硬切换）。
//
//   - 唯一对外入口：`hubmsgPlatformPlugin`；
//   - 工厂：`createHubMsgProvider` 给测试 / 高级场景使用；
//   - 不导出 wire 类型（`HubMsgMessageRecord` / `HubMsgConnection` 等）：
//     这些仅在 plugin-hubmsg 内部使用。

export { hubmsgPlatformPlugin, HUBMSG_PLUGIN_ID } from "./manifest.js";
export {
  createHubMsgProvider,
  HUBMSG_PROVIDER_ID,
  HUBMSG_PROVIDER_DISPLAY_NAME,
  DEFAULT_HUBMSG_URL,
  type HubMsgProvider,
  type HubMsgProviderConfig
} from "./hubmsgProvider.js";