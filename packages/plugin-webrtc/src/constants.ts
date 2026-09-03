// packages/plugin-webrtc/src/constants.ts
// plugin-webrtc 自身常量（协议、能力和路由）。

/** WebRTC owner inbox 私信协议标识。 */
export const WEBRTC_SIGNAL_PROTOCOL = "bsv8.webrtc.signal.v1";

/**
 * 音视频呼叫开关。当前 ChannelProtocol 只有“文件 Hash 请求 → WebRTC
 * offer”的关系，尚未定义呼叫会合请求；在上游协议增加正式版本前禁止
 * 生成或接受音视频呼叫，避免把呼叫描述摘要冒充文件 Hash。
 */
export const WEBRTC_CALLS_ENABLED = false;

/** plugin-webrtc 公开 service capability key。 */
export const WEBRTC_SERVICE_CAPABILITY = "webrtc.service";

/** 设置详情页路径。 */
export const WEBRTC_SETTINGS_PATH = "/settings/webrtc";

/** plugin id。 */
export const WEBRTC_PLUGIN_ID = "webrtc";
