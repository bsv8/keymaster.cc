import type { BorrowedModuleFileStore, KeyValueStore, ModuleFileStore, PluginStorageDeclaration } from "@keymaster/contracts";
import type { StoragePrivateRootStore } from "../storage-access/platform-root/platformRootStore.js";

export interface WorkerStorageBinding {
  walletGeneration: string;
  sessionEpoch: string;
  runGeneration: string;
}
export type WorkerMaintenanceStore = KeyValueStore & {
  collectGarbage(input?: { minAgeMs?: number; maxDeletes?: number }): Promise<{ scanned: number; candidates: number; deleted: number; failed: number }>;
};
export interface WorkerStorageClientDependencies<Binding extends WorkerStorageBinding> {
  root(): StoragePrivateRootStore | undefined;
  binding(): Binding | undefined;
  sameBinding(left: Binding, right: Binding): boolean;
  assertAvailable(): void;
  assertLive(binding: Binding): void;
  beginRequest(): () => void;
  declaration(moduleId: string, purposeId: string, model: "files" | "kv"): PluginStorageDeclaration;
  unavailable(message: string): Error;
  withIoLease<T>(operation: "read" | "write", model: "files" | "kv", execute: () => Promise<T>): Promise<T>;
  onFailure(error: unknown): void;
  onInvalidate(moduleId: string): void;
  registerMaintenance(store: WorkerMaintenanceStore): void;
  unregisterMaintenance(store: WorkerMaintenanceStore): void;
}

/** Storage owns borrowed handles and open generations. Only trusted assembly
 * supplies declarations, authority fences and the final physical I/O lease.
 */
export function createWorkerStorageClients<Binding extends WorkerStorageBinding>(deps: WorkerStorageClientDependencies<Binding>) {
  const files = new Map<string, BorrowedModuleFileStore>();
  const bindings = new Set<{ invalidate(): void }>();

  function borrow<Store extends { close(): void }>(moduleId: string, purposeId: string, model: "files" | "kv", open: (root: StoragePrivateRootStore, declaration: PluginStorageDeclaration) => Promise<Store>) {
    const declaration = deps.declaration(moduleId, purposeId, model);
    let closed = false;
    let generation = 0;
    let current: Store | undefined;
    let bound: Binding | undefined;
    let opening: Promise<Store> | undefined;
    const binding = {
      invalidate(notify = true) {
        generation += 1;
        current?.close();
        current = undefined;
        bound = undefined;
        opening = undefined;
        if (notify) deps.onInvalidate(moduleId);
      },
    };
    bindings.add(binding);
    async function resolve(): Promise<Store> {
      if (closed) throw deps.unavailable("Worker storage handle is closed");
      deps.assertAvailable();
      const expected = deps.binding();
      const root = deps.root();
      if (!expected || !root) throw deps.unavailable("Worker storage binding is unavailable");
      if (current && bound && deps.sameBinding(bound, expected)) return current;
      if (opening) return opening;
      binding.invalidate(false);
      const capturedGeneration = generation;
      const pending = open(root, declaration).then(opened => {
        const live = deps.binding();
        if (closed || generation !== capturedGeneration || deps.root() !== root || !live || !deps.sameBinding(live, expected)) {
          opened.close();
          throw deps.unavailable("Worker storage binding became stale while opening");
        }
        current = opened;
        bound = expected;
        return opened;
      }).finally(() => { if (opening === pending) opening = undefined; });
      opening = pending;
      return pending;
    }
    function run<T>(operation: "read" | "write", execute: (store: Store) => Promise<T>): Promise<T> {
      return deps.withIoLease(operation, model, async () => {
        try {
          const store = await resolve();
          const expected = bound;
          if (!expected) throw deps.unavailable("Worker storage binding is unavailable");
          const release = deps.beginRequest();
          try {
            const result = await execute(store);
            if (closed || store !== current) throw deps.unavailable("Worker storage handle became stale");
            deps.assertLive(expected);
            return result;
          } finally { release(); }
        } catch (error) { deps.onFailure(error); throw error; }
      });
    }
    return {
      run,
      binding: () => bound,
      close() {
        if (closed) return;
        closed = true;
        binding.invalidate();
        bindings.delete(binding);
      },
    };
  }

  function moduleFiles(moduleId: string, purposeId: string, appStorageName?: string): BorrowedModuleFileStore {
    const key = `${moduleId}\u0000${purposeId}\u0000${appStorageName ?? "*"}`;
    const existing = files.get(key);
    if (existing) return existing;
    const borrowed = borrow<ModuleFileStore>(moduleId, purposeId, "files", (root, declaration) => root.openModuleFileStore({ declaration, ...(appStorageName === undefined ? {} : { appStorageName }) }));
    const handle: BorrowedModuleFileStore = {
      get walletGeneration() { return borrowed.binding()?.walletGeneration ?? ""; },
      get sessionEpoch() { return borrowed.binding()?.sessionEpoch ?? ""; },
      get runGeneration() { return borrowed.binding()?.runGeneration ?? ""; },
      list: input => borrowed.run("read", store => store.list(input)),
      get: (path, options) => borrowed.run("read", store => store.get(path, options)),
      getRange: (path, range, options) => borrowed.run("read", store => store.getRange(path, range, options)),
      put: (path, bytes, options) => borrowed.run("write", store => store.put(path, bytes, options)),
      delete: (path, options) => borrowed.run("write", store => store.delete(path, options)),
      batch: (input, options) => borrowed.run("write", store => store.batch(input, options)),
    };
    files.set(key, handle);
    return handle;
  }

  function keyValue(moduleId: string, purposeId: string): KeyValueStore {
    const declaration = deps.declaration(moduleId, purposeId, "kv");
    if (declaration.authority === "third-party-app") throw new Error("Worker module K-V requires a built-in or platform declaration");
    const borrowed = borrow<KeyValueStore>(moduleId, purposeId, "kv", (root, declaration) => root.openKeyValueStore({ declaration }));
    const handle: WorkerMaintenanceStore = {
      get walletGeneration() { return borrowed.binding()?.walletGeneration ?? ""; },
      get sessionEpoch() { return borrowed.binding()?.sessionEpoch ?? ""; },
      get runGeneration() { return borrowed.binding()?.runGeneration ?? ""; },
      moduleId: declaration.moduleId,
      purposeId: declaration.purposeId,
      authority: declaration.authority,
      model: "kv",
      schemaVersion: declaration.schemaVersion,
      get: (key, options) => borrowed.run("read", store => store.get(key, options)),
      list: input => borrowed.run("read", store => store.list(input)),
      put: (key, value, condition) => borrowed.run("write", store => store.put(key, value, condition)),
      delete: (key, condition) => borrowed.run("write", store => store.delete(key, condition)),
      commit: input => borrowed.run("write", store => store.commit(input)),
      collectGarbage: input => borrowed.run("write", store => {
        const maintenance = store as Partial<WorkerMaintenanceStore>;
        if (!maintenance.collectGarbage) throw new Error("K-V garbage collection is unavailable");
        return maintenance.collectGarbage(input);
      }),
      close() { borrowed.close(); deps.unregisterMaintenance(handle); },
    };
    deps.registerMaintenance(handle);
    return handle;
  }
  return { moduleFiles, keyValue, invalidateAll() { for (const binding of bindings) binding.invalidate(); } };
}
