// packages/plugin-appmsg/src/index.ts
// 应用消息总线平台插件（施工单 2026-07-04 001 硬切换）。
//
//   - 唯一对外入口：`appmsgPlatformPlugin`；
//   - 内部职责：
//       * 提供 `appmsg.core` capability（AppMsgCoreImpl 单例）；
//       * 提供 `message.provider.registry` capability（plugin-hubmsg
//         / 未来其它 provider register 自身用）；
//       * 提供 `appmsg.endpoint.registry` capability（plugin-message 等
//         业务插件拿稳定 endpoint service 用）；
//       * 与 active provider 建立 bind / send / list / get / subscribe；
//       * 维护 key-scoped 本地消息库（每把 key 一个 namespace DB）；
//       * 推送分发：服务端 push → 本地 DB → endpoint service 订阅者；
//       * 增量同步：本地 cursor + 重连 / 推送触发；
//       * 在线查询：active provider `checkOnline`；
//       * AppMsg 管理页：`/system/appmsg` + system 分组菜单项 AppMsg；
//       * 订阅 owner / vault / provider 变化驱动 reconnect。
//   - 业务消息页走独立的 `plugin-message`（appId=`keymaster.message`），
//     是一个普通 scoped 消息插件，**不**走任何特权旁路。
//   - **plugin-appmsg 不再 import HubMsg 线协议实现**：所有 provider 通信
//     走 typed `MessageProvider` / `MessageProviderOperations` 接口。

export {
  appmsgPlatformPlugin,
  APPMSG_PLUGIN_ID,
  APPMSG_ROUTE_PATH
} from "./manifest.js";
export { AppMsgCoreImpl, type AppMsgCoreConfig } from "./appmsgCore.js";
export { AppMsgPage } from "./AppMsgPage.js";
export {
  createAppMsgService,
  type AppMsgService
} from "./appmsgService.js";
export { collectMessageEndpoints, connectionStatusClass } from "./AppMsgPage.js";
export type {
  AppMsgCore,
  AppMsgEndpointService,
  AppMsgEndpointServiceRegistry,
  AppMsgMessage,
  AppMsgRecipient,
  AppMsgSendInput,
  AppMsgSendResult,
  AppMsgListInput,
  AppMsgListResult,
  AppMsgGetInput,
  AppMsgOnlineInput,
  AppMsgOnlineResult,
  AppMsgOnlineStatus,
  AppMsgScope,
  AppMsgSenderProjection,
  AppMsgTargetSyncState,
  AppMsgLocalDbSnapshot,
  AppMsgEndpointId
} from "@keymaster/contracts";