import type { P2pkhUtxo } from "./p2pkhContracts.js";

export type P2pkhLogicalOutpointKey = string & { readonly __p2pkhLogicalOutpointKey: unique symbol };

/** The namespace-qualified identity used by every balance and selection path. */
export function p2pkhOutpointKey(row: { resourceId: string; txid: string; vout: number }): P2pkhLogicalOutpointKey {
  return `${row.resourceId}:${row.txid}:${row.vout}` as P2pkhLogicalOutpointKey;
}

/**
 * Pick the same canonical candidate for public allocation and the transfer
 * service. Confirmed chain facts always win over local/unconfirmed overlays;
 * duplicate rows within one layer use their stable id as the tie breaker.
 */
export function chooseCanonicalUtxo(current: P2pkhUtxo | undefined, candidate: P2pkhUtxo): P2pkhUtxo {
  if (!current) return candidate;
  const candidateRank = candidate.status === "confirmed" ? 0 : 1;
  const currentRank = current.status === "confirmed" ? 0 : 1;
  if (candidateRank !== currentRank) return candidateRank < currentRank ? candidate : current;
  return candidate.id.localeCompare(current.id) < 0 ? candidate : current;
}

export function canonicalizeP2pkhUtxos(candidates: P2pkhUtxo[]): P2pkhUtxo[] {
  const byOutpoint = new Map<string, P2pkhUtxo>();
  for (const candidate of candidates) {
    const key = p2pkhOutpointKey(candidate);
    byOutpoint.set(key, chooseCanonicalUtxo(byOutpoint.get(key), candidate));
  }
  return [...byOutpoint.values()];
}
