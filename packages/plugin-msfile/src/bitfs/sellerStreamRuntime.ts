// Window 侧 BitFS 卖方 stream runtime。
//
// 中文说明：
//   - 本模块只存在于 Window；唯一 libp2p Host 由 plugin-window-p2p 提供；
//   - 只做拨号、身份 pin、`/bitfs/wire/1.0.0` uvarint 分帧收发与关闭；
//   - 不持有私钥、不解析业务证据、不写入 journal；帧内容由 Worker 侧协议端口
//     产生并负责 persist-before-send；
//   - 每个销售会话独立拨号一条连接，关闭原因用稳定分类回传。

import { parse } from "go-bitfs";
import { BITFS_PROTOCOL_ID, MAX_WIRE_FRAME_BYTES, readArtifacts, writeArtifact } from "go-bitfs/transport";
import { hexToBytes, peerIdFromPublicKeyBytes } from "bitcoin-libp2p/identity";
import {
  dialAuthenticatedAddress,
  type AuthenticatedDialConnection,
  type AuthenticatedDialHost,
} from "../authenticatedDial.js";

/** Window 侧 BitFS 会话上限；Worker 侧还有 maxConcurrentSales 业务上限。 */
export const BITFS_STREAM_MAX_SESSIONS = 32;

/** 会话事件发回 Worker 的稳定形状。 */
export type BitfsStreamEvent =
  | {
    /** 一条完整入站 Artifact。 */
    type: "bitfs-seller-frame";
    /** 会话编号。 */
    sessionId: string;
    /** Window 侧连接实例编号；用于诊断与幂等关闭。 */
    connectionId: string;
    /** 会话建立时的 owner/session epoch；Worker 必须复核。 */
    ownerSessionEpoch: string;
    /** exact canonical Artifact 字节。 */
    frame: Uint8Array;
  }
  | {
    /** Window 侧判定会话结束（远端 EOF、分帧错误或本地清理）。 */
    type: "bitfs-seller-session-closed";
    /** 会话编号。 */
    sessionId: string;
    /** Window 侧连接实例编号。 */
    connectionId: string;
    /** 会话建立时的 owner/session epoch。 */
    ownerSessionEpoch: string;
    /** 稳定关闭原因。 */
    reason: string;
  };

/** 单条 BitFS stream 的最小能力；只用于收窄 libp2p Stream 类型。 */
type BitfsStreamLike = {
  send(data: Uint8Array): boolean;
  close(): Promise<void>;
  onDrain?(): Promise<void>;
};

interface StreamSessionEntry {
  sessionId: string;
  connectionId: string;
  ownerSessionEpoch: string;
  connection: AuthenticatedDialConnection;
  stream: BitfsStreamLike;
  controller: AbortController;
  closed: boolean;
}

export interface BitfsStreamRuntimeOptions {
  /** 唯一 Window Host 的拨号能力。 */
  host: AuthenticatedDialHost;
  /** 会话事件回传 Worker；事件不得携带私钥。 */
  emit(event: BitfsStreamEvent, transfer?: Transferable[]): Promise<void> | void;
  /** 当前 owner/session epoch；必须写入连接事件 fence。 */
  ownerSessionEpoch: string;
  /** WebRTC Direct 拨号超时毫秒数。 */
  webrtcTimeoutMs?: number;
  /** 测试接缝：覆盖已认证拨号；缺省使用 `authenticatedDial` 的唯一策略。 */
  dial?: (input: {
    /** 完整 multiaddr。 */
    address: string;
    /** 期望的压缩公钥 hex。 */
    publicKeyHex: string;
    /** 取消拨号。 */
    signal?: AbortSignal;
  }) => Promise<AuthenticatedDialConnection>;
}

export class BitfsStreamRuntime {
  private readonly sessions = new Map<string, StreamSessionEntry>();
  private disposed = false;

  constructor(private readonly options: BitfsStreamRuntimeOptions) {}

  /**
   * 拨号、完成身份 pin、打开 BitFS stream 并发送已持久化的首帧（报价）。
   * 首个成功地址生效；全部失败时抛出，不留下半连接。
   */
  async open(input: {
    /** 会话编号。 */
    sessionId: string;
    /** 已验证的候选 multiaddr 列表。 */
    addresses: string[];
    /** 请求者已验证的 33 字节压缩公钥 hex。 */
    publicKeyHex: string;
    /** 由同一公钥派生的 PeerId；必须与公钥一致。 */
    expectedPeerId: string;
    /** 已持久化的 exact Kind 1 报价字节。 */
    firstFrame: Uint8Array;
    /** 取消拨号；lease revoke 或 Worker 关闭会话时触发。 */
    signal?: AbortSignal;
  }): Promise<void> {
    if (this.disposed) throw new Error("BitFS stream runtime is disposed");
    if (input.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
    if (this.sessions.has(input.sessionId)) throw new Error("BitFS stream session id already exists");
    if (this.sessions.size >= BITFS_STREAM_MAX_SESSIONS) throw new Error("BitFS stream session limit reached");
    if (input.addresses.length === 0) throw new Error("BitFS stream requires at least one locator");
    // 公钥 ↔ PeerId 必须由本地重新派生核对，不能只信 Worker 传来的字符串。
    const publicKey = hexToBytes(input.publicKeyHex);
    const derivedPeerId = peerIdFromPublicKeyBytes(publicKey).toString();
    if (derivedPeerId !== input.expectedPeerId) throw new Error("BitFS stream PeerId does not match the requester public key");
    // 首帧由 Worker 侧协议端口产生并校验；Window 仍必须再跑一次严格解析，
    // 不信任跨 bridge 的字节形状。
    const first = parse(input.firstFrame.slice()).bytes();

    const errors: string[] = [];
    for (const address of input.addresses) {
      if (this.disposed) throw new Error("BitFS stream runtime is disposed");
      if (input.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
      let connection: AuthenticatedDialConnection | undefined;
      try {
        const dial = this.options.dial ?? ((input) => dialAuthenticatedAddress({
          host: this.options.host,
          address: input.address,
          publicKeyHex: input.publicKeyHex,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          ...(this.options.webrtcTimeoutMs === undefined ? {} : { webrtcTimeoutMs: this.options.webrtcTimeoutMs }),
        }));
        connection = await dial({
          address,
          publicKeyHex: input.publicKeyHex,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        await this.installSession(input.sessionId, connection, first);
        return;
      } catch (error) {
        errors.push(error instanceof Error ? error.message.slice(0, 128) : String(error).slice(0, 128));
        await connection?.close().catch(() => undefined);
      }
    }
    throw new Error(`BitFS stream dial failed: ${errors.join(" | ")}`);
  }

  /** 发送一条已由 Worker 协议端口持久化的 exact Artifact 帧。 */
  async send(sessionId: string, frame: Uint8Array): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.closed) throw new Error("BitFS stream session is not open");
    const artifact = parse(frame.slice());
    if (!writeArtifact(entry.stream as unknown as Parameters<typeof writeArtifact>[0], artifact)) {
      await entry.stream.onDrain?.();
    }
  }

  /** 关闭一条会话；重复调用幂等。 */
  async close(sessionId: string, reason = "closed"): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    await this.teardown(entry, reason, false);
  }

  /** 关闭全部会话并拒绝新会话。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    const entries = [...this.sessions.values()];
    for (const entry of entries) await this.teardown(entry, "runtime_disposed", false);
  }

  private async installSession(
    sessionId: string,
    connection: AuthenticatedDialConnection,
    firstFrame: Uint8Array,
  ): Promise<void> {
    const stream = await connection.newStream(BITFS_PROTOCOL_ID) as unknown as BitfsStreamLike;
    const entry: StreamSessionEntry = {
      sessionId,
      connectionId: crypto.randomUUID(),
      ownerSessionEpoch: this.options.ownerSessionEpoch,
      connection,
      stream,
      controller: new AbortController(),
      closed: false,
    };
    try {
      if (!writeArtifact(stream as unknown as Parameters<typeof writeArtifact>[0], parse(firstFrame))) {
        await stream.onDrain?.();
      }
    } catch (error) {
      await stream.close().catch(() => undefined);
      throw error;
    }
    this.sessions.set(sessionId, entry);
    void this.readLoop(entry);
  }

  private async readLoop(entry: StreamSessionEntry): Promise<void> {
    let reason = "remote_closed";
    try {
      for await (const artifact of readArtifacts(entry.stream as unknown as Parameters<typeof readArtifacts>[0], {
        signal: entry.controller.signal,
        maxInboundFrameBytes: MAX_WIRE_FRAME_BYTES,
        maxBufferedBytes: MAX_WIRE_FRAME_BYTES + 10,
      })) {
        if (entry.closed || this.sessions.get(entry.sessionId) !== entry) return;
        const frame = artifact.bytes();
        try {
          await this.options.emit({
            type: "bitfs-seller-frame",
            sessionId: entry.sessionId,
            connectionId: entry.connectionId,
            ownerSessionEpoch: entry.ownerSessionEpoch,
            frame,
          }, [frame.buffer]);
        } catch {
          reason = "worker_unreachable";
          break;
        }
      }
    } catch {
      reason = entry.controller.signal.aborted || entry.closed ? "local_closed" : "stream_error";
    }
    if (entry.closed) return;
    await this.teardown(entry, reason, true);
  }

  private async teardown(entry: StreamSessionEntry, reason: string, notify: boolean): Promise<void> {
    if (entry.closed) return;
    entry.closed = true;
    this.sessions.delete(entry.sessionId);
    entry.controller.abort();
    await entry.stream.close().catch(() => undefined);
    try { entry.connection.abort(new Error("BitFS stream session closed")); } catch { /* connection already closed */ }
    await entry.connection.close().catch(() => undefined);
    if (notify) {
      try {
        await this.options.emit({
          type: "bitfs-seller-session-closed",
          sessionId: entry.sessionId,
          connectionId: entry.connectionId,
          ownerSessionEpoch: entry.ownerSessionEpoch,
          reason: /^[a-z0-9_]{1,64}$/u.test(reason) ? reason : "stream_error",
        });
      } catch {
        // Worker 不可达时由 Worker 本地 stop/revoke 清理同一会话。
      }
    }
  }
}
