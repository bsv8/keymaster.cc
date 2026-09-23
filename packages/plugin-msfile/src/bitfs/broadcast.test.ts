// BitFS 交易 outbox：persist-before-broadcast、结果未知对账、exact bytes 重放。

import { describe, expect, it, vi } from "vitest";
import { transactionID } from "go-bitfs";
import { createInMemoryOwnerFileStore } from "../storage/inMemoryOwnerFileStore.testutil.js";
import {
  BitfsTransactionBroadcaster,
  createBitfsTransactionJournal,
  type BitfsChainPort,
} from "./broadcast.js";

const NOW = 1_800_000_000_000;
const INPUT_TXID = "ab".repeat(32);

/** 可被 @bsv/sdk 解析的最小 legacy 交易；金额与脚本固定。 */
function rawTransaction(marker = 0): Uint8Array {
  const hex = `0100000001${INPUT_TXID}0000000000ffffffff01e8030000000000001976a914${"11".repeat(20)}88ac00000000`;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  if (marker !== 0) bytes[bytes.length - 1] = marker;
  return bytes;
}

function txidOf(rawTx: Uint8Array): string {
  return Array.from(transactionID(rawTx), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fixture(chainOverrides: Partial<BitfsChainPort> = {}) {
  const store = createInMemoryOwnerFileStore();
  const journal = createBitfsTransactionJournal(store);
  const chain: BitfsChainPort = {
    broadcast: vi.fn(async () => ({ outcome: "accepted" as const })),
    lookupTransaction: vi.fn(async () => "unknown" as const),
    ...chainOverrides,
  };
  const broadcaster = new BitfsTransactionBroadcaster({ journal, chain, nowMs: () => NOW });
  return { store, journal, chain, broadcaster };
}

describe("BitFS 交易 outbox 与广播对账", () => {
  it("广播前先持久化 exact bytes，accepted 后仍等待链上观察", async () => {
    const raw = rawTransaction();
    const txid = txidOf(raw);
    const fixtureValue = fixture();
    const broadcast = fixtureValue.chain.broadcast as ReturnType<typeof vi.fn>;
    broadcast.mockImplementationOnce(async () => {
      // 广播调用发生时，outbox 必须已经能读到同一份 exact bytes。
      const stored = await fixtureValue.journal.getTransaction(txid);
      expect(stored).toEqual(raw);
      return { outcome: "accepted" };
    });
    await expect(fixtureValue.broadcaster.submit(raw)).resolves.toEqual({ status: "result-unknown", txid, attempts: 1, retryable: false, reason: "provider-accepted-awaiting-observation" });
    expect(await fixtureValue.journal.getTransactionRecord(txid)).toMatchObject({ state: "result-unknown", attempts: 1 });
  });

  it("网络错误按结果未知处理，再按 txid 对账为 confirmed", async () => {
    const raw = rawTransaction();
    const txid = txidOf(raw);
    const { broadcaster, chain, journal } = fixture({
      broadcast: vi.fn(async () => { throw new Error("WOC timeout"); }),
      lookupTransaction: vi.fn(async () => "mempool" as const),
    });
    const outcome = await broadcaster.submit(raw);
    expect(outcome).toMatchObject({ status: "result-unknown", txid, retryable: true });
    expect(await journal.getTransactionRecord(txid)).toMatchObject({ state: "result-unknown" });

    await expect(broadcaster.reconcile(txid)).resolves.toEqual({ status: "confirmed", txid, attempts: 1 });
    expect(chain.lookupTransaction).toHaveBeenCalledWith(txid);
    expect(await journal.getTransactionRecord(txid)).toMatchObject({ state: "confirmed" });
  });

  it("确定未派发后重试只重放同一 exact bytes", async () => {
    const raw = rawTransaction();
    const txid = txidOf(raw);
    const broadcast = vi.fn(async (): Promise<{ outcome: "accepted" | "already-known" }> => { throw new Error("invalid transaction: bad-txns-inputs-missingorspent"); });
    const { broadcaster, journal } = fixture({ broadcast });
    const failed = await broadcaster.submit(raw);
    expect(failed).toMatchObject({ status: "failed", txid, attempts: 1 });
    expect(await journal.getTransactionRecord(txid)).toMatchObject({ state: "failed" });

    broadcast.mockImplementationOnce(async () => ({ outcome: "already-known" }));
    await expect(broadcaster.retry(txid)).resolves.toEqual({ status: "result-unknown", txid, attempts: 2, retryable: false, reason: "provider-accepted-awaiting-observation" });
    const calls = broadcast.mock.calls as unknown as Array<[{ txid: string; rawTxHex: string }]>;
    expect(calls[0]![0].rawTxHex).toBe(calls[1]![0].rawTxHex);
  });

  it("查询不确定时不标记可重试，避免盲目重放", async () => {
    const raw = rawTransaction();
    const txid = txidOf(raw);
    const { broadcaster } = fixture({
      broadcast: vi.fn(async () => { throw new Error("socket hang up"); }),
      lookupTransaction: vi.fn(async () => "unknown" as const),
    });
    await broadcaster.submit(raw);
    await expect(broadcaster.reconcile(txid)).resolves.toMatchObject({ status: "result-unknown", retryable: false });
    await expect(broadcaster.reconcile("cd".repeat(32))).resolves.toMatchObject({ status: "failed", reason: "unknown_transaction" });
  });

  it("恢复 prepared 交易只派发 exact bytes，已派发交易则只对账", async () => {
    const raw = rawTransaction();
    const txid = txidOf(raw);
    const prepared = fixture();
    await prepared.journal.putTransaction(txid, raw, NOW);
    await expect(prepared.broadcaster.resume(raw)).resolves.toMatchObject({ status: "result-unknown", txid, attempts: 1 });
    expect(prepared.chain.broadcast).toHaveBeenCalledTimes(1);

    const alreadyDispatched = fixture({ lookupTransaction: vi.fn(async () => "mempool" as const) });
    await alreadyDispatched.broadcaster.submit(raw);
    (alreadyDispatched.chain.broadcast as ReturnType<typeof vi.fn>).mockClear();
    await expect(alreadyDispatched.broadcaster.resume(raw)).resolves.toMatchObject({ status: "confirmed", txid });
    expect(alreadyDispatched.chain.broadcast).not.toHaveBeenCalled();
  });

  it("同一 txid 绑定不同交易字节时拒绝覆盖", async () => {
    const store = createInMemoryOwnerFileStore();
    const journal = createBitfsTransactionJournal(store);
    const first = rawTransaction();
    const txid = txidOf(first);
    await journal.putTransaction(txid, first, NOW);
    await expect(journal.putTransaction(txid, rawTransaction(0x22), NOW)).rejects.toThrow(/不同交易字节/u);
    // 相同字节重复写入保持幂等。
    await expect(journal.putTransaction(txid, first, NOW)).resolves.toBeUndefined();
  });
});
