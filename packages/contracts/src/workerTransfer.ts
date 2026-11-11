import { defineCapability } from "webloom-framework";
import type { ActiveKeyCrypto } from "./activeKeyCrypto.js";

export interface VaultWorkerCrypto {
  createActiveKeyCrypto(): Promise<ActiveKeyCrypto>;
}
export const VAULT_WORKER_CRYPTO_CAPABILITY = defineCapability<VaultWorkerCrypto>({ kind: "local", id: "vault.worker-crypto", version: "1" });

export interface P2pkhTransferRequest {
  paymentContext?: { channelId: string; sessionId: string | null };
  recipientAddress?: string;
  /** 普通转账金额；Connect outputs 支付时忽略，以 payment.outputs 总额为准。 */
  amountSatoshis?: number;
  sendAll?: boolean;
  feeRateSatoshisPerKb?: number;
  payment?: import("./p2pkhConnectPayment.js").P2pkhConnectPaymentFacts;
}

export type P2pkhDirectTransferResult = Omit<import("./bsvP2pkhProviders.js").P2pkhTransferResultPayload, "rawTxHex"> & {
  amountSatoshis: number; feeSatoshis: number; changeSatoshis: number; serializedSizeBytes: number;
};
export interface P2pkhWorkerTransfer {
  transfer(input: P2pkhTransferRequest): Promise<P2pkhDirectTransferResult>;
  readonly identity: Readonly<import("./networkIdentity.js").NetworkIdentity>;
  prepareTransfer(input: P2pkhTransferRequest): Promise<unknown>;
  submitTransfer(preview: unknown): Promise<{ status: "local-confirmed" | "isolated" | "not-dispatched"; txid?: string; error?: string; rawTxHex: string; submissionId: string; localInputClaimIds: string[]; attempts: number; reason?: string }>;
}
export interface P2pkhWorkerTransferBinding {
  getService(): Promise<P2pkhWorkerTransfer>;
}
/** Lazy Worker transfers; lifecycle, repositories and provider registration stay private. */
export const P2PKH_WORKER_TRANSFER_CAPABILITY = defineCapability<P2pkhWorkerTransferBinding>({ kind: "local", id: "p2pkh.worker-transfer", version: "1" });

