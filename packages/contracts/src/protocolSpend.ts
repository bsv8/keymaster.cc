// 协议 spend 契约。
import { defineCapability } from "webloom-framework";
//
// 设计缘由：
//   - 协议插件需要的是“受控签名 + 广播 + txid 归一化”，不是 P2PKH
//     固化表单。
//   - 输入/输出计划由协议插件提交，钱包归属和网络由权威身份绑定。

import type { BsvNetwork } from "./vault.js";
import type { P2pkhUtxoBinding } from "./bsvP2pkhProviders.js";

export const P2PKH_PROTOCOL_SPEND_CAPABILITY = defineCapability<ProtocolSpendService>({
  kind: "local",
  id: "p2pkh.protocol-spend",
  version: "1",
});

export interface ProtocolSpendInput {
  /** 本地 exact outbox 的完整前序交易；签名前必须按 txid、输出金额和脚本复核。 */
  previousTransactionHex?: string;
  txid: string;
  vout: number;
  value: number;
  address: string;
  /**
   * 裸公钥单签输入的锁定脚本（可选）。
   *
   * 给了它就按「公钥在锁定脚本里」签名：scriptCode 用这个脚本，解锁脚本只推签名。
   *
   * 缺席时按普通 P2PKH 输入处理（scriptCode 由 `address` 重建，解锁脚本推签名与公钥）。
   */
  lockingScriptHex?: string;
}

export interface ProtocolSpendOutput {
  value: number;
  scriptHex: string;
  label?: string;
}

export interface ProtocolSpendPreview {
  /** In-memory unsigned preview ticket; absent on explicit durable presign. */
  previewId?: string;
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
  /**
   * UTXO manager allocation that owns this signed transaction. When present
   * the manager holds the durable pre-signature intent, the exclusive input
   * responsibility and the exact bytes, and the broadcast must run through
   * the manager's dispatch path.
   */
  managerAllocationId?: string;
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
  /** Pure unsigned preview: no signature, payment reservation or input claim. */
  prepare(input: ProtocolSpendPrepareInput): Promise<ProtocolSpendPreview>;
  /** Explicit signature for workflows whose next stage depends on signed txid.
   * It consumes payment authorization and persists input claims immediately. */
  presign(input: ProtocolSpendPrepareInput): Promise<ProtocolSpendPreview>;
  submit(preview: ProtocolSpendPreview): Promise<ProtocolSpendResult>;
  /** 释放尚未广播的预签名及其输入占用；未知或已派发交易不得调用。 */
  releasePrepared?(preview: ProtocolSpendPreview): Promise<void>;
  /** 按持久化提交编号释放已明确未派发的预签名；用于跨进程恢复。 */
  releasePreparedSubmission?(input: {
    /** 必须与持久化预签名记录一致的 canonical txid。 */
    txid: string;
    /** P2PKH 持久化的 protocol submission ID。 */
    submissionId: string;
  }): Promise<void>;
}

export interface ProtocolSpendPrepareInput {
  requestingPluginId?: string;
  inputs: ProtocolSpendInput[];
  outputs: ProtocolSpendOutput[];
  feeRateSatoshisPerKb: number;
  /** Business miner-fee cap, checked before manager intent or signing. */
  maxFeeSatoshis?: number;
  /** BitFS opening: retain exact responsibility but block dispatch until Kind 3. */
  deferDispatch?: boolean;
  changeAddress?: string;
  /**
   * 受控无找零模式。
   *
   * 与 `changeAddress` 互斥：协议固定输出交易没有找零输出，输入超出固定输出的
   * 全部差额**必须**成为矿工费，且不得超过调用方给出的预算上限。没有这条规则时
   * 钱包只能报「余款拒绝」，调用方无法构造固定输出的协议交易。
   */
  noChangeRule?: ProtocolSpendNoChangeRule;
  /**
   * Protocol role recorded in the UTXO manager's durable intent. Optional so
   * existing callers keep their behaviour; the default is "refund".
   */
  protocolKind?: "refund" | "close" | "fund" | "state";
}

/**
 * 受控无找零构建规则。
 *
 * 只有明确给出这条规则的调用方才进入无找零路径；其余调用方保持原来的
 * 「无 changeAddress 且有余款即拒绝」行为，避免协议插件以外的资金流被静默
 * 变成矿工费。
 */
export interface ProtocolSpendNoChangeRule {
  /**
   * 用户已确认的矿工费上限（聪）。
   *
   * 无找零模式下实际矿工费恒等于输入总额减固定输出总额，因此这条上限同时是
   * 「余额必须被精确用完」与「费用不得超过确认预算」的唯一判据。
   */
  readonly maxMinerFeeSatoshis: number;
  /**
   * 是否允许零值输出。
   *
   * 固定位置的协议输出必须为真：索引费为零时 vout 0 的值就是 0，位置本身是协议
   * 的一部分，不能因为金额为零而消失或改用别的位置。
   */
  readonly allowZeroValueOutputs?: boolean;
}

/**
 * 协议提交观测能力。
 *
 * 协议 spend 自己会把提交记录持久化（含 canonical txid 与状态）；恢复路径需要读
 * 回**同一个**提交而不是重建，所以观测入口单独发布成一个窄能力。
 *
 * 状态取值与 `P2pkhProtocolSpendSubmissionStatus` 对齐。调用方必须按
 * `(txid, submissionId)` 查询并校验记录的原始钱包归属：只按 txid 查会让
 * 同一笔交易的不同提交互相覆盖。
 */
export interface ProtocolSubmissionObserver {
  observeProtocolSubmission(input: {
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
export interface ProtocolFundingPlanRequest {
  amountSatoshis: number;
  feeRateSatoshisPerKb: number;
  outputs?: Array<{ scriptHex: string; value: string }>;
}

/**
 * 广播结果的**确定性**分类。
 *
 * `ProtocolSpendResult.status` 有 7 个值，但调用方真正要判断的只有三件事：钱到账了吗
 * （`accepted`）、交易确定没进网络吗（`not-broadcast`）、还是不知道（`uncertain`）。
 * 逐个 `!== "unknown"` 那样判断会把「明确被拒」和「服务商说法不一致」一起当成成功，
 * 因此在这里给出唯一一份映射。
 */
export type ProtocolSpendOutcome =
  /** 已被服务商接受（可能仍在 mempool，也可能已确认）。 */
  | "accepted"
  /** 确定没进网络：资金仍在本地，原提交不再需要对账。 */
  | "not-broadcast"
  /** 结果不明：必须先对账，不能当成成功、也不能当成失败。 */
  | "uncertain";

export function classifyProtocolSpendResult(status: ProtocolSpendResult["status"]): ProtocolSpendOutcome {
  switch (status) {
    case "broadcast-pending-woc":
    case "woc-observed-unconfirmed":
    case "woc-confirmed":
      return "accepted";
    // `rejected` 是服务商明确拒绝；`woc-dropped` 是 WOC 观测到已被丢弃。
    // 两者都能证明这笔钱没花出去，原 UTXO 与记录都要留着。
    case "rejected":
    case "woc-dropped":
      return "not-broadcast";
    // `unknown` 是没拿到结论；`provider-inconsistent` 是服务商的说法与本地 txid
    // 对不上——可能已经进了网络，也可能只是服务商算错了，同样不能下结论。
    case "unknown":
    case "provider-inconsistent":
      return "uncertain";
    default: {
      const exhaustive: never = status;
      throw new Error(`unknown protocol spend status: ${String(exhaustive)}`);
    }
  }
}

