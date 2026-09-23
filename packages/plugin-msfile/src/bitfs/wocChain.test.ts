import { describe, expect, it, vi } from "vitest";
import type { WocServiceHandle } from "@keymaster/contracts";
import { createInMemoryOwnerFileStore } from "../storage/inMemoryOwnerFileStore.testutil.js";
import { createBitfsSessionJournal } from "./sessionJournal.js";
import { BitfsTransactionBroadcaster, createBitfsTransactionJournal } from "./broadcast.js";
import { createBitfsWocChainPort, reconcileBitfsSessionTransactions, reconcileBitfsTransactions } from "./wocChain.js";

describe("BitFS WoC 链端口", () => {
  it("广播时核对 canonical txid，查询时区分已确认与 mempool", async () => {
    const txid = "11".repeat(32);
    const broadcast = vi.fn(async () => ({ accepted: true as const, canonicalTxid: txid, txidIntegrity: "exact" as const }));
    const getTransactionObservation = vi.fn(async () => ({ canonicalTxid: txid, observation: "unconfirmed" as const }));
    const port = createBitfsWocChainPort({ broadcast, getTransactionObservation } as unknown as WocServiceHandle, "main");
    await expect(port.broadcast({ txid, rawTxHex: "0102" })).resolves.toEqual({ outcome: "accepted" });
    await expect(port.lookupTransaction(txid)).resolves.toBe("mempool");
  });

  it("不把 provider txid 不一致当成成功", async () => {
    const txid = "22".repeat(32);
    const broadcast = vi.fn(async () => ({ accepted: true as const, canonicalTxid: "33".repeat(32), txidIntegrity: "mismatch" as const }));
    const port = createBitfsWocChainPort({ broadcast } as unknown as WocServiceHandle, "main");
    await expect(port.broadcast({ txid, rawTxHex: "0102" })).rejects.toThrow(/txid/u);
  });

  it("启动对账确认交易后推进对应会话，未确认结果保持不变", async () => {
    const sessions = createBitfsSessionJournal(createInMemoryOwnerFileStore());
    const confirmedTxid = "44".repeat(32);
    const unknownTxid = "55".repeat(32);
    await sessions.create({
      sessionId: "sale-confirmed", role: "seller", ownerPublicKeyHex: `02${"11".repeat(32)}`,
      counterpartyPublicKeyHex: `03${"22".repeat(32)}`, seedHashHex: "aa".repeat(32), generation: 1,
      phase: "payment-unknown", pendingTxid: confirmedTxid,
    }, 1_000);
    await sessions.create({
      sessionId: "sale-unknown", role: "seller", ownerPublicKeyHex: `02${"11".repeat(32)}`,
      counterpartyPublicKeyHex: `03${"22".repeat(32)}`, seedHashHex: "bb".repeat(32), generation: 1,
      phase: "payment-unknown", pendingTxid: unknownTxid,
    }, 1_000);

    await reconcileBitfsSessionTransactions({
      sessions,
      outcomes: [
        { status: "confirmed", txid: confirmedTxid, attempts: 1 },
        { status: "result-unknown", txid: unknownTxid, attempts: 1, retryable: false },
      ],
      nowMs: 2_000,
    });

    await expect(sessions.get("sale-confirmed")).resolves.toMatchObject({ phase: "paid" });
    expect((await sessions.get("sale-confirmed"))?.pendingTxid).toBeUndefined();
    await expect(sessions.get("sale-unknown")).resolves.toMatchObject({ phase: "payment-unknown", pendingTxid: unknownTxid });
  });

  it("outbox 已 confirmed 但会话未回写时，启动扫描仍返回确认事实", async () => {
    const store = createInMemoryOwnerFileStore();
    const journal = createBitfsTransactionJournal(store);
    const rawTx = fromHex(`0100000001${"ab".repeat(32)}0000000000ffffffff01e8030000000000001976a914${"11".repeat(20)}88ac00000000`);
    const lookup = vi.fn(async () => "confirmed" as const);
    const broadcaster = new BitfsTransactionBroadcaster({
      journal,
      chain: { broadcast: vi.fn(async () => ({ outcome: "accepted" as const })), lookupTransaction: lookup },
      nowMs: () => 2_000,
    });
    const submitted = await broadcaster.submit(rawTx);
    const reconciled = await broadcaster.reconcile(submitted.txid);
    expect(reconciled.status).toBe("confirmed");
    lookup.mockClear();

    await expect(reconcileBitfsTransactions({ journal, broadcaster })).resolves.toEqual([
      { status: "confirmed", txid: submitted.txid, attempts: 1 },
    ]);
    expect(lookup).not.toHaveBeenCalled();
  });
});

function fromHex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../gu) ?? [], (part) => Number.parseInt(part, 16));
}
