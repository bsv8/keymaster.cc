// packages/plugin-webrtc/src/index.ts
// WebRTC 业务插件 plugin-webrtc（施工单 2026-07-04 002 硬切换）。
//
// 该插件是一个**极薄业务插件**，appId = `keymaster.webrtc`：
//   - 通过 Coordinator 注入的 Channel runtime 发送固定 WebRTC 私信；
//   - service 不接触 Supplier、SSP wire、私钥或远端历史；
//   - 页面主流程已收口到 `/settings/webrtc`；旧 `/system/webrtc` 工作台常量保留，
//     但不再注册为用户可达入口；
//   - 不做远端在线查询；通话连接结果由 WebRTC 本身反馈。
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
  MAX_WEBRTC_TRANSFER_BYTES,
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
  createKeyValueWebrtcConfigStore,
  createMemoryWebrtcConfigStore,
  WEBRTC_CONFIG_STORAGE_KEY
} from "./webrtcConfig.js";
export {
  WEBRTC_SIGNAL_SCHEMA,
  DEFAULT_SIGNAL_TTL_MS,
  parseSignalBody,
  parseSignalValue,
  newOfferSignal,
  newAnswerSignal,
  newIceSignal,
  newEndOfCandidatesSignal,
  signalType,
  serializeSignal,
  isSignalExpired,
  isAcceptableRemoteSession,
  isAcceptableRemoteSessionId,
  tryParseSignal,
  type WebrtcSignal,
  type WebrtcSignalEnvelope,
  type WebrtcSignalType,
  type WebrtcInviteSignal,
  type WebrtcAnswerSignal,
  type WebrtcIceSignal,
  type WebrtcEndOfCandidatesSignal,
  type ParseSignalResult,
  type WebrtcRejectReason,
  type WebrtcHangupReason,
  type WebrtcSuggestedMode,
  type WebrtcTransferRejectReason
} from "./webrtcSignal.js";
export {
  WEBRTC_SIGNAL_PROTOCOL,
  WEBRTC_CALLS_ENABLED,
  WEBRTC_PLUGIN_ID,
  WEBRTC_SERVICE_CAPABILITY,
  WEBRTC_SETTINGS_PATH
} from "./constants.js";
