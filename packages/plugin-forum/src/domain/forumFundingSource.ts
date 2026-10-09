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
import { estimateProtocolFundingMinerFee } from "@keymaster/contracts";

import type { ForumFundingRecord, ForumFundingPlan, ForumFundingSource } from "./forumService.js";
import { ForumProtocolError } from "../publish/forumProtocol.js";

/** 单笔发布的固定输出上界：索引费 + 1 sat 数据输出 + 父价打赏。 */
export const FORUM_MAX_FIXED_OUTPUTS_SATOSHIS = 1_000_000n;
/** 费率：两笔交易都用同一 sat/KB 预算，避免展示与实际不是同一个口径。 */
export const FORUM_FEE_RATE_SATOSHIS_PER_KB = 1;

/**
 * P2PKH 侧的专用资金编号。
 *
 * Forum 自己的记录按 taskId 存放，P2PKH 的记录按 fundingId。两侧必须用同一个编号
 * 派生规则，否则 P2PKH 核对时找不到自己那份记录，复用路径就等于没核对。
 */
export const FORUM_FUNDING_ID = (taskId: string): string => `forum:${taskId}`;

export interface CreateForumFundingSourceDeps {
  protocolSpend(): ProtocolSpendService | undefined;
  /** 专用资金能力：选币、资金准备交易、找零与保护登记都在 P2PKH 内完成。 */
  funding(): ProtocolFundingService | undefined;
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

  /**
   * 复用已有资金前先让 P2PKH 核对。
   *
   * Forum 自己存了一份记录，但只有 P2PKH 知道：这条 UTXO 是否已被花费、它的保护
   * 登记是否还在（保护是内存态，重启后为空）。绕开这一步直接返回自己的记录，
   * 会让已花费的 UTXO 被再次当作可用资金，也会漏掉保护恢复。
   *
   * P2PKH 能力缺席时按 fail closed 处理：不返回记录，让调用方走正常准备流程，
   * 而不是拿一条未经核对的状态继续构造交易。
   */
  const reconcileWithWallet = async (
    record: ForumFundingRecord,
    input: { ownerPublicKeyHex: string; network: BsvNetwork; taskId: string; requiredSatoshis?: string },
  ): Promise<boolean> => {
    const funding = deps.funding();
    if (funding?.reconcileDedicatedFunding === undefined) return false;
    try {
      const outcome = await funding.reconcileDedicatedFunding({
        ownerPublicKeyHex: input.ownerPublicKeyHex,
        network: input.network,
        // 两侧必须用同一个编号，否则 P2PKH 找不到自己那份记录。
        fundingId: record.fundingId ?? FORUM_FUNDING_ID(input.taskId),
        txid: record.txid,
        vout: record.vout,
        requiredSatoshis: input.requiredSatoshis ?? record.valueSatoshis,
      });
      return outcome.usable;
    } catch {
      // 核对失败（记录不可读、owner 不匹配、链上不可用）一律当作不可复用。
      return false;
    }
  };

  return {
    /**
     * 按本次报价算专用资金额度与资金准备矿工费。
     *
     * 额度只由「协议固定输出 + 用户确认的矿工费预算」决定：拆出一笔固定上界的
     * 资金会让余额差在下一次发布时变成矿工费，也会让费用确认里显示的额度与
     * 实际花费对不上。
     */
    async planDedicatedFunding(input): Promise<ForumFundingPlan> {
      if (input.fixedOutputsSatoshis < 0n || input.protocolMinerFeeBudgetSatoshis <= 0n) {
        throw new ForumProtocolError("funding-plan", "固定输出与矿工费预算非法，拒绝按猜测的额度准备资金");
      }
      // 只准备所需金额：协议交易没有找零输出，拆多了就等于多付。
      const requiredSatoshis = input.fixedOutputsSatoshis + input.protocolMinerFeeBudgetSatoshis;
      const funding = deps.funding();
      const required = requiredSatoshis.toString();
      const estimated = funding?.estimateFundingMinerFee?.({
        requiredSatoshis: required,
        feeRateSatoshisPerKb: input.feeRateSatoshisPerKb,
      });
      // 与 P2PKH 同源的估算；能力缺席时按同一公式退让，而不是伪造零。
      const fundingMinerFeeSatoshis = estimated === undefined
        ? estimateProtocolFundingMinerFee(requiredSatoshis, input.feeRateSatoshisPerKb)
        : parseAmount(estimated, "资金准备矿工费估算");
      return { requiredSatoshis, fundingMinerFeeSatoshis };
    },

    async readDedicatedFunding(ownerPublicKeyHex, network, taskId, requiredSatoshis): Promise<ForumFundingRecord | undefined> {
      const record = await deps.repository.readDedicatedFunding(taskId);
      if (record === undefined) return undefined;
      // 记录属于别的 owner 时不可复用：恢复时不能用旧身份的专用资金。
      if (record.ownerPublicKeyHex !== undefined && record.ownerPublicKeyHex !== ownerPublicKeyHex.toLowerCase()) {
        return undefined;
      }
      const usable = await reconcileWithWallet(record, {
        ownerPublicKeyHex,
        network,
        taskId,
        requiredSatoshis: requiredSatoshis.toString(),
      });
      // 额度不够也算不可复用：同一个 fundingId 复用旧 UTXO 只会反复得到
      // funding-insufficient，必须让调用方按新额度重新准备。
      return usable ? record : undefined;
    },

    async observeFunding(input: { ownerPublicKeyHex: string; network: BsvNetwork; taskId: string; txid: string; vout: number }): Promise<string> {
      const funding = deps.funding();
      if (funding === undefined) return "unknown";
      const record = await deps.repository.readDedicatedFunding(input.taskId);
      return funding.observeDedicatedFunding({
        ownerPublicKeyHex: input.ownerPublicKeyHex,
        network: input.network,
        fundingId: record?.fundingId ?? FORUM_FUNDING_ID(input.taskId),
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
        fundingId: FORUM_FUNDING_ID(input.taskId),
        requiredSatoshis: input.requiredSatoshis.toString(),
        feeRateSatoshisPerKb: 1,
        ownerPluginId: "forum",
        protectionReason: `Forum 发布任务 ${input.taskId} 的专用资金`,
      });
      // 记录归属 owner：恢复时不能用旧身份的专用资金。
      await deps.repository.writeDedicatedFunding(input.taskId, {
        ...prepared,
        ownerPublicKeyHex: input.ownerPublicKeyHex.toLowerCase(),
      });
      return prepared;
    },

    /**
     * 显式回收专用资金。
     *
     * 三件事的顺序不能换：
     *   1. **先读 Forum 记录拿到真正的 fundingId**。钱包侧按 `forum:<taskId>` 或其
     *      后继编号存放记录；直接传裸 taskId 会去回收一个不存在的编号。
     *   2. **再让钱包侧回收**（那里才有链上观察与受控签名）。它缺席或拒绝时不碰
     *      两侧记录——提前删掉 Forum 记录会让「已回收」变成一句无法对账的说法。
     *   3. **最后才清 Forum 侧的记录**。保护由钱包侧按 fundingId 登记，Forum 不去
     *      注销它——注销一个本模块没登记过的 id 在真实注册表里会抛错。
     */
    async recoverDedicatedFunding(input) {
      const funding = deps.funding();
      if (funding?.recoverDedicatedFunding === undefined) {
        throw new Error("当前资金能力不支持显式回收");
      }
      const ownerPublicKeyHex = input.ownerPublicKeyHex.toLowerCase();
      const record = await deps.repository.readDedicatedFunding(input.taskId);
      const fundingId = record?.fundingId ?? FORUM_FUNDING_ID(input.taskId);
      const outcome = await funding.recoverDedicatedFunding({
        ownerPublicKeyHex,
        network: input.network,
        fundingId,
        feeRateSatoshisPerKb: input.feeRateSatoshisPerKb,
        reason: "supersededBy" in input.reason
          ? { supersededBy: input.reason.supersededBy }
          : { unused: true },
      });
      // 钱包侧确认后才清 Forum 记录：回收失败或结果不明时两侧证据都必须还在。
      await deps.repository.deleteDedicatedFunding(input.taskId);
      return { txid: outcome.txid, recoveredSatoshis: outcome.recoveredSatoshis };
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

/** 规范十进制 uint64 解析；非规范金额直接拒绝，不做隐式转换。 */
function parseAmount(value: string, label: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) throw new ForumProtocolError("amount", `${label} 必须是规范十进制 uint64`);
  const parsed = BigInt(value);
  if (parsed > 0xffffffffffffffffn) throw new ForumProtocolError("amount", `${label} 超过 uint64 上限`);
  return parsed;
}
