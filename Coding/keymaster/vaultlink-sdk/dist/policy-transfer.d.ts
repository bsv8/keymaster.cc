import { type PolicySnapshot } from "./payment.js";
/** Exact C++ Policy v2 bank. Public state only: no wallet key, PIN or password.
 * Conversion preserves uint64 precision, closed sessions, consumed/unknown
 * payments, revision fences and fee-pool baselines. It grants no import right. */
export declare function encodePaymentPolicy(snapshot: PolicySnapshot, key: string): Uint8Array;
export declare function decodePaymentPolicy(raw: Uint8Array, key: string): PolicySnapshot;
/** Device migration must reject unsupported channels before transferring a key. */
export declare function assertHardwarePaymentPolicy(snapshot: PolicySnapshot, key: string): void;
/** Reconnecting a migrated backend may observe later device activity, but must
 * never accept an empty/reset/older ledger for the same imported private key.
 * Limits can legitimately change under newer revisions; spent amounts, closed
 * sessions, payment identities and pool baselines cannot go backwards. */
export declare function assertPaymentPolicyContinuation(source: PolicySnapshot, current: PolicySnapshot, key: string): void;
