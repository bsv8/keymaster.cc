import type { BorrowedModuleFileStore, VaultWalletState, P2pkhAssetReader } from "@keymaster/contracts";
import { createP2pkhStateRepository, openP2pkhStateRepository } from "./storage/p2pkhStateRepository.js";
import { p2pkhAddressToScriptHex } from "./p2pkhTransactionParser.js";
import type { createP2pkhUtxoSnapshotStore } from "./p2pkhUtxoSnapshot.js";
export interface P2pkhWorkerAssetReaderDependencies {
  walletState: VaultWalletState;
  storage: BorrowedModuleFileStore;
  snapshots(): ReturnType<typeof createP2pkhUtxoSnapshotStore> | undefined;
  includeTestnet(): boolean;
}
export function createP2pkhWorkerAssetReader(deps: P2pkhWorkerAssetReaderDependencies): P2pkhAssetReader {
  return {
    listResources: async (assetId: "bsv" | "bsvtest") => {
      if (!deps.walletState.snapshot().activePublicKeyHex) return [];
      const repository = createP2pkhStateRepository(await openP2pkhStateRepository(deps.storage));
      return (await repository.listResourcesByKey()).filter((resource) => assetId === (resource.network === "main" ? "bsv" : "bsvtest"));
    },
    listUtxos: async (filter?: { assetId?: "bsv" | "bsvtest"; ownerPublicKeyHex?: string }) => {
      const ownerPublicKeyHex = filter?.ownerPublicKeyHex ?? deps.walletState.snapshot().activePublicKeyHex;
      if (!ownerPublicKeyHex) return [];
      if (deps.walletState.snapshot().activePublicKeyHex?.toLowerCase() !== ownerPublicKeyHex.toLowerCase()) throw new Error("P2PKH storage owner is not active");
      const repository = createP2pkhStateRepository(await openP2pkhStateRepository(deps.storage));
      const rows: Array<{ id: string; resourceId: string; publicKeyHex: string; network: "main" | "test"; address: string; txid: string; vout: number; value: number; height: number; script: string; status: "confirmed" | "unconfirmed"; isSpentInMempoolTx: boolean; syncedAt: string }> = [];
      for (const resource of await repository.listResourcesByKey()) {
        if (filter?.assetId && resource.network !== (filter.assetId === "bsv" ? "main" : "test")) continue;
        const snapshot = deps.snapshots()?.get(resource);
        if (!snapshot?.available) continue;
        for (const item of snapshot.items) {
          if (item.isSpentInMempoolTx) continue;
          rows.push({
            id: `utxo:${resource.resourceId}:${item.txid}:${item.vout}`,
            resourceId: resource.resourceId,
            publicKeyHex: resource.publicKeyHex,
            network: resource.network,
            address: resource.address,
            txid: item.txid,
            vout: item.vout,
            value: item.value,
            height: item.height,
            script: p2pkhAddressToScriptHex(resource.address, resource.network),
            status: item.status,
            isSpentInMempoolTx: item.isSpentInMempoolTx,
            syncedAt: snapshot.syncedAt ?? new Date().toISOString()
          });
        }
      }
      return rows;
    },
    getGlobalSettings: () => ({ includeTestnet: deps.includeTestnet() })
  };
}
