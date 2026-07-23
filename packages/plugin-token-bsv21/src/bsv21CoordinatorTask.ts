import type { AssetDataNotifier, KeyspaceService, VaultService, WocBsv21Service, WocService } from "@keymaster/contracts";
import { createBsv21Db } from "./bsv21Db.js";
import { createBsv21Service } from "./bsv21Service.js";
import { createBsv21SyncTask } from "./bsv21Sync.js";

export function createBsv21CoordinatorTask(input: { keyspace: KeyspaceService; p2pkh: Parameters<typeof createBsv21Service>[0]["p2pkh"]; woc: WocBsv21Service; wocService: WocService; vault: VaultService; notifier?: AssetDataNotifier }) {
  const service = createBsv21Service({ keyspace: input.keyspace, p2pkh: input.p2pkh, wocBsv21: input.woc });
  return createBsv21SyncTask({ db: createBsv21Db(input.keyspace), service, woc: input.wocService, keyspace: input.keyspace, vault: input.vault, assetDataNotifier: input.notifier });
}
