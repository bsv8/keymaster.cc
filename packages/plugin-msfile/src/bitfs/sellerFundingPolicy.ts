import { Transaction } from "@bsv/sdk";
import { decode } from "cborg";
import { MultisigPoolEngine, parseAs, buildArbitrationPaymentFromClaim, deriveOpeningDetails, type SellerPoolEvidence, type DeliveryRequestSummary } from "go-bitfs";

/** 只在 SDK 验过买方退款签名、即将调用卖方签名器时读取这些字段。
 * parseAs 负责严格 wire 检查；金额由规范退款模板重建，不能相信买方声称的余额。 */
export async function inspectBitfsPresignCapacity(rawKind2: Uint8Array) {
  const fields = decode(parseAs(2, rawKind2).bytes()) as [unknown, unknown, Uint8Array, Uint8Array, Uint8Array, Uint8Array, bigint | number, Uint8Array];
  const engine = new MultisigPoolEngine({ buyerPublicKey: fields[3], sellerPublicKey: fields[4], arbiterPublicKey: fields[5] });
  const terms = await engine.deriveRefundTerms(fields[2], BigInt(fields[6]));
  return { firstPaymentSequence: (Transaction.fromBinary(Array.from(fields[2])).inputs[0]!.sequence ?? 0) + 1, refundTemplateRaw: fields[2], arbiterPublicKey: fields[5], poolAmount: terms.poolOutputSatoshis, script: engine.lockingScript() };
}

/** 让 SDK 实际构造仲裁候选，覆盖累计付款、该批仲裁费和规范矿工费。
 * 只验证容量，不签名、不广播；不足时必须在交付内容之前拒绝。 */
export async function assertBitfsDeliveryCapacity(pool: SellerPoolEvidence, summary: DeliveryRequestSummary, arbitrationFee: bigint): Promise<void> {
  const details = await deriveOpeningDetails(pool.opening);
  buildArbitrationPaymentFromClaim(details.poolOutputSatoshis, details.poolLockingScript,
    pool.opening.refundTemplateRaw, summary.paymentSequence, summary.sellerAmountAfterSatoshis, arbitrationFee);
}
