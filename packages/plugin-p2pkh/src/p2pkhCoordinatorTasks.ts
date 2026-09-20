import type { BorrowedOwnerFileStore, KeyspaceService, WocService } from "@keymaster/contracts";
import type { MessageBus } from "webloom-framework";
import { createP2pkhTransactionSync } from "./p2pkhTransactionSync.js";
import { createP2pkhStateRepository, openP2pkhStateRepository } from "./storage/p2pkhStateRepository.js";

/**
 * Coordinator 的 P2PKH 历史同步任务。
 *
 * 只有一个数据源：WocService。任务只同步历史元数据；UTXO 快照刷新由
 * Worker 在同一个 run 里显式调用（见 Worker 装配），失败互不影响。
 */
export function createP2pkhCoordinatorTasks(input: {
  keyspace: KeyspaceService;
  storage: BorrowedOwnerFileStore;
  woc: WocService;
  isNetworkEnabled?: (network: "main" | "test") => boolean;
  messageBus?: MessageBus;
}) {
  const getStore = async () => createP2pkhStateRepository(await openP2pkhStateRepository(input.storage));
  const sync = createP2pkhTransactionSync({
    getStore,
    getResources: async () => (await getStore()).listResourcesByKey().then((resources) => resources.filter((resource) => input.isNetworkEnabled?.(resource.network) ?? true)),
    woc: input.woc,
    isNetworkEnabled: input.isNetworkEnabled
  });
  return {
    id: "p2pkh.transactions-sync" as const,
    unitId: "p2pkh.coordinator-worker",
    transactionsSync: (signal: AbortSignal) => sync.runOnce(signal),
    run: (signal: AbortSignal) => sync.runOnce(signal)
  };
}
