// packages/plugin-bsv-price/src/bsvPriceSettings.ts
// BSV Price 运行时设置存储（施工单 2026-07-08 002 硬切换）。
//
// 设计缘由：
//   - `pricePublisherPublicKeyHex` 是小型业务配置，由 Host 绑定的 K-V 句柄承载；
//   - 只保存一份运行时真值，字段固定，不引入旧存储迁移框架；
//   - 输入保存前统一 `trim + toLowerCase`，并严格校验压缩公钥 hex；
//   - 空串是合法值，表示“清空配置”；
//   - 读到坏 JSON / 坏 schema / 坏字段时，按“没有本地配置”处理。

/** K-V 中的相对配置键。 */
export const BSV_PRICE_SETTINGS_STORAGE_KEY = "settings";

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
  /** 初始化种子值：写入 K-V 队列；空值表示未配置。 */
  bootstrapPublisherPublicKeyHex(input: string): BsvPriceGlobalConfig;
  /** 保存新值并更新内存真值。 */
  savePublisherPublicKeyHex(input: string): BsvPriceGlobalConfig;
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
 * 由 Host 绑定的 K-V 驱动的 BSV Price 设置存储。
 *
 * 设计缘由：
 *   - 旧浏览器持久化不参与启动或 seed；
 *   - K-V 句柄缺失时只保留内存态，生产装配应在 Storage ready 后注入句柄。
 */
export function createKeyValueBsvPriceSettingsStore(
  storage: import("@keymaster/contracts").KeyValueStore | undefined,
  now: () => number = () => Date.now()
): BsvPriceSettingsStore {
  let current: BsvPriceGlobalConfig | null = null;
  const subscribers = new Set<(config: BsvPriceGlobalConfig | null) => void>();
  let writeQueue = Promise.resolve();

  async function ready(): Promise<void> {
    if (!storage) return;
    try {
      const entry = await storage.get<unknown>(BSV_PRICE_SETTINGS_STORAGE_KEY, { partition: "settings" });
      current = entry ? coerceBsvPriceGlobalConfig(entry.value) : null;
    } catch (error) {
      // 插件可以在 Vault 解锁前完成装载；延迟 owner 句柄此时没有 active
      // key，等 keyspace 通知后由 service 再次调用 ready()。
      if (!(error instanceof Error) || !/active key/u.test(error.message)) throw error;
    }
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

  function applyNext(hex: string, persist: boolean): BsvPriceGlobalConfig {
    const normalized = normalizePublisherPublicKeyHex(hex);
    if (!normalized.ok || normalized.value === undefined) {
      throw new Error(normalized.error ?? "invalid_publisher_public_key_hex");
    }
    const next: BsvPriceGlobalConfig = {
      pricePublisherPublicKeyHex: normalized.value,
      savedAtMs: now()
    };
    if (storage) {
      writeQueue = writeQueue
        .then(() => storage.put(BSV_PRICE_SETTINGS_STORAGE_KEY, next, { partition: "settings" }))
        .then(() => undefined)
        .catch(() => undefined);
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
    },
    ready
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
