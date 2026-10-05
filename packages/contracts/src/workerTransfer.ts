import { defineCapability } from "webloom-framework";
import type { ActiveKeyCrypto } from "./activeKeyCrypto.js";

export interface VaultWorkerCrypto {
  createActiveKeyCrypto(publicKeyHex: string): Promise<ActiveKeyCrypto>;
}
export const VAULT_WORKER_CRYPTO_CAPABILITY = defineCapability<VaultWorkerCrypto>({ kind: "local", id: "vault.worker-crypto", version: "1" });

export interface P2pkhWorkerTransfer {
  getGlobalSettings(): { includeTestnet?: boolean; feeRateSatoshisPerKb?: Partial<Record<"low" | "medium" | "high", number>> };
  prepareTransfer(input: { assetId: "bsv" | "bsvtest"; ownerPublicKeyHex: string; recipientAddress: string; amountSatoshis: number; feeRateSatoshisPerKb?: number }): Promise<unknown>;
  submitTransfer(preview: unknown): Promise<{ status: string; txid?: string; error?: string; rawTxHex?: string }>;
}
export interface P2pkhWorkerTransferBinding {
  getService(): Promise<P2pkhWorkerTransfer>;
}
/** Lazy Worker transfers; lifecycle, repositories and provider registration stay private. */
export const P2PKH_WORKER_TRANSFER_CAPABILITY = defineCapability<P2pkhWorkerTransferBinding>({ kind: "local", id: "p2pkh.worker-transfer", version: "1" });
