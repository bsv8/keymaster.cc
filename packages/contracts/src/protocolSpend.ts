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
  /**
   * 裸公钥单签输入的锁定脚本（可选）。
   *
   * 给了它就按「公钥在锁定脚本里」签名：scriptCode 用这个脚本，解锁脚本只推签名。
   * Forum 的 data / tip 输出正是这种形状，因此它们可以被识别、归集，而不需要把
   * 公钥塞进 P2PKH 的重建脚本——那会算出完全不同的 sighash。
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
  /**
   * 受控无找零模式。
   *
   * 与 `changeAddress` 互斥：协议固定输出交易没有找零输出，输入超出固定输出的
   * 全部差额**必须**成为矿工费，且不得超过调用方给出的预算上限。没有这条规则时
   * 钱包只能报「余款拒绝」，调用方无法构造固定输出的协议交易。
   */
  noChangeRule?: ProtocolSpendNoChangeRule;
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
   * 启动时从持久记录恢复受保护输出登记。
   *
   * 保护登记是**纯内存**状态：重启后必须重新登记，否则普通 P2PKH 选币会把仍属于
   * 用户的专用 UTXO 当成可用余额花掉，而它可能正挂在一个未完成的发布任务上。
   *
   * 返回恢复条数与不可读记录数：存在不可读记录时调用方应当拒绝准备新资金，
   * 因为那笔资金的 UTXO 可能已经在链上。
   */
  restoreProtections?(input: {
    ownerPublicKeyHex: string;
    network: BsvNetwork;
  }): Promise<{ restored: number; readonly unreadable: readonly string[] }>;
  /**
   * 按 outpoint 核对一笔已存在的专用资金，并在复用前恢复它的保护登记。
   *
   * 调用方已有自己的资金记录时必须走这里，而不是直接返回：只有这条路径会核对
   * 链上状态（已花费的资金不能被复用）并重申保护。
   */
  reconcileDedicatedFunding?(input: {
    ownerPublicKeyHex: string;
    network: BsvNetwork;
    fundingId: string;
    txid: string;
    vout: number;
    requiredSatoshis: string;
  }): Promise<{ state: ProtocolDedicatedFundingState; usable: boolean; reason?: string }>;
  /**
   * 准备并广播一笔资金准备交易，返回其产出的专用 UTXO。
   *
   * 返回不代表 UTXO 已确认：调用方需要时用 `observeDedicatedFunding` 查链上状态。
   * 同一个 `fundingId` 重复调用必须返回同一个 UTXO，不得再次拆钱。
   *
   * 恢复语义：已存在记录时**先对账原提交**，只有明确未派发才允许重新准备；
   * 被拒或状态未知的记录不得直接当作可用资金返回。
   */
  prepareDedicatedFunding(input: ProtocolFundingRequest): Promise<ProtocolDedicatedFunding>;
  /**
   * 估算一笔资金准备交易的矿工费上界（聪，规范十进制字符串）。
   *
   * 与 `prepareDedicatedFunding` 实际采用的费用余量同源：调用方把它列进费用确认
   * 项时，展示的额度就是真正会付的额度，不会出现「显示 0、实际扣费」。
   */
  estimateFundingMinerFee?(input: { requiredSatoshis: string; feeRateSatoshisPerKb: number }): string;
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
  /**
   * 显式回收：把已上链的专用资金扫回 owner 的地址。
   *
   * 与 `releaseDedicatedFunding` 的区别：那个只释放**未派发**预签名的占用；这笔钱
   * 已经在链上、仍属于用户，只是不再被任何发布任务需要，因此要真的花掉它。
   *
   * 必须是显式动作：回收会让记录消失，任务若仍在用这笔资金就会在恢复时才发现。
   * 因此实现要求调用方先确认记录确实不再被引用。
   */
  recoverDedicatedFunding?(input: {
    ownerPublicKeyHex: string;
    network: BsvNetwork;
    fundingId: string;
    feeRateSatoshisPerKb: number;
    /**
     * 「确定不再使用」的依据。调用方必须说清楚凭什么认为这笔钱可以扫走。
     *
     * - `supersededBy`：已被同一 owner 的另一笔专用资金替代，值必须与记录一致；
     * - `unused`：所属协议已仲裁该笔资金不再被任何任务引用（任务取消、报价下降后
     *   改用更便宜的资金等）。这条不能只靠调用方一句话——钱包侧仍会核对链上状态与
     *   广播状态，`dispatched`/`unknown` 的记录一律拒绝。
     */
    reason: { supersededBy: string } | { unused: true };
  }): Promise<{
    txid: string;
    rawTxHex: string;
    recoveredSatoshis: string;
    broadcastState: string;
    /** UTXO 此前已被别的交易花掉：只是清理记录，没有真的回收。 */
    outcome: "recovered" | "already-spent";
  }>;
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
  /**
   * 广播阶段。
   *
   * `prepared` 是**写前日志**：派发之前就已落盘，崩溃后据此对账而不是重新拆钱。
   * `rejected` 表示明确未派发（可以安全重来）；`unknown` 表示结果不明，必须先
   * 对账原提交，两种情况都不能直接当作可用资金。
   */
  readonly broadcastState?: ProtocolFundingBroadcastState;
  readonly updatedAtMs?: number;
}

export type ProtocolFundingBroadcastState = "prepared" | "dispatched" | "rejected" | "unknown";

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

/** 资金准备交易最多用多少个钱包输入参与估算。 */
export const PROTOCOL_FUNDING_MAX_INPUTS = 10;

/**
 * 资金准备交易的矿工费上界。
 *
 * 按「上限输入数 + 2 个输出（专用 UTXO 与找零）」的长度上界估算，不实测：这里算的
 * 是**额度**，实际费用由 `ProtocolSpendService` 按真实费率收敛并走找零。
 *
 * 放在契约层是因为调用方要把它列进费用确认项：只有同一份公式，界面显示的
 * 「专用资金准备矿工费」才与真正会付的量级一致，不会出现「显示 0、实际扣费」。
 */
export function estimateProtocolFundingMinerFee(
  requiredSatoshis: bigint,
  feeRateSatoshisPerKb: number,
  maxInputs: number = PROTOCOL_FUNDING_MAX_INPUTS,
): bigint {
  if (requiredSatoshis < 0n) throw new Error("资金准备额度不能为负数");
  if (!Number.isFinite(feeRateSatoshisPerKb) || feeRateSatoshisPerKb < 1) {
    throw new Error("资金准备矿工费率必须是正数");
  }
  if (!Number.isInteger(maxInputs) || maxInputs < 1) throw new Error("资金准备输入数上界必须是正整数");
  // 每个输入：outpoint 36 + 序列号 4 + scriptSig 上界（DER+公钥+SIGHASH）
  const perInputBytes = 36n + 4n + 108n;
  // 每个输出：金额 8 + 变长整数 1 + 锁定脚本上界
  const perOutputBytes = 8n + 10n + 128n;
  const size = BigInt(maxInputs) * perInputBytes + 2n * perOutputBytes + 1024n;
  return (size * BigInt(Math.ceil(feeRateSatoshisPerKb)) + 999n) / 1000n;
}

export type ProtocolDedicatedFundingState = "unknown" | "mempool" | "confirmed" | "spent";

export const P2PKH_FUNDING_CAPABILITY = defineCapability<ProtocolFundingService>({
  kind: "local",
  id: "p2pkh.protocol-funding",
  version: "1",
});
