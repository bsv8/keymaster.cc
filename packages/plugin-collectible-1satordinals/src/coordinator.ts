import type { AssetDataNotifier, VaultWalletState, VaultService, Woc1SatOrdinalsService, WocService } from "@keymaster/contracts";
import { createOrdinalsService, type P2pkhServiceFor1Sat } from "./ordinalsService.js";
import { createOrdinalsSyncTask } from "./ordinalsSync.js";

export function createOrdinalsCoordinatorTask(input: {
  walletState: VaultWalletState;
  p2pkh: P2pkhServiceFor1Sat;
  woc: Woc1SatOrdinalsService;
  wocService: WocService;
  vault: Pick<VaultService, "status">;
  notifier?: AssetDataNotifier;
}) {
  const service = createOrdinalsService({ walletState: input.walletState, p2pkh: input.p2pkh, wocOneSat: input.woc });
  return {
    ...createOrdinalsSyncTask({
      service,
      woc: input.wocService,
      walletState: input.walletState,
      vault: input.vault,
      assetDataNotifier: input.notifier
    }),
    unitId: "collectible-1satordinals.coordinator-worker",
  };
}
