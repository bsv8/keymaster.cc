// packages/contracts/src/woc.ts
// WOC 跨包契约。
// 设计缘由：所有 WOC 请求必须经过 woc.service。响应类型与请求优先级都是
// 跨包协议，因此只放类型与最小方法签名，不包含 P2PKH 业务类型。

import { defineCapability } from "webloom-framework";
import type { BsvNetwork } from "./vault.js";

/** WOC 观察状态。 */
export type WocObservation = "unconfirmed" | "confirmed";

/** WOC 请求优先级：值越大越优先。 */
export const WOC_PRIORITY = {
  broadcast: 100,
  interactive: 80,
  foreground: 60,
  background: 40,
  backfill: 20
} as const;

export type WocRequestPriority = keyof typeof WOC_PRIORITY;

/** WOC 基础配置。 */
export interface WocConfig {
  /** 网络路径之前的根 URL，例如 "https://api.whatsonchain.com/v1/bsv"。 */
  baseUrl: string;
  /** 每秒允许请求数，默认 3。 */
  requestsPerSecond: number;
}

/** WOC 队列快照。 */
export interface WocQueueSnapshot {
  /** 排队中请求数。 */
  queued: number;
  /** 正在飞行中的请求数。 */
  inFlight: number;
  /** 全局 backoff 解除时间（epoch ms）。 */
  backoffUntil?: number;
  /** 最近一次错误。 */
  lastError?: string;
  /**
   * 跨标签页强协调是否生效。
   *  - true：当前环境有 Web Locks（FIFO 互斥），全应用级限流严格成立。
   *  - false：当前环境没有 Web Locks（node 环境、旧浏览器、被禁用等）;
   *    限流只在单 tab 内严格,多 tab 各自占满 1000ms 配额,短期总速率
   *    可能超出配置值。UI 应据此提示用户"只开一个钱包标签页或换支持
   *    Web Locks 的浏览器"。
   *
   * 设计缘由：旧契约把 BroadcastChannel fallback 也算作 coordinated=true,
   * 但 BroadcastChannel + 本地推断的互斥协议在并发启动时会分裂——多
   * tab 同时自任 holder 的情况无法在协议层规避。此处只承认有 Web Locks
   * 时的强协调,避免给上层假象。
   */
  coordinated: boolean;
}

/** 公共请求选项。 */
export interface WocRequestOptions {
  /** 优先级；缺省 background。 */
  priority?: WocRequestPriority;
  /** 取消信号。 */
  signal?: AbortSignal;
  /** 额外超时毫秒（缺省由 service 决定）。 */
  timeoutMs?: number;
}

/** 余额响应。 */
export interface WocBalanceResponse {
  confirmed: number;
  unconfirmed: number;
}

/**
 * UTXO 响应（`unspent/all` 单请求归一化结果）。
 *
 * 字段语义（中文说明）：
 *   - txid：交易 ID（canonical，小写 hex）；
 *   - vout：输出序号；
 *   - value：聪数量；
 *   - height：区块高度；未确认时为 0；
 *   - status：confirmed（已确认）或 unconfirmed（未确认）；
 *   - isSpentInMempoolTx：是否已被内存池交易花费；true 的输出不可花费；
 *   - script：锁定脚本（Provider 提供时）。
 */
export interface WocUtxoResponse {
  txid: string;
  vout: number;
  value: number;
  height: number;
  status: WocObservation;
  isSpentInMempoolTx: boolean;
  script?: string;
  canonicalTxid?: string;
  network?: BsvNetwork;
}

/** 历史分页响应。 */
export interface WocHistoryPage {
  items: Array<{ txid: string; height: number; fee?: number; observation?: WocObservation; canonicalTxid?: string; network?: BsvNetwork }>;
  nextPageToken?: string;
}

/** 未确认历史响应。 */
export interface WocUnconfirmedHistory {
  items: Array<{ txid: string; fee?: number; observation?: WocObservation; canonicalTxid?: string; network?: BsvNetwork }>;
}

/**
 * 交易级观察结果。
 *
 * 语义：
 *   - `observation === "confirmed"`：WOC 已返回 confirmed transaction 真值；
 *   - `observation === "unconfirmed"`：confirmed 真值不存在，但 propagation
 *     / mempool 真值存在；
 *   - `observation === undefined`：confirmed / unconfirmed 真值都不存在。
 *
 * 这不是 holdings snapshot。消费方不得据当前持仓推断此值。
 */
export interface WocTransactionObservation {
  canonicalTxid: string;
  observation?: WocObservation;
}

/** 指定 outpoint 的花费交易；null 表示节点明确返回尚未花费。 */
export interface WocSpentOutput {
  /** 花费交易 canonical txid。 */
  txid: string;
  /** 花费交易中引用该 outpoint 的输入索引。 */
  vin: number;
  /** 花费交易是否已确认。 */
  status: "confirmed" | "unconfirmed";
}

/**
 * 广播结果。
 *
 * 关键不变量（消费方必须遵守）：
 *   - `accepted: true` 仅表示 provider（Whatsonchain）接受了 broadcast
 *     请求并返回 2xx，并不等于链上最终确认。是否进入 mempool、是否被打包、
 *     是否被重组，仍以 WOC recent-sync / history-backfill 观察到的链上
 *     真值为准。
 *   - `canonicalTxid` 是上层业务唯一应消费的 txid；上层不应再自行 reverse
 *     或 normalize provider 原始回执，所有字节序归一化已由 `plugin-woc`
 *     在此层完成。
 *   - `providerReturnedTxidRaw` / `providerReturnedTxidNormalized` 仅用于
 *     诊断（例如日志、provider-inconsistent 状态展示），禁止作为业务真值。
 *   - `txidIntegrity` 描述 provider 回执与本地 canonical txid 的关系：
 *       - "exact"     ：provider 原值与 canonical 完全一致
 *       - "reversed"  ：provider 原值与 canonical 字节序相反，但规范化后一致
 *       - "mismatch"  ：provider 原值规范化后仍与 canonical 不一致；
 *                       业务层应进入 provider-inconsistent / unknown，
 *                       仍写本地 input claim，等待链上真值收敛
 *       - "missing"   ：provider 未返回 txid 字段
 */
export interface WocBroadcastResult {
  accepted: true;
  canonicalTxid: string;
  providerReturnedTxidRaw?: string;
  providerReturnedTxidNormalized?: string;
  txidIntegrity: "exact" | "reversed" | "mismatch" | "missing";
}

/**
 * WOC service 契约。
 * 设计缘由：业务插件只看到这些类型化方法；URL 拼接、超时、限流、429 backoff、
 * 多标签页协调由 plugin-woc 内部负责。多标签页协调仅在 Web Locks 可用时
 * 是强保证；不可用时降级为单 tab 限流（snapshot.coordinated=false 提示）。
 */
/** WOC 只读服务；插件可见能力不包含广播出口。 */
export interface WocService {
  getConfig(): WocConfig;
  updateConfig(input: Partial<WocConfig>): WocConfig;
  onConfigChange(handler: (config: WocConfig) => void): () => void;
  getQueueSnapshot(): WocQueueSnapshot;
  onQueueChange(handler: (snapshot: WocQueueSnapshot) => void): () => void;

  getAddressConfirmedBalance(
    network: BsvNetwork,
    address: string,
    options?: WocRequestOptions
  ): Promise<WocBalanceResponse>;

  getAddressUnconfirmedBalance(
    network: BsvNetwork,
    address: string,
    options?: WocRequestOptions
  ): Promise<WocBalanceResponse>;

  /**
   * 单次请求返回地址的全部未花费输出（confirmed + unconfirmed + mempool 标记）。
   *
   * 设计缘由：P2PKH 的 UTXO 真值只有这一个来源；不再分别请求
   * `confirmed/unspent` 与 `unconfirmed/unspent` 再在业务层合并。
   * Provider 返回的 `status` 与 `isSpentInMempoolTx` 必须保留，不能在这里
   * 猜测或丢掉。
   */
  getAddressUnspentAll(
    network: BsvNetwork,
    address: string,
    options?: WocRequestOptions
  ): Promise<WocUtxoResponse[]>;

  getAddressesConfirmedBalances(
    network: BsvNetwork,
    addresses: string[],
    options?: WocRequestOptions
  ): Promise<WocBalanceResponse[]>;

  getAddressesUnconfirmedBalances(
    network: BsvNetwork,
    addresses: string[],
    options?: WocRequestOptions
  ): Promise<WocBalanceResponse[]>;

  listAddressConfirmedHistory(
    network: BsvNetwork,
    address: string,
    page: { limit?: number; page?: number; nextPageToken?: string } | undefined,
    options?: WocRequestOptions
  ): Promise<WocHistoryPage>;

  listAddressUnconfirmedHistory(
    network: BsvNetwork,
    address: string,
    options?: WocRequestOptions
  ): Promise<WocUnconfirmedHistory>;

  listAddressesHistory(
    network: BsvNetwork,
    addresses: string[],
    page: { limit?: number; page?: number; nextPageToken?: string } | undefined,
    options?: WocRequestOptions
  ): Promise<WocHistoryPage>;

  /** 交易级 observation：按 network + canonicalTxid 查询 confirmed / unconfirmed / undefined。 */
  getTransactionObservation(
    network: BsvNetwork,
    canonicalTxid: string,
    options?: WocRequestOptions
  ): Promise<WocTransactionObservation>;

  /** 读取节点当前最佳链高度；用于高度锁，不得由本地时钟估算。 */
  getChainHeight(
    network: BsvNetwork,
    options?: WocRequestOptions
  ): Promise<number>;

  /** 查询指定 outpoint 的 confirmed/unconfirmed spender。 */
  getSpentOutput(
    network: BsvNetwork,
    txid: string,
    vout: number,
    options?: WocRequestOptions
  ): Promise<WocSpentOutput | null>;

  /** Confirmed raw transaction bytes for provider adapters. */
  getRawTransaction?(
    network: BsvNetwork,
    txid: string,
    options?: WocRequestOptions
  ): Promise<string>;

}

/** Worker/装配层内部的 WOC 广播扩展，不通过 WOC_CAPABILITY 暴露给插件。 */
export interface WocWorkerBroadcastService {
  /** 广播：内部强制 broadcast 优先级，调用方不能降级。 */
  broadcast(
    network: BsvNetwork,
    rawTxHex: string,
    options?: Omit<WocRequestOptions, "priority">
  ): Promise<WocBroadcastResult>;
}

/** createWocService 返回的完整内部句柄；仅 Worker/装配层使用扩展方法。 */
export type WocServiceHandle = WocService & WocWorkerBroadcastService;

/** WOC capability key。 */
export const WOC_CAPABILITY = defineCapability<WocService>({
  kind: "local",
  id: "woc.service",
  version: "1",
});
