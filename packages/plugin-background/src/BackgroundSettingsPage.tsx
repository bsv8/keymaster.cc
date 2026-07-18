// packages/plugin-background/src/BackgroundSettingsPage.tsx
// 后台同步设置页：资产余额同步频率配置。
//
// 设计缘由：
//   - 设置属于后台任务平台，而不是 P2PKH 设置页或 WOC 设置页。
//   - 它影响 P2PKH、BSV-21、STAS 及未来所有资产 provider。
//   - 只允许 5 / 15 / 30 / 60 分钟预设；不能保存小于 5 分钟、任意秒数或永不运行。
//   - 保存后重新计算 asset-holdings 组任务的 nextRunAt，不立即触发网络同步。
//   - 保存后显示实际生效的值（可能因任务最小间隔被抬高）。
//   - 订阅后台设置变化以处理跨标签修改。

import { useEffect, useState } from "react";
import { useCapability, useI18n } from "@keymaster/runtime";
import type { BackgroundService, BackgroundSyncSettings } from "@keymaster/contracts";

/** 预设选项。 */
const INTERVAL_OPTIONS: Array<{ label: string; value: number }> = [
  { label: "background.settings.option.5min", value: 300_000 },
  { label: "background.settings.option.15min", value: 900_000 },
  { label: "background.settings.option.30min", value: 1_800_000 },
  { label: "background.settings.option.60min", value: 3_600_000 }
];

export function BackgroundSettingsPage() {
  const backgroundService = useCapability<BackgroundService>("background.service");
  const { t } = useI18n();
  useI18n().language();

  const currentSettings = backgroundService.getScheduleSettings();
  const [intervalMs, setIntervalMs] = useState(currentSettings.assetHoldingsIntervalMs);
  const [saved, setSaved] = useState(false);

  // 订阅后台设置变化：处理跨标签修改
  useEffect(() => {
    return backgroundService.onChange(() => {
      const latest = backgroundService.getScheduleSettings();
      setIntervalMs(latest.assetHoldingsIntervalMs);
    });
  }, [backgroundService]);

  function handleSave() {
    const settings: BackgroundSyncSettings = {
      assetHoldingsIntervalMs: intervalMs
    };
    backgroundService.updateScheduleSettings(settings);
    // 保存后读取实际生效值（可能因任务最小间隔被抬高）
    const effective = backgroundService.getScheduleSettings();
    setIntervalMs(effective.assetHoldingsIntervalMs);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
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
      <button onClick={handleSave}>
        {t("background.settings.save", { defaultValue: "保存" })}
      </button>
      {saved ? (
        <p className="background-settings__feedback">
          {t("background.settings.saved", { defaultValue: "已保存" })}
        </p>
      ) : null}
    </div>
  );
}
