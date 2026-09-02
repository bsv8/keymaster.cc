// SharedWorker Channel crypto adapter。
//
// 页面侧 Sat provider 只拿到密文 envelope 和已验证的元数据；所有调用都
// 通过 Coordinator 白名单 RPC 进入 SharedWorker，绝不传递 raw private key。

import type {
  CoordinatorChannelOpenResult,
  CoordinatorChannelSealResult
} from "./channelCryptoTypes.js";
import type { CoordinatorCryptoOperation, SessionCoordinatorClient } from "@keymaster/contracts";
import type { SatChannelCrypto, SatChannelOpenResult, SatChannelSealResult } from "./satProvider.js";
import { isCompressedPublicKeyHex } from "./satValidation.js";

function asError(ack: { status: string; message?: string }): Error {
  return new Error(ack.message ?? `Coordinator crypto failed: ${ack.status}`);
}

/** Coordinator RPC 返回结果的运行时校验与类型收口。 */
export function createCoordinatorChannelCrypto(coordinator: SessionCoordinatorClient): SatChannelCrypto {
  const call = async (operation: CoordinatorCryptoOperation): Promise<unknown> => {
    const response = await coordinator.crypto(operation);
    if (response.ack.status !== "ok" || !response.result) throw asError(response.ack);
    return response.result;
  };
  return {
    async sealDeliver(input) {
      const value = await call({ type: "channel.seal-deliver", ...input });
      return assertSeal(value);
    },
    async sealAck(input) {
      const value = await call({ type: "channel.seal-ack", ...input });
      return assertSeal(value);
    },
    async open(input) {
      const value = await call({ type: "channel.open", ...input });
      return assertOpen(value);
    }
  };
}

function assertSeal(value: unknown): SatChannelSealResult {
  if (!value || typeof value !== "object" || (value as { type?: unknown }).type !== "channel.seal") throw new Error("Coordinator returned an invalid Channel seal result");
  const result = value as Partial<CoordinatorChannelSealResult>;
  if (typeof result.channel !== "string" || typeof result.messageIdBase64Url !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(result.messageIdBase64Url) || !(result.envelopeJson instanceof Uint8Array) || typeof result.fromPublicKeyHex !== "string" || !isCompressedPublicKeyHex(result.fromPublicKeyHex) || !Number.isSafeInteger(result.expiresAtMs)) throw new Error("Coordinator returned an invalid Channel seal result");
  return {
    channel: result.channel,
    messageIdBase64Url: result.messageIdBase64Url,
    envelopeJson: result.envelopeJson.slice(),
    fromPublicKeyHex: result.fromPublicKeyHex,
    expiresAtMs: result.expiresAtMs!
  };
}

function assertOpen(value: unknown): SatChannelOpenResult {
  if (!value || typeof value !== "object" || (value as { type?: unknown }).type !== "channel.open") throw new Error("Coordinator returned an invalid Channel open result");
  const result = value as Partial<CoordinatorChannelOpenResult>;
  const issuedAtMs = result.issuedAtMs;
  const expiresAtMs = result.expiresAtMs;
  if (typeof result.channel !== "string" || typeof result.messageIdBase64Url !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(result.messageIdBase64Url) || !/^[0-9a-f]{64}$/.test(String(result.signedDigestHex)) || typeof result.fromPublicKeyHex !== "string" || !isCompressedPublicKeyHex(result.fromPublicKeyHex) || typeof result.toPublicKeyHex !== "string" || !isCompressedPublicKeyHex(result.toPublicKeyHex) || typeof result.protocol !== "string" || (result.bodyType !== "deliver" && result.bodyType !== "ack") || typeof issuedAtMs !== "number" || !Number.isSafeInteger(issuedAtMs) || typeof expiresAtMs !== "number" || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= issuedAtMs || expiresAtMs - issuedAtMs > 24 * 60 * 60 * 1000) throw new Error("Coordinator returned an invalid Channel open result");
  if (result.bodyType === "deliver" && !(result.contentJson instanceof Uint8Array)) throw new Error("Coordinator returned a Channel Deliver without content");
  if (result.bodyType === "ack" && (typeof result.acknowledgedMessageIdBase64Url !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(result.acknowledgedMessageIdBase64Url))) throw new Error("Coordinator returned an invalid Channel ACK result");
  return {
    channel: result.channel,
    messageIdBase64Url: result.messageIdBase64Url,
    signedDigestHex: result.signedDigestHex!,
    fromPublicKeyHex: result.fromPublicKeyHex,
    toPublicKeyHex: result.toPublicKeyHex,
    protocol: result.protocol,
    bodyType: result.bodyType,
    ...(result.contentJson ? { contentJson: result.contentJson.slice() } : {}),
    ...(typeof result.acknowledgedMessageIdBase64Url === "string" ? { acknowledgedMessageIdBase64Url: result.acknowledgedMessageIdBase64Url } : {}),
    issuedAtMs,
    expiresAtMs
  };
}
