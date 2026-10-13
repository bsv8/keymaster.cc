import { describe, expect, it, vi } from "vitest";
import type { ProtocolFundingService } from "@keymaster/contracts";
import { createForumFundingSource } from "./forumFundingSource.js";

// Forum 必须对账实际后继资金，而非继续用原任务编号查另一笔输出。
describe("Forum 后继资金编号", () => {
  it.each(["forum:task-1+1", undefined])("读取、重启核对与观测使用保存的资金编号 %s", async (fundingId) => {
    const owner = "02" + "11".repeat(32);
    const record = { fundingId, txid: "ab".repeat(32), vout: 0, rawTxHex: "00", valueSatoshis: "2000", address: "addr", ownerPublicKeyHex: owner };
    const reconcile = vi.fn(async () => ({ state: "mempool" as const, usable: true }));
    const observe = vi.fn(async () => "mempool" as const);
    const source = createForumFundingSource({
      protocolSpend: () => undefined,
      funding: () => ({ reconcileDedicatedFunding: reconcile, observeDedicatedFunding: observe } as unknown as ProtocolFundingService),
      protectedOutpoints: { register() {}, unregister() {} },
      woc: undefined,
      repository: { async readDedicatedFunding() { return record; }, async writeDedicatedFunding() {}, async deleteDedicatedFunding() {} },
    });
    expect(await source.readDedicatedFunding(owner, "test", "task-1", 2000n)).toBe(record);
    await source.observeFunding({ ownerPublicKeyHex: owner, network: "test", taskId: "task-1", txid: record.txid, vout: record.vout });
    const expectedId = fundingId ?? "forum:task-1";
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ fundingId: expectedId, txid: record.txid }));
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ fundingId: expectedId, txid: record.txid }));
  });
});

// 回收适配器：编号、删除时机与保护登记都要对上真实注册表的行为。
describe("Forum 专用资金回收适配", () => {
  const OWNER = "02" + "11".repeat(32);

  function harness(input: {
    forumRecord?: { fundingId?: string } | undefined;
    recover?: (arg: { fundingId: string; reason: { supersededBy: string } | { unused: true } }) => Promise<{ txid: string; recoveredSatoshis: string }>;
  } = {}) {
    const deleted: string[] = [];
    const unregistered: string[] = [];
    const recover = vi.fn(input.recover ?? (async () => ({ txid: "cd".repeat(32), recoveredSatoshis: "1800" })));
    const source = createForumFundingSource({
      protocolSpend: () => undefined,
      funding: () => ({
        recoverDedicatedFunding: (arg: { fundingId: string; reason: { supersededBy: string } | { unused: true } }) => {
          if (input.recover === undefined) return recover(arg);
          return input.recover(arg);
        },
      } as unknown as ProtocolFundingService),
      protectedOutpoints: { register() {}, unregister(id: string) { unregistered.push(id); } },
      woc: undefined,
      repository: {
        async readDedicatedFunding() {
          return input.forumRecord === undefined ? undefined : {
            fundingId: input.forumRecord.fundingId, txid: "ab".repeat(32), vout: 0, rawTxHex: "00",
            valueSatoshis: "2000", address: "addr", ownerPublicKeyHex: OWNER,
          } as never;
        },
        async writeDedicatedFunding() {},
        async deleteDedicatedFunding(taskId: string) { deleted.push(taskId); },
      },
    });
    return { source, recover, deleted, unregistered };
  }

  it("按 Forum 记录里的 fundingId 回收，不用裸 taskId", async () => {
    const h = harness({ forumRecord: { fundingId: "forum:task-1+1" } });
    await h.source.recoverDedicatedFunding?.({
      ownerPublicKeyHex: OWNER, network: "test", taskId: "task-1",
      feeRateSatoshisPerKb: 1, reason: { unused: true },
    });
    expect(h.recover).toHaveBeenCalledWith(expect.objectContaining({ fundingId: "forum:task-1+1" }));
  });

  it("没有记录时退回派生编号，仍不是裸 taskId", async () => {
    const h = harness({ forumRecord: undefined });
    await h.source.recoverDedicatedFunding?.({
      ownerPublicKeyHex: OWNER, network: "test", taskId: "task-1",
      feeRateSatoshisPerKb: 1, reason: { unused: true },
    });
    expect(h.recover).toHaveBeenCalledWith(expect.objectContaining({ fundingId: "forum:task-1" }));
  });

  it("钱包侧回收成功后才清 Forum 记录", async () => {
    const h = harness();
    await h.source.recoverDedicatedFunding?.({
      ownerPublicKeyHex: OWNER, network: "test", taskId: "task-1",
      feeRateSatoshisPerKb: 1, reason: { unused: true },
    });
    expect(h.deleted).toEqual(["task-1"]);
  });

  it("钱包侧失败或结果不明时两侧记录都保留", async () => {
    for (const failure of [
      async () => { throw new Error("回收交易广播结果未知"); },
      async () => { throw new Error("回收交易被明确拒绝"); },
    ]) {
      const h = harness({ recover: failure as never });
      await expect(h.source.recoverDedicatedFunding?.({
        ownerPublicKeyHex: OWNER, network: "test", taskId: "task-1",
        feeRateSatoshisPerKb: 1, reason: { unused: true },
      })).rejects.toThrow();
      // 提前删除会让「已回收」变成无法对账的说法。
      expect(h.deleted).toEqual([]);
    }
  });

  it("不注销本模块没登记过的保护 id", async () => {
    const h = harness();
    await h.source.recoverDedicatedFunding?.({
      ownerPublicKeyHex: OWNER, network: "test", taskId: "task-1",
      feeRateSatoshisPerKb: 1, reason: { unused: true },
    });
    // 真实注册表对未登记的 id 会抛错；保护由钱包侧按 fundingId 负责。
    expect(h.unregistered).toEqual([]);
  });

  it("传递替代编号依据", async () => {
    const h = harness();
    await h.source.recoverDedicatedFunding?.({
      ownerPublicKeyHex: OWNER, network: "test", taskId: "task-1",
      feeRateSatoshisPerKb: 1, reason: { supersededBy: "forum:task-1+1" },
    });
    expect(h.recover).toHaveBeenCalledWith(expect.objectContaining({ reason: { supersededBy: "forum:task-1+1" } }));
  });
});
