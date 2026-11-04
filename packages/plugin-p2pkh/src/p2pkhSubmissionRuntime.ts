// Caller-owned transaction intentions and outcomes, not a UTXO pool. No balances,
// selection, occupancy, manager-state inference or restoration from disk.
import type { BorrowedModuleFileStore, P2pkhPaymentLookupResult, ProtocolSpendInput, ProtocolSpendOutput } from "@keymaster/contracts";
import { parseTx, type AcceptedTransaction } from "keymaster-utxo-manager";
import type { UnsignedTx } from "./p2pkhSigner.js";
import type { FundingIdentity } from "./p2pkhUtxoManager.js";

export interface SubmissionPlan extends FundingIdentity {
 submissionId: string;
 allocationId?: string;
 paymentId?: string;
 unsignedTxHex: string;
 inputs: ProtocolSpendInput[];
 outputs: ProtocolSpendOutput[];
 feeSatoshis: number;
 feeRateSatoshisPerKb: number;
 changeSatoshis: number;
 changeAddress?: string;
}
type SubmissionState = "prepared" | "signing" | "signed" | "dispatching" | "unknown" | "accepted" | "already-known" | "rejected" | "cancelled";
export interface RuntimeSubmission {
 plan: SubmissionPlan; state: SubmissionState; txid?: string; rawTxHex?: string;
}
const instances = new WeakMap<object, P2pkhSubmissionRuntime>();
const sameScope = (row: RuntimeSubmission, scope: FundingIdentity) => row.plan.ownerPublicKeyHex.toLowerCase() === scope.ownerPublicKeyHex.toLowerCase() && row.plan.network === scope.network;
export function acceptedTransaction(rawTxHex: string): AcceptedTransaction {
 const tx = parseTx(rawTxHex);
 return {txid: tx.canonicalTxid, spentOutpoints: tx.inputs.map(row => row.outpointKey),
  outputs: tx.outputs.map((row, vout) => ({vout, value: String(row.value), scriptHex: row.scriptHex}))};
}
export function unsignedFromExact(rawTxHex: string): UnsignedTx {
 const tx = parseTx(rawTxHex);
 const bytes = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], byte => Number.parseInt(byte, 16));
 return {version: tx.version, lockTime: tx.locktime,
  inputs: tx.inputs.map(row => ({prevTxid: row.txid, prevVout: row.vout, sequence: row.sequence, scriptSig: bytes(row.scriptSigHex)})),
  outputs: tx.outputs.map(row => ({value: Number(row.value), script: bytes(row.scriptHex)}))};
}
export function createP2pkhSubmissionRuntime(files: BorrowedModuleFileStore): P2pkhSubmissionRuntime {
 const prior = instances.get(files); if (prior) return prior;
 const submissions = new Map<string, RuntimeSubmission>(); let disposed = false;
 function active() {if (disposed) throw new Error("Transaction runtime revoked");}
 function get(scope: FundingIdentity & {submissionId: string}) {
  active(); const row = submissions.get(scope.submissionId);
  if (!row || !sameScope(row, scope)) throw new Error("Transaction intention unavailable in this runtime");
  return row;
 }
 const runtime: P2pkhSubmissionRuntime = {
  dispose() {disposed = true; submissions.clear(); if (instances.get(files) === runtime) instances.delete(files);},
  prepare(plan: SubmissionPlan) {
   active();
   if (submissions.has(plan.submissionId) || (plan.allocationId && [...submissions.values()].some(row => sameScope(row, plan) && row.plan.allocationId === plan.allocationId))) throw new Error("Allocation already belongs to a transaction intention");
   submissions.set(plan.submissionId, {plan: structuredClone(plan), state: "prepared"});
  },
  preparedForAllocation(scope: FundingIdentity & {allocationId: string}) {
   active(); const row = [...submissions.values()].find(row => sameScope(row, scope) && row.plan.allocationId === scope.allocationId);
   if (!row || row.state !== "prepared") throw new Error("Funding intention is missing or already consumed");
   return structuredClone(row.plan);
  },
  read(scope: FundingIdentity & {submissionId: string}) {return structuredClone(get(scope));},
  find(scope: FundingIdentity & {submissionId: string}) {
   active(); const row = submissions.get(scope.submissionId);
   return row && sameScope(row, scope) ? structuredClone(row) : undefined;
  },
  byTxid(scope: FundingIdentity & {txid: string}) {
   active(); const row = [...submissions.values()].find(row => sameScope(row, scope) && row.txid === scope.txid);
   if (!row) throw new Error("Signed transaction has no current runtime intention");
   return structuredClone(row);
  },
  beginSigning(scope: FundingIdentity & {submissionId: string}) {
   const row = get(scope); if (row.state !== "prepared") throw new Error("Transaction signing already started or cancelled");
   row.state = "signing";
  },
  signed(scope: FundingIdentity & {submissionId: string; rawTxHex: string}) {
   const row = get(scope);
   if (row.state !== "signing") throw new Error("Transaction has no active signing attempt");
   row.rawTxHex = scope.rawTxHex; row.txid = parseTx(scope.rawTxHex).canonicalTxid; row.state = "signed";
  },
  cancelUnsigned(scope: FundingIdentity & {submissionId: string}) {
   const row = get(scope); if (row.state !== "prepared") return false;
   row.state = "cancelled"; return true;
  },
  cancelUndispatched(scope: FundingIdentity & {submissionId: string}) {
   const row = get(scope);
   if (!["prepared", "signed", "cancelled", "rejected"].includes(row.state)) throw new Error("Transaction may have been signed or dispatched; release refused");
   row.state = row.rawTxHex ? "rejected" : "cancelled";
   return structuredClone(row.plan);
  },
  assertExact(scope: FundingIdentity & {submissionId: string; allocationId: string; rawTxHex: string}) {
   const row = get(scope);
   if (row.plan.allocationId !== scope.allocationId || row.rawTxHex !== scope.rawTxHex || !["signed", "unknown", "accepted", "already-known"].includes(row.state)) throw new Error("Submission does not match its original signed intention");
   return structuredClone(row);
  },
  beginDispatch(scope: FundingIdentity & {submissionId: string; allocationId: string; rawTxHex: string}) {
   const row = runtime.assertExact(scope);
   if (row.state === "accepted" || row.state === "already-known") return row;
   get(scope).state = "dispatching"; return row;
  },
  outcome(scope: FundingIdentity & {submissionId: string; state: "accepted" | "already-known" | "unknown" | "rejected"}) {
   const row = get(scope);
   if (row.state === scope.state || row.state === "accepted" || row.state === "already-known" || (scope.state === "unknown" && (row.state === "rejected" || row.state === "cancelled"))) return;
   if (row.state !== "signed" && row.state !== "dispatching" && row.state !== "unknown") throw new Error("Transaction has no dispatch attempt");
   row.state = scope.state;
  },
  observeAccepted(scope: FundingIdentity & {rawTxHex: string}) {
   active(); const txid = parseTx(scope.rawTxHex).canonicalTxid;
   for (const row of submissions.values()) {
    if (sameScope(row, scope) && row.txid === txid && row.rawTxHex === scope.rawTxHex) row.state = "accepted";
   }
  },
  paymentStatus(scope: FundingIdentity & {paymentId: string}): P2pkhPaymentLookupResult {
   active(); const row = [...submissions.values()].find(row => sameScope(row, scope) && row.plan.paymentId === scope.paymentId);
   if (!row) return {status: "not_found"};
   const status = row.state === "accepted" || row.state === "already-known" ? "accepted"
    : row.state === "cancelled" ? "not_signed" : row.state === "rejected" ? "failed"
    : row.state === "prepared" ? "pending" : row.state === "signed" ? "signed_not_dispatched" : "unknown";
   return {status, allocationId: row.plan.allocationId, txid: row.txid};
  },
 };
 instances.set(files, runtime); return runtime;
}
type SubmissionScope = FundingIdentity & {submissionId: string};
type ExactScope = SubmissionScope & {allocationId: string; rawTxHex: string};
export interface P2pkhSubmissionRuntime {
 dispose(): void;
 prepare(plan: SubmissionPlan): void;
 preparedForAllocation(scope: FundingIdentity & {allocationId: string}): SubmissionPlan;
 read(scope: SubmissionScope): RuntimeSubmission;
 find(scope: SubmissionScope): RuntimeSubmission | undefined;
 byTxid(scope: FundingIdentity & {txid: string}): RuntimeSubmission;
 beginSigning(scope: SubmissionScope): void;
 signed(scope: SubmissionScope & {rawTxHex: string}): void;
 cancelUnsigned(scope: SubmissionScope): boolean;
 cancelUndispatched(scope: SubmissionScope): SubmissionPlan;
 assertExact(scope: ExactScope): RuntimeSubmission;
 beginDispatch(scope: ExactScope): RuntimeSubmission;
 outcome(scope: SubmissionScope & {state: "accepted" | "already-known" | "unknown" | "rejected"}): void;
 observeAccepted(scope: FundingIdentity & {rawTxHex: string}): void;
 paymentStatus(scope: FundingIdentity & {paymentId: string}): P2pkhPaymentLookupResult;
}
