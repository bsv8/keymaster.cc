import { afterEach, describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import { createP2pkhStateRepository, openP2pkhStateRepository, disposeP2pkhStateRepository } from "./p2pkhStateRepository.js";
import { parseP2pkhTransaction, p2pkhAddressToScriptHex } from "../p2pkhTransactionParser.js";
import { createMemoryOwnerFileStore, type MemoryOwnerFileStore } from "./testSupport/memoryOwnerFileStore.js";

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

function openRepository(files: MemoryOwnerFileStore = createMemoryOwnerFileStore()) {
  return { files, open: () => openP2pkhStateRepository(files) };
}

afterEach(() => {
  disposeP2pkhStateRepository();
});

describe("p2pkhStateRepository（文件真值 + 内存本地态）", () => {
  it("确认交易写桶内文件,UTXO 由回放得到", async () => {
    const { files, open } = openRepository();
    const bundle = await open();
    const repository = createP2pkhStateRepository(bundle);
    await repository.putAddress(resource);
    const raw = transaction();
    await repository.ingestConfirmedTransaction({ resource, tx: { txid: txid(raw), rawTxHex: raw, blockHeight: 100 } });

    expect(await repository.listAddresses()).toEqual([resource]);
    expect(await repository.listTransactionFacts({ resourceId: resource.resourceId })).toHaveLength(1);
    expect((await repository.listOwnedOutpoints({ resourceId: resource.resourceId }))[0]).toMatchObject({ value: 1000, chainState: "available" });
    expect([...files.__files.keys()]).toContain(`main/tx/${txid(raw)}.json`);
    expect([...files.__files.keys()]).toContain("main/height/0000000100.json");
    bundle.close();
  });

  it("本地提交与临时占用只在内存,confirmed 后收敛为链上状态", async () => {
    const { open } = openRepository();
    const bundle = await open();
    const repository = createP2pkhStateRepository(bundle);
    await repository.putAddress(resource);
    const now = new Date(0).toISOString();
    const raw = transaction();
    const confirmedTxid = txid(raw);
    await repository.prepareLocalSubmission({
      submission: {
        id: "submission-1", resourceId: resource.resourceId, publicKeyHex: OWNER_A, network: "main",
        txid: confirmedTxid, rawTxHex: raw, localState: "submitting", chainResolution: "unresolved",
        inputOutpointKeys: [], ownOutputs: [{ vout: 0, value: 1000, scriptHex: p2pkhAddressToScriptHex(resource.address, "main") }],
        parentTxids: [], createdAt: now, updatedAt: now, attempts: []
      },
      claims: [{ id: "claim-1", submissionId: "submission-1", resourceId: resource.resourceId, publicKeyHex: OWNER_A, network: "main", txid: "bb".repeat(32), vout: 0, state: "active", createdAt: now, updatedAt: now }],
      localOutpoints: [{ id: "local-output-1", resourceId: resource.resourceId, txid: confirmedTxid, vout: 0, value: 1000, scriptHex: p2pkhAddressToScriptHex(resource.address, "main"), submissionId: "submission-1", state: "unavailable", createdAt: now, updatedAt: now }]
    });
    expect(await repository.listLocalTransactions()).toMatchObject([{ id: "submission-1", localState: "submitting" }]);
    expect(await repository.listLocalInputClaims()).toMatchObject([{ id: "claim-1", state: "active" }]);

    await repository.ingestConfirmedTransaction({ resource, tx: { txid: confirmedTxid, rawTxHex: raw, blockHeight: 100 } });
    expect((await repository.listLocalTransactions())[0]).toMatchObject({ chainResolution: "chain-confirmed" });
    // 已上链：本地输出与占用清理,不再遮蔽链上 UTXO。
    expect(await repository.listLocalOutpoints()).toHaveLength(0);
    expect(await repository.listLocalInputClaims()).toHaveLength(0);
    expect(await repository.listUtxosByResource(resource.resourceId)).toMatchObject([{ txid: confirmedTxid, value: 1000, status: "confirmed" }]);
    bundle.close();
  });

  it("链上花费关系把冲突的本地提交标为 conflicted", async () => {
    const { open } = openRepository();
    const bundle = await open();
    const repository = createP2pkhStateRepository(bundle);
    await repository.putAddress(resource);
    const now = new Date(0).toISOString();
    const parentRaw = transaction();
    const parentTxid = txid(parentRaw);
    await repository.ingestConfirmedTransaction({ resource, tx: { txid: parentTxid, rawTxHex: parentRaw, blockHeight: 100 } });
    // 本地提交花费 parent:0,但链上另一个交易先花掉了。
    const spendRaw = transaction(parentTxid);
    const spendOutpointKey = parseP2pkhTransaction(spendRaw).inputs[0]!.outpointKey;
    await repository.prepareLocalSubmission({
      submission: {
        id: "submission-conflict", resourceId: resource.resourceId, publicKeyHex: OWNER_A, network: "main",
        txid: "cc".repeat(32), rawTxHex: "", localState: "submitting", chainResolution: "unresolved",
        inputOutpointKeys: [spendOutpointKey], ownOutputs: [], parentTxids: [], createdAt: now, updatedAt: now, attempts: []
      },
      claims: [], localOutpoints: []
    });
    await repository.ingestConfirmedTransaction({ resource, tx: { txid: txid(spendRaw), rawTxHex: spendRaw, blockHeight: 101 } });
    expect((await repository.listLocalTransactions()).find((row) => row.id === "submission-conflict")).toMatchObject({ chainResolution: "conflicted" });
    bundle.close();
  });
});
