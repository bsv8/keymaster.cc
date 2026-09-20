import { describe, expect, it } from "vitest";
import { createP2pkhFileRepository } from "./p2pkhFileRepository.js";
import { createMemoryOwnerFileStore } from "./testSupport/memoryOwnerFileStore.js";

describe("P2PKH 文件仓储", () => {
  it("设置缺省与部分覆盖", async () => {
    const store = createMemoryOwnerFileStore();
    const repository = createP2pkhFileRepository(store as never);

    await expect(repository.readSetting()).resolves.toEqual({
      includeTestnet: false,
      feeRateSatoshisPerKb: { low: 500, medium: 1000, high: 2000 },
      providerConfigs: {},
    });

    await repository.writeSetting({
      includeTestnet: true,
      feeRateSatoshisPerKb: { low: 500, medium: 1500, high: 2000 },
      providerConfigs: { woc: { endpoint: "https://woc-proxy.example.invalid/v1/bsv" } },
    });
    const written = JSON.parse(new TextDecoder().decode(store.__files.get("setting.json")!)) as Record<string, unknown>;
    // 默认值不落盘：low/high 与默认相同被省略。
    expect(written.feeRateSatoshisPerKb).toEqual({ medium: 1500 });
    await expect(repository.readSetting()).resolves.toMatchObject({
      includeTestnet: true,
      feeRateSatoshisPerKb: { low: 500, medium: 1500, high: 2000 },
    });
  });

  it("旧 providers 与未知 providerConfigs 被静默丢弃", async () => {
    const store = createMemoryOwnerFileStore();
    store.__files.set(
      "setting.json",
      store.__encode(JSON.stringify({
        format: "keymaster.p2pkh-setting",
        version: 1,
        includeTestnet: true,
        providers: { main: { syncProviderId: "junglebus" } },
        providerConfigs: { junglebus: { endpoint: "wss://example" }, woc: { requestsPerSecond: 3 } },
      })),
    );
    const repository = createP2pkhFileRepository(store as never);
    await expect(repository.readSetting()).resolves.toEqual({
      includeTestnet: true,
      feeRateSatoshisPerKb: { low: 500, medium: 1000, high: 2000 },
      providerConfigs: { woc: { requestsPerSecond: 3 } },
    });
  });

  it("损坏的设置文件按默认处理", async () => {
    const store = createMemoryOwnerFileStore();
    store.__files.set("setting.json", store.__encode(JSON.stringify({ format: "keymaster.p2pkh-setting", version: 1, includeTestnet: true, unknownField: 1 })));
    const repository = createP2pkhFileRepository(store as never);
    // 未知字段被忽略，有效字段仍然生效。
    await expect(repository.readSetting()).resolves.toMatchObject({ includeTestnet: true });
    store.__files.set("setting.json", store.__encode("not-json"));
    await expect(repository.readSetting()).resolves.toMatchObject({ includeTestnet: false });
  });

  it("历史按网络整文件替换", async () => {
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
    // 整文件替换：旧记录被丢弃；test 网络互不影响。
    await repository.writeHistory("main", [{ txid: txB, height: 11, fee: 5 }]);
    await expect(repository.readHistory("main")).resolves.toEqual([{ txid: txB, height: 11, fee: 5 }]);
    await expect(repository.readHistory("test")).resolves.toBeUndefined();
  });

  it("损坏的历史文件返回 undefined 而不是抛错", async () => {
    const store = createMemoryOwnerFileStore();
    store.__files.set("main/history.json", store.__encode(JSON.stringify({ format: "keymaster.p2pkh-history", version: 1, records: [{ txid: "bad", height: -1 }] })));
    const repository = createP2pkhFileRepository(store as never);
    await expect(repository.readHistory("main")).resolves.toBeUndefined();
  });
});
