// packages/plugin-token-stas/src/stasDb.test.ts
// STAS snapshot DB 单元测试。
// 使用 fake-indexeddb 提供真实 IndexedDB 环境（vitest.setup.ts 全局加载）。

import { describe, it, expect, afterEach } from "vitest";
import { createStasDb } from "./stasDb";
import type { StasTokenSnapshot } from "./stasDb";

const DB_NAME = "keymaster-stas-snapshots";

const PK1 = "pk1111111111111111111111111111111111111111111111111111111111111111";
const PK2 = "pk2222222222222222222222222222222222222222222222222222222222222222";

/**
 * 设置 onversionchange 自动关闭连接，防止 deleteDatabase 阻塞。
 * 设计缘由：createStasDb() 在闭包中缓存 IDBDatabase 连接，afterEach 的
 * deleteDatabase 会因连接未关闭而阻塞（fake-indexeddb 忠实实现了
 * IndexedDB 规范中 deleteDatabase 等待所有连接关闭的行为）。此补丁让
 * 所有连接在收到 versionchange 事件时自动关闭，使 deleteDatabase 正常完成。
 */
const _origOpen = indexedDB.open.bind(indexedDB);
(indexedDB as any).open = (...args: Parameters<typeof indexedDB.open>) => {
  const req = _origOpen(...args);
  req.addEventListener("success", () => {
    const db = req.result as IDBDatabase;
    db.onversionchange = () => db.close();
  });
  return req;
};

/** 构造测试用 snapshot 的辅助函数。 */
function makeSnapshot(
  overrides: Partial<StasTokenSnapshot> & { symbol: string; publicKeyHex?: string },
): StasTokenSnapshot {
  return {
    symbol: overrides.symbol,
    publicKeyHex: overrides.publicKeyHex ?? PK1,
    network: overrides.network ?? "main",
    address: overrides.address ?? "addr1",
    balance: overrides.balance ?? 100,
    issuer: overrides.issuer ?? "",
    syncedAt: overrides.syncedAt ?? "2026-01-01T00:00:00Z",
  };
}

afterEach(async () => {
  const dbs = await indexedDB.databases();
  for (const db of dbs) {
    if (db.name) indexedDB.deleteDatabase(db.name);
  }
});

describe("stasDb", () => {
  it("同地址同 symbol 不同 issuer 可以共存", async () => {
    const db = createStasDb();

    const snapA = makeSnapshot({ symbol: "TOKEN", issuer: "issuerA" });
    const snapB = makeSnapshot({ symbol: "TOKEN", issuer: "issuerB" });

    await db.put(snapA);
    await db.put(snapB);

    const list = await db.listByPublicKey(PK1);
    expect(list).toHaveLength(2);

    const issuers = list.map((s) => s.issuer).sort();
    expect(issuers).toEqual(["issuerA", "issuerB"]);
  });

  it("deleteByPublicKey 只删除指定 publicKeyHex 的数据", async () => {
    const db = createStasDb();

    const snap1 = makeSnapshot({ symbol: "A", publicKeyHex: PK1 });
    const snap2 = makeSnapshot({ symbol: "B", publicKeyHex: PK1 });
    const snap3 = makeSnapshot({ symbol: "C", publicKeyHex: PK2 });

    await db.put(snap1);
    await db.put(snap2);
    await db.put(snap3);

    // 删除 PK1 的数据
    await db.deleteByPublicKey(PK1);

    const list1 = await db.listByPublicKey(PK1);
    expect(list1).toHaveLength(0);

    const list2 = await db.listByPublicKey(PK2);
    expect(list2).toHaveLength(1);
    expect(list2[0]!.symbol).toBe("C");
  });

  it("升级重建：从旧版本打开后 createStasDb 能正常工作", async () => {
    // 第一步：手动以 version 1 打开 DB，创建旧 schema 并写入旧数据
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore("oldStore", { keyPath: "id" });
      };
      request.onsuccess = () => {
        const db = request.result;
        // 写入一条旧数据，验证升级后被丢弃
        const tx = db.transaction("oldStore", "readwrite");
        tx.objectStore("oldStore").put({ id: "old", value: "stale" });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });

    // 第二步：调用 createStasDb() 打开 version 3，触发 onupgradeneeded
    // 旧 store 被删除重建，旧数据丢失
    const db = createStasDb();

    // 旧数据应在升级时被丢弃
    const list = await db.listByPublicKey(PK1);
    expect(list).toHaveLength(0);

    // 验证新 schema 的 put/list 正常工作
    const snap = makeSnapshot({ symbol: "NEW" });
    await db.put(snap);

    const listAfter = await db.listByPublicKey(PK1);
    expect(listAfter).toHaveLength(1);
    expect(listAfter[0]!.symbol).toBe("NEW");
  });
});
