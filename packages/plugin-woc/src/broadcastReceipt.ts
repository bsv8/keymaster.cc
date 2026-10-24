import type { WocBroadcastResult, WocBroadcastEvidence } from "@keymaster/contracts";

/** Deliberately limited to the exact HTTP/body pairs captured by the WoC probe. */
export function normalizeWocBroadcastReceipt(
  canonicalTxid: string,
  evidence: WocBroadcastEvidence,
): WocBroadcastResult {
  let receipt: unknown;
  try { receipt = JSON.parse(evidence.body); } catch { /* unknown, retain original body */ }
  const providerTxid = typeof receipt === "string" ? receipt
    : receipt && typeof receipt === "object" && !Array.isArray(receipt)
      && typeof (receipt as { txid?: unknown }).txid === "string"
      ? (receipt as { txid: string }).txid : undefined;
  if (evidence.status >= 200 && evidence.status < 300
    && providerTxid?.toLowerCase() === canonicalTxid && /^[0-9a-f]{64}$/.test(canonicalTxid)) {
    return {
      accepted: true, canonicalTxid, providerReturnedTxidRaw: providerTxid,
      providerReturnedTxidNormalized: canonicalTxid, txidIntegrity: "exact",
      conclusion: "matching-txid", evidence,
    };
  }
  if (evidence.status === 400 && receipt === "unexpected response code 500: Transaction already in the mempool") {
    // This response belongs to the POST of these exact bytes, not a text search or a txid lookup.
    return { accepted: true, canonicalTxid, txidIntegrity: "missing", conclusion: "already-in-mempool", evidence };
  }
  const code = evidence.status === 400 && receipt === "unexpected response code 500: 258: txn-mempool-conflict"
    ? "woc-mempool-conflict" : "woc-broadcast-unknown";
  // Conflict is NOT evidence of which input/spender and is never a release marker.
  throw Object.assign(new Error(`WOC ${evidence.status} ${evidence.statusText} /tx/raw: ${evidence.body}`), {
    code, canonicalTxid, evidence,
  });
}
