// P2PKH 链上真值存储：raw tx 文件是唯一真值,UTXO 与索引在内存回放。
//
// 设计依据（KeymasterFormats《P2PKH 交易 / 高度》）：
//   - 确认交易写 `<net>/tx/<txid>.json`；高度写 `<net>/height/<10位>.json`；
//   - UTXO、花费关系、排序在 Worker 内存重建,不落盘；
//   - reorg：删除/改写文件后按新结果重建内存；
//   - 未确认交易、输入占用、同步游标不在本存储（只存在内存/上层）。

import type { BorrowedOwnerFileStore } from "@keymaster/contracts";
import type { P2pkhKeyResource, P2pkhOwnedOutpointProjection, P2pkhTransactionFact, P2pkhUtxo } from "../p2pkhContracts.js";
import { ownedP2pkhOutputs, parseP2pkhTransaction } from "../p2pkhTransactionParser.js";
import { createP2pkhFileRepository, type P2pkhFileRepositoryHandle } from "./p2pkhFileRepository.js";

const NETWORK_PATTERN = /^(main|test)$/u;

export interface P2pkhChainIngestTx {
  txid: string;
  rawTxHex: string;
  blockHeight?: number;
}

export interface P2pkhReorgCheck {
  /** 本次同步观察到的交易集合（完整历史时用于删除不再存在的文件）。 */
  observedTxids: string[];
  /** provider 是否给出了完整历史；false 时不做删除。 */
  completeHistory: boolean;
  /** 已确认锚点之前的历史不参与回滚。 */
  anchorTxid?: string;
}

export interface P2pkhChainSnapshot {
  facts: P2pkhTransactionFact[];
  ownedOutpoints: P2pkhOwnedOutpointProjection[];
  utxos: P2pkhUtxo[];
  /** txid → 区块高度；未收录高度的交易不在其中。 */
  heights: Record<string, number>;
}

export function createP2pkhChainStore(files: BorrowedOwnerFileStore) {
  const fileRepository: P2pkhFileRepositoryHandle = createP2pkhFileRepository(files);
  /** 资源（owner key × network）注册表；可随时从 keyspace 重建。 */
  const resources = new Map<string, P2pkhKeyResource>();
  /** 每个资源的内存快照（key = resourceId）。 */
  const snapshots = new Map<string, P2pkhChainSnapshot>();

  function assertResource(resource: P2pkhKeyResource): P2pkhKeyResource {
    if (!resource.resourceId || !resource.publicKeyHex || !NETWORK_PATTERN.test(resource.network)) throw new Error("P2PKH resource is invalid");
    return resource;
  }

  function resourceKey(resource: P2pkhKeyResource): string {
    return `${resource.publicKeyHex.toLowerCase()}:${resource.network}`;
  }

  /** 从文件重建一个资源的全部链上投影。 */
  async function hydrate(resource: P2pkhKeyResource): Promise<P2pkhChainSnapshot> {
    const registered = assertResource(resource);
    const listed = await fileRepository.listTransactions(registered.network);
    const heightEntries = await fileRepository.listHeights(registered.network);
    const heights = new Map<string, number>();
    for (const entry of heightEntries.heights) {
      for (const txid of entry.txids) heights.set(txid, entry.height);
    }
    const now = new Date().toISOString();
    const facts: P2pkhTransactionFact[] = [];
    for (const transaction of listed.transactions) {
      let parsed;
      try {
        parsed = parseP2pkhTransaction(transaction.rawTxHex, transaction.txid);
      } catch {
        continue;
      }
      const owned = ownedP2pkhOutputs(parsed, registered.address, registered.network);
      facts.push({
        id: `${registered.resourceId}:${transaction.txid}`,
        resourceId: registered.resourceId,
        publicKeyHex: registered.publicKeyHex,
        network: registered.network,
        address: registered.address,
        txid: transaction.txid,
        rawTxHex: transaction.rawTxHex,
        blockHeight: heights.get(transaction.txid),
        inputOutpointKeys: parsed.inputs.map((input) => input.outpointKey),
        inputs: parsed.inputs.map((input) => ({ txid: input.prevTxid, vout: input.prevVout, outpointKey: input.outpointKey })),
        ownedOutpointKeys: owned.map((output) => `${transaction.txid}:${output.vout}`),
        ownedOutputs: owned,
        firstConfirmedAt: now,
        lastConfirmedAt: now,
      });
    }
    // 高度顺序即区块内回放顺序；同一块内允许花上一笔。
    const order = new Map<string, number>();
    let sequence = 0;
    for (const entry of heightEntries.heights) {
      for (const txid of entry.txids) order.set(txid, sequence++);
    }
    facts.sort((left, right) => {
      const leftOrder = order.get(left.txid) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = order.get(right.txid) ?? Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder || left.txid.localeCompare(right.txid);
    });

    const outpoints = new Map<string, P2pkhOwnedOutpointProjection>();
    for (const fact of facts) {
      for (const output of fact.ownedOutputs) {
        const outpointKey = `${fact.txid}:${output.vout}`;
        outpoints.set(outpointKey, {
          id: `${registered.resourceId}:${outpointKey}`,
          resourceId: registered.resourceId,
          publicKeyHex: registered.publicKeyHex,
          network: registered.network,
          address: registered.address,
          txid: fact.txid,
          vout: output.vout,
          outpointKey,
          value: output.value,
          scriptHex: output.scriptHex,
          chainState: "available",
          createdBlockHeight: fact.blockHeight,
          updatedAt: now,
        });
      }
    }
    for (const fact of facts) {
      for (const inputKey of fact.inputOutpointKeys) {
        const row = outpoints.get(inputKey);
        if (row && row.txid !== fact.txid) {
          row.chainState = "spent";
          row.spentByTxid = fact.txid;
          row.spentBlockHeight = fact.blockHeight;
        }
      }
    }
    const ownedOutpoints = [...outpoints.values()];
    const utxos = ownedOutpoints
      .filter((outpoint) => outpoint.chainState === "available")
      .map((outpoint) => ({
        id: `utxo:${outpoint.resourceId}:${outpoint.outpointKey}`,
        resourceId: outpoint.resourceId,
        publicKeyHex: outpoint.publicKeyHex,
        network: outpoint.network,
        address: outpoint.address,
        txid: outpoint.txid,
        vout: outpoint.vout,
        value: outpoint.value,
        ...(outpoint.createdBlockHeight === undefined ? {} : { height: outpoint.createdBlockHeight }),
        script: outpoint.scriptHex,
        status: "confirmed" as const,
        isSpentInMempoolTx: false,
        syncedAt: now,
      }));
    const snapshot: P2pkhChainSnapshot = { facts, ownedOutpoints, utxos, heights: Object.fromEntries(heights) };
    snapshots.set(registered.resourceId, snapshot);
    return snapshot;
  }

  /** 写入一批已确认交易,并保持高度文件与区块内顺序。 */
  async function ingestConfirmed(resource: P2pkhKeyResource, transactions: readonly P2pkhChainIngestTx[]): Promise<P2pkhChainSnapshot> {
    const registered = assertResource(resource);
    for (const transaction of transactions) {
      const written = await fileRepository.putTransaction(registered.network, transaction.rawTxHex);
      if (transaction.txid && written.txid !== transaction.txid.toLowerCase()) throw new Error("P2PKH transaction txid mismatch");
    }
    // 高度目录：按 height 分组,追加进已有文件（保持区块内顺序）。
    const byHeight = new Map<number, string[]>();
    for (const transaction of transactions) {
      if (transaction.blockHeight === undefined) continue;
      const parsed = parseP2pkhTransaction(transaction.rawTxHex, transaction.txid);
      const list = byHeight.get(transaction.blockHeight) ?? [];
      list.push(parsed.canonicalTxid);
      byHeight.set(transaction.blockHeight, list);
    }
    for (const [height, txids] of byHeight) {
      const existing = await fileRepository.getHeight(registered.network, height);
      const merged = [...(existing ?? [])];
      for (const txid of txids) if (!merged.includes(txid)) merged.push(txid);
      await fileRepository.putHeight(registered.network, height, merged);
    }
    return hydrate(registered);
  }

  /**
   * 处理 reorg：按 provider 结果删除不再存在的 tx 文件与高度条目。
   * 只有 `completeHistory` 时才允许删除,避免把分页结果当全量。
   */
  async function applyReorg(resource: P2pkhKeyResource, reorg: P2pkhReorgCheck): Promise<P2pkhChainSnapshot> {
    const registered = assertResource(resource);
    if (reorg.completeHistory) {
      const observed = new Set(reorg.observedTxids.map((txid) => txid.toLowerCase()));
      const anchorIndex = reorg.anchorTxid === undefined ? -1 : reorg.observedTxids.findIndex((txid) => txid.toLowerCase() === reorg.anchorTxid!.toLowerCase());
      const heights = await fileRepository.listHeights(registered.network);
      for (const entry of heights.heights) {
        const remaining = entry.txids.filter((txid, index) => observed.has(txid) || (anchorIndex >= 0 && index < anchorIndex));
        if (remaining.length === entry.txids.length) continue;
        if (remaining.length === 0) await fileRepository.deleteHeight(registered.network, entry.height);
        else await fileRepository.putHeight(registered.network, entry.height, remaining);
      }
      // 高度条目裁剪后仍被引用的交易保留；不再被引用的未观察交易删除。
      const remainingHeights = await fileRepository.listHeights(registered.network);
      const txidsWithHeight = new Set(remainingHeights.heights.flatMap((entry) => entry.txids));
      const listed = await fileRepository.listTransactions(registered.network);
      for (const transaction of listed.transactions) {
        if (!observed.has(transaction.txid) && !txidsWithHeight.has(transaction.txid)) {
          await fileRepository.deleteTransaction(registered.network, transaction.txid);
        }
      }
    }
    return hydrate(registered);
  }

  return {
    putAddress: (resource: P2pkhKeyResource): void => { resources.set(resourceKey(assertResource(resource)), assertResource(resource)); },
    removeResource: (resourceId: string): void => {
      for (const [key, resource] of [...resources]) if (resource.resourceId === resourceId) resources.delete(key);
      snapshots.delete(resourceId);
    },
    listAddresses: (): P2pkhKeyResource[] => [...resources.values()],
    getResource: (resourceId: string): P2pkhKeyResource | undefined => [...resources.values()].find((resource) => resource.resourceId === resourceId),
    getSnapshot: (resourceId: string): P2pkhChainSnapshot | undefined => snapshots.get(resourceId),
    listSnapshots: (): P2pkhChainSnapshot[] => [...snapshots.values()],
    hydrate,
    ingestConfirmed,
    applyReorg,
    clearAll: (): void => { resources.clear(); snapshots.clear(); },
    getFileRepository: (): P2pkhFileRepositoryHandle => fileRepository,
  };
}

export type P2pkhChainStoreHandle = ReturnType<typeof createP2pkhChainStore>;
