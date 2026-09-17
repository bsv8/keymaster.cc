import { describe, expect, it } from "vitest";
import type { BorrowedOwnerFileStore } from "@keymaster/contracts";
import { p2pkhAddressToScriptHex, parseP2pkhTransaction } from "../p2pkhTransactionParser.js";
import { createP2pkhFileRepository } from "./p2pkhFileRepository.js";

function varInt(value: number): string {
  if (value < 0xfd) return value.toString(16).padStart(2, "0");
  if (value <= 0xffff) return `fd${value.toString(16).padStart(4, "0").match(/../g)!.reverse().join("")}`;
  return `fe${value.toString(16).padStart(8, "0").match(/../g)!.reverse().join("")}`;
}

function makeTransaction(address: string, outputValue = 1000): string {
  const script = p2pkhAddressToScriptHex(address, "main");
  const inputs = `${"00".repeat(32)}00000000${"00"}ffffffff`;
  const outputs = `${outputValue.toString(16).padStart(16, "0").match(/../g)!.reverse().join("")}${varInt(script.length / 2)}${script}`;
  return `01000000${varInt(1)}${inputs}${varInt(1)}${outputs}00000000`;
}

const ADDRESS = "1BoatSLRHtKNngkdXEeobR76b53LETtpyT";
const RAW_TX = makeTransaction(ADDRESS);
const TXID = parseP2pkhTransaction(RAW_TX).canonicalTxid;
const RAW_TX_2 = makeTransaction(ADDRESS, 2000);
const TXID_2 = parseP2pkhTransaction(RAW_TX_2).canonicalTxid;

type MemoryFileStore = BorrowedOwnerFileStore & {
  __files: Map<string, Uint8Array>;
  __encode(text: string): Uint8Array;
};

/** 内存 owner 文件根：只覆盖仓储用到的 list/get/put/delete。 */
function memoryFileStore(): MemoryFileStore {
  const files = new Map<string, Uint8Array>();
  const encode = (text: string) => new TextEncoder().encode(text);
  return {
    list: async (input = {}) => {
      const prefix = input.prefix ?? "";
      let paths = [...files.keys()].filter((path) => path.startsWith(prefix)).sort();
      const offset = input.cursor === undefined ? 0 : Number.parseInt(input.cursor, 10);
      const limit = input.limit ?? 1000;
      const selected = paths.slice(offset, offset + limit);
      return {
        files: selected.map((path) => ({ path, size: files.get(path)!.byteLength })),
        ...(offset + selected.length < paths.length ? { nextCursor: String(offset + selected.length) } : {}),
      };
    },
    get: async (path) => files.has(path) ? { path, bytes: new Uint8Array(files.get(path)!) } : undefined,
    put: async (path, bytes) => {
      files.set(path, new Uint8Array(bytes));
      return {};
    },
    delete: async (path) => { files.delete(path); },
    // 测试夹具直接写入损坏/定制内容。
    __files: files,
    __encode: encode,
  };
}

describe("P2PKH 文件仓储", () => {
  it("设置缺省与部分覆盖,并且严格拒绝未知字段", async () => {
    const store = memoryFileStore();
    const repository = createP2pkhFileRepository(store);

    await expect(repository.readSetting()).resolves.toEqual({
      includeTestnet: false,
      feeRateSatoshisPerKb: { low: 500, medium: 1000, high: 2000 },
      providers: { main: { syncProviderId: null, broadcastProviderId: null }, test: { syncProviderId: null, broadcastProviderId: null } },
      providerConfigs: {},
    });

    await repository.writeSetting({
      includeTestnet: true,
      feeRateSatoshisPerKb: { low: 500, medium: 1500, high: 2000 },
      providers: { main: { syncProviderId: "woc", broadcastProviderId: "woc" }, test: { syncProviderId: null, broadcastProviderId: "junglebus" } },
      providerConfigs: { woc: { endpoint: "https://api.whatsonchain.com/v1/bsv", requestsPerSecond: 3 } },
    });
    const written = JSON.parse(new TextDecoder().decode(store.__files.get("setting.json")!)) as Record<string, unknown>;
    // 默认值不落盘：low/high 与默认相同被省略。
    expect(written.feeRateSatoshisPerKb).toEqual({ medium: 1500 });
    await expect(repository.readSetting()).resolves.toMatchObject({
      includeTestnet: true,
      feeRateSatoshisPerKb: { medium: 1500 },
      providers: { main: { syncProviderId: "woc", broadcastProviderId: "woc" }, test: { broadcastProviderId: "junglebus" } },
    });

    store.__files.set("setting.json", store.__encode(JSON.stringify({ format: "keymaster.p2pkh-setting", version: 1, includeTestnet: true, unknownField: 1 })));
    await expect(repository.readSetting()).resolves.toMatchObject({ includeTestnet: false });
  });

  it("交易按 txid 一文件一交易,损坏文件跳过", async () => {
    const store = memoryFileStore();
    const repository = createP2pkhFileRepository(store);

    await expect(repository.putTransaction("main", RAW_TX)).resolves.toMatchObject({ txid: TXID, rawTxHex: RAW_TX });
    await expect(repository.getTransaction("main", TXID)).resolves.toMatchObject({ txid: TXID });
    await expect(repository.getTransaction("test", TXID)).resolves.toBeUndefined();

    // 幂等覆盖：同一交易重复写入不产生第二个文件。
    await repository.putTransaction("main", RAW_TX);
    expect([...store.__files.keys()].filter((path) => path.startsWith("main/tx/"))).toEqual([`main/tx/${TXID}.json`]);

    // 损坏 / txid 与文件名不符的文件被跳过。
    store.__files.set("main/tx/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff.json", store.__encode("{}"));
    const listed = await repository.listTransactions("main");
    expect(listed.transactions.map((tx) => tx.txid)).toEqual([TXID]);
    expect(listed.invalidFiles).toHaveLength(1);

    await repository.deleteTransaction("main", TXID);
    await expect(repository.getTransaction("main", TXID)).resolves.toBeUndefined();
  });

  it("高度文件非空、不重复,且要求 tx 已存在", async () => {
    const store = memoryFileStore();
    const repository = createP2pkhFileRepository(store);
    await repository.putTransaction("main", RAW_TX);
    await repository.putTransaction("main", RAW_TX_2);

    await expect(repository.putHeight("main", 850_000, [])).rejects.toThrow(/empty/iu);
    await expect(repository.putHeight("main", 850_000, [TXID, TXID])).rejects.toThrow(/duplicate/iu);
    await expect(repository.putHeight("main", 850_000, [TXID, "a".repeat(64)])).rejects.toThrow(/missing/iu);

    await repository.putHeight("main", 850_000, [TXID_2, TXID]);
    await repository.putTransaction("test", RAW_TX);
    await repository.putHeight("test", 850_001, [TXID]);
    const heights = await repository.listHeights("main");
    expect(heights.heights).toEqual([{ height: 850_000, txids: [TXID_2, TXID] }]);
    expect(await repository.listHeights("test")).toMatchObject({ heights: [{ height: 850_001, txids: [TXID] }] });

    await repository.deleteHeight("main", 850_000);
    await expect(repository.listHeights("main")).resolves.toMatchObject({ heights: [] });
  });

  it("load() 汇总设置、交易与高度", async () => {
    const store = memoryFileStore();
    const repository = createP2pkhFileRepository(store);
    await repository.putTransaction("main", RAW_TX);
    await repository.putHeight("main", 1, [TXID]);

    const loaded = await repository.load();
    expect(loaded.setting.includeTestnet).toBe(false);
    expect(loaded.transactions.map((tx) => tx.txid)).toEqual([TXID]);
    expect(loaded.heights).toEqual([{ height: 1, txids: [TXID] }]);
    expect(loaded.invalidFiles).toEqual([]);
  });
});
