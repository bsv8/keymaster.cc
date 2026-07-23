// packages/plugin-token-bsv21/src/bsv21Db.test.ts
// BSV-21 snapshot DB 单元测试（keyspace namespace 模式）。
// 使用 fake-indexeddb 提供真实 IndexedDB 环境（vitest.setup.ts 全局加载）。
//
// 测试场景：
//   1. 不同 key 打开不同 DB（keyspace namespace 隔离）
//   2. 切换 key 不串数据
//   3. replaceAll 原子性
//   4. 同 origin 不同 address 可以共存

import { describe, it, expect, afterEach } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { createBsv21Db } from "./bsv21Db";
import type { Bsv21Db, Bsv21TokenSnapshot } from "./bsv21Db";
import { createBsv21SyncTask } from "./bsv21Sync";
import type { KeyspaceService, KeyScopedStorageHandle, KeyScopedStorageOpenInput } from "@keymaster/contracts";

const PK1 = "pk1111111111111111111111111111111111111111111111111111111111111111";
const PK2 = "pk2222222222222222222222222222222222222222222222222222222222222222";

/** 构造测试用 snapshot 的辅助函数。 */
function makeSnapshot(
  overrides: Partial<Bsv21TokenSnapshot> & { origin: string },
): Bsv21TokenSnapshot {
  return {
    origin: overrides.origin,
    network: overrides.network ?? "main",
    address: overrides.address ?? "addr1",
    outpoint: overrides.outpoint ?? `${overrides.origin}_0`,
    amount: overrides.amount ?? "110",
    meta: overrides.meta ?? { origin: overrides.origin, symbol: "TOK" },
    syncedAt: overrides.syncedAt ?? "2026-01-01T00:00:00Z",
  };
}

/**
 * 创建 mock keyspace，支持切换 active key。
 * 每个 publicKeyHex 使用独立的 IndexedDB（与真实 keyspace 行为一致）。
 */
function makeMockKeyspace(initialHex?: string) {
  let activeHex = initialHex;
  const handles = new Map<string, KeyScopedStorageHandle>();
  const versions = new Map<string, number>();

  const keyspace: KeyspaceService = {
    active: () => ({ activePublicKeyHex: activeHex }),
    openKeyStorage: async (input: KeyScopedStorageOpenInput) => {
      // 模拟真实 keyspace：每个 publicKeyHex 一个独立 IndexedDB
      const name = `keymaster.key.${input.publicKeyHex}.plugin.plugin-token-bsv21.snapshots`;
      const oldVersion = versions.get(name) ?? 0;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(name, input.version);
        req.onupgradeneeded = () => input.upgrade(req.result, oldVersion, input.version);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      versions.set(name, input.version);
      const handle: KeyScopedStorageHandle = {
        db,
        name,
        close: () => { db.close(); handles.delete(input.publicKeyHex); },
      };
      handles.set(input.publicKeyHex, handle);
      return handle;
    },
  } as unknown as KeyspaceService;

  /** 切换 active key（模拟 keyspace.setActive）。 */
  function setActive(hex: string) {
    activeHex = hex;
  }

  return { keyspace, setActive, versions };
}

async function openLegacyV2Db(name: string, snapshots: Bsv21TokenSnapshot[], versions?: Map<string, number>): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(name, 2);
    req.onupgradeneeded = () => {
      const legacy = req.result;
      if (legacy.objectStoreNames.contains("snapshots")) {
        legacy.deleteObjectStore("snapshots");
      }
      legacy.createObjectStore("snapshots", { keyPath: ["network", "address", "origin"] });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("snapshots", "readwrite");
    const store = tx.objectStore("snapshots");
    for (const snapshot of snapshots) {
      store.put(snapshot as never);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  versions?.set(name, 2);
  db.close();
}

/**
 * 清理：用全新的 IDBFactory 替换全局 indexedDB，丢弃所有旧数据和连接。
 */
afterEach(() => {
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
});

describe("bsv21Db", () => {
  // 场景 1：不同 key 打开不同 DB（namespace 隔离）
  describe("不同 key 打开不同 DB", () => {
    it("PK1 写入的数据对 PK2 不可见", async () => {
      const { keyspace, setActive } = makeMockKeyspace(PK1);
      const db = createBsv21Db(keyspace);

      await db.put(makeSnapshot({ origin: "tok1", address: "addr1" }));

      // 切换到 PK2
      setActive(PK2);
      const list = await db.list();
      expect(list).toHaveLength(0);
    });

    it("PK1 和 PK2 各自独立写入和读取", async () => {
      const { keyspace, setActive } = makeMockKeyspace(PK1);
      const db = createBsv21Db(keyspace);

      await db.put(makeSnapshot({ origin: "tok1", address: "addr1" }));

      // 切换到 PK2，写入不同数据
      setActive(PK2);
      await db.put(makeSnapshot({ origin: "tok2", address: "addr2" }));

      // PK2 只能看到自己的数据
      const list2 = await db.list();
      expect(list2).toHaveLength(1);
      expect(list2[0]!.origin).toBe("tok2");

      // 切回 PK1，数据仍在
      setActive(PK1);
      const list1 = await db.list();
      expect(list1).toHaveLength(1);
      expect(list1[0]!.origin).toBe("tok1");
    });
  });

  // 场景 2：切换 key 不串数据
  describe("切换 key 不串数据", () => {
    it("replaceAll 后切换 key，新 key 数据不受影响", async () => {
      const { keyspace, setActive } = makeMockKeyspace(PK1);
      const db = createBsv21Db(keyspace);

      // PK1 写入数据
      await db.replaceAll([
        makeSnapshot({ origin: "tok1", address: "addr1" }),
        makeSnapshot({ origin: "tok2", address: "addr2" }),
      ]);

      // 切换到 PK2，replaceAll 新数据
      setActive(PK2);
      await db.replaceAll([
        makeSnapshot({ origin: "tok3", address: "addr3" }),
      ]);

      // PK2 只有 tok3
      const list2 = await db.list();
      expect(list2).toHaveLength(1);
      expect(list2[0]!.origin).toBe("tok3");

      // 切回 PK1，仍有 tok1 和 tok2
      setActive(PK1);
      const list1 = await db.list();
      expect(list1).toHaveLength(2);
      const origins = list1.map((s) => s.origin).sort();
      expect(origins).toEqual(["tok1", "tok2"]);
    });
  });

  // 场景 3：replaceAll 原子性
  describe("replaceAll 原子性", () => {
    it("替换后旧数据消失、新数据写入", async () => {
      const { keyspace } = makeMockKeyspace(PK1);
      const db = createBsv21Db(keyspace);

      await db.put(makeSnapshot({ origin: "tok1", address: "addr1" }));
      await db.put(makeSnapshot({ origin: "tok2", address: "addr2" }));

      const before = await db.list();
      expect(before).toHaveLength(2);

      await db.replaceAll([
        makeSnapshot({ origin: "tok3", address: "addrX" }),
        makeSnapshot({ origin: "tok4", address: "addrY" }),
        makeSnapshot({ origin: "tok5", address: "addrZ" }),
      ]);

      const after = await db.list();
      expect(after).toHaveLength(3);

      const origins = after.map((s) => s.origin).sort();
      expect(origins).toEqual(["tok3", "tok4", "tok5"]);
    });
  });

  // 场景 4：同 tokenId 多 outpoint 可以共存
  describe("同 tokenId 多 outpoint 可以共存", () => {
    it("put 两个同 tokenId 不同 outpoint 的 snapshot，list 返回两者", async () => {
      const { keyspace } = makeMockKeyspace(PK1);
      const db = createBsv21Db(keyspace);

      const s1 = makeSnapshot({ origin: "tok1", address: "addrA", outpoint: "tok1_0" });
      const s2 = makeSnapshot({ origin: "tok1", address: "addrA", outpoint: "tok1_1" });

      await db.put(s1);
      await db.put(s2);

      const list = await db.list();
      expect(list).toHaveLength(2);

      const outpoints = list.map((s) => s.outpoint).sort();
      expect(outpoints).toEqual(["tok1_0", "tok1_1"]);
    });
  });

  // 场景 5：amount 校验
  describe("amount 必须是十进制字符串", () => {
    it("拒绝非十进制字符串 amount", async () => {
      const { keyspace } = makeMockKeyspace(PK1);
      const db = createBsv21Db(keyspace);

      await expect(db.put(makeSnapshot({ origin: "tok-bad", amount: "11.0" }))).rejects.toThrow(/decimal string/);
    });
  });

  // 场景 6：v2 -> v3 升级
  describe("从 v2 打开到 v3", () => {
    it("会清空旧 store 并在 sync 后重建真值 snapshot", async () => {
      const { keyspace, versions } = makeMockKeyspace(PK1);
      const dbName = `keymaster.key.${PK1}.plugin.plugin-token-bsv21.snapshots`;

      await openLegacyV2Db(dbName, [
        makeSnapshot({ origin: "tok-old", address: "addr-old", outpoint: "tok-old_0" }),
        makeSnapshot({ origin: "tok-old", address: "addr-old", outpoint: "tok-old_1" }),
      ], versions);

      const db = createBsv21Db(keyspace);
      const afterOpen = await db.list();
      expect(afterOpen).toHaveLength(0);

      const syncTask = createBsv21SyncTask({
        db,
        service: {
          listActiveKeyTokens: async () => [{
            meta: { origin: "tok-new", symbol: "TOK" },
            balance: { confirmed: "0", unconfirmed: "0", amount: "7", display: "7" },
            outpoint: "tx-new_0",
            address: "addr-new",
            network: "main" as const
          }],
          listActiveKeyUnspentTokens: async () => [],
          getToken: async () => null
        } as never,
        woc: {
          getTransactionObservation: async (_network: "main" | "test", canonicalTxid: string) => ({ canonicalTxid, observation: undefined })
        } as never,
        keyspace,
        vault: { status: () => "unlocked" } as never
      });

      await syncTask.run({
        signal: new AbortController().signal,
        assertSessionFresh: () => {}
      } as never);

      const afterSync = await db.list();
      expect(afterSync).toHaveLength(1);
      expect(afterSync[0]).toMatchObject({
        origin: "tok-new",
        outpoint: "tx-new_0",
        amount: "7"
      });
    });
  });

  // 场景 5：无 active key 时抛错
  describe("无 active key 时抛错", () => {
    it("list 抛错", async () => {
      const { keyspace } = makeMockKeyspace(undefined);
      const db = createBsv21Db(keyspace);

      await expect(db.list()).rejects.toThrow("no active key");
    });
  });

  // 场景 6：A→B→A handle 生命周期回归
  // 设计缘由：验证移除 handle 缓存后，A→B→A 切换时不会复用
  // keyspace 已关闭的连接，A 仍能打开并读取原 snapshot。
  describe("A→B→A handle 生命周期", () => {
    it("A 写入 → 切 B 并关闭 A handle → B 写入 → 切回 A → A 仍能读取原 snapshot", async () => {
      const { keyspace, setActive } = makeMockKeyspace(PK1);
      const db = createBsv21Db(keyspace);

      // A 写入 snapshot
      await db.put(makeSnapshot({ origin: "tok-A", address: "addrA" }));

      // 切到 B，模拟 keyspace 关闭 A 的 handle
      setActive(PK2);
      // B 写入
      await db.put(makeSnapshot({ origin: "tok-B", address: "addrB" }));

      // 切回 A
      setActive(PK1);
      // A 仍能读取原 snapshot，不抛 InvalidStateError
      const listA = await db.list();
      expect(listA).toHaveLength(1);
      expect(listA[0]!.origin).toBe("tok-A");
    });
  });
});
