// packages/plugin-p2pkh/src/p2pkhDb.ts
// P2PKH 资源库（硬切换 005 + 硬切换 007 + 硬切换 001 + 硬切换 003 + 硬切换 002 收尾）。
// 设计缘由：
//   - 不再使用固定 DB_NAME = "p2pkh"；改为每个 owner publicKeyHex 一个
//     namespace DB，通过 keyspace.openKeyStorage 打开。
//   - DB name 形如 `keymaster.key.<publicKeyHex>.plugin.p2pkh.state`。
//     `publicKeyHex` + 链上数据。UTXO / history 过滤完全按 hex。
//   - module 内部用 `Map<publicKeyHex, OpenHandle>` 缓存「多 owner
//     并存」的 handle：打开新 owner 的 DB **不会** 关闭其它 owner 的
//     handle。每个 owner 的 IDBDatabase 独立持有、独立关闭。
//   - 调用方按 owner 取 handle：transfer 走 session owner，recent /
//     backfill 走 active key。同 owner 的二次 open 走 cache hit
//     (`db.reused`)，不重新打开 namespace DB。
//
// 硬切换 005（2026-06-19）：P2PKH DB 版本硬切换 6 -> 7（history）。
// 硬切换 002（2026-07-02）：P2PKH DB 版本硬切换 7 -> 9（key 域彻底收尾）。
//   - 打开语义收口为单一规则：版本不匹配即整库 rebuild。
//     - `oldVersion < 9`：进入 onupgradeneeded 事务，删光当前 DB 内所有
//       p2pkh_* stores，按 v9 完整重建。
//     - `oldVersion === 9`：直接使用，不做额外 schema 扫描。
//     - `oldVersion > 9`：keyspace.openKeyStorage 会抛 VersionError，
//       p2pkh 在 openP2pkhDb 捕获后执行
//       `close cached handle -> deleteDatabase -> reopen(name, 9)`。
//   - `deleteDatabase` blocked / 失败必须冒泡，**不允许**"假装已经 rebuild"。
//   - 重建边界是整份 `keymaster.key.<publicKeyHex>.plugin.p2pkh.state`，
//     不与其它 plugin 共库；整库删除不会误伤别的业务。
//
// 硬切换 003：
//   - 旧全局 "p2pkh" DB 不再作为恢复路径，也不再接入任何启动路径。
//   - 旧 `migrateLegacyP2pkhDb()` 已删除：硬切换 002 之后资源归属不再依赖
//   - 老 key 即使残留旧全局 DB 也允许被放弃；恢复路径是
//     `rehydrate + recent-sync + history-backfill`，从 WOC 链上真值重建。
//   - 旧的"best-effort 一次性迁移"注释已经被本硬切换覆盖；新代码若需要把
//     历史 v3 数据搬过来，也必须通过 active key 自己的 namespace DB
//     升级路径，而不是再造一条与 active key 模型平行的迁移链。

import type { BsvNetwork } from "@keymaster/contracts";
import type {
  P2pkhBackfillState,
  P2pkhHistoryItem,
  P2pkhKeyResource,
  P2pkhLocalInputClaim,
  P2pkhLocalSubmission,
  P2pkhProtocolSubmission,
  P2pkhRecentSyncState,
  P2pkhUtxo,
} from "./p2pkhContracts.js";
import type { P2pkhBackfillCommit, P2pkhRecentCommit } from "./p2pkhContracts.js";
import { makeResourceId } from "./p2pkhContracts.js";

const P2PKH_STORAGE_ID = "state";
/**
 * 硬切换 002 收尾：P2PKH namespace DB schema 版本升级到 8。
 * 重建边界是整份 `keymaster.key.<publicKeyHex>.plugin.p2pkh.state`。
 *
 * 导出以供 service 层日志 / 验收脚本使用——所有需要报告
 * "P2PKH 当前目标版本"的位置都应从这里取真值，不要再硬编码数字。
 */
export const P2PKH_DB_VERSION = 9;

interface P2pkhDbBundle {
  /** 关闭当前 namespace db handle。 */
  close(): void;
  /** 用于 store 操作的 IDBDatabase。 */
  getDb(): IDBDatabase;
  /** 关联的 publicKeyHex。 */
  publicKeyHex: string;
}

export type { P2pkhDbBundle };

export interface P2pkhInputOutpoint {
  txid: string;
  vout: number;
}

interface OpenHandle {
  publicKeyHex: string;
  close(): void;
  getDb(): IDBDatabase;
}

/**
 * 硬切换 002 收尾 + 多 owner 支持：module-level handle 缓存改为
 * `Map<publicKeyHex, OpenHandle>`。旧实现是单变量，调用方 A 打开
 * ownerA 的 DB 后、B 打开 ownerB 的 DB 会把 A 的 handle 静默关掉
 * —— 任何「同时对两个 owner 持有 IDBDatabase」的路径都会拿到
 * 悬空句柄。Map 化后两个 owner 的 DB 各自持有自己的句柄，独立
 * 关闭。
 */
const openHandles: Map<string, OpenHandle> = new Map();

/**
 * 硬切换 002 收尾 + 硬切换 005：openP2pkhDb 内部通过 `keyspace.openKeyStorage({ version, upgrade })`
 * 自动修复当前 key 的 namespace DB。upgrade 回调能拿到 oldVersion：
 *   - oldVersion === 0：DB 第一次被创建；
 *   - 0 < oldVersion < 9：旧版本被升级（**不迁移旧数据，删光 p2pkh stores 重建 v9**）；
 *   - oldVersion === 9：普通打开，不动 schema。
 *   - oldVersion > 9：不会进入 upgrade；浏览器层抛 VersionError，
 *     本函数在下方 try/catch 命中后走 `close -> deleteDatabase -> reopen`。
 * 配合传入的 logger 即可在日志上区分这几种情况。
 */
type OpenKind = "created" | "upgraded" | "opened";

interface UpgradeAudit {
  kind: OpenKind;
  oldVersion: number;
  newVersion: number;
  /** 已存在的 stores；只记录关键 store 是否齐全。 */
  storeSnapshot: Record<string, boolean>;
}

function auditV8Stores(db: IDBDatabase): Record<string, boolean> {
  const required = [
    "p2pkh_addresses",
    "p2pkh_utxos",
    "p2pkh_history",
    "p2pkh_history_backfill",
    "p2pkh_recent_sync",
    "p2pkh_local_submissions",
    "p2pkh_local_input_claims"
  ];
  const result: Record<string, boolean> = {};
  for (const name of required) {
    result[name] = db.objectStoreNames.contains(name);
  }
  return result;
}

/**
 * 打开 owner publicKeyHex 的 P2PKH namespace db（按 owner 缓存）。
 *
 * 设计缘由：硬切换 002 收尾 + 多 owner 支持——每个 owner 各自一个
 * 物理 IDB 数据库；module 内部 `openHandles: Map<publicKeyHex, OpenHandle>`
 * 让多 owner 的 handle **并存**，打开新 owner **不会** 关闭其它
 * owner 的 handle。调用方按 owner 取 handle：
 *   - transfer 走 session owner（protocol 强制 `session.owner === active`）。
 *   - recent-sync / backfill 走 active key。
 *   - 同 owner 二次 open 走 cache hit（`db.reused`），不重开 IDB。
 *
 * 硬切换 002 收尾：版本不匹配即整库 rebuild——收口在 `openP2pkhDb()` 一处。
 *   - `oldVersion < 9`：onupgradeneeded 事务内删光旧 p2pkh_* stores，重建 v9。
 *   - `oldVersion > 9`：keyspace 内部 `indexedDB.open(name, 9)` 抛 VersionError，
 *     本函数捕获后只关掉「本 owner 的」cached handle（避免 deleteDatabase
 *     被自己的连接阻塞），再 `deleteDatabase -> reopen`。
 *   - `oldVersion === 9`：普通打开。
 *   - `deleteDatabase` 被 blocked / 失败必须冒泡，**不允许**假装 rebuild 成功。
 *
 * 硬切换 003：调用方可通过 `logger` 让本函数在 upgrade 阶段补全"新建 /
 * 升级 / 普通打开"日志；不传时不记日志。
 */
export async function openP2pkhDb(input: {
  keyspace: import("@keymaster/contracts").KeyspaceService;
  publicKeyHex: string;
  logger?: import("@keymaster/contracts").PluginLogger;
}): Promise<P2pkhDbBundle> {
  // 命中缓存：同一 owner 的 DB 已开过，直接复用。
  const cached = openHandles.get(input.publicKeyHex);
  if (cached) {
    // 硬切换 003 收尾：缓存命中也必须留痕（p2pkh service 层不再
    // 持有 service-level cache，per-owner map 命中由 module 内部
    // 记日志）；调用方后续不会看到 db.opening 事件。
    input.logger?.info({
      scope: "p2pkh.db",
      event: "db.reused",
      message: "P2PKH reusing cached namespace db handle",
      data: { publicKeyHex: input.publicKeyHex, targetVersion: P2PKH_DB_VERSION }
    });
    return cached as P2pkhDbBundle;
  }
  // 硬切换 002 收尾：把「意图开 / 开成功 / 失败」三类日志都搬
  // 到 module 层——service 层只看 p2pkhDb 的 map，cache hit 时
  // service 不再误报 db.opening / db.opened。
  input.logger?.info({
    scope: "p2pkh.db",
    event: "db.opening",
    message: "P2PKH opening namespace db for owner",
    data: { publicKeyHex: input.publicKeyHex, targetVersion: P2PKH_DB_VERSION }
  });
  // 硬切换 002 收尾：多 owner 并存缓存下，主路径**不**主动关闭任
  // 何 cached handle——其它 owner 的 IDBDatabase 必须保持存活。VersionError
  // 重建路径会单独 `closeCachedHandle(input.publicKeyHex)`，只关
  // 「本 owner 的」handle 避免 deleteDatabase 被自己阻塞。
  let audit: UpgradeAudit | undefined;
  let handle: import("@keymaster/contracts").KeyScopedStorageHandle;
  try {
    handle = await input.keyspace.openKeyStorage({
      publicKeyHex: input.publicKeyHex,
      pluginId: "p2pkh",
      storageId: P2PKH_STORAGE_ID,
      version: P2PKH_DB_VERSION,
      upgrade: (db, oldVersion, newVersion) => {
        // 硬切换 002 收尾：oldVersion < 9 进入 upgrade 是"删光旧 stores 重建 v9"，
        // **不是**数据迁移。oldVersion === 0（首次创建）和
        // 0 < oldVersion < 9（旧版本）都统一落到 createV8Stores——
        // 区别仅在日志分类 kind 上。
        // newVersion 在 contract 里允许 null（DB 被删除的特殊场景）；本路径
        // 下若为 null 也按 created 处理——这只是日志分类，不需要阻断。
        const resolvedNewVersion = newVersion ?? P2PKH_DB_VERSION;
        const kind: OpenKind = oldVersion === 0 ? "created" : "upgraded";
        createV8Stores(db);
        audit = {
          kind,
          oldVersion,
          newVersion: resolvedNewVersion,
          storeSnapshot: auditV8Stores(db)
        };
        input.logger?.info({
          scope: "p2pkh.db",
          event: "schema.upgradeApplied",
          message: `P2PKH schema ${kind}`,
          data: {
            kind,
            oldVersion,
            newVersion: resolvedNewVersion,
            targetVersion: resolvedNewVersion,
            storeSnapshot: audit.storeSnapshot
          }
        });
      }
    });
  } catch (err) {
    // 硬切换 005：oldVersion > 9 走"close -> deleteDatabase -> reopen"重建。
    // 非 VersionError 直接冒泡，**不**在 p2pkh 层吞错。
    if (!isVersionError(err)) throw err;
    // 防御性：关掉本 owner 的 cached handle（若上次半路残留），
    // 避免 deleteDatabase 被自己的连接阻塞。其它 owner 的 handle
    // 不动。
    closeCachedHandle(input.publicKeyHex);
    const name = namespaceDbName(input.publicKeyHex);
    input.logger?.warn({
      scope: "p2pkh.db",
      event: "schema.versionMismatch",
      message: "P2PKH namespace db version higher than target; rebuilding",
      data: { publicKeyHex: input.publicKeyHex, targetVersion: P2PKH_DB_VERSION, name }
    });
    await deleteDatabaseOrThrow(name);
    handle = await input.keyspace.openKeyStorage({
      publicKeyHex: input.publicKeyHex,
      pluginId: "p2pkh",
      storageId: P2PKH_STORAGE_ID,
      version: P2PKH_DB_VERSION,
      upgrade: (db, oldVersion, newVersion) => {
        // 重建路径：上一轮 DB 已被 deleteDatabase，oldVersion === 0。
        const resolvedNewVersion = newVersion ?? P2PKH_DB_VERSION;
        createV8Stores(db);
        audit = {
          kind: "created",
          oldVersion,
          newVersion: resolvedNewVersion,
          storeSnapshot: auditV8Stores(db)
        };
        input.logger?.info({
          scope: "p2pkh.db",
          event: "schema.rebuilt",
          message: "P2PKH namespace db rebuilt after deleteDatabase",
          data: {
            oldVersion,
            newVersion: resolvedNewVersion,
            targetVersion: resolvedNewVersion,
            storeSnapshot: audit.storeSnapshot
          }
        });
      }
    });
  }
  // 浏览器层面 indexedDB.open 可能在 upgrade 之外直接成功（无版本变化
  // 复用旧 db），audit 不会被赋值。这种情况下我们记一条 opened 日志，
  // 覆盖"复用现有 schema / 未触发 upgrade"的语义。
  if (!audit) {
    audit = {
      kind: "opened",
      oldVersion: P2PKH_DB_VERSION,
      newVersion: P2PKH_DB_VERSION,
      storeSnapshot: auditV8Stores(handle.db)
    };
    input.logger?.info({
      scope: "p2pkh.db",
      event: "schema.opened",
      message: "P2PKH namespace db opened without schema upgrade",
      data: {
        kind: "opened",
        oldVersion: P2PKH_DB_VERSION,
        newVersion: P2PKH_DB_VERSION,
        targetVersion: P2PKH_DB_VERSION,
        storeSnapshot: audit.storeSnapshot
      }
    });
  }
  const next: OpenHandle = {
    publicKeyHex: input.publicKeyHex,
    close: () => {
      try {
        handle.close();
      } catch {
        // 静默
      }
      if (openHandles.get(input.publicKeyHex) === next) {
        openHandles.delete(input.publicKeyHex);
      }
    },
    getDb: () => handle.db
  };
  openHandles.set(input.publicKeyHex, next);
  // 硬切换 002 收尾：与 db.opening 配对的 db.opened 日志也在 module
  // 层发出，service 层不再有 service-level cache，也就不必再记。
  input.logger?.info({
    scope: "p2pkh.db",
    event: "db.opened",
    message: "P2PKH namespace db ready",
    data: { publicKeyHex: input.publicKeyHex, targetVersion: P2PKH_DB_VERSION }
  });
  return next as P2pkhDbBundle;
}

/**
 * 关闭并清空缓存的 db handle（仅用于测试与 dispose）。
 * 不传 publicKeyHex：关闭所有 owner 的 cached handle。
 * 传入 publicKeyHex：只关掉该 owner 的 handle（其它 owner 不动）。
 */
export function disposeP2pkhDb(publicKeyHex?: string): void {
  if (publicKeyHex === undefined) {
    closeCachedHandle();
    return;
  }
  closeCachedHandle(publicKeyHex);
}

/**
 * 内部：关掉 module-level cached handle（如果存在）。把这段逻辑抽到独立函数，
 * 避免在 openP2pkhDb 内被 TypeScript 跨 try-catch 的窄化分析吃成 `never`。
 * 不传 publicKeyHex：关掉所有 owner；传入：只关指定 owner。
 */
function closeCachedHandle(publicKeyHex?: string): void {
  if (publicKeyHex === undefined) {
    for (const handle of [...openHandles.values()]) {
      try {
        handle.close();
      } catch {
        // 静默
      }
    }
    openHandles.clear();
    return;
  }
  const current = openHandles.get(publicKeyHex);
  if (!current) return;
  try {
    current.close();
  } catch {
    // 静默
  }
  openHandles.delete(publicKeyHex);
}

/**
 * 硬切换 005：把 `oldVersion > 9` 时的浏览器抛错识别为 VersionError。
 * 浏览器原生是 `DOMException` 且 `name === "VersionError"`；
 * fake-indexeddb 同样以 DOMException 模拟。
 */
function isVersionError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  return name === "VersionError";
}

/**
 * 硬切换 005：当前 key 的 p2pkh namespace DB 名字。`plugin-p2pkh` 整库边界
 * 在这里——这把 key 的 p2pkh 数据物理上独立，不会和别的 plugin 共享。
 *
 * 导出是让单测可以直接断言这条命名约定：万一 keyspace 以后改了
 * `keymaster.key.<publicKeyHex>.plugin.<pluginId>.<storageId>` 这条
 * 规则，这里要跟着改并通过这条断言暴露。
 */
export function namespaceDbName(publicKeyHex: string): string {
  return `keymaster.key.${publicKeyHex}.plugin.p2pkh.state`;
}

/**
 * 硬切换 005：删整份 namespace DB。
 * - onsuccess：删除完成，库文件已被浏览器清掉。
 * - onerror：删除失败（例如权限 / 引擎异常），直接 fail-closed。
 * - onblocked：还有连接没关干净（同名 DB 仍被别处 open）。**绝不能**继续
 *   假装重建——本路径必须抛错让上层显式处理。
 */
function deleteDatabaseOrThrow(name: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error(`P2PKH deleteDatabase failed: ${name}`));
    req.onblocked = () => reject(new Error(`P2PKH deleteDatabase blocked: ${name}`));
  });
}

/**
 * v8 schema（硬切换 002 收尾）：
 *   - 进入 upgrade 事务即删光当前 DB 内**所有** `p2pkh_` 前缀的 store
 *     （包括任何历史遗留 / 未来被废弃但忘了在硬编码列表里登记的 store），
 *     然后按 v8 schema 完整重建；**不迁移**任何旧数据。
 *     但 canonical record（`P2pkhKeyResource` / `P2pkhUtxo` 等）
 */
const P2PKH_STORE_PREFIX = "p2pkh_";

function createV8Stores(db: IDBDatabase) {
  // v8：进入 onupgradeneeded 时**先**遍历 `db.objectStoreNames`，把所有
  // `p2pkh_` 前缀的 store 全部删掉，再**无条件**按 v8 schema 重建——这是
  // 硬切换 002 收尾的硬规则。
  //
  // 为什么不用硬编码的 store 名列表：硬编码列表是脆弱的——只要未来哪个
  // 开发者加了一个新 `p2pkh_xxx` store 又被回退/弃用，硬编码列表里
  // 没有这个 name 的话，upgrade 路径就会把它留在库里，硬切换语义就不完整。
  // 用前缀扫描把"p2pkh 自己创建的 store"作为删表范围，规则只有一条。
  // 唯一会漏掉的"非 p2pkh_ 命名的 store"——本插件永远不会创建这种 store，
  // 万一有就是别人越界写进来的，那不在本次硬切换语义内，不动它。
  // 索引 onupgradeneeded 期间对 `objectStoreNames` 的修改必须立刻可见；
  // 复制一份再删，避免边遍历边修改。
  const toDelete = [...db.objectStoreNames].filter((name) => name.startsWith(P2PKH_STORE_PREFIX));
  for (const name of toDelete) {
    db.deleteObjectStore(name);
  }
  if (!db.objectStoreNames.contains("p2pkh_addresses")) {
    const store = db.createObjectStore("p2pkh_addresses", { keyPath: "resourceId" });
    // publicKeyHex 是唯一 owner 维度；同 namespace 内不同 publicKeyHex 的
    // 旧记录在 v8 不存在——upgrade 时整库重建，DB 内不会跨 owner 串行。
    store.createIndex("publicKeyHex", "publicKeyHex", { unique: false });
    store.createIndex("network", "network", { unique: false });
    store.createIndex("address", "address", { unique: true });
  }
  if (!db.objectStoreNames.contains("p2pkh_utxos")) {
    const store = db.createObjectStore("p2pkh_utxos", { keyPath: "id" });
    store.createIndex("resourceId", "resourceId", { unique: false });
    store.createIndex("publicKeyHex", "publicKeyHex", { unique: false });
    store.createIndex("network", "network", { unique: false });
  }
  if (!db.objectStoreNames.contains("p2pkh_history")) {
    const store = db.createObjectStore("p2pkh_history", { keyPath: "id" });
    store.createIndex("resourceId", "resourceId", { unique: false });
    store.createIndex("publicKeyHex", "publicKeyHex", { unique: false });
    store.createIndex("network", "network", { unique: false });
  }
  if (!db.objectStoreNames.contains("p2pkh_history_backfill")) {
    db.createObjectStore("p2pkh_history_backfill", { keyPath: "resourceId" });
  }
  if (!db.objectStoreNames.contains("p2pkh_recent_sync")) {
    db.createObjectStore("p2pkh_recent_sync", { keyPath: "resourceId" });
  }
  if (!db.objectStoreNames.contains("p2pkh_local_submissions")) {
    const s = db.createObjectStore("p2pkh_local_submissions", { keyPath: "id" });
    s.createIndex("resourceId", "resourceId", { unique: false });
    s.createIndex("status", "status", { unique: false });
    s.createIndex("canonicalTxid", "canonicalTxid", { unique: false });
    s.createIndex("txidIntegrity", "txidIntegrity", { unique: false });
  }
  if (!db.objectStoreNames.contains("p2pkh_local_input_claims")) {
    const s = db.createObjectStore("p2pkh_local_input_claims", { keyPath: "id" });
    s.createIndex("resourceId", "resourceId", { unique: false });
    s.createIndex("submissionId", "submissionId", { unique: false });
    s.createIndex("state", "state", { unique: false });
    s.createIndex("canonicalTxid", "canonicalTxid", { unique: false });
  }
  if (!db.objectStoreNames.contains("p2pkh_protocol_submissions")) {
    const s = db.createObjectStore("p2pkh_protocol_submissions", { keyPath: "id" });
    s.createIndex("resourceId", "resourceId", { unique: false });
    s.createIndex("submissionId", "submissionId", { unique: false });
    s.createIndex("status", "status", { unique: false });
    s.createIndex("canonicalTxid", "canonicalTxid", { unique: false });
  }
}

function reqAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(
  handle: P2pkhDbBundle,
  store: string | string[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => Promise<T> | T
): Promise<T> {
  const db = handle.getDb();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode);
    let result: T;
    let settled = false;
    t.oncomplete = () => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    t.onerror = () => {
      if (!settled) {
        settled = true;
        reject(t.error);
      }
    };
    t.onabort = () => {
      if (!settled) {
        settled = true;
        reject(t.error);
      }
    };
    Promise.resolve(fn(t)).then(
      (r) => {
        result = r;
      },
      (e) => {
        if (!settled) {
          settled = true;
          try {
            t.abort();
          } catch {
            // 已被 abort。
          }
          reject(e);
        }
      }
    );
  });
}

/**
 * 硬切换 001：`P2pkhBalanceRow` 已删除。余额不再落库，由 service 每次
 * 基于当前 UTXO 快照现算。如果以后出现外部代码仍 import 此类型，
 * 会立即在编译期暴露（unknown 字段不能赋值）。
 */
void (0 as unknown as BsvNetwork);

function newHistoryId(resourceId: string, txid: string): string {
  return `${resourceId}:${txid}`;
}
function newLocalInputClaimId(resourceId: string, txid: string, vout: number): string {
  return `${resourceId}:${txid}:${vout}`;
}

/** 工厂：构造一个绑定到指定 handle 的 p2pkh db 操作集合。 */
export function createP2pkhDb(handle: P2pkhDbBundle) {
  return {
    /** 测试 / 资源管理：返回底层 IDBDatabase 引用，用于 deleteDatabase 前主动 close。 */
    getDb(): IDBDatabase {
      return handle.getDb();
    },
    /** 关闭当前 namespace db handle。 */
    close(): void {
      handle.close();
    },
    // ---------- address ----------
    async putAddress(r: P2pkhKeyResource): Promise<void> {
      await tx(handle, "p2pkh_addresses", "readwrite", (t) =>
        reqAsPromise(t.objectStore("p2pkh_addresses").put(r))
      );
    },
    async removeResource(resourceId: string): Promise<void> {
      await tx(handle, "p2pkh_addresses", "readwrite", (t) =>
        reqAsPromise(t.objectStore("p2pkh_addresses").delete(resourceId))
      );
    },
    async listAddresses(): Promise<P2pkhKeyResource[]> {
      return tx(handle, "p2pkh_addresses", "readonly", (t) =>
        reqAsPromise(t.objectStore("p2pkh_addresses").getAll())
      );
    },
    async getResource(resourceId: string): Promise<P2pkhKeyResource | undefined> {
      return tx(handle, "p2pkh_addresses", "readonly", (t) =>
        reqAsPromise(t.objectStore("p2pkh_addresses").get(resourceId))
      );
    },
    /** 当前 namespace 内所有 resource（key scoped DB 已按 owner hex 隔离）。 */
    async listResourcesByKey(): Promise<P2pkhKeyResource[]> {
      return tx(handle, "p2pkh_addresses", "readonly", (t) =>
        reqAsPromise(t.objectStore("p2pkh_addresses").getAll())
      );
    },

    // ---------- utxos ----------
    async putUtxos(rows: P2pkhUtxo[]): Promise<void> {
      if (rows.length === 0) return;
      await tx(handle, "p2pkh_utxos", "readwrite", (t) => {
        const store = t.objectStore("p2pkh_utxos");
        return Promise.all(rows.map((r) => reqAsPromise(store.put(r))));
      });
    },
    async clearUtxosForResource(resourceId: string): Promise<void> {
      await tx(handle, "p2pkh_utxos", "readwrite", async (t) => {
        const idx = t.objectStore("p2pkh_utxos").index("resourceId");
        const keys: IDBValidKey[] = await reqAsPromise(idx.getAllKeys(resourceId));
        const store = t.objectStore("p2pkh_utxos");
        return Promise.all(keys.map((k) => reqAsPromise(store.delete(k))));
      });
    },
    async replaceUtxosForResource(resourceId: string, rows: P2pkhUtxo[]): Promise<void> {
      await tx(handle, "p2pkh_utxos", "readwrite", async (t) => {
        const store = t.objectStore("p2pkh_utxos");
        const idx = store.index("resourceId");
        const keys: IDBValidKey[] = await reqAsPromise(idx.getAllKeys(resourceId));
        await Promise.all(keys.map((k) => reqAsPromise(store.delete(k))));
        await Promise.all(rows.map((r) => reqAsPromise(store.put(r))));
      });
    },
    async listUtxos(): Promise<P2pkhUtxo[]> {
      return tx(handle, "p2pkh_utxos", "readonly", (t) =>
        reqAsPromise(t.objectStore("p2pkh_utxos").getAll())
      );
    },

    // ---------- history ----------
    async putHistory(rows: P2pkhHistoryItem[]): Promise<void> {
      if (rows.length === 0) return;
      await tx(handle, "p2pkh_history", "readwrite", (t) => {
        const store = t.objectStore("p2pkh_history");
        return Promise.all(rows.map((r) => reqAsPromise(store.put(r))));
      });
    },
    async listHistory(): Promise<P2pkhHistoryItem[]> {
      return tx(handle, "p2pkh_history", "readonly", (t) =>
        reqAsPromise(t.objectStore("p2pkh_history").getAll())
      );
    },
    async clearHistoryForResource(resourceId: string): Promise<void> {
      await tx(handle, "p2pkh_history", "readwrite", async (t) => {
        const idx = t.objectStore("p2pkh_history").index("resourceId");
        const keys: IDBValidKey[] = await reqAsPromise(idx.getAllKeys(resourceId));
        const store = t.objectStore("p2pkh_history");
        return Promise.all(keys.map((k) => reqAsPromise(store.delete(k))));
      });
    },
    async getHistoryByTxid(resourceId: string, txid: string): Promise<P2pkhHistoryItem | undefined> {
      return tx(handle, "p2pkh_history", "readonly", (t) =>
        reqAsPromise(t.objectStore("p2pkh_history").get(newHistoryId(resourceId, txid)))
      );
    },

    // ---------- backfill ----------
    async getBackfillState(resourceId: string): Promise<P2pkhBackfillState | undefined> {
      return tx(handle, "p2pkh_history_backfill", "readonly", (t) =>
        reqAsPromise(t.objectStore("p2pkh_history_backfill").get(resourceId))
      );
    },
    async putBackfillState(state: P2pkhBackfillState): Promise<void> {
      await tx(handle, "p2pkh_history_backfill", "readwrite", (t) =>
        reqAsPromise(t.objectStore("p2pkh_history_backfill").put(state))
      );
    },
    async listBackfillStates(): Promise<P2pkhBackfillState[]> {
      return tx(handle, "p2pkh_history_backfill", "readonly", (t) =>
        reqAsPromise(t.objectStore("p2pkh_history_backfill").getAll())
      );
    },
    async clearBackfillState(resourceId: string): Promise<void> {
      await tx(handle, "p2pkh_history_backfill", "readwrite", (t) =>
        reqAsPromise(t.objectStore("p2pkh_history_backfill").delete(resourceId))
      );
    },

    // ---------- recent sync ----------
    async getRecentSyncState(resourceId: string): Promise<P2pkhRecentSyncState | undefined> {
      return tx(handle, "p2pkh_recent_sync", "readonly", (t) =>
        reqAsPromise(t.objectStore("p2pkh_recent_sync").get(resourceId))
      );
    },
    async putRecentSyncState(state: P2pkhRecentSyncState): Promise<void> {
      await tx(handle, "p2pkh_recent_sync", "readwrite", (t) =>
        reqAsPromise(t.objectStore("p2pkh_recent_sync").put(state))
      );
    },
    async listRecentSyncStates(): Promise<P2pkhRecentSyncState[]> {
      return tx(handle, "p2pkh_recent_sync", "readonly", (t) =>
        reqAsPromise(t.objectStore("p2pkh_recent_sync").getAll())
      );
    },

    // ---------- local submissions ----------
    async putLocalSubmission(t: P2pkhLocalSubmission): Promise<void> {
      await tx(handle, "p2pkh_local_submissions", "readwrite", (store) =>
        reqAsPromise(store.objectStore("p2pkh_local_submissions").put(t))
      );
    },
    async listLocalSubmissions(): Promise<P2pkhLocalSubmission[]> {
      return tx(handle, "p2pkh_local_submissions", "readonly", (store) =>
        reqAsPromise(store.objectStore("p2pkh_local_submissions").getAll())
      );
    },
    async listLocalSubmissionsByResource(resourceId: string): Promise<P2pkhLocalSubmission[]> {
      return tx(handle, "p2pkh_local_submissions", "readonly", (store) =>
        reqAsPromise(store.objectStore("p2pkh_local_submissions").index("resourceId").getAll(resourceId))
      );
    },
    async removeLocalSubmission(id: string): Promise<void> {
      await tx(handle, "p2pkh_local_submissions", "readwrite", (store) =>
        reqAsPromise(store.objectStore("p2pkh_local_submissions").delete(id))
      );
    },

    // ---------- local input claims ----------
    async putLocalInputClaim(r: P2pkhLocalInputClaim): Promise<void> {
      await tx(handle, "p2pkh_local_input_claims", "readwrite", (store) =>
        reqAsPromise(store.objectStore("p2pkh_local_input_claims").put(r))
      );
    },
    async listLocalInputClaims(): Promise<P2pkhLocalInputClaim[]> {
      return tx(handle, "p2pkh_local_input_claims", "readonly", (store) =>
        reqAsPromise(store.objectStore("p2pkh_local_input_claims").getAll())
      );
    },
    async listLocalInputClaimsByResource(resourceId: string): Promise<P2pkhLocalInputClaim[]> {
      return tx(handle, "p2pkh_local_input_claims", "readonly", (store) =>
        reqAsPromise(store.objectStore("p2pkh_local_input_claims").index("resourceId").getAll(resourceId))
      );
    },
    async removeLocalInputClaim(id: string): Promise<void> {
      await tx(handle, "p2pkh_local_input_claims", "readwrite", (store) =>
        reqAsPromise(store.objectStore("p2pkh_local_input_claims").delete(id))
      );
    },
    // ---------- protocol submissions ----------
    async putProtocolSubmission(record: P2pkhProtocolSubmission): Promise<void> {
      await tx(handle, "p2pkh_protocol_submissions", "readwrite", (store) =>
        reqAsPromise(store.objectStore("p2pkh_protocol_submissions").put(record))
      );
    },
    async getProtocolSubmission(id: string): Promise<P2pkhProtocolSubmission | undefined> {
      return tx(handle, "p2pkh_protocol_submissions", "readonly", (store) =>
        reqAsPromise(store.objectStore("p2pkh_protocol_submissions").get(id))
      );
    },
    async listProtocolSubmissions(): Promise<P2pkhProtocolSubmission[]> {
      return tx(handle, "p2pkh_protocol_submissions", "readonly", (store) =>
        reqAsPromise(store.objectStore("p2pkh_protocol_submissions").getAll())
      );
    },
    async listProtocolSubmissionsByResource(resourceId: string): Promise<P2pkhProtocolSubmission[]> {
      return tx(handle, "p2pkh_protocol_submissions", "readonly", (store) =>
        reqAsPromise(store.objectStore("p2pkh_protocol_submissions").index("resourceId").getAll(resourceId))
      );
    },
    async removeProtocolSubmission(id: string): Promise<void> {
      await tx(handle, "p2pkh_protocol_submissions", "readwrite", (store) =>
        reqAsPromise(store.objectStore("p2pkh_protocol_submissions").delete(id))
      );
    },
    /**
     * 硬切换 002 收尾：原子地写「submission + 所有 input claim」——
     * 单一 readwrite 事务，冲突时整笔 abort，submission 行和 claim
     * 行都不落库。这是 transfer 并发防重的事务层保险：两个并发
     * `submit(preview)` 在 `put` 同一对 `(resourceId, txid, vout)`
     * claim 时，第二个会撞到第一个的 `state: claimed` 行，整个事务
     * 中止并抛出「input already claimed」——调用方（transfer.submit）
     * 看到 throw 就不会调 woc.broadcast。
     *
     * 关键不变量：
     *   - 任何 input 被另一笔 submission `claimed` → 整事务 abort
     *     并抛错（fail-closed）。
     *   - 同一 submission 的重复调用（idempotent replay）→ 已存在的
     *     claim 视为可覆盖（state=claimed 且 submissionId 相同），不
     *     视为冲突。
     *   - `state=released` / `observed-consumed` 的 claim 视为已释放
     *     / 已对账完成，新 submission 可重新占（覆盖语义）。
     *   - submission 行在所有 claim 写完之后再写；任何一个 claim 失败
     *     都会让 submission 也不落地。
     */
    async tryClaimSubmissionWithInputs(input: {
      submission: P2pkhLocalSubmission;
      inputs: P2pkhUtxo[];
      expectedCanonicalTxid?: string;
      observation?: "unconfirmed" | "confirmed";
    }): Promise<{ claimIds: string[] }> {
      return tx(
        handle,
        ["p2pkh_local_submissions", "p2pkh_local_input_claims"],
        "readwrite",
        async (t) => {
          const subStore = t.objectStore("p2pkh_local_submissions");
          const claimStore = t.objectStore("p2pkh_local_input_claims");
          const now = new Date().toISOString();
          const claimIds: string[] = [];
          for (const u of input.inputs) {
            const id = localInputClaimIdFor(input.submission.resourceId, u.txid, u.vout);
            const existing = await reqAsPromise<P2pkhLocalInputClaim | undefined>(claimStore.get(id));
            if (existing && existing.state === "claimed" && existing.submissionId !== input.submission.id) {
              // 冲突：被另一笔 submission 占用。fn 抛错 → tx helper
              // 调 t.abort() → 整事务回滚；submission / claims 都不写。
              throw new Error(
                `P2PKH input already claimed by another submission: ${u.txid}:${u.vout} (submissionId=${existing.submissionId})`
              );
            }
            const claim: P2pkhLocalInputClaim = {
              id,
              submissionId: input.submission.id,
              resourceId: input.submission.resourceId,
              publicKeyHex: input.submission.publicKeyHex,
              network: input.submission.network,
              txid: u.txid,
              vout: u.vout,
              canonicalTxid: input.expectedCanonicalTxid ?? input.submission.canonicalTxid,
              observation: input.observation,
              state: "claimed",
              createdAt: now,
              updatedAt: now
            };
            await reqAsPromise(claimStore.put(claim));
            claimIds.push(id);
          }
          // 所有 claim 写完后再写 submission：任一 claim 失败
          // → 上面 throw → 整事务 abort → submission 也不落地。
          await reqAsPromise(subStore.put(input.submission));
          return { claimIds };
        }
      );
    },
    /**
     * 协议 spend / 其它内部预览阶段专用：原子地写入一组 local input claim，
     * 不落 local submission。与 transfer 的 claim 语义一致：同一
     * (resourceId, txid, vout) 在同一时间只能被一个 submissionId 占用。
     */
    async tryClaimInputs(input: {
      submissionId: string;
      resourceId: string;
      publicKeyHex: string;
      network: BsvNetwork;
      inputs: P2pkhInputOutpoint[];
      expectedCanonicalTxid?: string;
      observation?: "unconfirmed" | "confirmed";
    }): Promise<{ claimIds: string[] }> {
      return tx(handle, "p2pkh_local_input_claims", "readwrite", async (t) => {
        const claimStore = t.objectStore("p2pkh_local_input_claims");
        const now = new Date().toISOString();
        const claimIds: string[] = [];
        for (const u of input.inputs) {
          const id = localInputClaimIdFor(input.resourceId, u.txid, u.vout);
          const existing = await reqAsPromise<P2pkhLocalInputClaim | undefined>(claimStore.get(id));
          if (existing && existing.state === "claimed" && existing.submissionId !== input.submissionId) {
            throw new Error(
              `P2PKH input already claimed by another submission: ${u.txid}:${u.vout} (submissionId=${existing.submissionId})`
            );
          }
          const claim: P2pkhLocalInputClaim = {
            id,
            submissionId: input.submissionId,
            resourceId: input.resourceId,
            publicKeyHex: input.publicKeyHex,
            network: input.network,
            txid: u.txid,
            vout: u.vout,
            canonicalTxid: input.expectedCanonicalTxid,
            observation: input.observation,
            state: "claimed",
            createdAt: now,
            updatedAt: now
          };
          await reqAsPromise(claimStore.put(claim));
          claimIds.push(id);
        }
        return { claimIds };
      });
    },
    /**
     * 释放一组 claim 行。transfer 在 `definitive rejection` 路径上
     * 调用：广播被节点明确拒绝（duplicate / invalid 等），value 没
     * 在链上花掉，claim 必须释放，避免后续分配一直排除这些
     * 「本可重试」的 outpoint。审计信息保留在 `failed` submission
     * 行里。
     *
     * 单事务整批 delete；中途出错会冒泡，调用方按 fail-closed 处理
     * （这种失败极少发生，DB 层 delete 不通通常意味着存储已坏，
     * 后续 unrecoverable）。
     */
    async releaseLocalInputClaims(claimIds: string[]): Promise<void> {
      if (claimIds.length === 0) return;
      await tx(handle, "p2pkh_local_input_claims", "readwrite", async (t) => {
        const store = t.objectStore("p2pkh_local_input_claims");
        await Promise.all(claimIds.map((id) => reqAsPromise(store.delete(id))));
      });
    },

    // ---------- 原子提交 ----------
    async commitBackfillPage(commit: P2pkhBackfillCommit): Promise<void> {
      await tx(
        handle,
        ["p2pkh_addresses", "p2pkh_history", "p2pkh_history_backfill"],
        "readwrite",
        async (t) => {
          const addressStore = t.objectStore("p2pkh_addresses");
          const histStore = t.objectStore("p2pkh_history");
          const backfillStore = t.objectStore("p2pkh_history_backfill");
          const currentAddress = await reqAsPromise<P2pkhKeyResource | undefined>(addressStore.get(commit.resourceId));
          if (!currentAddress) {
            throw new Error("resource deleted");
          }
          if (currentAddress.generation !== commit.expectedGeneration) {
            throw new Error("generation mismatch");
          }
          const existing = await reqAsPromise<P2pkhBackfillState | undefined>(
            backfillStore.get(commit.resourceId)
          );
          const currentRevision = existing?.revision ?? 0;
          if (currentRevision !== commit.expectedRevision) {
            throw new Error("revision mismatch");
          }
          const now = new Date().toISOString();
          for (const item of commit.page) {
            const id = newHistoryId(commit.resourceId, item.txid);
            const prev = (await reqAsPromise<P2pkhHistoryItem | undefined>(histStore.get(id))) ?? null;
            const merged: P2pkhHistoryItem = {
              id,
              resourceId: commit.resourceId,
              publicKeyHex: currentAddress.publicKeyHex,
              network: currentAddress.network,
              address: currentAddress.address,
              txid: item.txid,
              height: item.height,
              status: "confirmed",
              source: "woc-confirmed",
              syncedAt: prev?.syncedAt ?? now
            };
            if (prev) {
              if (prev.status === "confirmed" || prev.status === "unconfirmed" || prev.status === "pending") {
                merged.status = "confirmed";
              }
              if (prev.syncedAt) merged.syncedAt = prev.syncedAt;
              if (prev.source && prev.source !== "woc-confirmed") merged.source = prev.source;
              if (prev.publicKeyHex) merged.publicKeyHex = prev.publicKeyHex;
              if (prev.network) merged.network = prev.network;
              if (prev.address) merged.address = prev.address;
            }
            await reqAsPromise(histStore.put(merged));
          }
          const next: P2pkhBackfillState = {
            resourceId: commit.resourceId,
            status: commit.nextPageToken ? "running" : "complete",
            nextPageToken: commit.nextPageToken,
            anchorTxids: existing?.anchorTxids ?? [],
            pagesSynced: (existing?.pagesSynced ?? 0) + 1,
            recordsSynced: (existing?.recordsSynced ?? 0) + commit.page.length,
            revision: currentRevision + 1,
            lastError: undefined,
            updatedAt: now
          };
          await reqAsPromise(backfillStore.put(next));
        }
      );
    },

    async commitRecentSnapshot(commit: P2pkhRecentCommit): Promise<void> {
      // 硬切换 001：事务范围不再包含 p2pkh_balances——余额不再落库。
      await tx(
        handle,
        [
          "p2pkh_addresses",
          "p2pkh_utxos",
          "p2pkh_history",
          "p2pkh_recent_sync",
          "p2pkh_local_input_claims",
          "p2pkh_local_submissions"
        ],
        "readwrite",
        async (t) => {
          const addressStore = t.objectStore("p2pkh_addresses");
          const now = new Date().toISOString();
          const currentAddress = await reqAsPromise<P2pkhKeyResource | undefined>(addressStore.get(commit.resourceId));
          if (!currentAddress) {
            throw new Error("resource deleted");
          }
          if (commit.expectedGeneration !== undefined && currentAddress.generation !== commit.expectedGeneration) {
            throw new Error("generation mismatch");
          }
          const effectiveResource = currentAddress;
          if (commit.utxos) {
            const utxoStore = t.objectStore("p2pkh_utxos");
            const idx = utxoStore.index("resourceId");
            const keys: IDBValidKey[] = await reqAsPromise(idx.getAllKeys(commit.resourceId));
            for (const k of keys) await reqAsPromise(utxoStore.delete(k));
            for (const u of commit.utxos) await reqAsPromise(utxoStore.put(u));
          }
          if (commit.recentHistory) {
            const histStore = t.objectStore("p2pkh_history");
            for (const h of commit.recentHistory) {
              const id = newHistoryId(commit.resourceId, h.txid);
              const prev = await reqAsPromise<P2pkhHistoryItem | undefined>(histStore.get(id));
              if (prev?.status === "confirmed" && h.status !== "confirmed") continue;
              // 硬切换 002 收尾：history 仅持有 publicKeyHex。
              const merged: P2pkhHistoryItem = {
                id,
                resourceId: commit.resourceId,
                publicKeyHex: effectiveResource.publicKeyHex,
                network: effectiveResource.network,
                address: effectiveResource.address,
                txid: h.txid,
                height: h.height,
                status: h.status,
                source: h.source,
                observation: h.observation ?? "confirmed",
                syncedAt: prev?.syncedAt && prev?.syncedAt > h.syncedAt ? prev.syncedAt : h.syncedAt
              };
              await reqAsPromise(histStore.put(merged));
            }
          }
          if (commit.unconfirmedHistory) {
            const histStore = t.objectStore("p2pkh_history");
            for (const h of commit.unconfirmedHistory) {
              const id = newHistoryId(commit.resourceId, h.txid);
              const prev = await reqAsPromise<P2pkhHistoryItem | undefined>(histStore.get(id));
              if (prev?.status === "confirmed") continue;
              await reqAsPromise(histStore.put({
                ...h,
                id,
                resourceId: commit.resourceId,
                publicKeyHex: effectiveResource.publicKeyHex,
                network: effectiveResource.network,
                address: effectiveResource.address,
                observation: h.observation ?? "unconfirmed"
              }));
            }
          }
          if (commit.recentConfirmedTxids) {
            const recentStore = t.objectStore("p2pkh_recent_sync");
            const existing = await reqAsPromise<P2pkhRecentSyncState | undefined>(recentStore.get(commit.resourceId));
            const next: P2pkhRecentSyncState = {
              resourceId: commit.resourceId,
              recentConfirmedTxids: commit.recentConfirmedTxids,
              lastCheckedAt: now,
              lastSuccessAt: now,
              lastError: existing?.lastError
            };
            await reqAsPromise(recentStore.put(next));
          }
          if (commit.localInputClaims) {
            const store = t.objectStore("p2pkh_local_input_claims");
            for (const r of commit.localInputClaims) {
              if (r.state === "released") {
                await reqAsPromise(store.delete(r.id));
                continue;
              }
              await reqAsPromise(store.put(r));
            }
          }
          if (commit.localSubmissions) {
            const store = t.objectStore("p2pkh_local_submissions");
            for (const p of commit.localSubmissions) await reqAsPromise(store.put(p));
          }
          if (commit.protocolSubmissions) {
            const store = t.objectStore("p2pkh_protocol_submissions");
            for (const p of commit.protocolSubmissions) await reqAsPromise(store.put(p));
          }
        }
      );
    },

    // ---------- 清理 ----------
    /** 清理当前 namespace 内所有数据。设计缘由：删除 key 时 namespace DB 整体删除，
     * 本方法用于手动重置或迁移失败回滚。硬切换 001：余额不再落库，
     * clearAll 不再调用 clearBalance。 */
    async clearAll(): Promise<void> {
      const resources = await this.listResourcesByKey();
      for (const r of resources) {
        await this.removeResource(r.resourceId);
        await this.clearUtxosForResource(r.resourceId);
        await this.clearHistoryForResource(r.resourceId);
        await this.clearBackfillState(r.resourceId);
        const submissions = await this.listLocalSubmissionsByResource(r.resourceId);
        for (const p of submissions) await this.removeLocalSubmission(p.id);
        const protocolSubmissions = await this.listProtocolSubmissionsByResource(r.resourceId);
        for (const p of protocolSubmissions) await this.removeProtocolSubmission(p.id);
        const claims = await this.listLocalInputClaimsByResource(r.resourceId);
        for (const rs of claims) await this.removeLocalInputClaim(rs.id);
      }
    }
  };
}

export type P2pkhDbHandle = ReturnType<typeof createP2pkhDb>;

export function resourceIdFor(network: BsvNetwork): string {
  return makeResourceId(network);
}

/** 工具：本地输入占用 id。 */
export function localInputClaimIdFor(resourceId: string, txid: string, vout: number): string {
  return newLocalInputClaimId(resourceId, txid, vout);
}
