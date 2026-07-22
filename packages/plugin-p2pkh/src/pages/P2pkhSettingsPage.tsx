// packages/plugin-p2pkh/src/pages/P2pkhSettingsPage.tsx
// P2PKH 设置（硬切换 001）：
//   - 设置项从 `allowUnconfirmed` 改为 `includeTestnet`。
//   - 缺省 `false`：P2PKH 默认不包含 testnet 货币（资产、转账、widget、页面按钮、后台同步）。
//   - 存储位置继续使用全局 localStorage；key = "p2pkh.settings"。
//   - WOC 设置仍然跳到独立的 WOC 设置页。
//   - 保存时调用 `service.applyGlobalSettings`：由 service 负责刷新进程内
//     缓存、通知订阅者、并在 false → true 时触发 rehydrate + recent-sync +
//     backfill。同 tab 不依赖 storage 事件。

import { useEffect, useState } from "react";
import { Select, TextInput } from "@keymaster/ui";
import { useCapability, useI18n, usePluginHost, useResourceSelector } from "@keymaster/runtime";
import { resolveP2pkhFeeRateSatoshisPerKb, type P2pkhFeeRateTier, type P2pkhGlobalSettings, type P2pkhService } from "../p2pkhContracts.js";

const DEFAULT_SETTINGS: P2pkhGlobalSettings = { includeTestnet: false };

export function P2pkhSettingsPage() {
  const host = usePluginHost();
  const service = useCapability<P2pkhService>("p2pkh.service");
  const { t } = useI18n();
  const resourceSettings = useResourceSelector<P2pkhGlobalSettings, P2pkhGlobalSettings>(
    host.resourceStore,
    "p2pkh.settings",
    [],
    (snapshot) => snapshot.data ?? DEFAULT_SETTINGS,
    (a, b) => a.includeTestnet === b.includeTestnet
      && JSON.stringify(a.feeRateSatoshisPerKb ?? {}) === JSON.stringify(b.feeRateSatoshisPerKb ?? {})
  );
  const [settings, setSettings] = useState<P2pkhGlobalSettings>(resourceSettings);
  const [feeRates, setFeeRates] = useState(() => Object.fromEntries(
    Object.entries(resolveP2pkhFeeRateSatoshisPerKb(resourceSettings)).map(([tier, rate]) => [tier, String(rate)])
  ) as Record<P2pkhFeeRateTier, string>);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSettings(resourceSettings);
    setFeeRates(Object.fromEntries(
      Object.entries(resolveP2pkhFeeRateSatoshisPerKb(resourceSettings)).map(([tier, rate]) => [tier, String(rate)])
    ) as Record<P2pkhFeeRateTier, string>);
  }, [resourceSettings]);

  async function applySettings(next: P2pkhGlobalSettings) {
    setSettings(next);
    setError(null);
    try {
      await service.applyGlobalSettings(next);
    } catch (err) {
      setSettings(service.getGlobalSettings());
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function saveFeeRate(tier: P2pkhFeeRateTier) {
    const value = Number(feeRates[tier]);
    if (!Number.isInteger(value) || value < 1) {
      setError(t("p2pkh.settings.feeRateInvalid", { defaultValue: "费率必须是大于 0 的整数（sats/kB）。" }));
      setFeeRates((current) => ({ ...current, [tier]: String(resolveP2pkhFeeRateSatoshisPerKb(settings)[tier]) }));
      return;
    }
    await applySettings({
      ...settings,
      feeRateSatoshisPerKb: { ...resolveP2pkhFeeRateSatoshisPerKb(settings), [tier]: value }
    });
  }

  return (
    <div className="p2pkh-settings">
      <Select
        label={t("p2pkh.settings.includeTestnet", { defaultValue: "包含 testnet 货币" })}
        value={settings.includeTestnet ? "yes" : "no"}
        onChange={(e) => void applySettings({ ...settings, includeTestnet: e.currentTarget.value === "yes" })}
        options={[
          {
            label: { key: "p2pkh.settings.includeTestnet.no", fallback: "否（推荐）" },
            value: "no"
          },
          {
            label: { key: "p2pkh.settings.includeTestnet.yes", fallback: "是" },
            value: "yes"
          }
        ]}
      />
      <p className="p2pkh-settings__hint">
        {t("p2pkh.settings.includeTestnetHint", {
          defaultValue: "关闭后 testnet 资产、转账入口、首页余额行与后台同步都会停止；再次打开会重新触发 testnet rehydrate + recent-sync。"
        })}
      </p>
      <section className="p2pkh-settings__fee-rates" aria-labelledby="p2pkh-fee-rates-title">
        <h3 id="p2pkh-fee-rates-title">{t("p2pkh.settings.feeRates", { defaultValue: "BSV 矿工费率" })}</h3>
        <p>{t("p2pkh.settings.feeRatesHint", { defaultValue: "按 sats/kB 配置。转账页默认使用“中”；修改后立即应用到新建的交易预览。" })}</p>
        {(["low", "medium", "high"] as const).map((tier) => (
          <TextInput
            key={tier}
            label={t(`p2pkh.settings.feeRate.${tier}`, { defaultValue: tier === "low" ? "低" : tier === "medium" ? "中（默认）" : "高" })}
            type="number"
            min="1"
            value={feeRates[tier]}
            onChange={(event) => {
              // React may evaluate a functional state updater after the event handler
              // returns, when `currentTarget` has already been cleared. Read the
              // input value while the event is still active instead.
              const value = event.currentTarget.value;
              setFeeRates((current) => ({ ...current, [tier]: value }));
            }}
            onBlur={() => void saveFeeRate(tier)}
            hint="sats/kB"
          />
        ))}
      </section>
      {error ? <p className="p2pkh-settings__error">{error}</p> : null}
    </div>
  );
}
