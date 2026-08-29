// packages/contracts/src/msfile.ts
// MSFile 客户端能力契约（docs/proposals/msfile/implementation-plan.md）。
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
 * Gate 通过前暂时保留旧后端源码，供回滚分支继续编译；当前原生 Range
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
 * 依据：见 docs/proposals/msfile/003-read-concurrency-pressure-evidence.md。
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

export interface MsFileStatResult {
  seedHashHex: string;
  suppliers: MsFileSupplierStat[];
}

/* ============== Read ============== */

export interface MsFileReadSeedInput {
  supplierPublicKeyHex: string;
  seedHashHex: string;
  signal?: AbortSignal;
}

export interface MsFileReadBlockInput {
  supplierPublicKeyHex: string;
  blockHashHex: string;
  signal?: AbortSignal;
}

export interface MsFileSeedReadParams {
  connectSessionId: string;
  supplierPublicKeyHex: string;
  seedHashHex: string;
}

export interface MsFileBlockReadParams {
  connectSessionId: string;
  supplierPublicKeyHex: string;
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
}

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

  readonly connect: MsFileConnectGateway;
}

export const MSFILE_SERVICE_CAPABILITY = "msfile.service";

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
