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
import type { P2pkhUtxoBinding, P2pkhUtxoSnapshotItem, P2pkhUtxoSnapshotResult, P2pkhUtxoSnapshotState } from "@keymaster/contracts";

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
  seq: number;
  state: Exclude<P2pkhUtxoSnapshotState, "unavailable">;
  /** 已消费快照对应的交易；只在 Worker 内存中保存，用于丢弃交易解封。 */
  consumedByTxid?: string;
  /** 消费发生时间；用于限制自动解封的最短等待窗口。 */
  consumedAt?: string;
}

/** Worker 广播门禁消费结果。此操作必须在同一 JS tick 内完成。 */
export type P2pkhUtxoSnapshotConsumeResult =
  | { status: "untouched" }
  | { status: "consumed"; seq: number; touchedOutpointKeys: string[] }
  | {
      status: "rejected";
      reason: "snapshot-stale" | "snapshot-consumed" | "snapshot-binding-required" | "snapshot-input-invalid";
      currentSeq?: number;
    };

export interface P2pkhUtxoSnapshotStore {
  refresh(resource: P2pkhUtxoSnapshotResource, options?: { signal?: AbortSignal }): Promise<P2pkhUtxoSnapshotResult>;
  get(resource: P2pkhUtxoSnapshotResource): P2pkhUtxoSnapshotResult;
  /**
   * 在 Worker 同步块内核对绑定、输入归属并消费快照。
   * 中文：返回 consumed 后，该序号在下一次内容变化刷新前不可再次提交。
   */
  consume(resource: P2pkhUtxoSnapshotResource, input: {
    binding?: P2pkhUtxoBinding;
    inputOutpointKeys: readonly string[];
    /** 实际广播交易 ID；用于消费结果未知时的只读链上观察。 */
    txid?: string;
  }): P2pkhUtxoSnapshotConsumeResult;
  /** 写前审计或参数校验失败时回滚本次尚未派发的消费。 */
  rollbackConsume(resource: P2pkhUtxoSnapshotResource, binding: P2pkhUtxoBinding): boolean;
  /**
   * 检查已消费快照对应的交易是否已被 WoC 丢弃。
   * 中文：只有超过等待阈值且 observation 未返回时，才复用旧序号解封；
   * confirmed / unconfirmed / 观察失败都保持 consumed。
   */
  reconcileConsumed(resource: P2pkhUtxoSnapshotResource, options?: { thresholdMs?: number }): Promise<boolean>;
  clearOwner(publicKeyHex: string): void;
  clearAll(): void;
}

/** 消费交易等待链上观察的最短时间；防止短暂传播延迟误解封。 */
export const P2PKH_CONSUMED_RECONCILE_THRESHOLD_MS = 10 * 60 * 1_000;

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
  /** Worker 会话内全局单调序号；不落盘，重启后重新从 1 发号。 */
  let nextSeq = 0;
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
  /** 消费/清除版本；用于使广播前已经发起的刷新不能覆盖消费状态。 */
  const mutations = new Map<string, number>();
  const knownKeys = new Set<string>();

  function snapshotKey(resource: P2pkhUtxoSnapshotResource): string {
    // owner + network + address + generation：地址或代际变化即视为不同资源，
    // 旧快照不会被复用，旧地址的迟到响应也不能覆盖新地址结果。
    return `${resource.publicKeyHex.toLowerCase()}:${resource.network}:${resource.address}:${resource.generation}`;
  }

  function epochFor(key: string): number {
    return epochs.get(key) ?? 0;
  }

  function mutationFor(key: string): number {
    return mutations.get(key) ?? 0;
  }

  function invalidate(key: string): void {
    epochs.set(key, epochFor(key) + 1);
    mutations.set(key, mutationFor(key) + 1);
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
      const mutation = mutationFor(key);
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
        // 消费可能发生在网络请求期间；迟到响应只能返回当前状态，不能解封
        // 已消费的旧序号，也不能覆盖同一 tick 的其它 Worker 门禁结果。
        if (mutationFor(key) !== mutation) {
          return toResult(snapshots.get(key));
        }
        const previous = snapshots.get(key);
        const sameContent = previous !== undefined && equalSnapshotItems(previous.items, items);
        const stored: StoredSnapshot = sameContent
          ? { ...previous, items, syncedAt: now() }
          : { items, syncedAt: now(), seq: ++nextSeq, state: "fresh" };
        // 原子替换：只有完整校验通过且代际未变才写入。
        snapshots.set(key, stored);
        return toResult(stored);
      })();
      inFlight.set(key, task);
      try {
        return await task;
      } finally {
        if (inFlight.get(key) === task) inFlight.delete(key);
      }
    },
    get(resource): P2pkhUtxoSnapshotResult {
      return toResult(snapshots.get(snapshotKey(resource)));
    },
    consume(resource, input): P2pkhUtxoSnapshotConsumeResult {
      const key = snapshotKey(resource);
      const stored = snapshots.get(key);
      if (!stored) return { status: "untouched" };
      const inputKeys = [...new Set(input.inputOutpointKeys)];
      const itemKeys = new Set(stored.items.map((item) => `${item.txid}:${item.vout}`));
      const touchedOutpointKeys = inputKeys.filter((outpointKey) => itemKeys.has(outpointKey));
      // 中文：带 binding 就表示交易声称使用了当前钱包快照。若一个输入都
      // 不在快照中，不能把它当成纯协议交易放行，否则过期/伪造 binding
      // 会绕过序号门禁；无 binding 的纯协议输入才允许 untouched。
      if (touchedOutpointKeys.length === 0) {
        return input.binding
          ? { status: "rejected", reason: "snapshot-input-invalid", currentSeq: stored.seq }
          : { status: "untouched" };
      }
      if (!input.binding || input.binding.resourceId !== resource.resourceId) {
        return { status: "rejected", reason: "snapshot-binding-required", currentSeq: stored.seq };
      }
      if (stored.state === "consumed") {
        return { status: "rejected", reason: "snapshot-consumed", currentSeq: stored.seq };
      }
      if (input.binding.seq !== stored.seq) {
        return { status: "rejected", reason: "snapshot-stale", currentSeq: stored.seq };
      }
      if (touchedOutpointKeys.some((outpointKey) => stored.items.some((item) => `${item.txid}:${item.vout}` === outpointKey && item.isSpentInMempoolTx))) {
        return { status: "rejected", reason: "snapshot-input-invalid", currentSeq: stored.seq };
      }
      snapshots.set(key, {
        ...stored,
        state: "consumed",
        ...(input.txid === undefined ? {} : { consumedByTxid: input.txid }),
        consumedAt: now(),
      });
      mutations.set(key, mutationFor(key) + 1);
      return { status: "consumed", seq: stored.seq, touchedOutpointKeys };
    },
    rollbackConsume(resource, binding): boolean {
      const key = snapshotKey(resource);
      const stored = snapshots.get(key);
      if (!stored || stored.state !== "consumed" || stored.seq !== binding.seq) return false;
      snapshots.set(key, { ...stored, state: "fresh", consumedByTxid: undefined, consumedAt: undefined });
      mutations.set(key, mutationFor(key) + 1);
      return true;
    },
    async reconcileConsumed(resource, options): Promise<boolean> {
      const key = snapshotKey(resource);
      const stored = snapshots.get(key);
      if (stored?.state !== "consumed" || !stored.consumedByTxid || !stored.consumedAt) return false;
      const epoch = epochFor(key);
      const mutation = mutationFor(key);
      const thresholdMs = options?.thresholdMs ?? P2PKH_CONSUMED_RECONCILE_THRESHOLD_MS;
      const consumedAtMs = Date.parse(stored.consumedAt);
      const nowMs = Date.parse(now());
      if (!Number.isFinite(consumedAtMs) || !Number.isFinite(nowMs) || nowMs - consumedAtMs < thresholdMs) return false;

      let observation: Awaited<ReturnType<WocService["getTransactionObservation"]>>;
      try {
        observation = await deps.woc.getTransactionObservation(resource.network, stored.consumedByTxid, { priority: "background" });
      } catch {
        // 观察失败不能改变 consumed；下一次同步仍会继续检查。
        return false;
      }
      if (observation.observation !== undefined) return false;

      // observation 跨越 await，必须再次确认期间没有刷新、消费、清除或
      // 回滚，避免旧观察结果解封新一代快照。
      const current = snapshots.get(key);
      if (!current || current.state !== "consumed"
        || current.seq !== stored.seq
        || current.consumedByTxid !== stored.consumedByTxid
        || epochFor(key) !== epoch
        || mutationFor(key) !== mutation) return false;
      snapshots.set(key, { ...current, state: "fresh", consumedByTxid: undefined, consumedAt: undefined });
      mutations.set(key, mutationFor(key) + 1);
      return true;
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

  function toResult(stored: StoredSnapshot | undefined): P2pkhUtxoSnapshotResult {
    if (!stored) return { available: false, state: "unavailable", items: [] };
    if (stored.state === "consumed") {
      return { available: false, seq: stored.seq, state: "consumed", syncedAt: stored.syncedAt, items: [] };
    }
    return { available: true, seq: stored.seq, state: "fresh", syncedAt: stored.syncedAt, items: stored.items };
  }
}

function equalSnapshotItems(left: readonly P2pkhUtxoSnapshotItem[], right: readonly P2pkhUtxoSnapshotItem[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    if (a.txid !== b.txid || a.vout !== b.vout || a.value !== b.value || a.height !== b.height
      || a.status !== b.status || a.isSpentInMempoolTx !== b.isSpentInMempoolTx || a.script !== b.script) return false;
  }
  return true;
}
