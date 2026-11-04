/** Caller-owned transaction outcome lookup; never inferred from allocation state. */
export interface P2pkhPaymentLookupInput {ownerPublicKeyHex: string; network: "main" | "test"; paymentId: string}
export interface P2pkhPaymentLookupResult {
 status: "not_found" | "not_signed" | "pending" | "signed_not_dispatched" | "unknown" | "accepted" | "failed";
 allocationId?: string;
 txid?: string;
}
export function projectP2pkhPaymentLookupResult(value: P2pkhPaymentLookupResult): P2pkhPaymentLookupResult {
 if (value.status === "not_found") return {status: value.status};
 if (value.status === "not_signed") return {status: value.status, allocationId: value.allocationId};
 return {status: value.status, allocationId: value.allocationId, ...(value.txid === undefined ? {} : {txid: value.txid})};
}
