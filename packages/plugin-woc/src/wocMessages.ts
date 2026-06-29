// packages/plugin-woc/src/wocMessages.ts
// WOC 消息类型常量与 payload 契约。
//
// 设计缘由：
//   - WOC actor mailbox 通过统一的 MessageBus 接收请求；type 字符串
//     作为 message 标识；payload 由 handler 解读。
//   - 业务插件仍走 woc.service，不直接发 woc.* 消息；本文件只供
//     wocService / wocActor 内部使用。
//   - payload 与 WocService 公开方法签名保持一致——network / address
//     / options / rawTxHex 等。
//   - 优先级：通过 message envelope 的 priority 字段表达，handler 内部
//     翻译为 WOC_PRIORITY 数值。

import type { BsvNetwork } from "@keymaster/contracts";
import type { WocRequestPriority } from "@keymaster/contracts";

/** WOC actor mailbox target。 */
export const WOC_ACTOR_TARGET = "woc";

/**
 * MessageBus 向 WOC 内部 mailbox 投递的并发上限。
 * 注意：这不是 WOC 网络请求并发，也不是每秒请求数；
 * WOC actor 内部 priority queue + sliding window rate limit 负责真正限流。
 * 提高此值让 MessageBus 不会因串行投递而阻断 WOC 的优先级插队（如 broadcast）。
 *
 * 必须小于等于 MessageBus 允许的 MAX_HANDLER_CONCURRENCY（runtime 内部
 * 常量，当前 128），否则 handle() 注册会抛 "Handler concurrency must not
 * exceed 128"。本常量与 runtime 解耦——跨包不直接 import runtime 常量，
 * 由测试保证 32 能注册。
 */
export const WOC_ACTOR_ACCEPT_CONCURRENCY = 32;

/** 消息 type 常量（与 WocService 方法一一对应）。 */
export const WOC_MSG = {
  BALANCE_CONFIRMED: "woc.balance.confirmed",
  BALANCE_UNCONFIRMED: "woc.balance.unconfirmed",
  UTXOS_CONFIRMED: "woc.utxos.confirmed",
  UTXOS_UNCONFIRMED: "woc.utxos.unconfirmed",
  HISTORY_CONFIRMED: "woc.history.confirmed",
  HISTORY_UNCONFIRMED: "woc.history.unconfirmed",
  TX_BROADCAST: "woc.tx.broadcast",
  // token / collectible 协议查询：与上面 coin 类 endpoint 共享 actor 的
  // priority queue / 限流 / 429 backoff / 多标签页协调。
  BSV21_LIST_TOKENS: "woc.bsv21.listTokens",
  BSV21_TOKEN_BALANCE: "woc.bsv21.tokenBalance",
  STAS_LIST_TOKENS: "woc.stas.listTokens",
  ONE_SAT_OUTPOINT: "woc.1satordinals.outpoint"
} as const;

export type WocMessageType = (typeof WOC_MSG)[keyof typeof WOC_MSG];

export interface WocActorPayload {
  network: BsvNetwork;
  priority: WocRequestPriority;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface WocBalancePayload extends WocActorPayload {
  address: string;
}

export interface WocUtxosPayload extends WocActorPayload {
  address: string;
}

export interface WocHistoryPayload extends WocActorPayload {
  address: string;
  page?: { limit?: number; page?: number; nextPageToken?: string };
}

export interface WocBroadcastPayload {
  network: BsvNetwork;
  rawTxHex: string;
  /** broadcast 内部强制 broadcast 优先级，调用方不可降级。 */
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** BSV-21：列地址持有的 token。 */
export interface WocBsv21ListTokensPayload extends WocActorPayload {
  address: string;
}

/** BSV-21：查单个 origin token 在某地址的余额。 */
export interface WocBsv21TokenBalancePayload extends WocActorPayload {
  address: string;
  origin: string;
}

/** STAS：列地址持有的 token。 */
export interface WocStasListTokensPayload extends WocActorPayload {
  address: string;
}

/** 1Sat Ordinals：按 outpoint 查 inscription。 */
export interface Woc1SatOutpointPayload extends WocActorPayload {
  outpoint: string;
}
