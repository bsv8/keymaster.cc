// 仲裁网络客户端。只复用 Window executor 的 Host；不创建第二个 Host。
// exact Kind 8/10 由调用方在发送前持久化，发送失败后只能重放同一请求。
import { decode, encode } from "cborg";
import { MAX_WIRE_FRAME_BYTES, parse, parseAs } from "go-bitfs";
import { readUvarintFrames, writeUvarintFrame } from "bitcoin-libp2p/stream";
import { dialAuthenticatedAddress, type AuthenticatedDialHost } from "../authenticatedDial.js";
import { deriveSupplierPeerId, normalizeSupplierAddress } from "../supplierConfig.js";

export interface BitfsArbitrationEndpoint {
  /** 签名报价选定的仲裁方业务压缩公钥，不信任服务自报身份。 */
  publicKeyHex: string;
  /** 包含同一公钥派生 PeerID 的完整可拨号地址。 */
  address: string;
}

export interface BitfsArbitrationInfo {
  /** 计费单位固定为内容条目，Seed、尾块、完整块均计一个。 */
  unit: "content-item";
  baseSat: number;
  perItemSat: number;
  retentionSeconds: number;
}

export interface BitfsArbitrationTransport {
  info?(input: { endpoint: BitfsArbitrationEndpoint; signal?: AbortSignal }): Promise<BitfsArbitrationInfo>;
  /** 只接受已经持久化的 exact Kind 8/10，返回 exact Kind 9/11。 */
  exchange(input: { endpoint: BitfsArbitrationEndpoint; request: Uint8Array; signal?: AbortSignal }): Promise<Uint8Array>;
}

/** 拒绝旧 KiB 价格，明确指出服务格式、单位、身份或数值的哪一项不匹配。 */
export function decodeArbitrationFeeInfo(raw: Uint8Array, publicKeyHex: string): BitfsArbitrationInfo {
  const data: unknown = decode(raw);
  if (!Array.isArray(data)) throw new Error("仲裁 info 必须是 CBOR 数组");
  if (data[0] === 1) throw new Error(`仲裁服务仍返回旧版按 KiB 计费表（info v1，${data.length} 字段）；需要升级为 info v2、content-item 条目计费后才能购买`);
  if (data[0] !== 2 || data.length !== 9) throw new Error(`仲裁 info 格式不匹配：需要 v2、9 字段，实际版本 ${String(data[0])}、${data.length} 字段`);
  if (data[8] !== "content-item") throw new Error(`仲裁计费单位不匹配：需要 content-item，实际 ${String(data[8])}`);
  if (data[1] !== deriveSupplierPeerId(publicKeyHex)) throw new Error("仲裁 info 身份不匹配：返回的 PeerID 与选定仲裁公钥不一致");
  for (const [index, field, minimum] of [[3, "base_sat", 1], [4, "per_item_sat", 0], [5, "retention_seconds", 0]] as const) {
    if (!Number.isSafeInteger(data[index]) || data[index] < minimum) throw new Error(`仲裁 info.${field} 不合法：需要不小于 ${minimum} 的安全整数，实际 ${String(data[index])}`);
  }
  return { unit: "content-item", baseSat: data[3], perItemSat: data[4], retentionSeconds: data[5] };
}

export class BitfsArbitrationRemoteError extends Error {
  constructor(
    /** 服务错误码；业务 unavailable 是签名 Kind 11，不走此分支。 */
    readonly code: string,
    /** 是否允许以相同请求重试。 */
    readonly retryable: boolean,
    /** 服务建议的重试等待时间，毫秒。 */
    readonly retryAfterMs: number,
  ) { super(`仲裁服务拒绝请求：${code}`); this.name = "BitfsArbitrationRemoteError"; }
}

/** 响应外壳仅负责 transport；业务报文必须交回 SDK 验证签名、金额和内容。 */
export function decodeArbitrationEnvelope(raw: Uint8Array, expectedKind: 0 | 9 | 11): Uint8Array {
  const value: unknown = decode(raw, { strict: true, allowIndefinite: false, allowUndefined: false, allowNaN: false, allowInfinity: false });
  if (!Array.isArray(value) || value[0] !== 1) throw new Error("仲裁响应外壳版本错误");
  // 外壳同样要求确定性编码，不能接受尾部数据或替代 CBOR 形式。
  const canonical = encode(value);
  if (canonical.length !== raw.length || !canonical.every((byte, index) => byte === raw[index])) throw new Error("仲裁响应外壳不是规范 CBOR");
  if (value[1] === 1) {
    const [, , code, retryable, delay, trace] = value;
    if (value.length !== 6 || typeof code !== "string" || !/^[A-Z_]{1,64}$/u.test(code)
      || typeof retryable !== "boolean" || !Number.isSafeInteger(delay) || delay < 0
      || typeof trace !== "string" || new TextEncoder().encode(trace).length > 64) throw new Error("仲裁错误外壳格式错误");
    throw new BitfsArbitrationRemoteError(code, retryable, delay);
  }
  if (value[1] !== 0 || value.length !== 4 || value[2] !== expectedKind || !(value[3] instanceof Uint8Array)) throw new Error("仲裁成功外壳 Kind 或格式错误");
  return expectedKind === 0 ? value[3].slice() : parseAs(expectedKind, value[3]).bytes();
}

export function createBitfsArbitrationClient(input: {
  /** 当前 owner 的唯一 Window Host。 */
  host: AuthenticatedDialHost;
  /** 本机开发允许 loopback WS；生产默认关闭。 */
  allowLoopbackWs?: boolean;
  /** 覆盖整个拨号/写入/响应周期的超时。 */
  timeoutMs?: number;
}): BitfsArbitrationTransport {
  const timeoutMs = input.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("仲裁超时必须是正整数毫秒");
  const roundTrip = async (endpoint: BitfsArbitrationEndpoint, request: Uint8Array, kind: 0 | 8 | 10, signal?: AbortSignal): Promise<Uint8Array> => {
      const expectedKind = kind === 0 ? 0 : kind === 8 ? 9 : 11;
      const peer = deriveSupplierPeerId(endpoint.publicKeyHex);
      const address = normalizeSupplierAddress(endpoint.address, peer, { allowLoopbackWs: input.allowLoopbackWs === true });
      if (!address.ok) throw new Error(`仲裁地址无效：${address.message}`);
      const controller = new AbortController();
      const forwardAbort = () => controller.abort(signal?.reason);
      if (signal?.aborted) forwardAbort();
      else signal?.addEventListener("abort", forwardAbort, { once: true });
      const timer = setTimeout(() => controller.abort(new Error("仲裁请求超时")), timeoutMs);
      let stream: Awaited<ReturnType<Awaited<ReturnType<typeof dialAuthenticatedAddress>>["newStream"]>> | undefined;
      let frames: AsyncIterableIterator<Uint8Array> | undefined;
      const abort = () => stream?.abort(new Error("仲裁请求已取消或超时"));
      controller.signal.addEventListener("abort", abort, { once: true });
      try {
        const connection = await dialAuthenticatedAddress({ host: input.host, address: address.value.normalized, publicKeyHex: endpoint.publicKeyHex, signal: controller.signal });
        stream = await connection.newStream(`/bitfs/arbitration/${kind === 0 ? "info" : kind === 8 ? "submit" : "retrieve"}/1.0.0`, { signal: controller.signal });
        // 注册 reader 后再发请求，避免快速响应在 listener 安装前到达。
        const max = MAX_WIRE_FRAME_BYTES + 4096;
        frames = readUvarintFrames(stream, { signal: controller.signal, maxInboundFrameBytes: max, maxBufferedBytes: max + 10, maxBufferedFrames: 1 });
        const response = frames.next();
        if (!writeUvarintFrame(stream, request)) await stream.onDrain();
        const first = await response;
        if (first.done) throw new Error("仲裁服务未返回响应");
        return decodeArbitrationEnvelope(first.value, expectedKind);
      } catch (error) {
        stream?.abort(error instanceof Error ? error : new Error("仲裁交换失败"));
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", forwardAbort);
        controller.signal.removeEventListener("abort", abort);
        await frames?.return?.();
        // 不关闭共享 Host/Connection，避免影响同 owner 的其他业务。
        if (stream) await stream.close().catch(() => undefined);
      }
  };
  return {
    async info({ endpoint, signal }) {
      return decodeArbitrationFeeInfo(await roundTrip(endpoint, new Uint8Array([1]), 0, signal), endpoint.publicKeyHex);
    },
    async exchange({ endpoint, request, signal }) {
      const kind = parse(request).kind;
      if (kind !== 8 && kind !== 10) throw new Error("仲裁客户端只接受 Kind 8 或 Kind 10");
      return roundTrip(endpoint, request, kind, signal);
    },
  };
}
