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
import { Button, PageHeader, Select } from "@keymaster/ui";
import { AppLink, useCapability, useI18n, usePluginHost } from "@keymaster/runtime";
import type { PluginManifest } from "@keymaster/contracts";
import type { P2pkhGlobalSettings, P2pkhService } from "../p2pkhContracts.js";

const STORAGE_KEY = "p2pkh.settings";

function load(): P2pkhGlobalSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const obj = JSON.parse(raw) as { includeTestnet?: unknown };
      return { includeTestnet: obj.includeTestnet === true };
    }
  } catch {
    // ignore
  }
  return { includeTestnet: false };
}

export function P2pkhSettingsPage() {
  const host = usePluginHost();
  const service = useCapability<P2pkhService>("p2pkh.service");
  const { t } = useI18n();
  useI18n().language();
  const [settings, setSettings] = useState<P2pkhGlobalSettings>(load);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 1500);
    return () => clearTimeout(timer);
  }, [saved]);

  const wocPlugin = host.capabilities.has("woc.service");
  void wocPlugin;
  void ([] as PluginManifest[]);

  return (
    <div className="p2pkh-settings">
      <PageHeader
        title={t("p2pkh.settings.title", { defaultValue: "P2PKH 设置" })}
        description={t("p2pkh.settings.desc", { defaultValue: "P2PKH 资产策略。WOC endpoint、限流、广播在 WOC 设置页配置。" })}
      />
      <Select
        label={t("p2pkh.settings.includeTestnet", { defaultValue: "包含 testnet 货币" })}
        value={settings.includeTestnet ? "yes" : "no"}
        onChange={(e) => setSettings({ ...settings, includeTestnet: e.currentTarget.value === "yes" })}
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
      <p className="p2pkh-settings__hint">
        {t("p2pkh.settings.wocHint", { defaultValue: "WOC endpoint、限流与队列状态请到 " })}
        <AppLink to="/settings/woc">{t("p2pkh.settings.wocLink", { defaultValue: "WOC 设置" })}</AppLink>
        。
      </p>
      <Button
        onClick={async () => {
          setError(null);
          try {
            await service.applyGlobalSettings(settings);
            setSaved(true);
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
        }}
      >
        {t("p2pkh.action.save", { defaultValue: "保存" })}
      </Button>
      {saved ? <span className="p2pkh-settings__saved">{t("p2pkh.action.saved", { defaultValue: "已保存" })}</span> : null}
      {error ? <p className="p2pkh-settings__error">{error}</p> : null}
    </div>
  );
}
