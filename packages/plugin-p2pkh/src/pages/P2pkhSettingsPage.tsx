// packages/plugin-p2pkh/src/pages/P2pkhSettingsPage.tsx
// P2PKH 设置：仅展示 P2PKH 自身策略（未确认 UTXO）。WOC 设置在 plugin-woc。

import { useEffect, useState } from "react";
import { Button, PageHeader, Select } from "@keymaster/ui";
import { useCapability, useI18n, usePluginHost } from "@keymaster/runtime";
import type { PluginManifest } from "@keymaster/contracts";

const STORAGE_KEY = "p2pkh.settings";

interface P2pkhSettings {
  allowUnconfirmed: boolean;
}

function load(): P2pkhSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as P2pkhSettings;
  } catch {
    // ignore
  }
  return { allowUnconfirmed: false };
}
function save(s: P2pkhSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

export function P2pkhSettingsPage() {
  const host = usePluginHost();
  useCapability("p2pkh.service");
  const { t } = useI18n();
  useI18n().language();
  const [settings, setSettings] = useState<P2pkhSettings>(load);
  const [saved, setSaved] = useState(false);

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
        label={t("p2pkh.settings.allowUnconfirmed", { defaultValue: "允许未确认 UTXO" })}
        value={settings.allowUnconfirmed ? "yes" : "no"}
        onChange={(e) => setSettings({ ...settings, allowUnconfirmed: e.currentTarget.value === "yes" })}
        options={[
          {
            label: { key: "p2pkh.settings.allowUnconfirmed.no", fallback: "否（推荐）" },
            value: "no"
          },
          {
            label: { key: "p2pkh.settings.allowUnconfirmed.yes", fallback: "是" },
            value: "yes"
          }
        ]}
      />
      <p className="p2pkh-settings__hint">
        {t("p2pkh.settings.wocHint", { defaultValue: "WOC endpoint、限流与队列状态请到 " })}
        <a href="/settings/woc">{t("p2pkh.settings.wocLink", { defaultValue: "WOC 设置" })}</a>
        。
      </p>
      <Button
        onClick={() => {
          save(settings);
          setSaved(true);
        }}
      >
        {t("p2pkh.action.save", { defaultValue: "保存" })}
      </Button>
      {saved ? <span className="p2pkh-settings__saved">{t("p2pkh.action.saved", { defaultValue: "已保存" })}</span> : null}
    </div>
  );
}
