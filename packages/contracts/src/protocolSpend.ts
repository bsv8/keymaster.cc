// 协议 spend 契约。
import { defineCapability } from "webloom-framework";
//
// 设计缘由：
//   - 协议插件需要的是“受控签名 + 广播 + txid 归一化”，不是 P2PKH
//     固化表单。
//   - 这里把输入/输出计划抽成最小公共协议，供 BSV-21 / 1Sat Ordinals
//     等插件复用。

import type { BsvNetwork } from "./vault.js";
import type { P2pkhUtxoBinding } from "./bsvP2pkhProviders.js";

export const P2PKH_PROTOCOL_SPEND_CAPABILITY = defineCapability<ProtocolSpendService>({
  kind: "local",
  id: "p2pkh.protocol-spend",
  version: "1",
});

export interface ProtocolSpendInput {
  txid: string;
  vout: number;
  value: number;
  address: string;
}

export interface ProtocolSpendOutput {
  value: number;
  scriptHex: string;
  label?: string;
}

export interface ProtocolSpendPreview {
  ownerPublicKeyHex: string;
  requestingPluginId?: string;
  network: BsvNetwork;
  inputs: ProtocolSpendInput[];
  outputs: ProtocolSpendOutput[];
  changeAddress?: string;
  changeSatoshis: number;
  estimatedFeeSatoshis: number;
  serializedSizeBytes: number;
  txid: string;
  rawTxHex: string;
  protectedClaimIds?: string[];
  inputClaimIds?: string[];
  submissionId?: string;
  /** 花费钱包 P2PKH UTXO 时捕获的快照绑定；纯代币输入可省略。 */
  utxoBinding?: P2pkhUtxoBinding;
  /** 兼容协议层的序号投影；无钱包 P2PKH 输入时省略。 */
  utxoSeq?: number;
}

export interface ProtocolSpendResult {
  status:
    | "broadcast-pending-woc"
    | "woc-observed-unconfirmed"
    | "woc-confirmed"
    | "woc-dropped"
    | "rejected"
    | "unknown"
    | "provider-inconsistent";
  txid: string;
  rawTxHex: string;
  inputClaimIds?: string[];
  submissionId?: string;
  canonicalTxid?: string;
  providerReturnedTxidRaw?: string;
  providerReturnedTxidNormalized?: string;
  txidIntegrity?: "exact" | "reversed" | "mismatch" | "missing";
  observation?: "unconfirmed" | "confirmed";
  droppedReason?: string;
  error?: string;
}

export interface ProtocolSpendService {
  prepare(input: ProtocolSpendPrepareInput): Promise<ProtocolSpendPreview>;
  submit(preview: ProtocolSpendPreview): Promise<ProtocolSpendResult>;
  /** 释放尚未广播的预签名及其输入占用；未知或已派发交易不得调用。 */
  releasePrepared?(preview: ProtocolSpendPreview): Promise<void>;
  /** 按持久化提交编号释放已明确未派发的预签名；用于跨进程恢复。 */
  releasePreparedSubmission?(input: {
    /** 提交所属的当前 Key。 */
    ownerPublicKeyHex: string;
    /** 交易所属网络。 */
    network: BsvNetwork;
    /** 必须与持久化预签名记录一致的 canonical txid。 */
    txid: string;
    /** P2PKH 持久化的 protocol submission ID。 */
    submissionId: string;
  }): Promise<void>;
}

export interface ProtocolSpendPrepareInput {
  ownerPublicKeyHex: string;
  requestingPluginId?: string;
  network: BsvNetwork;
  inputs: ProtocolSpendInput[];
  outputs: ProtocolSpendOutput[];
  feeRateSatoshisPerKb: number;
  changeAddress?: string;
}

/**
 * 协议提交观测能力。
 *
 * 协议 spend 自己会把提交记录持久化（含 canonical txid 与状态）；恢复路径需要读
 * 回**同一个**提交而不是重建，所以观测入口单独发布成一个窄能力。
 *
 * 状态取值与 `P2pkhProtocolSpendSubmissionStatus` 对齐。调用方必须按
 * `(ownerPublicKeyHex, network, txid, submissionId)` 四元组查询：只按 txid 查会让
 * 同一笔交易的不同提交互相覆盖。
 */
export interface ProtocolSubmissionObserver {
  observeProtocolSubmission(input: {
    ownerPublicKeyHex: string;
    network: BsvNetwork;
    txid: string;
    submissionId: string;
  }): Promise<ProtocolSubmissionObservation>;
}

export type ProtocolSubmissionObservation =
  | "not-dispatched"
  | "dispatched"
  | "observed-unconfirmed"
  | "observed-confirmed"
  | "dropped"
  | "rejected"
  | "unknown";

export const P2PKH_SUBMISSION_OBSERVER_CAPABILITY = defineCapability<ProtocolSubmissionObserver>({
  kind: "local",
  id: "p2pkh.submission-observer",
  version: "1",
});

/**
 * 专用资金能力。
 *
 * 协议交易不能直接花钱包的大额余额：差额会成为矿工费。因此协议插件先通过这个
 * 能力准备一笔**普通** P2PKH 资金准备交易（含正常找零），产出一个金额已知的
 * 单输入专用 UTXO，之后的协议交易只花这一个 UTXO 且不带找零。
 *
 * 选币、资金准备交易、找零与专用 UTXO 的保护登记全部在 P2PKH 内完成；调用方
 * 只拿到 outpoint 与金额。
 */
export interface ProtocolFundingService {
  /**
   * 准备并广播一笔资金准备交易，返回其产出的专用 UTXO。
   *
   * 返回不代表 UTXO 已确认：调用方需要时用 `observeDedicatedFunding` 查链上状态。
   * 同一个 `fundingId` 重复调用必须返回同一个 UTXO，不得再次拆钱。
   */
  prepareDedicatedFunding(input: ProtocolFundingRequest): Promise<ProtocolDedicatedFunding>;
  /** 按 outpoint 查这笔专用资金的链上状态。 */
  observeDedicatedFunding(input: {
    ownerPublicKeyHex: string;
    network: BsvNetwork;
    fundingId: string;
    txid: string;
    vout: number;
  }): Promise<ProtocolDedicatedFundingState>;
  /** 明确未派发时才可释放该 UTXO 的占用。 */
  releaseDedicatedFunding?(input: {
    ownerPublicKeyHex: string;
    network: BsvNetwork;
    fundingId: string;
    submissionId: string;
  }): Promise<void>;
}

export interface ProtocolFundingRequest {
  readonly ownerPublicKeyHex: string;
  readonly network: BsvNetwork;
  /** 调用方侧的稳定编号；同一个编号只允许有一笔专用资金。 */
  readonly fundingId: string;
  /** 专用 UTXO 至少要有这么多聪，够覆盖协议的固定输出与矿工费预算。 */
  readonly requiredSatoshis: string;
  /** 矿工费率（sat/KB），只用于资金准备交易本身。 */
  readonly feeRateSatoshisPerKb: number;
  /** 登记受保护输出时的诊断标签。 */
  readonly protectionReason?: string;
  /**
   * 专用资金的归属插件，用于受保护输出归属与诊断。
   *
   * 受保护输出按 outpoint 生效，因此这里不改变拦截行为；它只决定这条记录挂在
   * 哪个 plugin 名下，便于诊断「是谁把这笔输出锁住了」。
   */
  readonly ownerPluginId?: string;
}

export interface ProtocolDedicatedFunding {
  readonly fundingId: string;
  readonly txid: string;
  readonly vout: number;
  /** 资金准备交易的 raw，调用方原样保存用于对账。 */
  readonly rawTxHex: string;
  /** 专用 UTXO 的金额，规范十进制字符串。 */
  readonly valueSatoshis: string;
  /** 专用 UTXO 的 P2PKH 地址；协议交易花费它时用。 */
  readonly address: string;
  readonly submissionId?: string;
}

export type ProtocolDedicatedFundingState = "unknown" | "mempool" | "confirmed" | "spent";

export const P2PKH_FUNDING_CAPABILITY = defineCapability<ProtocolFundingService>({
  kind: "local",
  id: "p2pkh.protocol-funding",
  version: "1",
});
