// P2P（WebRTC）桶内设置文件格式（KeymasterFormats《桶/<owner>/p2p/setting.json》）。
//
// 路径（owner 根下,module 根即 `p2p/`）：
//   - `p2p/setting.json`   STUN 服务器列表（明文,≤8 KiB）
//
// 本文件只做格式解析与序列化;文件 I/O 在 p2pSettingFileRepository。
// 未知字段/类型错误一律拒绝;取值校验复用 webrtcConfig 的 STUN 规则。

import {
  validateStunServers,
  type WebrtcConfig,
} from "../webrtcConfig.js";

/** 设置文件固定名（p2p 模块根下）。 */
export const P2P_SETTING_FILE_NAME = "setting.json";
export const P2P_SETTING_FORMAT = "keymaster.p2p-setting";
export const P2P_SETTING_VERSION = 1;
/** 设置文件硬上限：8 KiB（16 条 × 256 字符 + JSON 开销）。 */
export const P2P_SETTING_MAX_BYTES = 8 * 1024;

/** 磁盘上的设置文件（stunServers 可省略,缺省即默认）。 */
export interface P2pSettingFileV1 {
  format: typeof P2P_SETTING_FORMAT;
  version: typeof P2P_SETTING_VERSION;
  stunServers?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** 严格解析设置文件；任何未知字段/类型错误/非法 URL 都返回 undefined。 */
export function parseP2pSettingFile(bytes: Uint8Array): P2pSettingFileV1 | undefined {
  if (bytes.byteLength === 0 || bytes.byteLength > P2P_SETTING_MAX_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const allowed = new Set(["format", "version", "stunServers"]);
  if (Object.keys(parsed).some((key) => !allowed.has(key))) return undefined;
  if (parsed.format !== P2P_SETTING_FORMAT || parsed.version !== P2P_SETTING_VERSION) return undefined;
  if (parsed.stunServers === undefined) {
    return { format: P2P_SETTING_FORMAT, version: P2P_SETTING_VERSION };
  }
  if (!Array.isArray(parsed.stunServers) || parsed.stunServers.some((entry) => typeof entry !== "string")) return undefined;
  const validated = validateStunServers(parsed.stunServers as string[]);
  if (!validated.ok || validated.value === undefined) return undefined;
  return { format: P2P_SETTING_FORMAT, version: P2P_SETTING_VERSION, stunServers: validated.value };
}

/** 序列化设置文件；STUN 列表按校验规则规范化（去空串/去重/空列表回落默认）。 */
export function serializeP2pSettingFile(config: WebrtcConfig): Uint8Array {
  const validated = validateStunServers(config.stunServers);
  if (!validated.ok || validated.value === undefined) throw new Error(validated.error ?? "invalid_config");
  const document = {
    format: P2P_SETTING_FORMAT,
    version: P2P_SETTING_VERSION,
    stunServers: validated.value,
  };
  return new TextEncoder().encode(`${JSON.stringify(document, null, 2)}\n`);
}
