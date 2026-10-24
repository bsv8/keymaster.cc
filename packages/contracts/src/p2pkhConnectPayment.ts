// Connect v1 payment facts shared by the protocol adapter, Worker transfer
// service and Vault review. These are internal DTOs, not a second approval
// system: they only carry the frozen payment plan between trusted components.

import type { ConnectPaymentRecipient, ConnectPaymentRecipientOwnership, ConnectPaymentType } from "./protocol.js";

/** Facts the protocol handler hands to the P2PKH service before coin selection. */
export interface P2pkhConnectPaymentFacts {
  paymentId: string;
  clientRequestId: string;
  paymentType: ConnectPaymentType;
  businessKind: string;
  recipient: ConnectPaymentRecipient;
  /** Verified App identity facts used for the Vault risk statement. */
  appId: string;
  appName: string;
  origin: string;
  /** Verified App publisher; the service computes ownership against the real script. */
  publisherPublicKeyHex: string;
}

/** Frozen facts returned with a payment preview and persisted by the manager. */
export interface P2pkhConnectPaymentPreview {
  paymentId: string;
  clientRequestId: string;
  /** Manager plan digest; binds Vault cancellation proof to the frozen plan. */
  planDigest: string;
  paymentType: ConnectPaymentType;
  businessKind: string;
  appId: string;
  appName: string;
  origin: string;
  publisherPublicKeyHex: string;
  recipientOwnership: ConnectPaymentRecipientOwnership;
  recipientLabel: string;
  businessScriptHex: string;
  businessAmountSats: string;
  changeAmountSats: string;
  feeSats: string;
  changeScriptHex: string | null;
  outputs: Array<{ vout: number; scriptHex: string; valueSats: string; role: "business" | "change" }>;
}
