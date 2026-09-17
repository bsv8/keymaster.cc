// P2PKH 桶内文件仓储：setting.json + <net>/tx/ + <net>/height/。
//
// 真值规则（KeymasterFormats《P2PKH 交易 / 高度 / 设置》）：
//   - raw tx 是唯一交易真值；UTXO/余额/排序由 Worker 在内存回放；
//   - 高度文件只记录"含我的交易的块"及块内顺序；
//   - 未确认交易不落盘（本仓储不接收未确认交易）；
//   - 损坏文件跳过并记录,不影响其它文件。

import type { BorrowedOwnerFileStore } from "@keymaster/contracts";
import { parseP2pkhTransaction } from "../p2pkhTransactionParser.js";
import {
  P2PKH_SETTING_FILE_NAME,
  parseP2pkhHeightFile,
  parseP2pkhHeightFileName,
  parseP2pkhSettingFile,
  parseP2pkhTxFile,
  p2pkhHeightFileName,
  resolveP2pkhSetting,
  serializeP2pkhHeightFile,
  serializeP2pkhSettingFile,
  serializeP2pkhTxFile,
  type P2pkhFileNetwork,
  type P2pkhResolvedSetting,
  type P2pkhTxFileV1,
} from "./p2pkhFileFormats.js";

const TXID_PATTERN = /^[0-9a-f]{64}$/u;
const NETWORKS: readonly P2pkhFileNetwork[] = ["main", "test"];

export interface P2pkhHeightEntry {
  height: number;
  txids: string[];
}

export interface P2pkhFileLoadResult {
  setting: P2pkhResolvedSetting;
  transactions: P2pkhTxFileV1[];
  heights: P2pkhHeightEntry[];
  /** 被跳过的损坏文件（模块根下的相对路径）。 */
  invalidFiles: string[];
}

function assertNetwork(network: P2pkhFileNetwork): P2pkhFileNetwork {
  if (!NETWORKS.includes(network)) throw new Error("P2PKH network is invalid");
  return network;
}

function assertTxid(txid: string): string {
  const normalized = txid.trim().toLowerCase();
  if (!TXID_PATTERN.test(normalized)) throw new Error("P2PKH txid is invalid");
  return normalized;
}

function txPath(network: P2pkhFileNetwork, txid: string): string {
  return `${network}/tx/${assertTxid(txid)}.json`;
}

function heightPath(network: P2pkhFileNetwork, height: number): string {
  return `${network}/height/${p2pkhHeightFileName(height)}`;
}

/** Repository 只接收 Host 已绑定的 `p2pkh/` owner 文件根。 */
export function createP2pkhFileRepository(files: BorrowedOwnerFileStore) {
  async function readSetting(): Promise<P2pkhResolvedSetting> {
    const object = await files.get(P2PKH_SETTING_FILE_NAME);
    if (!object) return resolveP2pkhSetting();
    const parsed = parseP2pkhSettingFile(object.bytes);
    // 设置文件损坏时按"文件不存在 = 全部默认"处理,不阻塞钱包。
    return resolveP2pkhSetting(parsed);
  }

  async function writeSetting(setting: P2pkhResolvedSetting): Promise<void> {
    await files.put(P2PKH_SETTING_FILE_NAME, serializeP2pkhSettingFile(setting));
  }

  async function listPage(prefix: string): Promise<Array<{ path: string }>> {
    const objects: Array<{ path: string }> = [];
    let cursor: string | undefined;
    do {
      const page = await files.list(cursor === undefined ? { prefix } : { prefix, cursor });
      objects.push(...page.files.map((file) => ({ path: file.path })));
      cursor = page.nextCursor;
    } while (cursor);
    return objects;
  }

  async function getTransaction(network: P2pkhFileNetwork, txid: string): Promise<P2pkhTxFileV1 | undefined> {
    const normalized = assertTxid(txid);
    const object = await files.get(txPath(network, normalized));
    if (!object) return undefined;
    const parsed = parseP2pkhTxFile(object.bytes, normalized);
    if (!parsed) return undefined;
    try {
      parseP2pkhTransaction(parsed.rawTxHex, parsed.txid);
    } catch {
      return undefined;
    }
    return parsed;
  }

  async function listTransactions(networkInput: P2pkhFileNetwork): Promise<{ transactions: P2pkhTxFileV1[]; invalidFiles: string[] }> {
    const network = assertNetwork(networkInput);
    const transactions: P2pkhTxFileV1[] = [];
    const invalidFiles: string[] = [];
    for (const file of await listPage(`${network}/tx/`)) {
      const name = file.path.slice(`${network}/tx/`.length);
      if (!name.endsWith(".json")) {
        invalidFiles.push(file.path);
        continue;
      }
      const txid = name.slice(0, -".json".length);
      if (!TXID_PATTERN.test(txid)) {
        invalidFiles.push(file.path);
        continue;
      }
      const object = await files.get(file.path);
      const parsed = object ? parseP2pkhTxFile(object.bytes, txid) : undefined;
      if (!parsed) {
        invalidFiles.push(file.path);
        continue;
      }
      try {
        parseP2pkhTransaction(parsed.rawTxHex, parsed.txid);
      } catch {
        invalidFiles.push(file.path);
        continue;
      }
      transactions.push(parsed);
    }
    transactions.sort((left, right) => left.txid.localeCompare(right.txid));
    return { transactions, invalidFiles };
  }

  /** 写入已确认交易；txid 由 raw bytes 现算,写的是新文件（幂等覆盖）。 */
  async function putTransaction(networkInput: P2pkhFileNetwork, rawTxHex: string): Promise<P2pkhTxFileV1> {
    const network = assertNetwork(networkInput);
    const normalizedHex = rawTxHex.trim().replace(/^0x/iu, "").toLowerCase();
    const parsed = parseP2pkhTransaction(normalizedHex);
    const transaction: P2pkhTxFileV1 = { format: "keymaster.p2pkh-tx", version: 1, txid: parsed.canonicalTxid, rawTxHex: normalizedHex };
    await files.put(txPath(network, parsed.canonicalTxid), serializeP2pkhTxFile(transaction));
    return transaction;
  }

  async function deleteTransaction(networkInput: P2pkhFileNetwork, txid: string): Promise<void> {
    const network = assertNetwork(networkInput);
    await files.delete(txPath(network, txid));
  }

  async function listHeights(networkInput: P2pkhFileNetwork): Promise<{ heights: P2pkhHeightEntry[]; invalidFiles: string[] }> {
    const network = assertNetwork(networkInput);
    const heights: P2pkhHeightEntry[] = [];
    const invalidFiles: string[] = [];
    for (const file of await listPage(`${network}/height/`)) {
      const name = file.path.slice(`${network}/height/`.length);
      const height = parseP2pkhHeightFileName(name);
      if (height === undefined) {
        invalidFiles.push(file.path);
        continue;
      }
      const object = await files.get(file.path);
      const txids = object ? parseP2pkhHeightFile(object.bytes) : undefined;
      if (!txids) {
        invalidFiles.push(file.path);
        continue;
      }
      heights.push({ height, txids });
    }
    heights.sort((left, right) => left.height - right.height);
    return { heights, invalidFiles };
  }

  /**
   * 写入高度文件；数组必须非空、不重复,且每个 txid 都已有 tx 文件
   * （顺序 = 区块内交易顺序）。
   */
  async function putHeight(networkInput: P2pkhFileNetwork, height: number, txids: readonly string[]): Promise<void> {
    const network = assertNetwork(networkInput);
    const normalized = txids.map((txid) => assertTxid(txid));
    if (normalized.length === 0) throw new Error("P2PKH height file cannot be empty");
    if (new Set(normalized).size !== normalized.length) throw new Error("P2PKH height file contains duplicate txids");
    for (const txid of normalized) {
      if (!await getTransaction(network, txid)) throw new Error(`P2PKH transaction ${txid} is missing for height ${height}`);
    }
    await files.put(heightPath(network, height), serializeP2pkhHeightFile(normalized));
  }

  /** 读取单个高度文件；不存在返回 undefined。 */
  async function getHeight(networkInput: P2pkhFileNetwork, height: number): Promise<string[] | undefined> {
    const network = assertNetwork(networkInput);
    const object = await files.get(heightPath(network, height));
    if (!object) return undefined;
    return parseP2pkhHeightFile(object.bytes);
  }

  async function deleteHeight(networkInput: P2pkhFileNetwork, height: number): Promise<void> {
    const network = assertNetwork(networkInput);
    await files.delete(heightPath(network, height));
  }

  /** 列举全部 tx 与高度文件,供 Worker 在内存回放 UTXO。 */
  async function load(networks: readonly P2pkhFileNetwork[] = NETWORKS): Promise<P2pkhFileLoadResult> {
    const setting = await readSetting();
    const transactions: P2pkhTxFileV1[] = [];
    const heights: P2pkhHeightEntry[] = [];
    const invalidFiles: string[] = [];
    for (const network of networks) {
      const txs = await listTransactions(network);
      transactions.push(...txs.transactions);
      invalidFiles.push(...txs.invalidFiles);
      const heightPages = await listHeights(network);
      heights.push(...heightPages.heights);
      invalidFiles.push(...heightPages.invalidFiles);
    }
    return { setting, transactions, heights, invalidFiles };
  }

  return {
    getStore(): BorrowedOwnerFileStore { return files; },
    readSetting,
    writeSetting,
    getTransaction,
    listTransactions,
    putTransaction,
    deleteTransaction,
    listHeights,
    getHeight,
    putHeight,
    deleteHeight,
    load,
  };
}

export type P2pkhFileRepositoryHandle = ReturnType<typeof createP2pkhFileRepository>;
