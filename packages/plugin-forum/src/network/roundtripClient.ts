// Forum 的 roundtrip 网络层。
//
// 身份方向必须分清：roundtrip 请求的 `from` 是**当前钱包 Key**，也是
// operatorSig 的签名身份和 vout 1 的 clientpublickey；`to` 才是配置的论坛服务
// 公钥。所以 libp2p 对端 PeerId 必须对应论坛公钥，而本地身份要与 operatorSig
// 同源，三者不是同一个东西。
//
// 其他关键边界：
//   - 签名走 Vault 的受控 active key，私钥不进入本页；
//   - 使用与 Go 侧同版本的 roundtrip SDK：请求过期、nonce 与重放规则由它处理；
//   - 客户端采用**完整** roundtrip 响应：校验签名、from、to 与 reply_to，
//     绝不以 HTTP 200 判断成功。

import type { ActiveKeyCrypto, ForumEndpointConfig } from "@keymaster/contracts";
import { FORUM_HTTP_PATH } from "@keymaster/contracts";
import {
  HTTP_CONTENT_TYPE,
  RoundtripCore,
  digestOf,
  httpExchange,
  type Exchange,
  type JsonObject,
  type RoundtripSigner,
} from "key-roundtrip";

/** SDK 与业务签名都要求严格 DER。 */
const SIGNATURE_FORMAT = "der" as const;

/**
 * 把 Vault 的受控签名能力适配成 roundtrip signer。
 *
 * signer 不持有私钥，也不接受任意摘要：SDK 的 core 已经校验过 unsigned 消息的
 * 结构、收件人与 nonce，这里只负责把规范字节的摘要交给 active key，并断言
 * 返回的格式与身份。
 */
export function createVaultRoundtripSigner(crypto: ActiveKeyCrypto, identity: { publicKeyHex: string }): RoundtripSigner {
  const publicKeyHex = identity.publicKeyHex.toLowerCase();
  return {
    publicKey(): Uint8Array {
      return hexToBytes(publicKeyHex);
    },
    async signRoundtrip(unsigned, signal): Promise<Uint8Array> {
      if (signal?.aborted === true) throw signal.reason as Error;
      const result = await crypto.signDigest({
        publicKeyHex,
        digest: toArrayBuffer(digestOf(unsigned)),
        format: SIGNATURE_FORMAT,
      });
      if (result.publicKeyHex.toLowerCase() !== publicKeyHex) {
        throw new ForumIdentityError("签名结果的身份与请求身份不一致");
      }
      if (result.format !== SIGNATURE_FORMAT) {
        throw new ForumIdentityError(`签名格式必须是 ${SIGNATURE_FORMAT}，实际 ${result.format}`);
      }
      return new Uint8Array(result.signature);
    },
  };
}

export interface ForumTransport {
  readonly kind: ForumEndpointConfig["kind"];
  /** 把已构建的请求字节送到对端，返回完整响应字节。 */
  exchange(requestBytes: Uint8Array, signal: AbortSignal): Promise<Uint8Array>;
  dispose(): Promise<void>;
}

/** HTTPS 入口。服务端只接受 POST <path>，操作来自已签名的 body.op。 */
export function createHttpsTransport(input: { baseUrl: string; fetchImpl?: typeof globalThis.fetch }): ForumTransport {
  const base = input.baseUrl.endsWith("/") ? input.baseUrl.slice(0, -1) : input.baseUrl;
  const exchange = httpExchange(`${base}${FORUM_HTTP_PATH}`, {
    ...(input.fetchImpl === undefined ? {} : { fetch: input.fetchImpl }),
    headers: { accept: HTTP_CONTENT_TYPE },
  });
  return {
    kind: "https",
    exchange: (requestBytes, signal) => exchange(requestBytes, signal),
    dispose: async () => undefined,
  };
}

/**
 * libp2p 入口（WSS 与 WebRTC Direct 共用）。
 *
 * 请求字节交给 Window P2P lane 执行，因此 Forum 不需要自己持有 Host；TLS、
 * certhash 与 PeerId 校验都在 lane 里完成。
 */
export function createLibp2pTransport(input: {
  dispatch: (operation: unknown, signal: AbortSignal) => Promise<unknown>;
  endpoint: ForumEndpointConfig;
  /** 已由业务层验证的论坛服务公钥；拨号后必须与远端身份一致。 */
  forumPublicKeyHex: string;
}): ForumTransport {
  return {
    kind: input.endpoint.kind,
    async exchange(requestBytes, signal): Promise<Uint8Array> {
      const outcome = await input.dispatch(
        {
          kind: "forum.roundtrip",
          address: input.endpoint.url,
          forumPublicKeyHex: input.forumPublicKeyHex,
          requestBytesHex: bytesToHex(requestBytes),
        },
        signal,
      );
      if (typeof outcome !== "object" || outcome === null) {
        throw new ForumTransportError("forum-lane-result", "libp2p lane 没有返回结果");
      }
      const record = outcome as { ok?: unknown; responseBytesHex?: unknown; code?: unknown; message?: unknown };
      if (record.ok !== true || typeof record.responseBytesHex !== "string") {
        throw new ForumTransportError(
          typeof record.code === "string" ? record.code : "forum-lane-transport",
          typeof record.message === "string" ? record.message : "libp2p lane 调用失败",
        );
      }
      return hexToBytes(record.responseBytesHex);
    },
    dispose: async () => undefined,
  };
}

/**
 * Forum 业务参数的可取值集合。
 *
 * 刻意比 `Record<string, unknown>` 窄：服务端对 `args` 的每一个字段都做类型与
 * 范围校验，未知字段直接拒绝，所以参数必须是可枚举的 JSON 标量，越窄越早失败。
 */
export type ForumArgValue = string | number | boolean | null;
export type ForumArgs = Record<string, ForumArgValue>;

export interface ForumRequestBody {
  readonly op: string;
  readonly args?: ForumArgs;
}

export type ForumCallOutcome =
  | { ok: true; result: Record<string, unknown>; requestId: string }
  | { ok: false; error: { code: string; message: string }; requestId: string };

export interface ForumRoundtripClient {
  /** 发起一次业务调用；业务失败以已签名的 error 返回，传输失败抛异常。 */
  call(body: ForumRequestBody, signal?: AbortSignal): Promise<ForumCallOutcome>;
  /** 当前客户端身份，即 roundtrip 的 from。 */
  readonly callerPublicKeyHex: string;
  dispose(): void;
}

/**
 * 一条论坛连接：roundtrip core + transport。
 *
 * core 负责过期窗口、nonce、签名与响应关联校验；它已经校验了响应的签名、
 * from、to 与 reply_to，所以业务层拿到的 `{ok:true,result}` 一定是对方签名过的
 * 结果，而不是「HTTP 200」。
 */
export function createForumRoundtripClient(input: {
  signer: RoundtripSigner;
  transport: ForumTransport;
  /** 配置的论坛服务公钥，即 roundtrip 的 to。 */
  forumPublicKeyHex: string;
  /** 期望的调用者身份；与 signer 的身份不一致时立即失败，不发出请求。 */
  callerPublicKeyHex: string;
  callTimeoutMs?: number;
}): ForumRoundtripClient {
  const callerPublicKeyHex = bytesToHex(input.signer.publicKey());
  if (callerPublicKeyHex !== input.callerPublicKeyHex.toLowerCase()) {
    // 任务记录的 owner 与实际签名身份必须一致，否则恢复时会把旧任务当成新用户的操作。
    throw new ForumIdentityError(
      `签名身份 ${callerPublicKeyHex.slice(0, 16)}… 与期望的 owner ${input.callerPublicKeyHex.toLowerCase().slice(0, 16)}… 不一致`,
    );
  }
  if (!/^(02|03)[0-9a-f]{64}$/u.test(input.forumPublicKeyHex)) {
    throw new ForumIdentityError("论坛服务公钥必须是 33 字节压缩公钥");
  }
  const core = new RoundtripCore({
    signer: input.signer,
    ...(input.callTimeoutMs === undefined ? {} : { callTimeoutMs: input.callTimeoutMs }),
  });
  const exchange: Exchange = (requestBytes, signal) => input.transport.exchange(requestBytes, signal);
  return {
    callerPublicKeyHex,
    async call(body, signal) {
      const outcome = await core.call({
        to: hexToBytes(input.forumPublicKeyHex),
        body: toJsonBody(body),
        exchange,
        ...(signal === undefined ? {} : { signal }),
      });
      if (!outcome.ok) {
        return { ok: false, error: outcome.error, requestId: outcome.requestId };
      }
      if (typeof outcome.result !== "object" || outcome.result === null || Array.isArray(outcome.result)) {
        throw new ForumResponseShapeError("服务端返回的 result 不是 JSON 对象");
      }
      return { ok: true, result: outcome.result as Record<string, unknown>, requestId: outcome.requestId };
    },
    dispose() {
      /* core 不持有外部资源；传输由调用方 dispose。 */
    },
  };
}

export class ForumTransportError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ForumTransportError";
    this.code = code;
  }
}

export class ForumIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForumIdentityError";
  }
}

export class ForumResponseShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForumResponseShapeError";
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

/**
 * 业务参数到 SDK `JsonValue` 的窄转换。
 *
 * 只接受标量，并拒绝非安全整数的 number：金额已经由调用方表达为十进制字符串，
 * 这里出现的裸 number 只能是页大小或高度，越界数字被截断会让服务端看到一个
 * 调用方从未请求过的值。
 */
function toJsonBody(body: ForumRequestBody): JsonObject {
  if (body.op.length === 0) throw new ForumResponseShapeError("op 不能为空");
  if (body.args === undefined) return { op: body.op };
  const args: JsonObject = {};
  for (const [key, value] of Object.entries(body.args)) {
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) {
        throw new ForumResponseShapeError(`args.${key} 必须是安全整数或字符串金额`);
      }
      args[key] = value;
      continue;
    }
    if (typeof value === "string" || typeof value === "boolean" || value === null) {
      args[key] = value;
      continue;
    }
    throw new ForumResponseShapeError(`args.${key} 不是可序列化的 JSON 标量`);
  }
  return { op: body.op, args };
}

function hexToBytes(text: string): Uint8Array {
  if (text.length % 2 !== 0) throw new ForumIdentityError("hex 长度必须是偶数");
  const out = new Uint8Array(text.length / 2);
  for (let index = 0; index < out.length; index += 1) out[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}