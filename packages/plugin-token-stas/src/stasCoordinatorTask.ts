import type { AssetDataNotifier, KeyspaceService, KeyValueStore, VaultService, WocStasService } from "@keymaster/contracts";
import { createStasRepository } from "./storage/stasRepository.js";
import { createStasService } from "./stasService.js";
import { createStasSyncTask } from "./stasSync.js";

export function createStasCoordinatorTask(input: { keyspace: KeyspaceService; store: KeyValueStore; p2pkh: Parameters<typeof createStasService>[0]["p2pkh"]; woc: WocStasService; vault: VaultService; notifier?: AssetDataNotifier }) {
  const service = createStasService({ keyspace: input.keyspace, p2pkh: input.p2pkh, wocStas: input.woc });
  return createStasSyncTask({ stateRepository: createStasRepository(input.store), service, keyspace: input.keyspace, vault: input.vault, assetDataNotifier: input.notifier });
}
