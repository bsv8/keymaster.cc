import { describe, expect, it } from "vitest";
import { formatSatsWithPrice } from "./index.js";

describe("formatSatsWithPrice", () => {
  it("shows sats with the priced value for mainnet", () => {
    expect(formatSatsWithPrice(100_000_000, { amount: "45.12", unit: "USDT" }, { locale: "en-US" }))
      .toBe("100,000,000 sats / 45.12 USDT");
  });

  it("computes the reference value from the price", () => {
    expect(formatSatsWithPrice(10_000, { amount: "45.12", unit: "USDT" }, { locale: "en-US" }))
      .toBe("10,000 sats / 0.00 USDT");
    expect(formatSatsWithPrice(1_000_000, { amount: "45.12", unit: "USDT" }, { locale: "en-US" }))
      .toBe("1,000,000 sats / 0.45 USDT");
  });

  it("always shows zero on testnet and when the price is unavailable", () => {
    expect(formatSatsWithPrice(1_000, { amount: "45.12", unit: "CNY" }, { locale: "en-US", network: "test" }))
      .toBe("1,000 sats / 0.00 CNY");
    expect(formatSatsWithPrice(1_000, null, { locale: "en-US" }))
      .toBe("1,000 sats / 0.00 USDT");
  });
});
