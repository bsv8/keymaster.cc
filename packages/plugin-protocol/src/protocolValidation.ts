import { validateNetworkIdentity, type NetworkIdentity, type ProtocolMethod, type MethodParams } from "@keymaster/contracts";
import { parseRequestMessage as parseWireRequest, ProtocolValidationError } from "keymaster-connect/server";

// 这里只做钱包内部执行 DTO 的适配；消息、字段、金额、路径、proof 的校验均归独立 Receiver。
export {
  ProtocolValidationError, parseCancelMessage, assertOriginMatches, assertMainnetP2pkhAddress,
  assertP2pkhAddressForAsset, assertCompressedPubkeyHex, validateExactChannel, isStructuredCloneRequestCandidate,
} from "keymaster-connect/server";

/** 保留产品范围开关供宿主装配使用；接收栈始终执行 v1 公开范围。 */
export const CONNECT_V1_SCOPE_ENABLED = true;

/** 内部调用也不能冒充 Connect 公开费用池或旧转账入口。 */
export function assertConnectV1Scope(method: ProtocolMethod, params: MethodParams<ProtocolMethod>): void {
  if (method === "feepool.prepare" || method === "feepool.commit" || method === "p2pkh.transfer" ||
      (method === "payment.channel.register" && (params as { paymentType?: unknown }).paymentType === "feepool.connect")) {
    throw new ProtocolValidationError("unsupported_scope", "Method is outside Connect v1 scope");
  }
}

/** 可信 receiver identity 转换成旧业务层所需上下文，不把内部字段放回 wire。 */
export function internalExecutionParams(method: ProtocolMethod, params: object, receiverIdentity: NetworkIdentity): MethodParams<ProtocolMethod> {
  const identity = validateNetworkIdentity(receiverIdentity);
  const payment = method === "payment.pay" || method === "payment.channel.register";
  return { ...params,
    ...(!["connect.login", "connect.launch", "channel.publish", "channel.subscription_set"].includes(method) ? { walletPublicKeyHex: identity.publicKeyHex } : {}),
    ...(payment ? { assetId: identity.bsvNetwork === "test" ? "bsv-testnet" : "bsv-mainnet" } : {}),
  } as MethodParams<ProtocolMethod>;
}

/** 纯业务适配入口供内部调用和边界测试使用，不持有第二套 schema。 */
export function parseRequestMessage(raw: unknown, receiverIdentity: NetworkIdentity) {
  const parsed = parseWireRequest(raw, receiverIdentity);
  const networkIdentity = validateNetworkIdentity(receiverIdentity);
  return { ...parsed, networkIdentity, params: internalExecutionParams(parsed.method, parsed.params, networkIdentity) };
}
