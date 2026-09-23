// packages/plugin-webrtc/src/constants.ts
// plugin-webrtc 自身常量（协议、能力和路由）。
import { defineCapability } from "webloom-framework";
import type { WebrtcService } from "./webrtcService.js";

/** WebRTC owner inbox 私信协议标识。 */
export const WEBRTC_SIGNAL_PROTOCOL = "bsv8.webrtc.signal.v1";

/**
 * 音视频呼叫开关。呼叫使用与文件传输相同的会合模式：
 *   主叫先经 `bsv8.message.v1` 发送 `keymaster.webrtc.call.request`
 *  （携带 rendezvous hash + mode），被叫确认后发布真实 Hash 请求，
 *   主叫再经 `bsv8.webrtc.signal.v1` 发送媒体 offer。
 * 拒绝 / 忙 / 挂断 / 回退经 `keymaster.webrtc.call.control`（APP 私信）
 * 交换，不占用 webrtc-signal 的 offer/answer/ICE 分支。
 */
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
