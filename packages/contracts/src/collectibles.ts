// packages/contracts/src/collectibles.ts
// 不可拆分藏品（NFT）公共契约。
//
// 设计缘由：
//   - collectible 围绕"单件对象"展开（preview / media / collection / owner
//     ref / attributes），与 fungible token 的"余额/数量"语义完全不同。
//     因此 collectible 不允许塞进 token.registry / asset.registry。
//   - preview / contentType / collection / ownerRef 是一级字段，不下放到
//     extras：通用详情页（plugin-collectibles）依赖这些字段工作，不能
//     要求每个 provider 都自带专属详情页。
//   - 通用详情页在 provider 没声明 detailRoute 的情况下必须仍可工作，
//     因此平台需要的字段都集中在 CollectibleDetail 的固定字段上。

import type { I18nText } from "./i18n.js";

/** collectible 状态。 */
export type CollectibleStatus = "ready" | "syncing" | "stale" | "failed" | "unsupported";

/** 预览内容：媒体或文本退化。 */
export interface CollectiblePreview {
  /** 媒体 URL（http(s) / data: / ipfs: / 自定义 scheme）。 */
  url?: string;
  /** mime；例如 "image/png" / "image/svg+xml" / "text/plain"。 */
  contentType?: string;
  /** 文本退化：没有 url 时显示。 */
  text?: string;
}

/** 列表使用的最小摘要：collectible 围绕单件对象，不允许出现 balance。 */
export interface CollectibleSummary {
  /** provider 内唯一的 collectible id。 */
  collectibleId: string;
  /** provider id；等于 CollectibleProvider.id。 */
  providerId: string;
  /** 展示名。链上 inscription name 应保持 string 不翻译。 */
  name: string | I18nText;
  /** collection 名（可选）。 */
  collection?: string;
  /** owner 引用（可选）：BSV 地址 / xpub / provider 自解释字段。 */
  ownerRef?: string;
  /** 预览。 */
  preview?: CollectiblePreview;
  /** 状态。 */
  status: CollectibleStatus;
  /** provider 声明的详情入口；缺省时由平台通用详情页接管。 */
  detailRoute?: { id?: string; path?: string };
  /** 次要展示字段。 */
  tags?: string[];
}

/** 属性表项。 */
export interface CollectibleAttribute {
  key: string;
  value: string;
}

/** collectible 活动。 */
export interface CollectibleActivity {
  id: string;
  collectibleId: string;
  txid?: string;
  title: I18nText;
  direction?: "in" | "out" | "self" | "info";
  status?: "confirmed" | "unconfirmed" | "pending" | "failed";
  occurredAt?: string;
}

/** collectible 详情。 */
export interface CollectibleDetail {
  summary: CollectibleSummary;
  /** 详情页预览。 */
  preview?: CollectiblePreview;
  /** 属性表（链上 attributes / 链下 metadata）。 */
  attributes?: CollectibleAttribute[];
  /** 活动列表。 */
  activities?: CollectibleActivity[];
  /**
   * provider 自解释字段：例如 1Sat outpoint / inscription id / content
   * length 等。详情页把 extras 内的字段按"可解释 key"展示。
   */
  extras?: Record<string, unknown>;
}

/** collectible provider 契约。 */
export interface CollectibleProvider {
  id: string;
  name: I18nText;
  order?: number;
  listCollectibles(): Promise<CollectibleSummary[]>;
  getCollectible(collectibleId: string): Promise<CollectibleDetail | undefined>;
  listActivity(collectibleId: string): Promise<CollectibleActivity[]>;
  sync(collectibleId?: string): Promise<void>;
  onChange(handler: () => void): () => void;
}

/** collectible provider 注册表。 */
export interface CollectibleRegistry {
  register(provider: CollectibleProvider): void;
  unregister(id: string): void;
  list(): CollectibleProvider[];
  get(id: string): CollectibleProvider | undefined;
  _ids(): string[];
}