import type { WocOutpoint, WocSpentOutput, WocSpentResult } from "@keymaster/contracts";
export function validateSpentOutpoints(points: WocOutpoint[]): void {
  if (!Array.isArray(points) || points.length === 0 || points.length > 20) throw Error("WOC spent batch must contain 1..20 outpoints");
  const seen = new Set<string>();
  for (const p of points) {
    const key = `${p.txid}:${p.vout}`;
    if (!/^[0-9a-f]{64}$/.test(p.txid) || !Number.isInteger(p.vout) || p.vout < 0 || p.vout > 0xffffffff || seen.has(key)) throw Error("WOC invalid or duplicate spent outpoint");
    seen.add(key);
  }
}
export function parseSpentOutput(raw: unknown): WocSpentOutput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("WOC invalid spent output");
  const value = raw as Record<string, unknown>;
  if (typeof value.txid !== "string" || !/^[0-9a-f]{64}$/.test(value.txid) || !Number.isInteger(value.vin) || (value.vin as number) < 0 || (value.vin as number) > 0xffffffff || (value.status !== "confirmed" && value.status !== "unconfirmed")) throw Error("WOC invalid spender");
  return { txid: value.txid, vin: value.vin as number, status: value.status };
}
export function parseSpentBatch(points: WocOutpoint[], raw: unknown): WocSpentResult[] {
  validateSpentOutpoints(points);
  if (!Array.isArray(raw)) throw Error("WOC invalid spent batch");
  const positions = new Map(points.map((p, index) => [`${p.txid}:${p.vout}`, index]));
  const results: WocSpentResult[] = points.map(p => ({ outpoint: { ...p }, status: "unknown" }));
  const seen = new Set<string>();
  for (const row of raw) {
    const key = `${row?.utxo?.txid}:${row?.utxo?.vout}`;
    const index = positions.get(key);
    if (index === undefined || !Number.isInteger(row?.utxo?.vout) || seen.has(key)) throw Error("WOC spent batch outpoint mismatch");
    seen.add(key);
    if (row.error === "") {
      try { results[index] = { outpoint: { ...points[index]! }, status: "spent", spender: parseSpentOutput(row.spentIn) }; }
      catch { /* HTTP200 + error empty + Unknown UTXO remains UNKNOWN */ }
    }
    if (results[index]!.status === "unknown") results[index]!.diagnostic = JSON.stringify(row);
  }
  return results;
}
