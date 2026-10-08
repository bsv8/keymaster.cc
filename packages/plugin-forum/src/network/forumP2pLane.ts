// Forum 的 Window P2P lane。
//
// Forum 与其它业务插件一样只注册业务 lane；唯一 Host、lease 与 MessagePort bridge
// 由 `plugin-window-p2p` 拥有，Forum 不另建 Host、也不自造身份 signer。
//
// lane 只做一件事：在已认证连接上跑一次 `/roundtrip/1` 请求-响应。拨号与身份
// pin 在这里实现而不是复用别的插件的私有模块：插件之间只通过 contracts 协作，
// 跨插件的实现导入会被边界检查拒绝。下面这段是「拨号 → 校验远端 Noise 身份与
// 公钥派生 PeerId → Direct 地址由 SDK 校验 certhash 与 PeerId」的唯一实现，
// 失败时不会把未认证连接交给调用方。

import type { WindowP2pExecutorLane, WindowP2pExecutorLaneContext } from "@keymaster/contracts";
import { authenticateConnection } from "bitcoin-libp2p/libp2p";
import { hexToBytes, peerIdFromPublicKeyBytes } from "bitcoin-libp2p/identity";
import { readUvarintFrames, writeUvarintFrame } from "bitcoin-libp2p/stream";
import { dialAuthenticatedWebRTCDirect, parseWebRTCDirectEndpoint } from "bitcoin-libp2p/webrtc-direct";
import { multiaddr } from "@multiformats/multiaddr";

import { FORUM_PROTOCOL_ID } from "@keymaster/contracts";

export const FORUM_LANE_ID = "forum";

/** 单个 roundtrip 帧上限：消息上限 1 MiB + 帧头。 */
export const FORUM_LANE_MAX_FRAME_BYTES = 1024 * 1024 + 16;
/** 单次调用默认超时。 */
export const FORUM_LANE_DEFAULT_TIMEOUT_MS = 15_000;
/** WebRTC Direct 拨号超时。 */
export const FORUM_LANE_DIRECT_TIMEOUT_MS = 15_000;

export interface ForumP2pLaneRequest {
  readonly kind: "forum.roundtrip";
  /** 完整 multiaddr；Direct 部署给出含 PeerId 与 certhash 的实际地址。 */
  readonly address: string;
  /** 已由业务层验证的论坛服务公钥；拨号后必须与远端身份一致。 */
  readonly forumPublicKeyHex: string;
  readonly requestBytesHex: string;
  readonly timeoutMs?: number;
}

export interface ForumP2pLaneResult {
  readonly responseBytesHex: string;
}

export type ForumP2pLaneOutcome =
  | ({ readonly ok: true } & ForumP2pLaneResult)
  | { readonly ok: false; readonly code: string; readonly message: string };

/** lane 侧最小 Host 能力；contracts 不依赖 libp2p，所以这里在自己的包内收窄。 */
interface ForumP2pHost {
  dial(
    address: ReturnType<typeof multiaddr>,
    options?: { signal?: AbortSignal },
  ): Promise<Parameters<typeof authenticateConnection>[0]>;
}

function isForumP2pLaneRequest(value: unknown): value is ForumP2pLaneRequest {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.kind === "forum.roundtrip" &&
    typeof record.address === "string" &&
    typeof record.forumPublicKeyHex === "string" &&
    typeof record.requestBytesHex === "string"
  );
}

/**
 * 拨号并校验远端身份。
 *
 * 三点约束：
 *   - `forumPublicKeyHex` 是业务层已经验证过的 33 字节压缩公钥；
 *   - WebRTC Direct 由 SDK 完成 endpoint 校验、certhash 校验、身份 pin 与超时；
 *   - 其它地址（WSS/WS）先 `host.dial`，再用 `authenticateConnection` 复核远端
 *     Noise 身份与公钥派生 PeerId；失败时必须关闭已建立的连接。
 */
async function dialForumPeer(input: {
  host: ForumP2pHost;
  address: string;
  forumPublicKeyHex: string;
  signal?: AbortSignal;
}): Promise<Parameters<typeof authenticateConnection>[0]> {
  const publicKey = hexToBytes(input.forumPublicKeyHex);
  const parsed = multiaddr(input.address);
  const isDirect = parsed.getComponents().some((component) => component.name === "webrtc-direct");
  if (isDirect) {
    const endpoint = parseWebRTCDirectEndpoint(parsed, { publicKey });
    const result = await dialAuthenticatedWebRTCDirect(input.host, endpoint, {
      publicKey,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      timeoutMs: FORUM_LANE_DIRECT_TIMEOUT_MS,
    });
    return result.connection;
  }
  const connection = await input.host.dial(parsed, input.signal === undefined ? {} : { signal: input.signal });
  try {
    // 连接认证不是消息验证：远端 PeerId 必须由配置的论坛公钥派生。
    authenticateConnection(connection, { peerId: peerIdFromPublicKeyBytes(publicKey), publicKey });
    return connection;
  } catch (error) {
    await connection.close().catch(() => undefined);
    throw error;
  }
}

export class ForumP2pLane implements WindowP2pExecutorLane {
  readonly laneId = FORUM_LANE_ID;
  private host?: ForumP2pHost;
  private ownerSessionEpoch = "";

  start(context: WindowP2pExecutorLaneContext): void {
    this.host = context.host as ForumP2pHost;
    this.ownerSessionEpoch = context.ownerSessionEpoch ?? "";
  }

  stop(): void {
    this.host = undefined;
    this.ownerSessionEpoch = "";
  }

  async handle(operation: unknown, signal: AbortSignal): Promise<unknown> {
    if (!isForumP2pLaneRequest(operation)) {
      return fail("forum-lane-request", "lane 只接受 forum.roundtrip 操作");
    }
    return this.call(operation, signal);
  }

  /**
   * Window 内直接调用。
   *
   * `handle` 是 Worker bridge 的入口，`call` 是同一实例在 Window 内的入口；两者
   * 共用下面的实现，所以 Host 的取得、身份 pin 与超时策略只有一份。
   */
  async call(request: ForumP2pLaneRequest, signal: AbortSignal): Promise<ForumP2pLaneOutcome> {
    const host = this.host;
    if (host === undefined) return fail("forum-lane-unavailable", "Window P2P Host 尚未就绪");
    if (!/^(02|03)[0-9a-f]{64}$/u.test(request.forumPublicKeyHex)) {
      return fail("forum-lane-identity", "论坛服务公钥必须是 33 字节压缩公钥");
    }
    let requestBytes: Uint8Array;
    try {
      requestBytes = fromHex(request.requestBytesHex);
    } catch (error) {
      return fail("forum-lane-request", error instanceof Error ? error.message : String(error));
    }
    const timeoutMs = request.timeoutMs ?? FORUM_LANE_DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("roundtrip 超时")), timeoutMs);
    const onAbort = (): void => controller.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const connection = await dialForumPeer({
        host,
        address: request.address,
        forumPublicKeyHex: request.forumPublicKeyHex,
        signal: controller.signal,
      });
      try {
        const stream = await connection.newStream(FORUM_PROTOCOL_ID);
        try {
          writeUvarintFrame(stream, requestBytes);
          // 一次请求一帧；写侧半关闭后对端就知道请求已完整。
          await stream.close();
          const response = await readSingleFrame(stream, FORUM_LANE_MAX_FRAME_BYTES, controller.signal);
          if (response === undefined) {
            return fail("forum-lane-frame", "对端在响应帧到达前关闭了流");
          }
          return { ok: true, responseBytesHex: toHex(response) };
        } finally {
          await stream.close().catch(() => undefined);
        }
      } finally {
        await connection.close().catch(() => undefined);
      }
    } catch (error) {
      return fail("forum-lane-transport", error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  /** 当前 owner 会话世代；上层用它给跨页状态加 fence。 */
  get sessionEpoch(): string {
    return this.ownerSessionEpoch;
  }
}

/** 恰好一帧；两帧是协议错误，零帧是截断。 */
async function readSingleFrame(
  stream: Parameters<typeof readUvarintFrames>[0],
  maxFrameBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array | undefined> {
  const iterator = readUvarintFrames(stream, { maxInboundFrameBytes: maxFrameBytes, signal })[Symbol.asyncIterator]();
  try {
    const first = await iterator.next();
    if (first.done === true) return undefined;
    const second = await iterator.next();
    if (!second.done) throw new Error("一条流只能承载一个请求与一个响应");
    return first.value;
  } finally {
    await iterator.return?.(undefined).catch(() => undefined);
  }
}

function fail(code: string, message: string): ForumP2pLaneOutcome {
  return { ok: false, code, message };
}

function fromHex(text: string): Uint8Array {
  if (text.length % 2 !== 0) throw new Error("hex 长度必须是偶数");
  const out = new Uint8Array(text.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    const value = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16);
    if (Number.isNaN(value)) throw new Error("hex 含有非十六进制字符");
    out[index] = value;
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}