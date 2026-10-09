// 派发租约的跨标签页互斥。
//
// 同一浏览器的每个标签页各有 Window 实例、各自的内存锁，但共享 owner 文件存储。
// 这里用同一个存储句柄造出两个「页面」，验证：
//   - 同时抢一笔任务时只有一个成功，另一个拿到 undefined；
//   - 租约到期后可被接管（崩溃的标签页不会永久锁死任务）；
//   - 续租与释放都只对自己的租约生效，不会踩掉别人的。

import { describe, expect, it } from "vitest";

import type { ForumPublishTask, StorageObjectRevision, StorageWriteCondition } from "@keymaster/contracts";

import { createForumRepository, type ForumDispatchLease } from "./forumRepository.js";

/**
 * 支持条件写的内存文件存储。
 *
 * 条件写是这里的关键：`ifNoneMatch` 与 `ifRevision` 都必须真的检查，否则
 * 「两个标签页只有一个拿到租约」就只是内存锁的老问题换了个文件名。
 */
interface ConditionalStore {
  readonly stats: { puts: number; conflicts: number };
  /** 打开「写入前让另一个写入插进来」的窗口：用来真正交错两个写。 */
  onAfterGet(hook: (path: string) => Promise<void>): void;
  onBeforePut(hook: (path: string) => Promise<void>): void;
}

type ConditionalStoreHandle = Parameters<typeof createForumRepository>[0] & ConditionalStore;

function conditionalStore(): ConditionalStoreHandle {
  const files = new Map<string, { bytes: Uint8Array; revision: number }>();
  const stats = { puts: 0, conflicts: 0 };
  const hooks: ((path: string) => Promise<void>)[] = [];
  const getHooks: ((path: string) => Promise<void>)[] = [];
  const store = {
    stats,
    walletGeneration: "gen",
    sessionEpoch: "epoch",
    runGeneration: "run",
    async list() {
      return { files: [...files.keys()].map((path) => ({ path, sizeBytes: files.get(path)?.bytes.byteLength ?? 0 })), nextCursor: null };
    },
    async get(path: string) {
      const entry = files.get(path);
      const snapshot = entry === undefined ? undefined : { path, bytes: entry.bytes, revision: String(entry.revision) as StorageObjectRevision, lastModified: "now" };
      for (const hook of getHooks.splice(0)) await hook(path);
      return snapshot;
    },
    async put(path: string, bytes: Uint8Array, options?: StorageWriteCondition) {
      // 交错点：hook 在判条件之前执行，让另一个写入抢先改变 revision。
      for (const hook of hooks.splice(0)) await hook(path);
      const existing = files.get(path);
      if (options?.ifNoneMatch === true && existing !== undefined) {
        stats.conflicts += 1;
        throw new Error("condition failed: object exists");
      }
      if (options?.ifRevision !== undefined && String(existing?.revision ?? "0") !== options.ifRevision) {
        stats.conflicts += 1;
        throw new Error("condition failed: revision mismatch");
      }
      stats.puts += 1;
      files.set(path, { bytes, revision: (existing?.revision ?? 0) + 1 });
      return { revision: String(files.get(path)?.revision ?? 1) as StorageObjectRevision, lastModified: "now" };
    },
    async delete(path: string, options?: StorageWriteCondition) {
      const existing = files.get(path);
      if (options?.ifRevision !== undefined && String(existing?.revision ?? "0") !== options.ifRevision) {
        stats.conflicts += 1;
        throw new Error("condition failed: revision mismatch");
      }
      files.delete(path);
    },
    async batch() {
      throw new Error("batch not used in this suite");
    },
    close() {},
  };
  (store as unknown as ConditionalStore).onAfterGet = (hook) => { getHooks.push(hook); };
  (store as unknown as ConditionalStore).onBeforePut = (hook) => {
    hooks.push(hook);
  };
  return store as unknown as ConditionalStoreHandle;
}

const TASK_ID = "task-1";
const OWNER = "02".repeat(33);
const TTL_MS = 60_000;

function taskFixture(): ForumPublishTask {
  return {
    taskId: TASK_ID,
    ownerPublicKeyHex: OWNER,
    network: "test",
    forumConfigId: "cfg",
    forumTxid: "ab".repeat(32),
    forumPublicKeyHex: OWNER,
    kind: "reply",
    targetTxid: "cd".repeat(32),
    tipPrice: "0",
    broadcastState: "not-dispatched",
    chainObservation: { state: "unknown", observedAtMs: 0 },
    indexObservation: { state: "unknown", eventAcceptanceQueryable: true, observedAtMs: 0 },
    phase: "budget-confirmed",
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}

function leaseInput(holderId: string) {
  // 栅栏令牌由仓储分配，调用方不提供。
  return {
    taskId: TASK_ID,
    holderId,
    ownerPublicKeyHex: OWNER,
    acquiredAtMs: 1_000,
  } satisfies Omit<ForumDispatchLease, "expiresAtMs" | "fencingToken">;
}

describe("跨标签页派发租约", () => {
  it("两个页面同时抢一笔任务时只有一个成功", async () => {
    const files = conditionalStore();
    // 两个「页面」各自建一个仓储实例，但共享同一个存储：等价于两个标签页。
    const tabA = createForumRepository(files);
    const tabB = createForumRepository(files);

    const [a, b] = await Promise.all([
      tabA.acquireDispatchLease(leaseInput("tab-a"), TTL_MS),
      tabB.acquireDispatchLease(leaseInput("tab-b"), TTL_MS),
    ]);
    const acquired = [a, b].filter((handle) => handle !== undefined);
    expect(acquired).toHaveLength(1);
    // 输的一方看到的是条件写冲突，而不是覆盖了对方的租约。
    expect(files.stats.conflicts).toBeGreaterThan(0);
  });

  it("同一页面重入拿到同一份租约而不是把自己挡在外面", async () => {
    const repository = createForumRepository(conditionalStore());
    const first = await repository.acquireDispatchLease(leaseInput("tab-a"), TTL_MS);
    expect(first).toBeDefined();
    const again = await repository.acquireDispatchLease(leaseInput("tab-a"), TTL_MS);
    expect(again).toBeDefined();
    // 续租把到期时间往后推，不会被自己拒绝。
    const renewed = await again?.renew({ ...(first as { lease: ForumDispatchLease }).lease, expiresAtMs: 0 });
    expect(renewed?.expiresAtMs).toBeGreaterThan(0);
  });

  it("租约过期后可以被接管", async () => {
    let clock = 1_000;
    const files = conditionalStore();
    const tabA = createForumRepository(files, () => clock);
    const tabB = createForumRepository(files, () => clock);
    const held = await tabA.acquireDispatchLease(leaseInput("tab-a"), 1_000);
    expect(held).toBeDefined();
    // 还没过期：接管失败。
    expect(await tabB.acquireDispatchLease(leaseInput("tab-b"), 1_000)).toBeUndefined();
    // 过期之后：接管成功，因此崩溃的标签页不会永久锁死任务。
    clock += 5_000;
    const taken = await tabB.acquireDispatchLease(leaseInput("tab-b"), 1_000);
    expect(taken).toBeDefined();
    expect(taken?.lease.holderId).toBe("tab-b");
  });

  it("释放只删自己的租约", async () => {
    const files = conditionalStore();
    const tabA = createForumRepository(files);
    const tabB = createForumRepository(files);
    const held = await tabA.acquireDispatchLease(leaseInput("tab-a"), TTL_MS);
    await held?.release();
    // A 释放之后 B 才能拿到。
    expect(await tabB.acquireDispatchLease(leaseInput("tab-b"), TTL_MS)).toBeDefined();
  });

  it("损坏的租约记录按不存在处理，不把无法归属的锁留着", async () => {
    const files = conditionalStore();
    await files.put("leases/task-1.json", new TextEncoder().encode("{not json"));
    const repository = createForumRepository(files);
    // 读不出持有者就无法判断是否过期，因此让下一位按创建分支接管。
    const handle = await repository.acquireDispatchLease(leaseInput("tab-a"), TTL_MS);
    expect(handle).toBeDefined();
  });
});

describe("租约失效的栅栏", () => {
  it("每次取得与续租都拿到更大的栅栏令牌", async () => {
    const files = conditionalStore();
    const repository = createForumRepository(files);
    const first = await repository.acquireDispatchLease(leaseInput("tab-a"), TTL_MS);
    const token1 = first?.lease.fencingToken ?? 0;
    expect(token1).toBeGreaterThan(0);
    const renewed = await first?.renew((first as { lease: ForumDispatchLease }).lease);
    // 续租必须推进令牌，否则旧持有者的写入无法与接管方区分。
    expect(renewed?.fencingToken).toBeGreaterThan(token1);
  });

  it("租约被接管后，旧持有者的 assertHeld 失败", async () => {
    let clock = 1_000;
    const files = conditionalStore();
    const tabA = createForumRepository(files, () => clock);
    const tabB = createForumRepository(files, () => clock);
    const held = await tabA.acquireDispatchLease(leaseInput("tab-a"), 1_000);
    expect(await held?.assertHeld()).toBeDefined();
    // A 租约过期后 B 接管。
    clock += 5_000;
    const taken = await tabB.acquireDispatchLease(leaseInput("tab-b"), 1_000);
    expect(taken?.lease.fencingToken).toBeGreaterThan(held?.lease.fencingToken ?? 0);
    // A 恢复后发现自己已经不是持有者：必须失败而不是继续构造。
    await expect(held?.assertHeld()).rejects.toMatchObject({ code: "lease-lost" });
  });

  it("租约过期后 assertHeld 失败，即使还是同一持有者", async () => {
    let clock = 1_000;
    const files = conditionalStore();
    const repository = createForumRepository(files, () => clock);
    const held = await repository.acquireDispatchLease(leaseInput("tab-a"), 1_000);
    clock += 5_000;
    // 慢请求超过 TTL：持有者身份没变，但租约已经不能作为授权使用。
    await expect(held?.assertHeld()).rejects.toMatchObject({ code: "lease-expired" });
  });

  it("续租可以在过期前恢复 assertHeld 的成功", async () => {
    let clock = 1_000;
    const files = conditionalStore();
    const repository = createForumRepository(files, () => clock);
    const held = await repository.acquireDispatchLease(leaseInput("tab-a"), 10_000);
    clock += 3_000;
    const renewed = await held?.renew((held as { lease: ForumDispatchLease }).lease);
    expect(renewed).toBeDefined();
    if (held !== undefined && renewed !== undefined) held.lease = renewed;
    await expect(held?.assertHeld()).resolves.toBeDefined();
  });

  it("旧持有者的阶段推进在租约被接管后被拒绝", async () => {
    let clock = 1_000;
    const files = conditionalStore();
    const tabA = createForumRepository(files, () => clock);
    const tabB = createForumRepository(files, () => clock);
    const base = taskFixture();
    await tabA.writeTask(base);

    const heldA = await tabA.acquireDispatchLease(leaseInput("tab-a"), 1_000);
    await tabA.writeTask({ ...base, phase: "funding-prepared" }, { fencingToken: heldA?.lease.fencingToken });

    clock += 5_000;
    const heldB = await tabB.acquireDispatchLease(leaseInput("tab-b"), 1_000);
    await tabB.writeTask({ ...base, phase: "quote-rechecked" }, { fencingToken: heldB?.lease.fencingToken });

    // A 带着落后令牌回来写入：必须失败，不能覆盖 B 的进展。
    await expect(tabA.writeTask({ ...base, phase: "raw-prepared" }, { fencingToken: heldA?.lease.fencingToken })).rejects.toMatchObject({
      code: "fenced",
    });
    expect((await tabB.readTask(TASK_ID))?.phase).toBe("quote-rechecked");
  });

  it("无令牌写入仍然允许（租约之外的普通路径）", async () => {
    const files = conditionalStore();
    const repository = createForumRepository(files);
    await repository.writeTask(taskFixture());
    await repository.writeTask({ ...taskFixture(), phase: "signed" });
    expect((await repository.readTask(TASK_ID))?.phase).toBe("signed");
  });

  it("真正交错两个阶段写入时，revision 条件写让输的一方失败", async () => {
    const files = conditionalStore();
    const tabA = createForumRepository(files);
    const tabB = createForumRepository(files);
    const base = taskFixture();
    await tabA.writeTask(base);

    const heldA = await tabA.acquireDispatchLease(leaseInput("tab-a"), 60_000);
    expect(heldA).toBeDefined();
    const token = heldA?.lease.fencingToken ?? 0;

    // 交错：A 在「读到 revision」与「真正写入」之间，另一个写入插队。
    //
    // 关键在于插队的写入用的是**同一个合法令牌**（模拟租约续期后同一持有者的另一条
    // 路径，或一次重试沿用了当前令牌）。令牌比较在这里不会拒绝任何一方——两个令牌
    // 相等，谁都不落后——因此只有 revision 条件写能挡住后来者。
    files.onBeforePut?.(async (path) => {
      if (!path.startsWith("publish/")) return;
      await tabB.writeTask({ ...base, phase: "quote-rechecked" }, { fencingToken: token });
    });
    await expect(tabA.writeTask({ ...base, phase: "raw-prepared" }, { fencingToken: token })).rejects.toMatchObject({
      code: "concurrent-write",
    });
    // 插队写入的进展没有被 A 覆盖。
    expect((await tabB.readTask(TASK_ID))?.phase).toBe("quote-rechecked");
  });

it("无令牌写入也保留已保存的栅栏令牌", async () => {
    const files = conditionalStore();
    const repository = createForumRepository(files);
    await repository.writeTask(taskFixture());
    await repository.writeTask({ ...taskFixture(), phase: "funding-prepared" }, { fencingToken: 5 });
    // rollbackToBudget / confirmBudget 走的是无令牌分支：不能抹掉令牌。
    await repository.writeTask({ ...taskFixture(), phase: "budget-confirmed" });
    expect(await repository.readTaskFencingToken(TASK_ID)).toBe(5);
    // 带更小令牌的后续写入因此仍会被正确判为 fenced。
    await expect(repository.writeTask(taskFixture(), { fencingToken: 4 })).rejects.toMatchObject({ code: "fenced" });
  });

it("并发无令牌写入只有一个成功", async () => {
    const files = conditionalStore();
    const repository = createForumRepository(files);
    await repository.writeTask(taskFixture());
    files.onBeforePut?.(async (path) => {
      if (path.startsWith("publish/")) await repository.writeTask({ ...taskFixture(), phase: "signed" });
    });
    // 两个「页面」基于同一份旧记录写不同阶段：后一个必须失败而不是覆盖。
    await expect(repository.writeTask({ ...taskFixture(), phase: "quoted" })).rejects.toMatchObject({
      code: "concurrent-write",
    });
  });

it("释放后重新取得租约，令牌不会退回 1", async () => {
    const files = conditionalStore();
    const repository = createForumRepository(files);
    await repository.writeTask(taskFixture());
    const first = await repository.acquireDispatchLease(leaseInput("tab-a"), 60_000);
    await repository.writeTask({ ...taskFixture(), phase: "funding-prepared" }, { fencingToken: first?.lease.fencingToken });
    const renewed = await first?.renew((first as { lease: ForumDispatchLease }).lease);
    if (first !== undefined && renewed !== undefined) first.lease = renewed;
    await repository.writeTask({ ...taskFixture(), phase: "quote-rechecked" }, { fencingToken: renewed?.fencingToken });
    await first?.release();

    // 模拟「续租后发生报价或网络失败，再重新进入发布」：令牌必须继续前进，
    // 否则重新取得的租约会拿到 1 并被自己保存的更大令牌判为 fenced。
    const second = await repository.acquireDispatchLease(leaseInput("tab-a"), 60_000);
    expect(second?.lease.fencingToken).toBeGreaterThan(renewed?.fencingToken ?? 0);
    await repository.writeTask({ ...taskFixture(), phase: "raw-prepared" }, { fencingToken: second?.lease.fencingToken });
    await expect(repository.writeTask({ ...taskFixture(), phase: "awaiting-index" }, { fencingToken: first?.lease.fencingToken })).rejects.toMatchObject({
      code: "fenced",
    });
  });

it("释放按 revision 条件删除，不会删掉接管方的新版本", async () => {
    let clock = 1_000;
    const files = conditionalStore();
    const tabA = createForumRepository(files, () => clock);
    const tabB = createForumRepository(files, () => clock);
    const heldA = await tabA.acquireDispatchLease(leaseInput("tab-a"), 1_000);
    clock += 5_000;
    const heldB = await tabB.acquireDispatchLease(leaseInput("tab-b"), 1_000);
    // A 迟到地释放：它那一版已经不是当前版本，删除必须无效。
    await heldA?.release();
    await expect(tabB.acquireDispatchLease(leaseInput("tab-c"), 1_000)).resolves.toBeUndefined();
    expect(heldB).toBeDefined();
  });
});

describe("任务内容与 revision 的原子快照", () => {
  it.each([true, false])("读取内容后被插队时旧任务写入失败（带令牌=%s）", async (withToken) => {
    const files = conditionalStore();
    const a = createForumRepository(files), b = createForumRepository(files);
    const base = taskFixture();
    await a.writeTask(base, { fencingToken: 1 });
    files.onAfterGet(async () => {
      await b.writeTask({ ...base, phase: "quote-rechecked" }, { fencingToken: 2 });
    });
    await expect(a.writeTask({ ...base, phase: "raw-prepared" }, withToken ? { fencingToken: 1 } : undefined)).rejects.toMatchObject({ code: "concurrent-write" });
    expect((await b.readTask(TASK_ID))?.phase).toBe("quote-rechecked");
    expect(await b.readTaskFencingToken(TASK_ID)).toBe(2);
  });
});
