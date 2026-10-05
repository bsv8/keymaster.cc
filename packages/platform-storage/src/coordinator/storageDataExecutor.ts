import type { CoordinatorClientRequest, CoordinatorResponse, KeyValueStore, ModuleFileStore, StorageRuntimeController, OwnerAppStorageGrant, SessionEpoch } from "@keymaster/contracts";
import type { CoordinatorPlatformStorageData, CoordinatorOwnerStorageData, StorageOwnerGrant, StoragePlatformGrant } from "@keymaster/contracts/storage-internal";
import type { StoragePrivateRootStore } from "../storage-access/platform-root/platformRootStore.js";

/** Trusted worker assembly supplies authenticated grants and transition fences.
 * The executor owns physical Storage operations; callers cannot choose a root.
 */
export interface StorageDataExecutorDependencies<Binding> {
  root(): StoragePrivateRootStore | undefined;
  rootToken(): object | undefined;
  sessionEpoch(): SessionEpoch;
  assertStorageDataAvailable(): void;
  storageUnavailableError(message: string): Error;
  resolvePlatformStorageGrant(id: string, clientId: string): Promise<StoragePlatformGrant>;
  resolveOwnerStorageGrant(id: string, clientId: string): Promise<StorageOwnerGrant>;
  resolveStorageGrant(id: string, clientId: string): Promise<{ context: OwnerAppStorageGrant; connectSessionId: string }>;
  ensureStorageRuntime(clientId: string): Promise<StorageRuntimeController>;
  beginStorageBindingRequest(): () => void;
  currentCoordinatorStorageBinding(): Binding | undefined;
  assertStorageBindingLive(binding: Binding): void;
}

export function createStorageDataExecutor<Binding>(deps: StorageDataExecutorDependencies<Binding>) {
async function executePlatformStorageDataUnsafe(
  data: CoordinatorPlatformStorageData,
  actualClientId: string,
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted) throw deps.storageUnavailableError("Platform storage request was cancelled");
  deps.assertStorageDataAvailable();
  const root = deps.root();
  const rootToken = deps.rootToken();
  if (!root || !rootToken) throw new Error("Platform storage has not been bootstrapped");
  const grant = await deps.resolvePlatformStorageGrant(data.platformGrantId, actualClientId);
  const store = await root.openPlatformStore({ declaration: {
    moduleId: grant.moduleId,
    purposeId: grant.purposeId,
    authority: grant.authority,
    model: grant.model,
    schemaVersion: grant.schemaVersion,
  } });
  try {
    if (signal?.aborted) throw deps.storageUnavailableError("Platform storage request was cancelled");
    let value: unknown;
    switch (data.type) {
      case "platform.get": value = await store.get(data.key, { partition: data.partition }); break;
      case "platform.list": value = await store.list(data.input); break;
      case "platform.put": value = await store.put(data.key, data.value, data.condition); break;
      case "platform.delete": await store.delete(data.key, data.condition); value = undefined; break;
      case "platform.commit": value = await store.commit({ partition: data.partition, ifRevision: data.ifRevision, operations: data.operations }); break;
    }
    if (deps.root() !== root || deps.rootToken() !== rootToken) throw deps.storageUnavailableError("Platform storage binding became stale");
    deps.assertStorageDataAvailable();
    return value;
  } finally {
    store.close();
  }
}


async function executeOwnerStorageDataUnsafe(data: CoordinatorOwnerStorageData, actualClientId: string, signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) throw deps.storageUnavailableError("Owner storage request was cancelled");
  deps.assertStorageDataAvailable();
  const grant = await deps.resolveOwnerStorageGrant(data.storageGrantId, actualClientId);
  const expectedBinding = deps.currentCoordinatorStorageBinding();
  if (!expectedBinding) throw deps.storageUnavailableError("Owner storage binding is unavailable");
  const root = deps.root();
  if (!root) throw deps.storageUnavailableError("Platform storage has not been bootstrapped");
  const release = deps.beginStorageBindingRequest();
  let store: KeyValueStore | undefined;
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
        case "owner.file-list": fileValue = await files.list(data.input); break;
        case "owner.file-get": fileValue = await files.get(data.path); break;
        case "owner.file-range": fileValue = await files.getRange(data.path, data.range); break;
        case "owner.file-put": fileValue = await files.put(data.path, data.bytes, {
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
    store = await root.openKeyValueStore({
      declaration: {
        moduleId: grant.moduleId,
        purposeId: grant.purposeId,
        authority: grant.authority,
        model: grant.model,
        schemaVersion: grant.schemaVersion,
      },
    });
    if (signal?.aborted) throw deps.storageUnavailableError("Owner storage request was cancelled");
    let value: unknown;
    switch (data.type) {
      case "owner.get": value = await store.get(data.key, { partition: data.partition }); break;
      case "owner.list": value = await store.list(data.input); break;
      case "owner.put": value = await store.put(data.key, data.value, data.condition); break;
      case "owner.delete": await store.delete(data.key, data.condition); value = undefined; break;
      case "owner.commit": value = await store.commit({ partition: data.partition, ifRevision: data.ifRevision, operations: data.operations }); break;
    }
    if (signal?.aborted) throw deps.storageUnavailableError("Owner storage request was cancelled");
    deps.assertStorageBindingLive(expectedBinding);
    return value;
  } finally {
    store?.close();
    files?.close();
    release();
  }
}


async function executeStorageDataUnsafe(request: Extract<CoordinatorClientRequest, { kind: "storage.data" }>, controller: AbortController, actualClientId: string): Promise<CoordinatorResponse> {
  deps.assertStorageDataAvailable();
  const capturedSessionEpoch = deps.sessionEpoch();
  const service = await deps.ensureStorageRuntime(actualClientId);
  if (!("grantId" in request.data)) throw new Error("Storage grant is required for file operations");
  const data = request.data;
  const resolvedGrant = await deps.resolveStorageGrant(data.grantId, actualClientId);
  const ctx = resolvedGrant.context;
  const root = deps.root();
  if (!root) throw deps.storageUnavailableError("Platform storage root is unavailable");
  const expectedBinding = deps.currentCoordinatorStorageBinding();
  if (!expectedBinding) throw deps.storageUnavailableError("Storage binding is unavailable");
  const releaseBindingRequest = deps.beginStorageBindingRequest();
  try {
    const signal = controller.signal;
    let value: unknown;
    switch (data.type) {
      case "list": value = await service.list(ctx, { ...data.input, signal }); break;
      case "create-directory": value = await service.createDirectory(ctx, { ...data.input, signal }); break;
      case "delete-directory": value = await service.deleteDirectory(ctx, { ...data.input, signal }); break;
      case "put": value = await service.put(ctx, { ...data.input, signal }); break;
      case "get-range": value = await service.getRange(ctx, { ...data.input, signal }); break;
      case "delete": value = await service.delete(ctx, { ...data.input, signal }); break;
    }
    // 本地 IndexedDB 事务可能忽略 AbortSignal 并在锁定/换绑之后才 resolve。
    // 结果跨过会话或绑定栅栏时一律丢弃，不提交也不返回给页面。
    if (controller.signal.aborted || capturedSessionEpoch !== deps.sessionEpoch()) {
      const error = new Error("Storage request became stale during owner transition") as Error & { code?: string };
      error.code = "storage_unavailable";
      throw error;
    }
    deps.assertStorageBindingLive(expectedBinding);
    await deps.resolveStorageGrant(data.grantId, actualClientId);
    return { requestId: request.requestId, sessionEpoch: deps.sessionEpoch(), ack: { status: "ok" }, operationResult: value };
  } finally {
    releaseBindingRequest();
  }
}

return { executePlatformStorageDataUnsafe, executeOwnerStorageDataUnsafe, executeStorageDataUnsafe };
}
