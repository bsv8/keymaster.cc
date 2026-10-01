import { describe, expect, it } from "vitest";
import type { StorageNamespaceBinding } from "@keymaster/contracts";
import { CENTRAL_STORAGE_DECLARATIONS } from "@keymaster/contracts";
import { createIndexedDbWalletStore, type WalletStore } from "../local/indexedDbWalletStore.js";
import { createKeyValueStore } from "./walletKvEngine.js";

function uniqueDatabaseName(label: string): string {
  return "keymaster-kv-gc-test-" + label + "-" + crypto.randomUUID();
}

function bindingFor(label: string, overrides: Partial<StorageNamespaceBinding> = {}): StorageNamespaceBinding {
  return {
    ...CENTRAL_STORAGE_DECLARATIONS.bsvPrice,
    walletGeneration: "wallet-generation-" + label,
    sessionEpoch: "session-epoch-" + label,
    runGeneration: "run-generation-" + label,
    ...overrides,
  };
}

/** 逐页收集某个前缀下的对象路径。 */
async function collectPaths(store: WalletStore, prefix: string): Promise<string[]> {
  const found: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list({
      prefix,
      ...(cursor === undefined ? {} : { cursor }),
      limit: 3,
    });
    found.push(...page.objects.map((object) => object.path));
    cursor = page.nextCursor;
  } while (cursor);
  return found;
}

describe("wallet K-V engine garbage collection", () => {
  it("reclaims the value object a delete detached from every head", async () => {
    const store = createIndexedDbWalletStore({ databaseName: uniqueDatabaseName("orphan") });
    try {
      const kv = createKeyValueStore({ store, binding: bindingFor("orphan") });
      await kv.put("note", { text: "hello" }, { partition: "settings" });
      const prefix = "bsv-price/settings/.keymaster/values/";
      expect(await collectPaths(store, prefix)).toHaveLength(1);

      await kv.delete("note", { partition: "settings" });
      // delete 只改写 head：内容寻址的旧 value object 仍在库里。
      expect(await collectPaths(store, prefix)).toHaveLength(1);

      const result = await kv.collectGarbage({ minAgeMs: 0 });
      expect(result).toMatchObject({ scanned: 1, candidates: 1, deleted: 1, failed: 0 });
      expect(await collectPaths(store, prefix)).toEqual([]);
      kv.close();
    } finally {
      store.close();
    }
  });

  it("keeps the value a live head still references, including across partitions", async () => {
    const store = createIndexedDbWalletStore({ databaseName: uniqueDatabaseName("live") });
    try {
      const kv = createKeyValueStore({ store, binding: bindingFor("live") });
      // 相同内容写进同一个 partition：内容去重让同一 head 内两条引用共用一个 value object。
      await kv.put("a", { text: "shared" }, { partition: "left" });
      await kv.put("b", { text: "shared" }, { partition: "left" });
      const prefix = "bsv-price/settings/.keymaster/values/";
      expect(await collectPaths(store, prefix)).toHaveLength(1);

      // 只从 left 删掉一条引用；b 仍引用同一个 value object。
      await kv.delete("a", { partition: "left" });
      const result = await kv.collectGarbage({ minAgeMs: 0 });
      expect(result.deleted).toBe(0);
      expect(await collectPaths(store, prefix)).toHaveLength(1);
      await expect(kv.get("b", { partition: "left" })).resolves.toMatchObject({ value: { text: "shared" } });
      kv.close();
    } finally {
      store.close();
    }
  });

  it("reclaims one partition's detached value without touching another partition's", async () => {
    const store = createIndexedDbWalletStore({ databaseName: uniqueDatabaseName("cross-partition") });
    try {
      const kv = createKeyValueStore({ store, binding: bindingFor("cross-partition") });
      await kv.put("note", { text: "hello" }, { partition: "left" });
      // 去重只在 partition 内进行：value envelope 里记了归属 partition，跨 partition
      // 共享同一个对象会让另一方读到时归属校验失败。
      await kv.put("note", { text: "hello" }, { partition: "right" });
      const prefix = "bsv-price/settings/.keymaster/values/";
      expect(await collectPaths(store, prefix)).toHaveLength(2);

      // 删掉 left 的引用后只有 left 那份成了孤儿，right 的必须留下。
      await kv.delete("note", { partition: "left" });
      const result = await kv.collectGarbage({ minAgeMs: 0 });
      expect(result).toMatchObject({ scanned: 2, candidates: 1, deleted: 1, failed: 0 });
      expect(await collectPaths(store, prefix)).toHaveLength(1);
      await expect(kv.get("note", { partition: "right" })).resolves.toMatchObject({ value: { text: "hello" } });
      await expect(kv.get("note", { partition: "left" })).resolves.toBeUndefined();
      kv.close();
    } finally {
      store.close();
    }
  });

  it("keeps every head a put created, so collection only ever sees detached values", async () => {
    const store = createIndexedDbWalletStore({ databaseName: uniqueDatabaseName("overwrite") });
    try {
      const kv = createKeyValueStore({ store, binding: bindingFor("overwrite") });
      await kv.put("note", { text: "v1" }, { partition: "settings" });
      await kv.put("note", { text: "v2" }, { partition: "settings" });
      const prefix = "bsv-price/settings/.keymaster/values/";
      expect(await collectPaths(store, prefix)).toHaveLength(2);

      const result = await kv.collectGarbage({ minAgeMs: 0 });
      expect(result.deleted).toBe(1);
      expect(await collectPaths(store, prefix)).toHaveLength(1);
      // 幸存者必须仍是当前 head 指向的那个值。
      await expect(kv.get("note", { partition: "settings" })).resolves.toMatchObject({ value: { text: "v2" } });
      kv.close();
    } finally {
      store.close();
    }
  });

  it("honours minAgeMs so an in-flight value is never removed", async () => {
    const store = createIndexedDbWalletStore({ databaseName: uniqueDatabaseName("age") });
    try {
      let clock = 1_000;
      const kv = createKeyValueStore({ store, binding: bindingFor("age"), now: () => clock });
      await kv.put("note", { text: "fresh" }, { partition: "settings" });
      await kv.delete("note", { partition: "settings" });

      // minAgeMs 门槛内：只判定为候选，不删。
      clock = 1_500;
      const young = await kv.collectGarbage({ minAgeMs: 1_000 });
      expect(young).toMatchObject({ scanned: 1, candidates: 0, deleted: 0 });
      expect(await collectPaths(store, "bsv-price/settings/.keymaster/values/")).toHaveLength(1);

      // 超过门槛后才回收。
      clock = 2_500;
      const old = await kv.collectGarbage({ minAgeMs: 1_000 });
      expect(old).toMatchObject({ candidates: 1, deleted: 1, failed: 0 });
      expect(await collectPaths(store, "bsv-price/settings/.keymaster/values/")).toEqual([]);
      kv.close();
    } finally {
      store.close();
    }
  });

  it("caps one pass at maxDeletes and finishes on the next pass", async () => {
    const store = createIndexedDbWalletStore({ databaseName: uniqueDatabaseName("cap") });
    try {
      const kv = createKeyValueStore({ store, binding: bindingFor("cap") });
      for (let index = 0; index < 5; index += 1) {
        await kv.put(`note-${index}`, { text: `v-${index}` }, { partition: "settings" });
        await kv.put(`note-${index}`, { text: `v-${index}-replaced` }, { partition: "settings" });
      }
      const prefix = "bsv-price/settings/.keymaster/values/";
      expect(await collectPaths(store, prefix)).toHaveLength(10);

      const first = await kv.collectGarbage({ minAgeMs: 0, maxDeletes: 3 });
      // 每个 note 只有一个被换掉的旧值是孤儿：10 个对象里 5 个仍被 head 引用。
      expect(first).toMatchObject({ scanned: 10, candidates: 5, deleted: 3, failed: 0 });
      expect(await collectPaths(store, prefix)).toHaveLength(7);

      const second = await kv.collectGarbage({ minAgeMs: 0, maxDeletes: 3 });
      // 剩下 2 个孤儿不足一整批上限，一次就收完。
      expect(second).toMatchObject({ scanned: 7, candidates: 2, deleted: 2, failed: 0 });
      expect(await collectPaths(store, prefix)).toHaveLength(5);

      const third = await kv.collectGarbage({ minAgeMs: 0, maxDeletes: 3 });
      expect(third).toMatchObject({ scanned: 5, candidates: 0, deleted: 0, failed: 0 });
      expect(await collectPaths(store, prefix)).toHaveLength(5);
      for (let index = 0; index < 5; index += 1) {
        await expect(kv.get(`note-${index}`, { partition: "settings" })).resolves.toMatchObject({ value: { text: `v-${index}-replaced` } });
      }
      kv.close();
    } finally {
      store.close();
    }
  });

  it("counts a conditional-delete conflict as failed and keeps the object for the next pass", async () => {
    const backing = createIndexedDbWalletStore({ databaseName: uniqueDatabaseName("conflict") });
    let stealOnDelete = true;
    // GC 是先读到 revision 再条件删除；用一个抢写代理把这一步变成真实的并发冲突。
    const store: WalletStore = {
      ...backing,
      delete: async (path, options) => {
        if (stealOnDelete) {
          stealOnDelete = false;
          const observed = await backing.get(path, { ifRevision: options?.ifRevision });
          if (observed) await backing.put(path, observed.bytes, { ifRevision: observed.revision });
        }
        return backing.delete(path, options);
      },
    };
    try {
      const kv = createKeyValueStore({ store, binding: bindingFor("conflict") });
      await kv.put("note", { text: "v1" }, { partition: "settings" });
      await kv.put("note", { text: "v2" }, { partition: "settings" });
      await kv.delete("note", { partition: "settings" });

      const prefix = "bsv-price/settings/.keymaster/values/";
      // v1 被覆盖写换下、v2 被 delete 摘掉，两个都是孤儿。
      const result = await kv.collectGarbage({ minAgeMs: 0 });
      expect(result).toMatchObject({ candidates: 2, deleted: 1, failed: 1 });
      // 冲突时保留对象；下一轮条件不再冲突，正常回收。
      expect(await collectPaths(store, prefix)).toHaveLength(1);
      const retry = await kv.collectGarbage({ minAgeMs: 0 });
      expect(retry).toMatchObject({ candidates: 1, deleted: 1, failed: 0 });
      expect(await collectPaths(store, prefix)).toHaveLength(0);
      kv.close();
    } finally {
      backing.close();
    }
  });

  it("never decodes a foreign object it cannot parse and fails closed on a stale handle", async () => {
    const store = createIndexedDbWalletStore({ databaseName: uniqueDatabaseName("foreign") });
    try {
      const kv = createKeyValueStore({ store, binding: bindingFor("foreign") });
      // 同前缀下的未知对象：本引擎没写过，宁可保留也不猜。
      await store.put("bsv-price/settings/.keymaster/values/not-a-value-object", new TextEncoder().encode("garbage"));

      const result = await kv.collectGarbage({ minAgeMs: 0 });
      expect(result).toMatchObject({ scanned: 1, candidates: 0, deleted: 0 });
      expect(await store.get("bsv-price/settings/.keymaster/values/not-a-value-object")).toBeDefined();

      kv.close();
      await expect(kv.collectGarbage({ minAgeMs: 0 })).rejects.toThrow();
    } finally {
      store.close();
    }
  });

  it("rejects nonsensical sweep bounds instead of deleting without a limit", async () => {
    const store = createIndexedDbWalletStore({ databaseName: uniqueDatabaseName("bounds") });
    try {
      const kv = createKeyValueStore({ store, binding: bindingFor("bounds") });
      await expect(kv.collectGarbage({ minAgeMs: -1 })).rejects.toThrow();
      await expect(kv.collectGarbage({ maxDeletes: -1 })).rejects.toThrow();
      await expect(kv.collectGarbage({ maxDeletes: 1.5 })).rejects.toThrow();
      kv.close();
    } finally {
      store.close();
    }
  });
});
