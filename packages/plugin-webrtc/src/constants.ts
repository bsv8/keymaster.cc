// packages/plugin-webrtc/src/constants.ts
// plugin-webrtc 自身常量（endpoint id / capability key / 路由常量）。
//
// 设计缘由：
//   - endpointId 跨 manifest 与 service 共享；
//   - 与 `plugin-message` 同 schema：`keymaster.<业务>` 形式，runtime 在
//     enable 时做形状校验 + 全局唯一性校验。

import type { AppMsgEndpointId } from "@keymaster/contracts";

/** plugin-webrtc 的固定 endpointId。 */
export const KEYMASTER_WEBRTC_APP_ID = "keymaster.webrtc";

/** plugin-webrtc 的固定 endpointId（公开形态）。 */
export const WEBRTC_ENDPOINT_ID: AppMsgEndpointId = {
  kind: "plugin",
  id: KEYMASTER_WEBRTC_APP_ID
};

/** plugin-webrtc 公开 service capability key。 */
export const WEBRTC_SERVICE_CAPABILITY = "webrtc.service";

/** 旧工作台路径常量：主流程已退场，保留仅用于兼容引用。 */
export const WEBRTC_WORKBENCH_PATH = "/system/webrtc";

/** 设置详情页路径。 */
export const WEBRTC_SETTINGS_PATH = "/settings/webrtc";

/** plugin id。 */
export const WEBRTC_PLUGIN_ID = "webrtc";
