import type { BsvNetwork, KeyspaceService, PluginLogger } from "@keymaster/contracts";
import type {
  P2pkhKeyResource,
  P2pkhLocalInputClaim, P2pkhLocalOutpoint,
  P2pkhLocalTransaction, P2pkhMigrationAudit, P2pkhOwnedOutpointProjection, P2pkhProtocolSubmission,
  P2pkhTransactionFact,
  P2pkhTransactionSyncState, P2pkhUtxo,
} from "./p2pkhContracts.js";
import { makeResourceId } from "./p2pkhContracts.js";
import { ownedP2pkhOutputs, parseP2pkhTransaction } from "./p2pkhTransactionParser.js";

export const P2PKH_DB_VERSION = 16;
const P2PKH_STORAGE_ID = "state";
const STORE_PREFIX = "p2pkh_";

export interface P2pkhDbBundle { close(): void; getDb(): IDBDatabase; publicKeyHex: string; }
export interface P2pkhInputOutpoint { txid: string; vout: number; }
const openHandles = new Map<string, P2pkhDbBundle>();

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed")); });
}

function runTransaction<T>(handle: P2pkhDbBundle, stores: string | string[], mode: IDBTransactionMode, body: (tx: IDBTransaction) => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction; let value: T; let bodyDone = false;
    try {
      tx = handle.getDb().transaction(stores, mode);
      void body(tx).then((result) => { value = result; bodyDone = true; }, (error) => { try { tx.abort(); } catch { /* preserve error */ } reject(error); });
      tx.oncomplete = () => { if (bodyDone) resolve(value!); };
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    } catch (error) { reject(error); }
  });
}

function all<T>(store: IDBObjectStore | IDBIndex): Promise<T[]> { return request(store.getAll()) as Promise<T[]>; }
function allByKey<T>(store: IDBObjectStore | IDBIndex, key: IDBValidKey | IDBKeyRange): Promise<T[]> { return request(store.getAll(key)) as Promise<T[]>; }
function getById<T>(store: IDBObjectStore, id: IDBValidKey): Promise<T | undefined> { return request(store.get(id)) as Promise<T | undefined>; }
function pageByCursor<T>(store: IDBObjectStore | IDBIndex, query: IDBValidKey | IDBKeyRange | null, direction: IDBCursorDirection, limit: number): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const rows: T[] = [];
    const cursorRequest = store.openCursor(query, direction);
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor || rows.length >= limit) { resolve(rows); return; }
      rows.push(cursor.value as T);
      cursor.continue();
    };
    cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error("IndexedDB cursor failed"));
  });
}
function encodePageCursor(key: IDBValidKey): string { return encodeURIComponent(JSON.stringify(key)); }
function decodePageCursor(cursor: string | undefined): IDBValidKey | undefined {
  if (!cursor) return undefined;
  try {
    const value = JSON.parse(decodeURIComponent(cursor)) as unknown;
    return Array.isArray(value) || typeof value === "string" || typeof value === "number" ? value as IDBValidKey : undefined;
  } catch { return undefined; }
}
function pageByIndex<T>(index: IDBIndex, resourceId: string, cursor: string | undefined, limit: number): Promise<{ items: T[]; nextCursor?: string }> {
  const after = decodePageCursor(cursor);
  const lower = [resourceId, "", ""] as IDBValidKey;
  const firstQuery = IDBKeyRange.bound(lower, [resourceId, "\uffff", "\uffff"]);
  const query = after === undefined ? firstQuery : IDBKeyRange.bound(lower, after, false, true);
  return new Promise((resolve, reject) => {
    const rows: T[] = [];
    let lastKey: IDBValidKey | undefined;
    let checkingMore = false;
    const cursorRequest = index.openCursor(query, "prev");
    cursorRequest.onsuccess = () => {
      const current = cursorRequest.result;
    if (!current) { resolve({ items: rows }); return; }
      if (checkingMore) { resolve({ items: rows, nextCursor: encodePageCursor(lastKey!) }); return; }
      rows.push(current.value as T);
      lastKey = current.key;
      if (rows.length >= limit) checkingMore = true;
      current.continue();
    };
    cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error("IndexedDB cursor failed"));
  });
}
function boundedLimit(value: number | undefined): number | undefined {
  if (!Number.isFinite(value) || value === undefined) return undefined;
  return Math.max(1, Math.min(1_000, Math.floor(value)));
}

function createFreshV10Stores(db: IDBDatabase): void {
  for (const name of [...db.objectStoreNames].filter((name) => name.startsWith(STORE_PREFIX))) db.deleteObjectStore(name);
  const address = db.createObjectStore("p2pkh_addresses", { keyPath: "resourceId" });
  address.createIndex("publicKeyHex", "publicKeyHex"); address.createIndex("network", "network"); address.createIndex("address", "address", { unique: true });
  const facts = db.createObjectStore("p2pkh_transactions", { keyPath: "id" });
  facts.createIndex("resourceId", "resourceId"); facts.createIndex("resourceBlockHeight", ["resourceId", "blockHeight"]); facts.createIndex("resourceTxid", ["resourceId", "txid"]); facts.createIndex("resourceTimeline", ["resourceId", "lastConfirmedAt", "txid"]); facts.createIndex("inputOutpointKeys", "inputOutpointKeys", { multiEntry: true }); facts.createIndex("ownedOutpointKeys", "ownedOutpointKeys", { multiEntry: true }); facts.createIndex("txid", "txid");
  const owned = db.createObjectStore("p2pkh_owned_outpoints", { keyPath: "id" });
  owned.createIndex("resourceChainState", ["resourceId", "chainState"]); owned.createIndex("chainState", "chainState"); owned.createIndex("resourceTxid", ["resourceId", "txid"]); owned.createIndex("resourceTimeline", ["resourceId", "updatedAt", "outpointKey"]); owned.createIndex("resourceOutpointKey", ["resourceId", "outpointKey"]); owned.createIndex("outpointKey", "outpointKey"); owned.createIndex("spentByTxid", "spentByTxid"); owned.createIndex("resourceCreatedBlockHeight", ["resourceId", "createdBlockHeight"]);
  const sync = db.createObjectStore("p2pkh_transaction_sync", { keyPath: "id" }); sync.createIndex("resourceId", "resourceId", { unique: true });
  const local = db.createObjectStore("p2pkh_local_transactions", { keyPath: "id" });
  local.createIndex("resourceId", "resourceId"); local.createIndex("resourceChainResolution", ["resourceId", "chainResolution"]); local.createIndex("resourceTxid", ["resourceId", "txid"]); local.createIndex("resourceTimeline", ["resourceId", "updatedAt", "id"]); local.createIndex("txid", "txid"); local.createIndex("inputOutpointKeys", "inputOutpointKeys", { multiEntry: true }); local.createIndex("parentTxids", "parentTxids", { multiEntry: true });
  const localOut = db.createObjectStore("p2pkh_local_outpoints", { keyPath: "id" }); localOut.createIndex("resourceId", "resourceId"); localOut.createIndex("resourceTimeline", ["resourceId", "updatedAt", "id"]); localOut.createIndex("submissionId", "submissionId"); localOut.createIndex("state", "state"); localOut.createIndex("outpointKey", ["txid", "vout"]);
  const claims = db.createObjectStore("p2pkh_local_input_claims", { keyPath: "id" }); claims.createIndex("resourceId", "resourceId"); claims.createIndex("resourceTimeline", ["resourceId", "updatedAt", "id"]); claims.createIndex("outpointKey", "outpointKey"); claims.createIndex("submissionId", "submissionId"); claims.createIndex("state", "state");
  const protocol = db.createObjectStore("p2pkh_protocol_submissions", { keyPath: "id" }); protocol.createIndex("resourceId", "resourceId");
  const audit = db.createObjectStore("p2pkh_migration_audits", { keyPath: "id" }); audit.createIndex("resourceId", "resourceId"); audit.createIndex("createdAt", "createdAt");
}

function ensureIndex(store: IDBObjectStore, name: string, keyPath: string | string[], options?: IDBIndexParameters): void {
  if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, options);
}

function createMigrationStores(db: IDBDatabase, transaction: IDBTransaction): void {
  const address = db.objectStoreNames.contains("p2pkh_addresses") ? undefined : db.createObjectStore("p2pkh_addresses", { keyPath: "resourceId" });
  if (address) { address.createIndex("publicKeyHex", "publicKeyHex"); address.createIndex("network", "network"); address.createIndex("address", "address", { unique: true }); }
  if (db.objectStoreNames.contains("p2pkh_addresses")) {
    const store = transaction.objectStore("p2pkh_addresses");
    ensureIndex(store, "publicKeyHex", "publicKeyHex"); ensureIndex(store, "network", "network"); ensureIndex(store, "address", "address", { unique: true });
  }
  const facts = db.createObjectStore("p2pkh_transactions", { keyPath: "id" }); facts.createIndex("resourceId", "resourceId"); facts.createIndex("resourceBlockHeight", ["resourceId", "blockHeight"]); facts.createIndex("resourceTxid", ["resourceId", "txid"]); facts.createIndex("resourceTimeline", ["resourceId", "lastConfirmedAt", "txid"]); facts.createIndex("inputOutpointKeys", "inputOutpointKeys", { multiEntry: true }); facts.createIndex("ownedOutpointKeys", "ownedOutpointKeys", { multiEntry: true }); facts.createIndex("txid", "txid");
  const owned = db.createObjectStore("p2pkh_owned_outpoints", { keyPath: "id" }); owned.createIndex("resourceChainState", ["resourceId", "chainState"]); owned.createIndex("chainState", "chainState"); owned.createIndex("resourceTxid", ["resourceId", "txid"]); owned.createIndex("resourceTimeline", ["resourceId", "updatedAt", "outpointKey"]); owned.createIndex("resourceOutpointKey", ["resourceId", "outpointKey"]); owned.createIndex("outpointKey", "outpointKey"); owned.createIndex("spentByTxid", "spentByTxid"); owned.createIndex("resourceCreatedBlockHeight", ["resourceId", "createdBlockHeight"]);
  const sync = db.createObjectStore("p2pkh_transaction_sync", { keyPath: "id" }); sync.createIndex("resourceId", "resourceId", { unique: true });
  const local = db.createObjectStore("p2pkh_local_transactions", { keyPath: "id" }); local.createIndex("resourceId", "resourceId"); local.createIndex("resourceChainResolution", ["resourceId", "chainResolution"]); local.createIndex("resourceTxid", ["resourceId", "txid"]); local.createIndex("resourceTimeline", ["resourceId", "updatedAt", "id"]); local.createIndex("txid", "txid"); local.createIndex("inputOutpointKeys", "inputOutpointKeys", { multiEntry: true }); local.createIndex("parentTxids", "parentTxids", { multiEntry: true });
  const localOut = db.createObjectStore("p2pkh_local_outpoints", { keyPath: "id" }); localOut.createIndex("resourceId", "resourceId"); localOut.createIndex("resourceTimeline", ["resourceId", "updatedAt", "id"]); localOut.createIndex("submissionId", "submissionId"); localOut.createIndex("state", "state"); localOut.createIndex("outpointKey", ["txid", "vout"]);
  if (!db.objectStoreNames.contains("p2pkh_local_input_claims")) { const claims = db.createObjectStore("p2pkh_local_input_claims", { keyPath: "id" }); claims.createIndex("resourceId", "resourceId"); claims.createIndex("resourceTimeline", ["resourceId", "updatedAt", "id"]); claims.createIndex("outpointKey", "outpointKey"); claims.createIndex("submissionId", "submissionId"); claims.createIndex("state", "state"); }
  else { const claims = transaction.objectStore("p2pkh_local_input_claims"); ensureIndex(claims, "resourceId", "resourceId"); ensureIndex(claims, "resourceTimeline", ["resourceId", "updatedAt", "id"]); ensureIndex(claims, "outpointKey", "outpointKey"); ensureIndex(claims, "submissionId", "submissionId"); ensureIndex(claims, "state", "state"); }
  if (!db.objectStoreNames.contains("p2pkh_protocol_submissions")) { const protocol = db.createObjectStore("p2pkh_protocol_submissions", { keyPath: "id" }); protocol.createIndex("resourceId", "resourceId"); }
  else ensureIndex(transaction.objectStore("p2pkh_protocol_submissions"), "resourceId", "resourceId");
  if (!db.objectStoreNames.contains("p2pkh_migration_audits")) { const audit = db.createObjectStore("p2pkh_migration_audits", { keyPath: "id" }); audit.createIndex("resourceId", "resourceId"); audit.createIndex("createdAt", "createdAt"); }
  else { const audit = transaction.objectStore("p2pkh_migration_audits"); ensureIndex(audit, "resourceId", "resourceId"); ensureIndex(audit, "createdAt", "createdAt"); }
}

function migrateV9ToV10(db: IDBDatabase, transaction?: IDBTransaction): void {
  if (!transaction) throw new Error("P2PKH v10 migration requires a versionchange transaction");
  const oldNames = ["p2pkh_addresses", "p2pkh_local_submissions", "p2pkh_local_input_claims", "p2pkh_protocol_submissions"];
  const snapshots: Record<string, unknown[]> = {};
  const pending = oldNames.filter((name) => db.objectStoreNames.contains(name));
  if (pending.length === 0) { createFreshV10Stores(db); return; }
  createMigrationStores(db, transaction);
  let remaining = pending.length;
  const finish = () => {
    if (remaining !== 0) return;
    const address = transaction.objectStore("p2pkh_addresses"); for (const row of snapshots.p2pkh_addresses ?? []) address.put(row);
    const claims = transaction.objectStore("p2pkh_local_input_claims"); for (const row of snapshots.p2pkh_local_input_claims ?? []) { const old = row as { txid?: unknown; vout?: unknown; state?: unknown }; const state = old.state === "claimed" ? "active" : old.state === "observed-consumed" ? "isolated" : ["active", "isolated", "released", "confirmed"].includes(String(old.state)) ? old.state : "isolated"; claims.put({ ...(row as object), state, outpointKey: `${String(old.txid ?? "")}:${Number(old.vout ?? 0)}` }); }
    const protocol = transaction.objectStore("p2pkh_protocol_submissions"); for (const row of snapshots.p2pkh_protocol_submissions ?? []) protocol.put(row);
    const local = transaction.objectStore("p2pkh_local_transactions");
    const audits = transaction.objectStore("p2pkh_migration_audits");
    for (const [index, raw] of (snapshots.p2pkh_local_submissions ?? []).entries()) {
      const old = raw as { id?: string; resourceId?: string; publicKeyHex?: string; network?: BsvNetwork; canonicalTxid?: string; rawTxHex?: string; inputOutpoints?: Array<{ txid: string; vout: number }>; createdAt?: string; updatedAt?: string };
      const missingFields = [
        ...(!old.resourceId ? ["resourceId"] : []),
        ...(!old.canonicalTxid ? ["txid"] : []),
        ...(typeof old.rawTxHex !== "string" || !old.rawTxHex ? ["rawTxHex"] : []),
        ...(!Array.isArray(old.inputOutpoints) ? ["inputOutpoints"] : [])
      ];
      if (missingFields.length > 0) audits.put({ id: `legacy-migration-audit:${old.id ?? index}`, source: "p2pkh_local_submissions", ...(old.id ? { legacyId: old.id } : {}), ...(old.resourceId ? { resourceId: old.resourceId } : {}), reason: !old.resourceId ? "missing-resource-id" : "missing-transaction-fields", missingFields, createdAt: new Date().toISOString() } satisfies P2pkhMigrationAudit);
      if (!old.resourceId) continue;
      const id = old.id ?? `legacy-migration-${index}`;
      const canonicalTxid = old.canonicalTxid ?? id;
      const rawTxHex = typeof old.rawTxHex === "string" ? old.rawTxHex : "";
      const reason = old.canonicalTxid && rawTxHex ? "legacy-migration" : "legacy-migration-incomplete";
      local.put({ id, resourceId: old.resourceId, publicKeyHex: old.publicKeyHex ?? "", network: old.network ?? "main", txid: canonicalTxid, rawTxHex, localState: "isolated", chainResolution: "unresolved", inputOutpointKeys: (old.inputOutpoints ?? []).map((i) => `${i.txid}:${i.vout}`), ownOutputs: [], parentTxids: [], createdAt: old.createdAt ?? new Date(0).toISOString(), updatedAt: old.updatedAt ?? new Date().toISOString(), isolationReason: reason, attempts: [] } satisfies P2pkhLocalTransaction);
    }
    for (const name of ["p2pkh_utxos", "p2pkh_history", "p2pkh_history_backfill", "p2pkh_recent_sync", "p2pkh_local_submissions"]) if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
  };
  for (const name of pending) {
    const req = transaction.objectStore(name).getAll();
    req.onsuccess = () => { snapshots[name] = (req.result as unknown[]) ?? []; remaining -= 1; finish(); };
    req.onerror = () => transaction.abort();
  }
}

function migrateV10ToV11(db: IDBDatabase, transaction?: IDBTransaction): void {
  if (!transaction) throw new Error("P2PKH v11 migration requires a versionchange transaction");
  if (!db.objectStoreNames.contains("p2pkh_owned_outpoints")) throw new Error("P2PKH v11 migration requires owned outpoints store");
  ensureIndex(transaction.objectStore("p2pkh_owned_outpoints"), "chainState", "chainState");
  if (db.objectStoreNames.contains("p2pkh_local_outpoints")) ensureIndex(transaction.objectStore("p2pkh_local_outpoints"), "submissionId", "submissionId");
}

function migrateV11ToV12(db: IDBDatabase, transaction?: IDBTransaction): void {
  if (!transaction) throw new Error("P2PKH v12 migration requires a versionchange transaction");
  if (!db.objectStoreNames.contains("p2pkh_transactions")) throw new Error("P2PKH v12 migration requires transactions store");
  ensureIndex(transaction.objectStore("p2pkh_transactions"), "resourceTxid", ["resourceId", "txid"]);
  if (db.objectStoreNames.contains("p2pkh_owned_outpoints")) ensureIndex(transaction.objectStore("p2pkh_owned_outpoints"), "resourceTxid", ["resourceId", "txid"]);
}

function migrateV12ToV13(db: IDBDatabase, transaction?: IDBTransaction): void {
  if (!transaction) throw new Error("P2PKH v13 migration requires a versionchange transaction");
  if (db.objectStoreNames.contains("p2pkh_transactions")) ensureIndex(transaction.objectStore("p2pkh_transactions"), "resourceTimeline", ["resourceId", "lastConfirmedAt", "txid"]);
  if (db.objectStoreNames.contains("p2pkh_owned_outpoints")) ensureIndex(transaction.objectStore("p2pkh_owned_outpoints"), "resourceTimeline", ["resourceId", "updatedAt", "outpointKey"]);
}

function migrateV13ToV14(db: IDBDatabase, transaction?: IDBTransaction): void {
  if (!transaction) throw new Error("P2PKH v14 migration requires a versionchange transaction");
  if (db.objectStoreNames.contains("p2pkh_owned_outpoints")) ensureIndex(transaction.objectStore("p2pkh_owned_outpoints"), "resourceOutpointKey", ["resourceId", "outpointKey"]);
  if (db.objectStoreNames.contains("p2pkh_local_transactions")) ensureIndex(transaction.objectStore("p2pkh_local_transactions"), "resourceTimeline", ["resourceId", "updatedAt", "id"]);
  if (db.objectStoreNames.contains("p2pkh_local_outpoints")) ensureIndex(transaction.objectStore("p2pkh_local_outpoints"), "resourceTimeline", ["resourceId", "updatedAt", "id"]);
  if (db.objectStoreNames.contains("p2pkh_local_input_claims")) ensureIndex(transaction.objectStore("p2pkh_local_input_claims"), "resourceTimeline", ["resourceId", "updatedAt", "id"]);
}

function migrateV14ToV15(db: IDBDatabase, transaction?: IDBTransaction): void {
  if (!transaction) throw new Error("P2PKH v15 migration requires a versionchange transaction");
  if (db.objectStoreNames.contains("p2pkh_migration_audits")) return;
  const audit = db.createObjectStore("p2pkh_migration_audits", { keyPath: "id" });
  audit.createIndex("resourceId", "resourceId");
  audit.createIndex("createdAt", "createdAt");
}

function migrateV15ToV16(db: IDBDatabase, transaction?: IDBTransaction): void {
  if (!transaction) throw new Error("P2PKH v16 migration requires a versionchange transaction");
  if (!db.objectStoreNames.contains("p2pkh_local_transactions")) return;
  const local = transaction.objectStore("p2pkh_local_transactions");
  ensureIndex(local, "resourceChainResolution", ["resourceId", "chainResolution"]);
  ensureIndex(local, "resourceTxid", ["resourceId", "txid"]);
  const facts = db.objectStoreNames.contains("p2pkh_transactions") ? transaction.objectStore("p2pkh_transactions") : undefined;
  const localRequest = local.getAll();
  const factRequest = facts?.getAll();
  const migrate = (): void => {
    if (localRequest.readyState !== "done" || (factRequest && factRequest.readyState !== "done")) return;
    const factsByKey = new Set(((factRequest?.result as Array<{ resourceId?: string; txid?: string }> | undefined) ?? []).map((row) => `${row.resourceId}:${row.txid}`));
    for (const raw of (localRequest.result as Array<Record<string, unknown>> | undefined) ?? []) {
      const oldState = String(raw.state ?? "isolated");
      const validPrevious = (value: unknown): "prepared" | "submitting" | "local-confirmed" | "isolated" | undefined =>
        value === "prepared" || value === "submitting" || value === "local-confirmed" || value === "isolated" ? value : undefined;
      let localState: "prepared" | "submitting" | "local-confirmed" | "isolated";
      let chainResolution: "unresolved" | "chain-confirmed" | "conflicted";
      if (oldState === "chain-confirmed") {
        localState = validPrevious(raw.chainConfirmationPreviousState) ?? "isolated";
        chainResolution = "chain-confirmed";
      } else if (oldState === "conflicted") {
        localState = validPrevious(raw.conflictPreviousState) ?? validPrevious(raw.chainConfirmationPreviousState) ?? "isolated";
        chainResolution = "conflicted";
      } else {
        localState = validPrevious(oldState) ?? "isolated";
        chainResolution = "unresolved";
      }
      const { state: _state, chainConfirmationPreviousState: _chainPrevious, conflictPreviousState: _conflictPrevious, ...rest } = raw;
      const row: Record<string, unknown> = { ...rest, localState, chainResolution };
      if (chainResolution === "chain-confirmed" && typeof raw.resourceId === "string" && typeof raw.txid === "string" && factsByKey.has(`${raw.resourceId}:${raw.txid}`)) row.confirmedFactId = `${raw.resourceId}:${raw.txid}`;
      local.put(row);
    }
  };
  localRequest.onsuccess = migrate;
  if (factRequest) factRequest.onsuccess = migrate;
}

export function namespaceDbName(publicKeyHex: string): string { return `keymaster.key.${publicKeyHex}.plugin.p2pkh.state`; }

export async function openP2pkhDb(input: { keyspace: KeyspaceService; publicKeyHex: string; logger?: PluginLogger }): Promise<P2pkhDbBundle> {
  const cached = openHandles.get(input.publicKeyHex); if (cached) return cached;
  const handle = await input.keyspace.openKeyStorage({ publicKeyHex: input.publicKeyHex, pluginId: "p2pkh", storageId: P2PKH_STORAGE_ID, version: P2PKH_DB_VERSION, upgrade(db, oldVersion, _newVersion, transaction) {
    if (oldVersion === 0) createFreshV10Stores(db);
    else if (oldVersion <= 9) migrateV9ToV10(db, transaction);
    else if (oldVersion === 10) {
      // IndexedDB invokes one upgrade callback for a 10 -> 15 jump. Apply all
      // intermediate schema steps in that same versionchange transaction.
      migrateV10ToV11(db, transaction);
      migrateV11ToV12(db, transaction);
      migrateV12ToV13(db, transaction);
      migrateV13ToV14(db, transaction);
      migrateV14ToV15(db, transaction);
      migrateV15ToV16(db, transaction);
    } else if (oldVersion === 11) {
      migrateV11ToV12(db, transaction);
      migrateV12ToV13(db, transaction);
      migrateV13ToV14(db, transaction);
      migrateV14ToV15(db, transaction);
      migrateV15ToV16(db, transaction);
    }
    else if (oldVersion === 12) { migrateV12ToV13(db, transaction); migrateV13ToV14(db, transaction); migrateV14ToV15(db, transaction); migrateV15ToV16(db, transaction); }
    else if (oldVersion === 13) { migrateV13ToV14(db, transaction); migrateV14ToV15(db, transaction); migrateV15ToV16(db, transaction); }
    else if (oldVersion === 14) { migrateV14ToV15(db, transaction); migrateV15ToV16(db, transaction); }
    else if (oldVersion === 15) migrateV15ToV16(db, transaction);
    else throw new Error(`P2PKH database version ${oldVersion} is newer than supported version ${P2PKH_DB_VERSION}`);
  } });
  let closed = false; const bundle: P2pkhDbBundle = { publicKeyHex: input.publicKeyHex, getDb: () => handle.db, close: () => { if (closed) return; closed = true; handle.close(); if (openHandles.get(input.publicKeyHex) === bundle) openHandles.delete(input.publicKeyHex); } };
  handle.db.addEventListener("versionchange", () => bundle.close()); openHandles.set(input.publicKeyHex, bundle); input.logger?.info({ scope: "p2pkh.db", event: "schema.ready", message: `P2PKH v${P2PKH_DB_VERSION} namespace ready`, data: { version: P2PKH_DB_VERSION } }); return bundle;
}
export function disposeP2pkhDb(publicKeyHex?: string): void { if (publicKeyHex) openHandles.get(publicKeyHex)?.close(); else for (const bundle of [...openHandles.values()]) bundle.close(); }

function resourceKey(resourceId: string, txid: string): string { return `${resourceId}:${txid}`; }
function outpointId(resourceId: string, txid: string, vout: number): string { return `${resourceId}:${txid}:${vout}`; }
function claimId(resourceId: string, txid: string, vout: number): string { return `${resourceId}:${txid}:${vout}`; }

async function rebuildOwnedProjectionInTransaction(
  tx: IDBTransaction,
  resourceId: string,
  facts: P2pkhTransactionFact[],
  now: string
): Promise<void> {
  const ownedStore = tx.objectStore("p2pkh_owned_outpoints");
  const existingOwned = [
    ...await allByKey<P2pkhOwnedOutpointProjection>(ownedStore.index("resourceChainState"), [resourceId, "available"]),
    ...await allByKey<P2pkhOwnedOutpointProjection>(ownedStore.index("resourceChainState"), [resourceId, "spent"])
  ];
  for (const row of existingOwned) await request(ownedStore.delete(row.id));
  const byOutpoint = new Map<string, P2pkhOwnedOutpointProjection>();
  for (const fact of facts.filter((candidate) => candidate.resourceId === resourceId)) {
    for (const output of fact.ownedOutputs) {
      const key = `${fact.txid}:${output.vout}`;
      byOutpoint.set(`${resourceId}:${key}`, {
        id: outpointId(resourceId, fact.txid, output.vout),
        resourceId,
        publicKeyHex: fact.publicKeyHex,
        network: fact.network,
        address: fact.address,
        txid: fact.txid,
        vout: output.vout,
        outpointKey: key,
        value: output.value,
        scriptHex: output.scriptHex,
        chainState: "available",
        createdBlockHeight: fact.blockHeight,
        updatedAt: now
      });
    }
  }
  const factByTxid = new Map(facts.filter((candidate) => candidate.resourceId === resourceId).map((fact) => [fact.txid, fact]));
  for (const fact of factByTxid.values()) {
    for (const key of fact.inputOutpointKeys) {
      const row = byOutpoint.get(`${resourceId}:${key}`);
      if (!row || row.txid === fact.txid) continue;
      const previousSpender = row.spentByTxid ? factByTxid.get(row.spentByTxid) : undefined;
      if (!previousSpender || (fact.blockHeight ?? -1) >= (previousSpender.blockHeight ?? -1)) {
        row.chainState = "spent";
        row.spentByTxid = fact.txid;
        row.spentBlockHeight = fact.blockHeight;
      }
    }
  }
  for (const row of byOutpoint.values()) await request(ownedStore.put(row));
}

/**
 * Keep duplicate physical local outputs as audit rows while enforcing one
 * logical spendability result per resource/outpoint. This is intentionally
 * called inside the caller's readwrite transaction after every local write.
 */
async function normalizeLocalOutputGroupsInTransaction(tx: IDBTransaction, resourceId: string, now: string, affectedOutpointKeys: Iterable<string>): Promise<void> {
  const localStore = tx.objectStore("p2pkh_local_transactions");
  const outputStore = tx.objectStore("p2pkh_local_outpoints");
  const outputIndex = outputStore.index("outpointKey");
  const inputIndex = localStore.index("inputOutpointKeys");
  const keys = [...new Set([...affectedOutpointKeys].filter((key) => key.includes(":")))];
  for (const outpointKey of keys) {
    const separator = outpointKey.lastIndexOf(":");
    const txid = outpointKey.slice(0, separator);
    const vout = Number(outpointKey.slice(separator + 1));
    if (!Number.isSafeInteger(vout) || vout < 0) continue;
    const group = (await allByKey<P2pkhLocalOutpoint>(outputIndex, [txid, vout])).filter((row) => row.resourceId === resourceId);
    if (group.length === 0) continue;
    const localById = new Map<string, P2pkhLocalTransaction>();
    for (const output of group) {
      const local = await getById<P2pkhLocalTransaction>(localStore, output.submissionId);
      if (local?.resourceId === resourceId) localById.set(local.id, local);
    }
    const children = (await allByKey<P2pkhLocalTransaction>(inputIndex, outpointKey)).filter((row) => row.resourceId === resourceId);
    const hasIsolatedChild = children.some((row) => row.chainResolution === "unresolved" && row.localState === "isolated");
    const hasUnresolvedChild = children.some((row) => row.chainResolution === "unresolved" && row.localState !== "isolated");
    const mutable = group.filter((output) => output.state !== "isolated" && output.state !== "invalidated");
    if (hasIsolatedChild) {
      for (const output of mutable) { output.state = "isolated"; output.updatedAt = now; }
    } else if (hasUnresolvedChild) {
      for (const output of mutable) { output.state = "claimed"; output.updatedAt = now; }
    } else {
      const eligible = mutable
        .filter((output) => localById.get(output.submissionId)?.localState === "local-confirmed" && localById.get(output.submissionId)?.chainResolution === "unresolved")
        .sort((left, right) => left.id.localeCompare(right.id));
      const canonical = eligible[0];
      for (const output of mutable) {
        output.state = output === canonical ? "available" : "unavailable";
        output.updatedAt = now;
      }
    }
    for (const output of group) await request(outputStore.put(output));
  }
}

export function createP2pkhDb(handle: P2pkhDbBundle) {
  return {
    getDb: () => handle.getDb(), close: () => handle.close(),
    putAddress: (row: P2pkhKeyResource) => runTransaction(handle, "p2pkh_addresses", "readwrite", async (tx) => { await request(tx.objectStore("p2pkh_addresses").put(row)); }),
    removeResource: (id: string) => runTransaction(handle, "p2pkh_addresses", "readwrite", async (tx) => { await request(tx.objectStore("p2pkh_addresses").delete(id)); }),
    listAddresses: () => runTransaction(handle, "p2pkh_addresses", "readonly", (tx) => all<P2pkhKeyResource>(tx.objectStore("p2pkh_addresses"))),
    listResourcesByKey: () => runTransaction(handle, "p2pkh_addresses", "readonly", (tx) => all<P2pkhKeyResource>(tx.objectStore("p2pkh_addresses"))),
    getResource: (id: string) => runTransaction(handle, "p2pkh_addresses", "readonly", (tx) => getById<P2pkhKeyResource>(tx.objectStore("p2pkh_addresses"), id)),

    async ingestConfirmedTransaction(input: { resource: P2pkhKeyResource; tx: { txid: string; rawTxHex: string; blockHeight?: number; blockHash?: string; blockTime?: number }; expectedGeneration?: number }): Promise<P2pkhTransactionFact> {
      const parsed = parseP2pkhTransaction(input.tx.rawTxHex, input.tx.txid); const owned = ownedP2pkhOutputs(parsed, input.resource.address, input.resource.network); const now = new Date().toISOString();
      const fact: P2pkhTransactionFact = { id: resourceKey(input.resource.resourceId, parsed.canonicalTxid), resourceId: input.resource.resourceId, publicKeyHex: input.resource.publicKeyHex, network: input.resource.network, address: input.resource.address, txid: parsed.canonicalTxid, rawTxHex: input.tx.rawTxHex.replace(/^0x/i, "").toLowerCase(), blockHeight: input.tx.blockHeight, blockHash: input.tx.blockHash, blockTime: input.tx.blockTime, inputOutpointKeys: parsed.inputs.map((i) => i.outpointKey), inputs: parsed.inputs.map((i) => ({ txid: i.prevTxid, vout: i.prevVout, outpointKey: i.outpointKey })), ownedOutpointKeys: owned.map((o) => `${parsed.canonicalTxid}:${o.vout}`), ownedOutputs: owned, firstConfirmedAt: now, lastConfirmedAt: now };
      await runTransaction(handle, ["p2pkh_addresses", "p2pkh_transactions", "p2pkh_owned_outpoints", "p2pkh_transaction_sync", "p2pkh_local_transactions", "p2pkh_local_input_claims", "p2pkh_local_outpoints"], "readwrite", async (tx) => {
        const current = await getById<P2pkhKeyResource>(tx.objectStore("p2pkh_addresses"), input.resource.resourceId); if (!current || (input.expectedGeneration !== undefined && current.generation !== input.expectedGeneration)) throw new Error("P2PKH resource generation changed");
        const facts = tx.objectStore("p2pkh_transactions"); const previous = await getById<P2pkhTransactionFact>(facts, fact.id); fact.firstConfirmedAt = previous?.firstConfirmedAt ?? now; fact.lastConfirmedAt = now; await request(facts.put(fact));
        const ownedStore = tx.objectStore("p2pkh_owned_outpoints");
        for (const output of owned) { const id = outpointId(fact.resourceId, fact.txid, output.vout); const existing = await getById<P2pkhOwnedOutpointProjection>(ownedStore, id); await request(ownedStore.put(existing ? { ...existing, value: output.value, scriptHex: output.scriptHex, updatedAt: now } : { id, resourceId: fact.resourceId, publicKeyHex: fact.publicKeyHex, network: fact.network, address: fact.address, txid: fact.txid, vout: output.vout, outpointKey: `${fact.txid}:${output.vout}`, value: output.value, scriptHex: output.scriptHex, chainState: "available", createdBlockHeight: fact.blockHeight, updatedAt: now } satisfies P2pkhOwnedOutpointProjection)); }
        for (const key of fact.inputOutpointKeys) { const row = await request(ownedStore.index("resourceOutpointKey").get([fact.resourceId, key])) as P2pkhOwnedOutpointProjection | undefined; if (row && row.txid !== fact.txid) { row.chainState = "spent"; row.spentByTxid = fact.txid; row.spentBlockHeight = fact.blockHeight; row.updatedAt = now; await request(ownedStore.put(row)); } }
        const allFacts = await all<P2pkhTransactionFact>(facts); for (const output of owned) { const key = `${fact.txid}:${output.vout}`; const spender = allFacts.find((candidate) => candidate.resourceId === fact.resourceId && candidate.txid !== fact.txid && candidate.inputOutpointKeys.includes(key)); if (spender) { const row = await getById<P2pkhOwnedOutpointProjection>(ownedStore, outpointId(fact.resourceId, fact.txid, output.vout)); if (row) { row.chainState = "spent"; row.spentByTxid = spender.txid; row.spentBlockHeight = spender.blockHeight; row.updatedAt = now; await request(ownedStore.put(row)); } } }
        const locals = tx.objectStore("p2pkh_local_transactions");
        const localRows = await allByKey<P2pkhLocalTransaction>(locals.index("txid"), fact.txid);
        for (const local of localRows.filter((row) => row.resourceId === fact.resourceId)) {
          local.chainResolution = "chain-confirmed";
          local.confirmedFactId = fact.id;
          local.conflictSourceTxids = undefined;
          local.resolvedAt = now;
          local.updatedAt = now;
          await request(locals.put(local));
          const outputs = tx.objectStore("p2pkh_local_outpoints");
          for (const output of await allByKey<P2pkhLocalOutpoint>(outputs.index("submissionId"), local.id)) await request(outputs.delete(output.id));
          const claims = tx.objectStore("p2pkh_local_input_claims");
          for (const claim of await allByKey<P2pkhLocalInputClaim>(claims.index("submissionId"), local.id)) await request(claims.delete(claim.id));
        }
        // The single-transaction fallback must apply the same competing
        // spender rule as paged confirmed ingest. Resolve the complete local
        // DAG in this atomic transaction so a confirmed remote spender cannot
        // leave descendants selectable.
        const allLocalRows = (await all<P2pkhLocalTransaction>(locals)).filter((row) => row.resourceId === fact.resourceId);
        const childrenByParent = new Map<string, P2pkhLocalTransaction[]>();
        for (const candidate of allLocalRows) for (const parent of candidate.parentTxids) {
          const children = childrenByParent.get(parent) ?? [];
          children.push(candidate);
          childrenByParent.set(parent, children);
        }
        const localRowsByTxid = new Map<string, P2pkhLocalTransaction[]>();
        for (const candidate of allLocalRows) {
          const rows = localRowsByTxid.get(candidate.txid) ?? [];
          rows.push(candidate);
          localRowsByTxid.set(candidate.txid, rows);
        }
        const branch = (root: P2pkhLocalTransaction): P2pkhLocalTransaction[] => {
          const result: P2pkhLocalTransaction[] = [];
          const seen = new Set<string>();
          const queue = [root];
          while (queue.length > 0) {
            const candidate = queue.shift()!;
            if (seen.has(candidate.id)) continue;
            seen.add(candidate.id);
            result.push(candidate);
            for (const child of childrenByParent.get(candidate.txid) ?? []) queue.push(child);
          }
          return result;
        };
        const localOutputsStore = tx.objectStore("p2pkh_local_outpoints");
        const localClaimsStore = tx.objectStore("p2pkh_local_input_claims");
        const competingRootTxids = new Set(allLocalRows
          .filter((candidate) => candidate.txid !== fact.txid && candidate.inputOutpointKeys.some((key) => fact.inputOutpointKeys.includes(key)))
          .map((candidate) => candidate.txid));
        for (const root of [...competingRootTxids].flatMap((txid) => localRowsByTxid.get(txid) ?? [])) {
          for (const candidate of branch(root)) {
            candidate.chainResolution = "conflicted";
            candidate.conflictSourceTxids = [...new Set([...(candidate.conflictSourceTxids ?? []), fact.txid])];
            candidate.resolvedAt = now;
            candidate.updatedAt = now;
            await request(locals.put(candidate));
            for (const output of await allByKey<P2pkhLocalOutpoint>(localOutputsStore.index("submissionId"), candidate.id)) {
              output.state = "invalidated";
              output.updatedAt = now;
              await request(localOutputsStore.put(output));
            }
            for (const claim of await allByKey<P2pkhLocalInputClaim>(localClaimsStore.index("submissionId"), candidate.id)) {
              claim.state = "isolated";
              claim.updatedAt = now;
              await request(localClaimsStore.put(claim));
            }
          }
        }
      });
      return fact;
    },
    async ingestConfirmedTransactionPage(input: { resource: P2pkhKeyResource; transactions: Array<{ txid: string; rawTxHex: string; blockHeight?: number; blockHash?: string; blockTime?: number }>; syncState: P2pkhTransactionSyncState; reorgCheck?: { observedTxids: string[]; completeHistory: boolean; anchorTxid?: string } }): Promise<void> {
      const now = new Date().toISOString();
      await runTransaction(handle, ["p2pkh_addresses", "p2pkh_transactions", "p2pkh_owned_outpoints", "p2pkh_transaction_sync", "p2pkh_local_transactions", "p2pkh_local_input_claims", "p2pkh_local_outpoints"], "readwrite", async (tx) => {
        const addressStore = tx.objectStore("p2pkh_addresses");
        const current = await getById<P2pkhKeyResource>(addressStore, input.resource.resourceId);
        if (!current || current.generation !== input.resource.generation) throw new Error("P2PKH resource generation changed");
        const syncStore = tx.objectStore("p2pkh_transaction_sync");
        const activeSync = await getById<P2pkhTransactionSyncState>(syncStore, input.resource.resourceId);
        const sameRun = activeSync && input.syncState.runId && activeSync.runId === input.syncState.runId;
        const sameProvider = activeSync && input.syncState.inProgressProviderId === undefined
          ? activeSync.inProgressProviderId !== undefined
          : activeSync?.inProgressProviderId === input.syncState.inProgressProviderId;
        const sameProviderGeneration = activeSync && input.syncState.inProgressProviderGeneration === undefined
          ? activeSync.inProgressProviderGeneration !== undefined
          : activeSync?.inProgressProviderGeneration === input.syncState.inProgressProviderGeneration;
        if (!activeSync || !sameRun || !sameProvider || !sameProviderGeneration) throw new Error("P2PKH sync generation changed");
        const facts = tx.objectStore("p2pkh_transactions");
        const ownedStore = tx.objectStore("p2pkh_owned_outpoints");
        const localStore = tx.objectStore("p2pkh_local_transactions");
        const claimStore = tx.objectStore("p2pkh_local_input_claims");
        const localOutpointStore = tx.objectStore("p2pkh_local_outpoints");
        // Both ordinary pages and reorg overlap only load local rows related
        // to the facts being reconciled. The complete-history case may pass
        // many stale facts, but it never performs an unbounded resource scan.
        let localRows: P2pkhLocalTransaction[] = [];
        let localClaims: P2pkhLocalInputClaim[] = [];
        let localOutpoints: P2pkhLocalOutpoint[] = [];
        let localsByTxid = new Map<string, P2pkhLocalTransaction[]>();
        let claimsBySubmission = new Map<string, P2pkhLocalInputClaim[]>();
        let claimsByOutpoint = new Map<string, P2pkhLocalInputClaim[]>();
        let localOutpointsBySubmission = new Map<string, P2pkhLocalOutpoint[]>();
        let localValueByOutpoint = new Map<string, number>();
        let localsByInputOutpoint = new Map<string, P2pkhLocalTransaction[]>();
        let childrenByParent = new Map<string, P2pkhLocalTransaction[]>();
        const indexLocalOverlay = (): void => {
          localsByTxid = new Map();
          for (const row of localRows) {
            const rows = localsByTxid.get(row.txid) ?? [];
            rows.push(row);
            localsByTxid.set(row.txid, rows);
          }
          claimsBySubmission = new Map();
          claimsByOutpoint = new Map();
          for (const claim of localClaims) {
            const bySubmission = claimsBySubmission.get(claim.submissionId) ?? [];
            bySubmission.push(claim); claimsBySubmission.set(claim.submissionId, bySubmission);
            const key = claim.outpointKey ?? `${claim.txid}:${claim.vout}`;
            const byOutpoint = claimsByOutpoint.get(key) ?? [];
            byOutpoint.push(claim); claimsByOutpoint.set(key, byOutpoint);
          }
          localOutpointsBySubmission = new Map();
          localValueByOutpoint = new Map();
          for (const output of localOutpoints) {
            const values = localOutpointsBySubmission.get(output.submissionId) ?? [];
            values.push(output); localOutpointsBySubmission.set(output.submissionId, values);
            localValueByOutpoint.set(`${output.txid}:${output.vout}`, output.value);
          }
          localsByInputOutpoint = new Map();
          childrenByParent = new Map();
          for (const local of localRows) {
            for (const key of local.inputOutpointKeys) {
              const values = localsByInputOutpoint.get(key) ?? [];
              values.push(local); localsByInputOutpoint.set(key, values);
            }
            for (const parent of local.parentTxids) {
              const children = childrenByParent.get(parent) ?? [];
              children.push(local); childrenByParent.set(parent, children);
            }
          }
        };
        indexLocalOverlay();
        const localOutputState = (localState: P2pkhLocalTransaction["localState"], chainResolution: P2pkhLocalTransaction["chainResolution"]): P2pkhLocalOutpoint["state"] => chainResolution === "conflicted" ? "invalidated" : localState === "local-confirmed" && chainResolution === "unresolved" ? "available" : localState === "isolated" ? "isolated" : "unavailable";
        const localClaimState = (localState: P2pkhLocalTransaction["localState"], chainResolution: P2pkhLocalTransaction["chainResolution"]): P2pkhLocalInputClaim["state"] => chainResolution === "chain-confirmed" ? "confirmed" : chainResolution === "conflicted" || localState === "isolated" ? "isolated" : "active";
        const loadLocalOverlay = async (relatedFacts: P2pkhTransactionFact[], extraRows: P2pkhLocalTransaction[] = []): Promise<void> => {
          const rowsById = new Map<string, P2pkhLocalTransaction>();
          const addRows = (rows: P2pkhLocalTransaction[]) => {
            for (const row of rows) if (row.resourceId === input.resource.resourceId) rowsById.set(row.id, row);
          };
          const inputIndex = localStore.index("inputOutpointKeys");
          const resourceTxidIndex = localStore.index("resourceTxid");
          for (const fact of relatedFacts) {
            addRows(await allByKey<P2pkhLocalTransaction>(resourceTxidIndex, [input.resource.resourceId, fact.txid]));
            for (const key of fact.inputOutpointKeys) addRows(await allByKey<P2pkhLocalTransaction>(inputIndex, key));
          }
          addRows(extraRows);
          // A confirmed spender can invalidate its descendants even when a
          // descendant does not directly consume a chain outpoint on this
          // page. Every discovered row also expands all same-txid siblings;
          // historical duplicate rows may have divergent input/parent fields,
          // so sibling expansion must happen before walking descendants.
          const parentIndex = localStore.index("parentTxids");
          const expanded = new Set<string>();
          while (true) {
            const pending = [...rowsById.values()].filter((row) => !expanded.has(row.id));
            if (pending.length === 0) break;
            for (const row of pending) {
              expanded.add(row.id);
              addRows(await allByKey<P2pkhLocalTransaction>(resourceTxidIndex, [input.resource.resourceId, row.txid]));
              addRows(await allByKey<P2pkhLocalTransaction>(parentIndex, row.txid));
            }
          }
          localRows = [...rowsById.values()];
          const claimsById = new Map<string, P2pkhLocalInputClaim>();
          const addClaims = (claims: P2pkhLocalInputClaim[]) => {
            for (const claim of claims) if (claim.resourceId === input.resource.resourceId) claimsById.set(claim.id, claim);
          };
          const claimOutpointIndex = claimStore.index("outpointKey");
          for (const fact of relatedFacts) for (const key of fact.inputOutpointKeys) addClaims(await allByKey<P2pkhLocalInputClaim>(claimOutpointIndex, key));
          const submissionIndex = claimStore.index("submissionId");
          for (const row of localRows) addClaims(await allByKey<P2pkhLocalInputClaim>(submissionIndex, row.id));
          localClaims = [...claimsById.values()];
          const outpointsById = new Map<string, P2pkhLocalOutpoint>();
          const addOutpoints = (outpoints: P2pkhLocalOutpoint[]) => {
            for (const outpoint of outpoints) if (outpoint.resourceId === input.resource.resourceId) outpointsById.set(outpoint.id, outpoint);
          };
          const outpointSubmissionIndex = localOutpointStore.index("submissionId");
          for (const row of localRows) addOutpoints(await allByKey<P2pkhLocalOutpoint>(outpointSubmissionIndex, row.id));
          localOutpoints = [...outpointsById.values()];
          indexLocalOverlay();
        };
        const loadCompleteLocalOverlay = async (rows: P2pkhLocalTransaction[]): Promise<void> => {
          localRows = rows.filter((row) => row.resourceId === input.resource.resourceId);
          localClaims = (await allByKey<P2pkhLocalInputClaim>(claimStore.index("resourceId"), input.resource.resourceId)).filter((claim) => claim.resourceId === input.resource.resourceId);
          localOutpoints = (await allByKey<P2pkhLocalOutpoint>(localOutpointStore.index("resourceId"), input.resource.resourceId)).filter((output) => output.resourceId === input.resource.resourceId);
          indexLocalOverlay();
        };
        // Confirmed values are needed only when a reorg restores a local
        // overlay and has to recreate a missing claim. Do not materialize the
        // complete owned projection for every ordinary provider page.
        let completeOwnedValueByOutpoint: Map<string, number> | undefined;
        const confirmedValueForOutpoint = async (outpointKey: string): Promise<number | undefined> => {
          if (completeOwnedValueByOutpoint) return completeOwnedValueByOutpoint.get(outpointKey);
          const row = await request(ownedStore.index("resourceOutpointKey").get([input.resource.resourceId, outpointKey])) as P2pkhOwnedOutpointProjection | undefined;
          return row?.resourceId === input.resource.resourceId ? row.value : undefined;
        };
        const restoreLocalOverlay = async (local: P2pkhLocalTransaction, state: P2pkhLocalTransaction["localState"], fallbackOutputs: Array<{ vout: number; value: number; scriptHex: string }> = [], persist = true): Promise<void> => {
          local.localState = state;
          local.chainResolution = "unresolved";
          local.confirmedFactId = undefined;
          local.resolvedAt = undefined;
          local.conflictSourceTxids = undefined;
          if (state === "isolated") local.isolationReason ??= "chain-reorg";
          else local.isolationReason = undefined;
          local.updatedAt = now;
          if (persist) await request(localStore.put(local));
          let outputs = localOutpointsBySubmission.get(local.id) ?? [];
          if (outputs.length === 0) {
            const source = fallbackOutputs.length > 0 ? fallbackOutputs : local.ownOutputs;
            outputs = source.map((output) => {
              const baseId = `${local.resourceId}:${local.txid}:${output.vout}`;
              const occupied = localOutpoints.some((candidate) => candidate.id === baseId && candidate.submissionId !== local.id);
              return { id: occupied ? `${baseId}:${local.id}` : baseId, resourceId: local.resourceId, txid: local.txid, vout: output.vout, value: output.value, scriptHex: output.scriptHex, submissionId: local.id, state: localOutputState(state, "unresolved"), createdAt: local.createdAt, updatedAt: now } satisfies P2pkhLocalOutpoint;
            });
            localOutpointsBySubmission.set(local.id, outputs);
            localOutpoints.push(...outputs);
            for (const output of outputs) { localValueByOutpoint.set(`${output.txid}:${output.vout}`, output.value); if (persist) await request(localOutpointStore.put(output)); }
          } else {
            for (const output of outputs) {
              output.state = localOutputState(state, "unresolved");
              output.updatedAt = now;
              if (persist) await request(localOutpointStore.put(output));
            }
          }
          const claims = claimsBySubmission.get(local.id) ?? [];
          for (const key of local.inputOutpointKeys) {
            if (claims.some((claim) => (claim.outpointKey ?? `${claim.txid}:${claim.vout}`) === key)) continue;
            const separator = key.lastIndexOf(":");
            const txid = separator > 0 ? key.slice(0, separator) : key;
            const vout = separator > 0 ? Number(key.slice(separator + 1)) : 0;
            const value = await confirmedValueForOutpoint(key) ?? localValueByOutpoint.get(key);
            const claim: P2pkhLocalInputClaim = { id: claimId(local.resourceId, txid, vout), submissionId: local.id, resourceId: local.resourceId, publicKeyHex: local.publicKeyHex, network: local.network, txid, vout, outpointKey: key, ...(value === undefined ? {} : { value }), state: localClaimState(state, "unresolved"), createdAt: local.createdAt, updatedAt: now };
            claims.push(claim);
            const byOutpoint = claimsByOutpoint.get(key) ?? [];
            byOutpoint.push(claim); claimsByOutpoint.set(key, byOutpoint);
            localClaims.push(claim);
          }
          claimsBySubmission.set(local.id, claims);
          for (const claim of claims) {
            claim.state = localClaimState(state, "unresolved");
            claim.updatedAt = now;
            if (persist) await request(claimStore.put(claim));
          }
        };
        // Rebuild the temporary overlay after a fact reorg/conflict as a DAG,
        // rather than treating every restored transaction as an independent
        // wallet balance. A child claim consumes its parent's local output;
        // this remains true when both rows are restored in the same pass.
        const reconcileRestoredLocalOverlay = async (persist = true): Promise<void> => {
          const outputByOutpoint = new Map<string, P2pkhLocalOutpoint[]>();
          for (const output of localOutpoints) {
            const outputs = outputByOutpoint.get(`${output.txid}:${output.vout}`) ?? [];
            outputs.push(output);
            outputByOutpoint.set(`${output.txid}:${output.vout}`, outputs);
          }
          const priority: Record<P2pkhLocalOutpoint["state"], number> = { unavailable: 1, available: 2, claimed: 3, isolated: 4, invalidated: 5 };
          const raiseOutput = (output: P2pkhLocalOutpoint, state: P2pkhLocalOutpoint["state"]): void => {
            if (priority[state] > priority[output.state]) output.state = state;
          };

          for (const local of localRows) {
            for (const output of localOutpointsBySubmission.get(local.id) ?? []) {
              output.state = localOutputState(local.localState, local.chainResolution);
              output.updatedAt = now;
            }
            for (const claim of claimsBySubmission.get(local.id) ?? []) {
              claim.state = localClaimState(local.localState, local.chainResolution);
              claim.updatedAt = now;
            }
          }
          // Historical duplicate submissions with the same txid describe one
          // outpoint. Keep every audit row, but only one deterministic local
          // output may contribute to spendable balance while unresolved.
          for (const outputs of outputByOutpoint.values()) {
            const available = outputs.filter((output) => output.state === "available").sort((left, right) => left.id.localeCompare(right.id));
            for (const output of available.slice(1)) output.state = "unavailable";
          }
          for (const child of localRows) {
            for (const inputKey of child.inputOutpointKeys) {
              const parentOutputs = outputByOutpoint.get(inputKey);
              if (!parentOutputs) continue;
              if (child.chainResolution === "conflicted") for (const parentOutput of parentOutputs) raiseOutput(parentOutput, "invalidated");
              else if (child.localState === "isolated") for (const parentOutput of parentOutputs) raiseOutput(parentOutput, "isolated");
              else if (child.chainResolution === "unresolved") {
                // A logical child claim reserves the whole outpoint group.
                // Do not leave an available sibling behind merely because a
                // deterministic canonical duplicate is currently unavailable.
                for (const parentOutput of parentOutputs) {
                  if (parentOutput.state !== "isolated" && parentOutput.state !== "invalidated") raiseOutput(parentOutput, "claimed");
                }
              }
            }
          }
          if (persist) {
            for (const output of localOutpoints) await request(localOutpointStore.put(output));
            for (const claim of localClaims) await request(claimStore.put(claim));
          }
        };
        const reconcileOwnedProjection = async (pageFacts: P2pkhTransactionFact[], removedFacts: P2pkhTransactionFact[] = []): Promise<void> => {
          const changedFacts = [...pageFacts, ...removedFacts];
          for (const fact of removedFacts) {
            for (const row of await allByKey<P2pkhOwnedOutpointProjection>(ownedStore.index("resourceTxid"), [fact.resourceId, fact.txid])) await request(ownedStore.delete(row.id));
          }
          for (const fact of pageFacts) {
            const expected = new Set(fact.ownedOutputs.map((output) => `${fact.txid}:${output.vout}`));
            for (const row of await allByKey<P2pkhOwnedOutpointProjection>(ownedStore.index("resourceTxid"), [fact.resourceId, fact.txid])) {
              if (!expected.has(row.outpointKey)) await request(ownedStore.delete(row.id));
            }
          }
          const reconcileOutpoint = async (key: string): Promise<void> => {
            const row = await request(ownedStore.index("resourceOutpointKey").get([input.resource.resourceId, key])) as P2pkhOwnedOutpointProjection | undefined;
            if (!row || row.resourceId !== input.resource.resourceId) return;
            const spenders = (await allByKey<P2pkhTransactionFact>(facts.index("inputOutpointKeys"), key)).filter((candidate) => candidate.resourceId === input.resource.resourceId && candidate.txid !== row.txid).sort((left, right) => (left.blockHeight ?? Number.MAX_SAFE_INTEGER) - (right.blockHeight ?? Number.MAX_SAFE_INTEGER));
            const spender = spenders[0];
            row.chainState = spender ? "spent" : "available";
            row.spentByTxid = spender?.txid;
            row.spentBlockHeight = spender?.blockHeight;
            row.updatedAt = now;
            await request(ownedStore.put(row));
          };
          for (const fact of changedFacts) {
            for (const key of fact.inputOutpointKeys) await reconcileOutpoint(key);
            for (const output of fact.ownedOutputs) await reconcileOutpoint(`${fact.txid}:${output.vout}`);
          }
        };
        const reconcilePageProjection = async (pageFacts: P2pkhTransactionFact[]): Promise<void> => {
          await loadLocalOverlay(pageFacts);
          await reconcileOwnedProjection(pageFacts);
        };
        const pageFacts: P2pkhTransactionFact[] = [];
        for (const transaction of input.transactions) {
          const parsed = parseP2pkhTransaction(transaction.rawTxHex, transaction.txid);
          const owned = ownedP2pkhOutputs(parsed, input.resource.address, input.resource.network);
          const id = resourceKey(input.resource.resourceId, parsed.canonicalTxid);
          const previous = await getById<P2pkhTransactionFact>(facts, id);
          const fact: P2pkhTransactionFact = { id, resourceId: input.resource.resourceId, publicKeyHex: input.resource.publicKeyHex, network: input.resource.network, address: input.resource.address, txid: parsed.canonicalTxid, rawTxHex: transaction.rawTxHex.replace(/^0x/i, "").toLowerCase(), blockHeight: transaction.blockHeight, blockHash: transaction.blockHash, blockTime: transaction.blockTime, inputOutpointKeys: parsed.inputs.map((item) => item.outpointKey), inputs: parsed.inputs.map((item) => ({ txid: item.prevTxid, vout: item.prevVout, outpointKey: item.outpointKey })), ownedOutpointKeys: owned.map((item) => `${parsed.canonicalTxid}:${item.vout}`), ownedOutputs: owned, firstConfirmedAt: previous?.firstConfirmedAt ?? now, lastConfirmedAt: now };
          pageFacts.push(fact);
          await request(facts.put(fact));
          for (const output of owned) {
            const outpointIdValue = outpointId(fact.resourceId, fact.txid, output.vout);
            const existing = await getById<P2pkhOwnedOutpointProjection>(ownedStore, outpointIdValue);
            await request(ownedStore.put(existing ? { ...existing, value: output.value, scriptHex: output.scriptHex, updatedAt: now } : { id: outpointIdValue, resourceId: fact.resourceId, publicKeyHex: fact.publicKeyHex, network: fact.network, address: fact.address, txid: fact.txid, vout: output.vout, outpointKey: `${fact.txid}:${output.vout}`, value: output.value, scriptHex: output.scriptHex, chainState: "available", createdBlockHeight: fact.blockHeight, updatedAt: now } satisfies P2pkhOwnedOutpointProjection));
          }
        }
        const reorgCheck = input.reorgCheck;
        let reconciledFacts: P2pkhTransactionFact[] = pageFacts;
        let terminalCandidateTxids = new Set<string>();
        if (reorgCheck && (reorgCheck.completeHistory || reorgCheck.anchorTxid)) {
          const anchor = reorgCheck.anchorTxid ? await request(facts.index("resourceTxid").get([input.resource.resourceId, reorgCheck.anchorTxid])) as P2pkhTransactionFact | undefined : undefined;
          const existingFacts = reorgCheck.completeHistory
            ? await allByKey<P2pkhTransactionFact>(facts.index("resourceId"), input.resource.resourceId)
            : anchor?.blockHeight === undefined
              ? []
              : await allByKey<P2pkhTransactionFact>(facts.index("resourceBlockHeight"), IDBKeyRange.bound([input.resource.resourceId, anchor.blockHeight], [input.resource.resourceId, Number.MAX_SAFE_INTEGER]));
          let allFacts = [...existingFacts.filter((row) => !pageFacts.some((pageFact) => pageFact.id === row.id)), ...pageFacts];
          const observed = new Set(reorgCheck.observedTxids.map((txid) => txid.toLowerCase()));
          const stale = allFacts.filter((fact) => fact.resourceId === input.resource.resourceId && !observed.has(fact.txid) && (reorgCheck.completeHistory || (anchor?.blockHeight !== undefined && fact.blockHeight !== undefined && fact.blockHeight >= anchor.blockHeight)));
          // Complete history is the convergence boundary for the whole local
          // audit trail. Include unresolved rows as well as terminal rows so a
          // same-txid sibling that has not yet been touched by a provider page
          // is promoted/restored with its siblings.
          const completeLocalRows = reorgCheck.completeHistory
            ? await allByKey<P2pkhLocalTransaction>(localStore.index("resourceId"), input.resource.resourceId)
            : [];
          if (reorgCheck.completeHistory) {
            completeOwnedValueByOutpoint = new Map((await allByKey<P2pkhOwnedOutpointProjection>(ownedStore.index("resourceOutpointKey"), IDBKeyRange.bound([input.resource.resourceId, ""], [input.resource.resourceId, "\uffff"]))).map((row) => [row.outpointKey, row.value]));
            await loadCompleteLocalOverlay(completeLocalRows);
          } else {
            await loadLocalOverlay([...pageFacts, ...stale]);
          }
          terminalCandidateTxids = new Set(
            localRows
              .filter((row) => row.chainResolution === "chain-confirmed" || row.chainResolution === "conflicted")
              .map((row) => row.txid)
          );
          const staleIds = new Set(stale.map((fact) => fact.id));
          for (const fact of stale) await request(facts.delete(fact.id));
          allFacts = allFacts.filter((fact) => !staleIds.has(fact.id));
          reconciledFacts = allFacts;
          for (const fact of stale) {
            for (const local of localsByTxid.get(fact.txid) ?? []) {
              if (local.chainResolution !== "chain-confirmed") continue;
              const restoredState = local.localState;
              if (reorgCheck.completeHistory) {
                // Complete-history planning below owns the single final write
                // for every local row/output/claim. Mutate the in-memory row
                // now so source selection sees the reorged axis, but defer
                // overlay persistence until the plan is applied.
                await restoreLocalOverlay(local, restoredState, fact.ownedOutputs, false);
              } else {
                await restoreLocalOverlay(local, restoredState, fact.ownedOutputs);
              }
            }
          }
          const staleTxids = new Set(stale.map((fact) => fact.txid));
          for (const local of localRows) {
            const sources = local.conflictSourceTxids ?? [];
            if (local.chainResolution !== "conflicted" || sources.length === 0) continue;
            const remainingSources = sources.filter((source) => !staleTxids.has(source));
            if (remainingSources.length === sources.length) continue;
            local.conflictSourceTxids = remainingSources;
            if (remainingSources.length === 0) {
              const restoredState = local.localState;
              if (reorgCheck.completeHistory) await restoreLocalOverlay(local, restoredState, [], false);
              else await restoreLocalOverlay(local, restoredState);
            } else if (reorgCheck.completeHistory) {
              local.updatedAt = now;
            } else {
              local.updatedAt = now;
              await request(localStore.put(local));
            }
          }
          if (reorgCheck.completeHistory) await rebuildOwnedProjectionInTransaction(tx, input.resource.resourceId, allFacts, now);
          else await reconcileOwnedProjection(pageFacts, stale);
        } else {
          await reconcilePageProjection(pageFacts);
        }

        // Reconcile the local overlay in the same transaction as facts and the
        // owned projection. A confirmed copy of a local tx promotes that tx;
        // a different confirmed spender conflicts it and invalidates its
        // descendants. Claims are deliberately retained until this chain fact
        // exists—there is no timeout-based unlock.
        const descendants = (rootTxid: string): P2pkhLocalTransaction[] => {
          const result = new Map<string, P2pkhLocalTransaction>();
          const queue = [...(localsByTxid.get(rootTxid) ?? [])];
          while (queue.length) {
            const parent = queue.shift()!;
            if (result.has(parent.id)) continue;
            result.set(parent.id, parent);
            for (const child of childrenByParent.get(parent.txid) ?? []) {
              if (result.has(child.id)) continue;
              queue.push(child);
            }
          }
          return [...result.values()];
        };
        const invalidateBranch = async (rootTxid: string, sourceTxid: string): Promise<void> => {
          const branch = descendants(rootTxid);
          for (const local of branch) {
            local.conflictSourceTxids = [...new Set([...(local.conflictSourceTxids ?? []), sourceTxid])];
            local.chainResolution = "conflicted";
            local.resolvedAt = now;
            local.updatedAt = now;
            await request(localStore.put(local));
            for (const output of localOutpointsBySubmission.get(local.id) ?? []) {
              output.state = "invalidated";
              output.updatedAt = now;
              await request(localOutpointStore.put(output));
            }
            for (const claim of claimsBySubmission.get(local.id) ?? []) {
              claim.state = "isolated";
              claim.updatedAt = now;
              await request(claimStore.put(claim));
            }
          }
        };

        const promoteLocalRows = async (fact: P2pkhTransactionFact, rows: P2pkhLocalTransaction[]): Promise<void> => {
          for (const local of rows) {
            local.chainResolution = "chain-confirmed";
            local.confirmedFactId = fact.id;
            local.resolvedAt = now;
            local.conflictSourceTxids = undefined;
            local.updatedAt = now;
            await request(localStore.put(local));
            for (const output of localOutpointsBySubmission.get(local.id) ?? []) {
              await request(localOutpointStore.delete(output.id));
            }
            localOutpointsBySubmission.delete(local.id);
            for (let index = localOutpoints.length - 1; index >= 0; index -= 1) if (localOutpoints[index]?.submissionId === local.id) localOutpoints.splice(index, 1);
            for (const claim of claimsBySubmission.get(local.id) ?? []) {
              await request(claimStore.delete(claim.id));
              const claimKey = claim.outpointKey ?? `${claim.txid}:${claim.vout}`;
              const remaining = (claimsByOutpoint.get(claimKey) ?? []).filter((candidate) => candidate.id !== claim.id);
              if (remaining.length > 0) claimsByOutpoint.set(claimKey, remaining);
              else claimsByOutpoint.delete(claimKey);
            }
            claimsBySubmission.delete(local.id);
            for (let index = localClaims.length - 1; index >= 0; index -= 1) if (localClaims[index]?.submissionId === local.id) localClaims.splice(index, 1);
          }
        };

        if (reorgCheck?.completeHistory) {
          const factByTxid = new Map(reconciledFacts.filter((fact) => fact.resourceId === input.resource.resourceId).map((fact) => [fact.txid, fact]));
          const spendersByInputOutpoint = new Map<string, P2pkhTransactionFact[]>();
          for (const fact of reconciledFacts) {
            if (fact.resourceId !== input.resource.resourceId) continue;
            for (const key of fact.inputOutpointKeys) {
              const spenders = spendersByInputOutpoint.get(key) ?? [];
              spenders.push(fact);
              spendersByInputOutpoint.set(key, spenders);
            }
          }

          // First compute the complete decision in memory. In particular, do
          // not call invalidateBranch per source/root: on a deep DAG that
          // repeats the same descendant walk (and IndexedDB writes) for every
          // ancestor. A txid is queued only when its source set grows, so each
          // local group is visited once per actual source relation.
          const localTxids = new Set(localRows.map((row) => row.txid));
          const conflictSourcesByTxid = new Map<string, Set<string>>();
          for (const txid of localTxids) {
            if (factByTxid.has(txid)) continue;
            const sources = new Set<string>();
            for (const row of localsByTxid.get(txid) ?? []) {
              for (const source of row.conflictSourceTxids ?? []) if (factByTxid.has(source)) sources.add(source);
              for (const key of row.inputOutpointKeys) {
                for (const fact of spendersByInputOutpoint.get(key) ?? []) if (fact.txid !== txid) sources.add(fact.txid);
              }
            }
            if (sources.size > 0) conflictSourcesByTxid.set(txid, sources);
          }
          const pendingTxids = [...conflictSourcesByTxid.keys()];
          for (let cursor = 0; cursor < pendingTxids.length; cursor += 1) {
            const parentTxid = pendingTxids[cursor]!;
            for (const child of childrenByParent.get(parentTxid) ?? []) {
              if (factByTxid.has(child.txid)) continue;
              const sources = conflictSourcesByTxid.get(child.txid) ?? new Set<string>();
              const before = sources.size;
              for (const source of conflictSourcesByTxid.get(parentTxid) ?? []) sources.add(source);
              if (sources.size !== before) {
                conflictSourcesByTxid.set(child.txid, sources);
                pendingTxids.push(child.txid);
              }
            }
          }

          const promotedSubmissionIds = new Set<string>();
          for (const txid of localTxids) {
            const group = localsByTxid.get(txid) ?? [];
            const fact = factByTxid.get(txid);
            const sources = conflictSourcesByTxid.get(txid);
            if (fact) {
              for (const local of group) {
                local.chainResolution = "chain-confirmed";
                local.confirmedFactId = fact.id;
                local.resolvedAt = now;
                local.conflictSourceTxids = undefined;
                local.updatedAt = now;
                promotedSubmissionIds.add(local.id);
              }
            } else if (sources && sources.size > 0) {
              for (const local of group) {
                local.chainResolution = "conflicted";
                local.confirmedFactId = undefined;
                local.conflictSourceTxids = [...sources].sort();
                local.resolvedAt = now;
                local.updatedAt = now;
                for (const output of localOutpointsBySubmission.get(local.id) ?? []) { output.state = "invalidated"; output.updatedAt = now; }
                for (const claim of claimsBySubmission.get(local.id) ?? []) { claim.state = "isolated"; claim.updatedAt = now; }
              }
            } else if (terminalCandidateTxids.has(txid)) {
              for (const local of group) await restoreLocalOverlay(local, local.localState, [], false);
            }
          }

          // Promoted rows no longer own temporary overlay records. Remove them
          // from the in-memory set before the one final normalization pass;
          // otherwise that pass could write an already-deleted record again.
          const promotedOutputs = localOutpoints.filter((output) => promotedSubmissionIds.has(output.submissionId));
          const promotedClaims = localClaims.filter((claim) => promotedSubmissionIds.has(claim.submissionId));
          localOutpoints = localOutpoints.filter((output) => !promotedSubmissionIds.has(output.submissionId));
          localClaims = localClaims.filter((claim) => !promotedSubmissionIds.has(claim.submissionId));
          for (const id of promotedSubmissionIds) {
            localOutpointsBySubmission.delete(id);
            claimsBySubmission.delete(id);
          }
          await reconcileRestoredLocalOverlay(false);
          for (const local of localRows) {
            if (promotedSubmissionIds.has(local.id) || local.chainResolution !== "unresolved" || local.conflictSourceTxids === undefined) await request(localStore.put(local));
          }
          for (const output of promotedOutputs) await request(localOutpointStore.delete(output.id));
          for (const claim of promotedClaims) await request(claimStore.delete(claim.id));
          for (const output of localOutpoints) await request(localOutpointStore.put(output));
          for (const claim of localClaims) await request(claimStore.put(claim));
        }

        if (!reorgCheck?.completeHistory) for (const fact of pageFacts) {
          for (const local of localsByTxid.get(fact.txid) ?? []) {
            local.chainResolution = "chain-confirmed";
            local.confirmedFactId = fact.id;
            local.resolvedAt = now;
            local.updatedAt = now;
            await request(localStore.put(local));
            for (const output of localOutpointsBySubmission.get(local.id) ?? []) {
              await request(localOutpointStore.delete(output.id));
            }
            localOutpointsBySubmission.delete(local.id);
            for (let index = localOutpoints.length - 1; index >= 0; index -= 1) if (localOutpoints[index]?.submissionId === local.id) localOutpoints.splice(index, 1);
            // A chain-confirmed local transaction no longer needs a temporary
            // claim. Its prior local state is retained on the transaction so a
            // later reorg can recreate the claim with a conservative value.
            for (const claim of claimsBySubmission.get(local.id) ?? []) {
              await request(claimStore.delete(claim.id));
              const remaining = (claimsByOutpoint.get(claim.outpointKey ?? `${claim.txid}:${claim.vout}`) ?? []).filter((candidate) => candidate.id !== claim.id);
              if (remaining.length > 0) claimsByOutpoint.set(claim.outpointKey ?? `${claim.txid}:${claim.vout}`, remaining);
              else claimsByOutpoint.delete(claim.outpointKey ?? `${claim.txid}:${claim.vout}`);
            }
            claimsBySubmission.delete(local.id);
            for (let index = localClaims.length - 1; index >= 0; index -= 1) if (localClaims[index]?.submissionId === local.id) localClaims.splice(index, 1);
          }
          for (const key of fact.inputOutpointKeys) {
            const sameTxSubmissionIds = new Set((localsByTxid.get(fact.txid) ?? []).map((candidate) => candidate.id));
            for (const claimant of localsByInputOutpoint.get(key) ?? []) {
              if (claimant.txid === fact.txid) continue;
              await invalidateBranch(claimant.txid, fact.txid);
            }
            for (const claim of claimsByOutpoint.get(key) ?? []) {
              if (sameTxSubmissionIds.has(claim.submissionId)) continue;
              claim.state = "isolated";
              claim.updatedAt = now;
              await request(claimStore.put(claim));
            }
          }
        }
        if (!reorgCheck?.completeHistory) await reconcileRestoredLocalOverlay();
        await request(syncStore.put({ ...input.syncState, id: input.resource.resourceId }));
      });
    },
    listTransactionFactsPage: (filter?: { resourceId?: string; network?: BsvNetwork; cursor?: string; limit?: number }) => runTransaction(handle, "p2pkh_transactions", "readonly", async (tx) => {
      const resourceId = filter?.resourceId;
      if (!resourceId) return { items: [], nextCursor: undefined };
      const page = await pageByIndex<P2pkhTransactionFact>(tx.objectStore("p2pkh_transactions").index("resourceTimeline"), resourceId, filter?.cursor, boundedLimit(filter?.limit) ?? 200);
      return { items: page.items.filter((row) => !filter?.network || row.network === filter.network), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
    }),
    listOwnedOutpointsPage: (filter?: { resourceId?: string; network?: BsvNetwork; chainState?: string; cursor?: string; limit?: number }) => runTransaction(handle, "p2pkh_owned_outpoints", "readonly", async (tx) => {
      const resourceId = filter?.resourceId;
      if (!resourceId) return { items: [], nextCursor: undefined };
      const page = await pageByIndex<P2pkhOwnedOutpointProjection>(tx.objectStore("p2pkh_owned_outpoints").index("resourceTimeline"), resourceId, filter?.cursor, boundedLimit(filter?.limit) ?? 500);
      return { items: page.items.filter((row) => (!filter?.network || row.network === filter.network) && (!filter?.chainState || row.chainState === filter.chainState)), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
    }),
    listOwnedOutpointValues: (resourceId: string, outpointKeys: string[]) => runTransaction(handle, "p2pkh_owned_outpoints", "readonly", async (tx) => {
      const index = tx.objectStore("p2pkh_owned_outpoints").index("resourceOutpointKey");
      const values: Record<string, number> = {};
      for (const key of [...new Set(outpointKeys)]) {
        const row = await request(index.get([resourceId, key])) as P2pkhOwnedOutpointProjection | undefined;
        if (row?.resourceId === resourceId) values[key] = row.value;
      }
      return values;
    }),
    listTransactionFacts: (filter?: { resourceId?: string; network?: BsvNetwork; limit?: number }) => runTransaction(handle, "p2pkh_transactions", "readonly", async (tx) => {
      const store = tx.objectStore("p2pkh_transactions");
      const limit = boundedLimit(filter?.limit);
      let rows: P2pkhTransactionFact[];
      if (!filter?.resourceId) rows = limit ? await pageByCursor<P2pkhTransactionFact>(store, null, "prev", limit) : await all<P2pkhTransactionFact>(store);
      else if (!limit) rows = await allByKey<P2pkhTransactionFact>(store.index("resourceId"), filter.resourceId);
      else {
        rows = (await pageByIndex<P2pkhTransactionFact>(store.index("resourceTimeline"), filter.resourceId, undefined, limit)).items;
      }
      return rows.filter((r) => !filter?.network || r.network === filter.network);
    }),
    listOwnedOutpoints: (filter?: { resourceId?: string; network?: BsvNetwork; chainState?: string; limit?: number }) => runTransaction(handle, "p2pkh_owned_outpoints", "readonly", async (tx) => {
      const store = tx.objectStore("p2pkh_owned_outpoints");
      const limit = boundedLimit(filter?.limit);
      let rows: P2pkhOwnedOutpointProjection[];
      if (!limit && filter?.resourceId && filter.chainState) rows = await allByKey<P2pkhOwnedOutpointProjection>(store.index("resourceChainState"), [filter.resourceId, filter.chainState]);
      else if (!limit && filter?.resourceId) rows = [...await allByKey<P2pkhOwnedOutpointProjection>(store.index("resourceChainState"), [filter.resourceId, "available"]), ...await allByKey<P2pkhOwnedOutpointProjection>(store.index("resourceChainState"), [filter.resourceId, "spent"] )];
      else if (!limit && filter?.chainState) rows = await allByKey<P2pkhOwnedOutpointProjection>(store.index("chainState"), filter.chainState);
      else if (!limit) rows = await all<P2pkhOwnedOutpointProjection>(store);
      else if (filter?.resourceId && filter.chainState) rows = await pageByCursor<P2pkhOwnedOutpointProjection>(store.index("resourceChainState"), [filter.resourceId, filter.chainState], "prev", limit);
      else if (filter?.resourceId) {
        rows = (await pageByIndex<P2pkhOwnedOutpointProjection>(store.index("resourceTimeline"), filter.resourceId, undefined, limit)).items;
      } else rows = await pageByCursor<P2pkhOwnedOutpointProjection>(store, null, "prev", limit);
      return rows.filter((r) => (!filter?.network || r.network === filter.network) && (!filter?.chainState || r.chainState === filter.chainState));
    }),
    listTransactionSyncStates: () => runTransaction(handle, "p2pkh_transaction_sync", "readonly", (tx) => all<P2pkhTransactionSyncState>(tx.objectStore("p2pkh_transaction_sync"))),
    getTransactionSyncState: (id: string) => runTransaction(handle, "p2pkh_transaction_sync", "readonly", (tx) => getById<P2pkhTransactionSyncState>(tx.objectStore("p2pkh_transaction_sync"), id)),
    putTransactionSyncState: (state: P2pkhTransactionSyncState) => runTransaction(handle, "p2pkh_transaction_sync", "readwrite", async (tx) => { await request(tx.objectStore("p2pkh_transaction_sync").put({ ...state, id: state.resourceId })); }),
    clearInProgressSyncState: (id: string) => runTransaction(handle, "p2pkh_transaction_sync", "readwrite", async (tx) => { const store = tx.objectStore("p2pkh_transaction_sync"); const row = await getById<P2pkhTransactionSyncState>(store, id); if (row) await request(store.put({ ...row, id, inProgressProviderId: undefined, inProgressProviderGeneration: undefined, inProgressCursor: undefined, runId: undefined, runHeadTxid: undefined, runObservedTxids: undefined })); }),
    async rebuildOwnedOutpoints(resourceId?: string): Promise<void> { await runTransaction(handle, ["p2pkh_transactions", "p2pkh_owned_outpoints"], "readwrite", async (tx) => { const factsStore = tx.objectStore("p2pkh_transactions"); const ownedStore = tx.objectStore("p2pkh_owned_outpoints"); const facts = (await all<P2pkhTransactionFact>(factsStore)).filter((r) => !resourceId || r.resourceId === resourceId); const existing = (await all<P2pkhOwnedOutpointProjection>(ownedStore)).filter((r) => !resourceId || r.resourceId === resourceId); for (const row of existing) await request(ownedStore.delete(row.id)); const map = new Map<string, P2pkhOwnedOutpointProjection>(); for (const fact of facts) for (const output of fact.ownedOutputs) map.set(`${fact.resourceId}:${fact.txid}:${output.vout}`, { id: outpointId(fact.resourceId, fact.txid, output.vout), resourceId: fact.resourceId, publicKeyHex: fact.publicKeyHex, network: fact.network, address: fact.address, txid: fact.txid, vout: output.vout, outpointKey: `${fact.txid}:${output.vout}`, value: output.value, scriptHex: output.scriptHex, chainState: "available", createdBlockHeight: fact.blockHeight, updatedAt: new Date().toISOString() }); const byOutpoint = new Map([...map.values()].map((row) => [`${row.resourceId}:${row.outpointKey}`, row])); for (const fact of facts) for (const key of fact.inputOutpointKeys) { const row = byOutpoint.get(`${fact.resourceId}:${key}`); if (row && row.txid !== fact.txid) { row.chainState = "spent"; row.spentByTxid = fact.txid; row.spentBlockHeight = fact.blockHeight; } } for (const row of map.values()) await request(ownedStore.put(row)); }); },

    listLocalTransactions: (resourceId?: string, limit?: number) => runTransaction(handle, "p2pkh_local_transactions", "readonly", async (tx) => { const store = tx.objectStore("p2pkh_local_transactions"); const size = boundedLimit(limit); if (resourceId && !size) return allByKey<P2pkhLocalTransaction>(store.index("resourceId"), resourceId); if (resourceId) return pageByCursor<P2pkhLocalTransaction>(store.index("resourceId"), resourceId, "prev", size!); return size ? pageByCursor<P2pkhLocalTransaction>(store, null, "prev", size) : all<P2pkhLocalTransaction>(store); }),
    listLocalOutpoints: (resourceId?: string, limit?: number) => runTransaction(handle, "p2pkh_local_outpoints", "readonly", async (tx) => { const store = tx.objectStore("p2pkh_local_outpoints"); const size = boundedLimit(limit); return resourceId ? (size ? pageByCursor<P2pkhLocalOutpoint>(store.index("resourceId"), resourceId, "prev", size) : allByKey<P2pkhLocalOutpoint>(store.index("resourceId"), resourceId)) : (size ? pageByCursor<P2pkhLocalOutpoint>(store, null, "prev", size) : all<P2pkhLocalOutpoint>(store)); }),
    listLocalTransactionsPage: (filter?: { resourceId?: string; cursor?: string; limit?: number }) => runTransaction(handle, "p2pkh_local_transactions", "readonly", async (tx) => { if (!filter?.resourceId) return { items: [], nextCursor: undefined }; return pageByIndex<P2pkhLocalTransaction>(tx.objectStore("p2pkh_local_transactions").index("resourceTimeline"), filter.resourceId, filter.cursor, boundedLimit(filter.limit) ?? 500); }),
    listLocalOutpointsPage: (filter?: { resourceId?: string; cursor?: string; limit?: number }) => runTransaction(handle, "p2pkh_local_outpoints", "readonly", async (tx) => { if (!filter?.resourceId) return { items: [], nextCursor: undefined }; const page = await pageByIndex<P2pkhLocalOutpoint>(tx.objectStore("p2pkh_local_outpoints").index("resourceTimeline"), filter.resourceId, filter.cursor, boundedLimit(filter.limit) ?? 500); return page; }),
    listLocalInputClaimsPage: (filter?: { resourceId?: string; cursor?: string; limit?: number }) => runTransaction(handle, "p2pkh_local_input_claims", "readonly", async (tx) => { if (!filter?.resourceId) return { items: [], nextCursor: undefined }; const page = await pageByIndex<P2pkhLocalInputClaim>(tx.objectStore("p2pkh_local_input_claims").index("resourceTimeline"), filter.resourceId, filter.cursor, boundedLimit(filter.limit) ?? 500); return page; }),
    async prepareLocalSubmission(input: { submission: P2pkhLocalTransaction; claims: P2pkhLocalInputClaim[]; localOutpoints: P2pkhLocalOutpoint[] }): Promise<void> {
      await runTransaction(handle, ["p2pkh_local_transactions", "p2pkh_local_input_claims", "p2pkh_local_outpoints"], "readwrite", async (tx) => {
        const claims = tx.objectStore("p2pkh_local_input_claims");
        const outputs = tx.objectStore("p2pkh_local_outpoints");
        const affected = new Set<string>(input.localOutpoints.map((output) => `${output.txid}:${output.vout}`));
        for (const claim of input.claims) {
          const id = claim.id || claimId(claim.resourceId, claim.txid, claim.vout);
          const existing = await getById<P2pkhLocalInputClaim>(claims, id);
          if (existing && existing.submissionId !== claim.submissionId && !["released", "confirmed"].includes(existing.state)) throw new Error(`P2PKH input already claimed: ${claim.txid}:${claim.vout}`);
          const outpointKey = `${claim.txid}:${claim.vout}`;
          affected.add(outpointKey);
          await request(claims.put({ ...claim, id, state: "active", outpointKey, createdAt: existing?.createdAt ?? claim.createdAt, updatedAt: new Date().toISOString() }));
          for (const parent of (await allByKey<P2pkhLocalOutpoint>(outputs.index("outpointKey"), [claim.txid, claim.vout])).filter((candidate) => candidate.resourceId === claim.resourceId && candidate.submissionId !== claim.submissionId && candidate.state === "available")) {
            parent.state = "claimed";
            parent.updatedAt = new Date().toISOString();
            await request(outputs.put(parent));
          }
        }
        await request(tx.objectStore("p2pkh_local_transactions").put({ ...input.submission, localState: "submitting", chainResolution: "unresolved" }));
        for (const output of input.localOutpoints) await request(outputs.put({ ...output, state: "unavailable" }));
        await normalizeLocalOutputGroupsInTransaction(tx, input.submission.resourceId, new Date().toISOString(), affected);
      });
    },
    async finishLocalSubmission(input: { submissionId: string; localState: "local-confirmed" | "isolated"; reason?: string; attempt?: unknown }): Promise<void> {
      await runTransaction(handle, ["p2pkh_local_transactions", "p2pkh_local_input_claims", "p2pkh_local_outpoints"], "readwrite", async (tx) => {
        const local = tx.objectStore("p2pkh_local_transactions");
        const row = await getById<P2pkhLocalTransaction>(local, input.submissionId);
        if (!row) throw new Error("Local submission not found");

        // Confirmed sync and broadcast completion share this transaction. Once
        // sync has established a chain truth, a late provider response may
        // append its attempt audit but can never downgrade the truth or touch
        // claims/outputs that sync already reconciled.
        const requestedLocalState = input.localState;
        const chainTruth = row.chainResolution === "chain-confirmed" || row.chainResolution === "conflicted";
        const broadcastTerminal = requestedLocalState !== undefined;
        if (chainTruth && broadcastTerminal) {
          if (input.attempt) {
            row.attempts = [...row.attempts, input.attempt as P2pkhLocalTransaction["attempts"][number]];
            row.updatedAt = new Date().toISOString();
            await request(local.put(row));
          }
          return;
        }

        if (requestedLocalState !== undefined) row.localState = requestedLocalState;
        row.updatedAt = new Date().toISOString();
        row.isolationReason = requestedLocalState === "local-confirmed" ? undefined : input.reason ?? row.isolationReason;
        if (input.attempt) row.attempts = [...row.attempts, input.attempt as P2pkhLocalTransaction["attempts"][number]];
        await request(local.put(row));

        const outputs = tx.objectStore("p2pkh_local_outpoints");
        const outputIndex = outputs.index("outpointKey");
        const affected = new Set(row.inputOutpointKeys);
        const localOutputs = await allByKey<P2pkhLocalOutpoint>(outputs.index("submissionId"), input.submissionId);
        for (const output of localOutputs.filter((candidate) => candidate.resourceId === row.resourceId)) {
          affected.add(`${output.txid}:${output.vout}`);
          output.state = row.chainResolution === "conflicted" ? "invalidated" : row.localState === "local-confirmed" ? "available" : "isolated";
          output.updatedAt = new Date().toISOString();
          await request(outputs.put(output));
        }
        const consumedParentState = row.chainResolution === "conflicted" ? "invalidated" : row.localState === "local-confirmed" ? "claimed" : "isolated";
        for (const outpointKey of row.inputOutpointKeys) {
          const separator = outpointKey.lastIndexOf(":");
          const txid = outpointKey.slice(0, separator);
          const vout = Number(outpointKey.slice(separator + 1));
          for (const parent of (await allByKey<P2pkhLocalOutpoint>(outputIndex, [txid, vout])).filter((candidate) => candidate.resourceId === row.resourceId && candidate.submissionId !== row.id)) {
            parent.state = consumedParentState;
            parent.updatedAt = new Date().toISOString();
            await request(outputs.put(parent));
          }
        }
        const claims = tx.objectStore("p2pkh_local_input_claims");
        for (const claim of (await allByKey<P2pkhLocalInputClaim>(claims.index("submissionId"), input.submissionId)).filter((candidate) => candidate.resourceId === row.resourceId)) {
          claim.state = row.chainResolution === "conflicted" || row.localState === "isolated" ? "isolated" : "active";
          claim.updatedAt = new Date().toISOString();
          await request(claims.put(claim));
        }
        await normalizeLocalOutputGroupsInTransaction(tx, row.resourceId, new Date().toISOString(), affected);
      });
    },
    async abortUnattemptedLocalSubmission(input: { submissionId: string; reason?: string; requestKind: "initial" | "rebroadcast" }): Promise<void> {
      await runTransaction(handle, ["p2pkh_local_transactions", "p2pkh_local_input_claims", "p2pkh_local_outpoints"], "readwrite", async (tx) => {
        if (input.requestKind !== "initial") return;
        const local = tx.objectStore("p2pkh_local_transactions");
        const row = await getById<P2pkhLocalTransaction>(local, input.submissionId);
        const attempts = row && Array.isArray(row.attempts) ? row.attempts : [];
        if (!row || row.chainResolution !== "unresolved" || attempts.length > 0 || (row.localState !== "prepared" && row.localState !== "submitting")) return;
        const outputs = tx.objectStore("p2pkh_local_outpoints");
        const outputIndex = outputs.index("outpointKey");
        const affected = new Set(row.inputOutpointKeys);
        const ownOutputs = await allByKey<P2pkhLocalOutpoint>(outputs.index("submissionId"), row.id);
        for (const output of ownOutputs.filter((candidate) => candidate.resourceId === row.resourceId)) {
          affected.add(`${output.txid}:${output.vout}`);
          await request(outputs.delete(output.id));
        }
        for (const outpointKey of row.inputOutpointKeys) {
          const separator = outpointKey.lastIndexOf(":");
          const txid = outpointKey.slice(0, separator);
          const vout = Number(outpointKey.slice(separator + 1));
          for (const parent of (await allByKey<P2pkhLocalOutpoint>(outputIndex, [txid, vout])).filter((candidate) => candidate.resourceId === row.resourceId && candidate.submissionId !== row.id && candidate.state === "claimed")) {
            parent.state = "available";
            parent.updatedAt = new Date().toISOString();
            await request(outputs.put(parent));
          }
        }
        await request(local.delete(input.submissionId));
        const claims = tx.objectStore("p2pkh_local_input_claims");
        for (const claim of (await allByKey<P2pkhLocalInputClaim>(claims.index("submissionId"), input.submissionId)).filter((candidate) => candidate.resourceId === row.resourceId)) await request(claims.delete(claim.id));
        await normalizeLocalOutputGroupsInTransaction(tx, row.resourceId, new Date().toISOString(), affected);
        void input.reason;
      });
    },

    // Compatibility surface: protocol/token consumers read confirmed output projections.
    listUtxos: () => runTransaction(handle, "p2pkh_owned_outpoints", "readonly", async (tx) => (await allByKey<P2pkhOwnedOutpointProjection>(tx.objectStore("p2pkh_owned_outpoints").index("chainState"), "available")).map((r) => ({ id: r.id, resourceId: r.resourceId, publicKeyHex: r.publicKeyHex, network: r.network, address: r.address, txid: r.txid, vout: r.vout, value: r.value, height: r.createdBlockHeight ?? 0, script: r.scriptHex, status: "confirmed", isSpentInMempoolTx: false, syncedAt: r.updatedAt } satisfies P2pkhUtxo))),
    listUtxosByResource: (id: string) => runTransaction(handle, "p2pkh_owned_outpoints", "readonly", async (tx) => (await allByKey<P2pkhOwnedOutpointProjection>(tx.objectStore("p2pkh_owned_outpoints").index("resourceChainState"), [id, "available"])).map((r) => ({ id: r.id, resourceId: r.resourceId, publicKeyHex: r.publicKeyHex, network: r.network, address: r.address, txid: r.txid, vout: r.vout, value: r.value, height: r.createdBlockHeight ?? 0, script: r.scriptHex, status: "confirmed", isSpentInMempoolTx: false, syncedAt: r.updatedAt } satisfies P2pkhUtxo))),
    listLocalInputClaims: (limit?: number) => runTransaction(handle, "p2pkh_local_input_claims", "readonly", (tx) => { const size = boundedLimit(limit); return size ? pageByCursor<P2pkhLocalInputClaim>(tx.objectStore("p2pkh_local_input_claims"), null, "prev", size) : all<P2pkhLocalInputClaim>(tx.objectStore("p2pkh_local_input_claims")); }),
    listLocalInputClaimsByResource: (id: string, limit?: number) => runTransaction(handle, "p2pkh_local_input_claims", "readonly", (tx) => { const size = boundedLimit(limit); return size ? pageByCursor<P2pkhLocalInputClaim>(tx.objectStore("p2pkh_local_input_claims").index("resourceId"), id, "prev", size) : allByKey<P2pkhLocalInputClaim>(tx.objectStore("p2pkh_local_input_claims").index("resourceId"), id); }),
    putProtocolSubmission: (row: P2pkhProtocolSubmission) => runTransaction(handle, "p2pkh_protocol_submissions", "readwrite", async (tx) => { await request(tx.objectStore("p2pkh_protocol_submissions").put(row)); }),
    getProtocolSubmission: (id: string) => runTransaction(handle, "p2pkh_protocol_submissions", "readonly", (tx) => getById<P2pkhProtocolSubmission>(tx.objectStore("p2pkh_protocol_submissions"), id)),
    listProtocolSubmissions: () => runTransaction(handle, "p2pkh_protocol_submissions", "readonly", (tx) => all<P2pkhProtocolSubmission>(tx.objectStore("p2pkh_protocol_submissions"))),
    listProtocolSubmissionsByResource: (id: string) => runTransaction(handle, "p2pkh_protocol_submissions", "readonly", (tx) => allByKey<P2pkhProtocolSubmission>(tx.objectStore("p2pkh_protocol_submissions").index("resourceId"), id)),
    listMigrationAudits: () => runTransaction(handle, "p2pkh_migration_audits", "readonly", (tx) => all<P2pkhMigrationAudit>(tx.objectStore("p2pkh_migration_audits"))),
    removeProtocolSubmission: (id: string) => runTransaction(handle, "p2pkh_protocol_submissions", "readwrite", async (tx) => { await request(tx.objectStore("p2pkh_protocol_submissions").delete(id)); }),
    async tryClaimInputs(input: { submissionId: string; resourceId: string; publicKeyHex: string; network: BsvNetwork; inputs: P2pkhInputOutpoint[]; expectedCanonicalTxid?: string; observation?: "unconfirmed" | "confirmed" }): Promise<{ claimIds: string[] }> { const ids: string[] = []; await runTransaction(handle, "p2pkh_local_input_claims", "readwrite", async (tx) => { const store = tx.objectStore("p2pkh_local_input_claims"); for (const value of input.inputs) { const id = claimId(input.resourceId, value.txid, value.vout); const existing = await getById<P2pkhLocalInputClaim>(store, id); if (existing && existing.submissionId !== input.submissionId && !["released", "confirmed"].includes(existing.state)) throw new Error(`P2PKH input already claimed: ${value.txid}:${value.vout}`); await request(store.put({ id, submissionId: input.submissionId, resourceId: input.resourceId, publicKeyHex: input.publicKeyHex, network: input.network, txid: value.txid, vout: value.vout, canonicalTxid: input.expectedCanonicalTxid, observation: input.observation, state: "active", createdAt: existing?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString(), outpointKey: `${value.txid}:${value.vout}` })); ids.push(id); } }); return { claimIds: ids }; },
    releaseLocalInputClaims: (ids: string[]) => runTransaction(handle, "p2pkh_local_input_claims", "readwrite", async (tx) => { const store = tx.objectStore("p2pkh_local_input_claims"); for (const id of ids) { const row = await getById<P2pkhLocalInputClaim>(store, id); if (row) { row.state = "released"; row.updatedAt = new Date().toISOString(); await request(store.put(row)); } } }),

    // Compatibility writes are projected into the owned-outpoint store;
    // they never recreate the removed provider cache store.
    clearUtxosForResource: async (id: string) => runTransaction(handle, "p2pkh_owned_outpoints", "readwrite", async (tx) => { const store = tx.objectStore("p2pkh_owned_outpoints"); const rows = [...await allByKey<P2pkhOwnedOutpointProjection>(store.index("resourceChainState"), [id, "available"]), ...await allByKey<P2pkhOwnedOutpointProjection>(store.index("resourceChainState"), [id, "spent"])]; for (const row of rows) await request(store.delete(row.id)); }),
    clearAll: async () => { const names = [...handle.getDb().objectStoreNames].filter((name) => name.startsWith(STORE_PREFIX)); await runTransaction(handle, names, "readwrite", async (tx) => { for (const name of names) await request(tx.objectStore(name).clear()); }); }
  };
}

export type P2pkhDbHandle = ReturnType<typeof createP2pkhDb>;
export function resourceIdFor(network: BsvNetwork): string { return makeResourceId(network); }
export function localInputClaimIdFor(resourceId: string, txid: string, vout: number): string { return claimId(resourceId, txid, vout); }
