// packages/plugin-settings/src/LanguageSection.tsx
// 平台语言设置区：English / 简体中文。
// 设计缘由：
//   - 复用 i18n.service 暴露的 setLanguage，热切换不重载页面。
//   - 持久化失败仅可能来自 localStorage 写入失败；UI 仍生效。
//   - 当前选择要立刻反映在选项上（i18n.language 触发 useI18n 重渲染）。
//   - **不提供「跟随浏览器」选项**：浏览器语言不像主题颜色会随系统变化，
//     切换频率极低；用户一旦手动选定就长期生效，不再回退到跟随浏览器。
//     首次启动仍然按浏览器语言映射作为没手动选过时的兜底（i18nStore 内部行为）。

import { useEffect, useState } from "react";
import { Select } from "@keymaster/ui";
import { useI18n, usePluginHost } from "@keymaster/runtime";
import type { SupportedLanguage } from "@keymaster/contracts";

export function LanguageSection() {
  const host = usePluginHost();
  const { t } = useI18n();
  // 触发 languageChanged 重渲染：切语言后 select.value 立即更新。
  const i18nSvc = host.i18n;
  const currentLang = i18nSvc.language();
  const supported = i18nSvc.supported();

  const [value, setValue] = useState<string>(() => i18nSvc.language());
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    setValue(currentLang);
  }, [currentLang]);

  async function onChange(next: string) {
    setWarning(null);
    setValue(next);
    try {
      await i18nSvc.setLanguage(next as SupportedLanguage);
    } catch (err) {
      // i18n 内部吞掉 localStorage 异常；这里仅防御外部调用方未捕获的 reject。
      setWarning(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section className="settings-language">
      <h2>{t("settings.language.title", { defaultValue: "Language" })}</h2>
      <p className="settings-language__desc">
        {t("settings.language.description", { defaultValue: "Choose display language. Switch is instant." })}
      </p>
      <Select
        label={t("settings.language.title", { defaultValue: "Language" })}
        value={value}
        onChange={(e) => {
          void onChange(e.currentTarget.value);
        }}
        options={supported.map((s) => ({
          label: { key: `common.locale.${s.code}`, fallback: s.code },
          value: s.code
        }))}
      />
      {warning ? <p className="settings-language__warning">{warning}</p> : null}
    </section>
  );
}
