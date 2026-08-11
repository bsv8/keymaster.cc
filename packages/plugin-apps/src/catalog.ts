// packages/plugin-apps/src/catalog.ts
// Keymaster 本地 app catalog 及签名 proof 门禁。
//
// catalog 是 launcher 的唯一信任根：签名 proof 不从部署站点获取，也不允许
// 调用方覆盖。缺少 proof 的条目明确禁用，避免启动后再失败。

import rawCatalog from "./appsCatalog.json";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { AppIdentityProofV1, AppCatalogResolver, AppRequirement } from "@keymaster/contracts";

/** 本地 launcher row；proof 之外的字段只用于展示和导航。 */
export interface AppCatalogEntry {
  id: string;
  name: string;
  summary: string;
  appOrigin: string;
  appUrl: string;
  claims: string[];
  appIdentity: AppIdentityProofV1;
  /** lucide-react 图标名称或静态 SVG 路径。 */
  icon?: string;
}

/** 将本地 catalog 暴露为协议 resolver；invalid row 保持已知阻断态。 */
export function createCatalogResolver(validation = loadCatalog()): AppCatalogResolver {
  const byOrigin = new Map<string, AppCatalogRow>();
  for (const entry of validation.ok) byOrigin.set(entry.appOrigin, { kind: "ok", entry });
  for (const entry of validation.invalid) {
    const raw = entry.raw as Record<string, unknown> | null;
    const origin = raw && typeof raw === "object" && typeof raw.appOrigin === "string" ? raw.appOrigin : undefined;
    if (origin) byOrigin.set(origin, { kind: "invalid", entry });
  }
  return {
    resolve(origin) {
      const row = byOrigin.get(origin);
      if (!row) return { kind: "unknown" };
      if (row.kind === "invalid") return { kind: "known-invalid", reason: row.entry.reason };
      return { kind: "known-valid", proof: row.entry.appIdentity, appId: row.entry.id };
    }
  };
}

export interface AppCatalogInvalidEntry {
  raw: unknown;
  reason: string;
  id: string | null;
}

export type AppCatalogRow =
  | { kind: "ok"; entry: AppCatalogEntry }
  | { kind: "invalid"; entry: AppCatalogInvalidEntry };

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?$/u;
const REQUIREMENTS = new Set<AppRequirement>(["private-key", "storage"]);

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, i) => key === expected[i]);
}

/** 与 plugin-protocol 保持一致的 RFC 8785 兼容 JCS 编码。 */
function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("identity payload contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const entries = Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(object[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new Error("identity payload contains an unsupported value");
}

/** 严格校验并验签 proof；catalog 启动门禁必须 fail closed。 */
export function validateAppIdentityProof(value: unknown): AppIdentityProofV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("appIdentity must be an object");
  }
  const object = value as Record<string, unknown>;
  if (!exactKeys(object, ["version", "publisherPublicKey", "app", "requirements", "signature"])) {
    throw new Error("appIdentity has unexpected fields");
  }
  const publisherPublicKey = object.publisherPublicKey;
  if (
    object.version !== 1 ||
    typeof publisherPublicKey !== "string" ||
    !/^(02|03)[0-9a-f]{64}$/u.test(publisherPublicKey)
  ) {
    throw new Error("invalid publisher public key");
  }
  try {
    const bytes = Uint8Array.from(
      publisherPublicKey.match(/.{2}/gu)!.map((part) => Number.parseInt(part, 16))
    );
    if (!secp256k1.utils.isValidPublicKey(bytes)) throw new Error("invalid point");
  } catch {
    throw new Error("invalid publisher public key");
  }
  if (!object.app || typeof object.app !== "object" || Array.isArray(object.app)) {
    throw new Error("appIdentity app must be an object");
  }
  const app = object.app as Record<string, unknown>;
  if (
    !exactKeys(app, ["id", "name", "description"]) ||
    typeof app.id !== "string" ||
    !ID_PATTERN.test(app.id)
  ) {
    throw new Error("invalid app id");
  }
  if (
    typeof app.name !== "string" ||
    !app.name.trim() ||
    app.name !== app.name.trim() ||
    [...app.name].length > 120 ||
    [...app.name].some((c) => /[\u0000-\u001f\u007f-\u009f\ufffd]/u.test(c))
  ) {
    throw new Error("invalid app name");
  }
  if (
    typeof app.description !== "string" ||
    !app.description.trim() ||
    app.description !== app.description.trim() ||
    [...app.description].length > 500 ||
    [...app.description].some((c) => /[\u0000-\u001f\u007f-\u009f\ufffd]/u.test(c))
  ) {
    throw new Error("invalid app description");
  }
  if (!Array.isArray(object.requirements)) {
    throw new Error("appIdentity requirements must be an array");
  }
  const requirements = object.requirements.map((requirement) => {
    if (typeof requirement !== "string" || !REQUIREMENTS.has(requirement as AppRequirement)) {
      throw new Error("unknown app requirement");
    }
    return requirement as AppRequirement;
  });
  if (
    new Set(requirements).size !== requirements.length ||
    requirements.some(
      (requirement, index) => index > 0 && requirements[index - 1]! >= requirement
    )
  ) {
    throw new Error("requirements must be sorted and unique");
  }
  if (typeof object.signature !== "string" || !/^[0-9a-f]{128}$/u.test(object.signature)) {
    throw new Error("invalid appIdentity signature");
  }
  const payload = canonicalizeJson({
    app: { description: app.description, id: app.id, name: app.name },
    publisherPublicKey,
    requirements,
    version: 1
  });
  const domain = new TextEncoder().encode("keymaster-app-identity:v1");
  const bytes = new TextEncoder().encode(payload);
  const signed = new Uint8Array(domain.length + 1 + bytes.length);
  signed.set(domain);
  signed[domain.length] = 0;
  signed.set(bytes, domain.length + 1);
  const digest = sha256(signed);
  try {
    if (
      !secp256k1.verify(
        Uint8Array.from(
          (object.signature as string).match(/.{2}/gu)!.map((part) => Number.parseInt(part, 16))
        ),
        digest,
        Uint8Array.from(
          (publisherPublicKey as string).match(/.{2}/gu)!.map((part) => Number.parseInt(part, 16))
        ),
        { prehash: false, format: "compact" }
      )
    ) throw new Error();
  } catch {
    throw new Error("invalid appIdentity signature");
  }
  return {
    version: 1,
    publisherPublicKey,
    app: {
      id: app.id as string,
      name: app.name as string,
      description: app.description as string
    },
    requirements,
    signature: object.signature
  };
}

/** 校验一条本地 catalog row；proof 有值时必须完整通过门禁。 */
export function validateAppEntry(raw: unknown): AppCatalogRow {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { kind: "invalid", entry: { raw, reason: "entry is not an object", id: null } };
  }
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" && r.id.length > 0 ? r.id : null;
  if (!id) return { kind: "invalid", entry: { raw, reason: "missing id", id: null } };
  const name = typeof r.name === "string" ? r.name : "";
  const summary = typeof r.summary === "string" ? r.summary : "";
  const appOrigin = typeof r.appOrigin === "string" ? r.appOrigin : "";
  const appUrl = typeof r.appUrl === "string" ? r.appUrl : "";
  const claims =
    Array.isArray(r.claims) && r.claims.every((claim) => typeof claim === "string")
      ? ([...r.claims] as string[])
      : [];
  const icon = typeof r.icon === "string" && r.icon.length > 0 ? r.icon : undefined;
  if (!name) return { kind: "invalid", entry: { raw, reason: "missing name", id } };
  if (!appOrigin) return { kind: "invalid", entry: { raw, reason: "missing appOrigin", id } };
  if (!appUrl) return { kind: "invalid", entry: { raw, reason: "missing appUrl", id } };
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(appOrigin);
  } catch {
    return { kind: "invalid", entry: { raw, reason: "invalid appOrigin", id } };
  }
  if (parsedOrigin.origin !== appOrigin) {
    return { kind: "invalid", entry: { raw, reason: "appOrigin is not exact origin", id } };
  }
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
  let appIdentity: AppIdentityProofV1 | undefined;
  if (r.appIdentity !== undefined) {
    try {
      appIdentity = validateAppIdentityProof(r.appIdentity);
    } catch (error) {
      return {
        kind: "invalid",
        entry: {
          raw,
          reason: error instanceof Error ? error.message : "invalid appIdentity",
          id
        }
      };
    }
    // launcher row id is intentionally independent (Demo uses `demo`), while
    // proof app.id remains the stable storage namespace identity.
  }
  if (!appIdentity) return { kind: "invalid", entry: { raw, reason: "missing appIdentity proof", id } };
  return {
    kind: "ok",
    entry: {
      id,
      name,
      summary,
      appOrigin,
      appUrl,
      claims,
      icon,
      appIdentity
    }
  };
}

export interface CatalogValidation {
  ok: AppCatalogEntry[];
  invalid: AppCatalogInvalidEntry[];
  duplicates: AppCatalogEntry[];
}

export function validateCatalog(raw: unknown): CatalogValidation {
  if (!Array.isArray(raw)) return { ok: [], invalid: [{ raw, reason: "catalog is not an array", id: null }], duplicates: [] };
  const seen = new Set<string>();
  const seenOrigins = new Set<string>();
  const ok: AppCatalogEntry[] = [];
  const invalid: AppCatalogInvalidEntry[] = [];
  const duplicates: AppCatalogEntry[] = [];
  for (const item of raw) {
    const row = validateAppEntry(item);
    if (row.kind === "invalid") { invalid.push(row.entry); continue; }
    // origin 同样是信任 lookup key；重复 origin 必须保持首条真值，后条
    // 进入 duplicate，防止 Map 静默覆盖导致 caller 选到未授权 metadata。
    if (seen.has(row.entry.id) || seenOrigins.has(row.entry.appOrigin)) { duplicates.push(row.entry); continue; }
    seen.add(row.entry.id);
    seenOrigins.add(row.entry.appOrigin);
    ok.push(row.entry);
  }
  return { ok, invalid, duplicates };
}

/** 读取并严格校验内嵌 catalog。 */
export function loadCatalog(): CatalogValidation { return validateCatalog(rawCatalog); }
