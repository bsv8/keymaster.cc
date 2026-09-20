// P2PKH 内存 UTXO 快照规则测试（2026-09-20 定案）。
//
// 覆盖：原子替换、失败保留旧快照、严格校验（status/txid/vout/value/冲突重复）、
// mempool 标记保留、空结果表示余额为 0、清除边界、并发刷新去重。

import { describe, expect, it, vi } from "vitest";
import type { WocService, WocUtxoResponse } from "@keymaster/contracts";
import { createP2pkhUtxoSnapshotStore, validateP2pkhUnspentAll, type P2pkhUtxoSnapshotResource } from "./p2pkhUtxoSnapshot.js";

const TXID_A = "aa".repeat(32);
const TXID_B = "bb".repeat(32);

function utxo(overrides: Partial<WocUtxoResponse> = {}): WocUtxoResponse {
  return {
    txid: TXID_A,
    vout: 0,
    value: 1_000,
    height: 100,
    status: "confirmed",
    isSpentInMempoolTx: false,
    ...overrides,
  };
}

function fakeWoc(rows: WocUtxoResponse[] | (() => Promise<WocUtxoResponse[]>)): WocService {
  return {
    getAddressUnspentAll: vi.fn(typeof rows === "function" ? rows : async () => rows),
  } as unknown as WocService;
}

const resource: P2pkhUtxoSnapshotResource = {
  resourceId: "p2pkh:main",
  publicKeyHex: "02".repeat(33),
  network: "main",
  address: "1FakeAddress",
  generation: 0,
};

describe("validateP2pkhUnspentAll", () => {
  it("normalizes and sorts items", () => {
    const items = validateP2pkhUnspentAll([
      utxo({ txid: TXID_B, vout: 1, value: 5, status: "unconfirmed", height: 0 }),
      utxo({ txid: TXID_A, vout: 2, value: 7 }),
    ]);
    expect(items).toEqual([
      { txid: TXID_A, vout: 2, value: 7, height: 100, status: "confirmed", isSpentInMempoolTx: false },
      { txid: TXID_B, vout: 1, value: 5, height: 0, status: "unconfirmed", isSpentInMempoolTx: false },
    ]);
  });

  it("keeps isSpentInMempoolTx and normalizes unconfirmed height to 0", () => {
    const items = validateP2pkhUnspentAll([utxo({ isSpentInMempoolTx: true, status: "unconfirmed", height: 123 })]);
    expect(items[0]!.isSpentInMempoolTx).toBe(true);
    expect(items[0]!.height).toBe(0);
  });

  it("rejects missing/invalid isSpentInMempoolTx, invalid confirmed height and invalid script", () => {
    expect(() => validateP2pkhUnspentAll([utxo({ isSpentInMempoolTx: undefined as never })])).toThrow(/isSpentInMempoolTx/u);
    expect(() => validateP2pkhUnspentAll([utxo({ isSpentInMempoolTx: "yes" as never })])).toThrow(/isSpentInMempoolTx/u);
    expect(() => validateP2pkhUnspentAll([utxo({ height: 0 })])).toThrow(/confirmed height/u);
    expect(() => validateP2pkhUnspentAll([utxo({ height: undefined as never })])).toThrow(/confirmed height/u);
    expect(() => validateP2pkhUnspentAll([utxo({ script: 42 as never })])).toThrow(/invalid script/u);
  });

  it("treats a script difference on duplicate outpoints as a conflict", () => {
    expect(() => validateP2pkhUnspentAll([utxo({ script: "76a914" + "00".repeat(20) + "88ac" }), utxo({ script: "76a914" + "11".repeat(20) + "88ac" })])).toThrow(/conflicting duplicates/u);
    expect(validateP2pkhUnspentAll([utxo({ script: "76a914" + "00".repeat(20) + "88ac" }), utxo({ script: "76a914" + "00".repeat(20) + "88ac" })])).toHaveLength(1);
  });

  it("dedupes identical duplicates and rejects conflicting duplicates", () => {
    expect(validateP2pkhUnspentAll([utxo(), utxo()])).toHaveLength(1);
    expect(() => validateP2pkhUnspentAll([utxo(), utxo({ value: 999 })])).toThrow(/conflicting duplicates/u);
    expect(() => validateP2pkhUnspentAll([utxo(), utxo({ status: "unconfirmed", height: 0 })])).toThrow(/conflicting duplicates/u);
  });

  it("rejects unknown status, invalid txid, vout and value", () => {
    expect(() => validateP2pkhUnspentAll([utxo({ status: "pending" as never })])).toThrow(/unknown status/u);
    expect(() => validateP2pkhUnspentAll([utxo({ txid: "zz".repeat(32) })])).toThrow(/invalid txid/u);
    expect(() => validateP2pkhUnspentAll([utxo({ vout: -1 })])).toThrow(/invalid vout/u);
    expect(() => validateP2pkhUnspentAll([utxo({ value: 1.5 })])).toThrow(/invalid value/u);
  });
});

describe("createP2pkhUtxoSnapshotStore", () => {
  it("atomically replaces the snapshot after a fully valid response", async () => {
    const woc = fakeWoc([utxo()]);
    const store = createP2pkhUtxoSnapshotStore({ woc, now: () => "2026-09-20T00:00:00.000Z" });
    expect(store.get(resource)).toEqual({ available: false, items: [] });
    const result = await store.refresh(resource);
    expect(result).toEqual({
      available: true,
      syncedAt: "2026-09-20T00:00:00.000Z",
      items: [{ txid: TXID_A, vout: 0, value: 1_000, height: 100, status: "confirmed", isSpentInMempoolTx: false }],
    });
    expect(store.get(resource).available).toBe(true);
  });

  it("keeps the old snapshot and throws when the request fails", async () => {
    let shouldFail = false;
    const woc = {
      getAddressUnspentAll: vi.fn(async () => {
        if (shouldFail) throw new Error("WOC 429");
        return [utxo()];
      }),
    } as unknown as WocService;
    const store = createP2pkhUtxoSnapshotStore({ woc, now: () => "t1" });
    await store.refresh(resource);
    shouldFail = true;
    await expect(store.refresh(resource)).rejects.toThrow(/WOC 429/u);
    expect(store.get(resource)).toMatchObject({ available: true, syncedAt: "t1", items: [{ value: 1_000 }] });
  });

  it("keeps the previous snapshot when a later response is invalid", async () => {
    let rows: WocUtxoResponse[] = [utxo({ value: 42 })];
    const woc = { getAddressUnspentAll: vi.fn(async () => rows) } as unknown as WocService;
    const store = createP2pkhUtxoSnapshotStore({ woc, now: () => "t1" });
    await store.refresh(resource);
    rows = [utxo({ value: 42 }), utxo({ value: 43 })];
    await expect(store.refresh(resource)).rejects.toThrow(/conflicting duplicates/u);
    expect(store.get(resource)).toMatchObject({ available: true, syncedAt: "t1", items: [{ value: 42 }] });
  });

  it("treats a successful empty result as a zero balance snapshot", async () => {
    const store = createP2pkhUtxoSnapshotStore({ woc: fakeWoc([]) });
    await store.refresh(resource);
    expect(store.get(resource)).toMatchObject({ available: true, items: [] });
  });

  it("clears by owner and globally", async () => {
    const store = createP2pkhUtxoSnapshotStore({ woc: fakeWoc([utxo()]) });
    await store.refresh(resource);
    const testResource: P2pkhUtxoSnapshotResource = { ...resource, network: "test", resourceId: "p2pkh:test" };
    await store.refresh(testResource);
    store.clearOwner(resource.publicKeyHex);
    expect(store.get(resource).available).toBe(false);
    expect(store.get(testResource).available).toBe(false);
    await store.refresh(resource);
    store.clearAll();
    expect(store.get(resource).available).toBe(false);
  });

  it("deduplicates concurrent refreshes of the same resource", async () => {
    const getAddressUnspentAll = vi.fn(async () => [utxo()]);
    const store = createP2pkhUtxoSnapshotStore({ woc: { getAddressUnspentAll } as unknown as WocService });
    await Promise.all([store.refresh(resource), store.refresh(resource), store.refresh(resource)]);
    expect(getAddressUnspentAll).toHaveBeenCalledTimes(1);
  });

  it("rejects late responses after clearOwner/clearAll and never writes them back", async () => {
    let resolveRows: ((rows: WocUtxoResponse[]) => void) | undefined;
    const woc = {
      getAddressUnspentAll: vi.fn(() => new Promise<WocUtxoResponse[]>((resolve) => { resolveRows = resolve; })),
    } as unknown as WocService;
    const store = createP2pkhUtxoSnapshotStore({ woc, now: () => "late" });
    const pending = store.refresh(resource);
    store.clearOwner(resource.publicKeyHex);
    resolveRows?.([utxo()]);
    await expect(pending).rejects.toThrow(/invalidated/u);
    expect(store.get(resource)).toEqual({ available: false, items: [] });

    // clearAll 同样使在途响应失效。
    let resolveSecond: ((rows: WocUtxoResponse[]) => void) | undefined;
    const secondWoc = {
      getAddressUnspentAll: vi.fn(() => new Promise<WocUtxoResponse[]>((resolve) => { resolveSecond = resolve; })),
    } as unknown as WocService;
    const secondStore = createP2pkhUtxoSnapshotStore({ woc: secondWoc, now: () => "late-2" });
    const pendingSecond = secondStore.refresh(resource);
    secondStore.clearAll();
    resolveSecond?.([utxo()]);
    await expect(pendingSecond).rejects.toThrow(/invalidated/u);
    expect(secondStore.get(resource).available).toBe(false);
  });

  it("does not share snapshots across addresses or generations of the same owner/network", async () => {
    const rowsByAddress: Record<string, WocUtxoResponse[]> = {
      "1AddressA": [utxo({ value: 111 })],
      "1AddressB": [utxo({ value: 222 })],
    };
    const woc = {
      getAddressUnspentAll: vi.fn(async (_network: string, address: string) => rowsByAddress[address] ?? []),
    } as unknown as WocService;
    const store = createP2pkhUtxoSnapshotStore({ woc, now: () => "t" });
    const addressA = { ...resource, address: "1AddressA" };
    const addressB = { ...resource, address: "1AddressB" };
    await store.refresh(addressA);
    // 地址 B 在刷新前必须是未知，不能复用地址 A 的快照。
    expect(store.get(addressB)).toEqual({ available: false, items: [] });
    await store.refresh(addressB);
    expect(store.get(addressA).items[0]!.value).toBe(111);
    expect(store.get(addressB).items[0]!.value).toBe(222);

    // 同一地址、generation 变化（资源重建）同样不能复用旧快照。
    const generationA1 = { ...addressA, generation: 1 };
    expect(store.get(generationA1)).toEqual({ available: false, items: [] });
    rowsByAddress["1AddressA"] = [utxo({ value: 333 })];
    await store.refresh(generationA1);
    expect(store.get(generationA1).items[0]!.value).toBe(333);
    expect(store.get(addressA).items[0]!.value).toBe(111);
  });

  it("ignores a late response from the old address after the resource address changes", async () => {
    let resolveOld: ((rows: WocUtxoResponse[]) => void) | undefined;
    const woc = {
      getAddressUnspentAll: vi.fn((_network: string, address: string) => {
        if (address === "1AddressA") return new Promise<WocUtxoResponse[]>((resolve) => { resolveOld = resolve; });
        return Promise.resolve([utxo({ value: 222 })]);
      }),
    } as unknown as WocService;
    const store = createP2pkhUtxoSnapshotStore({ woc, now: () => "t" });
    const addressA = { ...resource, address: "1AddressA" };
    const addressB = { ...resource, address: "1AddressB" };
    const pendingA = store.refresh(addressA);
    await store.refresh(addressB);
    // 旧地址的迟到响应完成后只能写入自己的键，绝不能覆盖地址 B。
    resolveOld?.([utxo({ value: 111 })]);
    await pendingA;
    expect(store.get(addressA).items[0]!.value).toBe(111);
    expect(store.get(addressB).items[0]!.value).toBe(222);
  });

  it("allows a fresh refresh after an owner/session clear", async () => {
    let call = 0;
    const woc = {
      getAddressUnspentAll: vi.fn(async () => {
        call += 1;
        return call === 1 ? [utxo({ value: 111 })] : [utxo({ value: 222 })];
      }),
    } as unknown as WocService;
    const store = createP2pkhUtxoSnapshotStore({ woc, now: () => `t${call}` });
    await store.refresh(resource);
    store.clearOwner(resource.publicKeyHex);
    const next = await store.refresh(resource);
    expect(next.items[0]!.value).toBe(222);
    expect(store.get(resource)).toMatchObject({ available: true, items: [{ value: 222 }] });
  });
});
