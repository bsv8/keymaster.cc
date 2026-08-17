// packages/plugin-p2pkh/src/pages/P2pkhSettingsPage.tsx
// P2PKH 设置（硬切换 001）：
//   - 设置项从 `allowUnconfirmed` 改为 `includeTestnet`。
//   - 缺省 `false`：P2PKH 默认不包含 testnet 货币（资产、转账、widget、页面按钮、确认同步）。
//   - 存储位置继续使用全局 localStorage；key = "p2pkh.settings"。
//   - 保存时调用 `service.applyGlobalSettings`：由 service 负责刷新进程内
//     缓存、通知订阅者、并在 false → true 时补齐 testnet 资源。

import { useEffect, useState } from "react";
import { Select, TextInput } from "@keymaster/ui";
import { useCapability, useI18n, usePluginHost, useResourceSelector } from "@keymaster/runtime";
import { SESSION_COORDINATOR_CLIENT_CAPABILITY, type P2pkhProviderRegistrySnapshot, type SessionCoordinatorClient } from "@keymaster/contracts";
import { resolveP2pkhFeeRateSatoshisPerKb, type P2pkhFeeRateTier, type P2pkhGlobalSettings, type P2pkhService } from "../p2pkhContracts.js";

const DEFAULT_SETTINGS: P2pkhGlobalSettings = { includeTestnet: false };

export function P2pkhSettingsPage() {
  const host = usePluginHost();
  const service = useCapability<P2pkhService>("p2pkh.service");
  const coordinator = useCapability<SessionCoordinatorClient>(SESSION_COORDINATOR_CLIENT_CAPABILITY);
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
  const [providers, setProviders] = useState<P2pkhProviderRegistrySnapshot | null>(null);

  useEffect(() => {
    setSettings(resourceSettings);
    setFeeRates(Object.fromEntries(
      Object.entries(resolveP2pkhFeeRateSatoshisPerKb(resourceSettings)).map(([tier, rate]) => [tier, String(rate)])
    ) as Record<P2pkhFeeRateTier, string>);
  }, [resourceSettings]);

  useEffect(() => {
    let alive = true;
    void coordinator.p2pkhProvidersGet().then((result) => {
      if (alive && result.status === "ok") setProviders(result.value);
    });
    const off = coordinator.subscribeTopic("p2pkh.providers", (event: { type?: string; snapshot?: P2pkhProviderRegistrySnapshot }) => {
      if (alive && event.type === "p2pkh.providers.changed" && event.snapshot) setProviders(event.snapshot);
    });
    return () => { alive = false; off(); };
  }, [coordinator]);

  async function updateProvider(network: "main" | "test", field: "syncProviderId" | "broadcastProviderId", value: string) {
    if (!providers) return;
    const selection = { ...providers.selection[network], [field]: value || null };
    const result = await coordinator.p2pkhProvidersUpdate(network, selection, providers.selection.generation);
    if (result.status !== "accepted" && result.status !== "ok") {
      setError("message" in result ? result.message : t("p2pkh.settings.provider.retry", { defaultValue: "Provider settings changed; reload and try again." }));
      return;
    }
    const next = await coordinator.p2pkhProvidersGet();
    if (next.status === "ok") setProviders(next.value);
  }

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
            onBlur={() => void saveFeeRate(tier)}
            hint={t("p2pkh.unit.satsPerKb", { defaultValue: "sats/kB" })}
          />
        ))}
      </section>
      <section className="p2pkh-settings__providers" aria-labelledby="p2pkh-providers-title">
        <h3 id="p2pkh-providers-title">{t("p2pkh.settings.providers", { defaultValue: "Confirmed sync and broadcast providers" })}</h3>
        <p>{t("p2pkh.settings.providersHint", { defaultValue: "Provider choices are persisted by the Coordinator. Changing one revokes the current sync generation." })}</p>
        {providers ? (["main", "test"] as const).map((network) => {
          const selectedSync = providers.selection[network].syncProviderId;
          const selectedBroadcast = providers.selection[network].broadcastProviderId;
          const syncProviders = providers.syncProviders.filter((provider) => provider.supportedNetworks.includes(network));
          const broadcastProviders = providers.broadcastProviders.filter((provider) => provider.supportedNetworks.includes(network));
          const syncUnavailable = Boolean(selectedSync && !syncProviders.some((provider) => provider.id === selectedSync));
          const broadcastUnavailable = Boolean(selectedBroadcast && !broadcastProviders.some((provider) => provider.id === selectedBroadcast));
          const syncOptions = [{ label: { key: "p2pkh.settings.provider.none", fallback: "Not configured" }, value: "" }, ...(syncUnavailable ? [{ label: { key: "p2pkh.settings.provider.unavailable", fallback: `Unavailable (selected: ${selectedSync})` }, value: selectedSync! }] : []), ...syncProviders.map((provider) => ({ label: { key: provider.id, fallback: provider.label }, value: provider.id }))];
          const broadcastOptions = [{ label: { key: "p2pkh.settings.provider.none", fallback: "Not configured" }, value: "" }, ...(broadcastUnavailable ? [{ label: { key: "p2pkh.settings.provider.unavailable", fallback: `Unavailable (selected: ${selectedBroadcast})` }, value: selectedBroadcast! }] : []), ...broadcastProviders.map((provider) => ({ label: { key: provider.id, fallback: provider.label }, value: provider.id }))];
          return <div key={network} className="p2pkh-settings__provider-network"><h4>{t(`p2pkh.network.${network}`, { defaultValue: network })}</h4><Select label={t("p2pkh.settings.provider.confirmed", { defaultValue: "Confirmed provider" })} value={selectedSync ?? ""} options={syncOptions} onChange={(event) => void updateProvider(network, "syncProviderId", event.currentTarget.value)} /><Select label={t("p2pkh.settings.provider.broadcast", { defaultValue: "Broadcast provider" })} value={selectedBroadcast ?? ""} options={broadcastOptions} onChange={(event) => void updateProvider(network, "broadcastProviderId", event.currentTarget.value)} />{syncUnavailable ? <p role="alert">{t("p2pkh.settings.provider.blocked", { defaultValue: "Confirmed sync is blocked: selected provider is unavailable ({{provider}}).", provider: selectedSync })}</p> : null}{broadcastUnavailable ? <p role="alert">{t("p2pkh.settings.provider.broadcastBlocked", { defaultValue: "Broadcast is blocked: selected provider is unavailable ({{provider}}).", provider: selectedBroadcast })}</p> : null}</div>;
        }) : <p>{t("p2pkh.settings.providersLoading", { defaultValue: "Loading providers…" })}</p>}
        <p>{t("p2pkh.settings.providerConfigHint", { defaultValue: "Provider endpoint and rate-limit settings are managed in each provider's own settings page." })}</p>
      </section>
      {error ? <p className="p2pkh-settings__error">{error}</p> : null}
    </div>
  );
}
