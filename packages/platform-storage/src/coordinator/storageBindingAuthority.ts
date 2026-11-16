// Host 侧存储绑定权威。
//
// 根据真实 consumer 的中央声明构造稳定访问接口。没有签发、缓存或续期会话许可；
// Worker 每次核对声明与钱包运行身份，实际业务 I/O 不自动重放。

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
  StorageOwnerBinding,
} from "@keymaster/contracts/storage-internal";

function unwrap<T>(result: CoordinatorValueResult<unknown>, operation: string): T {
  if (result.status === "ok") return result.value as T;
  const message = "message" in result && typeof result.message === "string" ? result.message : `${operation} failed`;
  const error = new Error(message) as Error & { code?: string };
  if ("code" in result && typeof result.code === "string") error.code = result.code;
  throw error;
}

export interface StorageBindingAuthorityOptions {
  getSessionEpoch?: () => string | undefined;
  /** Host 观察入口；原身份／会话的存活性由句柄绑定层和 Worker 控制。 */
  getActivePublicKeyHex?: () => string | undefined;
  /**
   * 当前钱包身份世代的权威来源。
   *
   * 必须由 Coordinator 侧的钱包状态提供：重置后即使重新导入同一私钥，
   * 世代也会改变，因此不能用公钥代替。
   */
  getWalletGeneration?: () => string | undefined;
  getRunGeneration?: () => string | undefined;
}

/** 将 Coordinator 内部 RPC 封装成 Host 使用的存储绑定权威。 */
export function createStorageBindingAuthority(
  client: StorageBindingCoordinatorClient,
  options: StorageBindingAuthorityOptions = {},
): StorageBindingAuthority {
  function binding(input: { pluginId: string; declaration: PluginStorageDeclaration }): Omit<StorageOwnerBinding, "sessionEpoch"> {
    const walletGeneration = options.getWalletGeneration?.();
    const runGeneration = options.getRunGeneration?.();
    if (!walletGeneration || !runGeneration) throw new Error("Wallet storage is not ready");
    if (input.declaration.moduleId !== input.pluginId || input.declaration.authority !== "built-in-module") throw new Error("Invalid internal storage declaration");
    if (input.declaration.model !== "kv" && input.declaration.model !== "files") throw new Error("Unsupported plugin storage model");
    return { ...input.declaration, model: input.declaration.model, authority: "built-in-module", walletGeneration, runGeneration };
  }
  function requestBinding(owner: Omit<StorageOwnerBinding, "sessionEpoch">): StorageOwnerBinding {
    const sessionEpoch = options.getSessionEpoch?.();
    if (!sessionEpoch) throw new Error("Wallet runtime is unavailable");
    return { ...owner, sessionEpoch };
  }
  async function openOwnerAppStore(input: { pluginId: string; declaration: PluginStorageDeclaration }): Promise<OwnerAppStore> {
    const owner = binding(input);
    let closed = false;
    const assertOpen = (): void => { if (closed) throw new Error("Storage handle is closed"); };
    const call = async <T>(data: CoordinatorOwnerStorageData): Promise<T> => unwrap<T>(await client.storageOwnerData(data), "module storage");
    return {
      get walletGeneration() { return owner.walletGeneration; },
      get runGeneration() { return owner.runGeneration; },
      moduleId: owner.moduleId,
      purposeId: owner.purposeId,
      authority: "built-in-module",
      model: "kv",
      schemaVersion: owner.schemaVersion,
      async get<T = KeyValueValue>(key: string, listInput: { partition?: string } = {}): Promise<KeyValueEntry<T> | undefined> {
        assertOpen();
        return call<KeyValueEntry<T> | undefined>({
          type: "owner.get",
          binding: requestBinding(owner),
          key,
          ...(listInput.partition === undefined ? {} : { partition: listInput.partition }),
        });
      },
      async list(listInput: KeyValueListInput = {}): Promise<KeyValueListResult> {
        assertOpen();
        return call<KeyValueListResult>({ type: "owner.list", binding: requestBinding(owner), input: listInput });
      },
      async put<T = KeyValueValue>(key: string, value: T, condition = {}): Promise<KeyValueEntryMeta> {
        assertOpen();
        return call<KeyValueEntryMeta>({ type: "owner.put", binding: requestBinding(owner), key, value, condition });
      },
      async delete(key: string, condition = {}): Promise<void> {
        assertOpen();
        await call<void>({ type: "owner.delete", binding: requestBinding(owner), key, condition });
      },
      async commit(commitInput: KeyValueCommitInput): Promise<KeyValueCommitResult> {
        assertOpen();
        return call<KeyValueCommitResult>({ type: "owner.commit", binding: requestBinding(owner), ...commitInput });
      },
      close() { closed = true; },
    };
  }

  async function openOwnerFileStore(input: { pluginId: string; declaration: PluginStorageDeclaration }): Promise<ModuleFileStore> {
    const owner = binding(input);
    let closed = false;
    const assertOpen = (): void => { if (closed) throw new Error("Storage handle is closed"); };
    // AbortSignal 是本地控制对象，不属于可序列化 RPC DTO。
    const call = async <T>(data: CoordinatorOwnerStorageData, signal?: AbortSignal): Promise<T> => unwrap<T>(await client.storageOwnerData(data, [], signal), "module file storage");
    return {
      get walletGeneration() { return owner.walletGeneration; },
      get runGeneration() { return owner.runGeneration; },
      async list(listInput = {}): Promise<ModuleFileListPage> {
        assertOpen();
        const { signal, ...input } = listInput;
        return call<ModuleFileListPage>({ type: "owner.file-list", binding: requestBinding(owner), input }, signal);
      },
      async get(path: string, getInput = {}): Promise<ModuleFileObject | undefined> {
        assertOpen();
        return call<ModuleFileObject | undefined>({
          type: "owner.file-get",
          binding: requestBinding(owner),
          path,
          ...(getInput.ifRevision === undefined ? {} : { ifRevision: getInput.ifRevision }),
        }, getInput.signal);
      },
      async getRange(path, range, rangeInput = {}): Promise<ModuleFileObject | undefined> {
        assertOpen();
        return call<ModuleFileObject | undefined>({
          type: "owner.file-range",
          binding: requestBinding(owner),
          path,
          range,
          ...(rangeInput.ifRevision === undefined ? {} : { ifRevision: rangeInput.ifRevision }),
        }, rangeInput.signal);
      },
      async put(path: string, bytes: Uint8Array, writeInput: StorageWriteCondition & { contentType?: string; signal?: AbortSignal } = {}): Promise<ModuleFileWriteResult> {
        assertOpen();
        const result = await call<ModuleFileWriteResult>({
          type: "owner.file-put",
          binding: requestBinding(owner),
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
          binding: requestBinding(owner),
          path,
          ...(deleteInput.ifRevision === undefined ? {} : { ifRevision: deleteInput.ifRevision }),
        }, deleteInput.signal);
      },
      async batch(batchInput, batchOptions = {}) {
        assertOpen();
        return call<{ paths: string[]; committedAt: string }>({
          type: "owner.file-batch",
          binding: requestBinding(owner),
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
    getRunGeneration: () => options.getRunGeneration?.(),
    openOwnerAppStore,
    openOwnerFileStore,
    async clearStorageRoot(input: { declaration: PluginStorageDeclaration; appStorageName?: string }) {
      unwrap<void>(await client.storageClearRoot(input), "clear storage root");
    },
  };
}
