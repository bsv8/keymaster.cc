// 已认证拨号的唯一实现。
//
// 中文说明：WebRTC Direct 由 bitcoin-libp2p SDK 完成 endpoint 校验、certhash
// 校验、身份 pin、超时与取消；WSS/WS 由 host.dial 建立连接后再用
// authenticateConnection 复核 PeerId 与压缩公钥。MSFile 供应商读取与 BitFS
// 卖方会话共用同一策略，避免两套拨号校验漂移。

import { multiaddr } from "@multiformats/multiaddr";
import { authenticateConnection } from "bitcoin-libp2p/libp2p";
import { hexToBytes, peerIdFromPublicKeyBytes } from "bitcoin-libp2p/identity";
import {
  dialAuthenticatedWebRTCDirect,
  parseWebRTCDirectEndpoint,
} from "bitcoin-libp2p/webrtc-direct";

/** 已完成 Noise 身份 pin 的连接；调用方负责关闭。 */
export type AuthenticatedDialConnection = Parameters<typeof authenticateConnection>[0];

/** 拨号只依赖 host.dial；具体 Host 由 Window P2P executor 提供。 */
export interface AuthenticatedDialHost {
  dial(address: ReturnType<typeof multiaddr>, options?: { signal?: AbortSignal }): Promise<AuthenticatedDialConnection>;
}

/** WebRTC Direct 拨号默认超时；与供应商探测保持一致。 */
export const AUTHENTICATED_DIAL_WEBRTC_TIMEOUT_MS = 15_000;

/**
 * 拨号并验证远端身份。
 *
 * 中文说明：
 *   - `publicKeyHex` 是已由业务层验证的 33 字节压缩公钥；
 *   - WebRTC Direct 走 SDK 的 certhash + PeerId 校验；
 *   - 其它地址（WSS/WS）先拨号，再校验远端 Noise 身份与公钥派生 PeerId；
 *   - 失败时不会把未认证连接交给调用方，并尽力关闭已建立的连接。
 */
export async function dialAuthenticatedAddress(input: {
  /** 唯一 Window Host 的拨号能力。 */
  host: AuthenticatedDialHost;
  /** 已通过白名单的完整 multiaddr。 */
  address: string;
  /** 期望的远端压缩公钥（66 位小写 hex）。 */
  publicKeyHex: string;
  /** 取消拨号。 */
  signal?: AbortSignal;
  /** WebRTC Direct 拨号超时毫秒数。 */
  webrtcTimeoutMs?: number;
}): Promise<AuthenticatedDialConnection> {
  const publicKey = hexToBytes(input.publicKeyHex);
  const parsed = multiaddr(input.address);
  const isDirect = parsed.getComponents().some((component) => component.name === "webrtc-direct");
  if (isDirect) {
    const endpoint = parseWebRTCDirectEndpoint(parsed, { publicKey });
    const result = await dialAuthenticatedWebRTCDirect(input.host, endpoint, {
      publicKey,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      timeoutMs: input.webrtcTimeoutMs ?? AUTHENTICATED_DIAL_WEBRTC_TIMEOUT_MS,
    });
    return result.connection;
  }
  const connection = await input.host.dial(parsed, input.signal === undefined ? {} : { signal: input.signal });
  try {
    authenticateConnection(connection, {
      peerId: peerIdFromPublicKeyBytes(publicKey),
      publicKey,
    });
    return connection;
  } catch (error) {
    // host.dial 已经建立了连接；身份 pin 失败时必须在这里关闭，不能交给
    // 调用方用可能未赋值的连接变量清理。
    await connection.close().catch(() => undefined);
    throw error;
  }
}
