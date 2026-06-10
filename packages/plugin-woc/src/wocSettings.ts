// packages/plugin-woc/src/wocSettings.ts
// WOC 配置存储与校验。
// 设计缘由：WOC baseUrl 与频率是 WOC 服务配置，不属于 P2PKH。
// 缺省值与 WOC 官方文档一致：base = api.whatsonchain.com/v1/bsv。
// 硬切换 001：默认 rate 由 3 改为 2；服务端窗口、同 IP 其它请求、
// 浏览器调度误差与 429 backoff 都需要余量。
// 持久化用 localStorage（key: woc.settings），仅保存明文 URL；不允许
// 把 API Key 写进 localStorage（施工单明确禁止）。

import type { WocConfig } from "@keymaster/contracts";

const STORAGE_KEY = "woc.settings";

export const DEFAULT_WOC_CONFIG: WocConfig = {
  baseUrl: "https://api.whatsonchain.com/v1/bsv",
  requestsPerSecond: 2
};

export function loadWocConfig(): WocConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<WocConfig>;
      return {
        baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : DEFAULT_WOC_CONFIG.baseUrl,
        requestsPerSecond:
          typeof parsed.requestsPerSecond === "number" && parsed.requestsPerSecond > 0
            ? parsed.requestsPerSecond
            : DEFAULT_WOC_CONFIG.requestsPerSecond
      };
    }
  } catch {
    // 忽略解析错误，回退到默认值。
  }
  return { ...DEFAULT_WOC_CONFIG };
}

export function saveWocConfig(config: WocConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

/** 去除尾部斜杠。 */
function trimTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

/** 校验 URL；缺省只允许 https，开发环境可显式允许 http://localhost。 */
export function validateWocBaseUrl(value: string): { ok: true; value: string } | { ok: false; error: string } {
  const trimmed = trimTrailingSlash(String(value ?? "").trim());
  if (!trimmed) {
    return { ok: false, error: "WOC base URL is required" };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: "WOC base URL is not a valid URL" };
  }
  if (url.protocol === "https:") {
    return { ok: true, value: trimmed };
  }
  if (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) {
    return { ok: true, value: trimmed };
  }
  return { ok: false, error: "WOC base URL must use https (or http://localhost for dev)" };
}

export function validateRequestsPerSecond(value: number): { ok: true; value: number } | { ok: false; error: string } {
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, error: "Requests per second must be a positive number" };
  }
  return { ok: true, value };
}
