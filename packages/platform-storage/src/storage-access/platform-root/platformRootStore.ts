import type {
  OwnerAppStore,
  OwnerFileStore,
  KeyValueStore,
  PlatformRootStore,
  PluginStorageDeclaration,
  SnapshotStore,
  StorageBucketProvider,
  StorageBucketRef,
  StorageNamespaceBinding,
  StorageSnapshotJsonCompatible,
} from "@keymaster/contracts";
import { buildStorageNamespaceRoot, validateOwnerPublicKeyHex, validatePluginStorageDeclaration, CENTRAL_STORAGE_DECLARATIONS, SYSTEM_STORAGE_DECLARATIONS } from "@keymaster/contracts";
import { createKeyValueStore } from "../../kv-engine/partitionedKvEngine.js";
import { StorageRuntimeError } from "../../runtime/storageError.js";
import { createOwnerAppStore } from "../owner-app/ownerAppStore.js";
import { createOwnerFileStore } from "../owner-app/ownerFileStore.js";
import { createFixedCasSnapshotStore } from "../../snapshot/fixedCasSnapshotStore.js";

export interface PlatformRootStoreOptions {
  /** 当前 Provider；只由 Coordinator 注入。 */
  provider: StorageBucketProvider;
  /** 当前抽象桶引用。 */
  bucket: StorageBucketRef;
  /** 只允许 Coordinator 预授权的 bucket 级中央声明（平台和内置模块）。 */
  platformStorageDeclarations?: readonly PluginStorageDeclaration[];
  /** 切桶/切 Key/切 keyspace 世代后让旧句柄 fail closed。 */
  isCurrent?: (binding: { ownerPublicKeyHex?: string; bucketGeneration: number; keyspaceGeneration?: number }) => boolean;
}

const DEFAULT_PLATFORM_DECLARATIONS: readonly PluginStorageDeclaration[] = Object.freeze([
  ...Object.values(CENTRAL_STORAGE_DECLARATIONS).filter((declaration) =>
    declaration.scope === "bucket"),
]);
const OWNER_DELETE_MAX_PASSES = 32;
const OWNER_DELETE_REQUIRED_EMPTY_PASSES = 2;
/** Local-storage capability DTO 的 limit 上限是 256；owner 清理按游标分页。 */
const OWNER_LIST_LIMIT = 256;

function isStorageConflict(error: unknown): boolean {
  return error instanceof StorageRuntimeError && error.code === "storage_conflict"
    || Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "storage_conflict");
}

async function listOwnerObjects(provider: StorageBucketProvider, ownerPublicKeyHex: string): Promise<Array<{ path: string; etag?: string }>> {
  const root = `${validateOwnerPublicKeyHex(ownerPublicKeyHex)}/`;
  const objects: Array<{ path: string; etag?: string }> = [];
  let cursor: string | undefined;
  do {
    const page = await provider.list({ prefix: root, cursor, limit: OWNER_LIST_LIMIT });
    objects.push(...page.objects.map((object) => ({ path: object.path, etag: object.etag })));
    cursor = page.nextCursor;
  } while (cursor);
  return objects;
}

async function deleteOwnerObjectsUntilEmpty(provider: StorageBucketProvider, ownerPublicKeyHex: string): Promise<boolean> {
  let emptyPasses = 0;
  for (let pass = 0; pass < OWNER_DELETE_MAX_PASSES; pass += 1) {
    const objects = await listOwnerObjects(provider, ownerPublicKeyHex);
    if (objects.length === 0) {
      emptyPasses += 1;
      if (emptyPasses >= OWNER_DELETE_REQUIRED_EMPTY_PASSES) return true;
      continue;
    }
    emptyPasses = 0;
    for (const object of objects) {
      try {
        await provider.delete(object.path, object.etag ? { ifMatch: object.etag } : undefined);
      } catch (error) {
        // 对象可能在列出后被另一个清理者删除或被迟到请求替换；下一轮
        // 重新列出并使用最新 ETag，不能因为一次 CAS 冲突中止清理。
        if (!isStorageConflict(error)) throw error;
      }
    }
  }
  throw new StorageRuntimeError("storage_unavailable", "Owner storage did not become empty before deletion timeout");
}

/**
 * Storage 平台层。
 *
 * 这里是唯一可以构造平台 bucket namespace 的入口；业务插件拿到的只能是
 * `openKeyValueStore()` 返回的 owner/App 受限句柄。
 */
export function createPlatformRootStore(options: PlatformRootStoreOptions): PlatformRootStore {
  if (options.provider.bucketId !== options.bucket.bucketId) throw new StorageRuntimeError("storage_forbidden", "Storage bucket binding mismatch");
  const platformDeclarations = new Map<string, PluginStorageDeclaration>(
    (options.platformStorageDeclarations ?? DEFAULT_PLATFORM_DECLARATIONS).map((candidate) => {
      const declaration = validatePluginStorageDeclaration(candidate);
      if (declaration.scope !== "bucket" || declaration.authority === "third-party-app") {
        throw new StorageRuntimeError("storage_forbidden", "Platform root accepts only authorized bucket declarations");
      }
      return [declarationKey(declaration), declaration] as const;
    }),
  );
  function declarationKey(declaration: PluginStorageDeclaration): string {
    return [
      declaration.moduleId,
      declaration.purposeId,
      declaration.scope,
      declaration.authority,
      declaration.model,
      declaration.schemaVersion,
    ].join("|");
  }
  const bindingFor = (declaration: PluginStorageDeclaration): StorageNamespaceBinding => Object.freeze({
    ...declaration,
    bucketId: options.bucket.bucketId,
    bucketGeneration: options.bucket.bucketGeneration,
  });
  const currentFor = (binding: StorageNamespaceBinding, keyspaceGeneration?: number): (() => boolean) => () => options.isCurrent?.({
    bucketGeneration: binding.bucketGeneration,
    keyspaceGeneration,
  }) ?? true;
  const openPlatformNamespace = async (input: PluginStorageDeclaration): Promise<KeyValueStore> => {
    const declaration = validatePluginStorageDeclaration(input);
    if (declaration.scope !== "bucket" || declaration.authority === "third-party-app" || declaration.model !== "kv") {
      throw new StorageRuntimeError("storage_forbidden", "Platform K-V declaration is not authorized");
    }
    const expected = platformDeclarations.get(declarationKey(declaration));
    if (!expected) {
      throw new StorageRuntimeError("storage_forbidden", "Platform storage namespace is not authorized");
    }
    const binding = bindingFor(declaration);
    buildStorageNamespaceRoot(binding);
    return createKeyValueStore({ provider: options.provider, binding, isCurrent: currentFor(binding) });
  };
  const openPlatformSnapshot = async <T>(input: { declaration: PluginStorageDeclaration; validate: (value: unknown) => StorageSnapshotJsonCompatible<T> }): Promise<SnapshotStore<T>> => {
    const declaration = validatePluginStorageDeclaration(input.declaration);
    if (declaration.scope !== "bucket" || declaration.authority !== "platform-only" || declaration.model !== "snapshot") {
      throw new StorageRuntimeError("storage_forbidden", "Platform snapshot declaration is not authorized");
    }
    const expected = platformDeclarations.get(declarationKey(declaration));
    if (!expected) {
      throw new StorageRuntimeError("storage_forbidden", "Platform snapshot declaration is not authorized");
    }
    const binding = bindingFor(declaration);
    return createFixedCasSnapshotStore({
      provider: options.provider,
      binding,
      isCurrent: currentFor(binding),
      validate: input.validate,
    });
  };
  /**
   * owner 模块的共享授权流程（K-V 与文件模型一致）。
   *
   * 内置 owner 模块由 pluginId 预绑定；裸句柄不能自造 module/purpose。
   * 单浏览器互斥由 `<owner>/lock.json` Key 应用锁与 Worker 内存栅栏保证，
   * 桶内不再保存 owner 生命周期记录。
   */
  const openOwnerBinding = async (
    input: { ownerPublicKeyHex: string; declaration: PluginStorageDeclaration; appPublisherPublicKeyHex?: string; keyspaceGeneration?: number },
    model: "kv" | "files",
  ): Promise<{
    declaration: PluginStorageDeclaration;
    ownerPublicKeyHex: string;
    appPublisherPublicKeyHex?: string;
    isCurrent: () => boolean;
  }> => {
    const declaration = validatePluginStorageDeclaration(input.declaration);
    if (declaration.scope !== "owner" || declaration.authority === "platform-only" || declaration.model !== model) {
      throw new StorageRuntimeError("storage_forbidden", model === "kv" ? "Owner K-V declaration is not authorized" : "Owner file declaration is not authorized");
    }
    if (input.appPublisherPublicKeyHex !== undefined && declaration.model !== "files") {
      throw new StorageRuntimeError("storage_forbidden", "App publisher root requires the files model");
    }
    const expected = Object.values(SYSTEM_STORAGE_DECLARATIONS).flat().find((candidate) =>
      candidate.moduleId === declaration.moduleId
      && candidate.purposeId === declaration.purposeId
      && candidate.scope === "owner"
      && candidate.authority === "built-in-module"
      && candidate.model === model);
    if (!expected || expected.schemaVersion !== declaration.schemaVersion) {
      throw new StorageRuntimeError("storage_forbidden", "Owner storage namespace is not centrally authorized");
    }
    const ownerPublicKeyHex = validateOwnerPublicKeyHex(input.ownerPublicKeyHex);
    const appPublisherPublicKeyHex = input.appPublisherPublicKeyHex === undefined
      ? undefined
      : validateOwnerPublicKeyHex(input.appPublisherPublicKeyHex);
    return {
      declaration,
      ownerPublicKeyHex,
      ...(appPublisherPublicKeyHex === undefined ? {} : { appPublisherPublicKeyHex }),
      isCurrent: () => options.isCurrent?.({
        ownerPublicKeyHex,
        bucketGeneration: options.bucket.bucketGeneration,
        keyspaceGeneration: input.keyspaceGeneration
      }) ?? true,
    };
  };

  return {
    bucket: Object.freeze({ ...options.bucket }),
    async openKeyValueStore(input): Promise<OwnerAppStore> {
      const opened = await openOwnerBinding(input, "kv");
      return createOwnerAppStore({
        provider: options.provider,
        bucket: options.bucket,
        ownerPublicKeyHex: opened.ownerPublicKeyHex,
        declaration: opened.declaration,
        isCurrent: opened.isCurrent,
      });
    },
    async openOwnerFileStore(input): Promise<OwnerFileStore> {
      const opened = await openOwnerBinding(input, "files");
      return createOwnerFileStore({
        provider: options.provider,
        bucket: options.bucket,
        ownerPublicKeyHex: opened.ownerPublicKeyHex,
        declaration: opened.declaration,
        ...(opened.appPublisherPublicKeyHex === undefined ? {} : { appPublisherPublicKeyHex: opened.appPublisherPublicKeyHex }),
        isCurrent: opened.isCurrent,
      });
    },
    async listOwnerAppPublishers(input): Promise<string[]> {
      const ownerPublicKeyHex = validateOwnerPublicKeyHex(input.ownerPublicKeyHex);
      const prefix = `${ownerPublicKeyHex}/app.`;
      const publishers = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await options.provider.list({ prefix, ...(cursor === undefined ? {} : { cursor }), limit: OWNER_LIST_LIMIT });
        for (const object of page.objects) {
          const relative = object.path.slice(ownerPublicKeyHex.length + 1);
          const segment = relative.split("/", 1)[0] ?? "";
          if (!segment.startsWith("app.")) continue;
          const publisher = segment.slice("app.".length);
          if (/^(02|03)[0-9a-f]{64}$/u.test(publisher)) publishers.add(publisher);
        }
        cursor = page.nextCursor;
      } while (cursor);
      return [...publishers].sort();
    },
    async deleteOwnerStorage(input) {
      // 物理清理只按列表删除；并发与跨设备互斥由 `<owner>/lock.json`
      // Key 应用锁和 Worker 内存栅栏负责，这里不再维护桶内生命周期记录。
      await deleteOwnerObjectsUntilEmpty(options.provider, validateOwnerPublicKeyHex(input.ownerPublicKeyHex));
    },
    openPlatformStore: (input) => openPlatformNamespace(input.declaration),
    openPlatformSnapshot,
  };
}
