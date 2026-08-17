import { sha256 } from "@noble/hashes/sha256";
import type { BsvNetwork, P2pkhConfirmedDataProvider } from "@keymaster/contracts";
import { P2pkhProviderError } from "@keymaster/contracts";
import type { JungleBusClient } from "./jungleBusClient.js";

function base64ToHex(value: string): string {
  if (typeof atob !== "function") throw new Error("Base64 decoder unavailable");
  return Array.from(atob(value), (char) => char.charCodeAt(0).toString(16).padStart(2, "0")).join("");
}

function txid(value: unknown): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new P2pkhProviderError("provider-inconsistent", "JungleBus returned an invalid txid");
  return normalized;
}
function dshaTxid(rawHex: string): string {
  const bytes = Uint8Array.from({ length: rawHex.length / 2 }, (_, i) => Number.parseInt(rawHex.slice(i * 2, i * 2 + 2), 16));
  return Array.from(sha256(sha256(bytes)).reverse(), (b) => b.toString(16).padStart(2, "0")).join("");
}
function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    for (const key of ["transactions", "txids", "items", "result", "data"]) if (Array.isArray(object[key])) return object[key] as unknown[];
  }
  return [];
}
function txidFromItem(value: unknown): string {
  if (typeof value === "string") return txid(value);
  if (!value || typeof value !== "object") throw new P2pkhProviderError("provider-inconsistent", "JungleBus address item is invalid");
  const item = value as Record<string, unknown>;
  return txid(item.transaction_id ?? item.txid ?? item.tx_id ?? item.id ?? item.hash);
}
function heightFromItem(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  // block_index is the transaction's position within a block, not the block
  // height. Only accept fields that identify the block itself.
  const height = item.blockHeight ?? item.block_height ?? item.height;
  return Number.isSafeInteger(height) && Number(height) >= 0 ? Number(height) : undefined;
}
function blockHashFromItem(value: unknown): string | undefined { if (!value || typeof value !== "object") return undefined; const item = value as Record<string, unknown>; return typeof (item.blockHash ?? item.block_hash) === "string" ? String(item.blockHash ?? item.block_hash) : undefined; }
function blockTimeFromItem(value: unknown): number | undefined { if (!value || typeof value !== "object") return undefined; const item = value as Record<string, unknown>; const time = item.blockTime ?? item.block_time ?? item.timestamp; return typeof time === "number" ? time : undefined; }

function parseTransactionResponse(value: unknown): { rawTxHex: string; blockHeight?: number; blockHash?: string; blockTime?: number } {
  const object = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const transaction = object.transaction ?? object.rawTransaction ?? object.raw_tx ?? object.hex ?? value;
  if (typeof transaction !== "string") throw new P2pkhProviderError("provider-inconsistent", "JungleBus transaction response has no raw transaction");
  // JungleBus's `transaction` field is raw bytes encoded as Base64. Explicit
  // hex fields remain supported for local proxies, but never treat Base64 as hex.
  const isExplicitHex = typeof object.hex === "string" || typeof object.rawTransaction === "string" || typeof object.raw_tx === "string";
  let rawTxHex: string;
  try { rawTxHex = isExplicitHex ? transaction.replace(/^0x/i, "").toLowerCase() : base64ToHex(transaction); } catch { throw new P2pkhProviderError("provider-inconsistent", "JungleBus raw transaction encoding is invalid"); }
  if (!/^[0-9a-f]+$/.test(rawTxHex) || rawTxHex.length % 2 !== 0) throw new P2pkhProviderError("provider-inconsistent", "JungleBus raw transaction is not bytes");
  return { rawTxHex, blockHeight: heightFromItem(value), blockHash: blockHashFromItem(value), blockTime: blockTimeFromItem(value) };
}

export function createJungleBusP2pkhConfirmedProvider(input: { client: JungleBusClient }): P2pkhConfirmedDataProvider {
  type Snapshot = { network: BsvNetwork; address: string; items: Array<{ txid: string; blockHeight?: number; blockHash?: string; blockTime?: number }>; lastUsedAt: number };
  const snapshots = new Map<string, Snapshot>();
  let snapshotSequence = 0;
  const snapshotTtlMs = 10 * 60 * 1000;
  const pruneSnapshots = () => {
    const cutoff = Date.now() - snapshotTtlMs;
    for (const [id, snapshot] of snapshots) if (snapshot.lastUsedAt < cutoff) snapshots.delete(id);
    while (snapshots.size > 16) snapshots.delete(snapshots.keys().next().value as string);
  };
  const loadSnapshot = async (network: BsvNetwork, address: string, signal: AbortSignal): Promise<Snapshot> => {
    const raw = await input.client.getAddressTransactions(network, address, signal);
    let items = asArray(raw).map((entry) => ({ txid: txidFromItem(entry), ...(heightFromItem(entry) === undefined ? {} : { blockHeight: heightFromItem(entry) }), ...(blockHashFromItem(entry) ? { blockHash: blockHashFromItem(entry) } : {}), ...(blockTimeFromItem(entry) === undefined ? {} : { blockTime: blockTimeFromItem(entry) }) }));
    const hasHeights = items.some((entry) => entry.blockHeight !== undefined);
    items.sort((a, b) => hasHeights ? (b.blockHeight ?? -1) - (a.blockHeight ?? -1) : 0);
    if (!hasHeights) items.reverse();
    const seen = new Set<string>(); items = items.filter((entry) => !seen.has(entry.txid) && seen.add(entry.txid));
    const snapshot = { network, address, items, lastUsedAt: Date.now() } satisfies Snapshot;
    pruneSnapshots();
    const id = `${Date.now().toString(36)}-${++snapshotSequence}`;
    snapshots.set(id, snapshot);
    return snapshot;
  };
  return {
    descriptor: { id: "junglebus", label: "JungleBus", supportedNetworks: ["main", "test"] },
    async listAddressConfirmedTransactions(request) {
      pruneSnapshots();
      let snapshot: Snapshot;
      let offset = 0;
      let snapshotId: string | undefined;
      if (request.cursor) {
        const match = /^jb1:([^:]+):(\d+)$/.exec(request.cursor);
        if (!match) throw new P2pkhProviderError("provider-inconsistent", "Invalid JungleBus cursor");
        snapshotId = match[1];
        offset = Number(match[2]);
        if (!Number.isSafeInteger(offset) || offset < 0) throw new P2pkhProviderError("provider-inconsistent", "Invalid JungleBus cursor");
        snapshot = snapshots.get(match[1]!)!;
        // A worker restart cannot retain the in-memory snapshot. The saved
        // offset is not safe against inserts/removals in the upstream
        // address history, so rebuild a new snapshot and restart from its
        // beginning. The sync layer deduplicates already observed txids and
        // will only complete its reorg audit after this fresh snapshot is
        // exhausted.
        if (!snapshot) {
          snapshot = await loadSnapshot(request.network, request.address, request.signal);
          snapshotId = [...snapshots.entries()].find(([, value]) => value === snapshot)?.[0];
          offset = 0;
        }
        if (snapshot.network !== request.network || snapshot.address !== request.address) throw new P2pkhProviderError("provider-inconsistent", "JungleBus cursor does not match address");
      } else {
        snapshot = await loadSnapshot(request.network, request.address, request.signal);
        snapshotId = [...snapshots.entries()].find(([, value]) => value === snapshot)?.[0];
      }
      snapshot.lastUsedAt = Date.now();
      const page = snapshot.items.slice(offset, offset + request.limit);
      const nextOffset = offset + page.length;
      const next = nextOffset < snapshot.items.length ? `jb1:${snapshotId ?? "restart"}:${nextOffset}` : undefined;
      if (!next && snapshotId) snapshots.delete(snapshotId);
      return { items: page, nextCursor: next, exhausted: !next };
    },
    async getConfirmedTransaction(request) {
      const expected = txid(request.txid);
      const parsed = parseTransactionResponse(await input.client.getTransaction(request.network, expected, request.signal));
      if (dshaTxid(parsed.rawTxHex) !== expected) throw new P2pkhProviderError("provider-inconsistent", `JungleBus raw transaction txid mismatch for ${expected}`);
      return { txid: expected, rawTxHex: parsed.rawTxHex, blockHeight: parsed.blockHeight, blockHash: parsed.blockHash, blockTime: parsed.blockTime };
    }
  };
}

export const createJungleBusConfirmedProvider = createJungleBusP2pkhConfirmedProvider;
