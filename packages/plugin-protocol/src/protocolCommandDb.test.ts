// packages/plugin-protocol/src/protocolCommandDb.test.ts
// 命令流 DB 行为单测（fake-indexeddb 由 vitest.setup 注入）。
//
// 关键不变量：
//   - 能按 exact origin 拉历史；
//   - 新命令插入后能按 updatedAt desc 返回；
//   - 不同 origin 不串历史；
//   - 更新同 id 后仍只保留一条记录。

import { beforeEach, describe, expect, it } from "vitest";
import type { ProtocolCommandRecord } from "@keymaster/contracts";
import { openProtocolCommandDb } from "./protocolCommandDb.js";

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
    activePublicKeyHex: "02" + "11".repeat(32),
    createdAt,
    updatedAt,
    finishedAt: updatedAt,
    errorCode: "",
    errorMessage: ""
  };
}

describe("openProtocolCommandDb", () => {
  // 注意：fake-indexeddb 全局共享一个 indexedDB 实例，每个测试**不**做
  // deleteDatabase 重建（重开会卡 onblocked）。本测试通过每条用例用
  // 唯一 record id 来保证互不干扰。

  it("stores and retrieves a command by id", async () => {
    const db = await openProtocolCommandDb();
    const rec = makeRecord("a", "https://demo.example", "identity.get", 1, 2);
    await db.putCommand(rec);
    const got = await db.getCommand("a");
    expect(got?.id).toBe("a");
    expect(got?.origin).toBe("https://demo.example");
  });

  it("returns null for missing id", async () => {
    const db = await openProtocolCommandDb();
    const got = await db.getCommand("nope-not-found");
    expect(got).toBeNull();
  });

  it("lists commands by origin sorted by updatedAt desc", async () => {
    const db = await openProtocolCommandDb();
    // 故意按 createdAt 顺序插入，期望按 updatedAt desc 出来。
    await db.putCommand(makeRecord("srt-r1", "https://srt-a.com", "identity.get", 1, 100));
    await db.putCommand(makeRecord("srt-r2", "https://srt-a.com", "intent.sign", 2, 300));
    await db.putCommand(makeRecord("srt-r3", "https://srt-a.com", "cipher.encrypt", 3, 200));
    const list = await db.listCommandsByOrigin("https://srt-a.com");
    expect(list.map((r) => r.id)).toEqual(["srt-r2", "srt-r3", "srt-r1"]);
  });

  it("does not mix history across origins", async () => {
    const db = await openProtocolCommandDb();
    await db.putCommand(makeRecord("mix-r1", "https://mix-a.com", "identity.get", 1, 100));
    await db.putCommand(makeRecord("mix-r2", "https://mix-b.com", "identity.get", 2, 200));
    const a = await db.listCommandsByOrigin("https://mix-a.com");
    const b = await db.listCommandsByOrigin("https://mix-b.com");
    expect(a.map((r) => r.id)).toEqual(["mix-r1"]);
    expect(b.map((r) => r.id)).toEqual(["mix-r2"]);
  });

  it("does not let host-only matches pass when origin has different port", async () => {
    const db = await openProtocolCommandDb();
    await db.putCommand(makeRecord("port-r1", "https://port-a.com:8443", "identity.get", 1, 100));
    // host 相同但端口不同：必须视为不同 origin。
    const list = await db.listCommandsByOrigin("https://port-a.com");
    expect(list).toEqual([]);
  });

  it("updating a command keeps it as a single record (no event rows)", async () => {
    const db = await openProtocolCommandDb();
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
});
