import type { HandlerCallContext } from "webloom-framework";
import type { CoordinatorOwnerStorageResult } from "@keymaster/contracts";
import type { CoordinatorOwnerStorageData } from "@keymaster/contracts/storage-internal";
export interface StorageRpcHandlerDependencies {
  authorize(call: HandlerCallContext): string;
  unavailable(message: string): Error;
  owner(data: CoordinatorOwnerStorageData, clientId: string, signal: AbortSignal): Promise<unknown>;
}
export function createStorageRpcHandlers(deps: StorageRpcHandlerDependencies) {
  async function owner(request: CoordinatorOwnerStorageData, call: HandlerCallContext): Promise<CoordinatorOwnerStorageResult> {
    const clientId = deps.authorize(call);
    if (call.signal.aborted) throw deps.unavailable("Owner storage request was cancelled");
    const value = await deps.owner(request, clientId, call.signal);
    if (call.signal.aborted) throw deps.unavailable("Owner storage request was cancelled");
    return value as CoordinatorOwnerStorageResult;
  }
  return { owner };
}
