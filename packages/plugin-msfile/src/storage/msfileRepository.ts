// MSFile 文件 Repository（KeymasterFormats：《msfiles/setting.json》与
// 《app.publickeyhex/settings.json》）。
//
// 布局：
//   - `<owner>/msfiles/setting.json`：金额上限、读取并发、用户供应商；
//   - `<owner>/app.<publisher 公钥>/settings.json`：按 appId 的 MSFile 覆盖
//     额度与本机观察（name/firstSeenAt/lastSeenAt）。
//
// 平台只提供已绑定 owner/module/purpose 的文件句柄；本文件负责格式解析、
// 严格校验和整文件读-改-写。未知顶层字段拒绝；`apps.<appId>` 下其它模块的
// 段在写回时原样保留。

import type {
  BorrowedOwnerFileStore,
  MsFileAppIdentityKey,
  MsFileAppPriceOverride,
  MsFileGlobalPriceSettings,
  MsFileReadConcurrencySettings,
  MsFileSupplierConfig,
} from "@keymaster/contracts";
import {
  MSFILE_READ_CONCURRENCY_RECOMMENDED,
  isValidMsFileSupplierPublicKeyHex,
  msFileAppPolicyKeyString,
  normalizeMsFileReadConcurrencySettings,
  normalizeMsFileSatoshiAmount,
} from "@keymaster/contracts";

const SETTING_FILE = "setting.json";
const APP_SETTINGS_FILE = "settings.json";
const MSFILES_SETTING_FORMAT = "keymaster.msfiles-setting";
const APP_SETTINGS_FORMAT = "keymaster.app-settings";
/** 单文件上限，与 KeymasterFormats 文档一致。 */
const MAX_SETTING_FILE_BYTES = 32 * 1024;
const MAX_APP_SETTINGS_FILE_BYTES = 16 * 1024;
const MAX_SUPPLIERS = 64;
const MAX_SUPPLIER_NAME_BYTES = 200;
const MAX_ADDRESSES_PER_SUPPLIER = 16;
const MAX_ADDRESS_BYTES = 2_048;
const MAX_APP_NAME_LENGTH = 256;
const APP_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?$/u;

export interface MsFileRepository {
  getGlobalSettings(): Promise<MsFileGlobalSettingsSnapshot | null>;
  putGlobalSettings(settings: MsFileGlobalPriceSettings, updatedAt: number): Promise<void>;
  putReadConcurrencySettings(settings: MsFileReadConcurrencySettings, updatedAt: number): Promise<void>;
  putMediaBlockReadConcurrency(settings: { mediaBlockReadConcurrency: number } | number, updatedAt: number): Promise<void>;
  listSuppliers(): Promise<MsFileSupplierConfig[]>;
  getSupplier(supplierPublicKeyHex: string): Promise<MsFileSupplierConfig | null>;
  upsertSupplier(config: MsFileSupplierConfig): Promise<void>;
  deleteSupplier(supplierPublicKeyHex: string): Promise<void>;
  listAppPolicies(): Promise<StoredAppPolicyRow[]>;
  getAppPolicy(key: MsFileAppIdentityKey): Promise<StoredAppPolicyRow | null>;
  putAppPolicy(record: StoredAppPolicyRow): Promise<void>;
  deleteAppPolicy(key: MsFileAppIdentityKey): Promise<void>;
  listAppUsages(): Promise<StoredAppUsageRow[]>;
  touchAppUsage(key: MsFileAppIdentityKey, appName: string, now: number): Promise<void>;
  close(): void;
}

export interface StoredAppPolicyRow {
  policyKey: string;
  key: MsFileAppIdentityKey;
  override: MsFileAppPriceOverride;
  updatedAt: number;
}

export interface StoredAppUsageRow {
  usageKey: string;
  key: MsFileAppIdentityKey;
  appName: string;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface MsFileGlobalSettingsSnapshot {
  settings: MsFileGlobalPriceSettings | null;
  mediaBlockReadConcurrency?: number;
  globalSeedReadConcurrency?: number;
  globalBlockReadConcurrency?: number;
  globalStatConcurrency?: number;
  updatedAt: number | null;
}

/**
 * Repository 依赖的文件句柄。
 *
 * settings 是 `<owner>/msfiles/`；appSettings 按 publisher 打开
 * `<owner>/app.<publisher>/`；listAppPublishers 只枚举目录名，用于授权列表。
 */
export interface MsFileRepositoryStores {
  /** 当前 active owner；用于生成 App 授权行的稳定身份键。 */
  ownerPublicKeyHex: string;
  settings: BorrowedOwnerFileStore;
  appSettings(publisherPublicKeyHex: string): BorrowedOwnerFileStore;
  listAppPublishers(): Promise<string[]>;
}

interface StoredSettingSnapshot {
  priceLimits: MsFileGlobalPriceSettings | null;
  readConcurrency: MsFileReadConcurrencySettings;
  suppliers: MsFileSupplierConfig[];
}

interface StoredAppEntry {
  name: string;
  firstSeenAt: string;
  lastSeenAt: string;
  msfiles?: MsFileAppPriceOverride;
}

interface ParsedAppSettings {
  /** 原样保留的 JSON 对象；写回未知模块段时使用。 */
  raw: Record<string, unknown>;
  apps: Map<string, StoredAppEntry>;
}

function fail(message: string): never {
  throw new Error(message);
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

function assertKnownKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) fail(`${label} has an unknown field: ${key}`);
  }
}

function decodeJsonObject(bytes: Uint8Array, maxBytes: number, label: string): Record<string, unknown> {
  if (bytes.byteLength > maxBytes) fail(`${label} is too large`);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail(`${label} is not valid UTF-8 JSON`);
  }
  return expectRecord(value, label);
}

function encodeJsonObject(value: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

function parseIsoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") fail(`${label} must be an ISO-8601 string`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail(`${label} must be a valid ISO-8601 timestamp`);
  return new Date(parsed).toISOString();
}

function parseSupplier(value: unknown, index: number): MsFileSupplierConfig {
  const label = `MSFile setting.json suppliers[${index}]`;
  const record = expectRecord(value, label);
  assertKnownKeys(record, ["name", "publicKeyHex", "addresses", "enabled"], label);
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (name.length === 0 || new TextEncoder().encode(name).length > MAX_SUPPLIER_NAME_BYTES) fail(`${label}.name is invalid`);
  const publicKeyHex = typeof record.publicKeyHex === "string" ? record.publicKeyHex.toLowerCase() : "";
  if (!isValidMsFileSupplierPublicKeyHex(publicKeyHex)) fail(`${label}.publicKeyHex is invalid`);
  if (!Array.isArray(record.addresses) || record.addresses.length < 1 || record.addresses.length > MAX_ADDRESSES_PER_SUPPLIER) {
    fail(`${label}.addresses is invalid`);
  }
  const addresses: string[] = [];
  for (const entry of record.addresses) {
    if (typeof entry !== "string") fail(`${label}.addresses is invalid`);
    const address = entry.trim();
    if (address.length === 0 || address.length > MAX_ADDRESS_BYTES) fail(`${label}.addresses is invalid`);
    if (!addresses.includes(address)) addresses.push(address);
  }
  if (typeof record.enabled !== "boolean") fail(`${label}.enabled is invalid`);
  return { name, supplierPublicKeyHex: publicKeyHex, addresses, enabled: record.enabled };
}

function parseSettingFile(bytes: Uint8Array): StoredSettingSnapshot {
  const label = "MSFile setting.json";
  const record = decodeJsonObject(bytes, MAX_SETTING_FILE_BYTES, label);
  assertKnownKeys(record, ["format", "version", "priceLimits", "readConcurrency", "suppliers"], label);
  if (record.format !== MSFILES_SETTING_FORMAT || record.version !== 1) fail(`${label} format/version is invalid`);

  let priceLimits: MsFileGlobalPriceSettings | null = null;
  if (record.priceLimits !== undefined) {
    const limits = expectRecord(record.priceLimits, `${label} priceLimits`);
    assertKnownKeys(limits, ["seedMaxPriceSatoshis", "blockMaxPriceSatoshis"], `${label} priceLimits`);
    const seedMaxPriceSatoshis = normalizeMsFileSatoshiAmount(limits.seedMaxPriceSatoshis);
    const blockMaxPriceSatoshis = normalizeMsFileSatoshiAmount(limits.blockMaxPriceSatoshis);
    if (seedMaxPriceSatoshis === undefined || blockMaxPriceSatoshis === undefined) fail(`${label} priceLimits is invalid`);
    priceLimits = { seedMaxPriceSatoshis, blockMaxPriceSatoshis };
  }

  let readConcurrency: MsFileReadConcurrencySettings = { ...MSFILE_READ_CONCURRENCY_RECOMMENDED };
  if (record.readConcurrency !== undefined) {
    const candidate = expectRecord(record.readConcurrency, `${label} readConcurrency`);
    assertKnownKeys(candidate, [
      "mediaBlockReadConcurrency",
      "globalSeedReadConcurrency",
      "globalBlockReadConcurrency",
      "globalStatConcurrency",
    ], `${label} readConcurrency`);
    const normalized = normalizeMsFileReadConcurrencySettings({
      mediaBlockReadConcurrency: candidate.mediaBlockReadConcurrency ?? MSFILE_READ_CONCURRENCY_RECOMMENDED.mediaBlockReadConcurrency,
      globalSeedReadConcurrency: candidate.globalSeedReadConcurrency ?? MSFILE_READ_CONCURRENCY_RECOMMENDED.globalSeedReadConcurrency,
      globalBlockReadConcurrency: candidate.globalBlockReadConcurrency ?? MSFILE_READ_CONCURRENCY_RECOMMENDED.globalBlockReadConcurrency,
      globalStatConcurrency: candidate.globalStatConcurrency ?? MSFILE_READ_CONCURRENCY_RECOMMENDED.globalStatConcurrency,
    });
    if (!normalized) fail(`${label} readConcurrency is invalid`);
    readConcurrency = normalized;
  }

  let suppliers: MsFileSupplierConfig[] = [];
  if (record.suppliers !== undefined) {
    if (!Array.isArray(record.suppliers) || record.suppliers.length > MAX_SUPPLIERS) fail(`${label} suppliers is invalid`);
    const seen = new Set<string>();
    suppliers = record.suppliers.map((entry, index) => {
      const parsed = parseSupplier(entry, index);
      if (seen.has(parsed.supplierPublicKeyHex)) fail(`${label} suppliers has a duplicate public key`);
      seen.add(parsed.supplierPublicKeyHex);
      return parsed;
    });
  }
  return { priceLimits, readConcurrency, suppliers };
}

function serializeSettingFile(snapshot: StoredSettingSnapshot): Uint8Array {
  const record: Record<string, unknown> = {
    format: MSFILES_SETTING_FORMAT,
    version: 1,
    ...(snapshot.priceLimits === null ? {} : {
      priceLimits: {
        seedMaxPriceSatoshis: snapshot.priceLimits.seedMaxPriceSatoshis,
        blockMaxPriceSatoshis: snapshot.priceLimits.blockMaxPriceSatoshis,
      },
    }),
    readConcurrency: { ...snapshot.readConcurrency },
    ...(snapshot.suppliers.length === 0 ? {} : {
      suppliers: snapshot.suppliers.map((supplier) => ({
        name: supplier.name,
        publicKeyHex: supplier.supplierPublicKeyHex,
        addresses: [...supplier.addresses],
        enabled: supplier.enabled,
      })),
    }),
  };
  return encodeJsonObject(record);
}

function parseAppEntry(value: unknown, appId: string): StoredAppEntry {
  const label = `MSFile app settings apps.${appId}`;
  const record = expectRecord(value, label);
  if (typeof record.name !== "string" || record.name.length === 0 || record.name.length > MAX_APP_NAME_LENGTH) fail(`${label}.name is invalid`);
  const firstSeenAt = parseIsoTimestamp(record.firstSeenAt, `${label}.firstSeenAt`);
  const lastSeenAt = parseIsoTimestamp(record.lastSeenAt, `${label}.lastSeenAt`);
  if (Date.parse(lastSeenAt) < Date.parse(firstSeenAt)) fail(`${label}.lastSeenAt is before firstSeenAt`);
  let msfiles: MsFileAppPriceOverride | undefined;
  if (record.msfiles !== undefined) {
    const section = expectRecord(record.msfiles, `${label}.msfiles`);
    assertKnownKeys(section, ["seedMaxPriceSatoshis", "blockMaxPriceSatoshis"], `${label}.msfiles`);
    const sanitized = sanitizeAppOverride(section);
    if (sanitized === undefined && Object.keys(section).length > 0) fail(`${label}.msfiles is invalid`);
    msfiles = sanitized;
  }
  return { name: record.name, firstSeenAt, lastSeenAt, ...(msfiles === undefined ? {} : { msfiles }) };
}

function parseAppSettingsFile(bytes: Uint8Array, expectedPublisherPublicKeyHex: string): ParsedAppSettings {
  const label = "MSFile app settings.json";
  const raw = decodeJsonObject(bytes, MAX_APP_SETTINGS_FILE_BYTES, label);
  assertKnownKeys(raw, ["format", "version", "publisherPublicKeyHex", "apps"], label);
  if (raw.format !== APP_SETTINGS_FORMAT || raw.version !== 1) fail(`${label} format/version is invalid`);
  if (raw.publisherPublicKeyHex !== expectedPublisherPublicKeyHex) fail(`${label} publisher does not match its directory`);
  const appsRecord = expectRecord(raw.apps, `${label} apps`);
  const apps = new Map<string, StoredAppEntry>();
  for (const [appId, entry] of Object.entries(appsRecord)) {
    if (!APP_ID_PATTERN.test(appId)) fail(`${label} has an invalid appId: ${appId}`);
    apps.set(appId, parseAppEntry(entry, appId));
  }
  return { raw, apps };
}

function serializeAppSettingsFile(
  raw: Record<string, unknown>,
  publisherPublicKeyHex: string,
  apps: Record<string, unknown>,
): Uint8Array {
  const record = {
    ...raw,
    format: APP_SETTINGS_FORMAT,
    version: 1,
    publisherPublicKeyHex,
    apps,
  };
  return encodeJsonObject(record);
}

export function isValidPersistedSupplier(value: unknown): value is MsFileSupplierConfig {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<MsFileSupplierConfig>;
  return typeof record.name === "string" && isValidMsFileSupplierPublicKeyHex(record.supplierPublicKeyHex) && Array.isArray(record.addresses) && record.addresses.length > 0 && record.addresses.every((address) => typeof address === "string") && typeof record.enabled === "boolean";
}

export function sanitizeAppOverride(input: unknown): MsFileAppPriceOverride | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  const override: MsFileAppPriceOverride = {};
  let found = false;
  for (const field of ["seedMaxPriceSatoshis", "blockMaxPriceSatoshis"] as const) {
    const value = record[field];
    if (value === undefined) continue;
    if (normalizeMsFileSatoshiAmount(value) === undefined) return undefined;
    override[field] = value as string;
    found = true;
  }
  return found ? override : undefined;
}

export async function openMsFileRepository(stores: MsFileRepositoryStores): Promise<MsFileRepository> {
  if (!stores?.settings || typeof stores.appSettings !== "function" || typeof stores.listAppPublishers !== "function") {
    throw new Error("MSFile file storage bindings are required");
  }
  const ownerPublicKeyHex = stores.ownerPublicKeyHex;
  if (typeof ownerPublicKeyHex !== "string" || !isValidMsFileSupplierPublicKeyHex(ownerPublicKeyHex)) {
    throw new Error("MSFile owner public key is invalid");
  }
  let closed = false;
  const assertOpen = () => { if (closed) throw new Error("MSFile storage is closed"); };

  const readSetting = async (): Promise<StoredSettingSnapshot> => {
    const file = await stores.settings.get(SETTING_FILE);
    if (!file) {
      return {
        priceLimits: null,
        readConcurrency: { ...MSFILE_READ_CONCURRENCY_RECOMMENDED },
        suppliers: [],
      };
    }
    return parseSettingFile(file.bytes);
  };
  const writeSetting = async (snapshot: StoredSettingSnapshot): Promise<void> => {
    await stores.settings.put(SETTING_FILE, serializeSettingFile(snapshot));
  };
  const mutateSetting = async (mutate: (snapshot: StoredSettingSnapshot) => void): Promise<void> => {
    const snapshot = await readSetting();
    mutate(snapshot);
    await writeSetting(snapshot);
  };

  const readAppSettings = async (publisherPublicKeyHex: string): Promise<ParsedAppSettings> => {
    const file = await stores.appSettings(publisherPublicKeyHex).get(APP_SETTINGS_FILE);
    if (!file) {
      return {
        raw: { format: APP_SETTINGS_FORMAT, version: 1, publisherPublicKeyHex, apps: {} },
        apps: new Map(),
      };
    }
    return parseAppSettingsFile(file.bytes, publisherPublicKeyHex);
  };
  const mutateAppEntry = async (
    key: MsFileAppIdentityKey,
    mutate: (entry: Record<string, unknown>, appId: string) => void,
  ): Promise<void> => {
    const publisher = key.publisherPublicKeyHex;
    const { raw } = await readAppSettings(publisher);
    const apps = { ...expectRecord(raw.apps, "MSFile app settings.json apps") };
    const appId = key.appId;
    const existing = apps[appId];
    const entry = existing !== undefined && typeof existing === "object" && existing !== null && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
    mutate(entry, appId);
    // 写前校验已知字段；未知模块段原样保留。
    parseAppEntry(entry, appId);
    apps[appId] = entry;
    await stores.appSettings(publisher).put(APP_SETTINGS_FILE, serializeAppSettingsFile(raw, publisher, apps));
  };

  return {
    async getGlobalSettings() {
      assertOpen();
      const file = await stores.settings.get(SETTING_FILE);
      if (!file) return null;
      const snapshot = parseSettingFile(file.bytes);
      return {
        settings: snapshot.priceLimits,
        ...snapshot.readConcurrency,
        updatedAt: null,
      };
    },
    async putGlobalSettings(settings, updatedAt) {
      assertOpen();
      void updatedAt;
      await mutateSetting((snapshot) => {
        snapshot.priceLimits = {
          seedMaxPriceSatoshis: settings.seedMaxPriceSatoshis,
          blockMaxPriceSatoshis: settings.blockMaxPriceSatoshis,
        };
      });
    },
    async putReadConcurrencySettings(settings, updatedAt) {
      assertOpen();
      void updatedAt;
      const normalized = normalizeMsFileReadConcurrencySettings(settings);
      if (!normalized) throw new Error("invalid MSFile read concurrency settings");
      await mutateSetting((snapshot) => { snapshot.readConcurrency = normalized; });
    },
    async putMediaBlockReadConcurrency(input, updatedAt) {
      assertOpen();
      void updatedAt;
      const snapshot = await readSetting();
      const requested = typeof input === "number" ? input : input.mediaBlockReadConcurrency;
      const normalized = normalizeMsFileReadConcurrencySettings({
        ...snapshot.readConcurrency,
        mediaBlockReadConcurrency: requested,
      });
      if (!normalized) throw new Error("invalid MSFile read concurrency settings");
      snapshot.readConcurrency = normalized;
      await writeSetting(snapshot);
    },
    async listSuppliers() {
      assertOpen();
      return (await readSetting()).suppliers.map((supplier) => ({ ...supplier, addresses: [...supplier.addresses] }));
    },
    async getSupplier(supplierPublicKeyHex) {
      assertOpen();
      const supplier = (await readSetting()).suppliers.find((entry) => entry.supplierPublicKeyHex === supplierPublicKeyHex);
      return supplier ? { ...supplier, addresses: [...supplier.addresses] } : null;
    },
    async upsertSupplier(config) {
      assertOpen();
      await mutateSetting((snapshot) => {
        const next = snapshot.suppliers.filter((entry) => entry.supplierPublicKeyHex !== config.supplierPublicKeyHex);
        if (next.length >= MAX_SUPPLIERS) throw new Error("MSFile supplier limit reached");
        next.push({ ...config, addresses: [...config.addresses] });
        snapshot.suppliers = next;
      });
    },
    async deleteSupplier(supplierPublicKeyHex) {
      assertOpen();
      await mutateSetting((snapshot) => {
        snapshot.suppliers = snapshot.suppliers.filter((entry) => entry.supplierPublicKeyHex !== supplierPublicKeyHex);
      });
    },
    async listAppPolicies() {
      assertOpen();
      const rows: StoredAppPolicyRow[] = [];
      for (const publisher of await stores.listAppPublishers()) {
        const { apps } = await readAppSettings(publisher);
        for (const [appId, entry] of apps) {
          if (!entry.msfiles) continue;
          const key: MsFileAppIdentityKey = { ownerPublicKeyHex, publisherPublicKeyHex: publisher, appId };
          rows.push({
            policyKey: msFileAppPolicyKeyString(key),
            key,
            override: { ...entry.msfiles },
            updatedAt: Date.parse(entry.lastSeenAt),
          });
        }
      }
      return rows;
    },
    async getAppPolicy(key) {
      assertOpen();
      const { apps } = await readAppSettings(key.publisherPublicKeyHex);
      const entry = apps.get(key.appId);
      if (!entry?.msfiles) return null;
      return {
        policyKey: msFileAppPolicyKeyString(key),
        key: { ...key },
        override: { ...entry.msfiles },
        updatedAt: Date.parse(entry.lastSeenAt),
      };
    },
    async putAppPolicy(record) {
      assertOpen();
      const override = sanitizeAppOverride(record.override);
      if (override === undefined) throw new Error("override must contain at least one canonical amount field");
      const nowIso = new Date(Number.isFinite(record.updatedAt) ? record.updatedAt : Date.now()).toISOString();
      await mutateAppEntry(record.key, (entry) => {
        if (typeof entry.name !== "string" || entry.name.length === 0) entry.name = record.key.appId;
        if (typeof entry.firstSeenAt !== "string") entry.firstSeenAt = nowIso;
        if (typeof entry.lastSeenAt !== "string") entry.lastSeenAt = nowIso;
        entry.msfiles = { ...override };
      });
    },
    async deleteAppPolicy(key) {
      assertOpen();
      await mutateAppEntry(key, (entry) => { delete entry.msfiles; });
    },
    async listAppUsages() {
      assertOpen();
      const rows: StoredAppUsageRow[] = [];
      for (const publisher of await stores.listAppPublishers()) {
        const { apps } = await readAppSettings(publisher);
        for (const [appId, entry] of apps) {
          const key: MsFileAppIdentityKey = { ownerPublicKeyHex, publisherPublicKeyHex: publisher, appId };
          rows.push({
            usageKey: msFileAppPolicyKeyString(key),
            key,
            appName: entry.name,
            firstSeenAt: Date.parse(entry.firstSeenAt),
            lastSeenAt: Date.parse(entry.lastSeenAt),
          });
        }
      }
      return rows;
    },
    async touchAppUsage(key, appName, now) {
      assertOpen();
      if (typeof appName !== "string" || appName.length === 0 || appName.length > MAX_APP_NAME_LENGTH) {
        throw new Error("appName is invalid");
      }
      const nowIso = new Date(now).toISOString();
      await mutateAppEntry(key, (entry) => {
        entry.name = appName;
        if (typeof entry.firstSeenAt !== "string") entry.firstSeenAt = nowIso;
        entry.lastSeenAt = nowIso;
      });
    },
    close() {
      closed = true;
    },
  };
}
