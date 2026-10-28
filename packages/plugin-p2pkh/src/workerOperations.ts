import { requireWocNetwork } from "@keymaster/contracts";
import { defineWorkerRequestRoute } from "@keymaster/contracts";
import type { P2pkhProtocolCommandResult } from "@keymaster/contracts";
import type {
  BorrowedModuleFileStore, CoordinatorClientRequest, CoordinatorResponse, P2pkhUtxoSnapshotResult,
  P2pkhTransactionBroadcastProvider, VaultWalletState,
} from "@keymaster/contracts";
import type { createP2pkhWorkerRuntime } from "./worker.js";
import { executeWorkerP2pkhSnapshot, readWorkerP2pkhResource } from "./workerSnapshotExecutor.js";
import { executeWorkerP2pkhBroadcast } from "./workerBroadcastExecutor.js";
import { ensureWorkerP2pkhResources, refreshWorkerP2pkhResources } from "./p2pkhWorkerResources.js";
import { readWorkerProtocolProtection } from "./workerProtocolRuntime.js";
import { createWorkerProtocolEvidence } from "./workerProtocolEvidence.js";
import { createP2pkhStateRepository, openP2pkhStateRepository } from "./storage/p2pkhStateRepository.js";
import { createP2pkhUtxoManager } from "./p2pkhUtxoManager.js";
import { createConclusionQueries } from "./conclusionQueries.js";
import { createWocInputObserver } from "./wocInputObserver.js";

type Input = { ownerPublicKeyHex: string; network: "main" | "test" };
type BroadcastRequest = Extract<CoordinatorClientRequest, { kind: "p2pkh.broadcast" }>;
type TransferPrepareRequest = Extract<CoordinatorClientRequest, { kind: "p2pkh.transfer.prepare" }>;
type TransferSubmitRequest = Extract<CoordinatorClientRequest, { kind: "p2pkh.transfer.submit" }>;
type ArtifactOccupyRequest = Extract<CoordinatorClientRequest, { kind: "p2pkh.artifact.occupy" }>;
export interface P2pkhWorkerOperationPorts {
  domain: ReturnType<typeof createP2pkhWorkerRuntime>;
  walletState: VaultWalletState;
  network(): "main" | "test";
  storage(): BorrowedModuleFileStore;
  available(): boolean;
  blocked(requestId: string): CoordinatorResponse;
  broadcastLease<T>(execute: () => Promise<T>): Promise<T>;
  provider(): P2pkhTransactionBroadcastProvider | undefined;
  funding: {
    protected(input: Input): Promise<readonly { txid: string; vout: number }[]>;
  };
  changed(event: { type: "asset.data-changed"; providerId: string; publicKeyHex: string; kinds: string[]; utxoSeqs?: { main?: number; test?: number } }): void;
}

/** 快照、广播与未发出证据归 P2PKH。公共 Host 只授予最终 I/O 租约。 */
export function createP2pkhWorkerOperations(ports: P2pkhWorkerOperationPorts) {
  const epoch = () => ports.walletState.snapshot().sessionEpoch;
  function capture(owner: string) {
    const session = ports.walletState.snapshot();
    const snapshots = ports.domain.snapshots();
    return {
      snapshots, assertFresh() {
        const now = ports.walletState.snapshot();
        if (now.status !== "unlocked" || now.sessionEpoch !== session.sessionEpoch
          || now.activePublicKeyHex?.toLowerCase() !== owner.toLowerCase()
          || ports.domain.snapshots() !== snapshots) throw new Error("P2PKH operation session revoked");
        ports.domain.binding()?.assertActive();
      }
    };
  }
  const ensureResources = (owner: string, network: "main" | "test") => ensureWorkerP2pkhResources(ports.storage(), owner, network);
  async function resource(owner: string, network: "main" | "test") {
    const captured = capture(owner);
    captured.assertFresh();
    const result = await readWorkerP2pkhResource(ports.storage(), { ownerPublicKeyHex: owner, network });
    captured.assertFresh();
    return result;
  }
  async function refresh(signal?: AbortSignal, storage = ports.storage(), assertActive: () => void = () => undefined) {
    const owner = ports.walletState.snapshot().activePublicKeyHex;
    if (!owner || !ports.domain.snapshots()) return {};
    const captured = capture(owner);
    return refreshWorkerP2pkhResources({
      storage, ownerPublicKeyHex: owner, bsvNetwork: ports.network(), snapshots: captured.snapshots!,
      assertFresh() { assertActive(); captured.assertFresh(); },
    }, signal);
  }
  async function protocolProtection(input: Input) {
    const captured = capture(input.ownerPublicKeyHex);
    captured.assertFresh();
    // Every protection keeps its source: a protocol submission's own input
    // claim is an occupation, a dedicated funding record is a real fund
    // protection. The executor subtracts only the former.
    const rows = await readWorkerProtocolProtection(ports.storage(), input.ownerPublicKeyHex, input.network);
    captured.assertFresh();
    const registry = ports.domain.transfer.protectedOutpoints()?.list({ publicKeyHex: input.ownerPublicKeyHex, network: input.network }) ?? [];
    return [
      ...rows,
      ...registry.map((row) => ({
        txid: row.txid,
        vout: row.vout,
        kind: row.kind,
        source: row.source ?? `fund:${row.ownerPluginId ?? "unknown"}`,
      })),
    ];
  }
  async function snapshot(requestId: string, input: Input, refreshSnapshot: boolean): Promise<CoordinatorResponse> {
    if (!ports.available()) return ports.blocked(requestId);
    const captured = capture(input.ownerPublicKeyHex);
    captured.assertFresh();
    const storage = ports.storage();
    if (refreshSnapshot) await ensureWorkerP2pkhResources(storage, input.ownerPublicKeyHex, ports.network());
    return executeWorkerP2pkhSnapshot(requestId, input, refreshSnapshot, {
      storage, snapshots: captured.snapshots, epoch, assertFresh: captured.assertFresh,
      publish: ports.changed,
    });
  }
  async function abortNotDispatched(request: BroadcastRequest, reason: string) {
    try {
      const wallet = ports.walletState.snapshot();
      if (wallet.activePublicKeyHex?.toLowerCase() !== request.ownerPublicKeyHex.toLowerCase()) throw new Error("P2PKH storage owner is not active");
      const repository = createP2pkhStateRepository(await openP2pkhStateRepository(ports.storage()));
      await repository.abortUnattemptedLocalSubmission?.({ submissionId: request.submissionId, reason });
      ports.changed({ type: "asset.data-changed", providerId: "p2pkh", publicKeyHex: request.ownerPublicKeyHex, kinds: ["utxo", "submission", "balance"] });
    } catch { /* 撤权后的旧存储句柄可能已失效；不能为了写证据绕过授权。 */ }
  }
  const conclusions = createConclusionQueries({
    recover: input => ports.domain.transfer.recoverSigning(input),
    capture(input) {
      if (!ports.available() || ports.network() !== input.network) throw new Error("Conclusion query wallet/network unavailable");
      const captured = capture(input.ownerPublicKeyHex);
      return () => { captured.assertFresh(); if (!ports.available() || ports.network() !== input.network) throw new Error("Conclusion query scope revoked"); };
    },
    async list(input) { return createP2pkhUtxoManager({ files: ports.storage() }).listConclusions(input); },
    changed(input) { ports.changed({ type: "asset.data-changed", providerId: "p2pkh", publicKeyHex: input.ownerPublicKeyHex, kinds: ["submission", "balance", "utxo"] }); },
    async runOnce(input, assertFresh, signal) {
      return ports.broadcastLease(async () => {
        assertFresh();
        if (signal.aborted) throw new Error("Conclusion query stopped");
        const storage = ports.storage();
        const manager = createP2pkhUtxoManager({ files: storage, chain: {
          async observe() { return null; },
          async observeInputs(network, keys, diagnostic) {
            assertFresh();
            const woc = ports.domain.query();
            if (!woc) return [];
            const facts = await createWocInputObserver(woc, network, diagnostic).observeInputs(keys);
            assertFresh();
            return facts;
          },
        } });
        const result = await manager.retryExact({ ...input, async broadcast(rawTxHex, txid) {
          assertFresh();
          if (signal.aborted) throw new Error("Conclusion query stopped");
          const repository = createP2pkhStateRepository(await openP2pkhStateRepository(storage));
          const local = (await repository.listLocalTransactions()).find(row => row.txid === txid && row.network === input.network && row.publicKeyHex.toLowerCase() === input.ownerPublicKeyHex.toLowerCase());
          assertFresh();
          if (local && local.rawTxHex.toLowerCase() !== rawTxHex) throw new Error("Original submission audit/exact mismatch");
          // Display journals are memory-only. After restart reconstruct that
          // audit row from the manager's verified durable exact, never a new
          // allocation/signature/payment. The manager command identity is stable.
          const submissionId = local?.id ?? `${input.allocationId}:broadcast`;
          const resourceId = local?.resourceId ?? `p2pkh:${input.network}`;
          const response = await executeWorkerP2pkhBroadcast(`conclusion:${input.allocationId}`, {
            kind: "p2pkh.broadcast", clientId: "wallet-conclusion", requestId: `conclusion:${input.allocationId}`,
            ...input, submissionId, expectedSessionEpoch: epoch(),
            submission: { resourceId, txid, rawTxHex, managerAllocationId: input.allocationId },
          }, {
            assertFresh, recoveringExact: true, signal,
            provider: ports.provider() ?? ports.domain.registry()?.getBroadcastProvider("woc", input.network),
            storage: () => storage, sessionEpoch: epoch,
            listProtectedOutpoints: ports.funding.protected, listProtocolProtectedOutpoints: protocolProtection,
            managerProtocolIntent: request => manager.protocolIntentProof(request),
            abortNotDispatched: async () => { /* Signed recovery NEVER releases an original responsibility. */ },
            refresh, publishChanged: ports.changed,
          });
          assertFresh();
          const outcome = response.operationResult as { status?: string; canonicalTxid?: string; txid?: string; reason?: string; providerCode?: string } | undefined;
          if (outcome?.status === "local-confirmed") return { status: "accepted", txid: outcome.canonicalTxid ?? outcome.txid ?? "" };
          if (outcome?.status === "already-known") return { status: "already-known", txid: outcome.canonicalTxid ?? outcome.txid ?? "", rawTxHex };
          if (outcome?.providerCode === "woc-mempool-conflict") return { status: "conflict", txid };
          throw new Error(outcome?.reason ?? "Original exact dispatch result unknown");
        } });
        assertFresh();
        // Observation may conclude without a new provider call. Update the
        // display journal after (never instead of) the manager durable result.
        if (result.delivery === "accepted" || result.delivery === "already-known") {
          const repository = createP2pkhStateRepository(await openP2pkhStateRepository(storage));
          for (const row of await repository.listLocalTransactions()) {
            if (row.txid === result.txid && row.network === input.network && row.publicKeyHex.toLowerCase() === input.ownerPublicKeyHex.toLowerCase()) await repository.finishLocalSubmission({ submissionId: row.id, localState: "local-confirmed" });
          }
        }
        assertFresh();
        return result;
      });
    },
  });
  async function paymentStatus(requestId: string, request: Extract<CoordinatorClientRequest, { kind: "p2pkh.payment.status" }>): Promise<CoordinatorResponse> {
    try {
      if (!ports.available() || ports.network() !== request.input.network) throw new Error("Payment status wallet/network unavailable");
      const captured = capture(request.input.ownerPublicKeyHex); captured.assertFresh();
      const result = await createP2pkhUtxoManager({ files: ports.storage() }).paymentStatus(request.input);
      captured.assertFresh();
      if (!ports.available() || ports.network() !== request.input.network) throw new Error("Payment status wallet/network changed");
      return { requestId, sessionEpoch: epoch(), ack: { status: "ok" }, operationResult: result };
    } catch (error) { return { requestId, sessionEpoch: epoch(), ack: { status: "error", message: error instanceof Error ? error.message : String(error) } }; }
  }
  async function conclusion(requestId: string, request: Extract<CoordinatorClientRequest, { kind: "p2pkh.conclusion" }>): Promise<CoordinatorResponse> {
    try {
      const result = await conclusions.execute(request.input);
      return { requestId, sessionEpoch: epoch(), ack: { status: "ok" }, operationResult: result };
    } catch (error) { return { requestId, sessionEpoch: epoch(), ack: { status: "error", message: error instanceof Error ? error.message : String(error) } }; }
  }

  async function broadcast(requestId: string, request: BroadcastRequest): Promise<CoordinatorResponse> {
    if (!ports.available()) return ports.blocked(requestId);
    return ports.broadcastLease(async () => {
      try {
        const captured = capture(request.ownerPublicKeyHex);
        const manager = createP2pkhUtxoManager({ files: ports.storage() });
        const dependencies = {
          assertFresh: captured.assertFresh,
          provider: ports.provider() ?? ports.domain.registry()?.getBroadcastProvider("woc", request.network),
          storage: ports.storage, sessionEpoch: epoch,
          listProtectedOutpoints: ports.funding.protected, listProtocolProtectedOutpoints: protocolProtection,
          async managerProtocolIntent(input: { ownerPublicKeyHex: string; network: "main" | "test"; allocationId: string; txid: string; inputOutpointKeys: readonly string[] }) {
            return manager.protocolIntentProof(input);
          },
          async assertInputsUnspent(network: "main" | "test", outpointKeys: readonly string[]) {
            const query = ports.domain.query();
            if (!query) throw new Error("P2PKH spent-output reader is unavailable");
            await Promise.all(outpointKeys.map(async (key: string) => {
              const [txid, voutText] = key.split(":");
              if (await requireWocNetwork(query, network).getSpentOutput(txid!, Number(voutText)) !== null) throw new Error(`P2PKH input is already spent: ${key}`);
            }));
            captured.assertFresh();
          },
          abortNotDispatched, refresh, publishChanged: ports.changed,
        };
        const allocationId = request.submission?.managerAllocationId;
        const protocolSubmission = await createWorkerProtocolEvidence(ports.storage()).getProtocolSubmission(request.submissionId);
        captured.assertFresh();
        // A protocol submission that carries a manager allocation is owned by
        // the manager: it holds the durable intent, the exclusive input
        // responsibility and the exact bytes. The protocol WAL stays as
        // business/history evidence and no longer decides dispatchability.
        if (!allocationId) {
          await abortNotDispatched(request, "utxo-manager-required");
          return { requestId, sessionEpoch: epoch(), ack: { status: "ok" }, operationResult: { status: "not-dispatched", reason: "coordinator-not-dispatched" } };
        }
        if (!request.submission) throw new Error("UTXO manager allocation requires an exact signed submission");
        const managerResource = await resource(request.ownerPublicKeyHex, request.network);
        captured.assertFresh();
        if (!managerResource) throw new Error("UTXO manager wallet resource is unavailable");
        const original = (await manager.listConclusions({ ownerPublicKeyHex: request.ownerPublicKeyHex, network: request.network })).find(row => row.allocationId === allocationId);
        const recoveringExact = original?.state === "unknown" || original?.state === "dispatching";
        captured.assertFresh();
        let workerResponse: CoordinatorResponse | undefined;
        try {
          const settled = await manager.submitSigned({
            ownerPublicKeyHex: request.ownerPublicKeyHex, resource: managerResource,
            allocationId, signedTxHex: request.submission.rawTxHex,
            async broadcast(rawTxHex, txid) {
              workerResponse = await executeWorkerP2pkhBroadcast(requestId, {
                ...request, submission: { ...request.submission!, managerAllocationId: allocationId, rawTxHex, txid },
              }, { ...dependencies, recoveringExact });
              captured.assertFresh();
              const outcome = workerResponse.operationResult as { status?: string; txid?: string; canonicalTxid?: string; reason?: string } | undefined;
              if (outcome?.status === "local-confirmed") return { status: "accepted", txid: outcome.canonicalTxid ?? outcome.txid ?? "" };
              if (outcome?.status === "already-known") return { status: "already-known", txid: outcome.canonicalTxid ?? outcome.txid ?? "", rawTxHex };
              if (outcome?.status === "not-dispatched") return { status: "not-dispatched", reason: outcome.reason ?? "coordinator-not-dispatched" };
              throw new Error(outcome?.reason ?? "Worker broadcast outcome is unknown or invalid");
            },
          });
          captured.assertFresh();
          ports.changed({ type: "asset.data-changed", providerId: "p2pkh", publicKeyHex: request.ownerPublicKeyHex, kinds: ["utxo", "balance", "submission"] });
          if (!workerResponse) return { requestId, sessionEpoch: epoch(), ack: { status: "ok" }, operationResult: settled.delivery === "accepted" || settled.delivery === "already-known"
            ? { status: "already-known", txid: settled.txid, canonicalTxid: settled.txid }
            : { status: "isolated", txid: settled.txid, reason: `Manager exact remains ${settled.delivery}` } };
          return workerResponse;
        } catch (error) {
          if (workerResponse?.operationResult && (workerResponse.operationResult as { status?: string }).status !== "not-dispatched") {
            return { ...workerResponse, operationResult: { status: "isolated", txid: request.submission.txid, reason: `UTXO manager result persistence failed: ${error instanceof Error ? error.message : String(error)}` } };
          }
          throw error;
        }
      } catch (error) {
        return { requestId, sessionEpoch: epoch(), ack: { status: "error", message: `P2PKH broadcast failed: ${error instanceof Error ? error.message : String(error)}` } };
      }
    });
  }
  /**
   * 普通转账准备：Window 不持有 Worker 的本地能力，只能把纯数据请求交给
   * Worker。选币、冻结与 allocation 全部在 Worker 的 UTXO Manager 内完成。
   */
  async function protocolCommand(requestId: string, request: Extract<CoordinatorClientRequest, { kind: "p2pkh.protocol.command" }>): Promise<CoordinatorResponse> {
    if (!ports.available()) return ports.blocked(requestId);
    try {
      const command = request.input;
      const input = command.input;
      if (request.expectedSessionEpoch !== epoch() || input.network !== ports.network()) throw new Error("Protocol RPC scope changed");
      const captured = capture(input.ownerPublicKeyHex);
      captured.assertFresh();
      const service = await ports.domain.transfer.ensureProtocol();
      captured.assertFresh();
      let result: P2pkhProtocolCommandResult;
      switch (command.type) {
        case "prepare": case "presign": result = { type: command.type, value: await service.executor[command.type](command.input) }; break;
        case "submit": result = { type: "submit", value: await service.executor.submit(command.input) }; break;
        case "release": await service.executor.releasePrepared!(command.input); result = { type: "release", value: { released: true } }; break;
        case "release-submission": await service.executor.releasePreparedSubmission(command.input); result = { type: "release-submission", value: { released: true } }; break;
        case "funding-plan": result = { type: "funding-plan", value: await service.planFundingCommand(command.input) }; break;
      }
      captured.assertFresh();
      if (input.network !== ports.network()) throw new Error("Protocol RPC network changed");
      return { requestId, sessionEpoch: epoch(), ack: { status: "ok" }, operationResult: result };
    } catch (error) {
      return { requestId, sessionEpoch: epoch(), ack: { status: "error", message: `P2PKH protocol command failed: ${error instanceof Error ? error.message : String(error)}` } };
    }
  }

  async function transferPrepare(requestId: string, request: TransferPrepareRequest): Promise<CoordinatorResponse> {
    if (!ports.available()) return ports.blocked(requestId);
    try {
      const captured = capture(request.input.ownerPublicKeyHex);
      captured.assertFresh();
      const service = await ports.domain.transfer.ensure();
      captured.assertFresh();
      if (request.input.network !== ports.network()) throw new Error("Transfer RPC network does not match the wallet");
      const { ownerPublicKeyHex: _owner, network: _network, assetId: _asset, ...transferRequest } = request.input;
      if (_asset !== (ports.network() === "test" ? "bsvtest" : "bsv")) throw new Error("Transfer RPC identity mismatch");
      const preview = await service.prepareTransfer(transferRequest);
      captured.assertFresh();
      ports.changed({ type: "asset.data-changed", providerId: "p2pkh", publicKeyHex: request.input.ownerPublicKeyHex, kinds: ["utxo", "balance"] });
      return { requestId, sessionEpoch: epoch(), ack: { status: "ok" }, operationResult: preview };
    } catch (error) {
      return { requestId, sessionEpoch: epoch(), ack: { status: "error", message: `P2PKH transfer prepare failed: ${error instanceof Error ? error.message : String(error)}` } };
    }
  }

  /**
   * 普通转账提交：只按 previewId 取回 Worker 自己记住的预览，页面无法改写
   * 选币、金额、找零或 manager allocation。
   */
  async function transferSubmit(requestId: string, request: TransferSubmitRequest): Promise<CoordinatorResponse> {
    if (!ports.available()) return ports.blocked(requestId);
    try {
      const captured = capture(request.input.ownerPublicKeyHex);
      captured.assertFresh();
      const service = await ports.domain.transfer.ensure();
      if (!service.submitPreparedTransfer) throw new Error("P2PKH prepared submit is unavailable");
      const result = await service.submitPreparedTransfer(request.input.previewId);
      captured.assertFresh();
      return { requestId, sessionEpoch: epoch(), ack: { status: "ok" }, operationResult: result };
    } catch (error) {
      return { requestId, sessionEpoch: epoch(), ack: { status: "error", message: `P2PKH transfer submit failed: ${error instanceof Error ? error.message : String(error)}` } };
    }
  }

  /** 外露 artifact 的占用：manager 先占住钱包输入，交付才允许继续。 */
  async function occupyArtifact(requestId: string, request: ArtifactOccupyRequest): Promise<CoordinatorResponse> {
    if (!ports.available()) return ports.blocked(requestId);
    try {
      const captured = capture(request.input.ownerPublicKeyHex);
      captured.assertFresh();
      const result = await ports.domain.transfer.occupyDeliveredArtifact({
        ...request.input,
        inputs: request.input.inputs.map((row) => ({ ...row })),
        outputs: request.input.outputs.map((row) => ({ ...row })),
      });
      captured.assertFresh();
      return { requestId, sessionEpoch: epoch(), ack: { status: "ok" }, operationResult: result };
    } catch (error) {
      return { requestId, sessionEpoch: epoch(), ack: { status: "error", message: `P2PKH artifact occupation failed: ${error instanceof Error ? error.message : String(error)}` } };
    }
  }
  const route = defineWorkerRequestRoute<Extract<CoordinatorClientRequest, { kind: "p2pkh.utxos.get" | "p2pkh.utxos.refresh" | "p2pkh.broadcast" | "p2pkh.transfer.prepare" | "p2pkh.transfer.submit" | "p2pkh.artifact.occupy" | "p2pkh.conclusion" | "p2pkh.payment.status" | "p2pkh.protocol.command" }>>({
    kinds: ["p2pkh.utxos.get", "p2pkh.utxos.refresh", "p2pkh.broadcast", "p2pkh.transfer.prepare", "p2pkh.transfer.submit", "p2pkh.artifact.occupy", "p2pkh.conclusion", "p2pkh.payment.status", "p2pkh.protocol.command"],
    policy: () => ({ scheduling: "serial", validateEpoch: true }),
    execute: (request, call) => {
      if (request.kind === "p2pkh.payment.status") return paymentStatus(call.requestId, request);
      if (request.kind === "p2pkh.conclusion") return conclusion(call.requestId, request);
      if (request.kind === "p2pkh.broadcast") return broadcast(call.requestId, request);
      if (request.kind === "p2pkh.protocol.command") return protocolCommand(call.requestId, request);
      if (request.kind === "p2pkh.transfer.prepare") return transferPrepare(call.requestId, request);
      if (request.kind === "p2pkh.transfer.submit") return transferSubmit(call.requestId, request);
      if (request.kind === "p2pkh.artifact.occupy") return occupyArtifact(call.requestId, request);
      return snapshot(call.requestId, request, request.kind === "p2pkh.utxos.refresh");
    },
    async stale(request, call) {
      if (request.kind !== "p2pkh.broadcast") return undefined;
      await abortNotDispatched(request, "stale-session-epoch");
      return { requestId: call.requestId, sessionEpoch: epoch(), ack: { status: "ok" }, operationResult: { status: "not-dispatched", reason: "stale-session-epoch" } };
    },
  });
  return { route, ensureResources, resource, refresh, protocolProtection, snapshot, broadcast, abortNotDispatched, dispose: () => conclusions.dispose() };
}
