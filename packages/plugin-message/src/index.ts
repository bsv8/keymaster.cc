// packages/plugin-message/src/index.ts
// 消息业务插件 plugin-message（施工单 2026-09-02/003）。
//
// 该插件是一个**极薄业务插件**，appId = `keymaster.message`：
//   - 通过 Coordinator Channel runtime 发送固定私密消息协议；
//   - 消息历史只存本地 key-scoped DB，不拉取远端历史；
//   - owner、签名、加密、供应商选择和物理订阅全部由 Coordinator 持有；
//   - 页面 = `/messages`（会话列表）与 `/message/:publicKeyHex`（会话详情主路由）；
//   - 同时兼容 `/messages/:publicKeyHex` 作为会话详情别名；
//   - **不**展示传输连接态、在线查询或远端全库统计。
//
// 样式入口：本插件自带 `src/styles.css`；装配层在
// `apps/web/src/styles/plugins.css` 显式 `@import` 引入。

export { messagePlatformPlugin, MESSAGE_PLUGIN_ID } from "./manifest.js";
export { MessagePage } from "./MessagePage.js";
export { MessageDetailPage } from "./MessageDetailPage.js";
export { createMessageService, type MessageService } from "./messageService.js";
