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

export interface StorageBindingAuthorityOptions {
}

/** 将 Coordinator 内部 RPC 封装成 Host 使用的存储绑定权威。 */
export function createStorageBindingAuthority(
  client: StorageBindingCoordinatorClient & { getActivePublicKeyHex(): string | undefined },
  options: StorageBindingAuthorityOptions = {}
): StorageBindingAuthority {
  async function openOwnerAppStore(input: { pluginId: string; declaration: PluginStorageDeclaration }): Promise<KeyValueStore> {
    if (input.declaration.scope !== "key") throw new Error("Owner storage must use key scope");
    const grant = unwrap<StorageOwnerGrant>(await client.storageBindOwner(input), "owner storage bind");
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
      applicationStorageId: grant.applicationStorageId,
      async get<T = KeyValueValue>(key: string, options: { partition?: string } = {}) { assertOpen(); assertKey(key); return call<KeyValueEntry<T> | undefined>({ type: "owner.get", storageGrantId: grant.storageGrantId, key, partition: options.partition }); },
      async list(input: KeyValueListInput = {}) { assertOpen(); return call<KeyValueListResult>({ type: "owner.list", storageGrantId: grant.storageGrantId, input }); },
      async put<T = KeyValueValue>(key: string, value: T, condition = {}) { assertOpen(); assertKey(key); return call<KeyValueEntryMeta>({ type: "owner.put", storageGrantId: grant.storageGrantId, key, value, condition }); },
      async delete(key: string, condition = {}) { assertOpen(); assertKey(key); await call<void>({ type: "owner.delete", storageGrantId: grant.storageGrantId, key, condition }); },
      async commit(input: KeyValueCommitInput) { assertOpen(); return call<KeyValueCommitResult>({ type: "owner.commit", storageGrantId: grant.storageGrantId, ...input }); },
      close() { closed = true; }
    };
  }

  async function openPlatformStore(input: { pluginId: string; applicationStorageId: string; schemaVersion: number }): Promise<KeyValueStore> {
    if (!Number.isSafeInteger(input.schemaVersion) || input.schemaVersion < 1) throw new Error("Storage schema version is invalid");
    let currentGrant: StoragePlatformGrant | undefined;
    let grantPromise: Promise<StoragePlatformGrant> | undefined;
    const bind = async (): Promise<StoragePlatformGrant> => {
      if (!grantPromise) {
        grantPromise = client.storageBindPlatform({
          pluginId: input.pluginId,
          declaration: { scope: "platform", applicationStorageId: input.applicationStorageId, schemaVersion: input.schemaVersion }
        }).then((result) => unwrap<StoragePlatformGrant>(result, "platform storage bind")).then((nextGrant) => {
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
        return call<T>(build(rebound.platformGrantId));
      }
    };
    return {
      bucketId: "coordinator",
      bucketGeneration: 0,
      ownerPublicKeyHex: "",
      applicationStorageId: initialGrant.applicationStorageId,
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
    openPlatformStore,
    async deleteOwnerStorage(input) { unwrap<void>(await client.storageDeleteOwner(input.ownerPublicKeyHex), "delete owner storage"); }
  };
}
