// packages/plugin-msfile/src/MsFileSettings.tsx
// /settings/local-files 的本地文件页：价格限制 / 供应商配置 / Connect App 授权。
// 页面只在 Vault unlocked 时通过设置菜单进入。
// 所有读写都通过 `msfile.service`；本组件不接触 platform K-V repository。

import { useCallback, useEffect, useId, useMemo, useState } from "react";
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
import { Button, Modal, PageHeader } from "@keymaster/ui";
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
type BitfsBuyerSettingsDraft = Omit<MsFileBitfsBuyerSettings, "maxConcurrentDownloads" | "maxConcurrentSellerSessions" | "blocksPerBatch"> & {
  maxConcurrentDownloads: string;
  maxConcurrentSellerSessions: string;
  blocksPerBatch: string;
};

/** 卖方状态缺省文案；正式界面优先使用 i18n 资源。 */
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
  const service = useOptionalCapability(MSFILE_SERVICE_CAPABILITY);
  return (
    <div className="msfile-settings-page">
      <PageHeader
        title={t("msfile.settings.page.title", { defaultValue: "Local files" })}
        description={t("msfile.settings.page.description", {
          defaultValue: "Configure local file price limits, suppliers, and Connect App authorizations."
        })}
      />
      {service ? <MsFileSettingsInner service={service} /> : (
        <p className="msfile-settings__unavailable">
          {t("msfile.settings.unavailable", { defaultValue: "钱包已锁定或 MSFile 服务暂不可用；解锁后可继续配置。" })}
        </p>
      )}
    </div>
  );
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
    blocksPerBatch: String(MSFILE_BITFS_BUYER_SETTINGS_DEFAULT.blocksPerBatch),
  });
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [supplierEditorOpen, setSupplierEditorOpen] = useState(false);
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
        blocksPerBatch: String(buyerSettings.blocksPerBatch),
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
      blocksPerBatch: Number(bitfsBuyerDraft.blocksPerBatch),
    });
    if (!candidate) {
      setError("BitFS 买方设置不合法：请检查单块自动购买上限、文件任务数、单文件卖家数和每批块数（1–16）。");
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
        blocksPerBatch: String(candidate.blocksPerBatch),
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

  async function saveConcurrencySettings() {
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
    setSupplierEditorOpen(true);
  }

  function resetSupplierForm() {
    setEditingKey(null);
    setNameDraft("");
    setKeyDraft("");
    setAddressesDraft("");
    setEnabledDraft(true);
  }

  function closeSupplierEditor() {
    setSupplierEditorOpen(false);
    resetSupplierForm();
  }

  function openSupplierEditor() {
    resetSupplierForm();
    setSupplierEditorOpen(true);
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
      await reload();
      closeSupplierEditor();
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
  const suppliers = snapshot?.suppliers ?? [];
  const enabledSourceCount = suppliers.filter((supplier) => supplier.enabled).length;
  const serviceStatus = statusResource.status;
  const sellerStatus = snapshot?.sellerRuntimeStatus ?? "disabled";

  return (
    <section className="msfile-settings" aria-label={t("msfile.settings.group", { defaultValue: "Local files" })}>
      {error ? <p className="msfile-settings__feedback is-error" role="alert">{error}</p> : null}
          {statusMessage ? <p className="msfile-settings__feedback is-success" role="status">{statusMessage}</p> : null}
          <div className="msfile-settings__overview" aria-label={t("msfile.settings.overview.label", { defaultValue: "配置状态" })}>
            <div className="msfile-settings__overview-card">
              <span>{t("msfile.settings.overview.service", { defaultValue: "服务状态" })}</span>
              <strong className={`is-${serviceStatus}`}>
                {t(`msfile.settings.overview.service.${serviceStatus}`, {
                  defaultValue: serviceStatus === "ready" ? "可用" : serviceStatus === "unconfigured" ? "需要配置" : "暂不可用"
                })}
              </strong>
            </div>
            <div className="msfile-settings__overview-card">
              <span>{t("msfile.settings.overview.sources", { defaultValue: "文件来源" })}</span>
              <strong>{t("msfile.settings.overview.sources.value", {
                defaultValue: "已启用 {{enabled}} / {{total}}",
                enabled: enabledSourceCount,
                total: suppliers.length
              })}</strong>
            </div>
            <div className="msfile-settings__overview-card">
              <span>{t("msfile.settings.overview.limits", { defaultValue: "全局限额" })}</span>
              <strong className={snapshot?.globalSettings ? "is-ready" : "is-unconfigured"}>
                {snapshot?.globalSettings
                  ? t("msfile.settings.overview.limits.configured", { defaultValue: "已配置" })
                  : t("msfile.settings.overview.limits.missing", { defaultValue: "未配置" })}
              </strong>
            </div>
          </div>
          <section className="msfile-settings__section" id="msfile-spending" aria-labelledby="msfile-spending-title">
            <header className="msfile-settings__section-header">
              <div>
                <h2 id="msfile-spending-title">{t("msfile.settings.section.spend", { defaultValue: "支付与限额" })}</h2>
                <p>{t("msfile.settings.section.spend.desc", { defaultValue: "设置 Keymaster 为单个 Seed 或 Block 最多支付的金额。" })}</p>
              </div>
            </header>
            <div className="msfile-settings__price-grid">
              <div className="msfile-settings__field">
                <label htmlFor="msfile-seed-limit">{t("msfile.settings.seedCap", { defaultValue: "Seed max price" })}</label>
                <input
                  id="msfile-seed-limit"
                  className="msfile-settings__control"
                  inputMode="numeric"
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
              </div>
              <div className="msfile-settings__field">
                <label htmlFor="msfile-block-limit">{t("msfile.settings.blockCap", { defaultValue: "Block max price" })}</label>
                <input
                  id="msfile-block-limit"
                  className="msfile-settings__control"
                  inputMode="numeric"
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
              </div>
            </div>
            <div className="msfile-settings__section-actions">
              <Button onClick={() => void savePriceLimits()}>{t("msfile.settings.save", { defaultValue: "Save price limits" })}</Button>
            </div>
          </section>

      <section className="msfile-settings__section" id="msfile-performance" aria-labelledby="msfile-performance-title">
        <header className="msfile-settings__section-header">
          <div>
            <h2 id="msfile-performance-title">{t("msfile.settings.section.performance", { defaultValue: "读取性能" })}</h2>
            <p>{t("msfile.settings.section.performance.desc", { defaultValue: "调整当前设备的并发读取能力，不改变文件校验规则。" })}</p>
          </div>
        </header>
        <div className="msfile-settings__concurrency-grid">
          <ConcurrencySettingRow
            field="mediaBlockReadConcurrency"
            value={concurrencyDraftState.mediaBlockReadConcurrency}
            label={t("msfile.settings.readConcurrency.media", { defaultValue: "单个媒体 Session 的 Block 读取数" })}
            max={MSFILE_READ_CONCURRENCY_HARD_LIMITS.mediaBlockReadConcurrency}
            onChange={(value) => setConcurrencyDraftState((current) => ({ ...current, mediaBlockReadConcurrency: value }))}
          />
          <ConcurrencySettingRow
            field="globalSeedReadConcurrency"
            value={concurrencyDraftState.globalSeedReadConcurrency}
            label={t("msfile.settings.readConcurrency.seed", { defaultValue: "全局 Seed 读取数" })}
            max={MSFILE_READ_CONCURRENCY_HARD_LIMITS.globalSeedReadConcurrency}
            onChange={(value) => setConcurrencyDraftState((current) => ({ ...current, globalSeedReadConcurrency: value }))}
          />
          <ConcurrencySettingRow
            field="globalBlockReadConcurrency"
            value={concurrencyDraftState.globalBlockReadConcurrency}
            label={t("msfile.settings.readConcurrency.block", { defaultValue: "全局 Block 读取数" })}
            max={MSFILE_READ_CONCURRENCY_HARD_LIMITS.globalBlockReadConcurrency}
            onChange={(value) => setConcurrencyDraftState((current) => ({ ...current, globalBlockReadConcurrency: value }))}
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
          />
        </div>
        {(() => {
          const current = normalizeMsFileReadConcurrencySettings({
            mediaBlockReadConcurrency: Number(concurrencyDraftState.mediaBlockReadConcurrency),
            globalSeedReadConcurrency: Number(concurrencyDraftState.globalSeedReadConcurrency),
            globalBlockReadConcurrency: Number(concurrencyDraftState.globalBlockReadConcurrency),
            globalStatConcurrency: Number(concurrencyDraftState.globalStatConcurrency),
          });
          return current ? (
            <p className="msfile-settings__callout">
              {t("msfile.settings.readConcurrency.estimate", {
                defaultValue: "媒体最坏在途字节估算：{{bytes}}（Seed 并发 × 16 MiB + Block 并发 × 256 KiB）。",
                bytes: formatMiB(estimateInFlightBytes(current)),
              })}
            </p>
          ) : null;
        })()}
        <div className="msfile-settings__section-actions">
          <Button variant="secondary" onClick={() => void restoreRecommendedConcurrency()}>
            {t("msfile.settings.readConcurrency.reset", { defaultValue: "恢复建议值" })}
          </Button>
          <Button onClick={() => void saveConcurrencySettings()}>
            {t("msfile.settings.readConcurrency.save", { defaultValue: "保存并发设置" })}
          </Button>
        </div>
      </section>

      <section className="msfile-settings__section" id="msfile-selling" aria-labelledby="msfile-selling-title">
        <header className="msfile-settings__section-header">
          <div>
            <h2 id="msfile-selling-title">{t("msfile.settings.section.seller", { defaultValue: "出售本地文件" })}</h2>
            <p>{t("msfile.settings.section.seller.desc", { defaultValue: "控制当前 Key 是否可以通过 BitFS 出售完整本地文件。" })}</p>
          </div>
          <span className={`msfile-settings__status is-${sellerStatus}`}>
            {t(`msfile.settings.seller.status.${sellerStatus}`, {
              defaultValue: SELLER_RUNTIME_STATUS_LABELS[sellerStatus]
            })}
          </span>
        </header>
        <div className="msfile-settings__callout">
          <p>{t("msfile.settings.seller.warning", {
            defaultValue: "开启后，卖方运行期间会暂停 Vault 自动锁，但不会自动解锁；手动锁定仍会立即停止接单并清除内存索引。"
          })}</p>
          <p>{t("msfile.settings.seller.degraded", {
            defaultValue: "“依赖暂不可用”表示 BitFS 卖方协议或 Window 传输尚未就绪，此时不会对外报价。"
          })}</p>
        </div>
        <div className="msfile-settings__form-grid">
          <label className="msfile-settings__checkbox is-wide">
            <input
              type="checkbox"
              checked={sellerDraft.sellerEnabled}
              onChange={(event) => setSellerDraft((current) => ({ ...current, sellerEnabled: event.target.checked }))}
            />
            <span>{t("msfile.settings.seller.enable", { defaultValue: "允许当前 Key 出售本地文件" })}</span>
          </label>
          <div className="msfile-settings__field">
            <label htmlFor="msfile-seller-seed-price">{t("msfile.settings.seller.seedPrice", { defaultValue: "单个 Seed 售价（聪）" })}</label>
            <input
              id="msfile-seller-seed-price"
              className="msfile-settings__control"
              inputMode="numeric"
              value={sellerDraft.seedPriceSatoshis}
              onChange={(event) => setSellerDraft((current) => ({ ...current, seedPriceSatoshis: event.target.value }))}
            />
          </div>
          <div className="msfile-settings__field">
            <label htmlFor="msfile-seller-block-price">{t("msfile.settings.seller.blockPrice", { defaultValue: "完整 256 KiB Block 售价（聪）" })}</label>
            <input
              id="msfile-seller-block-price"
              className="msfile-settings__control"
              inputMode="numeric"
              value={sellerDraft.fullBlockPriceSatoshis}
              onChange={(event) => setSellerDraft((current) => ({ ...current, fullBlockPriceSatoshis: event.target.value }))}
            />
          </div>
          <div className="msfile-settings__field">
            <label htmlFor="msfile-seller-quote-lifetime">{t("msfile.settings.seller.quoteLifetime", { defaultValue: "报价有效时间（秒，30–86400）" })}</label>
            <input
              id="msfile-seller-quote-lifetime"
              className="msfile-settings__control"
              type="number"
              min={30}
              max={86400}
              value={sellerDraft.quoteLifetimeSeconds}
              onChange={(event) => setSellerDraft((current) => ({ ...current, quoteLifetimeSeconds: Number(event.target.value) }))}
            />
          </div>
          <div className="msfile-settings__field">
            <label htmlFor="msfile-seller-max-sales">{t("msfile.settings.seller.maxSales", { defaultValue: "同时销售会话上限（1–16）" })}</label>
            <input
              id="msfile-seller-max-sales"
              className="msfile-settings__control"
              type="number"
              min={1}
              max={16}
              value={sellerDraft.maxConcurrentSales}
              onChange={(event) => setSellerDraft((current) => ({ ...current, maxConcurrentSales: Number(event.target.value) }))}
            />
          </div>
          <div className="msfile-settings__field is-wide">
            <label htmlFor="msfile-seller-arbiters">{t("msfile.settings.seller.arbiters", { defaultValue: "接受的仲裁方压缩公钥（每行一个）" })}</label>
            <textarea
              id="msfile-seller-arbiters"
              className="msfile-settings__control"
              rows={4}
              value={sellerArbitersDraft}
              onChange={(event) => setSellerArbitersDraft(event.target.value)}
            />
          </div>
        </div>
        <div className="msfile-settings__section-actions">
          <Button onClick={() => void saveSellerSettings()}>{t("msfile.settings.seller.save", { defaultValue: "保存卖方设置" })}</Button>
        </div>
      </section>

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
        <label>
          <span>{t("msfile.settings.bitfsBuyer.blocksPerBatch", { defaultValue: "每次请求的文件块数（1–16，默认 10）" })}</span>
          <input
            type="number"
            min={1}
            max={MSFILE_BITFS_BUYER_LIMITS.blocksPerBatch}
            value={bitfsBuyerDraft.blocksPerBatch}
            onChange={(event) => setBitfsBuyerDraft((current) => ({ ...current, blocksPerBatch: event.target.value }))}
          />
        </label>
        <Button onClick={() => void saveBitfsBuyerSettings()}>
          {t("msfile.settings.bitfsBuyer.save", { defaultValue: "保存 BitFS 买方设置" })}
        </Button>
      </div>

      <section className="msfile-settings__section" id="msfile-sources" aria-labelledby="msfile-sources-title">
        <header className="msfile-settings__section-header">
          <div>
            <h2 id="msfile-sources-title">{t("msfile.settings.section.suppliers", { defaultValue: "文件来源" })}</h2>
            <p>{t("msfile.settings.section.suppliers.desc", { defaultValue: "选择哪些供应商可以响应 Stat 和 Read 请求。" })}</p>
          </div>
          <div className="msfile-settings__section-header-actions">
            <span className="msfile-settings__count">{suppliers.length}</span>
            <Button size="sm" onClick={openSupplierEditor}>
              {t("msfile.settings.supplier.openAdd", { defaultValue: "添加" })}
            </Button>
          </div>
        </header>
        {suppliers.length === 0 ? (
          <p className="msfile-settings__empty">{t("msfile.settings.suppliers.empty", { defaultValue: "暂无文件来源。" })}</p>
        ) : (
        <ul className="msfile-settings__suppliers">
        {suppliers.map((supplier) => (
          <li key={supplier.supplierPublicKeyHex} className="msfile-settings__supplier-card">
            <div className="msfile-settings__supplier-header">
              <div className="msfile-settings__supplier-identity">
                <strong>{supplier.name}</strong>
                {supplier.builtin ? (
                  <span className="msfile-settings__badge">{t("msfile.settings.supplier.builtin", { defaultValue: "System default" })}</span>
                ) : null}
                <span className={`msfile-settings__status ${supplier.enabled ? "is-ready" : "is-disabled"}`}>
                  {supplier.enabled
                    ? t("msfile.settings.supplier.enabled", { defaultValue: "已启用" })
                    : t("msfile.settings.supplier.disabled", { defaultValue: "已停用" })}
                </span>
              </div>
              <div className="msfile-settings__supplier-actions">
                {supplier.builtin ? null : (
                  <label className="msfile-settings__checkbox">
                    <input type="checkbox" checked={supplier.enabled} onChange={() => void toggleSupplier(supplier)} />
                    <span>{t("msfile.settings.supplier.enabled", { defaultValue: "Enabled" })}</span>
                  </label>
                )}
                <Button variant="secondary" size="sm" onClick={() => void testSupplier(supplier)} disabled={probingKey === supplier.supplierPublicKeyHex}>
                  {probingKey === supplier.supplierPublicKeyHex
                    ? t("msfile.settings.supplier.testing", { defaultValue: "Testing…" })
                    : t("msfile.settings.supplier.test", { defaultValue: "Test connection" })}
                </Button>
                {supplier.builtin ? null : (
                  <>
                    <Button variant="secondary" size="sm" onClick={() => startEditSupplier(supplier)}>
                      {t("msfile.settings.supplier.edit", { defaultValue: "Edit" })}
                    </Button>
                    <Button variant="danger" size="sm" onClick={() => void removeSupplier(supplier)}>
                      {t("msfile.settings.supplier.delete", { defaultValue: "Delete" })}
                    </Button>
                  </>
                )}
              </div>
            </div>
            <dl className="msfile-settings__metadata">
              <div>
                <dt>{t("msfile.settings.supplier.publicKey", { defaultValue: "Public key" })}</dt>
                <dd><code title={supplier.supplierPublicKeyHex}>{supplier.supplierPublicKeyHex.slice(0, 16)}…</code></dd>
              </div>
              <div>
                <dt>{t("msfile.settings.supplier.addresses", { defaultValue: "Dialable addresses" })}</dt>
                <dd>{t("msfile.settings.supplier.addressCount", { defaultValue: "{{count}} 个地址", count: supplier.addresses.length })}</dd>
              </div>
            </dl>
            {supplier.builtin ? (
              <p className="msfile-settings__hint">{t("msfile.settings.supplier.builtinFixed", { defaultValue: "Always enabled; cannot be edited or deleted" })}</p>
            ) : null}
            {probeResult?.key === supplier.supplierPublicKeyHex ? (
              <p className={probeResult.ok ? "msfile-settings__ok" : "msfile-settings__error"}>{probeResult.detail}</p>
            ) : null}
          </li>
        ))}
      </ul>
        )}
      <Modal
        open={supplierEditorOpen}
        title={editingKey
          ? t("msfile.settings.supplier.form.editTitle", { defaultValue: "编辑文件来源" })
          : t("msfile.settings.supplier.form.addTitle", { defaultValue: "添加文件来源" })}
        onClose={closeSupplierEditor}
        closeButtonLabel={t("msfile.settings.supplier.close", { defaultValue: "关闭" })}
        data-testid="msfile-supplier-editor"
      >
        <div className="msfile-settings__supplier-editor">
          <p className="msfile-settings__hint">{t("msfile.settings.supplier.form.description", { defaultValue: "文件来源需要公钥和至少一个可拨号 multiaddr。" })}</p>
          <div className="msfile-settings__form-grid">
            <div className="msfile-settings__field">
              <label htmlFor="msfile-supplier-name">{t("msfile.settings.supplier.name", { defaultValue: "Display name" })}</label>
              <input
                id="msfile-supplier-name"
                className="msfile-settings__control"
                value={nameDraft}
                onChange={(event) => setNameDraft(event.target.value)}
              />
            </div>
            <div className="msfile-settings__field">
              <label htmlFor="msfile-supplier-key">{t("msfile.settings.supplier.publicKey", { defaultValue: "Public key" })}</label>
              <input
                id="msfile-supplier-key"
                className="msfile-settings__control"
                value={keyDraft}
                disabled={editingKey !== null}
                onChange={(event) => setKeyDraft(event.target.value.toLowerCase())}
              />
            </div>
            {peerIdPreview ? (
              <p className="msfile-settings__callout is-wide">
                {t("msfile.settings.supplier.peerId", { defaultValue: "PeerId" })}: <code>{peerIdPreview}</code>
              </p>
            ) : null}
            <div className="msfile-settings__field is-wide">
              <label htmlFor="msfile-supplier-addresses">{t("msfile.settings.supplier.addresses", { defaultValue: "Addresses" })}</label>
              <textarea
                id="msfile-supplier-addresses"
                className="msfile-settings__control"
                rows={4}
                value={addressesDraft}
                onChange={(event) => setAddressesDraft(event.target.value)}
              />
            </div>
            <label className="msfile-settings__checkbox is-wide">
              <input
                type="checkbox"
                checked={enabledDraft}
                onChange={(event) => setEnabledDraft(event.target.checked)}
              />
              <span>{t("msfile.settings.supplier.enabled", { defaultValue: "Enabled" })}</span>
            </label>
          </div>
          <div className="msfile-settings__section-actions">
            <Button onClick={() => void submitSupplier(enabledDraft)}>
              {editingKey ? t("msfile.settings.supplier.save", { defaultValue: "Save changes" }) : t("msfile.settings.supplier.add", { defaultValue: "Add supplier" })}
            </Button>
            <Button variant="secondary" onClick={closeSupplierEditor}>{t("msfile.settings.supplier.cancel", { defaultValue: "Cancel" })}</Button>
          </div>
        </div>
      </Modal>
      </section>

      <section className="msfile-settings__section" id="msfile-app-permissions" aria-labelledby="msfile-app-permissions-title">
        <header className="msfile-settings__section-header">
          <div>
            <h2 id="msfile-app-permissions-title">{t("msfile.settings.section.apps", { defaultValue: "应用权限" })}</h2>
            <p>{t("msfile.settings.section.apps.desc", { defaultValue: "查看 Connect App，并为应用设置单独的支付限额。" })}</p>
          </div>
          <span className="msfile-settings__count">{authorizations.length}</span>
        </header>
        {approvals.length > 0 ? (
          <p className="msfile-settings__callout is-warning">
            {t("msfile.settings.apps.pending", { defaultValue: "有 {{count}} 个价格确认正在等待处理。", count: approvals.length })}
          </p>
        ) : null}
        {authorizations.length === 0 ? (
          <p className="msfile-settings__empty">{t("msfile.settings.apps.empty", { defaultValue: "No apps yet." })}</p>
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
      </section>
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
}) {
  const { field, value, label, hint, max, onChange } = props;
  const inputId = `msfile-${field}`;
  return (
    <div className="msfile-settings__field">
      <label htmlFor={inputId}>{label}</label>
      <input
        id={inputId}
        className="msfile-settings__control"
        type="number"
        min={1}
        max={max}
        step={1}
        inputMode="numeric"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? <p className="msfile-settings__hint">{hint}</p> : null}
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
  const formId = useId();
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
    <li className="msfile-settings__app-card">
      <div className="msfile-settings__app-header">
        <div>
          <strong>{view.appName}</strong>
          <span>{view.key.appId}</span>
        </div>
        <code title={view.key.publisherPublicKeyHex}>{view.key.publisherPublicKeyHex.slice(0, 12)}…</code>
      </div>
      <div className="msfile-settings__app-limits">
        <div>
          <span>{t("msfile.settings.apps.seed", { defaultValue: "Seed" })}</span>
          <strong>{describeCap("seed")}</strong>
        </div>
        <div>
          <span>{t("msfile.settings.apps.block", { defaultValue: "Block" })}</span>
          <strong>{describeCap("block")}</strong>
        </div>
      </div>
      {editing ? (
        <div className="msfile-settings__form-grid is-editor">
          <div className="msfile-settings__field">
            <label htmlFor={`${formId}-seed`}>{t("msfile.settings.apps.seedOverride", { defaultValue: "Seed 单独限额" })}</label>
            <input
              id={`${formId}-seed`}
              className="msfile-settings__control"
              inputMode="numeric"
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
          </div>
          <div className="msfile-settings__field">
            <label htmlFor={`${formId}-block`}>{t("msfile.settings.apps.blockOverride", { defaultValue: "Block 单独限额" })}</label>
            <input
              id={`${formId}-block`}
              className="msfile-settings__control"
              inputMode="numeric"
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
          </div>
          <div className="msfile-settings__app-editor-actions is-wide">
            <Button onClick={() => void props.onSave(view, "seed", seedDraft)}>{t("msfile.settings.apps.saveSeed", { defaultValue: "保存 Seed 限额" })}</Button>
            <Button onClick={() => void props.onSave(view, "block", blockDraft)}>{t("msfile.settings.apps.saveBlock", { defaultValue: "保存 Block 限额" })}</Button>
          </div>
        </div>
      ) : null}
      <div className="msfile-settings__section-actions">
        <Button
          variant="secondary"
          onClick={() => {
            setSeedDraft(toDraft(overrideOf("seed")));
            setBlockDraft(toDraft(overrideOf("block")));
            setEditing((value) => !value);
          }}
        >
          {editing
            ? t("msfile.settings.apps.closeEditor", { defaultValue: "收起编辑" })
            : t("msfile.settings.apps.editOverride", { defaultValue: "Edit overrides" })}
        </Button>
        {overrideOf("seed") ? (
          <Button variant="ghost" size="sm" onClick={() => props.onRestore("seed")}>
            {t("msfile.settings.apps.restoreSeed", { defaultValue: "恢复 Seed 全局限额" })}
          </Button>
        ) : null}
        {overrideOf("block") ? (
          <Button variant="ghost" size="sm" onClick={() => props.onRestore("block")}>
            {t("msfile.settings.apps.restoreBlock", { defaultValue: "恢复 Block 全局限额" })}
          </Button>
        ) : null}
        {overrideOf("seed") || overrideOf("block") ? (
          <Button variant="danger" size="sm" onClick={props.onClear}>
            {t("msfile.settings.apps.clearAll", { defaultValue: "Restore inheritance" })}
          </Button>
        ) : null}
      </div>
    </li>
  );
}
