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
  PluginStorageDeclaration,
} from "@keymaster/contracts";
import type { CoordinatorOwnerStorageData, CoordinatorPlatformStorageData, StorageBindingAuthority, StorageBindingCoordinatorClient, StorageOwnerGrant, StoragePlatformGrant } from "@keymaster/contracts/storage-internal";

function unwrap<T>(result: CoordinatorValueResult<unknown>, operation: string): T {
  if (result.status === "ok") return result.value as T;
  const message = "message" in result ? result.message : `${operation} failed: ${result.status}`;
  const error = new Error(message) as Error & { code?: string };
  if ("code" in result && typeof result.code === "string") error.code = result.code;
  throw error;
}

function assertKey(key: string): void {
  if (typeof key !== "string" || key.length === 0 || key.includes("\\") || key.includes("\u0000") || key.split("/").some((part) => !part || part === "." || part === ".." || part === ".keymaster")) throw new Error("K-V key is invalid");
}

function assertGrantDeclaration(grant: Pick<StorageOwnerGrant | StoragePlatformGrant, "moduleId" | "purposeId" | "authority" | "model" | "schemaVersion">, declaration: PluginStorageDeclaration): void {
  if (grant.moduleId !== declaration.moduleId
    || grant.purposeId !== declaration.purposeId
    || grant.authority !== declaration.authority
    || grant.model !== declaration.model
    || grant.schemaVersion !== declaration.schemaVersion) {
    throw new Error("Storage grant declaration does not match the requested central declaration");
  }
}

function assertPlatformGrantBinding(grant: StoragePlatformGrant, declaration: PluginStorageDeclaration): void {
  assertGrantDeclaration(grant, declaration);
  if (typeof grant.bucketId !== "string" || grant.bucketId.length === 0
    || !Number.isSafeInteger(grant.bucketGeneration) || grant.bucketGeneration < 0) {
    throw new Error("Platform storage grant binding is invalid");
  }
}

export interface StorageBindingAuthorityOptions {
}

/** 将 Coordinator 内部 RPC 封装成 Host 使用的存储绑定权威。 */
export function createStorageBindingAuthority(
  client: StorageBindingCoordinatorClient & { getActivePublicKeyHex(): string | undefined },
  options: StorageBindingAuthorityOptions = {}
): StorageBindingAuthority {
  async function openOwnerAppStore(input: { pluginId: string; declaration: PluginStorageDeclaration }): Promise<KeyValueStore> {
    if (input.declaration.scope !== "owner" || input.declaration.model !== "kv") throw new Error("Owner storage must use owner K-V scope");
    const grant = unwrap<StorageOwnerGrant>(await client.storageBindOwner(input), "owner storage bind");
    assertGrantDeclaration(grant, input.declaration);
    const active = client.getActivePublicKeyHex()?.toLowerCase();
    if (!active || active !== grant.ownerPublicKeyHex) throw new Error("Owner storage owner changed");
    let closed = false;
    const assertOpen = () => { if (closed) throw new Error("Storage handle is closed"); };
    const call = async <T>(data: CoordinatorOwnerStorageData): Promise<T> => {
      return unwrap<T>(await client.storageOwnerData(data), "owner storage");
    };
    return {
      bucketId: grant.bucketId,
      bucketGeneration: grant.bucketGeneration,
      ownerPublicKeyHex: grant.ownerPublicKeyHex,
      moduleId: grant.moduleId,
      purposeId: grant.purposeId,
      scope: "owner",
      authority: grant.authority,
      model: "kv",
      schemaVersion: grant.schemaVersion,
      async get<T = KeyValueValue>(key: string, options: { partition?: string } = {}) { assertOpen(); assertKey(key); return call<KeyValueEntry<T> | undefined>({ type: "owner.get", storageGrantId: grant.storageGrantId, key, partition: options.partition }); },
      async list(input: KeyValueListInput = {}) { assertOpen(); return call<KeyValueListResult>({ type: "owner.list", storageGrantId: grant.storageGrantId, input }); },
      async put<T = KeyValueValue>(key: string, value: T, condition = {}) { assertOpen(); assertKey(key); return call<KeyValueEntryMeta>({ type: "owner.put", storageGrantId: grant.storageGrantId, key, value, condition }); },
      async delete(key: string, condition = {}) { assertOpen(); assertKey(key); await call<void>({ type: "owner.delete", storageGrantId: grant.storageGrantId, key, condition }); },
      async commit(input: KeyValueCommitInput) { assertOpen(); return call<KeyValueCommitResult>({ type: "owner.commit", storageGrantId: grant.storageGrantId, ...input }); },
      close() { closed = true; }
    };
  }

  async function openOwnerFileStore(input: { pluginId: string; declaration: PluginStorageDeclaration }): Promise<import("@keymaster/contracts").OwnerFileStore> {
    if (input.declaration.scope !== "owner" || input.declaration.model !== "files") throw new Error("Owner file storage must use owner files scope");
    const grant = unwrap<StorageOwnerGrant>(await client.storageBindOwner(input), "owner file storage bind");
    assertGrantDeclaration(grant, input.declaration);
    const active = client.getActivePublicKeyHex()?.toLowerCase();
    if (!active || active !== grant.ownerPublicKeyHex) throw new Error("Owner storage owner changed");
    let closed = false;
    const assertOpen = () => { if (closed) throw new Error("Storage handle is closed"); };
    const call = async <T>(data: CoordinatorOwnerStorageData): Promise<T> => {
      return unwrap<T>(await client.storageOwnerData(data), "owner file storage");
    };
    return {
      async list(fileInput = {}) {
        assertOpen();
        return call<import("@keymaster/contracts").OwnerFileListPage>({ type: "owner.file-list", storageGrantId: grant.storageGrantId, input: fileInput });
      },
      async get(path) {
        assertOpen();
        return call<import("@keymaster/contracts").OwnerFileObject | undefined>({ type: "owner.file-get", storageGrantId: grant.storageGrantId, path });
      },
      async put(path, bytes, condition = {}) {
        assertOpen();
        return call<{ etag?: string; lastModified?: string }>({
          type: "owner.file-put",
          storageGrantId: grant.storageGrantId,
          path,
          bytes,
          ...(condition.ifNoneMatch === undefined ? {} : { ifNoneMatch: true }),
          ...(condition.ifMatch === undefined ? {} : { ifMatch: condition.ifMatch }),
        });
      },
      async delete(path, deleteInput = {}) {
        assertOpen();
        await call<void>({
          type: "owner.file-delete",
          storageGrantId: grant.storageGrantId,
          path,
          ...(deleteInput.ifMatch === undefined ? {} : { ifMatch: deleteInput.ifMatch }),
        });
      },
    };
  }

  async function openPlatformStore(input: { pluginId: string; declaration: PluginStorageDeclaration }): Promise<KeyValueStore> {
    if (input.declaration.scope !== "bucket" || input.declaration.authority === "third-party-app" || input.declaration.model !== "kv") throw new Error("Platform storage declaration is invalid");
    let currentGrant: StoragePlatformGrant | undefined;
    let grantPromise: Promise<StoragePlatformGrant> | undefined;
    const bind = async (): Promise<StoragePlatformGrant> => {
      if (!grantPromise) {
        grantPromise = client.storageBindPlatform({
          pluginId: input.pluginId,
          declaration: input.declaration
        }).then((result) => unwrap<StoragePlatformGrant>(result, "platform storage bind")).then((nextGrant) => {
          assertPlatformGrantBinding(nextGrant, input.declaration);
          currentGrant = nextGrant;
          return nextGrant;
        }).catch((error) => {
          grantPromise = undefined;
          throw error;
        });
      }
      return grantPromise;
    };
    const invalidate = (expected: StoragePlatformGrant): void => {
      // 只让仍指向本次请求的旧 grant 失效；并发请求若已经完成重新绑定，
      // 不能把新 grant 一起清掉。
      if (currentGrant !== expected) return;
      currentGrant = undefined;
      grantPromise = undefined;
    };
    const getGrant = async (): Promise<StoragePlatformGrant> => currentGrant ?? bind();
    const isPreIoGrantValidationFailure = (error: unknown): boolean => {
      const message = error instanceof Error ? error.message : String(error);
      // Coordinator 在打开物理 store 之前完成这两个检查，因此重绑后
      // 只重放一次授权请求，不重放已经越过最终 I/O 边界的写入。
      return message === "Platform storage grant is invalid"
        || message === "Platform storage bucket generation changed";
    };
    const initialGrant = await getGrant();
    assertPlatformGrantBinding(initialGrant, input.declaration);
    let closed = false;
    const assertOpen = () => { if (closed) throw new Error("Storage handle is closed"); };
    const call = async <T>(data: CoordinatorPlatformStorageData): Promise<T> => unwrap<T>(await client.storagePlatformData(data), "platform storage");
    const request = async <T>(build: (platformGrantId: string) => CoordinatorPlatformStorageData): Promise<T> => {
      assertOpen();
      const grant = await getGrant();
      try {
        return await call<T>(build(grant.platformGrantId));
      } catch (error) {
        if (closed || !isPreIoGrantValidationFailure(error)) throw error;
        invalidate(grant);
        const rebound = await getGrant();
        assertPlatformGrantBinding(rebound, input.declaration);
        return call<T>(build(rebound.platformGrantId));
      }
    };
    return {
      get bucketId() { return (currentGrant ?? initialGrant).bucketId; },
      get bucketGeneration() { return (currentGrant ?? initialGrant).bucketGeneration; },
      moduleId: initialGrant.moduleId,
      purposeId: initialGrant.purposeId,
      scope: "bucket",
      authority: initialGrant.authority,
      model: "kv",
      schemaVersion: initialGrant.schemaVersion,
      async get<T = KeyValueValue>(key: string, options: { partition?: string } = {}) { assertOpen(); assertKey(key); return request<KeyValueEntry<T> | undefined>((platformGrantId) => ({ type: "platform.get", platformGrantId, key, partition: options.partition })); },
      async list(listInput: KeyValueListInput = {}) { assertOpen(); return request<KeyValueListResult>((platformGrantId) => ({ type: "platform.list", platformGrantId, input: listInput })); },
      async put<T = KeyValueValue>(key: string, value: T, condition = {}) { assertOpen(); assertKey(key); return request<KeyValueEntryMeta>((platformGrantId) => ({ type: "platform.put", platformGrantId, key, value, condition })); },
      async delete(key: string, condition = {}) { assertOpen(); await request<void>((platformGrantId) => ({ type: "platform.delete", platformGrantId, key, condition })); },
      async commit(commitInput: KeyValueCommitInput) { assertOpen(); return request<KeyValueCommitResult>((platformGrantId) => ({ type: "platform.commit", platformGrantId, ...commitInput })); },
      close() { closed = true; }
    };
  }

  return {
    getActivePublicKeyHex: () => client.getActivePublicKeyHex(),
    openOwnerAppStore,
    openOwnerFileStore,
    openPlatformStore,
    async deleteOwnerStorage(input) { unwrap<void>(await client.storageDeleteOwner(input.ownerPublicKeyHex), "delete owner storage"); }
  };
}
