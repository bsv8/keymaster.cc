import { defineWorkerRequestRoute } from "@keymaster/contracts";
import type { BorrowedModuleFileStore, CoordinatorClientRequest, CoordinatorResponse, P2pkhProtocolCommandResult,
 P2pkhTransactionBroadcastProvider, VaultWalletState } from "@keymaster/contracts";
import type { createP2pkhWorkerRuntime } from "./worker.js";
import { executeWorkerP2pkhSnapshot, readWorkerP2pkhResource } from "./workerSnapshotExecutor.js";
import { executeWorkerP2pkhBroadcast } from "./workerBroadcastExecutor.js";
import { ensureWorkerP2pkhResources, refreshWorkerP2pkhResources } from "./p2pkhWorkerResources.js";
import { createP2pkhStateRepository, openP2pkhStateRepository } from "./storage/p2pkhStateRepository.js";
import { createP2pkhUtxoManager } from "./p2pkhUtxoManager.js";
import { readWorkerProtocolProtection } from "./workerProtocolRuntime.js";

type Input = {ownerPublicKeyHex: string; network: "main" | "test"};
type Request<K extends CoordinatorClientRequest["kind"]> = Extract<CoordinatorClientRequest, {kind: K}>;
export interface P2pkhWorkerOperationPorts {
 domain: ReturnType<typeof createP2pkhWorkerRuntime>; walletState: VaultWalletState; network(): "main" | "test";
 storage(): BorrowedModuleFileStore; available(): boolean; blocked(requestId: string): CoordinatorResponse;
 broadcastLease<T>(execute: () => Promise<T>): Promise<T>; provider(): P2pkhTransactionBroadcastProvider | undefined;
 funding: {protected(input: Input): Promise<readonly {txid: string; vout: number}[]>};
 changed(event: {type: "asset.data-changed"; providerId: string; publicKeyHex: string; kinds: string[]; utxoSeqs?: {main?: number; test?: number}}): void;
}
export function createP2pkhWorkerOperations(ports: P2pkhWorkerOperationPorts) {
 const epoch = () => ports.walletState.snapshot().sessionEpoch;
 function capture(owner: string) {
  const session = ports.walletState.snapshot(), snapshots = ports.domain.snapshots();
  return {snapshots, assertFresh() {const now = ports.walletState.snapshot();
   if (now.status !== "unlocked" || now.sessionEpoch !== session.sessionEpoch || now.activePublicKeyHex?.toLowerCase() !== owner.toLowerCase()
    || ports.domain.snapshots() !== snapshots) throw new Error("P2PKH operation session revoked"); ports.domain.binding()?.assertActive();}};
 }
 const ensureResources = (owner: string, network: "main" | "test") => ensureWorkerP2pkhResources(ports.storage(), owner, network);
 async function resource(owner: string, network: "main" | "test") {const captured = capture(owner); captured.assertFresh();
  const result = await readWorkerP2pkhResource(ports.storage(), {ownerPublicKeyHex: owner, network}); captured.assertFresh(); return result;}
 async function refresh(signal?: AbortSignal, storage = ports.storage(), assertActive: () => void = () => undefined) {
  const owner = ports.walletState.snapshot().activePublicKeyHex; if (!owner || !ports.domain.snapshots()) return {};
  const captured = capture(owner); return refreshWorkerP2pkhResources({storage, ownerPublicKeyHex: owner, bsvNetwork: ports.network(), snapshots: captured.snapshots!,
   assertFresh() {assertActive(); captured.assertFresh();}}, signal);
 }
 async function protocolProtection(input: Input) {return readWorkerProtocolProtection(ports.storage(), input.ownerPublicKeyHex, input.network);}
 async function snapshot(requestId: string, input: Input, refreshing: boolean): Promise<CoordinatorResponse> {
  if (!ports.available()) return ports.blocked(requestId); const captured = capture(input.ownerPublicKeyHex); captured.assertFresh();
  const storage = ports.storage(); if (refreshing) await ensureWorkerP2pkhResources(storage, input.ownerPublicKeyHex, ports.network());
  return executeWorkerP2pkhSnapshot(requestId, input, refreshing, {storage, snapshots: captured.snapshots, epoch, assertFresh: captured.assertFresh, publish: ports.changed});
 }
 async function abortNotDispatched(request: Request<"p2pkh.broadcast">, reason: string) {
  const repository = createP2pkhStateRepository(await openP2pkhStateRepository(ports.storage()));
  await repository.abortUnattemptedLocalSubmission?.({submissionId: request.submissionId, reason});
 }
 // This caller owns submission outcomes. The allocation component never calls
 // a provider or asks for evidence: success injects change, explicit failure
 // releases, unknown leaves the allocation frozen.
 async function broadcast(requestId: string, request: Request<"p2pkh.broadcast">): Promise<CoordinatorResponse> {
  if (!ports.available()) return ports.blocked(requestId);
  return ports.broadcastLease(async () => {
   try {
    const captured = capture(request.ownerPublicKeyHex); captured.assertFresh();
    const submission = request.submission; if (!submission?.managerAllocationId) throw new Error("Wallet allocation required");
    const manager = createP2pkhUtxoManager({files: ports.storage()});
    const ownResource = await resource(request.ownerPublicKeyHex, request.network); captured.assertFresh(); if (!ownResource) throw new Error("Wallet resource unavailable");
    const response = await executeWorkerP2pkhBroadcast(requestId, {...request, submission: {...submission, managerAllocationId: submission.managerAllocationId}}, {
     assertFresh: captured.assertFresh, provider: ports.provider() ?? ports.domain.registry()?.getBroadcastProvider("woc", request.network),
     storage: ports.storage, sessionEpoch: epoch, abortNotDispatched, publishChanged: ports.changed,
    });
    captured.assertFresh();
    const outcome = response.operationResult as {status?: string; providerCode?: string} | undefined;
    if (outcome?.status === "local-confirmed" || outcome?.status === "already-known") {
     await manager.observeAcceptedExact({ownerPublicKeyHex: request.ownerPublicKeyHex, resource: ownResource, rawTxHex: submission.rawTxHex});
    } else if (outcome?.status === "not-dispatched" || outcome?.providerCode === "woc-tx-rejected") {
     await manager.release({...request, allocationId: submission.managerAllocationId});
    }
    ports.changed({type: "asset.data-changed", providerId: "p2pkh", publicKeyHex: request.ownerPublicKeyHex, kinds: ["utxo", "balance", "submission"]});
    return response;
   } catch (error) {return {requestId, sessionEpoch: epoch(), ack: {status: "error", message: `P2PKH broadcast failed: ${error instanceof Error ? error.message : String(error)}`}};}
  });
 }
 async function paymentStatus(requestId: string, request: Request<"p2pkh.payment.status">): Promise<CoordinatorResponse> {
  try {const captured = capture(request.input.ownerPublicKeyHex); captured.assertFresh();
   const result = await createP2pkhUtxoManager({files: ports.storage()}).paymentStatus(request.input); captured.assertFresh();
   return {requestId, sessionEpoch: epoch(), ack: {status: "ok"}, operationResult: result};
  } catch (error) {return {requestId, sessionEpoch: epoch(), ack: {status: "error", message: String(error)}};}
 }
 async function protocolCommand(requestId: string, request: Request<"p2pkh.protocol.command">): Promise<CoordinatorResponse> {
  if (!ports.available()) return ports.blocked(requestId);
  try {const command = request.input, input = command.input; if (request.expectedSessionEpoch !== epoch() || input.network !== ports.network()) throw new Error("Protocol RPC scope changed");
   const captured = capture(input.ownerPublicKeyHex); captured.assertFresh(); const service = await ports.domain.transfer.ensureProtocol(); captured.assertFresh();
   let result: P2pkhProtocolCommandResult;
   switch (command.type) {
    case "prepare": case "presign": result = {type: command.type, value: await service.executor[command.type](command.input)}; break;
    case "submit": result = {type: "submit", value: await service.executor.submit(command.input)}; break;
    case "release": await service.executor.releasePrepared!(command.input); result = {type: "release", value: {released: true}}; break;
    case "release-submission": await service.executor.releasePreparedSubmission(command.input); result = {type: "release-submission", value: {released: true}}; break;
    case "funding-plan": result = {type: "funding-plan", value: await service.planFundingCommand(command.input)}; break;
   }
   captured.assertFresh(); return {requestId, sessionEpoch: epoch(), ack: {status: "ok"}, operationResult: result};
  } catch (error) {return {requestId, sessionEpoch: epoch(), ack: {status: "error", message: String(error)}};}
 }
 async function transferPrepare(requestId: string, request: Request<"p2pkh.transfer.prepare">): Promise<CoordinatorResponse> {
  if (!ports.available()) return ports.blocked(requestId);
  try {const captured = capture(request.input.ownerPublicKeyHex); captured.assertFresh(); const service = await ports.domain.transfer.ensure(); captured.assertFresh();
   if (request.input.network !== ports.network()) throw new Error("Transfer RPC network changed");
   const {ownerPublicKeyHex: _owner, network: _network, assetId: _asset, ...input} = request.input;
   if (_asset !== (ports.network() === "test" ? "bsvtest" : "bsv")) throw new Error("Transfer RPC identity mismatch");
   const result = await service.prepareTransfer(input); captured.assertFresh();
   ports.changed({type: "asset.data-changed", providerId: "p2pkh", publicKeyHex: request.input.ownerPublicKeyHex, kinds: ["utxo", "balance"]});
   return {requestId, sessionEpoch: epoch(), ack: {status: "ok"}, operationResult: result};
  } catch (error) {return {requestId, sessionEpoch: epoch(), ack: {status: "error", message: String(error)}};}
 }
 async function transferSubmit(requestId: string, request: Request<"p2pkh.transfer.submit">): Promise<CoordinatorResponse> {
  if (!ports.available()) return ports.blocked(requestId);
  try {const captured = capture(request.input.ownerPublicKeyHex); captured.assertFresh(); const service = await ports.domain.transfer.ensure();
   const result = await service.submitPreparedTransfer!(request.input.previewId); captured.assertFresh();
   return {requestId, sessionEpoch: epoch(), ack: {status: "ok"}, operationResult: result};
  } catch (error) {return {requestId, sessionEpoch: epoch(), ack: {status: "error", message: String(error)}};}
 }
 async function occupyArtifact(requestId: string, request: Request<"p2pkh.artifact.occupy">): Promise<CoordinatorResponse> {
  if (!ports.available()) return ports.blocked(requestId);
  try {const captured = capture(request.input.ownerPublicKeyHex); captured.assertFresh(); const result = await ports.domain.transfer.occupyDeliveredArtifact({...request.input, inputs: request.input.inputs.map(row => ({...row})), outputs: request.input.outputs.map(row => ({...row}))}); captured.assertFresh();
   return {requestId, sessionEpoch: epoch(), ack: {status: "ok"}, operationResult: result};
  } catch (error) {return {requestId, sessionEpoch: epoch(), ack: {status: "error", message: String(error)}};}
 }
 type Kinds = "p2pkh.utxos.get" | "p2pkh.utxos.refresh" | "p2pkh.broadcast" | "p2pkh.transfer.prepare" | "p2pkh.transfer.submit" | "p2pkh.artifact.occupy" | "p2pkh.payment.status" | "p2pkh.protocol.command";
 const route = defineWorkerRequestRoute<Request<Kinds>>({kinds: ["p2pkh.utxos.get", "p2pkh.utxos.refresh", "p2pkh.broadcast", "p2pkh.transfer.prepare", "p2pkh.transfer.submit", "p2pkh.artifact.occupy", "p2pkh.payment.status", "p2pkh.protocol.command"],
  policy: request => ({scheduling: request.kind === "p2pkh.utxos.refresh" ? "parallel" : "serial", validateEpoch: true}),
  execute(request, call) {
   if (request.kind === "p2pkh.broadcast") return broadcast(call.requestId, request);
   if (request.kind === "p2pkh.payment.status") return paymentStatus(call.requestId, request);
   if (request.kind === "p2pkh.protocol.command") return protocolCommand(call.requestId, request);
   if (request.kind === "p2pkh.transfer.prepare") return transferPrepare(call.requestId, request);
   if (request.kind === "p2pkh.transfer.submit") return transferSubmit(call.requestId, request);
   if (request.kind === "p2pkh.artifact.occupy") return occupyArtifact(call.requestId, request);
   return snapshot(call.requestId, request, request.kind === "p2pkh.utxos.refresh");
  },
  async stale(request, call) {if (request.kind !== "p2pkh.broadcast") return undefined; await abortNotDispatched(request, "stale-session-epoch");
   return {requestId: call.requestId, sessionEpoch: epoch(), ack: {status: "ok"}, operationResult: {status: "not-dispatched", reason: "stale-session-epoch"}};},
 });
 return {route, ensureResources, resource, refresh, protocolProtection, snapshot, broadcast, abortNotDispatched, dispose() {}};
}
