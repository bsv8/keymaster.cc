// SatSubscription owner-scoped IndexedDB。
//
// DB 名由 KeyspaceService 生成，因此不同 owner 天然隔离。这里仍把 bigint
// 序列化成十进制字符串，避免依赖浏览器对 BigInt structured clone 的差异。
// 不保存私钥、ECDH/AES secret、App 明文或无限网络日志。

import type { KeyScopedStorageHandle, KeyspaceService } from "@keymaster/contracts";
import type {
  SatCollectResult,
  SatOwnerSupplierSettingsV1,
  SatSpiInformation,
  SatSupplierConfigV1
} from "@keymaster/contracts";
import { normalizeOwnerSettings, normalizeSupplierConfig, parseUnsignedBigInt } from "./satValidation.js";
import type { SatChannelDedupEntry, SatFeeAuditEntry, SatSubscriptionRecord, SatSubscriptionStateSnapshot } from "./satState.js";

export const SAT_SUBSCRIPTION_STORAGE_ID = "sat_subscription_v1";
export const SAT_SUBSCRIPTION_DB_VERSION = 1;
const PLUGIN_ID = "sat-subscription";

interface StoredSpiInformation {
  supplierId: string;
  ownerPublicKeyHex: string;
  currencies: Array<{ currency: string; network: string; paymentAddress: string; balance: string }>;
  projectType: string;
  projectInfoCbor: Uint8Array;
  observedAtMs: number;
}

interface StoredCollectResult extends Omit<SatCollectResult, "amount"> {
  amount: string;
}

interface SatDbSnapshot {
  ownerPublicKeyHex: string | null;
  supplierGeneration: number;
  suppliers: SatSupplierConfigV1[];
  ownerSettings: SatOwnerSupplierSettingsV1 | null;
  subscriptions: SatSubscriptionRecord[];
  feeAudit: SatFeeAuditEntry[];
  channelDedup: SatChannelDedupEntry[];
  spiInformation: StoredSpiInformation[];
  collectResults: StoredCollectResult[];
}

function requestAsPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("SatSubscription IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("SatSubscription IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("SatSubscription IndexedDB transaction aborted"));
  });
}

function upgradeSatDb(db: IDBDatabase): void {
  const stores: Array<[string, IDBObjectStoreParameters]> = [
    ["meta", { keyPath: "key" }],
    ["suppliers", { keyPath: "supplierId" }],
    ["owner_settings", { keyPath: "key" }],
    ["subscriptions", { keyPath: "key" }],
    ["fee_audit", { keyPath: "auditId" }],
    ["channel_dedup", { keyPath: "dedupKey" }],
    ["spi_information", { keyPath: "supplierId" }],
    ["collect_requests", { keyPath: "requestIdHex" }]
  ];
  for (const [name, options] of stores) {
    if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, options);
  }
}

function toStoredSpi(value: SatSpiInformation): StoredSpiInformation {
  return {
    supplierId: value.supplierId,
    ownerPublicKeyHex: value.ownerPublicKeyHex,
    currencies: value.currencies.map((item) => ({ ...item, balance: item.balance.toString(10) })),
    projectType: value.projectType,
    projectInfoCbor: value.projectInfoCbor.slice(),
    observedAtMs: value.observedAtMs
  };
}

function fromStoredSpi(value: StoredSpiInformation): SatSpiInformation {
  return {
    supplierId: value.supplierId,
    ownerPublicKeyHex: value.ownerPublicKeyHex,
    currencies: value.currencies.map((item) => ({ ...item, balance: parseUnsignedBigInt(item.balance, "balance") })),
    projectType: value.projectType,
    projectInfoCbor: value.projectInfoCbor.slice(),
    observedAtMs: value.observedAtMs
  };
}

function toStoredCollect(value: SatCollectResult): StoredCollectResult {
  return { ...value, amount: value.amount.toString(10) };
}

function fromStoredCollect(value: StoredCollectResult): SatCollectResult {
  return { ...value, amount: parseUnsignedBigInt(value.amount, "collect.amount") };
}

/** 打开当前 owner 的 SatSubscription namespace。 */
export async function openSatSubscriptionDb(input: { keyspace: KeyspaceService; publicKeyHex: string }): Promise<SatSubscriptionDb> {
  if (!input.publicKeyHex) throw new Error("SatSubscription DB requires an owner public key");
  const handle = await input.keyspace.openKeyStorage({
    publicKeyHex: input.publicKeyHex,
    pluginId: PLUGIN_ID,
    storageId: SAT_SUBSCRIPTION_STORAGE_ID,
    version: SAT_SUBSCRIPTION_DB_VERSION,
    upgrade: upgradeSatDb
  });
  return new SatSubscriptionDb(handle, input.publicKeyHex);
}

export class SatSubscriptionDb {
  constructor(readonly handle: KeyScopedStorageHandle, readonly ownerPublicKeyHex: string) {}

  close(): void {
    try { this.handle.close(); } catch { /* 已关闭 */ }
  }

  async load(): Promise<SatSubscriptionStateSnapshot> {
    const db = this.handle.db;
    const names = ["meta", "suppliers", "owner_settings", "subscriptions", "fee_audit", "channel_dedup", "spi_information", "collect_requests"];
    const transaction = db.transaction(names, "readonly");
    const done = transactionDone(transaction);
    const [meta, suppliers, ownerSettings, subscriptions, feeAudit, channelDedup, spiInformation, collectResults] = await Promise.all([
      requestAsPromise(transaction.objectStore("meta").get("snapshot")),
      requestAsPromise(transaction.objectStore("suppliers").getAll()),
      requestAsPromise(transaction.objectStore("owner_settings").get("current")),
      requestAsPromise(transaction.objectStore("subscriptions").getAll()),
      requestAsPromise(transaction.objectStore("fee_audit").getAll()),
      requestAsPromise(transaction.objectStore("channel_dedup").getAll()),
      requestAsPromise(transaction.objectStore("spi_information").getAll()),
      requestAsPromise(transaction.objectStore("collect_requests").getAll())
    ]);
    await done;
    const stored = meta as { key: string; ownerPublicKeyHex?: string; supplierGeneration?: number } | undefined;
    if (stored?.ownerPublicKeyHex && stored.ownerPublicKeyHex !== this.ownerPublicKeyHex) throw new Error("SatSubscription DB owner mismatch");
    const settings = ownerSettings as { key: string; value: SatOwnerSupplierSettingsV1 } | undefined;
    const snapshot = {
      ownerPublicKeyHex: this.ownerPublicKeyHex,
      supplierGeneration: stored?.supplierGeneration ?? 1,
      suppliers: (suppliers as SatSupplierConfigV1[]).map(normalizeSupplierConfig),
      ownerSettings: settings?.value ? normalizeOwnerSettings(settings.value) : null,
      subscriptions: subscriptions as SatSubscriptionRecord[],
      feeAudit: feeAudit as SatFeeAuditEntry[],
      channelDedup: channelDedup as SatChannelDedupEntry[],
      spiInformation: (spiInformation as StoredSpiInformation[]).map(fromStoredSpi),
      collectResults: (collectResults as StoredCollectResult[]).map(fromStoredCollect)
    } satisfies SatSubscriptionStateSnapshot;
    if (snapshot.ownerSettings && snapshot.ownerSettings.ownerPublicKeyHex !== this.ownerPublicKeyHex) throw new Error("SatSubscription owner settings mismatch");
    return snapshot;
  }

  async save(snapshot: SatSubscriptionStateSnapshot): Promise<void> {
    if (snapshot.ownerPublicKeyHex !== this.ownerPublicKeyHex) throw new Error("SatSubscription DB owner mismatch on save");
    const db = this.handle.db;
    const names = ["meta", "suppliers", "owner_settings", "subscriptions", "fee_audit", "channel_dedup", "spi_information", "collect_requests"];
    const transaction = db.transaction(names, "readwrite");
    for (const name of names) transaction.objectStore(name).clear();
    transaction.objectStore("meta").put({ key: "snapshot", ownerPublicKeyHex: this.ownerPublicKeyHex, supplierGeneration: snapshot.supplierGeneration });
    for (const supplier of snapshot.suppliers) transaction.objectStore("suppliers").put(normalizeSupplierConfig(supplier));
    if (snapshot.ownerSettings) transaction.objectStore("owner_settings").put({ key: "current", value: normalizeOwnerSettings(snapshot.ownerSettings) });
    for (const record of snapshot.subscriptions) transaction.objectStore("subscriptions").put({ ...record, key: `${record.supplierId}\u0000${record.channel}` });
    for (const record of snapshot.feeAudit.slice(-256)) transaction.objectStore("fee_audit").put(record);
    for (const record of snapshot.channelDedup.slice(-2048)) transaction.objectStore("channel_dedup").put(record);
    for (const record of snapshot.spiInformation.slice(-64)) transaction.objectStore("spi_information").put(toStoredSpi(record));
    for (const record of snapshot.collectResults.slice(-64)) transaction.objectStore("collect_requests").put(toStoredCollect(record));
    await transactionDone(transaction);
  }
}

/** 便于未初始化时创建一个空 owner snapshot。 */
export function emptySatSubscriptionSnapshot(ownerPublicKeyHex: string): SatSubscriptionStateSnapshot {
  return {
    ownerPublicKeyHex,
    supplierGeneration: 1,
    suppliers: [],
    ownerSettings: null,
    subscriptions: [],
    feeAudit: [],
    channelDedup: [],
    spiInformation: [],
    collectResults: []
  };
}
