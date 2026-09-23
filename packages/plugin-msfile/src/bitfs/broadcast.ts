// BitFS 交易 outbox 与广播对账。
//
// 中文说明：
//   - 调用应用节点适配器之前，必须先持久化 exact 交易原文与 canonical txid；
//   - 广播结果未知时只按 txid 对账，绝不重新签名或生成另一份交易；
//   - 重试只重放已持久化的 exact bytes，保证幂等；
//   - 本模块不持有私钥、不解析池业务状态、不决定业务是否完成。

import type { OwnerFileStore } from "@keymaster/contracts";
import { isDefinitelyNotDispatchedBroadcastError } from "@keymaster/contracts";
import { transactionID } from "go-bitfs";

const TX_FORMAT = "keymaster.bitfs-tx";
const TX_VERSION = 1;
const ID_PATTERN = /^[0-9a-f]{64}$/u;

/** 一笔 BitFS 交易在本地 outbox 中的状态。 */
export type BitfsTransactionState =
  /** 已持久化、尚未广播。 */
  | "prepared"
  /** 已广播但结果未知；必须按 txid 对账。 */
  | "result-unknown"
  /** 已确认上链或进入内存池。 */
  | "confirmed"
  /** 确定未派发；允许重放同一 exact bytes。 */
  | "failed";

/** 交易 outbox 的恢复索引；不包含交易原文。 */
export interface BitfsTransactionRecord {
  /** canonical txid（64 位小写 hex）。 */
  txid: string;
  /** 当前本地状态。 */
  state: BitfsTransactionState;
  /** 已尝试广播次数。 */
  attempts: number;
  /** 最后更新时间，UTC ISO-8601。 */
  updatedAt: string;
  /** 最近一次失败或未知原因，仅用于诊断。 */
  lastError?: string;
}

/** 交易 outbox 持久化端口；与协议 Artifact journal 共用独立 purpose。 */
export interface BitfsTransactionJournal {
  /** 先写入 exact 交易原文与 canonical txid；同一 txid 绑定不同字节时拒绝。 */
  putTransaction(txid: string, rawTx: Uint8Array, nowMs: number): Promise<void>;
  /** 读取 exact 交易原文副本。 */
  getTransaction(txid: string): Promise<Uint8Array | undefined>;
  /** 读取恢复索引。 */
  getTransactionRecord(txid: string): Promise<BitfsTransactionRecord | undefined>;
  /** 更新恢复索引；不覆盖交易原文。 */
  markTransaction(input: {
    /** canonical txid。 */
    txid: string;
    /** 新状态。 */
    state: BitfsTransactionState;
    /** 更新后的尝试次数。 */
    attempts: number;
    /** 诊断原因。 */
    lastError?: string;
    /** 当前时间毫秒。 */
    nowMs: number;
  }): Promise<void>;
  /** 列出全部 outbox 记录；用于恢复时按 txid 对账。 */
  listTransactions(): Promise<BitfsTransactionRecord[]>;
}

export function createBitfsTransactionJournal(store: OwnerFileStore): BitfsTransactionJournal {
  const rawPath = (txid: string) => `transactions/${assertId(txid)}.bin`;
  const recordPath = (txid: string) => `transactions/${assertId(txid)}.json`;
  const readRecord = async (txid: string): Promise<BitfsTransactionRecord | undefined> => {
    const object = await store.get(recordPath(txid));
    if (!object) return undefined;
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(object.bytes)); } catch { throw new Error("BitFS 交易 outbox 索引损坏"); }
    return parseRecord(value, txid);
  };
  return {
    async putTransaction(txid, rawTx, nowMs) {
      assertId(txid);
      if (!(rawTx instanceof Uint8Array) || rawTx.byteLength === 0) throw new TypeError("BitFS 交易原文不能为空");
      const prior = await store.get(rawPath(txid));
      if (prior && !equal(prior.bytes, rawTx)) throw new Error("BitFS txid 已绑定不同交易字节");
      if (!prior) await store.put(rawPath(txid), rawTx.slice(), { ifNoneMatch: "*" });
      const committed = await store.get(rawPath(txid));
      if (!committed || !equal(committed.bytes, rawTx)) throw new Error("BitFS 交易 outbox 持久化校验失败");
      const existing = await readRecord(txid);
      if (!existing) {
        await store.put(recordPath(txid), encodeRecord({ txid, state: "prepared", attempts: 0, updatedAt: iso(nowMs) }), { ifNoneMatch: "*" });
      }
    },
    async getTransaction(txid) {
      const object = await store.get(rawPath(txid));
      return object?.bytes.slice();
    },
    getTransactionRecord: readRecord,
    async markTransaction(input) {
      const existing = await readRecord(input.txid);
      if (!existing) throw new Error("BitFS 交易尚未进入 outbox");
      await store.put(recordPath(input.txid), encodeRecord({
        txid: input.txid,
        state: input.state,
        attempts: input.attempts,
        updatedAt: iso(input.nowMs),
        ...(input.lastError === undefined ? {} : { lastError: input.lastError.slice(0, 256) }),
      }));
    },
    async listTransactions() {
      const records: BitfsTransactionRecord[] = [];
      let cursor: string | undefined;
      do {
        const page = await store.list({ prefix: "transactions/", limit: 200, ...(cursor === undefined ? {} : { cursor }) });
        for (const file of page.files) {
          const match = /^transactions\/([0-9a-f]{64})\.json$/u.exec(file.path);
          if (!match) continue;
          const record = await readRecord(match[1]!);
          if (record) records.push(record);
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return records;
    },
  };
}

/** 应用节点适配器端口；SDK 不广播、不声称节点接受。 */
export interface BitfsChainPort {
  /** 提交已签名原始交易；返回 Provider 的确定受理结果。 */
  broadcast(input: {
    /** canonical txid。 */
    txid: string;
    /** 已签名原始交易 hex。 */
    rawTxHex: string;
  }): Promise<{ outcome: "accepted" | "already-known" }>;
  /** 按 txid 查询链上/内存池状态；查询失败或超时必须返回 unknown，不得当作 absent。 */
  lookupTransaction(txid: string): Promise<"confirmed" | "mempool" | "absent" | "unknown">;
}

/** 一次广播/对账的稳定结果。 */
export type BitfsBroadcastOutcome =
  | { status: "confirmed"; txid: string; attempts: number }
  | { status: "result-unknown"; txid: string; attempts: number; retryable: boolean; reason?: string }
  | { status: "failed"; txid: string; attempts: number; reason: string };

export interface BitfsTransactionBroadcasterDeps {
  /** 交易 outbox。 */
  journal: BitfsTransactionJournal;
  /** 应用节点适配器。 */
  chain: BitfsChainPort;
  /** 显式可信时钟。 */
  nowMs(): number;
}

/**
 * BitFS 交易广播器：persist-before-broadcast、按 txid 对账、exact bytes 重放。
 *
 * 中文说明：`submit` 与 `retry` 永远不会重新签名；它们只广播 outbox 中已经
 * 持久化的 exact bytes。`reconcile` 只查询，不广播。
 */
export class BitfsTransactionBroadcaster {
  constructor(private readonly deps: BitfsTransactionBroadcasterDeps) {}

  /** 先持久化再广播一笔新交易；同 txid 已存在时只重放已保存字节。 */
  async submit(rawTx: Uint8Array, signal?: AbortSignal): Promise<BitfsBroadcastOutcome> {
    if (!(rawTx instanceof Uint8Array) || rawTx.byteLength === 0) throw new TypeError("BitFS 广播需要非空交易原文");
    const txid = canonicalTxid(rawTx);
    const existing = await this.deps.journal.getTransaction(txid);
    if (existing && !equal(existing, rawTx)) throw new Error("BitFS txid 已绑定不同交易字节");
    await this.deps.journal.putTransaction(txid, rawTx, this.deps.nowMs());
    const record = await this.deps.journal.getTransactionRecord(txid);
    if (record?.state === "confirmed") return { status: "confirmed", txid, attempts: record.attempts };
    return this.dispatch(txid, rawTx, signal);
  }

  /** 按 txid 对账一笔结果未知交易；不广播、不重签。 */
  async reconcile(txid: string, _signal?: AbortSignal): Promise<BitfsBroadcastOutcome> {
    const record = await this.deps.journal.getTransactionRecord(txid);
    if (!record) return { status: "failed", txid, attempts: 0, reason: "unknown_transaction" };
    if (record.state === "confirmed") return { status: "confirmed", txid, attempts: record.attempts };
    let lookup: Awaited<ReturnType<BitfsChainPort["lookupTransaction"]>>;
    try {
      lookup = await this.deps.chain.lookupTransaction(txid);
    } catch {
      return { status: "result-unknown", txid, attempts: record.attempts, retryable: false, reason: "lookup-failed" };
    }
    if (lookup === "confirmed" || lookup === "mempool") {
      await this.mark(txid, "confirmed", record.attempts);
      return { status: "confirmed", txid, attempts: record.attempts };
    }
    if (lookup === "absent") {
      // 已广播但查不到：可能是传播延迟或已丢弃。只允许重放 exact bytes，绝不重签。
      return { status: "result-unknown", txid, attempts: record.attempts, retryable: true, reason: "absent" };
    }
    return { status: "result-unknown", txid, attempts: record.attempts, retryable: false, reason: "lookup-unknown" };
  }

  /** 重放 outbox 中已保存的 exact bytes；已确认交易直接返回。 */
  async retry(txid: string, signal?: AbortSignal): Promise<BitfsBroadcastOutcome> {
    const record = await this.deps.journal.getTransactionRecord(txid);
    if (!record) return { status: "failed", txid, attempts: 0, reason: "unknown_transaction" };
    if (record.state === "confirmed") return { status: "confirmed", txid, attempts: record.attempts };
    const rawTx = await this.deps.journal.getTransaction(txid);
    if (!rawTx) return { status: "failed", txid, attempts: record.attempts, reason: "missing_transaction_bytes" };
    return this.dispatch(txid, rawTx, signal);
  }

  /**
   * 从已持久化的会话交易恢复：新交易或尚未派发状态可发送 exact bytes；
   * 已派发状态只查询 txid，避免重启时盲目重放。
   */
  async resume(rawTx: Uint8Array, signal?: AbortSignal): Promise<BitfsBroadcastOutcome> {
    if (!(rawTx instanceof Uint8Array) || rawTx.byteLength === 0) throw new TypeError("BitFS 恢复需要非空交易原文");
    const txid = canonicalTxid(rawTx);
    const existing = await this.deps.journal.getTransactionRecord(txid);
    if (!existing || existing.state === "prepared" || existing.state === "failed") return this.submit(rawTx, signal);
    const stored = await this.deps.journal.getTransaction(txid);
    if (!stored || !equal(stored, rawTx)) throw new Error("BitFS 恢复交易与 outbox exact bytes 不一致");
    return this.reconcile(txid, signal);
  }

  private async dispatch(txid: string, rawTx: Uint8Array, signal?: AbortSignal): Promise<BitfsBroadcastOutcome> {
    const record = await this.deps.journal.getTransactionRecord(txid);
    const attempts = (record?.attempts ?? 0) + 1;
    if (signal?.aborted) {
      await this.mark(txid, "failed", attempts, "cancelled-before-dispatch");
      return { status: "failed", txid, attempts, reason: "cancelled" };
    }
    try {
      await this.deps.chain.broadcast({ txid, rawTxHex: toHex(rawTx) });
      // Provider 2xx 只证明已接收请求，不是 mempool/链上事实。
      // 业务状态必须等 reconcile 观察到 unconfirmed/confirmed 后才推进。
      await this.mark(txid, "result-unknown", attempts, "provider-accepted-awaiting-observation");
      return { status: "result-unknown", txid, attempts, retryable: false, reason: "provider-accepted-awaiting-observation" };
    } catch (error) {
      const reason = errorText(error);
      if (isDefinitelyNotDispatchedBroadcastError(error)) {
        await this.mark(txid, "failed", attempts, reason);
        return { status: "failed", txid, attempts, reason };
      }
      // 超时、断网、Provider 已收到但未回执等一律按结果未知处理。
      await this.mark(txid, "result-unknown", attempts, reason);
      return { status: "result-unknown", txid, attempts, retryable: true, ...(reason === undefined ? {} : { reason }) };
    }
  }

  private async mark(txid: string, state: BitfsTransactionState, attempts: number, lastError?: string): Promise<void> {
    await this.deps.journal.markTransaction({
      txid,
      state,
      attempts,
      ...(lastError === undefined ? {} : { lastError }),
      nowMs: this.deps.nowMs(),
    });
  }
}

function parseRecord(value: unknown, expectedTxid: string): BitfsTransactionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("BitFS 交易 outbox 索引格式错误");
  const row = value as Record<string, unknown>;
  const keys = ["format", "version", "txid", "state", "attempts", "updatedAt", "lastError"];
  if (Object.keys(row).some((key) => !keys.includes(key))
    || row.format !== TX_FORMAT
    || row.version !== TX_VERSION
    || row.txid !== assertId(expectedTxid)) throw new Error("BitFS 交易 outbox 索引格式错误");
  const states: BitfsTransactionState[] = ["prepared", "result-unknown", "confirmed", "failed"];
  if (!states.includes(row.state as BitfsTransactionState)) throw new Error("BitFS 交易 outbox 状态错误");
  if (!Number.isSafeInteger(row.attempts) || (row.attempts as number) < 0) throw new Error("BitFS 交易 outbox 尝试次数错误");
  const updatedAt = String(row.updatedAt);
  if (!Number.isFinite(Date.parse(updatedAt)) || new Date(Date.parse(updatedAt)).toISOString() !== updatedAt) throw new Error("BitFS 交易 outbox 时间错误");
  const lastError = row.lastError === undefined ? undefined : String(row.lastError);
  if (lastError !== undefined && lastError.length > 256) throw new Error("BitFS 交易 outbox 诊断文本过长");
  return {
    txid: expectedTxid,
    state: row.state as BitfsTransactionState,
    attempts: row.attempts as number,
    updatedAt,
    ...(lastError === undefined ? {} : { lastError }),
  };
}

function encodeRecord(record: Omit<BitfsTransactionRecord, "lastError"> & { lastError?: string }): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify({ format: TX_FORMAT, version: TX_VERSION, ...record }, null, 2)}\n`);
}

function canonicalTxid(rawTx: Uint8Array): string {
  const digest = transactionID(rawTx);
  if (digest.byteLength !== 32) throw new Error("BitFS 交易 txid 宽度错误");
  return toHex(digest);
}

function assertId(value: string): string {
  if (!ID_PATTERN.test(value)) throw new TypeError("BitFS txid 必须是 32 字节小写 hex");
  return value;
}

function iso(nowMs: number): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError("BitFS 交易 outbox 时间不合法");
  return new Date(nowMs).toISOString();
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 256) : String(error).slice(0, 256);
}
