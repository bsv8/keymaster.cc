// Host identity/type adapter only. No transaction plans, submission registry,
// payment conclusions or reconstruction of the kernel's occupancy invariants.
import { traceDev, deriveP2pkhAddress, type BorrowedModuleFileStore } from "@keymaster/contracts";
import { FundingKernel, type AcceptedTransaction, type AllocationMaterial, type AllocationView, type Funds, type SnapshotUtxo } from "keymaster-utxo-manager";
import { p2pkhAddressToScriptHex } from "./p2pkhTransactionParser.js";
import type { P2pkhKeyResource, P2pkhUtxo } from "./p2pkhContracts.js";

type Resource = Pick<P2pkhKeyResource, "resourceId" | "network" | "address">;
export type FundingIdentity = {ownerPublicKeyHex: string; network: "main" | "test"};
type ScopedResource = {ownerPublicKeyHex: string; resource: Resource};
export interface P2pkhManagerInputEvidence { utxo: P2pkhUtxo }
export interface P2pkhFundingAllocation extends AllocationView { selectedInputs: P2pkhManagerInputEvidence[] }
export interface P2pkhAllFundingAllocation {
 allocationId: string; totalInSats: string; selectedInputs: P2pkhManagerInputEvidence[];
}
interface State { pool: FundingKernel; revision: number; resource: Resource; owner: string }
const instances = new WeakMap<object, P2pkhUtxoManager>();
export function createP2pkhUtxoManager(input: {files: BorrowedModuleFileStore}): P2pkhUtxoManager {
 const prior = instances.get(input.files); if (prior) return prior;
 const states = new Map<string, State>(); let disposed = false;
 function state(owner: string, resource: Resource): State {
  if (disposed) throw new Error("UTXO allocation instance revoked");
  const key = `${owner.toLowerCase()}:${resource.network}`;
  let value = states.get(key);
  if (!value) {
   value = {pool: new FundingKernel({owner: owner.toLowerCase(), network: resource.network},
    {walletScriptHex: p2pkhAddressToScriptHex(resource.address, resource.network), dustThresholdSats: "1"}),
    revision: 0, resource, owner}; states.set(key, value);
  }
  return value;
 }
 function scoped(request: FundingIdentity) {return state(request.ownerPublicKeyHex, {resourceId: `p2pkh:${request.network}`, network: request.network, address: deriveP2pkhAddress(request.ownerPublicKeyHex, request.network)});}
 function evidence(s: State, rows: readonly SnapshotUtxo[]): P2pkhManagerInputEvidence[] {
  return rows.map(row => ({utxo: {id: `${row.txid}:${row.vout}`, resourceId: s.resource.resourceId, publicKeyHex: s.owner,
   network: s.resource.network, address: s.resource.address, txid: row.txid, vout: row.vout, value: Number(row.value),
   script: row.scriptHex, height: row.height, status: row.status, isSpentInMempoolTx: false, syncedAt: new Date().toISOString()}}));
 }
 function material(s: State, value: AllocationMaterial): P2pkhFundingAllocation {
  return {...value.allocation, selectedInputs: evidence(s, value.inputs)};
 }
 function operation<T>(s: State, kind: string, detail: unknown, run: () => T): T {
  traceDev("keymaster.utxo", `${kind}.start`, () => ({owner: s.owner, network: s.resource.network, detail, funds: s.pool.funds()}));
  try {
   const result = run();
   traceDev("keymaster.utxo", `${kind}.finish`, () => ({owner: s.owner, network: s.resource.network, detail, result, funds: s.pool.funds()}));
   return result;
  } catch (error) {
   traceDev("keymaster.utxo", `${kind}.error`, () => ({owner: s.owner, network: s.resource.network, detail, error, funds: s.pool.funds()}));
   throw error;
  }
 }
 const manager: P2pkhUtxoManager = {
  dispose() {disposed = true; states.clear(); if (instances.get(input.files) === manager) instances.delete(input.files);},
  async observe(request) {
   const s = state(request.ownerPublicKeyHex, request.resource);
   s.pool.applySnapshot({generation: 1, revision: ++s.revision, utxos: request.utxos.map(row => ({txid: row.txid, vout: row.vout, value: String(row.value),
    scriptHex: row.script ?? s.pool.config.walletScriptHex, status: row.status, height: row.height ?? 0}))});
  },
  async funds(request) { return scoped(request).pool.funds(); },
  async request(request) {
   const s = state(request.ownerPublicKeyHex, request.resource);
   return operation(s, "request", request, () => material(s, s.pool.request({requestId: crypto.randomUUID(), businessAmountSats: request.amountSats,
    feeRateSatPerKb: request.feeRateSatPerKb, outputs: request.outputs})));
  },
  async requestAll(request) {
   const s = state(request.ownerPublicKeyHex, request.resource);
   return operation(s, "request-all", request, () => {
    const value = s.pool.requestAll({requestId: crypto.randomUUID()});
    return {allocationId: value.allocationId, totalInSats: value.totalInSats, selectedInputs: evidence(s, value.inputs)};
   });
  },
  async assertAllocationUsable(request) {scoped(request).pool.assertAllocationUsable(request.allocationId);},
  async release(request) {const s = scoped(request); operation(s, "release", request, () => s.pool.release(request.allocationId));},
  async acceptTransaction(request) {const s = scoped(request); operation(s, "accept", request, () => s.pool.acceptTransaction(request.transaction));},
 };
 instances.set(input.files, manager); return manager;
}
export interface P2pkhUtxoManager {
 dispose(): void;
 observe(request: ScopedResource & {utxos: readonly P2pkhUtxo[]}): Promise<void>;
 funds(request: FundingIdentity): Promise<Funds>;
 request(request: ScopedResource & {amountSats: string; feeRateSatPerKb: string; outputs: Array<{scriptHex: string; value: string}>}): Promise<P2pkhFundingAllocation>;
 requestAll(request: ScopedResource): Promise<P2pkhAllFundingAllocation>;
 assertAllocationUsable(request: FundingIdentity & {allocationId: string}): Promise<void>;
 release(request: FundingIdentity & {allocationId: string}): Promise<void>;
 acceptTransaction(request: FundingIdentity & {transaction: AcceptedTransaction}): Promise<void>;
}
