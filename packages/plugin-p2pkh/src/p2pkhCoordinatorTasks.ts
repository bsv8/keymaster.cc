import type { KeyspaceService, KeyValueStore, P2pkhProviderRegistry } from "@keymaster/contracts";
import type { MessageBus } from "webloom-framework";
import { createP2pkhTransactionSync } from "./p2pkhTransactionSync.js";
import { createP2pkhStateRepository, openP2pkhStateRepository, P2PKH_REPOSITORY_VERSION, P2PKH_STORAGE_ID } from "./storage/p2pkhStateRepository.js";

export function createP2pkhCoordinatorTasks(input: {
  keyspace: KeyspaceService;
  storage: KeyValueStore;
  registry: P2pkhProviderRegistry;
  getSelection: (network: "main" | "test") => { syncProviderId: string | null; generation: number };
  isGenerationCurrent?: (network: "main" | "test", generation: number) => boolean;
  isNetworkEnabled?: (network: "main" | "test") => boolean;
  messageBus?: MessageBus;
}) {
  const getStore = async () => createP2pkhStateRepository(await openP2pkhStateRepository(input.storage));
  const sync = createP2pkhTransactionSync({
    getStore,
    getResources: async () => (await getStore()).listResourcesByKey().then((resources) => resources.filter((resource) => input.isNetworkEnabled?.(resource.network) ?? true)),
    registry: input.registry,
    getSelection: input.getSelection,
    isGenerationCurrent: input.isGenerationCurrent,
    isNetworkEnabled: input.isNetworkEnabled
  });
  return {
    id: "p2pkh.transactions-sync" as const,
    unitId: "p2pkh.coordinator-worker",
    transactionsSync: (signal: AbortSignal) => sync.runOnce(signal),
    run: (signal: AbortSignal) => sync.runOnce(signal)
  };
}
