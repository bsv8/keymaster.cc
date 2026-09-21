import type {
  AssetDataChangedEvent,
  CentralBroadcastFailureReason,
  CentralBroadcastService,
  CoordinatorP2pkhBroadcastResult,
  OneShotBroadcastInput,
  P2pkhBroadcastAssemblyControl,
  P2pkhUtxoSnapshotResult,
} from "@keymaster/contracts";

/** 中心广播服务依赖；页面只注入装配层的窄出口和快照读/刷新函数。 */
export interface CentralBroadcastServiceDeps {
  /** 私有 Worker 广播出口；不会作为 capability 交给普通插件。 */
  coordinator: P2pkhBroadcastAssemblyControl;
  /** 订阅 asset.data-changed，用快照序号唤醒重试。 */
  subscribeTopic?: (listener: (event: AssetDataChangedEvent) => void) => () => void;
  /** 读取当前快照，作为事件丢失时的兜底。 */
  getSnapshot?: (network: "main" | "test") => Promise<P2pkhUtxoSnapshotResult>;
  /** 主动刷新当前网络快照，作为事件丢失时的兜底。 */
  refreshSnapshot?: (network: "main" | "test") => Promise<P2pkhUtxoSnapshotResult>;
  /** 测试可缩短预算；生产默认 5 次 / 2 分钟。 */
  maxAttempts?: number;
  deadlineMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** 快照暂时不可用于重建交易：这是可重试的内部控制流，不是用户终态。 */
export type CentralBroadcastRetryCode = "snapshot-wait" | "snapshot-refresh";

export class CentralBroadcastRetryableError extends Error {
  readonly code: CentralBroadcastRetryCode;
  readonly currentSeq?: number;

  constructor(code: CentralBroadcastRetryCode, currentSeq?: number) {
    super(code === "snapshot-wait" ? "P2PKH UTXO snapshot is waiting for a fresh sequence" : "P2PKH UTXO snapshot refresh failed");
    this.name = "CentralBroadcastRetryableError";
    this.code = code;
    this.currentSeq = currentSeq;
  }
}

export function isCentralBroadcastRetryableError(error: unknown): error is CentralBroadcastRetryableError {
  return error instanceof CentralBroadcastRetryableError;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("broadcast retry cancelled"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("broadcast retry cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isNotDispatched(value: unknown): value is Extract<CoordinatorP2pkhBroadcastResult, { status: "not-dispatched" }> {
  return !!value && typeof value === "object" && (value as { status?: unknown }).status === "not-dispatched";
}

function isIsolated(value: unknown): value is Extract<CoordinatorP2pkhBroadcastResult, { status: "isolated" }> {
  return !!value && typeof value === "object" && (value as { status?: unknown }).status === "isolated";
}

function reasonForError(error: unknown): CentralBroadcastFailureReason {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes("insufficient") || lower.includes("余额不足")) return "insufficient";
  if (lower.includes("no-utxo") || lower.includes("no utxo") || lower.includes("没有可用")) return "no-utxos";
  if (lower.includes("cancel")) return "cancelled";
  if (lower.includes("sendall") || lower.includes("send all")) return "requires-reconfirm";
  if (lower.includes("binding") || lower.includes("snapshot")) return "snapshot-binding";
  return "policy-denied";
}

/** 将机器可判的终态转换成 UI 可直接显示的中文提示。 */
function failureMessage(reason: CentralBroadcastFailureReason): string {
  switch (reason) {
    case "insufficient": return "余额不足（金额加矿工费）";
    case "no-utxos": return "没有可用的 UTXO";
    case "policy-denied": return "交易参数或钱包策略校验失败";
    case "snapshot-timeout": return "等待新快照超时，上一笔交易状态未确认，请稍后检查交易记录";
    case "snapshot-binding": return "UTXO 快照序号绑定无效，请重新准备交易";
    case "rebuild-unavailable": return "无法自动重建交易，请重新操作";
    case "requires-reconfirm": return "余额已变化，请重新确认全部发送金额";
    case "isolated": return "广播结果未知，请在交易记录中确认状态";
    case "cancelled": return "操作已取消，钱包可能已锁定或切换了 owner";
  }
}

function toFailureReason(result: Extract<CoordinatorP2pkhBroadcastResult, { status: "not-dispatched" }>): CentralBroadcastFailureReason | undefined {
  switch (result.reason) {
    case "snapshot-binding-required":
    case "snapshot-input-invalid": return "snapshot-binding";
    case "stale-session-epoch":
    case "stale-provider-generation": return "cancelled";
    default: return undefined;
  }
}

/** 创建页面侧唯一广播入口。 */
export function createCentralBroadcastService(deps: CentralBroadcastServiceDeps): CentralBroadcastService {
  const maxAttempts = deps.maxAttempts ?? 5;
  const deadlineMs = deps.deadlineMs ?? 120_000;
  const initialBackoffMs = deps.initialBackoffMs ?? 1_000;
  const maxBackoffMs = deps.maxBackoffMs ?? 5_000;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? defaultSleep;

  async function submitOnce(input: OneShotBroadcastInput): Promise<CoordinatorP2pkhBroadcastResult> {
    const result = await deps.coordinator.p2pkhBroadcast({
      ownerPublicKeyHex: input.ownerPublicKeyHex,
      network: input.network,
      submissionId: input.submissionId,
      submission: {
        resourceId: input.resourceId,
        txid: input.txid,
        rawTxHex: input.rawTxHex,
        ...(input.utxoBinding === undefined ? {} : { utxoBinding: input.utxoBinding }),
      },
    });
    if (result.status === "ok") return result.value as CoordinatorP2pkhBroadcastResult;
    if (result.status === "transport-error" && result.dispatchStatus !== "not-dispatched") {
      return { status: "isolated", txid: input.txid, reason: result.message || "broadcast transport result unknown" };
    }
    return { status: "not-dispatched", reason: "coordinator-not-dispatched" };
  }

  async function waitForNewSeq(network: "main" | "test", boundSeq: number, delayMs: number, signal?: AbortSignal, requireFresh = false): Promise<number | undefined> {
    if (signal?.aborted) throw new Error("broadcast retry cancelled");
    let off: (() => void) | undefined;
    let resolveEvent!: (seq: number | undefined) => void;
    const eventPromise = new Promise<number | undefined>((resolve) => { resolveEvent = resolve; });
    if (deps.subscribeTopic) {
      off = deps.subscribeTopic((event) => {
        const seq = event.utxoSeqs?.[network];
        // v1 事件不携带 snapshot state。即使序号相等，也先唤醒一次，
        // 再由快照 RPC 判断是否已经从 consumed 解封为 fresh。
        if (typeof seq === "number" && seq >= boundSeq) resolveEvent(seq);
      });
    }
    try {
      const waitPromise = sleep(delayMs, signal).then(() => undefined);
      const result = await Promise.race([eventPromise, waitPromise]);
      if (typeof result === "number" && result > boundSeq && !requireFresh) return result;
      let snapshot: P2pkhUtxoSnapshotResult | undefined;
      try {
        snapshot = await deps.refreshSnapshot?.(network) ?? await deps.getSnapshot?.(network);
      } catch {
        // RPC/刷新失败不是“新快照已到”；保留当前门禁并继续按预算等待。
        // 尤其不能把一次读取异常当成 fresh，避免重建撞上旧序号。
        snapshot = undefined;
      }
      if (snapshot?.state === "fresh"
        && snapshot.available
        && snapshot.seq !== undefined
        && snapshot.seq >= boundSeq) return snapshot.seq;
      // 没有快照 RPC 时只能相信严格递增的事件；有 RPC 时必须确认
      // consumed 已经恢复 fresh，不能仅凭“序号变大”提前重建。
      return requireFresh && !deps.refreshSnapshot && !deps.getSnapshot && typeof result === "number" && result > boundSeq
        ? result
        : undefined;
    } finally {
      off?.();
    }
  }

  async function submitWithRetry(input: Parameters<CentralBroadcastService["submitWithRetry"]>[0]) {
    let attempts = 0;
    let boundSeq = input.boundSeq ?? 0;
    const deadline = now() + deadlineMs;
    let backoffMs = initialBackoffMs;
    while (attempts < maxAttempts && now() <= deadline) {
      if (input.signal?.aborted) return { status: "failed" as const, attempts, reason: "cancelled" as const, error: failureMessage("cancelled") };
      attempts += 1;
      let attemptResult: { submissionId: string; result: CoordinatorP2pkhBroadcastResult };
      try {
        attemptResult = await input.attempt({ submitOnce });
      } catch (error) {
        if (isCentralBroadcastRetryableError(error)) {
          // 中文：此异常发生在完整 rebuild/广播之前，不计入广播次数；等待
          // 新鲜快照后再重建，避免把“快照暂时不可用”终态化。
          attempts -= 1;
          if (error.currentSeq !== undefined) boundSeq = Math.max(boundSeq, error.currentSeq);
          if (now() >= deadline) break;
          let nextSeq: number | undefined;
          try {
            nextSeq = await waitForNewSeq(
              input.network ?? "main",
              boundSeq,
              Math.min(backoffMs, Math.max(0, deadline - now())),
              input.signal,
              true,
            );
          } catch (waitError) {
            if (input.signal?.aborted) return { status: "failed" as const, attempts, reason: "cancelled" as const, error: failureMessage("cancelled") };
            throw waitError;
          }
          if (nextSeq !== undefined) boundSeq = Math.max(boundSeq, nextSeq);
          backoffMs = Math.min(maxBackoffMs, backoffMs * 2);
          if (nextSeq === undefined && now() >= deadline) break;
          continue;
        }
        const reason = reasonForError(error);
        // attempt 闭包包含重新选币、签名和本地记录写入；这些步骤的异常
        // 不是“等待新快照”信号，必须立即终止，避免把地址/金额/余额等
        // 明确错误错误地重试成另一笔交易。
        return { status: "failed" as const, attempts, reason, error: failureMessage(reason) };
      }
      const result = attemptResult.result;
      if (result.status === "local-confirmed" || result.status === "already-known" || result.status === "accepted") {
        return { status: "local-confirmed" as const, txid: "txid" in result ? result.txid : result.canonicalTxid, attempts };
      }
      if (isIsolated(result)) return { status: "isolated" as const, txid: result.txid, attempts, reason: "isolated" as const, error: result.reason };
      let requireFreshSnapshot = false;
      if (isNotDispatched(result)) {
        const terminalReason = toFailureReason(result);
        if (terminalReason) return { status: "failed" as const, attempts, reason: terminalReason, error: failureMessage(terminalReason) };
        if (result.reason === "snapshot-consumed") {
          // consumed 即使拿到了一个更大的 seq，也仍然要等该 seq
          // 变成 fresh；否则可能再次撞上另一笔正在广播的交易。
          requireFreshSnapshot = true;
        } else if (result.reason === "snapshot-stale" && result.currentSeq !== undefined) {
          if (result.currentSeq > boundSeq) {
            boundSeq = result.currentSeq;
            continue;
          }
          boundSeq = Math.max(boundSeq, result.currentSeq);
        } else if (result.currentSeq !== undefined) {
          boundSeq = Math.max(boundSeq, result.currentSeq);
        }
      }
      if (attempts >= maxAttempts || now() >= deadline) break;
      while (true) {
        const nextSeq = await waitForNewSeq(input.network ?? "main", boundSeq, Math.min(backoffMs, Math.max(0, deadline - now())), input.signal, requireFreshSnapshot).catch((error) => {
          if (input.signal?.aborted) return undefined;
          throw error;
        });
        if (nextSeq !== undefined) {
          boundSeq = Math.max(boundSeq, nextSeq);
          break;
        }
        if (!requireFreshSnapshot || now() >= deadline || (!deps.refreshSnapshot && !deps.getSnapshot && !deps.subscribeTopic)) break;
        // consumed 仍未解封：继续等待，但不消耗一次完整 rebuild
        // 尝试次数；attempts 只统计真正提交过的交易。
        backoffMs = Math.min(maxBackoffMs, backoffMs * 2);
      }
      backoffMs = Math.min(maxBackoffMs, backoffMs * 2);
      if (requireFreshSnapshot && now() >= deadline) break;
    }
    return { status: "failed" as const, attempts, reason: "snapshot-timeout" as const, error: failureMessage("snapshot-timeout") };
  }

  return { submitOnce, submitWithRetry };
}
