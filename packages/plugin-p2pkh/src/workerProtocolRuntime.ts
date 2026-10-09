import type { ActiveKeyCrypto, BorrowedModuleFileStore, CentralBroadcastService, P2pkhUtxoSnapshotResult, ProtectedOutpoint, ProtocolSubmissionObservation, WocService } from "@keymaster/contracts";
import { createP2pkhProtocolSpendService } from "./p2pkhProtocolSpend.js";
import { createProtocolFundingService } from "./p2pkhProtocolFunding.js";
import { createProtectedOutpointRegistry } from "./registries/protectedOutpointRegistry.js";
import { createP2pkhFileRepository } from "./storage/p2pkhFileRepository.js";
import { openP2pkhStateRepository } from "./storage/p2pkhStateRepository.js";
import { createWorkerProtocolEvidence } from "./workerProtocolEvidence.js";
import type { P2pkhService } from "./p2pkhContracts.js";

export interface WorkerProtocolDependencies {
  assertActive(): void;
  owner: string;
  storage: BorrowedModuleFileStore;
  crypto(owner: string): Promise<ActiveKeyCrypto>;
  central: CentralBroadcastService;
  transfer: P2pkhService;
  snapshot(network: "main" | "test"): Promise<P2pkhUtxoSnapshotResult>;
  query(): WocService | undefined;
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
    .map(row => ({ txid: row.txid, vout: row.vout, network: row.network, publicKeyHex: row.publicKeyHex, ownerPluginId: "p2pkh", kind: "protocol-claim" }));
  return [...claimed, ...records.filter(row => row.ownerPublicKeyHex.toLowerCase() === owner.toLowerCase() && row.network === network)
    .map(row => ({ txid: row.txid, vout: row.vout, network: row.network, publicKeyHex: row.ownerPublicKeyHex, ownerPluginId: row.ownerPluginId ?? "p2pkh", kind: "protocol-funding" }))];
}

export async function createWorkerProtocolRuntime(deps: WorkerProtocolDependencies) {
  const registry = createProtectedOutpointRegistry();
  const check = (owner = deps.owner) => { deps.assertActive(); if (owner.toLowerCase() !== deps.owner.toLowerCase()) throw new Error("Protocol wallet owner mismatch"); };
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
  const spend = createP2pkhProtocolSpendService({
    vault: { status: () => { check(); return "unlocked"; }, createActiveKeyCrypto: async owner => { check(owner); const crypto = await deps.crypto(owner); check(); return crypto; } },
    centralBroadcastService: deps.central,
    getUtxoBinding: async ({ ownerPublicKeyHex, network }) => {
      check(ownerPublicKeyHex); const snapshot = await deps.snapshot(network); check();
      return snapshot.available && snapshot.state === "fresh" && snapshot.seq !== undefined ? { resourceId: `p2pkh:${network}`, seq: snapshot.seq } : undefined;
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
  });
  const funding = createProtocolFundingService({
    protocolSpend: () => { check(); return spend; }, protectedOutpoints: registry,
    store: {
      async get(id, owner) { check(owner); return (await files()).readProtocolFunding(id); },
      async put(record, options) { check(record.ownerPublicKeyHex); await (await files()).writeProtocolFunding({ ...record, updatedAtMs: record.updatedAtMs ?? Date.now() }, options); check(); },
      async delete(id) { await (await files()).deleteProtocolFunding(id); check(); },
      async list(owner) { check(owner); const result = await (await files()).listProtocolFunding(); check(); return { ...result, records: result.records.filter(row => row.ownerPublicKeyHex.toLowerCase() === owner.toLowerCase()) }; },
    },
    async allocate(input) { check(); const result = await deps.transfer.allocateUtxos(input); check(); return { selected: result.selected, totalInputSatoshis: result.totalInputSatoshis }; },
    async deriveChangeAddress(owner, network) { check(owner); const crypto = await deps.crypto(owner); try { const result = await crypto.deriveP2pkhAddress({ publicKeyHex: owner, network }); check(); return result.address; } finally { crypto.dispose("protocol-address-derived"); } },
    async observeChain(network, txid) { const query = deps.query(); if (!query) return "unknown"; const result = await query.getTransactionObservation(network, txid); check(); return result.observation === "confirmed" ? "confirmed" : result.observation === "unconfirmed" ? "mempool" : "unknown"; },
    async observeOutpoint({ network, txid, vout }) { const query = deps.query(); if (!query) return "unknown"; try { const spent = await query.getSpentOutput(network, txid, vout); check(); return spent === null ? "unspent" : "spent"; } catch { check(); return "unknown"; } },
    observeSubmission: observeProtocolSubmission,
  });
  await funding.restoreProtections!({ ownerPublicKeyHex: deps.owner, network: "main" });
  check();
  return Object.freeze({ spend, funding, observer: { observeProtocolSubmission }, protectedOutpoints: registry,
    dispose() { for (const id of registry._ids()) registry.unregister(id); },
  });
}
