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

export interface P2pkhWorkerTransfer {
  readonly identity: Readonly<import("./networkIdentity.js").NetworkIdentity>;
  prepareTransfer(input: P2pkhTransferRequest): Promise<unknown>;
  submitTransfer(preview: unknown): Promise<{ status: "local-confirmed" | "isolated" | "not-dispatched"; txid?: string; error?: string; rawTxHex: string; submissionId: string; localInputClaimIds: string[]; attempts: number; reason?: string }>;
}
export interface P2pkhWorkerTransferBinding {
  getService(): Promise<P2pkhWorkerTransfer>;
}
/** Lazy Worker transfers; lifecycle, repositories and provider registration stay private. */
export const P2PKH_WORKER_TRANSFER_CAPABILITY = defineCapability<P2pkhWorkerTransferBinding>({ kind: "local", id: "p2pkh.worker-transfer", version: "1" });

