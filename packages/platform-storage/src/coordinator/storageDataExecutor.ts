import type { ModuleFileStore, StorageRuntimeController, SessionEpoch } from "@keymaster/contracts";
import type { CoordinatorOwnerStorageData, StorageOwnerBinding } from "@keymaster/contracts/storage-internal";
import type { StoragePrivateRootStore } from "../storage-access/platform-root/platformRootStore.js";

/** Trusted assembly supplies plugin declarations and wallet transition fences.
 * The executor owns physical Storage operations; callers cannot choose a root.
 */
export interface StorageDataExecutorDependencies<Binding> {
  root(): StoragePrivateRootStore | undefined;
  rootToken(): object | undefined;
  sessionEpoch(): SessionEpoch;
  assertStorageDataAvailable(): void;
  storageUnavailableError(message: string): Error;
  resolveOwnerStorageBinding(binding: StorageOwnerBinding): import("@keymaster/contracts").PluginStorageDeclaration;
  beginStorageBindingRequest(): () => void;
  currentCoordinatorStorageBinding(): Binding | undefined;
  assertStorageBindingLive(binding: Binding): void;
}

export function createStorageDataExecutor<Binding>(deps: StorageDataExecutorDependencies<Binding>) {
async function executeOwnerStorageDataUnsafe(data: CoordinatorOwnerStorageData, actualClientId: string, signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) throw deps.storageUnavailableError("Owner storage request was cancelled");
  deps.assertStorageDataAvailable();
  const grant = deps.resolveOwnerStorageBinding(data.binding);
  const expectedBinding = deps.currentCoordinatorStorageBinding();
  if (!expectedBinding) throw deps.storageUnavailableError("Owner storage binding is unavailable");
  const root = deps.root();
  if (!root) throw deps.storageUnavailableError("Platform storage has not been bootstrapped");
  const release = deps.beginStorageBindingRequest();
  let files: ModuleFileStore | undefined;
  try {
    if (grant.model === "files") {
      files = await root.openModuleFileStore({
        declaration: {
          moduleId: grant.moduleId,
          purposeId: grant.purposeId,
          authority: grant.authority,
          model: grant.model,
          schemaVersion: grant.schemaVersion,
        },
      });
      let fileValue: unknown;
      switch (data.type) {
        case "owner.file-list": fileValue = await files.list({ ...data.input, signal }); break;
        case "owner.file-get": fileValue = await files.get(data.path, { ifRevision: data.ifRevision, signal }); break;
        case "owner.file-range": fileValue = await files.getRange(data.path, data.range, { ifRevision: data.ifRevision, signal }); break;
        case "owner.file-put": fileValue = await files.put(data.path, data.bytes, {
          contentType: data.contentType,
          ...(data.ifNoneMatch === undefined ? {} : { ifNoneMatch: true as const }),
          ...(data.ifRevision === undefined ? {} : { ifRevision: data.ifRevision }),
        }); break;
        case "owner.file-delete": await files.delete(data.path, data.ifRevision === undefined ? {} : { ifRevision: data.ifRevision }); fileValue = undefined; break;
        case "owner.file-batch": fileValue = await files.batch({
          operations: data.operations,
          ...(data.conditions
            ? {
                conditions: data.conditions.map((condition) => ({
                  path: condition.path,
                  ...(condition.ifRevision === undefined ? {} : { ifRevision: condition.ifRevision }),
                  ...(condition.ifNoneMatch === undefined ? {} : { ifNoneMatch: true as const }),
                })),
              }
            : {}),
        }); break;
        default: throw new Error("Owner file storage request is invalid");
      }
      if (signal?.aborted) throw deps.storageUnavailableError("Owner storage request was cancelled");
      deps.assertStorageBindingLive(expectedBinding);
      return fileValue;
    }
    throw new Error("Only file storage requests are supported");
  } finally {
    files?.close();
    release();
  }
}


return { executeOwnerStorageDataUnsafe };
}
