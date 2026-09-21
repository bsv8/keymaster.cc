import { defineCapability } from "webloom-framework";
import type { BsvNetwork } from "./vault.js";
import type { P2pkhUtxoBinding } from "./bsvP2pkhProviders.js";
import type { CoordinatorP2pkhBroadcastResult } from "./sessionCoordinatorRuntime.js";

/**
 * 判断广播错误是否能确定“请求没有派发到 Provider”。
 *
 * 中文：这个判定只允许在**能证明交易没有被链路接收**时返回 true，因为
 * 调用方会据此回滚快照消费与本地占用。注意：
 *   - HTTP 4xx（含 400/408/413/422）本身不构成证明：Provider 对
 *     "交易已存在 / 已在 mempool" 也可能返回 4xx，此时交易其实已上链路；
 *   - 超时、网络断开、429/5xx 同样可能发生在 Provider 已收到交易之后；
 *   - WoC 适配器当前对任意非 2xx 只抛 `WOC <status> <text>`，没有结构化
 *     状态，所以默认必须按“结果未知”处理。
 *
 * 只有两条安全通道允许回滚：
 *   1. Provider 适配器显式抛出的结构化标记 `code === "definitive-not-dispatched"`；
 *   2. 节点明确拒绝交易本体的错误文本（`invalid transaction` / `bad-txns-*` /
 *      `malformed payload`）；笼统的 `rejected` 不算。
 */
export function isDefinitelyNotDispatchedBroadcastError(error: unknown): boolean {
  const record = error && typeof error === "object" ? error as { code?: unknown } : undefined;
  if (record?.code === "definitive-not-dispatched") return true;
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  return lower.includes("invalid transaction")
    || lower.includes("bad-txns")
    || lower.includes("malformed payload");
}

/** 中心广播终态原因；UI 应映射成中文文案。 */
export type CentralBroadcastFailureReason =
  | "insufficient"
  | "no-utxos"
  | "policy-denied"
  | "snapshot-timeout"
  | "snapshot-binding"
  | "rebuild-unavailable"
  | "requires-reconfirm"
  | "isolated"
  | "cancelled";

/** 唯一广播入口能力；插件拿不到 Worker RPC 或 WOC 广播方法。 */
export const CENTRAL_BROADCAST_CAPABILITY = defineCapability<CentralBroadcastService>({
  kind: "local",
  id: "tx.broadcast",
  version: "1",
});

/** 一次提交的输入。 */
export interface OneShotBroadcastInput {
  /** 所有者压缩公钥 hex（小写）。 */
  ownerPublicKeyHex: string;
  /** 网络：main=主网，test=测试网。 */
  network: BsvNetwork;
  /** 本次尝试的本地提交 ID；每次重试必须重新生成。 */
  submissionId: string;
  /** 资源 ID，例如 p2pkh:main。 */
  resourceId: string;
  /** 交易 ID（64 位小写 hex）。 */
  txid: string;
  /** 已签名原始交易 hex。 */
  rawTxHex: string;
  /** 花费钱包 P2PKH UTXO 时的快照绑定。 */
  utxoBinding?: P2pkhUtxoBinding;
}

/** 中心广播服务的最终结果。 */
export interface BroadcastOutcome {
  /** local-confirmed=已确定广播；isolated=结果未知；failed=确定未派发且停止重试。 */
  status: "local-confirmed" | "isolated" | "failed";
  txid?: string;
  rawTxHex?: string;
  /** 已尝试次数（含第一次）。 */
  attempts: number;
  /** 终止原因。 */
  reason?: CentralBroadcastFailureReason;
  /** 最近一次错误，仅用于诊断。 */
  error?: string;
}

/** 页面侧中心广播服务。 */
export interface CentralBroadcastService {
  /** 单次提交，不自动重试；业务服务内部使用。 */
  submitOnce(input: OneShotBroadcastInput): Promise<CoordinatorP2pkhBroadcastResult>;
  /** 业务提供完整 rebuild 尝试，中心服务负责预算与唤醒。 */
  submitWithRetry(input: {
    /** 本次尝试所属网络；用于筛选对应的 utxoSeqs 事件。 */
    network?: BsvNetwork;
    /** 只有大于此序号的新快照才触发下一次组合。 */
    boundSeq?: number;
    /** 一次完整尝试：重新读快照、选币、签名、写本地记录并调用 submitOnce。 */
    attempt: (context: {
      submitOnce: (input: OneShotBroadcastInput) => Promise<CoordinatorP2pkhBroadcastResult>;
    }) => Promise<{ submissionId: string; result: CoordinatorP2pkhBroadcastResult }>;
    /** 锁钱包、切 owner 或用户取消信号。 */
    signal?: AbortSignal;
  }): Promise<BroadcastOutcome>;
}
