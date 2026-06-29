// packages/contracts/src/wocTokens.ts
// BSV-21 / STAS / 1Sat Ordinals 的 WOC capability 公共契约。
//
// 设计缘由：
//   - "WOC 唯一外网入口"不变量在 README 已经写死。所有 BSV token /
//     collectible 的 WOC 查询必须经过本文件的 capability。
//   - 三套 capability 由 plugin-woc 提供；业务插件（plugin-token-bsv21 /
//     plugin-token-stas / plugin-collectible-1satordinals）禁止越过本
//     capability 直接 fetch WOC URL。
//   - 三套 capability 共享 plugin-woc 内部的 actor 限流 / 优先级 / 429
//     backoff / 多标签页协调，不复制第二套限流队列。
//   - 阶段 1 仅暴露"最小查询面"：list / balance / single-outpoint 查
//     1Sat inscription；不暴露 raw fetch / URL 拼接 / 私有 endpoint。
//   - WOC 当前文档没有"按地址列出 1Sat 持仓"的统一入口，因此
//     1Sat capability 仅提供"按 outpoint 查 inscription"；按地址聚合
//     由业务插件（plugin-collectible-1satordinals）拿当前 active key
//     的未花费 UTXO 集合逐个 outpoint 反查完成。
//
// outpoint 格式（关键不变量）：
//   - WOC 1Sat endpoint 使用的 outpoint 字符串格式是 "txid_vout"（下划线
//     连接 txid 与 vout），不是 "txid:vout"。本文件把这一约束写在契约
//     注释里，plugin-woc 与所有调用方按此格式构造 / 解析 outpoint。
//   - 业务插件（plugin-collectible-1satordinals）拿到的 P2PKH UTXO 形如
//     { txid, vout }；调用 1Sat capability 时必须自己拼成 "txid_vout"。
//   - collectibleId 仍以 "txid:vout" 形式暴露给用户（更可读）；向 WOC
//     发起查询时由 provider 内部翻译为 "txid_vout"。

import type { BsvNetwork } from "./vault.js";
import type { WocRequestOptions } from "./woc.js";

/** BSV-21 capability key。 */
export const WOC_BSV21_CAPABILITY = "woc.bsv21.service";
/** STAS capability key。 */
export const WOC_STAS_CAPABILITY = "woc.stas.service";
/** 1Sat Ordinals capability key。 */
export const WOC_1SAT_ORDINALS_CAPABILITY = "woc.1satordinals.service";

/** 把 P2PKH 内部 txid+vout 翻译为 WOC 1Sat 期望的 outpoint 字符串。 */
export function toWocOutpoint(txid: string, vout: number): string {
  return `${txid}_${vout}`;
}

/** BSV-21 token 元数据。 */
export interface WocBsv21TokenMeta {
  /** token 创世 txid。 */
  origin: string;
  symbol?: string;
  decimals?: number;
  issuer?: string;
}

/** BSV-21 余额响应。 */
export interface WocBsv21BalanceResponse {
  confirmed: number;
  unconfirmed: number;
}

/** BSV-21 service。 */
export interface WocBsv21Service {
  /**
   * 列出某 BSV 地址持有的 BSV-21 token 元数据。
   * 阶段 1 由 plugin-woc 调 WOC 公开 endpoint 翻译；返回空列表
   * 表示该地址没有 BSV-21 token。
   */
  listAddressTokens(
    network: BsvNetwork,
    address: string,
    options?: WocRequestOptions
  ): Promise<WocBsv21TokenMeta[]>;
  /** 查询单个 token 在某地址的余额。 */
  getAddressTokenBalance(
    network: BsvNetwork,
    address: string,
    origin: string,
    options?: WocRequestOptions
  ): Promise<WocBsv21BalanceResponse>;
}

/** STAS token entry。 */
export interface WocStasTokenEntry {
  symbol: string;
  issuer?: string;
  /** provider-defined unit 下的余额。 */
  balance: number;
}

/** STAS service。 */
export interface WocStasService {
  /** 列出某 BSV 地址持有的 STAS token。 */
  listAddressTokens(
    network: BsvNetwork,
    address: string,
    options?: WocRequestOptions
  ): Promise<WocStasTokenEntry[]>;
}

/** 1Sat Ordinals inscription 元数据。 */
export interface Woc1SatOrdinalsInscription {
  inscriptionId: string;
  /** 1Sat endpoint 使用的 outpoint 字符串格式："txid_vout"。 */
  outpoint: string;
  /** 内容 origin（URL / text preview）。 */
  origin?: string;
  /** 内容 mime。 */
  contentType?: string;
  /** 预览 URL 或简短 text。 */
  preview?: string;
  /** 当前 owner 地址（BSV）。 */
  owner?: string;
}

/** 1Sat Ordinals service。 */
export interface Woc1SatOrdinalsService {
  /**
   * 按 outpoint 查 inscription。
   * - 命中：返回 inscription；
   * - 404 / not-found：返回 null；
   * - 其它错误：抛错由调用方决定如何处理。
   *
   * 注意：返回 null 不应被业务插件记成 provider 错误；404 在阶段 1
   * 是合法结果（"这个 outpoint 不是 1Sat collectible"）。
   *
   * outpoint 必须是 WOC 期望的 "txid_vout" 字符串；契约层用
   * `toWocOutpoint(txid, vout)` 构造。
   */
  getOutpointInscription(
    network: BsvNetwork,
    outpoint: string,
    options?: WocRequestOptions
  ): Promise<Woc1SatOrdinalsInscription | null>;
}