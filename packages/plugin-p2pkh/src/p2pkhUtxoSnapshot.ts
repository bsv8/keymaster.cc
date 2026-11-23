import { requireWocNetwork, traceDev } from "@keymaster/contracts";
// Current manager result adapter; chain observations go straight into the manager.
// No external UTXO cache, whole-result lock or timeout release.
import type { WocService, WocUtxoResponse, P2pkhUtxoSnapshotItem, P2pkhUtxoSnapshotResult } from "@keymaster/contracts";
import type { P2pkhUtxoManager } from "./p2pkhUtxoManager.js";

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

/** Merge already parsed WoC facts before atomically observing the batch. */
export function mergeP2pkhUnspentFacts(rows: readonly WocUtxoResponse[]): P2pkhUtxoSnapshotItem[] {
  const byOutpoint = new Map<string, P2pkhUtxoSnapshotItem>();
  for (const row of rows) {
    const txid = row.txid.toLowerCase();
    const height = row.status === "confirmed" ? row.height! : 0;
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
  /** Running plus queued observations, shared by every refresh caller. */
  maxTasks?: number;
}): P2pkhUtxoSnapshotStore {
  // Only notification cursors are cached, never funds or provider responses.
  const cursors = new Map<string, { fingerprint: string; seq: number }>();
  const maxTasks = deps.maxTasks ?? 3;
  const queue: Array<{ start(): Promise<void>; cancel(): void }> = [];
  let running = false;
  const pending = new Map<string, { controller: AbortController; result: Promise<P2pkhUtxoSnapshotResult> }>();
  function advance(): void {
    if (running) return;
    const task = queue.shift();
    if (!task) return;
    running = true;
    void task.start().finally(() => { running = false; advance(); });
  }
  function cancelQueued(): void {
    for (const { controller } of pending.values()) controller.abort();
    pending.clear();
    for (const task of queue.splice(0)) task.cancel();
  }
  let nextSeq = 0;
  let epoch = 0;
  const keyFor = (r: P2pkhUtxoSnapshotResource) => `${r.publicKeyHex.toLowerCase()}:${r.network}:${r.address}:${r.generation}`;
  const check = (captured: number) => { deps.assertActive(); if (captured !== epoch) throw new Error("Manager observation session revoked"); };
  async function get(resource: P2pkhUtxoSnapshotResource): Promise<P2pkhUtxoSnapshotResult> {
    const captured = epoch;
    check(captured);
    const funds = await deps.manager.funds({ ownerPublicKeyHex: resource.publicKeyHex, network: resource.network });
    check(captured);
    const fingerprint = String(funds.version);
    const key = keyFor(resource), prior = cursors.get(key);
    const seq = prior?.fingerprint === fingerprint ? prior.seq : ++nextSeq;
    cursors.set(key, { fingerprint, seq });
    return { hasResult: true, seq, syncedAt: deps.now?.() ?? new Date().toISOString(), funds };
  }
  function enqueueRefresh(resource: P2pkhUtxoSnapshotResource, currentEpoch: number, signal: AbortSignal): Promise<P2pkhUtxoSnapshotResult> {
    const context = { network: resource.network, address: resource.address, generation: resource.generation };
    if (Number(running) + queue.length >= maxTasks) {
      traceDev("keymaster.utxo", "refresh.queue-full", () => ({ ...context, queued: queue.length, running }));
      return Promise.reject(new Error("UTXO refresh queue full"));
    }
    const queuedAt = performance.now();
    traceDev("keymaster.utxo", "refresh.queued", () => ({ ...context, queued: queue.length, running }));
    return new Promise((resolve, reject) => {
      queue.push({
        cancel() { reject(new Error("Manager observation session revoked")); },
        async start() {
          const startedAt = performance.now();
          traceDev("keymaster.utxo", "refresh.start", () => ({ ...context, queueWaitMs: startedAt - queuedAt }));
          try {
            check(currentEpoch);
            signal.throwIfAborted();
            const observed = await requireWocNetwork(deps.woc, resource.network).getAddressUnspentAll(
              resource.address, { priority: "background", signal },
            );
            check(currentEpoch);
            signal.throwIfAborted();
            const rows = mergeP2pkhUnspentFacts(observed);
            traceDev("keymaster.utxo", "refresh.received", () => ({
              ...context, providerInputs: observed.length, uniqueInputs: rows.length, elapsedMs: performance.now() - startedAt,
            }));
            const syncedAt = deps.now?.() ?? new Date().toISOString();
            await deps.manager.observe({
              ownerPublicKeyHex: resource.publicKeyHex, resource,
              utxos: rows.map(row => ({ ...row, id: `${row.txid}:${row.vout}`, resourceId: resource.resourceId,
                publicKeyHex: resource.publicKeyHex, network: resource.network, address: resource.address, syncedAt })),
            });
            check(currentEpoch);
            const snapshot = await get(resource);
            traceDev("keymaster.utxo", "refresh.observed", () => ({
              ...context, count: rows.length, funds: snapshot.funds, elapsedMs: performance.now() - startedAt,
            }));
            resolve(snapshot);
          } catch (error) {
            traceDev("keymaster.utxo", "refresh.failed", () => ({
              ...context, aborted: signal.aborted, elapsedMs: performance.now() - startedAt, error,
            }));
            reject(error);
          }
        },
      });
      advance();
    });
  }

  return {
    get,
    async refresh(resource, { signal } = {}) {
      check(epoch);
      signal?.throwIfAborted();
      const key = keyFor(resource);
      let entry = pending.get(key);
      if (entry) {
        traceDev("keymaster.utxo", "refresh.join", () => ({ network: resource.network, address: resource.address }));
      } else {
        const controller = new AbortController();
        const result = enqueueRefresh(resource, epoch, controller.signal).finally(() => {
          if (pending.get(key)?.controller === controller) pending.delete(key);
        });
        entry = { controller, result };
        pending.set(key, entry);
      }
      if (!signal) return entry.result;
      const result = entry.result;
      return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        void result.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
      });
    },
    clearOwner(owner) { epoch++; for (const key of cursors.keys()) if (key.startsWith(`${owner.toLowerCase()}:`)) cursors.delete(key); cancelQueued(); deps.manager.dispose(); },
    clearAll() { epoch++; cursors.clear(); cancelQueued(); deps.manager.dispose(); },
  };
}
