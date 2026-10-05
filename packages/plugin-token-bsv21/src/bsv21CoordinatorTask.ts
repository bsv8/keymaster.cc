import type { AssetDataNotifier, BorrowedKeyValueStore, VaultWalletState, VaultService, WocBsv21Service, WocService } from "@keymaster/contracts";
import { createBsv21StateRepository } from "./storage/bsv21StateRepository.js";
import { createBsv21Service } from "./bsv21Service.js";
import { createBsv21SyncTask } from "./bsv21Sync.js";

export function createBsv21CoordinatorTask(input: { walletState: VaultWalletState; stateStore: BorrowedKeyValueStore; p2pkh: Parameters<typeof createBsv21Service>[0]["p2pkh"]; woc: WocBsv21Service; wocService: WocService; vault: Pick<VaultService, "status">; notifier?: AssetDataNotifier }) {
  const service = createBsv21Service({ walletState: input.walletState, p2pkh: input.p2pkh, wocBsv21: input.woc });
  return {
    ...createBsv21SyncTask({ stateRepository: createBsv21StateRepository(input.stateStore), service, woc: input.wocService, walletState: input.walletState, vault: input.vault, assetDataNotifier: input.notifier }),
    unitId: "token-bsv21.coordinator-worker",
  };
}
