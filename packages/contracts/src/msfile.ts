// packages/contracts/src/msfile.ts
// MSFile 客户端能力契约；人类可读说明见 docs/MSFile.md。
import { defineCapability } from "webloom-framework";
//
// 设计缘由：
//   - 内部受信任插件消费 `msfile.service` 的 stat/readSeed/readBlock；
//   - 不受信任 Connect App 只能走 `connect` gateway，由 plugin-protocol 用
//     持久 session 快照 + MessageEvent.origin 构造 App context；
//   - Seed/Block 区分只选择金额策略与内容校验规则，不进入 wire；
//   - 金额一律使用规范十进制字符串，只在 Frame codec 边界转成 CBOR uint64，
//     避免 JavaScript number 丢失精度；
//   - 本文件只允许类型、字面量常量与无依赖纯函数。

import type { AppIdentitySnapshot } from "./appIdentity.js";
import type { BinaryField } from "./protocol.js";

/** libp2p protocol ID；wire 真值来自 MSFile Proxy Wire Messages v1。 */
export const MSFILE_PROTOCOL_ID = "/msfile/1.0.0";

/** Frame / 内容硬上限。与 wire 规范一致，两层共同执行。 */
export const MSFILE_MAX_HEADER_BYTES = 65536;
export const MSFILE_MAX_SEED_BYTES = 16 * 1024 * 1024;
export const MSFILE_MAX_BLOCK_BYTES = 256 * 1024;
export const MSFILE_MAX_CONTENT_BYTES = MSFILE_MAX_SEED_BYTES;
export const MSFILE_MAX_ERROR_MESSAGE_BYTES = 1024;
export const MSFILE_BLOCK_SIZE_BYTES = 256 * 1024;
export const MSFILE_DIGEST_SIZE_BYTES = 32;

/**
 * 旧 MSE/转封装播放器的兼容常量。
 *
 * 保留旧后端源码供兼容测试；当前原生 Range
 * 播放器、插件设置页和 Resource Store 均不读取这些字段。
 */
export const MSFILE_MEDIA_PREFETCH_BLOCKS_DEFAULT = 5;
export const MSFILE_MEDIA_PREFETCH_BLOCKS_MIN = 2;
export const MSFILE_MEDIA_PREFETCH_BLOCKS_MAX = 64;

/**
 * MSFile 读取并发建议值。
 *
 * 这些值是设置页的一键恢复值，不是技术硬上限。硬上限依据浏览器内存
 * 压力预算单独定义，避免把推荐配置误当成所有设备都适用的固定值。
 */
export const MSFILE_READ_CONCURRENCY_RECOMMENDED: Readonly<MsFileReadConcurrencySettings> = Object.freeze({
  mediaBlockReadConcurrency: 2,
  globalSeedReadConcurrency: 4,
  globalBlockReadConcurrency: 8,
  globalStatConcurrency: 4,
});

/**
 * 读取并发技术硬上限。
 *
 * 依据：见 docs/MSFile.md 的并发设置说明。
 * 浏览器压力测试验证了 8 × 16 MiB + 32 × 256 KiB = 136 MiB 的最坏桥接
 * attachment 分配与释放；它们与上面的建议值刻意不同，并为媒体解码、页面
 * 和 Supplier 协议开销保留余量。媒体值还必须满足 media <= globalBlock。
 */
export const MSFILE_READ_CONCURRENCY_HARD_LIMITS: Readonly<MsFileReadConcurrencySettings> = Object.freeze({
  mediaBlockReadConcurrency: 16,
  globalSeedReadConcurrency: 8,
  globalBlockReadConcurrency: 32,
  globalStatConcurrency: 16,
});

/** 原生 Range 媒体 Session 创建时固定采用的 Block 并发默认值。 */
export const MSFILE_MEDIA_BLOCK_READ_CONCURRENCY_DEFAULT = MSFILE_READ_CONCURRENCY_RECOMMENDED.mediaBlockReadConcurrency;
export const MSFILE_MEDIA_BLOCK_READ_CONCURRENCY_MIN = 1;
export const MSFILE_MEDIA_BLOCK_READ_CONCURRENCY_MAX = MSFILE_READ_CONCURRENCY_HARD_LIMITS.mediaBlockReadConcurrency;

export interface MsFileReadConcurrencySettings {
  /** 单个媒体 Session 同时进入 Supplier Read 的 Block 数。 */
  mediaBlockReadConcurrency: number;
  /** 整个 Keymaster 同时读取的 Seed 数。 */
  globalSeedReadConcurrency: number;
  /** 整个 Keymaster 同时读取的 Block 数。 */
  globalBlockReadConcurrency: number;
  /** 整个 Keymaster 同时执行的 Stat 数。 */
  globalStatConcurrency: number;
}

/** 单个内容对象的最高金额。规范十进制字符串："0" 表示显式不限。 */
export type MsFileSatoshiAmount = string;

export interface MsFileGlobalPriceSettings {
  seedMaxPriceSatoshis: MsFileSatoshiAmount;
  blockMaxPriceSatoshis: MsFileSatoshiAmount;
}

/** App 级覆盖。字段缺失表示继承全局设置；不使用 `0` 表达缺失。 */
export interface MsFileAppPriceOverride {
  seedMaxPriceSatoshis?: MsFileSatoshiAmount;
  blockMaxPriceSatoshis?: MsFileSatoshiAmount;
}

/**
 * 解析规范十进制金额。
 *
 * 规则（施工单 §2.5）：
 *   - 只接受 `0` 或不带前导零的十进制正整数；
 *   - 范围 `0..2^64-1`；
 *   - 缺失 / 空串 / 非法输入返回 undefined，调用方不得把 undefined 变成 "0"。
 */
export function normalizeMsFileSatoshiAmount(input: unknown): MsFileSatoshiAmount | undefined {
  if (typeof input !== "string") return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(input)) return undefined;
  if (input.length > 1 && input.charCodeAt(0) === 0x30) return undefined;
  const value = BigInt(input);
  if (value > 0xffffffffffffffffn) return undefined;
  return input;
}

/** 把规范金额转成 wire 边界的 bigint。非规范输入 fail closed。 */
export function msFileSatoshiAmountToBigInt(input: MsFileSatoshiAmount): bigint | undefined {
  const normalized = normalizeMsFileSatoshiAmount(input);
  if (normalized === undefined) return undefined;
  return BigInt(normalized);
}

/** 校验并规范化媒体 Block 读取并发数；非法值返回 undefined，由调用方拒绝保存。 */
export function normalizeMsFileMediaBlockReadConcurrency(input: unknown): number | undefined {
  if (!Number.isSafeInteger(input)) return undefined;
  const value = input as number;
  if (
    value < MSFILE_MEDIA_BLOCK_READ_CONCURRENCY_MIN ||
    value > MSFILE_MEDIA_BLOCK_READ_CONCURRENCY_MAX
  ) return undefined;
  return value;
}

/** 校验完整读取并发设置；任一字段非法或关系不满足时整体拒绝。 */
export function normalizeMsFileReadConcurrencySettings(input: unknown): MsFileReadConcurrencySettings | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  const mediaBlockReadConcurrency = normalizeMsFileMediaBlockReadConcurrency(record.mediaBlockReadConcurrency);
  const globalSeedReadConcurrency = normalizeMsFileConcurrencyValue(
    record.globalSeedReadConcurrency,
    MSFILE_READ_CONCURRENCY_HARD_LIMITS.globalSeedReadConcurrency,
  );
  const globalBlockReadConcurrency = normalizeMsFileConcurrencyValue(
    record.globalBlockReadConcurrency,
    MSFILE_READ_CONCURRENCY_HARD_LIMITS.globalBlockReadConcurrency,
  );
  const globalStatConcurrency = normalizeMsFileConcurrencyValue(
    record.globalStatConcurrency,
    MSFILE_READ_CONCURRENCY_HARD_LIMITS.globalStatConcurrency,
  );
  if (mediaBlockReadConcurrency === undefined || globalSeedReadConcurrency === undefined ||
    globalBlockReadConcurrency === undefined || globalStatConcurrency === undefined ||
    mediaBlockReadConcurrency > globalBlockReadConcurrency) return undefined;
  return { mediaBlockReadConcurrency, globalSeedReadConcurrency, globalBlockReadConcurrency, globalStatConcurrency };
}

function normalizeMsFileConcurrencyValue(input: unknown, max: number): number | undefined {
  if (!Number.isSafeInteger(input)) return undefined;
  const value = input as number;
  return value >= 1 && value <= max ? value : undefined;
}

/** 64 位小写 hex（32 字节内容哈希）。 */
export function isValidMsFileHashHex(input: unknown): input is string {
  return typeof input === "string" && /^[0-9a-f]{64}$/.test(input);
}

/** 66 位小写 hex 且首字节 02/03（33 字节压缩 secp256k1 公钥）。 */
export function isValidMsFileSupplierPublicKeyHex(input: unknown): input is string {
  return typeof input === "string" && /^(02|03)[0-9a-f]{64}$/.test(input);
}

/** Keymaster 内置本地 BitFS 来源的稳定路由标识。 */
export const MSFILE_LOCAL_SOURCE_ID = "local-bitfs";

/** MSFile 来源类型；本地来源不经过 `/msfile/1.0.0`。 */
export type MsFileSourceKind = "local-bitfs" | "remote-proxy";

/** 根据远程供应商身份生成不会与本地来源冲突的稳定路由标识。 */
export function msFileRemoteSourceId(supplierPublicKeyHex: string): string {
  if (!isValidMsFileSupplierPublicKeyHex(supplierPublicKeyHex)) throw new TypeError("MSFile 远程来源公钥不合法");
  return `remote-proxy:${supplierPublicKeyHex}`;
}

/** 校验 MSFile 来源路由标识；拒绝路径字符和无界文本。 */
export function isValidMsFileSourceId(input: unknown): input is string {
  return typeof input === "string"
    && (input === MSFILE_LOCAL_SOURCE_ID || /^remote-proxy:(02|03)[0-9a-f]{64}$/u.test(input));
}

/** 稳定 App 策略键：owner + publisher + appId。不使用 origin 或 identityDigestHex。 */
export interface MsFileAppIdentityKey {
  ownerPublicKeyHex: string;
  publisherPublicKeyHex: string;
  appId: string;
}

export function msFileAppPolicyKeyString(key: MsFileAppIdentityKey): string {
  return `${key.ownerPublicKeyHex}|${key.publisherPublicKeyHex}|${key.appId}`;
}

/* ============== Stat ============== */

export type MsFileStatInput = {
  seedHashHex: string;
  signal?: AbortSignal;
};

export interface MsFileStatParams {
  connectSessionId: string;
  seedHashHex: string;
}

export interface MsFileStatAvailableEntry {
  supplierPublicKeyHex: string;
  status: "available";
  recommendedFilename: string;
  /** 十进制字符串形式的 uint64 字节数。 */
  fileSizeBytes: MsFileSatoshiAmount;
  mediaType: string;
}

export interface MsFileStatAbsentEntry {
  supplierPublicKeyHex: string;
  status: "absent";
}

export interface MsFileStatDiscoveringEntry {
  supplierPublicKeyHex: string;
  status: "discovering";
  retryAfterMs: number;
}

export interface MsFileStatQuotedEntry {
  supplierPublicKeyHex: string;
  status: "quoted";
  recommendedFilename: string;
  fileSizeBytes: MsFileSatoshiAmount;
  mediaType: string;
  minSeedPriceSatoshis: MsFileSatoshiAmount;
  maxSeedPriceSatoshis: MsFileSatoshiAmount;
  minFullBlockPriceSatoshis: MsFileSatoshiAmount;
  maxFullBlockPriceSatoshis: MsFileSatoshiAmount;
}

/** 网络错误不得折叠成 absent。 */
export interface MsFileStatNetworkErrorEntry {
  supplierPublicKeyHex: string;
  status: "network-error";
}

export type MsFileSupplierStat =
  | MsFileStatAvailableEntry
  | MsFileStatAbsentEntry
  | MsFileStatDiscoveringEntry
  | MsFileStatQuotedEntry
  | MsFileStatNetworkErrorEntry;

/** 远程 Proxy 结果补充来源路由信息后的公共视图。 */
type MsFileRemoteSourceStat<T> = T extends MsFileSupplierStat
  ? T & { /** 稳定来源路由标识。 */ sourceId: string; /** 固定为远程 Proxy。 */ sourceKind: "remote-proxy" }
  : never;

/** local 结果没有远程供应商公钥，不能用假公钥占位。 */
type MsFileLocalSourceStat<T> = T extends MsFileSupplierStat
  ? Omit<T, "supplierPublicKeyHex"> & { /** 固定本地路由标识。 */ sourceId: typeof MSFILE_LOCAL_SOURCE_ID; /** 固定为本地 BitFS。 */ sourceKind: "local-bitfs" }
  : never;

/** 统一 MSFile API 返回的 local/remote 来源状态。 */
export type MsFileSourceStat = MsFileRemoteSourceStat<MsFileSupplierStat> | MsFileLocalSourceStat<MsFileSupplierStat>;

export interface MsFileStatResult {
  seedHashHex: string;
  /** 所有本地与远程来源；本地来源固定排在第一位。 */
  sources: MsFileSourceStat[];
}

/* ============== Read ============== */

export interface MsFileReadSeedInput {
  /** 要读取的来源路由标识。 */
  sourceId: string;
  seedHashHex: string;
  signal?: AbortSignal;
}

export interface MsFileReadBlockInput {
  /** 要读取的来源路由标识。 */
  sourceId: string;
  /** Block 所属 Seed；用于本地精确寻址和关系校验。 */
  seedHashHex: string;
  blockHashHex: string;
  signal?: AbortSignal;
}

export interface MsFileSeedReadParams {
  connectSessionId: string;
  /** 要读取的来源路由标识。 */
  sourceId: string;
  seedHashHex: string;
}

export interface MsFileBlockReadParams {
  connectSessionId: string;
  /** 要读取的来源路由标识。 */
  sourceId: string;
  /** Block 所属 Seed；remote wire 不发送该字段。 */
  seedHashHex: string;
  blockHashHex: string;
}

export interface MsFileReadResult {
  contentHashHex: string;
  content: BinaryField;
}

/** Read 内容种类。只用于金额策略与校验规则，不进入 wire。 */
export type MsFileContentKind = "seed" | "block";

/* ============== Supplier 配置 ============== */

export interface MsFileSupplierConfig {
  name: string;
  supplierPublicKeyHex: string;
  addresses: string[];
  enabled: boolean;
  /**
   * 系统内置供应商：由平台常量提供，始终存在且启用。
   * 不能删除或改写；持久化的同名 Key 记录不得覆盖它。
   */
  builtin?: boolean;
}

/** 当前 Key 的 BitFS 卖方持久化设置。 */
export interface MsFileSellerSettings {
  /** 是否允许当前 Key 作为 BitFS 卖方。 */
  sellerEnabled: boolean;
  /** 单个 Seed 的售价（聪）。 */
  seedPriceSatoshis: MsFileSatoshiAmount;
  /** 一个完整 256 KiB Block 的售价（聪）。 */
  fullBlockPriceSatoshis: MsFileSatoshiAmount;
  /** 报价有效时间（秒）。 */
  quoteLifetimeSeconds: number;
  /** 卖方接受的仲裁方压缩公钥列表。 */
  supportedArbiterPublicKeys: string[];
  /** 当前 Key 同时处理的销售会话上限。 */
  maxConcurrentSales: number;
}

/** 当前 Key 的 BitFS 买方自动购买策略；强制下载限额按单个文件单独设置。 */
export interface MsFileBitfsBuyerSettings {
  /** 是否在单块报价不高于自动购买上限时自动开始购买；旧配置缺失时关闭。 */
  buyerAutoPurchaseEnabled: boolean;
  /** 自动购买允许的单个完整 Block 最高价，单位聪；不限制整份文件总价。 */
  maxFullBlockPriceSatoshis: MsFileSatoshiAmount;
  /** 多个合格卖家时的优先规则；速度优先尚无有效样本时回退到价格优先。 */
  sellerSelectionPriority: "price" | "recent-speed";
  /** BitFS 买方同时处理的文件任务上限。 */
  maxConcurrentDownloads: number;
  /** 单个文件同时参与传输的卖家费用池数量；旧设置缺失时保持单卖家。 */
  maxConcurrentSellerSessions: number;
  /** 用户按 Seed 单独保存的强制下载完整 Block 最高价；与自动购买上限分开。 */
  filePriceLimitsBySeedHash?: Record<string, MsFileSatoshiAmount>;
}

/** 自动购买安全缺省值；升级旧配置时必须保持关闭。 */
export const MSFILE_BITFS_BUYER_SETTINGS_DEFAULT: Readonly<MsFileBitfsBuyerSettings> = Object.freeze({
  buyerAutoPurchaseEnabled: false,
  maxFullBlockPriceSatoshis: "0",
  sellerSelectionPriority: "price",
  maxConcurrentDownloads: 1,
  maxConcurrentSellerSessions: 3,
  filePriceLimitsBySeedHash: Object.freeze({}),
});

/** BitFS 买方并发范围；任务数有界，避免报价洪峰同时占用资金和连接。 */
export const MSFILE_BITFS_BUYER_LIMITS = Object.freeze({
  maxConcurrentDownloads: 16,
  maxConcurrentSellerSessions: 16,
});

/** 严格校验买方设置；非法输入整体拒绝保存。 */
export function normalizeMsFileBitfsBuyerSettings(input: unknown): MsFileBitfsBuyerSettings | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  const maxFullBlockPriceSatoshis = normalizeMsFileSatoshiAmount(value.maxFullBlockPriceSatoshis);
  const filePriceLimitsBySeedHash: Record<string, MsFileSatoshiAmount> = {};
  const savedFileLimits = value.filePriceLimitsBySeedHash;
  if (savedFileLimits !== undefined) {
    if (typeof savedFileLimits !== "object" || savedFileLimits === null || Array.isArray(savedFileLimits)) return undefined;
    const entries = Object.entries(savedFileLimits as Record<string, unknown>);
    if (entries.length > 256) return undefined;
    for (const [seedHashHex, amount] of entries) {
      const normalizedAmount = normalizeMsFileSatoshiAmount(amount);
      if (!isValidMsFileHashHex(seedHashHex) || normalizedAmount === undefined) return undefined;
      filePriceLimitsBySeedHash[seedHashHex] = normalizedAmount;
    }
  }
  const maxConcurrentSellerSessions = value.maxConcurrentSellerSessions === undefined ? 1 : value.maxConcurrentSellerSessions;
  if (typeof value.buyerAutoPurchaseEnabled !== "boolean"
    || maxFullBlockPriceSatoshis === undefined
    || (value.sellerSelectionPriority !== "price" && value.sellerSelectionPriority !== "recent-speed")
    || !Number.isSafeInteger(value.maxConcurrentDownloads)
    || (value.maxConcurrentDownloads as number) < 1
    || (value.maxConcurrentDownloads as number) > MSFILE_BITFS_BUYER_LIMITS.maxConcurrentDownloads
    || !Number.isSafeInteger(maxConcurrentSellerSessions)
    || (maxConcurrentSellerSessions as number) < 1
    || (maxConcurrentSellerSessions as number) > MSFILE_BITFS_BUYER_LIMITS.maxConcurrentSellerSessions) return undefined;
  return {
    buyerAutoPurchaseEnabled: value.buyerAutoPurchaseEnabled,
    maxFullBlockPriceSatoshis,
    sellerSelectionPriority: value.sellerSelectionPriority,
    maxConcurrentDownloads: value.maxConcurrentDownloads as number,
    maxConcurrentSellerSessions: maxConcurrentSellerSessions as number,
    filePriceLimitsBySeedHash,
  };
}

/** 经 BitFS 报价验签后，可安全展示给买方的摘要。 */
export interface MsFileBitfsQuoteView {
  /** Keymaster 内部买方会话编号。 */
  sessionId: string;
  /** 报价对应的 Seed Hash。 */
  seedHashHex: string;
  /** 报价签名绑定的原文件大小，单位字节。 */
  fileSizeBytes: string;
  /** 已验签卖方压缩公钥。 */
  sellerPublicKeyHex: string;
  /** Seed 单价，单位聪。 */
  seedPriceSatoshis: string;
  /** 完整 Block 单价，单位聪。 */
  fullBlockPriceSatoshis: string;
  /** 报价有效截止时间，Unix 秒。 */
  quoteExpiresAtUnixSeconds: string;
  /** 卖方建议文件名。 */
  recommendedFilename: string;
  /** 报价允许的仲裁方压缩公钥；买方只可从此列表选择。 */
  supportedArbiterPublicKeys: string[];
  /** 最近一次已验收并完成付款的 Block 有效传输速度，单位字节/秒；没有样本时为 null。 */
  recentBytesPerSecond?: MsFileSatoshiAmount | null;
}

/** 买方购买阶段；供界面显示，不暴露交易原文。 */
export type MsFileBitfsPurchasePhase =
  /** 正在收集并验签卖家报价；尚未动用买方资金。 */
  | "discovering"
  /** 正在准备并发送开池预签请求。 */
  | "opening"
  /** 已取消正在准备但尚未收到卖方开池预签的流程；资金占用正在释放。 */
  | "cancelling-opening"
  /** 正在广播或核对开池资金交易。 */
  | "funding"
  /** 开池交易结果暂时未知。 */
  | "funding-unknown"
  /** 正在请求或等待 Seed。 */
  | "requesting-seed"
  /** 正在请求或等待文件块。 */
  | "requesting-blocks"
  /** 付款已发送，正在核对池交易。 */
  | "payment-unknown"
  /** 已付款，正在写入本地文件。 */
  | "content-committing"
  /** 文件已写入，正在通过 Kind 12/13 协商关池。 */
  | "closing-pool"
  /** 完整关池交易已发送，正在核对并回收买方余款。 */
  | "close-unknown"
  /** 买方主动取消后，正在与卖方协商关闭费用池。 */
  | "cancelling-pool"
  /** 买方主动取消的关池结果尚未确定；费用池仍受保护。 */
  | "cancel-unknown"
  /** 取消已由链上确认，费用池余款已回收。 */
  | "cancelled"
  /** 退款锁已到期，正在广播买方预签退款。 */
  | "refund-ready"
  /** 退款交易结果尚未确定，资金仍受保护。 */
  | "refund-unknown"
  /** 退款交易已观察，余款已恢复为专款可用余额。 */
  | "refunded"
  /** 文件已验证并写入本地 MSFile。 */
  | "completed"
  /** 买方协议或数据校验失败。 */
  | "failed"
  /** 传输已断开；本地会话证据仍保留。 */
  | "connection-closed";

/** 当前 Seed 的买方购买进度摘要，不包含 wire 或交易原文。 */
export interface MsFileBitfsPurchaseSnapshot {
  /** 被选中的报价会话编号。 */
  sessionId: string;
  /** 买方持久化会话阶段。 */
  phase: MsFileBitfsPurchasePhase;
  /** 本次计划的开池金额；尚未准备时为 null。 */
  openingAmountSatoshis: string | null;
  /** 用户为本文件选择的完整 Block 最高价；未使用文件专属上限时为 null。 */
  currentMaxFullBlockPriceSatoshis?: MsFileSatoshiAmount | null;
  /** 已验证并暂存的不同 Block 数量。 */
  verifiedBlockCount: number;
  /** 已验证并暂存 Block 的总字节数；底层存储未能提供准确大小时为 null。 */
  verifiedBytes?: MsFileSatoshiAmount | null;
  /** 报价文件的 Block 总数。 */
  totalBlockCount: number | null;
  /** 购买过程中的中文提示；没有错误时为 null。 */
  message: string | null;
}

/** `/msfile/storage` 显示的可恢复 BitFS 购买任务；不含 Artifact、签名或交易原文。 */
export interface MsFileBitfsTaskSnapshot extends MsFileBitfsPurchaseSnapshot {
  /** 购买绑定的 Seed Hash。 */
  seedHashHex: string;
  /** 当前购买报价卖家的压缩公钥；仅收集需求报价时还没有卖家，值为 null。 */
  sellerPublicKeyHex: string | null;
  /** 报价给出的建议文件名；旧会话缺少时为 null。 */
  recommendedFilename: string | null;
  /** 报价绑定的文件字节数；旧会话缺少时为 null。 */
  fileSizeBytes: MsFileSatoshiAmount | null;
  /** 完整 Block 单价；旧会话缺少时为 null。 */
  fullBlockPriceSatoshis: MsFileSatoshiAmount | null;
  /** 已支付给卖家的累计金额；尚无链上付款时为 0。 */
  paidSatoshis: MsFileSatoshiAmount;
  /** FundingTx 与当前费用池状态交易已知的矿工费合计。 */
  minerFeeSatoshis: MsFileSatoshiAmount;
  /** 仍处于费用池中或待回收的金额。 */
  lockedSatoshis: MsFileSatoshiAmount;
  /** 已准备但尚未观察回收的买方输出金额。 */
  pendingReturnSatoshis: MsFileSatoshiAmount;
  /** 任务页显示的已验收 Block 字节数；无法准确读取时为 null。 */
  verifiedBytes: MsFileSatoshiAmount | null;
  /** 是否仍处于需求/报价阶段，尚未选择卖家或准备资金。 */
  discoveryOnly?: boolean;
  /** 当前需求收到的已验签报价；可能为空，报价来自当前 Worker 会话。 */
  availableQuotes?: MsFileBitfsQuoteView[];
  /** 当前页面是否可以安全取消；已产生付款签名或卖家离线时为 false。 */
  canCancel?: boolean;
  /** 买卖通道断开且存在已开费用池时，可重新发布需求并续接原会话。 */
  canReconnect?: boolean;
}

/** 当前 Seed 的 ChannelProtocol 需求与已验证报价视图。 */
export interface MsFileBitfsDemandSnapshot {
  /** 当前需求的 Seed Hash。 */
  seedHashHex: string;
  /** 已签名 Hash 请求的 message_id；未发布时为 null。 */
  requestMessageId: string | null;
  /** 需求过期时间，Unix 毫秒；未发布时为 null。 */
  expiresAtMs: number | null;
  /** 通过关联 WebRTC DataChannel 收到并验签的报价。 */
  quotes: MsFileBitfsQuoteView[];
  /** 当前 Seed 最近一次买方购买会话；未开始时为 null。 */
  purchase?: MsFileBitfsPurchaseSnapshot | null;
  /** 用户为当前 Seed 保存的强制下载上限；不代替全局自动购买价上限。 */
  currentMaxFullBlockPriceSatoshis?: MsFileSatoshiAmount | null;
}

/** 新安装与旧 schema 升级时采用的安全卖方缺省值。 */
export const MSFILE_SELLER_SETTINGS_DEFAULT: Readonly<MsFileSellerSettings> = Object.freeze({
  sellerEnabled: false,
  seedPriceSatoshis: "0",
  fullBlockPriceSatoshis: "0",
  quoteLifetimeSeconds: 300,
  supportedArbiterPublicKeys: [],
  maxConcurrentSales: 1,
});

/** 卖方设置边界；设置页与 Coordinator DTO 校验共同使用。 */
export const MSFILE_SELLER_LIMITS = Object.freeze({
  /** 报价最短有效秒数。 */
  quoteLifetimeSecondsMin: 30,
  /** 报价最长有效秒数。 */
  quoteLifetimeSecondsMax: 86_400,
  /** 同时销售会话硬上限。 */
  maxConcurrentSales: 16,
  /** 可配置仲裁方数量硬上限。 */
  supportedArbiters: 32,
});

/** 严格规范化卖方设置；任一字段不合法时返回 undefined。 */
export function normalizeMsFileSellerSettings(input: unknown): MsFileSellerSettings | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  if (typeof value.sellerEnabled !== "boolean") return undefined;
  const seedPriceSatoshis = normalizeMsFileSatoshiAmount(value.seedPriceSatoshis);
  const fullBlockPriceSatoshis = normalizeMsFileSatoshiAmount(value.fullBlockPriceSatoshis);
  if (seedPriceSatoshis === undefined || fullBlockPriceSatoshis === undefined) return undefined;
  if (!Number.isSafeInteger(value.quoteLifetimeSeconds)
    || (value.quoteLifetimeSeconds as number) < MSFILE_SELLER_LIMITS.quoteLifetimeSecondsMin
    || (value.quoteLifetimeSeconds as number) > MSFILE_SELLER_LIMITS.quoteLifetimeSecondsMax) return undefined;
  if (!Number.isSafeInteger(value.maxConcurrentSales)
    || (value.maxConcurrentSales as number) < 1
    || (value.maxConcurrentSales as number) > MSFILE_SELLER_LIMITS.maxConcurrentSales) return undefined;
  if (!Array.isArray(value.supportedArbiterPublicKeys)
    || value.supportedArbiterPublicKeys.length > MSFILE_SELLER_LIMITS.supportedArbiters) return undefined;
  const supportedArbiterPublicKeys: string[] = [];
  for (const item of value.supportedArbiterPublicKeys) {
    if (!isValidMsFileSupplierPublicKeyHex(item) || supportedArbiterPublicKeys.includes(item)) return undefined;
    supportedArbiterPublicKeys.push(item);
  }
  return {
    sellerEnabled: value.sellerEnabled,
    seedPriceSatoshis,
    fullBlockPriceSatoshis,
    quoteLifetimeSeconds: value.quoteLifetimeSeconds as number,
    supportedArbiterPublicKeys,
    maxConcurrentSales: value.maxConcurrentSales as number,
  };
}

/** 卖方运行状态；用户开关与实际可接单状态分开表达。 */
export type MsFileSellerRuntimeStatus =
  | "disabled"
  | "waiting-unlock"
  | "indexing"
  | "configuration-error"
  | "ready"
  | "selling"
  | "degraded";

export interface MsFileSupplierAddressProbeResult {
  address: string;
  ok: boolean;
  errorCode?: string;
}

export interface MsFileSupplierProbeResult {
  supplierPublicKeyHex: string;
  peerId: string;
  connected: boolean;
  startedAt: number;
  durationMs: number;
  addresses: MsFileSupplierAddressProbeResult[];
}

/* ============== 设置与授权 ============== */

export interface MsFileSettingsSnapshot {
  /** 用户尚未显式保存全局设置时为 null；Read 此时 fail closed。 */
  globalSettings: MsFileGlobalPriceSettings | null;
  /** 单个媒体 Session 的 Block 读取并发数。 */
  mediaBlockReadConcurrency: number;
  /** 整个 Keymaster 的 Seed 读取并发数。 */
  globalSeedReadConcurrency: number;
  /** 整个 Keymaster 的 Block 读取并发数。 */
  globalBlockReadConcurrency: number;
  /** 整个 Keymaster 的 Stat 并发数。 */
  globalStatConcurrency: number;
  suppliers: MsFileSupplierConfig[];
  /** 供应商配置世代；每次变更递增，使旧连接失效。 */
  supplierGeneration: number;
  /** 当前 Key 的卖方配置；旧设置文件缺失时 sellerEnabled=false。 */
  sellerSettings: MsFileSellerSettings;
  /** Coordinator 中唯一卖方运行单元的当前状态。 */
  sellerRuntimeStatus: MsFileSellerRuntimeStatus;
}

export interface MsFileAppPolicyRecord {
  key: MsFileAppIdentityKey;
  override: MsFileAppPriceOverride;
  updatedAt: number;
}

export interface MsFileAppUsageRecord {
  key: MsFileAppIdentityKey;
  appName: string;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface MsFileAppAuthorizationView extends MsFileAppUsageRecord {
  policy: MsFileAppPolicyRecord | null;
}

export interface MsFileAppPriceOverrideUpdate {
  key: MsFileAppIdentityKey;
  override: MsFileAppPriceOverride;
}

export type MsFileServiceStatus =
  | "unconfigured"
  | "ready"
  | "unavailable";

/* ============== 超额确认 ============== */

export type MsFileApprovalKind = MsFileContentKind;

export interface MsFilePendingApproval {
  approvalId: string;
  createdAt: number;
  connectSessionId: string;
  transportOrigin: string;
  ownerPublicKeyHex: string;
  publisherPublicKeyHex: string;
  appId: string;
  appName: string;
  kind: MsFileApprovalKind;
  supplierPublicKeyHex: string;
  contentHashHex: string;
  /** 触发确认时的有效额度；确认界面据此展示"当前额度"。 */
  effectiveMaxPriceSatoshis: MsFileSatoshiAmount;
}

/**
 * 广播到 `msfile.state` topic 的脱敏审批视图。
 *
 * 设计缘由（审查修复）：完整 owner/publisher/supplier/hash/session id 属于
 * 内部策略真值，不得进入跨 tab 状态事件；UI 只需要提示性摘要与 approvalId，
 * 解析时由 Coordinator 用完整记录校验。
 */
export interface MsFilePendingApprovalView {
  approvalId: string;
  createdAt: number;
  appName: string;
  appId: string;
  /** 截断展示用的公钥/哈希前缀（非策略键）。 */
  publisherHint: string;
  supplierHint: string;
  contentHashHint: string;
  kind: MsFileApprovalKind;
  effectiveMaxPriceSatoshis: MsFileSatoshiAmount;
}

export type MsFileApprovalDecision =
  | { action: "reject" }
  | { action: "allow"; scope: "once"; newMaxPriceSatoshis: MsFileSatoshiAmount }
  | { action: "allow"; scope: "always"; newMaxPriceSatoshis: MsFileSatoshiAmount };

/* ============== Connect gateway ============== */

export interface MsFileConnectAppContext {
  connectSessionId: string;
  transportOrigin: string;
  ownerPublicKeyHex: string;
  appIdentity: AppIdentitySnapshot;
}

/**
 * Connect 专用入口。trusted 插件不得通过它调用；plugin-protocol 也不得
 * 绕过它去调 trusted Read。
 */
export interface MsFileConnectGateway {
  stat(ctx: MsFileConnectAppContext, input: Omit<MsFileStatInput, "signal"> & { signal?: AbortSignal }): Promise<MsFileStatResult>;
  readSeed(ctx: MsFileConnectAppContext, input: Omit<MsFileReadSeedInput, "signal"> & { signal?: AbortSignal }): Promise<MsFileReadResult>;
  readBlock(ctx: MsFileConnectAppContext, input: Omit<MsFileReadBlockInput, "signal"> & { signal?: AbortSignal }): Promise<MsFileReadResult>;
}

/* ============== Service ============== */

export interface MsFileService {
  status(): MsFileServiceStatus;
  subscribe(listener: () => void): () => void;

  getSettingsSnapshot(): Promise<MsFileSettingsSnapshot>;
  /** 读取四项并发设置；旧数据缺失字段时返回建议值。 */
  getReadConcurrencySettings(): Promise<MsFileReadConcurrencySettings>;
  /** 原子保存四项并发设置；非法输入不得产生部分写入。 */
  updateReadConcurrencySettings(input: MsFileReadConcurrencySettings): Promise<void>;
  /** 一键恢复施工单定义的建议值。 */
  resetReadConcurrencySettings(): Promise<void>;
  /** 兼容旧调用方的单字段读取入口。 */
  getMediaBlockReadConcurrency(): Promise<number>;
  updateGlobalPriceSettings(input: MsFileGlobalPriceSettings): Promise<void>;
  /** 原子保存当前 Key 的 BitFS 卖方设置。 */
  updateSellerSettings(input: MsFileSellerSettings): Promise<void>;
  /** 读取当前 Key 的 BitFS 自动购买策略；缺失方法的旧代理按自动购买关闭处理。 */
  getBitfsBuyerSettings?(): Promise<MsFileBitfsBuyerSettings>;
  /** 保存当前 Key 的 BitFS 自动购买策略；不改变已开始的购买任务。 */
  updateBitfsBuyerSettings?(input: MsFileBitfsBuyerSettings): Promise<void>;
  /** 兼容旧调用方的单字段保存入口；只影响之后新建的媒体 Session。 */
  updateMediaBlockReadConcurrency(value: number): Promise<void>;
  upsertSupplier(input: MsFileSupplierConfig): Promise<void>;
  deleteSupplier(supplierPublicKeyHex: string): Promise<void>;
  probeSupplier(supplierPublicKeyHex: string, signal?: AbortSignal): Promise<MsFileSupplierProbeResult>;
  updateAppPriceOverride(input: MsFileAppPriceOverrideUpdate): Promise<void>;
  clearAppPriceOverride(input: MsFileAppIdentityKey): Promise<void>;

  listAppAuthorizations(): Promise<MsFileAppAuthorizationView[]>;
  /** 脱敏视图；完整审批记录只留在 Coordinator 内部。 */
  listPendingApprovals(): MsFilePendingApprovalView[];
  resolveApproval(approvalId: string, decision: MsFileApprovalDecision): Promise<void>;

  abortSession(connectSessionId: string): Promise<void>;

  stat(input: MsFileStatInput): Promise<MsFileStatResult>;
  readSeed(input: MsFileReadSeedInput): Promise<MsFileReadResult>;
  readBlock(input: MsFileReadBlockInput): Promise<MsFileReadResult>;

  /**
   * 为本地缺失的 Seed 发布或复用 ChannelProtocol Hash 需求；不拆分资金。
   * 缺少该可选能力的旧 service 只可执行现有 remote MSFile 读取。
   */
  publishBitfsDemand?(seedHashHex: string): Promise<MsFileBitfsDemandSnapshot>;
  /** 读取需求编号及其当前已验证报价；不包含原始 wire 或交易证据。 */
  getBitfsDemand?(seedHashHex: string): Promise<MsFileBitfsDemandSnapshot>;
  /** 选择已验签报价并通过其关联 DataChannel 执行买方购买流程。 */
  startBitfsPurchase?(seedHashHex: string, sessionId: string, maxFullBlockPriceSatoshis?: MsFileSatoshiAmount): Promise<MsFileBitfsDemandSnapshot>;
  /** 在尚未产生付款签名时取消购买，并通过 Kind 12/13 协商回收池内余款。 */
  cancelBitfsPurchase?(seedHashHex: string, sessionId: string): Promise<MsFileBitfsDemandSnapshot>;
  /** 停止本地接收该需求的新报价；不会撤回已经发布的公开 Hash 请求。 */
  cancelBitfsDemand?(seedHashHex: string): Promise<void>;

  readonly connect: MsFileConnectGateway;
}

export const MSFILE_SERVICE_CAPABILITY = defineCapability<MsFileService>({
  kind: "local",
  id: "msfile.service",
  version: "1",
});

/* ============== 错误码 ============== */

/**
 * 稳定公开错误码。supplier wire error code 保留为内部诊断，不直接外泄；
 * transport timeout/EOF/Reset 不转换为 absent 或 content_not_found。
 *
 * 供应商业务终态与网络失败分开表达（审查修复）：content_not_found /
 * rate_limited 是供应商给出的确定答复，不归入 transport_error。
 */
export type MsFileErrorCode =
  | "msfile_not_configured"
  | "msfile_unavailable"
  | "msfile_identity_required"
  | "msfile_supplier_not_found"
  | "msfile_supplier_disabled"
  | "msfile_invalid_hash"
  | "msfile_price_limit_exceeded"
  | "msfile_integrity_error"
  | "msfile_content_not_found"
  | "msfile_rate_limited"
  /** 供应商侧明确业务失败：price_already_committed / acquisition_failed / internal_error。 */
  | "msfile_supplier_error"
  | "msfile_transport_error"
  | "msfile_protocol_error"
  /** 播放器公共错误码；不把远端原始异常暴露给页面。 */
  | "msfile_media_configuration"
  | "msfile_media_network"
  | "msfile_media_amount"
  | "msfile_media_integrity"
  | "msfile_media_unsupported_container"
  | "msfile_media_unsupported_codec"
  | "msfile_media_browser_capability"
  | "msfile_media_decode_failed"
  | "msfile_media_cancelled";
