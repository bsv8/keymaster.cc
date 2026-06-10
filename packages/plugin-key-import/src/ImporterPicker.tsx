// packages/plugin-key-import/src/ImporterPicker.tsx
// 选择一个 importer 来处理输入。
// 设计缘由：picker 只负责选择，不解析业务格式；解析由对应 importer 插件负责。
//
// 硬切换 003：name / description 是 I18nText，渲染时通过 host.i18n.text() 解析。

import { useCapability, useI18n, usePluginHost } from "@keymaster/runtime";
import type { ImporterRegistry, KeyImporter } from "@keymaster/contracts";

export interface ImporterPickerProps {
  selected: string | undefined;
  onSelect: (importer: KeyImporter) => void;
}

export function ImporterPicker({ selected, onSelect }: ImporterPickerProps) {
  const registry = useCapability<ImporterRegistry>("importer.registry");
  const host = usePluginHost();
  const { t } = useI18n();
  useI18n().language();
  const list = registry.list();
  if (list.length === 0) {
    return <p className="importer-picker__empty">{t("keyImport.picker.empty", { defaultValue: "没有可用的导入器。" })}</p>;
  }
  return (
    <div className="importer-picker">
      {list.map((importer) => (
        <button
          key={importer.id}
          type="button"
          className={`importer-picker__item ${selected === importer.id ? "is-selected" : ""}`}
          onClick={() => onSelect(importer)}
        >
          <span className="importer-picker__name">{host.i18n.text(importer.name)}</span>
          {importer.description ? (
            <span className="importer-picker__desc">{host.i18n.text(importer.description)}</span>
          ) : null}
          <span className="importer-picker__supports">
            {t("keyImport.page.label.supports", { defaultValue: "支持：" })}
            {importer.supports.join(", ")}
          </span>
        </button>
      ))}
    </div>
  );
}
