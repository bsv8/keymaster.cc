// packages/plugin-p2pkh/src/p2pkhDb.test.ts
// 硬切换 005 + 硬切换 007 后单测：
//   - 通过 fake keyspace 打开 key-scoped namespace db。
//   - 硬切换 005：version 不匹配走 rebuild 语义
//     - v0 -> v7 首次创建，v7 stores 全部建立；
//     - v6 -> v7 进入 onupgradeneeded，**不迁移**旧数据，按 v7 重建；
//     - v8 -> v7 触发 VersionError，close -> deleteDatabase -> reopen 收敛到 v7。
//   - commitBackfillPage / commitRecentSnapshot 校验不变。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createP2pkhDb, disposeP2pkhDb, namespaceDbName, openP2pkhDb, type P2pkhDbHandle } from "./p2pkhDb.js";
import type { P2pkhKeyResource } from "./p2pkhContracts.js";
import type { KeyScopedStorageHandle, KeyspaceService } from "@keymaster/contracts";

const ACTIVE_PUBLIC_KEY_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const DB_NAME = `keymaster.key.${ACTIVE_PUBLIC_KEY_HEX}.plugin.p2pkh.state`;

function makeResource(generation = 0): P2pkhKeyResource {
  return {
    resourceId: "key1:main",
    keyId: "key1",
    publicKeyHex: ACTIVE_PUBLIC_KEY_HEX,
    label: "test",
    address: "addr-main",
    network: "main",
    createdAt: "2024-01-01T00:00:00.000Z",
    generation
  };
}

function makeKeyspace(publicKeyHex: string): KeyspaceService {
  return {
    listKeys: async () => [],
    getKey: async () => undefined,
    active: () => ({ activePublicKeyHex: publicKeyHex }),
    setActive: async () => undefined,
    requireActiveKey: () => ({
      keyId: "key1",

      label: "test",
      capabilities: ["p2pkh"],
      createdAt: "2024-01-01T00:00:00.000Z",
      identityStatus: "ready"
    }),
    onActiveChange: () => () => undefined,
    openKeyStorage: async (input) => {
      if (input.publicKeyHex !== publicKeyHex) {
        throw new Error("Key storage is not ready");
      }
      const name = `keymaster.key.${input.publicKeyHex}.plugin.${input.pluginId}.${input.storageId}`;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open(name, input.version);
        r.onupgradeneeded = () => {
          input.upgrade(r.result, 0, input.version);
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      const handle: KeyScopedStorageHandle = {
        db,
        name,
        close: () => db.close()
      };
      return handle;
    },
    registerPluginStorage: () => undefined,
    listPluginStorages: () => [],
    prepareDeleteKey: async () => undefined,
    deleteKey: async () => undefined,
    // 硬切换 008 收尾：fake 上是 no-op。
    deleteKeyById: async () => undefined,
    isInitializing: () => false,
    onInitializationChange: () => () => undefined,
    // 硬切换 008：attachBackgroundService 在测试 fake 上是 no-op。
    attachBackgroundService: () => undefined
  };
}

/**
 * 硬切换 005：使用真实 IDBVersionChangeEvent 语义的 keyspace。
 * 默认 fake 总是把 oldVersion 传成 0，无法覆盖 v6 -> v7 / v8 -> v7 路径；
 * 本 fake 透传浏览器自身的 oldVersion / VersionError，验证 rebuild 分支。
 */
function makeRealKeyspace(publicKeyHex: string): KeyspaceService {
  const base = makeKeyspace(publicKeyHex);
  return {
    ...base,
    openKeyStorage: async (input) => {
      if (input.publicKeyHex !== publicKeyHex) {
        throw new Error("Key storage is not ready");
      }
      const name = `keymaster.key.${input.publicKeyHex}.plugin.${input.pluginId}.${input.storageId}`;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open(name, input.version);
        r.onupgradeneeded = (event) => {
          const ev = event as IDBVersionChangeEvent;
          input.upgrade(r.result, ev.oldVersion, ev.newVersion ?? null);
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        r.onblocked = () => reject(new Error("Key storage open blocked"));
      });
      const handle: KeyScopedStorageHandle = {
        db,
        name,
        close: () => db.close()
      };
      return handle;
    }
  };
}

/**
 * 硬切换 005：手工把 DB 在指定 version 打开（带 store 列表），用来
 * 模拟"本地残留旧 / 新 version 的 p2pkh DB"前置状态。
 *
 * stores 中的项支持 `{ name, keyPath }`，不指定 keyPath 时使用 out-of-line key
 * （v8 残留 store 这种"我不在乎 schema，只在乎库存在"的场景）。
 */
async function preOpenAtVersion(
  version: number,
  stores: Array<string | { name: string; keyPath?: string | string[] }>
): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, version);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const name of [...db.objectStoreNames]) {
        db.deleteObjectStore(name);
      }
      for (const entry of stores) {
        if (typeof entry === "string") {
          // out-of-line key：后续 put 必须显式带 key。
          db.createObjectStore(entry);
        } else {
          db.createObjectStore(entry.name, entry.keyPath ? { keyPath: entry.keyPath } : undefined);
        }
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error("preopen blocked"));
  });
}

function closeDbQuietly(db: IDBDatabase | undefined): void {
  if (!db) return;
  try {
    db.close();
  } catch {
    // 静默
  }
}

let bundle: P2pkhDbHandle | undefined;

async function openDb(): Promise<P2pkhDbHandle> {
  if (bundle) return bundle;
  const keyspace = makeKeyspace(ACTIVE_PUBLIC_KEY_HEX);
  const nsHandle = await openP2pkhDb({ keyspace, publicKeyHex: ACTIVE_PUBLIC_KEY_HEX });
  bundle = createP2pkhDb(nsHandle);
  return bundle;
}

async function resetDb(): Promise<void> {
  // 硬切换 008：必须调用 disposeP2pkhDb 清掉模块级 openHandle 缓存，
  // 否则下一轮 openP2pkhDb 会复用已关闭的 IDBDatabase，触发版本/升级错误。
  disposeP2pkhDb();
  bundle = undefined;
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  await resetDb();
});

afterEach(async () => {
  await resetDb();
});

describe("p2pkhDb v7 stores", () => {
  it("creates all required stores on first open and does not have p2pkh_balances", async () => {
    const db = await openDb();
    await db.listAddresses();
    const raw = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(DB_NAME);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const required = [
      "p2pkh_addresses",
      "p2pkh_utxos",
      "p2pkh_history",
      "p2pkh_history_backfill",
      "p2pkh_recent_sync",
      "p2pkh_local_submissions",
      "p2pkh_local_input_claims"
    ];
    for (const name of required) {
      expect(raw.objectStoreNames.contains(name), `missing store: ${name}`).toBe(true);
    }
    expect(raw.objectStoreNames.contains("p2pkh_pending_transfers")).toBe(false);
    expect(raw.objectStoreNames.contains("p2pkh_utxo_reservations")).toBe(false);
    // 硬切换 001：余额不再落库。
    expect(raw.objectStoreNames.contains("p2pkh_balances")).toBe(false);
    // 硬切换 005：DB 版本必须固定为 7。
    expect(raw.version).toBe(7);
    raw.close();
  });
});

describe("p2pkhDb namespaceDbName (硬切换 005 name source)", () => {
  it("uses the keyspace contract naming convention: keymaster.key.<hash>.plugin.p2pkh.state", () => {
    // 硬切换 005：VersionError 分支由 plugin-p2pkh 自己按这条命名约定
    // 拼出 name。如果 keyspace 改了 `keymaster.key.<publicKeyHex>.plugin.
    // <pluginId>.<storageId>` 这条规则，这里要直接红，避免 VersionError
    // 路径里悄悄删错库。
    expect(namespaceDbName(ACTIVE_PUBLIC_KEY_HEX)).toBe(DB_NAME);
    expect(namespaceDbName("a".repeat(64))).toBe(
      `keymaster.key.${"a".repeat(64)}.plugin.p2pkh.state`
    );
  });
});

describe("p2pkhDb version mismatch rebuild (硬切换 005)", () => {
  it("v6 -> v7 enters onupgradeneeded, drops old p2pkh stores, rebuilds v7 (no migration)", async () => {
    // 前置：DB 已存在 v6（v6 schema stores），并保留一条旧记录——
    // 验证硬切换 005 不会把这条记录搬到 v7。
    const seeded = await preOpenAtVersion(6, [
      { name: "p2pkh_addresses", keyPath: "resourceId" },
      { name: "p2pkh_utxos", keyPath: "id" },
      { name: "p2pkh_history", keyPath: "id" },
      { name: "p2pkh_history_backfill", keyPath: "resourceId" },
      { name: "p2pkh_recent_sync", keyPath: "resourceId" },
      { name: "p2pkh_local_submissions", keyPath: "id" },
      { name: "p2pkh_local_input_claims", keyPath: "id" }
    ]);
    await new Promise<void>((resolve, reject) => {
      const t = seeded.transaction("p2pkh_addresses", "readwrite");
      t.objectStore("p2pkh_addresses").put({
        resourceId: "stale:row",
        keyId: "stale",
        publicKeyHex: ACTIVE_PUBLIC_KEY_HEX,
        label: "stale",
        address: "stale-addr",
        network: "main",
        createdAt: "2024-01-01T00:00:00.000Z",
        generation: 0
      });
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
    closeDbQuietly(seeded);

    // 走真 IDBVersionChangeEvent 语义的 keyspace 调用 openP2pkhDb。
    const keyspace = makeRealKeyspace(ACTIVE_PUBLIC_KEY_HEX);
    const nsHandle = await openP2pkhDb({ keyspace, publicKeyHex: ACTIVE_PUBLIC_KEY_HEX });

    // 验证：DB 已经是 v7；旧 stores / 旧记录不能残留。
    const raw = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(DB_NAME);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    expect(raw.version).toBe(7);
    for (const name of [
      "p2pkh_addresses",
      "p2pkh_utxos",
      "p2pkh_history",
      "p2pkh_history_backfill",
      "p2pkh_recent_sync",
      "p2pkh_local_submissions",
      "p2pkh_local_input_claims"
    ]) {
      expect(raw.objectStoreNames.contains(name)).toBe(true);
    }
    raw.close();

    const db = createP2pkhDb(nsHandle);
    const rows = await db.listAddresses();
    expect(rows.find((r) => r.resourceId === "stale:row")).toBeUndefined();
  });

  it("v6 -> v7 cleans up stray p2pkh_orphan stores that are not in the v6 known list", async () => {
    // 硬切换 005 收尾验证：不能用"硬编码 store 名列表"实现 delete。
    // 这里故意在 v6 库内塞一个 `p2pkh_orphan`——它**不在**任何已知
    // schema 列表里，模拟"未来某次迭代加了一个 p2pkh_xxx store，后来
    // 又被回退/弃用，但硬编码列表没跟上"这条场景。
    // 升级到 v7 后这个 orphan 必须被删光，不能留在库里。
    const seeded = await preOpenAtVersion(6, [
      { name: "p2pkh_addresses", keyPath: "resourceId" },
      { name: "p2pkh_orphan", keyPath: "id" },
      { name: "p2pkh_stray_v6_artifact", keyPath: "id" }
    ]);
    closeDbQuietly(seeded);

    const keyspace = makeRealKeyspace(ACTIVE_PUBLIC_KEY_HEX);
    const nsHandle = await openP2pkhDb({ keyspace, publicKeyHex: ACTIVE_PUBLIC_KEY_HEX });

    const raw = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(DB_NAME);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    expect(raw.version).toBe(7);
    // 任何 p2pkh_ 前缀的 store 都不能残留——包括 v6 已知表之外的 stray。
    for (const stray of [...raw.objectStoreNames]) {
      expect(stray.startsWith("p2pkh_"), `unexpected non-p2pkh store: ${stray}`).toBe(true);
    }
    expect(raw.objectStoreNames.contains("p2pkh_orphan")).toBe(false);
    expect(raw.objectStoreNames.contains("p2pkh_stray_v6_artifact")).toBe(false);
    raw.close();

    // 还能正常用。
    createP2pkhDb(nsHandle).listAddresses();
  });

  it("v8 -> v7 triggers VersionError; close->deleteDatabase->reopen converges to v7", async () => {
    // 前置：DB 已存在 v8（mock 一个比目标 v7 高的 version）。
    // v8 stores 故意和 v7 不一样，验证整库删除而不是逐表迁移。
    const seeded = await preOpenAtVersion(8, [
      "p2pkh_addresses",
      "p2pkh_future_legacy_table",
      "p2pkh_orphan"
    ]);
    closeDbQuietly(seeded);

    const keyspace = makeRealKeyspace(ACTIVE_PUBLIC_KEY_HEX);
    const nsHandle = await openP2pkhDb({ keyspace, publicKeyHex: ACTIVE_PUBLIC_KEY_HEX });

    const raw = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(DB_NAME);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    expect(raw.version).toBe(7);
    // v8 残留 stores 不应被保留（整库删除后重建）。
    expect(raw.objectStoreNames.contains("p2pkh_future_legacy_table")).toBe(false);
    expect(raw.objectStoreNames.contains("p2pkh_orphan")).toBe(false);
    for (const name of [
      "p2pkh_addresses",
      "p2pkh_utxos",
      "p2pkh_history",
      "p2pkh_history_backfill",
      "p2pkh_recent_sync",
      "p2pkh_local_submissions",
      "p2pkh_local_input_claims"
    ]) {
      expect(raw.objectStoreNames.contains(name)).toBe(true);
    }
    raw.close();

    const db = createP2pkhDb(nsHandle);
    const rows = await db.listAddresses();
    expect(rows).toEqual([]);
  });

  it("non-VersionError is propagated, not swallowed as rebuild", async () => {
    // 硬切换 005：openP2pkhDb 只在 VersionError 上触发 deleteDatabase ->
    // reopen；其它错误必须原样冒泡，不假装 rebuild。
    const failingKeyspace: KeyspaceService = {
      ...makeRealKeyspace(ACTIVE_PUBLIC_KEY_HEX),
      openKeyStorage: async () => {
        throw new Error("synthetic open failure");
      }
    };
    await expect(
      openP2pkhDb({ keyspace: failingKeyspace, publicKeyHex: ACTIVE_PUBLIC_KEY_HEX })
    ).rejects.toThrow("synthetic open failure");
  });
});

describe("p2pkhDb commitBackfillPage", () => {
  it("persists page history and cursor atomically; rejects revision mismatch", async () => {
    const db = await openDb();
    const r = makeResource();
    await db.putAddress(r);
    await db.commitBackfillPage({
      resourceId: r.resourceId,
      expectedRevision: 0,
      expectedGeneration: 0,
      resource: r,
      page: [{ txid: "tx-a", height: 100, status: "confirmed", source: "woc-confirmed" }],
      nextPageToken: "tok-1"
    });
    const history1 = await db.listHistory();
    expect(history1).toHaveLength(1);
    expect(history1[0]!.id).toBe("key1:main:tx-a");
    expect(history1[0]!.network).toBe("main");
    expect(history1[0]!.keyId).toBe("key1");
    const state1 = await db.getBackfillState(r.resourceId);
    expect(state1?.revision).toBe(1);
    expect(state1?.nextPageToken).toBe("tok-1");
    expect(state1?.status).toBe("running");

    // 重复提交同一页：revision mismatch 应被丢弃
    await expect(
      db.commitBackfillPage({
        resourceId: r.resourceId,
        expectedRevision: 0,
        expectedGeneration: 0,
        resource: r,
        page: [{ txid: "tx-a", height: 100, status: "confirmed", source: "woc-confirmed" }],
        nextPageToken: "tok-1"
      })
    ).rejects.toThrow();
    const historyAfterDup = await db.listHistory();
    expect(historyAfterDup).toHaveLength(1);
  });

  it("rejects generation mismatch when key is removed and re-derived", async () => {
    const db = await openDb();
    const r0 = makeResource(0);
    await db.putAddress(r0);
    // 模拟 key 删除 + 重新导入：resource 重新写入且 generation 自增。
    const r1 = makeResource(1);
    await db.putAddress(r1);

    // 旧 generation 的迟到响应被丢弃
    await expect(
      db.commitBackfillPage({
        resourceId: r0.resourceId,
        expectedRevision: 0,
        expectedGeneration: 0, // 旧的 generation
        resource: r0,
        page: [{ txid: "tx-late", height: 1, status: "confirmed", source: "woc-confirmed" }],
        nextPageToken: undefined
      })
    ).rejects.toThrow();
    const all = await db.listHistory();
    expect(all.find((h) => h.txid === "tx-late")).toBeUndefined();
  });

  it("marks complete when nextPageToken missing", async () => {
    const db = await openDb();
    const r = makeResource();
    await db.putAddress(r);
    await db.commitBackfillPage({
      resourceId: r.resourceId,
      expectedRevision: 0,
      expectedGeneration: 0,
      resource: r,
      page: [],
      nextPageToken: undefined
    });
    const state = await db.getBackfillState(r.resourceId);
    expect(state?.status).toBe("complete");
  });
});

describe("p2pkhDb commitRecentSnapshot", () => {
  it("replaces UTXOs per resource and uses correct network (no balance write)", async () => {
    const db = await openDb();
    const r = makeResource();
    await db.putAddress(r);
    await db.commitRecentSnapshot({
      resourceId: r.resourceId,
      resource: r,
      utxos: [
        {
          id: `${r.resourceId}:t1:0`,
          resourceId: r.resourceId,
          keyId: r.keyId,
          publicKeyHex: r.publicKeyHex,
          network: "main",
          address: r.address,
          txid: "t1",
          vout: 0,
          value: 1000,
          height: 100,
          status: "confirmed",
          isSpentInMempoolTx: false,
          syncedAt: "2024-01-01T00:00:00.000Z"
        }
      ]
    });
    const utxos = await db.listUtxos();
    expect(utxos).toHaveLength(1);
    expect(utxos[0]!.network).toBe("main");
    // 硬切换 001：commitRecentSnapshot 不再写 p2pkh_balances，listBalances 应抛错（方法已被删除）。
    expect((db as unknown as { listBalances?: unknown }).listBalances).toBeUndefined();
    expect((db as unknown as { putBalance?: unknown }).putBalance).toBeUndefined();
  });

  it("does not overwrite confirmed history with unconfirmed", async () => {
    const db = await openDb();
    const r = makeResource();
    await db.putAddress(r);
    await db.commitBackfillPage({
      resourceId: r.resourceId,
      expectedRevision: 0,
      expectedGeneration: 0,
      resource: r,
      page: [{ txid: "t-conf", height: 10, status: "confirmed", source: "woc-confirmed" }],
      nextPageToken: undefined
    });
    // recent 不应把 confirmed 降级为 unconfirmed
    await db.commitRecentSnapshot({
      resourceId: r.resourceId,
      resource: r,
      unconfirmedHistory: [
        {
          id: `${r.resourceId}:t-conf`,
          resourceId: r.resourceId,
          keyId: r.keyId,
          publicKeyHex: r.publicKeyHex,
          network: "main",
          address: r.address,
          txid: "t-conf",
          height: undefined,
          status: "unconfirmed",
          source: "woc-unconfirmed",
          syncedAt: "2024-01-01T00:00:00.000Z"
        }
      ]
    });
    const all = await db.listHistory();
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe("confirmed");
  });

  it("rejects generation mismatch", async () => {
    const db = await openDb();
    const r = makeResource(0);
    await db.putAddress(r);
    // resource 重建 generation=1
    await db.putAddress({ ...r, generation: 1 });
    await expect(
      db.commitRecentSnapshot({
        resourceId: r.resourceId,
        resource: r,
        expectedGeneration: 0 // 旧 generation
      })
    ).rejects.toThrow();
  });

  it("removes UTXOs that WOC no longer reports (replace-semantics)", async () => {
    const db = await openDb();
    const r = makeResource();
    await db.putAddress(r);
    // 第一次同步：写入两个 UTXO。
    await db.commitRecentSnapshot({
      resourceId: r.resourceId,
      resource: r,
      utxos: [
        {
          id: `${r.resourceId}:t1:0`,
          resourceId: r.resourceId,
          keyId: r.keyId,
          publicKeyHex: r.publicKeyHex,
          network: "main",
          address: r.address,
          txid: "t1",
          vout: 0,
          value: 1000,
          height: 100,
          status: "confirmed",
          isSpentInMempoolTx: false,
          syncedAt: "2024-01-01T00:00:00.000Z"
        },
        {
          id: `${r.resourceId}:t2:0`,
          resourceId: r.resourceId,
          keyId: r.keyId,
          publicKeyHex: r.publicKeyHex,
          network: "main",
          address: r.address,
          txid: "t2",
          vout: 0,
          value: 2000,
          height: 101,
          status: "confirmed",
          isSpentInMempoolTx: false,
          syncedAt: "2024-01-01T00:00:00.000Z"
        }
      ]
    });
    // 第二次同步：WOC 只返回 t1；t2 必须从本地被删除。
    await db.commitRecentSnapshot({
      resourceId: r.resourceId,
      resource: r,
      utxos: [
        {
          id: `${r.resourceId}:t1:0`,
          resourceId: r.resourceId,
          keyId: r.keyId,
          publicKeyHex: r.publicKeyHex,
          network: "main",
          address: r.address,
          txid: "t1",
          vout: 0,
          value: 1000,
          height: 100,
          status: "confirmed",
          isSpentInMempoolTx: false,
          syncedAt: "2024-01-02T00:00:00.000Z"
        }
      ]
    });
    const utxos = await db.listUtxos();
    expect(utxos).toHaveLength(1);
    expect(utxos[0]!.txid).toBe("t1");
  });
});
