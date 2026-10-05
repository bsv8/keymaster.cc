import type { BorrowedModuleFileStore, CoordinatorClientRequest, CoordinatorResponse, VaultWalletState, P2pkhTransactionBroadcastProvider } from "@keymaster/contracts";
import { isDefinitelyNotDispatchedBroadcastError } from "@keymaster/contracts";
import { createP2pkhStateRepository, openP2pkhStateRepository } from "./storage/p2pkhStateRepository.js";
import { parseP2pkhTransaction } from "./p2pkhTransactionParser.js";
import type { P2pkhUtxoSnapshotResource, P2pkhUtxoSnapshotStore } from "./p2pkhUtxoSnapshot.js";

type BroadcastRequest = Extract<CoordinatorClientRequest, { kind: "p2pkh.broadcast" }>;
export interface WorkerBroadcastDependencies {
  assertFresh(): void;
  provider?: P2pkhTransactionBroadcastProvider;
  walletState: VaultWalletState;
  storage(): BorrowedModuleFileStore;
  sessionEpoch(): string;
  snapshots: P2pkhUtxoSnapshotStore | undefined;
  resource(owner: string, network: "main" | "test"): Promise<P2pkhUtxoSnapshotResource | undefined>;
  listProtectedOutpoints(input: { ownerPublicKeyHex: string; network: "main" | "test" }): Promise<readonly { txid: string; vout: number }[]>;
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
  const provider = deps.provider;
  if (!provider) {
    await deps.abortNotDispatched(request, "broadcast-provider-unavailable");
    return { requestId, sessionEpoch: deps.sessionEpoch(), ack: { status: "ok" }, operationResult: { status: "not-dispatched", reason: "broadcast-provider-unavailable" } };
  }

  const walletState = deps.walletState;
  if (walletState.snapshot().activePublicKeyHex?.toLowerCase() !== request.ownerPublicKeyHex.toLowerCase()) throw new Error("P2PKH storage owner is not active");
  const repository = createP2pkhStateRepository(await openP2pkhStateRepository(deps.storage()));
  let consumed = false;
  let snapshotResource: P2pkhUtxoSnapshotResource | undefined;
  const consumedBinding = request.submission?.utxoBinding;
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
  if (local.localState !== "submitting" || local.chainResolution !== "unresolved") {
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
  if (protectedInput) {
    await deps.abortNotDispatched(request, "bitfs-funds-protected");
    return {
      requestId,
      sessionEpoch: deps.sessionEpoch(),
      ack: { status: "ok" },
      operationResult: { status: "not-dispatched", reason: "bitfs-funds-protected", outpoint: protectedInput },
    };
  }

  // 唯一的 Worker 门禁：在同一无 await 的同步块内完成绑定核对、输入归属
  // 校验和消费。纯代币输入没有命中钱包快照时保持 untouched，不要求序号。
  snapshotResource = await deps.resource(request.ownerPublicKeyHex, request.network);
  deps.assertFresh();
  const consumeResult = snapshotResource && deps.snapshots
    ? deps.snapshots.consume(snapshotResource, {
        binding: consumedBinding,
        inputOutpointKeys: parsedInputOutpointKeys,
        txid: local.txid,
      })
    // 没有该 owner/network 资源时无法证明输入属于钱包快照，按纯协议输入
    // 路径继续；正常 P2PKH 资源由 ensureWorkerP2pkhResources 预先材料化。
    : { status: "untouched" as const };
  if (consumeResult.status === "rejected") {
    await deps.abortNotDispatched(request, consumeResult.reason);
    return {
      requestId,
      sessionEpoch: deps.sessionEpoch(),
      ack: { status: "ok" },
      operationResult: {
        status: "not-dispatched",
        reason: consumeResult.reason,
        ...(consumeResult.currentSeq === undefined ? {} : { currentSeq: consumeResult.currentSeq }),
      },
    };
  }
  consumed = consumeResult.status === "consumed";

  const startedAt = new Date().toISOString();
  try {
    deps.assertFresh();
    const result = await provider.broadcast({ network: request.network, canonicalTxid: local.txid, rawTxHex: local.rawTxHex });
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
    // 只有结构化标记（code=definitive-not-dispatched）或节点明确拒绝交易本体
    // 的错误才允许回滚消费；HTTP 4xx / 超时 / 网络错误可能是"已存在"，保持 isolated。
    if (isDefinitelyNotDispatchedBroadcastError(error)) {
      if (consumed && snapshotResource && consumedBinding) deps.snapshots?.rollbackConsume(snapshotResource, consumedBinding);
      await deps.abortNotDispatched(request, message);
      return { requestId, sessionEpoch: deps.sessionEpoch(), ack: { status: "ok" }, operationResult: { status: "not-dispatched", reason: "coordinator-not-dispatched" } };
    }
    await repository.finishLocalSubmission({ submissionId: local.id, localState: "isolated", reason: message, attempt });
    deps.publishChanged( { type: "asset.data-changed", providerId: "p2pkh", publicKeyHex: request.ownerPublicKeyHex, kinds: ["submission", "balance"] });
    return { requestId, sessionEpoch: deps.sessionEpoch(), ack: { status: "ok" }, operationResult: { status: "isolated", txid: local.txid, reason: message, providerId: provider.descriptor.id } };
  }
}

