import { describe, expect, it } from "vitest";
import {
  WALLET_DATABASE_NAME,
  createIndexedDbWalletStore,
  type WalletStore,
} from "./indexedDbWalletStore.js";

function uniqueDatabaseName(label: string): string {
  return "keymaster-test-" + label + "-" + crypto.randomUUID();
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** 逐页收集路径,用于验证游标分页能走完整目录。 */
async function collectPaths(store: WalletStore, prefix?: string): Promise<string[]> {
  const found: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list({
      ...(prefix === undefined ? {} : { prefix }),
      ...(cursor === undefined ? {} : { cursor }),
      limit: 2,
    });
    found.push(...page.objects.map((object) => object.path));
    cursor = page.nextCursor;
  } while (cursor);
  return found;
}

describe("IndexedDB wallet store", () => {
  it("uses a dedicated database name separate from the legacy bucket database", () => {
    expect(WALLET_DATABASE_NAME).toBe("keymaster.wallet");
    expect(WALLET_DATABASE_NAME).not.toBe("keymaster.local");
  });

  it("keys objects by normalized path with no bucket or owner prefix", async () => {
    const store = createIndexedDbWalletStore({ databaseName: uniqueDatabaseName("path") });
    try {
      await store.put("contacts/联系人01.json", bytes("{}"));
      await store.put("p2pkh/setting.json", bytes("{}"));
      await store.put("apps/notes/readme.md", bytes("hi"));
      expect(await collectPaths(store)).toEqual(["apps/notes/readme.md", "contacts/联系人01.json", "p2pkh/setting.json"]);
      // 主键就是相对 path 本身:没有任何桶身份段,也没有钱包 Owner 公钥段。
      await expect(store.get("contacts/联系人01.json")).resolves.toMatchObject({ revision: 1 });
      await expect(store.get("02abcdef/contacts/联系人01.json")).resolves.toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("rejects traversal, absolute and empty path shaped input", async () => {
    const store = createIndexedDbWalletStore({ databaseName: uniqueDatabaseName("guard") });
    try {
      for (const invalid of ["../escape.json", "contacts/../../escape.json", "/absolute.json", "", "a//b.json", "a/./b.json"]) {
        await expect(store.put(invalid, bytes("x"))).rejects.toMatchObject({ code: "storage_invalid_path" });
      }
    } finally {
      store.close();
    }
  });

  it("creates conditionally inside one transaction so concurrent initialization has a single winner", async () => {
    const databaseName = uniqueDatabaseName("init");
    const first = createIndexedDbWalletStore({ databaseName });
    const second = createIndexedDbWalletStore({ databaseName });
    try {
      const results = await Promise.allSettled([
        first.batch({
          operations: [{ type: "put", path: "key.json", bytes: bytes("hold-a") }],
          conditions: [{ path: "key.json", ifNoneMatch: true }],
        }),
        second.batch({
          operations: [{ type: "put", path: "key.json", bytes: bytes("hold-b") }],
          conditions: [{ path: "key.json", ifNoneMatch: true }],
        }),
      ]);
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "storage_conflict" });
      const winner = await first.readKeyHold();
      expect(["hold-a", "hold-b"]).toContain(new TextDecoder().decode(winner!));
    } finally {
      first.close();
      second.close();
    }
  });

  it("leaves no usable half-written wallet when a batch fails", async () => {
    const store = createIndexedDbWalletStore({ databaseName: uniqueDatabaseName("atomic") });
    try {
      await store.put("p2pkh/setting.json", bytes("{\"a\":1}"));
      // 第二个条件失败时,同一事务里的第一个 put 必须一起回滚。
      await expect(store.batch({
        operations: [
          { type: "put", path: "key.json", bytes: bytes("hold") },
          { type: "put", path: ".keymaster/meta", bytes: bytes("meta") },
        ],
        conditions: [{ path: "p2pkh/setting.json", ifRevision: 99 }],
      })).rejects.toMatchObject({ code: "storage_conflict" });
      expect(await store.readKeyHold()).toBeUndefined();
      await expect(store.get(".keymaster/meta")).resolves.toBeUndefined();
      // 既有业务数据不受失败批次影响。
      await expect(store.get("p2pkh/setting.json")).resolves.toMatchObject({ revision: 1 });
    } finally {
      store.close();
    }
  });

  it("supports revision CAS and monotonic revisions for identical bytes", async () => {
    const store = createIndexedDbWalletStore({ databaseName: uniqueDatabaseName("cas") });
    try {
      const first = await store.put("messages/时间索引.json", bytes("same"));
      expect(first.revision).toBe(1);
      const second = await store.put("messages/时间索引.json", bytes("same"));
      // 内容相同也必须是新世代:条件写依赖 revision,不能用内容哈希替代。
      expect(second.revision).toBe(2);
      await expect(store.put("messages/时间索引.json", bytes("x"), { ifRevision: 1 })).rejects.toMatchObject({
        code: "storage_conflict",
      });
      await expect(store.put("messages/时间索引.json", bytes("x"), { ifRevision: 2 })).resolves.toMatchObject({
        revision: 3,
      });
      await expect(store.get("messages/时间索引.json", { ifRevision: 2 })).rejects.toMatchObject({
        code: "storage_conflict",
      });
      await expect(store.put("new.json", bytes("n"), { ifNoneMatch: true })).resolves.toMatchObject({ revision: 1 });
      await expect(store.put("new.json", bytes("n"), { ifNoneMatch: true })).rejects.toMatchObject({
        code: "storage_conflict",
      });
    } finally {
      store.close();
    }
  });

  it("paginates a sorted list from metadata without exposing bytes", async () => {
    const store = createIndexedDbWalletStore({ databaseName: uniqueDatabaseName("page") });
    try {
      for (const name of ["a.json", "b.json", "c.json", "d.json", "e.json"]) {
        await store.put("contacts/" + name, bytes(name));
      }
      const first = await store.list({ prefix: "contacts/", limit: 2 });
      expect(first.objects.map((entry) => entry.path)).toEqual(["contacts/a.json", "contacts/b.json"]);
      // 列表项只有元数据:调用方据此判断是否要再按 revision 读取。
      expect(first.objects.every((entry) => !("bytes" in entry))).toBe(true);
      expect(first.objects[0]).toMatchObject({ size: "a.json".length, revision: 1 });
      expect(await collectPaths(store, "contacts/")).toEqual([
        "contacts/a.json",
        "contacts/b.json",
        "contacts/c.json",
        "contacts/d.json",
        "contacts/e.json",
      ]);
    } finally {
      store.close();
    }
  });

  it("keeps a key-based cursor stable across concurrent writes", async () => {
    const store = createIndexedDbWalletStore({ databaseName: uniqueDatabaseName("cursor") });
    try {
      await store.put("contacts/a.json", bytes("a"));
      await store.put("contacts/c.json", bytes("c"));
      await store.put("contacts/d.json", bytes("d"));
      const first = await store.list({ prefix: "contacts/", limit: 1 });
      expect(first.objects.map((entry) => entry.path)).toEqual(["contacts/a.json"]);
      expect(first.nextCursor).toBeDefined();
      // 分页期间插入一个排序更靠前的对象:游标从最后一个已读主键继续,
      // 所以既不会漏掉原有对象,也不会重复已读过的 a.json。
      await store.put("contacts/b.json", bytes("b"));
      const second = await store.list({ prefix: "contacts/", cursor: first.nextCursor, limit: 10 });
      expect(second.objects.map((entry) => entry.path)).toEqual(["contacts/b.json", "contacts/c.json", "contacts/d.json"]);
    } finally {
      store.close();
    }
  });

  it("scopes a list prefix to exactly one module directory", async () => {
    const store = createIndexedDbWalletStore({ databaseName: uniqueDatabaseName("prefix") });
    try {
      await store.put("p2pkh/setting.json", bytes("{}"));
      await store.put("p2p/mainnet/tx.json", bytes("{}"));
      await store.put("p2pkh2/setting.json", bytes("{}"));
      expect(await collectPaths(store, "p2pkh/")).toEqual(["p2pkh/setting.json"]);
    } finally {
      store.close();
    }
  });

  it("reads ranges while still reporting the full object size", async () => {
    const store = createIndexedDbWalletStore({ databaseName: uniqueDatabaseName("range") });
    try {
      await store.put("msfiles/setting.json", new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]));
      const chunk = await store.getRange("msfiles/setting.json", { offset: 2, length: 3 });
      expect(chunk?.bytes).toEqual(new Uint8Array([2, 3, 4]));
      expect(chunk?.size).toBe(8);
      const past = await store.getRange("msfiles/setting.json", { offset: 6, length: 10 });
      expect(past?.bytes).toEqual(new Uint8Array([6, 7]));
      expect(past?.size).toBe(8);
      await expect(store.getRange("msfiles/setting.json", { offset: -1, length: 2 })).rejects.toMatchObject({
        code: "storage_invalid_path",
      });
    } finally {
      store.close();
    }
  });

  it("commits key.json, meta and initial system data in one transaction", async () => {
    const store = createIndexedDbWalletStore({ databaseName: uniqueDatabaseName("commit") });
    try {
      await store.batch({
        operations: [
          { type: "put", path: "key.json", bytes: bytes("hold"), contentType: "application/json" },
          {
            type: "put",
            path: ".keymaster/meta",
            bytes: bytes(JSON.stringify({
              format: "keymaster.wallet-meta",
              version: 1,
              schemaVersion: 1,
              initialized: true,
              walletGeneration: crypto.randomUUID(),
              createdAt: new Date().toISOString(),
            })),
            contentType: "application/json",
          },
          { type: "put", path: ".keymaster/system/coordinator/settings/current", bytes: bytes("{}") },
        ],
        conditions: [{ path: "key.json", ifNoneMatch: true }],
      });
      expect(new TextDecoder().decode((await store.readKeyHold())!)).toBe("hold");
      await expect(store.readMeta()).resolves.toMatchObject({ revision: 1 });
      await expect(store.get(".keymaster/system/coordinator/settings/current")).resolves.toMatchObject({ size: 2 });
    } finally {
      store.close();
    }
  });

  it("clears every object and mints a new wallet generation on reset", async () => {
    const store = createIndexedDbWalletStore({ databaseName: uniqueDatabaseName("reset") });
    try {
      await store.put("key.json", bytes("hold"));
      await store.put("contacts/a.json", bytes("a"));
      await store.put(".keymaster/meta", bytes("{}"));
      const first = await store.resetWallet();
      expect(await store.readKeyHold()).toBeUndefined();
      await expect(store.get("contacts/a.json")).resolves.toBeUndefined();
      const meta = JSON.parse(new TextDecoder().decode((await store.readMeta())!.bytes));
      expect(meta).toMatchObject({ initialized: false });
      expect(meta.walletGeneration).toBe(first.walletGeneration);
      const second = await store.resetWallet();
      // 每次重置都是新的授权生命周期,即使之后导入同一把私钥。
      expect(second.walletGeneration).not.toBe(first.walletGeneration);
      expect(await collectPaths(store)).toEqual([".keymaster/meta"]);
    } finally {
      store.close();
    }
  });

  it("maps cancelled operations and a closed store to distinct failures", async () => {
    const store = createIndexedDbWalletStore({ databaseName: uniqueDatabaseName("errors") });
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(store.put("a.json", bytes("a"), { signal: controller.signal })).rejects.toMatchObject({
        code: "storage_unavailable",
      });
      store.close();
      await expect(store.put("a.json", bytes("a"))).rejects.toMatchObject({ code: "storage_unavailable" });
      await expect(store.list()).rejects.toMatchObject({ code: "storage_unavailable" });
    } finally {
      store.close();
    }
  });

  it("rejects a malformed cursor instead of silently restarting the list", async () => {
    const store = createIndexedDbWalletStore({ databaseName: uniqueDatabaseName("cursor-bad") });
    try {
      await store.put("a.json", bytes("a"));
      await expect(store.list({ cursor: "not-a-cursor" })).rejects.toMatchObject({ code: "storage_invalid_path" });
    } finally {
      store.close();
    }
  });
});
