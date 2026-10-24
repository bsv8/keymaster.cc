// Canonical amount arithmetic. All amounts are canonical decimal strings:
// "0" or [1-9][0-9]*, value in [0, MAX_MONEY_SATS]. No floats, no Number sums.
import { MAX_MONEY_SATS, UtmError } from "./contract.js";

export const MAX_MONEY = BigInt(MAX_MONEY_SATS);
const CANONICAL = /^(0|[1-9][0-9]*)$/;

export function parseAmount(value: unknown, what = "amount"): bigint {
  if (typeof value !== "string" || !CANONICAL.test(value)) {
    throw new UtmError("amount-invalid", `${what} is not a canonical amount string`);
  }
  const parsed = BigInt(value);
  if (parsed > MAX_MONEY) throw new UtmError("amount-invalid", `${what} exceeds max money`);
  return parsed;
}

export function formatAmount(value: bigint): string {
  if (value < 0n || value > MAX_MONEY) throw new UtmError("amount-invalid", "amount out of range");
  return value.toString(10);
}

export function addChecked(a: bigint, b: bigint, what = "sum"): bigint {
  const sum = a + b;
  if (sum > MAX_MONEY) throw new UtmError("amount-invalid", `${what} overflows max money`);
  return sum;
}

export function sumChecked(values: readonly bigint[], what = "sum"): bigint {
  let total = 0n;
  for (const value of values) total = addChecked(total, value, what);
  return total;
}

/** ceil(rate * sizeBytes / 1000), all checked. */
export function estimateFeeSats(feeRateSatPerKb: bigint, sizeBytes: bigint): bigint {
  if (feeRateSatPerKb <= 0n) throw new UtmError("fee-invalid", "fee rate must be positive");
  if (sizeBytes < 0n) throw new UtmError("fee-invalid", "size must be non-negative");
  const fee = (feeRateSatPerKb * sizeBytes + 999n) / 1000n;
  if (fee <= 0n) return 1n;
  if (fee > MAX_MONEY) throw new UtmError("fee-invalid", "fee exceeds max money");
  return fee;
}

export function parseFeeRate(value: unknown): bigint {
  const rate = parseAmount(value, "fee rate");
  if (rate <= 0n) throw new UtmError("fee-invalid", "fee rate must be positive");
  return rate;
}
