// packages/plugin-message/src/index.ts
// 系统消息应用 plugin-message：appId = `keymaster.message`（施工单 2026-07-03 001）。
//
// 该插件是 keymaster 平台唯一"查看 / 管理本地消息真值"的入口；它读取
// `appmsg.core`（即 platform 单例）提供的本地 DB / 同步状态 / 在线查询
// 能力，对外渲染一个 React Page（`MessagePage`）。

export { messagePlatformPlugin, MESSAGE_PLUGIN_ID } from "./manifest.js";
export { MessagePage } from "./MessagePage.js";
export { createMessageService } from "./messageService.js";
