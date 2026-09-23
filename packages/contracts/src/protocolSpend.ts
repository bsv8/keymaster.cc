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
