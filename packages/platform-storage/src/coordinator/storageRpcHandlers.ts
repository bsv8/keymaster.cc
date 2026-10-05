import type { HandlerCallContext } from "webloom-framework";
import type { CoordinatorOwnerStorageResult, CoordinatorPlatformStorageResult } from "@keymaster/contracts";
import type { CoordinatorOwnerStorageData, CoordinatorPlatformStorageData } from "@keymaster/contracts/storage-internal";
export interface StorageRpcHandlerDependencies {
  authorize(call: HandlerCallContext): string;
  unavailable(message: string): Error;
  owner(data: CoordinatorOwnerStorageData, clientId: string, signal: AbortSignal): Promise<unknown>;
  platform(data: CoordinatorPlatformStorageData, clientId: string, signal: AbortSignal): Promise<unknown>;
}
export function createStorageRpcHandlers(deps: StorageRpcHandlerDependencies) {
  async function owner(request: CoordinatorOwnerStorageData, call: HandlerCallContext): Promise<CoordinatorOwnerStorageResult> {
    const clientId = deps.authorize(call);
    if (call.signal.aborted) throw deps.unavailable("Owner storage request was cancelled");
    const value = await deps.owner(request, clientId, call.signal);
    if (call.signal.aborted) throw deps.unavailable("Owner storage request was cancelled");
    return value as CoordinatorOwnerStorageResult;
  }
  async function platform(request: CoordinatorPlatformStorageData, call: HandlerCallContext): Promise<CoordinatorPlatformStorageResult> {
    const clientId = deps.authorize(call);
    if (call.signal.aborted) throw deps.unavailable("Platform storage request was cancelled");
    const value = await deps.platform(request, clientId, call.signal);
    if (call.signal.aborted) throw deps.unavailable("Platform storage request was cancelled");
    return value as CoordinatorPlatformStorageResult;
  }
  return { owner, platform };
}
