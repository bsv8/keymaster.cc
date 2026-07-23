import { describe, expect, it } from "vitest";
import { protocolSpendReference } from "./bsv21TransferProvider.js";

describe("protocolSpendReference", () => {
  it("prefers canonicalTxid when available", () => {
    expect(protocolSpendReference({ txid: "local-txid", canonicalTxid: "canonical-txid" })).toBe("canonical-txid");
  });

  it("falls back to txid when canonicalTxid is absent", () => {
    expect(protocolSpendReference({ txid: "local-txid" })).toBe("local-txid");
  });
});
