import { describe, expect, it } from "vitest";
import { createP2pkhFileRepository } from "./p2pkhFileRepository.js";
import { createMemoryOwnerFileStore } from "./testSupport/memoryOwnerFileStore.js";
import { serializeP2pkhHistoryFile } from "./p2pkhFileFormats.js";

describe("P2PKH 文件仓储", () => {
  it("恢复保护读取全部资金分页，后页损坏记录也不会漏过", async () => {
    const store = createMemoryOwnerFileStore();
    const writer = createP2pkhFileRepository(store);
    for (let i = 0; i < 3; i++) await writer.writeProtocolFunding({ fundingId: `forum:${i}`, ownerPublicKeyHex: "02" + "aa".repeat(32), network: "test", txid: "bb".repeat(32), vout: i, rawTxHex: "00", valueSatoshis: "100", address: "address", updatedAtMs: 1 });
    await store.put("funding/zz-broken.json", new TextEncoder().encode("{}"));
    const paged = createP2pkhFileRepository({ ...store, list: input => store.list({ ...input, limit: 1 }) });
    const result = await paged.listProtocolFunding();
    expect(result.records.map(row => row.vout)).toEqual([0, 1, 2]);
    expect(result.unreadable).toEqual(["zz-broken"]);
  });

  it("设置缺省与部分覆盖", async () => {
    const store = createMemoryOwnerFileStore();
    const repository = createP2pkhFileRepository(store as never);

    await expect(repository.readSetting()).resolves.toEqual({

      feeRateSatoshisPerKb: { low: 60, medium: 120, high: 180 },
      providerConfigs: {},
    });

    await repository.writeSetting({

      feeRateSatoshisPerKb: { low: 60, medium: 150, high: 180 },
      providerConfigs: { woc: { endpoint: "https://woc-proxy.example.invalid/v1/bsv" } },
    });
    const written = JSON.parse(new TextDecoder().decode(store.__files.get("setting.json")!)) as Record<string, unknown>;
    // 默认值不落盘：low/high 与默认相同被省略。
    expect(written.feeRateSatoshisPerKb).toEqual({ medium: 150 });
    await expect(repository.readSetting()).resolves.toMatchObject({

      feeRateSatoshisPerKb: { low: 60, medium: 150, high: 180 },
    });
  });

  it("旧 providers 与未知 providerConfigs 被静默丢弃", async () => {
    const store = createMemoryOwnerFileStore();
    store.__files.set(
      "setting.json",
      store.__encode(JSON.stringify({
        format: "keymaster.p2pkh-setting",
        version: 1,

        providers: { main: { syncProviderId: "junglebus" } },
        providerConfigs: { junglebus: { endpoint: "wss://example" }, woc: { requestsPerSecond: 3 } },
      })),
    );
    const repository = createP2pkhFileRepository(store as never);
    await expect(repository.readSetting()).resolves.toEqual({

      feeRateSatoshisPerKb: { low: 60, medium: 120, high: 180 },
      providerConfigs: { woc: { requestsPerSecond: 3 } },
    });
  });

  it("损坏的设置文件按默认处理", async () => {
    const store = createMemoryOwnerFileStore();
    store.__files.set("setting.json", store.__encode(JSON.stringify({ format: "keymaster.p2pkh-setting", version: 1, bsvNetwork: "test", unknownField: 1 })));
    const repository = createP2pkhFileRepository(store as never);
    // 未知字段被忽略，有效字段仍然生效。
    await expect(repository.readSetting()).resolves.toMatchObject({ feeRateSatoshisPerKb: { medium: 120 } });
    store.__files.set("setting.json", store.__encode("not-json"));
    await expect(repository.readSetting()).resolves.toMatchObject({ feeRateSatoshisPerKb: { medium: 120 } });
  });

  it("历史在已绑定身份的模块根下整文件替换", async () => {
    const store = createMemoryOwnerFileStore();
    const repository = createP2pkhFileRepository(store as never);
    await expect(repository.readHistory("main")).resolves.toBeUndefined();
    const txA = "aa".repeat(32);
    const txB = "bb".repeat(32);
    await repository.writeHistory("main", [{ txid: txA, height: 10 }, { txid: txB, height: 11, fee: 5 }]);
    await expect(repository.readHistory("main")).resolves.toEqual([
      { txid: txA, height: 10 },
      { txid: txB, height: 11, fee: 5 },
    ]);
    expect([...store.__files.keys()]).toEqual(["history.json"]);
    // 整文件替换：旧记录被丢弃。
    await repository.writeHistory("main", [{ txid: txB, height: 11, fee: 5 }]);
    await expect(repository.readHistory("main")).resolves.toEqual([{ txid: txB, height: 11, fee: 5 }]);
  });

  it.each(["main", "test"] as const)("兼容读取 %s 旧历史，成功保存时原子移除旧文件", async network => {
    const store = createMemoryOwnerFileStore();
    const old = [{ txid: "aa".repeat(32), height: 10 }];
    const next = [{ txid: "bb".repeat(32), height: 11 }];
    await store.put(`${network}/history.json`, serializeP2pkhHistoryFile(old));
    const repository = createP2pkhFileRepository(store);
    await expect(repository.readHistory(network)).resolves.toEqual(old);
    expect(store.__files.has("history.json")).toBe(false);
    await repository.writeHistory(network, next);
    expect([...store.__files.keys()]).toEqual(["history.json"]);
    await expect(repository.readHistory(network)).resolves.toEqual(next);
  });

  it("新文件优先，损坏时不回退到旧历史", async () => {
    const store = createMemoryOwnerFileStore();
    await store.put("test/history.json", serializeP2pkhHistoryFile([{ txid: "aa".repeat(32), height: 10 }]));
    await store.put("history.json", serializeP2pkhHistoryFile([]));
    const repository = createP2pkhFileRepository(store);
    await expect(repository.readHistory("test")).resolves.toEqual([]);
    await store.put("history.json", store.__encode("broken"));
    await expect(repository.readHistory("test")).resolves.toBeUndefined();
  });

  it("保存失败时保留旧历史，不提前删除旧路径", async () => {
    const store = createMemoryOwnerFileStore();
    const old = [{ txid: "aa".repeat(32), height: 10 }];
    await store.put("test/history.json", serializeP2pkhHistoryFile(old));
    const repository = createP2pkhFileRepository({ ...store, batch: async () => { throw new Error("storage unavailable"); } });
    await expect(repository.writeHistory("test", [])).rejects.toThrow("storage unavailable");
    expect([...store.__files.keys()]).toEqual(["test/history.json"]);
    await expect(repository.readHistory("test")).resolves.toEqual(old);
  });

  it("损坏的历史文件返回 undefined 而不是抛错", async () => {
    const store = createMemoryOwnerFileStore();
    store.__files.set("history.json", store.__encode(JSON.stringify({ format: "keymaster.p2pkh-history", version: 1, records: [{ txid: "bad", height: -1 }] })));
    const repository = createP2pkhFileRepository(store as never);
    await expect(repository.readHistory("main")).resolves.toBeUndefined();
  });
});
