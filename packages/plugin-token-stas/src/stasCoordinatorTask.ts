import type { AssetDataNotifier, KeyspaceService, VaultService, WocStasService } from "@keymaster/contracts";
import { createStasDb } from "./stasDb.js";
import { createStasService } from "./stasService.js";
import { createStasSyncTask } from "./stasSync.js";

export function createStasCoordinatorTask(input: { keyspace: KeyspaceService; p2pkh: Parameters<typeof createStasService>[0]["p2pkh"]; woc: WocStasService; vault: VaultService; notifier?: AssetDataNotifier }) {
  const service = createStasService({ keyspace: input.keyspace, p2pkh: input.p2pkh, wocStas: input.woc });
  return createStasSyncTask({ db: createStasDb(input.keyspace), service, keyspace: input.keyspace, vault: input.vault, assetDataNotifier: input.notifier });
}
