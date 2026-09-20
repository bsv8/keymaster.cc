// P2PKH 桶内文件格式（KeymasterFormats《P2PKH 设置 / 历史》）。
//
// 路径（owner 根下，module 根即 `p2pkh/`）：
//   - `p2pkh/setting.json`        偏好与 WoC provider 配置（明文，≤4 KiB）
//   - `p2pkh/<net>/history.json`  WoC history 元数据（txid / height / fee）
//
// 设计缘由（2026-09-20 解耦）：
//   - 历史只保存元数据；raw tx、UTXO、花费关系、余额都不落盘；
//   - UTXO 只存在于 Coordinator Worker 内存快照，来自 WoC `unspent/all`；
//   - 旧文件里的 `providers`（确认同步供应商选择，如 junglebus）在加载时
//     直接丢弃，不能让旧配置导致启动失败。
//
// 本文件只做格式解析与序列化；文件 I/O 在 p2pkhFileRepository。

import type { P2pkhFeeRateTier } from "../p2pkhContracts.js";

/** 设置文件固定名（p2pkh 模块根下）。 */
export const P2PKH_SETTING_FILE_NAME = "setting.json";
export const P2PKH_SETTING_FORMAT = "keymaster.p2pkh-setting";
export const P2PKH_SETTING_VERSION = 1;
/** 设置文件硬上限：4 KiB。 */
export const P2PKH_SETTING_MAX_BYTES = 4 * 1024;

/** 历史文件格式与路径。 */
export const P2PKH_HISTORY_FORMAT = "keymaster.p2pkh-history";
export const P2PKH_HISTORY_VERSION = 1;
/** 单个网络的历史文件字节上限：32 MiB。 */
export const P2PKH_HISTORY_MAX_BYTES = 32 * 1024 * 1024;

const TXID_PATTERN = /^[0-9a-f]{64}$/u;
const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/u;
const NETWORKS = ["main", "test"] as const;
export type P2pkhFileNetwork = (typeof NETWORKS)[number];

/** 只接受保留的 Provider 配置 id；旧 junglebus 等配置在加载时被丢弃。 */
export const P2PKH_KNOWN_PROVIDER_IDS: ReadonlySet<string> = new Set(["woc"]);

/** 磁盘上的设置文件（字段可省略，缺省即默认）。 */
export interface P2pkhSettingFileV1 {
  format: typeof P2PKH_SETTING_FORMAT;
  version: typeof P2PKH_SETTING_VERSION;
  includeTestnet: boolean;
  feeRateSatoshisPerKb?: Partial<Record<P2pkhFeeRateTier, number>>;
  providerConfigs?: Record<string, Record<string, unknown>>;
}

/** 运行时视图：缺省已填。 */
export interface P2pkhResolvedSetting {
  includeTestnet: boolean;
  feeRateSatoshisPerKb: Record<P2pkhFeeRateTier, number>;
  providerConfigs: Record<string, Record<string, unknown>>;
}

export const P2PKH_SETTING_DEFAULTS = Object.freeze({
  includeTestnet: false,
  feeRateSatoshisPerKb: Object.freeze({ low: 500, medium: 1000, high: 2000 } as Record<P2pkhFeeRateTier, number>),
});

/** 历史记录条目（与 P2pkhHistoryRecord 的持久化字段一致）。 */
export interface P2pkhHistoryEntryV1 {
  txid: string;
  /** 确认高度；未确认为 0。 */
  height: number;
  /** WoC history 返回的手续费（聪）；缺失时省略。 */
  fee?: number;
}

/** 历史文件。 */
export interface P2pkhHistoryFileV1 {
  format: typeof P2PKH_HISTORY_FORMAT;
  version: typeof P2PKH_HISTORY_VERSION;
  records: P2pkhHistoryEntryV1[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function cloneJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  try {
    const cloned = JSON.parse(JSON.stringify(value)) as unknown;
    return isRecord(cloned) ? cloned : undefined;
  } catch {
    return undefined;
  }
}

function optionalFeeRate(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) return undefined;
  return value as number;
}

/**
 * 解析设置文件。
 *
 * 旧字段（`providers` 等）与未知字段直接忽略，而不是让整个钱包启动失败：
 * 旧用户存储里的 JungleBus 选择/配置在此被静默丢弃。
 */
export function parseP2pkhSettingFile(bytes: Uint8Array): P2pkhSettingFileV1 | undefined {
  if (bytes.byteLength === 0 || bytes.byteLength > P2PKH_SETTING_MAX_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (parsed.format !== P2PKH_SETTING_FORMAT || parsed.version !== P2PKH_SETTING_VERSION) return undefined;
  if (typeof parsed.includeTestnet !== "boolean") return undefined;

  let feeRate: Partial<Record<P2pkhFeeRateTier, number>> | undefined;
  if (parsed.feeRateSatoshisPerKb !== undefined) {
    if (!isRecord(parsed.feeRateSatoshisPerKb)) return undefined;
    feeRate = {};
    for (const tier of ["low", "medium", "high"] as const) {
      const value = optionalFeeRate(parsed.feeRateSatoshisPerKb[tier]);
      if (parsed.feeRateSatoshisPerKb[tier] !== undefined && value === undefined) return undefined;
      if (value !== undefined) feeRate[tier] = value;
    }
  }

  let providerConfigs: Record<string, Record<string, unknown>> | undefined;
  if (parsed.providerConfigs !== undefined) {
    if (!isRecord(parsed.providerConfigs)) return undefined;
    providerConfigs = {};
    for (const [providerId, config] of Object.entries(parsed.providerConfigs)) {
      // 未知 Provider（含旧 junglebus）配置不进入运行时视图。
      if (!PROVIDER_ID_PATTERN.test(providerId) || !P2PKH_KNOWN_PROVIDER_IDS.has(providerId)) continue;
      const cloned = cloneJsonObject(config);
      if (!cloned) continue;
      providerConfigs[providerId] = cloned;
    }
  }

  return {
    format: P2PKH_SETTING_FORMAT,
    version: P2PKH_SETTING_VERSION,
    includeTestnet: parsed.includeTestnet,
    ...(feeRate === undefined ? {} : { feeRateSatoshisPerKb: feeRate }),
    ...(providerConfigs === undefined ? {} : { providerConfigs }),
  };
}

/** 把磁盘文件解析成运行时视图（缺省填默认值）。 */
export function resolveP2pkhSetting(file?: P2pkhSettingFileV1): P2pkhResolvedSetting {
  return {
    includeTestnet: file?.includeTestnet ?? P2PKH_SETTING_DEFAULTS.includeTestnet,
    feeRateSatoshisPerKb: { ...P2PKH_SETTING_DEFAULTS.feeRateSatoshisPerKb, ...(file?.feeRateSatoshisPerKb ?? {}) },
    providerConfigs: file?.providerConfigs === undefined ? {} : structuredClone(file.providerConfigs),
  };
}

/** 序列化设置文件；默认值不写盘（费率只写与默认不同的档位）。 */
export function serializeP2pkhSettingFile(setting: P2pkhResolvedSetting): Uint8Array {
  const feeRate: Partial<Record<P2pkhFeeRateTier, number>> = {};
  for (const tier of ["low", "medium", "high"] as const) {
    if (setting.feeRateSatoshisPerKb[tier] !== P2PKH_SETTING_DEFAULTS.feeRateSatoshisPerKb[tier]) feeRate[tier] = setting.feeRateSatoshisPerKb[tier];
  }
  const providerConfigs: Record<string, Record<string, unknown>> = {};
  for (const [providerId, config] of Object.entries(setting.providerConfigs)) {
    if (P2PKH_KNOWN_PROVIDER_IDS.has(providerId)) providerConfigs[providerId] = config;
  }
  const document = {
    format: P2PKH_SETTING_FORMAT,
    version: P2PKH_SETTING_VERSION,
    includeTestnet: setting.includeTestnet,
    ...(Object.keys(feeRate).length === 0 ? {} : { feeRateSatoshisPerKb: feeRate }),
    ...(Object.keys(providerConfigs).length === 0 ? {} : { providerConfigs }),
  };
  return new TextEncoder().encode(`${JSON.stringify(document, null, 2)}\n`);
}

/** 历史文件路径（模块根下相对路径）。 */
export function p2pkhHistoryPath(network: P2pkhFileNetwork): string {
  if (!NETWORKS.includes(network)) throw new Error("P2PKH network is invalid");
  return `${network}/history.json`;
}

/**
 * 严格解析历史文件；任何非法记录导致整个文件视为损坏（返回 undefined），
 * 上层按“历史不可用”处理，不猜测缺失数据。
 */
export function parseP2pkhHistoryFile(bytes: Uint8Array): P2pkhHistoryEntryV1[] | undefined {
  if (bytes.byteLength === 0 || bytes.byteLength > P2PKH_HISTORY_MAX_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (parsed.format !== P2PKH_HISTORY_FORMAT || parsed.version !== P2PKH_HISTORY_VERSION) return undefined;
  if (!Array.isArray(parsed.records) || parsed.records.length > 1_000_000) return undefined;
  const records: P2pkhHistoryEntryV1[] = [];
  const seen = new Set<string>();
  for (const entry of parsed.records) {
    if (!isRecord(entry)) return undefined;
    const txid = typeof entry.txid === "string" ? entry.txid.toLowerCase() : "";
    if (!TXID_PATTERN.test(txid) || seen.has(txid)) return undefined;
    if (!Number.isSafeInteger(entry.height) || (entry.height as number) < 0) return undefined;
    if (entry.fee !== undefined && (!Number.isSafeInteger(entry.fee) || (entry.fee as number) < 0)) return undefined;
    seen.add(txid);
    records.push({
      txid,
      height: entry.height as number,
      ...(entry.fee === undefined ? {} : { fee: entry.fee as number }),
    });
  }
  return records;
}

export function serializeP2pkhHistoryFile(records: readonly P2pkhHistoryEntryV1[]): Uint8Array {
  const normalized = records.map((entry) => ({
    txid: entry.txid.toLowerCase(),
    height: entry.height,
    ...(entry.fee === undefined ? {} : { fee: entry.fee }),
  }));
  return new TextEncoder().encode(`${JSON.stringify({ format: P2PKH_HISTORY_FORMAT, version: P2PKH_HISTORY_VERSION, records: normalized })}\n`);
}
