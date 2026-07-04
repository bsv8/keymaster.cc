// packages/plugin-appmsg/src/index.ts
// 应用消息总线平台插件（施工单 2026-07-03 002）。
//
//   - 单一对外入口：appmsg.platform plugin；
//   - 内部职责：
//       * 与 HubMsg 建立单 WSS 连接（HubMsg 真值层）；
//       * 维护 key-scoped 本地消息库（每把 key 一个 namespace DB）；
//       * 推送分发：服务端 push → 本地 DB → 订阅者；
//       * 增量同步：本地 cursor + 重连 / 推送触发；
//       * 在线查询：HubMsg `message.online`；
//       * 对外暴露简单 facade `AppMsgSimpleClient`；
//       * HubMsg 管理页：`/system/hubmsg` + system 分组菜单项。
//   - HubMsg 连接真值在这里，**不**在 protocolService。
//   - 系统消息业务页走独立的 `plugin-message`（appId=`keymaster.message`），
//     是一个普通 scoped 消息插件，**不**走任何特权旁路。

export { appmsgPlatformPlugin, APPMSG_PLUGIN_ID, HUBMSG_ROUTE_PATH } from "./manifest.js";
export { AppMsgPluginClientImpl, makePluginScopedClient } from "./pluginClient.js";
export { AppMsgCoreImpl, type AppMsgCoreConfig } from "./appmsgCore.js";
export { HubMsgConnectionImpl } from "./hubmsgConnection.js";
export { signCompactSecp256k1 } from "./signing.js";
export { HubMsgPage } from "./HubMsgPage.js";
export { createHubMsgService, type HubMsgService } from "./hubmsgService.js";
export type {
  AppMsgCore,
  AppMsgPluginClient,
  AppMsgSimpleClient
} from "@keymaster/contracts";