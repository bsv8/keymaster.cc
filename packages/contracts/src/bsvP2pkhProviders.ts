import { defineCapability } from "webloom-framework";
import type { BsvNetwork } from "./vault.js";

/**
 * 广播 Provider：唯一保留下来的 Provider 抽象。
 *
 * 设计缘由（2026-09-20 简化）：
 *   - P2PKH 的已确认历史与 UTXO 真值只有 WoC 一个来源，confirmed-provider
 *     选择层已删除；同步直接调用 WocService。
 *   - 广播边界保留，方便未来切换广播通道，也不扩大本次改造范围。
 */
export interface P2pkhTransactionBroadcastProvider {
  readonly descriptor: P2pkhProviderDescriptor;
  broadcast(input: {
    network: BsvNetwork;
    canonicalTxid: string;
    rawTxHex: string;
    signal?: AbortSignal;
  }): Promise<P2pkhBroadcastResult>;
}

export interface P2pkhProviderDescriptor {
  id: string;
  label: string;
  supportedNetworks: BsvNetwork[];
}

export interface P2pkhBroadcastResult {
  status: "accepted" | "already-known";
  canonicalTxid: string;
  providerReference?: string;
  providerCode?: string;
  providerMessage?: string;
}

/**
 * 页面侧 P2PKH 本地提交快照。
 *
 * 设计缘由：本地提交记录和输入占用目前是内存态，页面 service 与 SharedWorker
 * 广播处理器是两个 JS realm，Worker 读不到页面内存。因此页面在请求广播时必须
 * 把“待广播交易”（canonical txid + 原始交易 hex）交给 Worker；Worker 先把它
 * 写入自己的审计存储（write-ahead），再调用广播 Provider，最后回写终态。
 * 这样 Worker 始终是广播不可逆操作的唯一写者，也不会信任页面自报的成功状态。
 */
export interface P2pkhBroadcastSubmission {
  /** 页面本地提交对应的资源 ID，例如 `p2pkh:test`。 */
  readonly resourceId: string;
  /** 与 rawTxHex 对应的 canonical txid（64 位小写十六进制）。 */
  readonly txid: string;
  /** 已签名的完整原始交易 hex；Worker 会用生产解析器复核 txid 后再广播。 */
  readonly rawTxHex: string;
}

/** Provider 注册表快照：只剩广播 Provider。 */
export interface P2pkhProviderRegistrySnapshot {
  broadcastProviders: P2pkhProviderDescriptor[];
}

/**
 * UTXO 快照项（Coordinator Worker 内存快照的跨进程投影）。
 *
 * 中文说明：
 *   - txid/vout：outpoint；
 *   - value：聪；
 *   - height：确认高度（未确认为 0）；
 *   - status：confirmed / unconfirmed；
 *   - isSpentInMempoolTx：是否已被内存池交易花费（true 不可选币）；
 *   - script：锁定脚本（Provider 提供时）。
 */
export interface P2pkhUtxoSnapshotItem {
  txid: string;
  vout: number;
  value: number;
  height: number;
  status: "confirmed" | "unconfirmed";
  isSpentInMempoolTx: boolean;
  script?: string;
}

/**
 * UTXO 快照读取结果。
 *
 * `available=false` 表示冷启动/刷新失败后尚无任何可信快照，余额是
 * “未知/不可用”，绝不能当成 0。
 */
export interface P2pkhUtxoSnapshotResult {
  available: boolean;
  syncedAt?: string;
  items: P2pkhUtxoSnapshotItem[];
}

export const P2PKH_PROVIDERS_CAPABILITY = defineCapability<P2pkhProviderRegistry>({
  kind: "local",
  id: "p2pkh.providers",
  version: "1",
});

export type P2pkhProviderFailureCode =
  | "provider-unavailable"
  | "unsupported-network"
  | "provider-inconsistent"
  | "rate-limited"
  | "aborted"
  | "rejected"
  | "unknown";

/** Provider errors are diagnostic only; business state consumes normalized status. */
export class P2pkhProviderError extends Error {
  readonly code: P2pkhProviderFailureCode;
  readonly providerCode?: string;

  constructor(code: P2pkhProviderFailureCode, message: string, providerCode?: string) {
    super(message);
    this.name = "P2pkhProviderError";
    this.code = code;
    this.providerCode = providerCode;
  }
}

export interface P2pkhProviderRegistry {
  registerBroadcastProvider(provider: P2pkhTransactionBroadcastProvider): void;
  /** 关闭 Provider 产品时同步移除广播入口；缺省实现只兼容只读 Provider。 */
  unregisterBroadcastProvider?(providerId: string): void;
  listBroadcastProviders(network?: BsvNetwork): P2pkhProviderDescriptor[];
  getBroadcastProvider(id: string, network: BsvNetwork): P2pkhTransactionBroadcastProvider | undefined;
}
