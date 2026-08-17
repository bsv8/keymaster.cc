import type { KeyspaceService, MessageBus, P2pkhProviderRegistry } from "@keymaster/contracts";
import { createP2pkhTransactionSync } from "./p2pkhTransactionSync.js";
import { createP2pkhDb, openP2pkhDb } from "./p2pkhDb.js";

export function createP2pkhCoordinatorTasks(input: {
  keyspace: KeyspaceService;
  registry: P2pkhProviderRegistry;
  getSelection: (network: "main" | "test") => { syncProviderId: string | null; generation: number };
  isGenerationCurrent?: (network: "main" | "test", generation: number) => boolean;
  isNetworkEnabled?: (network: "main" | "test") => boolean;
  messageBus?: MessageBus;
}) {
  const getDb = async () => createP2pkhDb(await openP2pkhDb({ keyspace: input.keyspace, publicKeyHex: input.keyspace.requireActiveKey().publicKeyHex }));
  const sync = createP2pkhTransactionSync({
    getDb,
    getResources: async () => (await getDb()).listResourcesByKey().then((resources) => resources.filter((resource) => input.isNetworkEnabled?.(resource.network) ?? true)),
    registry: input.registry,
    getSelection: input.getSelection,
    isGenerationCurrent: input.isGenerationCurrent,
    isNetworkEnabled: input.isNetworkEnabled
  });
  return {
    id: "p2pkh.transactions-sync" as const,
    transactionsSync: (signal: AbortSignal) => sync.runOnce(signal),
    run: (signal: AbortSignal) => sync.runOnce(signal)
  };
}
