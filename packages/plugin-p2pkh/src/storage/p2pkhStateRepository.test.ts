import { afterEach, describe, expect, it } from "vitest";
import { createP2pkhStateRepository, openP2pkhStateRepository, disposeP2pkhStateRepository } from "./p2pkhStateRepository.js";
import { p2pkhAddressToScriptHex } from "../p2pkhTransactionParser.js";
import { createMemoryOwnerFileStore, type MemoryOwnerFileStore } from "./testSupport/memoryOwnerFileStore.js";

const OWNER_A = "02" + "11".repeat(32);
const resource = {
  resourceId: "p2pkh:main",
  publicKeyHex: OWNER_A,
  label: "test",
  address: "1BoatSLRHtKNngkdXEeobR76b53LETtpyT",
  network: "main" as const,
  createdAt: new Date(0).toISOString(),
  generation: 0,
};

function openRepository(files: MemoryOwnerFileStore = createMemoryOwnerFileStore()) {
  return { files, open: () => openP2pkhStateRepository(files as never) };
}

function submission(id: string, txid: string) {
  const now = new Date(0).toISOString();
  return {
    id, resourceId: resource.resourceId, publicKeyHex: OWNER_A, network: "main" as const,
    txid, rawTxHex: "00", localState: "submitting" as const, chainResolution: "unresolved" as const,
    inputOutpointKeys: [], ownOutputs: [{ vout: 0, value: 1000, scriptHex: p2pkhAddressToScriptHex(resource.address, "main") }],
    createdAt: now, updatedAt: now, attempts: [],
  };
}

function claimFor(submissionId: string, txid: string, vout = 0) {
  const now = new Date(0).toISOString();
  return { id: `${resource.resourceId}:${txid}:${vout}`, submissionId, resourceId: resource.resourceId, publicKeyHex: OWNER_A, network: "main" as const, txid, vout, outpointKey: `${txid}:${vout}`, value: 1000, state: "active" as const, createdAt: now, updatedAt: now };
}

afterEach(() => {
  disposeP2pkhStateRepository();
});

describe("p2pkhStateRepository（历史元数据 + 内存本地态）", () => {
  it("管理资源表的增删改查", async () => {
    const { open } = openRepository();
    const bundle = await open();
    const repository = createP2pkhStateRepository(bundle);
    await repository.putAddress(resource);
    expect(await repository.listAddresses()).toEqual([resource]);
    expect(await repository.listResourcesByKey()).toEqual([resource]);
    expect(await repository.getResource(resource.resourceId)).toEqual(resource);
    await repository.removeResource(resource.resourceId);
    expect(await repository.getResource(resource.resourceId)).toBeUndefined();
    bundle.close();
  });

  it("整文件替换历史并分页读取", async () => {
    const { open } = openRepository();
    const bundle = await open();
    const repository = createP2pkhStateRepository(bundle);
    await repository.putAddress(resource);
    const txA = "aa".repeat(32);
    const txB = "bb".repeat(32);
    await repository.replaceHistory(resource, [{ txid: txA, height: 10 }, { txid: txB, height: 11, fee: 7 }]);
    expect((await repository.listHistory({ resourceId: resource.resourceId })).map((row) => row.txid).sort()).toEqual([txA, txB]);
    const page = await repository.listHistoryPage({ resourceId: resource.resourceId, limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeTruthy();
    // 整文件替换丢弃旧记录。
    await repository.replaceHistory(resource, [{ txid: txB, height: 11, fee: 7 }]);
    expect((await repository.listHistory({ resourceId: resource.resourceId })).map((row) => row.txid)).toEqual([txB]);
    bundle.close();
  });

  it("相同 txid 收敛本地提交为 chain-confirmed，不派生冲突 DAG", async () => {
    const { open } = openRepository();
    const bundle = await open();
    const repository = createP2pkhStateRepository(bundle);
    await repository.putAddress(resource);
    const txid = "cc".repeat(32);
    const otherTxid = "dd".repeat(32);
    await repository.prepareLocalSubmission({ submission: submission("sub-1", txid), claims: [claimFor("sub-1", "ee".repeat(32))] });
    await repository.prepareLocalSubmission({ submission: submission("sub-2", otherTxid), claims: [] });
    await repository.replaceHistory(resource, [{ txid, height: 100 }]);
    await repository.reconcileHistoryConfirmed(resource.resourceId, new Set([txid]));
    const rows = await repository.listLocalTransactions(resource.resourceId);
    expect(rows.find((row) => row.id === "sub-1")).toMatchObject({ chainResolution: "chain-confirmed", confirmedHistoryId: `${resource.resourceId}:${txid}` });
    expect(rows.find((row) => row.id === "sub-2")).toMatchObject({ chainResolution: "unresolved" });
    // 确认的 claim 进入 confirmed。
    expect((await repository.listLocalInputClaimsByResource(resource.resourceId)).find((row) => row.submissionId === "sub-1")?.state).toBe("confirmed");
    bundle.close();
  });

  it("原子写入本地提交，输入冲突时整事务失败", async () => {
    const { open } = openRepository();
    const bundle = await open();
    const repository = createP2pkhStateRepository(bundle);
    await repository.putAddress(resource);
    const txid = "ff".repeat(32);
    await repository.prepareLocalSubmission({ submission: submission("sub-a", "11".repeat(32)), claims: [claimFor("sub-a", txid)] });
    await expect(repository.prepareLocalSubmission({ submission: submission("sub-b", "22".repeat(32)), claims: [claimFor("sub-b", txid)] })).rejects.toThrow(/already claimed/);
    // 冲突提交没有写入。
    expect((await repository.listLocalTransactions()).find((row) => row.id === "sub-b")).toBeUndefined();
    bundle.close();
  });

  it("多输入 claim 冲突时整次提交原子失败，不留下部分 claim", async () => {
    const { open } = openRepository();
    const bundle = await open();
    const repository = createP2pkhStateRepository(bundle);
    await repository.putAddress(resource);
    const freeTxid = "aa".repeat(32);
    const busyTxid = "bb".repeat(32);
    await repository.prepareLocalSubmission({ submission: submission("sub-owner", "cc".repeat(32)), claims: [claimFor("sub-owner", busyTxid)] });
    await expect(repository.prepareLocalSubmission({
      submission: submission("sub-multi", "dd".repeat(32)),
      claims: [claimFor("sub-multi", freeTxid), claimFor("sub-multi", busyTxid)]
    })).rejects.toThrow(/already claimed/);
    // 第一个（空闲）输入也不能被写入，submission 也不能出现。
    const rows = await repository.listLocalInputClaimsByResource(resource.resourceId);
    expect(rows.filter((row) => row.submissionId === "sub-multi")).toEqual([]);
    expect((await repository.listLocalTransactions()).find((row) => row.id === "sub-multi")).toBeUndefined();
    // tryClaimInputs 同样必须整次原子。
    await expect(repository.tryClaimInputs({
      submissionId: "sub-protocol",
      resourceId: resource.resourceId,
      publicKeyHex: resource.publicKeyHex,
      network: resource.network,
      inputs: [{ txid: freeTxid, vout: 1 }, { txid: busyTxid, vout: 0 }]
    })).rejects.toThrow(/already claimed/);
    expect((await repository.listLocalInputClaimsByResource(resource.resourceId)).filter((row) => row.submissionId === "sub-protocol")).toEqual([]);
    bundle.close();
  });

  it("finish/abort 只处理初始未尝试提交", async () => {
    const { open } = openRepository();
    const bundle = await open();
    const repository = createP2pkhStateRepository(bundle);
    await repository.putAddress(resource);
    await repository.prepareLocalSubmission({ submission: submission("sub-finish", "33".repeat(32)), claims: [claimFor("sub-finish", "44".repeat(32))] });
    await repository.finishLocalSubmission({ submissionId: "sub-finish", localState: "isolated", reason: "provider-failed" });
    expect((await repository.listLocalTransactions(resource.resourceId)).find((row) => row.id === "sub-finish")).toMatchObject({ localState: "isolated" });
    expect((await repository.listLocalInputClaimsByResource(resource.resourceId))[0]?.state).toBe("isolated");

    await repository.prepareLocalSubmission({ submission: submission("sub-abort", "55".repeat(32)), claims: [claimFor("sub-abort", "66".repeat(32))] });
    await repository.abortUnattemptedLocalSubmission({ submissionId: "sub-abort", reason: "not-dispatched" });
    expect((await repository.listLocalTransactions()).find((row) => row.id === "sub-abort")).toBeUndefined();
    expect(await repository.listLocalInputClaimsByResource(resource.resourceId).then((rows) => rows.filter((row) => row.submissionId === "sub-abort"))).toEqual([]);
    // 已尝试/已定状态的提交不做清理。
    await repository.prepareLocalSubmission({ submission: submission("sub-keep", "77".repeat(32)), claims: [] });
    await repository.finishLocalSubmission({ submissionId: "sub-keep", localState: "isolated", reason: "provider-failed" });
    await repository.abortUnattemptedLocalSubmission({ submissionId: "sub-keep" });
    expect((await repository.listLocalTransactions()).find((row) => row.id === "sub-keep")).toBeDefined();
    bundle.close();
  });

  it("读写同步状态与协议提交，并支持分页与 clearAll", async () => {
    const { open } = openRepository();
    const bundle = await open();
    const repository = createP2pkhStateRepository(bundle);
    await repository.putAddress(resource);
    await repository.putTransactionSyncState({ id: resource.resourceId, resourceId: resource.resourceId, pagesSynced: 2, transactionsSynced: 3, lastAttemptAt: "now", lastSuccessAt: "now" });
    expect(await repository.getTransactionSyncState(resource.resourceId)).toMatchObject({ pagesSynced: 2 });
    expect(await repository.listTransactionSyncStates()).toHaveLength(1);
    await repository.putProtocolSubmission({
      id: "proto-1", resourceId: resource.resourceId, publicKeyHex: OWNER_A, network: "main",
      submissionId: "proto-1", canonicalTxid: "88".repeat(32), inputs: [], protectedClaimIds: [], localInputClaimIds: [],
      status: "prepared", createdAt: "now", updatedAt: "now",
    });
    expect(await repository.listProtocolSubmissionsByResource(resource.resourceId)).toHaveLength(1);
    await repository.removeProtocolSubmission("proto-1");
    expect(await repository.listProtocolSubmissions()).toEqual([]);

    await repository.prepareLocalSubmission({ submission: submission("sub-p1", "99".repeat(32)), claims: [claimFor("sub-p1", "9a".repeat(32))] });
    expect((await repository.listLocalTransactionsPage({ resourceId: resource.resourceId, limit: 10 })).items).toHaveLength(1);
    expect((await repository.listLocalInputClaimsPage({ resourceId: resource.resourceId, limit: 10 })).items).toHaveLength(1);
    await repository.releaseLocalInputClaims([`${resource.resourceId}:${"9a".repeat(32)}:0`]);
    expect((await repository.listLocalInputClaims())[0]?.state).toBe("released");
    await repository.clearAll();
    expect(await repository.listAddresses()).toEqual([]);
    bundle.close();
  });
});
