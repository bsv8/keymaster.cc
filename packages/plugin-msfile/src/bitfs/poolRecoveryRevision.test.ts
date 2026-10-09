import { expect, it } from "vitest";
import { createInMemoryOwnerFileStore } from "../storage/inMemoryOwnerFileStore.testutil.js";
import { createBitfsFundingLedger, prepareBitfsPoolRecoveryWithCurrentRevision } from "./funding.js";

async function fixture() {
  const ledger = createBitfsFundingLedger(createInMemoryOwnerFileStore());
  const identity = { ownerPublicKeyHex: "02" + "11".repeat(32), seedHashHex: "22".repeat(32), network: "test" as const, nowMs: 1000 };
  let account = await ledger.getAccount(identity);
  const split = { txid: "33".repeat(32), vout: 0, valueSatoshis: "300", scriptHex: "51" };
  account = await ledger.prepareSplit({ ...identity, expectedRevision: account.revision, txid: split.txid,
    p2pkhSubmissionId: "split-1", inputs: ["44".repeat(32) + ":0"], outputs: [split] });
  account = await ledger.observeSplit({ ...identity, txid: split.txid, actualOutputs: [split] });
  const opening = { txid: "55".repeat(32), vout: 0, valueSatoshis: "202", scriptHex: "51" };
  const change = { txid: opening.txid, vout: 1, valueSatoshis: "80", scriptHex: "51" };
  account = await ledger.reservePoolFunding({ ...identity, expectedRevision: account.revision, poolId: "pool-1",
    txid: opening.txid, p2pkhSubmissionId: "opening-1", inputs: [split.txid + ":0"], openingOutput: opening,
    changeOutput: change, maxFeeSatoshis: "100", changeSatoshis: "80", changeScriptHex: "51" });
  await ledger.observePoolFunding({ ...identity, poolId: "pool-1", actualInputs: [split.txid + ":0"], actualOutputs: [opening, change] });
  const close = { ...identity, poolId: "pool-1", purpose: "close" as const, txid: "66".repeat(32), spendingOutpoint: opening.txid + ":0",
    outputs: [{ txid: "66".repeat(32), vout: 0, valueSatoshis: "169", scriptHex: "51" }] };
  return { ledger, identity, close };
}

it("re-reads a real ledger after snapshot reconciliation races exact close registration", async () => {
  const { ledger, identity, close } = await fixture();
  let reads = 0;
  const interrupted = { ...ledger, async getAccount(input: Parameters<typeof ledger.getAccount>[0]) {
    const account = await ledger.getAccount(input);
    if (++reads === 1) await ledger.reconcileObservedTransactionInputs({ ownerPublicKeyHex: identity.ownerPublicKeyHex,
      network: identity.network, unspentOutpoints: [], nowMs: 2000 });
    return account;
  } };
  const account = await prepareBitfsPoolRecoveryWithCurrentRevision(interrupted, close, () => {});
  expect(reads).toBe(2);
  expect(account.pools[0]!.recoveryTxid).toBe(close.txid);
  expect(account.pools[0]!.state).toBe("recovery-pending");
  expect(account.transactions.filter(tx => tx.purpose === "close")).toHaveLength(1);
  expect(account.transactions.filter(tx => tx.purpose === "close")[0]!.state).toBe("prepared");
  expect(account.transactions.filter(tx => tx.purpose !== "close").every(tx => tx.inputsReconciled)).toBe(true);
});

it("retains plan integrity guards and rejects a withdrawn owner before registration", async () => {
  const { ledger, close } = await fixture();
  await prepareBitfsPoolRecoveryWithCurrentRevision(ledger, close, () => {});
  await expect(prepareBitfsPoolRecoveryWithCurrentRevision(ledger, { ...close, txid: "77".repeat(32),
    outputs: [{ ...close.outputs[0]!, txid: "77".repeat(32) }] }, () => {})).rejects.toThrow("待恢复交易哈希发生变化");
  await expect(prepareBitfsPoolRecoveryWithCurrentRevision(ledger, close, () => { throw new Error("owner revoked"); })).rejects.toThrow("owner revoked");
});
