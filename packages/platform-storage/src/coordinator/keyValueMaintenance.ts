import type { KeyValueStore, PlatformRootStore, PluginStorageDeclaration } from "@keymaster/contracts";
import { CENTRAL_STORAGE_DECLARATIONS, SYSTEM_STORAGE_DECLARATIONS } from "@keymaster/contracts";
import type { StoragePrivateRootStore } from "../storage-access/platform-root/platformRootStore.js";
export interface KeyValueMaintenanceDependencies {
  root(): StoragePrivateRootStore | undefined;
  rootToken(): object | undefined;
  isReady(): boolean;
  ownerGrants(): Iterable<PluginStorageDeclaration>;
}
/** Storage owns namespace enumeration, tracked handles and the maintenance generation. */
export function createKeyValueMaintenance(deps: KeyValueMaintenanceDependencies) {
  type CoordinatorKeyValueMaintenanceStore = KeyValueStore & {
    collectGarbage(input?: { minAgeMs?: number; maxDeletes?: number }): Promise<{ scanned: number; candidates: number; deleted: number; failed: number }>;
  };
  const coordinatorKeyValueMaintenanceStores = new Set<CoordinatorKeyValueMaintenanceStore>();
  const COORDINATOR_KV_GC_INTERVAL_MS = 15 * 60 * 1000;
  const COORDINATOR_KV_GC_MIN_AGE_MS = 10 * 60 * 1000;
  const COORDINATOR_KV_GC_MAX_DELETES = 64;
  let coordinatorKvGcTimer: ReturnType<typeof setTimeout> | undefined;
  let coordinatorKvGcGeneration = 0;
  let coordinatorKvGcRunning: Promise<void> | undefined;

  function registerCoordinatorKeyValueMaintenanceStore(store: KeyValueStore): void {
    const maintenance = store as CoordinatorKeyValueMaintenanceStore;
    if (typeof maintenance.collectGarbage === "function") coordinatorKeyValueMaintenanceStores.add(maintenance);
  }

  function unregisterCoordinatorKeyValueMaintenanceStore(store: KeyValueStore | undefined): void {
    if (store) coordinatorKeyValueMaintenanceStores.delete(store as CoordinatorKeyValueMaintenanceStore);
  }

  function stopCoordinatorKeyValueMaintenance(): void {
    coordinatorKvGcGeneration += 1;
    if (coordinatorKvGcTimer !== undefined) {
      clearTimeout(coordinatorKvGcTimer);
      coordinatorKvGcTimer = undefined;
    }
  }

  function declarationMaintenanceKey(
    declaration: Pick<PluginStorageDeclaration, "moduleId" | "purposeId" | "authority" | "model" | "schemaVersion">,
  ): string {
    return [declaration.moduleId, declaration.purposeId, declaration.authority, declaration.model, declaration.schemaVersion].join(":");
  }

  /** 需要参与本地 K-V 垃圾回收的中央声明坐标。 */
  function coordinatorKeyValueMaintenanceDeclarations(): PluginStorageDeclaration[] {
    const declarations = new Map<string, PluginStorageDeclaration>();
    for (const declaration of [
      ...Object.values(CENTRAL_STORAGE_DECLARATIONS),
      ...Object.values(SYSTEM_STORAGE_DECLARATIONS).flat(),
    ]) {
      if (declaration.model !== "kv") continue;
      declarations.set(declarationMaintenanceKey(declaration), { ...declaration });
    }
    // Host-bound built-in namespaces are normally already in SYSTEM_STORAGE_DECLARATIONS.
    // Include live grants too so a future centrally authorized dynamic namespace is not
    // stranded merely because it has no long-lived Worker handle.
    for (const grant of deps.ownerGrants()) {
      if (grant.model !== "kv") continue;
      const declaration: PluginStorageDeclaration = {
        moduleId: grant.moduleId,
        purposeId: grant.purposeId,
        authority: grant.authority,
        model: grant.model,
        schemaVersion: grant.schemaVersion,
      };
      declarations.set(declarationMaintenanceKey(declaration), declaration);
    }
    return [...declarations.values()];
  }

  function maintenanceStoreMatches(
    store: KeyValueStore,
    root: PlatformRootStore,
    target: PluginStorageDeclaration,
  ): boolean {
    return store.walletGeneration === root.walletGeneration
      && store.moduleId === target.moduleId
      && store.purposeId === target.purposeId
      && store.authority === target.authority
      && store.model === target.model
      && store.schemaVersion === target.schemaVersion;
  }

  async function collectCoordinatorKeyValueGarbage(input: { minAgeMs: number; maxDeletes: number }, swallowErrors: boolean): Promise<void> {
    const root = deps.root();
    const rootToken = deps.rootToken();
    if (!root || !rootToken || !deps.isReady()) return;
    const visited = new Set<string>();
    const collect = async (store: KeyValueStore, targetKey: string): Promise<void> => {
      if (visited.has(targetKey)) return;
      visited.add(targetKey);
      const maintenance = store as CoordinatorKeyValueMaintenanceStore;
      if (typeof maintenance.collectGarbage !== "function") return;
      try {
        await maintenance.collectGarbage(input);
      } catch (error) {
        if (!swallowErrors) throw error;
        console.warn("[storage] coordinator K-V garbage collection failed", error instanceof Error ? error.message : String(error));
      }
    };

    for (const store of [...coordinatorKeyValueMaintenanceStores]) {
      if (store.walletGeneration !== root.walletGeneration) continue;
      if (deps.root() !== root || deps.rootToken() !== rootToken) return;
      await collect(store, declarationMaintenanceKey({
        moduleId: store.moduleId,
        purposeId: store.purposeId,
        authority: store.authority,
        model: store.model,
        schemaVersion: store.schemaVersion,
      }));
    }

    if (deps.root() !== root || deps.rootToken() !== rootToken) return;
    for (const declaration of coordinatorKeyValueMaintenanceDeclarations()) {
      const targetKey = declarationMaintenanceKey(declaration);
      if (visited.has(targetKey)) continue;
      let store: KeyValueStore | undefined;
      try {
        store = declaration.authority === "platform-only"
          ? await root.openPlatformStore({ declaration })
          : await root.openKeyValueStore({ declaration });
        if (!maintenanceStoreMatches(store, root, declaration)) throw new Error("Coordinator K-V maintenance binding mismatch");
        await collect(store, targetKey);
      } catch (error) {
        if (!swallowErrors) throw error;
        console.warn("[storage] coordinator K-V namespace maintenance failed", error instanceof Error ? error.message : String(error));
      } finally {
        store?.close();
      }
      if (deps.root() !== root || deps.rootToken() !== rootToken) return;
    }
  }

  function scheduleCoordinatorKeyValueMaintenance(): void {
    if (!deps.isReady() || coordinatorKvGcTimer !== undefined) return;
    const generation = coordinatorKvGcGeneration;
    coordinatorKvGcTimer = setTimeout(() => {
      coordinatorKvGcTimer = undefined;
      if (generation !== coordinatorKvGcGeneration) return;
      let run: Promise<void>;
      run = collectCoordinatorKeyValueGarbage({ minAgeMs: COORDINATOR_KV_GC_MIN_AGE_MS, maxDeletes: COORDINATOR_KV_GC_MAX_DELETES }, true).finally(() => {
        if (coordinatorKvGcRunning === run) coordinatorKvGcRunning = undefined;
        if (generation === coordinatorKvGcGeneration) scheduleCoordinatorKeyValueMaintenance();
      });
      coordinatorKvGcRunning = run;
    }, COORDINATOR_KV_GC_INTERVAL_MS);
  }


  return {
    register: registerCoordinatorKeyValueMaintenanceStore,
    unregister: unregisterCoordinatorKeyValueMaintenanceStore,
    stop: stopCoordinatorKeyValueMaintenance,
    schedule: scheduleCoordinatorKeyValueMaintenance,
    clear() { stopCoordinatorKeyValueMaintenance(); coordinatorKeyValueMaintenanceStores.clear(); },
    async collectNow() {
      stopCoordinatorKeyValueMaintenance();
      await coordinatorKvGcRunning?.catch(() => undefined);
      await collectCoordinatorKeyValueGarbage({ minAgeMs: 0, maxDeletes: COORDINATOR_KV_GC_MAX_DELETES }, false);
      scheduleCoordinatorKeyValueMaintenance();
    },
  };
}
