// packages/plugin-token-bsv21/src/bsv21Db.test.ts
// BSV-21 snapshot DB 单元测试。
// 使用 fake-indexeddb 提供真实 IndexedDB 环境（vitest.setup.ts 全局加载）。

import { describe, it, expect, afterEach } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { createBsv21Db } from "./bsv21Db";
import type { Bsv21TokenSnapshot } from "./bsv21Db";

const DB_NAME = "keymaster-bsv21-snapshots";

const PK1 = "pk1111111111111111111111111111111111111111111111111111111111111111";
const PK2 = "pk2222222222222222222222222222222222222222222222222222222222222222";

/** 构造测试用 snapshot 的辅助函数。 */
function makeSnapshot(
  overrides: Partial<Bsv21TokenSnapshot> & { origin: string; publicKeyHex?: string },
): Bsv21TokenSnapshot {
  return {
    origin: overrides.origin,
    publicKeyHex: overrides.publicKeyHex ?? PK1,
    network: overrides.network ?? "main",
    address: overrides.address ?? "addr1",
    balance: overrides.balance ?? { confirmed: 100, unconfirmed: 10 },
    meta: overrides.meta ?? { origin: overrides.origin, symbol: "TOK" },
    syncedAt: overrides.syncedAt ?? "2026-01-01T00:00:00Z",
  };
}

/**
 * 清理：用全新的 IDBFactory 替换全局 indexedDB，丢弃所有旧数据和连接。
 * 设计缘由：createBsv21Db() 内部缓存了 IDBDatabase 连接且无 close() 方法，
 * deleteDatabase 会因连接未关闭而被 blocked。直接替换 IDBFactory 最干净。
 */
afterEach(() => {
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
});

describe("bsv21Db", () => {
  // 场景 1：同一 origin 不同 address 可以共存
  describe("同一 origin、不同 address 可以共存", () => {
    it("put 两个同 origin 不同 address 的 snapshot，listByPublicKey 返回两者", async () => {
      const db = createBsv21Db();

      const s1 = makeSnapshot({ origin: "tok1", address: "addrA" });
      const s2 = makeSnapshot({ origin: "tok1", address: "addrB" });

      await db.put(s1);
      await db.put(s2);

      const list = await db.listByPublicKey(PK1);
      expect(list).toHaveLength(2);

      const addresses = list.map((s) => s.address).sort();
      expect(addresses).toEqual(["addrA", "addrB"]);
    });
  });

  // 场景 2：按 publicKeyHex 删除
  describe("按 publicKeyHex 删除", () => {
    it("删除一个 publicKeyHex 的数据后，另一个 publicKeyHex 的数据不受影响", async () => {
      const db = createBsv21Db();

      const s1 = makeSnapshot({ origin: "tok1", publicKeyHex: PK1 });
      const s2 = makeSnapshot({ origin: "tok2", publicKeyHex: PK2 });

      await db.put(s1);
      await db.put(s2);

      await db.deleteByPublicKey(PK1);

      const list1 = await db.listByPublicKey(PK1);
      expect(list1).toHaveLength(0);

      const list2 = await db.listByPublicKey(PK2);
      expect(list2).toHaveLength(1);
      expect(list2[0]!.origin).toBe("tok2");
    });
  });

  // 场景 3：replaceByPublicKey 原子性
  describe("replaceByPublicKey 原子性", () => {
    it("替换后旧数据消失、新数据写入", async () => {
      const db = createBsv21Db();

      // 写入初始数据：两个 snapshot
      await db.put(makeSnapshot({ origin: "tok1", address: "addr1" }));
      await db.put(makeSnapshot({ origin: "tok2", address: "addr2" }));

      const before = await db.listByPublicKey(PK1);
      expect(before).toHaveLength(2);

      // 替换为一组新 snapshot
      const replacement = [
        makeSnapshot({ origin: "tok3", address: "addrX" }),
        makeSnapshot({ origin: "tok4", address: "addrY" }),
        makeSnapshot({ origin: "tok5", address: "addrZ" }),
      ];
      await db.replaceByPublicKey(PK1, replacement);

      const after = await db.listByPublicKey(PK1);
      expect(after).toHaveLength(3);

      const origins = after.map((s) => s.origin).sort();
      expect(origins).toEqual(["tok3", "tok4", "tok5"]);
    });

    it("replaceByPublicKey 只影响目标 publicKeyHex，其他 publicKeyHex 数据不变", async () => {
      const db = createBsv21Db();

      await db.put(makeSnapshot({ origin: "tok1", publicKeyHex: PK1 }));
      await db.put(makeSnapshot({ origin: "tok2", publicKeyHex: PK2 }));

      await db.replaceByPublicKey(PK1, [
        makeSnapshot({ origin: "tok_new", publicKeyHex: PK1 }),
      ]);

      const list2 = await db.listByPublicKey(PK2);
      expect(list2).toHaveLength(1);
      expect(list2[0]!.origin).toBe("tok2");
    });
  });

  // 场景 4：version 1 → version 2 升级重建
  describe("version 1 → version 2 升级", () => {
    it("旧版本数据被丢弃，新版本 put/list 正常工作", async () => {
      // 第一步：手动以 version 1 打开 DB，写入旧数据
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          const store = db.createObjectStore("snapshots", {
            keyPath: ["publicKeyHex", "origin"],
          });
          store.createIndex("publicKeyHex", "publicKeyHex", { unique: false });
        };
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("snapshots", "readwrite");
          const store = tx.objectStore("snapshots");
          store.put({ publicKeyHex: PK1, origin: "old_tok", network: "main", address: "old_addr" });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      });

      // 第二步：以当前版本（2）打开，触发 onupgradeneeded 重建 store
      const db = createBsv21Db();

      // 旧数据应在升级时被丢弃
      const list = await db.listByPublicKey(PK1);
      expect(list).toHaveLength(0);

      // 验证新 schema 的 put/list 正常工作
      const snapshot = makeSnapshot({ origin: "new_tok" });
      await db.put(snapshot);

      const listAfter = await db.listByPublicKey(PK1);
      expect(listAfter).toHaveLength(1);
      expect(listAfter[0]!.origin).toBe("new_tok");
    });
  });
});
