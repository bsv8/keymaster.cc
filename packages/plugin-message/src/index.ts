// packages/plugin-message/src/index.ts
// 消息业务插件 plugin-message（施工单 2026-07-03 002 硬切换）。
//
// 该插件是一个**普通 scoped 消息插件**，appId = `keymaster.message`：
//   - 通过 runtime 注入的 `<pluginId>.appmsg.client` 拿到 scoped client；
//   - 页面 = `/messages`（业务页）与 `/messages/:messageId`（详情页）；
//   - **不**展示 HubMsg 连接态 / 同步态 / 在线查询 / 全库统计——
//     这些由 `plugin-appmsg` 的 `/system/hubmsg` 管理页负责。
//
// 样式入口：本插件自带 `src/styles.css`；装配层在
// `apps/web/src/styles/plugins.css` 显式 `@import` 引入。

export { messagePlatformPlugin, MESSAGE_PLUGIN_ID } from "./manifest.js";
export { MessagePage } from "./MessagePage.js";
export { MessageDetailPage } from "./MessageDetailPage.js";
export { createMessageService, type MessageService } from "./messageService.js";