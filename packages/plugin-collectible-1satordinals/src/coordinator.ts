import type { AssetDataNotifier, KeyspaceService, VaultService, Woc1SatOrdinalsService } from "@keymaster/contracts";
import { createOrdinalsService, type P2pkhServiceFor1Sat } from "./ordinalsService.js";
import { createOrdinalsSyncTask } from "./ordinalsSync.js";

export function createOrdinalsCoordinatorTask(input: {
  keyspace: KeyspaceService;
  p2pkh: P2pkhServiceFor1Sat;
  woc: Woc1SatOrdinalsService;
  vault: VaultService;
  notifier?: AssetDataNotifier;
}) {
  const service = createOrdinalsService({ keyspace: input.keyspace, p2pkh: input.p2pkh, wocOneSat: input.woc });
  return createOrdinalsSyncTask({
    service,
    keyspace: input.keyspace,
    vault: input.vault,
    assetDataNotifier: input.notifier
  });
}
