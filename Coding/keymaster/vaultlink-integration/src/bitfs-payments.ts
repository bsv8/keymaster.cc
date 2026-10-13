import {
  equal,
  hex,
  unhex,
  inspectFeePool,
  inspectBitfsAuthorization, inspectBitfsOpening,
  parseTransaction,
} from "@vaultlink/sdk";
import type { WalletPaymentCommand } from "./wallet-payments.js";
interface SigningRequest {
  purpose: "wire_message" | "transaction";
  wireKind: number;
  digest: Uint8Array;
  transactionRaw?: Uint8Array;
  documentCBOR?: Uint8Array;
  openingRequestRaw?:Uint8Array;
  authorizationContext?: {unsignedTransactionRaw:Uint8Array;fundingTransactionRaw:Uint8Array;refundTemplateRaw:Uint8Array};
}
interface Signer {
  publicKey(): Uint8Array;
  sign(
    request: Readonly<SigningRequest>,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
}
/** BitFS 买方交易仅走钱包支付核心；普通协议消息仍由原有消息签名器处理。
 * 证据来自已经持久保存的 exact FundingTx 或链上原文，不把 SDK 声明金额当真值。
 * 卖方协签不是买方支出，本适配器不能拿卖方身份冒充买方付款。
 */
export function createBitfsPaymentSigner(
  wireSigner: Signer,
  context: {
    network: "main" | "test";
    role?: "buyer" | "seller" | "arbiter";
    assertActive(): void;
    requestPayment(command: WalletPaymentCommand): Promise<unknown>;
    previousTransaction(txid: string): Promise<Uint8Array>;
  },
): Signer {
  const pub = wireSigner.publicKey().slice(),
    channelId = `bitfs.${context.role ?? "buyer"}.${context.network}`;
  let registration: Promise<unknown> | undefined;
  return {
    publicKey: () => pub.slice(),
    async sign(request, signal) {
      context.assertActive();
      if (signal?.aborted)
        throw new DOMException("BitFS signing cancelled", "AbortError");
      const authorizing=request.purpose==="wire_message"&&request.wireKind===5;
      if (request.purpose === "wire_message"&&!authorizing)
        return wireSigner.sign(request, signal);
      if(authorizing&&(!request.documentCBOR||!request.authorizationContext||(context.role&&context.role!=="buyer")))throw Error("payment-context-required");
      if (
        !authorizing && (
        request.purpose !== "transaction" ||
        request.wireKind !== 0 ||
        !request.transactionRaw)
      )
        throw Error("unsupported-transaction");
      const raw = new Uint8Array(authorizing?request.authorizationContext!.unsignedTransactionRaw:request.transactionRaw!),
        tx = parseTransaction(raw);
      if (tx.inputs.length !== 1) throw Error("invalid-pool-input");
      const txid = hex(tx.inputs[0]!.txid.slice().reverse());
      const opening=request.openingRequestRaw?new Uint8Array(request.openingRequestRaw):undefined;
      if(opening&&context.role!=="seller")throw Error("invalid-opening");
      const previous = opening ? undefined : authorizing ? new Uint8Array(request.authorizationContext!.fundingTransactionRaw) : await context.previousTransaction(txid);
      context.assertActive();
      const auth=authorizing?{document:new Uint8Array(request.documentCBOR!),refundTemplate:new Uint8Array(request.authorizationContext!.refundTemplateRaw)}:undefined;
      const review = opening ? await inspectBitfsOpening(raw,opening,pub) : auth ? await inspectBitfsAuthorization(raw,[previous!],pub,auth) : await inspectFeePool(
        raw,
        [previous!],
        pub,
        "bitfs",
        "state",
        context.role && context.role !== "buyer" ? "cosigner" : "payer",
      );
      if (
        request.digest.length !== 32 ||
        !equal(request.digest, review.digests[0]!)
      )
        throw Error("invalid-signing-digest");
      registration ??= context.requestPayment({
        action: "register",
        id: channelId,
        owner: "msfile",
        kind: "plugin",
        network: context.network,
        paymentType: context.role && context.role !== "buyer" ? "feepool.bitfs.cosigner" : "feepool.bitfs",
      });
      await registration;
      context.assertActive();
      if (signal?.aborted)
        throw new DOMException("BitFS signing cancelled", "AbortError");
      const result = await context.requestPayment({
        action: "sign-feepool",
        family: "bitfs",
        stage: "state",
        ...(context.role && context.role !== "buyer" ? {role: "cosigner" as const} : {}),
        channelId,
        paymentId: crypto.randomUUID(),
        sessionId: null,
        rawTxHex: hex(raw),
        prevTransactionHexes: previous ? [hex(previous)] : [],
        ...(opening ? {openingRequestHex:hex(opening)} : {}),
        ...(auth ? {authorization:{documentHex:hex(auth.document),refundTemplateHex:hex(auth.refundTemplate)}} : {}),
      });
      context.assertActive();
      if (
        !result ||
        typeof result !== "object" ||
        Array.isArray(result) ||
        !("signatures" in result) ||
        !Array.isArray(result.signatures) ||
        result.signatures.length !== 1 ||
        typeof result.signatures[0] !== "string"
      )
        throw Error("invalid-wallet-signature");
      const signature = unhex(result.signatures[0]);
      if(authorizing){if(signature.length<8||signature[0]!==0x30)throw Error("invalid-wallet-signature");return signature;}
      if (signature.length < 9 || signature.at(-1) !== 0x41)
        throw Error("invalid-wallet-signature");
      return signature.slice(0, -1);
    },
  };
}

export const createBitfsBuyerPaymentSigner = createBitfsPaymentSigner;
