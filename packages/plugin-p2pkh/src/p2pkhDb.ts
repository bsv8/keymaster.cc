// packages/plugin-p2pkh/src/p2pkhDb.ts
// P2PKH 资源库（硬切换 005 + 硬切换 007 + 硬切换 001 + 硬切换 003）。
// 设计缘由：
//   - 不再使用固定 DB_NAME = "p2pkh"；改为每个 active key 一个 namespace DB，
//     通过 keyspace.openKeyStorage 打开。
//   - DB name 形如 `keymaster.key.<publicKeyHex>.plugin.p2pkh.state`。
//   - store 中 keyId 字段保留为诊断字段，但删除 / 清理不再以 keyId index 为主路径。
//   - resourceId 改为不包含 Vault keyId：`p2pkh:<network>`。
//   - 原子提交：commitBackfillPage / commitRecentSnapshot 行为不变，但写入的 DB
//     是当前 key 的 namespace DB，不再有跨 key 数据混合风险。
//   - 切换 active key 时调用方需要重新拿 p2pkhDb(publicKeyHex) 才能继续访问。
//   - 硬切换 001：DB schema 升级，删除 `p2pkh_balances` store；
//     余额改为 service 每次基于当前 UTXO 快照现算，不再落库。
//
// 硬切换 005（2026-06-19）：P2PKH DB 版本硬切换 6 -> 7。
//   - 目标版本 = 7；不兼容旧 schema，**不做老数据迁移**。
//   - 打开语义收口为单一规则：版本不匹配即整库 rebuild。
//     - `oldVersion < 7`：进入 onupgradeneeded 事务，删光当前 DB 内所有
//       p2pkh_* stores，按 v7 完整重建。
//     - `oldVersion === 7`：直接使用，不做额外 schema 扫描。
//     - `oldVersion > 7`：keyspace.openKeyStorage 会抛 VersionError，
//       p2pkh 在 openP2pkhDb 捕获后执行
//       `close cached handle -> deleteDatabase -> reopen(name, 7)`。
//   - `deleteDatabase` blocked / 失败必须冒泡，**不允许**"假装已经 rebuild"。
//   - 重建边界是整份 `keymaster.key.<publicKeyHex>.plugin.p2pkh.state`，
//     不与其它 plugin 共库；整库删除不会误伤别的业务。
//
// 硬切换 003：
//   - 旧全局 "p2pkh" DB 不再作为恢复路径，也不再接入任何启动路径。
//   - `migrateLegacyP2pkhDb()` 保留代码用于历史诊断，但不在 unlock、rehydrate、
//     手工同步、key.deleted 等路径里调用。
//   - 老 key 即使残留旧全局 DB 也允许被放弃；恢复路径是
//     `rehydrate + recent-sync + history-backfill`，从 WOC 链上真值重建。
//   - 旧的"best-effort 一次性迁移"注释已经被本硬切换覆盖；新代码若需要把
//     历史 v3 数据搬过来，也必须通过 active key 自己的 namespace DB
//     升级路径，而不是再造一条与 active key 模型平行的迁移链。

import type { BsvNetwork, KeyspaceService, PluginLogger } from "@keymaster/contracts";
import type {
  P2pkhBackfillState,
  P2pkhHistoryItem,
  P2pkhKeyResource,
  P2pkhLocalInputClaim,
  P2pkhLocalSubmission,
  P2pkhRecentSyncState,
  P2pkhUtxo,
} from "./p2pkhContracts.js";
import type { P2pkhBackfillCommit, P2pkhRecentCommit } from "./p2pkhContracts.js";
import { makeResourceId } from "./p2pkhContracts.js";

const P2PKH_STORAGE_ID = "state";
/**
 * 硬切换 005：P2PKH namespace DB schema 版本升级到 7。
 * 本次是硬切换——不兼容 v6 schema，**不做老数据迁移**。
 * 重建边界是整份 `keymaster.key.<publicKeyHex>.plugin.p2pkh.state`：
 *   - `oldVersion < 7`：onupgradeneeded 事务内删光旧 p2pkh_* stores，
 *     按 v7 完整重建。
 *   - `oldVersion > 7`：VersionError -> close cached handle ->
 *     deleteDatabase -> reopen(name, 7)。
 *
 * 导出以供 service 层日志 / 验收脚本使用——所有需要报告
 * "P2PKH 当前目标版本"的位置都应从这里取真值，不要再硬编码数字。
 */
export const P2PKH_DB_VERSION = 7;

/**
 * 旧全局 DB（v3）。保留常量以便调试 / 单元测试 / 一次性诊断脚本；
 * 硬切换 003 起不再有调用方接入这条路径。
 *
 * 设计缘由：当前系统对老 key 不再做一次性迁移，链上真值（rehydrate +
 * recent-sync + history-backfill）就是唯一恢复路径。即使本地残留
 * `p2pkh` v3 DB，也允许它留在原地被忽略，不影响当前 namespace 升级。
 */
const LEGACY_DB_NAME = "p2pkh";
const LEGACY_DB_VERSION = 3;

interface P2pkhDbBundle {
  /** 关闭当前 namespace db handle。 */
  close(): void;
  /** 用于 store 操作的 IDBDatabase。 */
  getDb(): IDBDatabase;
  /** 关联的 publicKeyHex。 */
  publicKeyHex: string;
}

export type { P2pkhDbBundle };

interface OpenHandle {
  publicKeyHex: string;
  close(): void;
  getDb(): IDBDatabase;
}

let openHandle: OpenHandle | undefined;

/**
 * 硬切换 003 + 硬切换 005：openP2pkhDb 内部通过 `keyspace.openKeyStorage({ version, upgrade })`
 * 自动修复当前 key 的 namespace DB。upgrade 回调能拿到 oldVersion：
 *   - oldVersion === 0：DB 第一次被创建；
 *   - 0 < oldVersion < newVersion：旧版本被升级（**不迁移旧数据，删光 p2pkh stores 重建**）；
 *   - oldVersion === newVersion：普通打开，不动 schema。
 *   - oldVersion > newVersion：不会进入 upgrade；浏览器层抛 VersionError，
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

function auditV7Stores(db: IDBDatabase): Record<string, boolean> {
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
 * 打开当前 active key 的 P2PKH namespace db。
 * 设计缘由：plugin 内部通过 keyspace 获取当前 active key，再打开对应 namespace。
 * 切换 active key 后必须重新调用此函数。
 *
 * 硬切换 005：版本不匹配即整库 rebuild——收口在 `openP2pkhDb()` 一处。
 *   - `oldVersion < 7`：onupgradeneeded 事务内删光旧 p2pkh_* stores，重建 v7。
 *   - `oldVersion > 7`：keyspace 内部 `indexedDB.open(name, 7)` 抛 VersionError，
 *     本函数捕获后执行 `close cached handle -> deleteDatabase -> reopen`。
 *   - `oldVersion === 7`：普通打开。
 *   - `deleteDatabase` 被 blocked / 失败必须冒泡，**不允许**假装 rebuild 成功。
 *
 * 硬切换 003：调用方可通过 `logger` 让本函数在 upgrade 阶段补全"新建 /
 * 升级 / 普通打开"日志；不传时不记日志。
 */
export async function openP2pkhDb(input: {
  keyspace: KeyspaceService;
  publicKeyHex: string;
  logger?: PluginLogger;
}): Promise<P2pkhDbBundle> {
  if (openHandle && openHandle.publicKeyHex === input.publicKeyHex) {
    return openHandle as P2pkhDbBundle;
  }
  // 切换 namespace：关闭旧的。
  closeCachedHandle();
  let audit: UpgradeAudit | undefined;
  let handle: import("@keymaster/contracts").KeyScopedStorageHandle;
  try {
    handle = await input.keyspace.openKeyStorage({
      publicKeyHex: input.publicKeyHex,
      pluginId: "p2pkh",
      storageId: P2PKH_STORAGE_ID,
      version: P2PKH_DB_VERSION,
      upgrade: (db, oldVersion, newVersion) => {
        // 硬切换 005：oldVersion < 7 进入 upgrade 是"删光旧 stores 重建 v7"，
        // **不是**数据迁移。oldVersion === 0（首次创建）和
        // 0 < oldVersion < 7（旧版本）都统一落到 createV7Stores——
        // 区别仅在日志分类 kind 上。
        // newVersion 在 contract 里允许 null（DB 被删除的特殊场景）；本路径
        // 下若为 null 也按 created 处理——这只是日志分类，不需要阻断。
        const resolvedNewVersion = newVersion ?? P2PKH_DB_VERSION;
        const kind: OpenKind = oldVersion === 0 ? "created" : "upgraded";
        createV7Stores(db);
        audit = {
          kind,
          oldVersion,
          newVersion: resolvedNewVersion,
          storeSnapshot: auditV7Stores(db)
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
    // 硬切换 005：oldVersion > 7 走"close -> deleteDatabase -> reopen"重建。
    // 非 VersionError 直接冒泡，**不**在 p2pkh 层吞错。
    if (!isVersionError(err)) throw err;
    // 防御性：捕获当前模块缓存的 openHandle 句柄（若本函数上方某次
    // 早返回路径已让 openHandle 残留，这里也要先关掉，避免
    // deleteDatabase 被自己的连接阻塞）。
    closeCachedHandle();
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
        createV7Stores(db);
        audit = {
          kind: "created",
          oldVersion,
          newVersion: resolvedNewVersion,
          storeSnapshot: auditV7Stores(db)
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
      storeSnapshot: auditV7Stores(handle.db)
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
      if (openHandle === next) openHandle = undefined;
    },
    getDb: () => handle.db
  };
  openHandle = next;
  return next as P2pkhDbBundle;
}

/** 关闭并清空缓存的 db handle（仅用于测试与 dispose）。 */
export function disposeP2pkhDb(): void {
  closeCachedHandle();
}

/**
 * 内部：关掉模块级 openHandle（如果存在）。把这段逻辑抽到独立函数，
 * 避免在 openP2pkhDb 内被 TypeScript 跨 try-catch 的窄化分析吃成 `never`。
 */
function closeCachedHandle(): void {
  const current = openHandle;
  if (!current) return;
  try {
    current.close();
  } catch {
    // 静默
  }
  openHandle = undefined;
}

/**
 * 硬切换 005：把 `oldVersion > 7` 时的浏览器抛错识别为 VersionError。
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
 * v7 schema（硬切换 005 + 硬切换 003 / 001）：
 *   - 硬切换 005：进入 upgrade 事务即删光当前 DB 内**所有** `p2pkh_` 前缀
 *     的 store（包括任何历史遗留 / 未来被废弃但忘了在硬编码列表里登记
 *     的 store），然后按 v7 完整重建；**不迁移**任何旧数据。
 *   - 硬切换 001：删除 `p2pkh_balances` store；余额不再是持久化实体。
 *   - 删除 `p2pkh_pending_transfers / p2pkh_utxo_reservations` 旧 store。
 *   - 新建 `p2pkh_local_submissions / p2pkh_local_input_claims`。
 */
const P2PKH_STORE_PREFIX = "p2pkh_";

function createV7Stores(db: IDBDatabase) {
  // v7：进入 onupgradeneeded 时**先**遍历 `db.objectStoreNames`，把所有
  // `p2pkh_` 前缀的 store 全部删掉，再**无条件**按 v7 schema 重建——这是
  // 硬切换 005 的硬规则。
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
    // publicKeyHex 是诊断字段（key switch 时排错用），不再做唯一约束。
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
    async listResourcesByKey(_keyId: string): Promise<P2pkhKeyResource[]> {
      // key scoped DB 里 keyId 不可靠；列出当前 namespace 全部 resource。
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
              keyId: currentAddress.keyId,
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
              const merged: P2pkhHistoryItem = {
                id,
                resourceId: commit.resourceId,
                keyId: effectiveResource.keyId,
                publicKeyHex: effectiveResource.publicKeyHex,
                network: effectiveResource.network,
                address: effectiveResource.address,
                txid: h.txid,
                height: h.height,
                status: h.status,
                source: h.source,
                syncedAt: prev?.syncedAt && prev?.syncedAt > h.syncedAt ? prev.syncedAt : h.syncedAt
              };
              await reqAsPromise(histStore.put(merged));
            }
          }
          if (commit.unconfirmedHistory) {
            const histStore = t.objectStore("p2pkh_history");
            const presentIds = new Set(
              commit.unconfirmedHistory.map((h) => newHistoryId(commit.resourceId, h.txid))
            );
            const allForResource = await reqAsPromise<IDBValidKey[]>(
              histStore.index("resourceId").getAllKeys(commit.resourceId)
            );
            const MISSING_THRESHOLD = 3;
            for (const key of allForResource) {
              const id = String(key);
              const prev = await reqAsPromise<P2pkhHistoryItem | undefined>(histStore.get(id));
              if (!prev) continue;
              if (prev.status === "confirmed") continue;
              if (presentIds.has(id)) {
                if (prev.missingObservationCount) {
                  await reqAsPromise(histStore.put({ ...prev, missingObservationCount: 0, syncedAt: now }));
                }
                continue;
              }
              const count = (prev.missingObservationCount ?? 0) + 1;
              if (count >= MISSING_THRESHOLD) {
                if (prev.status !== "dropped") {
                  await reqAsPromise(histStore.put({ ...prev, status: "dropped", missingObservationCount: count, syncedAt: now }));
                }
              } else if (count !== prev.missingObservationCount) {
                await reqAsPromise(histStore.put({ ...prev, missingObservationCount: count, syncedAt: now }));
              }
            }
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
                address: effectiveResource.address
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
            for (const r of commit.localInputClaims) await reqAsPromise(store.put(r));
          }
          if (commit.localSubmissions) {
            const store = t.objectStore("p2pkh_local_submissions");
            for (const p of commit.localSubmissions) await reqAsPromise(store.put(p));
          }
        }
      );
    },

    // ---------- 清理 ----------
    /** 清理当前 namespace 内所有数据。设计缘由：删除 key 时 namespace DB 整体删除，
     *  本方法用于手动重置或迁移失败回滚。硬切换 001：余额不再落库，
     *  clearAll 不再调用 clearBalance。 */
    async clearAll(): Promise<void> {
      const resources = await this.listResourcesByKey("");
      for (const r of resources) {
        await this.removeResource(r.resourceId);
        await this.clearUtxosForResource(r.resourceId);
        await this.clearHistoryForResource(r.resourceId);
        await this.clearBackfillState(r.resourceId);
        const submissions = await this.listLocalSubmissionsByResource(r.resourceId);
        for (const p of submissions) await this.removeLocalSubmission(p.id);
        const claims = await this.listLocalInputClaimsByResource(r.resourceId);
        for (const rs of claims) await this.removeLocalInputClaim(rs.id);
      }
    }
  };
}

export type P2pkhDbHandle = ReturnType<typeof createP2pkhDb>;

/** 工具：从已知的 keyId/network 构造 resourceId（保留供 transfer service 等调用）。 */
export function resourceIdFor(keyId: string, network: BsvNetwork): string {
  return makeResourceId(keyId, network);
}

/** 工具：本地输入占用 id。 */
export function localInputClaimIdFor(resourceId: string, txid: string, vout: number): string {
  return newLocalInputClaimId(resourceId, txid, vout);
}

/**
 * 硬切换 003：legacy migration 仅作为诊断工具保留，**不再被任何运行时
 * 路径调用**——不在 unlock、rehydrate、手工同步、key.deleted、indexedDB
 * 升级钩子里触发。
 *
 * 历史设计：将全局 `p2pkh` v3 DB 的记录按 keyId 找对应 publicKeyHex，
 * 写入对应 namespace DB；迁移成功后删除旧 DB；失败时只丢弃旧缓存。
 *
 * 现在 P2PKH 的恢复路径是 `rehydrate + recent-sync + history-backfill`：
 * 旧 DB 即使还在 indexedDB 里也只是死缓存；不需要为了它再造一条与
 * active key 模型平行的迁移链，否则只会增加系统复杂度。
 *
 * 调用方必须明确知道自己在做什么；任何"启动时自动迁移"或"unlock 时
 * 顺带迁移"的接法都是硬切换 003 禁止的。
 */
export interface LegacyMigrationSummary {
  migrated: number;
  failed: number;
  abandoned: boolean;
}

export async function migrateLegacyP2pkhDb(input: {
  keyspace: KeyspaceService;
  /** 把旧记录 keyId 映射到当前 active 的 publicKeyHex；找不到时跳过。 */
  resolvePublicKeyHash: (oldKeyId: string) => Promise<string | undefined>;
  onProgress?: (summary: LegacyMigrationSummary) => void;
}): Promise<LegacyMigrationSummary> {
  if (typeof indexedDB === "undefined") {
    return { migrated: 0, failed: 0, abandoned: false };
  }
  // 1) 读取旧 DB。
  const oldDb = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(LEGACY_DB_NAME, LEGACY_DB_VERSION);
    req.onupgradeneeded = () => {
      // 旧 DB 不应该在我们手里被升级；保留 onupgradeneeded 占位但不创建新 store。
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch(() => undefined);
  if (!oldDb) return { migrated: 0, failed: 0, abandoned: false };
  try {
    const stores = [...oldDb.objectStoreNames];
    if (!stores.includes("p2pkh_addresses")) {
      return { migrated: 0, failed: 0, abandoned: false };
    }
    const oldResources = await readAllFromLegacy<P2pkhKeyResource>(oldDb, "p2pkh_addresses");
    const oldUtxos = await readAllFromLegacy<P2pkhUtxo>(oldDb, "p2pkh_utxos");
    const oldHistory = await readAllFromLegacy<P2pkhHistoryItem>(oldDb, "p2pkh_history");
    // 硬切换 001：不再迁移旧 balance 行——余额改为 service 现算，
    // 即使旧 DB 仍有 p2pkh_balances 行也只能让它们随旧 DB 删除一起丢弃。
    const summary: LegacyMigrationSummary = { migrated: 0, failed: 0, abandoned: false };
    // 按 keyId 分组写到对应 namespace。
    const byKey = new Map<string, { resources: P2pkhKeyResource[]; utxos: P2pkhUtxo[]; history: P2pkhHistoryItem[] }>();
    function bucket(keyId: string) {
      let b = byKey.get(keyId);
      if (!b) {
        b = { resources: [], utxos: [], history: [] };
        byKey.set(keyId, b);
      }
      return b;
    }
    for (const r of oldResources) bucket(r.keyId).resources.push(r);
    for (const u of oldUtxos) bucket(u.keyId).utxos.push(u);
    for (const h of oldHistory) bucket(h.keyId).history.push(h);
    for (const [oldKeyId, group] of byKey) {
      const publicKeyHex = await input.resolvePublicKeyHash(oldKeyId);
      if (!publicKeyHex) {
        summary.failed += group.resources.length;
        continue;
      }
      try {
        const handle = await input.keyspace.openKeyStorage({
          publicKeyHex,
          pluginId: "p2pkh",
          storageId: P2PKH_STORAGE_ID,
          version: P2PKH_DB_VERSION,
          upgrade: (db) => createV7Stores(db)
        });
        const target = createP2pkhDb({
          publicKeyHex,
          close: () => handle.close(),
          getDb: () => handle.db
        });
        for (const r of group.resources) {
          await target.putAddress({ ...r, publicKeyHex });
        }
        for (const u of group.utxos) {
          await target.putUtxos([{ ...u, publicKeyHex }]);
        }
        for (const h of group.history) {
          await target.putHistory([{ ...h, publicKeyHex }]);
        }
        handle.close();
        summary.migrated += group.resources.length;
      } catch (err) {
        summary.failed += group.resources.length;
        summary.abandoned = true;
        console.error("P2PKH legacy migration failed for key", oldKeyId, err);
      }
    }
    input.onProgress?.(summary);
    // 2) 迁移成功后删除旧 DB。
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(LEGACY_DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("legacy p2pkh DB delete blocked"));
    });
    return summary;
  } catch (err) {
    console.error("P2PKH legacy migration failed", err);
    return { migrated: 0, failed: 0, abandoned: true };
  } finally {
    try {
      oldDb.close();
    } catch {
      // 静默
    }
  }
}

function readAllFromLegacy<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}
