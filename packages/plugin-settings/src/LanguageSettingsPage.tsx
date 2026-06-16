// packages/plugin-settings/src/LanguageSettingsPage.tsx
// 语言设置正式详情页：/settings/language
//
// 设计缘由（硬切换 003）：
//   - 不再有 /settings 聚合页；语言设置迁到独立 /settings/language。
//   - 复用 LanguageSection 的核心交互（i18n.service.setLanguage + 持久化）。
//   - 顶级 PageHeader 描述 + 单一选区，确保作为正式设置页具备自描述能力。

import { PageHeader } from "@keymaster/ui";
import { useI18n } from "@keymaster/runtime";
import { LanguageSection } from "./LanguageSection.js";

export function LanguageSettingsPage() {
  const { t } = useI18n();
  return (
    <div className="settings-language-page">
      <PageHeader
        title={t("settings.language.title", { defaultValue: "Language" })}
        description={t("settings.language.description", {
          defaultValue: "Choose display language. Affects all UI text; switch is instant."
        })}
      />
      <section className="settings-language-page__section">
        <LanguageSection />
      </section>
    </div>
  );
}
