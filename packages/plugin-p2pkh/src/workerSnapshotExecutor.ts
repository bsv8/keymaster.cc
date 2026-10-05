import type { BorrowedModuleFileStore, CoordinatorResponse, P2pkhUtxoSnapshotResult, AssetDataChangedEvent } from "@keymaster/contracts";
import { createP2pkhStateRepository, openP2pkhStateRepository } from "./storage/p2pkhStateRepository.js";
import type { P2pkhUtxoSnapshotStore } from "./p2pkhUtxoSnapshot.js";

type SnapshotInput = { ownerPublicKeyHex: string; network: "main" | "test" };
export async function readWorkerP2pkhResource(storage: BorrowedModuleFileStore, input: SnapshotInput) {
  const repository = createP2pkhStateRepository(await openP2pkhStateRepository(storage));
  return repository.getResource(`p2pkh:${input.network}`);
}
interface SnapshotPorts {
  storage: BorrowedModuleFileStore;
  snapshots?: P2pkhUtxoSnapshotStore;
  assertFresh(): void;
  epoch(): string;
  reconcile(input: SnapshotInput, snapshot: P2pkhUtxoSnapshotResult): Promise<void>;
  filter(input: SnapshotInput, snapshot: P2pkhUtxoSnapshotResult): Promise<P2pkhUtxoSnapshotResult>;
  publish(event: Omit<AssetDataChangedEvent, "topic" | "assetDataRevision" | "sessionEpoch">): void;
}
/** P2PKH owns snapshot lookup and refresh; each await remains tied to one store/session. */
export async function executeWorkerP2pkhSnapshot(requestId: string, input: SnapshotInput, refresh: boolean, ports: SnapshotPorts): Promise<CoordinatorResponse> {
  ports.assertFresh();
  const resource = await readWorkerP2pkhResource(ports.storage, input);
  ports.assertFresh();
  const snapshots = ports.snapshots;
  if (!resource || !snapshots) return { requestId, sessionEpoch: ports.epoch(), ack: { status: "ok" }, operationResult: { available: false, state: "unavailable", items: [] } satisfies P2pkhUtxoSnapshotResult };
  try {
    if (refresh) { await snapshots.reconcileConsumed(resource); ports.assertFresh(); }
    const snapshot = refresh ? await snapshots.refresh(resource) : snapshots.get(resource);
    ports.assertFresh();
    if (refresh) { await ports.reconcile(input, snapshot); ports.assertFresh(); }
    const result = await ports.filter(input, snapshot);
    ports.assertFresh();
    if (refresh) ports.publish({ type: "asset.data-changed", providerId: "p2pkh", publicKeyHex: input.ownerPublicKeyHex, kinds: ["utxo", "balance"], ...(result.seq === undefined ? {} : { utxoSeqs: { [input.network]: result.seq } }) });
    return { requestId, sessionEpoch: ports.epoch(), ack: { status: "ok" }, operationResult: result };
  } catch (error) {
    // Provider failure retains the old snapshot; callers must not spend from an unrefreshed result.
    const message = error instanceof Error ? error.message : String(error);
    return { requestId, sessionEpoch: ports.epoch(), ack: { status: "error", message: `P2PKH UTXO snapshot ${refresh ? "refresh" : "read"} failed: ${message}` } };
  }
}
