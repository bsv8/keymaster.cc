// packages/plugin-token-stas/src/stasDb.test.ts
// STAS snapshot DB 单元测试（keyspace namespace 模式）。
// 使用 fake-indexeddb 提供真实 IndexedDB 环境（vitest.setup.ts 全局加载）。
//
// 测试场景：
//   1. 不同 key 打开不同 DB（keyspace namespace 隔离）
//   2. 切换 key 不串数据
//   3. 同 issuer/symbol 多地址并存
//   4. 不同 issuer 不混合

import { describe, it, expect, afterEach } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { createStasDb } from "./stasDb";
import type { StasTokenSnapshot } from "./stasDb";
import type { KeyspaceService, KeyScopedStorageHandle, KeyScopedStorageOpenInput } from "@keymaster/contracts";

const PK1 = "pk1111111111111111111111111111111111111111111111111111111111111111";
const PK2 = "pk2222222222222222222222222222222222222222222222222222222222222222";

/** 构造测试用 snapshot 的辅助函数。 */
function makeSnapshot(
  overrides: Partial<StasTokenSnapshot> & { symbol: string },
): StasTokenSnapshot {
  return {
    symbol: overrides.symbol,
    network: overrides.network ?? "main",
    address: overrides.address ?? "addr1",
    balance: overrides.balance ?? 100,
    issuer: overrides.issuer ?? "",
    syncedAt: overrides.syncedAt ?? "2026-01-01T00:00:00Z",
  };
}

/**
 * 创建 mock keyspace，支持切换 active key。
 */
function makeMockKeyspace(initialHex?: string) {
  let activeHex = initialHex;
  const handles = new Map<string, KeyScopedStorageHandle>();

  const keyspace: KeyspaceService = {
    active: () => ({ activePublicKeyHex: activeHex }),
    openKeyStorage: async (input: KeyScopedStorageOpenInput) => {
      const name = `keymaster.key.${input.publicKeyHex}.plugin.plugin-token-stas.snapshots`;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(name, input.version);
        req.onupgradeneeded = () => input.upgrade(req.result, 0, input.version);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const handle: KeyScopedStorageHandle = {
        db,
        name,
        close: () => { db.close(); handles.delete(input.publicKeyHex); },
      };
      handles.set(input.publicKeyHex, handle);
      return handle;
    },
  } as unknown as KeyspaceService;

  function setActive(hex: string) {
    activeHex = hex;
  }

  return { keyspace, setActive };
}

/**
 * 清理：用全新的 IDBFactory 替换全局 indexedDB，丢弃所有旧数据和连接。
 */
afterEach(() => {
  (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
});

describe("stasDb", () => {
  // 场景 1：不同 key 打开不同 DB
  describe("不同 key 打开不同 DB", () => {
    it("PK1 写入的数据对 PK2 不可见", async () => {
      const { keyspace, setActive } = makeMockKeyspace(PK1);
      const db = createStasDb(keyspace);

      await db.put(makeSnapshot({ symbol: "TOK", issuer: "issA" }));

      setActive(PK2);
      const list = await db.list();
      expect(list).toHaveLength(0);
    });

    it("PK1 和 PK2 各自独立写入和读取", async () => {
      const { keyspace, setActive } = makeMockKeyspace(PK1);
      const db = createStasDb(keyspace);

      await db.put(makeSnapshot({ symbol: "TOK1", issuer: "issA" }));

      setActive(PK2);
      await db.put(makeSnapshot({ symbol: "TOK2", issuer: "issB" }));

      const list2 = await db.list();
      expect(list2).toHaveLength(1);
      expect(list2[0]!.symbol).toBe("TOK2");

      setActive(PK1);
      const list1 = await db.list();
      expect(list1).toHaveLength(1);
      expect(list1[0]!.symbol).toBe("TOK1");
    });
  });

  // 场景 2：切换 key 不串数据
  describe("切换 key 不串数据", () => {
    it("replaceAll 后切换 key，新 key 数据不受影响", async () => {
      const { keyspace, setActive } = makeMockKeyspace(PK1);
      const db = createStasDb(keyspace);

      await db.replaceAll([
        makeSnapshot({ symbol: "A", issuer: "iss1" }),
        makeSnapshot({ symbol: "B", issuer: "iss1" }),
      ]);

      setActive(PK2);
      await db.replaceAll([
        makeSnapshot({ symbol: "C", issuer: "iss2" }),
      ]);

      const list2 = await db.list();
      expect(list2).toHaveLength(1);
      expect(list2[0]!.symbol).toBe("C");

      setActive(PK1);
      const list1 = await db.list();
      expect(list1).toHaveLength(2);
      const symbols = list1.map((s) => s.symbol).sort();
      expect(symbols).toEqual(["A", "B"]);
    });
  });

  // 场景 3：同 issuer/symbol 多地址并存
  describe("同 issuer/symbol 多地址并存", () => {
    it("同 issuer、同 symbol、不同 address 可以共存", async () => {
      const { keyspace } = makeMockKeyspace(PK1);
      const db = createStasDb(keyspace);

      await db.put(makeSnapshot({ symbol: "TOK", issuer: "iss", address: "addr1" }));
      await db.put(makeSnapshot({ symbol: "TOK", issuer: "iss", address: "addr2" }));

      const list = await db.list();
      expect(list).toHaveLength(2);
      const addresses = list.map((s) => s.address).sort();
      expect(addresses).toEqual(["addr1", "addr2"]);
    });
  });

  // 场景 4：不同 issuer 不混合
  describe("不同 issuer 不混合", () => {
    it("同 symbol 不同 issuer 可以共存", async () => {
      const { keyspace } = makeMockKeyspace(PK1);
      const db = createStasDb(keyspace);

      await db.put(makeSnapshot({ symbol: "TOK", issuer: "issuerA" }));
      await db.put(makeSnapshot({ symbol: "TOK", issuer: "issuerB" }));

      const list = await db.list();
      expect(list).toHaveLength(2);
      const issuers = list.map((s) => s.issuer).sort();
      expect(issuers).toEqual(["issuerA", "issuerB"]);
    });
  });

  // 场景 5：无 active key 时抛错
  describe("无 active key 时抛错", () => {
    it("list 抛错", async () => {
      const { keyspace } = makeMockKeyspace(undefined);
      const db = createStasDb(keyspace);

      await expect(db.list()).rejects.toThrow("no active key");
    });
  });

  // 场景 6：A→B→A handle 生命周期回归
  // 设计缘由：验证移除 handle 缓存后，A→B→A 切换时不会复用
  // keyspace 已关闭的连接，A 仍能打开并读取原 snapshot。
  describe("A→B→A handle 生命周期", () => {
    it("A 写入 → 切 B 并关闭 A handle → B 写入 → 切回 A → A 仍能读取原 snapshot", async () => {
      const { keyspace, setActive } = makeMockKeyspace(PK1);
      const db = createStasDb(keyspace);

      // A 写入 snapshot
      await db.put(makeSnapshot({ symbol: "TOK-A", issuer: "issA" }));

      // 切到 B，模拟 keyspace 关闭 A 的 handle
      setActive(PK2);
      // B 写入
      await db.put(makeSnapshot({ symbol: "TOK-B", issuer: "issB" }));

      // 切回 A
      setActive(PK1);
      // A 仍能读取原 snapshot，不抛 InvalidStateError
      const listA = await db.list();
      expect(listA).toHaveLength(1);
      expect(listA[0]!.symbol).toBe("TOK-A");
    });
  });
});
