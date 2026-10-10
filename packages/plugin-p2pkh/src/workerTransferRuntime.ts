import type { ActiveKeyCrypto, AssetDataChangedEvent, BorrowedModuleFileStore, CoordinatorValueResult, VaultWalletState, P2pkhBroadcastSubmission, P2pkhUtxoSnapshotResult, VaultStatus, CentralBroadcastService, WocService } from "@keymaster/contracts";
import { createMessageBus } from "webloom-framework";
import { createCentralBroadcastService, type CentralBroadcastServiceDeps } from "./centralBroadcastService.js";
import { createP2pkhService } from "./p2pkhService.js";
import { createWorkerProtocolRuntime } from "./workerProtocolRuntime.js";
import type { P2pkhService } from "./p2pkhContracts.js";

type SnapshotInput = { ownerPublicKeyHex: string; network: "main" | "test" };
export interface WorkerTransferDependencies {
  requestPayment: import("@keymaster/contracts").VaultService["requestPayment"];
  assertActive(): void;
  session(): { owner?: string; epoch: string; unlocked: boolean };
  loadSettings(owner: string): Promise<void>;
  settings(): { includeTestnet: boolean };
  walletState(): VaultWalletState;
  storage(): BorrowedModuleFileStore;
  crypto(owner: string): Promise<ActiveKeyCrypto>;
  vaultStatus(): VaultStatus;
  snapshot(input: SnapshotInput, refresh: boolean): Promise<CoordinatorValueResult<P2pkhUtxoSnapshotResult>>;
  broadcast(input: SnapshotInput & { submissionId: string; submission?: P2pkhBroadcastSubmission }): Promise<CoordinatorValueResult<unknown>>;
  subscribeUtxo(listener: (event: { ownerPublicKeyHex: string; network: "main" | "test"; seq: number }) => void): () => void;
  query?(): WocService | undefined;
  retryOptions(): Pick<CentralBroadcastServiceDeps, "maxAttempts" | "deadlineMs" | "initialBackoffMs" | "maxBackoffMs"> | undefined;
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
  function release(): { starting?: Promise<P2pkhService> } {
    generation += 1;
    protocol?.dispose();
    protocol = undefined; protocolStarting = undefined; central = undefined;
    const old = current;
    current = undefined;
    currentOwner = undefined;
    currentEpoch = undefined;
    try { old?.onVaultLocked(); } catch { /* cleanup remains idempotent */ }
    try { old?.dispose?.(); } catch { /* cleanup remains idempotent */ }
    return { starting };
  }
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
      };
      const centralService = createCentralBroadcastService({
        coordinator: { p2pkhBroadcast: broadcast },
        subscribeTopic: listener => deps.subscribeUtxo(event => {
          if (event.ownerPublicKeyHex.toLowerCase() !== owner.toLowerCase()) return;
          listener({ utxoSeqs: { [event.network]: event.seq } } as AssetDataChangedEvent);
        }),
        getSnapshot: async network => {
          const result = await coordinator.p2pkhUtxosGet({ ownerPublicKeyHex: owner, network });
          assertFresh();
          return result.status === "ok" ? result.value : { available: false, state: "unavailable", items: [] };
        },
        refreshSnapshot: async network => {
          const result = await coordinator.p2pkhUtxosRefresh({ ownerPublicKeyHex: owner, network });
          assertFresh();
          return result.status === "ok" ? result.value : { available: false, state: "unavailable", items: [] };
        },
        ...deps.retryOptions(),
      });
      const service = createP2pkhService({
        vault: { status: deps.vaultStatus, createActiveKeyCrypto: deps.crypto, requestPayment: deps.requestPayment },
        woc: deps.query?.(),
        coordinator, centralBroadcastService: centralService, broadcastWithCoordinator: broadcast,
        walletState: deps.walletState(), storage: deps.storage(), messageBus: createMessageBus(),
      });
      try {
        await service.onVaultUnlocked();
        assertFresh();
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
    const assertActive = () => { deps.assertActive(); const now = deps.session(); if (generation !== token || !now.unlocked || now.owner !== owner || now.epoch !== epoch) throw new Error("Protocol wallet instance revoked"); };
    const run = createWorkerProtocolRuntime({ requestPayment: deps.requestPayment, assertActive, owner, storage: deps.storage(), crypto: deps.crypto,
      central: central!, transfer, query: () => deps.query?.(), snapshot: async network => { const result = await deps.snapshot({ ownerPublicKeyHex: owner, network }, false); assertActive(); return result.status === "ok" ? result.value : { available: false, state: "unavailable", items: [] }; },
    });
    protocolStarting = run;
    try { const candidate = await run; try { assertActive(); } catch (error) { candidate.dispose(); throw error; } protocol = candidate; return candidate; }
    finally { if (protocolStarting === run) protocolStarting = undefined; }
  }
  return { ensure, ensureProtocol, release, protectedOutpoints: () => protocol?.protectedOutpoints };
}
