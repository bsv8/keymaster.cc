// Trusted submit orchestration (utm/1).
//
// Each externally visible state transition is built on a detached kernel
// candidate, durably committed with its exact transaction/result, and only
// then published to the live kernel. A durable dispatch state always precedes
// network I/O. Unknown outcomes retain the same exact transaction and input
// responsibility.
import { UtmError } from "./contract.js";
import { checkTxid, parseTx } from "./txcodec.js";
import { FundingKernel, type ProtocolIntentInput, type InputObservation, type InputConclusion } from "./kernel.js";

export interface DurableStore {
  /** Atomically persist the frozen signing intent and its responsibility state. */
  saveIntent(allocationId: string, intentJson: string, stateBlob: string): Promise<void>;
  loadIntent(allocationId: string): Promise<string | null>;
  /** Atomically persist exact bytes, all input responsibility and dispatch intent. */
  saveDispatch(commandId: string, txid: string, rawTxHex: string, stateBlob: string): Promise<void>;
  loadExact(txid: string): Promise<string | null>;
  /** Atomically persist the result and resulting manager state. */
  recordResult(commandId: string, resultJson: string, stateBlob: string): Promise<void>;
  /**
   * Persist a state blob that carries no per-command artifact, such as the
   * external-signature responsibility ledger (E01). Hosts that keep the
   * ledger in the same durable file implement it; hosts that cannot must
   * refuse external delivery rather than lose the responsibility.
   */
  saveState?(stateBlob: string): Promise<void>;
}

export type BroadcastOutcome =
  | { status: "accepted"; txid: string }
  | { status: "already-known"; txid: string; rawTxHex: string }
  | { status: "not-dispatched"; reason: string }
  | { status: "conflict"; txid: string };

export interface Broadcaster {
  broadcast(rawTxHex: string): Promise<BroadcastOutcome>;
}

export interface InputObserver {
  observeInputs(outpoints: string[]): Promise<InputObservation[] | null>;
}

export interface ChainObserver {
  /** Returns provider bytes when the tx is observed, null when absent. */
  observe(txid: string): Promise<string | null>;
}

export type OrchestrationFaultPoint =
  | "after-dispatch-persist-before-broadcast"
  | "after-broadcast-before-result-persist"
  | "after-result-persist-before-publish";

export interface OrchestrationPorts {
  store: DurableStore;
  broadcaster: Broadcaster;
  chain: ChainObserver;
  inputObserver?: InputObserver;
  /** Deterministic internal crash injection for tests; production omits it. */
  fault?: (point: OrchestrationFaultPoint) => void | Promise<void>;
}

export interface SubmitResult {
  allocationId: string;
  txid: string;
  feeSats: string;
  delivery: "accepted" | "already-known" | "unknown" | "failed";
  conclusion?: InputConclusion;
}

// Go read ports return (value, found). A failed TS read is the same
// unavailable evidence, never permission to dispatch or release funds.
async function loadExactOrMissing(store: DurableStore, txid: string): Promise<string | null> {
  try { return await store.loadExact(txid); } catch { return null; }
}

/** Validate and durably freeze an unsigned transaction before authorizing signing. */
export async function prepareIntent(
  kernel: FundingKernel,
  store: Pick<DurableStore, "saveIntent">,
  allocationId: string,
  unsignedTxHex: string,
): Promise<{ allocationId: string; unsignedTxHex: string; estimatedFeeSats: string }> {
  const candidate = kernel.clone();
  const prepared = candidate.prepare({ allocationId, unsignedTxHex });
  candidate.markSigningIntentDurable(allocationId);
  const intentJson = JSON.stringify({
    allocationId,
    unsignedTxHex: prepared.unsignedTxHex,
    feeSats: prepared.estimatedFeeSats,
  });
  await store.saveIntent(allocationId, intentJson, candidate.serialize());
  kernel.replaceFrom(candidate);
  return prepared;
}

function resultJson(state: "done" | "unknown" | "failed", txid: string, reason?: string): string {
  return JSON.stringify({ state, txid, ...(reason ? { reason } : {}) });
}

/**
 * Persist a complete dispatch-intent candidate before calling the provider.
 * Provider results are verified on another detached candidate; result bytes
 * and state are atomically persisted before the live kernel is advanced.
 */
export async function submitSigned(
  kernel: FundingKernel,
  ports: OrchestrationPorts,
  allocationId: string,
  signedTxHex: string,
): Promise<SubmitResult> {
  return runSubmit(kernel, ports, allocationId, signedTxHex, (candidate, id, hex) =>
    candidate.completePrepare({ allocationId: id, signedTxHex: hex }));
}

/**
 * Submit a protocol-bound transaction: the same durable ordering as an
 * ordinary submit, but the signed bytes are validated against the frozen
 * protocol intent (classified inputs, fee cap, business cap) instead of the
 * ordinary allocation template.
 */
export async function submitProtocolSigned(
  kernel: FundingKernel,
  ports: OrchestrationPorts,
  allocationId: string,
  signedTxHex: string,
): Promise<SubmitResult> {
  return runSubmit(kernel, ports, allocationId, signedTxHex, (candidate, id, hex) =>
    candidate.completeProtocol({ allocationId: id, signedTxHex: hex, delivery: "wallet" }));
}

/** Read-only per-input observations followed by a durable common conclusion; never broadcasts. */
export async function reconcileInputs(kernel: FundingKernel, ports: OrchestrationPorts, allocationId: string): Promise<SubmitResult> {
  const allocation = kernel.allocationView(allocationId);
  const commandId = `${allocationId}:broadcast`;
  const entry = kernel.outboxView().find(row => row.commandId === commandId);
  if (!entry) throw new UtmError("allocation-unknown", "outbox command not found");
  if (entry.allocationId !== allocationId) throw new UtmError("state-conflict", "outbox allocation mismatch");
  if (entry.state === "done") return { allocationId, txid: entry.txid, feeSats: allocation.feeSats, delivery: "accepted" };
  if (entry.state === "failed") return { allocationId, txid: entry.txid, feeSats: allocation.feeSats, delivery: "failed", conclusion: entry.conclusion };
  if (!ports.inputObserver) throw new UtmError("policy-denied", "input observation port unavailable");
  const exact = await loadExactOrMissing(ports.store, entry.txid);
  if (!exact || exact !== entry.rawTxHex) throw new UtmError("state-conflict", "durable exact missing or inconsistent");
  const parsed = parseTx(exact, entry.txid);
  let observations: InputObservation[];
  try { observations = await ports.inputObserver.observeInputs(parsed.inputs.map(i => `${i.txid}:${i.vout}`)) ?? []; } catch { observations = []; }
  const candidate = kernel.clone();
  const conclusion = candidate.resolveInputObservations(commandId, observations);
  const delivery = conclusion.status === "accepted" ? "accepted" : conclusion.status === "failed" ? "failed" : "unknown";
  const result: SubmitResult = { allocationId, txid: entry.txid, feeSats: allocation.feeSats, delivery, ...(conclusion.status === "conflict" || conclusion.status === "failed" ? { conclusion } : {}) };
  await ports.store.recordResult(commandId, JSON.stringify(result), candidate.serialize());
  await ports.fault?.("after-result-persist-before-publish");
  kernel.replaceFrom(candidate);
  return result;
}

/** One explicitly requested dispatch of the original durable exact. No scheduler or signer. */
export async function retryExact(
  kernel: FundingKernel,
  ports: OrchestrationPorts,
  allocationId: string,
): Promise<SubmitResult> {
  const allocation = kernel.allocationView(allocationId);
  const entry = kernel.outboxView().find(row => row.commandId === `${allocationId}:broadcast`);
  if (!entry) throw new UtmError("allocation-unknown", "outbox command not found");
  if (entry.allocationId !== allocationId) throw new UtmError("state-conflict", "outbox allocation mismatch");
  if (entry.state === "done") return { allocationId, txid: entry.txid, feeSats: allocation.feeSats, delivery: "accepted" };
  if (entry.state === "failed") return { allocationId, txid: entry.txid, feeSats: allocation.feeSats, delivery: "failed", conclusion: entry.conclusion };
  if (ports.inputObserver) {
    const result = await reconcileInputs(kernel, ports, allocationId);
    if (result.delivery !== "unknown" || result.conclusion?.status === "conflict") return result;
  } else if (entry.conclusion) return { allocationId, txid: entry.txid, feeSats: allocation.feeSats, delivery: "unknown", conclusion: entry.conclusion };
  if (entry.delivery !== "wallet") throw new UtmError("policy-denied", "external delivery cannot be retried by wallet");
  if (allocation.state !== "held") throw new UtmError("allocation-state", "only held allocations can retry exact");
  const exact = await loadExactOrMissing(ports.store, entry.txid);
  let sameExact = false;
  try { sameExact = exact === entry.rawTxHex && parseTx(exact!, entry.txid).canonicalTxid === entry.txid; } catch { /* fail closed */ }
  if (!sameExact) throw new UtmError("state-conflict", "durable exact missing or inconsistent");
  // The same intent, write-ahead dispatch, receipt validation and result persistence
  // path as ordinary/protocol submission; never rerun completion, selection or signing.
  return runSubmit(kernel, ports, allocationId, exact!, () => ({ txid: entry.txid, feeSats: allocation.feeSats }));
}

type Completer = (candidate: FundingKernel, allocationId: string, signedTxHex: string) => { txid: string; feeSats: string };

async function runSubmit(
  kernel: FundingKernel,
  ports: OrchestrationPorts,
  allocationId: string,
  signedTxHex: string,
  complete: Completer,
): Promise<SubmitResult> {
  let savedIntent: { allocationId: string; unsignedTxHex: string };
  try {
    const stored = await ports.store.loadIntent(allocationId);
    if (!stored) throw new Error("durable signing intent not found");
    savedIntent = JSON.parse(stored) as { allocationId: string; unsignedTxHex: string };
  } catch (error) {
    throw new UtmError("state-conflict", `cannot authorize signing result: ${(error as Error).message}`);
  }
  const intent = kernel.signingIntent(allocationId);
  if (!intent.durable || savedIntent.allocationId !== allocationId ||
      savedIntent.unsignedTxHex.toLowerCase() !== intent.unsignedTxHex) {
    throw new UtmError("state-conflict", "signed transaction has no matching durable intent");
  }

  const candidate = kernel.clone();
  const completed = complete(candidate, allocationId, signedTxHex);
  const commandId = `${allocationId}:broadcast`;
  const exactHex = signedTxHex.toLowerCase();
  candidate.markDispatching(commandId);
  const persisted = candidate.outboxView().find((entry) => entry.commandId === commandId);
  if (!persisted || persisted.rawTxHex !== exactHex || persisted.txid !== completed.txid) {
    throw new UtmError("state-conflict", "outbox bytes do not match signed transaction");
  }

  // One durable transaction: exact bytes + all kernel responsibility + the
  // dispatch intent. If it fails, the live held allocation remains occupied
  // and no provider call is made.
  await ports.store.saveDispatch(commandId, completed.txid, exactHex, candidate.serialize());
  kernel.replaceFrom(candidate);
  await ports.fault?.("after-dispatch-persist-before-broadcast");

  let outcome: BroadcastOutcome | null = null;
  let transportError = false;
  try {
    outcome = await ports.broadcaster.broadcast(persisted.rawTxHex);
  } catch {
    transportError = true;
  }
  await ports.fault?.("after-broadcast-before-result-persist");

  let delivery: SubmitResult["delivery"] = "unknown";
  let report: { status: "accepted" | "already-known" | "not-dispatched" | "unknown"; txid: string; rawTxHex?: string };
  let durableResult: string;
  if (!transportError && outcome?.status === "accepted") {
    let providerTxid: string | null = null;
    try { providerTxid = checkTxid(outcome.txid).toLowerCase(); } catch { /* remain unknown */ }
    if (providerTxid === completed.txid) {
      report = { status: "accepted", txid: completed.txid };
      durableResult = resultJson("done", completed.txid);
      delivery = "accepted";
    } else {
      report = { status: "unknown", txid: completed.txid };
      durableResult = resultJson("unknown", completed.txid, "txid-mismatch");
    }
  } else if (!transportError && outcome?.status === "already-known") {
    let sameExact = false;
    try {
      sameExact = checkTxid(outcome.txid).toLowerCase() === completed.txid &&
        parseTx(outcome.rawTxHex, completed.txid).canonicalTxid === completed.txid &&
        outcome.rawTxHex.toLowerCase() === exactHex;
    } catch { /* invalid provider bytes are an unknown result */ }
    if (sameExact) {
      report = { status: "already-known", txid: completed.txid, rawTxHex: outcome.rawTxHex };
      durableResult = resultJson("done", completed.txid);
      delivery = "already-known";
    } else {
      report = { status: "unknown", txid: completed.txid };
      durableResult = resultJson("unknown", completed.txid, "already-known-mismatch");
    }
  } else {
    const reason = outcome?.status === "not-dispatched" ? outcome.reason : transportError ? "transport-error" : "invalid-provider-outcome";
    report = { status: "unknown", txid: completed.txid };
    durableResult = resultJson("unknown", completed.txid, reason);
  }

  const resultCandidate = kernel.clone();
  try {
    resultCandidate.broadcastResult(commandId, report);
  } catch (error) {
    // A late receipt that conflicts with a trusted spender has already
    // isolated the affected inputs in the candidate. Persist that safety
    // state as unknown/conflict (never accepted), publish it, then report the
    // error to the caller.
    if (error instanceof UtmError && error.code === "state-conflict") {
      await ports.store.recordResult(
        commandId, resultJson("unknown", completed.txid, "result-conflict"), resultCandidate.serialize(),
      );
      await ports.fault?.("after-result-persist-before-publish");
      kernel.replaceFrom(resultCandidate);
    }
    throw error;
  }
  await ports.store.recordResult(commandId, durableResult, resultCandidate.serialize());
  await ports.fault?.("after-result-persist-before-publish");
  kernel.replaceFrom(resultCandidate);
  if (!transportError && outcome?.status === "conflict" && ports.inputObserver) return reconcileInputs(kernel, ports, allocationId);
  return { allocationId, txid: completed.txid, feeSats: completed.feeSats, delivery };
}

/**
 * Freeze a protocol intent durably before any signer runs. The caller must
 * persist this state before it touches the wallet's payment channel.
 */
export async function prepareProtocolIntent(
  kernel: FundingKernel,
  store: Pick<DurableStore, "saveIntent">,
  intent: ProtocolIntentInput,
): Promise<{ allocationId: string; unsignedTxHex: string; feeCapSats: string }> {
  const candidate = kernel.clone();
  const prepared = candidate.prepareProtocolIntent(intent);
  candidate.markSigningIntentDurable(intent.allocationId);
  const intentJson = JSON.stringify({
    allocationId: intent.allocationId,
    unsignedTxHex: prepared.unsignedTxHex,
    feeCapSats: prepared.feeCapSats,
    kind: intent.binding.kind,
    poolId: intent.binding.poolId,
  });
  await store.saveIntent(intent.allocationId, intentJson, candidate.serialize());
  kernel.replaceFrom(candidate);
  return prepared;
}

/**
 * Persist the exact signed bytes of a protocol intent. With
 * delivery = "external" the entry starts in the unknown state: the bytes
 * leave the wallet, so the wallet's own provider proves nothing about
 * whether they were broadcast. This write happens BEFORE the bytes are
 * handed outside (E01).
 */
export async function completeProtocolIntent(
  kernel: FundingKernel,
  store: Pick<DurableStore, "saveDispatch">,
  allocationId: string,
  signedTxHex: string,
  delivery: "wallet" | "external",
): Promise<{ allocationId: string; txid: string; feeSats: string }> {
  const candidate = kernel.clone();
  const completed = candidate.completeProtocol({ allocationId, signedTxHex, delivery });
  const commandId = `${allocationId}:broadcast`;
  const exactHex = signedTxHex.toLowerCase();
  const entry = candidate.outboxView().find((row) => row.commandId === commandId);
  if (!entry || entry.rawTxHex !== exactHex || entry.txid !== completed.txid) {
    throw new UtmError("state-conflict", "outbox bytes do not match signed transaction");
  }
  if (delivery === "external" && entry.state !== "unknown") {
    throw new UtmError("state-conflict", "external delivery must start in the unknown state");
  }
  await store.saveDispatch(commandId, completed.txid, exactHex, candidate.serialize());
  kernel.replaceFrom(candidate);
  return completed;
}

/**
 * Record a partial signature that leaves the wallet. The receiver may
 * complete and spend it, so the responsibility is persisted durably BEFORE
 * the signature is handed outside (E01). Without a durable state port the
 * host must refuse to deliver.
 */
export async function recordExternalSignature(
  kernel: FundingKernel,
  store: Pick<DurableStore, "saveState">,
  input: {
    id: string; allocationId: string; scope: string; draftTxHex: string; signatureHex: string;
    relatedInputs: string[]; reason: string; binding?: { kind: string; poolId: string };
  },
): Promise<string> {
  if (!store.saveState) {
    throw new UtmError("policy-denied", "host cannot persist external signature responsibility");
  }
  const candidate = kernel.clone();
  const id = candidate.recordExternalSignature(input);
  await store.saveState(candidate.serialize());
  kernel.replaceFrom(candidate);
  return id;
}

/** Reconcile an unknown outbox entry against the same exact chain transaction. */
export async function reconcileUnknown(
  kernel: FundingKernel,
  ports: OrchestrationPorts,
  allocationId: string,
): Promise<"committed" | "still-unknown" | "failed"> {
  const commandId = `${allocationId}:broadcast`;
  const entry = kernel.outboxView().find((candidate) => candidate.commandId === commandId);
  if (!entry) throw new UtmError("allocation-unknown", "outbox command not found");
  if (entry.state === "done") return "committed";
  if (entry.state === "failed") return "failed";
  if (entry.conclusion) return "still-unknown";

  let observed: string | null;
  try { observed = await ports.chain.observe(entry.txid); } catch { observed = null; }
  const candidate = kernel.clone();
  let result: "committed" | "still-unknown" | "failed";
  try {
    result = candidate.reconcile(commandId, observed ? { found: true, rawTxHex: observed } : { found: false });
  } catch (error) {
    if (error instanceof UtmError && error.code === "state-conflict") {
      await ports.store.recordResult(commandId, resultJson("unknown", entry.txid, "result-conflict"), candidate.serialize());
      await ports.fault?.("after-result-persist-before-publish");
      kernel.replaceFrom(candidate);
    }
    throw error;
  }
  await ports.store.recordResult(commandId, resultJson(result === "committed" ? "done" : result === "failed" ? "failed" : "unknown", entry.txid), candidate.serialize());
  await ports.fault?.("after-result-persist-before-publish");
  kernel.replaceFrom(candidate);
  return result;
}
