// Host 侧存储绑定权威。
//
// 它把 Coordinator 的受限 RPC 封装成 Host 注入插件的受限句柄。绑定在 Worker
// 侧已经完成世代校验；这里只做第二道防线：
//   - 申请时的中央声明必须与 Worker 返回的 grant 完全一致（坐标 + 模型 +
//     schema 版本），不接受调用方在往返途中改写；
//   - 句柄只暴露 K-V / 文件的领域方法，不暴露物理路径、bucket 或数据库；
//   - 授权被拒或不可用时丢弃缓存，重新申请，而不是继续用旧 grant。

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
  StorageObjectRevision,
  StorageWriteCondition,
} from "@keymaster/contracts";
import type {
  CoordinatorOwnerStorageData,
  CoordinatorPlatformStorageData,
  StorageBindingAuthority,
  StorageBindingCoordinatorClient,
  StorageOwnerGrant,
  StoragePlatformGrant,
  ThirdPartyAppStorageGrant,
} from "@keymaster/contracts/storage-internal";
import { deriveThirdPartyStorageModuleId } from "@keymaster/contracts";

function unwrap<T>(result: CoordinatorValueResult<unknown>, operation: string): T {
  if (result.status === "ok") return result.value as T;
  const message = "message" in result && typeof result.message === "string" ? result.message : `${operation} failed`;
  const error = new Error(message) as Error & { code?: string };
  if ("code" in result && typeof result.code === "string") error.code = result.code;
  throw error;
}

/** K-V 业务键不能是路径、不能含 NUL/反斜杠，也不能借用系统保留段。 */
function assertKey(key: string): void {
  if (typeof key !== "string" || key.length === 0
    || key.includes("\\") || key.includes("\u0000")
    || key.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("K-V key is invalid");
  }
}

function assertGrantDeclaration(
  grant: Pick<StorageOwnerGrant | StoragePlatformGrant | ThirdPartyAppStorageGrant, "authority" | "model" | "schemaVersion"> &
    Partial<Pick<StorageOwnerGrant | StoragePlatformGrant, "moduleId" | "purposeId">> &
    Partial<Pick<ThirdPartyAppStorageGrant, "verifiedAppIdentity">>,
  declaration: PluginStorageDeclaration,
): void {
  if (grant.authority !== declaration.authority
    || grant.model !== declaration.model
    || grant.schemaVersion !== declaration.schemaVersion) {
    throw new Error("Storage grant does not match the requested central declaration");
  }
  // 第三方 App 的坐标由验证身份派生，调用方不能自报 moduleId/purposeId。
  if (grant.authority === "third-party-app") {
    const identity = grant.verifiedAppIdentity;
    if (!identity || identity.publisherPublicKeyHex === undefined || identity.appId === undefined) {
      throw new Error("Third-party app grant is missing a verified identity");
    }
    if (deriveThirdPartyStorageModuleId(identity.publisherPublicKeyHex, identity.appId) !== declaration.moduleId) {
      throw new Error("Third-party app grant moduleId does not match the verified identity");
    }
    return;
  }
  if (grant.moduleId !== declaration.moduleId || grant.purposeId !== declaration.purposeId) {
    throw new Error("Storage grant does not match the requested central declaration");
  }
}

function assertGenerations(grant: { walletGeneration: string; runGeneration: string; sessionEpoch: string }): void {
  if (typeof grant.walletGeneration !== "string" || grant.walletGeneration.length === 0
    || typeof grant.runGeneration !== "string" || grant.runGeneration.length === 0
    || typeof grant.sessionEpoch !== "string" || grant.sessionEpoch.length === 0) {
    throw new Error("Storage grant generation binding is invalid");
  }
}

function parseRevision(value: StorageObjectRevision | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Storage revision is invalid");
  return parsed;
}

export interface StorageBindingAuthorityOptions {
  /** Host 侧观察到的当前钱包公钥；用于在打开句柄时核对身份未变。 */
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
    if (declaration.model !== "kv" || declaration.authority === "platform-only" || declaration.authority === "third-party-app") {
      throw new Error("Module K-V storage requires a built-in-module kv declaration");
    }
    const grant = unwrap<StorageOwnerGrant>(await client.storageBindOwner({ pluginId: input.pluginId, declaration }), "module storage bind");
    assertGrantDeclaration(grant, declaration);
    assertGenerations(grant);
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
        assertKey(key);
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
        assertKey(key);
        return call<KeyValueEntryMeta>({ type: "owner.put", storageGrantId: grant.storageGrantId, key, value, condition });
      },
      async delete(key: string, condition = {}): Promise<void> {
        assertOpen();
        assertKey(key);
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
    if (declaration.model !== "files" || declaration.authority === "platform-only" || declaration.authority === "third-party-app") {
      throw new Error("Module file storage requires a built-in-module files declaration");
    }
    const grant = unwrap<StorageOwnerGrant>(await client.storageBindOwner({ pluginId: input.pluginId, declaration }), "module file storage bind");
    assertGrantDeclaration(grant, declaration);
    assertGenerations(grant);
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
        return { revision: String(parseRevision(result.revision) ?? 0), lastModified: result.lastModified };
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
    if (declaration.model !== "kv" || declaration.authority === "third-party-app") {
      throw new Error("Platform storage declaration is invalid");
    }
    let currentGrant: StoragePlatformGrant | undefined;
    let grantPromise: Promise<StoragePlatformGrant> | undefined;

    const bind = async (): Promise<StoragePlatformGrant> => {
      grantPromise ??= client.storageBindPlatform({ pluginId: input.pluginId, declaration })
        .then((result) => unwrap<StoragePlatformGrant>(result, "platform storage bind"))
        .then((grant) => {
          assertGrantDeclaration(grant, declaration);
          assertGenerations(grant);
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
        assertKey(key);
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
        assertKey(key);
        return request<KeyValueEntryMeta>((platformGrantId) => ({ type: "platform.put", platformGrantId, key, value, condition }));
      },
      async delete(key: string, condition = {}): Promise<void> {
        assertOpen();
        assertKey(key);
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
