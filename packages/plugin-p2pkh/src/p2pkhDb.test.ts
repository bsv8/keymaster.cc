import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import { createP2pkhDb, disposeP2pkhDb, namespaceDbName, openP2pkhDb } from "./p2pkhDb.js";
import { p2pkhAddressToScriptHex } from "./p2pkhTransactionParser.js";

const OWNER = "02" + "11".repeat(32);
const resource = { resourceId: "p2pkh:main", publicKeyHex: OWNER, label: "test", address: "1BoatSLRHtKNngkdXEeobR76b53LETtpyT", network: "main" as const, createdAt: new Date(0).toISOString(), generation: 0 };

function bytes(raw: string): Uint8Array { return Uint8Array.from(raw.match(/../g)!.map((part) => Number.parseInt(part, 16))); }
function txid(raw: string): string { return Array.from(sha256(sha256(bytes(raw))).reverse(), (byte) => byte.toString(16).padStart(2, "0")).join(""); }
function reverseHex(raw: string): string { return Array.from(bytes(raw)).reverse().map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function makeTx(prevTxid: string | undefined, scriptHex: string, value = 1000): string {
  const prev = prevTxid ? reverseHex(prevTxid) : "00".repeat(32);
  const valueHex = value.toString(16).padStart(16, "0").match(/../g)!.reverse().join("");
  return `0100000001${prev}0000000000ffffffff01${valueHex}${(scriptHex.length / 2).toString(16).padStart(2, "0")}${scriptHex}00000000`;
}

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

describe("p2pkhDb v10", () => {
  it("creates only the final fact/projection/local stores", async () => {
    await deleteDb().catch(() => undefined);
    const db = createP2pkhDb(await openP2pkhDb({ keyspace: keyspace(), publicKeyHex: OWNER }));
    const names = [...db.getDb().objectStoreNames];
    expect(names).toEqual(expect.arrayContaining(["p2pkh_addresses", "p2pkh_transactions", "p2pkh_owned_outpoints", "p2pkh_transaction_sync", "p2pkh_local_transactions", "p2pkh_local_outpoints", "p2pkh_local_input_claims", "p2pkh_protocol_submissions"]));
    expect(names).not.toEqual(expect.arrayContaining(["p2pkh_utxos", "p2pkh_history", "p2pkh_recent_sync", "p2pkh_history_backfill", "p2pkh_local_submissions"]));
    await deleteDb();
  });

  it("links spender-first and funding-first imports identically", async () => {
    const funding = makeTx(undefined, p2pkhAddressToScriptHex(resource.address, "main"));
    const fundingTxid = txid(funding);
    const spender = makeTx(fundingTxid, "76a914" + "00".repeat(20) + "88ac", 500);
    const spenderTxid = txid(spender);
    for (const order of [[spender, funding], [funding, spender]]) {
      await deleteDb().catch(() => undefined);
      const db = createP2pkhDb(await openP2pkhDb({ keyspace: keyspace(), publicKeyHex: OWNER }));
      await db.putAddress(resource);
      for (const raw of order) await db.ingestConfirmedTransaction({ resource, tx: { txid: txid(raw), rawTxHex: raw, blockHeight: 100 } });
      const owned = await db.listOwnedOutpoints({ resourceId: resource.resourceId });
      expect(owned).toHaveLength(1);
      expect(owned[0]).toMatchObject({ outpointKey: `${fundingTxid}:0`, chainState: "spent", spentByTxid: spenderTxid });
    }
    await deleteDb();
  });

  it("pages the timeline indexes and resolves input values without reading all coins", async () => {
    await deleteDb().catch(() => undefined);
    const db = createP2pkhDb(await openP2pkhDb({ keyspace: keyspace(), publicKeyHex: OWNER }));
    await db.putAddress(resource);
    const scriptHex = p2pkhAddressToScriptHex(resource.address, "main");
    const rawA = makeTx(undefined, scriptHex, 1_000);
    const rawB = makeTx(undefined, scriptHex, 2_000);
    const txidA = txid(rawA);
    const txidB = txid(rawB);
    await db.ingestConfirmedTransaction({ resource, tx: { txid: txidA, rawTxHex: rawA } });
    await db.ingestConfirmedTransaction({ resource, tx: { txid: txidB, rawTxHex: rawB } });
    const firstFacts = await db.listTransactionFactsPage({ resourceId: resource.resourceId, limit: 1 });
    const secondFacts = await db.listTransactionFactsPage({ resourceId: resource.resourceId, cursor: firstFacts.nextCursor, limit: 1 });
    expect(new Set([...firstFacts.items, ...secondFacts.items].map((row) => row.txid))).toEqual(new Set([txidA, txidB]));
    expect(secondFacts.nextCursor).toBeUndefined();
    const firstOwned = await db.listOwnedOutpointsPage({ resourceId: resource.resourceId, limit: 1 });
    const secondOwned = await db.listOwnedOutpointsPage({ resourceId: resource.resourceId, cursor: firstOwned.nextCursor, limit: 1 });
    expect(new Set([...firstOwned.items, ...secondOwned.items].map((row) => row.outpointKey))).toEqual(new Set([`${txidA}:0`, `${txidB}:0`]));
    expect(secondOwned.nextCursor).toBeUndefined();
    expect(await db.listOwnedOutpointValues(resource.resourceId, [`${txidA}:0`, "missing:0"])).toEqual({ [`${txidA}:0`]: 1_000 });
    await deleteDb();
  });

  it("scopes shared txid:vout lookups to the resource network", async () => {
    await deleteDb().catch(() => undefined);
    const db = createP2pkhDb(await openP2pkhDb({ keyspace: keyspace(), publicKeyHex: OWNER }));
    await db.putAddress(resource);
    const sharedTxid = "aa".repeat(32);
    const testResource = { ...resource, resourceId: "p2pkh:test", network: "test" as const };
    const now = new Date(0).toISOString();
    const put = (row: Record<string, unknown>) => new Promise<void>((resolve, reject) => {
      const transaction = db.getDb().transaction("p2pkh_owned_outpoints", "readwrite");
      transaction.objectStore("p2pkh_owned_outpoints").put(row);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    await put({ id: `${resource.resourceId}:${sharedTxid}:0`, resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", address: resource.address, txid: sharedTxid, vout: 0, outpointKey: `${sharedTxid}:0`, value: 100, scriptHex: "", chainState: "available", updatedAt: now });
    await put({ id: `${testResource.resourceId}:${sharedTxid}:0`, resourceId: testResource.resourceId, publicKeyHex: OWNER, network: "test", address: resource.address, txid: sharedTxid, vout: 0, outpointKey: `${sharedTxid}:0`, value: 200, scriptHex: "", chainState: "available", updatedAt: now });
    expect(await db.listOwnedOutpointValues(resource.resourceId, [`${sharedTxid}:0`])).toEqual({ [`${sharedTxid}:0`]: 100 });
    expect(await db.listOwnedOutpointValues(testResource.resourceId, [`${sharedTxid}:0`])).toEqual({ [`${sharedTxid}:0`]: 200 });
    const spendingRaw = makeTx(sharedTxid, p2pkhAddressToScriptHex(resource.address, "main"), 50);
    const spendingTxid = txid(spendingRaw);
    await db.ingestConfirmedTransaction({ resource, tx: { txid: spendingTxid, rawTxHex: spendingRaw, blockHeight: 100 } });
    const main = await db.listOwnedOutpoints({ resourceId: resource.resourceId });
    const test = await db.listOwnedOutpoints({ resourceId: testResource.resourceId });
    expect(main.find((row) => row.outpointKey === `${sharedTxid}:0`)).toMatchObject({ chainState: "spent", spentByTxid: spendingTxid });
    expect(test.find((row) => row.outpointKey === `${sharedTxid}:0`)).toMatchObject({ chainState: "available" });
    await deleteDb();
  });

  it("does not let a spender from another resource mark a funding output spent", async () => {
    await deleteDb().catch(() => undefined);
    const db = createP2pkhDb(await openP2pkhDb({ keyspace: keyspace(), publicKeyHex: OWNER }));
    const testResource = { ...resource, resourceId: "p2pkh:test", address: "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn", network: "test" as const };
    await db.putAddress(resource);
    await db.putAddress(testResource);
    const fundingRaw = makeTx(undefined, p2pkhAddressToScriptHex(resource.address, "main"), 100);
    const fundingTxid = txid(fundingRaw);
    const spenderRaw = makeTx(fundingTxid, p2pkhAddressToScriptHex(testResource.address, "test"), 50);
    const spenderTxid = txid(spenderRaw);
    const now = new Date(0).toISOString();
    const put = (row: Record<string, unknown>) => new Promise<void>((resolve, reject) => {
      const transaction = db.getDb().transaction("p2pkh_owned_outpoints", "readwrite");
      transaction.objectStore("p2pkh_owned_outpoints").put(row);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    await put({ id: `${resource.resourceId}:${fundingTxid}:0`, resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", address: resource.address, txid: fundingTxid, vout: 0, outpointKey: `${fundingTxid}:0`, value: 100, scriptHex: "", chainState: "available", updatedAt: now });
    await put({ id: `${testResource.resourceId}:${fundingTxid}:0`, resourceId: testResource.resourceId, publicKeyHex: OWNER, network: "test", address: testResource.address, txid: fundingTxid, vout: 0, outpointKey: `${fundingTxid}:0`, value: 100, scriptHex: "", chainState: "available", updatedAt: now });
    await db.ingestConfirmedTransaction({ resource: testResource, tx: { txid: spenderTxid, rawTxHex: spenderRaw, blockHeight: 101 } });
    await db.ingestConfirmedTransaction({ resource, tx: { txid: fundingTxid, rawTxHex: fundingRaw, blockHeight: 100 } });
    expect((await db.listOwnedOutpoints({ resourceId: resource.resourceId })).find((row) => row.outpointKey === `${fundingTxid}:0`)).toMatchObject({ chainState: "available" });
    expect((await db.listOwnedOutpoints({ resourceId: testResource.resourceId })).find((row) => row.outpointKey === `${fundingTxid}:0`)).toMatchObject({ chainState: "spent", spentByTxid: spenderTxid });
    await deleteDb();
  });

  it("pages local transactions, outpoints and claims with resource cursors", async () => {
    await deleteDb().catch(() => undefined);
    const db = createP2pkhDb(await openP2pkhDb({ keyspace: keyspace(), publicKeyHex: OWNER }));
    const now = new Date(0).toISOString();
    const later = new Date(1_000).toISOString();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.getDb().transaction(["p2pkh_local_transactions", "p2pkh_local_outpoints", "p2pkh_local_input_claims"], "readwrite");
      transaction.objectStore("p2pkh_local_transactions").put({ id: "local-a", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: "aa".repeat(32), rawTxHex: "", state: "local-confirmed", inputOutpointKeys: [], ownOutputs: [], parentTxids: [], createdAt: now, updatedAt: now, attempts: [] });
      transaction.objectStore("p2pkh_local_transactions").put({ id: "local-b", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: "bb".repeat(32), rawTxHex: "", state: "isolated", inputOutpointKeys: [], ownOutputs: [], parentTxids: [], createdAt: later, updatedAt: later, attempts: [] });
      transaction.objectStore("p2pkh_local_outpoints").put({ id: "out-a", resourceId: resource.resourceId, txid: "aa".repeat(32), vout: 0, value: 1, scriptHex: "", submissionId: "local-a", state: "available", createdAt: now, updatedAt: now });
      transaction.objectStore("p2pkh_local_outpoints").put({ id: "out-b", resourceId: resource.resourceId, txid: "bb".repeat(32), vout: 0, value: 2, scriptHex: "", submissionId: "local-b", state: "isolated", createdAt: later, updatedAt: later });
      transaction.objectStore("p2pkh_local_input_claims").put({ id: "claim-a", submissionId: "local-a", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: "aa".repeat(32), vout: 0, outpointKey: "aa".repeat(32) + ":0", state: "active", createdAt: now, updatedAt: now });
      transaction.objectStore("p2pkh_local_input_claims").put({ id: "claim-b", submissionId: "local-b", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: "bb".repeat(32), vout: 0, outpointKey: "bb".repeat(32) + ":0", state: "isolated", createdAt: later, updatedAt: later });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    const localTransactions = await db.listLocalTransactionsPage({ resourceId: resource.resourceId, limit: 1 });
    const localTransactionsNext = await db.listLocalTransactionsPage({ resourceId: resource.resourceId, cursor: localTransactions.nextCursor, limit: 1 });
    const localOutpoints = await db.listLocalOutpointsPage({ resourceId: resource.resourceId, limit: 1 });
    const localOutpointsNext = await db.listLocalOutpointsPage({ resourceId: resource.resourceId, cursor: localOutpoints.nextCursor, limit: 1 });
    const claims = await db.listLocalInputClaimsPage({ resourceId: resource.resourceId, limit: 1 });
    const claimsNext = await db.listLocalInputClaimsPage({ resourceId: resource.resourceId, cursor: claims.nextCursor, limit: 1 });
    expect(new Set([...localTransactions.items, ...localTransactionsNext.items].map((row) => row.id))).toEqual(new Set(["local-a", "local-b"]));
    expect(new Set([...localOutpoints.items, ...localOutpointsNext.items].map((row) => row.id))).toEqual(new Set(["out-a", "out-b"]));
    expect(new Set([...claims.items, ...claimsNext.items].map((row) => row.id))).toEqual(new Set(["claim-a", "claim-b"]));
    expect(localTransactionsNext.nextCursor).toBeUndefined();
    expect(localOutpointsNext.nextCursor).toBeUndefined();
    expect(claimsNext.nextCursor).toBeUndefined();
    await deleteDb();
  });

  it("promotes local confirmation and removes temporary claims", async () => {
    await deleteDb().catch(() => undefined);
    const db = createP2pkhDb(await openP2pkhDb({ keyspace: keyspace(), publicKeyHex: OWNER }));
    await db.putAddress(resource);
    const raw = makeTx(undefined, p2pkhAddressToScriptHex(resource.address, "main"));
    const localTxid = txid(raw);
    const scriptHex = p2pkhAddressToScriptHex(resource.address, "main");
    await db.prepareLocalSubmission({
      submission: { id: "local-1", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: localTxid, rawTxHex: raw, state: "submitting", inputOutpointKeys: ["11".repeat(32) + ":0"], ownOutputs: [{ vout: 0, value: 1000, scriptHex }], parentTxids: [], createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), attempts: [] },
      claims: [{ id: "claim-1", submissionId: "local-1", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: "11".repeat(32), vout: 0, value: 1000, state: "active", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }],
      localOutpoints: [{ id: `${resource.resourceId}:${localTxid}:0`, resourceId: resource.resourceId, txid: localTxid, vout: 0, value: 1000, scriptHex, submissionId: "local-1", state: "unavailable", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }]
    });
    await db.finishLocalSubmission({ submissionId: "local-1", state: "local-confirmed" });
    expect((await db.listLocalInputClaims())[0]?.state).toBe("active");
    await db.putTransactionSyncState({ id: resource.resourceId, resourceId: resource.resourceId, inProgressProviderId: "woc", inProgressProviderGeneration: 0, runId: "run-1", pagesSynced: 0, transactionsSynced: 0 });
    await db.ingestConfirmedTransactionPage({ resource, transactions: [{ txid: localTxid, rawTxHex: raw, blockHeight: 100 }], syncState: { id: resource.resourceId, resourceId: resource.resourceId, completeHeadTxid: localTxid, pagesSynced: 1, transactionsSynced: 1, runId: "run-1", inProgressProviderId: "woc", inProgressProviderGeneration: 0, lastSuccessAt: new Date().toISOString() } });
    expect((await db.listLocalTransactions())[0]?.state).toBe("chain-confirmed");
    await db.finishLocalSubmission({ submissionId: "local-1", state: "isolated", reason: "late-timeout", attempt: { id: "late-failure" } });
    await db.finishLocalSubmission({ submissionId: "local-1", state: "local-confirmed", attempt: { id: "late-success" } });
    expect((await db.listLocalTransactions())[0]).toMatchObject({ state: "chain-confirmed", attempts: [{ id: "late-failure" }, { id: "late-success" }] });
    expect(await db.listLocalOutpoints()).toHaveLength(0);
    expect(await db.listLocalInputClaims()).toHaveLength(0);
    await deleteDb();
  });

  it("restores a parent local change output when an unattempted child is aborted", async () => {
    await deleteDb().catch(() => undefined);
    const db = createP2pkhDb(await openP2pkhDb({ keyspace: keyspace(), publicKeyHex: OWNER }));
    await db.putAddress(resource);
    const now = new Date(0).toISOString();
    const parentTxid = "22".repeat(32);
    await db.prepareLocalSubmission({
      submission: { id: "parent", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: parentTxid, rawTxHex: "", state: "submitting", inputOutpointKeys: ["11".repeat(32) + ":0"], ownOutputs: [{ vout: 0, value: 2_000, scriptHex: "" }], parentTxids: [], createdAt: now, updatedAt: now, attempts: [] },
      claims: [{ id: "parent-claim", submissionId: "parent", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: "11".repeat(32), vout: 0, value: 2_100, state: "active", createdAt: now, updatedAt: now }],
      localOutpoints: [{ id: `${resource.resourceId}:${parentTxid}:0`, resourceId: resource.resourceId, txid: parentTxid, vout: 0, value: 2_000, scriptHex: "", submissionId: "parent", state: "unavailable", createdAt: now, updatedAt: now }]
    });
    await db.finishLocalSubmission({ submissionId: "parent", state: "local-confirmed" });
    const childTxid = "33".repeat(32);
    await db.prepareLocalSubmission({
      submission: { id: "child", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: childTxid, rawTxHex: "", state: "submitting", inputOutpointKeys: [`${parentTxid}:0`], ownOutputs: [], parentTxids: [parentTxid], createdAt: now, updatedAt: now, attempts: [] },
      claims: [{ id: "child-claim", submissionId: "child", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: parentTxid, vout: 0, value: 2_000, state: "active", createdAt: now, updatedAt: now }],
      localOutpoints: []
    });
    expect((await db.listLocalOutpoints()).find((row) => row.txid === parentTxid)?.state).toBe("claimed");
    await db.abortUnattemptedLocalSubmission({ submissionId: "child", reason: "stale-provider-generation", requestKind: "initial" });
    expect((await db.listLocalTransactions()).map((row) => row.id)).toEqual(["parent"]);
    expect((await db.listLocalInputClaims()).map((row) => row.id)).toEqual(["parent-claim"]);
    expect((await db.listLocalOutpoints()).find((row) => row.txid === parentTxid)?.state).toBe("available");
    await deleteDb();
  });

  it("never aborts a rebroadcast request with an empty attempt list", async () => {
    await deleteDb().catch(() => undefined);
    const db = createP2pkhDb(await openP2pkhDb({ keyspace: keyspace(), publicKeyHex: OWNER }));
    const now = new Date(0).toISOString();
    const txid = "44".repeat(32);
    await db.prepareLocalSubmission({
      submission: { id: "unknown-rebroadcast", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid, rawTxHex: "00", state: "submitting", inputOutpointKeys: ["55".repeat(32) + ":0"], ownOutputs: [{ vout: 0, value: 1_000, scriptHex: "" }], parentTxids: [], createdAt: now, updatedAt: now, attempts: [] },
      claims: [{ id: "unknown-rebroadcast-claim", submissionId: "unknown-rebroadcast", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: "55".repeat(32), vout: 0, value: 1_000, state: "active", createdAt: now, updatedAt: now }],
      localOutpoints: [{ id: `${resource.resourceId}:${txid}:0`, resourceId: resource.resourceId, txid, vout: 0, value: 1_000, scriptHex: "", submissionId: "unknown-rebroadcast", state: "unavailable", createdAt: now, updatedAt: now }]
    });
    await db.abortUnattemptedLocalSubmission({ submissionId: "unknown-rebroadcast", reason: "stale-provider-generation", requestKind: "rebroadcast" });
    expect(await db.listLocalTransactions()).toHaveLength(1);
    expect(await db.listLocalInputClaims()).toHaveLength(1);
    expect(await db.listLocalOutpoints()).toHaveLength(1);
    await deleteDb();
  });

  it("accepts a terminal checkpoint and reconciles facts omitted after a reorg", async () => {
    await deleteDb().catch(() => undefined);
    const db = createP2pkhDb(await openP2pkhDb({ keyspace: keyspace(), publicKeyHex: OWNER }));
    await db.putAddress(resource);
    const scriptHex = p2pkhAddressToScriptHex(resource.address, "main");
    const rawA = makeTx(undefined, scriptHex, 1_000);
    const rawB = makeTx(undefined, scriptHex, 2_000);
    const txidA = txid(rawA);
    const txidB = txid(rawB);
    const active = { id: resource.resourceId, resourceId: resource.resourceId, inProgressProviderId: "woc", inProgressProviderGeneration: 3, runId: "run-reorg", pagesSynced: 0, transactionsSynced: 0 };
    await db.putTransactionSyncState(active);
    await db.ingestConfirmedTransactionPage({ resource, transactions: [{ txid: txidA, rawTxHex: rawA, blockHeight: 200 }, { txid: txidB, rawTxHex: rawB, blockHeight: 199 }], syncState: { ...active, pagesSynced: 1, transactionsSynced: 2 } });
    await db.ingestConfirmedTransactionPage({ resource, transactions: [{ txid: txidA, rawTxHex: rawA, blockHeight: 200 }], syncState: { id: resource.resourceId, resourceId: resource.resourceId, completeHeadTxid: txidA, runId: "run-reorg", pagesSynced: 2, transactionsSynced: 3, lastSuccessAt: new Date().toISOString() }, reorgCheck: { observedTxids: [txidA], completeHistory: true } });
    expect((await db.listTransactionFacts({ resourceId: resource.resourceId })).map((row) => row.txid)).toEqual([txidA]);
    expect((await db.listOwnedOutpoints({ resourceId: resource.resourceId })).map((row) => row.txid)).toEqual([txidA]);
    expect((await db.getTransactionSyncState(resource.resourceId))?.inProgressProviderId).toBeUndefined();
    await deleteDb();
  });

  it("clears reorged facts when a provider supplies no block heights", async () => {
    await deleteDb().catch(() => undefined);
    const db = createP2pkhDb(await openP2pkhDb({ keyspace: keyspace(), publicKeyHex: OWNER }));
    await db.putAddress(resource);
    const scriptHex = p2pkhAddressToScriptHex(resource.address, "main");
    const rawA = makeTx(undefined, scriptHex, 1_000);
    const rawB = makeTx(undefined, scriptHex, 2_000);
    const txidA = txid(rawA);
    const txidB = txid(rawB);
    const active = { id: resource.resourceId, resourceId: resource.resourceId, inProgressProviderId: "junglebus", inProgressProviderGeneration: 1, runId: "run-no-height", pagesSynced: 0, transactionsSynced: 0 };
    await db.putTransactionSyncState(active);
    await db.ingestConfirmedTransactionPage({ resource, transactions: [{ txid: txidA, rawTxHex: rawA }, { txid: txidB, rawTxHex: rawB }], syncState: { ...active, pagesSynced: 1, transactionsSynced: 2 } });
    await db.ingestConfirmedTransactionPage({ resource, transactions: [{ txid: txidB, rawTxHex: rawB }], syncState: { id: resource.resourceId, resourceId: resource.resourceId, completeHeadTxid: txidB, runId: "run-no-height", pagesSynced: 2, transactionsSynced: 3 }, reorgCheck: { observedTxids: [txidB], completeHistory: true } });
    expect((await db.listTransactionFacts({ resourceId: resource.resourceId })).map((row) => row.txid)).toEqual([txidB]);
    expect((await db.listOwnedOutpoints({ resourceId: resource.resourceId })).map((row) => row.txid)).toEqual([txidB]);
    await deleteDb();
  });

  it("restores an originally isolated local transaction as isolated after its fact reorgs", async () => {
    await deleteDb().catch(() => undefined);
    const db = createP2pkhDb(await openP2pkhDb({ keyspace: keyspace(), publicKeyHex: OWNER }));
    await db.putAddress(resource);
    const scriptHex = p2pkhAddressToScriptHex(resource.address, "main");
    const raw = makeTx("11".repeat(32), scriptHex, 900);
    const localTxid = txid(raw);
    await db.prepareLocalSubmission({
      submission: { id: "isolated-local", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: localTxid, rawTxHex: raw, state: "submitting", inputOutpointKeys: ["11".repeat(32) + ":0"], ownOutputs: [{ vout: 0, value: 900, scriptHex }], parentTxids: [], createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), attempts: [] },
      claims: [{ id: "isolated-claim", submissionId: "isolated-local", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: "11".repeat(32), vout: 0, value: 1000, state: "active", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }],
      localOutpoints: [{ id: `${resource.resourceId}:${localTxid}:0`, resourceId: resource.resourceId, txid: localTxid, vout: 0, value: 900, scriptHex, submissionId: "isolated-local", state: "unavailable", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }]
    });
    await db.finishLocalSubmission({ submissionId: "isolated-local", state: "isolated", reason: "broadcast-timeout" });
    const active = { id: resource.resourceId, resourceId: resource.resourceId, inProgressProviderId: "woc", inProgressProviderGeneration: 1, runId: "run-isolated", pagesSynced: 0, transactionsSynced: 0 };
    await db.putTransactionSyncState(active);
    await db.ingestConfirmedTransactionPage({ resource, transactions: [{ txid: localTxid, rawTxHex: raw, blockHeight: 300 }], syncState: { ...active, pagesSynced: 1, transactionsSynced: 1 } });
    expect((await db.listLocalTransactions())[0]?.state).toBe("chain-confirmed");
    await db.putTransactionSyncState({ ...active, runId: "run-isolated-reorg" });
    await db.ingestConfirmedTransactionPage({ resource, transactions: [], syncState: { id: resource.resourceId, resourceId: resource.resourceId, runId: "run-isolated-reorg", pagesSynced: 1, transactionsSynced: 0 }, reorgCheck: { observedTxids: [], completeHistory: true } });
    expect((await db.listLocalTransactions())[0]).toMatchObject({ state: "isolated", isolationReason: "broadcast-timeout" });
    expect((await db.listLocalInputClaims())[0]?.state).toBe("isolated");
    expect((await db.listLocalOutpoints())[0]).toMatchObject({ state: "isolated", value: 900 });
    await deleteDb();
  });

  it("restores a local branch invalidated by a competing fact when that fact reorgs", async () => {
    await deleteDb().catch(() => undefined);
    const db = createP2pkhDb(await openP2pkhDb({ keyspace: keyspace(), publicKeyHex: OWNER }));
    await db.putAddress(resource);
    const scriptHex = p2pkhAddressToScriptHex(resource.address, "main");
    const localRaw = makeTx("11".repeat(32), scriptHex, 900);
    const localTxid = txid(localRaw);
    await db.prepareLocalSubmission({
      submission: { id: "branch-local", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: localTxid, rawTxHex: localRaw, state: "submitting", inputOutpointKeys: ["11".repeat(32) + ":0"], ownOutputs: [{ vout: 0, value: 900, scriptHex }], parentTxids: [], createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), attempts: [] },
      claims: [{ id: "branch-claim", submissionId: "branch-local", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: "11".repeat(32), vout: 0, value: 1000, state: "active", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }],
      localOutpoints: [{ id: `${resource.resourceId}:${localTxid}:0`, resourceId: resource.resourceId, txid: localTxid, vout: 0, value: 900, scriptHex, submissionId: "branch-local", state: "unavailable", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }]
    });
    await db.finishLocalSubmission({ submissionId: "branch-local", state: "local-confirmed" });
    const remoteRaw = makeTx("11".repeat(32), "76a914" + "00".repeat(20) + "88ac", 500);
    const remoteTxid = txid(remoteRaw);
    const active = { id: resource.resourceId, resourceId: resource.resourceId, inProgressProviderId: "woc", inProgressProviderGeneration: 1, runId: "run-remote", pagesSynced: 0, transactionsSynced: 0 };
    await db.putTransactionSyncState(active);
    await db.ingestConfirmedTransactionPage({ resource, transactions: [{ txid: remoteTxid, rawTxHex: remoteRaw, blockHeight: 301 }], syncState: { ...active, pagesSynced: 1, transactionsSynced: 1 } });
    expect((await db.listLocalTransactions())[0]?.state).toBe("conflicted");
    await db.finishLocalSubmission({ submissionId: "branch-local", state: "isolated", reason: "late-failure", attempt: { id: "late-conflict" } });
    expect((await db.listLocalTransactions())[0]).toMatchObject({ state: "conflicted", attempts: [{ id: "late-conflict" }] });
    expect((await db.listLocalTransactions())[0]?.isolationReason).not.toBe("late-failure");
    await db.putTransactionSyncState({ ...active, runId: "run-remote-reorg" });
    await db.ingestConfirmedTransactionPage({ resource, transactions: [], syncState: { id: resource.resourceId, resourceId: resource.resourceId, runId: "run-remote-reorg", pagesSynced: 1, transactionsSynced: 0 }, reorgCheck: { observedTxids: [], completeHistory: true } });
    expect((await db.listLocalTransactions())[0]?.state).toBe("local-confirmed");
    expect((await db.listLocalInputClaims())[0]?.state).toBe("active");
    expect((await db.listLocalOutpoints())[0]).toMatchObject({ state: "available", value: 900 });
    await deleteDb();
  });
});
