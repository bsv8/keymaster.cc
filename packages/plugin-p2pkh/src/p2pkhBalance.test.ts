import { describe, expect, it } from "vitest";
import type { P2pkhUtxoSnapshotResult } from "@keymaster/contracts";
import { calculateP2pkhBalanceBreakdown } from "./p2pkhService.js";

function snapshotItem(txid: string, value: number, status: "confirmed" | "unconfirmed" = "confirmed", extra: Partial<P2pkhUtxoSnapshotResult["items"][number]> = {}) {
  return { txid, vout: 0, value, height: status === "confirmed" ? 100 : 0, status, isSpentInMempoolTx: false, ...extra };
}

describe("calculateP2pkhBalanceBreakdown (snapshot-based)", () => {
  it("returns all zeros when the snapshot is unavailable", () => {
    const snapshot: P2pkhUtxoSnapshotResult = { available: false, state: "unavailable", items: [] };
    expect(calculateP2pkhBalanceBreakdown({ snapshot })).toEqual({
      confirmed: 0,
      unconfirmed: 0,
      spendable: 0,
    });
  });

  it("sums confirmed/unconfirmed excluding mempool-spent outputs", () => {
    const confirmedTxid = "aa".repeat(32);
    const unconfirmedTxid = "bb".repeat(32);
    const spentTxid = "cc".repeat(32);
    const snapshot: P2pkhUtxoSnapshotResult = {
      available: true,
      state: "fresh",
      syncedAt: "now",
      items: [
        snapshotItem(confirmedTxid, 1000, "confirmed"),
        snapshotItem(unconfirmedTxid, 500, "unconfirmed"),
        snapshotItem(spentTxid, 9999, "confirmed", { isSpentInMempoolTx: true }),
      ],
    };
    expect(calculateP2pkhBalanceBreakdown({ snapshot })).toEqual({
      confirmed: 1000,
      unconfirmed: 500,
      spendable: 1500,
    });
  });

  it("does not subtract local claims or protected outpoints from ordinary P2PKH balance", () => {
    const txidA = "dd".repeat(32);
    const txidB = "ee".repeat(32);
    const snapshot: P2pkhUtxoSnapshotResult = {
      available: true,
      state: "fresh",
      items: [snapshotItem(txidA, 1000), snapshotItem(txidB, 500)],
    };
    expect(calculateP2pkhBalanceBreakdown({ snapshot })).toEqual({ confirmed: 1500, unconfirmed: 0, spendable: 1500 });
  });

  it("counts only outputs that are not spent in the mempool", () => {
    const currentTxid = "f4".repeat(32);
    const snapshot: P2pkhUtxoSnapshotResult = {
      available: true,
      state: "fresh",
      items: [snapshotItem(currentTxid, 118, "unconfirmed")],
    };
    expect(calculateP2pkhBalanceBreakdown({ snapshot })).toEqual({ confirmed: 0, unconfirmed: 118, spendable: 118 });
  });
});
