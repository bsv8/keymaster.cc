import { rememberTransaction, fundingCoin, previousTransactions, paymentRequester, cleanupPayments } from "../../../Coding/keymaster/vaultlink-integration/test/transfer-fixture.mjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { ActiveKeyCrypto, VaultWalletState, CentralBroadcastService } from "@keymaster/contracts";
import { createMemoryOwnerFileStore } from "./storage/testSupport/memoryOwnerFileStore.js";
import { createWorkerProtocolRuntime, readWorkerProtocolProtection } from "./workerProtocolRuntime.js";
import { createWorkerProtocolEvidence } from "./workerProtocolEvidence.js";
import { createP2pkhFileRepository } from "./storage/p2pkhFileRepository.js";
import { disposeP2pkhStateRepository } from "./storage/p2pkhStateRepository.js";
import { executeWorkerP2pkhBroadcast } from "./workerBroadcastExecutor.js";
import { deriveP2pkhAddress } from "./p2pkhSigner.js";

const secret = "00".repeat(31) + "a1";
const owner = deriveP2pkhAddress(secret, "main");
const input = { ...fundingCoin(owner.publicKeyHex, 10000, "11".repeat(32)), address: owner.address };
afterEach(async () => {disposeP2pkhStateRepository();await cleanupPayments();});

async function fixture() {
  const storage = createMemoryOwnerFileStore();
  let active = true;
  const assertActive = () => { if (!active) throw new Error("revoked"); };
  const provider = vi.fn(async ({ canonicalTxid }: { canonicalTxid: string }) => {
    const records = await createWorkerProtocolEvidence(storage).listProtocolSubmissions();
    expect(records.find(row => row.canonicalTxid === canonicalTxid)?.status).toBe("unknown");
    return { status: "accepted", canonicalTxid };
  });
  const broadcast = async (submission: { submissionId: string; txid: string; rawTxHex: string; resourceId: string }) => executeWorkerP2pkhBroadcast("request", {
    kind: "p2pkh.broadcast", clientId: "forum", requestId: "request", ownerPublicKeyHex: owner.publicKeyHex, network: "main", expectedSessionEpoch: "epoch", submissionId: submission.submissionId,
    submission,
  }, {
    assertFresh: assertActive, provider: { descriptor: { id: "test" }, broadcast: provider } as never,
    walletState: { snapshot: () => ({ activePublicKeyHex: owner.publicKeyHex }) } as VaultWalletState,
    storage: () => storage, sessionEpoch: () => "epoch", snapshots: undefined, resource: async () => undefined,
    listProtectedOutpoints: async () => [], listProtocolProtectedOutpoints: () => readWorkerProtocolProtection(storage, owner.publicKeyHex, "main"),
    abortNotDispatched: async () => undefined, refresh: async () => ({}), publishChanged: () => undefined,
  });
  const central = { submitOnce: async (submission: Parameters<typeof broadcast>[0]) => {
    rememberTransaction(submission.rawTxHex);
    const result = await broadcast(submission);
    if (result.ack.status !== "ok") throw new Error("broadcast validation failed");
    return result.operationResult;
  } } as unknown as CentralBroadcastService;
  const crypto = async (): Promise<ActiveKeyCrypto> => ({
    getIdentity: () => ({ ...owner, sessionId: "session", label: "owner", capabilities: [], createdAt: 0 }) as never,
    deriveP2pkhAddress: async () => owner,
    signDigest: async ({ digest, format }) => { assertActive(); const signature = secp256k1.sign(new Uint8Array(digest), Uint8Array.from(secret.match(/../g)!.map(byte => parseInt(byte, 16))), { prehash: false, lowS: true, format }); return { publicKeyHex: owner.publicKeyHex, format, signature: signature.slice().buffer as ArrayBuffer }; },
    dispose: () => undefined,
  } as ActiveKeyCrypto);
  const runtime = await createWorkerProtocolRuntime({ requestPayment: paymentRequester(secret), storage, owner: owner.publicKeyHex, assertActive, crypto, central,
    transfer: { allocateUtxos: async () => ({ selected: [input], totalInputSatoshis: input.value }) } as never,
    snapshot: async () => ({ available: false, state: "unavailable", items: [] }),
    query: () => ({ getRawTransaction: async (network: string, txid: string) => (await previousTransactions(network,[{txid}]))[0], getTransactionObservation: async () => ({ observation: "confirmed" }), getSpentOutput: async () => null }) as never,
  });
  const prepare = () => runtime.spend.presign({ ownerPublicKeyHex: owner.publicKeyHex, network: "main", feeRateSatoshisPerKb: 1, inputs: [input], outputs: [{ value: 9900, scriptHex: "51" }], noChangeRule: { maxMinerFeeSatoshis: 100 } });
  return { storage, runtime, prepare, provider, broadcast, revoke: () => { active = false; runtime.dispose(); } };
}

describe("Worker wallet protocol authority", () => {
  it("persists submission and active input claims across repository restart", async () => {
    const f = await fixture(); const preview = await f.prepare();
    disposeP2pkhStateRepository();
    const record = await createWorkerProtocolEvidence(f.storage).getProtocolSubmission(preview.submissionId!);
    expect(record?.status).toBe("prepared");
    expect(await readWorkerProtocolProtection(f.storage, owner.publicKeyHex, "main")).toContainEqual(expect.objectContaining({ txid: input.txid, vout: 0, kind: "protocol-claim" }));
    await expect(f.prepare()).rejects.toThrow("already claimed");
  });
  it("allows the matching wallet submission and writes unknown before touching the provider", async () => {
    const f = await fixture(); const preview = await f.prepare();
    expect((await f.runtime.spend.submit(preview)).status).toBe("broadcast-pending-woc");
    expect(f.provider).toHaveBeenCalledOnce();
    expect(await f.runtime.observer.observeProtocolSubmission({ ownerPublicKeyHex: owner.publicKeyHex, network: "main", txid: preview.txid, submissionId: preview.submissionId! })).toBe("observed-unconfirmed");
  });
  it("rejects a different submission trying to bypass protected input filtering", async () => {
    const f = await fixture(); const preview = await f.prepare();
    const result = await f.broadcast({ submissionId: "forged", txid: preview.txid, rawTxHex: preview.rawTxHex, resourceId: "p2pkh:main" });
    expect(result.operationResult).toMatchObject({ status: "not-dispatched", reason: "protocol-funds-protected" });
    expect(f.provider).not.toHaveBeenCalled();
  });
  it("persists release, keeps the original id observable, and allows a new claim", async () => {
    const f = await fixture(); const preview = await f.prepare();
    await f.runtime.spend.releasePreparedSubmission!({ ownerPublicKeyHex: owner.publicKeyHex, network: "main", submissionId: preview.submissionId!, txid: preview.txid });
    disposeP2pkhStateRepository();
    expect(await f.runtime.observer.observeProtocolSubmission({ ownerPublicKeyHex: owner.publicKeyHex, network: "main", txid: preview.txid, submissionId: preview.submissionId! })).toBe("not-dispatched");
    expect(await readWorkerProtocolProtection(f.storage, owner.publicKeyHex, "main")).toEqual([]);
    expect((await f.prepare()).submissionId).not.toBe(preview.submissionId);
  });
  it("retains unknown WAL and claims after an interrupted dispatch", async () => {
    const f = await fixture(); const preview = await f.prepare();
    f.provider.mockImplementationOnce(async () => { throw new Error("network interrupted after sending"); });
    expect((await f.runtime.spend.submit(preview)).status).toBe("unknown");
    disposeP2pkhStateRepository();
    expect((await createWorkerProtocolEvidence(f.storage).getProtocolSubmission(preview.submissionId!))?.status).toBe("unknown");
    await expect(f.runtime.spend.releasePrepared!(preview)).rejects.toThrow();
    expect((await readWorkerProtocolProtection(f.storage, owner.publicKeyHex, "main")).length).toBeGreaterThan(0);
  });
  it("fails closed on corrupt funding or submission evidence", async () => {
    const f = await fixture(); await f.storage.put("funding/broken.json", new TextEncoder().encode("{}"));
    await expect(readWorkerProtocolProtection(f.storage, owner.publicKeyHex, "main")).rejects.toThrow("Unreadable");
    await f.storage.delete("funding/broken.json"); await f.storage.put("protocol/broken.json", new TextEncoder().encode("{}"));
    await expect(readWorkerProtocolProtection(f.storage, owner.publicKeyHex, "main")).rejects.toThrow("Corrupt");
  });
  it("derives network-specific protection from existing wallet funding files", async () => {
    const f = await fixture();
    await createP2pkhFileRepository(f.storage).writeProtocolFunding({ fundingId: "forum:task", ownerPublicKeyHex: owner.publicKeyHex, ownerPluginId: "forum", network: "test", txid: input.txid, vout: 2, rawTxHex: "00", valueSatoshis: "100", address: owner.address, updatedAtMs: 1 });
    expect(await readWorkerProtocolProtection(f.storage, owner.publicKeyHex, "main")).toEqual([]);
    expect(await readWorkerProtocolProtection(f.storage, owner.publicKeyHex, "test")).toContainEqual(expect.objectContaining({ txid: input.txid, vout: 2, ownerPluginId: "forum" }));
  });
  it("prepares and explicitly recovers dedicated funding through the same wallet and provider", async () => {
    const f = await fixture();
    const record = await f.runtime.funding.prepareDedicatedFunding({ ownerPublicKeyHex: owner.publicKeyHex, network: "main", fundingId: "forum:task", ownerPluginId: "forum", requiredSatoshis: "1000", feeRateSatoshisPerKb: 1 });
    expect((await readWorkerProtocolProtection(f.storage, owner.publicKeyHex, "main")).some(row => row.txid === record.txid && row.vout === record.vout)).toBe(true);
    const result = await f.runtime.funding.recoverDedicatedFunding!({ ownerPublicKeyHex: owner.publicKeyHex, network: "main", fundingId: record.fundingId, feeRateSatoshisPerKb: 1, reason: { unused: true } });
    expect(result.outcome).toBe("recovered");
    expect(await createP2pkhFileRepository(f.storage).readProtocolFunding(record.fundingId)).toBeUndefined();
    expect(f.provider).toHaveBeenCalledTimes(2);
  });
  it("fences retained wallet references after scope revocation", async () => {
    const f = await fixture(); f.revoke();
    await expect(f.prepare()).rejects.toThrow("revoked"); expect(f.provider).not.toHaveBeenCalled();
  });
});
