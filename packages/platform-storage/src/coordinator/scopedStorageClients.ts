import { STORAGE_FILE_CLIENTS_CAPABILITY, type PluginStorageDeclaration } from "@keymaster/contracts";
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

/** Storage owns purpose validation, lazy opening and lifetime fencing. Trusted assembly supplies only the authority. */
export function createScopedStorageClients(
  authority: StorageBindingAuthority,
  manifest: (pluginId: string) => { units?: readonly { id: string; storage?: PluginStorageDeclaration; storages?: readonly PluginStorageDeclaration[] }[] } | undefined,
) {
  const files = new WeakMap<PluginConsumer, Map<string, import("@keymaster/contracts").BorrowedModuleFileStore>>();
  const declarationFor = (consumer: PluginConsumer, scope: LifecycleScope, purposeId: string, model: "files") => {
    if (consumer.status !== "active") throw new Error("Storage consumer has been revoked");
    scope.assertActive(); consumer.capability(STORAGE_FILE_CLIENTS_CAPABILITY);
    const unit = manifest(consumer.pluginId)?.units?.find(candidate => candidate.id === consumer.unitId);
    const declarations = unit?.storages ?? (unit?.storage ? [unit.storage] : []);
    const declaration = declarations.find(candidate => candidate.purposeId === purposeId && candidate.model === "files");
    if (!declaration) throw new Error(`File purpose is not declared by this instance`);
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
  ] as const;
}
