import { deriveP2pkhAddress } from "@keymaster/contracts";
import { requireWocNetwork } from "@keymaster/contracts";
import type { ActiveKeyCrypto, AssetDataChangedEvent, BorrowedModuleFileStore, CoordinatorValueResult, VaultWalletState, P2pkhBroadcastSubmission, P2pkhUtxoSnapshotResult, VaultStatus, CentralBroadcastService, WocService } from "@keymaster/contracts";
import { createMessageBus } from "webloom-framework";
import { createCentralBroadcastService } from "./centralBroadcastService.js";
import { createP2pkhService } from "./p2pkhService.js";
import { createWorkerProtocolRuntime, readWorkerProtocolProtection } from "./workerProtocolRuntime.js";
import type { P2pkhProtocolManagerPort } from "./p2pkhProtocolSpend.js";

import { p2pkhAddressToScriptHex } from "./p2pkhTransactionParser.js";
import { createP2pkhUtxoManager, type P2pkhUtxoManager } from "./p2pkhUtxoManager.js";
import type { P2pkhService } from "./p2pkhContracts.js";
import { createWocInputObserver } from "./wocInputObserver.js";

type SnapshotInput = { ownerPublicKeyHex: string; network: "main" | "test" };
export interface WorkerTransferDependencies {
  requestPayment: import("@keymaster/contracts").VaultService["requestPayment"];
  assertActive(): void;
  session(): { owner?: string; epoch: string; unlocked: boolean };
  loadSettings(owner: string): Promise<void>;
  settings(): { bsvNetwork: "main" | "test"; feeRateSatoshisPerKb?: number };
  walletState(): VaultWalletState;
  storage(): BorrowedModuleFileStore;
  crypto(owner: string): Promise<ActiveKeyCrypto>;
  vaultStatus(): VaultStatus;
  snapshot(input: SnapshotInput, refresh: boolean): Promise<CoordinatorValueResult<P2pkhUtxoSnapshotResult>>;
  broadcast(input: SnapshotInput & { submissionId: string; submission?: P2pkhBroadcastSubmission }): Promise<CoordinatorValueResult<unknown>>;
  subscribeUtxo(listener: (event: { ownerPublicKeyHex: string; network: "main" | "test"; seq: number }) => void): () => void;
  query?(): WocService | undefined;
  protectedOutpoints(owner: string, network: "main" | "test"): Promise<readonly { txid: string; vout: number }[]>;
  fundsChanged(input: SnapshotInput): void;
}

/** P2PKH owns its lazy Worker transfer service and candidate disposal. */
export function createWorkerTransferRuntime(deps: WorkerTransferDependencies) {
  let current: P2pkhService | undefined;
  let currentOwner: string | undefined;
  let currentEpoch: string | undefined;
  let starting: Promise<P2pkhService> | undefined;
  let generation = 0;
  let central: CentralBroadcastService | undefined;
  let protocol: Awaited<ReturnType<typeof createWorkerProtocolRuntime>> | undefined;
  let protocolStarting: Promise<Awaited<ReturnType<typeof createWorkerProtocolRuntime>>> | undefined;
  let utxoManager: P2pkhUtxoManager | undefined;
  function release(): { starting?: Promise<P2pkhService>; protocolStarting?: typeof protocolStarting } {
    const pendingProtocol = protocolStarting;
    generation += 1;
    protocol?.dispose();
    protocol = undefined; protocolStarting = undefined; central = undefined;
    const old = current;
    current = undefined;
    currentOwner = undefined;
    currentEpoch = undefined;
    try { old?.onVaultLocked(); } catch { /* cleanup remains idempotent */ }
    try { old?.dispose?.(); } catch { /* cleanup remains idempotent */ }
    return { starting, protocolStarting: pendingProtocol };
  }
  /**
   * UTXO manager port for the protocol services: durable pre-signature
   * intent, exclusive input responsibility and exact-byte ownership.
   */
  async function protocolContext(request: { ownerPublicKeyHex: string; network: "main" | "test" }, refresh = false) {
    const manager = utxoManager;
    if (!manager) throw new Error("P2PKH UTXO manager is not ready");
    const session = deps.session();
    if (!session.unlocked || session.owner?.toLowerCase() !== request.ownerPublicKeyHex.toLowerCase()) throw new Error("Protocol manager owner mismatch");
    const address = deriveP2pkhAddress(request.ownerPublicKeyHex, request.network);
    const resource = { resourceId: `p2pkh:${request.network}`, network: request.network, address };
    const snapshot = await deps.snapshot({ ownerPublicKeyHex: request.ownerPublicKeyHex, network: request.network }, refresh);
    if (manager !== utxoManager) throw new Error("Protocol manager instance revoked");
    const utxos = snapshot.status === "ok" && snapshot.value.hasResult
      ? snapshot.value.items.filter(item => !item.isSpentInMempoolTx).map(item => ({
        id: `utxo:${resource.resourceId}:${item.txid}:${item.vout}`, resourceId: resource.resourceId,
        publicKeyHex: request.ownerPublicKeyHex, network: request.network, address,
        txid: item.txid, vout: item.vout, value: item.value, height: item.height,
        script: p2pkhAddressToScriptHex(address, request.network), status: item.status,
        isSpentInMempoolTx: item.isSpentInMempoolTx, syncedAt: new Date(0).toISOString(),
      })) : [];
    return { manager, resource, utxos };
  }
  const protocolManagerPort: P2pkhProtocolManagerPort = {
    async cancelProtocolSubmission(request) {
      const manager = utxoManager;
      if (!manager) throw new Error("Protocol manager unavailable");
      let proof: import("@keymaster/vaultlink-integration").ProtocolExecutionProof | null = null;
      try { proof = await deps.requestPayment({ action: "protocol-payment-status", executionId: request.submissionId }) as unknown as typeof proof; } catch { /* Missing/unreadable evidence never releases inputs. */ }
      await manager.cancelProtocolSubmission({ ...request, proof });
      if (proof && (proof as import("@keymaster/vaultlink-integration").ProtocolExecutionProof).state === "cancelled_before_sign") {
        try { await deps.requestPayment({ action: "protocol-payment-ack", executionIds: [request.submissionId] }); }
        catch (error) { console.warn("[p2pkh] Cancelled protocol ACK lost; manager cancellation retained", error); }
      }
      deps.fundsChanged(request);
    },
    async selectFundingInputs(request) {
      const { manager, resource, utxos } = await protocolContext(request, true);
      const planned = await manager.selectProtocolFunding({ ...request, resource, utxos });
      return {
        selected: planned.selectedInputs.map(row => ({
          txid: row.utxo.txid, vout: row.utxo.vout, value: row.utxo.value, address: row.utxo.address,
          ...(row.previousTransactionHex === undefined ? {} : { previousTransactionHex: row.previousTransactionHex }),
        })),
        totalInputSatoshis: planned.totalInputSatoshis,
      };
    },
    async beginProtocolIntent(request) {
      const { manager, resource, utxos } = await protocolContext(request);
      const result = await manager.beginProtocolIntent({ ...request, resource, utxos });
      deps.fundsChanged(request);
      return result;
    },
    async completeProtocolIntent(request) {
      const manager = utxoManager;
      if (!manager) throw new Error("P2PKH UTXO manager is not ready");
      const address = deriveP2pkhAddress(request.ownerPublicKeyHex, request.network);
      const result = await manager.completeProtocolIntent({
        ...request,
        resource: { resourceId: `p2pkh:${request.network}`, network: request.network, address },
      });
      deps.fundsChanged(request);
      return result;
    },
  };
  async function ensure(): Promise<P2pkhService> {
    deps.assertActive();
    const session = deps.session();
    const owner = session.owner;
    const epoch = session.epoch;
    if (!session.unlocked || !owner) throw new Error("P2PKH requires the current unlocked owner");
    const token = generation;
    const assertFresh = () => {
      deps.assertActive();
      const now = deps.session();
      if (token !== generation || !now.unlocked || now.owner !== owner || now.epoch !== epoch) throw new Error("P2PKH transfer service became stale");
    };
    await deps.loadSettings(owner);
    assertFresh();
    if (current && currentOwner === owner && currentEpoch === epoch) {
      const service = current;
      await service.onVaultUnlocked();
      assertFresh();
      if (current !== service) throw new Error("P2PKH transfer service was replaced");
      return service;
    }
    if (starting) {
      const pending = starting;
      await pending.catch(() => undefined);
      assertFresh();
      if (current && currentOwner === owner && currentEpoch === epoch) return current;
    }
    if (current) { release(); return ensure(); }
    const run = (async () => {
      const broadcast: WorkerTransferDependencies["broadcast"] = async (input) => {
        const now = deps.session();
        if (token !== generation || !now.unlocked || now.owner !== owner || now.epoch !== epoch) return { status: "ok", value: { status: "not-dispatched", reason: "stale-session-epoch" }, sessionEpoch: now.epoch };
        const result = await deps.broadcast(input);
        assertFresh();
        return result;
      };
      const coordinator = {
        getBootstrapSnapshot: () => ({ p2pkhSettings: deps.settings() }),
        p2pkhUtxosGet: (input: SnapshotInput) => deps.snapshot(input, false),
        p2pkhUtxosRefresh: (input: SnapshotInput) => deps.snapshot(input, true),
        // 占用是 Worker 内部动作：Window 只能经 Coordinator 请求它发生。
        p2pkhArtifactOccupy: async () => { throw new Error("P2PKH artifact occupation is worker-internal"); },
      };
      const centralService = createCentralBroadcastService({
        binding: { identity: { publicKeyHex: owner, bsvNetwork: deps.settings().bsvNetwork }, assertActive: assertFresh },
        coordinator: { p2pkhBroadcast: broadcast },
      });
      utxoManager = createP2pkhUtxoManager({
        files: deps.storage(),
        async listProtectedOutpoints(protectedOwner, network) {
          assertFresh();
          // Every protection keeps its source so the manager can take over
          // its own protocol claim without dropping somebody else's
          // protection on the same outpoint.
          const persisted = await readWorkerProtocolProtection(deps.storage(), protectedOwner, network);
          assertFresh();
          const activeProtocol = protocol ?? await ensureProtocol();
          assertFresh();
          const registry = activeProtocol.protectedOutpoints.list({ publicKeyHex: protectedOwner, network });
          return [
            ...persisted,
            ...await deps.protectedOutpoints(protectedOwner, network),
            ...registry.map((row) => ({
              txid: row.txid,
              vout: row.vout,
              kind: row.kind,
              source: row.source ?? `fund:${row.ownerPluginId ?? "unknown"}`,
            })),
          ];
        },
        chain: {
          async observeInputs(network, keys, diagnostic) {
            assertFresh();
            const woc = deps.query?.();
            if (!woc) return [];
            const facts = await createWocInputObserver(woc, network, diagnostic).observeInputs(keys);
            assertFresh();
            return facts;
          },
          async observe(network, txid) {
            const woc = deps.query?.();
            if (!woc?.getRawTransaction) return null;
            const raw = await requireWocNetwork(woc, network).getRawTransaction(txid);
            return raw.replace(/^0x/i, "").toLowerCase();
          },
        },
      });
      const recoveryManager = utxoManager, recoveryNetwork = deps.settings().bsvNetwork;
      const assertRecoveryFresh = () => { assertFresh(); if (utxoManager !== recoveryManager || deps.settings().bsvNetwork !== recoveryNetwork) throw new Error('Connect recovery scope changed'); };
      try {
        const recovered = await deps.requestPayment({ action: "connect-payment-recovery" });
        assertRecoveryFresh();
        if (Array.isArray(recovered) && recovered.length > 0) {
          const released = await recoveryManager.recoverCancelledPayments({
            ownerPublicKeyHex: owner,
            network: recoveryNetwork,
            proofs: recovered as Array<{ paymentId: string; planDigest: string; version: number; state: "cancelled_before_sign" }>,
          });
          assertRecoveryFresh();
          if (released.length > 0) {
            await deps.requestPayment({ action: "connect-payment-recovery-ack", paymentIds: released.map((row) => row.paymentId) });
            assertRecoveryFresh();
          }
        }
      } catch (error) {
        console.warn("[p2pkh] Connect payment journal recovery failed", error instanceof Error ? error.message : String(error));
      }
      assertRecoveryFresh();
      try {
        // Startup takeover is local persistence ONLY. Pending signed outboxes
        // remain stopped until the owner explicitly starts exact retransmission.
        const signed = await deps.requestPayment({ action: 'connect-payment-signed-recovery' });
        assertRecoveryFresh();
        if (!Array.isArray(signed)) throw new Error('Invalid signed payment recovery response');
        if (signed.length) {
          const adopted = await recoveryManager.recoverSignedPayments({ ownerPublicKeyHex: owner, network: recoveryNetwork, proofs: signed as Array<{ paymentId: string; planDigest: string; version: number; state: 'signed_complete' | 'quarantined'; signedTxHex?: string }> });
          assertRecoveryFresh();
          if (adopted.length) {
            try {
              await deps.requestPayment({ action: 'connect-payment-recovery-ack', paymentIds: adopted.map(row => row.paymentId) });
            } catch (error) {
              assertRecoveryFresh(); // durable manager exact already covers the duty; lost ACK is safely retryable.
              console.warn('[p2pkh] Connect signed handoff ACK failed', error instanceof Error ? error.message : String(error));
            }
            assertRecoveryFresh();
          }
        }
      } catch (error) {
        console.warn('[p2pkh] Connect signed payment takeover failed', error instanceof Error ? error.message : String(error));
        // Missing original intents/orphan signatures cannot permit a fresh
        // wallet snapshot to treat potentially signed inputs as free money.
        throw error;
      }
      assertRecoveryFresh();
      // Adopt exact/cancellation evidence before any new protocol funding.
      // Partial or unknown executions remain held and visible, never re-signed.
      const protocolProofs = await deps.requestPayment({ action: "protocol-payment-recovery" });
      assertRecoveryFresh();
      if (!Array.isArray(protocolProofs)) throw new Error("Invalid protocol execution recovery response");
      const protocolAck: string[] = [];
      for (const proof of protocolProofs) {
        const adopted = await recoveryManager.recoverProtocolExecution({ ownerPublicKeyHex: owner, network: recoveryNetwork, proof: proof as unknown as import("@keymaster/vaultlink-integration").ProtocolExecutionProof });
        assertRecoveryFresh();
        if (adopted) protocolAck.push((proof as unknown as { executionId: string }).executionId);
      }
      if (protocolAck.length) {
        try { await deps.requestPayment({ action: "protocol-payment-ack", executionIds: protocolAck }); }
        catch (error) { console.warn("[p2pkh] Protocol journal ACK lost; manager responsibility retained", error); }
        assertRecoveryFresh();
      }
      const { service } = createP2pkhService({
        vault: { status: deps.vaultStatus, createActiveKeyCrypto: async () => { assertFresh(); const crypto = await deps.crypto(owner); assertFresh(); return crypto; }, requestPayment: deps.requestPayment },
        utxoManager,
        woc: deps.query?.(),
        effectiveFeeRate: () => deps.settings().feeRateSatoshisPerKb ?? 100,
        coordinator, centralBroadcastService: centralService, broadcastWithCoordinator: broadcast,
        walletState: deps.walletState(), storage: deps.storage(), messageBus: createMessageBus(),
      });
      try {
        await service.onVaultUnlocked();
        assertFresh();
        // D05: settle outstanding exact transactions against the chain before
        // any new request is served. A failure keeps the responsibility.
        for (const network of ["main", "test"] as const) {
          try {
            await utxoManager!.reconcile({ ownerPublicKeyHex: owner, network });
          } catch (error) {
            // An unreadable ledger is not an empty ledger: the outstanding
            // responsibility stays unknown and must be visible.
            console.warn("[p2pkh] UTXO manager recovery failed", error instanceof Error ? error.message : String(error));
          }
          assertFresh();
        }
        central = centralService;
        current = service; currentOwner = owner; currentEpoch = epoch;
        return service;
      } catch (error) {
        try { service.onVaultLocked(); } catch { /* failed candidate owns its cleanup */ }
        try { service.dispose?.(); } catch { /* failed candidate owns its cleanup */ }
        throw error;
      }
    })();
    starting = run;
    try { return await run; }
    finally { if (starting === run) starting = undefined; }
  }
  async function ensureProtocol() {
    const transfer = await ensure();
    if (protocol) return protocol;
    if (protocolStarting) return protocolStarting;
    const owner = currentOwner!; const epoch = currentEpoch!; const token = generation;
    const network = deps.settings().bsvNetwork;
    const assertActive = () => { deps.assertActive(); const now = deps.session(); if (generation !== token || !now.unlocked || now.owner !== owner || now.epoch !== epoch || deps.settings().bsvNetwork !== network) throw new Error("Protocol wallet instance revoked"); };
    const run = createWorkerProtocolRuntime({
      requestPayment: deps.requestPayment, assertActive, owner, network, storage: deps.storage(), crypto: deps.crypto,
      central: central!, transfer, query: () => deps.query?.(), snapshot: async network => { const result = await deps.snapshot({ ownerPublicKeyHex: owner, network }, false); assertActive(); return result.status === "ok" ? result.value : { hasResult: false, items: null, seq: null, syncedAt: null }; },
      protocolManager: protocolManagerPort,
    });
    protocolStarting = run;
    try { const candidate = await run; try { assertActive(); } catch (error) { candidate.dispose(); throw error; } protocol = candidate; return candidate; }
    finally { if (protocolStarting === run) protocolStarting = undefined; }
  }
  /**
   * 占用一件**已签名、即将外露**的 artifact 的钱包输入。
   *
   * 中文说明：Connect/费用池把已签名的 artifact 交给站点之前，钱包输入的
   * 责任必须先落到 UTXO Manager——否则同一枚输入仍会被当作可花余额。占用
   * 以 delivery="external" 完成：字节离开钱包后，exact 处于 unknown 状态，
   * 只能由可信观察结算，找零也随之投影。
   */
  async function occupyDeliveredArtifact(input: {
    ownerPublicKeyHex: string;
    network: "main" | "test";
    artifactId: string;
    unsignedTxHex: string;
    signedTxHex: string;
    inputs: Array<{ txid: string; vout: number; value: string; scriptHex: string }>;
    outputs: Array<{ scriptHex: string; value: string }>;
    businessAmountSatoshis: string;
    feeRateSatoshisPerKb: string;
    feeCapSats: string;
    protocolKind: "refund" | "close" | "fund" | "state";
  }): Promise<{ allocationId: string; txid: string }> {
    // 冷实例直接占用也必须可用：先走受控初始化（建立 manager 与当前会话），
    // 再占用；不能要求先做过一次普通转账来预热。
    await ensure();
    const begun = await protocolManagerPort.beginProtocolIntent({
      ownerPublicKeyHex: input.ownerPublicKeyHex,
      network: input.network,
      binding: { kind: input.protocolKind, poolId: input.artifactId },
      unsignedTxHex: input.unsignedTxHex,
      inputs: input.inputs.map((row) => ({
        outpoint: `${row.txid}:${row.vout}`, class: "wallet", value: row.value, scriptHex: row.scriptHex, claimId: null,
      })),
      outputs: input.outputs,
      artifactId: input.artifactId,
      businessAmountSats: input.businessAmountSatoshis,
      feeRateSatPerKb: input.feeRateSatoshisPerKb,
      feeCapSats: input.feeCapSats,
      feePolicy: "exact",
      externalProofs: {},
      claims: [],
    });
    const completed = await protocolManagerPort.completeProtocolIntent({
      ownerPublicKeyHex: input.ownerPublicKeyHex,
      network: input.network,
      allocationId: begun.allocationId,
      signedTxHex: input.signedTxHex,
      delivery: "external",
    });
    return { allocationId: begun.allocationId, txid: completed.txid };
  }
  async function submitWalletExact(input: SnapshotInput & { txid: string; rawTxHex: string }) {
    await ensure();
    const manager = utxoManager!;
    const entry = (await manager.listConclusions(input)).find(row => row.txid === input.txid);
    if (!entry) throw new Error("Wallet exact has no durable manager allocation");
    await manager.allowBusinessDispatch({ ...input, allocationId: entry.allocationId });
    const result = await deps.broadcast({ ...input, submissionId: `manager:${entry.allocationId}`, submission: { resourceId: `p2pkh:${input.network}`, txid: input.txid, rawTxHex: input.rawTxHex, managerAllocationId: entry.allocationId } });
    if (result.status !== "ok") throw new Error("Wallet exact dispatch failed");
    const outcome = result.value as { status?: string; reason?: string };
    if (outcome.status !== "local-confirmed" && outcome.status !== "already-known") throw new Error(outcome.reason ?? "Wallet exact dispatch result unknown");
    return { outcome: outcome.status === "already-known" ? "already-known" as const : "accepted" as const };
  }
  async function observeBusinessReceipt(input: SnapshotInput & { rawTxHex: string }) {
    await ensure();
    const session = deps.session();
    if (!session.unlocked || session.owner?.toLowerCase() !== input.ownerPublicKeyHex.toLowerCase()) throw new Error("Business receipt owner mismatch");
    const resource = { resourceId: `p2pkh:${input.network}`, network: input.network, address: deriveP2pkhAddress(input.ownerPublicKeyHex, input.network) };
    await utxoManager!.observeAcceptedExact({ ...input, resource });
    deps.fundsChanged(input);
  }
  async function recoverSigning(input: SnapshotInput & { allocationId: string }) {
    await ensure();
    const manager = utxoManager!, session = deps.session();
    const assertFresh = () => { const now = deps.session(); deps.assertActive(); if (utxoManager !== manager || !now.unlocked || now.epoch !== session.epoch || now.owner?.toLowerCase() !== input.ownerPublicKeyHex.toLowerCase() || deps.settings().bsvNetwork !== input.network) throw new Error("Protocol recovery scope mismatch"); };
    assertFresh();
    const identity = await manager.protocolExecutionIdentity(input);
    assertFresh();
    if (!identity) throw new Error("No verifiable protocol execution identity; responsibility retained");
    const proof = await deps.requestPayment({ action: "protocol-payment-status", executionId: identity.executionId });
    assertFresh();
    if (!proof) throw new Error("Protocol execution journal is missing; responsibility retained");
    const recovered = await manager.recoverProtocolExecution({ ...input, proof: proof as unknown as import("@keymaster/vaultlink-integration").ProtocolExecutionProof });
    assertFresh();
    if (recovered) {
      try { await deps.requestPayment({ action: "protocol-payment-ack", executionIds: [identity.executionId] }); }
      catch (error) { console.warn("[p2pkh] Protocol recovery ACK lost", error); }
    }
    assertFresh();
    deps.fundsChanged(input);
    return recovered;
  }
  async function ownsWalletExact(input: SnapshotInput & { txid: string; rawTxHex: string }) { await ensure(); return utxoManager!.ownsWalletExact(input); }
  async function previousTransaction(input: SnapshotInput & { txid: string }) { await ensure(); return utxoManager!.previousTransaction(input); }
  return { ensure, ensureProtocol, release, occupyDeliveredArtifact, submitWalletExact, ownsWalletExact, previousTransaction, recoverSigning, observeBusinessReceipt, protectedOutpoints: () => protocol?.protectedOutpoints };
}
