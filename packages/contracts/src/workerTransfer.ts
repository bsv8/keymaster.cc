import { defineCapability } from "webloom-framework";
import type { ActiveKeyCrypto } from "./activeKeyCrypto.js";

export interface VaultWorkerCrypto {
  createActiveKeyCrypto(publicKeyHex: string): Promise<ActiveKeyCrypto>;
}
export const VAULT_WORKER_CRYPTO_CAPABILITY = defineCapability<VaultWorkerCrypto>({ kind: "local", id: "vault.worker-crypto", version: "1" });

export interface P2pkhWorkerTransfer {
  getGlobalSettings(): { bsvNetwork?: "main" | "test"; feeRateSatoshisPerKb?: number };
  prepareTransfer(input: { paymentContext?: { channelId: string; sessionId: string | null }; assetId: "bsv" | "bsvtest"; ownerPublicKeyHex: string; recipientAddress?: string; amountSatoshis: number; sendAll?: boolean; feeRateSatoshisPerKb?: number; payment?: import("./p2pkhConnectPayment.js").P2pkhConnectPaymentFacts }): Promise<unknown>;
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
    spend: import("./protocolSpend.js").ProtocolSpendService;
    funding: import("./protocolSpend.js").ProtocolFundingService;
    planFunding(input: Extract<import("./protocolSpendRpc.js").P2pkhProtocolCommand, { type: "funding-plan" }>["input"]): Promise<{ selected: import("./protocolSpend.js").ProtocolSpendInput[]; totalInputSatoshis: number }>;
    observer: import("./protocolSpend.js").ProtocolSubmissionObserver;
    protectedOutpoints: import("./spendProtection.js").ProtectedOutpointRegistry;
  }>;
}
export const P2PKH_WORKER_PROTOCOL_CAPABILITY = defineCapability<P2pkhWorkerProtocolBinding>({ kind: "local", id: "p2pkh.worker-protocol", version: "1" });
