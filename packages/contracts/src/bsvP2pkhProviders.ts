import type { BsvNetwork } from "./vault.js";

/** The only normalized data a confirmed P2PKH provider may expose. */
export interface P2pkhConfirmedDataProvider {
  readonly descriptor: P2pkhProviderDescriptor;
  listAddressConfirmedTransactions(input: {
    network: BsvNetwork;
    address: string;
    cursor?: string;
    limit: number;
    signal: AbortSignal;
  }): Promise<P2pkhConfirmedTransactionPage>;
  getConfirmedTransaction(input: {
    network: BsvNetwork;
    txid: string;
    signal: AbortSignal;
  }): Promise<P2pkhConfirmedTransaction>;
}

/** A broadcast provider is intentionally independent from confirmed sync. */
export interface P2pkhTransactionBroadcastProvider {
  readonly descriptor: P2pkhProviderDescriptor;
  broadcast(input: {
    network: BsvNetwork;
    canonicalTxid: string;
    rawTxHex: string;
    signal?: AbortSignal;
  }): Promise<P2pkhBroadcastResult>;
}

export interface P2pkhProviderDescriptor {
  id: string;
  label: string;
  supportedNetworks: BsvNetwork[];
}

export interface P2pkhConfirmedTransactionPage {
  items: Array<{
    txid: string;
    blockHeight?: number;
    blockHash?: string;
    blockTime?: number;
  }>;
  nextCursor?: string;
  exhausted: boolean;
}

export interface P2pkhConfirmedTransaction {
  txid: string;
  rawTxHex: string;
  blockHeight?: number;
  blockHash?: string;
  blockTime?: number;
}

export interface P2pkhBroadcastResult {
  status: "accepted" | "already-known";
  canonicalTxid: string;
  providerReference?: string;
  providerCode?: string;
  providerMessage?: string;
}

export interface P2pkhProviderRegistrySnapshot {
  syncProviders: P2pkhProviderDescriptor[];
  broadcastProviders: P2pkhProviderDescriptor[];
  selection: P2pkhProviderSettings;
}

export interface P2pkhNetworkProviderSelection {
  syncProviderId: string | null;
  broadcastProviderId: string | null;
}

export interface P2pkhProviderSettings {
  main: P2pkhNetworkProviderSelection;
  test: P2pkhNetworkProviderSelection;
  generation: number;
}

export type P2pkhProviderCapability = "confirmed-sync" | "broadcast";

export const P2PKH_PROVIDERS_CAPABILITY = "p2pkh.providers";

export type P2pkhProviderFailureCode =
  | "provider-unavailable"
  | "unsupported-network"
  | "provider-inconsistent"
  | "rate-limited"
  | "aborted"
  | "rejected"
  | "unknown";

/** Provider errors are diagnostic only; business state consumes normalized status. */
export class P2pkhProviderError extends Error {
  readonly code: P2pkhProviderFailureCode;
  readonly providerCode?: string;

  constructor(code: P2pkhProviderFailureCode, message: string, providerCode?: string) {
    super(message);
    this.name = "P2pkhProviderError";
    this.code = code;
    this.providerCode = providerCode;
  }
}

export interface P2pkhProviderRegistry {
  registerConfirmedProvider(provider: P2pkhConfirmedDataProvider): void;
  /** Optional lifecycle hook used when an optional provider plugin is disabled. */
  unregisterConfirmedProvider?(providerId: string): void;
  registerBroadcastProvider(provider: P2pkhTransactionBroadcastProvider): void;
  listConfirmedProviders(network?: BsvNetwork): P2pkhProviderDescriptor[];
  listBroadcastProviders(network?: BsvNetwork): P2pkhProviderDescriptor[];
  getConfirmedProvider(id: string, network: BsvNetwork): P2pkhConfirmedDataProvider | undefined;
  getBroadcastProvider(id: string, network: BsvNetwork): P2pkhTransactionBroadcastProvider | undefined;
}
