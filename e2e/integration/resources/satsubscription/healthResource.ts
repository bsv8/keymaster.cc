import type { E2ESatSubscriptionConfig } from "../config/types.js";
import { assertSafeIdentifier } from "../../support/ids.js";

/**
 * SatSubscription 资源层的公开配置投影。
 *
 * 这里故意不创建 WebSocket、不调用 Sat API，也不把 multiaddr 转成 URL。
 * 真实连接是否成功只能由真实 Chromium 页面 Journey 的可见结果确认。
 */
export interface SatSubscriptionResourceProjection {
  /** 本轮真实资源运行编号，限制状态归属范围。 */
  readonly runId: string;
  /** 配置声明的网络标签；当前 SatSubscription 资源只接受 testnet。 */
  readonly network: "testnet";
  /** satsubscription.json 中的远端供应商身份公钥。 */
  readonly supplierPublicKeyHex: string;
  /** 页面表单中的 WebSocket libp2p multiaddr，不是 wss:// URL。 */
  readonly websocketMultiaddr: string;
  /** 页面表单中的 WebRTC Direct libp2p multiaddr。 */
  readonly webrtcDirectMultiaddr: string;
  /** Node 资源层是否做过 WebSocket 探针；按测试边界固定为 false。 */
  readonly websocketVerified: false;
  /** Node 资源层是否做过 WebRTC Direct 探针；按测试边界固定为 false。 */
  readonly webrtcDirectVerified: false;
}

/**
 * 把仓库外配置整理成跨 Playwright 项目可传递的公开投影。
 *
 * 该函数只做字段/身份格式检查，不代表供应商在线；页面 Journey 必须
 * 通过 page.fill/page.click 重新提交这些字段并读取页面连接状态。
 */
export function projectSatSubscriptionConfig(
  config: E2ESatSubscriptionConfig,
  runId: string,
): SatSubscriptionResourceProjection {
  const safeRunId = assertSafeIdentifier(runId, "run_id");
  if (!/^0[23][0-9a-f]{64}$/iu.test(config.supplierPublicKeyHex)) {
    throw new Error("SatSubscription 配置中的 supplierPublicKeyHex 不是合法压缩公钥");
  }
  if (!config.websocket.trim() || !config.webrtcDirect.trim()) {
    throw new Error("SatSubscription 配置必须同时提供 WebSocket 和 WebRTC Direct multiaddr");
  }
  return {
    runId: safeRunId,
    network: "testnet",
    supplierPublicKeyHex: config.supplierPublicKeyHex.toLowerCase(),
    websocketMultiaddr: config.websocket,
    webrtcDirectMultiaddr: config.webrtcDirect,
    websocketVerified: false,
    webrtcDirectVerified: false,
  };
}
