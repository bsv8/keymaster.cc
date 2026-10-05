import type { AssetDataNotifier, BorrowedKeyValueStore, VaultWalletState, VaultService, WocStasService } from "@keymaster/contracts";
import { createStasRepository } from "./storage/stasRepository.js";
import { createStasService } from "./stasService.js";
import { createStasSyncTask } from "./stasSync.js";

export function createStasCoordinatorTask(input: { walletState: VaultWalletState; stateStore: BorrowedKeyValueStore; p2pkh: Parameters<typeof createStasService>[0]["p2pkh"]; woc: WocStasService; vault: Pick<VaultService, "status">; notifier?: AssetDataNotifier }) {
  const service = createStasService({ walletState: input.walletState, p2pkh: input.p2pkh, wocStas: input.woc });
  return {
    ...createStasSyncTask({ stateRepository: createStasRepository(input.stateStore), service, walletState: input.walletState, vault: input.vault, assetDataNotifier: input.notifier }),
    unitId: "token-stas.coordinator-worker",
  };
}
