import type { KeyspaceService, MessageBus, WocService } from "@keymaster/contracts";
import { createP2pkhHistoryBackfill } from "./p2pkhHistoryBackfill.js";
import { createP2pkhRecentSync } from "./p2pkhRecentSync.js";
import { createP2pkhDb, openP2pkhDb } from "./p2pkhDb.js";
import { createP2pkhSyncCoordinator } from "./p2pkhSyncCoordinator.js";

export function createP2pkhCoordinatorTasks(input: { keyspace: KeyspaceService; woc: WocService; messageBus: MessageBus; assertSessionFresh?: (kind: "recent" | "backfill") => void }) {
  const getDb = async () => createP2pkhDb(await openP2pkhDb({ keyspace: input.keyspace, publicKeyHex: input.keyspace.requireActiveKey().publicKeyHex }));
  const getResources = async () => (await getDb()).listResourcesByKey();
  const coordinator = createP2pkhSyncCoordinator({ getDb });
  const recent = createP2pkhRecentSync({ woc: input.woc, messageBus: input.messageBus, coordinator, getResources, getDb, assertSessionFresh: () => input.assertSessionFresh?.("recent") });
  const backfill = createP2pkhHistoryBackfill({ woc: input.woc, messageBus: input.messageBus, coordinator, getResources, getDb, assertSessionFresh: () => input.assertSessionFresh?.("backfill") });
  return {
    recent: (signal: AbortSignal) => recent.runOnce(signal),
    backfill: (signal: AbortSignal) => backfill.runOnce(signal)
  };
}
