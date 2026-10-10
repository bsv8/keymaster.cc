import { PaymentPolicy, hex, unhex, type PolicySnapshot } from "@vaultlink/sdk";
/** Browser persistence and migration share one uint64/byte codec. Parsing never
 * converts a corrupt or missing ledger into a freshly authorized empty ledger. */
export function parseStoredPaymentPolicy(bytes: Uint8Array, key: string): PolicySnapshot {
  const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes), (_name, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if ("$bigint" in value) {
        if (Object.keys(value).length !== 1 || typeof value.$bigint !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value.$bigint)) throw new Error("Invalid stored payment integer");
        return BigInt(value.$bigint);
      }
      if ("$bytes" in value) {
        if (Object.keys(value).length !== 1 || typeof value.$bytes !== "string" || !/^(?:[0-9a-f]{2})*$/u.test(value.$bytes)) throw new Error("Invalid stored payment bytes");
        return unhex(value.$bytes);
      }
    }
    return value;
  });
  // PaymentPolicy.open owns schema upgrades and validates before any signing.
  // Do not reject its supported v1 on the storage read path; migration separately
  // passes the upgraded snapshot through the strict v2 bank encoder.
  if (!parsed || typeof parsed !== "object" || (parsed as { key?: unknown }).key !== key) throw new Error("Stored payment identity mismatch");
  return parsed as PolicySnapshot;
}
export function serializeStoredPaymentPolicy(snapshot: PolicySnapshot, key: string): Uint8Array {
  const valid = PaymentPolicy.inspectSnapshot(snapshot, key);
  return new TextEncoder().encode(JSON.stringify(valid, (_name, value) => typeof value === "bigint" ? { $bigint: String(value) } : value instanceof Uint8Array ? { $bytes: hex(value) } : value));
}
