// packages/plugin-message/src/index.ts
// 消息业务插件 plugin-message（施工单 2026-07-04 001 硬切换）。
//
// 该插件是一个**极薄业务插件**，appId = `keymaster.message`：
//   - 通过 plugin-appmsg 的 `appmsg.endpoint.registry` 拿到稳定长寿
//     `AppMsgEndpointService`（endpoint = plugin-endpoint
//     `keymaster.message`）；
//   - service 内部自动处理 owner / active provider 真值迁移；本插件
//     **不**订阅 keyspace / vault / provider 任何事件；
//   - **不**走 `<pluginId>.appmsg.client` 旧 capability（runtime 已经
//     移除该注入路径）；
//   - **不**暴露 `subscriptionSource()` 旧"subscription token"接口；
//   - 页面 = `/messages`（会话列表）与 `/message/:publicKeyHex`（会话详情主路由）；
//   - 同时兼容 `/messages/:publicKeyHex` 作为会话详情别名；
//   - **不**展示 AppMsg 连接态 / 同步态 / 在线查询 / 全库统计——
//     这些由 `plugin-appmsg` 的 `/system/appmsg` 管理页负责。
//
// 样式入口：本插件自带 `src/styles.css`；装配层在
// `apps/web/src/styles/plugins.css` 显式 `@import` 引入。

export { messagePlatformPlugin, MESSAGE_PLUGIN_ID } from "./manifest.js";
export { MessagePage } from "./MessagePage.js";
export { MessageDetailPage } from "./MessageDetailPage.js";
export { createMessageService, type MessageService } from "./messageService.js";
