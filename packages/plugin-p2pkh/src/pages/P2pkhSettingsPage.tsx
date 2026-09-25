// packages/plugin-p2pkh/src/pages/P2pkhSettingsPage.tsx
// P2PKH 设置：
//   - includeTestnet：是否把 testnet 资产纳入运行范围；
//   - BSV 矿工费率三档。
//   - 已删除“确认同步供应商选择”：P2PKH 历史与 UTXO 只有 WoC 一个数据源。

import { useEffect, useState } from "react";
import { Select, TextInput } from "@keymaster/ui";
import { useOptionalCapability } from "webloom-framework/react";
import { useI18n, useOptionalResourceSelector, usePluginHost } from "@keymaster/runtime";
import { P2PKH_COORDINATOR_CONTROL_CAPABILITY } from "@keymaster/contracts";
import { resolveP2pkhFeeRateSatoshisPerKb, type P2pkhFeeRateTier, type P2pkhGlobalSettings, type P2pkhService } from "../p2pkhContracts.js";
import { P2PKH_CAPABILITY } from "../p2pkhContracts.js";

const DEFAULT_SETTINGS: P2pkhGlobalSettings = { includeTestnet: false };

export function P2pkhSettingsPage() {
  const host = usePluginHost();
  // owner 作用域 capability 会在锁定时被撤销；设置区可能正好挂载在 BSV 链
  // 页面上，这里必须按"暂不可用"渲染，而不是让 useCapability 抛异常。
  const service = useOptionalCapability(P2PKH_CAPABILITY);
  const coordinator = useOptionalCapability(P2PKH_COORDINATOR_CONTROL_CAPABILITY);
  const { t } = useI18n();
  // 锁定时资源定义会被注销；可选选择器降级到默认值而不是抛错。
  const resourceSettings = useOptionalResourceSelector<P2pkhGlobalSettings, P2pkhGlobalSettings>(
    host.resourceStore,
    "p2pkh.settings",
    [],
    (snapshot) => snapshot.data ?? DEFAULT_SETTINGS,
    DEFAULT_SETTINGS
  );
  const [settings, setSettings] = useState<P2pkhGlobalSettings>(resourceSettings);
  const [feeRates, setFeeRates] = useState(() => Object.fromEntries(
    Object.entries(resolveP2pkhFeeRateSatoshisPerKb(DEFAULT_SETTINGS)).map(([tier, rate]) => [tier, String(rate)])
  ) as Record<P2pkhFeeRateTier, string>);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSettings(resourceSettings);
    setFeeRates(Object.fromEntries(
      Object.entries(resolveP2pkhFeeRateSatoshisPerKb(resourceSettings)).map(([tier, rate]) => [tier, String(rate)])
    ) as Record<P2pkhFeeRateTier, string>);
  }, [resourceSettings]);

  async function applySettings(next: P2pkhGlobalSettings) {
    if (!service) return;
    setSettings(next);
    setError(null);
    try {
      await service.applyGlobalSettings(next);
    } catch (err) {
      setSettings(service.getGlobalSettings());
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function saveFeeRate(tier: P2pkhFeeRateTier, rawValue = feeRates[tier]) {
    const value = Number(rawValue);
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

  if (!service || !coordinator) {
    return (
      <div className="p2pkh-settings p2pkh-settings--unavailable">
        <p className="p2pkh-settings__hint">
          {t("p2pkh.settings.unavailable", { defaultValue: "钱包已锁定或 P2PKH 服务暂不可用；解锁后可继续配置。" })}
        </p>
      </div>
    );
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
          defaultValue: "关闭后 testnet 资产、转账入口与 testnet 钱包行会隐藏，确认同步也会跳过 testnet；再次开启会补齐 testnet 资源。"
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
            onBlur={(event) => void saveFeeRate(tier, event.currentTarget.value)}
            hint={t("p2pkh.unit.satsPerKb", { defaultValue: "sats/kB" })}
          />
        ))}
      </section>
      {error ? <p className="p2pkh-settings__error">{error}</p> : null}
    </div>
  );
}
