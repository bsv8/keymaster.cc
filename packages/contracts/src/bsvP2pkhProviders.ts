import { defineCapability } from "webloom-framework";
import type { BsvNetwork } from "./vault.js";
import type { P2pkhConnectPaymentFacts, P2pkhConnectPaymentPreview } from "./p2pkhConnectPayment.js";

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
  /** Provider 原始返回的 txid；跨 Worker 后仍保留，便于协议层审计。 */
  providerReturnedTxidRaw?: string;
  /** 归一化后的 Provider txid。 */
  providerReturnedTxidNormalized?: string;
  /** Provider txid 与本地 canonical txid 的一致性。 */
  txidIntegrity?: "exact" | "reversed" | "mismatch" | "missing";
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
  /** 组合交易时捕获的快照序号绑定；花费钱包 P2PKH UTXO 时必须提供。 */
  readonly utxoBinding?: P2pkhUtxoBinding;
  /** Worker UTXO Manager reservation for ordinary wallet funding. */
  readonly managerAllocationId?: string;
}

/** 组合交易时捕获的 UTXO 快照版本绑定。 */
export interface P2pkhUtxoBinding {
  /** 资源 ID，例如 p2pkh:main / p2pkh:test。 */
  readonly resourceId: string;
  /** 组合时看到的快照序号；提交时必须与 Worker 当前序号一致。 */
  readonly seq: number;
}

/**
 * 跨 Runtime 的普通转账输入（只含可序列化字段）。
 *
 * 中文说明：Window 不再直接持有 Worker 的本地能力；它通过 Coordinator 把
 * 转账请求交给 Worker 的 UTXO Manager。跨边界只允许这些纯数据字段。
 */
export interface P2pkhTransferPrepareInput {
  readonly assetId: "bsv" | "bsvtest";
  readonly network: "main" | "test";
  readonly ownerPublicKeyHex: string;
  readonly recipientAddress?: string;
  readonly amountSatoshis: number;
  readonly sendAll?: boolean;
  /** Connect v1 strict payment facts; mutually exclusive with sendAll. */
  readonly payment?: P2pkhConnectPaymentFacts;
  readonly feeRateSatoshisPerKb?: number;
  readonly paymentContext?: { readonly channelId: string; readonly sessionId: string | null };
}

/**
 * 跨 Runtime 的普通转账提交请求：只引用 Worker 自己记住的预览。
 *
 * 中文说明：事实以 Worker 的记录为准——页面只能带 previewId，不能改写选币、
 * 金额、找零或 manager allocation。Worker 找不到（或已过期）该预览即拒绝。
 */
export interface P2pkhTransferSubmitInput {
  readonly previewId: string;
  readonly ownerPublicKeyHex: string;
}

/**
 * 跨 Runtime 的普通转账预览：Window 用于展示的冻结事实。
 *
 * 中文说明：这是**展示与提交引用**，不是授权。Worker 仍按自己的快照、UTXO
 * Manager allocation 与签名事实复核；页面不能凭这条负载花费未授权的资金。
 */
export interface P2pkhTransferPreviewPayload {
  readonly previewId: string;
  readonly assetId: "bsv" | "bsvtest";
  readonly network: "main" | "test";
  readonly ownerPublicKeyHex: string;
  readonly recipientAddress?: string;
  readonly amountSatoshis: number;
  readonly sendAll?: boolean;
  readonly feeRateSatoshisPerKb: number;
  readonly estimatedFeeSatoshis: number;
  readonly serializedSizeBytes: number;
  readonly outputs: ReadonlyArray<{ readonly address?: string; readonly scriptHex?: string; readonly value: number; readonly role?: "business" | "change" }>;
  readonly changeAddress: string;
  /** Connect v1 strict payment preview; absent for the legacy transfer path. */
  readonly payment?: P2pkhConnectPaymentPreview;
  readonly rawTxHex: string;
  /**
   * 最终交易身份。
   *
   * 中文说明：**未签名预览没有最终 txid，固定为空字符串**。跨 Runtime 不允许
   * 用未签名哈希冒充 canonical txid，也不允许提前签名来凑一个 txid。已签名
   * 的预览（协议路径）才带 canonical txid。
   */
  readonly txid: string;
  readonly managerAllocationId?: string;
  readonly utxoBinding?: P2pkhUtxoBinding;
  readonly paymentContext?: { readonly channelId: string; readonly sessionId: string | null };
  readonly allocation: {
    readonly requestedSatoshis: number;
    readonly feeReserveSatoshis: number;
    readonly selected: ReadonlyArray<{ readonly txid: string; readonly vout: number; readonly value: number }>;
    readonly totalInputSatoshis: number;
    readonly changeSatoshis: number;
  };
}

/**
 * 跨 Runtime 的“外露 artifact 占用”请求。
 *
 * 中文说明：Connect/费用池把**已签名**的 artifact 交给站点之前，钱包输入的
 * 责任必须先落到 UTXO Manager——否则同一枚输入仍会被当作可花余额。artifact
 * 身份必须稳定：ledger 与 manager 两侧指向同一笔占用。
 */
export interface P2pkhArtifactOccupyInput {
  readonly ownerPublicKeyHex: string;
  readonly network: "main" | "test";
  /** 稳定 artifact 身份（与 ledger 的责任 ID 一致）。 */
  readonly artifactId: string;
  /** 未签名模板：manager 冻结 intent 用（形状必须与已签字节一致）。 */
  readonly unsignedTxHex: string;
  /** 已签名的 artifact 原文（即将外露给站点的那份）。 */
  readonly signedTxHex: string;
  /** artifact 真实花费的钱包输入。 */
  readonly inputs: ReadonlyArray<{
    readonly txid: string; readonly vout: number; readonly value: string; readonly scriptHex: string;
  }>;
  /** artifact 的自有输出（找零投影用）。 */
  readonly outputs: ReadonlyArray<{ readonly scriptHex: string; readonly value: string }>;
  /** 业务金额（矿工费 = 输入总额 − 输出总额）。 */
  readonly businessAmountSatoshis: string;
  readonly feeRateSatoshisPerKb: string;
  readonly feeCapSats: string;
  readonly protocolKind: "refund" | "close" | "fund" | "state";
}

/** 当前钱包的业务请求；身份仅在受信边界自动补入持久意图。 */
export type P2pkhArtifactRequest = Omit<P2pkhArtifactOccupyInput, "ownerPublicKeyHex" | "network">;

/** 外露 artifact 的占用结果：manager 的 allocation 与交易身份。 */
export interface P2pkhArtifactOccupyResult {
  readonly allocationId: string;
  readonly txid: string;
}

/** 跨 Runtime 的普通转账结果。 */
export interface P2pkhTransferResultPayload {
  readonly status: "local-confirmed" | "isolated" | "not-dispatched";
  /**
   * 最终交易身份：只有 `local-confirmed` 必有；未派发/取消/隔离可以没有。
   *
   * 中文说明：没有最终交易时**不是错误**——响应解析器必须接受这种合法状态。
   */
  readonly txid?: string;
  readonly rawTxHex: string;
  readonly error?: string;
  /** 提交身份：取消或未派发时可能为空。 */
  readonly submissionId: string;
  readonly localInputClaimIds: readonly string[];
  readonly attempts: number;
  readonly reason?: string;
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
 * 当前 manager 查询结果。hasResult 只说明结果已取得，不要求先完成链上同步。
 * seq 是本实例内容变化编号，syncedAt 是本次结果生成时间，均不授予资金权限。
 * 未取得结果时全部材料明确为 null；取得结果时空集合也是正常结果。
 */
export type P2pkhUtxoSnapshotResult =
  | { hasResult: false; items: null; seq: null; syncedAt: null }
  | { hasResult: true; items: P2pkhUtxoSnapshotItem[]; seq: number; syncedAt: string };

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
