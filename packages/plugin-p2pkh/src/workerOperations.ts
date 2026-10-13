import { defineWorkerRequestRoute } from "@keymaster/contracts";
import type {
  BorrowedModuleFileStore, CoordinatorClientRequest, CoordinatorResponse, P2pkhUtxoSnapshotResult,
  P2pkhTransactionBroadcastProvider, VaultWalletState,
} from "@keymaster/contracts";
import type { createP2pkhWorkerRuntime } from "./worker.js";
import { executeWorkerP2pkhSnapshot, readWorkerP2pkhResource } from "./workerSnapshotExecutor.js";
import { executeWorkerP2pkhBroadcast } from "./workerBroadcastExecutor.js";
import { ensureWorkerP2pkhResources, refreshWorkerP2pkhResources } from "./p2pkhWorkerResources.js";
import { readWorkerProtocolProtection } from "./workerProtocolRuntime.js";
import { createP2pkhStateRepository, openP2pkhStateRepository } from "./storage/p2pkhStateRepository.js";

type Input = { ownerPublicKeyHex: string; network: "main" | "test" };
type BroadcastRequest = Extract<CoordinatorClientRequest, { kind: "p2pkh.broadcast" }>;
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
    reconcile(input: Input, snapshot: P2pkhUtxoSnapshotResult): Promise<void>;
    filter(input: Input, snapshot: P2pkhUtxoSnapshotResult): Promise<P2pkhUtxoSnapshotResult>;
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
      afterRefresh: (network, snapshot) => ports.funding.reconcile({ ownerPublicKeyHex: owner, network }, snapshot),
    }, signal);
  }
  async function protocolProtection(input: Input) {
    const captured = capture(input.ownerPublicKeyHex);
    captured.assertFresh();
    const rows = await readWorkerProtocolProtection(ports.storage(), input.ownerPublicKeyHex, input.network);
    captured.assertFresh();
    return [...rows, ...(ports.domain.transfer.protectedOutpoints()?.list({ publicKeyHex: input.ownerPublicKeyHex, network: input.network }) ?? [])];
  }
  async function snapshot(requestId: string, input: Input, refreshSnapshot: boolean): Promise<CoordinatorResponse> {
    if (!ports.available()) return ports.blocked(requestId);
    const captured = capture(input.ownerPublicKeyHex);
    captured.assertFresh();
    const storage = ports.storage();
    if (refreshSnapshot) await ensureWorkerP2pkhResources(storage, input.ownerPublicKeyHex, ports.network());
    return executeWorkerP2pkhSnapshot(requestId, input, refreshSnapshot, {
      storage, snapshots: captured.snapshots, epoch, assertFresh: captured.assertFresh,
      reconcile: ports.funding.reconcile,
      async filter(input, result) {
        const filtered = await ports.funding.filter(input, result);
        const protectedRows = await protocolProtection(input);
        const keys = new Set(protectedRows.map(row => `${row.txid}:${row.vout}`));
        return { ...filtered, items: filtered.items.filter(row => !keys.has(`${row.txid}:${row.vout}`)) };
      }, publish: ports.changed,
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
  async function broadcast(requestId: string, request: BroadcastRequest): Promise<CoordinatorResponse> {
    if (!ports.available()) return ports.blocked(requestId);
    return ports.broadcastLease(async () => {
      try {
        const captured = capture(request.ownerPublicKeyHex);
        return await executeWorkerP2pkhBroadcast(requestId, request, {
          assertFresh: captured.assertFresh, snapshots: captured.snapshots,
          provider: ports.provider() ?? ports.domain.registry()?.getBroadcastProvider("woc", request.network),
          walletState: ports.walletState, storage: ports.storage, sessionEpoch: epoch,
          resource, listProtectedOutpoints: ports.funding.protected, listProtocolProtectedOutpoints: protocolProtection,
          abortNotDispatched, refresh, publishChanged: ports.changed,
        });
      } catch (error) {
        return { requestId, sessionEpoch: epoch(), ack: { status: "error", message: `P2PKH broadcast failed: ${error instanceof Error ? error.message : String(error)}` } };
      }
    });
  }
  const route = defineWorkerRequestRoute<Extract<CoordinatorClientRequest, { kind: "p2pkh.utxos.get" | "p2pkh.utxos.refresh" | "p2pkh.broadcast" }>>({
    kinds: ["p2pkh.utxos.get", "p2pkh.utxos.refresh", "p2pkh.broadcast"],
    policy: () => ({ scheduling: "serial", validateEpoch: true }),
    execute: (request, call) => request.kind === "p2pkh.broadcast" ? broadcast(call.requestId, request) : snapshot(call.requestId, request, request.kind === "p2pkh.utxos.refresh"),
    async stale(request, call) {
      if (request.kind !== "p2pkh.broadcast") return undefined;
      await abortNotDispatched(request, "stale-session-epoch");
      return { requestId: call.requestId, sessionEpoch: epoch(), ack: { status: "ok" }, operationResult: { status: "not-dispatched", reason: "stale-session-epoch" } };
    },
  });
  return { route, ensureResources, resource, refresh, protocolProtection, snapshot, broadcast, abortNotDispatched };
}
