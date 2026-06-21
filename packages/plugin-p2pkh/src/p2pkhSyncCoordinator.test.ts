// packages/plugin-p2pkh/src/p2pkhSyncCoordinator.test.ts
// 协调器单测（硬切换 007 + 硬切换 001）：
//   - 同一 resource 串行执行。
//   - revision 不匹配被丢弃。
//   - generation 不匹配被丢弃。
//   - hasRecentPending 在 recent 排队时为 true。
// 硬切换 001：本文件无 balance commit 相关断言（commitRecentSnapshot
// 的 balance 写入语义已整体删除）。
//
// 通过 fake keyspace 打开 key-scoped namespace db，注入 coordinator。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createP2pkhDb, disposeP2pkhDb, openP2pkhDb, type P2pkhDbHandle } from "./p2pkhDb.js";
import { createP2pkhSyncCoordinator } from "./p2pkhSyncCoordinator.js";
import type { P2pkhKeyResource } from "./p2pkhContracts.js";
import type { KeyScopedStorageHandle, KeyspaceService } from "@keymaster/contracts";

const ACTIVE_PUBLIC_KEY_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const DB_NAME = `keymaster.key.${ACTIVE_PUBLIC_KEY_HEX}.plugin.p2pkh.state`;

function makeResource(generation = 0): P2pkhKeyResource {
  return {
    resourceId: "k1:main",
    keyId: "k1",
    publicKeyHex: ACTIVE_PUBLIC_KEY_HEX,
    label: "l",
    address: "a",
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
      keyId: "k1",

      label: "l",
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

let bundle: P2pkhDbHandle | undefined;

async function getDb(): Promise<P2pkhDbHandle> {
  if (bundle) return bundle;
  const keyspace = makeKeyspace(ACTIVE_PUBLIC_KEY_HEX);
  const nsHandle = await openP2pkhDb({ keyspace, publicKeyHex: ACTIVE_PUBLIC_KEY_HEX });
  bundle = createP2pkhDb(nsHandle);
  return bundle;
}

beforeEach(async () => {
  // 硬切换 008：必须调 disposeP2pkhDb 清掉模块级 openHandle 缓存。
  disposeP2pkhDb();
  bundle = undefined;
  await new Promise<void>((resolve) => {
    const r = indexedDB.deleteDatabase(DB_NAME);
    r.onsuccess = () => resolve();
    r.onerror = () => resolve();
    r.onblocked = () => resolve();
  });
});

afterEach(async () => {
  disposeP2pkhDb();
  bundle = undefined;
  await new Promise<void>((resolve) => {
    const r = indexedDB.deleteDatabase(DB_NAME);
    r.onsuccess = () => resolve();
    r.onerror = () => resolve();
    r.onblocked = () => resolve();
  });
});

describe("P2pkhSyncCoordinator", () => {
  it("runs backfill page serially per resource", async () => {
    const db = await getDb();
    const r = makeResource();
    await db.putAddress(r);
    const c = createP2pkhSyncCoordinator({ getDb: () => getDb() });
    const calls: number[] = [];
    await c.runBackfillPage(r.resourceId, 0, r.generation, async () => {
      calls.push(1);
      return { page: [], nextPageToken: "t1", resource: r };
    });
    await c.runBackfillPage(r.resourceId, 1, r.generation, async () => {
      calls.push(2);
      return { page: [], nextPageToken: "t2", resource: r };
    });
    expect(calls).toEqual([1, 2]);
  });

  it("rejects commit when revision mismatches", async () => {
    const db = await getDb();
    const r = makeResource();
    await db.putAddress(r);
    const c = createP2pkhSyncCoordinator({ getDb: () => getDb() });
    await c.runBackfillPage(r.resourceId, 0, r.generation, async () => ({
      page: [{ txid: "a", height: 1, status: "confirmed" as const, source: "woc-confirmed" as const }],
      nextPageToken: "t1",
      resource: r
    }));
    // 第二次 commit 用错的 expectedRevision 应被丢弃
    await expect(
      c.runBackfillPage(r.resourceId, 0, r.generation, async () => ({
        page: [{ txid: "b", height: 1, status: "confirmed" as const, source: "woc-confirmed" as const }],
        nextPageToken: "t2",
        resource: r
      }))
    ).rejects.toThrow();
    const hist = await db.listHistory();
    expect(hist.map((h) => h.txid).sort()).toEqual(["a"]);
  });

  it("rejects commit when generation mismatches (key rebuilt)", async () => {
    const db = await getDb();
    const r0 = makeResource(0);
    await db.putAddress(r0);
    // 模拟 resource 重建 generation=1
    await db.putAddress({ ...r0, generation: 1 });
    const c = createP2pkhSyncCoordinator({ getDb: () => getDb() });
    await expect(
      c.runBackfillPage(r0.resourceId, 0, 0, async () => ({
        page: [{ txid: "late", height: 1, status: "confirmed" as const, source: "woc-confirmed" as const }],
        nextPageToken: undefined,
        resource: r0
      }))
    ).rejects.toThrow();
    const hist = await db.listHistory();
    expect(hist).toHaveLength(0);
  });

  it("hasRecentPending is true while a recent build is queued", async () => {
    const db = await getDb();
    const r = makeResource();
    await db.putAddress(r);
    const c = createP2pkhSyncCoordinator({ getDb: () => getDb() });
    let resolveBuild!: () => void;
    const build = new Promise<void>((res) => {
      resolveBuild = res;
    });
    const pending = c.runRecent(r.resourceId, r.generation, () => build.then(() => ({
      resourceId: r.resourceId
    } as never)));
    // runRecent 是 async 函数；同步路径上 hasRecentPending 应为 true
    expect(c.hasRecentPending(r.resourceId)).toBe(true);
    resolveBuild();
    await pending;
    expect(c.hasRecentPending(r.resourceId)).toBe(false);
  });
});
