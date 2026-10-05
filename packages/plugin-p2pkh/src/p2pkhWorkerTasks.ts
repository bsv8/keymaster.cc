import type { AssetDataInvalidationEvent, BackgroundTaskDefinition, BorrowedModuleFileStore, VaultWalletState, WocService } from "@keymaster/contracts";
import { createP2pkhCoordinatorTasks } from "./p2pkhCoordinatorTasks.js";
export interface P2pkhWorkerTaskDependencies {
  walletState: VaultWalletState;
  woc: WocService;
  storage: BorrowedModuleFileStore;
  isNetworkEnabled(network: "main" | "test"): boolean;
  loadSettings(ownerPublicKeyHex?: string): Promise<void>;
  refreshUtxos(signal: AbortSignal): Promise<{ main?: number; test?: number }>;
  emitDataChanged(kinds: AssetDataInvalidationEvent["kinds"], seqs?: { main?: number; test?: number }): void;
}
export type P2pkhWorkerTaskDefinition = BackgroundTaskDefinition & { syncPolicy: "managed" | "smart" };
/** P2PKH owns the task definitions and domain execution. The coordinator owns
 * scheduling, physical completion accounting and the final I/O lease.
 */
export function createP2pkhWorkerTaskDefinitions(deps: P2pkhWorkerTaskDependencies): readonly P2pkhWorkerTaskDefinition[] {
  const history = createP2pkhCoordinatorTasks(deps);
  const keyScope = () => {
    const publicKeyHex = deps.walletState.snapshot().activePublicKeyHex;
    return publicKeyHex ? { publicKeyHex } : undefined;
  };
  return [
    {
      id: "p2pkh.transactions-sync", pluginId: "p2pkh", unitId: history.unitId, syncPolicy: "managed", keyScope,
      label: { key: "p2pkh.task.transactions.label", fallback: "P2PKH confirmed transactions" },
      async run({ signal, assertSessionFresh }) {
        await deps.loadSettings(deps.walletState.snapshot().activePublicKeyHex);
        const result = await history.transactionsSync(signal);
        assertSessionFresh?.();
        if (!result.cancelled) deps.emitDataChanged(["resource", "history", "submission", "balance"]);
      },
    },
    {
      id: "p2pkh.utxo-snapshot", pluginId: "p2pkh", unitId: history.unitId, syncPolicy: "smart", keyScope,
      label: { key: "p2pkh.task.utxo.label", fallback: "P2PKH UTXO snapshot" },
      async run({ signal, assertSessionFresh }) {
        await deps.loadSettings(deps.walletState.snapshot().activePublicKeyHex);
        const seqs = await deps.refreshUtxos(signal);
        assertSessionFresh?.();
        deps.emitDataChanged(["utxo", "balance"], seqs);
      },
    },
  ];
}
