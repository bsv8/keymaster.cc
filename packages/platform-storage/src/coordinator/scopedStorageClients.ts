import { STORAGE_FILE_CLIENTS_CAPABILITY, STORAGE_KV_CLIENTS_CAPABILITY, assertSystemStorageDeclaration, validatePluginStorageDeclaration, type KeyValueStore, type PluginManifest, type PluginStorageDeclaration } from "@keymaster/contracts";
import type { StorageBindingAuthority } from "@keymaster/contracts/storage-internal";
import type { LifecycleScope, PluginConsumer } from "webloom-framework";
import { isIssuedKeymasterConsumer } from "@keymaster/runtime/storage";
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
function isStaleOwnerStorageBinding(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  if (code === "storage_unavailable" || code === "storage_identity_required") return true;
  return /owner storage (?:handle|grant|binding) .*?(?:stale|invalid|changed)|owner storage .*unavailable|owner storage owner changed|owner storage bucket generation changed/i.test(errorMessage(error));
}


function createDeferredOwnerAppStore(
  authority: StorageBindingAuthority,
  pluginId: string,
  declaration: PluginStorageDeclaration,
  scope: import("webloom-framework").LifecycleScope,
): KeyValueStore {
  // 第三方 App 只能拿到自己目录里的文件读写；K-V 与 snapshot 属于平台和
  // 内置模块，不对 App 开放，所以这里拒绝而不是降级成别的句柄。
  if (declaration.authority === "third-party-app") {
    throw new Error("Third-party app storage cannot be bound to a K-V store");
  }
  let closed = false;
  let current: KeyValueStore | undefined;
  let opening: Promise<KeyValueStore> | undefined;
  // 打开句柄时锁定的三件世代：任一变化都必须重新申请 grant，旧句柄不再复用。
  let boundWalletGeneration: string | undefined;
  let boundSessionEpoch: string | undefined;
  let boundRunGeneration: string | undefined;

  const invalidateCurrent = (): void => {
    current?.close();
    current = undefined;
    opening = undefined;
    boundWalletGeneration = undefined;
    boundSessionEpoch = undefined;
    boundRunGeneration = undefined;
  };

  const removeScopeRevoke = scope.onRevoke(() => {
    closed = true;
    invalidateCurrent();
  });
  scope.onDispose(() => {
    removeScopeRevoke();
    closed = true;
    invalidateCurrent();
  }, "owner-storage");

  async function resolve(): Promise<KeyValueStore> {
    scope.assertActive();
    if (closed) throw new Error("Owner storage handle is closed");
    // 会话 epoch 与运行世代只由 Worker 自己推进；Host 侧能观察到的是钱包
    // 身份世代（重置/重新初始化后改变）。任何一个变了就丢弃旧 grant 重绑。
    const liveWalletGeneration = authority.getWalletGeneration?.();
    const walletChanged = liveWalletGeneration !== undefined
      && boundWalletGeneration !== undefined
      && boundWalletGeneration !== liveWalletGeneration;
    if (walletChanged) invalidateCurrent();
    if (!current) {
      if (!opening) {
        // Resource loaders may enter concurrently before the first grant is ready.
        const pending: Promise<KeyValueStore> = (declaration.authority === "platform-only" ? authority.openPlatformStore({ pluginId, declaration }) : authority.openOwnerAppStore({ pluginId, declaration })).then(opened => {
          try {
            scope.assertActive();
            if (closed || opening !== pending) throw new Error("Owner storage binding superseded while opening");
            const latestWalletGeneration = authority.getWalletGeneration?.();
            if (latestWalletGeneration !== undefined && opened.walletGeneration !== latestWalletGeneration) {
              throw new Error("Owner storage wallet generation changed while opening binding");
            }
            current = opened;
            boundWalletGeneration = opened.walletGeneration;
            boundSessionEpoch = opened.sessionEpoch;
            boundRunGeneration = opened.runGeneration;
            return opened;
          } catch (error) {
            opened.close();
            throw error;
          }
        }).finally(() => { if (opening === pending) opening = undefined; });
        opening = pending;
      }
      return opening;
    }
    scope.assertActive();
    return current;
  }

  const run = async <T>(operation: (store: KeyValueStore) => Promise<T>): Promise<T> => {
    const store = await resolve();
    const boundEpoch = boundSessionEpoch;
    const boundRun = boundRunGeneration;
    const boundWallet = boundWalletGeneration;
    try {
      scope.assertActive();
      const result = await operation(store);
      scope.assertActive();
      // 锁、改密、重置、撤权与 Worker 重启都会改变其中一项；跨过栅栏的迟到
      // 结果在这里被丢弃，不允许把旧授权下的写入当作成功。
      if (current !== store
        || boundSessionEpoch !== boundEpoch
        || boundRunGeneration !== boundRun
        || boundWalletGeneration !== boundWallet
        || (authority.getWalletGeneration?.() !== undefined
          && boundWalletGeneration !== authority.getWalletGeneration?.())) {
        throw new Error("Owner storage binding changed while operation was running");
      }
      return result;
    } catch (error) {
      if (current === store && isStaleOwnerStorageBinding(error)) invalidateCurrent();
      throw error;
    }
  };

  return {
    get walletGeneration() { return boundWalletGeneration ?? "pending"; },
    get sessionEpoch() { return boundSessionEpoch ?? "pending"; },
    get runGeneration() { return boundRunGeneration ?? "pending"; },
    moduleId: declaration.moduleId,
    purposeId: declaration.purposeId,
    authority: declaration.authority,
    model: "kv",
    schemaVersion: declaration.schemaVersion,
    get: async (key, options) => run((store) => store.get(key, options)),
    list: async (input) => run((store) => store.list(input)),
    put: async (key, value, condition) => run((store) => store.put(key, value, condition)),
    delete: async (key, condition) => { await run((store) => store.delete(key, condition)); },
    commit: async (input) => run((store) => store.commit(input)),
    close: () => {
      if (closed) return;
      closed = true;
      invalidateCurrent();
    },
  };
}

/** 创建延迟模块文件句柄（model: "files"）；authority 在最终 I/O 边界复核绑定。 */
function createDeferredOwnerFileStore(
  authority: StorageBindingAuthority,
  pluginId: string,
  declaration: PluginStorageDeclaration,
  scope: import("webloom-framework").LifecycleScope,
): import("@keymaster/contracts").OwnerFileStore {
  let closed = false;
  let current: import("@keymaster/contracts").OwnerFileStore | undefined;
  let opening: Promise<import("@keymaster/contracts").OwnerFileStore> | undefined;

  const invalidateCurrent = (): void => {
    current?.close();
    current = undefined;
    opening = undefined;
  };

  const removeScopeRevoke = scope.onRevoke(() => {
    closed = true;
    invalidateCurrent();
  });
  scope.onDispose(() => {
    removeScopeRevoke();
    closed = true;
    invalidateCurrent();
  }, "owner-file-storage");

  async function resolve(): Promise<import("@keymaster/contracts").OwnerFileStore> {
    scope.assertActive();
    if (closed) throw new Error("Owner file storage handle is closed");
    const liveWalletGeneration = authority.getWalletGeneration?.();
    if (current && liveWalletGeneration !== undefined && current.walletGeneration !== liveWalletGeneration) invalidateCurrent();
    if (!current) {
      if (!opening) {
        const pending: Promise<import("@keymaster/contracts").OwnerFileStore> = authority.openOwnerFileStore({ pluginId, declaration }).then(opened => {
          try {
            scope.assertActive();
            if (closed || opening !== pending) throw new Error("Owner file storage binding superseded while opening");
            const latestWalletGeneration = authority.getWalletGeneration?.();
            if (latestWalletGeneration !== undefined && opened.walletGeneration !== latestWalletGeneration) {
              throw new Error("Owner file storage wallet generation changed while opening binding");
            }
            current = opened;
            return opened;
          } catch (error) {
            opened.close();
            throw error;
          }
        }).finally(() => { if (opening === pending) opening = undefined; });
        opening = pending;
      }
      return opening;
    }
    return current;
  }

  const run = async <T>(operation: (store: import("@keymaster/contracts").OwnerFileStore) => Promise<T>): Promise<T> => {
    const store = await resolve();
    const boundEpoch = store.sessionEpoch;
    const boundRun = store.runGeneration;
    const boundWallet = store.walletGeneration;
    try {
      scope.assertActive();
      const result = await operation(store);
      scope.assertActive();
      // 锁、改密、重置、撤权与 Worker 重启都会改变其中一项；跨过栅栏的迟到
      // 结果在这里被丢弃。
      if (current !== store
        || store.sessionEpoch !== boundEpoch
        || store.runGeneration !== boundRun
        || store.walletGeneration !== boundWallet
        || (authority.getWalletGeneration?.() !== undefined && boundWallet !== authority.getWalletGeneration?.())) {
        throw new Error("Owner file storage binding changed while operation was running");
      }
      return result;
    } catch (error) {
      if (current === store && isStaleOwnerStorageBinding(error)) invalidateCurrent();
      throw error;
    }
  };

  return {
    get walletGeneration() { return current?.walletGeneration ?? "pending"; },
    get sessionEpoch() { return current?.sessionEpoch ?? "pending"; },
    get runGeneration() { return current?.runGeneration ?? "pending"; },
    list: (input) => run((store) => store.list(input)),
    get: (path, options) => run((store) => store.get(path, options)),
    getRange: (path, range, options) => run((store) => store.getRange(path, range, options)),
    put: (path, bytes, condition) => run((store) => store.put(path, bytes, condition)),
    delete: (path, options) => { return run((store) => store.delete(path, options)); },
    batch: (input, options) => run((store) => store.batch(input, options)),
    close: () => {
      if (closed) return;
      closed = true;
      invalidateCurrent();
    },
  };
}

function borrowKeyValueStore(store: KeyValueStore): import("@keymaster/contracts").BorrowedKeyValueStore {
  return {
    get walletGeneration() { return store.walletGeneration; },
    get sessionEpoch() { return store.sessionEpoch; },
    get runGeneration() { return store.runGeneration; },
    get moduleId() { return store.moduleId; },
    get purposeId() { return store.purposeId; },
    get authority() { return store.authority; },
    get model() { return store.model; },
    get schemaVersion() { return store.schemaVersion; },
    get: (key, input) => store.get(key, input),
    list: (input) => store.list(input),
    put: (key, value, condition) => store.put(key, value, condition),
    delete: (key, condition) => store.delete(key, condition),
    commit: (input) => store.commit(input),
  };
}


/** Storage owns purpose validation, lazy opening and lifetime fencing. Trusted assembly supplies only the authority. */
export function createScopedStorageClients(
  authority: StorageBindingAuthority,
  manifest: (pluginId: string) => { units?: readonly { id: string; storage?: PluginStorageDeclaration; storages?: readonly PluginStorageDeclaration[] }[] } | undefined,
  authentic: (consumer: PluginConsumer, scope: LifecycleScope) => boolean = isIssuedKeymasterConsumer,
) {
  const files = new WeakMap<PluginConsumer, Map<string, import("@keymaster/contracts").BorrowedOwnerFileStore>>();
  const kv = new WeakMap<PluginConsumer, Map<string, import("@keymaster/contracts").BorrowedKeyValueStore>>();
  const declarationFor = (consumer: PluginConsumer, scope: LifecycleScope, purposeId: string, model: "files" | "kv") => {
    if (!authentic(consumer, scope) || consumer.status !== "active") throw new Error("Client binding requires its live issued consumer and Scope");
    scope.assertActive(); consumer.capability(model === "files" ? STORAGE_FILE_CLIENTS_CAPABILITY : STORAGE_KV_CLIENTS_CAPABILITY);
    const unit = manifest(consumer.pluginId)?.units?.find(candidate => candidate.id === consumer.unitId);
    const declarations = unit?.storages ?? (unit?.storage ? [unit.storage] : []);
    const declaration = declarations.find(candidate => candidate.purposeId === purposeId && (model === "files" ? candidate.model === "files" : candidate.model !== "files"));
    if (!declaration) throw new Error(`${model === "files" ? "File" : "K-V"} purpose is not declared by this instance`);
    validatePluginStorageDeclaration(declaration); assertSystemStorageDeclaration(consumer.pluginId, declaration);
    return declaration;
  };
  return [
    { capability: STORAGE_FILE_CLIENTS_CAPABILITY, value: { bind(consumer: PluginConsumer, scope: LifecycleScope, purposeId: string) {
      const declaration = declarationFor(consumer, scope, purposeId, "files");
      let cache = files.get(consumer); if (!cache) { cache = new Map(); files.set(consumer, cache); }
      let store = cache.get(purposeId);
      if (!store) { store = createDeferredOwnerFileStore(authority, consumer.pluginId, declaration, scope); cache.set(purposeId, store); }
      return store;
    } } },
    { capability: STORAGE_KV_CLIENTS_CAPABILITY, value: { bind(consumer: PluginConsumer, scope: LifecycleScope, purposeId: string) {
      const declaration = declarationFor(consumer, scope, purposeId, "kv");
      let cache = kv.get(consumer); if (!cache) { cache = new Map(); kv.set(consumer, cache); }
      let store = cache.get(purposeId);
      if (!store) { const owned = createDeferredOwnerAppStore(authority, consumer.pluginId, declaration, scope); scope.track(owned, value => value.close(), `storage:${purposeId}`); store = borrowKeyValueStore(owned); cache.set(purposeId, store); }
      return store;
    } } },
  ] as const;
}
