// packages/plugin-msfile/src/MsFileSettings.tsx
// /settings/system 的 MSFile group：价格限制 / 供应商配置 / Connect App 授权。
// 页面只在 Vault unlocked 时渲染（visibleWhen 由 manifest 保证）。
// 所有读写都通过 `msfile.service`；本组件不接触 platform K-V repository。

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  MsFileAppAuthorizationView,
  MsFileBitfsBuyerSettings,
  MsFilePendingApprovalView,
  MsFileReadConcurrencySettings,
  MsFileSatoshiAmount,
  MsFileSellerRuntimeStatus,
  MsFileService,
  MsFileSellerSettings,
  MsFileSettingsSnapshot,
  MsFileSupplierConfig,
} from "@keymaster/contracts";
import { useOptionalCapability } from "webloom-framework/react";
import { useI18n, useOptionalResourceSelector, usePluginHost } from "@keymaster/runtime";
import { Button } from "@keymaster/ui";
import { MSFILE_SERVICE_CAPABILITY } from "@keymaster/contracts";
import {
  MSFILE_MAX_BLOCK_BYTES,
  MSFILE_MAX_SEED_BYTES,
  MSFILE_READ_CONCURRENCY_HARD_LIMITS,
  MSFILE_READ_CONCURRENCY_RECOMMENDED,
  MSFILE_SELLER_SETTINGS_DEFAULT,
  MSFILE_BITFS_BUYER_SETTINGS_DEFAULT,
  MSFILE_BITFS_BUYER_LIMITS,
  normalizeMsFileSellerSettings,
  normalizeMsFileBitfsBuyerSettings,
  normalizeMsFileReadConcurrencySettings,
  normalizeMsFileSatoshiAmount,
} from "@keymaster/contracts";

/** `msfile.status` 资源快照（由 plugin manifest 注册）。 */
export interface MsFileStatusResourceSnapshot {
  status: string;
  globalSettings: import("@keymaster/contracts").MsFileGlobalPriceSettings | null;
  mediaBlockReadConcurrency: number;
  globalSeedReadConcurrency: number;
  globalBlockReadConcurrency: number;
  globalStatConcurrency: number;
  approvals: MsFilePendingApprovalView[];
}

type AmountDraft = { text: string; unlimited: boolean };
type ConcurrencyField = keyof MsFileReadConcurrencySettings;
type ConcurrencyDraft = Record<ConcurrencyField, string>;
type BitfsBuyerSettingsDraft = Omit<MsFileBitfsBuyerSettings, "maxConcurrentDownloads" | "maxConcurrentSellerSessions"> & {
  maxConcurrentDownloads: string;
  maxConcurrentSellerSessions: string;
};

/** 卖方运行状态的中文说明；状态值本身是稳定契约，不翻译持久化字段。 */
const SELLER_RUNTIME_STATUS_LABELS: Record<MsFileSellerRuntimeStatus, string> = {
  "disabled": "已关闭",
  "waiting-unlock": "等待解锁",
  "indexing": "正在建立本地索引",
  "configuration-error": "配置不完整",
  "ready": "可以接单",
  "selling": "正在销售",
  "degraded": "依赖暂不可用",
};

function concurrencyDraft(settings: MsFileReadConcurrencySettings): ConcurrencyDraft {
  return {
    mediaBlockReadConcurrency: String(settings.mediaBlockReadConcurrency),
    globalSeedReadConcurrency: String(settings.globalSeedReadConcurrency),
    globalBlockReadConcurrency: String(settings.globalBlockReadConcurrency),
    globalStatConcurrency: String(settings.globalStatConcurrency),
  };
}

function estimateInFlightBytes(settings: MsFileReadConcurrencySettings): number {
  return settings.globalSeedReadConcurrency * MSFILE_MAX_SEED_BYTES
    + settings.globalBlockReadConcurrency * MSFILE_MAX_BLOCK_BYTES;
}

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(bytes % (1024 * 1024) === 0 ? 0 : 1)} MiB`;
}

function toDraft(value: MsFileSatoshiAmount | undefined): AmountDraft {
  if (value === "0") return { text: "", unlimited: true };
  return { text: value ?? "", unlimited: false };
}

export function MsFileSettings() {
  const { t } = useI18n();
  // owner 作用域 capability 会在锁定时撤销；设置区可能正好挂载在系统设置
  // 页面上，必须按"暂不可用"渲染而不是抛错。
  const service = useOptionalCapability(MSFILE_SERVICE_CAPABILITY);
  if (!service) {
    return (
      <p className="msfile-settings__unavailable">
        {t("msfile.settings.unavailable", { defaultValue: "钱包已锁定或 MSFile 服务暂不可用；解锁后可继续配置。" })}
      </p>
    );
  }
  return <MsFileSettingsInner service={service} />;
}

function MsFileSettingsInner({ service }: { service: MsFileService }) {
  const { t } = useI18n();
  const host = usePluginHost();
  // 订阅一律走 Resource Store（react 资源边界门禁）；manifest 已注册 msfile.status。
  // 锁定时资源定义会被注销，选择器必须能降级为本地推荐值。
  const statusFallback: MsFileStatusResourceSnapshot = {
    status: service.status(),
    globalSettings: null,
    ...MSFILE_READ_CONCURRENCY_RECOMMENDED,
    approvals: [],
  };
  const statusResource = useOptionalResourceSelector<MsFileStatusResourceSnapshot, MsFileStatusResourceSnapshot>(
    host.resourceStore,
    "msfile.status",
    [],
    (snapshot) => snapshot.data ?? statusFallback,
    statusFallback
  );
  const [snapshot, setSnapshot] = useState<MsFileSettingsSnapshot | null>(null);
  const [authorizations, setAuthorizations] = useState<MsFileAppAuthorizationView[]>([]);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [seedDraft, setSeedDraft] = useState<AmountDraft>({ text: "", unlimited: false });
  const [blockDraft, setBlockDraft] = useState<AmountDraft>({ text: "", unlimited: false });
  const [concurrencyDraftState, setConcurrencyDraftState] = useState<ConcurrencyDraft>(() => concurrencyDraft(MSFILE_READ_CONCURRENCY_RECOMMENDED));
  const [nameDraft, setNameDraft] = useState("");
  const [keyDraft, setKeyDraft] = useState("");
  const [addressesDraft, setAddressesDraft] = useState("");
  const [enabledDraft, setEnabledDraft] = useState(true);
  const [sellerDraft, setSellerDraft] = useState<MsFileSellerSettings>({
    ...MSFILE_SELLER_SETTINGS_DEFAULT,
    supportedArbiterPublicKeys: [],
  });
  const [sellerArbitersDraft, setSellerArbitersDraft] = useState("");
  const [bitfsBuyerDraft, setBitfsBuyerDraft] = useState<BitfsBuyerSettingsDraft>({
    ...MSFILE_BITFS_BUYER_SETTINGS_DEFAULT,
    maxConcurrentDownloads: String(MSFILE_BITFS_BUYER_SETTINGS_DEFAULT.maxConcurrentDownloads),
    maxConcurrentSellerSessions: String(MSFILE_BITFS_BUYER_SETTINGS_DEFAULT.maxConcurrentSellerSessions),
  });
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [probingKey, setProbingKey] = useState<string | null>(null);
  const [probeResult, setProbeResult] = useState<{ key: string; ok: boolean; detail: string } | null>(null);

  const reload = useCallback(async () => {
    try {
      const next = await service.getSettingsSnapshot();
      setSnapshot(next);
      const buyerSettings = await service.getBitfsBuyerSettings?.() ?? { ...MSFILE_BITFS_BUYER_SETTINGS_DEFAULT };
      setBitfsBuyerDraft({
        ...buyerSettings,
        maxConcurrentDownloads: String(buyerSettings.maxConcurrentDownloads),
        maxConcurrentSellerSessions: String(buyerSettings.maxConcurrentSellerSessions),
      });
      setAuthorizations(await service.listAppAuthorizations());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [service]);

  useEffect(() => {
    void reload();
  }, [reload, statusResource]);

  useEffect(() => {
    if (!snapshot?.globalSettings) return;
    setSeedDraft(toDraft(snapshot.globalSettings.seedMaxPriceSatoshis));
    setBlockDraft(toDraft(snapshot.globalSettings.blockMaxPriceSatoshis));
  }, [snapshot?.globalSettings]);

  useEffect(() => {
    if (!snapshot) return;
    setConcurrencyDraftState(concurrencyDraft({
      mediaBlockReadConcurrency: snapshot.mediaBlockReadConcurrency,
      globalSeedReadConcurrency: snapshot.globalSeedReadConcurrency,
      globalBlockReadConcurrency: snapshot.globalBlockReadConcurrency,
      globalStatConcurrency: snapshot.globalStatConcurrency,
    }));
  }, [snapshot?.mediaBlockReadConcurrency, snapshot?.globalSeedReadConcurrency, snapshot?.globalBlockReadConcurrency, snapshot?.globalStatConcurrency]);

  useEffect(() => {
    if (!snapshot) return;
    setSellerDraft({ ...snapshot.sellerSettings, supportedArbiterPublicKeys: [...snapshot.sellerSettings.supportedArbiterPublicKeys] });
    setSellerArbitersDraft(snapshot.sellerSettings.supportedArbiterPublicKeys.join("\n"));
  }, [snapshot?.sellerSettings]);

  async function saveSellerSettings() {
    setError(null);
    setStatusMessage(null);
    const candidate = normalizeMsFileSellerSettings({
      ...sellerDraft,
      supportedArbiterPublicKeys: sellerArbitersDraft.split("\n").map((value) => value.trim().toLowerCase()).filter(Boolean),
    });
    if (!candidate) {
      setError("卖方设置不合法：请检查价格、报价期限、仲裁方公钥和并发上限。");
      return;
    }
    try {
      await service.updateSellerSettings(candidate);
      await reload();
      setStatusMessage("卖方设置已保存。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function saveBitfsBuyerSettings() {
    setError(null);
    setStatusMessage(null);
    const candidate = normalizeMsFileBitfsBuyerSettings({
      ...bitfsBuyerDraft,
      maxConcurrentDownloads: Number(bitfsBuyerDraft.maxConcurrentDownloads),
      maxConcurrentSellerSessions: Number(bitfsBuyerDraft.maxConcurrentSellerSessions),
    });
    if (!candidate) {
      setError("BitFS 买方设置不合法：请检查单块自动购买上限、文件任务数和单文件卖家数（1–16）。");
      return;
    }
    if (!service.updateBitfsBuyerSettings) {
      setError("当前 MSFile 连接不支持 BitFS 买方设置。");
      return;
    }
    try {
      await service.updateBitfsBuyerSettings(candidate);
      setBitfsBuyerDraft({
        ...candidate,
        maxConcurrentDownloads: String(candidate.maxConcurrentDownloads),
        maxConcurrentSellerSessions: String(candidate.maxConcurrentSellerSessions),
      });
      setStatusMessage("BitFS 买方设置已保存。已开始的购买不会改变开池报价。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  // 审查修复（chunk 体积）：multiaddr/libp2p 依赖只在预览 PeerId 时动态加载，
  // 不进入应用主 chunk。
  const [peerIdPreview, setPeerIdPreview] = useState<string | null>(null);
  useEffect(() => {
    const hexKey = keyDraft;
    if (!/^(02|03)[0-9a-f]{64}$/.test(hexKey)) {
      setPeerIdPreview(null);
      return undefined;
    }
    let cancelled = false;
    void import("./supplierConfig.js")
      .then(({ deriveSupplierPeerId: derive }) => {
        if (cancelled) return;
        try {
          setPeerIdPreview(derive(hexKey));
        } catch {
          setPeerIdPreview(null);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [keyDraft]);

  async function savePriceLimits() {
    setError(null);
    setStatusMessage(null);
    const seedValue = seedDraft.unlimited ? "0" : normalizeMsFileSatoshiAmount(seedDraft.text.trim());
    const blockValue = blockDraft.unlimited ? "0" : normalizeMsFileSatoshiAmount(blockDraft.text.trim());
    // 普通输入框不把空值解释为 0：空且未开启“不限”时直接报错。
    if (!seedDraft.unlimited && seedValue === undefined) {
      setError(t("msfile.errors.default", { defaultValue: "Seed limit must be a positive amount or explicit unlimited" }));
      return;
    }
    if (!blockDraft.unlimited && blockValue === undefined) {
      setError(t("msfile.errors.default", { defaultValue: "Block limit must be a positive amount or explicit unlimited" }));
      return;
    }
    try {
      await service.updateGlobalPriceSettings({ seedMaxPriceSatoshis: seedValue!, blockMaxPriceSatoshis: blockValue! });
      setStatusMessage(t("msfile.settings.saved", { defaultValue: "Saved." }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function saveConcurrencyField(_field: ConcurrencyField) {
    setError(null);
    setStatusMessage(null);
    const candidate = normalizeMsFileReadConcurrencySettings({
      mediaBlockReadConcurrency: Number(concurrencyDraftState.mediaBlockReadConcurrency),
      globalSeedReadConcurrency: Number(concurrencyDraftState.globalSeedReadConcurrency),
      globalBlockReadConcurrency: Number(concurrencyDraftState.globalBlockReadConcurrency),
      globalStatConcurrency: Number(concurrencyDraftState.globalStatConcurrency),
    });
    if (!candidate) {
      setError(t("msfile.settings.readConcurrency.validation", {
        defaultValue: "请输入大于等于 1 的安全整数；媒体并发不能大于全局 Block 并发。",
      }));
      return;
    }
    try {
      await service.updateReadConcurrencySettings(candidate);
      setStatusMessage(t("msfile.settings.readConcurrency.saved", {
        defaultValue: "并发设置已保存。新媒体 Session 使用媒体值；之后排队的读取使用全局值。",
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function restoreRecommendedConcurrency() {
    setError(null);
    setStatusMessage(null);
    try {
      await service.resetReadConcurrencySettings();
      setConcurrencyDraftState(concurrencyDraft(MSFILE_READ_CONCURRENCY_RECOMMENDED));
      setStatusMessage(t("msfile.settings.readConcurrency.saved", {
        defaultValue: "并发设置已保存。新媒体 Session 使用媒体值；之后排队的读取使用全局值。",
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function startEditSupplier(supplier: MsFileSupplierConfig) {
    setEditingKey(supplier.supplierPublicKeyHex);
    setNameDraft(supplier.name);
    setKeyDraft(supplier.supplierPublicKeyHex);
    setAddressesDraft(supplier.addresses.join("\n"));
    // 审查修复：编辑保存不得隐式改变 enabled 状态。
    setEnabledDraft(supplier.enabled);
  }

  function resetSupplierForm() {
    setEditingKey(null);
    setNameDraft("");
    setKeyDraft("");
    setAddressesDraft("");
    setEnabledDraft(true);
  }

  async function submitSupplier(enabled: boolean) {
    setError(null);
    try {
      await service.upsertSupplier({
        name: nameDraft,
        supplierPublicKeyHex: keyDraft.trim(),
        addresses: addressesDraft.split("\n").map((line) => line.trim()).filter(Boolean),
        // 编辑路径以表单复选框为准（初值来自被编辑记录）。
        enabled
      });
      resetSupplierForm();
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function removeSupplier(supplier: MsFileSupplierConfig) {
    setError(null);
    if (!window.confirm(t("msfile.settings.supplier.deleteConfirm", { defaultValue: "Delete this supplier?" }))) return;
    try {
      await service.deleteSupplier(supplier.supplierPublicKeyHex);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function toggleSupplier(supplier: MsFileSupplierConfig) {
    setError(null);
    try {
      await service.upsertSupplier({ ...supplier, enabled: !supplier.enabled });
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function testSupplier(supplier: MsFileSupplierConfig) {
    setProbingKey(supplier.supplierPublicKeyHex);
    setProbeResult(null);
    try {
      const result = await service.probeSupplier(supplier.supplierPublicKeyHex);
      setProbeResult({
        key: supplier.supplierPublicKeyHex,
        ok: result.connected,
        detail: result.connected
          ? t("msfile.settings.supplier.testOk", { defaultValue: "Connected" })
          : t("msfile.settings.supplier.testFailed", { defaultValue: "Failed" })
      });
    } catch (cause) {
      setProbeResult({
        key: supplier.supplierPublicKeyHex,
        ok: false,
        detail: cause instanceof Error ? cause.message : String(cause)
      });
    } finally {
      setProbingKey(null);
    }
  }

  async function saveOverride(view: MsFileAppAuthorizationView, kind: "seed" | "block", draft: AmountDraft) {
    setError(null);
    const existing = view.policy?.override ?? {};
    const value = draft.unlimited ? "0" : normalizeMsFileSatoshiAmount(draft.text.trim());
    if (!draft.unlimited && value === undefined) {
      setError(t("msfile.errors.default", { defaultValue: "Amount must be a positive number or explicit unlimited" }));
      return;
    }
    const override = kind === "seed"
      ? { ...existing, seedMaxPriceSatoshis: value }
      : { ...existing, blockMaxPriceSatoshis: value };
    try {
      await service.updateAppPriceOverride({ key: view.key, override });
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function clearOverrides(view: MsFileAppAuthorizationView) {
    setError(null);
    try {
      await service.clearAppPriceOverride(view.key);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  // 审查修复：支持单独让 Seed 或 Block 恢复继承。
  async function restoreSingleOverride(view: MsFileAppAuthorizationView, kind: "seed" | "block") {
    setError(null);
    try {
      const remaining = { ...(view.policy?.override ?? {}) };
      if (kind === "seed") delete remaining.seedMaxPriceSatoshis;
      else delete remaining.blockMaxPriceSatoshis;
      if (!remaining.seedMaxPriceSatoshis && !remaining.blockMaxPriceSatoshis) {
        await service.clearAppPriceOverride(view.key);
      } else {
        await service.updateAppPriceOverride({ key: view.key, override: remaining });
      }
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const approvals: MsFilePendingApprovalView[] = service.listPendingApprovals();

  return (
    <section className="msfile-settings" aria-label={t("msfile.settings.group", { defaultValue: "MSFile" })}>
      <h3>{t("msfile.settings.priceLimits", { defaultValue: "Price limits" })}</h3>
      <p className="msfile-settings__hint">{t("msfile.settings.priceLimits.hint", { defaultValue: "" })}</p>
      <div className="msfile-settings__row">
        <label>
          <span>{t("msfile.settings.seedCap", { defaultValue: "Seed max price" })}</span>
          <input
            value={seedDraft.unlimited ? "" : seedDraft.text}
            disabled={seedDraft.unlimited}
            placeholder={seedDraft.unlimited ? t("msfile.settings.unlimited", { defaultValue: "Unlimited" }) : ""}
            onChange={(event) => setSeedDraft({ ...seedDraft, text: event.target.value })}
          />
          <label className="msfile-settings__checkbox">
            <input
              type="checkbox"
              checked={seedDraft.unlimited}
              onChange={(event) => setSeedDraft({ text: "", unlimited: event.target.checked })}
            />
            <span>{t("msfile.settings.unlimited", { defaultValue: "Unlimited" })}</span>
          </label>
        </label>
        <label>
          <span>{t("msfile.settings.blockCap", { defaultValue: "Block max price" })}</span>
          <input
            value={blockDraft.unlimited ? "" : blockDraft.text}
            disabled={blockDraft.unlimited}
            placeholder={blockDraft.unlimited ? t("msfile.settings.unlimited", { defaultValue: "Unlimited" }) : ""}
            onChange={(event) => setBlockDraft({ ...blockDraft, text: event.target.value })}
          />
          <label className="msfile-settings__checkbox">
            <input
              type="checkbox"
              checked={blockDraft.unlimited}
              onChange={(event) => setBlockDraft({ text: "", unlimited: event.target.checked })}
            />
            <span>{t("msfile.settings.unlimited", { defaultValue: "Unlimited" })}</span>
          </label>
        </label>
        <Button onClick={() => void savePriceLimits()}>{t("msfile.settings.save", { defaultValue: "Save" })}</Button>
      </div>

      <h3>{t("msfile.settings.readConcurrency", { defaultValue: "读取并发与资源" })}</h3>
      <p className="msfile-settings__hint">
        {t("msfile.settings.readConcurrency.hint", {
          defaultValue: "这些字段是读取运输层并发上限，不是预取数或缓存数。调高可能提升高带宽设备的吞吐，但会增加网络、内存、Supplier 压力以及同时付款请求；调低会节约资源，但可能增加等待。",
        })}
      </p>
      <div className="msfile-settings__form msfile-settings__concurrency">
        <ConcurrencySettingRow
          field="mediaBlockReadConcurrency"
          value={concurrencyDraftState.mediaBlockReadConcurrency}
          label={t("msfile.settings.readConcurrency.media", { defaultValue: "单个媒体 Session 的 Block 读取数" })}
          max={MSFILE_READ_CONCURRENCY_HARD_LIMITS.mediaBlockReadConcurrency}
          onChange={(value) => setConcurrencyDraftState((current) => ({ ...current, mediaBlockReadConcurrency: value }))}
          onSave={() => void saveConcurrencyField("mediaBlockReadConcurrency")}
          t={t}
        />
        <ConcurrencySettingRow
          field="globalSeedReadConcurrency"
          value={concurrencyDraftState.globalSeedReadConcurrency}
          label={t("msfile.settings.readConcurrency.seed", { defaultValue: "全局 Seed 读取数" })}
          max={MSFILE_READ_CONCURRENCY_HARD_LIMITS.globalSeedReadConcurrency}
          onChange={(value) => setConcurrencyDraftState((current) => ({ ...current, globalSeedReadConcurrency: value }))}
          onSave={() => void saveConcurrencyField("globalSeedReadConcurrency")}
          t={t}
        />
        <ConcurrencySettingRow
          field="globalBlockReadConcurrency"
          value={concurrencyDraftState.globalBlockReadConcurrency}
          label={t("msfile.settings.readConcurrency.block", { defaultValue: "全局 Block 读取数" })}
          max={MSFILE_READ_CONCURRENCY_HARD_LIMITS.globalBlockReadConcurrency}
          onChange={(value) => setConcurrencyDraftState((current) => ({ ...current, globalBlockReadConcurrency: value }))}
          onSave={() => void saveConcurrencyField("globalBlockReadConcurrency")}
          t={t}
        />
        <ConcurrencySettingRow
          field="globalStatConcurrency"
          value={concurrencyDraftState.globalStatConcurrency}
          label={t("msfile.settings.readConcurrency.stat", { defaultValue: "全局 Stat 查询并发数" })}
          hint={t("msfile.settings.readConcurrency.stat.hint", {
            defaultValue: "Keymaster 同时处理的 Stat 查询任务数量。每个查询仍会询问所有已启用的 Supplier。",
          })}
          max={MSFILE_READ_CONCURRENCY_HARD_LIMITS.globalStatConcurrency}
          onChange={(value) => setConcurrencyDraftState((current) => ({ ...current, globalStatConcurrency: value }))}
          onSave={() => void saveConcurrencyField("globalStatConcurrency")}
          t={t}
        />
        {(() => {
          const current = normalizeMsFileReadConcurrencySettings({
            mediaBlockReadConcurrency: Number(concurrencyDraftState.mediaBlockReadConcurrency),
            globalSeedReadConcurrency: Number(concurrencyDraftState.globalSeedReadConcurrency),
            globalBlockReadConcurrency: Number(concurrencyDraftState.globalBlockReadConcurrency),
            globalStatConcurrency: Number(concurrencyDraftState.globalStatConcurrency),
          });
          return current ? (
            <p className="msfile-settings__hint">
              {t("msfile.settings.readConcurrency.estimate", {
                defaultValue: "媒体最坏在途字节估算：{{bytes}}（Seed 并发 × 16 MiB + Block 并发 × 256 KiB）。",
                bytes: formatMiB(estimateInFlightBytes(current)),
              })}
            </p>
          ) : null;
        })()}
        <Button variant="secondary" onClick={() => void restoreRecommendedConcurrency()}>
          {t("msfile.settings.readConcurrency.reset", { defaultValue: "恢复建议值" })}
        </Button>
      </div>

      <h3>BitFS 卖方模式</h3>
      <p className="msfile-settings__hint">
        开启后，当前 Key 可出售本地完整文件。卖方运行期间会暂停 Vault 自动锁，但不会自动解锁；手动锁定仍会立即停止接单并清除内存索引。
      </p>
      <p className="msfile-settings__hint">
        当前运行状态：{SELLER_RUNTIME_STATUS_LABELS[snapshot?.sellerRuntimeStatus ?? "disabled"]}（
        {snapshot?.sellerRuntimeStatus ?? "disabled"}）。「依赖暂不可用」表示 BitFS 卖方协议或 Window
        传输尚未就绪，此时不会对外报价。
      </p>
      <div className="msfile-settings__form">
        <label className="msfile-settings__checkbox">
          <input
            type="checkbox"
            checked={sellerDraft.sellerEnabled}
            onChange={(event) => setSellerDraft((current) => ({ ...current, sellerEnabled: event.target.checked }))}
          />
          <span>允许当前 Key 作为 BitFS 卖方</span>
        </label>
        <label>
          <span>单个 Seed 售价（聪）</span>
          <input value={sellerDraft.seedPriceSatoshis} onChange={(event) => setSellerDraft((current) => ({ ...current, seedPriceSatoshis: event.target.value }))} />
        </label>
        <label>
          <span>完整 256 KiB Block 售价（聪）</span>
          <input value={sellerDraft.fullBlockPriceSatoshis} onChange={(event) => setSellerDraft((current) => ({ ...current, fullBlockPriceSatoshis: event.target.value }))} />
        </label>
        <label>
          <span>报价有效时间（秒，30–86400）</span>
          <input type="number" min={30} max={86400} value={sellerDraft.quoteLifetimeSeconds} onChange={(event) => setSellerDraft((current) => ({ ...current, quoteLifetimeSeconds: Number(event.target.value) }))} />
        </label>
        <label>
          <span>接受的仲裁方压缩公钥（每行一个）</span>
          <textarea rows={4} value={sellerArbitersDraft} onChange={(event) => setSellerArbitersDraft(event.target.value)} />
        </label>
        <label>
          <span>同时销售会话上限（1–16）</span>
          <input type="number" min={1} max={16} value={sellerDraft.maxConcurrentSales} onChange={(event) => setSellerDraft((current) => ({ ...current, maxConcurrentSales: Number(event.target.value) }))} />
        </label>
        <Button onClick={() => void saveSellerSettings()}>保存卖方设置</Button>
      </div>

      <h3>{t("msfile.settings.bitfsBuyer.title", { defaultValue: "BitFS 买方自动购买" })}</h3>
      <p className="msfile-settings__hint">
        {t("msfile.settings.bitfsBuyer.hint", { defaultValue: "自动购买默认关闭。启用后只在完整 Block 单价不高于下方上限时自动开始；该上限按单块计算，不限制文件总价。强制下载仍由每个文件任务单独决定；单文件卖家数决定同时参与传输的费用池数量。" })}
      </p>
      <div className="msfile-settings__form">
        <label className="msfile-settings__checkbox">
          <input
            type="checkbox"
            checked={bitfsBuyerDraft.buyerAutoPurchaseEnabled}
            onChange={(event) => setBitfsBuyerDraft((current) => ({ ...current, buyerAutoPurchaseEnabled: event.target.checked }))}
          />
          <span>{t("msfile.settings.bitfsBuyer.enabled", { defaultValue: "允许合格报价自动开始购买" })}</span>
        </label>
        <label>
          <span>{t("msfile.settings.bitfsBuyer.maxBlockPrice", { defaultValue: "自动购买完整 Block 最高价（聪）" })}</span>
          <input
            inputMode="numeric"
            value={bitfsBuyerDraft.maxFullBlockPriceSatoshis}
            onChange={(event) => setBitfsBuyerDraft((current) => ({ ...current, maxFullBlockPriceSatoshis: event.target.value }))}
          />
        </label>
        <label>
          <span>{t("msfile.settings.bitfsBuyer.priority", { defaultValue: "卖家选择优先级" })}</span>
          <select
            value={bitfsBuyerDraft.sellerSelectionPriority}
            onChange={(event) => setBitfsBuyerDraft((current) => ({ ...current, sellerSelectionPriority: event.target.value as MsFileBitfsBuyerSettings["sellerSelectionPriority"] }))}
          >
            <option value="price">{t("msfile.settings.bitfsBuyer.priority.price", { defaultValue: "价格优先" })}</option>
            <option value="recent-speed">{t("msfile.settings.bitfsBuyer.priority.speed", { defaultValue: "最近速度优先（无速度记录时按价格）" })}</option>
          </select>
        </label>
        <label>
          <span>{t("msfile.settings.bitfsBuyer.concurrency", { defaultValue: "同时购买文件任务数（1–16）" })}</span>
          <input
            type="number"
            min={1}
            max={MSFILE_BITFS_BUYER_LIMITS.maxConcurrentDownloads}
            value={bitfsBuyerDraft.maxConcurrentDownloads}
            onChange={(event) => setBitfsBuyerDraft((current) => ({ ...current, maxConcurrentDownloads: event.target.value }))}
          />
        </label>
        <label>
          <span>{t("msfile.settings.bitfsBuyer.sellerConcurrency", { defaultValue: "单个文件同时传输的卖家数（1–16）" })}</span>
          <input
            type="number"
            min={1}
            max={MSFILE_BITFS_BUYER_LIMITS.maxConcurrentSellerSessions}
            value={bitfsBuyerDraft.maxConcurrentSellerSessions}
            onChange={(event) => setBitfsBuyerDraft((current) => ({ ...current, maxConcurrentSellerSessions: event.target.value }))}
          />
        </label>
        <Button onClick={() => void saveBitfsBuyerSettings()}>
          {t("msfile.settings.bitfsBuyer.save", { defaultValue: "保存 BitFS 买方设置" })}
        </Button>
      </div>

      <h3>{t("msfile.settings.suppliers", { defaultValue: "Suppliers" })}</h3>
      <ul className="msfile-settings__suppliers">
        {(snapshot?.suppliers ?? []).map((supplier) => (
          <li key={supplier.supplierPublicKeyHex}>
            <div className="msfile-settings__supplier-line">
              <strong>{supplier.name}</strong>
              {supplier.builtin ? (
                <span className="msfile-settings__badge">{t("msfile.settings.supplier.builtin", { defaultValue: "System default" })}</span>
              ) : null}
              <code title={supplier.supplierPublicKeyHex}>{supplier.supplierPublicKeyHex.slice(0, 12)}…</code>
              <span>{supplier.addresses.length} addr</span>
              {supplier.builtin ? (
                <span className="msfile-settings__fixed">
                  {t("msfile.settings.supplier.builtinFixed", { defaultValue: "Always enabled; cannot be edited or deleted" })}
                </span>
              ) : (
                <>
                  <label className="msfile-settings__checkbox">
                    <input type="checkbox" checked={supplier.enabled} onChange={() => void toggleSupplier(supplier)} />
                    <span>{t("msfile.settings.supplier.enabled", { defaultValue: "Enabled" })}</span>
                  </label>
                  <Button variant="secondary" onClick={() => startEditSupplier(supplier)}>
                    {t("msfile.settings.supplier.edit", { defaultValue: "Edit" })}
                  </Button>
                </>
              )}
              <Button variant="secondary" onClick={() => void testSupplier(supplier)} disabled={probingKey === supplier.supplierPublicKeyHex}>
                {probingKey === supplier.supplierPublicKeyHex
                  ? t("msfile.settings.supplier.testing", { defaultValue: "Testing…" })
                  : t("msfile.settings.supplier.test", { defaultValue: "Test connection" })}
              </Button>
              {supplier.builtin ? null : (
                <Button variant="danger" onClick={() => void removeSupplier(supplier)}>
                  {t("msfile.settings.supplier.delete", { defaultValue: "Delete" })}
                </Button>
              )}
            </div>
            {probeResult?.key === supplier.supplierPublicKeyHex ? (
              <p className={probeResult.ok ? "msfile-settings__ok" : "msfile-settings__error"}>{probeResult.detail}</p>
            ) : null}
          </li>
        ))}
      </ul>

      <div className="msfile-settings__form">
        <label>
          <span>{t("msfile.settings.supplier.name", { defaultValue: "Display name" })}</span>
          <input value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} />
        </label>
        <label>
          <span>{t("msfile.settings.supplier.publicKey", { defaultValue: "Public key" })}</span>
          <input
            value={keyDraft}
            disabled={editingKey !== null}
            onChange={(event) => setKeyDraft(event.target.value.toLowerCase())}
          />
        </label>
        {peerIdPreview ? (
          <p className="msfile-settings__hint">
            {t("msfile.settings.supplier.peerId", { defaultValue: "PeerId" })}: <code>{peerIdPreview}</code>
          </p>
        ) : null}
        <label>
          <span>{t("msfile.settings.supplier.addresses", { defaultValue: "Addresses" })}</span>
          <textarea rows={4} value={addressesDraft} onChange={(event) => setAddressesDraft(event.target.value)} />
        </label>
        <label className="msfile-settings__checkbox">
          <input
            type="checkbox"
            checked={enabledDraft}
            onChange={(event) => setEnabledDraft(event.target.checked)}
          />
          <span>{t("msfile.settings.supplier.enabled", { defaultValue: "Enabled" })}</span>
        </label>
        <div className="msfile-settings__actions">
          <Button onClick={() => void submitSupplier(enabledDraft)}>
            {editingKey ? t("msfile.settings.supplier.edit", { defaultValue: "Save" }) : t("msfile.settings.supplier.add", { defaultValue: "Add supplier" })}
          </Button>
          {editingKey ? <Button variant="secondary" onClick={resetSupplierForm}>Cancel</Button> : null}
        </div>
      </div>

      <h3>{t("msfile.settings.apps", { defaultValue: "Connect App authorizations" })}</h3>
      {authorizations.length === 0 ? (
        <p className="msfile-settings__hint">{t("msfile.settings.apps.empty", { defaultValue: "No apps yet." })}</p>
      ) : (
        <ul className="msfile-settings__apps">
          {authorizations.map((view) => (
            <AppAuthorizationRow
              key={`${view.key.ownerPublicKeyHex}|${view.key.publisherPublicKeyHex}|${view.key.appId}`}
              view={view}
              globalSettings={snapshot?.globalSettings ?? null}
              onSave={saveOverride}
              onClear={() => void clearOverrides(view)}
              onRestore={(kind) => void restoreSingleOverride(view, kind)}
            />
          ))}
        </ul>
      )}

      {approvals.length > 0 ? (
        <p className="msfile-settings__hint">
          {approvals.length} pending price confirmation(s)
        </p>
      ) : null}

      {error ? <p className="msfile-settings__error">{error}</p> : null}
      {statusMessage ? <p className="msfile-settings__ok">{statusMessage}</p> : null}
    </section>
  );
}

function ConcurrencySettingRow(props: {
  field: ConcurrencyField;
  value: string;
  label: string;
  hint?: string;
  max: number;
  onChange: (value: string) => void;
  onSave: () => void;
  t: (key: string, values?: Record<string, string | number | boolean | null | undefined>) => string;
}) {
  const { field, value, label, hint, max, onChange, onSave, t } = props;
  const inputId = `msfile-${field}`;
  return (
    <div className="msfile-settings__row">
      <label htmlFor={inputId}>
        <span>{label}</span>
        <input
          id={inputId}
          type="number"
          min={1}
          max={max}
          step={1}
          inputMode="numeric"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      {hint ? <p className="msfile-settings__hint">{hint}</p> : null}
      <Button onClick={onSave}>{t("msfile.settings.readConcurrency.save", { defaultValue: "保存并发设置" })}</Button>
    </div>
  );
}

function AppAuthorizationRow(props: {
  view: MsFileAppAuthorizationView;
  globalSettings: MsFileSettingsSnapshot["globalSettings"];
  onSave: (view: MsFileAppAuthorizationView, kind: "seed" | "block", draft: AmountDraft) => Promise<void>;
  onClear: () => void;
  onRestore: (kind: "seed" | "block") => void;
}) {
  const { t } = useI18n();
  const { view, globalSettings } = props;
  const [editing, setEditing] = useState(false);
  const [seedDraft, setSeedDraft] = useState<AmountDraft>({ text: "", unlimited: false });
  const [blockDraft, setBlockDraft] = useState<AmountDraft>({ text: "", unlimited: false });

  const overrideOf = (kind: "seed" | "block"): string | undefined =>
    kind === "seed"
      ? view.policy?.override.seedMaxPriceSatoshis ?? undefined
      : view.policy?.override.blockMaxPriceSatoshis ?? undefined;
  // 审查修复：继承态展示实际生效的全局金额。
  const inheritedOf = (kind: "seed" | "block"): string =>
    (globalSettings ? (kind === "seed" ? globalSettings.seedMaxPriceSatoshis : globalSettings.blockMaxPriceSatoshis) : undefined) ?? "";
  const describeCap = (kind: "seed" | "block"): string => {
    const override = overrideOf(kind);
    if (override !== undefined) {
      return `${override} (${t("msfile.settings.apps.override", { defaultValue: "override" })})`;
    }
    const inherited = inheritedOf(kind);
    return inherited
      ? `${inherited} (${t("msfile.settings.apps.inherited", { defaultValue: "Inherited" })})`
      : t("msfile.settings.apps.inherited", { defaultValue: "Inherited" });
  };

  return (
    <li>
      <div className="msfile-settings__supplier-line">
        <strong>{view.appName}</strong>
        <code title={view.key.publisherPublicKeyHex}>{view.key.publisherPublicKeyHex.slice(0, 10)}…</code>
        <span>appId: {view.key.appId}</span>
      </div>
      <p className="msfile-settings__hint">
        Seed: {describeCap("seed")}
        {" · "}
        Block: {describeCap("block")}
      </p>
      {editing ? (
        <div className="msfile-settings__form">
          <label>
            <span>Seed override</span>
            <input
              value={seedDraft.unlimited ? "" : seedDraft.text}
              disabled={seedDraft.unlimited}
              onChange={(event) => setSeedDraft({ ...seedDraft, text: event.target.value })}
            />
            <label className="msfile-settings__checkbox">
              <input
                type="checkbox"
                checked={seedDraft.unlimited}
                onChange={(event) => setSeedDraft({ text: "", unlimited: event.target.checked })}
              />
              <span>{t("msfile.settings.unlimited", { defaultValue: "Unlimited" })}</span>
            </label>
            <Button onClick={() => void props.onSave(view, "seed", seedDraft)}>Save seed</Button>
          </label>
          <label>
            <span>Block override</span>
            <input
              value={blockDraft.unlimited ? "" : blockDraft.text}
              disabled={blockDraft.unlimited}
              onChange={(event) => setBlockDraft({ ...blockDraft, text: event.target.value })}
            />
            <label className="msfile-settings__checkbox">
              <input
                type="checkbox"
                checked={blockDraft.unlimited}
                onChange={(event) => setBlockDraft({ text: "", unlimited: event.target.checked })}
              />
              <span>{t("msfile.settings.unlimited", { defaultValue: "Unlimited" })}</span>
            </label>
            <Button onClick={() => void props.onSave(view, "block", blockDraft)}>Save block</Button>
          </label>
        </div>
      ) : null}
      <div className="msfile-settings__actions">
        <Button
          variant="secondary"
          onClick={() => {
            setSeedDraft(toDraft(overrideOf("seed")));
            setBlockDraft(toDraft(overrideOf("block")));
            setEditing((value) => !value);
          }}
        >
          {t("msfile.settings.apps.editOverride", { defaultValue: "Edit overrides" })}
        </Button>
        {overrideOf("seed") || overrideOf("block") ? (
          <>
            {overrideOf("seed") ? (
              <Button variant="secondary" onClick={() => props.onRestore("seed")}>
                Restore seed inheritance
              </Button>
            ) : null}
            {overrideOf("block") ? (
              <Button variant="secondary" onClick={() => props.onRestore("block")}>
                Restore block inheritance
              </Button>
            ) : null}
            <Button variant="danger" onClick={props.onClear}>
              {t("msfile.settings.apps.clearAll", { defaultValue: "Restore inheritance" })}
            </Button>
          </>
        ) : null}
      </div>
    </li>
  );
}
