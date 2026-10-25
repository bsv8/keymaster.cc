import type { BorrowedModuleFileStore, P2pkhUtxoSnapshotResult } from "@keymaster/contracts";
import { publicKeyHexToP2pkhAddress } from "./p2pkhSigner.js";
import { createP2pkhStateRepository, openP2pkhStateRepository } from "./storage/p2pkhStateRepository.js";
import type { P2pkhUtxoSnapshotStore, P2pkhUtxoSnapshotResource } from "./p2pkhUtxoSnapshot.js";
export async function ensureWorkerP2pkhResources(storage: BorrowedModuleFileStore, ownerPublicKeyHex: string, bsvNetwork: "main" | "test"): Promise<P2pkhUtxoSnapshotResource[]> {
  const repository = createP2pkhStateRepository(await openP2pkhStateRepository(storage));
  const existing = await repository.listResourcesByKey();
  const networks: Array<"main" | "test"> = bsvNetwork === "test" ? ["test"] : ["main"];
  const createdAt = new Date().toISOString();
  for (const network of networks) {
    const resourceId = `p2pkh:${network}`;
    if (existing.some((resource) => resource.resourceId === resourceId)) continue;
    const address = publicKeyHexToP2pkhAddress(ownerPublicKeyHex, network);
    const resource = {
      resourceId,
      publicKeyHex: ownerPublicKeyHex,
      label: "",
      address,
      network,
      createdAt,
      generation: 0,
    };
    await repository.putAddress(resource);
    existing.push(resource);
  }
  return existing;
}


export interface P2pkhWorkerRefreshDependencies {
  storage: BorrowedModuleFileStore;
  ownerPublicKeyHex: string;
  bsvNetwork: "main" | "test";
  snapshots: P2pkhUtxoSnapshotStore;
  assertFresh(): void;
  afterRefresh?(network: "main" | "test", result: P2pkhUtxoSnapshotResult): Promise<void>;
}
/** Refresh a captured domain store, never a replacement introduced during awaited I/O. */
export async function refreshWorkerP2pkhResources(deps: P2pkhWorkerRefreshDependencies, signal?: AbortSignal): Promise<{ main?: number; test?: number }> {
  deps.assertFresh();
  const bsvNetwork = deps.bsvNetwork;
  const resources = await ensureWorkerP2pkhResources(deps.storage, deps.ownerPublicKeyHex, bsvNetwork);
  deps.assertFresh();
  const utxoSeqs: { main?: number; test?: number } = {};
  for (const resource of resources) {
    if (resource.network === "test" && !bsvNetwork) continue;
    if (signal?.aborted) return utxoSeqs;
    // Refresh ingests provider facts into the manager; it never releases
    // signed/unknown responsibilities based on elapsed time or missing txids.
    deps.assertFresh();
    const result = await deps.snapshots.refresh(resource, signal ? { signal } : {}).catch(() => undefined);
    deps.assertFresh();
    if (result?.seq !== undefined) utxoSeqs[resource.network] = result.seq;
  }
  deps.assertFresh();
  return utxoSeqs;
}

