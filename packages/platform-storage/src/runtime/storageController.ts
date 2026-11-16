import type { StorageRuntimeController, StorageRuntimeControllerStatus, StorageRuntimeSummary } from "@keymaster/contracts";

/** 只管理钱包本地介质状态，不为外部应用提供文件操作。 */
export interface StorageRuntimeControllerDeps {
  summary(): Promise<Omit<StorageRuntimeSummary, "status" | "medium" | "persistence">>;
  abortSession(sessionId: string): Promise<void>;
  persistence(): Promise<{ persisted: boolean; usageBytes?: number; quotaBytes?: number }>;
  status(): StorageRuntimeControllerStatus;
}

export async function createStorageRuntimeController(deps: StorageRuntimeControllerDeps): Promise<StorageRuntimeController> {
  return {
    status: () => deps.status(),
    subscribe: () => () => {},
    async summary() {
      const [base, persistence] = await Promise.all([deps.summary(), deps.persistence()]);
      return { ...base, status: deps.status(), medium: "indexeddb", persistence };
    },
    abortSession: id => deps.abortSession(id),
  };
}
