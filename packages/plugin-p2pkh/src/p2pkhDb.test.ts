import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import { createP2pkhDb, disposeP2pkhDb, namespaceDbName, openP2pkhDb } from "./p2pkhDb.js";
import { p2pkhAddressToScriptHex } from "./p2pkhTransactionParser.js";
import { calculateP2pkhBalanceBreakdown } from "./p2pkhService.js";
import type { P2pkhLocalInputClaim, P2pkhLocalOutpoint, P2pkhLocalTransaction } from "./p2pkhContracts.js";

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

async function putLocalData(
  db: ReturnType<typeof createP2pkhDb>,
  rows: P2pkhLocalTransaction[],
  claims: P2pkhLocalInputClaim[] = [],
  outputs: P2pkhLocalOutpoint[] = []
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const transaction = db.getDb().transaction(["p2pkh_local_transactions", "p2pkh_local_input_claims", "p2pkh_local_outpoints"], "readwrite");
    for (const row of rows) transaction.objectStore("p2pkh_local_transactions").put(row);
    for (const claim of claims) transaction.objectStore("p2pkh_local_input_claims").put(claim);
    for (const output of outputs) transaction.objectStore("p2pkh_local_outpoints").put(output);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function makeLocalRow(id: string, txidValue: string, overrides: Partial<P2pkhLocalTransaction> = {}): P2pkhLocalTransaction {
  const now = new Date(0).toISOString();
  return {
    id,
    resourceId: resource.resourceId,
    publicKeyHex: OWNER,
    network: "main",
    txid: txidValue,
    rawTxHex: "",
    localState: "local-confirmed",
    chainResolution: "unresolved",
    inputOutpointKeys: [],
    ownOutputs: [],
    parentTxids: [],
    createdAt: now,
    updatedAt: now,
    attempts: [],
    ...overrides
  };
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
      transaction.objectStore("p2pkh_local_transactions").put({ id: "local-a", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: "aa".repeat(32), rawTxHex: "", localState: "local-confirmed", chainResolution: "unresolved", inputOutpointKeys: [], ownOutputs: [], parentTxids: [], createdAt: now, updatedAt: now, attempts: [] });
      transaction.objectStore("p2pkh_local_transactions").put({ id: "local-b", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: "bb".repeat(32), rawTxHex: "", localState: "isolated", chainResolution: "unresolved", inputOutpointKeys: [], ownOutputs: [], parentTxids: [], createdAt: later, updatedAt: later, attempts: [] });
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
      submission: { id: "local-1", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: localTxid, rawTxHex: raw, localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: ["11".repeat(32) + ":0"], ownOutputs: [{ vout: 0, value: 1000, scriptHex }], parentTxids: [], createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), attempts: [] },
      claims: [{ id: "claim-1", submissionId: "local-1", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: "11".repeat(32), vout: 0, value: 1000, state: "active", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }],
      localOutpoints: [{ id: `${resource.resourceId}:${localTxid}:0`, resourceId: resource.resourceId, txid: localTxid, vout: 0, value: 1000, scriptHex, submissionId: "local-1", state: "unavailable", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }]
    });
    await db.finishLocalSubmission({ submissionId: "local-1", localState: "local-confirmed" });
    expect((await db.listLocalInputClaims())[0]?.state).toBe("active");
    await db.putTransactionSyncState({ id: resource.resourceId, resourceId: resource.resourceId, inProgressProviderId: "woc", inProgressProviderGeneration: 0, runId: "run-1", pagesSynced: 0, transactionsSynced: 0 });
    await db.ingestConfirmedTransactionPage({ resource, transactions: [{ txid: localTxid, rawTxHex: raw, blockHeight: 100 }], syncState: { id: resource.resourceId, resourceId: resource.resourceId, completeHeadTxid: localTxid, pagesSynced: 1, transactionsSynced: 1, runId: "run-1", inProgressProviderId: "woc", inProgressProviderGeneration: 0, lastSuccessAt: new Date().toISOString() } });
    expect(await db.listLocalTransactions()).toMatchObject([{ id: "local-1", localState: "local-confirmed", chainResolution: "chain-confirmed", confirmedFactId: `${resource.resourceId}:${localTxid}`, resolvedAt: expect.any(String) }]);
    await db.finishLocalSubmission({ submissionId: "local-1", localState: "isolated", reason: "late-timeout", attempt: { id: "late-failure" } });
    await db.finishLocalSubmission({ submissionId: "local-1", localState: "local-confirmed", attempt: { id: "late-success" } });
    expect(await db.listLocalTransactions()).toMatchObject([{ id: "local-1", localState: "local-confirmed", chainResolution: "chain-confirmed", attempts: [{ id: "late-failure" }, { id: "late-success" }] }]);
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
      submission: { id: "parent", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: parentTxid, rawTxHex: "", localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: ["11".repeat(32) + ":0"], ownOutputs: [{ vout: 0, value: 2_000, scriptHex: "" }], parentTxids: [], createdAt: now, updatedAt: now, attempts: [] },
      claims: [{ id: "parent-claim", submissionId: "parent", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: "11".repeat(32), vout: 0, value: 2_100, state: "active", createdAt: now, updatedAt: now }],
      localOutpoints: [{ id: `${resource.resourceId}:${parentTxid}:0`, resourceId: resource.resourceId, txid: parentTxid, vout: 0, value: 2_000, scriptHex: "", submissionId: "parent", state: "unavailable", createdAt: now, updatedAt: now }]
    });
    await db.finishLocalSubmission({ submissionId: "parent", localState: "local-confirmed" });
    const childTxid = "33".repeat(32);
    await db.prepareLocalSubmission({
      submission: { id: "child", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: childTxid, rawTxHex: "", localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: [`${parentTxid}:0`], ownOutputs: [], parentTxids: [parentTxid], createdAt: now, updatedAt: now, attempts: [] },
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

  it("single confirmed ingest conflicts a local root and its descendants atomically", async () => {
    await deleteDb().catch(() => undefined);
    const db = createP2pkhDb(await openP2pkhDb({ keyspace: keyspace(), publicKeyHex: OWNER }));
    await db.putAddress(resource);
    const rootTxid = "aa".repeat(32);
    const childTxid = "bb".repeat(32);
    const parentInput = "11".repeat(32) + ":0";
    const now = new Date(0).toISOString();
    await db.prepareLocalSubmission({
      submission: { id: "single-root", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: rootTxid, rawTxHex: "", localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: [parentInput], ownOutputs: [{ vout: 0, value: 900, scriptHex: "" }], parentTxids: [], createdAt: now, updatedAt: now, attempts: [] },
      claims: [{ id: "single-root-claim", submissionId: "single-root", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: "11".repeat(32), vout: 0, outpointKey: parentInput, value: 1000, state: "active", createdAt: now, updatedAt: now }],
      localOutpoints: [{ id: `${resource.resourceId}:${rootTxid}:0`, resourceId: resource.resourceId, txid: rootTxid, vout: 0, value: 900, scriptHex: "", submissionId: "single-root", state: "unavailable", createdAt: now, updatedAt: now }]
    });
    await db.finishLocalSubmission({ submissionId: "single-root", localState: "local-confirmed" });
    await db.prepareLocalSubmission({
      submission: { id: "single-child", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: childTxid, rawTxHex: "", localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: [`${rootTxid}:0`], ownOutputs: [], parentTxids: [rootTxid], createdAt: now, updatedAt: now, attempts: [] },
      claims: [{ id: "single-child-claim", submissionId: "single-child", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: rootTxid, vout: 0, outpointKey: `${rootTxid}:0`, value: 900, state: "active", createdAt: now, updatedAt: now }],
      localOutpoints: []
    });
    const remoteRaw = makeTx("11".repeat(32), "76a914" + "00".repeat(20) + "88ac", 500);
    const remoteTxid = txid(remoteRaw);
    await db.ingestConfirmedTransaction({ resource, tx: { txid: remoteTxid, rawTxHex: remoteRaw, blockHeight: 200 } });
    expect(await db.listLocalTransactions()).toMatchObject([
      { id: "single-child", chainResolution: "conflicted", conflictSourceTxids: [remoteTxid] },
      { id: "single-root", chainResolution: "conflicted", conflictSourceTxids: [remoteTxid] }
    ]);
    expect((await db.listLocalOutpoints()).find((row) => row.submissionId === "single-root")?.state).toBe("invalidated");
    expect((await db.listLocalInputClaims()).every((row) => row.state === "isolated")).toBe(true);
    await deleteDb();
  });

  it("always prepares a local row as unresolved regardless of caller resolution", async () => {
    await deleteDb().catch(() => undefined);
    const db = createP2pkhDb(await openP2pkhDb({ keyspace: keyspace(), publicKeyHex: OWNER }));
    await db.prepareLocalSubmission({
      submission: { id: "spoof", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: "cc".repeat(32), rawTxHex: "", localState: "submitting", chainResolution: "chain-confirmed", inputOutpointKeys: [], ownOutputs: [], parentTxids: [], createdAt: "now", updatedAt: "now", attempts: [] },
      claims: [],
      localOutpoints: []
    });
    expect((await db.listLocalTransactions()).find((row) => row.id === "spoof")).toMatchObject({ localState: "submitting", chainResolution: "unresolved" });
    await deleteDb();
  });

  it("never aborts a rebroadcast request with an empty attempt list", async () => {
    await deleteDb().catch(() => undefined);
    const db = createP2pkhDb(await openP2pkhDb({ keyspace: keyspace(), publicKeyHex: OWNER }));
    const now = new Date(0).toISOString();
    const txid = "44".repeat(32);
    await db.prepareLocalSubmission({
      submission: { id: "unknown-rebroadcast", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid, rawTxHex: "00", localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: ["55".repeat(32) + ":0"], ownOutputs: [{ vout: 0, value: 1_000, scriptHex: "" }], parentTxids: [], createdAt: now, updatedAt: now, attempts: [] },
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
      submission: { id: "isolated-local", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: localTxid, rawTxHex: raw, localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: ["11".repeat(32) + ":0"], ownOutputs: [{ vout: 0, value: 900, scriptHex }], parentTxids: [], createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), attempts: [] },
      claims: [{ id: "isolated-claim", submissionId: "isolated-local", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: "11".repeat(32), vout: 0, value: 1000, state: "active", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }],
      localOutpoints: [{ id: `${resource.resourceId}:${localTxid}:0`, resourceId: resource.resourceId, txid: localTxid, vout: 0, value: 900, scriptHex, submissionId: "isolated-local", state: "unavailable", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }]
    });
    await db.finishLocalSubmission({ submissionId: "isolated-local", localState: "isolated", reason: "broadcast-timeout" });
    const active = { id: resource.resourceId, resourceId: resource.resourceId, inProgressProviderId: "woc", inProgressProviderGeneration: 1, runId: "run-isolated", pagesSynced: 0, transactionsSynced: 0 };
    await db.putTransactionSyncState(active);
    await db.ingestConfirmedTransactionPage({ resource, transactions: [{ txid: localTxid, rawTxHex: raw, blockHeight: 300 }], syncState: { ...active, pagesSynced: 1, transactionsSynced: 1 } });
    expect(await db.listLocalTransactions()).toMatchObject([{ id: "isolated-local", localState: "isolated", chainResolution: "chain-confirmed" }]);
    await db.putTransactionSyncState({ ...active, runId: "run-isolated-reorg" });
    await db.ingestConfirmedTransactionPage({ resource, transactions: [], syncState: { id: resource.resourceId, resourceId: resource.resourceId, runId: "run-isolated-reorg", pagesSynced: 1, transactionsSynced: 0 }, reorgCheck: { observedTxids: [], completeHistory: true } });
    expect((await db.listLocalTransactions())[0]).toMatchObject({ localState: "isolated", chainResolution: "unresolved", isolationReason: "broadcast-timeout" });
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
      submission: { id: "branch-local", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: localTxid, rawTxHex: localRaw, localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: ["11".repeat(32) + ":0"], ownOutputs: [{ vout: 0, value: 900, scriptHex }], parentTxids: [], createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), attempts: [] },
      claims: [{ id: "branch-claim", submissionId: "branch-local", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: "11".repeat(32), vout: 0, value: 1000, state: "active", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }],
      localOutpoints: [{ id: `${resource.resourceId}:${localTxid}:0`, resourceId: resource.resourceId, txid: localTxid, vout: 0, value: 900, scriptHex, submissionId: "branch-local", state: "unavailable", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }]
    });
    await db.finishLocalSubmission({ submissionId: "branch-local", localState: "local-confirmed" });
    const childRaw = makeTx(localTxid, scriptHex, 800);
    const childTxid = txid(childRaw);
    await db.prepareLocalSubmission({
      submission: { id: "branch-child", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: childTxid, rawTxHex: childRaw, localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: [`${localTxid}:0`], ownOutputs: [{ vout: 0, value: 800, scriptHex }], parentTxids: [localTxid], createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), attempts: [] },
      claims: [{ id: "branch-child-claim", submissionId: "branch-child", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: localTxid, vout: 0, value: 900, state: "active", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }],
      localOutpoints: [{ id: `${resource.resourceId}:${childTxid}:0`, resourceId: resource.resourceId, txid: childTxid, vout: 0, value: 800, scriptHex, submissionId: "branch-child", state: "unavailable", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }]
    });
    await db.finishLocalSubmission({ submissionId: "branch-child", localState: "local-confirmed" });
    const remoteRaw = makeTx("11".repeat(32), "76a914" + "00".repeat(20) + "88ac", 500);
    const remoteTxid = txid(remoteRaw);
    const active = { id: resource.resourceId, resourceId: resource.resourceId, inProgressProviderId: "woc", inProgressProviderGeneration: 1, runId: "run-remote", pagesSynced: 0, transactionsSynced: 0 };
    await db.putTransactionSyncState(active);
    await db.ingestConfirmedTransactionPage({ resource, transactions: [{ txid: remoteTxid, rawTxHex: remoteRaw, blockHeight: 301 }], syncState: { ...active, pagesSynced: 1, transactionsSynced: 1 } });
    expect((await db.listLocalTransactions()).find((row) => row.id === "branch-local")?.chainResolution).toBe("conflicted");
    await db.finishLocalSubmission({ submissionId: "branch-local", localState: "isolated", reason: "late-failure", attempt: { id: "late-conflict" } });
    expect((await db.listLocalTransactions()).find((row) => row.id === "branch-local")).toMatchObject({ chainResolution: "conflicted", attempts: [{ id: "late-conflict" }] });
    expect((await db.listLocalTransactions()).find((row) => row.id === "branch-local")?.isolationReason).not.toBe("late-failure");
    await db.putTransactionSyncState({ ...active, runId: "run-remote-reorg" });
    await db.ingestConfirmedTransactionPage({ resource, transactions: [], syncState: { id: resource.resourceId, resourceId: resource.resourceId, runId: "run-remote-reorg", pagesSynced: 1, transactionsSynced: 0 }, reorgCheck: { observedTxids: [], completeHistory: true } });
    expect((await db.listLocalTransactions()).find((row) => row.id === "branch-local")?.localState).toBe("local-confirmed");
    expect((await db.listLocalInputClaims())[0]?.state).toBe("active");
    const restoredOutputs = await db.listLocalOutpoints();
    expect(restoredOutputs.find((row) => row.submissionId === "branch-local")?.state).toBe("claimed");
    expect(restoredOutputs.find((row) => row.submissionId === "branch-child")?.state).toBe("available");
    expect((await db.listLocalInputClaims()).every((row) => row.state === "active")).toBe(true);
    expect(calculateP2pkhBalanceBreakdown({ chain: [], locals: restoredOutputs, localTransactions: await db.listLocalTransactions(), claims: await db.listLocalInputClaims(), network: "main" })).toMatchObject({ localConfirmedChange: 800 });
    await deleteDb();
  });

  it("preserves an isolated reason through competing conflict and reorg", async () => {
    await deleteDb().catch(() => undefined);
    const db = createP2pkhDb(await openP2pkhDb({ keyspace: keyspace(), publicKeyHex: OWNER }));
    await db.putAddress(resource);
    const scriptHex = p2pkhAddressToScriptHex(resource.address, "main");
    const localRaw = makeTx("11".repeat(32), scriptHex, 900);
    const localTxid = txid(localRaw);
    await db.prepareLocalSubmission({
      submission: { id: "isolated-conflict", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: localTxid, rawTxHex: localRaw, localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: ["11".repeat(32) + ":0"], ownOutputs: [{ vout: 0, value: 900, scriptHex }], parentTxids: [], createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), attempts: [] },
      claims: [{ id: "isolated-conflict-claim", submissionId: "isolated-conflict", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: "11".repeat(32), vout: 0, value: 1000, state: "active", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }],
      localOutpoints: [{ id: `${resource.resourceId}:${localTxid}:0`, resourceId: resource.resourceId, txid: localTxid, vout: 0, value: 900, scriptHex, submissionId: "isolated-conflict", state: "unavailable", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }]
    });
    await db.finishLocalSubmission({ submissionId: "isolated-conflict", localState: "isolated", reason: "broadcast-timeout" });
    const remoteRaw = makeTx("11".repeat(32), "76a914" + "00".repeat(20) + "88ac", 500);
    const remoteTxid = txid(remoteRaw);
    const active = { id: resource.resourceId, resourceId: resource.resourceId, inProgressProviderId: "woc", inProgressProviderGeneration: 1, runId: "run-isolated-conflict", pagesSynced: 0, transactionsSynced: 0 };
    await db.putTransactionSyncState(active);
    await db.ingestConfirmedTransactionPage({ resource, transactions: [{ txid: remoteTxid, rawTxHex: remoteRaw, blockHeight: 302 }], syncState: { ...active, pagesSynced: 1, transactionsSynced: 1 } });
    expect((await db.listLocalTransactions())[0]).toMatchObject({ chainResolution: "conflicted", isolationReason: "broadcast-timeout", conflictSourceTxids: [remoteTxid] });
    await db.putTransactionSyncState({ ...active, runId: "run-isolated-conflict-reorg" });
    await db.ingestConfirmedTransactionPage({ resource, transactions: [], syncState: { id: resource.resourceId, resourceId: resource.resourceId, runId: "run-isolated-conflict-reorg", pagesSynced: 1, transactionsSynced: 0 }, reorgCheck: { observedTxids: [], completeHistory: true } });
    expect((await db.listLocalTransactions())[0]).toMatchObject({ localState: "isolated", chainResolution: "unresolved", isolationReason: "broadcast-timeout" });
    await db.finishLocalSubmission({ submissionId: "isolated-conflict", localState: "local-confirmed" });
    expect((await db.listLocalTransactions())[0]?.isolationReason).toBeUndefined();
    await deleteDb();
  });

  it("reclaims a restored own fact output when an unresolved child still consumes it", async () => {
    await deleteDb().catch(() => undefined);
    const db = createP2pkhDb(await openP2pkhDb({ keyspace: keyspace(), publicKeyHex: OWNER }));
    await db.putAddress(resource);
    const scriptHex = p2pkhAddressToScriptHex(resource.address, "main");
    const parentRaw = makeTx("11".repeat(32), scriptHex, 900);
    const parentTxid = txid(parentRaw);
    const childRaw = makeTx(parentTxid, scriptHex, 800);
    const childTxid = txid(childRaw);
    const now = new Date(0).toISOString();
    await db.prepareLocalSubmission({
      submission: { id: "own-reorg-parent", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: parentTxid, rawTxHex: parentRaw, localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: ["11".repeat(32) + ":0"], ownOutputs: [{ vout: 0, value: 900, scriptHex }], parentTxids: [], createdAt: now, updatedAt: now, attempts: [] },
      claims: [{ id: "own-reorg-parent-claim", submissionId: "own-reorg-parent", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: "11".repeat(32), vout: 0, value: 1000, state: "active", createdAt: now, updatedAt: now }],
      localOutpoints: [{ id: `${resource.resourceId}:${parentTxid}:0`, resourceId: resource.resourceId, txid: parentTxid, vout: 0, value: 900, scriptHex, submissionId: "own-reorg-parent", state: "unavailable", createdAt: now, updatedAt: now }]
    });
    await db.finishLocalSubmission({ submissionId: "own-reorg-parent", localState: "local-confirmed" });
    await db.prepareLocalSubmission({
      submission: { id: "own-reorg-child", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: childTxid, rawTxHex: childRaw, localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: [`${parentTxid}:0`], ownOutputs: [{ vout: 0, value: 800, scriptHex }], parentTxids: [parentTxid], createdAt: now, updatedAt: now, attempts: [] },
      claims: [{ id: "own-reorg-child-claim", submissionId: "own-reorg-child", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: parentTxid, vout: 0, value: 900, state: "active", createdAt: now, updatedAt: now }],
      localOutpoints: [{ id: `${resource.resourceId}:${childTxid}:0`, resourceId: resource.resourceId, txid: childTxid, vout: 0, value: 800, scriptHex, submissionId: "own-reorg-child", state: "unavailable", createdAt: now, updatedAt: now }]
    });
    await db.finishLocalSubmission({ submissionId: "own-reorg-child", localState: "local-confirmed" });
    const active = { id: resource.resourceId, resourceId: resource.resourceId, inProgressProviderId: "woc", inProgressProviderGeneration: 1, runId: "run-own-reorg", pagesSynced: 0, transactionsSynced: 0 };
    await db.putTransactionSyncState(active);
    await db.ingestConfirmedTransactionPage({ resource, transactions: [{ txid: parentTxid, rawTxHex: parentRaw, blockHeight: 303 }], syncState: { ...active, pagesSynced: 1, transactionsSynced: 1 } });
    expect((await db.listLocalTransactions()).find((row) => row.id === "own-reorg-parent")?.chainResolution).toBe("chain-confirmed");
    expect((await db.listLocalOutpoints()).find((row) => row.submissionId === "own-reorg-parent")).toBeUndefined();
    await db.putTransactionSyncState({ ...active, runId: "run-own-reorg-reorg" });
    await db.ingestConfirmedTransactionPage({ resource, transactions: [], syncState: { id: resource.resourceId, resourceId: resource.resourceId, runId: "run-own-reorg-reorg", pagesSynced: 1, transactionsSynced: 0 }, reorgCheck: { observedTxids: [], completeHistory: true } });
    const outputs = await db.listLocalOutpoints();
    expect(outputs.find((row) => row.submissionId === "own-reorg-parent")?.state).toBe("claimed");
    expect(outputs.find((row) => row.submissionId === "own-reorg-child")?.state).toBe("available");
    expect((await db.listLocalInputClaims()).find((row) => row.id === "own-reorg-child-claim")?.state).toBe("active");
    await deleteDb();
  });

  it("does not delete a chain-confirmed or conflicted row on a late initial abort", async () => {
    await deleteDb().catch(() => undefined);
    const db = createP2pkhDb(await openP2pkhDb({ keyspace: keyspace(), publicKeyHex: OWNER }));
    await db.putAddress(resource);
    const scriptHex = p2pkhAddressToScriptHex(resource.address, "main");
    const confirmedRaw = makeTx(undefined, scriptHex, 900);
    const confirmedTxid = txid(confirmedRaw);
    await db.prepareLocalSubmission({ submission: makeLocalRow("late-confirmed", confirmedTxid, { rawTxHex: confirmedRaw, localState: "submitting" }), claims: [], localOutpoints: [] });
    await db.finishLocalSubmission({ submissionId: "late-confirmed", localState: "local-confirmed" });
    await db.ingestConfirmedTransaction({ resource, tx: { txid: confirmedTxid, rawTxHex: confirmedRaw, blockHeight: 400 } });
    await db.abortUnattemptedLocalSubmission({ submissionId: "late-confirmed", requestKind: "initial" });
    expect((await db.listLocalTransactions()).find((row) => row.id === "late-confirmed")).toMatchObject({ chainResolution: "chain-confirmed" });

    const conflictRaw = makeTx("11".repeat(32), scriptHex, 800);
    const conflictTxid = txid(conflictRaw);
    const claimKey = `${"11".repeat(32)}:0`;
    await db.prepareLocalSubmission({
      submission: makeLocalRow("late-conflicted", conflictTxid, { rawTxHex: conflictRaw, localState: "submitting", inputOutpointKeys: [claimKey] }),
      claims: [{ id: "late-conflicted-claim", submissionId: "late-conflicted", resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: "11".repeat(32), vout: 0, outpointKey: claimKey, value: 900, state: "active", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }],
      localOutpoints: []
    });
    await db.finishLocalSubmission({ submissionId: "late-conflicted", localState: "local-confirmed" });
    const remoteRaw = makeTx("11".repeat(32), "76a914" + "00".repeat(20) + "88ac", 700);
    await db.ingestConfirmedTransaction({ resource, tx: { txid: txid(remoteRaw), rawTxHex: remoteRaw, blockHeight: 401 } });
    await db.abortUnattemptedLocalSubmission({ submissionId: "late-conflicted", requestKind: "initial" });
    expect((await db.listLocalTransactions()).find((row) => row.id === "late-conflicted")).toMatchObject({ chainResolution: "conflicted" });
    await deleteDb();
  });

  it("adjudicates every duplicate txid row and keeps one restored overlay outpoint", async () => {
    await deleteDb().catch(() => undefined);
    const db = createP2pkhDb(await openP2pkhDb({ keyspace: keyspace(), publicKeyHex: OWNER }));
    await db.putAddress(resource);
    const parentKey = `${"22".repeat(32)}:0`;
    const scriptHex = p2pkhAddressToScriptHex(resource.address, "main");
    const rootRaw = makeTx(undefined, scriptHex, 800);
    const rootTxid = txid(rootRaw);
    const childTxid = "bb".repeat(32);
    const remoteRaw = makeTx("22".repeat(32), "76a914" + "00".repeat(20) + "88ac", 500);
    const remoteTxid = txid(remoteRaw);
    const rows = [
      makeLocalRow("duplicate-root-a", rootTxid, { inputOutpointKeys: [parentKey], ownOutputs: [{ vout: 0, value: 800, scriptHex: "" }] }),
      makeLocalRow("duplicate-root-b", rootTxid, { inputOutpointKeys: [parentKey], ownOutputs: [{ vout: 0, value: 800, scriptHex: "" }] }),
      makeLocalRow("duplicate-child-a", childTxid, { inputOutpointKeys: [`${rootTxid}:0`], parentTxids: [rootTxid] }),
      makeLocalRow("duplicate-child-b", childTxid, { inputOutpointKeys: [`${rootTxid}:0`], parentTxids: [rootTxid] })
    ];
    await putLocalData(db, rows, [], [
      { id: "out-root-a", resourceId: resource.resourceId, txid: rootTxid, vout: 0, value: 800, scriptHex: "", submissionId: "duplicate-root-a", state: "available", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() },
      { id: "out-root-b", resourceId: resource.resourceId, txid: rootTxid, vout: 0, value: 800, scriptHex: "", submissionId: "duplicate-root-b", state: "available", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }
    ]);
    await db.ingestConfirmedTransaction({ resource, tx: { txid: rootTxid, rawTxHex: rootRaw, blockHeight: 402 } });
    expect((await db.listLocalTransactions()).filter((row) => row.txid === rootTxid).every((row) => row.chainResolution === "chain-confirmed")).toBe(true);
    expect((await db.listLocalOutpoints()).filter((row) => row.txid === rootTxid)).toHaveLength(0);

    await putLocalData(db, rows.map((row) => ({ ...row, chainResolution: "unresolved" as const, localState: "local-confirmed" as const, updatedAt: new Date(1).toISOString() })), [], [
      { id: "out-root-a", resourceId: resource.resourceId, txid: rootTxid, vout: 0, value: 800, scriptHex: "", submissionId: "duplicate-root-a", state: "available", createdAt: new Date(0).toISOString(), updatedAt: new Date(1).toISOString() },
      { id: "out-root-b", resourceId: resource.resourceId, txid: rootTxid, vout: 0, value: 800, scriptHex: "", submissionId: "duplicate-root-b", state: "available", createdAt: new Date(0).toISOString(), updatedAt: new Date(1).toISOString() }
    ]);
    const pagedSync = { id: resource.resourceId, resourceId: resource.resourceId, inProgressProviderId: "woc", inProgressProviderGeneration: 1, runId: "duplicate-paged", pagesSynced: 0, transactionsSynced: 0 };
    await db.putTransactionSyncState(pagedSync);
    await db.ingestConfirmedTransactionPage({ resource, transactions: [{ txid: remoteTxid, rawTxHex: remoteRaw, blockHeight: 403 }], syncState: { ...pagedSync, pagesSynced: 1, transactionsSynced: 1 } });
    expect((await db.listLocalTransactions()).filter((row) => row.id.startsWith("duplicate-")).every((row) => row.chainResolution === "conflicted")).toBe(true);
    expect((await db.listLocalOutpoints()).every((row) => row.state === "invalidated")).toBe(true);

    await db.putTransactionSyncState({ id: resource.resourceId, resourceId: resource.resourceId, inProgressProviderId: "woc", inProgressProviderGeneration: 1, runId: "duplicate-reorg", pagesSynced: 0, transactionsSynced: 0 });
    await db.ingestConfirmedTransactionPage({ resource, transactions: [], syncState: { id: resource.resourceId, resourceId: resource.resourceId, runId: "duplicate-reorg", pagesSynced: 1, transactionsSynced: 0 }, reorgCheck: { observedTxids: [], completeHistory: true } });
    expect((await db.listLocalTransactions()).filter((row) => row.id.startsWith("duplicate-root")).every((row) => row.chainResolution === "unresolved")).toBe(true);
    const restored = (await db.listLocalOutpoints()).filter((row) => row.txid === rootTxid);
    expect(restored).toHaveLength(2);
    expect(restored.filter((row) => row.state === "claimed")).toHaveLength(2);
    await deleteDb();
  });

  it("complete history resolves orphan terminal rows against facts and competing spenders", async () => {
    await deleteDb().catch(() => undefined);
    const db = createP2pkhDb(await openP2pkhDb({ keyspace: keyspace(), publicKeyHex: OWNER }));
    await db.putAddress(resource);
    const scriptHex = p2pkhAddressToScriptHex(resource.address, "main");
    const orphanRaw = makeTx("33".repeat(32), scriptHex, 700);
    const orphanTxid = txid(orphanRaw);
    await putLocalData(db, [makeLocalRow("orphan-terminal", orphanTxid, { chainResolution: "chain-confirmed", confirmedFactId: "missing-fact", rawTxHex: orphanRaw, inputOutpointKeys: [`${"33".repeat(32)}:0`], ownOutputs: [{ vout: 0, value: 700, scriptHex }] })], [], [{ id: "orphan-out", resourceId: resource.resourceId, txid: orphanTxid, vout: 0, value: 700, scriptHex, submissionId: "orphan-terminal", state: "unavailable", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }]);
    await db.putTransactionSyncState({ id: resource.resourceId, resourceId: resource.resourceId, inProgressProviderId: "woc", inProgressProviderGeneration: 1, runId: "orphan-reorg", pagesSynced: 0, transactionsSynced: 0 });
    await db.ingestConfirmedTransactionPage({ resource, transactions: [], syncState: { id: resource.resourceId, resourceId: resource.resourceId, runId: "orphan-reorg", pagesSynced: 1, transactionsSynced: 0 }, reorgCheck: { observedTxids: [], completeHistory: true } });
    expect((await db.listLocalTransactions()).find((row) => row.id === "orphan-terminal")).toMatchObject({ chainResolution: "unresolved", confirmedFactId: undefined });
    expect((await db.listLocalOutpoints()).find((row) => row.id === "orphan-out")?.state).toBe("available");

    const retainedRaw = makeTx(undefined, scriptHex, 600);
    const retainedTxid = txid(retainedRaw);
    await db.ingestConfirmedTransaction({ resource, tx: { txid: retainedTxid, rawTxHex: retainedRaw, blockHeight: 405 } });
    await putLocalData(db, [makeLocalRow("retained-terminal", retainedTxid, { chainResolution: "chain-confirmed", confirmedFactId: "wrong-fact" })]);
    await db.putTransactionSyncState({ id: resource.resourceId, resourceId: resource.resourceId, inProgressProviderId: "woc", inProgressProviderGeneration: 1, runId: "retained-fact", pagesSynced: 0, transactionsSynced: 0 });
    await db.ingestConfirmedTransactionPage({ resource, transactions: [{ txid: retainedTxid, rawTxHex: retainedRaw, blockHeight: 405 }], syncState: { id: resource.resourceId, resourceId: resource.resourceId, runId: "retained-fact", pagesSynced: 1, transactionsSynced: 1 }, reorgCheck: { observedTxids: [retainedTxid], completeHistory: true } });
    expect((await db.listLocalTransactions()).find((row) => row.id === "retained-terminal")).toMatchObject({ chainResolution: "chain-confirmed", confirmedFactId: `${resource.resourceId}:${retainedTxid}` });

    const competingRaw = makeTx("33".repeat(32), "76a914" + "00".repeat(20) + "88ac", 500);
    const competingTxid = txid(competingRaw);
    await db.putTransactionSyncState({ id: resource.resourceId, resourceId: resource.resourceId, inProgressProviderId: "woc", inProgressProviderGeneration: 1, runId: "orphan-competing", pagesSynced: 0, transactionsSynced: 0 });
    await db.ingestConfirmedTransactionPage({ resource, transactions: [{ txid: competingTxid, rawTxHex: competingRaw, blockHeight: 404 }], syncState: { id: resource.resourceId, resourceId: resource.resourceId, runId: "orphan-competing", pagesSynced: 1, transactionsSynced: 1 }, reorgCheck: { observedTxids: [competingTxid], completeHistory: true } });
    expect((await db.listLocalTransactions()).find((row) => row.id === "orphan-terminal")).toMatchObject({ chainResolution: "conflicted", conflictSourceTxids: [competingTxid] });
    await deleteDb();
  });

  it("single ingest adjudicates same-txid siblings when only one row matches the spender", async () => {
    await deleteDb().catch(() => undefined);
    const db = createP2pkhDb(await openP2pkhDb({ keyspace: keyspace(), publicKeyHex: OWNER }));
    await db.putAddress(resource);
    const rootTxid = "c1".repeat(32);
    const childTxid = "c2".repeat(32);
    const parentKey = `${"44".repeat(32)}:0`;
    await putLocalData(db, [
      makeLocalRow("single-sibling-match", rootTxid, { inputOutpointKeys: [parentKey] }),
      makeLocalRow("single-sibling-divergent", rootTxid),
      makeLocalRow("single-sibling-child", childTxid, { parentTxids: [rootTxid] })
    ]);
    const remoteRaw = makeTx("44".repeat(32), "76a914" + "00".repeat(20) + "88ac", 400);
    const remoteTxid = txid(remoteRaw);
    await db.ingestConfirmedTransaction({ resource, tx: { txid: remoteTxid, rawTxHex: remoteRaw, blockHeight: 410 } });
    expect((await db.listLocalTransactions()).filter((row) => row.id.startsWith("single-sibling-")).every((row) => row.chainResolution === "conflicted")).toBe(true);
    await deleteDb();
  });

  it("paged ingest adjudicates same-txid siblings when only one row matches the spender", async () => {
    await deleteDb().catch(() => undefined);
    const db = createP2pkhDb(await openP2pkhDb({ keyspace: keyspace(), publicKeyHex: OWNER }));
    await db.putAddress(resource);
    const rootTxid = "d1".repeat(32);
    const childTxid = "d2".repeat(32);
    const parentKey = `${"55".repeat(32)}:0`;
    await putLocalData(db, [
      makeLocalRow("paged-sibling-match", rootTxid, { inputOutpointKeys: [parentKey] }),
      makeLocalRow("paged-sibling-divergent", rootTxid),
      makeLocalRow("paged-sibling-child", childTxid, { parentTxids: [rootTxid] })
    ]);
    const remoteRaw = makeTx("55".repeat(32), "76a914" + "00".repeat(20) + "88ac", 500);
    const remoteTxid = txid(remoteRaw);
    const sync = { id: resource.resourceId, resourceId: resource.resourceId, inProgressProviderId: "woc", inProgressProviderGeneration: 1, runId: "paged-sibling-run", pagesSynced: 0, transactionsSynced: 0 };
    await db.putTransactionSyncState(sync);
    await db.ingestConfirmedTransactionPage({ resource, transactions: [{ txid: remoteTxid, rawTxHex: remoteRaw, blockHeight: 411 }], syncState: { ...sync, pagesSynced: 1, transactionsSynced: 1 } });
    expect((await db.listLocalTransactions()).filter((row) => row.id.startsWith("paged-sibling-")).every((row) => row.chainResolution === "conflicted")).toBe(true);
    await deleteDb();
  });

  it("complete history expands same-txid terminal siblings before restoring and conflicting", async () => {
    await deleteDb().catch(() => undefined);
    const db = createP2pkhDb(await openP2pkhDb({ keyspace: keyspace(), publicKeyHex: OWNER }));
    await db.putAddress(resource);
    const rootTxid = "e1".repeat(32);
    const parentKey = `${"66".repeat(32)}:0`;
    const baseOutput = { id: "base-sibling-output", resourceId: resource.resourceId, txid: rootTxid, vout: 0, value: 700, scriptHex: "", submissionId: "unresolved-sibling", state: "unavailable" as const, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
    const terminal = makeLocalRow("terminal-sibling", rootTxid, { chainResolution: "chain-confirmed", confirmedFactId: "missing", inputOutpointKeys: [parentKey], ownOutputs: [{ vout: 0, value: 700, scriptHex: "" }] });
    const sibling = makeLocalRow("unresolved-sibling", rootTxid, { inputOutpointKeys: [], ownOutputs: [{ vout: 0, value: 700, scriptHex: "" }] });
    await putLocalData(db, [terminal, sibling], [], [baseOutput]);
    const sync = { id: resource.resourceId, resourceId: resource.resourceId, inProgressProviderId: "woc", inProgressProviderGeneration: 1, runId: "terminal-restore", pagesSynced: 0, transactionsSynced: 0 };
    await db.putTransactionSyncState(sync);
    await db.ingestConfirmedTransactionPage({ resource, transactions: [], syncState: { ...sync, pagesSynced: 1, transactionsSynced: 0 }, reorgCheck: { observedTxids: [], completeHistory: true } });
    const restoredRows = await db.listLocalTransactions();
    expect(restoredRows.filter((row) => row.txid === rootTxid).every((row) => row.chainResolution === "unresolved")).toBe(true);
    const restoredOutputs = (await db.listLocalOutpoints()).filter((row) => row.txid === rootTxid);
    expect(new Set(restoredOutputs.map((row) => row.submissionId))).toEqual(new Set(["terminal-sibling", "unresolved-sibling"]));
    expect(restoredOutputs.every((row) => row.submissionId === "terminal-sibling" || row.submissionId === "unresolved-sibling")).toBe(true);

    await putLocalData(db, [
      { ...terminal, updatedAt: new Date(1).toISOString() },
      { ...sibling, updatedAt: new Date(1).toISOString() }
    ], [], restoredOutputs);
    const remoteRaw = makeTx("66".repeat(32), "76a914" + "00".repeat(20) + "88ac", 600);
    const remoteTxid = txid(remoteRaw);
    const conflictSync = { ...sync, runId: "terminal-conflict", pagesSynced: 0, transactionsSynced: 0 };
    await db.putTransactionSyncState(conflictSync);
    await db.ingestConfirmedTransactionPage({ resource, transactions: [{ txid: remoteTxid, rawTxHex: remoteRaw, blockHeight: 412 }], syncState: { ...conflictSync, pagesSynced: 1, transactionsSynced: 1 }, reorgCheck: { observedTxids: [remoteTxid], completeHistory: true } });
    expect((await db.listLocalTransactions()).filter((row) => row.txid === rootTxid).every((row) => row.chainResolution === "conflicted")).toBe(true);
    await deleteDb();
  });

  it("claims every duplicate parent output when a child consumes the logical outpoint", async () => {
    await deleteDb().catch(() => undefined);
    const db = createP2pkhDb(await openP2pkhDb({ keyspace: keyspace(), publicKeyHex: OWNER }));
    await db.putAddress(resource);
    const scriptHex = p2pkhAddressToScriptHex(resource.address, "main");
    const parentRaw = makeTx(undefined, scriptHex, 700);
    const parentTxid = txid(parentRaw);
    const childTxid = "f2".repeat(32);
    const childKey = `${parentTxid}:0`;
    const now = new Date(0).toISOString();
    const parentSubmitting = makeLocalRow("a-parent-submitting", parentTxid, { localState: "submitting", ownOutputs: [{ vout: 0, value: 700, scriptHex }] });
    const parentConfirmed = makeLocalRow("b-parent-confirmed", parentTxid, { localState: "local-confirmed", ownOutputs: [{ vout: 0, value: 700, scriptHex }] });
    const child = makeLocalRow("child-after-duplicate", childTxid, { inputOutpointKeys: [childKey], parentTxids: [parentTxid], ownOutputs: [{ vout: 0, value: 600, scriptHex }] });
    await putLocalData(db, [parentSubmitting, parentConfirmed, child], [], [
      { id: "a-parent-output", resourceId: resource.resourceId, txid: parentTxid, vout: 0, value: 700, scriptHex, submissionId: parentSubmitting.id, state: "unavailable", createdAt: now, updatedAt: now },
      { id: "b-parent-output", resourceId: resource.resourceId, txid: parentTxid, vout: 0, value: 700, scriptHex, submissionId: parentConfirmed.id, state: "available", createdAt: now, updatedAt: now },
      { id: "child-output", resourceId: resource.resourceId, txid: childTxid, vout: 0, value: 600, scriptHex, submissionId: child.id, state: "available", createdAt: now, updatedAt: now }
    ]);
    const firstSync = { id: resource.resourceId, resourceId: resource.resourceId, inProgressProviderId: "woc", inProgressProviderGeneration: 1, runId: "duplicate-lifecycle", pagesSynced: 0, transactionsSynced: 0 };
    await db.putTransactionSyncState(firstSync);
    await db.ingestConfirmedTransactionPage({ resource, transactions: [{ txid: parentTxid, rawTxHex: parentRaw, blockHeight: 413 }], syncState: { ...firstSync, pagesSynced: 1, transactionsSynced: 1 } });
    const reorgSync = { ...firstSync, runId: "duplicate-lifecycle-reorg", pagesSynced: 0, transactionsSynced: 0 };
    await db.putTransactionSyncState(reorgSync);
    await db.ingestConfirmedTransactionPage({ resource, transactions: [], syncState: { ...reorgSync, pagesSynced: 1, transactionsSynced: 0 }, reorgCheck: { observedTxids: [], completeHistory: true } });
    const outputs = await db.listLocalOutpoints();
    const parentOutputs = outputs.filter((row) => row.txid === parentTxid && row.vout === 0);
    expect(parentOutputs.filter((row) => row.state === "available")).toHaveLength(0);
    expect(parentOutputs.every((row) => row.state === "claimed")).toBe(true);
    expect(outputs.find((row) => row.submissionId === child.id)).toMatchObject({ state: "available", value: 600 });
    expect(calculateP2pkhBalanceBreakdown({ chain: [], locals: outputs, localTransactions: await db.listLocalTransactions(), claims: await db.listLocalInputClaims(), network: "main" })).toMatchObject({ localConfirmedChange: 600 });
    await db.finishLocalSubmission({ submissionId: parentSubmitting.id, localState: "local-confirmed", attempt: { id: "late-parent-success" } });
    const afterLateFinish = (await db.listLocalOutpoints()).filter((row) => row.txid === parentTxid && row.vout === 0);
    expect(afterLateFinish.filter((row) => row.state === "available")).toHaveLength(0);
    expect(afterLateFinish.every((row) => row.state === "claimed")).toBe(true);
    expect((await db.listLocalOutpoints()).find((row) => row.submissionId === child.id)).toMatchObject({ state: "available", value: 600 });
    await deleteDb();
  });

  it("complete history promotes every same-txid sibling discovered after an earlier fact page", async () => {
    await deleteDb().catch(() => undefined);
    const db = createP2pkhDb(await openP2pkhDb({ keyspace: keyspace(), publicKeyHex: OWNER }));
    await db.putAddress(resource);
    const scriptHex = p2pkhAddressToScriptHex(resource.address, "main");
    const raw = makeTx(undefined, scriptHex, 750);
    const sameTxid = txid(raw);
    await db.ingestConfirmedTransaction({ resource, tx: { txid: sameTxid, rawTxHex: raw, blockHeight: 414 } });
    const siblingA = makeLocalRow("late-unresolved-sibling", sameTxid, { chainResolution: "unresolved", ownOutputs: [{ vout: 0, value: 750, scriptHex }] });
    const siblingB = makeLocalRow("late-conflicted-sibling", sameTxid, { chainResolution: "conflicted", confirmedFactId: "wrong", conflictSourceTxids: ["old-source"], ownOutputs: [{ vout: 0, value: 750, scriptHex }] });
    const siblingC = makeLocalRow("late-unresolved-only-sibling", sameTxid, { chainResolution: "unresolved", ownOutputs: [{ vout: 0, value: 750, scriptHex }] });
    await putLocalData(db, [siblingA, siblingB, siblingC], [], [
      { id: "late-output-a", resourceId: resource.resourceId, txid: sameTxid, vout: 0, value: 750, scriptHex, submissionId: siblingA.id, state: "available", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() },
      { id: "late-output-b", resourceId: resource.resourceId, txid: sameTxid, vout: 0, value: 750, scriptHex, submissionId: siblingB.id, state: "invalidated", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() },
      { id: "late-output-c", resourceId: resource.resourceId, txid: sameTxid, vout: 0, value: 750, scriptHex, submissionId: siblingC.id, state: "available", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }
    ]);
    const sync = { id: resource.resourceId, resourceId: resource.resourceId, inProgressProviderId: "woc", inProgressProviderGeneration: 1, runId: "late-fact-complete", pagesSynced: 0, transactionsSynced: 0 };
    await db.putTransactionSyncState(sync);
    await db.ingestConfirmedTransactionPage({ resource, transactions: [], syncState: { ...sync, pagesSynced: 2, transactionsSynced: 1 }, reorgCheck: { observedTxids: [sameTxid], completeHistory: true } });
    const promoted = (await db.listLocalTransactions()).filter((row) => row.txid === sameTxid);
    expect(promoted).toHaveLength(3);
    expect(promoted).toEqual(expect.arrayContaining([
      { ...siblingA, chainResolution: "chain-confirmed", confirmedFactId: `${resource.resourceId}:${sameTxid}`, resolvedAt: expect.any(String), updatedAt: expect.any(String) },
      { ...siblingB, chainResolution: "chain-confirmed", confirmedFactId: `${resource.resourceId}:${sameTxid}`, conflictSourceTxids: undefined, resolvedAt: expect.any(String), updatedAt: expect.any(String) },
      { ...siblingC, chainResolution: "chain-confirmed", confirmedFactId: `${resource.resourceId}:${sameTxid}`, resolvedAt: expect.any(String), updatedAt: expect.any(String) }
    ]));
    expect((await db.listLocalOutpoints()).filter((row) => row.txid === sameTxid)).toHaveLength(0);
    await deleteDb();
  });

  it("complete history restores isolated conflicted rows and preserves valid conflict sources", async () => {
    await deleteDb().catch(() => undefined);
    const db = createP2pkhDb(await openP2pkhDb({ keyspace: keyspace(), publicKeyHex: OWNER }));
    await db.putAddress(resource);
    const orphanTxid = "f3".repeat(32);
    const orphan = makeLocalRow("orphan-conflicted", orphanTxid, { chainResolution: "conflicted", conflictSourceTxids: ["gone-source"], ownOutputs: [{ vout: 0, value: 500, scriptHex: "" }] });
    await putLocalData(db, [orphan], [], [{ id: "orphan-conflicted-output", resourceId: resource.resourceId, txid: orphanTxid, vout: 0, value: 500, scriptHex: "", submissionId: orphan.id, state: "invalidated", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }]);
    const sync = { id: resource.resourceId, resourceId: resource.resourceId, inProgressProviderId: "woc", inProgressProviderGeneration: 1, runId: "orphan-conflict-restore", pagesSynced: 0, transactionsSynced: 0 };
    await db.putTransactionSyncState(sync);
    await db.ingestConfirmedTransactionPage({ resource, transactions: [], syncState: { ...sync, pagesSynced: 1, transactionsSynced: 0 }, reorgCheck: { observedTxids: [], completeHistory: true } });
    expect((await db.listLocalTransactions()).find((row) => row.id === orphan.id)).toMatchObject({ chainResolution: "unresolved", conflictSourceTxids: undefined });
    expect((await db.listLocalOutpoints()).find((row) => row.submissionId === orphan.id)?.state).toBe("available");

    const sourceRaw = makeTx("77".repeat(32), "76a914" + "00".repeat(20) + "88ac", 400);
    const sourceTxid = txid(sourceRaw);
    const validTxid = "f4".repeat(32);
    const valid = makeLocalRow("valid-conflicted", validTxid, { chainResolution: "conflicted", conflictSourceTxids: [sourceTxid], inputOutpointKeys: [`${"77".repeat(32)}:0`], ownOutputs: [{ vout: 0, value: 300, scriptHex: "" }] });
    await db.ingestConfirmedTransaction({ resource, tx: { txid: sourceTxid, rawTxHex: sourceRaw, blockHeight: 415 } });
    await putLocalData(db, [valid], [], [{ id: "valid-conflicted-output", resourceId: resource.resourceId, txid: validTxid, vout: 0, value: 300, scriptHex: "", submissionId: valid.id, state: "invalidated", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }]);
    const validSync = { ...sync, runId: "valid-conflict-keep", pagesSynced: 0, transactionsSynced: 0 };
    await db.putTransactionSyncState(validSync);
    await db.ingestConfirmedTransactionPage({ resource, transactions: [], syncState: { ...validSync, pagesSynced: 1, transactionsSynced: 1 }, reorgCheck: { observedTxids: [sourceTxid], completeHistory: true } });
    expect((await db.listLocalTransactions()).find((row) => row.id === valid.id)).toMatchObject({ chainResolution: "conflicted", conflictSourceTxids: [sourceTxid] });
    const actualRemoteRaw = makeTx("88".repeat(32), "76a914" + "00".repeat(20) + "88ac", 350);
    const actualRemoteTxid = txid(actualRemoteRaw);
    const stale = makeLocalRow("stale-conflicted", "f5".repeat(32), { chainResolution: "conflicted", conflictSourceTxids: ["old-missing"], inputOutpointKeys: [`${"88".repeat(32)}:0`] });
    const testResource = { ...resource, resourceId: "p2pkh:test", network: "test" as const, address: "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn" };
    await db.putAddress(testResource);
    const crossResource = { ...makeLocalRow("cross-resource-conflicted", "f6".repeat(32), { chainResolution: "conflicted", conflictSourceTxids: ["old-missing"], inputOutpointKeys: [`${"88".repeat(32)}:0`] }), resourceId: testResource.resourceId, network: testResource.network, publicKeyHex: testResource.publicKeyHex };
    await putLocalData(db, [stale, crossResource]);
    const actualSync = { ...sync, runId: "actual-competitor", pagesSynced: 0, transactionsSynced: 0 };
    await db.putTransactionSyncState(actualSync);
    await db.ingestConfirmedTransactionPage({ resource, transactions: [{ txid: actualRemoteTxid, rawTxHex: actualRemoteRaw, blockHeight: 416 }], syncState: { ...actualSync, pagesSynced: 1, transactionsSynced: 1 }, reorgCheck: { observedTxids: [actualRemoteTxid], completeHistory: true } });
    expect((await db.listLocalTransactions()).find((row) => row.id === stale.id)).toMatchObject({ chainResolution: "conflicted", conflictSourceTxids: [actualRemoteTxid] });
    expect((await db.listLocalTransactions()).find((row) => row.id === crossResource.id)).toMatchObject({ chainResolution: "conflicted", conflictSourceTxids: ["old-missing"] });
    await deleteDb();
  });

  it("reconciles a stale chain-confirmed row against an earlier-page competing fact", async () => {
    await deleteDb().catch(() => undefined);
    const db = createP2pkhDb(await openP2pkhDb({ keyspace: keyspace(), publicKeyHex: OWNER }));
    await db.putAddress(resource);
    const parentTxid = "91".repeat(32);
    const scriptHex = p2pkhAddressToScriptHex(resource.address, "main");
    const rawA = makeTx(parentTxid, scriptHex, 700);
    const txidA = txid(rawA);
    const rawB = makeTx(parentTxid, "76a914" + "00".repeat(20) + "88ac", 650);
    const txidB = txid(rawB);
    await db.ingestConfirmedTransaction({ resource, tx: { txid: txidA, rawTxHex: rawA, blockHeight: 500 } });
    await db.ingestConfirmedTransaction({ resource, tx: { txid: txidB, rawTxHex: rawB, blockHeight: 501 } });
    const localA = makeLocalRow("stale-chain-a", txidA, { chainResolution: "chain-confirmed", confirmedFactId: `${resource.resourceId}:${txidA}`, inputOutpointKeys: [`${parentTxid}:0`], ownOutputs: [{ vout: 0, value: 700, scriptHex }] });
    await putLocalData(db, [localA]);
    const sync = { id: resource.resourceId, resourceId: resource.resourceId, inProgressProviderId: "woc", inProgressProviderGeneration: 1, runId: "stale-competition", pagesSynced: 0, transactionsSynced: 0 };
    await db.putTransactionSyncState(sync);
    await db.ingestConfirmedTransactionPage({ resource, transactions: [], syncState: { ...sync, pagesSynced: 1, transactionsSynced: 0 }, reorgCheck: { observedTxids: [txidB], completeHistory: true } });
    expect((await db.listLocalTransactions()).find((row) => row.id === localA.id)).toMatchObject({ chainResolution: "conflicted", conflictSourceTxids: [txidB] });
    await deleteDb();
  });

  it("promotes an unavailable valid sibling when the previous canonical output is isolated", async () => {
    await deleteDb().catch(() => undefined);
    const db = createP2pkhDb(await openP2pkhDb({ keyspace: keyspace(), publicKeyHex: OWNER }));
    const sharedTxid = "92".repeat(32);
    const now = new Date(0).toISOString();
    const canonical = makeLocalRow("a-canonical", sharedTxid, { localState: "local-confirmed" });
    const sibling = makeLocalRow("b-sibling", sharedTxid, { localState: "local-confirmed" });
    await putLocalData(db, [canonical, sibling], [], [
      { id: "a-canonical-output", resourceId: resource.resourceId, txid: sharedTxid, vout: 0, value: 800, scriptHex: "", submissionId: canonical.id, state: "isolated", createdAt: now, updatedAt: now },
      { id: "b-sibling-output", resourceId: resource.resourceId, txid: sharedTxid, vout: 0, value: 800, scriptHex: "", submissionId: sibling.id, state: "unavailable", createdAt: now, updatedAt: now }
    ]);
    await db.prepareLocalSubmission({
      submission: makeLocalRow("trigger-normalize", sharedTxid, { localState: "submitting", ownOutputs: [{ vout: 0, value: 800, scriptHex: "" }] }),
      claims: [],
      localOutpoints: [{ id: "trigger-normalize-output", resourceId: resource.resourceId, txid: sharedTxid, vout: 0, value: 800, scriptHex: "", submissionId: "trigger-normalize", state: "unavailable", createdAt: now, updatedAt: now }]
    });
    const outputs = (await db.listLocalOutpoints()).filter((row) => row.txid === sharedTxid);
    expect(outputs.find((row) => row.id === "a-canonical-output")?.state).toBe("isolated");
    expect(outputs.find((row) => row.id === "b-sibling-output")?.state).toBe("available");
    await deleteDb();
  });

  it("normalizes only affected outpoint groups with a large unrelated audit history", async () => {
    await deleteDb().catch(() => undefined);
    const db = createP2pkhDb(await openP2pkhDb({ keyspace: keyspace(), publicKeyHex: OWNER }));
    const now = new Date(0).toISOString();
    const history = Array.from({ length: 200 }, (_, index) => {
      const txid = index.toString(16).padStart(2, "0").repeat(32);
      const id = `unrelated-${index}`;
      return {
        row: makeLocalRow(id, txid, { localState: "local-confirmed" }),
        output: { id: `${id}-output`, resourceId: resource.resourceId, txid, vout: 0, value: index + 1, scriptHex: "", submissionId: id, state: "available" as const, createdAt: now, updatedAt: now }
      };
    });
    await putLocalData(db, history.map((entry) => entry.row), [], history.map((entry) => entry.output));
    const focusedTxid = "ff".repeat(32);
    await db.prepareLocalSubmission({
      submission: makeLocalRow("focused-submission", focusedTxid, { localState: "submitting", ownOutputs: [{ vout: 0, value: 900, scriptHex: "" }] }),
      claims: [],
      localOutpoints: [{ id: "focused-output", resourceId: resource.resourceId, txid: focusedTxid, vout: 0, value: 900, scriptHex: "", submissionId: "focused-submission", state: "unavailable", createdAt: now, updatedAt: now }]
    });
    const unrelated = (await db.listLocalOutpoints()).filter((output) => output.submissionId.startsWith("unrelated-"));
    expect(unrelated).toHaveLength(200);
    expect(unrelated.every((output) => output.state === "available" && output.updatedAt === now)).toBe(true);
    expect((await db.listLocalOutpoints()).find((output) => output.id === "focused-output")?.state).toBe("unavailable");
    await deleteDb();
  });

  it("recomputes a stale conflicted source against a surviving competing fact", async () => {
    await deleteDb().catch(() => undefined);
    const db = createP2pkhDb(await openP2pkhDb({ keyspace: keyspace(), publicKeyHex: OWNER }));
    await db.putAddress(resource);
    const parentTxid = "94".repeat(32);
    const competingInput = `${parentTxid}:0`;
    const sourceRaw = makeTx(parentTxid, "76a914" + "00".repeat(20) + "88ac", 400);
    const sourceTxid = txid(sourceRaw);
    const competingRaw = makeTx(parentTxid, "76a914" + "11".repeat(20) + "88ac", 350);
    const competingTxid = txid(competingRaw);
    await db.ingestConfirmedTransaction({ resource, tx: { txid: sourceTxid, rawTxHex: sourceRaw, blockHeight: 510 } });
    await db.ingestConfirmedTransaction({ resource, tx: { txid: competingTxid, rawTxHex: competingRaw, blockHeight: 511 } });
    const local = makeLocalRow("stale-conflict-source", "95".repeat(32), { chainResolution: "conflicted", conflictSourceTxids: [sourceTxid], inputOutpointKeys: [competingInput], ownOutputs: [{ vout: 0, value: 300, scriptHex: "" }] });
    const now = new Date(0).toISOString();
    const claim: P2pkhLocalInputClaim = { id: "stale-conflict-claim", submissionId: local.id, resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: parentTxid, vout: 0, outpointKey: competingInput, value: 500, state: "isolated", createdAt: now, updatedAt: now };
    await putLocalData(db, [local], [claim], [{ id: "stale-conflict-output", resourceId: resource.resourceId, txid: local.txid, vout: 0, value: 300, scriptHex: "", submissionId: local.id, state: "invalidated", createdAt: now, updatedAt: now }]);
    const sync = { id: resource.resourceId, resourceId: resource.resourceId, inProgressProviderId: "woc", inProgressProviderGeneration: 1, runId: "stale-conflict-source", pagesSynced: 0, transactionsSynced: 0 };
    await db.putTransactionSyncState(sync);
    await db.ingestConfirmedTransactionPage({ resource, transactions: [], syncState: { ...sync, pagesSynced: 1, transactionsSynced: 0 }, reorgCheck: { observedTxids: [competingTxid], completeHistory: true } });
    expect((await db.listLocalTransactions()).find((row) => row.id === local.id)).toMatchObject({ chainResolution: "conflicted", conflictSourceTxids: [competingTxid] });
    expect((await db.listLocalOutpoints()).find((row) => row.id === "stale-conflict-output")?.state).toBe("invalidated");
    expect((await db.listLocalInputClaims()).find((row) => row.id === claim.id)?.state).toBe("isolated");
    await deleteDb();
  });

  it("conflicts an unresolved local row written after an earlier competing fact page", async () => {
    await deleteDb().catch(() => undefined);
    const db = createP2pkhDb(await openP2pkhDb({ keyspace: keyspace(), publicKeyHex: OWNER }));
    await db.putAddress(resource);
    const parentTxid = "96".repeat(32);
    const competingRaw = makeTx(parentTxid, "76a914" + "22".repeat(20) + "88ac", 325);
    const competingTxid = txid(competingRaw);
    await db.ingestConfirmedTransaction({ resource, tx: { txid: competingTxid, rawTxHex: competingRaw, blockHeight: 512 } });
    const local = makeLocalRow("late-unresolved-competition", "97".repeat(32), { localState: "local-confirmed", chainResolution: "unresolved", inputOutpointKeys: [`${parentTxid}:0`], ownOutputs: [{ vout: 0, value: 275, scriptHex: "" }] });
    const now = new Date(0).toISOString();
    const claim: P2pkhLocalInputClaim = { id: "late-unresolved-claim", submissionId: local.id, resourceId: resource.resourceId, publicKeyHex: OWNER, network: "main", txid: parentTxid, vout: 0, outpointKey: `${parentTxid}:0`, value: 500, state: "active", createdAt: now, updatedAt: now };
    await putLocalData(db, [local], [claim], [{ id: "late-unresolved-output", resourceId: resource.resourceId, txid: local.txid, vout: 0, value: 275, scriptHex: "", submissionId: local.id, state: "available", createdAt: now, updatedAt: now }]);
    const sync = { id: resource.resourceId, resourceId: resource.resourceId, inProgressProviderId: "woc", inProgressProviderGeneration: 1, runId: "late-unresolved-competition", pagesSynced: 0, transactionsSynced: 0 };
    await db.putTransactionSyncState(sync);
    await db.ingestConfirmedTransactionPage({ resource, transactions: [], syncState: { ...sync, pagesSynced: 1, transactionsSynced: 0 }, reorgCheck: { observedTxids: [competingTxid], completeHistory: true } });
    expect((await db.listLocalTransactions()).find((row) => row.id === local.id)).toMatchObject({ chainResolution: "conflicted", conflictSourceTxids: [competingTxid] });
    expect((await db.listLocalOutpoints()).find((row) => row.id === "late-unresolved-output")?.state).toBe("invalidated");
    expect((await db.listLocalInputClaims()).find((row) => row.id === claim.id)?.state).toBe("isolated");
    await deleteDb();
  });

  it("converges a scaled complete-history fixture with linear resource maps", async () => {
    await deleteDb().catch(() => undefined);
    const db = createP2pkhDb(await openP2pkhDb({ keyspace: keyspace(), publicKeyHex: OWNER }));
    await db.putAddress(resource);
    const facts = [] as Array<{ txid: string; rawTxHex: string }>;
    for (let index = 0; index < 40; index += 1) {
      const rawTxHex = makeTx(undefined, "76a914" + "00".repeat(20) + "88ac", 100 + index);
      const fact = await db.ingestConfirmedTransaction({ resource, tx: { txid: txid(rawTxHex), rawTxHex, blockHeight: 600 + index } });
      facts.push({ txid: fact.txid, rawTxHex });
    }
    const first = facts[0]!;
    const promotedRows = facts.map((fact, index) => makeLocalRow(`scaled-promoted-${index}`, fact.txid, { chainResolution: "chain-confirmed", confirmedFactId: "stale-fact-id" }));
    const ordinary = makeLocalRow("scaled-ordinary-unresolved", "98".repeat(32), { chainResolution: "unresolved", ownOutputs: [{ vout: 0, value: 55, scriptHex: "" }] });
    const testResource = { ...resource, resourceId: "p2pkh:test", network: "test" as const, address: "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn" };
    const crossResource = { ...makeLocalRow("scaled-cross-resource", first.txid, { chainResolution: "conflicted", conflictSourceTxids: ["missing-source"] }), resourceId: testResource.resourceId, network: testResource.network };
    const now = new Date(0).toISOString();
    await putLocalData(db, [...promotedRows, ordinary, crossResource], [], [{ id: "scaled-ordinary-output", resourceId: resource.resourceId, txid: ordinary.txid, vout: 0, value: 55, scriptHex: "", submissionId: ordinary.id, state: "available", createdAt: now, updatedAt: now }]);
    const sync = { id: resource.resourceId, resourceId: resource.resourceId, inProgressProviderId: "woc", inProgressProviderGeneration: 1, runId: "scaled-complete", pagesSynced: 0, transactionsSynced: 0 };
    await db.putTransactionSyncState(sync);
    await db.ingestConfirmedTransactionPage({ resource, transactions: [], syncState: { ...sync, pagesSynced: 1, transactionsSynced: 0 }, reorgCheck: { observedTxids: facts.slice(1).map((fact) => fact.txid), completeHistory: true } });
    const rows = await db.listLocalTransactions();
    expect(rows.filter((row) => row.id.startsWith("scaled-promoted-") && row.txid !== first.txid).every((row) => row.chainResolution === "chain-confirmed" && row.confirmedFactId === `${resource.resourceId}:${row.txid}`)).toBe(true);
    expect(rows.find((row) => row.id === promotedRows[0]!.id)).toMatchObject({ chainResolution: "unresolved", confirmedFactId: undefined });
    expect(rows.find((row) => row.id === ordinary.id)).toMatchObject({ chainResolution: "unresolved" });
    expect(rows.find((row) => row.id === crossResource.id)).toMatchObject({ chainResolution: "conflicted", conflictSourceTxids: ["missing-source"] });
    await deleteDb();
  });

  it("writes each deep-DAG local row and output once from one conflict plan", async () => {
    await deleteDb().catch(() => undefined);
    const db = createP2pkhDb(await openP2pkhDb({ keyspace: keyspace(), publicKeyHex: OWNER }));
    await db.putAddress(resource);
    const sharedInputTxid = "a9".repeat(32);
    const remoteRaw = makeTx(sharedInputTxid, "76a914" + "33".repeat(20) + "88ac", 450);
    const remoteTxid = txid(remoteRaw);
    await db.ingestConfirmedTransaction({ resource, tx: { txid: remoteTxid, rawTxHex: remoteRaw, blockHeight: 900 } });
    const depth = 24;
    const now = new Date(0).toISOString();
    const rows: P2pkhLocalTransaction[] = [];
    const outputs: P2pkhLocalOutpoint[] = [];
    let parentTxid: string | undefined;
    for (let index = 0; index < depth; index += 1) {
      const localTxid = `${index.toString(16).padStart(2, "0")}`.repeat(32);
      const row = makeLocalRow(`deep-row-${index}`, localTxid, { inputOutpointKeys: [index === 0 ? `${sharedInputTxid}:0` : `${parentTxid}:0`], parentTxids: parentTxid ? [parentTxid] : [], ownOutputs: [{ vout: 0, value: 100 - index, scriptHex: "" }] });
      rows.push(row);
      outputs.push({ id: `deep-output-${index}`, resourceId: resource.resourceId, txid: localTxid, vout: 0, value: 100 - index, scriptHex: "", submissionId: row.id, state: "available", createdAt: now, updatedAt: now });
      parentTxid = localTxid;
    }
    await putLocalData(db, rows, [], outputs);
    const sync = { id: resource.resourceId, resourceId: resource.resourceId, inProgressProviderId: "woc", inProgressProviderGeneration: 1, runId: "deep-plan", pagesSynced: 0, transactionsSynced: 0 };
    await db.putTransactionSyncState(sync);
    const originalPut = IDBObjectStore.prototype.put;
    const localRowWrites = new Map<string, number>();
    const localOutputWrites = new Map<string, number>();
    IDBObjectStore.prototype.put = function(value: unknown, ...args: [IDBValidKey?]) {
      if (this.name === "p2pkh_local_transactions" && typeof value === "object" && value !== null && "id" in value) {
        const id = String((value as { id: unknown }).id);
        localRowWrites.set(id, (localRowWrites.get(id) ?? 0) + 1);
      }
      if (this.name === "p2pkh_local_outpoints" && typeof value === "object" && value !== null && "id" in value) {
        const id = String((value as { id: unknown }).id);
        localOutputWrites.set(id, (localOutputWrites.get(id) ?? 0) + 1);
      }
      return args.length > 0 ? originalPut.call(this, value as never, args[0]) : originalPut.call(this, value as never);
    };
    try {
      await db.ingestConfirmedTransactionPage({ resource, transactions: [], syncState: { ...sync, pagesSynced: 1, transactionsSynced: 1 }, reorgCheck: { observedTxids: [remoteTxid], completeHistory: true } });
    } finally {
      IDBObjectStore.prototype.put = originalPut;
    }
    expect([...localRowWrites.values()].every((count) => count === 1)).toBe(true);
    expect([...localOutputWrites.values()].every((count) => count === 1)).toBe(true);
    expect(localRowWrites.size).toBe(depth);
    expect(localOutputWrites.size).toBe(depth);
    expect((await db.listLocalTransactions()).every((row) => row.chainResolution === "conflicted")).toBe(true);
    await deleteDb();
  });
});
