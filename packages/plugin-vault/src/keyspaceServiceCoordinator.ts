import type { KeyIdentity, KeyScopedStorageHandle, KeyScopedStorageOpenInput, KeyspaceService, CoordinatorValueResult, SessionCoordinatorClient } from "@keymaster/contracts";
import type { SessionStateMirror } from "./sessionStateMirror.js";

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

export function createKeyspaceServiceCoordinator(client: CoordinatorClientLike, mirror: SessionStateMirror): KeyspaceService {
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
    async setActive() { throw new Error("Active key changes must go through vault.activateKey with password"); },
    requireActiveKey: () => { const publicKeyHex = requireReady(); return { publicKeyHex, label: "", capabilities: [], createdAt: "" }; },
    onActiveKeyChanged(handler) { const snapshot = current(); handlers.add(handler); handler({ activePublicKeyHex: snapshot.activePublicKeyHex, generation: snapshot.keyspaceGeneration }); return () => handlers.delete(handler); },
    async openKeyStorage(input: KeyScopedStorageOpenInput): Promise<KeyScopedStorageHandle> { const key = input.publicKeyHex || requireReady(); const name = `keymaster.key.${key}.plugin.${input.pluginId}.${input.storageId}`; const db = await new Promise<IDBDatabase>((resolve, reject) => { const req = indexedDB.open(name, input.version); req.onupgradeneeded = () => input.upgrade(req.result, req.transaction?.db.version ?? 0, input.version); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); const set = openHandles.get(key) ?? new Set<IDBDatabase>(); set.add(db); openHandles.set(key, set); return { db, name, close: () => { db.close(); set.delete(db); } }; },
    registerPluginStorage(input) { if (!storages.some((s) => s.pluginId === input.pluginId && s.storageId === input.storageId)) storages.push(input); },
    listPluginStorages: () => [...storages],
    async prepareDeleteKey(publicKeyHex) { await client.backgroundCancelByKey(publicKeyHex); for (const db of openHandles.get(publicKeyHex) ?? []) db.close(); openHandles.delete(publicKeyHex); },
    async deleteKey(input) { unwrap<void>(await client.vaultOperation("deleteKey", input), "deleteKey"); },
    isInitializing: () => false,
    onInitializationChange: () => () => undefined
  };
}
