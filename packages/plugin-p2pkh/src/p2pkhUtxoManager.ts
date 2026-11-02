// Wallet caller adapter for the memory-only allocation component. Payment plans
// and signed bytes here are runtime construction metadata, not a durable ledger.
import { deriveP2pkhAddress, type BorrowedModuleFileStore, type P2pkhPaymentLookupResult } from "@keymaster/contracts";
import { FundingKernel, buildUnsigned, parseTx, estimateFeeSats, estimateSignedSize } from "keymaster-utxo-manager";
import { buildPaymentTemplate, type PaymentType, type PaymentOutputRole } from "./p2pkhPaymentTemplate.js";
import { p2pkhAddressToScriptHex } from "./p2pkhTransactionParser.js";
import type { P2pkhKeyResource, P2pkhUtxo } from "./p2pkhContracts.js";

type Resource = Pick<P2pkhKeyResource, "resourceId" | "network" | "address">;
type Identity = { ownerPublicKeyHex: string; network: "main" | "test" };
export interface P2pkhManagerInputEvidence { utxo: P2pkhUtxo }
export interface P2pkhManagerReservation {
 allocationId: string; unsignedTxHex: string; businessSats: string; feeSats: string; changeSats: string; totalInSats: string;
 selectedOutpoints: string[]; selectedInputs: P2pkhManagerInputEvidence[];
 outputs: Array<{vout: number; scriptHex: string; valueSats: string; role: PaymentOutputRole}>;
 businessScriptHex: string; changeScriptHex: string | null; planDigest?: string;
}
interface InputAllocation {
 ownerPublicKeyHex: string; resource: Resource; allocationId?: string;
 outpoints: string[]; submissionId: string; artifactId?: string;
}
interface TransactionRecord {
 allocationId: string; paymentId?: string; submissionId?: string; artifactId?: string; rawTxHex?: string; txid?: string;
}
interface State { pool: FundingKernel; revision: number; resource: Resource; owner: string; records: Map<string, TransactionRecord> }
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
    revision: 0, resource, owner, records: new Map()}; states.set(key, value);
  }
  return value;
 }
 function scoped(request: Identity) {return state(request.ownerPublicKeyHex, {resourceId: `p2pkh:${request.network}`, network: request.network, address: deriveP2pkhAddress(request.ownerPublicKeyHex, request.network)});}
 function evidence(s: State, keys: readonly string[]): P2pkhManagerInputEvidence[] {
  return keys.map(key => {const row = s.pool.lookup(key);
   return {utxo: {id: key, resourceId: s.resource.resourceId, publicKeyHex: s.owner, network: s.resource.network, address: s.resource.address,
    txid: row.txid, vout: row.vout, value: Number(row.value), script: row.scriptHex, height: row.height, status: row.status,
    isSpentInMempoolTx: false, syncedAt: new Date().toISOString()}};});
 }
 const manager = {
  dispose() {disposed = true; states.clear(); if (instances.get(input.files) === manager) instances.delete(input.files);},
  async observe(request: {ownerPublicKeyHex: string; resource: Resource; utxos: readonly P2pkhUtxo[]}) {
   const s = state(request.ownerPublicKeyHex, request.resource);
   s.pool.applySnapshot({generation: 1, revision: ++s.revision, utxos: request.utxos.map(row => ({txid: row.txid, vout: row.vout, value: String(row.value),
    scriptHex: row.script ?? s.pool.config.walletScriptHex, status: row.status, height: row.height ?? 0}))});
  },
  async available(request: {ownerPublicKeyHex: string; resource: Resource}) {const s = state(request.ownerPublicKeyHex, request.resource); return {observed: s.revision > 0, inputs: evidence(s, s.pool.spendableOutpoints())};},
  async reserve(request: {ownerPublicKeyHex: string; resource: P2pkhKeyResource; feeRateSatoshisPerKb: number; recipientAddress?: string; recipientScriptHex?: string;
   paymentType?: PaymentType; paymentId?: string; amountSatoshis: number; sendAll: boolean}): Promise<P2pkhManagerReservation> {
   const s = state(request.ownerPublicKeyHex, request.resource), allocationId = crypto.randomUUID();
   const scriptHex = request.recipientScriptHex ?? p2pkhAddressToScriptHex(request.recipientAddress!, request.resource.network);
   let business = BigInt(request.amountSatoshis);
   if (request.sendAll) {
    const balance = BigInt(s.pool.spendableBalance()); const fee = estimateFeeSats(BigInt(request.feeRateSatoshisPerKb), estimateSignedSize(s.pool.spendableOutpoints().length, [scriptHex.length / 2]));
    if (balance <= fee) throw new Error("Insufficient balance"); business = balance - fee;
   }
   const view = s.pool.request({requestId: allocationId, businessAmountSats: String(business), feeRateSatPerKb: String(request.feeRateSatoshisPerKb), outputs: [{scriptHex, value: String(business)}]});
   const changeScriptHex = BigInt(view.changeSats) > 0n ? s.pool.config.walletScriptHex : null;
   const outputs = buildPaymentTemplate({paymentType: request.paymentType ?? "p2pkh", businessAmountSats: String(business), businessScriptHex: scriptHex,
    changeAmountSats: view.changeSats, changeScriptHex});
   const unsignedTxHex = buildUnsigned({inputs: view.inputs.map(key => {const row = s.pool.lookup(key); return {txid: row.txid, vout: row.vout};}), outputs: outputs.map(row => ({scriptHex: row.scriptHex, value: row.valueSats}))});
   const result = {allocationId, unsignedTxHex, businessSats: String(business), feeSats: view.feeSats, changeSats: view.changeSats, totalInSats: view.totalInSats,
    selectedOutpoints: view.inputs, selectedInputs: evidence(s, view.inputs), outputs, businessScriptHex: scriptHex, changeScriptHex};
   const planDigest = JSON.stringify(result.outputs);
   s.records.set(allocationId, {allocationId, paymentId: request.paymentId});
   return {...result, planDigest};
  },
  async release(request: Identity & {allocationId?: string; submissionId?: string}) {
   const s = scoped(request); const id = request.allocationId ?? [...s.records.values()].find(row => row.submissionId === request.submissionId)?.allocationId;
   if (id) s.pool.release(id);
  },
  async refreshAllocationInputs(request: {ownerPublicKeyHex: string; resource: Resource; allocationId: string}) {
   const s = state(request.ownerPublicKeyHex, request.resource); return evidence(s, s.pool.allocationView(request.allocationId).inputs);
  },
  async selectProtocolFunding(request: {ownerPublicKeyHex: string; resource: Resource; amountSatoshis: number; feeRateSatoshisPerKb: number; outputs?: Array<{scriptHex: string; value: string}>}) {
   const s = state(request.ownerPublicKeyHex, request.resource), allocationId = crypto.randomUUID();
   const view = s.pool.request({requestId: allocationId, businessAmountSats: String(request.amountSatoshis), feeRateSatPerKb: String(request.feeRateSatoshisPerKb),
    outputs: request.outputs ?? [{scriptHex: s.pool.config.walletScriptHex, value: String(request.amountSatoshis)}]});
   s.records.set(allocationId, {allocationId});
   return {allocationId, selectedInputs: evidence(s, view.inputs), totalInputSatoshis: Number(view.totalInSats)};
  },
  async allocateInputs(request: InputAllocation) {
   const s = state(request.ownerPublicKeyHex, request.resource);
   const existing = request.artifactId ? [...s.records.values()].find(row => row.artifactId === request.artifactId) : undefined;
   if (existing) return {allocationId: existing.allocationId};
   const allocationId = request.allocationId ?? crypto.randomUUID();
   if (!request.allocationId) s.pool.allocate(allocationId, request.outpoints);
   s.records.set(allocationId, {allocationId, submissionId: request.submissionId, artifactId: request.artifactId});
   return {allocationId};
  },
  async rememberTransaction(request: {ownerPublicKeyHex: string; resource: Resource; allocationId: string; signedTxHex: string}) {
   const s = state(request.ownerPublicKeyHex, request.resource), tx = parseTx(request.signedTxHex);
   const record = s.records.get(request.allocationId)!; record.rawTxHex = request.signedTxHex; record.txid = tx.canonicalTxid;
   return {txid: tx.canonicalTxid};
  },
  async observeAcceptedExact(request: {ownerPublicKeyHex: string; resource: Resource; rawTxHex: string}) {
   const tx = parseTx(request.rawTxHex);
   state(request.ownerPublicKeyHex, request.resource).pool.acceptTransaction({
    txid: tx.canonicalTxid, spentOutpoints: tx.inputs.map(row => row.outpointKey),
    outputs: tx.outputs.map((row, vout) => ({vout, value: String(row.value), scriptHex: row.scriptHex})),
   });
  },
  async walletTransaction(request: Identity & {txid: string}) {return [...scoped(request).records.values()].find(row => row.txid === request.txid);},
  async paymentStatus(request: Identity & {paymentId: string}): Promise<P2pkhPaymentLookupResult> {
   const s = scoped(request), record = [...s.records.values()].find(row => row.paymentId === request.paymentId);
   if (!record) return {status: "not_found"}; const allocation = s.pool.allocationView(record.allocationId);
   return {status: allocation.state === "used" ? "accepted" : allocation.state === "released" ? record.txid ? "failed" : "not_signed" : record.txid ? "unknown" : "pending", allocationId: record.allocationId, txid: record.txid};
  },
 };
 instances.set(input.files, manager); return manager;
}
export interface P2pkhUtxoManager {
 dispose(): void;
 observe(request: {ownerPublicKeyHex: string; resource: Resource; utxos: readonly P2pkhUtxo[]}): Promise<void>;
 available(request: {ownerPublicKeyHex: string; resource: Resource}): Promise<{observed: boolean; inputs: P2pkhManagerInputEvidence[]}>;
 reserve(request: {ownerPublicKeyHex: string; resource: P2pkhKeyResource; feeRateSatoshisPerKb: number; recipientAddress?: string; recipientScriptHex?: string; paymentType?: PaymentType; paymentId?: string; amountSatoshis: number; sendAll: boolean}): Promise<P2pkhManagerReservation>;
 release(request: Identity & {allocationId?: string; submissionId?: string}): Promise<void>;
 refreshAllocationInputs(request: {ownerPublicKeyHex: string; resource: Resource; allocationId: string}): Promise<P2pkhManagerInputEvidence[]>;
 selectProtocolFunding(request: {ownerPublicKeyHex: string; resource: Resource; amountSatoshis: number; feeRateSatoshisPerKb: number; outputs?: Array<{scriptHex: string; value: string}>}): Promise<{allocationId: string; selectedInputs: P2pkhManagerInputEvidence[]; totalInputSatoshis: number}>;
 allocateInputs(request: InputAllocation): Promise<{allocationId: string}>;
 rememberTransaction(request: {ownerPublicKeyHex: string; resource: Resource; allocationId: string; signedTxHex: string}): Promise<{txid: string}>;
 observeAcceptedExact(request: {ownerPublicKeyHex: string; resource: Resource; rawTxHex: string}): Promise<void>;
 walletTransaction(request: Identity & {txid: string}): Promise<TransactionRecord | undefined>;
 paymentStatus(request: Identity & {paymentId: string}): Promise<P2pkhPaymentLookupResult>;
}
