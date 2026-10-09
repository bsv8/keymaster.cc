// P2PKH 专用资金文件仓储。
//
// 这里测的是**文件语义**本身：每条记录一个文件、条件写、严格解析。跨标签页覆盖、
// 创建竞态与「记录存在但读不出来」这三个问题都只在文件语义下才复现得出来，
// 因此不能用内存 Map 替身来验证。

import { describe, expect, it } from "vitest";

import type { StorageObjectRevision, StorageWriteCondition } from "@keymaster/contracts";

import { createP2pkhFileRepository } from "./p2pkhFileRepository.js";
import {
  parseP2pkhProtocolFundingFile,
  p2pkhProtocolFundingPath,
  serializeP2pkhProtocolFundingFile,
  type P2pkhProtocolFundingEntryV1,
} from "./p2pkhFileFormats.js";

const OWNER = "02".repeat(33);
const ADDRESS = "n1rGjTHZWjkX7pwBei5c5opidSF1TSzWK6";

function entry(fundingId: string, overrides: Partial<P2pkhProtocolFundingEntryV1> = {}): P2pkhProtocolFundingEntryV1 {
  return {
    fundingId,
    ownerPluginId: "forum",
    txid: "ab".repeat(32),
    vout: 0,
    rawTxHex: "0100deadbeef",
    valueSatoshis: "1000",
    address: ADDRESS,
    broadcastState: "prepared",
    updatedAtMs: 1_700_000_000_000,
    ownerPublicKeyHex: OWNER,
    network: "test",
    ...overrides,
  };
}

/** 支持条件写与 list 的内存 owner 文件句柄。 */
function files() {
  const map = new Map<string, { bytes: Uint8Array; revision: number }>();
  const store = {
    conflicts: 0,
    async get(path: string) {
      const entry = map.get(path);
      if (entry === undefined) return undefined;
      return { path, bytes: entry.bytes, revision: String(entry.revision) as StorageObjectRevision, lastModified: "now" };
    },
    async put(path: string, bytes: Uint8Array, options?: StorageWriteCondition) {
      const existing = map.get(path);
      if (options?.ifNoneMatch === true && existing !== undefined) {
        store.conflicts += 1;
        throw new Error("condition failed: exists");
      }
      if (options?.ifRevision !== undefined && String(existing?.revision ?? "0") !== options.ifRevision) {
        store.conflicts += 1;
        throw new Error("condition failed: revision");
      }
      map.set(path, { bytes, revision: (existing?.revision ?? 0) + 1 });
      return { revision: String(map.get(path)?.revision ?? 1) as StorageObjectRevision, lastModified: "now" };
    },
    async delete(path: string) {
      map.delete(path);
    },
    async list(input?: { prefix?: string }) {
      const paths = [...map.keys()].filter((path) => input?.prefix === undefined || path.startsWith(input.prefix));
      return { files: paths.map((path) => ({ path, sizeBytes: map.get(path)?.bytes.byteLength ?? 0 })), nextCursor: null };
    },
    close() {},
    raw: map,
  };
  return store;
}

type Repo = ReturnType<typeof createP2pkhFileRepository>;

function repository(store: ReturnType<typeof files>): Repo {
  return createP2pkhFileRepository(store as never);
}

describe("专用资金记录路径", () => {
  it("每条记录一个文件路径", () => {
    expect(p2pkhProtocolFundingPath("forum:task-1")).toBe("funding/forum:task-1.json");
    expect(p2pkhProtocolFundingPath("protocol:abc")).toBe("funding/protocol:abc.json");
  });

  it("不安全的 id 直接拒绝，不猜一个文件名", () => {
    expect(() => p2pkhProtocolFundingPath("../escape")).toThrow();
    expect(() => p2pkhProtocolFundingPath("")).toThrow();
    expect(() => p2pkhProtocolFundingPath("a/b")).toThrow();
  });
});

describe("专用资金记录的跨页写入", () => {
  it("两个标签页写不同 fundingId 时互不覆盖", async () => {
    const store = files();
    // 两个 Window 实例，各自建一个仓储，但共享同一份文件：等价于两个标签页。
    const tabA = repository(store);
    const tabB = repository(store);

    await tabA.writeProtocolFunding(entry("forum:task-a"));
    await tabB.writeProtocolFunding(entry("forum:task-b"));

    // 关键：写前日志不能因为「各自缓存了全部记录再整体覆盖」而丢一条。
    expect(await tabA.readProtocolFunding("forum:task-a")).toMatchObject({ fundingId: "forum:task-a" });
    expect(await tabA.readProtocolFunding("forum:task-b")).toMatchObject({ fundingId: "forum:task-b" });
    expect(await tabB.readProtocolFunding("forum:task-a")).toMatchObject({ fundingId: "forum:task-a" });
    const listed = await tabA.listProtocolFunding();
    expect(listed.records.map((record) => record.fundingId).sort()).toEqual(["forum:task-a", "forum:task-b"]);
    expect(listed.unreadable).toEqual([]);
  });

  it("同一 fundingId 的重复创建由条件写挡住", async () => {
    const store = files();
    const repo = repository(store);
    await expect(repo.writeProtocolFunding(entry("forum:task-a"), { ifAbsent: true })).resolves.toBeUndefined();
    // 第二次必须失败：写前日志不能被静默覆盖成另一笔交易的证据。
    await expect(repo.writeProtocolFunding(entry("forum:task-a", { txid: "cd".repeat(32) }), { ifAbsent: true })).rejects.toThrow();
    expect(store.conflicts).toBeGreaterThan(0);
    expect((await repo.readProtocolFunding("forum:task-a"))?.txid).toBe("ab".repeat(32));
  });

  it("删除一条不影响其它记录", async () => {
    const store = files();
    const repo = repository(store);
    await repo.writeProtocolFunding(entry("forum:task-a"));
    await repo.writeProtocolFunding(entry("forum:task-b"));
    await repo.deleteProtocolFunding("forum:task-a");
    expect(await repo.readProtocolFunding("forum:task-a")).toBeUndefined();
    expect(await repo.readProtocolFunding("forum:task-b")).toMatchObject({ fundingId: "forum:task-b" });
  });
});

describe("被替代记录", () => {
  it("保留 supersededBy 且旧记录仍可读", async () => {
    const store = files();
    const repo = repository(store);
    await repo.writeProtocolFunding(entry("forum:task-1"));
    await repo.writeProtocolFunding(entry("forum:task-1+1", { supersededBy: undefined }));
    // 旧记录标为被替代：它的 UTXO 还在链上，恢复与回收都需要它。
    const old = (await repo.readProtocolFunding("forum:task-1")) as P2pkhProtocolFundingEntryV1;
    await repo.writeProtocolFunding({ ...old, supersededBy: "forum:task-1+1" });
    expect((await repo.readProtocolFunding("forum:task-1"))?.supersededBy).toBe("forum:task-1+1");
    // 新旧两条都在：重启后两笔都有证据。
    const listed = await repo.listProtocolFunding();
    expect(listed.records.map((record) => record.fundingId).sort()).toEqual(["forum:task-1", "forum:task-1+1"]);
  });
});

describe("专用资金记录的严格解析", () => {
  it("往返保留全部字段", () => {
    const original = entry("forum:task-a", { submissionId: "submission-1", broadcastState: "dispatched" });
    expect(parseP2pkhProtocolFundingFile(serializeP2pkhProtocolFundingFile(original))).toEqual({
      format: "keymaster.p2pkh-protocol-funding",
      version: 1,
      record: original,
    });
  });

  it("非法字段一律视为损坏", () => {
    const bytes = serializeP2pkhProtocolFundingFile(entry("forum:task-a"));
    const mutate = (change: (document: Record<string, unknown>) => void): Uint8Array => {
      const document = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
      change(document);
      return new TextEncoder().encode(JSON.stringify(document));
    };
    expect(parseP2pkhProtocolFundingFile(mutate((d) => { (d.record as Record<string, unknown>).txid = "nope"; }))).toBeUndefined();
    expect(parseP2pkhProtocolFundingFile(mutate((d) => { (d.record as Record<string, unknown>).vout = -1; }))).toBeUndefined();
    expect(parseP2pkhProtocolFundingFile(mutate((d) => { (d.record as Record<string, unknown>).valueSatoshis = "01"; }))).toBeUndefined();
    expect(parseP2pkhProtocolFundingFile(mutate((d) => { (d.record as Record<string, unknown>).broadcastState = "whatever"; }))).toBeUndefined();
    expect(parseP2pkhProtocolFundingFile(mutate((d) => { (d.record as Record<string, unknown>).ownerPublicKeyHex = "03"; }))).toBeUndefined();
    // owner 与 network 是恢复与保护的判据，缺失即损坏。
    expect(parseP2pkhProtocolFundingFile(mutate((d) => { delete (d.record as Record<string, unknown>).ownerPublicKeyHex; }))).toBeUndefined();
    expect(parseP2pkhProtocolFundingFile(mutate((d) => { delete (d.record as Record<string, unknown>).network; }))).toBeUndefined();
    expect(parseP2pkhProtocolFundingFile(mutate((d) => { (d.record as Record<string, unknown>).network = "regtest"; }))).toBeUndefined();
    expect(parseP2pkhProtocolFundingFile(new TextEncoder().encode("{"))).toBeUndefined();
    expect(parseP2pkhProtocolFundingFile(new Uint8Array(0))).toBeUndefined();
  });

  it("文件存在但读不出来时 list 报告 unreadable，而不是当作没有记录", async () => {
    const store = files();
    const repo = repository(store);
    // 直接塞一个格式不对的文件：模拟磁盘上存在但无法解析的记录。
    await store.put("funding/forum:broken.json", new TextEncoder().encode("{not json"));
    await repo.writeProtocolFunding(entry("forum:task-a"));
    const listed = await repo.listProtocolFunding();
    expect(listed.records.map((record) => record.fundingId)).toEqual(["forum:task-a"]);
    expect(listed.unreadable).toEqual(["forum:broken"]);
  });

  it("不存在的记录读成 undefined（与损坏区分）", async () => {
    const repo = repository(files());
    expect(await repo.readProtocolFunding("forum:missing")).toBeUndefined();
    expect((await repo.listProtocolFunding()).unreadable).toEqual([]);
  });
});