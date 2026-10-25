import type { BorrowedModuleFileStore, CoordinatorClientRequest, CoordinatorResponse, VaultWalletState, P2pkhTransactionBroadcastProvider } from "@keymaster/contracts";
import { isDefinitelyNotDispatchedBroadcastError } from "@keymaster/contracts";
import { createP2pkhStateRepository, openP2pkhStateRepository } from "./storage/p2pkhStateRepository.js";
import { createWorkerProtocolEvidence } from "./workerProtocolEvidence.js";
import { parseP2pkhTransaction } from "./p2pkhTransactionParser.js";
import type { P2pkhUtxoSnapshotResource, P2pkhUtxoSnapshotStore } from "./p2pkhUtxoSnapshot.js";

type BroadcastRequest = Extract<CoordinatorClientRequest, { kind: "p2pkh.broadcast" }>;
export interface WorkerBroadcastDependencies {
  assertFresh(): void;
  /** Internal-only: original durable manager exact, never a Window flag. */
  recoveringExact?: boolean;
  signal?: AbortSignal;
  provider?: P2pkhTransactionBroadcastProvider;
  walletState: VaultWalletState;
  storage(): BorrowedModuleFileStore;
  sessionEpoch(): string;
  snapshots: P2pkhUtxoSnapshotStore | undefined;
  resource(owner: string, network: "main" | "test"): Promise<P2pkhUtxoSnapshotResource | undefined>;
  listProtectedOutpoints(input: { ownerPublicKeyHex: string; network: "main" | "test" }): Promise<readonly { txid: string; vout: number }[]>;
  listProtocolProtectedOutpoints?(input: { ownerPublicKeyHex: string; network: "main" | "test" }): Promise<readonly { txid: string; vout: number; kind?: string; source?: string; submissionId?: string }[]>;
  /** Final per-input chain-spend check for Manager-authorized ordinary transfers. */
  assertInputsUnspent?(network: "main" | "test", outpointKeys: readonly string[]): Promise<void>;
  /**
   * Manager proof for a protocol-bound broadcast: the frozen manager intent
   * must bind the same exact transaction and the same inputs, with a
   * protocol claim on every protected input. A caller flag never proves it.
   */
  managerProtocolIntent?(input: {
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
  if (!request.submission?.managerAllocationId) throw new Error("Every wallet broadcast requires a manager allocation");
  try {
  const provider = deps.provider;
  if (!provider) {
    await deps.abortNotDispatched(request, "broadcast-provider-unavailable");
    return { requestId, sessionEpoch: deps.sessionEpoch(), ack: { status: "ok" }, operationResult: { status: "not-dispatched", reason: "broadcast-provider-unavailable" } };
  }

  const walletState = deps.walletState;
  if (walletState.snapshot().activePublicKeyHex?.toLowerCase() !== request.ownerPublicKeyHex.toLowerCase()) throw new Error("P2PKH storage owner is not active");
  const repository = createP2pkhStateRepository(await openP2pkhStateRepository(deps.storage()));
  let local = (await repository.listLocalTransactions()).find((row) => row.id === request.submissionId && row.network === request.network);
  if (!local) {
    // 页面 service 与 Worker 是两个 JS realm，页面内存中的本地提交这里读不到。
    // 页面必须在广播请求里带上待广播的 canonical 交易；Worker 先用生产解析器
    // 复核 txid 与原始交易一致，再写自己的审计存储（write-ahead），最后广播。
    if (!request.submission) return { requestId, sessionEpoch: deps.sessionEpoch(), ack: { status: "validation-error", message: "Local P2PKH submission not found" } };
    let parsed;
    try {
      parsed = parseP2pkhTransaction(request.submission.rawTxHex, request.submission.txid);
    } catch {
      return { requestId, sessionEpoch: deps.sessionEpoch(), ack: { status: "validation-error", message: "P2PKH broadcast payload txid does not match the raw transaction" } };
    }
    if (parsed.canonicalTxid !== request.submission.txid) {
      return { requestId, sessionEpoch: deps.sessionEpoch(), ack: { status: "validation-error", message: "P2PKH broadcast payload txid does not match the raw transaction" } };
    }
    const now = new Date().toISOString();
    local = {
      id: request.submissionId,
      resourceId: request.submission.resourceId,
      publicKeyHex: request.ownerPublicKeyHex,
      network: request.network,
      txid: request.submission.txid,
      rawTxHex: request.submission.rawTxHex,
      localState: "submitting",
      chainResolution: "unresolved",
      inputOutpointKeys: parsed.inputs.map((input) => input.outpointKey),
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
  } else if (request.submission && local.txid.toLowerCase() !== request.submission.txid) {
    return { requestId, sessionEpoch: deps.sessionEpoch(), ack: { status: "validation-error", message: "P2PKH broadcast payload does not match the stored submission" } };
  }
  if (local.publicKeyHex.toLowerCase() !== request.ownerPublicKeyHex.toLowerCase() || (request.submission && local.rawTxHex.toLowerCase() !== request.submission.rawTxHex.toLowerCase())) throw new Error("Stored broadcast identity/exact mismatch");
  if ((!deps.recoveringExact && local.localState !== "submitting") || local.chainResolution !== "unresolved") {
    return { requestId, sessionEpoch: deps.sessionEpoch(), ack: { status: "validation-error", message: `Submission is not dispatchable in localState=${local.localState}, chainResolution=${local.chainResolution}` } };
  }

  // 中文：无论 Worker 是否已有本地 write-ahead 记录，都必须从本次原始
  // 交易解析输入 outpoint；不能信任页面或旧记录中的 inputOutpointKeys。
  const rawTxHexForValidation = request.submission?.rawTxHex ?? local.rawTxHex;
  const txidForValidation = request.submission?.txid ?? local.txid;
  let parsedInputOutpointKeys: string[];
  try {
    const parsed = parseP2pkhTransaction(rawTxHexForValidation, txidForValidation);
    if (parsed.canonicalTxid !== local.txid.toLowerCase()) throw new Error("txid mismatch");
    parsedInputOutpointKeys = parsed.inputs.map((input) => input.outpointKey);
  } catch {
    return { requestId, sessionEpoch: deps.sessionEpoch(), ack: { status: "validation-error", message: "P2PKH broadcast raw transaction is invalid" } };
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
  const bitfsManagerProof = protectedInput && request.submission?.managerAllocationId && deps.managerProtocolIntent
    ? await deps.managerProtocolIntent({ ownerPublicKeyHex: request.ownerPublicKeyHex, network: request.network, allocationId: request.submission.managerAllocationId, txid: local.txid, inputOutpointKeys: parsedInputOutpointKeys }) : undefined;
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
    const protocol = await evidence.getProtocolSubmission(request.submissionId);
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
    const managerAllocationId = request.submission?.managerAllocationId;
    let authorized = false;
    if (managerAllocationId && deps.managerProtocolIntent) {
      // The manager holds the durable protocol intent: it must bind this
      // exact transaction and the same input set.
      const proof = await deps.managerProtocolIntent({
        ownerPublicKeyHex: request.ownerPublicKeyHex,
        network: request.network,
        allocationId: managerAllocationId,
        txid: local.txid,
        inputOutpointKeys: parsedInputOutpointKeys,
      });
      deps.assertFresh();
      // The submission's own input claims are covered by the manager intent
      // itself; every other protected output must be a claimed protocol input.
      authorized = proof.ok && foreignProtectedInputs.every(key => proof.protectedInputs.includes(key));
    } else {
      const inputKeys = protocol?.inputs.map(row => `${row.txid}:${row.vout}`) ?? [];
      authorized = protocol?.status === "prepared" && protocol.canonicalTxid === local.txid
        && protocol.publicKeyHex.toLowerCase() === request.ownerPublicKeyHex.toLowerCase() && protocol.network === request.network
        && inputKeys.length === parsedInputOutpointKeys.length && inputKeys.every((key, index) => key === parsedInputOutpointKeys[index])
        && parsedInputOutpointKeys.every(key => claims.some(claim => claim.submissionId === protocol.id && protocol.localInputClaimIds.includes(claim.id)
          && claim.publicKeyHex.toLowerCase() === request.ownerPublicKeyHex.toLowerCase() && claim.network === request.network && claim.state === "active"
          && `${claim.txid}:${claim.vout}` === key));
      deps.assertFresh();
    }
    if (!authorized) {
      await deps.abortNotDispatched(request, "protocol-funds-protected");
      return { requestId, sessionEpoch: deps.sessionEpoch(), ack: { status: "ok" }, operationResult: { status: "not-dispatched", reason: "protocol-funds-protected" } };
    }
  }

  const managerAuthorized = typeof request.submission?.managerAllocationId === "string";
  if (managerAuthorized && !deps.recoveringExact) {
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
    // 广播后立即触发一次后台刷新；普通 P2PKH 不维护本地输入占用，
    // 下一组可花 UTXO 由 WoC 快照内容变化和新 seq 决定。
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
    // reason 必须是非空、有上界的字符串：它要跨 RPC parser 和 UI，空 message
    // 的 Error 会让响应校验失败，把“已隔离”伪装成框架层 handler 异常。
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
  } catch (error) {
    throw error;
  }
}

