// Runtime 日志 K-V Repository。
//
// 日志属于平台诊断状态，写入 `logs` platform namespace；业务插件只能通过
// logger 访问。生产 Host 注入 Coordinator 绑定的句柄，测试可使用内存夹具。

import type { KeyValueStore } from "@keymaster/contracts";
import { createInMemoryKeyValueStore } from "../storage/inMemoryKeyValueStore.js";

export const LOG_STORAGE_ID = "logs";
const CONFIG_PARTITION = "config";
const ENTRIES_PARTITION = "entries";
const CONFIG_KEY = "singleton";
const ENTRY_PREFIX = "entry/";

export interface LogEntryRow {
  id: string;
  ts: string;
  level: string;
  pluginId: string;
  scope: string;
  event: string;
  message: string;
  data?: Record<string, unknown>;
  keyScope?: { publicKeyHex: string };
  error?: { name?: string; message: string; stack?: string };
}

export interface LogConfigRow {
  id: "singleton";
  retentionDays: number;
  debugEnabled: boolean;
}

let repositoryStore: KeyValueStore | undefined;
let testStore: KeyValueStore | undefined;

function getStore(): KeyValueStore {
  if (repositoryStore) return repositoryStore;
  testStore ??= createInMemoryKeyValueStore({ scope: "platform", applicationStorageId: LOG_STORAGE_ID, schemaVersion: 1, bucketId: "test-memory", bucketGeneration: 1 });
  return testStore;
}

/** 由生产装配层注入 logs platform 句柄。 */
export function configureLogRepository(store: KeyValueStore): void {
  repositoryStore?.close();
  repositoryStore = store;
}

export function disposeLogRepository(): void {
  repositoryStore?.close();
  repositoryStore = undefined;
  testStore?.close();
  testStore = undefined;
}

async function listEntries(): Promise<LogEntryRow[]> {
  const rows: LogEntryRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await getStore().list({ partition: ENTRIES_PARTITION, prefix: ENTRY_PREFIX, cursor, limit: 1000 });
    rows.push(...page.entries.map((entry) => entry.value as unknown as LogEntryRow));
    cursor = page.nextCursor;
  } while (cursor);
  return rows;
}

export async function putEntry(row: LogEntryRow): Promise<void> {
  await getStore().put(`${ENTRY_PREFIX}${row.id}`, row, { partition: ENTRIES_PARTITION });
}

export async function getEntry(id: string): Promise<LogEntryRow | undefined> {
  return (await getStore().get<LogEntryRow>(`${ENTRY_PREFIX}${id}`, { partition: ENTRIES_PARTITION }))?.value;
}

export async function listAllEntries(): Promise<LogEntryRow[]> {
  return (await listEntries()).sort((left, right) => right.ts.localeCompare(left.ts));
}

export async function listByPlugin(pluginId: string): Promise<LogEntryRow[]> {
  return (await listEntries()).filter((row) => row.pluginId === pluginId).sort((left, right) => right.ts.localeCompare(left.ts));
}

export async function deleteWhere(predicate: (row: LogEntryRow) => boolean): Promise<number> {
  const matches = (await listEntries()).filter(predicate);
  if (matches.length === 0) return 0;
  await getStore().commit({ partition: ENTRIES_PARTITION, operations: matches.map((row) => ({ type: "delete" as const, key: `${ENTRY_PREFIX}${row.id}` })) });
  return matches.length;
}

export async function getConfigRow(): Promise<LogConfigRow | undefined> {
  return (await getStore().get<LogConfigRow>(CONFIG_KEY, { partition: CONFIG_PARTITION }))?.value;
}

export async function putConfigRow(row: LogConfigRow): Promise<void> {
  await getStore().put(CONFIG_KEY, row, { partition: CONFIG_PARTITION });
}
