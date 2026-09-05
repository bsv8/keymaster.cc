// packages/plugin-woc/src/wocSettings.ts
// WOC 配置存储与校验。
// 设计缘由：WOC baseUrl 与频率是 WOC 服务配置，不属于 P2PKH。
// 缺省值与 WOC 官方文档一致：base = api.whatsonchain.com/v1/bsv。
// 硬切换 001：默认 rate 由 3 改为 2；服务端窗口、同 IP 其它请求、
// 浏览器调度误差与 429 backoff 都需要余量。
// 持久化由 Host 注入的 WOC owner/App K-V 句柄负责；本模块只负责默认值
// 与输入校验，不接触浏览器存储、Provider 或物理路径。

import type { WocConfig } from "@keymaster/contracts";

export const DEFAULT_WOC_CONFIG: WocConfig = {
  baseUrl: "https://api.whatsonchain.com/v1/bsv",
  requestsPerSecond: 2
};

/** 从 K-V 的未知值恢复合法配置；旧浏览器存储不会被读取。 */
export function normalizeWocConfig(raw: unknown): WocConfig {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_WOC_CONFIG };
  const parsed = raw as Partial<WocConfig>;
  return {
    baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : DEFAULT_WOC_CONFIG.baseUrl,
    requestsPerSecond:
      typeof parsed.requestsPerSecond === "number" && parsed.requestsPerSecond > 0
        ? parsed.requestsPerSecond
        : DEFAULT_WOC_CONFIG.requestsPerSecond
  };
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
