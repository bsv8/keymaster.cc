import type { BorrowedModuleFileStore, P2pkhConclusionRow, P2pkhPaymentLookupResult } from "@keymaster/contracts";
import { buildUnsigned, estimateFeeSats, estimateSignedSize, formatAmount, FundingKernel, parseTx, submitSigned, submitProtocolSigned, completeProtocolIntent, prepareProtocolIntent, buildPaymentTemplate, validatePaymentTemplate, type AllocationView, type BroadcastOutcome, type DurableStore, type ManagerConfig, type PaymentOutputRole, type PaymentType, type Scope, type SnapshotUtxo, type InputObservation, type SubmitResult, retryExact as retryManagerExact, reconcileInputs as reconcileManagerInputs } from "@keymaster/utxo-manager";
import { p2pkhAddressToScriptHex } from "./p2pkhTransactionParser.js";
import type { P2pkhKeyResource, P2pkhUtxo } from "./p2pkhContracts.js";
export interface ProtocolExecutionIdentity { executionId: string; allocationId: string; submissionId: string; }
export interface ProtocolExecutionProof extends ProtocolExecutionIdentity {
  owner: string; network: "main" | "test"; unsignedTxHex: string;
  state: "authorized" | "signing_started" | "signed_partial" | "signed_complete" | "cancelled_before_sign";
  version: number; signedTxHex?: string;
}
import { createWorkerProtocolEvidence } from "./workerProtocolEvidence.js";

function pathFor(network: "main" | "test"): string { return `utxo-manager/p2pkh-${network}-state.json`; }
const SCHEMA = "keymaster.p2pkh-utxo-manager/2";
const LEGACY_SCHEMA = "keymaster.p2pkh-utxo-manager/1";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const recoveredScopes = new WeakMap<object, Set<string>>();

/** The scope has no manager state yet: nothing is outstanding. */
export class P2pkhManagerStateMissingError extends Error {
  constructor(message = "P2PKH UTXO manager state is missing") {
    super(message);
    this.name = "P2pkhManagerStateMissingError";
  }
}

/**
 * The manager state exists but cannot be trusted (corrupt JSON, schema or
 * scope mismatch, unreadable storage). Reporting "no responsibility" here
 * would hide outstanding funds, so the caller must see the failure.
 */
export class P2pkhManagerStateUnreadableError extends Error {
  readonly reason: string;
  constructor(reason: string, message?: string) {
    super(message ?? `P2PKH UTXO manager state is unreadable: ${reason}`);
    this.name = "P2pkhManagerStateUnreadableError";
    this.reason = reason;
  }
}

type PersistedAllocationKind = "payment" | "legacy" | "protocol";
interface PersistedPaymentPlan {
  allocationId: string;
  paymentId?: string;
  planDigest?: string;
  paymentType: PaymentType;
  businessAmountSats: string;
  businessScriptHex: string;
  changeScriptHex: string | null;
  changeAmountSats: string;
  outputs: Array<{ vout: number; scriptHex: string; valueSats: string; role: PaymentOutputRole }>;
}
interface PersistedManagerState {
  schema: string;
  owner: string;
  network: "main" | "test";
  kernel: string;
  snapshotRevision: number;
  /** Provider-reported mempool spends; only an explicit unspent observation clears them. */
  mempoolSpent?: string[];
  /** False until the trusted BitFS business path verifies Kind 3. */
  businessDispatch?: Record<string, boolean>;
  cancelledDispatch?: Record<string, string>;
  protocolExecutions?: Record<string, { executionId: string; submissionId: string; unsignedTxHex: string; released?: boolean }>;
  intents: Record<string, string>;
  results: Record<string, string>;
  /**
   * Q04：交付 artifact 的稳定身份。键是 artifactId，值与冻结意图的内容
   * 摘要绑定；同内容重放返回原 allocation，同 ID 不同内容明确冲突。
   */
  artifacts?: Record<string, { allocationId: string; content: string; phase: string }>;
  /**
   * CV1 payment role plans frozen by `reserve` before any signature. The
   * signing path reads this durable plan, never a page-supplied plan, and
   * re-parses the real raw transaction against it.
   *
   * `allocationKinds` is mandatory in schema v2: a missing/corrupt kind or
   * plan must fail closed, not fall back to the legacy set-matching path.
   */
  payments?: Record<string, PersistedPaymentPlan>;
  allocationKinds?: Record<string, PersistedAllocationKind>;
  /** Ack-retry tombstone: paymentId -> planDigest already released by manager. */
  releasedPayments?: Record<string, string>;
}

interface LoadedState {
  path: string;
  kernel: FundingKernel;
  value: PersistedManagerState;
  revision?: string;
}

export interface P2pkhManagerInputEvidence {
  utxo: P2pkhUtxo;
  /** Exact parent bytes from the durable manager outbox for locally created outputs. */
  previousTransactionHex?: string;
}

export interface P2pkhManagerReservation {
  allocationId: string;
  unsignedTxHex: string;
  businessSats: string;
  feeSats: string;
  changeSats: string;
  totalInSats: string;
  selectedOutpoints: string[];
  selectedInputs: P2pkhManagerInputEvidence[];
  /** Exact v1 output roles frozen before signing (vout + script + value + role). */
  outputs: Array<{ vout: number; scriptHex: string; valueSats: string; role: PaymentOutputRole }>;
  businessScriptHex: string;
  changeScriptHex: string | null;
  planDigest?: string;
}

export interface P2pkhManagerResponsibility {
  commandId: string;
  allocationId: string | null;
  txid: string;
  state: string;
  delivery: string;
  reason: string;
  inputs: string[];
  totalInSats: string;
  ownOutputs: Array<{ outpoint: string; value: string }>;
}

export interface P2pkhManagerReconcileReport {
  /** Exact transactions now observed and settled. */
  committed: string[];
  /** Transactions the chain does not show (yet): responsibility kept. */
  unobserved: string[];
  /** Transactions that could not be checked at all. */
  unobservable: string[];
}

export interface P2pkhProtocolIntentInput {
  ownerPublicKeyHex: string;
  resource: Pick<P2pkhKeyResource, "resourceId" | "network" | "address">;
  binding: { kind: "refund" | "close" | "fund" | "state"; poolId: string };
  unsignedTxHex: string;
  /** Classified actual inputs of the transaction, in transaction order. */
  inputs: Array<{ outpoint: string; class: "wallet" | "protected" | "external"; value: string; scriptHex: string; claimId: string | null }>;
  /** Declared non-self outputs the business authorized. */
  outputs: Array<{ scriptHex: string; value: string }>;
  businessAmountSats: string;
  feeRateSatPerKb: string;
  feeCapSats: string;
  feePolicy: "rate" | "exact";
  /** Current WoC-derived spendable UTXOs, used to refresh the Manager facts. */
  utxos: readonly P2pkhUtxo[];
  /** Trusted prevout evidence for external inputs. */
  externalProofs?: Record<string, { value: string; scriptHex: string }>;
  /**
   * Protection sources this intent takes over (a protocol submission's own
   * input claim). Every other source keeps blocking the input.
   */
  claims?: string[];
  /**
   * Q04: stable identity of a delivered artifact. When present, replaying the
   * same content returns the original allocation instead of occupying again.
   */
  artifactId?: string;
  deferDispatch?: boolean;
  executionId?: string;
}

export interface P2pkhUtxoManager {
  /** The only ingestion point for complete, validated chain observations. */
  observe(input: { ownerPublicKeyHex: string; resource: Pick<P2pkhKeyResource, "resourceId" | "network" | "address">; utxos: readonly P2pkhUtxo[] }): Promise<void>;
  /** Cancel dispatch without assuming signatures are releasable. */
  cancelProtocolSubmission(input: { ownerPublicKeyHex: string; network: "main" | "test"; submissionId: string; allocationId?: string; txid?: string; reason?: "cancelled" | "execution-failed"; proof?: ProtocolExecutionProof | null }): Promise<void>;
  /** 退役硬删除（仅限已确认的论坛范围清理调用）。按 submission 精确删除协议责任及索引，不改变普通取消/unknown/BitFS 语义，不放宽公共取消条件。 */
  retireForumProtocolSubmission(input: { ownerPublicKeyHex: string; network: "main" | "test"; submissionId: string }): Promise<{ deleted: boolean; allocationId?: string }>;
  recoverProtocolExecution(input: { ownerPublicKeyHex: string; network: "main" | "test"; proof: ProtocolExecutionProof }): Promise<boolean>;
  protocolExecutionIdentity(input: { ownerPublicKeyHex: string; network: "main" | "test"; allocationId: string }): Promise<{ executionId: string; submissionId: string } | null>;
  ownsWalletExact(input: { ownerPublicKeyHex: string; network: "main" | "test"; txid: string; rawTxHex: string }): Promise<boolean>;
  /** Manager-owned parent evidence for business classification; no membership polling. */
  previousTransaction(input: { ownerPublicKeyHex: string; network: "main" | "test"; txid: string }): Promise<string | null>;
  /** Trusted business adapter only; binds permission to the original durable exact. */
  allowBusinessDispatch(input: { ownerPublicKeyHex: string; network: "main" | "test"; allocationId: string; rawTxHex: string }): Promise<void>;
  /** Trusted pool/business receipt: project returned wallet outputs without a new approval. */
  observeAcceptedExact(input: { ownerPublicKeyHex: string; resource: Pick<P2pkhKeyResource, "resourceId" | "network" | "address">; rawTxHex: string }): Promise<void>;
  /** Manager-owned spendable projection, including accepted local change. */
  available(input: { ownerPublicKeyHex: string; resource: Pick<P2pkhKeyResource, "resourceId" | "network" | "address"> }): Promise<{ observed: boolean; inputs: P2pkhManagerInputEvidence[] }>;
  /** Read-only core planning. The protocol intent must still durably claim these
   * inputs before signing; a concurrent reservation may invalidate this plan. */
  selectProtocolFunding(input: {
    ownerPublicKeyHex: string;
    resource: Pick<P2pkhKeyResource, "resourceId" | "network" | "address">;
    utxos: readonly P2pkhUtxo[];
    amountSatoshis: number;
    feeRateSatoshisPerKb: number;
    outputs?: Array<{ scriptHex: string; value: string }>;
  }): Promise<{ selectedInputs: P2pkhManagerInputEvidence[]; totalInputSatoshis: number }>;
  reserve(input: {
    ownerPublicKeyHex: string;
    resource: P2pkhKeyResource;
    utxos: readonly P2pkhUtxo[];
    feeRateSatoshisPerKb: number;
    /** Legacy P2PKH recipient. Kept for the existing ordinary transfer path. */
    recipientAddress?: string;
    /** Exact v1 business output script; required when recipientAddress is absent. */
    recipientScriptHex?: string;
    /** v1 payment scheme. Defaults to P2PKH for the legacy address path. */
    paymentType?: PaymentType;
    /** Stable Connect payment identity, bound into the cancellation proof. */
    paymentId?: string;
    amountSatoshis: number;
    sendAll: boolean;
  }): Promise<P2pkhManagerReservation>;
  /** Refresh Manager facts/protections, then return the exact held inputs and local parent bytes. */
  refreshAllocationInputs(input: {
    ownerPublicKeyHex: string;
    resource: Pick<P2pkhKeyResource, "resourceId" | "network" | "address">;
    allocationId: string;
    utxos: readonly P2pkhUtxo[];
  }): Promise<P2pkhManagerInputEvidence[]>;
  prepareSigning(input: { ownerPublicKeyHex: string; resource: Pick<P2pkhKeyResource, "resourceId" | "network" | "address">; allocationId: string; unsignedTxHex: string }): Promise<void>;
  release(input: { ownerPublicKeyHex: string; network: "main" | "test"; allocationId: string }): Promise<void>;
  submitSigned(input: {
    ownerPublicKeyHex: string;
    resource: Pick<P2pkhKeyResource, "resourceId" | "network" | "address">;
    allocationId: string;
    signedTxHex: string;
    broadcast(rawTxHex: string, txid: string): Promise<BroadcastOutcome>;
  }): Promise<{ txid: string; delivery: "accepted" | "already-known" | "unknown" | "failed" }>;
  /** Read-only wallet-owner view. No raw bytes or signatures cross RPC. */
  listConclusions(input: { ownerPublicKeyHex: string; network: "main" | "test" }): Promise<P2pkhConclusionRow[]>;
  /** Host wrappers of the SAME generic manager APIs; no new signing or selection. */
  reconcileInputs(input: { ownerPublicKeyHex: string; network: "main" | "test"; allocationId: string }): Promise<SubmitResult>;
  retryExact(input: { ownerPublicKeyHex: string; network: "main" | "test"; allocationId: string; broadcast(rawTxHex: string, txid: string): Promise<BroadcastOutcome> }): Promise<SubmitResult>;
  /**
   * D05: settle outstanding exact transactions against the chain. Only a
   * trusted observation of the SAME exact transaction releases the inputs and
   * enables its self outputs; an unobserved or unobservable transaction keeps
   * its responsibility. Never re-selects coins and never builds a
   * replacement transaction.
   */
  reconcile(input: {
    ownerPublicKeyHex: string;
    network: "main" | "test";
    observe?(txid: string): Promise<string | null>;
  }): Promise<P2pkhManagerReconcileReport>;
  /** Read-only reconciliation of protocol payment identity to manager/outbox. */
  paymentStatus(input: { ownerPublicKeyHex: string; network: "main" | "test"; paymentId: string }): Promise<P2pkhPaymentLookupResult>;
  /** Host-only takeover of VERIFIED Vault journal exacts, without signing or dispatch.
   * Uses existing common kernel completion primitives; ACK only after durable save. */
  recoverSignedPayments(input: {
    ownerPublicKeyHex: string; network: "main" | "test";
    proofs: Array<{ paymentId: string; planDigest: string; version: number; state: "signed_complete" | "quarantined"; signedTxHex?: string }>;
  }): Promise<Array<{ paymentId: string; allocationId: string; txid: string }>>;
  /**
   * Release a payment allocation only with a Vault execution proof that no
   * signature was ever started. The proof binds paymentId/allocationId/
   * planDigest/version; a missing or mismatched proof is rejected.
   */
  cancelPayment(input: {
    ownerPublicKeyHex: string;
    network: "main" | "test";
    allocationId: string;
    proof: { paymentId: string; allocationId: string; planDigest: string; version: number; state: "cancelled_before_sign" };
  }): Promise<void>;
  /**
   * Startup recovery for Connect payments whose Vault journal proves no
   * signature ever started. Matches proofs by paymentId + planDigest; never
   * releases a plan that is signed, missing, or has a different digest.
   */
  recoverCancelledPayments(input: {
    ownerPublicKeyHex: string;
    network: "main" | "test";
    proofs: ReadonlyArray<{ paymentId: string; planDigest: string; version: number; state: "cancelled_before_sign" }>;
  }): Promise<Array<{ allocationId: string; paymentId: string }>>;
  /** E04: report the outstanding money responsibilities of this scope. */
  responsibilities(input: { ownerPublicKeyHex: string; network: "main" | "test" }): Promise<P2pkhManagerResponsibility[]>;
  /**
   * P6-c: freeze a protocol-bound unsigned transaction durably BEFORE any
   * signer runs. The manager takes exclusive responsibility for the wallet
   * and protected inputs and caps the miner fee.
   */
  beginProtocolIntent(input: P2pkhProtocolIntentInput): Promise<{ allocationId: string }>;
  /**
   * P6-c: persist the exact signed bytes of a protocol intent. "wallet" means
   * this wallet's provider will broadcast them; "external" means the bytes
   * leave the wallet and the entry keeps its responsibility until a trusted
   * observation settles it.
   */
  completeProtocolIntent(input: {
    ownerPublicKeyHex: string;
    resource: Pick<P2pkhKeyResource, "resourceId" | "network" | "address">;
    allocationId: string;
    signedTxHex: string;
    delivery: "wallet" | "external";
  }): Promise<{ txid: string; feeSats: string }>;
  /**
   * Prove that a protocol-protected input was claimed through the manager
   * (not by a caller flag): the frozen intent must bind the same exact
   * transaction and the same inputs, with a protocol claim on every
   * protected input.
   */
  protocolIntentProof(input: {
    ownerPublicKeyHex: string;
    network: "main" | "test";
    allocationId: string;
    txid: string;
    inputOutpointKeys: readonly string[];
  }): Promise<{ ok: boolean; protectedInputs: string[] }>;
}

function configFor(resource: Pick<P2pkhKeyResource, "address" | "network">): ManagerConfig {
  return {
    walletScriptHex: p2pkhAddressToScriptHex(resource.address, resource.network),
    dustThresholdSats: "1",
    maxUnconfirmedAncestors: 32,
  };
}

function emptyState(owner: string, network: "main" | "test", config: ManagerConfig): LoadedState {
  const scope: Scope = { owner: owner.toLowerCase(), network };
  const kernel = new FundingKernel(scope, config);
  return {
    path: pathFor(network),
    kernel,
    value: { schema: SCHEMA, owner: scope.owner, network, kernel: kernel.serialize(), snapshotRevision: 0, intents: {}, results: {}, payments: {}, allocationKinds: {} },
  };
}


function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function kernelAllocationStates(kernel: FundingKernel): Record<string, string> {
  const serialized = JSON.parse(kernel.serialize()) as { allocations?: Record<string, { state?: unknown }> };
  const states: Record<string, string> = {};
  for (const [id, record] of Object.entries(serialized.allocations ?? {})) {
    states[id] = typeof record.state === "string" ? record.state : "held";
  }
  return states;
}

function validatePersistedPaymentPlan(
  value: unknown,
  allocationId: string,
  walletScriptHex: string,
): PersistedPaymentPlan {
  if (!isPlainRecord(value)) throw new Error(`Payment plan for ${allocationId} is missing or malformed`);
  if (value.allocationId !== allocationId) throw new Error(`Payment plan ${allocationId} has a different allocationId`);
  if (value.paymentType !== "p2pkh" && value.paymentType !== "p2pk") throw new Error(`Payment plan ${allocationId} has an unsupported paymentType`);
  if (typeof value.businessAmountSats !== "string" || typeof value.businessScriptHex !== "string"
    || typeof value.changeAmountSats !== "string" || (value.changeScriptHex !== null && typeof value.changeScriptHex !== "string")) {
    throw new Error(`Payment plan ${allocationId} has malformed fields`);
  }
  const expected = buildPaymentTemplate({
    paymentType: value.paymentType,
    businessAmountSats: value.businessAmountSats,
    businessScriptHex: value.businessScriptHex,
    changeScriptHex: value.changeScriptHex,
    changeAmountSats: value.changeAmountSats,
  });
  if (expected.some((row) => row.role === "change") && value.changeScriptHex !== walletScriptHex) {
    throw new Error(`Payment plan ${allocationId} change is not the wallet P2PKH script`);
  }
  if (!Array.isArray(value.outputs) || value.outputs.length !== expected.length) {
    throw new Error(`Payment plan ${allocationId} role map length does not match its template`);
  }
  const actual = value.outputs.map((row) => {
    if (!isPlainRecord(row)
      || typeof row.vout !== "number" || !Number.isSafeInteger(row.vout) || row.vout < 0
      || typeof row.scriptHex !== "string" || typeof row.valueSats !== "string"
      || (row.role !== "business" && row.role !== "change")) {
      throw new Error(`Payment plan ${allocationId} has a malformed role row`);
    }
    return { vout: row.vout, scriptHex: row.scriptHex.toLowerCase(), valueSats: row.valueSats, role: row.role };
  });
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Payment plan ${allocationId} role map does not match its template`);
  }
  const normalized: PersistedPaymentPlan = {
    allocationId,
    ...(typeof value.paymentId === "string" ? { paymentId: value.paymentId } : {}),
    paymentType: value.paymentType,
    businessAmountSats: value.businessAmountSats,
    businessScriptHex: value.businessScriptHex,
    changeScriptHex: value.changeScriptHex,
    changeAmountSats: value.changeAmountSats,
    outputs: expected,
  };
  const digest = paymentPlanDigest(normalized);
  if (value.planDigest !== undefined && value.planDigest !== digest) {
    throw new Error(`Payment plan ${allocationId} digest does not match its facts`);
  }
  normalized.planDigest = digest;
  return normalized;
}

function normalizePaymentState(value: PersistedManagerState, kernel: FundingKernel): void {
  if (value.cancelledDispatch !== undefined && (!isPlainRecord(value.cancelledDispatch) || Object.values(value.cancelledDispatch).some(v => typeof v !== "string"))) throw new Error("Invalid cancellation state");
  if (value.protocolExecutions !== undefined && (!isPlainRecord(value.protocolExecutions) || Object.entries(value.protocolExecutions).some(([id, v]) => !isPlainRecord(v) || typeof v.executionId !== "string" || typeof v.submissionId !== "string" || typeof v.unsignedTxHex !== "string" || (v.released !== undefined && typeof v.released !== "boolean") || (!v.released && kernel.signingIntent(id).unsignedTxHex !== v.unsignedTxHex)))) throw new Error("Invalid protocol execution state");
  if (value.businessDispatch !== undefined && (!isPlainRecord(value.businessDispatch) || Object.values(value.businessDispatch).some(flag => typeof flag !== "boolean"))) throw new Error("Invalid business dispatch gate state");
  const states = kernelAllocationStates(kernel);
  const legacyPayments = value.payments === undefined ? {} : value.payments;
  const existingKinds = value.allocationKinds === undefined ? {} : value.allocationKinds;
  const releasedPayments = value.releasedPayments === undefined ? {} : value.releasedPayments;
  if (value.schema !== SCHEMA && value.schema !== LEGACY_SCHEMA) {
    throw new Error(`P2PKH UTXO manager state has an unsupported schema: ${String(value.schema)}`);
  }
  if (!isPlainRecord(legacyPayments)) throw new Error("P2PKH UTXO manager payments map is malformed");
  if (!isPlainRecord(existingKinds)) throw new Error("P2PKH UTXO manager allocationKinds map is malformed");
  if (!isPlainRecord(releasedPayments)) throw new Error("P2PKH UTXO manager releasedPayments map is malformed");
  if (value.schema === SCHEMA) {
    if (value.payments === undefined || value.allocationKinds === undefined) {
      throw new Error("P2PKH UTXO manager schema v2 is missing payment metadata; refusing to sign");
    }
  }
  const kinds: Record<string, PersistedAllocationKind> = {};
  for (const [id, state] of Object.entries(states)) {
    const held = state === "held";
    const candidate = existingKinds[id];
    if (candidate !== undefined && candidate !== "payment" && candidate !== "legacy" && candidate !== "protocol") {
      throw new Error(`P2PKH UTXO manager allocation ${id} has an invalid kind`);
    }
    if (held) {
      if (value.schema === SCHEMA && candidate === undefined) {
        throw new Error(`P2PKH UTXO manager allocation ${id} is missing its allocation kind; refusing to sign`);
      }
      kinds[id] = candidate ?? (legacyPayments[id] ? "payment" : "legacy");
    } else if (candidate !== undefined) {
      kinds[id] = candidate;
    }
  }
  const plans: Record<string, PersistedPaymentPlan> = {};
  for (const [id, plan] of Object.entries(legacyPayments)) {
    const state = states[id];
    if (state === undefined) continue;
    const held = state === "held";
    if (kinds[id] !== "payment") {
      if (held) throw new Error(`P2PKH UTXO manager allocation ${id} has a plan but is not a payment allocation`);
      continue;
    }
    plans[id] = validatePersistedPaymentPlan(plan, id, kernel.config.walletScriptHex);
  }
  for (const [id, state] of Object.entries(states)) {
    if (state !== "held" || kinds[id] !== "payment") continue;
    if (!plans[id]) throw new Error(`P2PKH UTXO manager payment allocation ${id} is missing its frozen plan; refusing to sign`);
  }
  value.schema = SCHEMA;
  value.payments = plans;
  value.allocationKinds = kinds;
  value.releasedPayments = releasedPayments;
}

async function readState(files: BorrowedModuleFileStore, owner: string, resource: Pick<P2pkhKeyResource, "resourceId" | "network" | "address">): Promise<LoadedState> {
  const network = resource.network;
  const expectedOwner = owner.toLowerCase();
  const config = configFor(resource);
  const statePath = pathFor(network);
  const object = await files.get(statePath);
  if (!object) {
    markRecovered(files, expectedOwner, network);
    return emptyState(expectedOwner, network, config);
  }
  let value: PersistedManagerState;
  try { value = JSON.parse(decoder.decode(object.bytes)) as PersistedManagerState; }
  catch { throw new Error("P2PKH UTXO manager state is corrupt; refusing to spend"); }
  if (!value || (value.schema !== SCHEMA && value.schema !== LEGACY_SCHEMA) || value.owner !== expectedOwner || value.network !== network
      || typeof value.kernel !== "string" || !Number.isSafeInteger(value.snapshotRevision) || value.snapshotRevision < 0
      || !isPlainRecord(value.intents) || !isPlainRecord(value.results)) {
    throw new Error("P2PKH UTXO manager state scope/schema mismatch; refusing to spend");
  }
  let kernel: FundingKernel;
  try { kernel = FundingKernel.restore(value.kernel, { owner: expectedOwner, network }); }
  catch (error) { throw new Error(`P2PKH UTXO manager state cannot be restored: ${error instanceof Error ? error.message : String(error)}`); }
  if (kernel.config.walletScriptHex !== config.walletScriptHex) throw new Error("P2PKH wallet script changed; UTXO manager state needs recovery");
  normalizePaymentState(value, kernel);
  const state = { path: statePath, kernel, value, revision: object.revision };
  await recoverPendingAllocations(files, state);
  return state;
}

function markRecovered(files: BorrowedModuleFileStore, owner: string, network: "main" | "test"): void {
  let scopes = recoveredScopes.get(files);
  if (!scopes) { scopes = new Set(); recoveredScopes.set(files, scopes); }
  scopes.add(`${owner.toLowerCase()}:${network}`);
}

async function recoverPendingAllocations(files: BorrowedModuleFileStore, state: LoadedState): Promise<void> {
  let scopes = recoveredScopes.get(files);
  if (!scopes) { scopes = new Set(); recoveredScopes.set(files, scopes); }
  const key = `${state.value.owner}:${state.value.network}`;
  if (scopes.has(key)) return;
  scopes.add(key);
  try {
    const candidate = state.kernel.clone();
    const dropped = candidate.dropPending();
    if (dropped.length > 0) {
      const payments = { ...(state.value.payments ?? {}) };
      const allocationKinds = { ...(state.value.allocationKinds ?? {}) };
      for (const id of dropped) {
        delete payments[id];
        delete allocationKinds[id];
      }
      state.value = { ...state.value, payments, allocationKinds };
      await persist(files, state, candidate);
    }
  } catch (error) {
    scopes.delete(key);
    throw error;
  }
}

async function persist(files: BorrowedModuleFileStore, state: LoadedState, kernel: FundingKernel): Promise<void> {
  const value = { ...state.value, kernel: kernel.serialize() };
  const bytes = encoder.encode(JSON.stringify(value));
  const saved = await files.put(state.path, bytes, state.revision === undefined ? { ifNoneMatch: true } : { ifRevision: state.revision });
  state.value = value;
  state.revision = saved.revision;
  state.kernel = kernel;
}

function mapReservation(view: AllocationView, unsignedTxHex: string, selectedInputs: P2pkhManagerInputEvidence[]): Omit<P2pkhManagerReservation, "outputs" | "businessScriptHex" | "changeScriptHex"> {
  return {
    allocationId: view.allocationId,
    unsignedTxHex,
    businessSats: view.businessSats,
    feeSats: view.feeSats,
    changeSats: view.changeSats,
    totalInSats: view.totalInSats,
    selectedOutpoints: [...view.inputs],
    selectedInputs,
  };
}

function evidenceContext(kernel: FundingKernel) {
  const heights = (JSON.parse(kernel.serialize()) as { utxos: Record<string, { height: number }> }).utxos;
  const parents = new Map(kernel.outboxView().filter(row => row.state === "done").map(row => [row.txid, row]));
  return { heights, parents, parsed: new Map<string, ReturnType<typeof parseTx>>() };
}
function managerInputsEvidence(kernel: FundingKernel, keys: string[], owner: string, resource: Pick<P2pkhKeyResource, "resourceId" | "network" | "address">) {
  const context = evidenceContext(kernel);
  return keys.map(key => managerInputEvidence(kernel, key, owner, resource, context));
}
function managerInputEvidence(
  kernel: FundingKernel,
  outpoint: string,
  owner: string,
  resource: Pick<P2pkhKeyResource, "resourceId" | "network" | "address">,
  context = evidenceContext(kernel),
): P2pkhManagerInputEvidence {
  const row = kernel.lookup(outpoint);
  if (row.spentBy || row.protected || row.isolated || row.pendingParent || row.scriptHex !== p2pkhAddressToScriptHex(resource.address, resource.network)) {
    throw new Error(`UTXO manager input is no longer spendable: ${outpoint}`);
  }
  const [txid, voutText] = outpoint.toLowerCase().split(":");
  const vout = Number(voutText);
  const value = Number(row.value);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`UTXO manager input value is invalid: ${outpoint}`);
  const utxo: P2pkhUtxo = {
    id: outpoint.toLowerCase(), resourceId: resource.resourceId, publicKeyHex: owner,
    network: resource.network, address: resource.address, txid: txid!, vout, value,
    height: context.heights[outpoint]?.height ?? 0, script: row.scriptHex, status: row.status as "confirmed" | "unconfirmed",
    isSpentInMempoolTx: false, syncedAt: new Date(0).toISOString(),
  };
  // Parent evidence follows the dependency (creatingTxid), not provenance.
  // A WoC-observed output merged with a done exact must not be forced back to
  // a WoC raw-transaction read.
  if (!row.creatingTxid) {
    if (row.source === "local") throw new Error(`Local UTXO has no recorded parent transaction: ${outpoint}`);
    return { utxo };
  }
  const parent = context.parents.get(row.creatingTxid);
  if (!parent) {
    if (row.source === "local") throw new Error(`Local UTXO parent bytes are unavailable: ${outpoint}`);
    return { utxo };
  }
  let parsed = context.parsed.get(parent.txid);
  if (!parsed) { parsed = parseTx(parent.rawTxHex, parent.txid); context.parsed.set(parent.txid, parsed); }
  const output = parsed.outputs[vout];
  if (!output || formatAmount(output.value) !== row.value || output.scriptHex !== row.scriptHex) {
    throw new Error(`UTXO parent output does not match Manager facts: ${outpoint}`);
  }
  return { utxo, previousTransactionHex: parent.rawTxHex };
}

function snapshotUtxosFor(resource: Pick<P2pkhKeyResource, "address" | "network">, utxos: readonly P2pkhUtxo[]): SnapshotUtxo[] {
  return utxos.map((row) => ({
    txid: row.txid, vout: row.vout, value: String(row.value),
    scriptHex: row.script ?? p2pkhAddressToScriptHex(resource.address, resource.network),
    status: row.status, height: row.height ?? 0,
  }));
}

async function refreshCandidate(input: {
  files: BorrowedModuleFileStore;
  state: LoadedState;
  owner: string;
  resource: Pick<P2pkhKeyResource, "resourceId" | "network" | "address">;
  utxos: readonly P2pkhUtxo[];
  listProtectedOutpoints?: (owner: string, network: "main" | "test") => Promise<readonly { txid: string; vout: number; kind?: string; source?: string; submissionId?: string }[]>;
}): Promise<{ candidate: FundingKernel; revision: number }> {
  const candidate = input.state.kernel.clone();
  // Selection never re-ingests a host projection as a chain snapshot. Only
  // observe() may advance chain facts; otherwise occupied/local/unknown facts
  // could be erased by feeding a filtered spendable list back into the core.
  const revision = input.state.value.snapshotRevision;
  candidate.setProtected(candidate.protectedOutpointKeys(), false);
  const protectedOutpoints = await input.listProtectedOutpoints?.(input.owner, input.resource.network) ?? [];
  // Every protection is kept, with its source. A protocol submission's own
  // input claim is an occupation, not a fund protection: it must not be
  // dropped here, because a claim this manager has not taken over still
  // commits the input to a signed transaction. The manager takes over its own
  // claim explicitly, by naming it in the protocol intent.
  const bySource = new Map<string, string[]>();
  for (const row of protectedOutpoints) {
    const key = `${row.txid.toLowerCase()}:${row.vout}`;
    const source = row.source ?? (row.kind === "protocol-claim" ? "protocol-claim" : row.kind ?? "protection");
    const list = bySource.get(source) ?? [];
    list.push(key);
    bySource.set(source, list);
  }
  for (const [source, keys] of bySource) {
    candidate.setProtected([...new Set(keys)], true, source);
  }
  const mempoolSpent = input.state.value.mempoolSpent ?? [];
  if (!Array.isArray(mempoolSpent) || mempoolSpent.some(key => typeof key !== "string" || !/^[0-9a-f]{64}:\d+$/.test(key))) throw new Error("Invalid manager mempool observation state");
  candidate.setProtected(mempoolSpent, true, "chain:mempool-spent");
  return { candidate, revision };
}


function paymentPlanForAllocation(
  state: LoadedState,
  allocationId: string,
): PersistedPaymentPlan | null {
  const kind = state.value.allocationKinds?.[allocationId];
  if (kind === "legacy" || kind === "protocol") return null;
  if (kind !== "payment") {
    throw new Error(`UTXO manager allocation ${allocationId} has no payment kind; refusing to sign`);
  }
  const plan = state.value.payments?.[allocationId];
  if (!plan) {
    throw new Error(`UTXO manager payment allocation ${allocationId} has no frozen plan; refusing to sign`);
  }
  return plan;
}

function paymentPlanDigest(plan: PersistedPaymentPlan): string {
  return JSON.stringify({
    allocationId: plan.allocationId,
    paymentId: plan.paymentId ?? null,
    paymentType: plan.paymentType,
    businessAmountSats: plan.businessAmountSats,
    businessScriptHex: plan.businessScriptHex,
    changeScriptHex: plan.changeScriptHex,
    changeAmountSats: plan.changeAmountSats,
    outputs: plan.outputs,
  });
}

function assertFrozenPaymentTransaction(input: {
  kernel: FundingKernel;
  allocationId: string;
  rawTxHex: string;
  plan: NonNullable<PersistedManagerState["payments"]>[string];
  allowTerminal?: boolean;
}): void {
  const parsed = parseTx(input.rawTxHex);
  const allocation = input.kernel.allocationView(input.allocationId);
  if (allocation.state !== "held" && !input.allowTerminal) throw new Error(`UTXO manager allocation is not held: ${allocation.state}`);
  const actualInputs = parsed.inputs.map((row) => `${row.txid}:${row.vout}`);
  if (actualInputs.length !== allocation.inputs.length
    || actualInputs.some((key, index) => key !== allocation.inputs[index]?.toLowerCase())) {
    throw new Error("Frozen payment transaction inputs do not match the allocation");
  }
  const prevouts = allocation.inputs.map((key) => {
    const row = input.kernel.lookup(key);
    return { scriptHex: row.scriptHex, valueSats: row.value };
  });
  const outputs = parsed.outputs.map((row, vout) => ({
    vout, scriptHex: row.scriptHex, valueSats: formatAmount(row.value),
  }));
  const checked = validatePaymentTemplate({
    plan: {
      paymentType: input.plan.paymentType,
      businessAmountSats: input.plan.businessAmountSats,
      businessScriptHex: input.plan.businessScriptHex,
      changeScriptHex: input.plan.changeScriptHex,
      changeAmountSats: input.plan.changeAmountSats,
    },
    prevouts,
    outputs,
  });
  if (checked.businessSats !== allocation.businessSats
    || checked.changeSats !== allocation.changeSats
    || checked.feeSats !== allocation.feeSats) {
    throw new Error("Frozen payment transaction facts do not match the allocation");
  }
}

function bitfsFundingTemplate(unsignedTxHex: string): boolean {
  const script = parseTx(unsignedTxHex).outputs[0]?.scriptHex;
  return !!script && script.length === 210 && script.startsWith("52") && script.endsWith("53ae");
}
function assertDispatchAllowed(state: LoadedState, allocationId: string) {
  if (state.value.cancelledDispatch?.[allocationId]) throw new Error("Protocol dispatch cancelled; signature responsibility retained");
  if (state.value.businessDispatch?.[allocationId] === false) throw new Error("Business dispatch awaits verified Kind 3");
}
function verifyExecution(state: LoadedState, allocationId: string, proof: ProtocolExecutionProof) {
  const execution = state.value.protocolExecutions?.[allocationId];
  if (!execution || proof.owner.toLowerCase() !== state.value.owner || proof.network !== state.value.network || proof.allocationId !== allocationId || proof.executionId !== execution.executionId || proof.submissionId !== execution.submissionId || proof.unsignedTxHex !== execution.unsignedTxHex) throw new Error("Protocol execution proof does not match durable intent");
  return execution;
}
export function createP2pkhUtxoManager(input: {
  files: BorrowedModuleFileStore;
  /**
   * The protected outputs of this scope, each with the source that protects
   * it. A source of "protocol-claim:<submissionId>" is the input occupation a
   * protocol submission created for itself; a dedicated funding record or
   * another plugin is a real fund protection. The sources are kept apart so
   * that taking over one's own claim never drops somebody else's protection
   * on the same outpoint.
   */
  listProtectedOutpoints?(owner: string, network: "main" | "test"): Promise<readonly { txid: string; vout: number; kind?: string; source?: string; submissionId?: string }[]>;
  /** Trusted chain observation used to settle outstanding exact transactions. */
  chain?: { observe(network: "main" | "test", txid: string): Promise<string | null>; observeInputs?(network: "main" | "test", outpoints: string[], diagnostic?: (value: unknown) => void): Promise<InputObservation[] | null> };
}): P2pkhUtxoManager {
  async function adoptLegacyCancellation(state: LoadedState, allocationId: string) {
    if (state.value.cancelledDispatch?.[allocationId]) return;
    const binding = state.kernel.protocolIntentView(allocationId)?.binding;
    if (!binding) return;
    const old = await createWorkerProtocolEvidence(input.files).getProtocolSubmission(binding.poolId);
    const exact = state.kernel.outboxView().find(row => row.allocationId === allocationId);
    if (old?.status === "rejected" && old.droppedReason === "prepared-spend-released") {
      if (old.publicKeyHex.toLowerCase() !== state.value.owner || old.network !== state.value.network || (exact && exact.txid !== old.canonicalTxid)) throw new Error("Legacy cancellation identity mismatch");
      state.value = { ...state.value, cancelledDispatch: { ...state.value.cancelledDispatch, [allocationId]: "legacy-cancelled" } };
      await persist(input.files, state, state.kernel);
      return;
    }
    // Missing legacy gate is NOT proof that a BitFS opening passed Kind 3.
    if (state.value.businessDispatch?.[allocationId] === undefined && exact?.state !== "done" && bitfsFundingTemplate(state.kernel.signingIntent(allocationId).unsignedTxHex)) {
      state.value = { ...state.value, businessDispatch: { ...state.value.businessDispatch, [allocationId]: false } };
      await persist(input.files, state, state.kernel);
    }
  }
  async function conclusionContext(request: { ownerPublicKeyHex: string; network: "main" | "test"; allocationId: string }) {
    const state = await readStateForScope(input.files, request.ownerPublicKeyHex, request.network);
    const plan = paymentPlanForAllocation(state, request.allocationId);
    const entry = state.kernel.outboxView().find(row => row.commandId === `${request.allocationId}:broadcast`);
    if (plan && entry) assertFrozenPaymentTransaction({ kernel: state.kernel, allocationId: request.allocationId, rawTxHex: entry.rawTxHex, plan, allowTerminal: entry.state === "done" || entry.state === "failed" });
    const diagnostics: unknown[] = [];
    return { state, ports: { store: createDurableStore(input.files, state, diagnostics), chain: { observe: async (txid: string) => input.chain?.observe(request.network, txid) ?? null },
      inputObserver: input.chain?.observeInputs ? { observeInputs: async (keys: string[]) => input.chain!.observeInputs!(request.network, keys, value => diagnostics.push(value)) } : undefined,
      broadcaster: { broadcast: async (): Promise<BroadcastOutcome> => { throw new Error("Read-only input reconciliation cannot broadcast"); } },
    } };
  }
  const manager: P2pkhUtxoManager = {
    async observe(request) {
      const owner = request.ownerPublicKeyHex.toLowerCase();
      const state = await readState(input.files, owner, request.resource);
      const { candidate } = await refreshCandidate({ files: input.files, state, owner, resource: request.resource, utxos: [], listProtectedOutpoints: input.listProtectedOutpoints });
      const revision = state.value.snapshotRevision + 1;
      if (!Number.isSafeInteger(revision)) throw new Error("UTXO manager observation revision exhausted");
      candidate.applySnapshot({ generation: 1, revision, utxos: snapshotUtxosFor(request.resource, request.utxos) });
      const mempoolSpent = new Set(state.value.mempoolSpent ?? []);
      for (const row of request.utxos) {
        const key = `${row.txid.toLowerCase()}:${row.vout}`;
        if (row.isSpentInMempoolTx) mempoolSpent.add(key); else mempoolSpent.delete(key);
      }
      candidate.setProtected(state.value.mempoolSpent ?? [], false, "chain:mempool-spent");
      candidate.setProtected([...mempoolSpent], true, "chain:mempool-spent");
      await persist(input.files, { ...state, value: { ...state.value, snapshotRevision: revision, mempoolSpent: [...mempoolSpent] } }, candidate);
    },
    async protocolExecutionIdentity(request) {
      const state = await readStateForScope(input.files, request.ownerPublicKeyHex, request.network);
      const row = state.value.protocolExecutions?.[request.allocationId];
      return row ? { executionId: row.executionId, submissionId: row.submissionId } : null;
    },
    async ownsWalletExact(request) {
      let state: LoadedState;
      try { state = await readStateForScope(input.files, request.ownerPublicKeyHex, request.network); } catch (error) { if (error instanceof P2pkhManagerStateMissingError) return false; throw error; }
      const row = state.kernel.outboxView().find(entry => entry.txid === request.txid && entry.allocationId !== null && entry.delivery === "wallet");
      if (!row) return false;
      if (row.rawTxHex !== request.rawTxHex.toLowerCase()) throw new Error("Manager wallet exact mismatch");
      return true;
    },
    async previousTransaction(request) {
      let state: LoadedState;
      try { state = await readStateForScope(input.files, request.ownerPublicKeyHex, request.network); } catch (error) { if (error instanceof P2pkhManagerStateMissingError) return null; throw error; }
      const row = state.kernel.outboxView().find(entry => entry.txid === request.txid && entry.state === "done");
      if (!row) return null;
      parseTx(row.rawTxHex, request.txid);
      return row.rawTxHex;
    },
    async cancelProtocolSubmission(request) {
      const state = await readStateForScope(input.files, request.ownerPublicKeyHex, request.network);
      const ids = Object.keys(state.value.allocationKinds ?? {}).filter(id => state.value.allocationKinds![id] === "protocol" && (state.value.protocolExecutions?.[id]?.submissionId === request.submissionId || state.kernel.protocolIntentView(id)?.binding?.poolId === request.submissionId));
      if (ids.length !== 1 || (request.allocationId && request.allocationId !== ids[0])) throw new Error("Protocol cancellation identity is missing or ambiguous");
      const id = ids[0]!, candidate = state.kernel.clone();
      const exact = candidate.outboxView().find(row => row.allocationId === id);
      if (request.txid && exact?.txid !== request.txid) throw new Error("Protocol cancellation exact mismatch");
      const executions = { ...state.value.protocolExecutions };
      if (request.proof) {
        const execution = verifyExecution(state, id, request.proof);
        if (request.proof.state === "cancelled_before_sign") {
          if (!execution.released) candidate.cancelUnstarted(id);
          executions[id] = { ...execution, released: true };
        }
      }
      await persist(input.files, { ...state, value: { ...state.value, protocolExecutions: executions, cancelledDispatch: request.reason === "execution-failed" && request.proof?.state !== "cancelled_before_sign" ? state.value.cancelledDispatch : { ...state.value.cancelledDispatch, [id]: "cancelled" } } }, candidate);
    },
    async retireForumProtocolSubmission(request) {
      let state: LoadedState;
      try { state = await readStateForScope(input.files, request.ownerPublicKeyHex, request.network); }
      catch (error) { if (error instanceof P2pkhManagerStateMissingError) return { deleted: false }; throw error; }
      const ids = Object.keys(state.value.allocationKinds ?? {}).filter(id => state.value.allocationKinds![id] === "protocol" && (state.value.protocolExecutions?.[id]?.submissionId === request.submissionId || state.kernel.protocolIntentView(id)?.binding?.poolId === request.submissionId));
      if (ids.length === 0) return { deleted: false };
      if (ids.length !== 1) throw new Error("Forum retirement identity is ambiguous");
      const id = ids[0]!;
      const binding = state.kernel.protocolIntentView(id)?.binding;
      const execution = state.value.protocolExecutions?.[id];
      if ((binding && binding.poolId !== request.submissionId) || (execution && execution.submissionId !== request.submissionId)) {
        throw new Error("Forum retirement identity is inconsistent");
      }
      const commandIds = new Set(state.kernel.outboxView().filter(row => row.allocationId === id).map(row => row.commandId));
      // The allocation command identity remains stable even if its outbox is already gone.
      commandIds.add(`${id}:broadcast`);
      const allocationKinds = { ...state.value.allocationKinds };
      delete allocationKinds[id];
      const intents = { ...state.value.intents };
      delete intents[id];
      const results = { ...state.value.results };
      for (const [key, value] of Object.entries(results)) {
        if (commandIds.has(key)) { delete results[key]; continue; }
        if (!key.startsWith("attempt#")) continue;
        // A corrupt attempt prevents proving its ownership: retain all evidence and fail.
        const attempt = JSON.parse(value) as { commandId?: unknown };
        if (typeof attempt?.commandId !== "string") throw new Error("Manager result attempt identity is malformed");
        if (commandIds.has(attempt.commandId)) delete results[key];
      }
      const candidate = state.kernel.clone();
      candidate.retireForumProtocolAllocation(id);
      const protocolExecutions = { ...(state.value.protocolExecutions ?? {}) };
      delete protocolExecutions[id];
      const artifacts = { ...(state.value.artifacts ?? {}) };
      for (const [artifactId, artifact] of Object.entries(artifacts)) {
        if ((artifact as { allocationId?: unknown }).allocationId === id) delete artifacts[artifactId];
      }
      const cancelledDispatch = { ...(state.value.cancelledDispatch ?? {}) };
      delete cancelledDispatch[id];
      const businessDispatch = { ...(state.value.businessDispatch ?? {}) };
      delete businessDispatch[id];
      await persist(input.files, { ...state, value: { ...state.value, allocationKinds, intents, results, protocolExecutions, artifacts, cancelledDispatch, businessDispatch } }, candidate);
      return { deleted: true, allocationId: id };
    },
    async recoverProtocolExecution(request) {
      const state = await readStateForScope(input.files, request.ownerPublicKeyHex, request.network), proof = request.proof;
      const execution = verifyExecution(state, proof.allocationId, proof);
      if (proof.state === "cancelled_before_sign") {
        if (execution.released) return true;
        const candidate = state.kernel.clone(); candidate.cancelUnstarted(proof.allocationId);
        await persist(input.files, { ...state, value: { ...state.value, protocolExecutions: { ...state.value.protocolExecutions, [proof.allocationId]: { ...execution, released: true } }, cancelledDispatch: { ...state.value.cancelledDispatch, [proof.allocationId]: "cancelled-before-sign" } } }, candidate);
        return true;
      }
      if (proof.state !== "signed_complete") return false;
      if (!proof.signedTxHex || execution.released) throw new Error("Protocol signed recovery contradicts cancellation");
      const existing = state.kernel.outboxView().find(row => row.allocationId === proof.allocationId);
      if (existing) { if (existing.rawTxHex !== proof.signedTxHex) throw new Error("Protocol recovery exact conflict"); return true; }
      await completeProtocolIntent(state.kernel, createDurableStore(input.files, state), proof.allocationId, proof.signedTxHex, "wallet");
      return true;
    },
    async allowBusinessDispatch(request) {
      const state = await readStateForScope(input.files, request.ownerPublicKeyHex, request.network);
      const entry = state.kernel.outboxView().find(row => row.allocationId === request.allocationId);
      if (!entry || entry.rawTxHex !== request.rawTxHex.toLowerCase()) throw new Error("Business dispatch must bind the durable exact");
      await adoptLegacyCancellation(state, request.allocationId);
      if (state.value.cancelledDispatch?.[request.allocationId]) throw new Error("Cancelled dispatch cannot be reopened by business authorization");
      if (state.value.businessDispatch?.[request.allocationId] === undefined) return; // Older already-authorized manager exact.
      await persist(input.files, { ...state, value: { ...state.value, businessDispatch: { ...state.value.businessDispatch, [request.allocationId]: true } } }, state.kernel);
    },
    async observeAcceptedExact(request) {
      const state = await readState(input.files, request.ownerPublicKeyHex, request.resource);
      const candidate = state.kernel.clone();
      const parsed = parseTx(request.rawTxHex);
      const prior = candidate.outboxView().find(row => row.txid === parsed.canonicalTxid);
      if (prior?.state === "done") {
        if (prior.rawTxHex !== request.rawTxHex.toLowerCase()) throw new Error("Business receipt exact mismatch");
        return;
      }
      const commandId = prior?.commandId ?? candidate.importUnknown(parsed.canonicalTxid, request.rawTxHex);
      candidate.reconcile(commandId, { found: true, rawTxHex: request.rawTxHex });
      await persist(input.files, state, candidate);
    },
    async available(request) {
      const owner = request.ownerPublicKeyHex.toLowerCase();
      const state = await readState(input.files, owner, request.resource);
      const { candidate } = await refreshCandidate({ files: input.files, state, owner, resource: request.resource, utxos: [], listProtectedOutpoints: input.listProtectedOutpoints });
      const outpoints = candidate.spendableOutpoints();
      return { observed: state.value.snapshotRevision > 0 || outpoints.length > 0, inputs: managerInputsEvidence(candidate, outpoints, owner, request.resource) };
    },
    async listConclusions(request) {
      let state: LoadedState;
      try { state = await readStateForScope(input.files, request.ownerPublicKeyHex, request.network); }
      catch (error) { if (error instanceof P2pkhManagerStateMissingError) return []; throw error; }
      const boxes = state.kernel.outboxView().filter(row => row.allocationId !== null);
      const rows: P2pkhConclusionRow[] = boxes.map(row => ({
        allocationId: row.allocationId!, txid: row.txid, state: row.state, delivery: row.delivery, queryState: "stopped" as const,
        ...((state.value.cancelledDispatch?.[row.allocationId!] || state.value.businessDispatch?.[row.allocationId!] === false) ? { retryable: false, error: state.value.cancelledDispatch?.[row.allocationId!] ? "Dispatch cancelled; signature responsibility retained" : "Awaiting verified Kind 3" } : {}),
        ...(row.conclusion ? { conclusion: { ...row.conclusion, status: row.conclusion.status as "conflict" | "failed", reason: "input-conflict" as const } } : {}),
      }));
      for (const [id, kind] of Object.entries(state.value.allocationKinds ?? {})) {
        if (kind !== "protocol" || boxes.some(row => row.allocationId === id)) continue;
        const allocation = state.kernel.allocationView(id);
        if (allocation.state !== "held") continue;
        rows.push({ allocationId: id, txid: "", state: "unknown", delivery: "wallet", queryState: "stopped", retryable: false, signingState: "unknown", heldInputs: allocation.inputs, heldSats: allocation.totalInSats, error: "Durable signing intent awaits execution-journal recovery" });
      }
      return rows;
    },
    async reconcileInputs(request) {
      const { state, ports } = await conclusionContext(request);
      return reconcileManagerInputs(state.kernel, ports, request.allocationId);
    },
    async retryExact(request) {
      const { state, ports } = await conclusionContext(request);
      await adoptLegacyCancellation(state, request.allocationId);
      assertDispatchAllowed(state, request.allocationId);
      return retryManagerExact(state.kernel, { ...ports, broadcaster: { broadcast: async raw => request.broadcast(raw, parseTx(raw).canonicalTxid) } }, request.allocationId);
    },
    async selectProtocolFunding(request) {
      const owner = request.ownerPublicKeyHex.toLowerCase();
      const resource = request.resource;
      const state = await readState(input.files, owner, resource);
      const { candidate } = await refreshCandidate({
        files: input.files, state, owner, resource, utxos: request.utxos,
        listProtectedOutpoints: input.listProtectedOutpoints,
      });
      // Use the SAME kernel's selection, fees, ancestry and protected-input
      // rules. This clone is deliberately not saved: signing will atomically
      // acquire a protocol intent over the exact chosen inputs, or fail closed.
      const view = candidate.request({
        requestId: `protocol-plan-${crypto.randomUUID()}`,
        businessAmountSats: String(request.amountSatoshis),
        feeRateSatPerKb: String(request.feeRateSatoshisPerKb),
        outputs: request.outputs ?? [{ scriptHex: configFor(resource).walletScriptHex, value: String(request.amountSatoshis) }],
      });
      const selectedInputs = managerInputsEvidence(candidate, view.inputs, owner, resource);
      const totalInputSatoshis = selectedInputs.reduce((sum, row) => sum + row.utxo.value, 0);
      if (!Number.isSafeInteger(totalInputSatoshis)) throw new Error("Protocol funding input total exceeds safe integer range");
      return { selectedInputs, totalInputSatoshis };
    },
    async reserve(request) {
      const owner = request.ownerPublicKeyHex.toLowerCase();
      const resource = request.resource;
      const state = await readState(input.files, owner, resource);
      const { candidate, revision } = await refreshCandidate({
        files: input.files, state, owner, resource, utxos: request.utxos,
        listProtectedOutpoints: input.listProtectedOutpoints,
      });

      const requestId = crypto.randomUUID();
      const paymentType: PaymentType = request.paymentType ?? "p2pkh";
      const changeScriptHex = configFor(resource).walletScriptHex;
      const recipientScript = request.recipientScriptHex?.toLowerCase()
        ?? (request.recipientAddress
          ? p2pkhAddressToScriptHex(request.recipientAddress, resource.network)
          : undefined);
      if (!recipientScript) throw new Error("P2PKH manager requires a recipient address or script");
      let businessSats = BigInt(request.amountSatoshis);
      if (request.sendAll) {
        const outpoints = candidate.spendableOutpoints();
        if (outpoints.length === 0) throw new Error("P2PKH transfer has no spendable UTXOs");
        const available = BigInt(candidate.spendableBalance());
        const fee = estimateFeeSats(BigInt(request.feeRateSatoshisPerKb), estimateSignedSize(outpoints.length, [recipientScript.length / 2]));
        businessSats = available - fee;
        if (businessSats <= 0n) throw new Error("P2PKH balance is insufficient to pay the send-all fee");
      }
      const view = candidate.request({
        requestId,
        businessAmountSats: formatAmount(businessSats),
        feeRateSatPerKb: String(request.feeRateSatoshisPerKb),
        outputs: [{ scriptHex: recipientScript, value: formatAmount(businessSats) }],
      });
      const selected = view.inputs.map((key) => {
        const [txid, vout] = key.split(":");
        return { txid: txid!, vout: Number(vout) };
      });
      const roleMap = buildPaymentTemplate({
        paymentType,
        businessAmountSats: view.businessSats,
        businessScriptHex: recipientScript,
        changeScriptHex,
        changeAmountSats: view.changeSats,
      });
      // The kernel just allocated these amounts/inputs and the internal
      // builder just produced this role map. Persist their result directly;
      // stored/external exact recovery is handled by its own boundary.
      const unsignedTxHex = buildUnsigned({
        inputs: selected,
        outputs: roleMap.map((row) => ({ scriptHex: row.scriptHex, value: row.valueSats })),
      });
      const selectedInputs = managerInputsEvidence(candidate, view.inputs, owner, resource);
      const plan: PersistedPaymentPlan = {
        allocationId: view.allocationId,
        ...(request.paymentId === undefined ? {} : { paymentId: request.paymentId }),
        paymentType,
        businessAmountSats: view.businessSats,
        businessScriptHex: recipientScript,
        changeScriptHex: BigInt(view.changeSats) > 0n ? changeScriptHex : null,
        changeAmountSats: view.changeSats,
        outputs: roleMap,
      };
      plan.planDigest = paymentPlanDigest(plan);
      await persist(input.files, {
        ...state,
        value: {
          ...state.value,
          snapshotRevision: revision,
          payments: { ...(state.value.payments ?? {}), [view.allocationId]: plan },
          allocationKinds: { ...(state.value.allocationKinds ?? {}), [view.allocationId]: "payment" },
        },
      }, candidate);
      return {
        ...mapReservation(view, unsignedTxHex, selectedInputs),
        outputs: roleMap,
        businessScriptHex: recipientScript,
        changeScriptHex: plan.changeScriptHex,
        planDigest: plan.planDigest,
      };
    },

    async refreshAllocationInputs(request) {
      const owner = request.ownerPublicKeyHex.toLowerCase();
      const resource = request.resource;
      const state = await readState(input.files, owner, resource);
      const { candidate, revision } = await refreshCandidate({
        files: input.files, state, owner, resource, utxos: request.utxos,
        listProtectedOutpoints: input.listProtectedOutpoints,
      });
      const allocation = candidate.allocationView(request.allocationId);
      if (allocation.state !== "held") throw new Error(`UTXO manager allocation is not held: ${allocation.state}`);
      const context = evidenceContext(candidate);
      const selectedInputs = allocation.inputs.map((key) => {
        const row = candidate.lookup(key);
        if (row.occupiedBy !== request.allocationId) throw new Error(`UTXO manager no longer owns input: ${key}`);
        return managerInputEvidence(candidate, key, owner, resource, context);
      });
      await persist(input.files, { ...state, value: { ...state.value, snapshotRevision: revision } }, candidate);
      return selectedInputs;
    },

    async prepareSigning(request) {
      const state = await readState(input.files, request.ownerPublicKeyHex, request.resource);
      const candidate = state.kernel.clone();
      const plan = paymentPlanForAllocation(state, request.allocationId);
      if (plan) {
        assertFrozenPaymentTransaction({
          kernel: candidate,
          allocationId: request.allocationId,
          rawTxHex: request.unsignedTxHex,
          plan,
        });
      }
      const prepared = candidate.prepare({ allocationId: request.allocationId, unsignedTxHex: request.unsignedTxHex });
      candidate.markSigningIntentDurable(request.allocationId);
      const intent = JSON.stringify({ allocationId: request.allocationId, unsignedTxHex: prepared.unsignedTxHex, feeSats: prepared.estimatedFeeSats });
      const value = { ...state.value, kernel: candidate.serialize(), intents: { ...state.value.intents, [request.allocationId]: intent } };
      const saved = await input.files.put(state.path, encoder.encode(JSON.stringify(value)), state.revision === undefined ? { ifNoneMatch: true } : { ifRevision: state.revision });
      state.revision = saved.revision;
    },

    async release(request) {
      const state = await readStateForScope(input.files, request.ownerPublicKeyHex, request.network);
      const candidate = state.kernel.clone();
      const intent = candidate.signingIntent(request.allocationId);
      if (intent.durable) throw new Error("Cannot release a durable signing intent");
      candidate.abortUnbroadcast(request.allocationId);
      await persist(input.files, state, candidate);
    },

    async submitSigned(request) {
      const state = await readState(input.files, request.ownerPublicKeyHex, request.resource);
      await adoptLegacyCancellation(state, request.allocationId);
      assertDispatchAllowed(state, request.allocationId);
      const plan = paymentPlanForAllocation(state, request.allocationId);
      if (plan) {
        // Re-check the actual signed exact bytes, not the reconstructed
        // expected table: a swapped output position or changed script/value
        // must fail before dispatch.
        assertFrozenPaymentTransaction({
          kernel: state.kernel,
          allocationId: request.allocationId,
          rawTxHex: request.signedTxHex,
          plan,
        });
      }
      const store = createDurableStore(input.files, state);
      const candidate = state.kernel;
      const ports = {
        store,
        broadcaster: { broadcast: async (rawTxHex: string) => request.broadcast(rawTxHex, parseTx(rawTxHex).canonicalTxid) },
        chain: { observe: async (txid: string) => input.chain?.observe(request.resource.network, txid) ?? null },
      };
      const existing = candidate.outboxView().find(row => row.allocationId === request.allocationId);
      if (existing) {
        if (existing.rawTxHex !== request.signedTxHex.toLowerCase()) throw new Error("Manager exact bytes changed");
        const result = await retryManagerExact(candidate, ports, request.allocationId);
        return { txid: result.txid, delivery: result.delivery };
      }
      // A protocol allocation carries its own intent rules (classified
      // inputs, fee cap, business cap); an ordinary one uses the template
      // rules. The durable ordering is identical.
      const protocol = state.kernel.protocolIntentView(request.allocationId);
      const result = protocol
        ? await submitProtocolSigned(candidate, ports, request.allocationId, request.signedTxHex)
        : await submitSigned(candidate, ports, request.allocationId, request.signedTxHex);
      return { txid: result.txid, delivery: result.delivery };
    },

    async recoverSignedPayments(request) {
      if (!request.proofs.length) return [];
      let state: LoadedState;
      try { state = await readStateForScope(input.files, request.ownerPublicKeyHex, request.network); }
      catch (error) { if (error instanceof P2pkhManagerStateMissingError) throw new Error('Signed journal responsibility has no manager state'); throw error; }
      const candidate = state.kernel.clone();
      const recovered: Array<{ paymentId: string; allocationId: string; txid: string }> = [];
      const seen = new Set<string>(); let changed = false;
      for (const proof of request.proofs) {
        if (seen.has(proof.paymentId)) throw new Error('Duplicate signed payment recovery identity');
        if (proof.state === 'signed_complete' && !proof.signedTxHex) throw new Error('Signed payment recovery exact is unavailable');
        seen.add(proof.paymentId);
        const entries = Object.entries(state.value.payments ?? {}).filter(([, plan]) => plan.paymentId === proof.paymentId);
        if (entries.length > 1) throw new Error('Ambiguous signed payment identity');
        if (!entries.length) {
          if (state.value.releasedPayments?.[proof.paymentId] !== undefined) throw new Error('Signed recovery contradicts unsigned release');
          throw new Error('Signed journal responsibility has no original allocation');
        }
        const [allocationId, plan] = entries[0]!;
        if (proof.planDigest !== plan.planDigest) throw new Error('Signed recovery plan digest mismatch');
        const intent = candidate.signingIntent(allocationId);
        const saved = state.value.intents[allocationId];
        if (!saved || !intent.durable) throw new Error('Signed recovery lacks durable signing intent');
        const durable = JSON.parse(saved) as { allocationId?: string; unsignedTxHex?: string };
        if (durable.allocationId !== allocationId || durable.unsignedTxHex !== intent.unsignedTxHex) throw new Error('Signed recovery intent mismatch');
        if (proof.state === 'quarantined') continue; // Original durable intent covers the duty; never ACK partial/corrupt material.
        const exact = proof.signedTxHex!.toLowerCase();
        const parsed = parseTx(exact);
        assertFrozenPaymentTransaction({ kernel: candidate, allocationId, rawTxHex: exact, plan, allowTerminal: true });
        const unsigned = buildUnsigned({ version: parsed.version, locktime: parsed.locktime, inputs: parsed.inputs.map(row => ({ txid: row.txid, vout: row.vout, sequence: row.sequence })), outputs: parsed.outputs.map(row => ({ scriptHex: row.scriptHex, value: formatAmount(row.value) })) });
        if (durable.allocationId !== allocationId || durable.unsignedTxHex !== intent.unsignedTxHex || unsigned !== intent.unsignedTxHex) throw new Error('Signed recovery differs from immutable signing template');
        // Cryptographic verification is performed by the Vault journal reader;
        // here independently bind all script envelopes to the current owner.
        for (const row of parsed.inputs) {
          const size = Number.parseInt(row.scriptSigHex.slice(0, 2), 16);
          if (!Number.isInteger(size) || size < 9 || size > 73 || row.scriptSigHex.length !== (size + 35) * 2 || row.scriptSigHex.slice((size + 1) * 2) !== `21${request.ownerPublicKeyHex.toLowerCase()}` || row.scriptSigHex.slice(size * 2, (size + 1) * 2) !== '41') throw new Error('Signed recovery has invalid owner signature envelope');
        }
        const existing = candidate.outboxView().filter(row => row.allocationId === allocationId);
        if (existing.length > 1 || (existing[0] && (existing[0].commandId !== `${allocationId}:broadcast` || existing[0].rawTxHex !== exact || existing[0].txid !== parsed.canonicalTxid))) throw new Error('Signed recovery conflicts with original outbox exact');
        if (!existing.length) {
          candidate.completePrepare({ allocationId, signedTxHex: exact }); changed = true;
        }
        recovered.push({ paymentId: proof.paymentId, allocationId, txid: parsed.canonicalTxid });
      }
      if (changed) await persist(input.files, state, candidate);
      return recovered;
    },

    async recoverCancelledPayments(request) {
      const state = await readStateForScope(input.files, request.ownerPublicKeyHex, request.network);
      const candidate = state.kernel.clone();
      const payments = { ...(state.value.payments ?? {}) };
      const allocationKinds = { ...(state.value.allocationKinds ?? {}) };
      const releasedPayments = { ...(state.value.releasedPayments ?? {}) };
      const released: Array<{ allocationId: string; paymentId: string }> = [];
      for (const proof of request.proofs) {
        if (proof.state !== "cancelled_before_sign") continue;
        const entry = Object.entries(payments).find(([, plan]) => plan.paymentId === proof.paymentId);
        if (!entry) {
          if (releasedPayments[proof.paymentId] === proof.planDigest) {
            released.push({ allocationId: "", paymentId: proof.paymentId });
          }
          continue;
        }
        const [allocationId, plan] = entry;
        if ((plan.planDigest ?? paymentPlanDigest(plan)) !== proof.planDigest) continue;
        try {
          candidate.cancelUnstarted(allocationId);
        } catch {
          continue;
        }
        delete payments[allocationId];
        delete allocationKinds[allocationId];
        releasedPayments[proof.paymentId] = proof.planDigest;
        released.push({ allocationId, paymentId: proof.paymentId });
      }
      if (released.length > 0) {
        await persist(input.files, { ...state, value: { ...state.value, payments, allocationKinds, releasedPayments } }, candidate);
      }
      return released;
    },

    async paymentStatus(request) {
      let state: LoadedState;
      try { state = await readStateForScope(input.files, request.ownerPublicKeyHex, request.network); }
      catch (error) { if (error instanceof P2pkhManagerStateMissingError) return { status: "not_found" }; throw error; }
      const entries = Object.entries(state.value.payments ?? {}).filter(([, plan]) => plan.paymentId === request.paymentId);
      if (entries.length > 1) throw new Error("Ambiguous manager payment identity");
      const entry = entries[0];
      const releasedDigest = state.value.releasedPayments?.[request.paymentId];
      if (!entry) {
        if (releasedDigest !== undefined) {
          if (typeof releasedDigest !== "string") throw new Error("Malformed unsigned-payment release tombstone");
          const released = JSON.parse(releasedDigest) as PersistedPaymentPlan;
          if (!released || typeof released.allocationId !== "string" || released.paymentId !== request.paymentId) throw new Error("Unsigned-payment release identity mismatch");
          validatePersistedPaymentPlan({ ...released, planDigest: releasedDigest }, released.allocationId, state.kernel.config.walletScriptHex);
          if (state.kernel.allocationView(released.allocationId).state !== "aborted" || state.kernel.outboxView().some(row => row.allocationId === released.allocationId)) throw new Error("Unsigned-payment release contradicts kernel responsibility");
          return { status: "not_signed", allocationId: released.allocationId };
        }
        return { status: "not_found" };
      }
      if (releasedDigest !== undefined) throw new Error("Active payment contradicts unsigned release tombstone");
      const [allocationId, plan] = entry;
      const boxes = state.kernel.outboxView().filter(row => row.allocationId === allocationId);
      if (boxes.length > 1) throw new Error("Ambiguous manager payment outbox");
      const outbox = boxes[0];
      if (!outbox) {
        const allocation = state.kernel.allocationView(allocationId);
        if (allocation.state !== "held") throw new Error("Payment allocation lacks its durable outbox");
        return { status: "pending", allocationId };
      }
      if (outbox.commandId !== `${allocationId}:broadcast`) throw new Error("Payment outbox command identity mismatch");
      assertFrozenPaymentTransaction({ kernel: state.kernel, allocationId, rawTxHex: outbox.rawTxHex, plan, allowTerminal: outbox.state === "done" || outbox.state === "failed" });
      if (outbox.state === "done") return { status: "accepted" as const, allocationId, txid: outbox.txid };
      const conclusion = outbox.conclusion ? { ...outbox.conclusion, status: outbox.conclusion.status as "conflict" | "failed", reason: "input-conflict" as const } : undefined;
      if (outbox.state === "failed") return { status: "failed" as const, allocationId, txid: outbox.txid, conclusion };
      if (outbox.state === "unknown" || outbox.state === "dispatching") return { status: "unknown" as const, allocationId, txid: outbox.txid, ...(conclusion ? { conclusion } : {}) };
      return { status: "signed_not_dispatched" as const, allocationId, txid: outbox.txid };
    },

    async cancelPayment(request) {
      const state = await readStateForScope(input.files, request.ownerPublicKeyHex, request.network);
      const plan = state.value.payments?.[request.allocationId];
      const kind = state.value.allocationKinds?.[request.allocationId];
      if (kind !== "payment" || !plan) throw new Error("Payment allocation has no frozen plan; refusing to release");
      if (request.proof.state !== "cancelled_before_sign"
        || request.proof.paymentId !== plan.paymentId
        || request.proof.allocationId !== request.allocationId
        || request.proof.planDigest !== (plan.planDigest ?? paymentPlanDigest(plan))) {
        throw new Error("Payment cancellation proof does not match the frozen plan");
      }
      const candidate = state.kernel.clone();
      candidate.cancelUnstarted(request.allocationId);
      const payments = { ...(state.value.payments ?? {}) };
      const allocationKinds = { ...(state.value.allocationKinds ?? {}) };
      const releasedPayments = { ...(state.value.releasedPayments ?? {}), [request.proof.paymentId]: request.proof.planDigest };
      delete payments[request.allocationId];
      delete allocationKinds[request.allocationId];
      await persist(input.files, { ...state, value: { ...state.value, payments, allocationKinds, releasedPayments } }, candidate);
    },

    async reconcile(request) {
      const owner = request.ownerPublicKeyHex.toLowerCase();
      let state: LoadedState;
      try {
        state = await readStateForScope(input.files, owner, request.network);
      } catch (error) {
        // "No state yet" means nothing is outstanding. Anything else (corrupt
        // JSON, schema/scope mismatch, unreadable storage) must be visible:
        // reporting an empty responsibility list would hide real funds.
        if (error instanceof P2pkhManagerStateMissingError) {
          return { committed: [], unobserved: [], unobservable: [] };
        }
        throw error;
      }
      const observe = request.observe ?? (input.chain
        ? (txid: string) => input.chain!.observe(request.network, txid)
        : undefined);
      const candidate = state.kernel.clone();
      const committed: string[] = [];
      const unobserved: string[] = [];
      const unobservable: string[] = [];
      for (const entry of candidate.outboxView()) {
        if (entry.state === "done" || entry.state === "failed") continue;
        if (!observe) { unobservable.push(entry.txid); continue; }
        let raw: string | null = null;
        try {
          raw = await observe(entry.txid);
        } catch {
          unobservable.push(entry.txid);
          continue;
        }
        if (!raw) { unobserved.push(entry.txid); continue; }
        try {
          const result = candidate.reconcile(entry.commandId, { found: true, rawTxHex: raw });
          if (result === "committed") committed.push(entry.txid);
          else unobserved.push(entry.txid);
        } catch {
          // A mismatching observation is not proof that the transaction is
          // gone: keep the responsibility instead of releasing it.
          unobservable.push(entry.txid);
        }
      }
      await persist(input.files, state, candidate);
      return { committed, unobserved, unobservable };
    },

    async responsibilities(request) {
      const owner = request.ownerPublicKeyHex.toLowerCase();
      let state: LoadedState;
      try {
        state = await readStateForScope(input.files, owner, request.network);
      } catch (error) {
        if (error instanceof P2pkhManagerStateMissingError) return [];
        // An unreadable ledger is not an empty ledger.
        throw error;
      }
      const rows: P2pkhManagerResponsibility[] = state.kernel.responsibilityView().map((row) => ({
        commandId: row.commandId,
        allocationId: row.allocationId,
        txid: row.txid,
        state: row.state,
        delivery: row.delivery,
        reason: row.reason,
        inputs: [...row.inputs],
        totalInSats: row.totalInSats,
        ownOutputs: row.ownOutputs.map((output) => ({ ...output })),
      }));
      const boxes = state.kernel.outboxView();
      for (const [id, kind] of Object.entries(state.value.allocationKinds ?? {})) {
        if (kind !== "protocol" || boxes.some(row => row.allocationId === id)) continue;
        const allocation = state.kernel.allocationView(id);
        if (allocation.state === "held") rows.push({ commandId: `${id}:signing`, allocationId: id, txid: "", state: "signing-unknown", delivery: "wallet", reason: "Durable signing intent awaits execution evidence", inputs: allocation.inputs, totalInSats: allocation.totalInSats, ownOutputs: [] });
      }
      return rows;
    },

    async beginProtocolIntent(request) {
      const owner = request.ownerPublicKeyHex.toLowerCase();
      const state = await readState(input.files, owner, request.resource);
      // Q04：先按 artifact 身份判定重放。内容摘要覆盖冻结意图的全部输入，
      // 不允许用同一个 ID 换内容（换内容必须换身份并重新授权）。
      const artifactId = request.artifactId;
      const contentKey = artifactId === undefined ? undefined : JSON.stringify({
        unsignedTxHex: request.unsignedTxHex.toLowerCase(),
        inputs: request.inputs,
        outputs: request.outputs,
        businessAmountSats: request.businessAmountSats,
        feeRateSatPerKb: request.feeRateSatPerKb,
        feeCapSats: request.feeCapSats,
        feePolicy: request.feePolicy,
        binding: request.binding,
        ...(request.deferDispatch ? { deferDispatch: true } : {}),
        claims: [...(request.claims ?? [])].sort(),
      });
      const existing = artifactId === undefined ? undefined : state.value.artifacts?.[artifactId];
      if (artifactId !== undefined && existing) {
        if (existing.content !== contentKey) {
          throw new Error(`UTXO manager artifact ${artifactId} was already occupied with different content`);
        }
        return { allocationId: existing.allocationId };
      }
      const { candidate, revision } = await refreshCandidate({
        files: input.files, state, owner, resource: request.resource, utxos: request.utxos,
        listProtectedOutpoints: input.listProtectedOutpoints,
      });
      const allocationId = `protocol-${crypto.randomUUID()}`;
      candidate.requestProtocol({
        requestId: allocationId,
        businessAmountSats: request.businessAmountSats,
        feeRateSatPerKb: request.feeRateSatPerKb,
        outputs: request.outputs.map((output) => ({ scriptHex: output.scriptHex, value: output.value })),
      });
      const storeState = {
        ...state,
        value: {
          ...state.value,
          snapshotRevision: revision,
          allocationKinds: { ...(state.value.allocationKinds ?? {}), [allocationId]: "protocol" as const },
          ...((request.deferDispatch || bitfsFundingTemplate(request.unsignedTxHex)) ? { businessDispatch: { ...state.value.businessDispatch, [allocationId]: false } } : {}),
          ...(request.executionId ? { protocolExecutions: { ...state.value.protocolExecutions, [allocationId]: { executionId: request.executionId, submissionId: request.binding.poolId, unsignedTxHex: request.unsignedTxHex.toLowerCase() } } } : {}),
        },
      };
      const store = createDurableStore(input.files, storeState);
      if (artifactId !== undefined) {
        // 与 intent 落盘在同一次持久化：不存在“占用了但没有身份记录”的窗口。
        storeState.value = {
          ...storeState.value,
          artifacts: {
            ...(storeState.value.artifacts ?? {}),
            [artifactId]: { allocationId, content: contentKey as string, phase: "occupied" },
          },
        };
      }
      const prepared = await prepareProtocolIntent(candidate, store, {
        allocationId,
        unsignedTxHex: request.unsignedTxHex,
        inputs: request.inputs.map((row) => ({
          outpoint: row.outpoint, class: row.class, value: row.value, scriptHex: row.scriptHex, claimId: row.claimId,
        })),
        feeCapSats: request.feeCapSats,
        feePolicy: request.feePolicy,
        binding: request.binding,
        externalProofs: request.externalProofs,
        claims: request.claims,
      });
      state.kernel.replaceFrom(candidate);
      return { allocationId: prepared.allocationId };
    },

    async completeProtocolIntent(request) {
      const owner = request.ownerPublicKeyHex.toLowerCase();
      const state = await readState(input.files, owner, request.resource);
      const store = createDurableStore(input.files, state);
      const completed = await completeProtocolIntent(
        state.kernel,
        store,
        request.allocationId,
        request.signedTxHex,
        request.delivery,
      );
      return { txid: completed.txid, feeSats: completed.feeSats };
    },

    async protocolIntentProof(request) {
      const owner = request.ownerPublicKeyHex.toLowerCase();
      let state: LoadedState;
      try {
        state = await readStateForScope(input.files, owner, request.network);
      } catch {
        return { ok: false, protectedInputs: [] };
      }
      const intent = state.kernel.protocolIntentView(request.allocationId);
      if (!intent) return { ok: false, protectedInputs: [] };
      if (intent.signedTxid && intent.signedTxid.toLowerCase() !== request.txid.toLowerCase()) {
        return { ok: false, protectedInputs: [] };
      }
      const intentKeys = intent.inputs.map((fact) => fact.outpoint);
      if (intentKeys.length !== request.inputOutpointKeys.length
          || !intentKeys.every((key, index) => key === request.inputOutpointKeys[index])) {
        return { ok: false, protectedInputs: [] };
      }
      const protectedInputs: string[] = [];
      for (const fact of intent.inputs) {
        if (fact.class !== "protected") continue;
        if (!fact.claimId) return { ok: false, protectedInputs: [] };
        protectedInputs.push(fact.outpoint);
      }
      return { ok: true, protectedInputs };
    },
  };
  // One scope write lane, including the provider call's durable dispatch boundary.
  // Read-only proof callbacks remain reentrant; storage CAS guards other handles.
  let tails = managerWriteTails.get(input.files);
  if (!tails) { tails = new Map(); managerWriteTails.set(input.files, tails); }
  const readOnly = new Set(["available", "listConclusions", "responsibilities", "paymentStatus", "protocolIntentProof", "previousTransaction", "ownsWalletExact", "protocolExecutionIdentity"]);
  for (const name of Object.keys(manager) as Array<keyof P2pkhUtxoManager>) {
    if (readOnly.has(name)) continue;
    const operation = manager[name] as (request: any) => Promise<unknown>;
    (manager as any)[name] = async (request: any) => {
      const key = `${request.ownerPublicKeyHex.toLowerCase()}:${request.network ?? request.resource?.network}`;
      const prior = tails!.get(key) ?? Promise.resolve();
      const run = prior.catch(() => undefined).then(() => operation(request));
      tails!.set(key, run);
      try { return await run; } finally { if (tails!.get(key) === run) tails!.delete(key); }
    };
  }
  return manager;
}
const managerWriteTails = new WeakMap<object, Map<string, Promise<unknown>>>();

async function readStateForScope(files: BorrowedModuleFileStore, owner: string, network: "main" | "test"): Promise<LoadedState> {
  const statePath = pathFor(network);
  const object = await files.get(statePath);
  if (!object) throw new P2pkhManagerStateMissingError();
  let value: PersistedManagerState;
  try { value = JSON.parse(decoder.decode(object.bytes)) as PersistedManagerState; }
  catch { throw new P2pkhManagerStateUnreadableError("corrupt JSON", "P2PKH UTXO manager state is corrupt; refusing to spend"); }
  if (!value || (value.schema !== SCHEMA && value.schema !== LEGACY_SCHEMA) || value.owner !== owner.toLowerCase() || value.network !== network
      || typeof value.kernel !== "string" || !Number.isSafeInteger(value.snapshotRevision) || value.snapshotRevision < 0
      || !isPlainRecord(value.intents) || !isPlainRecord(value.results)) {
    throw new P2pkhManagerStateUnreadableError("scope or schema mismatch", "P2PKH UTXO manager state scope/schema mismatch; refusing to spend");
  }
  let kernel: FundingKernel;
  try { kernel = FundingKernel.restore(value.kernel, { owner: owner.toLowerCase(), network }); }
  catch (error) { throw new P2pkhManagerStateUnreadableError(error instanceof Error ? error.message : String(error), `P2PKH UTXO manager state cannot be restored: ${error instanceof Error ? error.message : String(error)}`); }
  try { normalizePaymentState(value, kernel); }
  catch (error) { throw new P2pkhManagerStateUnreadableError("payment plan missing or corrupt", error instanceof Error ? error.message : String(error)); }
  return { path: statePath, kernel, value, revision: object.revision };
}

function createDurableStore(files: BorrowedModuleFileStore, initial: LoadedState, inputDiagnostics?: unknown[]): DurableStore {
  const state = initial;
  const save = async (value: PersistedManagerState) => {
    const saved = await files.put(state.path, encoder.encode(JSON.stringify(value)), state.revision === undefined ? { ifNoneMatch: true } : { ifRevision: state.revision });
    state.revision = saved.revision;
    state.value = value;
    state.kernel = FundingKernel.restore(value.kernel, { owner: value.owner, network: value.network });
  };
  return {
    async saveIntent(allocationId, intentJson, stateBlob) {
      await save({ ...state.value, kernel: stateBlob, intents: { ...state.value.intents, [allocationId]: intentJson } });
    },
    async loadIntent(allocationId) { return state.value.intents[allocationId] ?? null; },
    async saveDispatch(commandId, txid, rawTxHex, stateBlob) {
      const kernel = FundingKernel.restore(stateBlob, { owner: state.value.owner, network: state.value.network });
      const entry = kernel.outboxView().find((row) => row.commandId === commandId);
      if (!entry || entry.txid !== txid || entry.rawTxHex !== rawTxHex.toLowerCase()) throw new Error("UTXO manager dispatch does not match exact outbox bytes");
      await save({ ...state.value, kernel: stateBlob });
    },
    async loadExact(txid) {
      const entry = state.kernel.outboxView().find((row) => row.txid === txid.toLowerCase());
      return entry?.rawTxHex ?? null;
    },
    async recordResult(commandId, resultJson, stateBlob) {
      const content = inputDiagnostics?.length ? JSON.stringify({ managerResult: resultJson, inputDiagnostics }) : resultJson;
      const results = { ...state.value.results };
      let index = Object.keys(results).length;
      while (`attempt#${index}` in results) index++;
      results[`attempt#${index}`] = JSON.stringify({ commandId, result: content });
      results[commandId] = content;
      await save({ ...state.value, kernel: stateBlob, results });
    },
  };
}
