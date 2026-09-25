// BitFS 交易对 WoC 的 Worker 内部适配。
// 只把已签名 raw transaction 与 txid 事实投影成 BitfsChainPort。

import type { BsvNetwork, WocServiceHandle } from "@keymaster/contracts";
import type { BitfsChainPort, BitfsBroadcastOutcome, BitfsTransactionJournal } from "./broadcast.js";
import { BitfsTransactionBroadcaster } from "./broadcast.js";
import type { BitfsSessionJournal, BitfsSessionRecord } from "./sessionJournal.js";
import { bitfsTxidHex } from "./txid.js";

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
  // 买方的交易阶段还必须同步专款账本、生成 Kind 4，或核对已验收内容。
  // 单凭 outbox 的 confirmed 不能完成这些应用状态转换；由买方任务按 exact
  // FundingTx 专项恢复，避免把 FundingTx 误当作内容付款并标记文件已完成。
  return undefined;
}

export type BitfsPoolSpendChain =
  | { kind: "unspent" }
  | { kind: "unknown"; reason: "spender_raw_unavailable" }
  | { kind: "unchanged"; txid: string }
  | { kind: "spender"; txid: string; rawTransaction: Uint8Array; status: "confirmed" | "unconfirmed" };

/**
 * 读取费用池开池输出当前被哪一版累计付款状态花费，并返回其 exact 原文。
 * MultisigPool 的付款更新都竞争花费同一个开池输出，不是前后交易串接；调用方
 * 仍须用 go-bitfs 验证新状态，不得只信 WoC 的 spender 关系。
 */
export async function readBitfsPoolSpendChain(input: {
  /** Worker 内 WoC 句柄。 */
  woc: WocServiceHandle;
  /** 链网络。 */
  network: BsvNetwork;
  /** 资金交易 canonical txid。 */
  fundingTxid: string;
  /** 最近一次已经验收的累计池状态交易；相同 spender 表示没有新状态。 */
  afterTxid?: string;
  /** 取消对账。 */
  signal?: AbortSignal;
  /** 保持旧调用兼容的扫描上限；现在每次最多读取开池输出的一个当前 spender。 */
  maxPayments?: number;
}): Promise<BitfsPoolSpendChain> {
  const fundingTxid = assertTxid(input.fundingTxid);
  const afterTxid = input.afterTxid === undefined ? undefined : assertTxid(input.afterTxid);
  const maxPayments = input.maxPayments ?? 8_194;
  if (!Number.isSafeInteger(maxPayments) || maxPayments < 1 || maxPayments > 100_000) throw new TypeError("BitFS 支付链扫描上限不合法");
  if (input.signal?.aborted) throw new DOMException("BitFS 支付状态查询已取消", "AbortError");
  let spent: Awaited<ReturnType<WocServiceHandle["getSpentOutput"]>> = null;
  for (let attempt = 0; ; attempt += 1) {
    try {
      spent = await input.woc.getSpentOutput(input.network, fundingTxid, 0, { signal: input.signal, priority: "interactive" });
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= 20 || !/WOC 400/u.test(message)) throw new Error(`BitFS WOC spender query failed for ${fundingTxid}: ${message}`, { cause: error });
      await waitForAbortableDelay(3_000, input.signal);
    }
  }
  if (!spent) return { kind: "unspent" };
  const txid = assertTxid(spent.txid);
  if (afterTxid !== undefined && txid === afterTxid) return { kind: "unchanged", txid };
  let rawHex: string | undefined;
  try {
    rawHex = await input.woc.getRawTransaction?.(input.network, txid, { signal: input.signal, priority: "interactive" });
  } catch (error) {
    if (spent.status === "unconfirmed" && error instanceof Error && /WOC 404/u.test(error.message)) {
      return { kind: "unknown", reason: "spender_raw_unavailable" };
    }
    throw error;
  }
  if (typeof rawHex !== "string") {
    if (spent.status === "unconfirmed") return { kind: "unknown", reason: "spender_raw_unavailable" };
    throw new Error("WoC 未提供 BitFS 付款交易原文");
  }
  const rawTransaction = fromHex(rawHex);
  if (bitfsTxidHex(rawTransaction) !== txid) throw new Error("BitFS 付款交易原文与 txid 不匹配");
  return { kind: "spender", txid, rawTransaction, status: spent.status };
}

function assertTxid(value: string): string { if (!/^[0-9a-f]{64}$/u.test(value)) throw new TypeError("BitFS txid 不合法"); return value; }
async function waitForAbortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException("BitFS 支付状态查询已取消", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = (): void => { clearTimeout(timer); cleanup(); reject(new DOMException("BitFS 支付状态查询已取消", "AbortError")); };
    const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
function fromHex(value: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/u.test(value)) throw new Error("WoC 交易原文不是小写 hex");
  return Uint8Array.from(value.match(/../gu) ?? [], (part) => Number.parseInt(part, 16));
}
