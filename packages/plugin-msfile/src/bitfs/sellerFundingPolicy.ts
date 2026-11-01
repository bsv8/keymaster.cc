import { buildArbitrationPaymentFromClaim, deriveOpeningDetails, type SellerPoolEvidence, type DeliveryRequestSummary } from "bitfs-protocol";

/** 在交付前实际构造仲裁候选，覆盖累计付款、该批仲裁费和规范矿工费。
 * 开池不以文件最低价格准入；本检查不签名、不广播，也不读取正文。 */
export async function assertBitfsDeliveryCapacity(pool: SellerPoolEvidence, summary: DeliveryRequestSummary, arbitrationFee: bigint): Promise<void> {
  const details = await deriveOpeningDetails(pool.opening);
  buildArbitrationPaymentFromClaim(details.poolOutputSatoshis, details.poolLockingScript,
    pool.opening.refundTemplateRaw, summary.paymentSequence, summary.sellerAmountAfterSatoshis, arbitrationFee);
}
