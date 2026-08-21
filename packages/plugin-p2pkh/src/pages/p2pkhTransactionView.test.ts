import { describe, expect, it } from "vitest";
import { detailPath, listPath, parseTransactionSource, readTransactionSource, readTransactionSubmissionId, transactionSourceListPath } from "./p2pkhTransactionView.js";

describe("P2PKH transaction navigation paths", () => {
  it("builds each formal network/view list path with page only", () => {
    expect(listPath("main", 1, "transactions")).toBe("/p2pkh/mainnet/transactions?page=1");
    expect(listPath("test", 3, "transactions")).toBe("/p2pkh/testnet/transactions?page=3");
    expect(listPath("main", 2, "local-transactions")).toBe("/p2pkh/mainnet/local-transactions?page=2");
    expect(listPath("test", 4, "local-transactions")).toBe("/p2pkh/testnet/local-transactions?page=4");
    expect(listPath("main", 1, "transactions")).not.toContain("tab=");
  });

  it("records the source list for detail back navigation without tab compatibility", () => {
    expect(detailPath("abc", "test", 5, "local-transactions")).toBe("/p2pkh/tx/abc?network=test&page=5&source=local-transactions");
    expect(detailPath("abc", "test", 5, "local-transactions", "submission-2")).toBe("/p2pkh/tx/abc?network=test&page=5&source=local-transactions&submissionId=submission-2");
    expect(readTransactionSubmissionId("?network=test&source=local-transactions&submissionId=submission-2")).toBe("submission-2");
    expect(readTransactionSource("?network=test&page=5&source=local-transactions")).toBe("local-transactions");
    expect(readTransactionSource("?network=test&page=5&tab=coins")).toBe("transactions");
  });

  it("uses one source parser for missing, invalid, explicit transaction, and local values", () => {
    expect(parseTransactionSource("")).toBe("transactions");
    expect(parseTransactionSource("?source=invalid")).toBe("transactions");
    expect(parseTransactionSource("?source=transactions")).toBe("transactions");
    expect(parseTransactionSource("?source=local-transactions")).toBe("local-transactions");
    expect(transactionSourceListPath("?network=test")).toBe("/p2pkh/testnet/transactions");
    expect(transactionSourceListPath("?network=main&source=invalid")).toBe("/p2pkh/mainnet/transactions");
    expect(transactionSourceListPath("?network=main&source=local-transactions")).toBe("/p2pkh/mainnet/local-transactions");
  });
});
