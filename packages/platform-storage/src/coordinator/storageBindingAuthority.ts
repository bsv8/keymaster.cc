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
  PluginStorageDeclaration
} from "@keymaster/contracts";
import type { CoordinatorOwnerStorageData, CoordinatorPlatformStorageData, StorageBindingAuthority, StorageBindingCoordinatorClient, StorageOwnerGrant } from "@keymaster/contracts/storage-internal";

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

/** 将 Coordinator 内部 RPC 封装成 Host 使用的存储绑定权威。 */
export function createStorageBindingAuthority(client: StorageBindingCoordinatorClient & { getActivePublicKeyHex(): string | undefined }): StorageBindingAuthority {
  async function openOwnerAppStore(input: { pluginId: string; declaration: PluginStorageDeclaration }): Promise<KeyValueStore> {
    if (input.declaration.scope !== "key") throw new Error("Owner storage must use key scope");
    const grant = unwrap<StorageOwnerGrant>(await client.storageBindOwner(input), "owner storage bind");
    const active = client.getActivePublicKeyHex()?.toLowerCase();
    if (!active || active !== grant.ownerPublicKeyHex) throw new Error("Owner storage owner changed");
    let closed = false;
    const assertOpen = () => { if (closed) throw new Error("Storage handle is closed"); };
    const call = async <T>(data: CoordinatorOwnerStorageData): Promise<T> => unwrap<T>(await client.storageOwnerData(data), "owner storage");
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
    const grant = unwrap<import("@keymaster/contracts/storage-internal").StoragePlatformGrant>(await client.storageBindPlatform({
      pluginId: input.pluginId,
      declaration: { scope: "platform", applicationStorageId: input.applicationStorageId, schemaVersion: input.schemaVersion }
    }), "platform storage bind");
    let closed = false;
    const assertOpen = () => { if (closed) throw new Error("Storage handle is closed"); };
    const call = async <T>(data: CoordinatorPlatformStorageData): Promise<T> => unwrap<T>(await client.storagePlatformData(data), "platform storage");
    return {
      bucketId: "coordinator",
      bucketGeneration: 0,
      ownerPublicKeyHex: "",
      applicationStorageId: grant.applicationStorageId,
      async get<T = KeyValueValue>(key: string, options: { partition?: string } = {}) { assertOpen(); assertKey(key); return call<KeyValueEntry<T> | undefined>({ type: "platform.get", platformGrantId: grant.platformGrantId, key, partition: options.partition }); },
      async list(listInput: KeyValueListInput = {}) { assertOpen(); return call<KeyValueListResult>({ type: "platform.list", platformGrantId: grant.platformGrantId, input: listInput }); },
      async put<T = KeyValueValue>(key: string, value: T, condition = {}) { assertOpen(); assertKey(key); return call<KeyValueEntryMeta>({ type: "platform.put", platformGrantId: grant.platformGrantId, key, value, condition }); },
      async delete(key: string, condition = {}) { assertOpen(); assertKey(key); await call<void>({ type: "platform.delete", platformGrantId: grant.platformGrantId, key, condition }); },
      async commit(commitInput: KeyValueCommitInput) { assertOpen(); return call<KeyValueCommitResult>({ type: "platform.commit", platformGrantId: grant.platformGrantId, ...commitInput }); },
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
