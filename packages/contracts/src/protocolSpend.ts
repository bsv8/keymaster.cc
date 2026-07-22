// 协议 spend 契约。
//
// 设计缘由：
//   - 协议插件需要的是“受控签名 + 广播 + txid 归一化”，不是 P2PKH
//     固化表单。
//   - 这里把输入/输出计划抽成最小公共协议，供 BSV-21 / 1Sat Ordinals
//     等插件复用。

import type { BsvNetwork } from "./vault.js";

export const P2PKH_PROTOCOL_SPEND_CAPABILITY = "p2pkh.protocol-spend";

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
}

export interface ProtocolSpendResult {
  status: "broadcast" | "rejected" | "unknown" | "provider-inconsistent";
  txid: string;
  rawTxHex: string;
  inputClaimIds?: string[];
  submissionId?: string;
  canonicalTxid?: string;
  providerReturnedTxidRaw?: string;
  providerReturnedTxidNormalized?: string;
  txidIntegrity?: "exact" | "reversed" | "mismatch" | "missing";
  error?: string;
}

export interface ProtocolSpendService {
  prepare(input: ProtocolSpendPrepareInput): Promise<ProtocolSpendPreview>;
  submit(preview: ProtocolSpendPreview): Promise<ProtocolSpendResult>;
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
