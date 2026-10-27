import { defineCapability } from "webloom-framework";
import type { ActiveKeyCrypto } from "./activeKeyCrypto.js";

export interface VaultWorkerCrypto {
  createActiveKeyCrypto(): Promise<ActiveKeyCrypto>;
}
export const VAULT_WORKER_CRYPTO_CAPABILITY = defineCapability<VaultWorkerCrypto>({ kind: "local", id: "vault.worker-crypto", version: "1" });

export interface P2pkhTransferRequest {
  paymentContext?: { channelId: string; sessionId: string | null };
  recipientAddress?: string;
  amountSatoshis: number;
  sendAll?: boolean;
  feeRateSatoshisPerKb?: number;
  payment?: import("./p2pkhConnectPayment.js").P2pkhConnectPaymentFacts;
}

const transferRequestFields = new Set(["paymentContext", "recipientAddress", "amountSatoshis", "sendAll", "feeRateSatoshisPerKb", "payment"]);
/** 检查请求字段边界；金额、地址和签名事实仍由执行层完整验证。 */
export function assertP2pkhTransferRequestFields(request: unknown): void {
  if (!request || typeof request !== "object" || Array.isArray(request)
    || Object.keys(request).some(key => !transferRequestFields.has(key))) throw new TypeError("Unsupported transfer request field");
}

export interface P2pkhWorkerTransfer {
  getGlobalSettings(): { bsvNetwork: "main" | "test"; feeRateSatoshisPerKb?: number };
  prepareTransfer(input: P2pkhTransferRequest): Promise<unknown>;
  submitTransfer(preview: unknown): Promise<{ status: "local-confirmed" | "isolated" | "not-dispatched"; txid?: string; error?: string; rawTxHex: string; submissionId: string; localInputClaimIds: string[]; attempts: number; reason?: string }>;
}
export interface P2pkhWorkerTransferBinding {
  getService(): Promise<P2pkhWorkerTransfer>;
}
/** Lazy Worker transfers; lifecycle, repositories and provider registration stay private. */
export const P2PKH_WORKER_TRANSFER_CAPABILITY = defineCapability<P2pkhWorkerTransferBinding>({ kind: "local", id: "p2pkh.worker-transfer", version: "1" });

/** Wallet-owned protocol operations share the transfer runtime, funding files and claims. */
export interface P2pkhWorkerProtocolBinding {
  getService(): Promise<{
    readonly identity: Readonly<import("./networkIdentity.js").NetworkIdentity>;
    spend: import("./protocolSpend.js").ProtocolSpendService;
    funding: import("./protocolSpend.js").ProtocolFundingService;
    planFunding(input: import("./protocolSpend.js").ProtocolFundingPlanRequest): Promise<{ selected: import("./protocolSpend.js").ProtocolSpendInput[]; totalInputSatoshis: number }>;
    observer: import("./protocolSpend.js").ProtocolSubmissionObserver;
    protectedOutpoints: import("./spendProtection.js").ProtectedOutpointRegistry;
  }>;
}
export const P2PKH_WORKER_PROTOCOL_CAPABILITY = defineCapability<P2pkhWorkerProtocolBinding>({ kind: "local", id: "p2pkh.worker-protocol", version: "1" });
