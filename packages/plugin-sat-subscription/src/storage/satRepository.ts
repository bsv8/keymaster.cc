// SatSubscription owner/App K-V Repository。
// 一个 snapshot 作为单个值提交，避免部分 collection 写入被读者观察到。

import type { KeyValueStore, SatCollectResult, SatOwnerSupplierSettingsV1, SatSpiInformation, SatSupplierConfigV1 } from "@keymaster/contracts";
import { normalizeOwnerSettings, normalizeSupplierConfig, parseUnsignedBigInt } from "../satValidation.js";
import type { SatChannelDedupEntry, SatFeeAuditEntry, SatSubscriptionRecord, SatSubscriptionStateSnapshot } from "../satState.js";

export const SAT_SUBSCRIPTION_STORAGE_ID = "SatSubscription";
export const SAT_SUBSCRIPTION_SCHEMA_VERSION = 1;
interface StoredSpiInformation {
  supplierId: string;
  ownerPublicKeyHex: string;
  currencies: Array<{ currency: string; network: string; paymentAddress: string; balance: string }>;
  projectType: string;
  projectInfoCbor: Uint8Array;
  observedAtMs: number;
}
interface StoredCollectResult extends Omit<SatCollectResult, "amount"> { amount: string; }
interface SatSubscriptionRepositorySnapshot {
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
function toStoredSpi(value: SatSpiInformation): StoredSpiInformation { return { ...value, currencies: value.currencies.map((item) => ({ ...item, balance: item.balance.toString(10) })), projectInfoCbor: value.projectInfoCbor.slice() }; }
function fromStoredSpi(value: StoredSpiInformation): SatSpiInformation { return { ...value, currencies: value.currencies.map((item) => ({ ...item, balance: parseUnsignedBigInt(item.balance, "balance") })), projectInfoCbor: value.projectInfoCbor.slice() }; }
function toStoredCollect(value: SatCollectResult): StoredCollectResult { return { ...value, amount: value.amount.toString(10) }; }
function fromStoredCollect(value: StoredCollectResult): SatCollectResult { return { ...value, amount: parseUnsignedBigInt(value.amount, "collect.amount") }; }

export function createSatSubscriptionRepository(handle: KeyValueStore): SatSubscriptionRepository {
  return new SatSubscriptionRepository(handle);
}

export class SatSubscriptionRepository {
  readonly ownerPublicKeyHex: string;
  constructor(readonly handle: KeyValueStore) {
    this.ownerPublicKeyHex = handle.ownerPublicKeyHex;
  }
  close(): void { this.handle.close(); }
  async load(): Promise<SatSubscriptionStateSnapshot> {
    const stored = (await this.handle.get<SatSubscriptionRepositorySnapshot>("snapshot", { partition: "state" }))?.value;
    if (!stored) return { ownerPublicKeyHex: this.ownerPublicKeyHex, supplierGeneration: 1, suppliers: [], ownerSettings: null, subscriptions: [], feeAudit: [], channelDedup: [], spiInformation: [], collectResults: [] };
    if (stored.ownerPublicKeyHex && stored.ownerPublicKeyHex !== this.ownerPublicKeyHex) throw new Error("SatSubscription owner mismatch");
    const ownerSettings = stored.ownerSettings ? normalizeOwnerSettings(stored.ownerSettings) : null;
    if (ownerSettings && ownerSettings.ownerPublicKeyHex !== this.ownerPublicKeyHex) throw new Error("SatSubscription owner settings mismatch");
    return { ownerPublicKeyHex: this.ownerPublicKeyHex, supplierGeneration: stored.supplierGeneration, suppliers: stored.suppliers.map(normalizeSupplierConfig), ownerSettings, subscriptions: stored.subscriptions, feeAudit: stored.feeAudit, channelDedup: stored.channelDedup, spiInformation: stored.spiInformation.map(fromStoredSpi), collectResults: stored.collectResults.map(fromStoredCollect) };
  }
  async save(snapshot: SatSubscriptionStateSnapshot): Promise<void> {
    if (snapshot.ownerPublicKeyHex !== this.ownerPublicKeyHex) throw new Error("SatSubscription owner mismatch on save");
    const stored: SatSubscriptionRepositorySnapshot = {
      ownerPublicKeyHex: this.ownerPublicKeyHex,
      supplierGeneration: snapshot.supplierGeneration,
      suppliers: snapshot.suppliers.map(normalizeSupplierConfig),
      ownerSettings: snapshot.ownerSettings ? normalizeOwnerSettings(snapshot.ownerSettings) : null,
      subscriptions: snapshot.subscriptions,
      feeAudit: snapshot.feeAudit.slice(-256),
      channelDedup: snapshot.channelDedup.slice(-2048),
      spiInformation: snapshot.spiInformation.slice(-64).map(toStoredSpi),
      collectResults: snapshot.collectResults.slice(-64).map(toStoredCollect)
    };
    await this.handle.put("snapshot", stored, { partition: "state" });
  }
}

export function emptySatSubscriptionSnapshot(ownerPublicKeyHex: string): SatSubscriptionStateSnapshot {
  return { ownerPublicKeyHex, supplierGeneration: 1, suppliers: [], ownerSettings: null, subscriptions: [], feeAudit: [], channelDedup: [], spiInformation: [], collectResults: [] };
}
