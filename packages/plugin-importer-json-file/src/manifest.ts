// packages/plugin-importer-json-file/src/manifest.ts
// 注册 JSON file importer。
// 设计缘由：importer 插件不写 vault、不注册菜单/页面。

import type { I18nPluginResources, ImporterRegistry, PluginManifest } from "@keymaster/contracts";
import { jsonFileImporter } from "./jsonFileImporter.js";

const jsonFileResources: I18nPluginResources = {
  namespace: "importerJsonFile",
  resources: {
    en: {
      "importerJsonFile.name": "JSON File",
      "importerJsonFile.description": "Extract private keys from a wallet JSON export; supports bsv8 encrypted envelopes.",
      "importerJsonFile.summary.envelope": "bsv8 encrypted key envelope",
      "importerJsonFile.summary.field": "Field: {{path}}"
    },
    "zh-CN": {
      "importerJsonFile.name": "JSON File",
      "importerJsonFile.description": "从钱包导出的 JSON 文件中提取私钥；支持 bsv8 加密 envelope。",
      "importerJsonFile.summary.envelope": "bsv8 加密 envelope",
      "importerJsonFile.summary.field": "字段：{{path}}"
    }
  }
};

export const jsonFileImporterPlugin: PluginManifest = {
  id: "importer-json-file",
  name: "JSON File Importer",
  description: "从钱包 JSON 导出文件中提取私钥。",
  i18n: jsonFileResources,
  dependencies: [{ capability: "importer.registry", reason: "需要注册 JSON 实现" }],
  setup(ctx) {
    ctx.get<ImporterRegistry>("importer.registry").register(jsonFileImporter);
  }
};
