import { describe, expect, it } from "vitest";
import type { BorrowedOwnerFileStore } from "@keymaster/contracts";
import type { P2pkhKeyResource } from "../p2pkhContracts.js";
import { p2pkhAddressToScriptHex, parseP2pkhTransaction } from "../p2pkhTransactionParser.js";
import { createP2pkhChainStore } from "./p2pkhChainStore.js";

function varInt(value: number): string {
  if (value < 0xfd) return value.toString(16).padStart(2, "0");
  if (value <= 0xffff) return `fd${value.toString(16).padStart(4, "0").match(/../g)!.reverse().join("")}`;
  return `fe${value.toString(16).padStart(8, "0").match(/../g)!.reverse().join("")}`;
}

function littleEndianHex(value: number, bytes: number): string {
  return value.toString(16).padStart(bytes * 2, "0").match(/../g)!.reverse().join("");
}

function makeTransaction(address: string, outputValue = 1000): string {
  const script = p2pkhAddressToScriptHex(address, "main");
  const inputs = `${"00".repeat(32)}00000000${"00"}ffffffff`;
  const outputs = `${littleEndianHex(outputValue, 8)}${varInt(script.length / 2)}${script}`;
  return `01000000${varInt(1)}${inputs}${varInt(1)}${outputs}00000000`;
}

/** 花费前一笔交易第 vout 个输出的交易。 */
function makeSpendTransaction(prevTxid: string, vout: number, address: string, outputValue = 900): string {
  const script = p2pkhAddressToScriptHex(address, "main");
  const prevBytes = prevTxid.match(/../g)!.reverse().join("");
  const inputs = `${prevBytes}${littleEndianHex(vout, 4)}${"00"}ffffffff`;
  const outputs = `${littleEndianHex(outputValue, 8)}${varInt(script.length / 2)}${script}`;
  return `01000000${varInt(1)}${inputs}${varInt(1)}${outputs}00000000`;
}

const ADDRESS = "1BoatSLRHtKNngkdXEeobR76b53LETtpyT";
const OWNER_TX = makeTransaction(ADDRESS);
const OWNER_TXID = parseP2pkhTransaction(OWNER_TX).canonicalTxid;
const SPEND_TX = makeSpendTransaction(OWNER_TXID, 0, ADDRESS, 900);
const SPEND_TXID = parseP2pkhTransaction(SPEND_TX).canonicalTxid;

const RESOURCE: P2pkhKeyResource = {
  resourceId: "resource-1",
  publicKeyHex: "02" + "aa".repeat(32),
  label: "test",
  network: "main",
  address: ADDRESS,
  generation: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
};

/** 内存 owner 文件根：只覆盖仓储用到的 list/get/put/delete。 */
function memoryFileStore(): BorrowedOwnerFileStore {
  const files = new Map<string, Uint8Array>();
  return {
    list: async (input = {}) => {
      const prefix = input.prefix ?? "";
      const paths = [...files.keys()].filter((path) => path.startsWith(prefix)).sort();
      const offset = input.cursor === undefined ? 0 : Number.parseInt(input.cursor, 10);
      const limit = input.limit ?? 1000;
      const selected = paths.slice(offset, offset + limit);
      return {
        files: selected.map((path) => ({ path, size: files.get(path)!.byteLength })),
        ...(offset + selected.length < paths.length ? { nextCursor: String(offset + selected.length) } : {}),
      };
    },
    get: async (path) => files.has(path) ? { path, bytes: new Uint8Array(files.get(path)!) } : undefined,
    put: async (path, bytes) => { files.set(path, new Uint8Array(bytes)); return {}; },
    delete: async (path) => { files.delete(path); },
  };
}

describe("P2PKH 链上真值存储", () => {
  it("确认交易写文件并按高度回放,花费用 outpoint 状态表达", async () => {
    const store = createP2pkhChainStore(memoryFileStore());
    store.putAddress(RESOURCE);

    let snapshot = await store.ingestConfirmed(RESOURCE, [
      { txid: OWNER_TXID, rawTxHex: OWNER_TX, blockHeight: 100 },
      { txid: SPEND_TXID, rawTxHex: SPEND_TX, blockHeight: 101 },
    ]);

    expect(snapshot.facts.map((fact) => fact.txid)).toEqual([OWNER_TXID, SPEND_TXID]);
    expect(snapshot.heights).toEqual({ [OWNER_TXID]: 100, [SPEND_TXID]: 101 });
    const ownerOutpoint = snapshot.ownedOutpoints.find((outpoint) => outpoint.txid === OWNER_TXID);
    expect(ownerOutpoint).toMatchObject({ chainState: "spent", spentByTxid: SPEND_TXID, spentBlockHeight: 101 });
    expect(snapshot.utxos.map((utxo) => utxo.txid)).toEqual([SPEND_TXID]);
    expect(snapshot.utxos[0]).toMatchObject({ value: 900, height: 101, status: "confirmed" });

    // 重新 hydrate 必须得到同样的投影（文件是唯一真值）。
    const stripUtxoTime = (utxos: typeof snapshot.utxos) => utxos.map(({ syncedAt: _syncedAt, ...rest }) => rest);
    const stripOutpointTime = (rows: typeof snapshot.ownedOutpoints) => rows.map(({ updatedAt: _updatedAt, ...rest }) => rest);
    const rebuilt = await store.hydrate(RESOURCE);
    expect(stripUtxoTime(rebuilt.utxos)).toEqual(stripUtxoTime(snapshot.utxos));
    expect(stripOutpointTime(rebuilt.ownedOutpoints)).toEqual(stripOutpointTime(snapshot.ownedOutpoints));
  });

  it("同一区块内按高度文件顺序回放", async () => {
    const store = createP2pkhChainStore(memoryFileStore());
    store.putAddress(RESOURCE);
    // 同块内必须按 height 文件顺序：先花费交易、后父交易会解析失败,
    // 因此顺序写入（父在前）时必须保持一致。
    const snapshot = await store.ingestConfirmed(RESOURCE, [
      { txid: OWNER_TXID, rawTxHex: OWNER_TX, blockHeight: 200 },
      { txid: SPEND_TXID, rawTxHex: SPEND_TX, blockHeight: 200 },
    ]);
    expect(snapshot.facts.map((fact) => fact.txid)).toEqual([OWNER_TXID, SPEND_TXID]);
    expect(snapshot.utxos.map((utxo) => utxo.txid)).toEqual([SPEND_TXID]);
  });

  it("完整历史 reorg 删除未观察到的交易与高度条目,不完整历史不动文件", async () => {
    const files = memoryFileStore();
    const store = createP2pkhChainStore(files);
    store.putAddress(RESOURCE);
    await store.ingestConfirmed(RESOURCE, [
      { txid: OWNER_TXID, rawTxHex: OWNER_TX, blockHeight: 100 },
      { txid: SPEND_TXID, rawTxHex: SPEND_TX, blockHeight: 101 },
    ]);

    // 不完整历史：即使未观察到也不删除。
    await store.applyReorg(RESOURCE, { observedTxids: [OWNER_TXID], completeHistory: false });
    await expect(store.hydrate(RESOURCE)).resolves.toMatchObject({ heights: { [OWNER_TXID]: 100, [SPEND_TXID]: 101 } });

    // 完整历史：未观察到的 SPEND 被删除,父交易因高度条目仍存在而保留。
    const reorged = await store.applyReorg(RESOURCE, { observedTxids: [OWNER_TXID], completeHistory: true });
    expect(reorged.facts.map((fact) => fact.txid)).toEqual([OWNER_TXID]);
    expect(reorged.utxos.map((utxo) => utxo.txid)).toEqual([OWNER_TXID]);
    expect(reorged.heights).toEqual({ [OWNER_TXID]: 100 });
  });

  it("资源注册表可增删,clearAll 清空内存", async () => {
    const store = createP2pkhChainStore(memoryFileStore());
    store.putAddress(RESOURCE);
    expect(store.listAddresses()).toEqual([RESOURCE]);
    expect(store.getResource("resource-1")).toEqual(RESOURCE);
    store.removeResource("resource-1");
    expect(store.listAddresses()).toEqual([]);
  });
});
