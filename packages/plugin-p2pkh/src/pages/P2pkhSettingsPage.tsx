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
import { Select } from "@keymaster/ui";
import { useCapability, useI18n, usePluginHost, useResourceSelector } from "@keymaster/runtime";
import type { P2pkhGlobalSettings, P2pkhService } from "../p2pkhContracts.js";

export function P2pkhSettingsPage() {
  const host = usePluginHost();
  const service = useCapability<P2pkhService>("p2pkh.service");
  const { t } = useI18n();
  const resourceSettings = useResourceSelector<P2pkhGlobalSettings, P2pkhGlobalSettings>(
    host.resourceStore,
    "p2pkh.settings",
    [],
    (snapshot) => snapshot.data ?? { includeTestnet: false },
    (a, b) => a.includeTestnet === b.includeTestnet
  );
  const [settings, setSettings] = useState<P2pkhGlobalSettings>(resourceSettings);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSettings(resourceSettings);
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
      {error ? <p className="p2pkh-settings__error">{error}</p> : null}
    </div>
  );
}
