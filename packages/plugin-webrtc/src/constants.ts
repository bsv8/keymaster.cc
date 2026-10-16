// packages/plugin-webrtc/src/constants.ts
// plugin-webrtc 自身常量（协议、能力和路由）。
import { defineCapability } from "webloom-framework";
import type { WebrtcService } from "./webrtcService.js";

/** 共享 Hash/offer 协议标识；联系人服务通过 APP 私信发送独立信令。 */
export const WEBRTC_SIGNAL_PROTOCOL = "bsv8.webrtc.signal.v1";

/** 音视频通话通过加密 APP 私信协商：主叫邀请，被叫 offer，主叫 answer。 */
export const WEBRTC_CALLS_ENABLED = true;

/** plugin-webrtc 公开 service capability key。 */
export const WEBRTC_SERVICE_CAPABILITY = defineCapability<WebrtcService>({
  kind: "local",
  id: "webrtc.service",
  version: "1",
});

/** 设置详情页路径。 */
export const WEBRTC_SETTINGS_PATH = "/settings/webrtc";

/** plugin id。 */
export const WEBRTC_PLUGIN_ID = "webrtc";
