import type { KeyIdentity, KeyScopedStorageHandle, KeyScopedStorageOpenInput, KeyspaceService, CoordinatorValueResult, SessionCoordinatorClient } from "@keymaster/contracts";
import type { SessionStateMirror } from "./sessionStateMirror.js";
import type { MessageBus } from "@keymaster/runtime";

type CoordinatorClientLike = Pick<
  SessionCoordinatorClient,
  "backgroundCancelByKey" | "vaultOperation"
>;

function unwrap<T>(result: CoordinatorValueResult<unknown>, operation: string): T {
  if (result.status === "ok") return result.value as T;
  const message = "message" in result
    ? result.message
    : result.status === "blocked"
      ? (typeof result.reason === "string" ? result.reason : result.reason.fallback)
      : `${operation} failed: ${result.status}`;
  throw new Error(message);
}

export function createKeyspaceServiceCoordinator(client: CoordinatorClientLike, mirror: SessionStateMirror, messageBus: MessageBus): KeyspaceService {
  let state = mirror.getSnapshot();
  const handlers = new Set<(value: { activePublicKeyHex?: string; generation?: number }) => void>();
  const storages: Array<{ pluginId: string; storageId: string }> = [];
  const openHandles = new Map<string, Set<IDBDatabase>>();
  mirror.subscribe((snapshot) => { const previous = state.activePublicKeyHex; const previousGeneration = state.keyspaceGeneration; state = snapshot; if (previous !== state.activePublicKeyHex || previousGeneration !== state.keyspaceGeneration) for (const h of handlers) h({ activePublicKeyHex: state.activePublicKeyHex, generation: state.keyspaceGeneration }); });
  // Synchronous reads must observe the Mirror's already-committed snapshot,
  // even while an earlier facade listener is running in this same dispatch turn.
  const current = () => mirror.getSnapshot();
  const requireReady = () => { const snapshot = current(); if (snapshot.vaultStatus !== "unlocked" || !snapshot.activePublicKeyHex) throw new Error("Active key is unavailable"); return snapshot.activePublicKeyHex; };
  return {
    async listKeys() { return unwrap<KeyIdentity[]>(await client.vaultOperation("listKeys"), "listKeys"); },
    async getKey(publicKeyHex) { return unwrap<KeyIdentity | undefined>(await client.vaultOperation("getKey", { publicKeyHex }), "getKey"); },
    active: () => ({ activePublicKeyHex: current().activePublicKeyHex }),
    selected: () => current().selectedPublicKeyHex,
    async setActive() { throw new Error("Active key changes must go through vault.activateKey with password"); },
    requireActiveKey: () => { const publicKeyHex = requireReady(); return { publicKeyHex, label: "", capabilities: [], createdAt: "" }; },
    onActiveKeyChanged(handler) { const snapshot = current(); handlers.add(handler); handler({ activePublicKeyHex: snapshot.activePublicKeyHex, generation: snapshot.keyspaceGeneration }); return () => handlers.delete(handler); },
    async openKeyStorage(input: KeyScopedStorageOpenInput): Promise<KeyScopedStorageHandle> {
      const key = input.publicKeyHex || requireReady();
      const name = `keymaster.key.${key}.plugin.${input.pluginId}.${input.storageId}`;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(name, input.version);
        req.onupgradeneeded = (event) => input.upgrade(req.result, (event as IDBVersionChangeEvent).oldVersion, input.version, req.transaction ?? undefined);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const set = openHandles.get(key) ?? new Set<IDBDatabase>();
      openHandles.set(key, set);
      let closed = false;
      let handle: KeyScopedStorageHandle;
      const removeTracking = () => {
        set.delete(db);
        if (set.size === 0 && openHandles.get(key) === set) openHandles.delete(key);
      };
      const onVersionChange = () => {
        if (closed) return;
        closed = true;
        removeTracking();
        try { db.close(); } catch { /* noop */ }
      };
      db.addEventListener("versionchange", onVersionChange);
      set.add(db);
      handle = {
        db,
        name,
        close() {
          if (closed) return;
          closed = true;
          db.removeEventListener("versionchange", onVersionChange);
          try { db.close(); } catch { /* noop */ }
          removeTracking();
        }
      };
      return handle;
    },
    registerPluginStorage(input) { if (!storages.some((s) => s.pluginId === input.pluginId && s.storageId === input.storageId)) storages.push(input); },
    listPluginStorages: () => [...storages],
    async prepareDeleteKey(publicKeyHex) { await prepareDeleteKeyInternal(publicKeyHex); },
    async deleteKey(input) {
      const keys = unwrap<KeyIdentity[]>(await client.vaultOperation("listKeys"), "listKeys");
      const target = keys.find((key) => key.publicKeyHex === input.publicKeyHex);
      if (!target) throw new Error("Key not found");
      if (!target.label) throw new Error("Key label is unavailable");
      if (input.confirmationLabel !== target.label) throw new Error("Key label mismatch");
      await prepareDeleteKeyInternal(input.publicKeyHex);
      for (const storage of storages) {
        const name = `keymaster.key.${input.publicKeyHex}.plugin.${storage.pluginId}.${storage.storageId}`;
        await deleteNamespaceDatabase(name);
      }
      unwrap<void>(await client.vaultOperation("deleteKeyMaterial", { publicKeyHex: input.publicKeyHex }), "deleteKeyMaterial");
      messageBus.publish("key.deleted", { publicKeyHex: input.publicKeyHex });
      const remaining = await unwrap<KeyIdentity[]>(await client.vaultOperation("listKeys"), "listKeys");
      if (remaining.length === 0) unwrap<void>(await client.vaultOperation("finalizeEmptyVaultAfterLastKeyDeletion"), "finalizeEmptyVaultAfterLastKeyDeletion");
    },
    isInitializing: () => false,
    onInitializationChange: () => () => undefined
  };

  async function prepareDeleteKeyInternal(publicKeyHex: string): Promise<void> {
    const cancelResult = await client.backgroundCancelByKey(publicKeyHex);
    if (cancelResult.status !== "accepted" && cancelResult.status !== "ok") {
      throw new Error("Background cancellation failed");
    }
    for (const db of openHandles.get(publicKeyHex) ?? []) db.close();
    openHandles.delete(publicKeyHex);
    messageBus.publish("key.deleting", { publicKeyHex });
  }
}

/** Wait for IndexedDB deleteDatabase's real terminal event. onblocked is
 * informational: the request remains live and may succeed once handles close. */
function deleteNamespaceDatabase(name: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) console.warn(`[keyspace-coordinator] deleteDatabase still blocked`, name);
    }, 5000);
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } };
    req.onerror = () => { if (!settled) { settled = true; clearTimeout(timer); reject(req.error ?? new Error("Namespace delete failed")); } };
    req.onblocked = () => { /* wait for success/error; IDB has no abort */ };
  });
}
