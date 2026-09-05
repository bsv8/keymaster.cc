// MSFile 平台 K-V Repository。
//
// MSFile 设置、Supplier、App 策略和使用记录属于平台运行时状态，统一写入
// `MSFile` platform namespace。生产 Coordinator 必须注入已绑定的句柄；无参
// 入口只创建内存夹具，供单元测试使用，不连接浏览器持久化 API。

import type {
  KeyValueStore,
  MsFileAppIdentityKey,
  MsFileAppPriceOverride,
  MsFileGlobalPriceSettings,
  MsFileReadConcurrencySettings,
  MsFileSupplierConfig
} from "@keymaster/contracts";
import {
  MSFILE_READ_CONCURRENCY_RECOMMENDED,
  isValidMsFileSupplierPublicKeyHex,
  msFileAppPolicyKeyString,
  normalizeMsFileReadConcurrencySettings
} from "@keymaster/contracts";
import { createInMemoryKeyValueStore } from "@keymaster/runtime";

export const MSFILE_STORAGE_ID = "MSFile";
export const MSFILE_STORAGE_VERSION = 1;
const SETTINGS_PARTITION = "settings";
const SUPPLIERS_PARTITION = "suppliers";
const POLICIES_PARTITION = "policies";
const USAGES_PARTITION = "usages";
const SETTINGS_KEY = "singleton";
const SUPPLIER_PREFIX = "supplier/";
const POLICY_PREFIX = "policy/";
const USAGE_PREFIX = "usage/";
const LEGACY_MEDIA_PLAYBACK_DEFAULT = 5;
const LEGACY_MEDIA_PLAYBACK_MIN = 2;
const LEGACY_MEDIA_PLAYBACK_MAX = 64;

interface GlobalSettingsRow {
  key: "singleton";
  settings: MsFileGlobalPriceSettings | null;
  /** 历史媒体预取字段；保留为平台设置的一部分，现行读取路径不依赖它。 */
  mediaPlaybackPrefetchBlocks?: number;
  mediaBlockReadConcurrency?: number;
  globalSeedReadConcurrency?: number;
  globalBlockReadConcurrency?: number;
  globalStatConcurrency?: number;
  updatedAt: number;
}

interface LegacyMediaPlaybackSettings { mediaPlaybackPrefetchBlocks: number; }

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

export interface MsFileRepository {
  getGlobalSettings(): Promise<MsFileGlobalSettingsSnapshot | null>;
  putGlobalSettings(settings: MsFileGlobalPriceSettings, updatedAt: number, mediaPlaybackPrefetchBlocks?: number): Promise<void>;
  putReadConcurrencySettings(settings: MsFileReadConcurrencySettings, updatedAt: number): Promise<void>;
  putMediaBlockReadConcurrency(settings: { mediaBlockReadConcurrency: number } | number, updatedAt: number): Promise<void>;
  putMediaPlaybackPrefetchBlocks?(settings: LegacyMediaPlaybackSettings, updatedAt: number): Promise<void>;
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

export interface MsFileGlobalSettingsSnapshot {
  settings: MsFileGlobalPriceSettings | null;
  /** 历史字段，仅用于保持设置读写稳定。 */
  mediaPlaybackPrefetchBlocks?: number;
  mediaBlockReadConcurrency?: number;
  globalSeedReadConcurrency?: number;
  globalBlockReadConcurrency?: number;
  globalStatConcurrency?: number;
  updatedAt: number | null;
}

function createTestStore(): KeyValueStore {
  return createInMemoryKeyValueStore({ scope: "key", ownerPublicKeyHex: "02" + "00".repeat(32), applicationStorageId: MSFILE_STORAGE_ID, schemaVersion: 1, bucketId: "test-memory", bucketGeneration: 1 });
}

function normalizeLegacyMediaPlaybackBlocks(input: unknown): number | undefined {
  return Number.isSafeInteger(input) && (input as number) >= LEGACY_MEDIA_PLAYBACK_MIN && (input as number) <= LEGACY_MEDIA_PLAYBACK_MAX
    ? input as number
    : undefined;
}

function readConcurrencyFromRow(row: Partial<GlobalSettingsRow> | undefined): MsFileReadConcurrencySettings {
  return normalizeMsFileReadConcurrencySettings({
    mediaBlockReadConcurrency: row?.mediaBlockReadConcurrency ?? MSFILE_READ_CONCURRENCY_RECOMMENDED.mediaBlockReadConcurrency,
    globalSeedReadConcurrency: row?.globalSeedReadConcurrency ?? MSFILE_READ_CONCURRENCY_RECOMMENDED.globalSeedReadConcurrency,
    globalBlockReadConcurrency: row?.globalBlockReadConcurrency ?? MSFILE_READ_CONCURRENCY_RECOMMENDED.globalBlockReadConcurrency,
    globalStatConcurrency: row?.globalStatConcurrency ?? MSFILE_READ_CONCURRENCY_RECOMMENDED.globalStatConcurrency
  }) ?? { ...MSFILE_READ_CONCURRENCY_RECOMMENDED };
}

async function listPartition<T>(store: KeyValueStore, partition: string, prefix: string): Promise<T[]> {
  const rows: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list({ partition, prefix, cursor, limit: 1000 });
    rows.push(...page.entries.map((entry) => entry.value as unknown as T));
    cursor = page.nextCursor;
  } while (cursor);
  return rows;
}

async function currentRevision(store: KeyValueStore, partition: string): Promise<number> {
  return (await store.list({ partition, limit: 1 })).revision;
}

export async function openMsFileRepository(store: KeyValueStore = createTestStore()): Promise<MsFileRepository> {
  let closed = false;
  const assertOpen = () => { if (closed) throw new Error("MSFile storage is closed"); };
  const getSettingsRow = async () => (await store.get<GlobalSettingsRow>(SETTINGS_KEY, { partition: SETTINGS_PARTITION }))?.value;
  const putSettingsRow = async (row: GlobalSettingsRow): Promise<void> => {
    const revision = await currentRevision(store, SETTINGS_PARTITION);
    await store.commit({ partition: SETTINGS_PARTITION, ifRevision: revision, operations: [{ type: "put", key: SETTINGS_KEY, value: row }] });
  };

  return {
    async getGlobalSettings() {
      assertOpen();
      const row = await getSettingsRow();
      if (!row) return null;
      const settings = row.settings && typeof row.settings.seedMaxPriceSatoshis === "string" && typeof row.settings.blockMaxPriceSatoshis === "string" ? row.settings : null;
      return { settings, mediaPlaybackPrefetchBlocks: normalizeLegacyMediaPlaybackBlocks(row.mediaPlaybackPrefetchBlocks) ?? LEGACY_MEDIA_PLAYBACK_DEFAULT, ...readConcurrencyFromRow(row), updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : null };
    },
    async putGlobalSettings(settings, updatedAt, mediaPlaybackPrefetchBlocks) {
      assertOpen();
      const existing = await getSettingsRow();
      await putSettingsRow({ key: SETTINGS_KEY, settings, mediaPlaybackPrefetchBlocks: normalizeLegacyMediaPlaybackBlocks(mediaPlaybackPrefetchBlocks) ?? normalizeLegacyMediaPlaybackBlocks(existing?.mediaPlaybackPrefetchBlocks) ?? LEGACY_MEDIA_PLAYBACK_DEFAULT, ...readConcurrencyFromRow(existing), updatedAt });
    },
    async putReadConcurrencySettings(settings, updatedAt) {
      assertOpen();
      const normalized = normalizeMsFileReadConcurrencySettings(settings);
      if (!normalized) throw new Error("invalid MSFile read concurrency settings");
      const existing = await getSettingsRow();
      await putSettingsRow({ key: SETTINGS_KEY, settings: existing?.settings ?? null, mediaPlaybackPrefetchBlocks: normalizeLegacyMediaPlaybackBlocks(existing?.mediaPlaybackPrefetchBlocks) ?? LEGACY_MEDIA_PLAYBACK_DEFAULT, ...normalized, updatedAt });
    },
    async putMediaBlockReadConcurrency(input, updatedAt) {
      assertOpen();
      const requested = typeof input === "number" ? input : input.mediaBlockReadConcurrency;
      const normalized = normalizeMsFileReadConcurrencySettings({
        ...readConcurrencyFromRow(await getSettingsRow()),
        mediaBlockReadConcurrency: requested
      });
      if (!normalized) throw new Error("invalid MSFile read concurrency settings");
      const existing = await getSettingsRow();
      await putSettingsRow({
        key: SETTINGS_KEY,
        settings: existing?.settings ?? null,
        mediaPlaybackPrefetchBlocks: normalizeLegacyMediaPlaybackBlocks(existing?.mediaPlaybackPrefetchBlocks) ?? LEGACY_MEDIA_PLAYBACK_DEFAULT,
        ...normalized,
        updatedAt
      });
    },
    async putMediaPlaybackPrefetchBlocks(input, updatedAt) {
      assertOpen();
      const value = normalizeLegacyMediaPlaybackBlocks(input.mediaPlaybackPrefetchBlocks);
      if (value === undefined) throw new Error("mediaPlaybackPrefetchBlocks must be an integer in 2..64");
      const existing = await getSettingsRow();
      await putSettingsRow({ key: SETTINGS_KEY, settings: existing?.settings ?? null, mediaPlaybackPrefetchBlocks: value, ...readConcurrencyFromRow(existing), updatedAt });
    },
    async listSuppliers() { assertOpen(); return (await listPartition<unknown>(store, SUPPLIERS_PARTITION, SUPPLIER_PREFIX)).filter(isValidPersistedSupplier); },
    async getSupplier(supplierPublicKeyHex) { assertOpen(); const row = await store.get<unknown>(`${SUPPLIER_PREFIX}${supplierPublicKeyHex}`, { partition: SUPPLIERS_PARTITION }); return isValidPersistedSupplier(row?.value) ? row.value : null; },
    async upsertSupplier(config) { assertOpen(); await store.put(`${SUPPLIER_PREFIX}${config.supplierPublicKeyHex}`, config, { partition: SUPPLIERS_PARTITION }); },
    async deleteSupplier(supplierPublicKeyHex) { assertOpen(); await store.delete(`${SUPPLIER_PREFIX}${supplierPublicKeyHex}`, { partition: SUPPLIERS_PARTITION }); },
    async listAppPolicies() { assertOpen(); return (await listPartition<StoredAppPolicyRow>(store, POLICIES_PARTITION, POLICY_PREFIX)).filter((row) => Boolean(row?.key && row?.override && typeof row.policyKey === "string")); },
    async getAppPolicy(key) { assertOpen(); return (await store.get<StoredAppPolicyRow>(`${POLICY_PREFIX}${msFileAppPolicyKeyString(key)}`, { partition: POLICIES_PARTITION }))?.value ?? null; },
    async putAppPolicy(record) { assertOpen(); await store.put(`${POLICY_PREFIX}${msFileAppPolicyKeyString(record.key)}`, { ...record, policyKey: msFileAppPolicyKeyString(record.key) }, { partition: POLICIES_PARTITION }); },
    async deleteAppPolicy(key) { assertOpen(); await store.delete(`${POLICY_PREFIX}${msFileAppPolicyKeyString(key)}`, { partition: POLICIES_PARTITION }); },
    async listAppUsages() { assertOpen(); return listPartition<StoredAppUsageRow>(store, USAGES_PARTITION, USAGE_PREFIX); },
    async touchAppUsage(key, appName, now) {
      assertOpen();
      const usageKey = msFileAppPolicyKeyString(key);
      const existing = (await store.get<StoredAppUsageRow>(`${USAGE_PREFIX}${usageKey}`, { partition: USAGES_PARTITION }))?.value;
      await store.put(`${USAGE_PREFIX}${usageKey}`, existing ? { ...existing, appName, lastSeenAt: now } : { usageKey, key, appName, firstSeenAt: now, lastSeenAt: now }, { partition: USAGES_PARTITION });
    },
    close() { if (!closed) { closed = true; store.close(); } }
  };
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
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value) || BigInt(value) > 0xffffffffffffffffn) return undefined;
    override[field] = value;
    found = true;
  }
  return found ? override : undefined;
}
