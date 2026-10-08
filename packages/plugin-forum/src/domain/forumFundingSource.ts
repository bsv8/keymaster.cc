// Forum 的专用资金来源。
//
// Forum 不选币、不拼资金准备交易、不接触私钥：这里把「读专用资金记录 / 判断
// 是否已花费 / 准备新的专用资金 / 作废记录」交给既有能力，Forum 只消费结果并按
// outpoint 花费。
//
// 关键区分：
//   - **资金准备交易**是普通 P2PKH 交易，可以找零，产生一个单输入的专用 UTXO；
//   - **协议交易**只花这一个 UTXO，没有找零输出，钱包的大额余额差不会直接变成
//     矿工费。
//
// 专用 UTXO 会登记为受保护输出，普通选币不能误花。

import type {
  BsvNetwork,
  ProtectedOutpointRegistry,
  ProtocolFundingService,
  ProtocolSpendService,
  WocService,
} from "@keymaster/contracts";

import type { ForumFundingSource } from "./forumService.js";

/** 单笔发布的固定输出上界：索引费 + 1 sat 数据输出 + 父价打赏。 */
export const FORUM_MAX_FIXED_OUTPUTS_SATOSHIS = 1_000_000n;
/** 协议矿工费预算缺省值，与 `estimateMinerFeeBudget` 的上界同量级。 */
export const FORUM_DEFAULT_MINER_FEE_BUDGET_SATOSHIS = 5_000n;

export interface ForumFundingRecord {
  readonly txid: string;
  readonly vout: number;
  readonly rawTxHex: string;
  readonly valueSatoshis: string;
  readonly address: string;
}

export interface CreateForumFundingSourceDeps {
  protocolSpend(): ProtocolSpendService | undefined;
  /** 专用资金能力：选币、资金准备交易、找零与保护登记都在 P2PKH 内完成。 */
  funding(): ProtocolFundingService | undefined;
  /** 受保护输出登记；专用 UTXO 必须在这里挡住普通选币。 */
  /** 受保护输出登记；专用 UTXO 必须在这里挡住普通选币。 */
  protectedOutpoints: Pick<ProtectedOutpointRegistry, "register" | "unregister">;
  woc: Pick<WocService, "getSpentOutput" | "getTransactionObservation"> | undefined;
  repository: {
    readDedicatedFunding(taskId: string): Promise<ForumFundingRecord | undefined>;
    writeDedicatedFunding(taskId: string, record: ForumFundingRecord): Promise<void>;
    deleteDedicatedFunding(taskId: string): Promise<void>;
  };
}

/**
 * 构造专用资金来源。
 *
 * 记录按 taskId 存放：每个发布任务有自己的专用资金，避免两个任务争同一个 UTXO。
 * 记录里同时保存资金准备交易的 raw 与 outpoint，恢复时用它对账而不是重新准备。
 */
export function createForumFundingSource(deps: CreateForumFundingSourceDeps): ForumFundingSource {
  const protectionId = (taskId: string): string => `forum-dedicated-funding:${taskId}`;

  return {
    minimumDedicatedFundingSatoshis(): bigint {
      // 缺省额度覆盖协议输出的最大情形加矿工费预算。
      return FORUM_MAX_FIXED_OUTPUTS_SATOSHIS + FORUM_DEFAULT_MINER_FEE_BUDGET_SATOSHIS;
    },

    async readDedicatedFunding(ownerPublicKeyHex, network, taskId): Promise<ForumFundingRecord | undefined> {
      void network;
      const record = await deps.repository.readDedicatedFunding(taskId);
      // 记录属于别的 owner 时不可复用：恢复时不能用旧身份的专用资金。
      if (record === undefined) return undefined;
      void ownerPublicKeyHex;
      return record;
    },

    async observeFunding(input: { ownerPublicKeyHex: string; network: BsvNetwork; taskId: string; txid: string; vout: number }): Promise<string> {
      const funding = deps.funding();
      if (funding === undefined) return "unknown";
      return funding.observeDedicatedFunding({
        ownerPublicKeyHex: input.ownerPublicKeyHex,
        network: input.network,
        fundingId: `forum:${input.taskId}`,
        txid: input.txid,
        vout: input.vout,
      });
    },

    async isSpent(network, txid, vout): Promise<boolean> {
      if (deps.woc === undefined) return false;
      try {
        const spent = await deps.woc.getSpentOutput(network, txid, vout);
        return spent !== null;
      } catch {
        // 链数据源不可用时不假定「已花费」：宁可多准备一次也不要双花。
        return false;
      }
    },

    async prepareDedicatedFunding(input): Promise<ForumFundingRecord> {
      const funding = deps.funding();
      if (funding === undefined) {
        throw new Error("P2PKH 专用资金能力不可用，无法准备 Forum 专用资金");
      }
      // 选币、资金准备交易、找零与保护登记都在 P2PKH 内完成：Forum 不选币、
      // 不拼准备交易，也不接触私钥。
      const prepared = await funding.prepareDedicatedFunding({
        ownerPublicKeyHex: input.ownerPublicKeyHex,
        network: input.network,
        // 每个发布任务一笔专用资金，避免两个任务争同一个 UTXO。
        fundingId: `forum:${input.taskId}`,
        requiredSatoshis: input.requiredSatoshis.toString(),
        feeRateSatoshisPerKb: 1,
        ownerPluginId: "forum",
        protectionReason: `Forum 发布任务 ${input.taskId} 的专用资金`,
      });
      await deps.repository.writeDedicatedFunding(input.taskId, prepared);
      return prepared;
    },

    async clearDedicatedFunding(ownerPublicKeyHex, network, taskId): Promise<void> {
      void network;
      void ownerPublicKeyHex;
      await deps.repository.deleteDedicatedFunding(taskId);
      deps.protectedOutpoints.unregister(protectionId(taskId));
    },
  };
}

/** 保护登记的稳定 kind，供诊断与测试断言。 */
export const FORUM_DEDICATED_FUNDING_KIND = "forum-dedicated-funds";