import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { BsvNetwork, DomainGetPublicKeyParams, DomainProfilesParams, DomainProfilesResult, ProfileResult, ProtocolErrorCode } from "keymaster-connect/protocol";

export const bsv8Suffix = "bsv8";
export interface DomainServiceInput {
  id: string;
  name: string;
  baseUrl: string;
}
export interface DomainService extends DomainServiceInput {
  suffixes: string[];
}
export interface DomainDirectory {
  list(): Promise<DomainService[]>;
  save(service: DomainService, editing: boolean): Promise<void>;
  remove(id: string): Promise<void>;
}

export class DomainSettingsError extends Error {}

function origin(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new DomainSettingsError("域名服务地址无效"); }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new DomainSettingsError("域名服务须使用 HTTPS 基址或本机 HTTP");
  }
  return url.origin;
}

function normalizeSuffix(value: string): string {
  const suffix = value.trim().replace(/^\./u, "").toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/u.test(suffix)) throw new DomainSettingsError("域名后缀无效");
  return suffix;
}

export function validateDomainDirectory(rows: DomainService[]): void {
  const owners = new Map([[bsv8Suffix, "BSV8"]]);
  const ids = new Set([bsv8Suffix]);
  for (const row of rows) {
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(row.id) || !row.name.trim() || origin(row.baseUrl) !== row.baseUrl ||
        !Array.isArray(row.suffixes) || !row.suffixes.length || ids.has(row.id.toLowerCase())) {
      throw new DomainSettingsError("第三方域名服务配置无效");
    }
    ids.add(row.id.toLowerCase());
    for (const suffix of row.suffixes) {
      if (normalizeSuffix(suffix) !== suffix) throw new DomainSettingsError("域名后缀无效");
      const owner = owners.get(suffix);
      if (owner) throw new DomainSettingsError(`域名后缀 .${suffix} 已由 ${owner} 管理`);
      owners.set(suffix, row.name);
    }
  }
}

export class DomainQueryError extends Error {
  constructor(readonly code: ProtocolErrorCode, message: string) { super(message); }
}

const unavailable = () => new DomainQueryError("domain_service_unavailable", "域名服务不可用或返回了无效的数据");

async function domainFetch(url: string, signal: AbortSignal, body?: object): Promise<unknown> {
  try {
    const response = await fetch(url, {
      signal, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer",
      ...(body === undefined ? {} : {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 404 && data?.error?.code === "name_not_found") {
        throw new DomainQueryError("name_not_found", "域名不存在或已到期");
      }
      if (response.status === 400 && data?.error?.code === "invalid_name") {
        throw new DomainQueryError("invalid_name", "域名无效");
      }
      throw unavailable();
    }
    return data;
  } catch (error) {
    if (signal.aborted || error instanceof DomainQueryError) throw error;
    throw unavailable();
  }
}

async function readSuffixes(baseUrl: string, network: BsvNetwork, signal: AbortSignal): Promise<string[]> {
  const config = await domainFetch(baseUrl + "/v1/config", signal) as { network?: unknown; service?: unknown; suffixes?: unknown } | null;
  if (config?.network === (network === "main" ? "test" : "main")) {
    throw new DomainQueryError("domain_network_mismatch", "域名服务网络与钱包网络不一致");
  }
  try {
    if (!config || config.network !== network || typeof config.service !== "string" || origin(config.service) !== baseUrl ||
        !Array.isArray(config.suffixes) || !config.suffixes.length) throw unavailable();
    const suffixes = config.suffixes.map(normalizeSuffix);
    if (new Set(suffixes).size !== suffixes.length) throw unavailable();
    return suffixes.sort();
  } catch {
    throw unavailable();
  }
}

export async function discoverDomainService(input: DomainServiceInput, network: BsvNetwork, signal: AbortSignal): Promise<DomainService> {
  if (typeof input.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(input.id) || input.id.toLowerCase() === bsv8Suffix ||
      typeof input.name !== "string" || !input.name.trim() || typeof input.baseUrl !== "string") {
    throw new DomainSettingsError("第三方域名服务配置无效");
  }
  const baseUrl = origin(input.baseUrl);
  const suffixes = await readSuffixes(baseUrl, network, AbortSignal.any([signal, AbortSignal.timeout(8_000)]));
  return { id: input.id, name: input.name.trim(), baseUrl, suffixes };
}

function validLabel(name: unknown): name is string {
  return typeof name === "string" && Boolean(name) && new TextEncoder().encode(name).length <= 255 && !/[./]/u.test(name);
}

function domainParts(domain: string): { label: string; suffix: string } {
  const [label, extension, ...extra] = domain.split(".");
  if (!validLabel(label) || extra.length) throw new DomainQueryError("invalid_name", "域名无效");
  if (extension === undefined) return { label, suffix: bsv8Suffix };
  try {
    if (extension !== extension.trim()) throw new Error();
    return { label, suffix: normalizeSuffix(extension) };
  } catch {
    throw new DomainQueryError("invalid_name", "域名无效");
  }
}

function validKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^0[23][0-9a-f]{64}$/u.test(value)) return false;
  try { secp256k1.Point.fromHex(value); return true; } catch { return false; }
}

function profileResult(value: unknown, input: string, suffixes: string[]): ProfileResult {
  const item = value as ProfileResult | null;
  if (!item || item.publicKeyHex !== input) throw unavailable();
  if ("error" in item) {
    const code = item.error?.code;
    if ("profile" in item || !["invalid_public_key", "name_not_found", "primary_name_required"].includes(code)) throw unavailable();
    return { publicKeyHex: input, error: { code } };
  }
  const profile = item.profile;
  if (!profile || profile.publicKeyHex !== input || !validKey(input) || typeof profile.domain !== "string" ||
      !Number.isSafeInteger(profile.expiresAt) || profile.expiresAt <= 0) throw unavailable();
  const [label, suffix, extra] = profile.domain.split(".");
  if (!validLabel(label) || (suffix === undefined || !suffixes.includes(suffix)) || extra !== undefined) throw unavailable();
  const image = (media: { seedHashHex: string } | undefined) => {
    if (media === undefined) return undefined;
    if (typeof media?.seedHashHex !== "string" || !/^[a-f0-9]{64}$/u.test(media.seedHashHex)) throw unavailable();
    return { seedHashHex: media.seedHashHex };
  };
  const { text } = profile;
  if (text !== undefined && (!text || typeof text !== "object" || Array.isArray(text) || !Object.values(text).every(v => typeof v === "string"))) throw unavailable();
  return { publicKeyHex: input, profile: {
    publicKeyHex: input, domain: profile.domain, expiresAt: profile.expiresAt, text,
    avatar: image(profile.avatar), header: image(profile.header),
  } };
}

export type DomainQuery =
  | { method: "domain.profiles"; params: DomainProfilesParams }
  | { method: "domain.get_public_key"; params: DomainGetPublicKeyParams };

export async function queryDomain(directory: DomainDirectory, network: BsvNetwork, query: DomainQuery, requestSignal: AbortSignal): Promise<DomainProfilesResult | { publicKeyHex: string }> {
  const target = query.method === "domain.get_public_key" ? domainParts(query.params.domain) : undefined;
  const id = query.params.serviceId;
  const suffix = target?.suffix;
  let server: DomainService | undefined;
  if ((!id || id === bsv8Suffix) && (!suffix || suffix === bsv8Suffix)) {
    const env = (import.meta as ImportMeta & { env?: Record<string, string> }).env;
    const configured = network === "test" ? env?.VITE_KEYMASTER_DOMAIN_TEST_URL : env?.VITE_KEYMASTER_DOMAIN_MAIN_URL;
    if (configured) server = { id: bsv8Suffix, name: "BSV8", baseUrl: origin(configured), suffixes: [bsv8Suffix] };
  } else {
    server = (await directory.list()).find(row => (!id || row.id === id) && (!suffix || row.suffixes.includes(suffix)));
  }
  if (!server) throw new DomainQueryError("domain_service_not_configured", "当前网络未配置指定的域名服务");
  const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(10_000)]);
  const suffixes = await readSuffixes(server.baseUrl, network, signal);
  if (suffixes.length !== server.suffixes.length || suffixes.some((v, i) => v !== server.suffixes[i])) throw unavailable();
  if (query.method === "domain.profiles") {
    const keys = query.params.publicKeys;
    const body = await domainFetch(server.baseUrl + "/v1/owners/profiles", signal, { publicKeys: keys }) as DomainProfilesResult | null;
    if (!Array.isArray(body?.results) || body.results.length !== keys.length) throw unavailable();
    return { results: body.results.map((item, index) => profileResult(item, keys[index]!, suffixes)) };
  }
  const { label, suffix: lookupSuffix } = target!;
  const record = await domainFetch(server.baseUrl + "/v1/names/" + encodeURIComponent(label) + "?suffix=" + encodeURIComponent(lookupSuffix), signal) as { owner?: { publicKeyHex?: unknown } } | null;
  const publicKeyHex = record?.owner?.publicKeyHex;
  if (!validKey(publicKeyHex)) throw unavailable();
  return { publicKeyHex };
}
