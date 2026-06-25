// packages/plugin-protocol/src/OriginSettingsTray.tsx
// popup 顶栏 inline 配置面板：编辑当前 origin 的 p2pkh auto-approve +
// feepool auto-sign 配置。
//
// 设计缘由（施工单 002 硬切换）：
//   - popup 是会话级长存；origin 切换时 settings 跟着重读。
//   - 站点级配置**不**走 settings.registry（settings 路由是 per-user 全局
//     设置；站点级是 per-origin per-popup-session）。
//   - 写操作走 service.setOriginSettings；service 内部同步刷 originCache，
//     让下一次 p2pkh.auto-approve 同步判断立即生效。
//   - 关闭面板只点 × 或再次点击顶栏按钮。
//   - 文案中文；按钮布局模仿 BackgroundTray 的 inline-attached 模式。

import { useEffect, useState } from "react";
import { Button, PageHeader } from "@keymaster/ui";
import { useCapability, useI18n } from "@keymaster/runtime";
import {
  PROTOCOL_SERVICE_CAPABILITY,
  type ProtocolOriginSettingsRecord,
  type ProtocolService
} from "@keymaster/contracts";

interface OriginSettingsTrayInlineProps {
  origin: string;
  onClose: () => void;
}

function defaultOriginSettings(origin: string): ProtocolOriginSettingsRecord {
  return {
    origin,
    p2pkhAutoApproveEnabled: false,
    p2pkhAutoApproveMaxSatoshis: 0,
    feePoolAutoSignMaxSatoshis: 0,
    feePoolDefaultFundSatoshis: 0,
    updatedAt: Date.now()
  };
}

export function OriginSettingsTrayInline({ origin, onClose }: OriginSettingsTrayInlineProps) {
  const service = useCapability<ProtocolService>(PROTOCOL_SERVICE_CAPABILITY);
  const { t } = useI18n();
  useI18n().language();
  const [form, setForm] = useState<ProtocolOriginSettingsRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void service.getOriginSettings(origin).then((rec) => {
      if (cancelled) return;
      setForm(rec ?? defaultOriginSettings(origin));
    });
    return () => {
      cancelled = true;
    };
  }, [origin, service]);

  useEffect(() => {
    if (!saved) return;
    const handle = setTimeout(() => setSaved(false), 1500);
    return () => clearTimeout(handle);
  }, [saved]);

  if (!form) {
    return (
      <div className="origin-settings-panel" role="dialog" aria-label={t("protocol.originSettings.title", { defaultValue: "Per-origin settings" })}>
        <PageHeader
          title={t("protocol.originSettings.title", { defaultValue: "Per-origin settings" })}
          description={origin}
        />
        <div className="origin-settings-panel__loading">…</div>
        <button
          type="button"
          className="origin-settings-panel__close"
          onClick={onClose}
          aria-label="close"
        >
          ×
        </button>
      </div>
    );
  }

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await service.setOriginSettings(form!);
      setSaved(true);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("protocol.originSettings.err.saveFailed", { defaultValue: "Failed to save" })
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="origin-settings-panel" role="dialog" aria-label={t("protocol.originSettings.title", { defaultValue: "Per-origin settings" })}>
      <PageHeader
        title={t("protocol.originSettings.title", { defaultValue: "Per-origin settings" })}
        description={origin}
      />
      <div className="origin-settings-panel__form">
        <label className="origin-settings-panel__field">
          <input
            type="checkbox"
            checked={form.p2pkhAutoApproveEnabled}
            onChange={(e) =>
              setForm({ ...form, p2pkhAutoApproveEnabled: e.currentTarget.checked })
            }
          />
          <span>
            {t("protocol.originSettings.p2pkhAutoApprove.label", {
              defaultValue: "Auto-approve p2pkh.transfer when amount ≤ max"
            })}
          </span>
        </label>
        <label className="origin-settings-panel__field">
          <span>
            {t("protocol.originSettings.p2pkhAutoApproveMax.label", {
              defaultValue: "Max satoshis for auto-approve (0 = off)"
            })}
          </span>
          <input
            type="number"
            min={0}
            step={1}
            value={String(form.p2pkhAutoApproveMaxSatoshis)}
            onChange={(e) => {
              const v = Number(e.currentTarget.value);
              setForm({
                ...form,
                p2pkhAutoApproveMaxSatoshis: Number.isInteger(v) && v >= 0 ? v : 0
              });
            }}
          />
        </label>
        <label className="origin-settings-panel__field">
          <span>
            {t("protocol.originSettings.feepoolAutoSignMax.label", {
              defaultValue: "Max satoshis for fee-pool auto-sign (0 = off)"
            })}
          </span>
          <input
            type="number"
            min={0}
            step={1}
            value={String(form.feePoolAutoSignMaxSatoshis)}
            onChange={(e) => {
              const v = Number(e.currentTarget.value);
              setForm({
                ...form,
                feePoolAutoSignMaxSatoshis: Number.isInteger(v) && v >= 0 ? v : 0
              });
            }}
          />
        </label>
        <label className="origin-settings-panel__field">
          <span>
            {t("protocol.originSettings.feePoolDefaultFundSatoshis.label", {
              defaultValue: "Fee-pool default initial fund (satoshis). 0 = unconfigured."
            })}
          </span>
          <input
            type="number"
            min={0}
            step={1}
            value={String(form.feePoolDefaultFundSatoshis)}
            onChange={(e) => {
              const v = Number(e.currentTarget.value);
              setForm({
                ...form,
                feePoolDefaultFundSatoshis: Number.isInteger(v) && v >= 0 ? v : 0
              });
            }}
          />
        </label>
        {error ? (
          <div className="origin-settings-panel__error">
            <code>{error}</code>
          </div>
        ) : null}
        <div className="origin-settings-panel__actions">
          <Button onClick={save} loading={busy}>
            {t("protocol.originSettings.save", { defaultValue: "Save" })}
          </Button>
          {saved ? (
            <span className="origin-settings-panel__saved">
              {t("protocol.originSettings.saved", { defaultValue: "Saved" })}
            </span>
          ) : null}
          <span className="origin-settings-panel__spacer" />
          <button
            type="button"
            className="origin-settings-panel__close"
            onClick={onClose}
            aria-label="close"
          >
            ×
          </button>
        </div>
      </div>
    </div>
  );
}
