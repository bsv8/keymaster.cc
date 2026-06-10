// packages/contracts/src/assets.ts
// 资产平台公共契约。
// 设计缘由：把"资产"从 P2PKH 等具体实现中抽离出来。
// 资产平台（plugin-assets）只依赖本文件的协议；具体资产（plugin-p2pkh 等）实现 AssetProvider。
// 禁止在本文件中出现 utxo、script、wif、p2pkh 等具体实现字段。

import type { BsvNetwork } from "./vault.js";
import type { I18nText } from "./i18n.js";

/** 资产类别。 */
export type AssetKind = "coin" | "token" | "collectible" | "contract" | "other";

/** 资产状态：平台层用 status 表达 provider 同步/可用性。 */
export type AssetStatus = "ready" | "syncing" | "stale" | "failed" | "unsupported";

/** 可展示余额：不要求所有资产都有 satoshis 语义。 */
export interface AssetBalance {
  /** 主要展示金额（按 provider 语义：coin 类型通常是 satoshis）。 */
  amount: number;
  /** 单位标识，例如 "sats"、"BSV"、"USD"。 */
  unit: string;
  /** 备用展示文本，例如 "0.1234 BSV"。 */
  display?: string;
}

/** 资产列表使用的最小摘要。 */
export interface AssetSummary {
  /** 资产 id，provider 内唯一。 */
  assetId: string;
  /** 资产所属 provider id，等于 AssetProvider.id。 */
  providerId: string;
  /** 资产类别。 */
  kind: AssetKind;
  /**
   * 展示名。硬切换后允许 I18nText。
   * 设计缘由：系统内置资产（BSV、BSV Testnet）可翻译；用户自定义名称、
   * 链上 token name 不应被翻译，保留 string 兼容。
   * provider 自行决定：内置资产传 I18nText；用户/链上资产保持 string。
   */
  label: string | I18nText;
  /** 所属网络（coin 类资产通常有；其他可省略）。 */
  network?: BsvNetwork;
  /** 当前余额。 */
  balance?: AssetBalance;
  /** 状态。 */
  status: AssetStatus;
  /** 详情页入口：provider 自行注册的 route id。 */
  detailRoute?: { id?: string; path?: string };
  /** 次要展示字段，例如地址前缀、合约名。 */
  tags?: string[];
}

/** 资产活动摘要：平台可展示的最小交易/事件视图。 */
export interface AssetActivity {
  /** provider 内唯一的活动 id。 */
  id: string;
  /** 关联的资产 id。 */
  assetId: string;
  /** 交易 txid，可选（部分资产可能没有链上 txid）。 */
  txid?: string;
  /**
   * 活动标题。硬切换后改为 I18nText，状态枚举（发送/接收/铸造/...）走
   * i18n key 映射；具体文案由 provider 的 i18n 资源或 plugin-p2pkh
   * 的 p2pkh.activity.* 提供。
   */
  title: I18nText;
  /** 金额（可选）。 */
  amount?: AssetBalance;
  /** 方向。 */
  direction?: "in" | "out" | "self" | "info";
  /** 状态。 */
  status?: "confirmed" | "unconfirmed" | "pending" | "failed";
  /** 发生时间，ISO 字符串。 */
  occurredAt?: string;
}

/** 资产详情扩展字段：provider 自解释的展示数据。 */
export interface AssetDetail {
  summary: AssetSummary;
  activities?: AssetActivity[];
  /** provider 自由扩展：例如 P2PKH 在这里放余额/同步时间。 */
  extras?: Record<string, unknown>;
}

/** 资产 provider：由具体资产插件（plugin-p2pkh 等）实现。 */
export interface AssetProvider {
  /** provider 唯一 id，使用命名空间，例如 "p2pkh"。 */
  id: string;
  /**
   * 展示名。provider.name 硬切换为 I18nText；系统内置 provider
   * （P2PKH）走 plugin 自身的 i18n 资源。
   */
  name: I18nText;
  /** provider 类别，列表中可分组展示。 */
  kind: AssetKind;
  /** 平台排序：越小越靠前。 */
  order?: number;
  /** 列出该 provider 暴露的资产摘要。 */
  listAssets(): Promise<AssetSummary[]>;
  /** 取单个资产详情。 */
  getAsset(assetId: string): Promise<AssetDetail | undefined>;
  /** 列出该资产的活动。 */
  listActivity(assetId: string): Promise<AssetActivity[]>;
  /** 触发同步：可指定 assetId，不指定时同步该 provider 全部资产。 */
  sync(assetId?: string): Promise<void>;
  /** 订阅资产变化，返回取消订阅函数。 */
  onChange(handler: () => void): () => void;
}

/** 资产 provider 注册表接口。 */
export interface AssetRegistry {
  /** 注册 provider；id 重复抛错。 */
  register(provider: AssetProvider): void;
  /** 列出全部 provider，按 order/name 排序。 */
  list(): AssetProvider[];
  /** 按 id 取 provider。 */
  get(id: string): AssetProvider | undefined;
}
