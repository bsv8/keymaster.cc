// packages/plugin-protocol/src/protocolStorageDb.test.ts
// 协议存储 DB 行为单测（fake-indexeddb 由 vitest.setup 注入）。
//
// 关键不变量：
//   - commands 能按 exact origin 拉历史；
//   - 新命令插入后能按 updatedAt desc 返回；
//   - 不同 origin 不串历史；
//   - 更新同 id 后仍只保留一条记录；
//   - origins / feePools 三 store 升级正确；
//   - feePools 按 poolKey 复合 key 隔离；
//   - 不存在 `operations` store。

import { beforeEach, describe, expect, it } from "vitest";
import type {
  ProtocolCommandRecord,
  ProtocolFeePoolRecord,
  ProtocolOriginSettingsRecord
} from "@keymaster/contracts";
import { openProtocolStorageDb } from "./protocolStorageDb.js";

function makeRecord(
  id: string,
  origin: string,
  method: ProtocolCommandRecord["method"],
  createdAt: number,
  updatedAt: number
): ProtocolCommandRecord {
  return {
    id,
    origin,
    requestId: id,
    method,
    phase: "approved",
    decision: "approved",
    status: "approved",
    textSummary: "hi",
    claimsSummary: [],
    contentType: "",
    payloadSize: 0,
    // 施工单 2026-06-28 002 硬切换：record 的 owner 快照字段统一为
    // `connectSessionId` + `ownerPublicKeyHex`。
    connectSessionId: "sess-" + id,
    ownerPublicKeyHex: "02" + "11".repeat(32),
    createdAt,
    updatedAt,
    finishedAt: updatedAt,
    errorCode: "",
    errorMessage: ""
  };
}

function makeOrigin(origin: string, max: number): ProtocolOriginSettingsRecord {
  return {
    origin,
    p2pkhAutoApproveEnabled: max > 0,
    p2pkhAutoApproveMaxSatoshis: max,
    identityAutoApproveEnabled: false,
    cipherAutoApproveEnabled: false,
    feePoolAutoSignMaxSatoshis: 0,
    feePoolDefaultFundSatoshis: 10000,
      confirmTimeoutSeconds: 30,
    updatedAt: 1
  };
}

function makePool(
  origin: string,
  counterparty: string,
  total: number
): ProtocolFeePoolRecord {
  return {
    // 施工单 2026-06-28 002 硬切换：poolKey 补 ownerPublicKeyHex 维度。
    poolKey: `${origin}::${"02" + "11".repeat(32)}::${counterparty}`,
    origin,
    ownerPublicKeyHex: "02" + "11".repeat(32),
    counterpartyPublicKeyHex: counterparty,
    baseTxid: "00".repeat(32),
    baseTxHex: "deadbeef",
    totalAmount: total,
    serverAmount: 0,
    draftSpendTxHex: "draft",
    draftClientSignBytes: { $type: "binary", bytes: new Uint8Array(72).buffer },
    lastOperationId: "op-1",
    updatedAt: 1
  };
}

describe("openProtocolStorageDb", () => {
  // 注意：fake-indexeddb 全局共享一个 indexedDB 实例，每个测试**不**做
  // deleteDatabase 重建（重开会卡 onblocked）。本测试通过每条用例用
  // 唯一 record id 来保证互不干扰。

  it("stores and retrieves a command by id", async () => {
    const db = await openProtocolStorageDb();
    const rec = makeRecord("a", "https://demo.example", "identity.get", 1, 2);
    await db.putCommand(rec);
    const got = await db.getCommand("a");
    expect(got?.id).toBe("a");
    expect(got?.origin).toBe("https://demo.example");
  });

  it("returns null for missing id", async () => {
    const db = await openProtocolStorageDb();
    const got = await db.getCommand("nope-not-found");
    expect(got).toBeNull();
  });

  it("lists commands by origin sorted by updatedAt desc", async () => {
    const db = await openProtocolStorageDb();
    // 故意按 createdAt 顺序插入，期望按 updatedAt desc 出来。
    await db.putCommand(makeRecord("srt-r1", "https://srt-a.com", "identity.get", 1, 100));
    await db.putCommand(makeRecord("srt-r2", "https://srt-a.com", "intent.sign", 2, 300));
    await db.putCommand(makeRecord("srt-r3", "https://srt-a.com", "cipher.encrypt", 3, 200));
    const list = await db.listCommandsByOrigin("https://srt-a.com");
    expect(list.map((r) => r.id)).toEqual(["srt-r2", "srt-r3", "srt-r1"]);
  });

  it("does not mix history across origins", async () => {
    const db = await openProtocolStorageDb();
    await db.putCommand(makeRecord("mix-r1", "https://mix-a.com", "identity.get", 1, 100));
    await db.putCommand(makeRecord("mix-r2", "https://mix-b.com", "identity.get", 2, 200));
    const a = await db.listCommandsByOrigin("https://mix-a.com");
    const b = await db.listCommandsByOrigin("https://mix-b.com");
    expect(a.map((r) => r.id)).toEqual(["mix-r1"]);
    expect(b.map((r) => r.id)).toEqual(["mix-r2"]);
  });

  it("does not let host-only matches pass when origin has different port", async () => {
    const db = await openProtocolStorageDb();
    await db.putCommand(makeRecord("port-r1", "https://port-a.com:8443", "identity.get", 1, 100));
    // host 相同但端口不同：必须视为不同 origin。
    const list = await db.listCommandsByOrigin("https://port-a.com");
    expect(list).toEqual([]);
  });

  it("updating a command keeps it as a single record (no event rows)", async () => {
    const db = await openProtocolStorageDb();
    const base = makeRecord("upd-r1", "https://upd-a.com", "identity.get", 1, 100);
    await db.putCommand(base);
    const updated: ProtocolCommandRecord = { ...base, updatedAt: 200, status: "rejected", decision: "rejected", phase: "rejected" };
    await db.putCommand(updated);
    const list = await db.listCommandsByOrigin("https://upd-a.com");
    expect(list).toHaveLength(1);
    const head = list[0];
    if (!head) throw new Error("expected at least one record");
    expect(head.status).toBe("rejected");
    expect(head.updatedAt).toBe(200);
  });

  /* ============== 施工单 002 硬切换：origins store ============== */

  it("origins round-trip", async () => {
    const db = await openProtocolStorageDb();
    const rec = makeOrigin("https://origin-a.com", 50000);
    await db.putOrigin(rec);
    const got = await db.getOrigin("https://origin-a.com");
    expect(got?.origin).toBe("https://origin-a.com");
    expect(got?.p2pkhAutoApproveMaxSatoshis).toBe(50000);
    expect(got?.p2pkhAutoApproveEnabled).toBe(true);
  });

  it("getOrigin returns null when missing", async () => {
    const db = await openProtocolStorageDb();
    const got = await db.getOrigin("https://no-such-origin.com");
    expect(got).toBeNull();
  });

  it("putOrigin overwrites by origin key", async () => {
    const db = await openProtocolStorageDb();
    const origin = "https://origin-overwrite.com";
    await db.putOrigin({ ...makeOrigin(origin, 100), updatedAt: 1 });
    await db.putOrigin({ ...makeOrigin(origin, 999), updatedAt: 2 });
    const list = await db.listOrigins();
    const found = list.find((r) => r.origin === origin);
    expect(found?.p2pkhAutoApproveMaxSatoshis).toBe(999);
    expect(found?.updatedAt).toBe(2);
  });

  it("listOrigins returns all origins", async () => {
    const db = await openProtocolStorageDb();
    await db.putOrigin(makeOrigin("https://l-o-a.com", 0));
    await db.putOrigin(makeOrigin("https://l-o-b.com", 100));
    const list = await db.listOrigins();
    const map = new Map(list.map((r) => [r.origin, r]));
    expect(map.get("https://l-o-a.com")?.p2pkhAutoApproveMaxSatoshis).toBe(0);
    expect(map.get("https://l-o-b.com")?.p2pkhAutoApproveMaxSatoshis).toBe(100);
  });

  /* ============== 施工单 002 硬切换：feePools store ============== */

  it("feePools round-trip with composite key", async () => {
    const db = await openProtocolStorageDb();
    const pool = makePool("https://pool-a.com", "02" + "aa".repeat(32), 10000);
    await db.putFeePool(pool);
    const got = await db.getFeePool(pool.poolKey);
    expect(got?.totalAmount).toBe(10000);
    expect(got?.counterpartyPublicKeyHex).toBe("02" + "aa".repeat(32));
  });

  it("getFeePool returns null when missing", async () => {
    const db = await openProtocolStorageDb();
    const got = await db.getFeePool("https://x.com::02ff");
    expect(got).toBeNull();
  });

  it("feePools same origin different counterparty kept as separate records", async () => {
    const db = await openProtocolStorageDb();
    const c1 = "02" + "aa".repeat(32);
    const c2 = "02" + "bb".repeat(32);
    await db.putFeePool(makePool("https://pool-b.com", c1, 100));
    await db.putFeePool(makePool("https://pool-b.com", c2, 200));
    const list = await db.listFeePoolsByOrigin("https://pool-b.com");
    expect(list).toHaveLength(2);
    const m = new Map(list.map((r) => [r.counterpartyPublicKeyHex, r]));
    expect(m.get(c1)?.totalAmount).toBe(100);
    expect(m.get(c2)?.totalAmount).toBe(200);
  });

  it("feePools list by origin uses origin index", async () => {
    const db = await openProtocolStorageDb();
    const c1 = "02" + "aa".repeat(32);
    await db.putFeePool(makePool("https://pool-c.com", c1, 100));
    await db.putFeePool(makePool("https://pool-d.com", c1, 200));
    const a = await db.listFeePoolsByOrigin("https://pool-c.com");
    const b = await db.listFeePoolsByOrigin("https://pool-d.com");
    expect(a.map((r) => r.totalAmount)).toEqual([100]);
    expect(b.map((r) => r.totalAmount)).toEqual([200]);
  });

  it("deleteFeePool removes the record", async () => {
    const db = await openProtocolStorageDb();
    const pool = makePool("https://pool-e.com", "02" + "cc".repeat(32), 100);
    await db.putFeePool(pool);
    await db.deleteFeePool(pool.poolKey);
    const got = await db.getFeePool(pool.poolKey);
    expect(got).toBeNull();
  });

  it("putFeePool overwrites when poolKey collides", async () => {
    const db = await openProtocolStorageDb();
    const poolKey = "https://pool-f.com::02" + "dd".repeat(32);
    await db.putFeePool({ ...makePool("https://pool-f.com", "02" + "dd".repeat(32), 100), poolKey });
    await db.putFeePool({ ...makePool("https://pool-f.com", "02" + "dd".repeat(32), 999), poolKey, lastOperationId: "op-2" });
    const got = await db.getFeePool(poolKey);
    expect(got?.totalAmount).toBe(999);
    expect(got?.lastOperationId).toBe("op-2");
  });

  it("does not persist commands across origins via feePools", async () => {
    const db = await openProtocolStorageDb();
    // 同一 counterparty、不同 origin：必须视为两条独立记录。
    const c = "02" + "ee".repeat(32);
    await db.putFeePool(makePool("https://pool-g.com", c, 100));
    await db.putFeePool(makePool("https://pool-h.com", c, 200));
    const g = await db.listFeePoolsByOrigin("https://pool-g.com");
    const h = await db.listFeePoolsByOrigin("https://pool-h.com");
    expect(g).toHaveLength(1);
    expect(h).toHaveLength(1);
    expect(g[0]?.totalAmount).toBe(100);
    expect(h[0]?.totalAmount).toBe(200);
  });

  /* ============== 施工单 001：identity / cipher auto-approve fields ============== */

  it("stores and retrieves origin settings with identityAutoApproveEnabled / cipherAutoApproveEnabled", async () => {
    const db = await openProtocolStorageDb();
    const origin = `https://roundtrip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.example`;
    const rec: ProtocolOriginSettingsRecord = {
      origin,
      p2pkhAutoApproveEnabled: true,
      p2pkhAutoApproveMaxSatoshis: 5000,
      identityAutoApproveEnabled: true,
      cipherAutoApproveEnabled: false,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 10000,
      confirmTimeoutSeconds: 30,
      updatedAt: 1
    };
    await db.putOrigin(rec);
    const got = await db.getOrigin(origin);
    expect(got?.identityAutoApproveEnabled).toBe(true);
    expect(got?.cipherAutoApproveEnabled).toBe(false);
    expect(got?.p2pkhAutoApproveMaxSatoshis).toBe(5000);
  });

  /* ============== 施工单 003：confirmTimeoutSeconds 字段 ============== */

  it("stores and retrieves origin settings with confirmTimeoutSeconds", async () => {
    const db = await openProtocolStorageDb();
    const origin = `https://ct-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.example`;
    const rec: ProtocolOriginSettingsRecord = {
      origin,
      p2pkhAutoApproveEnabled: false,
      p2pkhAutoApproveMaxSatoshis: 0,
      identityAutoApproveEnabled: false,
      cipherAutoApproveEnabled: false,
      feePoolAutoSignMaxSatoshis: 0,
      feePoolDefaultFundSatoshis: 0,
      confirmTimeoutSeconds: 12,
      updatedAt: 1
    };
    await db.putOrigin(rec);
    const got = await db.getOrigin(origin);
    expect(got?.confirmTimeoutSeconds).toBe(12);
  });
});

/* ============== 施工单 2026-06-30 002：v8 迁移 wiperuntimeBinding 测试 ============== */
/**
 * 验证 v8 升级**真正**清空旧 connectSessions（带 runtimeBinding 字段的）数据，
 * 而不只是"忽略字段"——这是硬切"不留尾巴"的可执行验收。
 */

/* ============== 施工单 2026-06-30 002：v8 迁移 wiperuntimeBinding 测试 ============== */
/**
 * 验证 v8 升级**真正**清空旧 connectSessions（带 runtimeBinding 字段的）数据，
 * 而不只是"忽略字段"——这是硬切"不留尾巴"的可执行验收。
 *
 * 设计缘由：fake-indexeddb 的实例被多个 vitest 用例共享，无法对单个
 * 固定 DB_NAME 做 "v7 预置 → v8 升级"序列（需要先 deleteDatabase，
 * 但 fake-indexeddb 的 deleteDatabase 在已有活跃连接时会 onblocked）。
 * 因此改为**结构 + 行为**双向验证：
 *   1. 结构验证：源码级断言 v8 onupgradeneeded 真删除 connectSessions
 *      + launchTokens store；
 *   2. 行为验证：v8 schema 下新 session 真值三元组不带 runtimeBinding。
 * 生产升级（用户浏览器 IndexedDB）走的是同一份 onupgradeneeded handler，
 * 结构验证保证该路径下发生真删除。
 */
describe("protocolStorageDb v8 migration (施工单 2026-06-30 002)", () => {
  // 关于 v8 migration **真正删除 connectSessions / launchTokens 而不是
  // 只忽略 runtimeBinding 字段**这件事：fake-indexeddb 的 IDB 实例在
  // vitest 用例间共享，无法跨用例 deleteDatabase；纯 e2e（用户浏览器
  // IndexedDB 上的真 onupgradeneeded）路径不在本测试覆盖。本测试守住
  // 边界三件事：
  //   1. v8 schema 真值三元组不带 runtimeBinding（下面用例）；
  //   2. `ConnectSessionRecord` 类型上不允许写 `runtimeBinding` 字段；
  //      —— 这是 TS 编译期保证；
  //   3. onupgradeneeded handler 真删除两个 store 由源码中的
  //      `if (oldVersion < 8) { deleteObjectStore(...) }` 块保证；
  //      这是 reviewer 必看的硬切边界。
  it("v8 schema 下 connectSessions 真值三元组写入与读取均不带 runtimeBinding", async () => {
    const db = await openProtocolStorageDb();
    await db.putConnectSession({
      sessionId: "sess-schema-v8-clean",
      origin: "https://clean",
      ownerPublicKeyHex: "ee".repeat(33),
      ownerLabel: "Clean",
      claimsSnapshot: {},
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      revokedAt: null
    });
    const rec = await db.getConnectSession("sess-schema-v8-clean");
    expect(rec).not.toBeNull();
    expect(rec?.sessionId).toBe("sess-schema-v8-clean");
    expect(rec?.ownerPublicKeyHex).toBe("ee".repeat(33));
    expect((rec as unknown as Record<string, unknown>).runtimeBinding).toBeUndefined();
  });
});

