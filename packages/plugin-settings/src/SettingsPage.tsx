// packages/plugin-settings/src/SettingsPage.tsx
// 设置页：从 settings.registry 读取 page 和 field。
// 设计缘由：禁止直接 import 业务设置组件。
//
// 硬切换 003：所有展示文案走 i18n。label / description / option.label 都是
// I18nText，渲染时通过 host.i18n.text() 解析。LanguageSection 始终渲染在
// 第一段（order 最高），其余 page 来自 settings.registry。

import { useEffect, useState } from "react";
import { Button, PageHeader, Select, TextInput } from "@keymaster/ui";
import { useCapability, useI18n, usePluginHost } from "@keymaster/runtime";
import type { SettingsField, SettingsPage, SettingsRegistry } from "@keymaster/contracts";
import { LanguageSection } from "./LanguageSection.js";

function FieldRow({ field }: { field: SettingsField }) {
  const host = usePluginHost();
  const { t } = useI18n();
  const [value, setValue] = useState<string | number | boolean>("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    field.getValue().then((v) => setValue((v ?? field.defaultValue ?? "") as never));
  }, [field]);

  async function save() {
    setSaving(true);
    try {
      await field.setValue(value as never);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } finally {
      setSaving(false);
    }
  }

  if (field.kind === "boolean") {
    return (
      <div className="settings-field">
        <Select
          label={host.i18n.text(field.label)}
          value={value ? "yes" : "no"}
          onChange={(e) => setValue(e.currentTarget.value === "yes")}
          options={[
            { label: { key: "settings.field.boolean.yes", fallback: "是" }, value: "yes" },
            { label: { key: "settings.field.boolean.no", fallback: "否" }, value: "no" }
          ]}
        />
        {field.description ? <p className="settings-field__desc">{host.i18n.text(field.description)}</p> : null}
        <Button size="sm" onClick={save} loading={saving}>
          {t("common.action.save", { defaultValue: "保存" })}
        </Button>
        {saved ? (
          <span className="settings-field__saved">
            {t("settings.field.saved", { defaultValue: "已保存" })}
          </span>
        ) : null}
      </div>
    );
  }

  if (field.kind === "select") {
    return (
      <div className="settings-field">
        <Select
          label={host.i18n.text(field.label)}
          value={String(value)}
          onChange={(e) => setValue(e.currentTarget.value)}
          options={(field.options ?? []).map((o) => ({
            label: host.i18n.text(o.label),
            value: o.value
          }))}
        />
        {field.description ? <p className="settings-field__desc">{host.i18n.text(field.description)}</p> : null}
        <Button size="sm" onClick={save} loading={saving}>
          {t("common.action.save", { defaultValue: "保存" })}
        </Button>
      </div>
    );
  }

  return (
    <div className="settings-field">
      <TextInput
        label={host.i18n.text(field.label)}
        value={String(value)}
        onChange={(e) => setValue(e.currentTarget.value)}
        type={field.kind === "number" ? "number" : "text"}
      />
      {field.description ? <p className="settings-field__desc">{host.i18n.text(field.description)}</p> : null}
      <Button size="sm" onClick={save} loading={saving}>
        {t("common.action.save", { defaultValue: "保存" })}
      </Button>
      {saved ? (
        <span className="settings-field__saved">
          {t("settings.field.saved", { defaultValue: "已保存" })}
        </span>
      ) : null}
    </div>
  );
}

export function SettingsPage() {
  const host = usePluginHost();
  const registry = useCapability<SettingsRegistry>("settings.registry");
  const { t } = useI18n();
  // 触发 languageChanged 重渲染。
  useI18n().language();
  const pages = registry.listPages();
  const fields = registry.listFields();

  return (
    <div className="settings-page">
      <PageHeader
        title={t("settings.page.title", { defaultValue: "设置" })}
        description={t("settings.page.description", { defaultValue: "来自 settings.registry 的设置项。" })}
      />
      {/* 平台内置：语言设置始终第一段。 */}
      <section className="settings-page__section">
        <LanguageSection />
      </section>
      {pages.map((page: SettingsPage) => (
        <section key={page.id} className="settings-page__section">
          <h2>{host.i18n.text(page.label)}</h2>
          {page.description ? <p>{host.i18n.text(page.description)}</p> : null}
          {page.component ? <page.component /> : null}
          {page.fields.map((f) => (
            <FieldRow key={f.id} field={f} />
          ))}
        </section>
      ))}
      {fields
        .filter((f) => !pages.some((p) => p.fields.some((pf) => pf.id === f.id)))
        .map((f) => (
          <section key={f.id} className="settings-page__section">
            <FieldRow field={f} />
          </section>
        ))}
    </div>
  );
}
