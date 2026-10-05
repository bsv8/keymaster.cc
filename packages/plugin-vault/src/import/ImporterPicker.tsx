import { useInternalVault, useVaultImporters } from "../VaultInternalContext.js";
// packages/plugin-vault/src/import/ImporterPicker.tsx
// 选择一个 importer 来处理输入。
// 设计缘由：picker 只负责选择，不解析业务格式；解析由 Vault 内部格式解析器负责。
//
// 硬切换 003：name / description 是 I18nText，渲染时通过 text() 解析。

import { usePluginCapability } from "webloom-framework/react";
import { usePluginI18n } from "@keymaster/runtime";

import type { KeyImporter } from "./types.js";

export interface ImporterPickerProps {
  selected: string | undefined;
  onSelect: (importer: KeyImporter) => void;
}

export function ImporterPicker({ selected, onSelect }: ImporterPickerProps) {
  const registry = useVaultImporters();
  const { t, text } = usePluginI18n();
  const list = registry.list();
  if (list.length === 0) {
    return <p className="importer-picker__empty">{t("vault.import.picker.empty", { defaultValue: "没有可用的导入器。" })}</p>;
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
          <span className="importer-picker__name">{text(importer.name)}</span>
          {importer.description ? (
            <span className="importer-picker__desc">{text(importer.description)}</span>
          ) : null}
          <span className="importer-picker__supports">
            {t("vault.import.page.label.supports", { defaultValue: "支持：" })}
            {importer.supports.join(", ")}
          </span>
        </button>
      ))}
    </div>
  );
}
