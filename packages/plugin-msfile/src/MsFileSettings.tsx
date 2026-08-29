// packages/plugin-msfile/src/MsFileSettings.tsx
// /settings/system 的 MSFile group：价格限制 / 供应商配置 / Connect App 授权。
// 页面只在 Vault unlocked 时渲染（visibleWhen 由 manifest 保证）。
// 所有读写都通过 `msfile.service`；本组件不接触 IndexedDB。

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  MsFileAppAuthorizationView,
  MsFilePendingApprovalView,
  MsFileSatoshiAmount,
  MsFileService,
  MsFileSettingsSnapshot,
  MsFileSupplierConfig,
} from "@keymaster/contracts";
import { useCapability, useI18n, usePluginHost, useResourceSelector } from "@keymaster/runtime";
import { Button } from "@keymaster/ui";
import { MSFILE_SERVICE_CAPABILITY } from "@keymaster/contracts";
import { normalizeMsFileSatoshiAmount } from "@keymaster/contracts";

/** `msfile.status` 资源快照（由 plugin manifest 注册）。 */
export interface MsFileStatusResourceSnapshot {
  status: string;
  globalSettings: import("@keymaster/contracts").MsFileGlobalPriceSettings | null;
  approvals: MsFilePendingApprovalView[];
}

type AmountDraft = { text: string; unlimited: boolean };

function toDraft(value: MsFileSatoshiAmount | undefined): AmountDraft {
  if (value === "0") return { text: "", unlimited: true };
  return { text: value ?? "", unlimited: false };
}

export function MsFileSettings() {
  const { t } = useI18n();
  const service = useCapability<MsFileService>(MSFILE_SERVICE_CAPABILITY);
  const host = usePluginHost();
  // 订阅一律走 Resource Store（react 资源边界门禁）；manifest 已注册 msfile.status。
  const statusResource = useResourceSelector<MsFileStatusResourceSnapshot, MsFileStatusResourceSnapshot>(
    host.resourceStore,
    "msfile.status",
    [],
    (snapshot) =>
      snapshot.data ?? { status: service.status(), globalSettings: null, approvals: [] },
    (a, b) =>
      a.status === b.status &&
      JSON.stringify(a.globalSettings) === JSON.stringify(b.globalSettings) &&
      JSON.stringify(a.approvals) === JSON.stringify(b.approvals)
  );
  const [snapshot, setSnapshot] = useState<MsFileSettingsSnapshot | null>(null);
  const [authorizations, setAuthorizations] = useState<MsFileAppAuthorizationView[]>([]);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [seedDraft, setSeedDraft] = useState<AmountDraft>({ text: "", unlimited: false });
  const [blockDraft, setBlockDraft] = useState<AmountDraft>({ text: "", unlimited: false });
  const [nameDraft, setNameDraft] = useState("");
  const [keyDraft, setKeyDraft] = useState("");
  const [addressesDraft, setAddressesDraft] = useState("");
  const [enabledDraft, setEnabledDraft] = useState(true);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [probingKey, setProbingKey] = useState<string | null>(null);
  const [probeResult, setProbeResult] = useState<{ key: string; ok: boolean; detail: string } | null>(null);

  const reload = useCallback(async () => {
    try {
      const next = await service.getSettingsSnapshot();
      setSnapshot(next);
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

      <h3>{t("msfile.settings.suppliers", { defaultValue: "Suppliers" })}</h3>
      <ul className="msfile-settings__suppliers">
        {(snapshot?.suppliers ?? []).map((supplier) => (
          <li key={supplier.supplierPublicKeyHex}>
            <div className="msfile-settings__supplier-line">
              <strong>{supplier.name}</strong>
              <code title={supplier.supplierPublicKeyHex}>{supplier.supplierPublicKeyHex.slice(0, 12)}…</code>
              <span>{supplier.addresses.length} addr</span>
              <label className="msfile-settings__checkbox">
                <input type="checkbox" checked={supplier.enabled} onChange={() => void toggleSupplier(supplier)} />
                <span>{t("msfile.settings.supplier.enabled", { defaultValue: "Enabled" })}</span>
              </label>
              <Button variant="secondary" onClick={() => startEditSupplier(supplier)}>
                {t("msfile.settings.supplier.edit", { defaultValue: "Edit" })}
              </Button>
              <Button variant="secondary" onClick={() => void testSupplier(supplier)} disabled={probingKey === supplier.supplierPublicKeyHex}>
                {probingKey === supplier.supplierPublicKeyHex
                  ? t("msfile.settings.supplier.testing", { defaultValue: "Testing…" })
                  : t("msfile.settings.supplier.test", { defaultValue: "Test connection" })}
              </Button>
              <Button variant="danger" onClick={() => void removeSupplier(supplier)}>
                {t("msfile.settings.supplier.delete", { defaultValue: "Delete" })}
              </Button>
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
