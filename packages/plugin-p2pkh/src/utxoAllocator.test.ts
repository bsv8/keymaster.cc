// packages/plugin-p2pkh/src/utxoAllocator.test.ts
// UTXO 分配逻辑单测：
//   - 不允许金额为 0/负数。
//   - 默认只选 confirmed；allowUnconfirmed=true 时可包含 unconfirmed。
//   - reservation 排除（由 service 层过滤）。

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

  it("selects only confirmed by default", () => {
    // 给足 confirmed 才能满足 required；否则会被 insufficient 拦截。
    const r = allocateUtxos([utxo(1000, "confirmed"), utxo(5000, "unconfirmed")], {
      amountSatoshis: 200,
      feeReserveSatoshis: 100,
      assetId: "bsv"
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.allocation.selected.every((u) => u.status === "confirmed")).toBe(true);
    }
  });

  it("returns no-utxos when only unconfirmed available and allowUnconfirmed=false", () => {
    const r = allocateUtxos([utxo(5000, "unconfirmed")], {
      amountSatoshis: 200,
      feeReserveSatoshis: 100,
      assetId: "bsv"
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe("no-utxos");
  });

  it("selects unconfirmed when allowUnconfirmed=true", () => {
    const r = allocateUtxos([utxo(5000, "unconfirmed")], {
      amountSatoshis: 100,
      feeReserveSatoshis: 100,
      allowUnconfirmed: true,
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
