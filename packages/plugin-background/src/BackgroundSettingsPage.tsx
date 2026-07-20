// packages/plugin-background/src/BackgroundSettingsPage.tsx
// 后台同步设置页：资产余额同步频率配置。
//
// 设计缘由：
//   - 设置属于后台任务平台，而不是 P2PKH 设置页或 WOC 设置页。
//   - 它影响 P2PKH、BSV-21、STAS 及未来所有资产 provider。
//   - 只允许 5 / 15 / 30 / 60 分钟预设；不能保存小于 5 分钟、任意秒数或永不运行。
//   - 保存后重新计算 asset-holdings 组任务的 nextRunAt，不立即触发网络同步。
//   - 保存后显示实际生效的值（可能因任务最小间隔被抬高）。
//
// 硬切换 003：使用 Resource Store 读取后台设置，跨标签同步由 resource subscribe 处理。

import { useEffect, useState } from "react";
import { useCapability, useI18n, usePluginHost, useResourceSelector } from "@keymaster/runtime";
import type { BackgroundService, BackgroundSyncSettings } from "@keymaster/contracts";

/** 预设选项。 */
const INTERVAL_OPTIONS: Array<{ label: string; value: number }> = [
  { label: "background.settings.option.5min", value: 300_000 },
  { label: "background.settings.option.15min", value: 900_000 },
  { label: "background.settings.option.30min", value: 1_800_000 },
  { label: "background.settings.option.60min", value: 3_600_000 }
];

const DEFAULT_SETTINGS: BackgroundSyncSettings = { assetHoldingsIntervalMs: 900_000 };

export function BackgroundSettingsPage() {
  const backgroundService = useCapability<BackgroundService>("background.service");
  const host = usePluginHost();
  const { t } = useI18n();
  const store = host.resourceStore;

  // 使用 Resource Store 读取后台设置（跨标签同步由 resource subscribe 处理）
  const settings = useResourceSelector<BackgroundSyncSettings, BackgroundSyncSettings>(
    store,
    "background.scheduleSettings",
    [],
    (snapshot) => snapshot.data ?? DEFAULT_SETTINGS,
    (a, b) => a.assetHoldingsIntervalMs === b.assetHoldingsIntervalMs
  );

  // 本地交互 state：表单值
  const [intervalMs, setIntervalMs] = useState(settings.assetHoldingsIntervalMs);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // 当 resource 设置变化时（跨标签同步），更新表单值
  useEffect(() => {
    setIntervalMs(settings.assetHoldingsIntervalMs);
  }, [settings.assetHoldingsIntervalMs]);

  function handleSave() {
    const settings: BackgroundSyncSettings = {
      assetHoldingsIntervalMs: intervalMs
    };
    setSaving(true);
    setSaveError(null);
    void backgroundService.updateScheduleSettings(settings).then((result) => {
      setSaving(false);
      if (result.status !== "accepted") {
        setSaveError("message" in result ? result.message : t("background.settings.saveFailed", { defaultValue: "保存失败，请稍后重试。" }));
        return;
      }
      const effective = backgroundService.getScheduleSettings();
      setIntervalMs(effective.assetHoldingsIntervalMs);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    });
  }

  return (
    <div className="background-settings">
      <h2>{t("background.settings.title", { defaultValue: "后台同步设置" })}</h2>
      <p className="background-settings__description">
        {t("background.settings.description", {
          defaultValue: "后台同步始终由系统维持。您可以调整同步频率，或在托盘中点击「立即同步一次」手动触发一轮同步。"
        })}
      </p>
      <div className="background-settings__field">
        <label>
          {t("background.settings.assetHoldingsInterval", { defaultValue: "资产余额同步频率" })}
          <select
            value={intervalMs}
            onChange={(e) => setIntervalMs(Number(e.target.value))}
          >
            {INTERVAL_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {t(opt.label, { defaultValue: opt.label })}
              </option>
            ))}
          </select>
        </label>
      </div>
      <button onClick={handleSave} disabled={saving}>
        {t("background.settings.save", { defaultValue: "保存" })}
      </button>
      {saved ? (
        <p className="background-settings__feedback">
          {t("background.settings.saved", { defaultValue: "已保存" })}
        </p>
      ) : null}
      {saveError ? <p className="background-settings__error">{saveError}</p> : null}
    </div>
  );
}
