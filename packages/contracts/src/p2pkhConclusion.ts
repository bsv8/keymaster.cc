/** Wallet-owner UI RPC only. Application payment.status remains read-only. */
export type P2pkhConclusionInput = {
  ownerPublicKeyHex: string;
  network: "main" | "test";
} & ({ action: "list" } | { action: "start" | "stop"; allocationId: string });
export interface P2pkhInputConclusion {
  status: "conflict" | "failed";
  reason: "input-conflict";
  releasedInputs: string[];
  spentInputs: Array<{ outpoint: string; txid: string; vin: number | null; confirmed: boolean | null }>;
  heldInputs: string[];
  releasedSats: string;
}
export interface P2pkhConclusionRow {
  allocationId: string;
  txid: string;
  state: "pending" | "dispatching" | "unknown" | "done" | "failed";
  delivery: "wallet" | "external";
  queryState: "stopped" | "running";
  conclusion?: P2pkhInputConclusion;
  error?: string;
}
export interface P2pkhConclusionResult { items: P2pkhConclusionRow[]; }
export interface P2pkhPaymentLookupInput { ownerPublicKeyHex: string; network: "main" | "test"; paymentId: string; }
export interface P2pkhPaymentLookupResult {
  status: "not_found" | "not_signed" | "pending" | "signed_not_dispatched" | "unknown" | "accepted" | "failed";
  allocationId?: string;
  txid?: string;
  conclusion?: P2pkhInputConclusion;
}
export function parseP2pkhPaymentLookupInput(value: unknown): P2pkhPaymentLookupInput {
  const v = record(value);
  if (Object.keys(v).some(key => !["ownerPublicKeyHex", "network", "paymentId"].includes(key))) throw new TypeError("Unexpected payment lookup request field");
  const scope = parseP2pkhConclusionInput({ ownerPublicKeyHex: v.ownerPublicKeyHex, network: v.network, action: "list" });
  return { ownerPublicKeyHex: scope.ownerPublicKeyHex, network: scope.network, paymentId: text(v.paymentId, 256) };
}
export function parseP2pkhPaymentLookupResult(value: unknown): P2pkhPaymentLookupResult {
  const v = record(value);
  const status = choice(v.status, ["not_found", "not_signed", "pending", "signed_not_dispatched", "unknown", "accepted", "failed"] as const);
  if (status === "not_found") {
    if (v.allocationId !== undefined || v.txid !== undefined || v.conclusion !== undefined) throw new TypeError("Missing payment has unexpected exact facts");
    return { status };
  }
  if (status === "not_signed") {
    if (v.txid !== undefined || v.conclusion !== undefined) throw new TypeError("Unsigned payment has unexpected exact facts");
    return { status, allocationId: text(v.allocationId, 128) };
  }
  const allocationId = text(v.allocationId, 128);
  const canonical = v.txid === undefined ? undefined : txid(v.txid);
  if ((status === "accepted" || status === "failed" || status === "signed_not_dispatched") && !canonical) throw new TypeError("Payment conclusion lacks canonical txid");
  const result: P2pkhPaymentLookupResult = { status, allocationId, ...(canonical ? { txid: canonical } : {}) };
  if (v.conclusion !== undefined) {
    if (status !== "unknown" && status !== "failed") throw new TypeError("Unexpected input conflict conclusion");
    if (!canonical) throw new TypeError("Input conclusion lacks exact identity");
    const row = parseP2pkhConclusionResult({ items: [{ allocationId, txid: canonical, delivery: "wallet", queryState: "stopped", state: status === "failed" ? "failed" : "unknown", conclusion: v.conclusion }] }).items[0]!;
    result.conclusion = row.conclusion;
  }
  if (status === "failed" && result.conclusion?.status !== "failed") throw new TypeError("Failed payment lacks release conclusion");
  return result;
}

function record(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new TypeError("Invalid conclusion record");
  return v as Record<string, unknown>;
}
function text(v: unknown, max = 256): string {
  if (typeof v !== "string" || !v.length || v.length > max) throw new TypeError("Invalid conclusion string");
  return v;
}
function choice<T extends string>(v: unknown, options: readonly T[]): T {
  if (!options.includes(v as T)) throw new TypeError("Invalid conclusion enum");
  return v as T;
}
function txid(v: unknown): string { const s = text(v, 64); if (!/^[0-9a-f]{64}$/.test(s)) throw new TypeError("Invalid conclusion txid"); return s; }
function outpoint(v: unknown): string { const s = text(v, 80); const m = /^([0-9a-f]{64}):(0|[1-9][0-9]*)$/.exec(s); if (!m || Number(m[2]) > 0xffffffff) throw new TypeError("Invalid conclusion outpoint"); return s; }
function points(v: unknown): string[] { if (!Array.isArray(v) || v.length > 100000) throw new TypeError("Invalid conclusion input list"); return v.map(outpoint); }
export function parseP2pkhConclusionInput(value: unknown): P2pkhConclusionInput {
  const v = record(value);
  const action = choice(v.action, ["list", "start", "stop"] as const);
  const ownerPublicKeyHex = text(v.ownerPublicKeyHex, 66);
  if (!/^(02|03)[0-9a-f]{64}$/i.test(ownerPublicKeyHex)) throw new TypeError("Invalid conclusion owner");
  const network = choice(v.network, ["main", "test"] as const);
  const allowed = ["action", "ownerPublicKeyHex", "network", ...(action === "list" ? [] : ["allocationId"])];
  if (Object.keys(v).some(k => !allowed.includes(k))) throw new TypeError("Unexpected conclusion request field");
  return action === "list" ? { action, ownerPublicKeyHex, network } : { action, ownerPublicKeyHex, network, allocationId: text(v.allocationId, 128) };
}
export function parseP2pkhConclusionResult(value: unknown): P2pkhConclusionResult {
  const v = record(value);
  if (!Array.isArray(v.items) || v.items.length > 100000) throw new TypeError("Invalid conclusion items");
  return { items: v.items.map(item => {
    const row = record(item);
    const result: P2pkhConclusionRow = {
      allocationId: text(row.allocationId, 128), txid: txid(row.txid),
      state: choice(row.state, ["pending", "dispatching", "unknown", "done", "failed"] as const),
      delivery: choice(row.delivery, ["wallet", "external"] as const),
      queryState: choice(row.queryState, ["stopped", "running"] as const),
      ...(row.error === undefined ? {} : { error: text(row.error, 2048) }),
    };
    if (row.conclusion !== undefined) {
      const c = record(row.conclusion);
      if (!Array.isArray(c.spentInputs) || c.spentInputs.length > 100000) throw new TypeError("Invalid spent facts");
      const releasedSats = text(c.releasedSats, 20);
      if (!/^(0|[1-9][0-9]*)$/.test(releasedSats) || BigInt(releasedSats) > 2100000000000000n) throw new TypeError("Invalid released amount");
      result.conclusion = {
        status: choice(c.status, ["conflict", "failed"] as const), reason: choice(c.reason, ["input-conflict"] as const),
        releasedInputs: points(c.releasedInputs), heldInputs: points(c.heldInputs), releasedSats,
        spentInputs: c.spentInputs.map(item => {
          const f = record(item);
          if (f.vin !== null && (!Number.isInteger(f.vin) || (f.vin as number) < 0 || (f.vin as number) > 0xffffffff)) throw new TypeError("Invalid spender vin");
          if (f.confirmed !== null && typeof f.confirmed !== "boolean") throw new TypeError("Invalid spender confirmation");
          return { outpoint: outpoint(f.outpoint), txid: txid(f.txid), vin: f.vin as number | null, confirmed: f.confirmed as boolean | null };
        }),
      };
      if (result.conclusion.spentInputs.length === 0 || (result.conclusion.status === "failed") !== (result.conclusion.heldInputs.length === 0) || (result.state === "failed") !== (result.conclusion.status === "failed")) throw new TypeError("Inconsistent input conclusion state");
    }
    return result;
  }) };
}
