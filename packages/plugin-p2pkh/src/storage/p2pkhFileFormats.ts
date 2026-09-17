// P2PKH 桶内文件格式（KeymasterFormats《P2PKH 设置 / 交易 / 高度》）。
//
// 路径（owner 根下,module 根即 `p2pkh/`）：
//   - `p2pkh/setting.json`               偏好、provider 选择与配置（明文,≤4 KiB）
//   - `p2pkh/<net>/tx/<txid>.json`       已确认交易的 raw bytes
//   - `p2pkh/<net>/height/<0000000000>.json`  含我的交易的高度与区块内顺序
//
// 本文件只做格式解析与序列化;文件 I/O 在 p2pkhFileRepository。

import type { P2pkhFeeRateTier } from "../p2pkhContracts.js";

/** 设置文件固定名（p2pkh 模块根下）。 */
export const P2PKH_SETTING_FILE_NAME = "setting.json";
export const P2PKH_SETTING_FORMAT = "keymaster.p2pkh-setting";
export const P2PKH_SETTING_VERSION = 1;
/** 设置文件硬上限：4 KiB。 */
export const P2PKH_SETTING_MAX_BYTES = 4 * 1024;
export const P2PKH_TX_FORMAT = "keymaster.p2pkh-tx";
export const P2PKH_TX_VERSION = 1;
/** 区块高度文件名：10 位零填充。 */
export const P2PKH_HEIGHT_FILE_PATTERN = /^\d{10}\.json$/u;
const TXID_PATTERN = /^[0-9a-f]{64}$/u;
const HEX_PATTERN = /^[0-9a-f]*$/u;
const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/u;
const NETWORKS = ["main", "test"] as const;
export type P2pkhFileNetwork = (typeof NETWORKS)[number];

/** 单网络 provider 选择;null/省略 = 未选。 */
export interface P2pkhProviderSelectionFile {
  syncProviderId?: string | null;
  broadcastProviderId?: string | null;
}

/** 磁盘上的设置文件（字段可省略,缺省即默认）。 */
export interface P2pkhSettingFileV1 {
  format: typeof P2PKH_SETTING_FORMAT;
  version: typeof P2PKH_SETTING_VERSION;
  includeTestnet: boolean;
  feeRateSatoshisPerKb?: Partial<Record<P2pkhFeeRateTier, number>>;
  providers?: Partial<Record<P2pkhFileNetwork, P2pkhProviderSelectionFile>>;
  providerConfigs?: Record<string, Record<string, unknown>>;
}

/** 运行时视图：缺省已填。 */
export interface P2pkhResolvedSetting {
  includeTestnet: boolean;
  feeRateSatoshisPerKb: Record<P2pkhFeeRateTier, number>;
  providers: Record<P2pkhFileNetwork, Required<P2pkhProviderSelectionFile>>;
  providerConfigs: Record<string, Record<string, unknown>>;
}

export const P2PKH_SETTING_DEFAULTS = Object.freeze({
  includeTestnet: false,
  feeRateSatoshisPerKb: Object.freeze({ low: 500, medium: 1000, high: 2000 } as Record<P2pkhFeeRateTier, number>),
});

/** 交易文件。 */
export interface P2pkhTxFileV1 {
  format: typeof P2PKH_TX_FORMAT;
  version: typeof P2PKH_TX_VERSION;
  txid: string;
  rawTxHex: string;
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

function optionalProviderId(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || !PROVIDER_ID_PATTERN.test(value)) return undefined;
  return value;
}

function optionalFeeRate(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) return undefined;
  return value as number;
}

/** 严格解析设置文件；任何未知字段/类型错误都返回 undefined。 */
export function parseP2pkhSettingFile(bytes: Uint8Array): P2pkhSettingFileV1 | undefined {
  if (bytes.byteLength === 0 || bytes.byteLength > P2PKH_SETTING_MAX_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const allowed = new Set(["format", "version", "includeTestnet", "feeRateSatoshisPerKb", "providers", "providerConfigs"]);
  if (Object.keys(parsed).some((key) => !allowed.has(key))) return undefined;
  if (parsed.format !== P2PKH_SETTING_FORMAT || parsed.version !== P2PKH_SETTING_VERSION) return undefined;
  if (typeof parsed.includeTestnet !== "boolean") return undefined;

  let feeRate: Partial<Record<P2pkhFeeRateTier, number>> | undefined;
  if (parsed.feeRateSatoshisPerKb !== undefined) {
    if (!isRecord(parsed.feeRateSatoshisPerKb)) return undefined;
    const keys = Object.keys(parsed.feeRateSatoshisPerKb);
    if (keys.some((key) => key !== "low" && key !== "medium" && key !== "high")) return undefined;
    feeRate = {};
    for (const tier of ["low", "medium", "high"] as const) {
      const value = optionalFeeRate(parsed.feeRateSatoshisPerKb[tier]);
      if (parsed.feeRateSatoshisPerKb[tier] !== undefined && value === undefined) return undefined;
      if (value !== undefined) feeRate[tier] = value;
    }
  }

  let providers: Partial<Record<P2pkhFileNetwork, P2pkhProviderSelectionFile>> | undefined;
  if (parsed.providers !== undefined) {
    if (!isRecord(parsed.providers)) return undefined;
    if (Object.keys(parsed.providers).some((key) => key !== "main" && key !== "test")) return undefined;
    providers = {};
    for (const network of NETWORKS) {
      const selection = parsed.providers[network];
      if (selection === undefined) continue;
      if (!isRecord(selection)) return undefined;
      if (Object.keys(selection).some((key) => key !== "syncProviderId" && key !== "broadcastProviderId")) return undefined;
      const syncProviderId = optionalProviderId(selection.syncProviderId);
      const broadcastProviderId = optionalProviderId(selection.broadcastProviderId);
      if (selection.syncProviderId !== undefined && syncProviderId === undefined) return undefined;
      if (selection.broadcastProviderId !== undefined && broadcastProviderId === undefined) return undefined;
      providers[network] = {
        ...(syncProviderId === undefined ? {} : { syncProviderId }),
        ...(broadcastProviderId === undefined ? {} : { broadcastProviderId }),
      };
    }
  }

  let providerConfigs: Record<string, Record<string, unknown>> | undefined;
  if (parsed.providerConfigs !== undefined) {
    if (!isRecord(parsed.providerConfigs)) return undefined;
    providerConfigs = {};
    for (const [providerId, config] of Object.entries(parsed.providerConfigs)) {
      if (!PROVIDER_ID_PATTERN.test(providerId)) return undefined;
      const cloned = cloneJsonObject(config);
      if (!cloned) return undefined;
      providerConfigs[providerId] = cloned;
    }
  }

  return {
    format: P2PKH_SETTING_FORMAT,
    version: P2PKH_SETTING_VERSION,
    includeTestnet: parsed.includeTestnet,
    ...(feeRate === undefined ? {} : { feeRateSatoshisPerKb: feeRate }),
    ...(providers === undefined ? {} : { providers }),
    ...(providerConfigs === undefined ? {} : { providerConfigs }),
  };
}

/** 把磁盘文件解析成运行时视图（缺省填默认值）。 */
export function resolveP2pkhSetting(file?: P2pkhSettingFileV1): P2pkhResolvedSetting {
  const empty = (): Required<P2pkhProviderSelectionFile> => ({ syncProviderId: null, broadcastProviderId: null });
  const selection = (input?: P2pkhProviderSelectionFile): Required<P2pkhProviderSelectionFile> => ({
    syncProviderId: input?.syncProviderId ?? null,
    broadcastProviderId: input?.broadcastProviderId ?? null,
  });
  return {
    includeTestnet: file?.includeTestnet ?? P2PKH_SETTING_DEFAULTS.includeTestnet,
    feeRateSatoshisPerKb: { ...P2PKH_SETTING_DEFAULTS.feeRateSatoshisPerKb, ...(file?.feeRateSatoshisPerKb ?? {}) },
    providers: {
      main: file?.providers?.main === undefined ? empty() : selection(file.providers.main),
      test: file?.providers?.test === undefined ? empty() : selection(file.providers.test),
    },
    providerConfigs: file?.providerConfigs === undefined ? {} : structuredClone(file.providerConfigs),
  };
}

/** 序列化设置文件；默认值不写盘（费率只写与默认不同的档位）。 */
export function serializeP2pkhSettingFile(setting: P2pkhResolvedSetting): Uint8Array {
  const feeRate: Partial<Record<P2pkhFeeRateTier, number>> = {};
  for (const tier of ["low", "medium", "high"] as const) {
    if (setting.feeRateSatoshisPerKb[tier] !== P2PKH_SETTING_DEFAULTS.feeRateSatoshisPerKb[tier]) feeRate[tier] = setting.feeRateSatoshisPerKb[tier];
  }
  const providers: Partial<Record<P2pkhFileNetwork, P2pkhProviderSelectionFile>> = {};
  for (const network of NETWORKS) {
    const selection = setting.providers[network];
    if (selection.syncProviderId === null && selection.broadcastProviderId === null) continue;
    providers[network] = {
      syncProviderId: selection.syncProviderId,
      broadcastProviderId: selection.broadcastProviderId,
    };
  }
  const document = {
    format: P2PKH_SETTING_FORMAT,
    version: P2PKH_SETTING_VERSION,
    includeTestnet: setting.includeTestnet,
    ...(Object.keys(feeRate).length === 0 ? {} : { feeRateSatoshisPerKb: feeRate }),
    ...(Object.keys(providers).length === 0 ? {} : { providers }),
    ...(Object.keys(setting.providerConfigs).length === 0 ? {} : { providerConfigs: setting.providerConfigs }),
  };
  return new TextEncoder().encode(`${JSON.stringify(document, null, 2)}\n`);
}

/** 严格解析交易文件；txid 校验由调用方用交易解析器复核。 */
export function parseP2pkhTxFile(bytes: Uint8Array, expectedTxid: string): P2pkhTxFileV1 | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (Object.keys(parsed).some((key) => key !== "format" && key !== "version" && key !== "txid" && key !== "rawTxHex")) return undefined;
  if (parsed.format !== P2PKH_TX_FORMAT || parsed.version !== P2PKH_TX_VERSION) return undefined;
  if (typeof parsed.txid !== "string" || !TXID_PATTERN.test(parsed.txid)) return undefined;
  if (parsed.txid !== expectedTxid.toLowerCase()) return undefined;
  if (typeof parsed.rawTxHex !== "string" || parsed.rawTxHex.length === 0 || parsed.rawTxHex.length % 2 !== 0 || !HEX_PATTERN.test(parsed.rawTxHex)) return undefined;
  return { format: P2PKH_TX_FORMAT, version: P2PKH_TX_VERSION, txid: parsed.txid, rawTxHex: parsed.rawTxHex };
}

export function serializeP2pkhTxFile(transaction: { txid: string; rawTxHex: string }): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify({
    format: P2PKH_TX_FORMAT,
    version: P2PKH_TX_VERSION,
    txid: transaction.txid.toLowerCase(),
    rawTxHex: transaction.rawTxHex.toLowerCase(),
  }, null, 2)}\n`);
}

/** 高度文件名（10 位零填充）。 */
export function p2pkhHeightFileName(height: number): string {
  if (!Number.isSafeInteger(height) || height < 0 || height > 9_999_999_999) throw new Error("Block height is invalid");
  return `${String(height).padStart(10, "0")}.json`;
}

/** 解析高度文件名;非法返回 undefined。 */
export function parseP2pkhHeightFileName(path: string): number | undefined {
  if (!P2PKH_HEIGHT_FILE_PATTERN.test(path)) return undefined;
  return Number.parseInt(path.slice(0, 10), 10);
}

/** 严格解析高度文件：非空、元素合法且不重复。 */
export function parseP2pkhHeightFile(bytes: Uint8Array): string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
  const seen = new Set<string>();
  for (const txid of parsed) {
    if (typeof txid !== "string" || !TXID_PATTERN.test(txid) || seen.has(txid)) return undefined;
    seen.add(txid);
  }
  return [...parsed] as string[];
}

export function serializeP2pkhHeightFile(txids: readonly string[]): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(txids, null, 2)}\n`);
}
