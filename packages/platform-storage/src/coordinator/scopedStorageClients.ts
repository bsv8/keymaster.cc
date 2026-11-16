import { STORAGE_FILE_CLIENTS_CAPABILITY, STORAGE_KV_CLIENTS_CAPABILITY, type KeyValueStore, type PluginManifest, type PluginStorageDeclaration } from "@keymaster/contracts";
import type { StorageBindingAuthority } from "@keymaster/contracts/storage-internal";
import type { LifecycleScope, PluginConsumer } from "webloom-framework";
/** 稳定的实例存储接口：首次 I/O 打开一次，实例退出时关闭。
 * 页面遮罩和改密不改变实例或访问范围，不维护解锁会话缓存与重绑。
 */
function scopedStore<Store extends { close(): void }>(
  scope: LifecycleScope,
  open: () => Promise<Store>,
  valid: (store: Store) => boolean,
) {
  let closed = false;
  let opened: Store | undefined;
  let opening: Promise<Store> | undefined;
  const close = () => { closed = true; opened?.close(); opened = undefined; };
  const off = scope.onRevoke(close);
  scope.onDispose(() => { off(); close(); }, "storage");
  async function run<T>(operation: (store: Store) => Promise<T>): Promise<T> {
    scope.assertActive();
    if (closed) throw new Error("Storage instance has been released");
    opening ??= open().then(store => {
      if (closed || !valid(store)) { store.close(); throw new Error("Storage wallet changed while opening"); }
      opened = store;
      return store;
    }).catch(error => { opening = undefined; throw error; });
    const store = await opening;
    scope.assertActive();
    if (!valid(store)) throw new Error("Storage wallet changed");
    const value = await operation(store);
    scope.assertActive();
    if (!valid(store)) throw new Error("Storage wallet changed while operation was running");
    return value;
  }
  return { run, close, current: () => opened };
}
function bindWallet(authority: StorageBindingAuthority) {
  // 在 consumer 取得接口时固定归属，而不是等旧回调首次 I/O 时采用新钱包。
  const walletGeneration = authority.getWalletGeneration?.();
  const runGeneration = authority.getRunGeneration?.();
  return (store: { walletGeneration: string; runGeneration: string }): boolean =>
    (walletGeneration === undefined || (store.walletGeneration === walletGeneration && authority.getWalletGeneration?.() === walletGeneration))
    && (runGeneration === undefined || (store.runGeneration === runGeneration && authority.getRunGeneration?.() === runGeneration));
}
function createDeferredOwnerAppStore(authority: StorageBindingAuthority, pluginId: string, declaration: PluginStorageDeclaration, scope: LifecycleScope): KeyValueStore {
  if (declaration.authority !== "built-in-module") throw new Error("Only internal plugins can use wallet storage");
  const store = scopedStore(scope, () => authority.openOwnerAppStore({ pluginId, declaration }), bindWallet(authority));
  return {
    get walletGeneration() { return store.current()?.walletGeneration ?? "pending"; },
    get runGeneration() { return store.current()?.runGeneration ?? "pending"; },
    moduleId: declaration.moduleId, purposeId: declaration.purposeId, authority: declaration.authority, model: "kv", schemaVersion: declaration.schemaVersion,
    get: (key, input) => store.run(value => value.get(key, input)),
    list: input => store.run(value => value.list(input)),
    put: (key, value, condition) => store.run(target => target.put(key, value, condition)),
    delete: (key, condition) => store.run(value => value.delete(key, condition)),
    commit: input => store.run(value => value.commit(input)),
    close: store.close,
  };
}
function createDeferredOwnerFileStore(authority: StorageBindingAuthority, pluginId: string, declaration: PluginStorageDeclaration, scope: LifecycleScope): import("@keymaster/contracts").ModuleFileStore {
  const store = scopedStore(scope, () => authority.openOwnerFileStore({ pluginId, declaration }), bindWallet(authority));
  return {
    get walletGeneration() { return store.current()?.walletGeneration ?? "pending"; },
    get runGeneration() { return store.current()?.runGeneration ?? "pending"; },
    get: (path, input) => store.run(value => value.get(path, input)),
    list: input => store.run(value => value.list(input)),
    getRange: (path, range, input) => store.run(value => value.getRange(path, range, input)),
    put: (path, bytes, input) => store.run(value => value.put(path, bytes, input)),
    delete: (path, input) => store.run(value => value.delete(path, input)),
    batch: (input, options) => store.run(value => value.batch(input, options)),
    close: store.close,
  };
}

function borrowKeyValueStore(store: KeyValueStore): import("@keymaster/contracts").BorrowedKeyValueStore {
  return {
    get walletGeneration() { return store.walletGeneration; },
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
) {
  const files = new WeakMap<PluginConsumer, Map<string, import("@keymaster/contracts").BorrowedModuleFileStore>>();
  const kv = new WeakMap<PluginConsumer, Map<string, import("@keymaster/contracts").BorrowedKeyValueStore>>();
  const declarationFor = (consumer: PluginConsumer, scope: LifecycleScope, purposeId: string, model: "files" | "kv") => {
    if (consumer.status !== "active") throw new Error("Storage consumer has been revoked");
    scope.assertActive(); consumer.capability(model === "files" ? STORAGE_FILE_CLIENTS_CAPABILITY : STORAGE_KV_CLIENTS_CAPABILITY);
    const unit = manifest(consumer.pluginId)?.units?.find(candidate => candidate.id === consumer.unitId);
    const declarations = unit?.storages ?? (unit?.storage ? [unit.storage] : []);
    const declaration = declarations.find(candidate => candidate.purposeId === purposeId && (model === "files" ? candidate.model === "files" : candidate.model !== "files"));
    if (!declaration) throw new Error(`${model === "files" ? "File" : "K-V"} purpose is not declared by this instance`);
    if (declaration.moduleId !== consumer.pluginId) throw new Error("Storage module must match its plugin");
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
