// packages/plugin-bsv-price/src/bsvPriceSettings.ts
// BSV Price 运行时设置存储（施工单 2026-07-08 002 硬切换）。
//
// 设计缘由：
//   - `pricePublisherPublicKeyHex` 是小型全局业务配置，直接用 localStorage；
//   - 只保存一份运行时真值，字段固定，不引入 DB / 迁移框架；
//   - 输入保存前统一 `trim + toLowerCase`，并严格校验压缩公钥 hex；
//   - 空串是合法值，表示“清空配置”；
//   - 读到坏 JSON / 坏 schema / 坏字段时，按“没有本地配置”处理。

/** localStorage 存储 key。 */
export const BSV_PRICE_SETTINGS_STORAGE_KEY = "bsv-price.settings";

/**
 * 本地持久化的设置 schema。
 *
 * 设计缘由：
 *   - 只保留一个业务字段和一个写入时间戳；
 *   - 时间戳用于诊断 / 排障，不参与业务判断。
 */
export interface BsvPriceGlobalConfig {
  pricePublisherPublicKeyHex: string;
  savedAtMs: number;
}

/** 设置保存前的校验结果。 */
export interface BsvPricePublicKeyCheck {
  ok: boolean;
  error?: string;
  value?: string;
}

/** 运行时配置存储。 */
export interface BsvPriceSettingsStore {
  /** 读取当前内存真值；没有本地配置时返回 null。 */
  load(): BsvPriceGlobalConfig | null;
  /** 读取当前内存真值的副本；没有本地配置时返回 null。 */
  snapshot(): BsvPriceGlobalConfig | null;
  /** 初始化种子值：尽量写盘；写盘失败不抛，避免启动卡死。 */
  bootstrapPublisherPublicKeyHex(input: string): BsvPriceGlobalConfig;
  /** 保存新值：先写 localStorage，成功后才切换内存真值。 */
  savePublisherPublicKeyHex(input: string): BsvPriceGlobalConfig;
  /** 订阅内存真值变化。 */
  subscribe(handler: (config: BsvPriceGlobalConfig | null) => void): () => void;
}

/** 压缩公钥 hex 的固定长度。 */
const COMPRESSED_PUBLIC_KEY_HEX_LENGTH = 66;
/** 压缩公钥 hex 的前缀。 */
const COMPRESSED_PUBLIC_KEY_PREFIXES = ["02", "03"] as const;
/** 压缩公钥 hex 允许字符。 */
const COMPRESSED_PUBLIC_KEY_RE = /^[0-9a-f]+$/;

/**
 * 规范化并校验 publisher 公钥 hex。
 *
 * 设计缘由：
 *   - 输入一律先做 `trim()` + `toLowerCase()`；
 *   - 空串是合法值，表示清空配置；
 *   - 非空值必须是 66 位压缩 secp256k1 公钥 hex；
 *   - 前缀只能是 `02` 或 `03`，避免把非压缩公钥误写入运行时真值。
 */
export function normalizePublisherPublicKeyHex(input: string): BsvPricePublicKeyCheck {
  if (typeof input !== "string") {
    return { ok: false, error: "invalid_type" };
  }
  const value = input.trim().toLowerCase();
  if (value.length === 0) {
    return { ok: true, value: "" };
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
  return { ok: true, value };
}

/**
 * 从 raw unknown 读出合法设置。
 *
 * 失败语义：返回 null，不抛错。
 */
export function coerceBsvPriceGlobalConfig(raw: unknown): BsvPriceGlobalConfig | null {
  if (!isObject(raw)) return null;
  const hex = raw.pricePublisherPublicKeyHex;
  const savedAtMs = raw.savedAtMs;
  if (typeof savedAtMs !== "number" || !Number.isFinite(savedAtMs)) return null;
  if (typeof hex !== "string") return null;
  const normalized = normalizePublisherPublicKeyHex(hex);
  if (!normalized.ok || normalized.value === undefined) return null;
  return {
    pricePublisherPublicKeyHex: normalized.value,
    savedAtMs
  };
}

/**
 * 从 localStorage 读取设置。
 *
 * 失败语义：读不到 / parse 失败 / schema 坏掉 → null。
 */
export function readBsvPriceGlobalConfig(
  localStorage: Storage | null
): BsvPriceGlobalConfig | null {
  if (!localStorage) return null;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(BSV_PRICE_SETTINGS_STORAGE_KEY);
  } catch {
    return null;
  }
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return coerceBsvPriceGlobalConfig(parsed);
}

/**
 * 写入 localStorage。
 *
 * 失败语义：
 *   - storage 不可用：直接抛错；
 *   - setItem 抛错：把错误抛给调用方，由调用方决定是否回滚。
 */
export function writeBsvPriceGlobalConfig(
  localStorage: Storage | null,
  next: BsvPriceGlobalConfig
): BsvPriceGlobalConfig {
  const normalized = coerceBsvPriceGlobalConfig(next);
  if (!normalized) {
    throw new Error("invalid_config");
  }
  if (!localStorage) {
    throw new Error("local_storage_unavailable");
  }
  localStorage.setItem(BSV_PRICE_SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

/**
 * 由 localStorage 驱动的 BSV Price 设置存储。
 *
 * 设计缘由：
 *   - `bootstrapPublisherPublicKeyHex()` 用于启动 seed，写失败不应卡死；
 *   - `savePublisherPublicKeyHex()` 用于用户显式保存，失败必须抛错；
 *   - 内存真值与持久态分离，保存失败不进入半状态。
 */
export function createLocalStorageBsvPriceSettingsStore(
  localStorage: Storage | null,
  now: () => number = () => Date.now()
): BsvPriceSettingsStore {
  let current = readBsvPriceGlobalConfig(localStorage);
  const subscribers = new Set<(config: BsvPriceGlobalConfig | null) => void>();

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

  function applyNext(hex: string, persist: boolean): BsvPriceGlobalConfig {
    const normalized = normalizePublisherPublicKeyHex(hex);
    if (!normalized.ok || normalized.value === undefined) {
      throw new Error(normalized.error ?? "invalid_publisher_public_key_hex");
    }
    const next: BsvPriceGlobalConfig = {
      pricePublisherPublicKeyHex: normalized.value,
      savedAtMs: now()
    };
    if (persist) {
      writeBsvPriceGlobalConfig(localStorage, next);
    } else if (localStorage) {
      try {
        localStorage.setItem(BSV_PRICE_SETTINGS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // 启动 seed 是 best-effort；写失败不打断 service。
      }
    }
    current = next;
    emit();
    return {
      pricePublisherPublicKeyHex: next.pricePublisherPublicKeyHex,
      savedAtMs: next.savedAtMs
    };
  }

  return {
    load: () => cloneConfig(current),
    snapshot,
    bootstrapPublisherPublicKeyHex: (input) => applyNext(input, false),
    savePublisherPublicKeyHex: (input) => applyNext(input, true),
    subscribe(handler) {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    }
  };
}

function cloneConfig(input: BsvPriceGlobalConfig | null): BsvPriceGlobalConfig | null {
  if (!input) return null;
  return {
    pricePublisherPublicKeyHex: input.pricePublisherPublicKeyHex,
    savedAtMs: input.savedAtMs
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
