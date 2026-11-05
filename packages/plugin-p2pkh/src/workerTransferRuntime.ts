import { requireUnlockedWalletIdentity } from "@keymaster/contracts";
import type { ActiveKeyCrypto, BorrowedModuleFileStore, CoordinatorValueResult, VaultWalletState, P2pkhBroadcastSubmission, P2pkhUtxoSnapshotResult, VaultStatus, CentralBroadcastService, WocService } from "@keymaster/contracts";
import { createMessageBus } from "webloom-framework";
import { createCentralBroadcastService } from "./centralBroadcastService.js";
import { createP2pkhService } from "./p2pkhService.js";
import { createWorkerProtocolRuntime } from "./workerProtocolRuntime.js";
import { p2pkhUtxosFromTransaction, createP2pkhSubmissionRuntime } from "./p2pkhSubmissionRuntime.js";

import { createP2pkhUtxoManager, type P2pkhUtxoManager } from "./p2pkhUtxoManager.js";
import type { P2pkhService } from "./p2pkhContracts.js";

type SnapshotInput = { ownerPublicKeyHex: string; network: "main" | "test" };
export interface WorkerTransferDependencies {
  assertActive(): void;
  session(): { owner?: string; epoch: string; unlocked: boolean };
  loadSettings(owner: string): Promise<void>;
  effectiveFeeRate(network: "main" | "test"): number;
  walletState(): VaultWalletState;
  storage(): BorrowedModuleFileStore;
  crypto(owner: string): Promise<ActiveKeyCrypto>;
  vaultStatus(): VaultStatus;
  snapshot(input: SnapshotInput, refresh: boolean): Promise<CoordinatorValueResult<P2pkhUtxoSnapshotResult>>;
  broadcast(input: SnapshotInput & { submissionId: string; submission?: P2pkhBroadcastSubmission }): Promise<CoordinatorValueResult<unknown>>;
  subscribeUtxo(listener: (event: { ownerPublicKeyHex: string; network: "main" | "test"; seq: number }) => void): () => void;
  query?(): WocService | undefined;
  fundsChanged(input: SnapshotInput): void;
}

/** P2PKH owns its lazy Worker transfer service and candidate disposal. */
export function createWorkerTransferRuntime(deps: WorkerTransferDependencies) {
  let current: P2pkhService | undefined;
  let currentIdentity: Readonly<import("@keymaster/contracts").NetworkIdentity> | undefined;
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
    currentIdentity = undefined;
    currentOwner = undefined;
    currentEpoch = undefined;
    try { old?.onVaultLocked(); } catch { /* cleanup remains idempotent */ }
    try { old?.dispose?.(); } catch { /* cleanup remains idempotent */ }
    return { starting, protocolStarting: pendingProtocol };
  }
  async function ensure(): Promise<P2pkhService> {
    deps.assertActive();
    const session = deps.session();
    const owner = session.owner;
    const epoch = session.epoch;
    if (!session.unlocked || !owner) throw new Error("P2PKH requires the current unlocked owner");
    const identity = requireUnlockedWalletIdentity(deps.walletState().snapshot());
    if (identity.publicKeyHex.toLowerCase() !== owner.toLowerCase()) throw new Error("P2PKH transfer identity does not match the current owner");
    const network = identity.bsvNetwork;
    const token = generation;
    const assertFresh = () => {
      deps.assertActive();
      const now = deps.session();
      const nowIdentity = requireUnlockedWalletIdentity(deps.walletState().snapshot());
      if (token !== generation || !now.unlocked || now.owner !== owner || now.epoch !== epoch
        || nowIdentity.publicKeyHex.toLowerCase() !== identity.publicKeyHex.toLowerCase()
        || nowIdentity.bsvNetwork !== network) throw new Error("P2PKH transfer service became stale");
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
        p2pkhUtxosGet: (input: SnapshotInput) => deps.snapshot(input, false),
        p2pkhUtxosRefresh: (input: SnapshotInput) => deps.snapshot(input, true),
      };
      const centralService = createCentralBroadcastService({
        binding: { identity, assertActive: assertFresh },
        coordinator: { p2pkhBroadcast: broadcast },
      });
      utxoManager = createP2pkhUtxoManager({ files: deps.storage() });
      const { service } = createP2pkhService({
        vault: { status: deps.vaultStatus, createActiveKeyCrypto: async () => { assertFresh(); const crypto = await deps.crypto(owner); assertFresh(); return crypto; } },
        utxoManager, submissions: createP2pkhSubmissionRuntime(deps.storage()),
        woc: deps.query?.(),
        effectiveFeeRate: deps.effectiveFeeRate,
        coordinator, centralBroadcastService: centralService, broadcastWithCoordinator: broadcast,
        walletState: deps.walletState(), storage: deps.storage(), messageBus: createMessageBus(),
      });
      try {
        await service.onVaultUnlocked();
        assertFresh();
        central = centralService;
        currentIdentity = Object.freeze({ ...identity });
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
    await ensure();
    if (protocol) return protocol;
    if (protocolStarting) return protocolStarting;
    const owner = currentOwner!; const epoch = currentEpoch!; const token = generation;
    const network = requireUnlockedWalletIdentity(deps.walletState().snapshot()).bsvNetwork;
    const assertActive = () => { deps.assertActive(); const now = deps.session(); const current = requireUnlockedWalletIdentity(deps.walletState().snapshot()); if (generation !== token || !now.unlocked || now.owner !== owner || now.epoch !== epoch || current.publicKeyHex.toLowerCase() !== owner.toLowerCase() || current.bsvNetwork !== network) throw new Error("Protocol wallet instance revoked"); };
    const run = createWorkerProtocolRuntime({
       assertActive, owner, network, storage: deps.storage(), crypto: deps.crypto,
      central: central!,
      manager: utxoManager!, submissions: createP2pkhSubmissionRuntime(deps.storage()),
    });
    protocolStarting = run;
    try { const candidate = await run; try { assertActive(); } catch (error) { candidate.dispose(); throw error; } protocol = candidate; return candidate; }
    finally { if (protocolStarting === run) protocolStarting = undefined; }
  }
  function identityFor(service: P2pkhService): Readonly<import("@keymaster/contracts").NetworkIdentity> {
    if (current !== service || !currentIdentity) throw new Error("P2PKH transfer identity is no longer active");
    return currentIdentity;
  }
  async function submitWalletExact(input: SnapshotInput & { txid: string; rawTxHex: string }) {
    await ensure();
    const transactions = createP2pkhSubmissionRuntime(deps.storage());
    const entry = transactions.byTxid(input);
    const scope = {ownerPublicKeyHex: input.ownerPublicKeyHex, network: input.network, submissionId: entry.plan.submissionId};
    if (!entry.plan.allocationId) throw new Error("Wallet transaction has no allocation");
    if (entry.state === "rejected" || entry.state === "cancelled") throw Object.assign(new Error("Wallet transaction intention has ended"), {code: "definitive-not-dispatched"});
    let result: CoordinatorValueResult<unknown>;
    try {
      result = await deps.broadcast({ ...input, submissionId: entry.plan.submissionId, submission: { resourceId: `p2pkh:${input.network}`, txid: input.txid, rawTxHex: input.rawTxHex, managerAllocationId: entry.plan.allocationId } });
    } catch (error) {
      const code = (error as {code?: string})?.code;
      if (code !== "definitive-not-dispatched" && code !== "woc-tx-rejected") transactions.outcome({...scope, state: "unknown"});
      throw error;
    }
    if (result.status !== "ok") {
      const definitive = result.status === "transport-error" && result.dispatchStatus === "not-dispatched";
      if (!definitive) transactions.outcome({...scope, state: "unknown"});
      throw Object.assign(new Error("Wallet exact dispatch failed"), {code: definitive ? "definitive-not-dispatched" : "broadcast-unknown"});
    }
    const outcome = result.value as { status?: string; reason?: string; providerCode?: string };
    if (outcome.status !== "local-confirmed" && outcome.status !== "already-known") {
      const code = outcome.status === "not-dispatched" ? "definitive-not-dispatched" : outcome.providerCode === "woc-tx-rejected" ? "woc-tx-rejected" : "broadcast-unknown";
      if (code === "broadcast-unknown") transactions.outcome({...scope, state: "unknown"});
      throw Object.assign(new Error(outcome.reason ?? "Wallet exact dispatch result unknown"), {code});
    }
    return { outcome: outcome.status === "already-known" ? "already-known" as const : "accepted" as const };
  }
  async function observeBusinessReceipt(input: SnapshotInput & { rawTxHex: string }) {
    await ensure();
    const session = deps.session();
    if (!session.unlocked || session.owner?.toLowerCase() !== input.ownerPublicKeyHex.toLowerCase()) throw new Error("Business receipt owner mismatch");
    const utxos = p2pkhUtxosFromTransaction(input.rawTxHex, input);
    if (utxos.length) await utxoManager!.injectP2pkhUtxos({...input, utxos});
    createP2pkhSubmissionRuntime(deps.storage()).observeAccepted(input);
    deps.fundsChanged(input);
  }
  return { ensure, ensureProtocol, identityFor, release, submitWalletExact, observeBusinessReceipt };
}
