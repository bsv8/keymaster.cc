// packages/contracts/src/tokens.ts
// fungible token 公共契约。
//
// 设计缘由：
//   - 把"同质化代币"从 asset / collectible 中彻底抽出。资产平台
//     （plugin-assets）只能通过 token.registry 拿到 token provider，
//     不能让 token 注册进 asset.registry。
//   - 协议字段只描述"持有、余额、状态、详情"，禁止出现 UTXO、script、
//     rawTx、change、fee、wif、p2pkh 等具体实现字段；这些只能下放到
//     具体 token 业务插件（如 plugin-token-bsv21）。
//   - provider 自己决定是否暴露 issuer / decimals / icon / tags；本文件
//     不强制要求。
//   - 平台排序：provider.order 决定 provider 间顺序；同 provider 内的
//     token 排序由 provider 自己 listTokens() 返回的顺序决定，平台不再
//     二次排序以尊重 provider 业务语义（硬切换 008 收尾不变）。

import type { BsvNetwork } from "./vault.js";
import type { I18nText } from "./i18n.js";

/** Token 状态：与 AssetStatus 同形，由 provider 同步/可用性驱动。 */
export type TokenStatus = "ready" | "syncing" | "stale" | "failed" | "unsupported";

/**
 * Token 余额：按 provider 语义。
 * 设计缘由：fungible token 余额的"单位"是 token 自己的最小单位
 * （例如 1e-8 BSV-21），平台层不假设 satoshis 语义，amount + unit
 * 字段足矣；display 由 provider 预格式化。
 */
export interface TokenBalance {
  amount: number;
  unit: string;
  display?: string;
}

/** Token 列表最小摘要。平台只读这一层。 */
export interface TokenSummary {
  /** provider 内唯一的 token id。 */
  tokenId: string;
  /** token provider id；等于 TokenProvider.id。 */
  providerId: string;
  /** token symbol；例如 "BSV-21-XUSD"。provider 自行保证稳定。 */
  symbol: string;
  /**
   * 展示名。内置 token 可走 I18nText；链上 token name 应保持 string 不翻译。
   * provider 自行决定。
   */
  label: string | I18nText;
  /** 所属网络（可选；当前阶段 1 实际都是 BSV main）。 */
  network?: BsvNetwork;
  /** 当前余额。 */
  balance?: TokenBalance;
  /** 状态。 */
  status: TokenStatus;
  /** 详情入口：由 provider 自己声明的 route。 */
  detailRoute?: { id?: string; path?: string };
  /** 发行方（可选；provider 决定是否暴露）。 */
  issuer?: string;
  /** 精度（可选）。 */
  decimals?: number;
  /** 图标 URL 或 data URI（可选）。 */
  icon?: string;
  /** 次要展示字段（可选）。 */
  tags?: string[];
}

/** Token 活动摘要。 */
export interface TokenActivity {
  /** provider 内唯一的活动 id。 */
  id: string;
  /** 关联的 token id。 */
  tokenId: string;
  /** 链上 txid（可选）。 */
  txid?: string;
  /** 标题；状态枚举走 i18n。 */
  title: I18nText;
  /** 金额（可选）。 */
  amount?: TokenBalance;
  /** 方向。 */
  direction?: "in" | "out" | "self" | "info";
  /** 状态。 */
  status?: "confirmed" | "unconfirmed" | "pending" | "failed";
  /** 发生时间（ISO 字符串）。 */
  occurredAt?: string;
}

/** Token 详情扩展。 */
export interface TokenDetail {
  summary: TokenSummary;
  activities?: TokenActivity[];
  /** provider 自由扩展：例如 BSV-21 origin / STAS script hash 等。 */
  extras?: Record<string, unknown>;
}

/** Token provider 契约。 */
export interface TokenProvider {
  /** provider 唯一 id，使用命名空间，例如 "bsv21" / "stas"。 */
  id: string;
  /** 展示名；硬切换为 I18nText。 */
  name: I18nText;
  /** 平台排序：越小越靠前。 */
  order?: number;
  /** 列出该 provider 暴露的 token 摘要。平台不做二次排序。 */
  listTokens(): Promise<TokenSummary[]>;
  /** 取单个 token 详情。 */
  getToken(tokenId: string): Promise<TokenDetail | undefined>;
  /** 列出该 token 的活动。 */
  listActivity(tokenId: string): Promise<TokenActivity[]>;
  /** 触发同步：可指定 tokenId，不指定时同步该 provider 全部。 */
  sync(tokenId?: string): Promise<void>;
  /** 订阅 token 变化。 */
  onChange(handler: () => void): () => void;
}

/** Token provider 注册表。 */
export interface TokenRegistry {
  /** 注册 provider；id 重复抛错。 */
  register(provider: TokenProvider): void;
  /** 注销 provider。id 不存在抛错（owner diff / teardown 路径使用）。 */
  unregister(id: string): void;
  /** 列出全部 provider；按 order / name i18n key 排序。 */
  list(): TokenProvider[];
  /** 按 id 取 provider。 */
  get(id: string): TokenProvider | undefined;
  /** 仅用于 host owner diff 捕获。 */
  _ids(): string[];
}