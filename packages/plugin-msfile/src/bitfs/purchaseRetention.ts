import type { BorrowedModuleFileStore } from "@keymaster/contracts";
import type { BitfsSessionRecord } from "./sessionJournal.js";
import type { BitfsFundingAccount } from "./funding.js";

interface DeletedHistory { version: 1; seedHashHex: string; sessionIds: string[]; hiddenSessionIds?: string[]; erasableSessionIds?: string[] }
const queues = new Map<string, Promise<void>>();
/** 与内容写入共用的删除栅栏；不涉及签名、广播或资金操作。 */
export async function withBitfsContentLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const prior = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  queues.set(key, gate);
  await prior;
  try { return await run(); } finally { release(); if (queues.get(key) === gate) queues.delete(key); }
}
export function bitfsContentLockKey(store: BorrowedModuleFileStore, owner: string, seed: string): string {
  return `${store.walletGeneration}:${store.sessionEpoch}:${store.runGeneration}:${owner}:${seed}`;
}
export async function readBitfsDeletedHistory(store: BorrowedModuleFileStore, seed: string): Promise<Set<string>> {
  if (!/^[0-9a-f]{64}$/.test(seed)) throw new Error("删除记录 Seed Hash 无效");
  const file = await store.get(`deleted-history/${seed}.json`);
  if (!file) return new Set();
  const value = JSON.parse(new TextDecoder().decode(file.bytes)) as DeletedHistory;
  if (value.version !== 1 || value.seedHashHex !== seed || !Array.isArray(value.sessionIds)
    || value.sessionIds.some(id => !/^[0-9a-z][0-9a-z._-]{0,127}$/.test(id))) throw new Error("采购删除记录损坏");
  return new Set(value.sessionIds);
}
/** 只有清理成功才从普通历史隐藏，失败仍可看到原记录并重试。 */
export async function readBitfsHiddenHistory(store: BorrowedModuleFileStore, seed: string): Promise<Set<string>> {
  const file = await store.get(`deleted-history/${seed}.json`);
  if (!file) return new Set();
  await readBitfsDeletedHistory(store, seed);
  const value = JSON.parse(new TextDecoder().decode(file.bytes)) as DeletedHistory;
  if (value.hiddenSessionIds !== undefined && (!Array.isArray(value.hiddenSessionIds) || value.hiddenSessionIds.some(id => !value.sessionIds.includes(id)))) throw new Error("采购隐藏记录损坏");
  return new Set(value.hiddenSessionIds ?? []);
}
export async function readBitfsErasableHistory(store: BorrowedModuleFileStore, seed: string): Promise<Set<string>> {
  const deleted = await readBitfsDeletedHistory(store, seed);
  const file = await store.get(`deleted-history/${seed}.json`);
  if (!file) return new Set();
  const value = JSON.parse(new TextDecoder().decode(file.bytes)) as DeletedHistory;
  if (value.erasableSessionIds !== undefined && (!Array.isArray(value.erasableSessionIds) || value.erasableSessionIds.some(id => !deleted.has(id)))) throw new Error("采购清理提交记录损坏");
  return new Set(value.erasableSessionIds ?? []);
}
export async function completeBitfsHistoryDeletion(store: BorrowedModuleFileStore, seed: string, ids: readonly string[]): Promise<void> {
  const deleted = await readBitfsDeletedHistory(store, seed), hidden = await readBitfsHiddenHistory(store, seed), erasable = await readBitfsErasableHistory(store, seed);
  for (const id of ids) hidden.add(id);
  await store.put(`deleted-history/${seed}.json`, new TextEncoder().encode(JSON.stringify({ version: 1, seedHashHex: seed, sessionIds: [...deleted], hiddenSessionIds: [...hidden], erasableSessionIds: [...erasable] })));
}
export async function markBitfsDeletedHistory(store: BorrowedModuleFileStore, seed: string, ids: readonly string[], safeIds: readonly string[] = []): Promise<void> {
  const existing = await readBitfsDeletedHistory(store, seed);
  const hidden = await readBitfsHiddenHistory(store, seed);
  const erasable = await readBitfsErasableHistory(store, seed);
  for (const id of ids) existing.add(id);
  for (const id of safeIds) erasable.add(id);
  await store.put(`deleted-history/${seed}.json`, new TextEncoder().encode(JSON.stringify({ version: 1, seedHashHex: seed, sessionIds: [...existing], hiddenSessionIds: [...hidden], erasableSessionIds: [...erasable] })));
}
/** 直接依据执行期间已维护的资金账本分类，不在删除时创建费用池记录。 */
export function bitfsSessionNeedsFundingRecovery(session: BitfsSessionRecord, accounts: readonly BitfsFundingAccount[]): boolean {
  const pools = accounts.flatMap(a => a.pools).filter(p => p.poolId === session.sessionId);
  const transactions = accounts.flatMap(a => a.transactions).filter(t => t.poolId === session.sessionId);
  if (transactions.some(t => t.state !== "failed" && (t.state !== "observed" || !t.inputsReconciled))) return true;
  if (pools.length) return pools.some(p => p.state !== "closed" && !(p.state === "funding-failed" && session.phase === "cancelled" && transactions.every(t => t.state === "failed") && !session.pendingAuthorizationId && !session.pendingTxid));
  // 没有账本池不能据此认定未派发；先保留预签、交易和付款责任。
  if (session.pendingTxid || session.pendingAuthorizationId) return true;
  if (session.phase === "cancelled" && transactions.length && transactions.every(t => t.state === "failed")) return false;
  return session.evidence.some(name => ["kind2-opening-request", "kind3-opening-response", "funding-transaction", "opening-configuration"].includes(name)
    || name.startsWith("kind7-"));
}
export async function listBitfsPaths(store: BorrowedModuleFileStore, prefix: string): Promise<string[]> {
  const result: string[] = []; let cursor: string | undefined;
  do {
    const page = await store.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    result.push(...page.files.map(file => file.path)); cursor = page.nextCursor;
  } while (cursor !== undefined);
  return result;
}
export async function deleteBitfsPrefix(store: BorrowedModuleFileStore, prefix: string): Promise<void> {
  // 先收集路径再删，避免基于 offset 的分页因删除而跳项。
  for (const path of await listBitfsPaths(store, prefix)) await store.delete(path);
}
/** 已删采购保留的内容仅供原资金恢复使用，不可再进入普通文件库。
 * 每个操作与删除串行，阻止迟到写入跨越删除边界。 */
export function createBitfsRetainedContentStore(input: { store: BorrowedModuleFileStore; journal: BorrowedModuleFileStore; owner: string; seed: string; sessionId: string }): BorrowedModuleFileStore {
  const { store, journal, owner, seed, sessionId } = input;
  const key = bitfsContentLockKey(store, owner, seed);
  const base = `bitfs-recovery-content/${sessionId}/`;
  const map = async (path: string) => (await readBitfsDeletedHistory(journal, seed)).has(sessionId) ? base + path : path;
  const writePath = async (path: string) => {
    const mapped = await map(path);
    if (mapped.startsWith(base) && !await journal.get(`sessions/${sessionId}.json`)) throw new Error("采购已删除，停止迟到内容写入");
    return mapped;
  };
  return {
    walletGeneration: store.walletGeneration, sessionEpoch: store.sessionEpoch, runGeneration: store.runGeneration,
    get: (path, options) => withBitfsContentLock(key, async () => { const mapped = await map(path); const file = await store.get(mapped, options); return file ? { ...file, path } : undefined; }),
    getRange: (path, range, options) => withBitfsContentLock(key, async () => { const file = await store.getRange(await map(path), range, options); return file ? { ...file, path } : undefined; }),
    put: (path, bytes, options) => withBitfsContentLock(key, async () => store.put(await writePath(path), bytes, options)),
    delete: (path, options) => withBitfsContentLock(key, async () => store.delete(await map(path), options)),
    list: (options = {}) => withBitfsContentLock(key, async () => {
      const prefix = await map(options.prefix ?? "");
      const page = await store.list({ ...options, prefix });
      return { ...page, files: page.files.map(file => ({ ...file, path: prefix.startsWith(base) ? file.path.slice(base.length) : file.path })) };
    }),
    batch: (input, options) => withBitfsContentLock(key, async () => {
      const operations = await Promise.all(input.operations.map(async op => ({ ...op, path: op.type === "put" ? await writePath(op.path) : await map(op.path) })));
      const conditions = input.conditions ? await Promise.all(input.conditions.map(async c => ({ ...c, path: await map(c.path) }))) : undefined;
      const result = await store.batch({ operations, ...(conditions ? { conditions } : {}) }, options);
      return { ...result, paths: input.operations.map(op => op.path) };
    }),
  };
}
