import { requireWocNetwork } from "@keymaster/contracts";
// Current manager result adapter; chain observations go straight into the manager.
// No external UTXO cache, whole-result lock or timeout release.
import type { WocService, WocUtxoResponse, P2pkhUtxoSnapshotItem, P2pkhUtxoSnapshotResult } from "@keymaster/contracts";
import type { P2pkhUtxoManager } from "./p2pkhUtxoManager.js";

const TXID_PATTERN = /^[0-9a-f]{64}$/u;
export interface P2pkhUtxoSnapshotResource {
  resourceId: string;
  publicKeyHex: string;
  network: "main" | "test";
  address: string;
  generation: number;
}
/** All returned funds data comes from the current manager projection. */
export interface P2pkhUtxoSnapshotStore {
  refresh(resource: P2pkhUtxoSnapshotResource, options?: { signal?: AbortSignal }): Promise<P2pkhUtxoSnapshotResult>;
  get(resource: P2pkhUtxoSnapshotResource): Promise<P2pkhUtxoSnapshotResult>;
  clearOwner(publicKeyHex: string): void;
  clearAll(): void;
}

/** Validate the entire provider response before committing any observation. */
export function validateP2pkhUnspentAll(rows: readonly WocUtxoResponse[]): P2pkhUtxoSnapshotItem[] {
  const byOutpoint = new Map<string, P2pkhUtxoSnapshotItem>();
  for (const row of rows) {
    const txid = String(row.txid ?? "").trim().toLowerCase();
    if (!TXID_PATTERN.test(txid)) throw new Error("WoC unspent/all returned an invalid txid");
    if (!Number.isSafeInteger(row.vout) || row.vout < 0) throw new Error("WoC unspent/all returned an invalid vout");
    if (!Number.isSafeInteger(row.value) || row.value < 0) throw new Error("WoC unspent/all returned an invalid value");
    if (row.status !== "confirmed" && row.status !== "unconfirmed") throw new Error("WoC unspent/all returned an unknown status");
    if (typeof row.isSpentInMempoolTx !== "boolean") throw new Error("WoC unspent/all returned an invalid isSpentInMempoolTx");
    if (row.script !== undefined && typeof row.script !== "string") throw new Error("WoC unspent/all returned an invalid script");
    const height = row.status === "confirmed"
      ? (Number.isSafeInteger(row.height) && row.height > 0 ? row.height : (() => { throw new Error("WoC unspent/all returned an invalid confirmed height"); })()) : 0;
    const item: P2pkhUtxoSnapshotItem = { txid, vout: row.vout, value: row.value, height, status: row.status, isSpentInMempoolTx: row.isSpentInMempoolTx,
      ...(row.script ? { script: row.script } : {}) };
    const key = `${txid}:${row.vout}`;
    const prior = byOutpoint.get(key);
    if (prior) {
      if (prior.value !== item.value || (prior.script !== undefined && item.script !== undefined && prior.script !== item.script)) throw new Error(`WoC unspent/all returned conflicting duplicates for ${key}`);
      item.status = prior.status === "confirmed" || item.status === "confirmed" ? "confirmed" : "unconfirmed";
      item.height = item.status === "confirmed" ? Math.max(prior.height, item.height) : 0;
      item.isSpentInMempoolTx ||= prior.isSpentInMempoolTx;
      item.script ??= prior.script;
    }
    byOutpoint.set(key, item);
  }
  return [...byOutpoint.values()].sort((a, b) => a.txid.localeCompare(b.txid) || a.vout - b.vout);
}

export function createP2pkhUtxoSnapshotStore(deps: {
  woc: WocService;
  manager: P2pkhUtxoManager;
  assertActive(): void;
  now?: () => string;
}): P2pkhUtxoSnapshotStore {
  // Only notification cursors are cached, never funds or provider responses.
  const cursors = new Map<string, { fingerprint: string; seq: number }>();
  const inFlight = new Map<string, Promise<P2pkhUtxoSnapshotResult>>();
  let nextSeq = 0;
  let epoch = 0;
  const keyFor = (r: P2pkhUtxoSnapshotResource) => `${r.publicKeyHex.toLowerCase()}:${r.network}:${r.address}:${r.generation}`;
  const check = (captured: number) => { deps.assertActive(); if (captured !== epoch) throw new Error("Manager observation session revoked"); };
  async function get(resource: P2pkhUtxoSnapshotResource): Promise<P2pkhUtxoSnapshotResult> {
    const captured = epoch;
    check(captured);
    const view = await deps.manager.available({ ownerPublicKeyHex: resource.publicKeyHex, resource });
    check(captured);
    const items = view.inputs.map(({ utxo }) => ({ txid: utxo.txid, vout: utxo.vout, value: utxo.value, height: utxo.height ?? 0, status: utxo.status, isSpentInMempoolTx: false, ...(utxo.script ? { script: utxo.script } : {}) }));
    const fingerprint = JSON.stringify(items);
    const key = keyFor(resource), prior = cursors.get(key);
    const seq = prior?.fingerprint === fingerprint ? prior.seq : ++nextSeq;
    cursors.set(key, { fingerprint, seq });
    return { hasResult: true, seq, syncedAt: deps.now?.() ?? new Date().toISOString(), items };
  }
  return {
    get,
    async refresh(resource, options) {
      const key = keyFor(resource), pending = inFlight.get(key);
      if (pending) return pending;
      const captured = epoch;
      check(captured);
      const task = (async () => {
        const rows = validateP2pkhUnspentAll(await requireWocNetwork(deps.woc, resource.network).getAddressUnspentAll(resource.address, { priority: "background", ...(options?.signal ? { signal: options.signal } : {}) }));
        check(captured);
        if (options?.signal?.aborted) throw new Error("Manager observation cancelled");
        await deps.manager.observe({ ownerPublicKeyHex: resource.publicKeyHex, resource, utxos: rows.map(row => ({ ...row, id: `${row.txid}:${row.vout}`, resourceId: resource.resourceId, publicKeyHex: resource.publicKeyHex, network: resource.network, address: resource.address, syncedAt: deps.now?.() ?? new Date().toISOString() })) });
        check(captured);
        return get(resource);
      })();
      inFlight.set(key, task);
      try { return await task; } finally { if (inFlight.get(key) === task) inFlight.delete(key); }
    },
    clearOwner(owner) { epoch++; for (const key of cursors.keys()) if (key.startsWith(`${owner.toLowerCase()}:`)) cursors.delete(key); inFlight.clear(); },
    clearAll() { epoch++; cursors.clear(); inFlight.clear(); },
  };
}
