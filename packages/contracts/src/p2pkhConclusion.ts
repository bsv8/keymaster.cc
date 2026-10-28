/** Wallet-owner UI RPC only. Application payment.status remains read-only. */
export type P2pkhConclusionInput = {
  ownerPublicKeyHex: string;
  network: "main" | "test";
} & ({ action: "list" } | { action: "start" | "stop" | "recover"; allocationId: string });
export interface P2pkhInputConclusion {
  status: "conflict" | "failed";
  reason: "input-conflict";
  releasedInputs: string[];
  spentInputs: Array<{ outpoint: string; txid: string; vin: number | null; confirmed: boolean | null }>;
  heldInputs: string[];
  releasedSats: string;
}
export interface P2pkhConclusionRow {
  allocationId: string;
  txid: string;
  state: "pending" | "dispatching" | "unknown" | "done" | "failed";
  delivery: "wallet" | "external";
  queryState: "stopped" | "running";
  conclusion?: P2pkhInputConclusion;
  error?: string;
  retryable?: boolean;
  signingState?: "unknown";
  heldInputs?: string[];
  heldSats?: string;
}
export interface P2pkhConclusionResult { items: P2pkhConclusionRow[]; }
export interface P2pkhPaymentLookupInput { ownerPublicKeyHex: string; network: "main" | "test"; paymentId: string; }
export interface P2pkhPaymentLookupResult {
  status: "not_found" | "not_signed" | "pending" | "signed_not_dispatched" | "unknown" | "accepted" | "failed";
  allocationId?: string;
  txid?: string;
  conclusion?: P2pkhInputConclusion;
}

/** Public projection, not validation: never expose exact bytes or signatures. */
function projectInputConclusion(value: P2pkhInputConclusion): P2pkhInputConclusion {
  const { status, reason, releasedSats } = value;
  return { status, reason, releasedSats,
    releasedInputs: [...value.releasedInputs], heldInputs: [...value.heldInputs],
    spentInputs: value.spentInputs.map(({ outpoint, txid, vin, confirmed }) => ({ outpoint, txid, vin, confirmed })),
  };
}

/** Copy only the wallet-owner view; internal facts need no runtime revalidation. */
export function projectP2pkhConclusionResult(value: P2pkhConclusionResult): P2pkhConclusionResult {
  return { items: value.items.map(row => ({
    allocationId: row.allocationId, txid: row.txid, state: row.state, delivery: row.delivery, queryState: row.queryState,
    ...(row.error === undefined ? {} : { error: row.error }),
    ...(row.retryable === undefined ? {} : { retryable: row.retryable }),
    ...(row.signingState === undefined ? {} : { signingState: row.signingState,
      heldInputs: row.heldInputs === undefined ? undefined : [...row.heldInputs], heldSats: row.heldSats }),
    ...(row.conclusion === undefined ? {} : { conclusion: projectInputConclusion(row.conclusion) }),
  })) };
}

/** Read-only application view; absent/unsigned payments have no exact facts. */
export function projectP2pkhPaymentLookupResult(value: P2pkhPaymentLookupResult): P2pkhPaymentLookupResult {
  if (value.status === "not_found") return { status: value.status };
  if (value.status === "not_signed") return { status: value.status, allocationId: value.allocationId };
  return { status: value.status, allocationId: value.allocationId,
    ...(value.txid === undefined ? {} : { txid: value.txid }),
    ...(value.conclusion === undefined ? {} : { conclusion: projectInputConclusion(value.conclusion) }),
  };
}
