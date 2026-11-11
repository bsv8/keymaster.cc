// Connect v1 payment facts shared by the protocol adapter, Worker transfer
// service and Vault review. These are internal DTOs, not a second approval
// system: they only carry the frozen payment plan between trusted components.

import type { ConnectPaymentOutput } from "./protocol.js";

/** Facts the protocol handler hands to the P2PKH service before coin selection. */
export interface P2pkhConnectPaymentFacts {
  paymentId: string;
  clientRequestId: string;
  /** 业务输出；顺序即链上顺序，找零由钱包追加。 */
  outputs: ConnectPaymentOutput[];
  /** Verified App identity facts used for the Vault risk statement. */
  appId: string;
  appName: string;
  origin: string;
  /** Verified App publisher. */
  publisherPublicKeyHex: string;
}

/** Frozen facts returned with a payment preview and persisted by the manager. */
export interface P2pkhConnectPaymentPreview {
  paymentId: string;
  clientRequestId: string;
  /** Manager plan digest; binds Vault cancellation proof to the frozen plan. */
  planDigest: string;
  appId: string;
  appName: string;
  origin: string;
  publisherPublicKeyHex: string;
  /** 业务输出总额（字符串 sat，不含矿工费与找零）。 */
  businessTotalSats: string;
  changeAmountSats: string;
  feeSats: string;
  changeScriptHex: string | null;
  outputs: Array<{ vout: number; scriptHex: string; valueSats: string; role: "business" | "change" }>;
}
