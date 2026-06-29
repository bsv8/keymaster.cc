// packages/plugin-woc/src/wocActor.ts
// WOC actor mailbox：注册 target="woc" 的 handler 统一处理 WOC 消息。
//
// 设计缘由：
//   - wocActor 是 MessageBus 的 handler 策略，不是另一套总线。
//   - 在 attach 时向 messageBus 注册 7 个 woc.* 类型的 handler；detach
//     时取消注册。
//   - handler 不直接 await 完整 fetch，而是把消息加入内部 priority queue
//     并返回 deferred promise；actor 的 pump 串行消费。
//   - priority queue + sliding window rate limit + 429 backoff + Web Locks
//     协调 + fetchJson + 404 空结果翻译 + cancel/timeout + snapshot 都
//     集中在 actor 内部。
//   - 业务插件仍走 woc.service，woc.service 内部通过 messageBus.request
//     把请求投递给 actor。
//   - actor mailbox 使用内存消息，不做 IndexedDB 持久化。
//   - 阶段 2：handler 收到的 message envelope 携带 MessageBus 内部 signal
//     （覆盖 caller signal + timeout）。actor 内部不再造 AbortController，
//     直接把 message.signal 接到 fetch 链路。

import type {
  BsvNetwork,
  Message,
  MessageBus,
  PluginLogger,
  WocBalanceResponse,
  WocBroadcastResult,
  WocConfig,
  WocHistoryPage,
  WocQueueSnapshot,
  WocRequestPriority,
  WocUnconfirmedHistory,
  WocUtxoResponse
} from "@keymaster/contracts";
import { WOC_PRIORITY } from "@keymaster/contracts";
import { loadWocConfig, saveWocConfig } from "./wocSettings.js";
import {
  WOC_ACTOR_ACCEPT_CONCURRENCY,
  WOC_ACTOR_TARGET,
  WOC_MSG,
  type WocBalancePayload,
  type WocBsv21ListTokensPayload,
  type WocBsv21TokenBalancePayload,
  type WocBroadcastPayload,
  type WocHistoryPayload,
  type WocStasListTokensPayload,
  type WocUtxosPayload,
  type Woc1SatOutpointPayload
} from "./wocMessages.js";
import type {
  Woc1SatOrdinalsInscription,
  WocBsv21BalanceResponse,
  WocBsv21TokenMeta,
  WocStasTokenEntry
} from "@keymaster/contracts";

const DEFAULT_TIMEOUT_MS = 15_000;
const SHARED_TIMESTAMP_KEY = "woc.sharedTimestamps";
const SHARED_TIMESTAMP_MAX = 64;
const WEB_LOCK_NAME = "woc.service.send";

interface ActorEntry {
  priority: number;
  sequence: number;
  signal: AbortSignal;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  /** endpoint 解析后的 fetch 执行体。 */
  run: (signal: AbortSignal) => Promise<unknown>;
  /** 业务标签（用于 snapshot / 日志）。 */
  label: string;
  /**
   * 唯一终态守卫。abort listener 与 fetch Promise 完成都能调用
   * resolve/reject；settled 保证所有副作用只发生一次。
   */
  settled: boolean;
}

interface Locker {
  request<T>(name: string, cb: () => Promise<T>): Promise<T | undefined>;
}

/** 把 hex 字符串转成字节数组。 */
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error("Invalid hex length");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byte = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (!Number.isFinite(byte)) {
      throw new Error("Invalid hex string");
    }
    out[i] = byte;
  }
  return out;
}

/** 把字节数组转成 hex 字符串。 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 规范化 txid：去掉 0x 前缀并转小写。 */
function normalizeTxidHex(txid: string): string {
  return txid.startsWith("0x") ? txid.slice(2).toLowerCase() : txid.toLowerCase();
}

/** 反转 hex 字节序；输入非法时返回 undefined。 */
function reverseHexBytes(txid: string): string | undefined {
  const clean = normalizeTxidHex(txid);
  if (clean.length === 0) return "";
  if (clean.length % 2 !== 0 || !/^[0-9a-f]+$/.test(clean)) {
    return undefined;
  }
  const parts = clean.match(/../g);
  return parts ? parts.reverse().join("") : undefined;
}

/** 计算 rawTxHex 的 canonical txid（double-SHA256 后字节序反转）。 */
async function calcCanonicalTxidFromRawTxHex(rawTxHex: string): Promise<string> {
  const input = hexToBytes(rawTxHex);
  const firstInput = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer;
  const first = await crypto.subtle.digest("SHA-256", firstInput);
  const second = await crypto.subtle.digest("SHA-256", first);
  const digest = new Uint8Array(second);
  digest.reverse();
  return bytesToHex(digest);
}

/**
 * Provider txid 回执解释器（纯函数）。
 *
 * 职责：
 *   - 把 provider 返回的原始 txid 与本地 canonical txid 一起解释成
 *     "exact / reversed / mismatch / missing" 四种 integrity 结论；
 *   - 不做任何 fetch / 不做归一化之外的副作用；
 *   - 业务层（包括 plugin-p2pkh）只消费 canonicalTxid；
 *     providerReturnedTxid* 仅用于诊断。
 *
 * 设计缘由：
 *   把回执解释从 broadcast() 主流程中抽离出来，避免在主流程里继续堆
 *   条件分支引入新的优先级副作用（例如不小心在 fetch 之前 await）。
 */
function interpretProviderTxidReceipt(input: {
  providerTxid: string;
  canonicalTxid: string;
}): {
  providerReturnedTxidRaw: string;
  providerReturnedTxidNormalized: string;
  txidIntegrity: "exact" | "reversed" | "mismatch" | "missing";
} {
  const providerReturnedTxidRaw = input.providerTxid;
  const providerReturnedTxidNormalized = normalizeTxidHex(providerReturnedTxidRaw);
  const reversedProviderTxid = reverseHexBytes(providerReturnedTxidRaw);
  const txidIntegrity: "exact" | "reversed" | "mismatch" | "missing" =
    providerReturnedTxidNormalized === input.canonicalTxid
      ? "exact"
      : reversedProviderTxid === input.canonicalTxid
        ? "reversed"
        : providerReturnedTxidNormalized.length > 0
          ? "mismatch"
          : "missing";
  return {
    providerReturnedTxidRaw,
    providerReturnedTxidNormalized,
    txidIntegrity
  };
}

function getLocker(): Locker | undefined {
  if (typeof navigator === "undefined") return undefined;
  const nav = navigator as Navigator & { locks?: Locker };
  return nav.locks;
}

export interface WocActorHandle {
  /** 把 actor 的 handler 注册到指定 messageBus。幂等。 */
  attach(messageBus: MessageBus): void;
  /** 取消注册。 */
  detach(): void;
  getConfig(): WocConfig;
  updateConfig(input: Partial<WocConfig>): WocConfig;
  onConfigChange(handler: (c: WocConfig) => void): () => void;
  getQueueSnapshot(): WocQueueSnapshot;
  onQueueChange(handler: (s: WocQueueSnapshot) => void): () => void;
  dispose(): void;
}

export interface CreateWocActorOptions {
  /**
   * 硬切换 002：业务插件注入的 logger。WOC 的关键轨迹（config changed /
   * request queued / completed / failed / backoff）都进统一日志。
   * 不传时不记日志（保持旧行为）。
   */
  logger?: PluginLogger;
}

export function createWocActor(options: CreateWocActorOptions = {}): WocActorHandle {
  let config: WocConfig = loadWocConfig();
  const configListeners = new Set<(c: WocConfig) => void>();
  const queueListeners = new Set<(s: WocQueueSnapshot) => void>();
  let messageBus: MessageBus | null = null;
  const unsubscribers: Array<() => void> = [];
  const logger = options.logger;

  // 内部 priority queue / pump / 限流 / 429 状态。
  const queue: ActorEntry[] = [];
  let inFlight = 0;
  let sequence = 0;
  let disposed = false;
  let backoffUntil = 0;
  let lastError: string | undefined;
  let pumpScheduled = false;
  let pumping = false;
  const localTimestamps: number[] = [];

  function isCoordinated(): boolean {
    return getLocker() != null;
  }

  function emitConfig() {
    for (const l of configListeners) l(config);
  }

  function snapshot(): WocQueueSnapshot {
    return {
      queued: queue.length,
      inFlight,
      backoffUntil: backoffUntil > Date.now() ? backoffUntil : undefined,
      lastError,
      coordinated: isCoordinated()
    };
  }

  function emitSnapshot() {
    const s = snapshot();
    for (const l of queueListeners) l(s);
  }

  function readSharedTimestamps(): number[] {
    try {
      const raw = localStorage.getItem(SHARED_TIMESTAMP_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw) as number[];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }
  function writeSharedTimestamps(arr: number[]) {
    try {
      localStorage.setItem(SHARED_TIMESTAMP_KEY, JSON.stringify(arr));
    } catch {
      // 静默失败。
    }
  }
  function prune(timestamps: number[], now: number): number[] {
    const cutoff = now - 1000;
    return timestamps.filter((t) => t > cutoff);
  }
  function nextSendAt(): number {
    const now = Date.now();
    const shared = prune(readSharedTimestamps(), now);
    const local = prune(localTimestamps, now);
    const merged = prune(
      Array.from(new Set([...shared, ...local])).sort((a, b) => a - b),
      now
    );
    const rate = Math.max(config.requestsPerSecond, 0.0001);
    if (merged.length === 0) return now;
    const maxInWindow = Math.max(1, Math.floor(rate));
    if (merged.length >= maxInWindow) {
      const earliest = merged[0]!;
      return earliest + 1000;
    }
    if (rate > 1) {
      const last = merged[merged.length - 1]!;
      const minSpacing = 1000 / rate;
      return Math.max(now, last + minSpacing);
    }
    return now;
  }
  function recordSendTime(t: number) {
    localTimestamps.push(t);
    const shared = prune(readSharedTimestamps(), t);
    shared.push(t);
    const trimmed = shared.length > SHARED_TIMESTAMP_MAX ? shared.slice(-SHARED_TIMESTAMP_MAX) : shared;
    writeSharedTimestamps(trimmed);
  }
  function schedulePump() {
    if (pumpScheduled) return;
    pumpScheduled = true;
    queueMicrotask(() => {
      pumpScheduled = false;
      void pump();
    });
  }
  function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function pump() {
    if (pumping || disposed) return;
    pumping = true;
    try {
      while (!disposed) {
        while (queue.length > 0 && queue[0]!.signal.aborted) {
          const [head] = queue.splice(0, 1);
          head!.reject(head!.signal.reason ?? new Error("aborted"));
          emitSnapshot();
        }
        if (queue.length === 0) break;
        const now = Date.now();
        if (backoffUntil > now) {
          await sleep(Math.min(backoffUntil - now, 1000));
          continue;
        }
        const entry = pickHighestPriority();
        if (!entry) break;
        if (entry.signal.aborted) {
          entry.reject(entry.signal.reason ?? new Error("aborted"));
          emitSnapshot();
          continue;
        }
        await acquireSlot();
        // 关键修复（硬切换 001）：等待 slot 期间可能其它请求收到 429
        // 触发了全局 backoff；acquireSlot 返回后必须重新检查 backoffUntil。
        if (backoffUntil > Date.now()) {
          // 修复（硬切换 008 收尾）：重 push 回队尾，保留 sequence；
          // pickHighestPriority 仍按 priority + sequence 决定顺序，不会破坏
          // 优先级与 FIFO。
          queue.push(entry);
          emitSnapshot();
          await sleep(Math.min(backoffUntil - Date.now(), 1000));
          continue;
        }
        if (entry.signal.aborted || disposed) {
          entry.reject(entry.signal.reason ?? new Error("aborted"));
          continue;
        }
        inFlight += 1;
        emitSnapshot();
        entry
          .run(entry.signal)
          .then(
            (v) => entry.resolve(v),
            (err) => entry.reject(err)
          )
          .finally(() => {
            inFlight -= 1;
            emitSnapshot();
          });
      }
    } finally {
      pumping = false;
    }
  }

  async function acquireSlot(): Promise<number> {
    const locker = getLocker();
    if (locker) {
      const result = await locker.request(WEB_LOCK_NAME, async () => {
        const slot = nextSendAt();
        const wait = slot - Date.now();
        if (wait > 0) await sleep(wait);
        const sendTime = Date.now();
        recordSendTime(sendTime);
        return sendTime;
      });
      return result ?? Date.now();
    }
    const slot = nextSendAt();
    const wait = slot - Date.now();
    if (wait > 0) await sleep(wait);
    const sendTime = Date.now();
    recordSendTime(sendTime);
    return sendTime;
  }

  function pickHighestPriority(): ActorEntry | undefined {
    let best: ActorEntry | undefined;
    for (const e of queue) {
      if (e.signal.aborted) continue;
      if (!best || e.priority > best.priority || (e.priority === best.priority && e.sequence < best.sequence)) {
        best = e;
      }
    }
    if (best) {
      const idx = queue.indexOf(best);
      if (idx >= 0) queue.splice(idx, 1);
    }
    return best;
  }

  function priorityOf(p: WocRequestPriority): number {
    return WOC_PRIORITY[p];
  }

  function networkPath(network: BsvNetwork): string {
    return network === "main" ? "/main" : "/test";
  }
  function fullUrl(network: BsvNetwork, path: string): string {
    return `${config.baseUrl}${networkPath(network)}${path}`;
  }

  async function fetchJson<T>(network: BsvNetwork, path: string, init: RequestInit, signal: AbortSignal, timeoutMs?: number): Promise<T> {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort(signal.reason);
    if (signal.aborted) ctl.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctl.abort(new Error("timeout")), timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetch(fullUrl(network, path), { ...init, signal: ctl.signal });
      if (res.status === 429) {
        const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
        applyBackoff(retryAfter, "429 Too Many Requests");
        throw new Error(`WOC 429`);
      }
      if (!res.ok) {
        throw new Error(`WOC ${res.status} ${res.statusText}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  function parseRetryAfter(value: string | null): number | undefined {
    if (!value) return undefined;
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return n * 1000;
    const t = Date.parse(value);
    if (Number.isFinite(t)) return Math.max(0, t - Date.now());
    return undefined;
  }

  let backoffStep = 0;
  function applyBackoff(retryAfterMs: number | undefined, reason: string) {
    lastError = reason;
    let duration: number;
    if (typeof retryAfterMs === "number") {
      duration = retryAfterMs;
    } else {
      const base = 1000;
      const cap = 60_000;
      duration = Math.min(cap, base * Math.pow(2, backoffStep)) + Math.floor(Math.random() * 250);
      backoffStep += 1;
    }
    // 关键不变量：多个 WOC 请求可以并发飞行；先返回的 429 可能要求
    // 等待 30 秒，后返回的 429 可能只要求等待 1 秒。全局 backoff 必须
    // 取最长要求，不能被短窗口覆盖。
    const candidateUntil = Date.now() + duration;
    backoffUntil = Math.max(backoffUntil, candidateUntil);
    logger?.warn({
      scope: "woc.backoff",
      event: "backoff.entered",
      message: "WOC backoff entered",
      data: { retryAfterMs: duration, reason, until: candidateUntil }
    });
    emitSnapshot();
  }
  function resetBackoff() {
    // 关键不变量：backoffUntil 由 Retry-After 显式设定（服务端指令），
    // 不能被成功响应提前覆盖；snapshot() 在到期后自然显示为 undefined。
    // 只重置 backoffStep，让下一次 429 从 base * 2^0 开始。
    const wasInBackoff = backoffUntil > Date.now();
    backoffStep = 0;
    if (wasInBackoff) {
      logger?.info({
        scope: "woc.backoff",
        event: "backoff.cleared",
        message: "WOC backoff cleared"
      });
    }
  }

  function isWocNotFoundError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    return /^WOC 404\b/.test(err.message);
  }

  /**
   * 内部入队：把 endpoint 调用挂到 actor 的 priority queue。
   * 关键设计：opts.signal 来自 messageBus 内部 ctl（覆盖 caller signal
   * + timeout），handler 内直接把它接到 fetch 链路。actor 自身不再造
   * AbortController，避免与 messageBus 双层 timeout 互相覆盖。
   */
  function enqueue<T>(opts: {
    priority: number;
    signal: AbortSignal;
    label: string;
    fn: (signal: AbortSignal) => Promise<T>;
  }): Promise<T> {
    if (disposed) return Promise.reject(new Error("WOC service is disposed"));
    if (opts.signal.aborted) {
      return Promise.reject(opts.signal.reason ?? new Error("aborted"));
    }
    return new Promise<T>((resolve, reject) => {
      const startedAt = Date.now();
      logger?.debug({
        scope: "woc.request",
        event: "request.queued",
        message: `WOC request queued: ${opts.label}`,
        data: { endpoint: opts.label, priority: opts.priority }
      });
      const entry: ActorEntry = {
        priority: opts.priority,
        sequence: sequence++,
        signal: opts.signal,
        label: opts.label,
        run: () => opts.fn(opts.signal),
        settled: false,
        resolve: (v) => {
          logger?.debug({
            scope: "woc.request",
            event: "request.completed",
            message: `WOC request completed: ${opts.label}`,
            data: { endpoint: opts.label, latencyMs: Date.now() - startedAt }
          });
          resolve(v as T);
        },
        reject
      };
      // 唯一终态：abort listener 与 pump 的 fetch 完成都走这里；
      // settled 守卫保证 resolve/reject 副作用只发生一次。
      function settleEntry(state: "resolved" | "rejected" | "aborted", value: unknown) {
        if (entry.settled) return;
        entry.settled = true;
        opts.signal.removeEventListener("abort", onAbort);
        if (state === "resolved") {
          resolve(value as T);
        } else {
          reject(value);
        }
      }
      const onAbort = () => {
        const idx = queue.indexOf(entry);
        if (idx >= 0) {
          queue.splice(idx, 1);
          emitSnapshot();
        }
        settleEntry("aborted", opts.signal.reason ?? new Error("aborted"));
      };
      // opts.signal 已被 messageBus 维护；actor 端只监听取消，不再造 ctl。
      if (opts.signal.aborted) {
        settleEntry("aborted", opts.signal.reason ?? new Error("aborted"));
        return;
      }
      opts.signal.addEventListener("abort", onAbort, { once: true });
      // 暴露给 pump 的 entry.resolve / entry.reject 都走 settled 守卫。
      entry.resolve = (v) => settleEntry("resolved", v);
      entry.reject = (e) => {
        // 关键：abort 优先。signal 已 abort 时不让 fetch reject 污染 lastError，
        // 也不应让 Promise reject 走 rejected 路径。
        if (entry.signal.aborted) {
          settleEntry("aborted", entry.signal.reason);
        } else {
          lastError = e instanceof Error ? e.message : String(e);
          logger?.warn({
            scope: "woc.request",
            event: "request.failed",
            message: `WOC request failed: ${opts.label}`,
            data: { endpoint: opts.label, latencyMs: Date.now() - startedAt },
            error: {
              name: e instanceof Error ? e.name : "Error",
              message: lastError ?? ""
            }
          });
          settleEntry("rejected", e);
        }
      };
      queue.push(entry);
      emitSnapshot();
      schedulePump();
    });
  }

  // ---- endpoint 实现 ----
  function getAddressConfirmedBalance(network: BsvNetwork, address: string, opts: { signal: AbortSignal; priority?: WocRequestPriority; timeoutMs?: number }): Promise<WocBalanceResponse> {
    return enqueue({
      priority: priorityOf(opts.priority ?? "background"),
      signal: opts.signal,
      label: WOC_MSG.BALANCE_CONFIRMED,
      fn: (signal) =>
        fetchJson<WocBalanceResponse>(
          network,
          `/address/${encodeURIComponent(address)}/confirmed/balance`,
          { method: "GET" },
          signal,
          opts.timeoutMs
        )
    });
  }
  function getAddressUnconfirmedBalance(network: BsvNetwork, address: string, opts: { signal: AbortSignal; priority?: WocRequestPriority; timeoutMs?: number }): Promise<WocBalanceResponse> {
    return enqueue({
      priority: priorityOf(opts.priority ?? "background"),
      signal: opts.signal,
      label: WOC_MSG.BALANCE_UNCONFIRMED,
      fn: (signal) =>
        fetchJson<WocBalanceResponse>(
          network,
          `/address/${encodeURIComponent(address)}/unconfirmed/balance`,
          { method: "GET" },
          signal,
          opts.timeoutMs
        )
    });
  }
  function getAddressConfirmedUtxos(network: BsvNetwork, address: string, opts: { signal: AbortSignal; priority?: WocRequestPriority; timeoutMs?: number }): Promise<WocUtxoResponse[]> {
    return enqueue({
      priority: priorityOf(opts.priority ?? "background"),
      signal: opts.signal,
      label: WOC_MSG.UTXOS_CONFIRMED,
      fn: async (signal) => {
        let raw: { result: Array<{ tx_hash: string; tx_pos: number; value: number; height: number; script?: string }> };
        try {
          raw = await fetchJson<{
            result: Array<{ tx_hash: string; tx_pos: number; value: number; height: number; script?: string }>;
          }>(
            network,
            `/address/${encodeURIComponent(address)}/confirmed/unspent`,
            { method: "GET" },
            signal,
            opts.timeoutMs
          );
        } catch (err) {
          if (isWocNotFoundError(err)) return [];
          throw err;
        }
        return raw.result.map((u) => ({
          txid: u.tx_hash,
          vout: u.tx_pos,
          value: u.value,
          height: u.height,
          script: u.script,
          isSpentInMempoolTx: false
        }));
      }
    });
  }
  function getAddressUnconfirmedUtxos(network: BsvNetwork, address: string, opts: { signal: AbortSignal; priority?: WocRequestPriority; timeoutMs?: number }): Promise<WocUtxoResponse[]> {
    return enqueue({
      priority: priorityOf(opts.priority ?? "background"),
      signal: opts.signal,
      label: WOC_MSG.UTXOS_UNCONFIRMED,
      fn: async (signal) => {
        let raw: { result: Array<{ tx_hash: string; tx_pos: number; value: number; height: number; script?: string; isSpentInMempoolTx?: boolean }> };
        try {
          raw = await fetchJson<{
            result: Array<{ tx_hash: string; tx_pos: number; value: number; height: number; script?: string; isSpentInMempoolTx?: boolean }>;
          }>(
            network,
            `/address/${encodeURIComponent(address)}/unconfirmed/unspent`,
            { method: "GET" },
            signal,
            opts.timeoutMs
          );
        } catch (err) {
          if (isWocNotFoundError(err)) return [];
          throw err;
        }
        return raw.result.map((u) => ({
          txid: u.tx_hash,
          vout: u.tx_pos,
          value: u.value,
          height: 0,
          script: u.script,
          isSpentInMempoolTx: u.isSpentInMempoolTx ?? false
        }));
      }
    });
  }
  function listAddressConfirmedHistory(network: BsvNetwork, address: string, page: { limit?: number; page?: number; nextPageToken?: string } | undefined, opts: { signal: AbortSignal; priority?: WocRequestPriority; timeoutMs?: number }): Promise<WocHistoryPage> {
    const qs = new URLSearchParams();
    if (page?.limit) qs.set("limit", String(page.limit));
    if (page?.nextPageToken) qs.set("token", page.nextPageToken);
    const q = qs.toString();
    const path = `/address/${encodeURIComponent(address)}/confirmed/history${q ? "?" + q : ""}`;
    return enqueue({
      priority: priorityOf(opts.priority ?? "background"),
      signal: opts.signal,
      label: WOC_MSG.HISTORY_CONFIRMED,
      fn: async (signal) => {
        let raw: { result: Array<{ tx_hash: string; height: number; fee?: number }>; nextPageToken?: string };
        try {
          raw = await fetchJson<{
            result: Array<{ tx_hash: string; height: number; fee?: number }>;
            nextPageToken?: string;
          }>(network, path, { method: "GET" }, signal, opts.timeoutMs);
        } catch (err) {
          if (isWocNotFoundError(err)) return { items: [], nextPageToken: undefined };
          throw err;
        }
        return {
          items: raw.result.map((r) => ({ txid: r.tx_hash, height: r.height, fee: r.fee })),
          nextPageToken: raw.nextPageToken
        };
      }
    });
  }
  function listAddressUnconfirmedHistory(network: BsvNetwork, address: string, opts: { signal: AbortSignal; priority?: WocRequestPriority; timeoutMs?: number }): Promise<WocUnconfirmedHistory> {
    const path = `/address/${encodeURIComponent(address)}/unconfirmed/history`;
    return enqueue({
      priority: priorityOf(opts.priority ?? "background"),
      signal: opts.signal,
      label: WOC_MSG.HISTORY_UNCONFIRMED,
      fn: async (signal) => {
        let raw: { result: Array<{ tx_hash: string; fee?: number }> };
        try {
          raw = await fetchJson<{
            result: Array<{ tx_hash: string; fee?: number }>;
          }>(network, path, { method: "GET" }, signal, opts.timeoutMs);
        } catch (err) {
          if (isWocNotFoundError(err)) return { items: [] };
          throw err;
        }
        return { items: raw.result.map((r) => ({ txid: r.tx_hash, fee: r.fee })) };
      }
    });
  }
  function broadcast(network: BsvNetwork, rawTxHex: string, opts: { signal: AbortSignal; timeoutMs?: number }): Promise<WocBroadcastResult> {
    return enqueue({
      priority: WOC_PRIORITY.broadcast,
      signal: opts.signal,
      label: WOC_MSG.TX_BROADCAST,
      fn: async (signal) => {
        // 关键修复（硬切换 003 收尾）：必须先发 /tx/raw，再做本地 canonical
        // 计算。旧实现先 await calcCanonicalTxidFromRawTxHex 会让 broadcast
        // 任务在 fetchJson 之前先让出执行权；pump 继续 while 循环时趁机拉起
        // background 任务的 fetch，破坏 broadcast 优先级（order[1] 变成
        // background 而不是 /tx/raw）。
        const res = await fetchJson<{ txid: string }>(network, "/tx/raw", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ txhex: rawTxHex })
        }, signal, opts.timeoutMs);
        resetBackoff();
        const canonicalTxid = await calcCanonicalTxidFromRawTxHex(rawTxHex);
        const interpreted = interpretProviderTxidReceipt({
          providerTxid: res.txid,
          canonicalTxid
        });
        return {
          accepted: true,
          canonicalTxid,
          providerReturnedTxidRaw: interpreted.providerReturnedTxidRaw,
          providerReturnedTxidNormalized: interpreted.providerReturnedTxidNormalized,
          txidIntegrity: interpreted.txidIntegrity
        };
      }
    });
  }

  // ---- token / collectible 协议 endpoint（共享 actor 限流与优先级队列） ----
  // 设计缘由：BSV-21 / STAS / 1Sat 的 WOC 查询与现有 coin 类 endpoint 走
  // 同一 actor priority queue，不复制第二套限流。404 / not-found 翻译
  // 为业务语义（1Sat 返回 null；BSV-21 list 返回空数组）。
  //
  // 路径（对齐 WOC 官方公开 endpoint 形态）：
  //   - BSV-21 列表：GET /token/bsv21/<address>/balance
  //   - BSV-21 单 token 余额：GET /token/bsv21/<address>/balance/<origin>
  //   - STAS 列表：GET /token/stas/<address>/balance
  //   - 1Sat outpoint：GET /token/1satordinals/<txid>_<vout>
  //     outpoint 字符串格式："txid_vout"（下划线）；不是 "txid:vout"。
  //     业务插件（plugin-collectible-1satordinals）拿 P2PKH UTXO 的
  //     { txid, vout } 自行用 toWocOutpoint() 拼成正确字符串再调进来。

  function bsv21ListTokens(network: BsvNetwork, address: string, opts: { signal: AbortSignal; priority?: WocRequestPriority; timeoutMs?: number }): Promise<WocBsv21TokenMeta[]> {
    return enqueue({
      priority: priorityOf(opts.priority ?? "background"),
      signal: opts.signal,
      label: WOC_MSG.BSV21_LIST_TOKENS,
      fn: async (signal) => {
        let raw: { result?: Array<{ origin: string; symbol?: string; decimals?: number; issuer?: string }> };
        try {
          raw = await fetchJson<{
            result?: Array<{ origin: string; symbol?: string; decimals?: number; issuer?: string }>;
          }>(
            network,
            `/token/bsv21/${encodeURIComponent(address)}/balance`,
            { method: "GET" },
            signal,
            opts.timeoutMs
          );
        } catch (err) {
          if (isWocNotFoundError(err)) return [];
          throw err;
        }
        const list = raw.result ?? [];
        return list.map((t) => ({
          origin: t.origin,
          symbol: t.symbol,
          decimals: t.decimals,
          issuer: t.issuer
        }));
      }
    });
  }

  function bsv21TokenBalance(network: BsvNetwork, address: string, origin: string, opts: { signal: AbortSignal; priority?: WocRequestPriority; timeoutMs?: number }): Promise<WocBsv21BalanceResponse> {
    return enqueue({
      priority: priorityOf(opts.priority ?? "background"),
      signal: opts.signal,
      label: WOC_MSG.BSV21_TOKEN_BALANCE,
      fn: (signal) =>
        fetchJson<WocBsv21BalanceResponse>(
          network,
          `/token/bsv21/${encodeURIComponent(address)}/balance/${encodeURIComponent(origin)}`,
          { method: "GET" },
          signal,
          opts.timeoutMs
        )
    });
  }

  function stasListTokens(network: BsvNetwork, address: string, opts: { signal: AbortSignal; priority?: WocRequestPriority; timeoutMs?: number }): Promise<WocStasTokenEntry[]> {
    return enqueue({
      priority: priorityOf(opts.priority ?? "background"),
      signal: opts.signal,
      label: WOC_MSG.STAS_LIST_TOKENS,
      fn: async (signal) => {
        let raw: { result?: Array<{ symbol: string; issuer?: string; balance: number }> };
        try {
          raw = await fetchJson<{
            result?: Array<{ symbol: string; issuer?: string; balance: number }>;
          }>(
            network,
            `/token/stas/${encodeURIComponent(address)}/balance`,
            { method: "GET" },
            signal,
            opts.timeoutMs
          );
        } catch (err) {
          if (isWocNotFoundError(err)) return [];
          throw err;
        }
        return (raw.result ?? []).map((t) => ({
          symbol: t.symbol,
          issuer: t.issuer,
          balance: Number.isFinite(t.balance) ? t.balance : 0
        }));
      }
    });
  }

  function oneSatOutpoint(network: BsvNetwork, outpoint: string, opts: { signal: AbortSignal; priority?: WocRequestPriority; timeoutMs?: number }): Promise<Woc1SatOrdinalsInscription | null> {
    return enqueue({
      priority: priorityOf(opts.priority ?? "background"),
      signal: opts.signal,
      label: WOC_MSG.ONE_SAT_OUTPOINT,
      fn: async (signal) => {
        if (!outpoint.includes("_")) {
          // 业务侧把 outpoint 拼错了（必须 "txid_vout"）：直接视为
          // "不是 1Sat collectible"，返回 null 而非抛错。
          return null;
        }
        try {
          const raw = await fetchJson<{
            inscriptionId: string;
            outpoint?: string;
            origin?: string;
            contentType?: string;
            preview?: string;
            owner?: string;
          }>(
            network,
            `/token/1satordinals/${encodeURIComponent(outpoint)}`,
            { method: "GET" },
            signal,
            opts.timeoutMs
          );
          return {
            inscriptionId: raw.inscriptionId,
            outpoint: raw.outpoint ?? outpoint,
            origin: raw.origin,
            contentType: raw.contentType,
            preview: raw.preview,
            owner: raw.owner
          };
        } catch (err) {
          // 404 / not-found：业务侧约定的"这不是 1Sat collectible"语义，
          // 翻译成 null；其它错误向上抛。
          if (isWocNotFoundError(err)) return null;
          throw err;
        }
      }
    });
  }

  /**
   * 业务插件层：把 wocService 投递给 messageBus 的消息翻译为 actor 内部
   * endpoint 调用。这里保持 WocService 公开 API 行为完全等价。
   */
  async function dispatch(type: string, message: Message): Promise<unknown> {
    if (disposed) throw new Error("WOC actor is disposed");
    const signal = message.signal;
    if (!signal) {
      throw new Error(`MessageBus delivered a woc.* message without signal: type=${type}`);
    }
    const payload = message.payload as WocCommonPayload;
    const opts = {
      signal,
      priority: payload.priority ?? "background",
      timeoutMs: payload.timeoutMs
    };
    switch (type) {
      case WOC_MSG.BALANCE_CONFIRMED: {
        const p = payload as WocBalancePayload;
        return getAddressConfirmedBalance(p.network, p.address, opts);
      }
      case WOC_MSG.BALANCE_UNCONFIRMED: {
        const p = payload as WocBalancePayload;
        return getAddressUnconfirmedBalance(p.network, p.address, opts);
      }
      case WOC_MSG.UTXOS_CONFIRMED: {
        const p = payload as WocUtxosPayload;
        return getAddressConfirmedUtxos(p.network, p.address, opts);
      }
      case WOC_MSG.UTXOS_UNCONFIRMED: {
        const p = payload as WocUtxosPayload;
        return getAddressUnconfirmedUtxos(p.network, p.address, opts);
      }
      case WOC_MSG.HISTORY_CONFIRMED: {
        const p = payload as WocHistoryPayload;
        return listAddressConfirmedHistory(p.network, p.address, p.page, opts);
      }
      case WOC_MSG.HISTORY_UNCONFIRMED: {
        const p = payload as WocHistoryPayload;
        return listAddressUnconfirmedHistory(p.network, p.address, opts);
      }
      case WOC_MSG.TX_BROADCAST: {
        const p = payload as WocBroadcastPayload;
        return broadcast(p.network, p.rawTxHex, { signal, timeoutMs: opts.timeoutMs });
      }
      case WOC_MSG.BSV21_LIST_TOKENS: {
        const p = payload as WocBsv21ListTokensPayload;
        return bsv21ListTokens(p.network, p.address, opts);
      }
      case WOC_MSG.BSV21_TOKEN_BALANCE: {
        const p = payload as WocBsv21TokenBalancePayload;
        return bsv21TokenBalance(p.network, p.address, p.origin, opts);
      }
      case WOC_MSG.STAS_LIST_TOKENS: {
        const p = payload as WocStasListTokensPayload;
        return stasListTokens(p.network, p.address, opts);
      }
      case WOC_MSG.ONE_SAT_OUTPOINT: {
        const p = payload as Woc1SatOutpointPayload;
        return oneSatOutpoint(p.network, p.outpoint, opts);
      }
      default:
        throw new Error(`Unknown WOC message type: ${type}`);
    }
  }

  function attach(bus: MessageBus): void {
    if (messageBus) {
      // 幂等：若已 attach 同一 bus 直接返回；不同 bus 先 detach。
      if (messageBus === bus) return;
      detach();
    }
    messageBus = bus;
    for (const type of [
      WOC_MSG.BALANCE_CONFIRMED,
      WOC_MSG.BALANCE_UNCONFIRMED,
      WOC_MSG.UTXOS_CONFIRMED,
      WOC_MSG.UTXOS_UNCONFIRMED,
      WOC_MSG.HISTORY_CONFIRMED,
      WOC_MSG.HISTORY_UNCONFIRMED,
      WOC_MSG.TX_BROADCAST,
      WOC_MSG.BSV21_LIST_TOKENS,
      WOC_MSG.BSV21_TOKEN_BALANCE,
      WOC_MSG.STAS_LIST_TOKENS,
      WOC_MSG.ONE_SAT_OUTPOINT
    ]) {
      const off = bus.handle(type, (message) => dispatch(type, message), {
        target: WOC_ACTOR_TARGET,
        concurrency: WOC_ACTOR_ACCEPT_CONCURRENCY
      });
      unsubscribers.push(off);
    }
  }

  function detach(): void {
    for (const off of unsubscribers.splice(0, unsubscribers.length)) {
      try { off(); } catch { /* 静默 */ }
    }
    messageBus = null;
  }

  return {
    attach,
    detach,
    getConfig: () => ({ ...config }),
    updateConfig(input) {
      const next: WocConfig = { ...config, ...input };
      if (input.baseUrl !== undefined) next.baseUrl = input.baseUrl.replace(/\/+$/, "");
      if (input.requestsPerSecond !== undefined) {
        if (!(input.requestsPerSecond > 0)) {
          throw new Error("requestsPerSecond must be a positive number");
        }
        next.requestsPerSecond = input.requestsPerSecond;
      }
      const changed: Record<string, unknown> = {};
      if (input.baseUrl !== undefined) changed.baseUrl = next.baseUrl;
      if (input.requestsPerSecond !== undefined) changed.requestsPerSecond = next.requestsPerSecond;
      config = next;
      saveWocConfig(config);
      logger?.info({
        scope: "woc.config",
        event: "config.changed",
        message: "WOC config changed",
        data: changed
      });
      emitConfig();
      schedulePump();
      return { ...config };
    },
    onConfigChange(handler) {
      configListeners.add(handler);
      return () => configListeners.delete(handler);
    },
    getQueueSnapshot: snapshot,
    onQueueChange(handler) {
      queueListeners.add(handler);
      return () => queueListeners.delete(handler);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      detach();
      for (const e of queue.splice(0, queue.length)) {
        e.reject(new Error("WOC actor is disposed"));
      }
      emitSnapshot();
    }
  };
}

// 内部 payload 公共形状（仅 actor 内部 switch 用，避免每个 case 重复 cast）。
interface WocCommonPayload {
  priority?: WocRequestPriority;
  timeoutMs?: number;
}
