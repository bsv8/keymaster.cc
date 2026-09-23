// BitFS 交易对 WoC 的 Worker 内部适配。
// 只把已签名 raw transaction 与 txid 事实投影成 BitfsChainPort。

import type { BsvNetwork, WocServiceHandle } from "@keymaster/contracts";
import type { BitfsChainPort, BitfsBroadcastOutcome, BitfsTransactionJournal } from "./broadcast.js";
import { BitfsTransactionBroadcaster } from "./broadcast.js";
import type { BitfsSessionJournal, BitfsSessionRecord } from "./sessionJournal.js";
import { transactionID } from "go-bitfs";

/** 创建只能在 Coordinator Worker 内装配的 BitFS 链端口。 */
export function createBitfsWocChainPort(woc: WocServiceHandle, network: BsvNetwork): BitfsChainPort {
  return {
    async broadcast(input) {
      const result = await woc.broadcast(network, input.rawTxHex);
      if (result.canonicalTxid !== input.txid || result.txidIntegrity === "mismatch") {
        throw new Error("WoC 广播回执与 BitFS canonical txid 不一致");
      }
      return { outcome: result.txidIntegrity === "missing" ? "already-known" : "accepted" };
    },
    async lookupTransaction(txid) {
      try {
        const result = await woc.getTransactionObservation(network, txid);
        if (result.canonicalTxid !== txid) return "unknown";
        if (result.observation === "confirmed") return "confirmed";
        if (result.observation === "unconfirmed") return "mempool";
        return "absent";
      } catch {
        return "unknown";
      }
    },
  };
}

/** Worker 启动/解锁后只查询未确定交易，不在恢复阶段自动广播。 */
export async function reconcileBitfsTransactions(input: {
  /** BitFS 交易 outbox。 */
  journal: BitfsTransactionJournal;
  /** 按 txid 查询的广播器。 */
  broadcaster: BitfsTransactionBroadcaster;
  /** 取消 Worker 恢复。 */
  signal?: AbortSignal;
}): Promise<BitfsBroadcastOutcome[]> {
  const records = await input.journal.listTransactions();
  const outcomes: BitfsBroadcastOutcome[] = [];
  for (const record of records) {
    if (input.signal?.aborted) throw new DOMException("BitFS 交易对账已取消", "AbortError");
    // outbox 可能已写 confirmed，但 Worker 在回写会话前崩溃。
    // 因此必须把已确认记录也返回，使会话投影可重入。
    if (record.state === "confirmed") {
      outcomes.push({ status: "confirmed", txid: record.txid, attempts: record.attempts });
      continue;
    }
    if (record.state === "failed") continue;
    outcomes.push(await input.broadcaster.reconcile(record.txid, input.signal));
  }
  return outcomes;
}

/**
 * 把启动对账观察到的交易事实投影回买卖会话。
 * 只有 confirmed/mempool 事实才推进阶段；unknown/absent 保留原状继续对账。
 */
export async function reconcileBitfsSessionTransactions(input: {
  /** Keymaster 买卖会话 journal。 */
  sessions: BitfsSessionJournal;
  /** 本次交易对账结果。 */
  outcomes: readonly BitfsBroadcastOutcome[];
  /** 显式当前时间。 */
  nowMs: number;
}): Promise<void> {
  const confirmed = new Set(input.outcomes.filter((item) => item.status === "confirmed").map((item) => item.txid));
  if (confirmed.size === 0) return;
  for (const record of await input.sessions.list()) {
    if (!record.pendingTxid || !confirmed.has(record.pendingTxid)) continue;
    const phase = confirmedPhase(record);
    if (!phase) continue;
    try {
      await input.sessions.update(record.sessionId, record.revision, { phase, pendingTxid: undefined }, input.nowMs);
    } catch (error) {
      // 另一条串行路径已推进时重新读取；只有目标事实尚未体现才上抛 CAS 冲突。
      const current = await input.sessions.get(record.sessionId);
      if (!current || current.pendingTxid === record.pendingTxid) throw error;
    }
  }
}

function confirmedPhase(record: BitfsSessionRecord): BitfsSessionRecord["phase"] | undefined {
  if (record.role === "seller") {
    if (record.phase === "payment-unknown" || record.phase === "arbitration-payment-unknown") return "paid";
    if (record.phase === "close-unknown") return "closed";
    return undefined;
  }
  if (record.phase === "funding-unknown") return "funded";
  if (record.phase === "payment-unknown") return "completed";
  return undefined;
}

/**
 * 从资金交易 output[0] 开始追踪支付池花费链，返回每一笔完整交易原文。
 * 调用方必须再用 go-bitfs pool evidence 全量验证，不得只信 WoC 的 spender 关系。
 */
export async function readBitfsPoolSpendChain(input: {
  /** Worker 内 WoC 句柄。 */
  woc: WocServiceHandle;
  /** 链网络。 */
  network: BsvNetwork;
  /** 资金交易 canonical txid。 */
  fundingTxid: string;
  /** 取消对账。 */
  signal?: AbortSignal;
  /** 最多跟踪付款数，防止恶意/损坏关系无界扫描。 */
  maxPayments?: number;
}): Promise<Array<{ txid: string; rawTransaction: Uint8Array; status: "confirmed" | "unconfirmed" }>> {
  let current = assertTxid(input.fundingTxid);
  const maxPayments = input.maxPayments ?? 4_096;
  if (!Number.isSafeInteger(maxPayments) || maxPayments < 1 || maxPayments > 100_000) throw new TypeError("BitFS 支付链扫描上限不合法");
  const seen = new Set<string>([current]);
  const result: Array<{ txid: string; rawTransaction: Uint8Array; status: "confirmed" | "unconfirmed" }> = [];
  for (let index = 0; index < maxPayments; index += 1) {
    if (input.signal?.aborted) throw new DOMException("BitFS 支付链对账已取消", "AbortError");
    const spent = await input.woc.getSpentOutput(input.network, current, 0, { signal: input.signal, priority: "interactive" });
    if (!spent) return result;
    const txid = assertTxid(spent.txid);
    if (seen.has(txid)) throw new Error("BitFS 支付链出现循环 spender 关系");
    const rawHex = await input.woc.getRawTransaction?.(input.network, txid, { signal: input.signal, priority: "interactive" });
    if (typeof rawHex !== "string") throw new Error("WoC 未提供 BitFS 支付交易原文");
    const rawTransaction = fromHex(rawHex);
    if (toHex(transactionID(rawTransaction)) !== txid) throw new Error("BitFS 支付交易原文与 txid 不匹配");
    result.push({ txid, rawTransaction, status: spent.status });
    seen.add(txid);
    current = txid;
  }
  throw new Error("BitFS 支付链超过扫描上限");
}

function assertTxid(value: string): string { if (!/^[0-9a-f]{64}$/u.test(value)) throw new TypeError("BitFS txid 不合法"); return value; }
function fromHex(value: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/u.test(value)) throw new Error("WoC 交易原文不是小写 hex");
  return Uint8Array.from(value.match(/../gu) ?? [], (part) => Number.parseInt(part, 16));
}
function toHex(value: Uint8Array): string { return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(""); }
