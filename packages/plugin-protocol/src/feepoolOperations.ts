// packages/plugin-protocol/src/feepoolOperations.ts
// feepool pending operation 内存模型。
//
// 设计缘由（V4 收口）：feepool 真实模型是"两笔 tx + 持续协商的 B-Tx 草稿"。
//   - A-Tx（base tx，建池时定）：client P2PKH UTXO → 2-of-2 multisig output。
//   - B-Tx（spend 草稿）：multisig output → server + client change。
//     持续协商的草稿。create / close_and_recreate 的新池分支 → 初始版；
//     spend / close_and_recreate 的 close 之前 → 更新版。
//   - `pending op` 在 prepare 时落内存，commit 时消费，endSession 时清空。
//   - `pending op` **不**进 IndexedDB（operationId 故意只活本会话）。
//   - 真实签名由 `keymaster-multisig-pool` SDK 完成；本文件只做模型。

import type { ProtocolFeePoolAction, ProtocolFeePoolRecord } from "@keymaster/contracts";

/**
 * feepool prepare 落地、commit 消费的内存 op。
 *
 * 关键不变量（V4）：
 *   - `draftSpendTxHex` / `draftClientSignBytes`：当前 B-Tx 草稿（含
 *     server 的 update sig 等价的 client 初始签）。三种 action 都有。
 *     不是已广播的最终 tx；是 site 与 server 持续协商的对象。
 *   - `nextServerAmount` = `prior.serverAmount + amountSatoshis`（或
 *     create 时 = `amountSatoshis`）。这是 commit 落库后该池累计分配额。
 *   - `close_and_recreate` 的 close 部分：把 `prior.draftSpendTxHex` 切到
 *     `FINAL_LOCKTIME` 最终版本，得到 `closeDraftTxHex` / `closeClientSignBytes`。
 *     之后才建新池（A-Tx + 初始 B-Tx 草稿）。
 */
export interface FeepoolPendingOp {
  /** 内部稳定 op id（与 prepare 返回的 operationId 一致）。 */
  operationId: string;
  /** prepare 时的 exact origin；commit 时按这个做 origin 一致性检查。 */
  origin: string;
  /** prepare 时的对端公钥 hex。 */
  counterpartyPublicKeyHex: string;
  /** 三种 action 之一。 */
  action: ProtocolFeePoolAction;
  /** prepare 完成时间（unix ms）；commit 用来诊断 op 过期。 */
  preparedAt: number;
  /** create / close_and_recreate 的新池 A-Tx（base tx）hex。 */
  baseTxHex?: string;
  /** create / close_and_recreate 的新池 multisig output vout index。 */
  baseTxOutputIndex?: number;
  /**
   * 主 B-Tx 草稿（三种 action 都有）。
   * - create：初始版，`serverAmount = amountSatoshis`。
   * - spend：更新版（在 prior draft 上 `loadTx` 改 serverAmount 后）。
   * - close_and_recreate：建新池后**新池**的初始 B-Tx 草稿。
   */
  draftSpendTxHex: string;
  /** 主 B-Tx 草稿上的 client 部分签名（initial / update sig 视 action 而定）。 */
  draftClientSignBytes: Uint8Array;
  /** 池大小（= base tx multisig output 总额；commit 验签用）。 */
  draftTotalAmount: number;
  /**
   * 本次 transfer 的 delta（site 请求的 `params.amountSatoshis`）。
   * 不直接是 transfer 后的累计 serverAmount（那是 `nextServerAmount`）。
   */
  amountSatoshis: number;
  /**
   * 期望落地后的累计 serverAmount：
   *   - create：`= amountSatoshis`（从 0 开始累计）。
   *   - spend：`= prior.serverAmount + amountSatoshis`（在 prior 基础上累加）。
   *   - close_and_recreate 的新池分支：`= amountSatoshis`（新池从 0 重新累计）。
   */
  nextServerAmount: number;
  /**
   * close_and_recreate 的 close 部分（旧草稿切到 FINAL_LOCKTIME 最终版本）。
   */
  closeDraftTxHex?: string;
  closeClientSignBytes?: Uint8Array;
  /** 决策时参考的旧池快照（spend / close_and_recreate 非空；create 为 null）。 */
  priorPool: ProtocolFeePoolRecord | null;
}

export type FeepoolPendingOpsMap = Map<string, FeepoolPendingOp>;
