import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { createP2pkhDb, disposeP2pkhDb, namespaceDbName, openP2pkhDb } from "./p2pkhDb.js";

const OWNER = "02" + "11".repeat(32);
const resource = { resourceId: "p2pkh:main", publicKeyHex: OWNER, label: "test", address: "1BoatSLRHtKNngkdXEeobR76b53LETtpyT", network: "main" as const, createdAt: new Date(0).toISOString(), generation: 0 };

function keyspace() {
  return {
    openKeyStorage: (input: { publicKeyHex: string; version: number; upgrade: (db: IDBDatabase, oldVersion: number, newVersion: number, transaction?: IDBTransaction) => void }) => new Promise<{ db: IDBDatabase; name: string; close(): void }>((resolve, reject) => {
      const name = namespaceDbName(input.publicKeyHex);
      const request = indexedDB.open(name, input.version);
      request.onupgradeneeded = (event) => input.upgrade(request.result, (event as IDBVersionChangeEvent).oldVersion, input.version, request.transaction ?? undefined);
      request.onsuccess = () => resolve({ db: request.result, name, close: () => request.result.close() });
      request.onerror = () => reject(request.error);
    })
  } as never;
}

async function deleteDb(): Promise<void> {
  disposeP2pkhDb(OWNER);
  await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(namespaceDbName(OWNER)); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
}

describe("P2PKH v10 migration", () => {
  it("migrates v15 local state to dual axes, preserves audit fields and adds local indexes", async () => {
    await deleteDb().catch(() => undefined);
    const confirmedTxid = "aa".repeat(32);
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(namespaceDbName(OWNER), 15);
      request.onupgradeneeded = () => {
        const db = request.result;
        const addresses = db.createObjectStore("p2pkh_addresses", { keyPath: "resourceId" });
        addresses.put(resource);
        const facts = db.createObjectStore("p2pkh_transactions", { keyPath: "id" });
        facts.createIndex("resourceId", "resourceId");
        facts.createIndex("resourceTxid", ["resourceId", "txid"]);
        facts.put({ id: `${resource.resourceId}:${confirmedTxid}`, resourceId: resource.resourceId, txid: confirmedTxid });
        const conflictFactTxid = "bb".repeat(32);
        facts.put({ id: `${resource.resourceId}:${conflictFactTxid}`, resourceId: resource.resourceId, txid: conflictFactTxid });
        const locals = db.createObjectStore("p2pkh_local_transactions", { keyPath: "id" });
        locals.createIndex("resourceId", "resourceId");
        locals.createIndex("resourceTimeline", ["resourceId", "updatedAt", "id"]);
        locals.createIndex("txid", "txid");
        locals.createIndex("inputOutpointKeys", "inputOutpointKeys", { multiEntry: true });
        locals.createIndex("parentTxids", "parentTxids", { multiEntry: true });
        const base = { resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main" as const, rawTxHex: "deadbeef", inputOutpointKeys: ["11".repeat(32) + ":0"], ownOutputs: [{ vout: 0, value: 9, scriptHex: "" }], parentTxids: ["parent"], attempts: [{ id: "attempt", submissionId: "legacy-local", providerId: "woc", startedAt: "now", status: "accepted" as const }], createdAt: "old", updatedAt: "new" };
        locals.put({ ...base, id: "prepared", txid: "01".repeat(32), state: "prepared" });
        locals.put({ ...base, id: "submitting", txid: "02".repeat(32), state: "submitting" });
        locals.put({ ...base, id: "local-confirmed", txid: "03".repeat(32), state: "local-confirmed" });
        locals.put({ ...base, id: "isolated", txid: "04".repeat(32), state: "isolated" });
        locals.put({ ...base, id: "legacy-local", txid: confirmedTxid, state: "chain-confirmed", chainConfirmationPreviousState: "local-confirmed", conflictPreviousState: "prepared", conflictSourceTxids: ["remote"] });
        locals.put({ ...base, id: "conflicted", txid: conflictFactTxid, state: "conflicted", conflictPreviousState: "chain-confirmed", chainConfirmationPreviousState: "submitting", conflictSourceTxids: ["remote"] });
        locals.put({ ...base, id: "chain-invalid-previous", txid: "05".repeat(32), state: "chain-confirmed", chainConfirmationPreviousState: "conflicted", conflictPreviousState: "chain-confirmed" });
        locals.put({ ...base, id: "conflicted-invalid-previous", txid: "06".repeat(32), state: "conflicted", conflictPreviousState: "chain-confirmed", chainConfirmationPreviousState: "conflicted" });
      };
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
    });
    const db = createP2pkhDb(await openP2pkhDb({ keyspace: keyspace(), publicKeyHex: OWNER }));
    const localStore = db.getDb().transaction("p2pkh_local_transactions", "readonly").objectStore("p2pkh_local_transactions");
    expect(localStore.indexNames).toContain("resourceChainResolution");
    expect(localStore.indexNames).toContain("resourceTxid");
    const migratedRows = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => { const req = localStore.getAll(); req.onsuccess = () => resolve(req.result as Array<Record<string, unknown>>); req.onerror = () => reject(req.error); });
    const rowsById = new Map(migratedRows.map((item) => [String(item.id), item]));
    expect(rowsById.get("prepared")).toMatchObject({ localState: "prepared", chainResolution: "unresolved" });
    expect(rowsById.get("submitting")).toMatchObject({ localState: "submitting", chainResolution: "unresolved" });
    expect(rowsById.get("local-confirmed")).toMatchObject({ localState: "local-confirmed", chainResolution: "unresolved" });
    expect(rowsById.get("isolated")).toMatchObject({ localState: "isolated", chainResolution: "unresolved" });
    expect(rowsById.get("conflicted")).toMatchObject({ localState: "submitting", chainResolution: "conflicted", conflictSourceTxids: ["remote"] });
    expect(rowsById.get("chain-invalid-previous")).toMatchObject({ localState: "isolated", chainResolution: "chain-confirmed" });
    expect(rowsById.get("conflicted-invalid-previous")).toMatchObject({ localState: "isolated", chainResolution: "conflicted" });
    const row = rowsById.get("legacy-local");
    expect(row).toMatchObject({ localState: "local-confirmed", chainResolution: "chain-confirmed", confirmedFactId: `${resource.resourceId}:${confirmedTxid}`, rawTxHex: "deadbeef", ownOutputs: [{ vout: 0, value: 9, scriptHex: "" }], parentTxids: ["parent"], attempts: [{ id: "attempt" }], conflictSourceTxids: ["remote"], createdAt: "old", updatedAt: "new" });
    expect(row).not.toHaveProperty("state");
    expect(row).not.toHaveProperty("chainConfirmationPreviousState");
    expect(row).not.toHaveProperty("conflictPreviousState");
    await deleteDb();
  });

  it("preserves claims, local submissions, protocol submissions and removes provider stores", async () => {
    await deleteDb().catch(() => undefined);
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(namespaceDbName(OWNER), 9);
      request.onupgradeneeded = () => {
        const db = request.result;
        const addresses = db.createObjectStore("p2pkh_addresses", { keyPath: "resourceId" });
        addresses.put(resource);
        const utxos = db.createObjectStore("p2pkh_utxos", { keyPath: "id" });
        utxos.put({ id: "old-utxo" });
        const history = db.createObjectStore("p2pkh_history", { keyPath: "id" });
        history.put({ id: "old-history" });
        db.createObjectStore("p2pkh_history_backfill", { keyPath: "resourceId" });
        db.createObjectStore("p2pkh_recent_sync", { keyPath: "resourceId" });
        const submissions = db.createObjectStore("p2pkh_local_submissions", { keyPath: "id" });
        submissions.put({ id: "local-1", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", canonicalTxid: "aa".repeat(32), rawTxHex: "", inputOutpoints: [], createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() });
        const claims = db.createObjectStore("p2pkh_local_input_claims", { keyPath: "id" });
        claims.put({ id: "claim-1", submissionId: "local-1", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: "bb".repeat(32), vout: 0, state: "claimed", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() });
        claims.put({ id: "claim-observed", submissionId: "legacy-observed", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: "cc".repeat(32), vout: 1, state: "observed-consumed", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() });
        const protocol = db.createObjectStore("p2pkh_protocol_submissions", { keyPath: "id" });
        protocol.put({ id: "protocol-1", resourceId: resource.resourceId });
      };
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
    });
    const db = createP2pkhDb(await openP2pkhDb({ keyspace: keyspace(), publicKeyHex: OWNER }));
    expect((await db.listAddresses()).map((row) => row.resourceId)).toContain(resource.resourceId);
    expect((await db.listLocalTransactions()).map((row) => row.id)).toContain("local-1");
    expect(await db.listMigrationAudits()).toEqual([expect.objectContaining({ legacyId: "local-1", reason: "missing-transaction-fields", missingFields: ["rawTxHex"] })]);
    expect((await db.listLocalInputClaims()).map((row) => row.id)).toContain("claim-1");
    expect((await db.listLocalInputClaims()).find((row) => row.id === "claim-observed")?.state).toBe("isolated");
    expect((await db.listProtocolSubmissions()).map((row) => row.id)).toContain("protocol-1");
    const names = [...db.getDb().objectStoreNames];
    expect(names).toContain("p2pkh_transactions");
    expect(names).not.toContain("p2pkh_utxos");
    expect(names).not.toContain("p2pkh_history");
    expect(names).not.toContain("p2pkh_local_submissions");
    await deleteDb();
  });

  it.each([10, 11, 12, 13])("adds v12, v13 and v14 indexes when upgrading directly from v%#", async (oldVersion) => {
    await deleteDb().catch(() => undefined);
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(namespaceDbName(OWNER), oldVersion);
      request.onupgradeneeded = () => {
        const db = request.result;
        const addresses = db.createObjectStore("p2pkh_addresses", { keyPath: "resourceId" });
        addresses.createIndex("publicKeyHex", "publicKeyHex");
        addresses.createIndex("network", "network");
        addresses.createIndex("address", "address", { unique: true });
        const facts = db.createObjectStore("p2pkh_transactions", { keyPath: "id" });
        facts.createIndex("resourceId", "resourceId");
        facts.createIndex("resourceBlockHeight", ["resourceId", "blockHeight"]);
        if (oldVersion >= 12) facts.createIndex("resourceTxid", ["resourceId", "txid"]);
        if (oldVersion >= 13) facts.createIndex("resourceTimeline", ["resourceId", "lastConfirmedAt", "txid"]);
        facts.createIndex("inputOutpointKeys", "inputOutpointKeys", { multiEntry: true });
        facts.createIndex("ownedOutpointKeys", "ownedOutpointKeys", { multiEntry: true });
        facts.createIndex("txid", "txid");
        const owned = db.createObjectStore("p2pkh_owned_outpoints", { keyPath: "id" });
        owned.createIndex("resourceChainState", ["resourceId", "chainState"]);
        if (oldVersion >= 11) owned.createIndex("chainState", "chainState");
        if (oldVersion >= 12) owned.createIndex("resourceTxid", ["resourceId", "txid"]);
        if (oldVersion >= 13) owned.createIndex("resourceTimeline", ["resourceId", "updatedAt", "outpointKey"]);
        if (oldVersion >= 14) owned.createIndex("resourceOutpointKey", ["resourceId", "outpointKey"]);
        owned.createIndex("outpointKey", "outpointKey");
        owned.createIndex("spentByTxid", "spentByTxid");
        owned.createIndex("resourceCreatedBlockHeight", ["resourceId", "createdBlockHeight"]);
        const sync = db.createObjectStore("p2pkh_transaction_sync", { keyPath: "id" });
        sync.createIndex("resourceId", "resourceId", { unique: true });
        const localOutpoints = db.createObjectStore("p2pkh_local_outpoints", { keyPath: "id" });
        localOutpoints.createIndex("resourceId", "resourceId");
        if (oldVersion >= 14) localOutpoints.createIndex("resourceTimeline", ["resourceId", "updatedAt", "id"]);
        if (oldVersion >= 11) localOutpoints.createIndex("submissionId", "submissionId");
        localOutpoints.createIndex("state", "state");
        localOutpoints.createIndex("outpointKey", ["txid", "vout"]);
        const localTransactions = db.createObjectStore("p2pkh_local_transactions", { keyPath: "id" });
        localTransactions.createIndex("resourceId", "resourceId");
        if (oldVersion >= 14) localTransactions.createIndex("resourceTimeline", ["resourceId", "updatedAt", "id"]);
        const claims = db.createObjectStore("p2pkh_local_input_claims", { keyPath: "id" });
        claims.createIndex("resourceId", "resourceId");
        if (oldVersion >= 14) claims.createIndex("resourceTimeline", ["resourceId", "updatedAt", "id"]);
        claims.createIndex("outpointKey", "outpointKey");
        claims.createIndex("submissionId", "submissionId");
        claims.createIndex("state", "state");
        db.createObjectStore("p2pkh_protocol_submissions", { keyPath: "id" }).createIndex("resourceId", "resourceId");
      };
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
    });
    const db = createP2pkhDb(await openP2pkhDb({ keyspace: keyspace(), publicKeyHex: OWNER }));
    const names = [...db.getDb().objectStoreNames];
    expect(names).toContain("p2pkh_transactions");
    expect(db.getDb().transaction("p2pkh_transactions", "readonly").objectStore("p2pkh_transactions").indexNames).toContain("resourceTxid");
    expect(db.getDb().transaction("p2pkh_transactions", "readonly").objectStore("p2pkh_transactions").indexNames).toContain("resourceTimeline");
    expect(db.getDb().transaction("p2pkh_owned_outpoints", "readonly").objectStore("p2pkh_owned_outpoints").indexNames).toContain("resourceTxid");
    expect(db.getDb().transaction("p2pkh_owned_outpoints", "readonly").objectStore("p2pkh_owned_outpoints").indexNames).toContain("resourceTimeline");
    expect(db.getDb().transaction("p2pkh_owned_outpoints", "readonly").objectStore("p2pkh_owned_outpoints").indexNames).toContain("resourceOutpointKey");
    expect(db.getDb().transaction("p2pkh_local_transactions", "readonly").objectStore("p2pkh_local_transactions").indexNames).toContain("resourceTimeline");
    expect(db.getDb().transaction("p2pkh_local_outpoints", "readonly").objectStore("p2pkh_local_outpoints").indexNames).toContain("resourceTimeline");
    expect(db.getDb().transaction("p2pkh_local_input_claims", "readonly").objectStore("p2pkh_local_input_claims").indexNames).toContain("resourceTimeline");
    await deleteDb();
  });
});
