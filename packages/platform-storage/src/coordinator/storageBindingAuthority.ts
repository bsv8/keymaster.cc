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
  StorageBindingAuthority,
  StorageBindingCoordinatorClient,
  StorageOwnerGrant,
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
    // AbortSignal 是本地控制对象，不属于可序列化 RPC DTO。
    const call = async <T>(data: CoordinatorOwnerStorageData, signal?: AbortSignal): Promise<T> => unwrap<T>(await client.storageOwnerData(data, [], signal), "module file storage");
    return {
      get walletGeneration() { return grant.walletGeneration; },
      get sessionEpoch() { return grant.sessionEpoch; },
      get runGeneration() { return grant.runGeneration; },
      async list(listInput = {}): Promise<ModuleFileListPage> {
        assertOpen();
        const { signal, ...input } = listInput;
        return call<ModuleFileListPage>({ type: "owner.file-list", storageGrantId: grant.storageGrantId, input }, signal);
      },
      async get(path: string, getInput = {}): Promise<ModuleFileObject | undefined> {
        assertOpen();
        return call<ModuleFileObject | undefined>({
          type: "owner.file-get",
          storageGrantId: grant.storageGrantId,
          path,
          ...(getInput.ifRevision === undefined ? {} : { ifRevision: getInput.ifRevision }),
        }, getInput.signal);
      },
      async getRange(path, range, rangeInput = {}): Promise<ModuleFileObject | undefined> {
        assertOpen();
        return call<ModuleFileObject | undefined>({
          type: "owner.file-range",
          storageGrantId: grant.storageGrantId,
          path,
          range,
          ...(rangeInput.ifRevision === undefined ? {} : { ifRevision: rangeInput.ifRevision }),
        }, rangeInput.signal);
      },
      async put(path: string, bytes: Uint8Array, writeInput: StorageWriteCondition & { contentType?: string; signal?: AbortSignal } = {}): Promise<ModuleFileWriteResult> {
        assertOpen();
        const result = await call<ModuleFileWriteResult>({
          type: "owner.file-put",
          storageGrantId: grant.storageGrantId,
          path,
          bytes,
          ...(writeInput.ifRevision === undefined ? {} : { ifRevision: writeInput.ifRevision }),
          ...(writeInput.ifNoneMatch === undefined ? {} : { ifNoneMatch: true }),
          ...(writeInput.contentType === undefined ? {} : { contentType: writeInput.contentType }),
        }, writeInput.signal);
        return { revision: result.revision, lastModified: result.lastModified };
      },
      async delete(path: string, deleteInput = {}): Promise<void> {
        assertOpen();
        await call<void>({
          type: "owner.file-delete",
          storageGrantId: grant.storageGrantId,
          path,
          ...(deleteInput.ifRevision === undefined ? {} : { ifRevision: deleteInput.ifRevision }),
        }, deleteInput.signal);
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
        }, batchOptions.signal);
      },
      close() { closed = true; },
    };
  }

  return {
    getActivePublicKeyHex: () => options.getActivePublicKeyHex?.(),
    getWalletGeneration: () => options.getWalletGeneration?.(),
    openOwnerAppStore,
    openOwnerFileStore,
    async clearStorageRoot(input: { declaration: PluginStorageDeclaration; appStorageName?: string }) {
      unwrap<void>(await client.storageClearRoot(input), "clear storage root");
    },
  };
}
