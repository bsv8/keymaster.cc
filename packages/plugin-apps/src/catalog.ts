// packages/plugin-apps/src/catalog.ts
// 读取与校验 app 清单 JSON。
//
// 设计缘由（施工单 2026-06-29 002 硬切换）：
//   - 清单真值落在 `plugin-apps/src/appsCatalog.json`；删除插件时真值一并删除。
//   - 不引入复杂 schema 系统；只做最小校验：必填字段、URL 合法、origin 与
//     appUrl.origin 一致、id 不重复。
//   - 校验失败的 app **不**抛错，而是以"坏记录"形式返回；UI 对坏记录显示
//     明确错误态，**不**打崩整个 host。
//   - 校验逻辑走纯函数，方便 node 单测直接验证。

import rawCatalog from "./appsCatalog.json";

/** 单条 app 清单。 */
export interface AppCatalogEntry {
  id: string;
  name: string;
  summary: string;
  appOrigin: string;
  appUrl: string;
  claims: string[];
}

/** 校验失败的 app 记录：保留原始数据 + 错误原因。 */
export interface AppCatalogInvalidEntry {
  raw: unknown;
  reason: string;
  id: string | null;
}

export type AppCatalogRow =
  | { kind: "ok"; entry: AppCatalogEntry }
  | { kind: "invalid"; entry: AppCatalogInvalidEntry };

/**
 * 校验一条 app 记录。
 *
 * 校验项：
 *   - 顶层必须为对象；
 *   - 必填字段非空：`id` / `name` / `appOrigin` / `appUrl`；
 *   - `appOrigin` 是合法 origin（`URL` 解析成功且 `pathname === "/"` 或空）；
 *   - `appUrl` 是合法 URL；
 *   - `new URL(appUrl).origin === appOrigin`；
 *   - `claims` 是字符串数组（缺省视为 `[]`）。
 */
export function validateAppEntry(raw: unknown): AppCatalogRow {
  if (!raw || typeof raw !== "object") {
    return {
      kind: "invalid",
      entry: { raw, reason: "entry is not an object", id: null }
    };
  }
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" && r.id.length > 0 ? r.id : null;
  const name = typeof r.name === "string" ? r.name : "";
  const summary = typeof r.summary === "string" ? r.summary : "";
  const appOrigin = typeof r.appOrigin === "string" ? r.appOrigin : "";
  const appUrl = typeof r.appUrl === "string" ? r.appUrl : "";
  const claims = Array.isArray(r.claims)
    ? r.claims.filter((c): c is string => typeof c === "string")
    : [];

  if (!id) {
    return { kind: "invalid", entry: { raw, reason: "missing id", id: null } };
  }
  if (!name) {
    return { kind: "invalid", entry: { raw, reason: "missing name", id } };
  }
  if (!appOrigin) {
    return { kind: "invalid", entry: { raw, reason: "missing appOrigin", id } };
  }
  if (!appUrl) {
    return { kind: "invalid", entry: { raw, reason: "missing appUrl", id } };
  }
  // 校验 appOrigin 是合法 origin。
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(appOrigin);
  } catch {
    return { kind: "invalid", entry: { raw, reason: "invalid appOrigin", id } };
  }
  if (parsedOrigin.origin !== appOrigin) {
    return { kind: "invalid", entry: { raw, reason: "appOrigin is not exact origin", id } };
  }
  // 校验 appUrl 是合法 URL。
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(appUrl);
  } catch {
    return { kind: "invalid", entry: { raw, reason: "invalid appUrl", id } };
  }
  if (parsedUrl.origin !== appOrigin) {
    return {
      kind: "invalid",
      entry: { raw, reason: "appOrigin does not match appUrl.origin", id }
    };
  }
  return {
    kind: "ok",
    entry: { id, name, summary, appOrigin, appUrl, claims }
  };
}

/**
 * 校验整个 app 清单。
 *
 * 返回值：
 *   - `ok` 列表（保留输入顺序）；
 *   - `invalid` 列表；
 *   - `duplicates` 列表（id 重复的 ok entry，保留先出现的）。
 */
export interface CatalogValidation {
  ok: AppCatalogEntry[];
  invalid: AppCatalogInvalidEntry[];
  duplicates: AppCatalogEntry[];
}

export function validateCatalog(raw: unknown): CatalogValidation {
  if (!Array.isArray(raw)) {
    return { ok: [], invalid: [{ raw, reason: "catalog is not an array", id: null }], duplicates: [] };
  }
  const seen = new Set<string>();
  const ok: AppCatalogEntry[] = [];
  const invalid: AppCatalogInvalidEntry[] = [];
  const duplicates: AppCatalogEntry[] = [];
  for (const item of raw) {
    const row = validateAppEntry(item);
    if (row.kind === "invalid") {
      invalid.push(row.entry);
      continue;
    }
    if (seen.has(row.entry.id)) {
      duplicates.push(row.entry);
      continue;
    }
    seen.add(row.entry.id);
    ok.push(row.entry);
  }
  return { ok, invalid, duplicates };
}

/** 直接读取 `appsCatalog.json` 并校验。 */
export function loadCatalog(): CatalogValidation {
  return validateCatalog(rawCatalog);
}
