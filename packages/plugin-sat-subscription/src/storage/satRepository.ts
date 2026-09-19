// SatSubscription owner 文件仓储。
//
// 物理布局：`<owner>/sat-subscription/setting.json`。
// 本仓储只保存本地供应商设置；远端订阅、账单、连接和 SPI 结果都不属于
// setting.json。旧的 `.keymaster` K-V snapshot 不再读取、迁移或删除。

import type {
  BorrowedOwnerFileStore,
  SatOwnerSupplierSettingsV1,
  SatSupplierConfigV1,
} from "@keymaster/contracts";
import {
  assertSupplierId,
  normalizeOwnerSettings,
  normalizeSupplierConfig,
} from "../satValidation.js";
import {
  isBuiltInDefaultSupplierConfig,
  SAT_DEFAULT_SUPPLIER_ID,
} from "../defaults.js";
import type { SatSubscriptionStateSnapshot } from "../satState.js";

/** 设置文件在 sat-subscription 文件根下的固定路径。 */
export const SAT_SUBSCRIPTION_SETTING_FILE = "setting.json";
/** 设置文件格式标识。 */
export const SAT_SUBSCRIPTION_SETTING_FORMAT = "keymaster.sat-subscription-setting";
/** 当前设置文件版本。 */
export const SAT_SUBSCRIPTION_SETTING_VERSION = 1;
/** 格式文档规定的单文件上限。 */
const MAX_SETTING_BYTES = 32 * 1024;
const INVALID_SETTING_SENTINEL = "<invalid-setting-file>";

interface SatSubscriptionSettingFileV1 {
  format: typeof SAT_SUBSCRIPTION_SETTING_FORMAT;
  version: typeof SAT_SUBSCRIPTION_SETTING_VERSION;
  /** 只包含用户新增 Supplier，不包含编译内置的 bsv8。 */
  suppliers?: SatSupplierConfigV1[];
  /** 只在用户选择新增 Supplier 作为默认出口时保存。 */
  defaultPublishSupplierId?: string | null;
  /** 只保存新增 Supplier 的接收入口。 */
  receiveSupplierIds?: string[];
}

interface ParsedSatSubscriptionSetting {
  suppliers: SatSupplierConfigV1[];
  defaultPublishSupplierId: string | null;
  receiveSupplierIds: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const expected = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new Error(`${field} contains unknown field: ${key}`);
  }
}

function isReservedDefaultSupplier(config: SatSupplierConfigV1): boolean {
  return isBuiltInDefaultSupplierConfig(config);
}

function assertCustomSupplier(config: SatSupplierConfigV1, field: string): void {
  if (isReservedDefaultSupplier(config)) throw new Error(`${field} must not override the built-in default supplier`);
}

function parseSupplier(value: unknown, field: string): SatSupplierConfigV1 {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  assertExactKeys(value, ["supplierId", "name", "supplierPublicKeyHex", "multiaddrs", "enabled"], field);
  const normalized = normalizeSupplierConfig({
    supplierId: value.supplierId as string,
    name: value.name as string,
    supplierPublicKeyHex: value.supplierPublicKeyHex as string,
    multiaddrs: value.multiaddrs as string[],
    enabled: value.enabled as boolean,
  });
  assertCustomSupplier(normalized, field);
  return normalized;
}

/** 严格解析 setting.json；未知字段、版本和引用错误都会拒绝整份文件。 */
export function parseSatSubscriptionSettingFile(bytes: Uint8Array): ParsedSatSubscriptionSetting {
  if (bytes.byteLength > MAX_SETTING_BYTES) throw new Error("setting.json exceeds 32 KiB");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    throw new Error("setting.json is not valid UTF-8 JSON", { cause: error });
  }
  if (!isRecord(parsed)) throw new Error("setting.json root must be an object");
  assertExactKeys(parsed, ["format", "version", "suppliers", "defaultPublishSupplierId", "receiveSupplierIds"], "setting.json");
  if (parsed.format !== SAT_SUBSCRIPTION_SETTING_FORMAT) throw new Error("setting.json format is unsupported");
  if (parsed.version !== SAT_SUBSCRIPTION_SETTING_VERSION) throw new Error("setting.json version is unsupported");

  const suppliers = parsed.suppliers === undefined
    ? []
    : Array.isArray(parsed.suppliers)
      ? parsed.suppliers.map((item, index) => parseSupplier(item, `setting.json.suppliers[${index}]`))
      : (() => { throw new Error("setting.json.suppliers must be an array"); })();
  if (suppliers.length > 64) throw new Error("setting.json.suppliers exceeds 64 entries");
  const supplierIds = new Set<string>();
  for (const supplier of suppliers) {
    if (supplierIds.has(supplier.supplierId)) throw new Error("setting.json.suppliers contains duplicate supplierId");
    supplierIds.add(supplier.supplierId);
  }

  const defaultPublishSupplierId = parsed.defaultPublishSupplierId === undefined || parsed.defaultPublishSupplierId === null
    ? null
    : (() => {
      assertSupplierId(parsed.defaultPublishSupplierId);
      if (!supplierIds.has(parsed.defaultPublishSupplierId)) throw new Error("setting.json.defaultPublishSupplierId is not configured");
      const supplier = suppliers.find((item) => item.supplierId === parsed.defaultPublishSupplierId);
      if (!supplier?.enabled) throw new Error("setting.json.defaultPublishSupplierId must reference an enabled supplier");
      return parsed.defaultPublishSupplierId;
    })();

  const receiveSupplierIds = parsed.receiveSupplierIds === undefined
    ? []
    : Array.isArray(parsed.receiveSupplierIds)
      ? parsed.receiveSupplierIds.map((supplierId, index) => {
        assertSupplierId(supplierId);
        if (!supplierIds.has(supplierId)) throw new Error(`setting.json.receiveSupplierIds[${index}] is not configured`);
        const supplier = suppliers.find((item) => item.supplierId === supplierId);
        if (!supplier?.enabled) throw new Error(`setting.json.receiveSupplierIds[${index}] must reference an enabled supplier`);
        return supplierId;
      })
      : (() => { throw new Error("setting.json.receiveSupplierIds must be an array"); })();
  if (receiveSupplierIds.length > 64) throw new Error("setting.json.receiveSupplierIds exceeds 64 entries");
  if (new Set(receiveSupplierIds).size !== receiveSupplierIds.length) throw new Error("setting.json.receiveSupplierIds contains duplicates");

  return { suppliers, defaultPublishSupplierId, receiveSupplierIds };
}

function emptySnapshot(ownerPublicKeyHex: string): SatSubscriptionStateSnapshot {
  return {
    ownerPublicKeyHex,
    supplierGeneration: 1,
    suppliers: [],
    ownerSettings: null,
    subscriptions: [],
    feeAudit: [],
    channelDedup: [],
    spiInformation: [],
    collectResults: [],
  };
}

function cloneSupplier(config: SatSupplierConfigV1): SatSupplierConfigV1 {
  return { ...config, multiaddrs: [...config.multiaddrs] };
}

function settingFromSnapshot(
  snapshot: SatSubscriptionStateSnapshot,
  ownerPublicKeyHex: string,
): SatSubscriptionSettingFileV1 | null {
  if (snapshot.ownerPublicKeyHex !== ownerPublicKeyHex) throw new Error("SatSubscription owner mismatch on save");
  const suppliers = snapshot.suppliers.filter((supplier) => supplier.supplierId !== SAT_DEFAULT_SUPPLIER_ID);
  const normalizedSuppliers = suppliers.map((supplier, index) => {
    const normalized = normalizeSupplierConfig(supplier);
    assertCustomSupplier(normalized, `snapshot.suppliers[${index}]`);
    return normalized;
  });
  const supplierIds = new Set(normalizedSuppliers.map((supplier) => supplier.supplierId));
  if (supplierIds.size !== normalizedSuppliers.length) throw new Error("snapshot suppliers contain duplicate supplierId");

  const settings = snapshot.ownerSettings;
  if (settings && settings.ownerPublicKeyHex !== ownerPublicKeyHex) throw new Error("SatSubscription owner settings mismatch on save");
  const normalizedSettings: SatOwnerSupplierSettingsV1 | null = settings ? normalizeOwnerSettings(settings) : null;
  const defaultPublishSupplierId = normalizedSettings?.defaultPublishSupplierId ?? null;
  const customDefault = defaultPublishSupplierId === SAT_DEFAULT_SUPPLIER_ID ? null : defaultPublishSupplierId;
  if (customDefault !== null) {
    if (!supplierIds.has(customDefault)) throw new Error("default publish supplier is not configured");
    if (!normalizedSuppliers.find((supplier) => supplier.supplierId === customDefault)?.enabled) {
      throw new Error("default publish supplier must be enabled");
    }
  }
  const receiveSupplierIds = [...new Set(
    (normalizedSettings?.receiveSupplierIds ?? []).filter((supplierId) => supplierId !== SAT_DEFAULT_SUPPLIER_ID),
  )];
  for (const supplierId of receiveSupplierIds) {
    if (!supplierIds.has(supplierId)) throw new Error("receive supplier is not configured");
    if (!normalizedSuppliers.find((supplier) => supplier.supplierId === supplierId)?.enabled) {
      throw new Error("receive supplier must be enabled");
    }
  }
  if (normalizedSuppliers.length === 0 && customDefault === null && receiveSupplierIds.length === 0) return null;
  return {
    format: SAT_SUBSCRIPTION_SETTING_FORMAT,
    version: SAT_SUBSCRIPTION_SETTING_VERSION,
    ...(normalizedSuppliers.length === 0 ? {} : { suppliers: normalizedSuppliers.map(cloneSupplier) }),
    ...(customDefault === null ? {} : { defaultPublishSupplierId: customDefault }),
    ...(receiveSupplierIds.length === 0 ? {} : { receiveSupplierIds }),
  };
}

function serializeSetting(value: SatSubscriptionSettingFileV1): Uint8Array {
  const bytes = new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
  if (bytes.byteLength > MAX_SETTING_BYTES) throw new Error("setting.json exceeds 32 KiB");
  return bytes;
}

/** 创建绑定当前 owner 文件根的 SatSubscription 设置仓储。 */
export function createSatSubscriptionRepository(
  files: BorrowedOwnerFileStore,
  ownerPublicKeyHex: string,
): SatSubscriptionRepository {
  return new SatSubscriptionRepository(files, ownerPublicKeyHex);
}

export class SatSubscriptionRepository {
  private lastSerializedSetting: string | null | undefined;

  constructor(
    readonly files: BorrowedOwnerFileStore,
    readonly ownerPublicKeyHex: string,
  ) {}

  /** 读取设置；损坏文件只回退到运行时默认值，不自动覆盖原文件。 */
  async load(): Promise<SatSubscriptionStateSnapshot> {
    const object = await this.files.get(SAT_SUBSCRIPTION_SETTING_FILE);
    if (!object) {
      this.lastSerializedSetting = null;
      return emptySnapshot(this.ownerPublicKeyHex);
    }
    try {
      const setting = parseSatSubscriptionSettingFile(object.bytes);
      this.lastSerializedSetting = new TextDecoder().decode(serializeSetting({
        format: SAT_SUBSCRIPTION_SETTING_FORMAT,
        version: SAT_SUBSCRIPTION_SETTING_VERSION,
        ...(setting.suppliers.length === 0 ? {} : { suppliers: setting.suppliers.map(cloneSupplier) }),
        ...(setting.defaultPublishSupplierId === null ? {} : { defaultPublishSupplierId: setting.defaultPublishSupplierId }),
        ...(setting.receiveSupplierIds.length === 0 ? {} : { receiveSupplierIds: [...setting.receiveSupplierIds] }),
      }));
      const hasExplicitSelection = setting.defaultPublishSupplierId !== null || setting.receiveSupplierIds.length > 0;
      return {
        ...emptySnapshot(this.ownerPublicKeyHex),
        suppliers: setting.suppliers.map(cloneSupplier),
        ownerSettings: setting.suppliers.length > 0 || hasExplicitSelection
          ? {
            ownerPublicKeyHex: this.ownerPublicKeyHex,
            defaultPublishSupplierId: setting.defaultPublishSupplierId,
            receiveSupplierIds: [...setting.receiveSupplierIds],
          }
          : null,
      };
    } catch (error) {
      this.lastSerializedSetting = INVALID_SETTING_SENTINEL;
      console.warn("[sat-subscription] invalid setting.json; using built-in defaults", error instanceof Error ? error.message : String(error));
      return emptySnapshot(this.ownerPublicKeyHex);
    }
  }

  /** 保存设置；默认值不落盘，恢复默认且无自定义 Supplier 时删除文件。 */
  async save(snapshot: SatSubscriptionStateSnapshot): Promise<void> {
    const setting = settingFromSnapshot(snapshot, this.ownerPublicKeyHex);
    if (!setting) {
      // 缺省值不会创建文件；损坏文件也不能被运行态保存动作自动修复。
      if (this.lastSerializedSetting === null || this.lastSerializedSetting === INVALID_SETTING_SENTINEL) return;
      await this.files.delete(SAT_SUBSCRIPTION_SETTING_FILE);
      this.lastSerializedSetting = null;
      return;
    }
    const bytes = serializeSetting(setting);
    const serialized = new TextDecoder().decode(bytes);
    // SatState 还会在内存中记录远端观察值/运行诊断；这些变化不能反复
    // 改写设置文件，也不能覆盖另一窗口已经写入的同一份设置。
    if (this.lastSerializedSetting === serialized) return;
    await this.files.put(SAT_SUBSCRIPTION_SETTING_FILE, bytes);
    this.lastSerializedSetting = serialized;
  }

  /** 文件句柄生命周期由 Worker Host 管理。 */
  close(): void {}
}

export function emptySatSubscriptionSnapshot(ownerPublicKeyHex: string): SatSubscriptionStateSnapshot {
  return emptySnapshot(ownerPublicKeyHex);
}
