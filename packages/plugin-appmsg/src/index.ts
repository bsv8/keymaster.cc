// packages/plugin-appmsg/src/index.ts
// 应用消息总线平台插件（施工单 2026-07-01 002 硬切换）。
//
// 设计缘由：
//   - 单一对外入口：appmsg.platform plugin。
//   - 内部职责：
//       * 与 HubMsg 建立单 WSS 连接（HubMsg 真值层）；
//       * 绑定当前 owner；
//       * 维护本地缓存（最近消息列表 + 补拉窗口）；
//       * 向 protocolService 暴露 `appmsg.core`（origin-adapter）；
//       * 向声明了 `appMessageEndpoint` 的插件注入 scoped `appmsg.client`。
//   - HubMsg 连接真值在这里，**不**在 protocolService。
//   - runtime 在 plugin host enable / disable 阶段按
//     `manifest.appMessageEndpoint` 决定是否给该插件注入 scoped client。

export { appmsgPlatformPlugin } from "./manifest.js";
export type { AppMsgCore, AppMsgPluginClient } from "@keymaster/contracts";