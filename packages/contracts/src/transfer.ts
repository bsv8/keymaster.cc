// packages/contracts/src/transfer.ts
// Transfer 硬切换协议。
// 设计缘由：转账平台不解释具体资产（UTXO、地址、金额、矿工费、签名）。
// Transfer 只列 provider 暴露的 Transfer Offer；选中后挂载 provider 提供的
// 完整 Transfer Widget，由 Widget 内部完成输入/预览/签名/广播。
//
// 删除旧 TransferContext/TransferDraft/SignedTransfer 是因为这些字段是
// coin/P2PKH 专属语义；保留会让平台继续承担 P2PKH 表单职责。

import type { ComponentType } from "react";
import type { I18nText } from "./i18n.js";

/** 转账资产状态。 */
export type TransferOfferStatus = "ready" | "syncing" | "stale" | "failed" | "unsupported";

/** 转账余额（按 provider 语义；coin 类型通常是 satoshis）。 */
export interface TransferOfferBalance {
  amount: number;
  unit: string;
  display?: string;
}

/**
 * Transfer Offer：provider 暴露的"可转移资产"。
 * 设计缘由：同一 provider 可以暴露多个资产（bsv / bsvtest），Offer
 * 把资产与 provider 绑定后挂在列表上，避免平台再按 id 硬编码分支。
 */
export interface TransferOffer {
  /** offer 唯一 id，由 provider 自行生成。 */
  id: string;
  /** provider id。 */
  providerId: string;
  /** provider 内的 assetId；Transfer 平台不解释。 */
  assetProviderId: string;
  /** 资产 id。 */
  assetId: string;
  /**
   * 展示名。硬切换后为 I18nText；provider 自身翻译资产展示名。
   */
  label: I18nText;
  /** 描述。 */
  description?: I18nText;
  /** 当前余额（可选）。 */
  balance?: TransferOfferBalance;
  /** 状态。 */
  status: TransferOfferStatus;
  /** 平台排序：越小越靠前。 */
  order?: number;
}

/** Transfer Widget props：平台选中 offer 后挂载的组件入参。 */
export interface TransferWidgetProps {
  offer: TransferOffer;
  onCompleted(result: TransferCompletion): void;
}

/** 提交后结果。 */
export interface TransferCompletion {
  offerId: string;
  providerId: string;
  assetProviderId: string;
  assetId: string;
  /** 可选引用：例如 txid；平台不假设所有资产都有。 */
  reference?: string;
  completedAt: string;
  /** 诊断/展示用，平台不解释内容。 */
  details?: Record<string, unknown>;
}

/** Transfer Provider 契约。 */
export interface TransferProvider {
  id: string;
  /**
   * 展示名。硬切换后为 I18nText。
   */
  name: I18nText;
  /** 描述。 */
  description?: I18nText;
  order?: number;
  /** 渲染 provider 的完整转移 Widget。 */
  component: ComponentType<TransferWidgetProps>;
  /** 列出 provider 当前可转移的 Offer。 */
  listOffers(): Promise<TransferOffer[]>;
  /** 余额/状态变化时通知平台刷新。 */
  onChange(handler: () => void): () => void;
}

/** Transfer Registry 接口。 */
export interface TransferRegistry {
  register(provider: TransferProvider): void;
  list(): TransferProvider[];
  get(id: string): TransferProvider | undefined;
}
