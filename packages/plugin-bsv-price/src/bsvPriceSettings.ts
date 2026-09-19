// packages/plugin-bsv-price/src/bsvPriceSettings.ts
// BSV Price 运行时设置存储（多发布服务器 + 激活交易对）。
//
// 设计缘由：
//   - 设置由 Host 绑定的 K-V 句柄承载，字段固定，不引入迁移框架；
//   - 服务器按 PriceCast 发布器公钥唯一标识；名称只是展示标签；
//   - 激活项是「供应商-交易所-交易对」三元组，服务只订阅激活服务器；
//   - 输入保存前统一 trim + toLowerCase，并严格校验公钥 / 标识符；
//   - 缺省公钥是生产 PriceCast 发布器；旧配置缺失或损坏时回落到默认值，
//     不进入"未配置"状态；
//   - 读到坏 JSON / 坏 schema 时，按"没有本地配置"处理，由调用方 seed。

import { parsePublicKey } from "bsv8-channel-protocol";
import {
  DEFAULT_PRICE_MARKET,
  DEFAULT_PRICE_PAIR,
  DEFAULT_PRICE_PUBLISHER_PUBLIC_KEY_HEX,
  DEFAULT_PRICE_SERVER_NAME
} from "./constants.js";

/** K-V 中的相对配置键。 */
export const BSV_PRICE_SETTINGS_STORAGE_KEY = "settings";

/** 一个价格发布服务器（PriceCast publisher）。 */
export interface BsvPriceServerConfig {
  /** 展示名称；只是标签，不参与业务判断。 */
  name: string;
  /** 长期压缩公钥 hex；同时是服务器唯一标识。 */
  publisherPublicKeyHex: string;
}

/** 当前激活的展示选项：供应商-交易所-交易对。 */
export interface BsvPriceActiveOption {
  /** 激活服务器公钥 hex；必须是 servers 中的一项。 */
  publisherPublicKeyHex: string;
  /** 交易所编号，例如 gate。 */
  market: string;
  /** 交易对编号，例如 bsvusdt。 */
  pair: string;
}

/**
 * 本地持久化的设置 schema。
 *
 * 设计缘由：
 *   - servers 是候选列表；active 决定实际订阅与展示；
 *   - savedAtMs 只用于诊断 / 排障，不参与业务判断。
 */
export interface BsvPriceGlobalConfig {
  servers: BsvPriceServerConfig[];
  active: BsvPriceActiveOption;
  savedAtMs: number;
}

/** 文本校验结果。 */
export interface BsvPriceTextCheck {
  ok: boolean;
  error?: string;
  value?: string;
}

/** 公钥校验结果。 */
export type BsvPricePublicKeyCheck = BsvPriceTextCheck;

/** 运行时配置存储。 */
export interface BsvPriceSettingsStore {
  /** 读取当前内存真值；没有本地配置时返回 null。 */
  load(): BsvPriceGlobalConfig | null;
  /** 读取当前内存真值的副本；没有本地配置时返回 null。 */
  snapshot(): BsvPriceGlobalConfig | null;
  /** 初始化种子值：写入 K-V 队列。 */
  bootstrapConfig(config: BsvPriceGlobalConfig): BsvPriceGlobalConfig;
  /** 远端保存成功后更新内存真值。 */
  saveConfig(config: BsvPriceGlobalConfig): Promise<BsvPriceGlobalConfig>;
  /** 订阅内存真值变化。 */
  subscribe(handler: (config: BsvPriceGlobalConfig | null) => void): () => void;
  /** 等待 K-V 配置完成首次加载。 */
  ready(): Promise<void>;
}

/** 压缩公钥 hex 的固定长度。 */
const COMPRESSED_PUBLIC_KEY_HEX_LENGTH = 66;
/** 压缩公钥 hex 的前缀。 */
const COMPRESSED_PUBLIC_KEY_PREFIXES = ["02", "03"] as const;
/** 压缩公钥 hex 允许字符。 */
const COMPRESSED_PUBLIC_KEY_RE = /^[0-9a-f]+$/;
/** 服务器名称的最大 UTF-8 字节数。 */
const MAX_SERVER_NAME_BYTES = 64;
/** 市场 / 交易对标识符允许的字符（与 bsv8.bsv-price.v1 一致）。 */
const IDENTIFIER_RE = /^[a-z0-9][a-z0-9._-]*$/u;
/** 标识符最大 UTF-8 字节数。 */
const MAX_IDENTIFIER_BYTES = 64;
/** servers 列表的最大长度。 */
const MAX_SERVERS = 100;

/**
 * 规范化并校验 publisher 公钥 hex。
 *
 * 设计缘由：
 *   - 输入一律先做 `trim()` + `toLowerCase()`；
 *   - 非空值必须是 66 位压缩 secp256k1 公钥 hex；
 *   - 前缀只能是 `02` 或 `03`，避免把非压缩公钥误写入运行时真值。
 */
export function normalizePublisherPublicKeyHex(input: unknown): BsvPricePublicKeyCheck {
  if (typeof input !== "string") {
    return { ok: false, error: "invalid_type" };
  }
  const value = input.trim().toLowerCase();
  if (value.length === 0) {
    return { ok: false, error: "invalid_empty" };
  }
  if (value.length !== COMPRESSED_PUBLIC_KEY_HEX_LENGTH) {
    return { ok: false, error: "invalid_length" };
  }
  if (!COMPRESSED_PUBLIC_KEY_RE.test(value)) {
    return { ok: false, error: "invalid_hex" };
  }
  if (!COMPRESSED_PUBLIC_KEY_PREFIXES.some((prefix) => value.startsWith(prefix))) {
    return { ok: false, error: "invalid_prefix" };
  }
  try {
    parsePublicKey(value);
  } catch {
    return { ok: false, error: "invalid_public_key" };
  }
  return { ok: true, value };
}

/** 规范化并校验服务器展示名称。 */
export function normalizeServerName(input: unknown): BsvPriceTextCheck {
  if (typeof input !== "string") return { ok: false, error: "invalid_type" };
  const value = input.trim();
  if (value.length === 0) return { ok: false, error: "invalid_empty" };
  if (new TextEncoder().encode(value).byteLength > MAX_SERVER_NAME_BYTES) {
    return { ok: false, error: "invalid_length" };
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) return { ok: false, error: "invalid_character" };
  return { ok: true, value };
}

/** 规范化并校验市场 / 交易对标识符。 */
export function normalizeMarketIdentifier(input: unknown): BsvPriceTextCheck {
  if (typeof input !== "string") return { ok: false, error: "invalid_type" };
  const value = input.trim().toLowerCase();
  if (value.length === 0) return { ok: false, error: "invalid_empty" };
  if (new TextEncoder().encode(value).byteLength > MAX_IDENTIFIER_BYTES) {
    return { ok: false, error: "invalid_length" };
  }
  if (!IDENTIFIER_RE.test(value)) return { ok: false, error: "invalid_identifier" };
  return { ok: true, value };
}

/**
 * 从交易对编号推导计价单位。
 *
 * 设计缘由：BSV 价格协议里交易对形如 `bsv<quote>`；去掉 `bsv` 前缀并
 * 转大写就是展示单位（`bsvusdt` → `USDT`、`bsvcny` → `CNY`）。非 `bsv`
 * 前缀的编号整串大写，保持"单位随交易对变化"的语义。
 */
export function deriveUnitFromPair(pair: string): string {
  const value = typeof pair === "string" ? pair.trim().toLowerCase() : "";
  if (value.length === 0) return "";
  const quote = value.startsWith("bsv") && value.length > 3 ? value.slice(3) : value;
  return quote.toUpperCase();
}

/**
 * 构造缺省设置：唯一默认服务器 + 默认交易对。
 *
 * 设计缘由：默认公钥是生产 PriceCast 发布器；种子公钥非法时回落到内置值。
 */
export function createDefaultBsvPriceConfig(
  seedPublisherPublicKeyHex: string = DEFAULT_PRICE_PUBLISHER_PUBLIC_KEY_HEX,
  now: () => number = () => Date.now()
): BsvPriceGlobalConfig {
  const seeded = normalizePublisherPublicKeyHex(seedPublisherPublicKeyHex);
  const publisherPublicKeyHex =
    seeded.ok && seeded.value ? seeded.value : DEFAULT_PRICE_PUBLISHER_PUBLIC_KEY_HEX;
  return {
    servers: [{ name: DEFAULT_PRICE_SERVER_NAME, publisherPublicKeyHex }],
    active: {
      publisherPublicKeyHex,
      market: DEFAULT_PRICE_MARKET,
      pair: DEFAULT_PRICE_PAIR
    },
    savedAtMs: now()
  };
}

/**
 * 归一化服务器列表：逐项校验、按公钥去重。
 *
 * 失败语义：返回 null，调用方按"没有本地配置"处理。
 */
function coerceServers(raw: unknown): BsvPriceServerConfig[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SERVERS) return null;
  const servers: BsvPriceServerConfig[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!isObject(item)) return null;
    const name = normalizeServerName(item.name);
    if (!name.ok || name.value === undefined) return null;
    const key = normalizePublisherPublicKeyHex(item.publisherPublicKeyHex as string);
    if (!key.ok || key.value === undefined) return null;
    if (seen.has(key.value)) return null;
    seen.add(key.value);
    servers.push({ name: name.value, publisherPublicKeyHex: key.value });
  }
  return servers;
}

/** 归一化激活项；服务器不存在或标识符非法时返回 null。 */
function coerceActiveOption(
  raw: unknown,
  servers: readonly BsvPriceServerConfig[]
): BsvPriceActiveOption | null {
  if (!isObject(raw)) return null;
  const key = normalizePublisherPublicKeyHex(raw.publisherPublicKeyHex as string);
  if (!key.ok || key.value === undefined) return null;
  if (!servers.some((server) => server.publisherPublicKeyHex === key.value)) return null;
  const market = normalizeMarketIdentifier(raw.market as string);
  if (!market.ok || market.value === undefined) return null;
  const pair = normalizeMarketIdentifier(raw.pair as string);
  if (!pair.ok || pair.value === undefined) return null;
  return { publisherPublicKeyHex: key.value, market: market.value, pair: pair.value };
}

/** 兼容旧单公钥配置：`{ pricePublisherPublicKeyHex, savedAtMs }`。 */
function coerceLegacyConfig(raw: Record<string, unknown>): BsvPriceGlobalConfig | null {
  const hex = raw.pricePublisherPublicKeyHex;
  if (typeof hex !== "string") return null;
  const savedAtMs =
    typeof raw.savedAtMs === "number" && Number.isFinite(raw.savedAtMs) ? raw.savedAtMs : 0;
  // 旧空值直接回落到内置默认服务器，不再表达"未配置"。
  if (hex.trim().length === 0) return { ...createDefaultBsvPriceConfig(), savedAtMs };
  const normalized = normalizePublisherPublicKeyHex(hex);
  if (!normalized.ok || normalized.value === undefined) return null;
  return { ...createDefaultBsvPriceConfig(normalized.value), savedAtMs };
}

/**
 * 从 raw unknown 读出合法设置。
 *
 * 失败语义：返回 null，不抛错。旧单公钥 schema 自动升级为多服务器 schema。
 */
export function coerceBsvPriceGlobalConfig(raw: unknown): BsvPriceGlobalConfig | null {
  if (!isObject(raw)) return null;
  if ("pricePublisherPublicKeyHex" in raw) return coerceLegacyConfig(raw);
  const servers = coerceServers(raw.servers);
  if (!servers) return null;
  const active = coerceActiveOption(raw.active, servers);
  if (!active) return null;
  const savedAtMs =
    typeof raw.savedAtMs === "number" && Number.isFinite(raw.savedAtMs) ? raw.savedAtMs : 0;
  return { servers, active, savedAtMs };
}

/**
 * 由 Host 绑定的 K-V 驱动的 BSV Price 设置存储。
 *
 * 设计缘由：K-V 句柄是生产实现的必需依赖；测试使用显式的内存 factory。
 */
export function createKeyValueBsvPriceSettingsStore(
  storage: import("@keymaster/contracts").BorrowedKeyValueStore,
  now: () => number = () => Date.now()
): BsvPriceSettingsStore {
  if (!storage) throw new Error("BSV Price central storage binding is required");
  let current: BsvPriceGlobalConfig | null = null;
  const subscribers = new Set<(config: BsvPriceGlobalConfig | null) => void>();
  let writeQueue = Promise.resolve();

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = writeQueue.then(operation);
    writeQueue = result.then(() => undefined, () => undefined);
    return result;
  };

  async function ready(): Promise<void> {
    const entry = await storage.get<unknown>(BSV_PRICE_SETTINGS_STORAGE_KEY, { partition: "settings" });
    current = entry ? coerceBsvPriceGlobalConfig(entry.value) : null;
  }

  function snapshot(): BsvPriceGlobalConfig | null {
    return cloneConfig(current);
  }

  function emit(): void {
    const next = snapshot();
    for (const handler of subscribers) {
      try {
        handler(next);
      } catch {
        // 订阅者异常不应影响设置真值。
      }
    }
  }

  function applyBootstrap(config: BsvPriceGlobalConfig): BsvPriceGlobalConfig {
    const next = assertConfig(config, now);
    current = next;
    emit();
    return cloneConfig(next)!;
  }

  function saveConfig(config: BsvPriceGlobalConfig): Promise<BsvPriceGlobalConfig> {
    const next = assertConfig(config, now);
    return enqueue(async () => {
      await storage.put(BSV_PRICE_SETTINGS_STORAGE_KEY, next, { partition: "settings" });
      current = next;
      emit();
      return cloneConfig(next)!;
    });
  }

  return {
    load: () => cloneConfig(current),
    snapshot,
    bootstrapConfig: applyBootstrap,
    saveConfig,
    subscribe(handler) {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },
    ready
  };
}

/** 明确的内存版设置存储，仅供测试或离线调用方注入。 */
export function createMemoryBsvPriceSettingsStore(
  initial: BsvPriceGlobalConfig | null = null,
  now: () => number = () => Date.now()
): BsvPriceSettingsStore {
  let current = cloneConfig(initial);
  const subscribers = new Set<(config: BsvPriceGlobalConfig | null) => void>();

  function emit(): void {
    const next = cloneConfig(current);
    for (const handler of subscribers) {
      try {
        handler(next);
      } catch {
        // 订阅者异常不应影响设置真值。
      }
    }
  }

  return {
    load: () => cloneConfig(current),
    snapshot: () => cloneConfig(current),
    bootstrapConfig(config) {
      current = assertConfig(config, now);
      emit();
      return cloneConfig(current)!;
    },
    async saveConfig(config) {
      current = assertConfig(config, now);
      emit();
      return cloneConfig(current)!;
    },
    subscribe(handler) {
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    },
    ready: async () => undefined
  };
}

/** 校验并刷新 savedAtMs；非法配置直接抛错。 */
function assertConfig(config: BsvPriceGlobalConfig, now: () => number): BsvPriceGlobalConfig {
  const coerced = coerceBsvPriceGlobalConfig(config);
  if (!coerced) throw new Error("invalid_bsv_price_config");
  return { ...coerced, savedAtMs: now() };
}

function cloneConfig(input: BsvPriceGlobalConfig | null): BsvPriceGlobalConfig | null {
  if (!input) return null;
  return {
    servers: input.servers.map((server) => ({
      name: server.name,
      publisherPublicKeyHex: server.publisherPublicKeyHex
    })),
    active: { ...input.active },
    savedAtMs: input.savedAtMs
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
