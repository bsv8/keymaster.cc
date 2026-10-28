// Deterministic funding kernel (utm/1). Pure: no clock, network, keys or
// filesystem. One instance serves one scope (owner + network); hosts create
// one manager per scope. All money uses canonical decimal strings / BigInt.
import { CONTRACT_VERSION, UtmError } from "./contract.js";
import { estimateFeeSats, formatAmount, parseAmount, parseFeeRate, sumChecked, addChecked, MAX_MONEY } from "./amounts.js";
import { buildUnsigned, checkTxid, estimateSignedSize, parseTx, type ParsedTx } from "./txcodec.js";
import { calcTxid } from "./hash.js";

export interface Scope {
  owner: string; // owner public key hex (identity, opaque to kernel)
  network: "main" | "test";
}

export interface ManagerConfig {
  /** Wallet's own locking script hex: the only script recognized as self. */
  walletScriptHex: string;
  /** Change below this is not created; leftover must still satisfy fee rules. */
  dustThresholdSats: string;
  /** Max unconfirmed ancestors a new spend may depend on. */
  maxUnconfirmedAncestors: number;
}

export interface SnapshotUtxo {
  txid: string;
  vout: number;
  value: string;
  scriptHex: string;
  status: "confirmed" | "unconfirmed";
  height: number;
}

export interface SnapshotInput {
  generation: number;
  revision: number; // scope-local monotonic WoC generation marker
  utxos: SnapshotUtxo[];
}

export interface RequestInput {
  requestId: string;
  businessAmountSats: string;
  feeRateSatPerKb: string;
  /** Non-wallet outputs the business wants (script + value). */
  outputs: Array<{ scriptHex: string; value: string }>;
  version?: number;
  locktime?: number;
}

export interface ExternalProof {
  value: string;
  scriptHex: string;
}

export interface PrepareInput {
  allocationId: string;
  unsignedTxHex: string;
  /** Trusted prevout evidence for non-wallet inputs; absent input = reject. */
  externalProofs?: Record<string, ExternalProof>;
  /** Protocol-bound spends with no wallet inputs (refund/close). */
  protocolBinding?: { kind: ProtocolBindingKind; poolId: string };
}

/**
 * How the miner fee of a protocol intent is authorized.
 * "rate" = the fee must be at least rate x actual size (the caller asked for
 * that rate); "exact" = the fee is a fixed difference the business already
 * approved, so only the ceiling applies and no rate floor is imposed.
 */
export type ProtocolFeePolicy = "rate" | "exact";

/**
 * Pre-signature protocol intent. The trusted adapter classifies every actual
 * input of the unsigned transaction and hands the kernel the exact bytes it
 * is about to sign. The kernel takes exclusive responsibility for the wallet
 * and protected inputs, binds the trusted proofs of the external inputs and
 * caps the miner fee. Nothing is signed before this is durable.
 */
export interface ProtocolIntentInput {
  allocationId: string;
  unsignedTxHex: string;
  inputs: ProtocolInputFact[];
  /** Hard miner-fee ceiling authorized for this transaction. */
  feeCapSats: string;
  feePolicy: ProtocolFeePolicy;
  binding: { kind: ProtocolBindingKind; poolId: string };
  externalProofs?: Record<string, ExternalProof>;
  /**
   * Protection sources this intent takes over.
   *
   * A protocol submission's own input claim is an occupation, not a fund
   * protection: the manager may take it over, but only by naming it here.
   * Every other protection source (a dedicated funding record, another
   * plugin, another submission's claim) keeps blocking the input and must be
   * proven as a real protocol protection instead.
   */
  claims?: string[];
}

export interface CompletePrepareInput {
  allocationId: string;
  signedTxHex: string;
}

export interface AllocationView {
  allocationId: string;
  requestId: string;
  inputs: string[]; // outpoint keys txid:vout
  totalInSats: string;
  businessSats: string;
  feeSats: string;
  changeSats: string;
  state: "held" | "committed" | "aborted" | "superseded";
}

interface StoredUtxo {
  value: bigint;
  scriptHex: string;
  status: "confirmed" | "unconfirmed";
  height: number;
  source: "woc" | "local" | "external";
  creatingTxid: string | null; // local outputs: parent txid
  /** Parent input outpoints of the creating tx (local outputs only). */
  parentInputs: string[] | null;
  /** WoC has reported this exact outpoint: ancestors stop here. */
  confirmed: boolean;
  spentBy: string | null; // tombstone: spending txid (local or external)
  spentExternal: boolean;
  occupiedBy: string | null; // allocationId
  protected: boolean;
  /**
   * Why this output is protected, one entry per protection source.
   *
   * A protocol submission's own input claim is an *occupation*, not a fund
   * protection; a dedicated funding record is a real protection. Keeping the
   * sources apart is what lets a manager take over its own claim without
   * dropping somebody else's protection on the same outpoint.
   */
  protectionSources: string[];
  isolated: string | null; // reason
  /** Parent broadcast is still unknown: not selectable until it settles. */
  pendingParent: string | null;
}

interface StoredAllocation {
  requestId: string;
  requestHash: string;
  inputs: string[];
  business: bigint;
  feeRate: bigint;
  fee: bigint;
  change: bigint;
  outputs: Array<{ scriptHex: string; value: bigint }>;
  version: number;
  locktime: number;
  externalProofs: Record<string, { value: bigint; scriptHex: string }>;
  protocolBinding: { kind: ProtocolBindingKind; poolId: string } | null;
  /** Classified actual inputs of a protocol intent (empty for ordinary). */
  protocolInputs: ProtocolInputFact[];
  /** Authorized miner-fee ceiling of a protocol intent ("" for ordinary). */
  protocolFeeCapSats: string;
  /** Miner-fee policy of a protocol intent ("" for ordinary). */
  protocolFeePolicy: ProtocolFeePolicy | "";
  /** Protection sources this intent takes over ("" claims of other parties). */
  protocolClaims: string[];
  signedTxid: string | null;
  signingIntentHex: string;
  signingIntentDurable: boolean;
  state: "held" | "committed" | "aborted" | "superseded";
}

export interface InputObservation {
  outpoint: string;
  status: "spent" | "unspent" | "unknown";
  txid?: string;
  vin?: number;
  confirmed?: boolean;
}
export interface SpentInputFact {
  outpoint: string;
  txid: string;
  vin: number | null;
  confirmed: boolean | null;
}
export interface InputConclusion {
  status: "accepted" | "unknown" | "conflict" | "failed";
  reason: string;
  releasedInputs: string[];
  spentInputs: SpentInputFact[];
  heldInputs: string[];
  releasedSats: string;
}

export interface OutboxEntry {
  commandId: string;
  /** Owning allocation; null for imported history without an anchor. */
  allocationId: string | null;
  txid: string;
  rawTxHex: string;
  /** pending = never attempted; dispatching = handed to the network port. */
  state: "pending" | "dispatching" | "done" | "unknown" | "failed";
  /**
   * Who is responsible for putting this exact transaction on the network.
   * "wallet" = this wallet's provider; "external" = the signed bytes were
   * handed to an outside party and may already be broadcast by them. The
   * two are never interchangeable: "the wallet did not dispatch" is not
   * proof that an externally delivered transaction was not broadcast.
   */
  delivery: "wallet" | "external";
  conclusion?: InputConclusion;
}

/**
 * Classification of one actual input of a protocol-bound transaction.
 * "wallet" = proven self P2PKH balance; "protected" = self P2PKH output
 * held under a protocol protection claim; "external" = a protocol input
 * outside the wallet balance, bound by a trusted prevout proof.
 */
export type ProtocolInputClass = "wallet" | "protected" | "external";

/**
 * What a protection source authorises.
 *
 * "occupation" = a protocol submission's own input occupation. It may be
 * taken over by the intent that created it, and it never protects the funds.
 * "fund" = a real fund protection (dedicated funding, another plugin). It
 * can never be taken over and it can never be downgraded to a plain wallet
 * input.
 * "legacy" = a protection recovered from an older state that carried no
 * source. It is never takeable: an unknown protection must keep blocking.
 */
export type ProtectionSourceKind = "occupation" | "fund" | "legacy";

/** The source string format is `<kind>:<owner>:<id>`. */
export function protectionSourceKind(source: string): ProtectionSourceKind {
  const kind = source.split(":", 1)[0];
  if (kind === "occupation") return "occupation";
  if (kind === "fund") return "fund";
  return "legacy";
}

/** The source string of a protocol submission's own input occupation. */
export function occupationSource(submissionId: string): string {
  return `occupation:${submissionId}`;
}

/** The source string of a real fund protection. */
export function fundSource(owner: string): string {
  return `fund:${owner}`;
}

/** Protocol roles a signed transaction may carry. */
export type ProtocolBindingKind = "refund" | "close" | "fund" | "state";

export interface ProtocolInputFact {
  outpoint: string;
  class: ProtocolInputClass;
  value: string;
  scriptHex: string;
  /** Trusted protocol claim id; required for "protected" inputs. */
  claimId: string | null;
}

/** A durable responsibility for a partial signature delivered outside. */
export interface ExternalSignatureRecord {
  id: string;
  allocationId: string;
  scope: string;
  binding: { kind: string; poolId: string } | null;
  draftTxHex: string;
  signatureHex: string;
  relatedInputs: string[];
  /**
   * The inputs the signed artifact actually spends, parsed from the exact
   * draft. The responsibility view reports these, not the caller's claim.
   */
  artifactInputs: string[];
  reason: string;
  /**
   * "responsible" = the signature may still be completed and spent.
   * "superseded" = a newer round exists, but the old signature is still a
   * valid artifact until trusted evidence retires it; it keeps its
   * responsibility and stays visible.
   * "settled" = trusted evidence retired it.
   */
  state: "responsible" | "superseded" | "quarantined" | "settled";
  /** The record that legitimately replaced this one (protocol rounds). */
  supersededBy?: string;
  /** Trusted evidence that retired this responsibility. */
  settledTxid?: string;
}

/**
 * The trusted, structured fact that retires an external signature
 * responsibility. There is no evidence-free settlement.
 */
export type ExternalSignatureEvidence =
  | {
      kind: "input-consumed";
      txid: string;
      /** Exact observed bytes provide self outputs, parent relation and spent inputs. */
      rawTxHex: string;
      inputs: string[];
    }
  | {
      kind: "signature-invalidated";
      /** Why the signature became unusable without consuming an input. */
      reason: string;
      txid?: string;
    };

/** Human-readable responsibility report (E04 traceability). */
export interface ResponsibilityView {
  commandId: string;
  allocationId: string | null;
  txid: string;
  state: OutboxEntry["state"];
  delivery: OutboxEntry["delivery"];
  reason: string;
  inputs: string[];
  totalInSats: string;
  ownOutputs: Array<{ outpoint: string; value: string }>;
}

interface SerializedState {
  version: "utm/1";
  scope: Scope;
  config: { walletScriptHex: string; dustThresholdSats: string; maxUnconfirmedAncestors: number };
  generation: number;
  wocRevision: number;
  localRevision: number;
  utxos: Record<string, {
    value: string; scriptHex: string; status: "confirmed" | "unconfirmed"; height: number;
    source: "woc" | "local" | "external"; creatingTxid: string | null; spentBy: string | null;
    spentExternal: boolean; occupiedBy: string | null; protected: boolean; protectionSources?: string[];
    isolated: string | null;
    pendingParent: string | null; parentInputs: string[] | null; confirmed: boolean;
  }>;
  allocations: Record<string, {
    requestId: string; requestHash: string; inputs: string[];
    business: string; feeRate: string; fee: string; change: string;
    outputs: Array<{ scriptHex: string; value: string }>;
    version: number; locktime: number;
    externalProofs: Record<string, { value: string; scriptHex: string }>;
    protocolBinding: { kind: ProtocolBindingKind; poolId: string } | null;
    protocolInputs: ProtocolInputFact[];
    protocolFeeCapSats: string;
    protocolFeePolicy?: ProtocolFeePolicy | "";
    protocolClaims?: string[];
    signedTxid: string | null; signingIntentHex?: string; signingIntentDurable?: boolean;
    state: "held" | "committed" | "aborted" | "superseded";
  }>;
  outbox: Array<Omit<OutboxEntry, "delivery"> & { delivery?: "wallet" | "external" }>;
  externalSignatures: ExternalSignatureRecord[];
  /** Set when a migrated responsibility cannot be scoped; blocks new funding. */
  fundsFrozen?: string;
}

function outpointKey(txid: string, vout: number): string {
  return `${txid.toLowerCase()}:${vout}`;
}

function checkedOutpoint(value: string): string {
  const parts = value.toLowerCase().split(":");
  if (parts.length !== 2) throw new UtmError("tx-invalid", "bad outpoint");
  if (!/^(0|[1-9][0-9]*)$/.test(parts[1]!)) throw new UtmError("tx-invalid", "bad vout");
  return outpointKey(checkTxid(parts[0]!), checkVout(Number(parts[1])));
}

/**
 * Isolation reasons that are scoped to the outpoint that carries them: the
 * transaction that created or spent it stays valid, and only that outpoint
 * (plus the descendants that depend on it) goes out of service.
 *
 * - "conflict:<txid>": two parties claim to spend the same outpoint.
 * - "woc-conflict:<value>:<script>": the chain reports different facts for
 *   this outpoint than the local record holds.
 * - "local-conflict:<outpoint>": two local records disagree about this
 *   outpoint.
 * - "external-spend-unknown": the chain reports an unknown spender and the
 *   outpoint's own facts are unknown.
 * - "protected-unknown": a protected placeholder whose facts are unknown.
 * - "external-signature-quarantine": the outpoint is held for an external
 *   signature responsibility.
 *
 * Only an explicitly listed reason may keep the sibling branch usable.
 */
function isOutputLevelIsolation(reason: string): boolean {
  return reason.startsWith("conflict:")
    || reason.startsWith("woc-conflict:")
    || reason.startsWith("local-conflict:")
    || reason === "external-spend-unknown"
    || reason === "protected-unknown"
    || reason === "external-signature-quarantine";
}

/**
 * Isolation reasons that mean the *transaction* that owns the outpoint is
 * broken, so the transaction and everything descending from it is invalid.
 *
 * - "commit-conflict:<txid>": the transaction lost the race for one of its
 *   inputs, so its change is quarantined.
 * - "ancestor-conflict:<outpoint>": the outpoint descends from a conflicted
 *   outpoint, so its creating transaction is invalid too.
 */
function isTransactionLevelIsolation(reason: string): boolean {
  return reason.startsWith("commit-conflict:") || reason.startsWith("ancestor-conflict:");
}

function checkVout(vout: unknown): number {
  if (!Number.isInteger(vout) || (vout as number) < 0 || (vout as number) > 0xffffffff) {
    throw new UtmError("tx-invalid", "bad vout");
  }
  return vout as number;
}

function checkScriptHex(scriptHex: unknown, what = "script"): string {
  if (typeof scriptHex !== "string") throw new UtmError("tx-invalid", `${what} must be hex`);
  const clean = /^0x/i.test(scriptHex) ? scriptHex.slice(2) : scriptHex;
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean) || clean.length / 2 > 10000) {
    throw new UtmError("tx-invalid", `${what} is not valid script hex`);
  }
  return canonicalScriptHex(scriptHex);
}

function canonicalScriptHex(scriptHex: string): string {
  return scriptHex.replace(/^0x/i, "").toLowerCase();
}

export function unsignedSkeleton(rawTxHex: string): string {
  const parsed = parseTx(rawTxHex);
  return buildUnsigned({
    version: parsed.version,
    locktime: parsed.locktime,
    inputs: parsed.inputs.map((input) => ({ txid: input.txid, vout: input.vout, sequence: input.sequence })),
    outputs: parsed.outputs.map((output) => ({ value: output.value.toString(10), scriptHex: output.scriptHex })),
  });
}

/**
 * Canonical digest of a protocol intent. Two intents are the same only when
 * the frozen skeleton, the classified inputs, the trusted proofs, the fee
 * policy, the binding and the declared outputs are all identical.
 */
function protocolIntentDigest(input: {
  skeleton: string;
  inputs: ProtocolInputFact[];
  proofs: Record<string, { value: bigint; scriptHex: string }>;
  feeCapSats: string;
  feePolicy: string;
  binding: { kind: string; poolId: string } | null;
  outputs: Array<{ scriptHex: string; value: bigint }>;
  claims: string[];
}): string {
  const proofs: Record<string, { value: string; scriptHex: string }> = {};
  for (const key of Object.keys(input.proofs).sort()) {
    const proof = input.proofs[key]!;
    proofs[key] = { value: formatAmount(proof.value), scriptHex: proof.scriptHex };
  }
  return calcTxid(new TextEncoder().encode(JSON.stringify({
    skeleton: input.skeleton,
    inputs: input.inputs.map((fact) => ({
      outpoint: fact.outpoint, class: fact.class, value: formatAmount(parseAmount(fact.value, "input value")),
      scriptHex: fact.scriptHex, claimId: fact.claimId,
    })),
    proofs,
    feeCapSats: input.feeCapSats,
    feePolicy: input.feePolicy,
    binding: input.binding,
    outputs: input.outputs.map((output) => ({ scriptHex: output.scriptHex, value: formatAmount(output.value) })),
    claims: [...input.claims].sort(),
  })));
}

function stableRequestHash(input: RequestInput): string {
  const normalized = {
    businessAmountSats: input.businessAmountSats,
    feeRateSatPerKb: input.feeRateSatPerKb,
    locktime: input.locktime ?? 0,
    outputs: [...input.outputs]
      .map((o) => ({ scriptHex: o.scriptHex.toLowerCase(), value: o.value }))
      .sort((a, b) => (a.scriptHex < b.scriptHex ? -1 : a.scriptHex > b.scriptHex ? 1 : a.value < b.value ? -1 : 1)),
    version: input.version ?? 1,
  };
  return JSON.stringify(normalized);
}

export class FundingKernel {
  private utxos = new Map<string, StoredUtxo>();
  private allocations = new Map<string, StoredAllocation>();
  private outbox: OutboxEntry[] = [];
  private externalSignatures = new Map<string, ExternalSignatureRecord>();
  private fundsFrozen: string | null = null;
  private generation = 0;
  private wocRevision = 0;
  private localRevision = 0;
  private readonly scopeValue: Scope;
  private readonly configValue: ManagerConfig;
  /** Detached views, equivalent to Go Scope()/Config() value returns. */
  get scope(): Scope { return { ...this.scopeValue }; }
  get config(): ManagerConfig { return { ...this.configValue }; }

  constructor(
    scope: Scope,
    config: ManagerConfig,
  ) {
    // The wallet supplies its initialized identity and configuration. Disk
    // recovery validates serialized data separately in restore().
    this.scopeValue = { ...scope };
    this.configValue = { ...config };
  }

  private bump(): void {
    this.localRevision += 1;
  }

  /**
   * A scope whose migrated responsibilities cannot be scoped must not sign or
   * allocate new money. Reads, snapshots, trusted observations and settlement
   * stay available so the host can resolve the quarantine.
   */
  private assertFundsNotFrozen(operation: string): void {
    if (this.fundsFrozen) {
      throw new UtmError("state-conflict", `cannot ${operation}: scope funds are frozen (${this.fundsFrozen})`);
    }
  }

  /**
   * Release quarantine held only by settled signature duties. A normal
   * snapshot or protection refresh never clears this reason.
   */
  private releaseOrphanSignatureQuarantine(): void {
    const covered = new Set<string>();
    for (const row of this.externalSignatures.values()) {
      if (row.state === "settled") continue;
      for (const key of [...row.relatedInputs, ...row.artifactInputs]) covered.add(key);
    }
    for (const [key, row] of this.utxos) {
      if (row.isolated !== "external-signature-quarantine" || covered.has(key)) continue;
      if (row.value === 0n && row.scriptHex === "" && !row.protected && !row.occupiedBy) {
        this.utxos.delete(key);
      } else {
        row.isolated = null;
      }
    }
  }

  /** Re-derive the migration freeze after a responsibility became terminal. */
  private refreshFundsFrozen(): void {
    if (this.fundsFrozen && !this.fundsFrozen.startsWith("migration:")) return;
    let first: string | null = null;
    for (const row of this.externalSignatures.values()) {
      if (row.state === "settled" || row.state !== "quarantined") continue;
      if (first === null || row.id < first) first = row.id;
    }
    this.fundsFrozen = first === null ? null : `migration:${first}`;
  }

  /** Work on a detached state candidate before durable commit. */
  clone(): FundingKernel {
    const candidate = new FundingKernel(this.scopeValue, this.configValue);
    candidate.replaceFrom(this);
    return candidate;
  }

  /** Publish a durably persisted internal candidate without reparsing disk data. */
  replaceFrom(candidate: FundingKernel): void {
    // Copy rather than share: failed writes and later candidate mutations must
    // never publish into the live state. Validation belongs to disk recovery,
    // not to a round trip through serialize/restore on every internal call.
    const state = structuredClone({
      utxos: candidate.utxos,
      allocations: candidate.allocations,
      outbox: candidate.outbox,
      externalSignatures: candidate.externalSignatures,
    });
    this.utxos = state.utxos;
    this.allocations = state.allocations;
    this.outbox = state.outbox;
    this.externalSignatures = state.externalSignatures;
    this.fundsFrozen = candidate.fundsFrozen;
    this.generation = candidate.generation;
    this.wocRevision = candidate.wocRevision;
    this.localRevision = candidate.localRevision;
  }

  /** Mark the validated template as durably recorded before signing. */
  markSigningIntentDurable(allocationId: string): void {
    this.assertFundsNotFrozen("mark a signing intent durable");
    const id = allocationId;
    const record = this.allocations.get(id);
    if (!record || !record.signingIntentHex) throw new UtmError("allocation-state", "signing intent was not prepared");
    record.signingIntentDurable = true;
    this.bump();
  }

  signingIntent(allocationId: string): { unsignedTxHex: string; durable: boolean } {
    const record = this.allocations.get(allocationId);
    if (!record) throw new UtmError("allocation-unknown", "allocation not found");
    return { unsignedTxHex: record.signingIntentHex, durable: record.signingIntentDurable };
  }

  // ---- snapshots ---------------------------------------------------------

  applySnapshot(input: SnapshotInput): { added: number; removed: number; isolated: string[] } {
    if (input.generation < this.generation) throw new UtmError("snapshot-stale", "older generation");
    if (input.generation === this.generation && input.revision <= this.wocRevision) {
      throw new UtmError("snapshot-stale", "revision did not advance");
    }
    // Convert the trusted observation batch before merging any state.
    const incoming = new Map<string, SnapshotUtxo>();
    for (const row of input.utxos) {
      const key = outpointKey(row.txid, row.vout);
      const value = parseAmount(row.value, "utxo value");
      const scriptHex = canonicalScriptHex(row.scriptHex);
      const prev = incoming.get(key);
      if (prev) {
        if (prev.value !== row.value || prev.scriptHex !== scriptHex) {
          throw new UtmError("outpoint-conflict", `conflicting duplicate ${key}`);
        }
        continue;
      }
      incoming.set(key, { txid: row.txid.toLowerCase(), vout: row.vout, value: formatAmount(value), scriptHex, status: row.status, height: row.height });
    }
    let added = 0;
    let removed = 0;
    const isolated: string[] = [];
    // Merge: never resurrect locally-spent inputs; never drop local change;
    // amount/script conflicts isolate; protected/occupied survive. A WoC
    // sighting confirms local outputs and prunes their ancestor subgraphs.
    for (const [key, row] of incoming) {
      const existing = this.utxos.get(key);
      if (existing) {
        if (existing.spentBy) continue; // tombstone wins over old snapshots
        if (existing.protected && existing.isolated === "protected-unknown" && existing.value === 0n && existing.scriptHex === "") {
          existing.value = parseAmount(row.value);
          existing.scriptHex = row.scriptHex;
          existing.status = row.status;
          existing.height = row.height;
          existing.confirmed = row.status === "confirmed" && row.height > 0;
          existing.isolated = null;
          continue;
        }
        if (existing.isolated !== null && existing.value === 0n && existing.scriptHex === "") {
          // A quarantined placeholder: adopt the real facts but keep the
          // isolation. A later normal snapshot must never clear it.
          existing.value = parseAmount(row.value);
          existing.scriptHex = row.scriptHex;
          existing.status = row.status;
          existing.height = row.height;
          existing.confirmed = row.status === "confirmed" && row.height > 0;
          continue;
        }
        if (formatAmount(existing.value) !== row.value || existing.scriptHex !== row.scriptHex) {
          existing.isolated = `woc-conflict:${row.value}:${row.scriptHex.slice(0, 16)}`;
          isolated.push(key);
          continue;
        }
        existing.status = row.status;
        existing.height = row.height;
        if (existing.source === "local" && existing.creatingTxid === null) existing.source = "woc";
        existing.confirmed = row.status === "confirmed" && row.height > 0;
        continue;
      }
      this.utxos.set(key, {
        value: parseAmount(row.value), scriptHex: row.scriptHex, status: row.status, height: row.height,
        source: "woc", creatingTxid: null, parentInputs: null, confirmed: row.status === "confirmed" && row.height > 0,
        spentBy: null, spentExternal: false,
        occupiedBy: null, protected: false, protectionSources: [], isolated: null, pendingParent: null,
      });
      added += 1;
    }
    for (const [key, existing] of this.utxos) {
      // Snapshot-first outputs retain WoC provenance when a later exact
      // receipt attaches creatingTxid. Their trusted local dependency must
      // survive a temporarily missing snapshot just like local-first change.
      if (existing.source === "local" || existing.creatingTxid !== null || existing.spentBy) continue;
      if (!incoming.has(key) && !existing.isolated) {
        // WoC no longer reports it: external spend or reorg. Keep a tombstone
        // only if we have no responsibility; occupied/protected stay as-is.
        if (!existing.occupiedBy && !existing.protected) {
          this.utxos.delete(key);
          removed += 1;
        }
      }
    }
    this.generation = input.generation;
    this.wocRevision = input.revision;
    this.bump();
    return { added, removed, isolated };
  }

  /**
   * Chain reports outpoint spent: tombstone it. If another tx already spent
   * it, the conflict is isolated transitively (the outpoint plus all
   * unconfirmed local descendants) instead of throwing: a network fact is
   * never a caller error. The first-seen spend stays canonical.
   */
  reportExternalSpend(outpoint: string, spendingTxid: string): void {
    const key = outpoint.toLowerCase();
    const spending = spendingTxid.toLowerCase();
    const existing = this.utxos.get(key);
    if (existing) {
      if (existing.spentBy && existing.spentBy !== spending) {
        existing.isolated = `conflict:${spending}`;
        this.isolateDescendants(key, `ancestor-conflict:${key}`);
      } else if (!existing.spentBy) {
        existing.spentBy = spending;
        existing.spentExternal = true;
        existing.occupiedBy = null;
      }
    } else {
      this.utxos.set(key, {
        value: 0n, scriptHex: "", status: "unconfirmed", height: 0, source: "woc",
        creatingTxid: null, parentInputs: null, confirmed: false,
        spentBy: spendingTxid.toLowerCase(), spentExternal: true,
        occupiedBy: null, protected: false, protectionSources: [], isolated: "external-spend-unknown", pendingParent: null,
      });
    }
    this.bump();
  }

  /** Isolate an outpoint and all unconfirmed local outputs descending from it. */
  private isolateDescendants(rootOutpoint: string, reason: string): void {
    const seen = new Set<string>([rootOutpoint]);
    const seenTxids = new Set<string>();
    const root = this.utxos.get(rootOutpoint);
    if (root?.spentBy) seenTxids.add(root.spentBy);
    let grown = true;
    while (grown) {
      grown = false;
      for (const [key, row] of this.utxos) {
        if (seen.has(key)) continue;
        const parents = row.parentInputs ?? [];
        // Dependency, not provenance: a WoC-seen output of a known parent is
        // still a descendant. creatingTxid covers outputs whose parent link
        // arrived after the snapshot.
        const depends = parents.some((p) => seen.has(p)) ||
          (row.creatingTxid !== null && seenTxids.has(row.creatingTxid));
        if (!depends) continue;
        seen.add(key);
        grown = true;
        if (row.creatingTxid) seenTxids.add(row.creatingTxid);
        // Spent outputs already moved their value; isolate only live ones.
        // Confirmed history stands.
        if (row.spentBy || row.isolated || row.confirmed) continue;
        row.isolated = reason;
        row.occupiedBy = null;
      }
    }
  }

  protectedOutpointKeys(): string[] {
    return [...this.utxos.entries()].filter(([, row]) => row.protected).map(([key]) => key).sort();
  }

  spendableOutpoints(): string[] {
    return this.candidates().map((candidate) => candidate.key);
  }

  /**
   * Protect or release outputs, remembering *why* each one is protected.
   *
   * `source` identifies the protection provider (for example
   * "protocol-claim:<submissionId>" or "protocol-funding:<fundingId>"). Sources
   * accumulate: an outpoint protected by two providers keeps both, so taking
   * over one of them never drops the other. Releasing clears every source of
   * that outpoint, so the refresh pattern "clear all, then re-add" stays
   * correct.
   */
  setProtected(outpoints: readonly string[], protect: boolean, source = ""): void {
    for (const raw of outpoints) {
      const key = raw.toLowerCase();
      const existing = this.utxos.get(key);
      if (existing) {
        if (!protect) {
          if (existing.isolated === "protected-unknown" && existing.value === 0n && existing.scriptHex === "") {
            this.utxos.delete(key);
            continue;
          }
          existing.protected = false;
          existing.protectionSources = [];
          if (existing.isolated === "protected-unknown") existing.isolated = null;
          continue;
        }
        existing.protected = true;
        if (!existing.protectionSources.includes(source)) {
          existing.protectionSources = [...existing.protectionSources, source].sort();
        }
        if (existing.isolated === "protected-unknown") {
          existing.isolated = null;
        }
      } else if (protect) {
        this.utxos.set(key, {
          value: 0n, scriptHex: "", status: "unconfirmed", height: 0, source: "woc",
          creatingTxid: null, parentInputs: null, confirmed: false,
          spentBy: null, spentExternal: false, occupiedBy: null,
          protected: true, protectionSources: [source], isolated: "protected-unknown", pendingParent: null,
        });
      }
    }
    this.bump();
  }

  // ---- selection ----------------------------------------------------------

  private candidates(): Array<{ key: string; value: bigint; txid: string; vout: number }> {
    const out: Array<{ key: string; value: bigint; txid: string; vout: number }> = [];
    if (this.fundsFrozen) return out;
    for (const [key, row] of this.utxos) {
      if (row.spentBy || row.occupiedBy || row.protected || row.isolated || row.pendingParent) continue;
      if (row.scriptHex !== this.config.walletScriptHex) continue; // only proven self script is selectable
      const [txid, voutStr] = key.split(":");
      out.push({ key, value: row.value, txid: txid!, vout: Number(voutStr) });
    }
    out.sort((a, b) => {
      if (a.value !== b.value) return a.value > b.value ? -1 : 1;
      if (a.txid !== b.txid) return a.txid < b.txid ? -1 : 1;
      return a.vout - b.vout;
    });
    return out;
  }

  request(input: RequestInput): AllocationView {
    this.assertFundsNotFrozen("request funds");
    const requestId = input.requestId;
    const business = parseAmount(input.businessAmountSats, "business amount");
    if (business <= 0n) throw new UtmError("policy-denied", "business amount must be positive");
    const feeRate = parseFeeRate(input.feeRateSatPerKb);
    const version = input.version ?? 1;
    const locktime = input.locktime ?? 0;
    const outputs = input.outputs.map((o) => ({ scriptHex: canonicalScriptHex(o.scriptHex), value: parseAmount(o.value, "output value") }));
    if (outputs.length === 0) throw new UtmError("policy-denied", "at least one business output is required");
    const businessSum = sumChecked(outputs.map((o) => o.value), "business outputs");
    if (businessSum > business) throw new UtmError("policy-denied", "business outputs exceed authorized amount");
    const existing = this.allocations.get(requestId);
    if (existing) {
      if (existing.requestHash === stableRequestHash({ ...input, outputs: input.outputs })) return this.view(requestId, existing);
      throw new UtmError("id-conflict", "same id with different content");
    }
    const pool = this.candidates();
    if (pool.length === 0) throw new UtmError("no-utxos", "no spendable utxos");
    const scriptLens = outputs.map((o) => o.scriptHex.length / 2);
    const dust = parseAmount(this.config.dustThresholdSats, "dust");
    const chosen: typeof pool = [];
    let total = 0n;
    let fee = 0n;
    let change = 0n;
    for (let i = 0; i < pool.length; i++) {
      chosen.push(pool[i]!);
      total = total + pool[i]!.value;
      if (total > MAX_MONEY) throw new UtmError("amount-invalid", "selected total overflows");
      const withChange = estimateFeeSats(feeRate, estimateSignedSize(chosen.length, [...scriptLens, this.config.walletScriptHex.length / 2]));
      if (total >= business + withChange + dust) {
        fee = withChange;
        change = total - business - withChange;
        break;
      }
      if (i === pool.length - 1) {
        const noChange = estimateFeeSats(feeRate, estimateSignedSize(chosen.length, scriptLens));
        if (total >= business + noChange) {
          fee = total - business;
          change = 0n;
          if (fee < noChange) throw new UtmError("insufficient", "fee short of no-change minimum");
          break;
        }
      }
    }
    if (chosen.length === 0 || (change === 0n && fee === 0n)) {
      const need = business;
      const have = pool.reduce((s, c) => s + c.value, 0n);
      throw new UtmError("insufficient", `need ${need} plus fee, have ${have}`);
    }
    const record: StoredAllocation = {
      requestId, requestHash: stableRequestHash({ ...input, outputs: input.outputs }),
      inputs: chosen.map((c) => c.key), business, feeRate, fee, change,
      outputs, version, locktime, externalProofs: {}, protocolBinding: null,
      protocolInputs: [], protocolFeeCapSats: "", protocolFeePolicy: "", protocolClaims: [],
      signedTxid: null,
      signingIntentHex: "", signingIntentDurable: false, state: "held",
    };
    for (const c of chosen) this.utxos.get(c.key)!.occupiedBy = requestId;
    this.allocations.set(requestId, record);
    this.bump();
    return this.view(requestId, record);
  }

  replace(allocationId: string, input: RequestInput): AllocationView {
    this.assertFundsNotFrozen("replace an allocation");
    const id = allocationId;
    const current = this.allocations.get(id);
    if (!current) throw new UtmError("allocation-unknown", "allocation not found");
    if (current.state !== "held") throw new UtmError("allocation-state", `cannot replace from ${current.state}`);
    if (current.signedTxid) throw new UtmError("allocation-state", "signed allocation cannot be replaced");
    this.assertNoExternalResponsibility(id);
    for (const key of current.inputs) {
      const row = this.utxos.get(key);
      if (row && row.occupiedBy === id) row.occupiedBy = null;
    }
    this.allocations.delete(id);
    try {
      return this.request({ ...input, requestId: id });
    } catch (error) {
      // Roll back to the previous occupation on failure.
      this.allocations.set(id, current);
      for (const key of current.inputs) {
        const row = this.utxos.get(key);
        if (row && !row.spentBy) row.occupiedBy = id;
      }
      throw error;
    }
  }

  /** Release only an unsigned, undispatched, unexposed held allocation. */
  release(allocationId: string): void {
    this.assertFundsNotFrozen("release an allocation");
    const id = allocationId;
    const current = this.allocations.get(id);
    if (!current) throw new UtmError("allocation-unknown", "allocation not found");
    if (current.state !== "held") throw new UtmError("allocation-state", `cannot release from ${current.state}`);
    if (current.signedTxid) throw new UtmError("allocation-state", "signed allocation cannot be released");
    this.assertNoExternalResponsibility(id);
    for (const key of current.inputs) {
      const row = this.utxos.get(key);
      if (row && row.occupiedBy === id) row.occupiedBy = null;
    }
    current.state = "aborted";
    this.bump();
  }

  /**
   * A partial signature that already left the wallet keeps its inputs
   * responsible. Only a trusted terminal state (settle / supersede) clears it.
   */
  private assertNoExternalResponsibility(allocationId: string): void {
    const responsibility = this.externalResponsibilityFor(allocationId);
    if (responsibility) {
      throw new UtmError(
        "allocation-state",
        `allocation holds an external signature responsibility (${responsibility.id}); it cannot be released`,
      );
    }
  }

  /**
   * Protocol anchor allocation: business may be "0" and declared outputs
   * may be empty (pure inbound payouts such as refunds declare nothing).
   * No inputs are selected up front: protocol inputs are validated and
   * authorized at spend time by validateProtocolSpend.
   */
  requestProtocol(input: RequestInput): AllocationView {
    this.assertFundsNotFrozen("request protocol funds");
    const requestId = input.requestId;
    const business = parseAmount(input.businessAmountSats, "business amount");
    const feeRate = parseFeeRate(input.feeRateSatPerKb);
    const version = input.version ?? 1;
    const locktime = input.locktime ?? 0;
    const outputs = input.outputs.map((o) => ({ scriptHex: canonicalScriptHex(o.scriptHex), value: parseAmount(o.value, "output value") }));
    // No business-sum gate here: declared outputs are an exact-match binding
    // list (often funded by external pool inputs); the wallet's net outflow
    // is capped at spend time by business + fee share.
    const existing = this.allocations.get(requestId);
    if (existing) {
      if (existing.requestHash === stableRequestHash({ ...input, outputs: input.outputs })) return this.view(requestId, existing);
      throw new UtmError("id-conflict", "same id with different content");
    }
    const record: StoredAllocation = {
      requestId, requestHash: stableRequestHash({ ...input, outputs: input.outputs }),
      inputs: [], business, feeRate, fee: 0n, change: 0n,
      outputs, version, locktime, externalProofs: {}, protocolBinding: null,
      protocolInputs: [], protocolFeeCapSats: "", protocolFeePolicy: "", protocolClaims: [],
      signedTxid: null,
      signingIntentHex: "", signingIntentDurable: false, state: "held",
    };
    this.allocations.set(requestId, record);
    this.bump();
    return this.view(requestId, record);
  }

  // ---- submit validation ----------------------------------------------------

  /**
   * Validate the unsigned template against the allocation: inputs must match
   * exactly; outputs must be the authorized business outputs plus at most one
   * self change output with the exact change value.
   */
  prepare(input: PrepareInput): { allocationId: string; unsignedTxHex: string; estimatedFeeSats: string } {
    this.assertFundsNotFrozen("prepare a signing intent");
    const id = input.allocationId;
    const record = this.allocations.get(id);
    if (!record) throw new UtmError("allocation-unknown", "allocation not found");
    if (record.state !== "held") throw new UtmError("allocation-state", `cannot prepare from ${record.state}`);
    const parsed = parseTx(input.unsignedTxHex);
    const inputKeys = parsed.inputs.map((i) => `${i.txid}:${i.vout}`);
    if (inputKeys.length !== record.inputs.length || ![...record.inputs].sort().every((k, i) => k === [...inputKeys].sort()[i])) {
      throw new UtmError("snapshot-input-invalid", "template inputs do not match allocation");
    }
    for (const key of inputKeys) {
      const row = this.utxos.get(key);
      if (!row || row.spentBy || row.isolated || row.protected || row.pendingParent) throw new UtmError("snapshot-input-invalid", `input ${key} is not spendable`);
      if (row.occupiedBy !== id) throw new UtmError("already-occupied", `input ${key} is not held by this allocation`);
      if (row.scriptHex !== this.config.walletScriptHex) throw new UtmError("unknown-input", `input ${key} is not a proven wallet input`);
    }
    this.checkAncestors(inputKeys);
    // Outputs: authorized business outputs (exact script+value multiset) + optional exact change to self.
    const remaining = record.outputs.map((o) => ({ ...o }));
    let changeSeen = 0n;
    let changeCount = 0;
    for (const out of parsed.outputs) {
      const script = out.scriptHex.toLowerCase();
      const idx = remaining.findIndex((r) => r.scriptHex === script && r.value === out.value);
      if (idx >= 0) {
        remaining.splice(idx, 1);
        continue;
      }
      if (script === this.config.walletScriptHex) {
        changeSeen += out.value;
        changeCount += 1;
        continue;
      }
      throw new UtmError("policy-denied", "template has an unauthorized output");
    }
    if (remaining.length !== 0) throw new UtmError("policy-denied", "template misses authorized business outputs");
    if (changeCount > 1) throw new UtmError("policy-denied", "at most one change output is allowed");
    if (changeSeen !== record.change) throw new UtmError("fee-out-of-range", "change does not match authorized fee");
    if (parsed.version !== record.version || parsed.locktime !== record.locktime) {
      throw new UtmError("policy-denied", "version/locktime mismatch");
    }
    const skeleton = unsignedSkeleton(input.unsignedTxHex);
    if (record.signingIntentHex && record.signingIntentHex !== skeleton) {
      throw new UtmError("state-conflict", "transaction differs from frozen signing intent");
    }
    if (!record.signingIntentHex) record.signingIntentHex = skeleton;
    this.bump();
    return { allocationId: id, unsignedTxHex: input.unsignedTxHex.toLowerCase(), estimatedFeeSats: formatAmount(record.fee) };
  }

  /**
   * Walk the full dependency graph above an outpoint. Counts distinct
   * UNCONFIRMED ancestor transactions (multi-parent merges count every
   * branch); confirmed WoC history stops a branch. Exceeding
   * maxUnconfirmedAncestors, unknown parents, external conflicts and
   * cycles all fail closed.
   */
  private checkAncestors(outpoints: readonly string[]): void {
    const ancestorTxids = new Set<string>();
    const visitedOutpoints = new Set<string>();
    const activeOutpoints = new Set<string>();
    const activeTxids = new Set<string>();
    const visit = (current: string): void => {
      if (activeOutpoints.has(current)) throw new UtmError("ancestor-conflict", "dependency cycle");
      if (visitedOutpoints.has(current)) return; // a shared DAG ancestor is visited once
      activeOutpoints.add(current);
      const row = this.utxos.get(current);
      if (row?.isolated) throw new UtmError("ancestor-conflict", `ancestor ${current} is isolated`);
      if (row?.creatingTxid && !row.confirmed) {
        const parentTxid = row.creatingTxid;
        if (activeTxids.has(parentTxid)) throw new UtmError("ancestor-conflict", "dependency cycle");
        ancestorTxids.add(parentTxid);
        if (ancestorTxids.size > this.config.maxUnconfirmedAncestors) {
          throw new UtmError("policy-denied", "unconfirmed ancestor limit exceeded");
        }
        // A parent is known only from a trusted, settled exact — not from
        // this output's own creatingTxid, and not from a pending/unknown
        // broadcast. `spentExternal` is provenance, never a conflict flag.
        const parentEntry = this.outbox.find((entry) => entry.txid === parentTxid && entry.state === "done");
        if (!parentEntry) throw new UtmError("ancestor-unknown", `parent ${parentTxid} is unknown`);
        let parentExact: ParsedTx;
        try { parentExact = parseTx(parentEntry.rawTxHex, parentTxid); }
        catch { throw new UtmError("ancestor-conflict", `parent ${parentTxid} exact bytes are invalid`); }
        const [, currentVoutText] = current.split(":");
        const currentOutput = parentExact.outputs[Number(currentVoutText)];
        if (!currentOutput || currentOutput.value !== row.value || currentOutput.scriptHex.toLowerCase() !== row.scriptHex) {
          throw new UtmError("ancestor-conflict", `output ${current} does not match its parent exact`);
        }
        // "The parent transaction is invalid" and "one of the parent's
        // outputs is unusable" are two different facts and must never be
        // merged into one flag. The dependency direction decides which is
        // which:
        //
        // * INPUT of the parent — upstream. An isolated input, or an input
        //   another spender already claimed, means the parent itself cannot
        //   be trusted: it double-spends or descends from a broken lineage.
        //   The parent and everything below it are refused.
        // * OUTPUT of the parent — downstream. A competing spend of one
        //   output says nothing about the transaction that created it: only
        //   that output (and the descendants that depend on it) goes out of
        //   service, while the parent and its sibling outputs stay valid.
        //   Otherwise one contested output would freeze unrelated funds.
        //   The output level is an explicit allow list: a reason this
        //   version does not know is NOT treated as output level, it fails
        //   closed like a transaction level reason.
        const parentInputKeys = new Set(parentExact.inputs.map((i) => `${i.txid}:${i.vout}`));
        for (const [key, row] of this.utxos) {
          // A row that records the parent as its spender is one of the
          // parent's inputs, even when the exact bytes disagree.
          if (!parentInputKeys.has(key) && row.spentBy !== parentTxid) continue;
          if (row.isolated !== null) {
            throw new UtmError("ancestor-conflict", `parent ${parentTxid} input ${key} is isolated`);
          }
          if (row.spentBy !== null && row.spentBy !== parentTxid) {
            throw new UtmError("ancestor-conflict", `parent ${parentTxid} consumption disagrees at ${key}`);
          }
        }
        // The parent's own transaction is broken: its change was quarantined
        // because the transaction itself lost the race, or because an
        // ancestor conflicted. The parent and its descendants are invalid.
        for (const [key, row] of this.utxos) {
          if (row.creatingTxid !== parentTxid || row.isolated === null) continue;
          if (isTransactionLevelIsolation(row.isolated)) {
            throw new UtmError("ancestor-conflict", `parent ${parentTxid} conflicts at ${key}`);
          }
          if (!isOutputLevelIsolation(row.isolated)) {
            // An unknown reason: keep it (never silently clear it) and refuse
            // the whole branch until it is understood.
            const reason = [...row.isolated].slice(0, 64).join("");
            throw new UtmError(
              "ancestor-conflict",
              `parent ${parentTxid} carries an unknown isolation reason "${reason}" at ${key}`,
            );
          }
        }
        activeTxids.add(parentTxid);
        for (const parent of row.parentInputs ?? []) visit(parent);
        activeTxids.delete(parentTxid);
      }
      activeOutpoints.delete(current);
      visitedOutpoints.add(current);
    };
    for (const outpoint of outpoints) visit(outpoint);
  }

  /**
   * Match a transaction's outputs against the anchor's declared manifest.
   *
   * Declared outputs (business payouts AND protocol-earmarked self outputs
   * such as a dedicated funding output) are consumed by script+value. At most
   * one undeclared self output may remain: that is ordinary change. Any
   * other undeclared output is a policy violation.
   */
  private matchProtocolOutputs(
    declared: Array<{ scriptHex: string; value: bigint }>,
    outputs: Array<{ value: bigint; scriptHex: string }>,
  ): { ownOut: bigint[]; change: bigint } {
    const remaining = declared.map((output) => ({ ...output }));
    const ownOut: bigint[] = [];
    let change = 0n;
    let changeCount = 0;
    for (const out of outputs) {
      const script = out.scriptHex.toLowerCase();
      const index = remaining.findIndex((r) => r.scriptHex === script && r.value === out.value);
      if (index >= 0) {
        remaining.splice(index, 1);
        if (script === this.config.walletScriptHex) ownOut.push(out.value);
        continue;
      }
      if (script === this.config.walletScriptHex) {
        change = out.value;
        changeCount += 1;
        ownOut.push(out.value);
        continue;
      }
      throw new UtmError("policy-denied", "protocol template has an undeclared non-self output");
    }
    if (remaining.length !== 0) throw new UtmError("policy-denied", "protocol template misses declared outputs");
    if (changeCount > 1) throw new UtmError("policy-denied", "at most one change output is allowed");
    return { ownOut, change };
  }

  /**
   * Validate the signed transaction: same checks as prepare plus fee-range
   * proof (actual size floor vs frozen estimate ceiling) and per-input
   * signature-size bound (P2PKH weight 148).
   */
  completePrepare(input: CompletePrepareInput): { allocationId: string; txid: string; feeSats: string } {
    this.assertFundsNotFrozen("complete a wallet spend");
    const id = input.allocationId;
    const record = this.allocations.get(id);
    if (!record) throw new UtmError("allocation-unknown", "allocation not found");
    if (record.state !== "held") throw new UtmError("allocation-state", `cannot complete from ${record.state}`);
    const parsed = parseTx(input.signedTxHex);
    for (const txIn of parsed.inputs) {
      const scriptBytes = txIn.scriptSigHex.length / 2;
      if (scriptBytes > 148) throw new UtmError("signature-exceeds-bound", `input ${txIn.txid}:${txIn.vout} script exceeds P2PKH bound`);
    }
    // Re-run template checks against the signed bytes (same shapes).
    this.prepare({ allocationId: id, unsignedTxHex: input.signedTxHex });
    const totalIn = sumChecked(record.inputs.map((k) => this.utxos.get(k)!.value), "inputs");
    const totalOut = sumChecked(parsed.outputs.map((o) => o.value), "outputs");
    if (totalOut > totalIn) throw new UtmError("fee-out-of-range", "outputs exceed inputs");
    const actualFee = totalIn - totalOut;
    const feeFloor = estimateFeeSats(record.feeRate, BigInt(parsed.sizeBytes));
    // The authorized estimate is the ceiling here: change-exactness forces
    // actualFee == record.fee, and the no-change path legitimately absorbs
    // dust above the with-change estimate. Protocol spends (which have no
    // such anchor) additionally enforce the shape-derived ceiling.
    if (actualFee < feeFloor) throw new UtmError("fee-out-of-range", "fee below actual-size minimum");
    if (actualFee > record.fee) throw new UtmError("fee-out-of-range", "fee above authorized estimate");
    record.signedTxid = parsed.canonicalTxid;
    record.fee = actualFee;
    const outboxId = `${id}:broadcast`;
    const existingOutbox = this.outbox.find((e) => e.commandId === outboxId);
    if (!existingOutbox) {
      this.outbox.push({ commandId: outboxId, allocationId: id, txid: parsed.canonicalTxid, rawTxHex: input.signedTxHex.toLowerCase(), state: "pending", delivery: "wallet" });
    } else if (existingOutbox.txid !== parsed.canonicalTxid) {
      throw new UtmError("state-conflict", "outbox already holds another tx for this allocation");
    }
    this.bump();
    return { allocationId: id, txid: parsed.canonicalTxid, feeSats: formatAmount(actualFee) };
  }

  // ---- broadcast settlement --------------------------------------------------

  /**
   * Mark an entry as handed to the network port. Must be persisted before
   * the broadcast call; a crash afterwards recovers as unknown (query or
   * replay the SAME exact tx), never as droppable. Idempotent.
   */
  /** Trusted spent facts, not HTTP text. Call on a detached candidate and persist before publication. */
  resolveInputObservations(commandId: string, observations: InputObservation[] | null = []): InputConclusion {
    const entry = this.outbox.find(e => e.commandId === commandId);
    if (!entry) throw new UtmError("allocation-unknown", "outbox command not found");
    if (entry.state === "done") return { status: "accepted", reason: "", releasedInputs: [], spentInputs: [], heldInputs: [], releasedSats: "0" };
    if (entry.state === "failed" && entry.conclusion) return structuredClone(entry.conclusion);
    if (!entry.allocationId || entry.delivery !== "wallet") throw new UtmError("policy-denied", "input resolution requires wallet allocation");
    const allocation = this.allocations.get(entry.allocationId);
    if (!allocation || allocation.signedTxid !== entry.txid || allocation.state !== "held") throw new UtmError("allocation-state", "input resolution requires original signed allocation");
    const parsed = parseTx(entry.rawTxHex, entry.txid);
    const keys = parsed.inputs.map(i => `${i.txid}:${i.vout}`);
    if (keys.length !== allocation.inputs.length || keys.some(key => !allocation.inputs.includes(key))) throw new UtmError("policy-denied", "exact inputs do not match allocation responsibility");
    const supplied = new Map<string, InputObservation>();
    for (const fact of observations ?? []) {
      if (!keys.includes(fact.outpoint) || supplied.has(fact.outpoint)) throw new UtmError("policy-denied", "input observation does not match the responsible inputs");
      if (fact.status === "spent" && fact.txid === entry.txid && fact.vin !== keys.indexOf(fact.outpoint)) throw new UtmError("policy-denied", "self spender vin mismatch");
      supplied.set(fact.outpoint, fact);
    }
    const priorSpent = new Map((entry.conclusion?.spentInputs ?? []).map(f => [f.outpoint, f]));
    const spent: SpentInputFact[] = [];
    let self = false;
    let other = false;
    for (const key of keys) {
      if (entry.conclusion?.releasedInputs.includes(key)) continue;
      const fact = supplied.get(key);
      const local = this.utxos.get(key)?.spentBy ?? priorSpent.get(key)?.txid;
      if (fact?.status === "spent" && fact.txid === entry.txid) self = true;
      if ((local && local !== entry.txid) || (fact?.status === "spent" && fact.txid !== entry.txid)) other = true;
      if (local === entry.txid) self = true;
      if (local && local !== entry.txid) {
        const previous = priorSpent.get(key) ?? { outpoint: key, txid: local, vin: null, confirmed: null };
        if (fact?.status === "spent" && fact.txid === previous.txid) {
          if (previous.vin !== null && previous.vin !== fact.vin) throw new UtmError("state-conflict", "spender vin changed");
          spent.push({ ...previous, vin: fact.vin!, confirmed: previous.confirmed === true || fact.confirmed! });
        } else spent.push({ ...previous });
      }
      else if (fact?.status === "spent" && fact.txid !== entry.txid) spent.push({ outpoint: key, txid: fact.txid!, vin: fact.vin!, confirmed: fact.confirmed! });
    }
    if (self && other) throw new UtmError("state-conflict", "inconsistent self/other spender evidence");
    if (self) {
      this.broadcastResult(commandId, { status: "accepted", txid: entry.txid });
      return { status: "accepted", reason: "", releasedInputs: [], spentInputs: [], heldInputs: [], releasedSats: "0" };
    }
    if (!other) return { status: "unknown", reason: "", releasedInputs: [], spentInputs: [], heldInputs: [...keys], releasedSats: "0" };
    for (const fact of spent) this.reportExternalSpend(fact.outpoint, fact.txid);
    // Never enable outputs of the disproven exact or its descendants.
    parsed.outputs.forEach((out, index) => {
      if (out.scriptHex !== this.config.walletScriptHex) return;
      const key = `${entry.txid}:${index}`;
      const row = this.utxos.get(key);
      if (row) row.isolated = row.isolated ?? `commit-conflict:${entry.txid}`;
      else this.utxos.set(key, { value: out.value, scriptHex: out.scriptHex, status: "unconfirmed", height: 0, source: "local", creatingTxid: entry.txid, parentInputs: [...keys], confirmed: false, spentBy: null, spentExternal: false, occupiedBy: null, protected: false, protectionSources: [], isolated: `commit-conflict:${entry.txid}`, pendingParent: null });
      this.isolateDescendants(key, `commit-conflict:${entry.txid}`);
    });
    const released = new Set(entry.conclusion?.releasedInputs ?? []);
    const spentKeys = new Set(spent.map(f => f.outpoint));
    const held: string[] = [];
    for (const key of keys) {
      if (spentKeys.has(key) || released.has(key)) continue;
      const row = this.utxos.get(key);
      const fact = supplied.get(key);
      const duty = [...this.externalSignatures.values()].some(r => r.state !== "settled" && (r.relatedInputs.includes(key) || r.artifactInputs.includes(key)));
      if (fact?.status === "unspent" && row && !row.spentBy && row.occupiedBy === entry.allocationId && !row.protected && !row.isolated && !row.pendingParent && !duty) {
        row.occupiedBy = null;
        // A proof of unspent cannot make an invalid/unknown ancestor usable.
        if (row.scriptHex !== this.config.walletScriptHex || this.spendableOutpoints().includes(key)) released.add(key);
        else row.occupiedBy = entry.allocationId;
      }
      if (!released.has(key)) held.push(key);
    }
    const releasedInputs = keys.filter(key => released.has(key));
    const releasedSats = releasedInputs.reduce((sum, key) => sum + (this.utxos.get(key)?.scriptHex === this.config.walletScriptHex ? this.utxos.get(key)!.value : 0n), 0n);
    const conclusion: InputConclusion = { status: held.length ? "conflict" : "failed", reason: "input-conflict", releasedInputs, spentInputs: spent, heldInputs: held, releasedSats: formatAmount(releasedSats) };
    entry.conclusion = conclusion;
    entry.state = held.length ? "unknown" : "failed";
    if (!held.length) allocation.state = "aborted";
    this.bump();
    return structuredClone(conclusion);
  }

  markDispatching(commandId: string): void {
    const entry = this.outbox.find((e) => e.commandId === commandId);
    if (!entry) throw new UtmError("allocation-unknown", "outbox command not found");
    if (entry.conclusion) throw new UtmError("allocation-state", "conflicting exact cannot be redispatched");
    if (entry.state === "pending" || entry.state === "unknown") {
      entry.state = "dispatching";
      this.bump();
    }
  }

  broadcastResult(commandId: string, result: { status: "accepted" | "already-known" | "not-dispatched" | "unknown"; txid: string; rawTxHex?: string }): void {
    const entry = this.outbox.find((e) => e.commandId === commandId);
    if (!entry) throw new UtmError("allocation-unknown", "outbox command not found");
    if (entry.state === "done") return; // idempotent replay
    if (entry.conclusion) {
      if (result.status === "accepted" || result.status === "already-known") throw new UtmError("state-conflict", "accepted receipt contradicts proven input conflict");
      return; // unknown cannot erase a stronger conclusion
    }
    const txid = checkTxid(result.txid).toLowerCase();
    if (txid !== entry.txid) throw new UtmError("state-conflict", "broadcast txid does not match outbox");
    if (result.status === "accepted" || result.status === "already-known") {
      if (result.status === "already-known") {
        if (!result.rawTxHex) throw new UtmError("policy-denied", "already-known requires provider bytes");
        const observed = parseTx(result.rawTxHex, entry.txid);
        const local = parseTx(entry.rawTxHex, entry.txid);
        if (observed.canonicalTxid !== local.canonicalTxid) throw new UtmError("state-conflict", "provider tx differs from local exact");
      }
      this.commitOutbox(entry);
      entry.state = "done";
    } else if (result.status === "not-dispatched") {
      entry.state = "unknown"; // carrier is unsure; keep responsibility, allow reconcile, never auto-release
      this.markUnknown(entry);
    } else {
      entry.state = "unknown";
      this.markUnknown(entry);
    }
    this.bump();
  }

  /**
   * Merge one self output of an exact transaction into the outpoint view.
   *
   * The same outpoint/value/script is NOT a conflict just because WoC saw it
   * first. A snapshot-confirmed output keeps its confirmation, protection,
   * occupation and spent tombstone; the merge only fills the exact parent
   * evidence. Real amount/script/parent conflicts and existing quarantine /
   * conflict reasons stay isolated.
   */
  private mergeSelfOutput(
    txid: string,
    parentInputs: readonly string[],
    output: { value: bigint; scriptHex: string },
    index: number,
  ): void {
    const key = `${txid}:${index}`;
    const scriptHex = output.scriptHex.toLowerCase();
    const prev = this.utxos.get(key);
    if (!prev) {
      this.utxos.set(key, {
        value: output.value, scriptHex, status: "unconfirmed", height: 0,
        source: "local", creatingTxid: txid, parentInputs: [...parentInputs], confirmed: false,
        spentBy: null, spentExternal: false,
        occupiedBy: null, protected: false, protectionSources: [], isolated: null, pendingParent: null,
      });
      return;
    }
    if (prev.spentBy) return; // never resurrect a spent output
    if (prev.protected && prev.value === 0n && prev.scriptHex === "") {
      // Protected placeholder registered before the output existed. Adopt
      // the real facts, keep every protection, and clear only the placeholder
      // marker, never a real quarantine/conflict.
      const keepIsolation = prev.isolated === "protected-unknown" ? null : prev.isolated;
      prev.value = output.value;
      prev.scriptHex = scriptHex;
      prev.status = "unconfirmed";
      prev.height = 0;
      prev.source = "local";
      prev.creatingTxid = txid;
      prev.parentInputs = [...parentInputs];
      prev.confirmed = false;
      prev.spentBy = null;
      prev.spentExternal = false;
      prev.isolated = keepIsolation;
      prev.pendingParent = null;
      return;
    }
    if (prev.value === output.value && prev.scriptHex === scriptHex) {
      if (prev.creatingTxid !== null && prev.creatingTxid !== txid) {
        prev.isolated = prev.isolated ?? `local-conflict:${key}`;
        return;
      }
      if (prev.isolated === "protected-unknown") prev.isolated = null;
      prev.creatingTxid = txid;
      prev.parentInputs = [...parentInputs];
      prev.pendingParent = null;
      if (prev.source !== "woc") prev.source = "local";
      return;
    }
    prev.isolated = prev.isolated ?? `local-conflict:${key}`;
  }

  /**
   * Ordinary provider/reconcile settlement shares the same input-conflict
   * rule as external observation. A late ACK must never overwrite a trusted
   * different spender or enable this transaction's change.
   */
  private assertOutboxInputsAvailable(entry: OutboxEntry, parsed: ParsedTx): void {
    const conflicts: string[] = [];
    for (const txIn of parsed.inputs) {
      const key = `${txIn.txid}:${txIn.vout}`;
      const row = this.utxos.get(key);
      if (!row) continue;
      if (row.spentBy !== null && row.spentBy !== entry.txid) conflicts.push(key);
      else if (row.occupiedBy !== null && row.occupiedBy !== entry.allocationId) conflicts.push(key);
      else if (row.isolated !== null) conflicts.push(key);
    }
    if (conflicts.length === 0) return;
    for (const key of conflicts) this.isolateConflict(key, entry.txid);
    // A snapshot may already show this transaction's own change. Do not leave
    // it selectable when the transaction itself is in conflict.
    parsed.outputs.forEach((out, index) => {
      if (out.scriptHex.toLowerCase() !== this.config.walletScriptHex) return;
      const key = `${entry.txid}:${index}`;
      const row = this.utxos.get(key);
      if (!row || row.spentBy) return;
      row.isolated = row.isolated ?? `commit-conflict:${entry.txid}`;
      this.isolateDescendants(key, `commit-conflict:${entry.txid}`);
    });
    this.bump();
    throw new UtmError("state-conflict", "outbox input conflicts with a recorded spender; related change is isolated");
  }

  private commitOutbox(entry: OutboxEntry): void {
    const parsed = parseTx(entry.rawTxHex, entry.txid);
    this.assertOutboxInputsAvailable(entry, parsed);
    const record = entry.allocationId ? this.allocations.get(entry.allocationId) : undefined;
    const parentInputs = parsed.inputs.map((i) => `${i.txid}:${i.vout}`);
    // Spend tombstones for all inputs (proven values stay for conservation).
    for (const txIn of parsed.inputs) {
      const key = `${txIn.txid}:${txIn.vout}`;
      const row = this.utxos.get(key);
      if (row) {
        row.spentBy = entry.txid;
        row.spentExternal = false;
        row.occupiedBy = null;
      } else {
        this.utxos.set(key, {
          value: 0n, scriptHex: "", status: "unconfirmed", height: 0, source: "local",
          creatingTxid: null, parentInputs: null, confirmed: false,
          spentBy: entry.txid, spentExternal: false, occupiedBy: null,
          protected: false, protectionSources: [], isolated: null, pendingParent: null,
        });
      }
    }
    // Register self outputs as immediately spendable local outputs.
    // (Imported-unknown outputs keep pendingParent until the entry settles.)
    parsed.outputs.forEach((out, index) => {
      if (out.scriptHex.toLowerCase() === this.config.walletScriptHex) {
        this.mergeSelfOutput(entry.txid, parentInputs, out, index);
      }
    });
    if (record) {
      record.state = "committed";
      record.signedTxid = entry.txid;
    }
  }

  /**
   * Project a trusted observed transaction that retires an external
   * signature responsibility.
   *
   * It reuses the ordinary exact-settlement projection: the parent exact
   * bytes are stored, the self outputs become spendable local outputs with
   * their parent relation, and the spent inputs keep their tombstones. The
   * allocation is only marked committed when this exact transaction really
   * is its own transaction AND no other responsibility is outstanding.
   */
  private projectSettledTransaction(
    allocationId: string,
    exact: ParsedTx,
    rawTxHex: string,
    mode: "allocation" | "observation",
  ): void {
    const txid = exact.canonicalTxid;
    const parentInputs = exact.inputs.map((txIn) => `${txIn.txid}:${txIn.vout}`);
    // A trusted observation of another transaction consumes the money but is
    // NOT proof that this allocation's authorized transaction succeeded. It
    // gets its own evidence entry and never borrows `<allocation>:broadcast`.
    const commandId = mode === "allocation" ? `${allocationId}:broadcast` : `observed:${txid}`;
    const owner = mode === "allocation" ? allocationId : null;
    let entry = this.outbox.find((candidate) => candidate.commandId === commandId);
    if (entry && entry.rawTxHex !== rawTxHex) {
      throw new UtmError("state-conflict", "the observed transaction differs from the recorded exact bytes");
    }
    if (!entry) {
      this.outbox.push({
        commandId, allocationId: owner, txid, rawTxHex, state: "done", delivery: "external",
      });
      entry = this.outbox[this.outbox.length - 1]!;
    } else {
      entry.state = "done";
    }
    // The self outputs of the observed exact transaction become spendable.
    exact.outputs.forEach((out, index) => {
      if (out.scriptHex.toLowerCase() === this.config.walletScriptHex) {
        this.mergeSelfOutput(txid, parentInputs, out, index);
      }
    });
    if (mode !== "allocation") return;
    // The caller already proved the frozen template and stored exact txid.
    // Only an allocation without any remaining responsibility is completed.
    const record = this.allocations.get(allocationId);
    if (record) {
      const outstanding = [...this.externalSignatures.values()].some((row) =>
        row.allocationId === allocationId && row.state !== "settled");
      if (!outstanding) {
        record.state = "committed";
        record.signedTxid = txid;
      }
    }
  }

  private markUnknown(entry: OutboxEntry): void {
    // Unknown delivery: inputs stay protected under the outbox responsibility.
    // They are NOT released and the change is NOT enabled.
    const record = entry.allocationId ? this.allocations.get(entry.allocationId) : undefined;
    if (record && record.state === "held") {
      // Keep occupation so no second spend can reuse the inputs; the outbox
      // entry carries the exact bytes for query-or-replay of the SAME tx.
      record.signedTxid = entry.txid;
    }
  }

  /** Reconcile an unknown outbox entry against a chain observation. */
  reconcile(commandId: string, observation: { found: boolean; rawTxHex?: string }): "committed" | "still-unknown" | "failed" {
    const entry = this.outbox.find((e) => e.commandId === commandId);
    if (!entry) throw new UtmError("allocation-unknown", "outbox command not found");
    if (entry.state === "done") return "committed";
    if (entry.state === "failed") return "failed";
    if (entry.conclusion) throw new UtmError("allocation-state", "conflicting exact requires input reconciliation");
    if (!observation.found) return "still-unknown";
    if (!observation.rawTxHex) throw new UtmError("policy-denied", "found observation requires bytes");
    const observed = parseTx(observation.rawTxHex, entry.txid);
    if (observed.canonicalTxid !== entry.txid) throw new UtmError("state-conflict", "observed tx differs from local exact");
    this.commitOutbox(entry);
    entry.state = "done";
    this.bump();
    return "committed";
  }

  // ---- protocol-bound spends (refund/close, possibly no wallet inputs) --------

  /** Validate protocol inputs, attribution, fee authorization and outputs. */
  validateProtocolSpend(input: PrepareInput & { signedTxHex: string }): { txid: string; feeSats: string } {
    this.assertFundsNotFrozen("validate a protocol spend");
    const id = input.allocationId;
    const record = this.allocations.get(id);
    if (!record) throw new UtmError("allocation-unknown", "allocation not found");
    if (record.state !== "held") throw new UtmError("allocation-state", `cannot spend from ${record.state}`);
    const binding = input.protocolBinding;
    if (!binding || (binding.kind !== "refund" && binding.kind !== "close")) {
      throw new UtmError("policy-denied", "valid protocol binding is required");
    }
    const parsed = parseTx(input.signedTxHex);
    if (record.signedTxid && record.signedTxid !== parsed.canonicalTxid) {
      throw new UtmError("state-conflict", "protocol allocation already binds another transaction");
    }

    const walletKeys: string[] = [];
    const inputKeys: string[] = [];
    const walletValues: bigint[] = [];
    const externalValues: bigint[] = [];
    const normalizedProofs: Record<string, { value: bigint; scriptHex: string }> = {};
    for (const txIn of parsed.inputs) {
      const key = `${txIn.txid}:${txIn.vout}`;
      inputKeys.push(key);
      const row = this.utxos.get(key);
      const rawProof = input.externalProofs?.[key];
      const proof = rawProof === undefined ? undefined : {
        value: parseAmount(rawProof.value, "proof value"),
        scriptHex: canonicalScriptHex(rawProof.scriptHex),
      };
      if (row && (row.spentBy || row.isolated || row.protected || row.pendingParent)) {
        throw new UtmError("snapshot-input-invalid", `input ${key} is spent, protected, isolated or has an unknown parent`);
      }
      if (row?.occupiedBy && row.occupiedBy !== id) {
        throw new UtmError("already-occupied", `input ${key} is occupied`);
      }
      if (row?.scriptHex === this.config.walletScriptHex) {
        if (proof) throw new UtmError("policy-denied", `proof for wallet input ${key} is not allowed`);
        walletKeys.push(key);
        walletValues.push(row.value);
        continue;
      }
      if (!proof) throw new UtmError("unknown-input", `input ${key} has no trusted proof`);
      if (proof.scriptHex === this.config.walletScriptHex) {
        throw new UtmError("policy-denied", `input ${key} claims the wallet script without kernel proof`);
      }
      if (row && (row.scriptHex !== proof.scriptHex || row.value !== proof.value)) {
        throw new UtmError("state-conflict", `proof does not match the recorded prevout ${key}`);
      }
      normalizedProofs[key] = proof;
      externalValues.push(proof.value);
    }
    this.checkAncestors(walletKeys);

    const walletIn = sumChecked(walletValues, "wallet inputs");
    const externalIn = sumChecked(externalValues, "external inputs");
    const totalOut = sumChecked(parsed.outputs.map((output) => output.value), "outputs");
    const ownValues: bigint[] = [];
    const remaining = record.outputs.map((output) => ({ ...output }));
    for (const output of parsed.outputs) {
      const scriptHex = output.scriptHex.toLowerCase();
      if (scriptHex === this.config.walletScriptHex) {
        ownValues.push(output.value);
        continue;
      }
      const index = remaining.findIndex((declared) => declared.scriptHex === scriptHex && declared.value === output.value);
      if (index < 0) throw new UtmError("policy-denied", "protocol tx has an undeclared non-self output");
      remaining.splice(index, 1);
    }
    if (remaining.length !== 0) throw new UtmError("policy-denied", "protocol tx misses declared outputs");

    const ownOut = sumChecked(ownValues, "own outputs");
    const totalIn = addChecked(walletIn, externalIn, "inputs");
    if (totalIn < totalOut) throw new UtmError("fee-out-of-range", "protocol tx outputs exceed inputs");
    const feeTotal = totalIn - totalOut;
    const feeFloor = estimateFeeSats(record.feeRate, BigInt(parsed.sizeBytes));
    const estimatedSizeCeiling = estimateSignedSize(parsed.inputs.length, parsed.outputs.map((output) => output.scriptHex.length / 2));
    // Protocol inputs may have covenant unlocking scripts larger than P2PKH.
    // Bound their fee shape by the exact observed bytes plus at most six bytes
    // per input for DER-length variance across up to three signatures, while
    // retaining the ordinary P2PKH estimate when it is larger.
    const protocolSizeCeiling = BigInt(parsed.sizeBytes + parsed.inputs.length * 6);
    const sizeCeiling = protocolSizeCeiling > estimatedSizeCeiling ? protocolSizeCeiling : estimatedSizeCeiling;
    const feeCeiling = estimateFeeSats(record.feeRate, sizeCeiling);
    if (feeTotal < feeFloor || feeTotal > feeCeiling) {
      throw new UtmError("fee-out-of-range", `protocol fee ${feeTotal} outside requested rate interval [${feeFloor},${feeCeiling}]`);
    }
    const walletLoss = walletIn > ownOut ? walletIn - ownOut : 0n;
    if (walletLoss > addChecked(record.business, feeCeiling, "wallet cap")) {
      throw new UtmError("policy-denied", "wallet pays more than business plus fee share");
    }

    const outboxId = `${id}:broadcast`;
    const exactHex = input.signedTxHex.toLowerCase();
    const existingOutbox = this.outbox.find((entry) => entry.commandId === outboxId);
    if (existingOutbox && (existingOutbox.txid !== parsed.canonicalTxid || existingOutbox.rawTxHex !== exactHex)) {
      throw new UtmError("state-conflict", "protocol outbox already holds different exact bytes");
    }

    // Every actual input, including proved external inputs, is now a first-
    // class responsibility. Occupancy is shared with ordinary wallet spends.
    for (let index = 0; index < inputKeys.length; index++) {
      const key = inputKeys[index]!;
      let row = this.utxos.get(key);
      if (!row) {
        const proof = normalizedProofs[key]!;
        row = {
          value: proof.value, scriptHex: proof.scriptHex, status: "unconfirmed", height: 0,
          source: "external", creatingTxid: null, parentInputs: null, confirmed: false,
          spentBy: null, spentExternal: false, occupiedBy: id, protected: false, protectionSources: [], isolated: null, pendingParent: null,
        };
        this.utxos.set(key, row);
      } else {
        row.occupiedBy = id;
      }
    }
    const spentKeys = new Set(inputKeys);
    for (const oldKey of record.inputs) {
      if (!spentKeys.has(oldKey)) {
        const row = this.utxos.get(oldKey);
        if (row?.occupiedBy === id) row.occupiedBy = null;
      }
    }
    record.inputs = inputKeys;
    record.externalProofs = normalizedProofs;
    record.signedTxid = parsed.canonicalTxid;
    record.protocolBinding = { kind: binding.kind, poolId: binding.poolId };
    if (!existingOutbox) {
      this.outbox.push({ commandId: outboxId, allocationId: id, txid: parsed.canonicalTxid, rawTxHex: exactHex, state: "pending", delivery: "wallet" });
    }
    this.bump();
    return { txid: parsed.canonicalTxid, feeSats: formatAmount(feeTotal) };
  }

  // ---- protocol intent (pre-signature) and external delivery -----------------

  /**
   * Freeze a protocol-bound unsigned transaction before any signer runs.
   *
   * The trusted adapter classifies every actual input; the kernel verifies
   * each class against its own facts (proven self script, protection claim,
   * trusted prevout proof), takes exclusive responsibility for the wallet and
   * protected inputs and caps the miner fee. Unclassified, mismatched or
   * over-cap inputs fail closed: no amount of caller assertion can widen the
   * authorization.
   */
  prepareProtocolIntent(input: ProtocolIntentInput): { allocationId: string; unsignedTxHex: string; feeCapSats: string } {
    this.assertFundsNotFrozen("prepare a protocol intent");
    const id = input.allocationId;
    const record = this.allocations.get(id);
    if (!record) throw new UtmError("allocation-unknown", "allocation not found");
    if (record.state !== "held") throw new UtmError("allocation-state", `cannot prepare from ${record.state}`);
    const kind = input.binding.kind;
    const feeCap = parseAmount(input.feeCapSats, "fee cap");
    if (feeCap <= 0n) throw new UtmError("fee-invalid", "fee cap must be positive");
    if (record.feeRate <= 0n) throw new UtmError("fee-invalid", "protocol allocation needs a fee rate");
    const parsed = parseTx(input.unsignedTxHex);
    if (parsed.inputs.length === 0) throw new UtmError("tx-invalid", "protocol intent needs at least one input");

    const factsByKey = new Map<string, ProtocolInputFact>();
    for (const raw of input.inputs) {
      const key = raw.outpoint.toLowerCase();
      if (factsByKey.has(key)) throw new UtmError("tx-invalid", `duplicate protocol input ${key}`);
      factsByKey.set(key, {
        outpoint: key,
        class: raw.class,
        value: formatAmount(parseAmount(raw.value, "input value")),
        scriptHex: raw.scriptHex.toLowerCase(),
        claimId: raw.class === "protected" ? raw.claimId : null,
      });
    }
    if (factsByKey.size !== parsed.inputs.length) {
      throw new UtmError("snapshot-input-invalid", "intent inputs do not match the transaction");
    }

    const takenClaims = [...new Set((input.claims ?? []).map((claim) => claim.toLowerCase()))].sort();
    for (const claim of takenClaims) {
      // Only an occupation may be taken over, and only by the intent that
      // created it: a fund protection is never a claimable balance.
      if (protectionSourceKind(claim) !== "occupation") {
        throw new UtmError("policy-denied", `claim ${claim} is not a takeover-able occupation`);
      }
    }
    const walletKeys: string[] = [];
    const facts: ProtocolInputFact[] = [];
    const normalizedProofs: Record<string, { value: bigint; scriptHex: string }> = {};
    for (const txIn of parsed.inputs) {
      const key = `${txIn.txid}:${txIn.vout}`;
      const fact = factsByKey.get(key);
      if (!fact) throw new UtmError("snapshot-input-invalid", `input ${key} has no trusted classification`);
      const value = parseAmount(fact.value, "input value");
      const scriptHex = fact.scriptHex;
      const row = this.utxos.get(key);
      if (row && (row.spentBy || row.isolated || row.pendingParent)) {
        throw new UtmError("snapshot-input-invalid", `input ${key} is spent, isolated or has an unknown parent`);
      }
      if (row?.occupiedBy && row.occupiedBy !== id) {
        throw new UtmError("already-occupied", `input ${key} is occupied`);
      }

      // Gate 1 — exclusive occupation, BEFORE any use permission and for
      // EVERY classification. A fund/protected authorization says what the
      // money may be used for; it never says somebody else's already-signed
      // occupation may be ignored.
      if (row?.protected) {
        const blocking = row.protectionSources.filter((entry) =>
          protectionSourceKind(entry) !== "fund" && !takenClaims.includes(entry));
        if (blocking.length > 0) {
          throw new UtmError("funds-protected", `input ${key} is a protected output reserved by another occupation`);
        }
      }

      if (fact.class === "external") {
        const proof = input.externalProofs?.[key];
        if (!proof) throw new UtmError("unknown-input", `input ${key} has no trusted proof`);
        const proofValue = parseAmount(proof.value, "proof value");
        const proofScript = proof.scriptHex.toLowerCase();
        if (proofScript === this.config.walletScriptHex) {
          throw new UtmError("policy-denied", `input ${key} claims the wallet script without kernel proof`);
        }
        if (proofValue !== value) throw new UtmError("state-conflict", `proof value does not match the declared input ${key}`);
        if (row && (row.scriptHex !== proofScript || row.value !== proofValue)) {
          throw new UtmError("state-conflict", `proof does not match the recorded prevout ${key}`);
        }
        normalizedProofs[key] = { value: proofValue, scriptHex: proofScript };
      } else {
        if (!row) throw new UtmError("unknown-input", `input ${key} is not a known wallet output`);
        if (row.scriptHex !== this.config.walletScriptHex) {
          throw new UtmError("unknown-input", `input ${key} is not a proven wallet input`);
        }
        if (row.value !== value || row.scriptHex !== scriptHex) {
          throw new UtmError("state-conflict", `input ${key} does not match the recorded prevout`);
        }
        // Gate 2 — use permission for the declared classification.
        if (fact.class === "wallet") {
          // A plain wallet input must not carry a fund protection: that is a
          // protocol-marked output and needs its own business claim.
          const fund = row.protectionSources.filter((entry) => protectionSourceKind(entry) === "fund");
          if (fund.length > 0) {
            throw new UtmError("funds-protected", `input ${key} is a protected output`);
          }
        }
        if (fact.class === "protected") {
          if (!row.protected) throw new UtmError("funds-protected", `input ${key} is not a protected output`);
          if (!fact.claimId) throw new UtmError("policy-denied", `input ${key} needs a protocol claim id`);
          // An occupation is not a business protection: the input must carry
          // at least one FUND source.
          const real = row.protectionSources.filter((entry) => protectionSourceKind(entry) === "fund");
          if (real.length === 0) throw new UtmError("funds-protected", `input ${key} has no fund protection to claim`);
        }
        walletKeys.push(key);
      }
      facts.push({ ...fact, value: formatAmount(value) });
    }
    this.checkAncestors(walletKeys);

    // The output manifest is matched completely: a declared output (business
    // or a protocol-earmarked self output) is consumed by script+value, and at
    // most one undeclared self output may remain as ordinary change.
    const manifest = this.matchProtocolOutputs(record.outputs, parsed.outputs);

    // The exact amounts are already known before signing: the input values
    // come from trusted prevout facts and the outputs from the unsigned
    // template. The fee and the wallet outflow are therefore checked HERE,
    // not only after the signer ran.
    const walletIn = sumChecked(
      facts.filter((fact) => fact.class !== "external").map((fact) => parseAmount(fact.value, "input value")),
      "wallet inputs",
    );
    const externalIn = sumChecked(
      facts.filter((fact) => fact.class === "external").map((fact) => parseAmount(fact.value, "input value")),
      "external inputs",
    );
    const totalIn = addChecked(walletIn, externalIn, "inputs");
    const totalOut = sumChecked(parsed.outputs.map((output) => output.value), "outputs");
    if (totalIn < totalOut) throw new UtmError("fee-out-of-range", "protocol template outputs exceed inputs");
    const actualFee = totalIn - totalOut;
    if (actualFee > feeCap) {
      throw new UtmError("fee-out-of-range", `protocol fee ${actualFee} above the authorized cap ${feeCap}`);
    }
    const ownOut = sumChecked(manifest.ownOut, "own outputs");
    const walletLoss = walletIn > ownOut ? walletIn - ownOut : 0n;
    const walletCap = addChecked(record.business, feeCap, "wallet cap");
    if (walletLoss > walletCap) {
      throw new UtmError("policy-denied", "wallet pays more than business plus fee share");
    }

    // Necessary condition only: the unsigned template is a lower bound of the
    // signed size, so a cap that cannot even cover it cannot cover the final
    // transaction. The authoritative bounds are checked on the exact bytes.
    const unsignedFee = estimateFeeSats(record.feeRate, BigInt(parsed.sizeBytes));
    if (unsignedFee > feeCap) throw new UtmError("fee-out-of-range", "authorized fee cap is below the estimated miner fee");

    // A frozen intent is immutable: the same content is idempotent, different
    // content is an explicit conflict. Replacing it needs a new allocation.
    const digest = protocolIntentDigest({
      skeleton: unsignedSkeleton(input.unsignedTxHex),
      inputs: facts,
      proofs: normalizedProofs,
      feeCapSats: formatAmount(feeCap),
      feePolicy: input.feePolicy,
      binding: { kind, poolId: input.binding.poolId },
      outputs: record.outputs,
      claims: takenClaims,
    });
    if (record.signingIntentHex) {
      const frozen = protocolIntentDigest({
        skeleton: record.signingIntentHex,
        inputs: record.protocolInputs,
        proofs: record.externalProofs,
        feeCapSats: record.protocolFeeCapSats,
        feePolicy: record.protocolFeePolicy,
        binding: record.protocolBinding,
        outputs: record.outputs,
        claims: record.protocolClaims,
      });
      if (frozen !== digest) {
        throw new UtmError("state-conflict", "protocol intent differs from the frozen intent");
      }
      return { allocationId: id, unsignedTxHex: input.unsignedTxHex.toLowerCase(), feeCapSats: formatAmount(feeCap) };
    }

    // Every actual input now carries this allocation's responsibility.
    for (const fact of facts) {
      const key = fact.outpoint;
      const row = this.utxos.get(key);
      if (row) {
        row.occupiedBy = id;
      } else {
        const proof = normalizedProofs[key]!;
        this.utxos.set(key, {
          value: proof.value, scriptHex: proof.scriptHex, status: "unconfirmed", height: 0, source: "external",
          creatingTxid: null, parentInputs: null, confirmed: false,
          spentBy: null, spentExternal: false, occupiedBy: id, protected: false, protectionSources: [], isolated: null, pendingParent: null,
        });
      }
    }
    record.protocolInputs = facts;
    record.protocolFeeCapSats = formatAmount(feeCap);
    record.protocolFeePolicy = input.feePolicy;
    record.protocolClaims = takenClaims;
    record.externalProofs = normalizedProofs;
    record.protocolBinding = { kind, poolId: input.binding.poolId };
    record.inputs = facts.map((f) => f.outpoint);
    record.signingIntentHex = unsignedSkeleton(input.unsignedTxHex);
    this.bump();
    return { allocationId: id, unsignedTxHex: input.unsignedTxHex.toLowerCase(), feeCapSats: formatAmount(feeCap) };
  }

  /**
   * Validate the signed bytes of a protocol intent against the frozen
   * intent, then record the exact transaction. "external" delivery marks the
   * bytes as possibly already broadcast by an outside party: the wallet's own
   * provider is not involved, so the entry starts in the unknown state and
   * keeps the input responsibility until a trusted observation settles it.
   */
  completeProtocol(input: { allocationId: string; signedTxHex: string; delivery?: "wallet" | "external" }): { allocationId: string; txid: string; feeSats: string } {
    this.assertFundsNotFrozen("complete a protocol spend");
    const id = input.allocationId;
    const record = this.allocations.get(id);
    if (!record) throw new UtmError("allocation-unknown", "allocation not found");
    if (record.state !== "held") throw new UtmError("allocation-state", `cannot complete from ${record.state}`);
    if (record.protocolInputs.length === 0 || !record.signingIntentHex) throw new UtmError("allocation-state", "protocol intent was not prepared");
    const parsed = parseTx(input.signedTxHex);
    if (record.signedTxid && record.signedTxid !== parsed.canonicalTxid) {
      throw new UtmError("state-conflict", "protocol allocation already binds another transaction");
    }
    const skeleton = unsignedSkeleton(input.signedTxHex);
    if (record.signingIntentHex !== skeleton) {
      throw new UtmError("state-conflict", "transaction differs from frozen signing intent");
    }

    // The frozen skeleton already binds the ordered inputs and output layout
    // accepted before signing. Do not revalidate that internal manifest here;
    // actual signature size and current prevout amounts still determine fees.
    const ownOut = sumChecked(parsed.outputs
      .filter(output => output.scriptHex === this.config.walletScriptHex)
      .map(output => output.value), "own outputs");

    let walletIn = 0n;
    let externalIn = 0n;
    for (const fact of record.protocolInputs) {
      if (fact.class === "external") {
        const proof = record.externalProofs[fact.outpoint];
        if (!proof) throw new UtmError("unknown-input", `input ${fact.outpoint} has no trusted proof`);
        externalIn += proof.value;
        continue;
      }
      const row = this.utxos.get(fact.outpoint);
      walletIn += row ? row.value : parseAmount(fact.value, "input value");
    }
    const totalIn = addChecked(walletIn, externalIn, "inputs");
    const totalOut = sumChecked(parsed.outputs.map((o) => o.value), "outputs");
    if (totalIn < totalOut) throw new UtmError("fee-out-of-range", "protocol tx outputs exceed inputs");
    const fee = totalIn - totalOut;
    const feeFloor = record.protocolFeePolicy === "exact"
      ? 1n
      : estimateFeeSats(record.feeRate, BigInt(parsed.sizeBytes));
    const feeCap = parseAmount(record.protocolFeeCapSats, "fee cap");
    if (fee < feeFloor) throw new UtmError("fee-out-of-range", "protocol fee below actual-size minimum");
    if (fee > feeCap) throw new UtmError("fee-out-of-range", "protocol fee above the authorized cap");
    const walletLoss = walletIn > ownOut ? walletIn - ownOut : 0n;
    if (walletLoss > addChecked(record.business, feeCap, "wallet cap")) {
      throw new UtmError("policy-denied", "wallet pays more than business plus fee share");
    }

    const outboxId = `${id}:broadcast`;
    const exactHex = input.signedTxHex.toLowerCase();
    const existing = this.outbox.find((e) => e.commandId === outboxId);
    if (existing && (existing.txid !== parsed.canonicalTxid || existing.rawTxHex !== exactHex)) {
      throw new UtmError("state-conflict", "protocol outbox already holds different exact bytes");
    }
    if (!existing) {
      const delivery = input.delivery === "external" ? "external" : "wallet";
      this.outbox.push({
        commandId: outboxId, allocationId: id, txid: parsed.canonicalTxid, rawTxHex: exactHex,
        state: delivery === "external" ? "unknown" : "pending", delivery,
      });
    }
    record.signedTxid = parsed.canonicalTxid;
    record.fee = fee;
    this.bump();
    return { allocationId: id, txid: parsed.canonicalTxid, feeSats: formatAmount(fee) };
  }

  /**
   * Record a partial signature that leaves the wallet. The receiver may
   * complete and spend it, so the responsibility survives until a trusted
   * observation settles the related outpoints. Idempotent by id.
   *
   * The record is bound to a real allocation and to that allocation's own
   * inputs: a signature that is not attached to held funds cannot create
   * (or clear) a money responsibility.
   */
  recordExternalSignature(input: {
    id: string; allocationId: string; scope: string; draftTxHex: string; signatureHex: string;
    relatedInputs: string[]; reason: string; binding?: { kind: string; poolId: string };
  }): string {
    this.assertFundsNotFrozen("record an external signature");
    const id = input.id;
    const allocation = this.allocations.get(input.allocationId);
    if (!allocation) throw new UtmError("allocation-unknown", "external signature allocation not found");
    if (allocation.state !== "held") {
      throw new UtmError("allocation-state", `external signature cannot attach to a ${allocation.state} allocation`);
    }
    // The exact draft is parsed: the responsibility follows the artifact,
    // not the caller's metadata. A signature only ever affects inputs the
    // signed artifact actually spends.
    let artifact: ParsedTx;
    try { artifact = parseTx(input.draftTxHex); }
    catch { throw new UtmError("tx-invalid", "external signature draft is not a valid transaction"); }
    const artifactInputs = [...new Set(artifact.inputs.map((txIn) => `${txIn.txid}:${txIn.vout}`))].sort();
    if (artifactInputs.length === 0) {
      throw new UtmError("tx-invalid", "external signature draft spends no input");
    }
    const related = [...new Set(input.relatedInputs.map((key) => key.toLowerCase()))].sort();
    if (related.length === 0) {
      throw new UtmError("policy-denied", "external signature needs the related inputs it exposes");
    }
    for (const key of related) {
      if (!artifactInputs.includes(key)) {
        throw new UtmError("policy-denied", `external signature input ${key} is not spent by the signed artifact`);
      }
    }
    // Every input the allocation holds and the artifact spends is covered by
    // the responsibility: a signature may cover part of a transaction, but
    // it may not leave the wallet's own money uncovered.
    for (const key of allocation.inputs) {
      if (!artifactInputs.includes(key)) continue;
      if (!related.includes(key)) {
        throw new UtmError("policy-denied", `external signature does not cover the held input ${key}`);
      }
    }
    // The responsibility may only cover inputs this allocation already owns.
    // "The kernel does not know the outpoint yet" is not a credential: an
    // unknown input must not be registered now and left for a later snapshot
    // to promote into free wallet balance.
    if (artifactInputs.some((key) => !related.includes(key))) {
      throw new UtmError("policy-denied", "external signature related inputs do not cover the signed artifact");
    }
    const missingExternal: Array<{ key: string; value: bigint; scriptHex: string }> = [];
    for (const key of artifactInputs) {
      if (!allocation.inputs.includes(key)) {
        throw new UtmError("policy-denied", `external signature input ${key} is not held by the allocation`);
      }
      const row = this.utxos.get(key);
      if (row?.spentBy) {
        throw new UtmError("policy-denied", `external signature input ${key} is already spent`);
      }
      if (row?.isolated) {
        throw new UtmError("state-conflict", `external signature input ${key} is isolated`);
      }
      if (row?.occupiedBy && row.occupiedBy !== input.allocationId) {
        throw new UtmError("already-occupied", `external signature input ${key} is held by another allocation`);
      }
      const isWalletInput = row !== undefined && row.scriptHex === this.config.walletScriptHex;
      if (isWalletInput) {
        if (row.occupiedBy !== input.allocationId) {
          throw new UtmError("policy-denied", `external signature input ${key} is not held by the allocation`);
        }
        continue;
      }
      // A third-party input is not wallet balance, but the allocation must
      // have proved its prevout and taken responsibility for it at pre-sign
      // time. A row that merely exists is not an authorization.
      const proof = allocation.externalProofs[key];
      if (!proof) {
        throw new UtmError("policy-denied", `external signature input ${key} is not a proven external input of the allocation`);
      }
      if (row) {
        if (row.scriptHex !== proof.scriptHex || row.value !== proof.value) {
          throw new UtmError("state-conflict", `external signature input ${key} does not match the trusted prevout proof`);
        }
        if (row.occupiedBy !== input.allocationId) {
          throw new UtmError("policy-denied", `external signature input ${key} is not held by the allocation`);
        }
      } else {
        missingExternal.push({ key, value: proof.value, scriptHex: proof.scriptHex });
      }
    }
    const existing = this.externalSignatures.get(id);
    if (existing) {
      if (existing.draftTxHex !== input.draftTxHex.toLowerCase() || existing.signatureHex !== input.signatureHex.toLowerCase()
          || existing.relatedInputs.join(",") !== related.join(",")
          || existing.allocationId !== input.allocationId
          || existing.scope !== input.scope
          || (existing.binding?.kind ?? "") !== (input.binding?.kind ?? "")
          || (existing.binding?.poolId ?? "") !== (input.binding?.poolId ?? "")) {
        throw new UtmError("id-conflict", "same external signature id with different content");
      }
      return id;
    }
    // A legacy allocation may carry a trusted proof whose outpoint was not
    // materialized. Create the responsibility row now, already occupied by
    // this allocation, so a later snapshot cannot turn it into free money.
    for (const external of missingExternal) {
      this.utxos.set(external.key, {
        value: external.value, scriptHex: external.scriptHex, status: "unconfirmed", height: 0, source: "external",
        creatingTxid: null, parentInputs: null, confirmed: false,
        spentBy: null, spentExternal: false, occupiedBy: input.allocationId,
        protected: false, protectionSources: [], isolated: null, pendingParent: null,
      });
    }
    this.externalSignatures.set(id, {
      id, allocationId: input.allocationId, scope: input.scope,
      binding: input.binding ? { kind: input.binding.kind, poolId: input.binding.poolId } : null,
      draftTxHex: input.draftTxHex.toLowerCase(), signatureHex: input.signatureHex.toLowerCase(),
      relatedInputs: related, artifactInputs, reason: input.reason, state: "responsible",
    });
    this.bump();
    return id;
  }

  /**
   * Settle an external partial-signature responsibility with a trusted,
   * structured fact.
   *
   * There is no evidence-free settlement: a bare id is not proof. The fact
   * must be one of two terminal kinds:
   *
   * - "input-consumed": a transaction that was credibly observed consumed the
   *   inputs the signature affected. The kernel marks those inputs spent,
   *   settles the sibling responsibilities of the same round and projects the
   *   self outputs — atomically, so the input can never be re-allocated after
   *   the responsibility is cleared.
   * - "signature-invalidated": the signature became unusable without any
   *   input being consumed. The inputs stay free; the evidence must say why.
   *
   * If the observation conflicts with an already recorded spender, the
   * candidate is mutated to isolate the affected inputs/descendants and the
   * call throws `state-conflict`. The host MUST persist that candidate: the
   * isolation is the safety action, not an optional side effect.
   */
  settleExternalSignature(id: string, evidence: ExternalSignatureEvidence): void {
    const key = id;
    const record = this.externalSignatures.get(key);
    if (!record) throw new UtmError("allocation-unknown", "external signature not found");
    if (record.state === "settled") return;
    if (evidence.kind === "input-consumed") {
      const txid = evidence.txid.toLowerCase();
      let exact: ParsedTx;
      try { exact = parseTx(evidence.rawTxHex, txid); }
      catch { throw new UtmError("policy-denied", "settlement evidence does not carry the observed exact transaction"); }
      const consumed = [...new Set(evidence.inputs.map((key) => key.toLowerCase()))].sort();
      if (consumed.length === 0) {
        throw new UtmError("policy-denied", "settlement evidence must name the consumed inputs");
      }
      // The exact transaction is the primary fact. Its real inputs, not the
      // caller's list, decide which responsibility it touched.
      const exactInputs = [...new Set(exact.inputs.map((txIn) => `${txIn.txid}:${txIn.vout}`))].sort();
      const responsibility = new Set([...record.artifactInputs, ...record.relatedInputs]);
      const hits = exactInputs.filter((key) => responsibility.has(key));
      if (hits.length === 0) {
        throw new UtmError("policy-denied", "the observed transaction does not spend the responsibility");
      }
      if (exactInputs.length !== consumed.length || !consumed.every((key, index) => exactInputs[index] === key)) {
        // A declaration that disagrees with the exact bytes is not a usable
        // settlement, but a real consumption of a responsible input still
        // freezes the old chain.
        for (const key of hits) this.isolateConflict(key, txid);
        this.bump();
        throw new UtmError("policy-denied", "the observed transaction does not spend the declared inputs; related change is isolated");
      }
      if (!this.allocations.has(record.allocationId)) {
        throw new UtmError("allocation-unknown", "external signature allocation no longer exists");
      }
      const outboxId = `${record.allocationId}:broadcast`;
      const existingOutbox = this.outbox.find((entry) => entry.commandId === outboxId);
      const outboxConflict = existingOutbox !== undefined &&
        (existingOutbox.txid !== txid || existingOutbox.rawTxHex !== evidence.rawTxHex.toLowerCase());
      const conflictingInputs = exactInputs.filter((key) => {
        const row = this.utxos.get(key);
        if (!row) return false;
        if (row.spentBy !== null && row.spentBy !== txid) return true;
        if (row.occupiedBy !== null && row.occupiedBy !== record.allocationId) return true;
        return row.isolated !== null;
      });
      if (conflictingInputs.length > 0 || outboxConflict) {
        // Do not silently skip a conflicting input and then clear the duty.
        // Isolate every responsible/conflicting outpoint and its old local
        // descendants; the responsibility stays outstanding until the host
        // resolves the conflict with a consistent trusted fact.
        for (const key of new Set([...hits, ...conflictingInputs])) this.isolateConflict(key, txid);
        this.bump();
        throw new UtmError("state-conflict", "observed consumption conflicts with the recorded spender; related change is isolated");
      }

      const coversArtifact = record.artifactInputs.every((key) => exactInputs.includes(key));
      if (!coversArtifact) {
        // A competing transaction that consumes only part of the artifact is
        // a real external-consumption fact, not a successful settlement of
        // the whole responsibility. Isolate the touched chain; keep the rest
        // of the duty outstanding.
        for (const key of hits) this.isolateConflict(key, txid);
        this.bump();
        throw new UtmError("state-conflict", "the observed transaction only consumes part of the responsibility; related change is isolated");
      }

      const allocation = this.allocations.get(record.allocationId)!;
      const authorized = this.allocationExactMatches(allocation, exact, evidence.rawTxHex);

      // Retire the whole round first, then project the money. Only a match
      // with this allocation's frozen template may complete the allocation.
      for (const sibling of this.externalSignatures.values()) {
        if (sibling.allocationId !== record.allocationId || sibling.state === "settled") continue;
        // Only retire a responsibility whose WHOLE artifact was consumed. A
        // sibling with an uncovered input keeps its duty and occupation.
        if (sibling.artifactInputs.length === 0) continue;
        if (!sibling.artifactInputs.every((key) => exactInputs.includes(key))) continue;
        sibling.state = "settled";
        sibling.settledTxid = txid;
      }
      for (const key of exactInputs) {
        const row = this.utxos.get(key);
        if (!row) continue;
        row.spentBy = txid;
        row.spentExternal = true;
        row.occupiedBy = null;
      }
      // The observed exact transaction is the parent of its own outputs: the
      // ordinary self change becomes spendable immediately, without a WoC
      // tick, a block or the end of the fee pool. Another transaction that
      // merely consumes the same inputs gets a separate observation entry and
      // never borrows `<allocation>:broadcast`.
      this.projectSettledTransaction(
        record.allocationId, exact, evidence.rawTxHex.toLowerCase(),
        authorized ? "allocation" : "observation",
      );
      this.refreshFundsFrozen();
      this.releaseOrphanSignatureQuarantine();
      this.bump();
      return;
    }
    if (evidence.kind === "signature-invalidated") {
      record.settledTxid = evidence.txid ? evidence.txid.toLowerCase() : undefined;
      record.state = "settled";
      this.refreshFundsFrozen();
      this.releaseOrphanSignatureQuarantine();
      this.bump();
      return;
    }
    throw new UtmError("policy-denied", "unknown settlement evidence kind");
  }

  /**
   * A trusted exact observation completes an allocation only when its frozen
   * skeleton (inputs, outputs, version, locktime, sequence) matches AND, if
   * the allocation already stored an exact txid, that txid is the observed
   * one. Merely spending the same inputs is not the same authorization.
   */
  private allocationExactMatches(record: StoredAllocation, exact: ParsedTx, rawTxHex: string): boolean {
    if (!record.signingIntentHex) return false;
    let skeleton: string;
    try { skeleton = unsignedSkeleton(rawTxHex); } catch { return false; }
    if (skeleton !== record.signingIntentHex) return false;
    if (record.signedTxid !== null && record.signedTxid !== exact.canonicalTxid) return false;
    return true;
  }

  /**
   * Isolate one consumed outpoint and the local descendants of the recorded
   * spender. The recorded spender is never overwritten: a conflict is not a
   * new canonical spend.
   */
  private isolateConflict(outpoint: string, observedTxid: string): void {
    const key = outpoint.toLowerCase();
    const row = this.utxos.get(key);
    if (!row) {
      this.utxos.set(key, {
        value: 0n, scriptHex: "", status: "unconfirmed", height: 0, source: "external",
        creatingTxid: null, parentInputs: null, confirmed: false,
        spentBy: null, spentExternal: false, occupiedBy: null,
        protected: false, protectionSources: [], isolated: `conflict:${observedTxid}`, pendingParent: null,
      });
      return;
    }
    row.isolated = row.isolated ?? `conflict:${observedTxid}`;
    this.isolateDescendants(key, `ancestor-conflict:${key}`);
  }

  /**
   * The active external-signature responsibility of an allocation, if any.
   * Release paths consult it: a signature that already left the wallet keeps
   * its inputs responsible until a trusted terminal state is recorded.
   * A superseded record still counts: the old artifact is still valid.
   */
  externalResponsibilityFor(allocationId: string): ExternalSignatureRecord | null {
    const id = allocationId;
    // Canonical id order is stable across languages and serialize/restore.
    for (const record of this.externalSignatureView()) {
      if (record.allocationId !== id) continue;
      if (record.state !== "responsible" && record.state !== "superseded" && record.state !== "quarantined") continue;
      return record;
    }
    return null;
  }

  /**
   * Record that a newer protocol round replaces an older partial signature
   * (the fee pool negotiates several state drafts).
   *
   * The relation is explicit and auditable, but it is **not** a terminal
   * state: the old artifact is still a valid signature until trusted
   * evidence retires it. So the old record becomes "superseded" — it keeps
   * its responsibility and stays visible in the responsibility view.
   *
   * The replacement must belong to the same scope and the same contract
   * (pool); a different pool or scope can never supersede this one.
   */
  supersedeExternalSignature(oldId: string, newId: string): void {
    const oldKey = oldId;
    const newKey = newId;
    if (oldKey === newKey) throw new UtmError("id-conflict", "a signature cannot supersede itself");
    const older = this.externalSignatures.get(oldKey);
    const newer = this.externalSignatures.get(newKey);
    if (!older) throw new UtmError("allocation-unknown", "external signature not found");
    if (!newer) throw new UtmError("allocation-unknown", "superseding external signature not found");
    if (newer.state !== "responsible") throw new UtmError("allocation-state", "superseding signature is not responsible");
    if (older.allocationId !== newer.allocationId) {
      throw new UtmError("policy-denied", "a signature can only supersede one of the same allocation");
    }
    if (older.scope !== newer.scope) {
      throw new UtmError("policy-denied", "a signature can only supersede one of the same scope");
    }
    if ((older.binding?.kind ?? "") !== (newer.binding?.kind ?? "")
      || (older.binding?.poolId ?? "") !== (newer.binding?.poolId ?? "")) {
      throw new UtmError("policy-denied", "a signature can only supersede one of the same contract");
    }
    if (older.relatedInputs.join(",") !== newer.relatedInputs.join(",")) {
      throw new UtmError("policy-denied", "a signature can only supersede one over the same inputs");
    }
    if (older.state === "settled") return;
    // The old artifact is still valid: it stays responsible and visible.
    older.state = "superseded";
    older.supersededBy = newKey;
    this.bump();
  }

  externalSignatureView(): ExternalSignatureRecord[] {
    return [...this.externalSignatures.values()]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((row) => ({ ...row, binding: row.binding ? { ...row.binding } : null, relatedInputs: [...row.relatedInputs], artifactInputs: [...row.artifactInputs] }));
  }

  /**
   * The frozen protocol intent of an allocation (null for ordinary ones).
   * The host uses it to prove that a protocol-protected input was claimed
   * through the manager rather than by a caller flag.
   */
  protocolIntentView(allocationId: string): {
    inputs: ProtocolInputFact[];
    feeCapSats: string;
    feePolicy: ProtocolFeePolicy | "";
    binding: { kind: ProtocolBindingKind; poolId: string } | null;
    signedTxid: string | null;
  } | null {
    const id = allocationId;
    const record = this.allocations.get(id);
    if (!record || record.protocolInputs.length === 0) return null;
    return {
      inputs: record.protocolInputs.map((fact) => ({ ...fact })),
      feeCapSats: record.protocolFeeCapSats,
      feePolicy: record.protocolFeePolicy,
      binding: record.protocolBinding ? { ...record.protocolBinding } : null,
      signedTxid: record.signedTxid,
    };
  }

  /**
   * Report the outstanding money responsibilities of this scope: the exact
   * transactions the wallet still owns (or handed outside) and the partial
   * signatures that may still be completed by their receivers.
   */
  responsibilityView(): ResponsibilityView[] {
    const views: ResponsibilityView[] = [];
    for (const entry of this.outbox) {
      if (entry.state === "done" || entry.state === "failed") continue;
      const record = entry.allocationId ? this.allocations.get(entry.allocationId) : undefined;
      const inputs = record ? [...record.inputs] : [];
      let totalIn = 0n;
      for (const key of inputs) totalIn += this.utxos.get(key)?.value ?? 0n;
      const ownOutputs: ResponsibilityView["ownOutputs"] = [];
      if (entry.delivery === "external" || entry.state !== "pending") {
        const parsed = parseTx(entry.rawTxHex, entry.txid);
        parsed.outputs.forEach((out, index) => {
          if (out.scriptHex.toLowerCase() !== this.config.walletScriptHex) return;
          ownOutputs.push({ outpoint: `${entry.txid}:${index}`, value: formatAmount(out.value) });
        });
      }
      views.push({
        commandId: entry.commandId, allocationId: entry.allocationId, txid: entry.txid,
        state: entry.state, delivery: entry.delivery,
        reason: entry.delivery === "external" ? "signed bytes delivered outside the wallet" : "wallet broadcast outcome unknown",
        inputs, totalInSats: formatAmount(totalIn), ownOutputs,
      });
    }
    for (const row of this.externalSignatures.values()) {
      if (row.state === "settled") continue;
      views.push({
        commandId: row.id, allocationId: row.allocationId, txid: "",
        state: "unknown", delivery: "external",
        reason: row.reason,
        // The responsibility follows the artifact: the inputs the signed
        // draft actually spends.
        inputs: [...row.artifactInputs.length > 0 ? row.artifactInputs : row.relatedInputs],
        totalInSats: "0", ownOutputs: [],
      });
    }
    return views;
  }

  /**
   * Import a previously-broadcast exact transaction whose result is unknown
   * (legacy unresolved records, protocol refund/close broadcasts). Inputs
   * come under this entry's responsibility; self outputs are adopted but NOT
   * selectable until the entry settles via broadcastResult/reconcile.
   */
  importUnknown(txid: string, rawTxHex: string): string {
    const canonical = checkTxid(txid).toLowerCase();
    const parsed = parseTx(rawTxHex, canonical);
    const commandId = `imported:${canonical}`;
    const existing = this.outbox.find((e) => e.commandId === commandId);
    if (existing) {
      if (existing.txid !== canonical || existing.rawTxHex !== rawTxHex.toLowerCase()) {
        throw new UtmError("state-conflict", "imported command already holds another tx");
      }
      return commandId; // idempotent replay
    }
    for (const txIn of parsed.inputs) {
      const key = `${txIn.txid}:${txIn.vout}`;
      const row = this.utxos.get(key);
      if (row) {
        if (row.spentBy && row.spentBy !== canonical) {
          throw new UtmError("state-conflict", `input ${key} already spent by another tx`);
        }
        if (row.occupiedBy) {
          const holder = this.allocations.get(row.occupiedBy);
          if (holder && holder.state === "held") {
            throw new UtmError("state-conflict", `input ${key} is occupied by live allocation ${row.occupiedBy}`);
          }
          row.occupiedBy = null;
        }
        row.spentBy = canonical;
        row.spentExternal = false;
      } else {
        this.utxos.set(key, {
          value: 0n, scriptHex: "", status: "unconfirmed", height: 0, source: "local",
          creatingTxid: null, parentInputs: null, confirmed: false,
          spentBy: canonical, spentExternal: false, occupiedBy: null,
          protected: false, protectionSources: [], isolated: null, pendingParent: null,
        });
      }
    }
    for (let index = 0; index < parsed.outputs.length; index++) {
      const out = parsed.outputs[index]!;
      if (out.scriptHex.toLowerCase() !== this.config.walletScriptHex) continue;
      const key = `${canonical}:${index}`;
      const prev = this.utxos.get(key);
      if (prev) {
        if (prev.spentBy) continue;
        if (prev.source === "local" && prev.value === out.value && prev.creatingTxid === canonical) continue;
        prev.isolated = `local-conflict:${key}`;
        continue;
      }
      this.utxos.set(key, {
        value: out.value, scriptHex: out.scriptHex.toLowerCase(), status: "unconfirmed", height: 0,
        source: "local", creatingTxid: canonical,
        parentInputs: parsed.inputs.map((i) => `${i.txid}:${i.vout}`), confirmed: false,
        spentBy: null, spentExternal: false,
        occupiedBy: null, protected: false, protectionSources: [], isolated: null, pendingParent: canonical,
      });
    }
    this.outbox.push({ commandId, allocationId: null, txid: canonical, rawTxHex: rawTxHex.toLowerCase(), state: "unknown", delivery: "wallet" });
    this.bump();
    return commandId;
  }

  /**
   * Abort an allocation whose signed bytes were never broadcast: the
   * outbox holds no non-pending entry for it, so nothing external can
   * exist. Releases occupations, drops a pending outbox entry for the same
   * bytes, and marks the allocation aborted. Refuses anything committed,
   * unknown, or already aborted. Callers must guarantee the bytes never
   * left the host through another path.
   */
  abortUnbroadcast(allocationId: string): void {
    this.assertFundsNotFrozen("abort an allocation");
    const id = allocationId;
    const record = this.allocations.get(id);
    if (!record) throw new UtmError("allocation-unknown", "allocation not found");
    if (record.state !== "held") throw new UtmError("allocation-state", `cannot abort from ${record.state}`);
    const outboxId = `${id}:broadcast`;
    const entry = this.outbox.find((e) => e.commandId === outboxId);
    if (entry && entry.state !== "pending") {
      throw new UtmError("allocation-state", "broadcast already attempted");
    }
    if (entry && entry.txid !== record.signedTxid) {
      throw new UtmError("state-conflict", "outbox does not match allocation");
    }
    // A partial signature that already left the wallet keeps the inputs
    // responsible: an ordinary abort must not erase that consequence.
    this.assertNoExternalResponsibility(id);
    if (entry) this.outbox = this.outbox.filter((e) => e.commandId !== outboxId);
    for (const key of record.inputs) {
      const row = this.utxos.get(key);
      if (row && row.occupiedBy === id && !row.spentBy) row.occupiedBy = null;
    }
    record.state = "aborted";
    this.bump();
  }

  /**
   * Explicit retired-forum hard deletion, never ordinary cancellation/recovery.
   * The host must prove forum ownership. Signed/unknown records are deliberately
   * discarded under that policy; observed spent inputs remain spent.
   */
  retireForumProtocolAllocation(allocationId: string): void {
    this.assertFundsNotFrozen("retire a forum protocol allocation");
    const id = allocationId;
    const record = this.allocations.get(id);
    if (!record) throw new UtmError("allocation-unknown", "allocation not found");
    if (!record.protocolBinding) throw new UtmError("allocation-state", "forum retirement requires a protocol allocation");
    for (const key of record.inputs) {
      const row = this.utxos.get(key);
      if (row && row.occupiedBy === id && !row.spentBy) row.occupiedBy = null;
    }
    this.outbox = this.outbox.filter((entry) => entry.allocationId !== id);
    for (const [key, signature] of this.externalSignatures) {
      if (signature.allocationId === id) this.externalSignatures.delete(key);
    }
    this.allocations.delete(id);
    this.bump();
  }

  /**
   * Release an allocation only when a trusted execution journal proved that
   * no signature was ever started. The caller owns that proof; this kernel
   * method only clears the pre-signature durable intent and aborts the held
   * allocation. It refuses any signed/attempted allocation.
   */
  cancelUnstarted(allocationId: string): void {
    this.assertFundsNotFrozen("cancel an unstarted allocation");
    const id = allocationId;
    const record = this.allocations.get(id);
    if (!record) throw new UtmError("allocation-unknown", "allocation not found");
    if (record.state !== "held") throw new UtmError("allocation-state", `cannot cancel from ${record.state}`);
    if (record.signedTxid) throw new UtmError("allocation-state", "allocation already signed");
    record.signingIntentDurable = false;
    record.signingIntentHex = "";
    this.abortUnbroadcast(id);
  }

  /**
   * Startup policy: drop every never-broadcast pending entry and abort
   * unsigned/pending-signed held allocations. Dispatching or unknown entries
   * keep their responsibility. Deterministic order (sorted ids).
   */
  dropPending(): string[] {
    if (this.fundsFrozen) return [];
    const dropped: string[] = [];
    for (const id of [...this.allocations.keys()].sort()) {
      const record = this.allocations.get(id);
      if (record && (record.signingIntentDurable || record.signedTxid !== null)) continue;
      try {
        this.abortUnbroadcast(id);
        dropped.push(id);
      } catch {
        // Committed/unknown/aborted allocations keep their state.
      }
    }
    return dropped;
  }

  /** Read-only view of one outpoint for host adapters (fee inputs, signing). */
  lookup(outpoint: string): {
    value: string; scriptHex: string; status: "confirmed" | "unconfirmed";
    source: "woc" | "local" | "external"; creatingTxid: string | null; spentBy: string | null;
    occupiedBy: string | null; protected: boolean; isolated: string | null;
    pendingParent: string | null; parentInputs: string[] | null; confirmed: boolean;
  } {
    const key = outpoint.toLowerCase();
    const row = this.utxos.get(key);
    if (!row) throw new UtmError("unknown-input", `outpoint ${outpoint} is unknown`);
    return {
      value: formatAmount(row.value), scriptHex: row.scriptHex, status: row.status,
      source: row.source, creatingTxid: row.creatingTxid, spentBy: row.spentBy,
      occupiedBy: row.occupiedBy, protected: row.protected, isolated: row.isolated,
      pendingParent: row.pendingParent, parentInputs: row.parentInputs ? [...row.parentInputs] : null, confirmed: row.confirmed,
    };
  }

  /** Current WoC revision, for hosts that persist the snapshot cursor. */
  snapshotRevision(): number {
    return this.wocRevision;
  }

  // ---- views / persistence ----------------------------------------------------

  private view(id: string, record: StoredAllocation): AllocationView {
    return {
      allocationId: id,
      requestId: record.requestId,
      inputs: [...record.inputs],
      totalInSats: formatAmount(record.inputs.reduce((s, k) => s + (this.utxos.get(k)?.value ?? 0n), 0n)),
      businessSats: formatAmount(record.business),
      feeSats: formatAmount(record.fee),
      changeSats: formatAmount(record.change),
      state: record.state,
    };
  }

  allocationView(allocationId: string): AllocationView {
    const record = this.allocations.get(allocationId);
    if (!record) throw new UtmError("allocation-unknown", "allocation not found");
    return this.view(allocationId, record);
  }

  outboxView(): OutboxEntry[] {
    return this.outbox.map((e) => ({ ...e, ...(e.conclusion ? { conclusion: structuredClone(e.conclusion) } : {}) }));
  }

  spendableBalance(): string {
    return formatAmount(this.candidates().reduce((s, c) => s + c.value, 0n));
  }

  serialize(): string {
    const utxos: SerializedState["utxos"] = {};
    for (const key of [...this.utxos.keys()].sort()) {
      const row = this.utxos.get(key)!;
      utxos[key] = {
        value: formatAmount(row.value), scriptHex: row.scriptHex, status: row.status, height: row.height,
        source: row.source, creatingTxid: row.creatingTxid, spentBy: row.spentBy,
        spentExternal: row.spentExternal, occupiedBy: row.occupiedBy, protected: row.protected,
        protectionSources: [...row.protectionSources], isolated: row.isolated,
        pendingParent: row.pendingParent, parentInputs: row.parentInputs, confirmed: row.confirmed,
      };
    }
    const allocations: SerializedState["allocations"] = {};
    for (const key of [...this.allocations.keys()].sort()) {
      const record = this.allocations.get(key)!;
      const proofs: Record<string, { value: string; scriptHex: string }> = {};
      for (const proofKey of Object.keys(record.externalProofs).sort()) {
        proofs[proofKey] = { value: formatAmount(record.externalProofs[proofKey]!.value), scriptHex: record.externalProofs[proofKey]!.scriptHex };
      }
      allocations[key] = {
        requestId: record.requestId, requestHash: record.requestHash, inputs: [...record.inputs],
        business: formatAmount(record.business), feeRate: formatAmount(record.feeRate),
        fee: formatAmount(record.fee), change: formatAmount(record.change),
        outputs: record.outputs.map((o) => ({ scriptHex: o.scriptHex, value: formatAmount(o.value) })),
        version: record.version, locktime: record.locktime, externalProofs: proofs,
        protocolBinding: record.protocolBinding,
        protocolInputs: record.protocolInputs.map((f) => ({ ...f })),
        protocolFeeCapSats: record.protocolFeeCapSats,
        protocolFeePolicy: record.protocolFeePolicy,
        protocolClaims: [...record.protocolClaims],
        signedTxid: record.signedTxid, signingIntentHex: record.signingIntentHex, signingIntentDurable: record.signingIntentDurable, state: record.state,
      };
    }
    const externalSignatures: ExternalSignatureRecord[] = [...this.externalSignatures.values()]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((row) => ({ ...row, relatedInputs: [...row.relatedInputs] }));
    const state: SerializedState = {
      version: CONTRACT_VERSION,
      scope: { ...this.scope },
      config: {
        walletScriptHex: this.config.walletScriptHex,
        dustThresholdSats: this.config.dustThresholdSats,
        maxUnconfirmedAncestors: this.config.maxUnconfirmedAncestors,
      },
      generation: this.generation,
      wocRevision: this.wocRevision,
      localRevision: this.localRevision,
      utxos,
      allocations,
      outbox: this.outbox.map((e) => ({
        commandId: e.commandId, allocationId: e.allocationId, txid: e.txid, rawTxHex: e.rawTxHex,
        state: e.state, delivery: e.delivery,
        ...(e.conclusion ? { conclusion: structuredClone(e.conclusion) } : {}),
      })),
      externalSignatures,
      ...(this.fundsFrozen ? { fundsFrozen: this.fundsFrozen } : {}),
    };
    return JSON.stringify(state);
  }

  static restore(blob: string, scope: Scope): FundingKernel {
    let state: SerializedState;
    try {
      state = JSON.parse(blob) as SerializedState;
    } catch {
      throw new UtmError("state-conflict", "snapshot blob is not JSON");
    }
    if (state.version !== CONTRACT_VERSION) throw new UtmError("version-unsupported", `unsupported state ${state.version}`);
    if (state.scope.owner !== scope.owner || state.scope.network !== scope.network) {
      throw new UtmError("scope-mismatch", "snapshot scope does not match");
    }
    if (!Number.isInteger(state.config.maxUnconfirmedAncestors) || state.config.maxUnconfirmedAncestors < 0) {
      throw new UtmError("state-conflict", "invalid stored maxUnconfirmedAncestors");
    }
    const kernel = new FundingKernel(scope, {
      walletScriptHex: checkScriptHex(state.config.walletScriptHex, "stored wallet script"),
      dustThresholdSats: formatAmount(parseAmount(state.config.dustThresholdSats, "stored dust threshold")),
      maxUnconfirmedAncestors: state.config.maxUnconfirmedAncestors,
    });
    for (const [key, row] of Object.entries(state.utxos)) {
      if (checkedOutpoint(key) !== key) throw new UtmError("tx-invalid", "noncanonical outpoint");
      const sources = [...(row.protectionSources ?? [])];
      // A legacy state carried `protected: true` without any source. Its
      // protection meaning must not be lost: an unknown protection keeps
      // blocking and can never be taken over.
      if (row.protected && sources.length === 0) sources.push("legacy:unknown");
      kernel.utxos.set(key, {
        value: parseAmount(row.value), scriptHex: row.scriptHex, status: row.status, height: row.height,
        source: row.source, creatingTxid: row.creatingTxid, spentBy: row.spentBy,
        spentExternal: row.spentExternal, occupiedBy: row.occupiedBy, protected: row.protected,
        protectionSources: sources, isolated: row.isolated,
        pendingParent: row.pendingParent ?? null,
        parentInputs: row.parentInputs ?? null, confirmed: row.confirmed ?? false,
      });
    }
    for (const [key, record] of Object.entries(state.allocations)) {
      const proofs: Record<string, { value: bigint; scriptHex: string }> = {};
      for (const [proofKey, proof] of Object.entries(record.externalProofs)) {
        proofs[proofKey] = { value: parseAmount(proof.value), scriptHex: proof.scriptHex };
      }
      kernel.allocations.set(key, {
        requestId: record.requestId, requestHash: record.requestHash, inputs: [...record.inputs],
        business: parseAmount(record.business), feeRate: parseAmount(record.feeRate),
        fee: parseAmount(record.fee), change: parseAmount(record.change),
        outputs: record.outputs.map((o) => ({ scriptHex: o.scriptHex, value: parseAmount(o.value) })),
        version: record.version, locktime: record.locktime, externalProofs: proofs,
        protocolBinding: record.protocolBinding ?? null,
        protocolInputs: (record.protocolInputs ?? []).map((f) => ({
          outpoint: f.outpoint, class: f.class, value: f.value, scriptHex: f.scriptHex, claimId: f.claimId ?? null,
        })),
        protocolFeeCapSats: record.protocolFeeCapSats ?? "",
        protocolFeePolicy: record.protocolFeePolicy ?? "",
        protocolClaims: [...(record.protocolClaims ?? [])],
        signedTxid: record.signedTxid,
        signingIntentHex: record.signingIntentHex ?? "", signingIntentDurable: record.signingIntentDurable ?? false, state: record.state,
      });
    }
    kernel.outbox = state.outbox.map((e) => {
      const entry: OutboxEntry = {
        commandId: e.commandId, allocationId: e.allocationId ?? null, txid: e.txid, rawTxHex: e.rawTxHex,
        state: e.state, delivery: e.delivery ?? "wallet",
        ...(e.conclusion ? { conclusion: structuredClone(e.conclusion) } : {}),
      };
      if (entry.allocationId === null) {
        // Backward compat: pre-allocationId blobs derive the owner from the
        // command shape (strip one trailing ":broadcast"; imports have none).
        if (entry.commandId.endsWith(":broadcast")) {
          entry.allocationId = entry.commandId.slice(0, -":broadcast".length);
        }
      }
      return entry;
    });
    for (const row of state.externalSignatures ?? []) {
      // `artifactInputs` is a derived cache, never independent authorization
      // evidence. Every outstanding record is re-parsed from the exact draft;
      // a missing, unreadable or disagreeing cache quarantines the duty.
      const relatedInputs = [...new Set((row.relatedInputs ?? []).map((key) => key.toLowerCase()))].sort();
      const cached = [...new Set((row.artifactInputs ?? []).map((key) => key.toLowerCase()))].sort();
      let artifactInputs = cached;
      let recordState = row.state;
      if (recordState !== "settled") {
        try {
          const parsed = parseTx(row.draftTxHex);
          const actual = [...new Set(parsed.inputs.map((txIn) => `${txIn.txid}:${txIn.vout}`))].sort();
          if (actual.length === 0) {
            recordState = "quarantined";
          } else if (cached.length === 0) {
            artifactInputs = actual;
          } else if (cached.length !== actual.length || !cached.every((key, index) => key === actual[index])) {
            // Keep every determinable responsibility: the cache may name a
            // real input the draft no longer does, or the draft may spend an
            // input the cache hid. The union stays frozen until trusted
            // evidence resolves the record.
            artifactInputs = [...new Set([...cached, ...actual])].sort();
            recordState = "quarantined";
          } else {
            artifactInputs = actual;
          }
        } catch {
          recordState = "quarantined";
        }
      }
      const incomplete = recordState !== "settled" && artifactInputs.length === 0;
      kernel.externalSignatures.set(row.id, {
        ...row,
        relatedInputs,
        artifactInputs,
        state: recordState,
      });
      // Isolating the record is not enough: the money it names must stop
      // being free balance. Every input the responsibility covers is
      // occupied by that allocation, or isolated when the scope cannot
      // prove who holds it.
      if (recordState === "settled") continue;
      if (incomplete) {
        // The artifact input set is unknown. Occupying the readable metadata
        // is not enough: freeze new funding for this scope until the host
        // resolves the quarantine with trusted evidence.
        kernel.fundsFrozen = kernel.fundsFrozen ?? `migration:${row.id}`;
      }
      const allocation = kernel.allocations.get(row.allocationId);
      for (const key of [...new Set([...relatedInputs, ...artifactInputs])].sort()) {
        const held = kernel.utxos.get(key);
        if (!held) {
          kernel.utxos.set(key, {
            value: 0n, scriptHex: "", status: "unconfirmed", height: 0, source: "external",
            creatingTxid: null, parentInputs: null, confirmed: false,
            spentBy: null, spentExternal: false, occupiedBy: null,
            protected: false, protectionSources: [], isolated: "external-signature-quarantine", pendingParent: null,
          });
          continue;
        }
        if (held.occupiedBy && held.occupiedBy !== row.allocationId) {
          held.isolated = "external-signature-quarantine";
          continue;
        }
        // Only inputs that belong to the allocation's authorized input set
        // become allocation occupations. A named input outside that set is
        // held by the signature duty itself, so settling the duty can release
        // it without fabricating an allocation claim.
        if (allocation && allocation.inputs.includes(key)) {
          if (!held.occupiedBy) held.occupiedBy = row.allocationId;
        } else {
          held.isolated = held.isolated ?? "external-signature-quarantine";
        }
        if (incomplete) held.isolated = held.isolated ?? "external-signature-quarantine";
      }
    }
    for (const entry of kernel.outbox) kernel.validateInputConclusion(entry);
    kernel.fundsFrozen = state.fundsFrozen ?? null;
    kernel.refreshFundsFrozen();
    kernel.generation = state.generation;
    kernel.wocRevision = state.wocRevision;
    kernel.localRevision = state.localRevision;
    return kernel;
  }

  private validateInputConclusion(entry: OutboxEntry): void {
    const c = entry.conclusion;
    if (!c) { if (entry.state === "failed") throw new UtmError("state-conflict", "failed outbox lacks conclusion"); return; }
    const invalid = () => new UtmError("state-conflict", "invalid persisted input conclusion");
    if ((c.status !== "conflict" && c.status !== "failed") || c.reason !== "input-conflict" || !Array.isArray(c.releasedInputs) || !Array.isArray(c.spentInputs) || !Array.isArray(c.heldInputs) || c.spentInputs.length === 0 || !entry.allocationId || entry.delivery !== "wallet") throw invalid();
    const allocation = this.allocations.get(entry.allocationId);
    if (!allocation || allocation.signedTxid !== entry.txid || allocation.state !== (c.status === "failed" ? "aborted" : "held") || entry.state !== (c.status === "failed" ? "failed" : "unknown") || (c.heldInputs.length === 0) !== (c.status === "failed")) throw invalid();
    let keys: string[];
    try { keys = parseTx(entry.rawTxHex, entry.txid).inputs.map(i => `${i.txid}:${i.vout}`); } catch { throw invalid(); }
    const seen = new Set<string>();
    const add = (key: string) => { if (!keys.includes(key) || seen.has(key)) throw invalid(); seen.add(key); };
    if (keys.length !== allocation.inputs.length || keys.some(key => !allocation.inputs.includes(key))) throw invalid();
    for (const key of c.releasedInputs) {
      add(key);
      const row = this.utxos.get(key);
      if (!row || row.occupiedBy === entry.allocationId) throw invalid();
    }
    for (const fact of c.spentInputs) {
      if (!fact || !/^[0-9a-f]{64}$/.test(fact.txid) || fact.txid === entry.txid || (fact.vin !== null && (!Number.isInteger(fact.vin) || fact.vin < 0 || fact.vin > 0xffffffff)) || (fact.confirmed !== null && typeof fact.confirmed !== "boolean")) throw invalid();
      add(fact.outpoint);
      if (this.utxos.get(fact.outpoint)?.spentBy !== fact.txid) throw invalid();
    }
    for (const key of c.heldInputs) {
      add(key);
      const row = this.utxos.get(key);
      if (!row || (row.occupiedBy !== entry.allocationId && !row.protected && !row.isolated)) throw invalid();
    }
    if (seen.size !== keys.length) throw invalid();
    const amount = c.releasedInputs.reduce((sum, key) => sum + (this.utxos.get(key)?.scriptHex === this.config.walletScriptHex ? this.utxos.get(key)!.value : 0n), 0n);
    try { if (c.releasedSats !== formatAmount(amount)) throw invalid(); } catch { throw invalid(); }
  }

  /** Canonical state hash for cross-language comparison. */
  stateHash(): string {
    return calcTxid(new TextEncoder().encode(this.serialize()));
  }
}
