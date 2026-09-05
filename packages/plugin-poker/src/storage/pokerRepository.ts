// Poker owner/App K-V Repository。
// 运行缓存按 partition 隔离；不读取旧设置或旧数据库，也不提供迁移适配器。

import type { KeyValueStore } from "@keymaster/contracts";

export const POKER_KEY_STORAGE_ID = "Poker";
export const POKER_KEY_STORAGE_VERSION = 1;
export interface CachedTable { tableId: string; variant: string; seats: number; stakes: number; ownerPub: string; observedAt: number; }
export interface CachedPresence { publicKeyHex: string; endpoint?: string; nick?: string; seenAt: number; }
export interface CachedTxIngest { txid: string; route: string; kind?: string; reason?: string; rawTx: Uint8Array; receivedAt: number; consumed: boolean; }

const PARTITIONS = { tables: "tables", presences: "presences", txIngest: "tx-ingest" } as const;
const prefix = (partition: string) => `${partition}/`;

async function list<T>(store: KeyValueStore, partition: string): Promise<T[]> {
  const rows: T[] = []; let cursor: string | undefined;
  do { const page = await store.list({ partition, prefix: prefix(partition), cursor, limit: 1000 }); rows.push(...page.entries.map((entry) => entry.value as T)); cursor = page.nextCursor; } while (cursor);
  return rows;
}
async function clear(store: KeyValueStore, partition: string): Promise<void> {
  let cursor: string | undefined; const keys: string[] = [];
  do { const page = await store.list({ partition, prefix: prefix(partition), cursor, limit: 1000 }); keys.push(...page.entries.map((entry) => entry.key)); cursor = page.nextCursor; } while (cursor);
  if (keys.length) await store.commit({ partition, operations: keys.map((key) => ({ type: "delete" as const, key })) });
}

export async function writeTable(store: KeyValueStore, table: CachedTable): Promise<void> { await store.put(`${prefix(PARTITIONS.tables)}${table.tableId}`, table, { partition: PARTITIONS.tables }); }
export function readAllTables(store: KeyValueStore): Promise<CachedTable[]> { return list<CachedTable>(store, PARTITIONS.tables); }
export async function deleteTable(store: KeyValueStore, tableId: string): Promise<void> { await store.delete(`${prefix(PARTITIONS.tables)}${tableId}`, { partition: PARTITIONS.tables }); }
export function clearTables(store: KeyValueStore): Promise<void> { return clear(store, PARTITIONS.tables); }
export async function writePresence(store: KeyValueStore, presence: CachedPresence): Promise<void> { await store.put(`${prefix(PARTITIONS.presences)}${presence.publicKeyHex}`, presence, { partition: PARTITIONS.presences }); }
export function readAllPresences(store: KeyValueStore): Promise<CachedPresence[]> { return list<CachedPresence>(store, PARTITIONS.presences); }
export function clearPresences(store: KeyValueStore): Promise<void> { return clear(store, PARTITIONS.presences); }
export async function writeTxIngest(store: KeyValueStore, value: CachedTxIngest): Promise<void> { await store.put(`${prefix(PARTITIONS.txIngest)}${value.txid}`, value, { partition: PARTITIONS.txIngest }); }
export async function readAllTxIngest(store: KeyValueStore, cap = 200): Promise<CachedTxIngest[]> { return (await list<CachedTxIngest>(store, PARTITIONS.txIngest)).sort((a, b) => a.receivedAt - b.receivedAt).slice(-cap); }
export function clearTxIngest(store: KeyValueStore): Promise<void> { return clear(store, PARTITIONS.txIngest); }
