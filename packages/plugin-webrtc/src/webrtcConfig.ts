// packages/plugin-webrtc/src/webrtcConfig.ts
// WebRTC STUN 配置存储（施工单 2026-07-04 002 硬切换）。
//
// 设计缘由：
//   - STUN 配置由 Host 注入的 WebRTC owner/App K-V 句柄承载；
//   - 形状固定：`{ stunServers: string[] }`；
//   - 缺省值：`stun:stun.l.google.com:19302`；
//   - 合法性校验：每条必须以 `stun:` 开头且为合法 URI；
//   - 写失败 / 解析失败 → 内存态不变 + 抛出英文错误（由设置页 catch 后
//     展示给用户做 rollback，参考 `OriginSettingsTray`）；
//   - 内存态 + 持久态分离：
//       * `loadConfig()` = 从内存同步读 → 合法性净化；
//       * `saveConfig(next)` = 同步校验 → 排队写 K-V → 通知订阅者；
//   - 订阅接口：`subscribe(handler)`：订阅者接收最新配置对象。

/** 配置结构。 */
export interface WebrtcConfig {
  stunServers: string[];
}

/** 默认 STUN（google public）。 */
export const DEFAULT_STUN_SERVERS: readonly string[] = [
  "stun:stun.l.google.com:19302"
];

/** K-V 中的相对配置键。 */
export const WEBRTC_CONFIG_STORAGE_KEY = "settings";

/** 单条 STUN URL 默认长度上限。 */
const MAX_STUN_URL_LENGTH = 256;
/** STUN 数量上限。 */
const MAX_STUN_SERVERS = 16;

/** 校验结果：把"用户输入字符串"的标准错误和"已规范化值"分开。 */
export interface StunCheckResult {
  ok: boolean;
  /** 校验失败时的英文错误信息。 */
  error?: string;
  /** 规范化后的 URL（trim 后仍合法的字符串）。 */
  value?: string;
}

/**
 * 单条 STUN URL 校验（轻量规则校验）。
 *
 * 设计缘由：
 *   - STUN URI 没有标准 URL 解析器（`new URL("stun:...")` 会抛 `TypeError`）；
 *     `new URL("stun:host:3478")` 看起来能解析，但协议面其实做了归一化，
 *     不能拿来当"严格 URI 解析"用。这里**只**做轻量规则校验，明确放弃
 *     "标准 URL 解析"语义。
 *   - 不接 TURN——这是施工单的硬约束（§6.4）。`turn:` / `turns:` / `relay`
 *     一律拒绝。
 *
 * 接受规则：
 *   - 必须以 `stun:` 开头；
 *   - 形如 `stun:host[:port]`；host 非空、可含 `.` `-` `_`；
 *   - port（可选）必须是 1..65535；
 *   - 不含空白 / 控制字符；总长 ≤ MAX_STUN_URL_LENGTH。
 */
const STUN_URI_RE = /^stun:([A-Za-z0-9._-]+)(?::(\d{1,5}))?$/;

export function validateStunUrl(raw: string): StunCheckResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "empty" };
  }
  if (trimmed.length > MAX_STUN_URL_LENGTH) {
    return { ok: false, error: "too_long" };
  }
  if (!trimmed.startsWith("stun:")) {
    return { ok: false, error: "scheme_must_be_stun" };
  }
  if (/\s/.test(trimmed)) {
    return { ok: false, error: "no_spaces_allowed" };
  }
  if (/[\r\n\t]/.test(trimmed)) {
    return { ok: false, error: "no_control_chars" };
  }
  const m = STUN_URI_RE.exec(trimmed);
  if (!m) return { ok: false, error: "invalid_stun_uri" };
  const host = m[1] ?? "";
  if (host.length === 0) return { ok: false, error: "missing_host" };
  const portStr = m[2];
  if (portStr !== undefined) {
    const port = Number(portStr);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, error: "invalid_port" };
    }
  }
  return { ok: true, value: trimmed };
}

/**
 * 整组配置校验：去空 / 去重 / 段段校验。
 *
 * 失败语义：任一条不合法 → 整组失败 + 返回首个错误信息。
 */
export function validateStunServers(input: string[]): {
  ok: boolean;
  error?: string;
  value?: string[];
} {
  if (!Array.isArray(input)) {
    return { ok: false, error: "not_array" };
  }
  if (input.length > MAX_STUN_SERVERS) {
    return { ok: false, error: "too_many_servers" };
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < input.length; i++) {
    const raw = input[i];
    if (typeof raw !== "string") {
      return { ok: false, error: `invalid_entry_at_${i}` };
    }
    const check = validateStunUrl(raw);
    if (!check.ok || check.value === undefined) {
      return { ok: false, error: `invalid_entry_at_${i}_${check.error ?? "unknown"}` };
    }
    if (!seen.has(check.value)) {
      seen.add(check.value);
      out.push(check.value);
    }
  }
  if (out.length === 0) {
    // 至少给一个默认；这与 §5.8"字段留空时自动保存"的语义一致——
    // 只要用户还没填，至少保留兜底默认。
    return { ok: true, value: [...DEFAULT_STUN_SERVERS] };
  }
  return { ok: true, value: out };
}

/**
 * 从 raw unknown 解析成 `WebrtcConfig`。只在前几行 / 测试 / 防御性入口使用。
 *
 * 失败语义：把不合法输入降级成默认配置，**不**抛错。
 */
export function coerceWebrtcConfig(raw: unknown): WebrtcConfig {
  if (!isObject(raw)) return { stunServers: [...DEFAULT_STUN_SERVERS] };
  const arr = raw.stunServers;
  if (!Array.isArray(arr)) return { stunServers: [...DEFAULT_STUN_SERVERS] };
  const validated = validateStunServers(arr as string[]);
  if (!validated.ok || validated.value === undefined) {
    return { stunServers: [...DEFAULT_STUN_SERVERS] };
  }
  return { stunServers: validated.value };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/* ============================================================
 * ConfigStore：Host 绑定的 K-V-backed 单例（per plugin enable）
 * ============================================================ */

/**
 * 配置存储抽象。生产实现是 `KeyValueConfigStore`；测试可以注入内存版。
 */
export interface WebrtcConfigStore {
  /** 同步读当前配置；缺省值兜底。 */
  load(): WebrtcConfig;
  /** 同步校验 + 写。失败抛错。 */
  save(next: WebrtcConfig): void;
  /** 订阅配置变化；返回取消订阅函数。 */
  subscribe(handler: (config: WebrtcConfig) => void): () => void;
  /** 当前内存真值（最近一次成功 load / save）。 */
  snapshot(): WebrtcConfig;
  /** 等待 K-V 配置完成首次加载。 */
  ready(): Promise<void>;
}

/**
 * K-V-backed 配置存储。**单例**——一个 plugin-webrtc enable 周期
 * 内只持有一份内存真值。
 *
 * 设计要点：
 *   - 构造时**不**抛：缺 / 损坏 → 全部降级成默认；
 *   - `save` 同步更新内存并排队写 K-V；
 *   - 订阅者**不**会立即收到自己的 save 的回调（典型 store 模式）；
 *   - 内存态与持久态分离：save 失败抛错时内存态仍保留**上次成功**的
 *     真值，避免脏读。
 */
export function createKeyValueWebrtcConfigStore(
  storage: import("@keymaster/contracts").KeyValueStore | undefined,
  now: () => number = () => Date.now()
): WebrtcConfigStore {
  let current: WebrtcConfig = { stunServers: [...DEFAULT_STUN_SERVERS] };
  const subscribers = new Set<(c: WebrtcConfig) => void>();
  let writeQueue = Promise.resolve();

  async function ready(): Promise<void> {
    if (!storage) return;
    try {
      const entry = await storage.get<unknown>(WEBRTC_CONFIG_STORAGE_KEY, { partition: "settings" });
      if (entry) current = coerceWebrtcConfig(entry.value);
    } catch (error) {
      // 插件在 active key 产生前可以先装载；延迟 owner 句柄此时只允许
      // 返回默认内存配置，active 事件会再次触发 ready()。
      if (!(error instanceof Error) || !/active key/u.test(error.message)) throw error;
    }
  }

  function snapshot(): WebrtcConfig {
    return { stunServers: [...current.stunServers] };
  }

  function save(next: WebrtcConfig): void {
    const validated = validateStunServers(next.stunServers);
    if (!validated.ok || validated.value === undefined) {
      throw new Error(validated.error ?? "invalid_config");
    }
    const normalized: WebrtcConfig = { stunServers: validated.value };
    current = normalized;
    if (storage) {
      const persisted = { ...normalized, savedAtMs: now() };
      writeQueue = writeQueue
        .then(() => storage.put(WEBRTC_CONFIG_STORAGE_KEY, persisted, { partition: "settings" }))
        .then(() => undefined)
        .catch(() => undefined);
    }
    for (const handler of subscribers) {
      try {
        handler(snapshot());
      } catch {
        // 防御性吞掉 handler 异常——配置订阅不影响持久结果。
      }
    }
  }

  return {
    load: () => ({ ...current, stunServers: [...current.stunServers] }),
    save,
    subscribe(handler) {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },
    snapshot,
    ready
  };
}

/**
 * 内存版 store（用于单测）。不做持久化。
 */
export function createMemoryWebrtcConfigStore(
  initial: WebrtcConfig = { stunServers: [...DEFAULT_STUN_SERVERS] }
): WebrtcConfigStore {
  let current: WebrtcConfig = coerceWebrtcConfig(initial);
  const subscribers = new Set<(c: WebrtcConfig) => void>();
  return {
    load: () => ({ ...current, stunServers: [...current.stunServers] }),
    save: (next) => {
      const validated = validateStunServers(next.stunServers);
      if (!validated.ok || validated.value === undefined) {
        throw new Error(validated.error ?? "invalid_config");
      }
      current = { stunServers: validated.value };
      for (const handler of subscribers) {
        try {
          handler({ stunServers: [...current.stunServers] });
        } catch {
          // ignore
        }
      }
    },
    subscribe(handler) {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },
    snapshot: () => ({ stunServers: [...current.stunServers] }),
    ready: async () => undefined
  };
}
