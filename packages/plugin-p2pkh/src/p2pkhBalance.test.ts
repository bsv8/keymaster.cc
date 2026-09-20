import { describe, expect, it } from "vitest";
import type { P2pkhLocalInputClaim } from "./p2pkhContracts.js";
import type { P2pkhUtxoSnapshotResult } from "@keymaster/contracts";
import { calculateP2pkhBalanceBreakdown } from "./p2pkhService.js";

const owner = "02" + "11".repeat(32);
const resourceId = "p2pkh:main";

function snapshotItem(txid: string, value: number, status: "confirmed" | "unconfirmed" = "confirmed", extra: Partial<P2pkhUtxoSnapshotResult["items"][number]> = {}) {
  return { txid, vout: 0, value, height: status === "confirmed" ? 100 : 0, status, isSpentInMempoolTx: false, ...extra };
}

function claim(id: string, txid: string, value: number, state: P2pkhLocalInputClaim["state"] = "active"): P2pkhLocalInputClaim {
  return { id, submissionId: "sub-1", resourceId, publicKeyHex: owner, network: "main", txid, vout: 0, outpointKey: `${txid}:0`, value, state, createdAt: "now", updatedAt: "now" };
}

describe("calculateP2pkhBalanceBreakdown (snapshot-based)", () => {
  it("returns all zeros when the snapshot is unavailable", () => {
    const snapshot: P2pkhUtxoSnapshotResult = { available: false, items: [] };
    expect(calculateP2pkhBalanceBreakdown({ snapshot, claims: [claim("c1", "aa".repeat(32), 1000)] })).toEqual({
      confirmed: 0,
      unconfirmed: 0,
      spendable: 0,
      pendingInputClaims: 0,
    });
  });

  it("sums confirmed/unconfirmed excluding mempool-spent outputs", () => {
    const confirmedTxid = "aa".repeat(32);
    const unconfirmedTxid = "bb".repeat(32);
    const spentTxid = "cc".repeat(32);
    const snapshot: P2pkhUtxoSnapshotResult = {
      available: true,
      syncedAt: "now",
      items: [
        snapshotItem(confirmedTxid, 1000, "confirmed"),
        snapshotItem(unconfirmedTxid, 500, "unconfirmed"),
        snapshotItem(spentTxid, 9999, "confirmed", { isSpentInMempoolTx: true }),
      ],
    };
    expect(calculateP2pkhBalanceBreakdown({ snapshot, claims: [] })).toMatchObject({
      confirmed: 1000,
      unconfirmed: 500,
      spendable: 1500,
      pendingInputClaims: 0,
    });
  });

  it("deducts active/isolated claims once and ignores released/confirmed claims", () => {
    const txidA = "dd".repeat(32);
    const txidB = "ee".repeat(32);
    const snapshot: P2pkhUtxoSnapshotResult = {
      available: true,
      items: [snapshotItem(txidA, 1000), snapshotItem(txidB, 500)],
    };
    const claims = [
      claim("c1", txidA, 1000, "active"),
      // 同一 outpoint 重复 claim 只计一次。
      { ...claim("c2", txidA, 1000, "isolated"), submissionId: "sub-2" },
      claim("c3", txidB, 200, "released"),
      claim("c4", txidB, 200, "confirmed"),
    ];
    const result = calculateP2pkhBalanceBreakdown({ snapshot, claims });
    expect(result.pendingInputClaims).toBe(1000);
    expect(result.spendable).toBe(500);
  });

  it("deducts protected outpoints from spendable", () => {
    const protectedTxid = "f1".repeat(32);
    const freeTxid = "f2".repeat(32);
    const snapshot: P2pkhUtxoSnapshotResult = {
      available: true,
      items: [snapshotItem(protectedTxid, 1000), snapshotItem(freeTxid, 500)],
    };
    const result = calculateP2pkhBalanceBreakdown({
      snapshot,
      claims: [],
      protectedOutpoints: new Set([`${protectedTxid}:0`]),
    });
    expect(result).toMatchObject({ confirmed: 1500, spendable: 500 });
  });

  it("floors spendable at zero when claims and protected values exceed the snapshot", () => {
    const txid = "f3".repeat(32);
    const snapshot: P2pkhUtxoSnapshotResult = { available: true, items: [snapshotItem(txid, 300)] };
    const result = calculateP2pkhBalanceBreakdown({
      snapshot,
      claims: [claim("c1", txid, 500)],
      protectedOutpoints: new Set([`${txid}:0`]),
    });
    expect(result.spendable).toBe(0);
    expect(result.pendingInputClaims).toBe(500);
  });
});
