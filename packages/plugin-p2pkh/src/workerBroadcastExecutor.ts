import type { BorrowedModuleFileStore, CoordinatorClientRequest, CoordinatorResponse, P2pkhTransactionBroadcastProvider } from "@keymaster/contracts";
import { isDefinitelyNotDispatchedBroadcastError } from "@keymaster/contracts";
import { createP2pkhStateRepository, openP2pkhStateRepository } from "./storage/p2pkhStateRepository.js";
import { createWorkerProtocolEvidence } from "./workerProtocolEvidence.js";
import { parseP2pkhTransaction } from "./p2pkhTransactionParser.js";

// Both callers are manager dispatch callbacks, after allocation/exact resolution.
type BroadcastRequest = Extract<CoordinatorClientRequest, { kind: "p2pkh.broadcast" }> & {
  submission: { managerAllocationId: string };
};
export interface WorkerBroadcastDependencies {
  assertFresh(): void;
  /** Internal-only: original durable manager exact, never a Window flag. */
  recoveringExact?: boolean;
  signal?: AbortSignal;
  provider?: P2pkhTransactionBroadcastProvider;
  storage(): BorrowedModuleFileStore;
  sessionEpoch(): string;
  listProtectedOutpoints(input: { ownerPublicKeyHex: string; network: "main" | "test" }): Promise<readonly { txid: string; vout: number }[]>;
  listProtocolProtectedOutpoints?(input: { ownerPublicKeyHex: string; network: "main" | "test" }): Promise<readonly { txid: string; vout: number; kind?: string; source?: string; submissionId?: string }[]>;
  /** Final per-input chain-spend check for Manager-authorized ordinary transfers. */
  assertInputsUnspent?(network: "main" | "test", outpointKeys: readonly string[]): Promise<void>;
  /**
   * Manager proof for a protocol-bound broadcast: the frozen manager intent
   * must bind the same exact transaction and the same inputs, with a
   * protocol claim on every protected input. A caller flag never proves it.
   */
  managerProtocolIntent(input: {
    ownerPublicKeyHex: string; network: "main" | "test"; allocationId: string;
    txid: string; inputOutpointKeys: readonly string[];
  }): Promise<{ ok: boolean; protectedInputs: string[] }>;
  abortNotDispatched(request: BroadcastRequest, reason: string): Promise<void>;
  refresh(): Promise<{ main?: number; test?: number }>;
  publishChanged(event: { type: "asset.data-changed"; providerId: string; publicKeyHex: string; kinds: string[]; utxoSeqs?: { main?: number; test?: number } }): void;
}

/** Owns submission validation, write-ahead audit, snapshot consumption and provider result reconciliation. */
export async function executeWorkerP2pkhBroadcast(
  requestId: string,
  request: BroadcastRequest,
  deps: WorkerBroadcastDependencies,
): Promise<CoordinatorResponse> {
  deps.assertFresh();
  const submission = request.submission;
  const provider = deps.provider;
  if (!provider) {
    await deps.abortNotDispatched(request, "broadcast-provider-unavailable");
    return { requestId, sessionEpoch: deps.sessionEpoch(), ack: { status: "ok" }, operationResult: { status: "not-dispatched", reason: "broadcast-provider-unavailable" } };
  }

  // The manager supplies the exact bytes. Decode once to derive the actual
  // outpoints; display metadata is neither a second authority nor a proof.
  let parsed;
  try {
    parsed = parseP2pkhTransaction(submission.rawTxHex);
  } catch {
    return { requestId, sessionEpoch: deps.sessionEpoch(), ack: { status: "validation-error", message: "P2PKH broadcast raw transaction is invalid" } };
  }
  const parsedInputOutpointKeys = parsed.inputs.map(input => input.outpointKey);
  const repository = createP2pkhStateRepository(await openP2pkhStateRepository(deps.storage()));
  let local = (await repository.listLocalTransactions()).find((row) => row.id === request.submissionId && row.network === request.network);
  if (!local) {
    // Reconstruct the display audit from the manager exact before provider I/O.
    const now = new Date().toISOString();
    local = {
      id: request.submissionId,
      resourceId: submission.resourceId,
      publicKeyHex: request.ownerPublicKeyHex,
      network: request.network,
      txid: parsed.canonicalTxid,
      rawTxHex: submission.rawTxHex,
      localState: "submitting",
      chainResolution: "unresolved",
      inputOutpointKeys: parsedInputOutpointKeys,
      ownOutputs: [],
      createdAt: now,
      updatedAt: now,
      attempts: [],
    };
    try {
      await repository.prepareLocalSubmission({ submission: local, claims: [] });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { requestId, sessionEpoch: deps.sessionEpoch(), ack: { status: "validation-error", message: `P2PKH broadcast payload write-ahead failed: ${message}` } };
    }
  } else if (local.txid.toLowerCase() !== parsed.canonicalTxid) {
    return { requestId, sessionEpoch: deps.sessionEpoch(), ack: { status: "validation-error", message: "P2PKH broadcast payload does not match the stored submission" } };
  }
  if (local.publicKeyHex.toLowerCase() !== request.ownerPublicKeyHex.toLowerCase() || local.rawTxHex.toLowerCase() !== submission.rawTxHex.toLowerCase()) throw new Error("Stored broadcast identity/exact mismatch");
  if ((!deps.recoveringExact && local.localState !== "submitting") || local.chainResolution !== "unresolved") {
    return { requestId, sessionEpoch: deps.sessionEpoch(), ack: { status: "validation-error", message: `Submission is not dispatchable in localState=${local.localState}, chainResolution=${local.chainResolution}` } };
  }

  // 普通 P2PKH 广播再次检查专款账本，避免调用方绕过被过滤的余额快照，
  // 直接提交花费专款 outpoint 的原始交易。
  const protectedBitfsInputs = await deps.listProtectedOutpoints({
    ownerPublicKeyHex: request.ownerPublicKeyHex,
    network: request.network,
  });
  deps.assertFresh();
  const protectedInputKeys = new Set(protectedBitfsInputs.map((item) => `${item.txid}:${item.vout}`));
  const protectedInput = parsedInputOutpointKeys.find((key) => protectedInputKeys.has(key));
  const bitfsManagerProof = protectedInput
    ? await deps.managerProtocolIntent({ ownerPublicKeyHex: request.ownerPublicKeyHex, network: request.network, allocationId: submission.managerAllocationId, txid: local.txid, inputOutpointKeys: parsedInputOutpointKeys }) : undefined;
  deps.assertFresh();
  if (protectedInput && !bitfsManagerProof?.ok) {
    await deps.abortNotDispatched(request, "bitfs-funds-protected");
    return {
      requestId,
      sessionEpoch: deps.sessionEpoch(),
      ack: { status: "ok" },
      operationResult: { status: "not-dispatched", reason: "bitfs-funds-protected", outpoint: protectedInput },
    };
  }

  // Protocol exemptions are proven from wallet records and claims, never a caller flag.
  const protocolProtection = await deps.listProtocolProtectedOutpoints?.({ ownerPublicKeyHex: request.ownerPublicKeyHex, network: request.network }) ?? [];
  deps.assertFresh();
  const protocolKeys = new Set(protocolProtection.map(row => `${row.txid}:${row.vout}`));
  const protocolProtectedInputs = parsedInputOutpointKeys.filter(key => protocolKeys.has(key));
  if (protocolProtectedInputs.length > 0) {
    // Two different protections must not be conflated:
    //  - "protocol-claim" is the input occupation THIS submission created;
    //    the manager's frozen intent (same exact tx, same inputs) proves it.
    //  - "protocol-funding" is a real protocol-protected output (dedicated
    //    funds); it needs a trusted business claim.
    // The subtraction is per SOURCE, not per outpoint: an outpoint that also
    // carries somebody else's protection stays protected.
    const evidence = createWorkerProtocolEvidence(deps.storage());
    const claims = await evidence.listLocalInputClaims();
    const ownClaimSubmissions = new Set(claims
      .filter(claim => claim.submissionId === request.submissionId
        && claim.publicKeyHex.toLowerCase() === request.ownerPublicKeyHex.toLowerCase()
        && claim.network === request.network
        && claim.state === "active")
      .map((claim) => claim.submissionId));
    const foreignProtectedInputs = protocolProtectedInputs.filter((key) =>
      // A protection that is not one of this submission's own input claims.
      protocolProtection.some((row) => `${row.txid}:${row.vout}` === key
        && !(row.kind === "protocol-claim" && ownClaimSubmissions.has(row.submissionId ?? request.submissionId))));
    // The manager holds the durable protocol intent: it binds the exact and
    // input set. Every other source still needs its own protected-input claim.
    const proof = await deps.managerProtocolIntent({
      ownerPublicKeyHex: request.ownerPublicKeyHex,
      network: request.network,
      allocationId: submission.managerAllocationId,
      txid: local.txid,
      inputOutpointKeys: parsedInputOutpointKeys,
    });
    deps.assertFresh();
    const authorized = proof.ok && foreignProtectedInputs.every(key => proof.protectedInputs.includes(key));
    if (!authorized) {
      await deps.abortNotDispatched(request, "protocol-funds-protected");
      return { requestId, sessionEpoch: deps.sessionEpoch(), ack: { status: "ok" }, operationResult: { status: "not-dispatched", reason: "protocol-funds-protected" } };
    }
  }

  if (!deps.recoveringExact) {
    if (!deps.assertInputsUnspent) throw new Error("Manager input spend checker is unavailable");
    await deps.assertInputsUnspent(request.network, parsedInputOutpointKeys);
    deps.assertFresh();
  }

  // The manager owns exact input occupations and dispatch. A notification
  // cursor is never a spend authorization and cannot be consumed or reset.

  const startedAt = new Date().toISOString();
  try {
    deps.assertFresh();
    const evidence = createWorkerProtocolEvidence(deps.storage());
    const protocol = await evidence.getProtocolSubmission(request.submissionId);
    if (protocol) {
      if ((protocol.status !== "prepared" && !(deps.recoveringExact && protocol.status === "unknown")) || protocol.canonicalTxid !== local.txid || protocol.publicKeyHex.toLowerCase() !== request.ownerPublicKeyHex.toLowerCase() || protocol.network !== request.network) throw Object.assign(new Error("Protocol submission is not dispatchable"), { code: "definitive-not-dispatched" });
      await evidence.putProtocolSubmission({ ...protocol, status: "unknown", updatedAt: new Date().toISOString() });
      deps.assertFresh();
    }
    if (deps.signal?.aborted) throw new Error("Conclusion query stopped");
    const result = await provider.broadcast({ network: request.network, canonicalTxid: local.txid, rawTxHex: local.rawTxHex, signal: deps.signal });
    if (result.canonicalTxid !== local.txid) {
      // 中文：Provider 已返回，但 txid 与本地原始交易不一致。它不是“未派发”，
      // 不能回滚消费；同时把回执完整透传，让协议层进入 provider-inconsistent。
      const message = "Broadcast provider returned a different transaction id";
      const finishedAt = new Date().toISOString();
      await repository.finishLocalSubmission({
        submissionId: local.id,
        localState: "isolated",
        reason: message,
        attempt: { id: `${local.id}:${startedAt}`, submissionId: local.id, providerId: provider.descriptor.id, startedAt, finishedAt, status: "isolated", providerMessage: message },
      });
      deps.publishChanged( { type: "asset.data-changed", providerId: "p2pkh", publicKeyHex: request.ownerPublicKeyHex, kinds: ["submission", "balance"] });
      return {
        requestId,
        sessionEpoch: deps.sessionEpoch(),
        ack: { status: "ok" },
        operationResult: {
          status: "isolated",
          txid: local.txid,
          reason: message,
          canonicalTxid: local.txid,
          providerReturnedTxidRaw: result.canonicalTxid,
          providerReturnedTxidNormalized: result.canonicalTxid.toLowerCase(),
          txidIntegrity: "mismatch",
          providerId: provider.descriptor.id,
        },
      };
    }
    const finishedAt = new Date().toISOString();
    await repository.finishLocalSubmission({ submissionId: local.id, localState: "local-confirmed", attempt: { id: `${local.id}:${startedAt}`, submissionId: local.id, providerId: provider.descriptor.id, startedAt, finishedAt, status: result.status, providerReference: result.providerReference, providerCode: result.providerCode, providerMessage: result.providerMessage } });
    // Refresh chain observations after dispatch. The manager, not the snapshot
    // cursor or display journal, owns spendability and input responsibility.
    void deps.refresh().then((utxoSeqs) => {
      deps.publishChanged( { type: "asset.data-changed", providerId: "p2pkh", publicKeyHex: request.ownerPublicKeyHex, kinds: ["utxo", "submission", "balance"], ...(Object.keys(utxoSeqs).length === 0 ? {} : { utxoSeqs }) });
    }).catch(() => {
      deps.publishChanged( { type: "asset.data-changed", providerId: "p2pkh", publicKeyHex: request.ownerPublicKeyHex, kinds: ["submission", "balance"] });
    });
    return {
      requestId,
      sessionEpoch: deps.sessionEpoch(),
      ack: { status: "ok" },
      operationResult: {
        status: result.status === "already-known" ? "already-known" : "local-confirmed",
        txid: local.txid,
        canonicalTxid: result.canonicalTxid,
        providerReturnedTxidRaw: result.providerReturnedTxidRaw ?? result.canonicalTxid,
        providerReturnedTxidNormalized: result.providerReturnedTxidNormalized ?? result.canonicalTxid.toLowerCase(),
        txidIntegrity: result.txidIntegrity ?? "exact",
        providerId: provider.descriptor.id,
        ...(result.providerReference === undefined ? {} : { providerReference: result.providerReference }),
        ...(result.providerCode === undefined ? {} : { providerCode: result.providerCode }),
        ...(result.providerMessage === undefined ? {} : { providerMessage: result.providerMessage }),
      }
    };
  } catch (error) {
    // Keep a bounded, useful diagnostic even when an I/O error has no message.
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = (rawMessage.trim() || (error instanceof Error ? error.name || "broadcast-isolated" : "broadcast-isolated")).slice(0, 2_048);
    const finishedAt = new Date().toISOString();
    const attempt = { id: `${local.id}:${startedAt}`, submissionId: local.id, providerId: provider.descriptor.id, startedAt, finishedAt, status: "isolated" as const, providerMessage: message };
    // Only a trusted pre-dispatch marker permits rollback. Generic node text
    // and conflicts never prove every input releasable.
    if (isDefinitelyNotDispatchedBroadcastError(error)) {
      await deps.abortNotDispatched(request, message);
      return { requestId, sessionEpoch: deps.sessionEpoch(), ack: { status: "ok" }, operationResult: { status: "not-dispatched", reason: "coordinator-not-dispatched" } };
    }
    await repository.finishLocalSubmission({ submissionId: local.id, localState: "isolated", reason: message, attempt });
    deps.publishChanged( { type: "asset.data-changed", providerId: "p2pkh", publicKeyHex: request.ownerPublicKeyHex, kinds: ["submission", "balance"] });
    return { requestId, sessionEpoch: deps.sessionEpoch(), ack: { status: "ok" }, operationResult: { status: "isolated", txid: local.txid, reason: message, providerId: provider.descriptor.id, ...((error as { code?: unknown })?.code === "woc-mempool-conflict" ? { providerCode: "woc-mempool-conflict" } : {}) } };
  }
}

