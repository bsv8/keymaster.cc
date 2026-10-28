// Host 侧存储绑定权威。
//
// 它把 Coordinator 的受限 RPC 封装成 Host 注入插件的受限句柄。绑定在 Worker
// 侧负责实际 grant 状态和世代失效；Host 直接使用可信结果，不重复认证声明。
// 句柄只暴露领域方法与公开元数据；确定发生在提交前的 grant 失效才允许重绑。

import type {
  CoordinatorValueResult,
  KeyValueCommitInput,
  KeyValueCommitResult,
  KeyValueEntry,
  KeyValueEntryMeta,
  KeyValueListInput,
  KeyValueListResult,
  KeyValueStore,
  KeyValueValue,
  ModuleFileListPage,
  ModuleFileObject,
  ModuleFileStore,
  ModuleFileWriteResult,
  OwnerAppStore,
  PluginStorageDeclaration,
  StorageWriteCondition,
} from "@keymaster/contracts";
import type {
  CoordinatorOwnerStorageData,
  CoordinatorPlatformStorageData,
  StorageBindingAuthority,
  StorageBindingCoordinatorClient,
  StorageOwnerGrant,
  StoragePlatformGrant,
} from "@keymaster/contracts/storage-internal";

function unwrap<T>(result: CoordinatorValueResult<unknown>, operation: string): T {
  if (result.status === "ok") return result.value as T;
  const message = "message" in result && typeof result.message === "string" ? result.message : `${operation} failed`;
  const error = new Error(message) as Error & { code?: string };
  if ("code" in result && typeof result.code === "string") error.code = result.code;
  throw error;
}

export interface StorageBindingAuthorityOptions {
  /** Host 观察入口；原身份／会话的存活性由句柄绑定层和 Worker 控制。 */
  getActivePublicKeyHex?: () => string | undefined;
  /**
   * 当前钱包身份世代的权威来源。
   *
   * 必须由 Coordinator 侧的钱包状态提供：重置后即使重新导入同一私钥，
   * 世代也会改变，因此不能用公钥代替。
   */
  getWalletGeneration?: () => string | undefined;
}

/** 将 Coordinator 内部 RPC 封装成 Host 使用的存储绑定权威。 */
export function createStorageBindingAuthority(
  client: StorageBindingCoordinatorClient,
  options: StorageBindingAuthorityOptions = {},
): StorageBindingAuthority {
  async function openOwnerAppStore(input: { pluginId: string; declaration: PluginStorageDeclaration }): Promise<OwnerAppStore> {
    const declaration = input.declaration;
    const grant = unwrap<StorageOwnerGrant>(await client.storageBindOwner({ pluginId: input.pluginId, declaration }), "module storage bind");
    let closed = false;
    const assertOpen = (): void => { if (closed) throw new Error("Storage handle is closed"); };
    const call = async <T>(data: CoordinatorOwnerStorageData): Promise<T> => unwrap<T>(await client.storageOwnerData(data), "module storage");
    return {
      get walletGeneration() { return grant.walletGeneration; },
      get sessionEpoch() { return grant.sessionEpoch; },
      get runGeneration() { return grant.runGeneration; },
      moduleId: grant.moduleId,
      purposeId: grant.purposeId,
      authority: "built-in-module",
      model: "kv",
      schemaVersion: grant.schemaVersion,
      async get<T = KeyValueValue>(key: string, listInput: { partition?: string } = {}): Promise<KeyValueEntry<T> | undefined> {
        assertOpen();
        return call<KeyValueEntry<T> | undefined>({
          type: "owner.get",
          storageGrantId: grant.storageGrantId,
          key,
          ...(listInput.partition === undefined ? {} : { partition: listInput.partition }),
        });
      },
      async list(listInput: KeyValueListInput = {}): Promise<KeyValueListResult> {
        assertOpen();
        return call<KeyValueListResult>({ type: "owner.list", storageGrantId: grant.storageGrantId, input: listInput });
      },
      async put<T = KeyValueValue>(key: string, value: T, condition = {}): Promise<KeyValueEntryMeta> {
        assertOpen();
        return call<KeyValueEntryMeta>({ type: "owner.put", storageGrantId: grant.storageGrantId, key, value, condition });
      },
      async delete(key: string, condition = {}): Promise<void> {
        assertOpen();
        await call<void>({ type: "owner.delete", storageGrantId: grant.storageGrantId, key, condition });
      },
      async commit(commitInput: KeyValueCommitInput): Promise<KeyValueCommitResult> {
        assertOpen();
        return call<KeyValueCommitResult>({ type: "owner.commit", storageGrantId: grant.storageGrantId, ...commitInput });
      },
      close() { closed = true; },
    };
  }

  async function openOwnerFileStore(input: { pluginId: string; declaration: PluginStorageDeclaration }): Promise<ModuleFileStore> {
    const declaration = input.declaration;
    const grant = unwrap<StorageOwnerGrant>(await client.storageBindOwner({ pluginId: input.pluginId, declaration }), "module file storage bind");
    let closed = false;
    const assertOpen = (): void => { if (closed) throw new Error("Storage handle is closed"); };
    const call = async <T>(data: CoordinatorOwnerStorageData): Promise<T> => unwrap<T>(await client.storageOwnerData(data), "module file storage");
    return {
      get walletGeneration() { return grant.walletGeneration; },
      get sessionEpoch() { return grant.sessionEpoch; },
      get runGeneration() { return grant.runGeneration; },
      async list(listInput = {}): Promise<ModuleFileListPage> {
        assertOpen();
        return call<ModuleFileListPage>({ type: "owner.file-list", storageGrantId: grant.storageGrantId, input: listInput });
      },
      async get(path: string, getInput = {}): Promise<ModuleFileObject | undefined> {
        assertOpen();
        return call<ModuleFileObject | undefined>({
          type: "owner.file-get",
          storageGrantId: grant.storageGrantId,
          path,
          ...(getInput.ifRevision === undefined ? {} : { ifRevision: getInput.ifRevision }),
        });
      },
      async getRange(path, range, rangeInput = {}): Promise<ModuleFileObject | undefined> {
        assertOpen();
        return call<ModuleFileObject | undefined>({
          type: "owner.file-range",
          storageGrantId: grant.storageGrantId,
          path,
          range,
          ...(rangeInput.ifRevision === undefined ? {} : { ifRevision: rangeInput.ifRevision }),
        });
      },
      async put(path: string, bytes: Uint8Array, writeInput: StorageWriteCondition & { contentType?: string } = {}): Promise<ModuleFileWriteResult> {
        assertOpen();
        const result = await call<ModuleFileWriteResult>({
          type: "owner.file-put",
          storageGrantId: grant.storageGrantId,
          path,
          bytes,
          ...(writeInput.ifRevision === undefined ? {} : { ifRevision: writeInput.ifRevision }),
          ...(writeInput.ifNoneMatch === undefined ? {} : { ifNoneMatch: true }),
          ...(writeInput.contentType === undefined ? {} : { contentType: writeInput.contentType }),
        });
        return { revision: result.revision, lastModified: result.lastModified };
      },
      async delete(path: string, deleteInput = {}): Promise<void> {
        assertOpen();
        await call<void>({
          type: "owner.file-delete",
          storageGrantId: grant.storageGrantId,
          path,
          ...(deleteInput.ifRevision === undefined ? {} : { ifRevision: deleteInput.ifRevision }),
        });
      },
      async batch(batchInput, batchOptions = {}) {
        assertOpen();
        return call<{ paths: string[]; committedAt: string }>({
          type: "owner.file-batch",
          storageGrantId: grant.storageGrantId,
          operations: batchInput.operations.map((operation) => operation.type === "delete"
            ? { type: "delete" as const, path: operation.path }
            : {
              type: "put" as const,
              path: operation.path,
              bytes: operation.bytes,
              ...(operation.contentType === undefined ? {} : { contentType: operation.contentType }),
            }),
          conditions: (batchInput.conditions ?? []).map((condition) => ({
            path: condition.path,
            ...(condition.ifRevision === undefined ? {} : { ifRevision: condition.ifRevision }),
            ...(condition.ifNoneMatch === undefined ? {} : { ifNoneMatch: condition.ifNoneMatch }),
          })),
        });
      },
      close() { closed = true; },
    };
  }

  async function openPlatformStore(input: { pluginId: string; declaration: PluginStorageDeclaration }): Promise<KeyValueStore> {
    const declaration = input.declaration;
    let currentGrant: StoragePlatformGrant | undefined;
    let grantPromise: Promise<StoragePlatformGrant> | undefined;

    const bind = async (): Promise<StoragePlatformGrant> => {
      grantPromise ??= client.storageBindPlatform({ pluginId: input.pluginId, declaration })
        .then((result) => unwrap<StoragePlatformGrant>(result, "platform storage bind"))
        .then((grant) => {
          currentGrant = grant;
          return grant;
        })
        .catch((error: unknown) => {
          grantPromise = undefined;
          throw error;
        });
      return grantPromise;
    };

    /**
     * 只让仍指向本次请求的旧 grant 失效。
     *
     * 并发的另一个请求可能已经完成重新绑定，如果无条件清空就会把新 grant 一起
     * 丢掉，句柄会反复重绑。
     */
    const invalidate = (expected: StoragePlatformGrant): void => {
      if (currentGrant !== expected) return;
      currentGrant = undefined;
      grantPromise = undefined;
    };

    const getGrant = async (): Promise<StoragePlatformGrant> => currentGrant ?? bind();
    const initialGrant = await getGrant();
    let closed = false;
    const assertOpen = (): void => { if (closed) throw new Error("Storage handle is closed"); };

    /**
     * Worker 在真正落盘前就会拒绝过期 grant。这类失败可以安全地重放一次：重放
     * 的仍然只是授权申请与同一条数据请求，不会在重新绑定后重复执行已经越过
     * 提交边界的写入。
     */
    const isPreCommitGrantFailure = (error: unknown): boolean => {
      const message = error instanceof Error ? error.message : String(error);
      return message === "Platform storage grant is invalid"
        || message === "Platform storage grant generation is stale"
        || message === "Storage session epoch changed";
    };

    const call = async <T>(data: CoordinatorPlatformStorageData): Promise<T> => unwrap<T>(await client.storagePlatformData(data), "platform storage");

    const request = async <T>(build: (platformGrantId: string) => CoordinatorPlatformStorageData): Promise<T> => {
      assertOpen();
      const grant = await getGrant();
      try {
        return await call<T>(build(grant.platformGrantId));
      } catch (error) {
        if (closed || !isPreCommitGrantFailure(error)) throw error;
        invalidate(grant);
        const rebound = await getGrant();
        return call<T>(build(rebound.platformGrantId));
      }
    };

    return {
      get walletGeneration() { return (currentGrant ?? initialGrant).walletGeneration; },
      get sessionEpoch() { return (currentGrant ?? initialGrant).sessionEpoch; },
      get runGeneration() { return (currentGrant ?? initialGrant).runGeneration; },
      moduleId: initialGrant.moduleId,
      purposeId: initialGrant.purposeId,
      authority: initialGrant.authority,
      model: "kv",
      schemaVersion: initialGrant.schemaVersion,
      async get<T = KeyValueValue>(key: string, getInput: { partition?: string } = {}): Promise<KeyValueEntry<T> | undefined> {
        assertOpen();
        return request<KeyValueEntry<T> | undefined>((platformGrantId) => ({
          type: "platform.get",
          platformGrantId,
          key,
          ...(getInput.partition === undefined ? {} : { partition: getInput.partition }),
        }));
      },
      async list(listInput: KeyValueListInput = {}): Promise<KeyValueListResult> {
        assertOpen();
        return request<KeyValueListResult>((platformGrantId) => ({ type: "platform.list", platformGrantId, input: listInput }));
      },
      async put<T = KeyValueValue>(key: string, value: T, condition = {}): Promise<KeyValueEntryMeta> {
        assertOpen();
        return request<KeyValueEntryMeta>((platformGrantId) => ({ type: "platform.put", platformGrantId, key, value, condition }));
      },
      async delete(key: string, condition = {}): Promise<void> {
        assertOpen();
        await request<void>((platformGrantId) => ({ type: "platform.delete", platformGrantId, key, condition }));
      },
      async commit(commitInput: KeyValueCommitInput): Promise<KeyValueCommitResult> {
        assertOpen();
        return request<KeyValueCommitResult>((platformGrantId) => ({ type: "platform.commit", platformGrantId, ...commitInput }));
      },
      close() { closed = true; },
    };
  }

  return {
    getActivePublicKeyHex: () => options.getActivePublicKeyHex?.(),
    getWalletGeneration: () => options.getWalletGeneration?.(),
    openOwnerAppStore,
    openOwnerFileStore,
    openPlatformStore,
    async clearStorageRoot(input: { declaration: PluginStorageDeclaration; appStorageName?: string }) {
      unwrap<void>(await client.storageClearRoot(input), "clear storage root");
    },
  };
}
