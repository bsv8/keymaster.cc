import type { BorrowedModuleFileStore, CoordinatorClientRequest, CoordinatorResponse, P2pkhTransactionBroadcastProvider } from "@keymaster/contracts";
import { isDefinitelyNotDispatchedBroadcastError } from "@keymaster/contracts";
import { createP2pkhStateRepository, openP2pkhStateRepository } from "./storage/p2pkhStateRepository.js";
import { createWorkerProtocolEvidence } from "./workerProtocolEvidence.js";
import { parseP2pkhTransaction } from "./p2pkhTransactionParser.js";

type BroadcastRequest = Extract<CoordinatorClientRequest, {kind: "p2pkh.broadcast"}> & {submission: {managerAllocationId: string}};
export interface WorkerBroadcastDependencies {
 assertFresh(): void; signal?: AbortSignal; provider?: P2pkhTransactionBroadcastProvider;
 storage(): BorrowedModuleFileStore; sessionEpoch(): string;
 abortNotDispatched(request: BroadcastRequest, reason: string): Promise<void>;
 publishChanged(event: {type: "asset.data-changed"; providerId: string; publicKeyHex: string; kinds: string[]}): void;
}
// Submission belongs to the wallet caller. Allocation/own-output updates occur
// in workerOperations immediately on the successful provider result.
export async function executeWorkerP2pkhBroadcast(requestId: string, request: BroadcastRequest, deps: WorkerBroadcastDependencies): Promise<CoordinatorResponse> {
 deps.assertFresh(); const submission = request.submission, provider = deps.provider;
 const respond = (operationResult: unknown): CoordinatorResponse => ({requestId, sessionEpoch: deps.sessionEpoch(), ack: {status: "ok"}, operationResult});
 if (!provider) {await deps.abortNotDispatched(request, "broadcast-provider-unavailable"); return respond({status: "not-dispatched", reason: "broadcast-provider-unavailable"});}
 const parsed = parseP2pkhTransaction(submission.rawTxHex);
 const repository = createP2pkhStateRepository(await openP2pkhStateRepository(deps.storage()));
 const now = new Date().toISOString();
 let local = (await repository.listLocalTransactions()).find(row => row.id === request.submissionId && row.network === request.network);
 if (!local) {
  local = {id: request.submissionId, resourceId: submission.resourceId, publicKeyHex: request.ownerPublicKeyHex, network: request.network,
   txid: parsed.canonicalTxid, rawTxHex: submission.rawTxHex, localState: "submitting", chainResolution: "unresolved",
   inputOutpointKeys: parsed.inputs.map(row => row.outpointKey), ownOutputs: [], createdAt: now, updatedAt: now, attempts: []};
  await repository.prepareLocalSubmission({submission: local, claims: []});
 }
 const startedAt = new Date().toISOString();
 try {
  deps.assertFresh(); const evidence = createWorkerProtocolEvidence(deps.storage()); const protocol = await evidence.getProtocolSubmission(request.submissionId);
  if (protocol) await evidence.putProtocolSubmission({...protocol, status: "unknown", updatedAt: startedAt});
  deps.assertFresh();
  const result = await provider.broadcast({network: request.network, canonicalTxid: parsed.canonicalTxid, rawTxHex: submission.rawTxHex, signal: deps.signal});
  if (result.canonicalTxid !== parsed.canonicalTxid) throw new Error("Broadcast provider returned a different transaction id");
  // Return success even if display-audit I/O fails afterwards. The caller must
  // still inject change: an audit failure is not a transaction failure.
  try {await repository.finishLocalSubmission({submissionId: local.id, localState: "local-confirmed", attempt: {
   id: `${local.id}:${startedAt}`, submissionId: local.id, providerId: provider.descriptor.id, startedAt, finishedAt: new Date().toISOString(), status: result.status,
   providerCode: result.providerCode, providerMessage: result.providerMessage, providerReference: result.providerReference}});} catch (error) {console.warn("P2PKH successful submission audit failed", error);}
  return respond({status: result.status === "already-known" ? "already-known" : "local-confirmed", txid: parsed.canonicalTxid, canonicalTxid: result.canonicalTxid,
   providerReturnedTxidRaw: result.providerReturnedTxidRaw ?? result.canonicalTxid, providerReturnedTxidNormalized: result.providerReturnedTxidNormalized ?? result.canonicalTxid,
   txidIntegrity: result.txidIntegrity ?? "exact", providerId: provider.descriptor.id});
 } catch (error) {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2048);
  if (isDefinitelyNotDispatchedBroadcastError(error)) {await deps.abortNotDispatched(request, message); return respond({status: "not-dispatched", reason: "coordinator-not-dispatched"});}
  const providerCode = (error as {code?: string})?.code;
  try {await repository.finishLocalSubmission({submissionId: local.id, localState: "isolated", reason: message, attempt: {
   id: `${local.id}:${startedAt}`, submissionId: local.id, providerId: provider.descriptor.id, startedAt, finishedAt: new Date().toISOString(), status: "isolated", providerMessage: message, providerCode}});} catch (auditError) {console.warn("P2PKH submission failure audit failed", auditError);}
  return respond({status: "isolated", txid: parsed.canonicalTxid, reason: message, providerId: provider.descriptor.id, providerCode});
 }
}
