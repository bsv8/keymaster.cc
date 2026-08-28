// packages/plugin-msfile/src/msfileDb.ts
// `keymaster.msfile` IndexedDB（施工单 §3.5）。
//
// 记录不含私钥、付款凭证或内容字节，不写 localStorage。所有写入在
// Coordinator SharedWorker 中串行执行；本模块只提供单事务读写原语。

import type {
  MsFileAppIdentityKey,
  MsFileAppPriceOverride,
  MsFileGlobalPriceSettings,
  MsFileMediaPlaybackSettings,
  MsFileSupplierConfig,
} from "@keymaster/contracts";
import {
  isValidMsFileSupplierPublicKeyHex,
  msFileAppPolicyKeyString,
  MSFILE_MEDIA_PREFETCH_BLOCKS_DEFAULT,
  normalizeMsFileMediaPrefetchBlocks,
} from "@keymaster/contracts";

export const MSFILE_DB_NAME = "keymaster.msfile";
export const MSFILE_DB_VERSION = 2;

interface GlobalSettingsRow {
  key: "singleton";
  settings: MsFileGlobalPriceSettings | null;
  /** V2 新增；V1 记录缺失时按默认值读取。 */
  mediaPlaybackPrefetchBlocks?: number;
  updatedAt: number;
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

/** DB 读回的形状层守卫（曲线级校验由 supplierConfig 在拨号前执行）。 */
export function isValidPersistedSupplier(value: unknown): value is MsFileSupplierConfig {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<MsFileSupplierConfig>;
  return typeof record.name === "string"
    && isValidMsFileSupplierPublicKeyHex(record.supplierPublicKeyHex)
    && Array.isArray(record.addresses)
    && record.addresses.length > 0
    && record.addresses.every((a) => typeof a === "string")
    && typeof record.enabled === "boolean";
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexeddb request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("indexeddb transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("indexeddb transaction failed"));
  });
}

export interface MsFileDb {
  getGlobalSettings(): Promise<MsFileGlobalSettingsSnapshot | null>;
  putGlobalSettings(settings: MsFileGlobalPriceSettings, updatedAt: number, mediaPlaybackPrefetchBlocks?: number): Promise<void>;
  /** 独立更新播放器设置；可选以兼容旧的测试/外部 DB seam。 */
  putMediaPlaybackPrefetchBlocks?(settings: MsFileMediaPlaybackSettings, updatedAt: number): Promise<void>;
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

/** 全局设置快照：settings 为 null 表示用户尚未显式保存（Read fail closed）。 */
export interface MsFileGlobalSettingsSnapshot {
  settings: MsFileGlobalPriceSettings | null;
  /** V1 行缺失时由 DB 读取层补成 5。 */
  mediaPlaybackPrefetchBlocks?: number;
  updatedAt: number | null;
}

export async function openMsFileDb(indexedDbFactory?: IDBFactory): Promise<MsFileDb> {
  const factory = indexedDbFactory ?? globalThis.indexedDB;
  if (!factory) throw new Error("IndexedDB is unavailable");
  const openRequest = factory.open(MSFILE_DB_NAME, MSFILE_DB_VERSION);
  openRequest.onupgradeneeded = () => {
    const db = openRequest.result;
    if (!db.objectStoreNames.contains("globalSettings")) db.createObjectStore("globalSettings", { keyPath: "key" });
    if (!db.objectStoreNames.contains("suppliers")) db.createObjectStore("suppliers", { keyPath: "supplierPublicKeyHex" });
    if (!db.objectStoreNames.contains("appPolicies")) db.createObjectStore("appPolicies", { keyPath: "policyKey" });
    if (!db.objectStoreNames.contains("appUsage")) db.createObjectStore("appUsage", { keyPath: "usageKey" });
  };
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    openRequest.onsuccess = () => resolve(openRequest.result);
    openRequest.onerror = () => reject(openRequest.error ?? new Error("failed to open msfile database"));
    openRequest.onblocked = () => reject(new Error("opening msfile database was blocked"));
  });
  db.onversionchange = () => db.close();

  function readStore<T>(name: string, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const transaction = db.transaction(name, "readonly");
    return requestToPromise(run(transaction.objectStore(name)));
  }

  return {
    async getGlobalSettings() {
      const row = await readStore<GlobalSettingsRow | undefined>("globalSettings", (store) => store.get("singleton"));
      if (!row) return null;
      let settings: MsFileGlobalPriceSettings | null = null;
      if (row.settings) {
        const { seedMaxPriceSatoshis, blockMaxPriceSatoshis } = row.settings;
        if (typeof seedMaxPriceSatoshis !== "string" || typeof blockMaxPriceSatoshis !== "string") return null;
        settings = { seedMaxPriceSatoshis, blockMaxPriceSatoshis };
      }
      return {
        settings,
        mediaPlaybackPrefetchBlocks: normalizeMsFileMediaPrefetchBlocks(row.mediaPlaybackPrefetchBlocks)
          ?? MSFILE_MEDIA_PREFETCH_BLOCKS_DEFAULT,
        updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : null,
      };
    },
    async putGlobalSettings(settings, updatedAt, mediaPlaybackPrefetchBlocks) {
      const transaction = db.transaction("globalSettings", "readwrite");
      transaction.objectStore("globalSettings").put({
        key: "singleton",
        settings,
        mediaPlaybackPrefetchBlocks: normalizeMsFileMediaPrefetchBlocks(mediaPlaybackPrefetchBlocks)
          ?? MSFILE_MEDIA_PREFETCH_BLOCKS_DEFAULT,
        updatedAt,
      } satisfies GlobalSettingsRow);
      await transactionDone(transaction);
    },
    async putMediaPlaybackPrefetchBlocks(mediaSettings, updatedAt) {
      const value = normalizeMsFileMediaPrefetchBlocks(mediaSettings.mediaPlaybackPrefetchBlocks);
      if (value === undefined) throw new Error("mediaPlaybackPrefetchBlocks must be an integer in 2..64");
      const transaction = db.transaction("globalSettings", "readwrite");
      const store = transaction.objectStore("globalSettings");
      const existing = await requestToPromise<GlobalSettingsRow | undefined>(store.get("singleton"));
      store.put({
        key: "singleton",
        settings: existing?.settings ?? null,
        mediaPlaybackPrefetchBlocks: value,
        updatedAt,
      } satisfies GlobalSettingsRow);
      await transactionDone(transaction);
    },
    async listSuppliers() {
      const rows = await readStore<unknown[]>("suppliers", (store) => store.getAll());
      return rows.filter(isValidPersistedSupplier);
    },
    async getSupplier(supplierPublicKeyHex) {
      const row = await readStore<unknown>("suppliers", (store) => store.get(supplierPublicKeyHex));
      return isValidPersistedSupplier(row) ? row : null;
    },
    async upsertSupplier(config) {
      const transaction = db.transaction("suppliers", "readwrite");
      transaction.objectStore("suppliers").put(config);
      await transactionDone(transaction);
    },
    async deleteSupplier(supplierPublicKeyHex) {
      const transaction = db.transaction("suppliers", "readwrite");
      transaction.objectStore("suppliers").delete(supplierPublicKeyHex);
      await transactionDone(transaction);
    },
    async listAppPolicies() {
      const rows = await readStore<StoredAppPolicyRow[]>("appPolicies", (store) => store.getAll());
      return rows.filter((row) => Boolean(row?.key && row?.override && typeof row.policyKey === "string"));
    },
    async getAppPolicy(key) {
      const row = await readStore<StoredAppPolicyRow | undefined>(
        "appPolicies",
        (store) => store.get(msFileAppPolicyKeyString(key))
      );
      return row ?? null;
    },
    async putAppPolicy(record) {
      const transaction = db.transaction("appPolicies", "readwrite");
      transaction.objectStore("appPolicies").put({ ...record, policyKey: msFileAppPolicyKeyString(record.key) });
      await transactionDone(transaction);
    },
    async deleteAppPolicy(key) {
      const transaction = db.transaction("appPolicies", "readwrite");
      transaction.objectStore("appPolicies").delete(msFileAppPolicyKeyString(key));
      await transactionDone(transaction);
    },
    async listAppUsages() {
      return readStore<StoredAppUsageRow[]>("appUsage", (store) => store.getAll());
    },
    async touchAppUsage(key, appName, now) {
      const usageKey = msFileAppPolicyKeyString(key);
      const transaction = db.transaction("appUsage", "readwrite");
      const store = transaction.objectStore("appUsage");
      const existing = await requestToPromise<StoredAppUsageRow | undefined>(store.get(usageKey));
      const next: StoredAppUsageRow = existing
        ? { ...existing, appName, lastSeenAt: now }
        : { usageKey, key, appName, firstSeenAt: now, lastSeenAt: now };
      store.put(next);
      await transactionDone(transaction);
    },
    close() {
      db.close();
    },
  };
}

/** App override 的结构校验（DB 读回与 RPC 边界共用）。 */
export function sanitizeAppOverride(input: unknown): MsFileAppPriceOverride | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  const override: MsFileAppPriceOverride = {};
  let sawAny = false;
  for (const field of ["seedMaxPriceSatoshis", "blockMaxPriceSatoshis"] as const) {
    const value = record[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > 0xffffffffffffffffn) return undefined;
    override[field] = value;
    sawAny = true;
  }
  return sawAny ? override : undefined;
}
