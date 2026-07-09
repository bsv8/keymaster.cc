// packages/plugin-webrtc/src/index.ts
// WebRTC 业务插件 plugin-webrtc（施工单 2026-07-04 002 硬切换）。
//
// 该插件是一个**极薄业务插件**，appId = `keymaster.webrtc`：
//   - 通过 plugin-appmsg 的 `appmsg.endpoint.registry` 拿到稳定长寿
//     `AppMsgEndpointService`（endpoint = `keymaster.webrtc`）；
//   - service 内部自动处理 owner / active provider 真值迁移；本插件
//     **不**订阅 keyspace / vault / provider 任何事件；
//   - **不**走 `<pluginId>.appmsg.client` 旧 capability（runtime 已经
//     移除该注入路径）；
//   - **不**暴露 `subscriptionSource()` 旧"subscription token"接口；
//   - 页面 = `/system/webrtc`（工作台）与 `/settings/webrtc`（设置详情页）；
//   - **不**展示 AppMsg 连接态 / 在线查询 / 全库统计——这些由
//     `plugin-appmsg` 的 `/system/appmsg` 管理页负责；
//   - **不**做 TURN / 中继账号配置 / 通话记录 / 离线补偿。
//
// 样式入口：本插件自带 `src/styles.css`；装配层在
// `apps/web/src/styles/plugins.css` 显式 `@import` 引入。

export {
  webrtcPlugin
} from "./manifest.js";
export {
  WebrtcPage
} from "./WebrtcPage.js";
export {
  WebrtcSettingsPage
} from "./WebrtcSettingsPage.js";
export {
  createWebrtcService,
  createBrowserWebrtcEnvironment,
  type WebrtcService,
  type WebrtcSessionSnapshot,
  type WebrtcSessionPhase,
  type WebrtcMode,
  type WebrtcRemoteNotice,
  type WebrtcRemoteNoticeKind,
  type WebrtcBlockReason,
  type WebrtcSubscriber,
  type WebrtcEnvironment,
  type RTCPeerConnectionLike,
  type MediaStreamLike,
  type StunDiagnosticResult,
  type StartCallInput,
  type WebrtcLogger
} from "./webrtcService.js";
export {
  createWebrtcHistoryService,
  type WebrtcHistoryService,
  type WebrtcHistoryItem
} from "./webrtcHistoryService.js";
export {
  type WebrtcConfig,
  type WebrtcConfigStore,
  DEFAULT_STUN_SERVERS,
  validateStunUrl,
  validateStunServers,
  coerceWebrtcConfig,
  createLocalStorageWebrtcConfigStore,
  createMemoryWebrtcConfigStore,
  getDefaultWebrtcLocalStorage,
  WEBRTC_CONFIG_STORAGE_KEY
} from "./webrtcConfig.js";
export {
  WEBRTC_SIGNAL_SCHEMA,
  DEFAULT_SIGNAL_TTL_MS,
  parseSignalBody,
  serializeSignal,
  isSignalExpired,
  isAcceptableRemoteSessionId,
  tryParseSignal,
  type WebrtcSignal,
  type WebrtcSignalEnvelope,
  type WebrtcSignalType,
  type WebrtcInviteSignal,
  type WebrtcAnswerSignal,
  type WebrtcIceSignal,
  type WebrtcRejectSignal,
  type WebrtcBusySignal,
  type WebrtcHangupSignal,
  type WebrtcFallbackRequiredSignal,
  type ParseSignalResult,
  type WebrtcRejectReason,
  type WebrtcHangupReason,
  type WebrtcSuggestedMode
} from "./webrtcSignal.js";
export {
  KEYMASTER_WEBRTC_APP_ID,
  WEBRTC_ENDPOINT_ID,
  WEBRTC_PLUGIN_ID,
  WEBRTC_SERVICE_CAPABILITY,
  WEBRTC_WORKBENCH_PATH,
  WEBRTC_SETTINGS_PATH
} from "./constants.js";
