import { describe, expect, it } from "vitest";
import type { P2pkhUtxo } from "./p2pkhContracts.js";
import { canonicalizeP2pkhUtxos } from "./p2pkhCanonical.js";

const base = { resourceId: "p2pkh:main", publicKeyHex: "02" + "11".repeat(32), network: "main" as const, address: "1abc", txid: "aa".repeat(32), vout: 0, isSpentInMempoolTx: false, syncedAt: "now" };
function candidate(id: string, value: number, status: P2pkhUtxo["status"], resourceId = base.resourceId): P2pkhUtxo {
  return { ...base, id, resourceId, value, status };
}

describe("P2PKH canonical outpoints", () => {
  it("always prefers the confirmed candidate independent of input order", () => {
    const local = candidate("000-local", 9_000, "unconfirmed");
    const chain = candidate("zzz-chain", 1_000, "confirmed");
    expect(canonicalizeP2pkhUtxos([local, chain])).toEqual([chain]);
    expect(canonicalizeP2pkhUtxos([chain, local])).toEqual([chain]);
  });

  it("does not merge the same txid/vout across resource namespaces", () => {
    const main = candidate("main", 1_000, "confirmed", "p2pkh:main");
    const test = candidate("test", 2_000, "unconfirmed", "p2pkh:test");
    expect(canonicalizeP2pkhUtxos([main, test])).toHaveLength(2);
  });
});
