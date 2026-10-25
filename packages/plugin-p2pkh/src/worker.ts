import {
  defineBuiltinWorkerPlugin, STORAGE_FILE_CLIENTS_CAPABILITY, VAULT_WALLET_STATE_CAPABILITY,
  VAULT_WORKER_CRYPTO_CAPABILITY, WOC_CAPABILITY, WOC_WORKER_BROADCAST_CAPABILITY,
  P2PKH_WORKER_TRANSFER_CAPABILITY, P2PKH_WORKER_PROTOCOL_CAPABILITY, P2PKH_ASSET_READER_CAPABILITY,
  type BorrowedModuleFileStore, type VaultWalletState, type VaultWorkerCrypto, type WocService,
  type WocWorkerBroadcastService, type P2pkhProviderRegistry, type WorkerTaskRegistrar,
} from "@keymaster/contracts";
import { createP2pkhProviderRegistry, createP2pkhUtxoSnapshotStore, type P2pkhUtxoSnapshotStore } from "./coordinator.js";
import { createWorkerTransferRuntime, type WorkerTransferDependencies } from "./workerTransferRuntime.js";
import { createP2pkhWorkerAssetReader } from "./p2pkhWorkerAssetReader.js";
import { createP2pkhWorkerTaskDefinitions } from "./p2pkhWorkerTasks.js";
import { createP2pkhUtxoManager } from "./p2pkhUtxoManager.js";
import { readWorkerProtocolProtection } from "./workerProtocolRuntime.js";

interface InstanceBinding {
  storage: BorrowedModuleFileStore;
  walletState: VaultWalletState;
  crypto: VaultWorkerCrypto;
  assertActive(): void;
}

export interface P2pkhWorkerPorts {
  transfer: WorkerTransferDependencies;
  tasks: WorkerTaskRegistrar;
  registerProviders(registry: P2pkhProviderRegistry, broadcast: WocWorkerBroadcastService): void;
  snapshotSource(query: WocService): WocService;
  protectedOutpoints(owner: string, network: "main" | "test"): Promise<readonly { txid: string; vout: number }[]>;
  resetSettings(): void;
  refresh(signal: AbortSignal, storage: BorrowedModuleFileStore, assertActive: () => void): Promise<{ main?: number; test?: number }>;
  emit(kinds: import("@keymaster/contracts").AssetDataChangedEvent["kinds"], utxoSeqs?: { main?: number; test?: number }): void;
}

/** Provider、snapshot 和 borrowed handles 归 P2PKH，不由 Host 保存。 */
interface WorkerUtxoSeqEvent {
  /** 序号归属 owner（压缩公钥 hex，小写）。 */
  ownerPublicKeyHex: string;
  /** 网络：main=主网，test=测试网。 */
  network: "main" | "test";
  /** 最新快照序号。 */
  seq: number;
}
export function createP2pkhWorkerRuntime(ports: P2pkhWorkerPorts) {
  const workerUtxoSeqListeners = new Set<(event: WorkerUtxoSeqEvent) => void>();
  function subscribeWorkerUtxoSeq(listener: (event: WorkerUtxoSeqEvent) => void): () => void {
    workerUtxoSeqListeners.add(listener);
    return () => workerUtxoSeqListeners.delete(listener);
  }
  function publishWorkerUtxoSeq(event: WorkerUtxoSeqEvent): void {
    for (const listener of [...workerUtxoSeqListeners]) {
      try {
        listener(event);
      } catch {
        // 观察者失败不能影响快照提交。
      }
    }
  }
  let registry: P2pkhProviderRegistry | undefined;
  let snapshots: P2pkhUtxoSnapshotStore | undefined;
  let binding: InstanceBinding | undefined;
  let query: WocService | undefined;
  const transfer = createWorkerTransferRuntime(ports.transfer);
  function initialize(source: WocService, broadcast: WocWorkerBroadcastService) {
    registry = createP2pkhProviderRegistry();
    ports.registerProviders(registry, broadcast);
    const own = binding;
    if (!own) throw new Error("Manager projection requires an active P2PKH binding");
    const assertActive = () => { own.assertActive(); if (binding !== own) throw new Error("P2PKH manager projection revoked"); };
    const manager = createP2pkhUtxoManager({ files: own.storage, async listProtectedOutpoints(owner, network) {
      assertActive();
      const persisted = await readWorkerProtocolProtection(own.storage, owner, network);
      const business = await ports.protectedOutpoints(owner, network);
      assertActive();
      const registry = transfer.protectedOutpoints()?.list({ publicKeyHex: owner, network }) ?? [];
      return [...persisted, ...business, ...registry];
    } });
    snapshots = createP2pkhUtxoSnapshotStore({ woc: ports.snapshotSource(source), manager, assertActive });
  }
  const plugin = defineBuiltinWorkerPlugin("p2pkh", [P2PKH_WORKER_TRANSFER_CAPABILITY, P2PKH_WORKER_PROTOCOL_CAPABILITY, P2PKH_ASSET_READER_CAPABILITY], async context => {
    const own: InstanceBinding = {
      storage: context.capability(STORAGE_FILE_CLIENTS_CAPABILITY).bind(context.consumer, context.scope, ""),
      walletState: context.capability(VAULT_WALLET_STATE_CAPABILITY).bind(context.consumer, context.scope),
      crypto: context.capability(VAULT_WORKER_CRYPTO_CAPABILITY), assertActive: () => context.scope.assertActive(),
    };
    binding = own;
    query = context.capability(WOC_CAPABILITY);
    initialize(query, context.capability(WOC_WORKER_BROADCAST_CAPABILITY));
    const ownedRegistry = registry;
    const ownedSnapshots = snapshots;
    let released: ReturnType<typeof transfer.release> | undefined;
    context.scope.onRevoke(() => {
      if (binding !== own) return;
      binding = undefined;
      released = transfer.release();
      if (registry === ownedRegistry) registry = undefined;
      if (snapshots === ownedSnapshots) { snapshots?.clearAll(); snapshots = undefined; }
      query = undefined;
      ports.resetSettings();
    });
    context.onDispose(async () => { await Promise.allSettled([released?.starting, released?.protocolStarting]); });
    context.provide(P2PKH_WORKER_TRANSFER_CAPABILITY, Object.freeze({
      async getService() {
        context.scope.assertActive();
        const service = await transfer.ensure();
        context.scope.assertActive();
        return Object.freeze({
          getGlobalSettings: () => { context.scope.assertActive(); return structuredClone(service.getGlobalSettings()); },
          async prepareTransfer(input: Parameters<typeof service.prepareTransfer>[0]) { context.scope.assertActive(); const result = await service.prepareTransfer(input); context.scope.assertActive(); return result; },
          async submitTransfer(preview: unknown) { context.scope.assertActive(); const result = await service.submitTransfer(preview as Parameters<typeof service.submitTransfer>[0]); context.scope.assertActive(); return result; },
        });
      },
    }));
    context.provide(P2PKH_WORKER_PROTOCOL_CAPABILITY, Object.freeze({
      async getService() { context.scope.assertActive(); const service = await transfer.ensureProtocol(); context.scope.assertActive(); return service; },
    }));
    const network = () => {
      const identity = own.walletState.snapshot().activeKeyIdentity;
      if (!identity) throw new Error("P2PKH network identity unavailable");
      return identity.bsvNetwork;
    };
    context.provide(P2PKH_ASSET_READER_CAPABILITY, createP2pkhWorkerAssetReader({ walletState: own.walletState, storage: own.storage, snapshots: () => ownedSnapshots, bsvNetwork: network }));
    const definitions = createP2pkhWorkerTaskDefinitions({
      walletState: own.walletState, woc: query, storage: own.storage,
      isNetworkEnabled: candidate => candidate === network(), loadSettings: ports.transfer.loadSettings,
      refreshUtxos: signal => ports.refresh(signal, own.storage, own.assertActive), emitDataChanged: ports.emit,
    });
    for (const task of definitions) {
      const registration = await ports.tasks.register(task, own.assertActive);
      context.scope.onRevoke(registration.revoke);
      context.onDispose(registration.dispose);
    }
  });
  return {
    subscribeUtxoSeq: subscribeWorkerUtxoSeq, publishUtxoSeq: publishWorkerUtxoSeq, plugin, transfer, initialize, registry: () => registry, snapshots: () => snapshots, binding: () => binding, query: () => query,
    reset() { transfer.release(); registry = undefined; snapshots?.clearAll(); snapshots = undefined; binding = undefined; query = undefined; },
  };
}

export { createP2pkhWorkerOperations } from "./workerOperations.js";
