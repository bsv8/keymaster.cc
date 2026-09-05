import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import type { OwnerAppStore } from "@keymaster/contracts";
import { createInMemoryKeyValueStore } from "@keymaster/runtime";
import { createP2pkhStateRepository, openP2pkhStateRepository, disposeP2pkhStateRepository } from "./storage/p2pkhStateRepository.js";
import { p2pkhAddressToScriptHex } from "./p2pkhTransactionParser.js";

const OWNER_A = "02" + "11".repeat(32);
const resource = {
  resourceId: "p2pkh:main",
  publicKeyHex: OWNER_A,
  label: "test",
  address: "1BoatSLRHtKNngkdXEeobR76b53LETtpyT",
  network: "main" as const,
  createdAt: new Date(0).toISOString(),
  generation: 0
};

function txid(raw: string): string {
  const bytes = Uint8Array.from(raw.match(/../g)!.map((part) => Number.parseInt(part, 16)));
  return Array.from(sha256(sha256(bytes)).reverse(), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function transaction(prevTxid?: string): string {
  const previous = prevTxid ? Array.from(Uint8Array.from(prevTxid.match(/../g)!).reverse(), (byte) => byte.toString(16).padStart(2, "0")).join("") : "00".repeat(32);
  const script = p2pkhAddressToScriptHex(resource.address, "main");
  return `0100000001${previous}0000000000ffffffff01e80300000000000019${script}00000000`;
}

function makeStore(ownerPublicKeyHex = OWNER_A): OwnerAppStore {
  return createInMemoryKeyValueStore({
    scope: "key",
    ownerPublicKeyHex,
    applicationStorageId: "UTXOS",
    schemaVersion: 1,
    bucketId: "test",
    bucketGeneration: 1
  }) as OwnerAppStore;
}

describe("p2pkhStateRepository", () => {
  it("writes business records to the injected owner K-V namespace", async () => {
    const store = makeStore();
    const bundle = await openP2pkhStateRepository(store);
    const repository = createP2pkhStateRepository(bundle);
    await repository.putAddress(resource);
    const raw = transaction();
    await repository.ingestConfirmedTransaction({ resource, tx: { txid: txid(raw), rawTxHex: raw, blockHeight: 100 } });
    expect(await repository.listAddresses()).toEqual([resource]);
    expect(await repository.listTransactionFacts({ resourceId: resource.resourceId })).toHaveLength(1);
    expect((await repository.listOwnedOutpoints({ resourceId: resource.resourceId }))[0]).toMatchObject({ value: 1000, chainState: "available" });
    const records = await store.list({ partition: "records", prefix: "record/" });
    expect(records.entries.length).toBeGreaterThan(0);
    bundle.close();
  });

  it("keeps local submission state and temporary claims in one owner namespace", async () => {
    const bundle = await openP2pkhStateRepository(makeStore());
    const repository = createP2pkhStateRepository(bundle);
    const now = new Date(0).toISOString();
    await repository.prepareLocalSubmission({
      submission: {
        id: "submission-1", resourceId: resource.resourceId, publicKeyHex: OWNER_A, network: "main",
        txid: "aa".repeat(32), rawTxHex: "", localState: "submitting", chainResolution: "unresolved",
        inputOutpointKeys: ["bb".repeat(32) + ":0"], ownOutputs: [], parentTxids: [], createdAt: now, updatedAt: now, attempts: []
      },
      claims: [{ id: "claim-1", submissionId: "submission-1", resourceId: resource.resourceId, publicKeyHex: OWNER_A, network: "main", txid: "bb".repeat(32), vout: 0, state: "active", createdAt: now, updatedAt: now }],
      localOutpoints: []
    });
    expect(await repository.listLocalTransactions()).toMatchObject([{ id: "submission-1", localState: "submitting" }]);
    expect(await repository.listLocalInputClaims()).toMatchObject([{ id: "claim-1", state: "active" }]);
    await repository.finishLocalSubmission({ submissionId: "submission-1", localState: "local-confirmed" });
    expect((await repository.listLocalTransactions())[0]?.localState).toBe("local-confirmed");
    bundle.close();
  });

  it("keeps the owner binding on the injected store", async () => {
    const store = makeStore();
    const bundle = await openP2pkhStateRepository(store);
    const repository = createP2pkhStateRepository(bundle);
    await repository.putAddress(resource);
    expect(store.ownerPublicKeyHex).toBe(OWNER_A);
    expect(await repository.listAddresses()).toEqual([resource]);
    disposeP2pkhStateRepository();
  });
});
