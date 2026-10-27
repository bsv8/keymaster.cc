import { requireWocNetwork } from "@keymaster/contracts";
import type { ActiveKeyCrypto, BorrowedModuleFileStore, CentralBroadcastService, P2pkhUtxoSnapshotResult, ProtectedOutpoint, ProtocolSubmissionObservation, WocService } from "@keymaster/contracts";
import { createP2pkhProtocolSpendService, type P2pkhProtocolManagerPort } from "./p2pkhProtocolSpend.js";
import { createProtocolFundingService } from "./p2pkhProtocolFunding.js";
import { createProtectedOutpointRegistry } from "./registries/protectedOutpointRegistry.js";
import { createP2pkhFileRepository } from "./storage/p2pkhFileRepository.js";
import { openP2pkhStateRepository } from "./storage/p2pkhStateRepository.js";
import { createWorkerProtocolEvidence } from "./workerProtocolEvidence.js";
import { createWalletProtectedOutpoints } from "./registries/walletProtectedOutpoints.js";
import type { P2pkhService } from "./p2pkhContracts.js";

export interface WorkerProtocolDependencies {
  requestPayment: import("@keymaster/contracts").VaultService["requestPayment"];
  assertActive(): void;
  owner: string;
  network: "main" | "test";
  storage: BorrowedModuleFileStore;
  crypto(owner: string): Promise<ActiveKeyCrypto>;
  central: CentralBroadcastService;
  transfer: P2pkhService;
  snapshot(network: "main" | "test"): Promise<P2pkhUtxoSnapshotResult>;
  query(): WocService | undefined;
  /** UTXO manager port: durable pre-sign intent and exact-byte ownership. */
  protocolManager?: P2pkhProtocolManagerPort;
}

/** A disposable projection of the existing wallet funding files, never a second ledger. */
export async function readWorkerProtocolProtection(storage: BorrowedModuleFileStore, owner: string, network: "main" | "test"): Promise<ProtectedOutpoint[]> {
  const { records, unreadable } = await createP2pkhFileRepository((await openP2pkhStateRepository(storage)).files).listProtocolFunding();
  if (unreadable.length) throw new Error("Unreadable protocol funding records; wallet spending is blocked");
  const state = createWorkerProtocolEvidence(storage);
  const submissions = await state.listProtocolSubmissions();
  const ids = new Set(submissions.filter(row => row.publicKeyHex.toLowerCase() === owner.toLowerCase() && row.network === network).map(row => row.id));
  const claims = await state.listLocalInputClaims();
  const claimed = claims.filter(row => ids.has(row.submissionId) && row.publicKeyHex.toLowerCase() === owner.toLowerCase() && row.network === network && (row.state === "active" || row.state === "isolated"))
    .map(row => ({
      txid: row.txid, vout: row.vout, network: row.network, publicKeyHex: row.publicKeyHex,
      ownerPluginId: "p2pkh", kind: "protocol-claim",
      // The source identifies the occupation: the manager may take over THIS
      // submission's claim, but never somebody else's.
      source: `occupation:${row.submissionId}`, submissionId: row.submissionId,
    }));
  return [...claimed, ...records.filter(row => row.ownerPublicKeyHex.toLowerCase() === owner.toLowerCase() && row.network === network)
    .map(row => ({
      txid: row.txid, vout: row.vout, network: row.network, publicKeyHex: row.ownerPublicKeyHex,
      ownerPluginId: row.ownerPluginId ?? "p2pkh", kind: "protocol-funding",
      source: `fund:${row.fundingId}`,
    }))];
}


export async function createWorkerProtocolRuntime(deps: WorkerProtocolDependencies) {
  const registry = createProtectedOutpointRegistry();
  const check = (owner = deps.owner) => { deps.assertActive(); if (owner.toLowerCase() !== deps.owner.toLowerCase()) throw new Error("Protocol wallet owner mismatch"); };
  const protectionView = createWalletProtectedOutpoints(registry, { identity: { publicKeyHex: deps.owner, bsvNetwork: deps.network }, assertActive: () => check() });
  const state = async () => { check(); const store = createWorkerProtocolEvidence(deps.storage); check(); return store; };
  const files = async () => { check(); const store = createP2pkhFileRepository((await openP2pkhStateRepository(deps.storage)).files); check(); return store; };
  const observeProtocolSubmission = async (input: { ownerPublicKeyHex: string; network: "main" | "test"; txid: string; submissionId: string }): Promise<ProtocolSubmissionObservation> => {
    check(input.ownerPublicKeyHex);
    const row = await (await state()).getProtocolSubmission(input.submissionId);
    check();
    if (!row || row.publicKeyHex.toLowerCase() !== deps.owner.toLowerCase() || row.network !== input.network || row.canonicalTxid !== input.txid) return "unknown";
    switch (row.status) {
      case "prepared": return "not-dispatched";
      case "broadcast-pending-woc": case "woc-observed-unconfirmed": return "observed-unconfirmed";
      case "woc-confirmed": return "observed-confirmed";
      case "woc-dropped": return "dropped";
      case "rejected": return row.droppedReason === "prepared-spend-released" ? "not-dispatched" : "rejected";
      default: return "unknown";
    }
  };
  const executor = createP2pkhProtocolSpendService({
    assertInputsUnspent:async(network,inputs)=>{const query=deps.query();if(!query)throw Error("Protocol input reader unavailable");await Promise.all(inputs.map(async i=>{if(await requireWocNetwork(query, network).getSpentOutput(i.txid, i.vout)!==null)throw Error("Protocol input is already spent");}));check();},
    previousTransactions: async (network, inputs) => { const q = deps.query(); if (!q?.getRawTransaction) throw new Error("Complete previous transaction reader unavailable"); const raw = await Promise.all(inputs.map(i => requireWocNetwork(q, network).getRawTransaction!(i.txid))); check(); return raw; },
    vault: { requestPayment: c => { check(); return deps.requestPayment(c); }, status: () => { check(); return "unlocked"; }, createActiveKeyCrypto: async () => { check(); const crypto = await deps.crypto(deps.owner); check(); return crypto; } },
    centralBroadcastService: deps.central,
    getUtxoBinding: async ({ ownerPublicKeyHex, network }) => {
      check(ownerPublicKeyHex); const snapshot = await deps.snapshot(network); check();
      return snapshot.hasResult ? { resourceId: `p2pkh:${network}`, seq: snapshot.seq } : undefined;
    },
    getKeyForOwner: async owner => { check(owner); return { publicKeyHex: deps.owner }; },
    claimStore: {
      async tryClaimInputs(input) { check(input.publicKeyHex); const result = await (await state()).tryClaimInputs(input); check(); return result; },
      async releaseLocalInputClaims(input) { check(input.publicKeyHex); await (await state()).releaseLocalInputClaims(input.claimIds); check(); },
    },
    submissionStore: {
      async getProtocolSubmission(input) { check(input.publicKeyHex); return (await state()).getProtocolSubmission(input.id); },
      async putProtocolSubmission(record) { check(record.publicKeyHex); await (await state()).putProtocolSubmission(record); check(); },
    },
    protectedOutpoints: registry,
    protocolManager: deps.protocolManager,
  });
  const scoped = <T extends object>(input: T) => {
    check();
    if ("ownerPublicKeyHex" in input || "network" in input) throw new TypeError("Protocol requests cannot select a wallet");
    return { ...structuredClone(input), ownerPublicKeyHex: deps.owner, network: deps.network };
  };
  const assertPreview = (preview: import("@keymaster/contracts").ProtocolSpendPreview) => {
    check(preview.ownerPublicKeyHex);
    if (preview.network !== deps.network) throw new Error("Protocol preview network mismatch");
  };
  const spend: import("@keymaster/contracts").ProtocolSpendService = {
    async prepare(input) { const value = await executor.prepare(scoped(input)); check(); assertPreview(value); return value; },
    async presign(input) { const value = await executor.presign(scoped(input)); check(); assertPreview(value); return value; },
    async submit(input) { assertPreview(input); const result = await executor.submit(input); check(); return result; },
    async releasePrepared(input) { assertPreview(input); await executor.releasePrepared!(input); check(); },
    async releasePreparedSubmission(input) { await executor.releasePreparedSubmission(scoped(input)); check(); },
  };
  const planFunding = async (input: { ownerPublicKeyHex: string; network: "main" | "test"; amountSatoshis: number; feeRateSatoshisPerKb: number; outputs?: Array<{ scriptHex: string; value: string }> }) => {
    check(input.ownerPublicKeyHex);
    if (!deps.protocolManager?.selectFundingInputs) throw new Error("Protocol funding requires manager selection");
    const result = await deps.protocolManager.selectFundingInputs(input);
    check();
    return result;
  };
  const funding = createProtocolFundingService({
    binding: { identity: { publicKeyHex: deps.owner, bsvNetwork: deps.network }, assertActive: check },
    protocolSpend: () => { check(); return spend; }, protectedOutpoints: registry,
    store: {
      async get(id, owner) { check(owner); return (await files()).readProtocolFunding(id); },
      async put(record, options) { check(record.ownerPublicKeyHex); await (await files()).writeProtocolFunding({ ...record, updatedAtMs: record.updatedAtMs ?? Date.now() }, options); check(); },
      async delete(id) { await (await files()).deleteProtocolFunding(id); check(); },
      async list(owner) { check(owner); const result = await (await files()).listProtocolFunding(); check(); return { ...result, records: result.records.filter(row => row.ownerPublicKeyHex.toLowerCase() === owner.toLowerCase()) }; },
    },
    async allocate(input) {
      check();
      const result = await planFunding({
        ownerPublicKeyHex: deps.owner, network: input.assetId === "bsvtest" ? "test" : "main",
        amountSatoshis: input.amountSatoshis, feeRateSatoshisPerKb: input.feeRateSatoshisPerKb,
      });
      check();
      return result;
    },
    async deriveChangeAddress(owner, network) { check(owner); const crypto = await deps.crypto(owner); try { const result = await crypto.deriveP2pkhAddress(); check(); return result.address; } finally { crypto.dispose("protocol-address-derived"); } },
    async observeChain(network, txid) { const query = deps.query(); if (!query) return "unknown"; const result = await requireWocNetwork(query, network).getTransactionObservation(txid); check(); return result.observation === "confirmed" ? "confirmed" : result.observation === "unconfirmed" ? "mempool" : "unknown"; },
    async observeOutpoint({ network, txid, vout }) { const query = deps.query(); if (!query) return "unknown"; try { const spent = await requireWocNetwork(query, network).getSpentOutput(txid, vout); check(); return spent === null ? "unspent" : "spent"; } catch { check(); return "unknown"; } },
    observeSubmission: observeProtocolSubmission,
  });
  await funding.restoreProtections!();
  check();
  return Object.freeze({ identity: Object.freeze({ publicKeyHex: deps.owner, bsvNetwork: deps.network }), spend, executor, funding, planFundingCommand: planFunding,
    planFunding: (input: import("@keymaster/contracts").ProtocolFundingPlanRequest) => planFunding(scoped(input)), observer: { observeProtocolSubmission: (input: { txid: string; submissionId: string }) => observeProtocolSubmission(scoped(input)) }, protectedOutpoints: registry, protectionView,
    dispose() { for (const id of registry._ids()) registry.unregister(id); },
  });
}
