// packages/plugin-p2pkh/src/utxoAllocator.test.ts
// UTXO 分配逻辑单测（硬切换 001）：
//   - 不允许金额为 0/负数。
//   - allocator 不再区分 confirmed / unconfirmed；所有未 reserved 候选都可参与。
//   - reservation 排除由 service 层在传入前完成；allocator 只看候选集合。

import { describe, expect, it } from "vitest";
import { allocateUtxos } from "./utxoAllocator.js";
import type { P2pkhUtxo } from "./p2pkhContracts.js";

function utxo(value: number, status: "confirmed" | "unconfirmed" = "confirmed", id = `t${value}`): P2pkhUtxo {
  return {
    id,
    resourceId: "r1",
    keyId: "k1",
    publicKeyHash: "h1",
    network: "main",
    address: "a",
    txid: id,
    vout: 0,
    value,
    height: 1,
    status,
    isSpentInMempoolTx: false,
    syncedAt: "2024-01-01T00:00:00.000Z"
  };
}

describe("allocateUtxos", () => {
  it("rejects zero/negative amount", () => {
    const r = allocateUtxos([utxo(1000)], { amountSatoshis: 0, assetId: "bsv" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe("policy-denied");
  });

  it("returns no-utxos when no candidates", () => {
    const r = allocateUtxos([], { amountSatoshis: 100, assetId: "bsv" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe("no-utxos");
  });

  it("returns insufficient when available < required + fee", () => {
    const r = allocateUtxos([utxo(100)], {
      amountSatoshis: 1000,
      feeReserveSatoshis: 100,
      assetId: "bsv"
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe("insufficient");
  });

  it("treats confirmed and unconfirmed as equivalent candidates", () => {
    // 候选集合中混合 confirmed / unconfirmed：allocator 不再按 status 过滤。
    const r = allocateUtxos([utxo(1000, "confirmed"), utxo(5000, "unconfirmed")], {
      amountSatoshis: 200,
      feeReserveSatoshis: 100,
      assetId: "bsv"
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // 仍然挑选 smallest-first；1000 比 5000 小，所以选 confirmed 那条。
      expect(r.allocation.selected).toHaveLength(1);
      expect(r.allocation.selected[0]!.status).toBe("confirmed");
    }
  });

  it("includes unconfirmed candidates in the same set as confirmed", () => {
    // 候选只有一个 unconfirmed：仍能成功选币。
    const r = allocateUtxos([utxo(5000, "unconfirmed")], {
      amountSatoshis: 200,
      feeReserveSatoshis: 100,
      assetId: "bsv"
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.allocation.selected).toHaveLength(1);
      expect(r.allocation.selected[0]!.status).toBe("unconfirmed");
    }
  });

  it("picks smallest-first by default", () => {
    const utxos = [utxo(100, "confirmed", "big"), utxo(20, "confirmed", "small"), utxo(50, "confirmed", "mid")];
    const r = allocateUtxos(utxos, { amountSatoshis: 25, feeReserveSatoshis: 10, assetId: "bsv" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.allocation.selected[0]!.id).toBe("small");
    }
  });
});
