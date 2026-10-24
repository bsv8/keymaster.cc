// utm/1 contract constants and error codes.
// No dependencies. Amounts are canonical decimal strings (JSON level).

export const CONTRACT_VERSION = "utm/1";

/** Maximum BSV money: 21_000_000 * 100_000_000 satoshis, as canonical string. */
export const MAX_MONEY_SATS = "2100000000000000";

/** Fee unit: satoshis per kilobyte, 1 KB = 1000 bytes. */
export const FEE_UNIT = "satoshisPerKb";
export const BYTES_PER_KB = 1000;

/** Deterministic selection: largest-first (value desc, txid asc, vout asc). */
export const SELECTION_STRATEGY = "largest-first";

/** Serialized size model (P2PKH upper-bound template, proven in P4). */
export const TX_BASE_BYTES = 10; // version(4) + locktime(4) + 2 count bytes minimum
export const P2PKH_INPUT_WEIGHT = 148;
export const OUTPUT_OVERHEAD = 8; // value bytes; script length prefix counted exactly

export const ERROR_CODES = [
  "insufficient",
  "no-utxos",
  "policy-denied",
  "amount-invalid",
  "fee-invalid",
  "id-conflict",
  "scope-mismatch",
  "snapshot-stale",
  "snapshot-binding-required",
  "snapshot-input-invalid",
  "funds-protected",
  "mixed-inputs-unsupported",
  "unknown-input",
  "signature-exceeds-bound",
  "fee-out-of-range",
  "already-known",
  "not-dispatched",
  "isolated-unknown",
  "ancestor-unknown",
  "ancestor-conflict",
  "already-occupied",
  "allocation-unknown",
  "allocation-state",
  "version-unsupported",
  "state-conflict",
  "tx-invalid",
  "outpoint-conflict",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class UtmError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message?: string) {
    super(message ?? code);
    this.name = "UtmError";
    this.code = code;
  }
}

/** Equivalent to Go CodeOf; do not mistake an untyped host error for a money conclusion. */
export function codeOf(error: unknown): string {
  if (error instanceof UtmError) return error.code;
  return `unmapped:${error == null ? "<nil>" : error instanceof Error ? error.message : String(error)}`;
}
