// P2PKH UTXO 内存快照：WoC `unspent/all` 是唯一真值来源。
//
// 规则（2026-09-20 定案）：
//   - 快照只存在于 Coordinator Worker 内存，不写文件、不写 K-V；
//   - 每个 owner + network + address 一次 `unspent/all` 请求；
//   - 新响应完整校验成功后原子替换旧快照；
//   - 请求失败、超时、429、JSON 错误、字段冲突时保留旧快照并抛错，
//     绝不把余额写成 0；
//   - `isSpentInMempoolTx=true` 的输出保留在快照中用于展示，但不进入
//     可花费集合，也不参与选币；
//   - 锁定钱包 / 切换 owner / 销毁会话时由调用方清除对应快照。

import type { WocService, WocUtxoResponse } from "@keymaster/contracts";
import type { P2pkhUtxoSnapshotItem, P2pkhUtxoSnapshotResult } from "@keymaster/contracts";

const TXID_PATTERN = /^[0-9a-f]{64}$/u;

export interface P2pkhUtxoSnapshotResource {
  resourceId: string;
  publicKeyHex: string;
  network: "main" | "test";
  address: string;
  /**
   * 资源代际：地址被重新派生或资源被删除重建时自增。
   *
   * 参与快照键，确保“同一 Owner 同一网络换了地址”后不会读到旧地址的
   * 快照，也不会被旧地址的迟到响应覆盖。
   */
  generation: number;
}

interface StoredSnapshot {
  items: P2pkhUtxoSnapshotItem[];
  syncedAt: string;
}

export interface P2pkhUtxoSnapshotStore {
  refresh(resource: P2pkhUtxoSnapshotResource, options?: { signal?: AbortSignal }): Promise<P2pkhUtxoSnapshotResult>;
  get(resource: P2pkhUtxoSnapshotResource): P2pkhUtxoSnapshotResult;
  clearOwner(publicKeyHex: string): void;
  clearAll(): void;
}

/**
 * 严格校验并归一化一次 `unspent/all` 响应。
 *
 * 任何非法字段或“同一 outpoint 内容冲突”都会抛错；调用方必须保留旧快照。
 */
export function validateP2pkhUnspentAll(rows: readonly WocUtxoResponse[]): P2pkhUtxoSnapshotItem[] {
  const byOutpoint = new Map<string, P2pkhUtxoSnapshotItem>();
  for (const row of rows) {
    const txid = String(row.txid ?? "").trim().toLowerCase();
    if (!TXID_PATTERN.test(txid)) throw new Error("WoC unspent/all returned an invalid txid");
    if (!Number.isSafeInteger(row.vout) || row.vout < 0) throw new Error("WoC unspent/all returned an invalid vout");
    if (!Number.isSafeInteger(row.value) || row.value < 0) throw new Error("WoC unspent/all returned an invalid value");
    if (row.status !== "confirmed" && row.status !== "unconfirmed") throw new Error("WoC unspent/all returned an unknown status");
    // 必填布尔：缺失/非法一律整次失败，不能按 false 放行。
    if (typeof row.isSpentInMempoolTx !== "boolean") throw new Error("WoC unspent/all returned an invalid isSpentInMempoolTx");
    if (row.script !== undefined && typeof row.script !== "string") throw new Error("WoC unspent/all returned an invalid script");
    const height = row.status === "confirmed"
      ? (Number.isSafeInteger(row.height) && row.height > 0 ? row.height : (() => { throw new Error("WoC unspent/all returned an invalid confirmed height"); })())
      : 0;
    const item: P2pkhUtxoSnapshotItem = {
      txid,
      vout: row.vout,
      value: row.value,
      height,
      status: row.status,
      isSpentInMempoolTx: row.isSpentInMempoolTx,
      ...(typeof row.script === "string" && row.script.length > 0 ? { script: row.script } : {}),
    };
    const outpointKey = `${txid}:${row.vout}`;
    const existing = byOutpoint.get(outpointKey);
    if (existing) {
      // 同 outpoint 重复且任一保留字段冲突 → 整次快照失败；完全一致则视为去重。
      if (existing.value !== item.value
        || existing.height !== item.height
        || existing.status !== item.status
        || existing.isSpentInMempoolTx !== item.isSpentInMempoolTx
        || existing.script !== item.script) {
        throw new Error(`WoC unspent/all returned conflicting duplicates for ${outpointKey}`);
      }
      continue;
    }
    byOutpoint.set(outpointKey, item);
  }
  return [...byOutpoint.values()].sort((left, right) => left.txid.localeCompare(right.txid) || left.vout - right.vout);
}

export function createP2pkhUtxoSnapshotStore(deps: { woc: WocService; now?: () => string }): P2pkhUtxoSnapshotStore {
  const now = () => deps.now?.() ?? new Date().toISOString();
  const snapshots = new Map<string, StoredSnapshot>();
  /** 同一资源的并发刷新复用同一个在途请求，避免重复消耗 WoC 限流额度。 */
  const inFlight = new Map<string, Promise<P2pkhUtxoSnapshotResult>>();
  /**
   * 每个快照键的失效纪元：锁定 / 切 Owner / 销毁会话时递增。
   *
   * 与资源 generation 不同：这里只用于使在途刷新失效。写回前复核纪元，
   * 否则旧 Owner 的迟到响应会重新写入已被清除的快照。knownKeys 保证即使
   * 请求尚未返回，也能在清除时把纪元推进到足以使该请求失效。
   */
  const epochs = new Map<string, number>();
  const knownKeys = new Set<string>();

  function snapshotKey(resource: P2pkhUtxoSnapshotResource): string {
    // owner + network + address + generation：地址或代际变化即视为不同资源，
    // 旧快照不会被复用，旧地址的迟到响应也不能覆盖新地址结果。
    return `${resource.publicKeyHex.toLowerCase()}:${resource.network}:${resource.address}:${resource.generation}`;
  }

  function epochFor(key: string): number {
    return epochs.get(key) ?? 0;
  }

  function invalidate(key: string): void {
    epochs.set(key, epochFor(key) + 1);
    snapshots.delete(key);
    inFlight.delete(key);
  }

  return {
    async refresh(resource, options): Promise<P2pkhUtxoSnapshotResult> {
      const key = snapshotKey(resource);
      knownKeys.add(key);
      const pending = inFlight.get(key);
      if (pending && !options?.signal) return pending;
      const epoch = epochFor(key);
      const task = (async (): Promise<P2pkhUtxoSnapshotResult> => {
        const rows = await deps.woc.getAddressUnspentAll(resource.network, resource.address, {
          priority: "background",
          ...(options?.signal ? { signal: options.signal } : {}),
        });
        const items = validateP2pkhUnspentAll(rows);
        // 提交前复核纪元：期间发生 lock / 切 Owner / 销毁会话时拒绝写回。
        if (epochFor(key) !== epoch) {
          throw new Error("P2PKH UTXO snapshot refresh was invalidated by an owner/session change");
        }
        const stored: StoredSnapshot = { items, syncedAt: now() };
        // 原子替换：只有完整校验通过且代际未变才写入。
        snapshots.set(key, stored);
        return { available: true, syncedAt: stored.syncedAt, items };
      })();
      inFlight.set(key, task);
      try {
        return await task;
      } finally {
        if (inFlight.get(key) === task) inFlight.delete(key);
      }
    },
    get(resource): P2pkhUtxoSnapshotResult {
      const stored = snapshots.get(snapshotKey(resource));
      if (!stored) return { available: false, items: [] };
      return { available: true, syncedAt: stored.syncedAt, items: stored.items };
    },
    clearOwner(publicKeyHex: string): void {
      const prefix = `${publicKeyHex.toLowerCase()}:`;
      for (const key of knownKeys) if (key.startsWith(prefix)) invalidate(key);
    },
    clearAll(): void {
      for (const key of knownKeys) invalidate(key);
      snapshots.clear();
    },
  };
}
