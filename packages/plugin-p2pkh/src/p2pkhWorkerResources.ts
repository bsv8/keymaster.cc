import type { BorrowedModuleFileStore, P2pkhUtxoSnapshotResult } from "@keymaster/contracts";
import { publicKeyHexToP2pkhAddress } from "./p2pkhSigner.js";
import { createP2pkhStateRepository, openP2pkhStateRepository } from "./storage/p2pkhStateRepository.js";
import type { P2pkhUtxoSnapshotStore, P2pkhUtxoSnapshotResource } from "./p2pkhUtxoSnapshot.js";
export async function ensureWorkerP2pkhResources(storage: BorrowedModuleFileStore, ownerPublicKeyHex: string, includeTestnet: boolean): Promise<P2pkhUtxoSnapshotResource[]> {
  const repository = createP2pkhStateRepository(await openP2pkhStateRepository(storage));
  const existing = await repository.listResourcesByKey();
  const networks: Array<"main" | "test"> = includeTestnet ? ["main", "test"] : ["main"];
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
  includeTestnet: boolean;
  snapshots: P2pkhUtxoSnapshotStore;
  assertFresh(): void;
  afterRefresh?(network: "main" | "test", result: P2pkhUtxoSnapshotResult): Promise<void>;
}
/** Refresh a captured domain store, never a replacement introduced during awaited I/O. */
export async function refreshWorkerP2pkhResources(deps: P2pkhWorkerRefreshDependencies, signal?: AbortSignal): Promise<{ main?: number; test?: number }> {
  deps.assertFresh();
  const includeTestnet = deps.includeTestnet;
  const resources = await ensureWorkerP2pkhResources(deps.storage, deps.ownerPublicKeyHex, includeTestnet);
  deps.assertFresh();
  const utxoSeqs: { main?: number; test?: number } = {};
  for (const resource of resources) {
    if (resource.network === "test" && !includeTestnet) continue;
    if (signal?.aborted) return utxoSeqs;
    // consumed 快照不能仅凭“下一次 unspent 内容暂时没变”解封。
    // 先做一次交易级只读观察：只有消费交易超过阈值且 confirmed /
    // unconfirmed 都不存在时，才复用原序号恢复 fresh。
    deps.assertFresh();
    await deps.snapshots.reconcileConsumed(resource).catch(() => false);
    deps.assertFresh();
    const result = await deps.snapshots.refresh(resource, signal ? { signal } : {}).catch(() => undefined);
    deps.assertFresh();
    if (result) await deps.afterRefresh?.(resource.network, result);
    if (result?.seq !== undefined) utxoSeqs[resource.network] = result.seq;
  }
  deps.assertFresh();
  return utxoSeqs;
}

