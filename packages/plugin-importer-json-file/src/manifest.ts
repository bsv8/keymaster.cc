// packages/plugin-importer-json-file/src/manifest.ts
// 注册 JSON importer。
// 设计缘由：importer 插件不写 vault、不注册菜单/页面。
//
// 硬切换 012（施工单 001）：名称从 "JSON File" 改为 "JSON"，因为 importer
// 已经同时支持 JSON 文件与 JSON 文本；继续叫 "JSON File" 会和实际能力冲突。

import type { I18nPluginResources, PluginManifest, PluginSetup } from "@keymaster/contracts";
import { IMPORTER_REGISTRY_CAPABILITY, defineRuntimeUnitDependencies } from "@keymaster/contracts";
import { jsonFileImporter } from "./jsonFileImporter.js";

const jsonFileResources: I18nPluginResources = {
  namespace: "importerJsonFile",
  resources: {
    en: {
      "importerJsonFile.name": "JSON",
      "importerJsonFile.description":
        "Extract private keys from a wallet JSON export; supports JSON files, JSON text, and bsv8 encrypted envelopes.",
      "importerJsonFile.summary.envelope": "bsv8 encrypted key envelope",
      "importerJsonFile.summary.field": "Field: {{path}}"
    },
    "zh-CN": {
      "importerJsonFile.name": "JSON",
      "importerJsonFile.description":
        "从钱包导出的 JSON 中提取私钥；支持 JSON 文件、JSON 文本与 bsv8 加密 envelope。",
      "importerJsonFile.summary.envelope": "bsv8 加密 envelope",
      "importerJsonFile.summary.field": "字段：{{path}}"
    }
  }
};

const jsonFileImporterPluginDefinition = {
  id: "importer-json-file",
  name: "JSON Importer",
  description: "从钱包 JSON 导出文件 / JSON 文本中提取私钥。",
  kind: "business",
  startup: "optional",
    // 首次 Storage 初始化的导入向导也需要 JSON importer；该插件只依赖
    // Host 内置 importer.registry，不依赖尚未创建的 Vault。
    bootstrapStage: "storage-onboarding",
  defaultEnabled: true,
  canDisable: true,
  displayGroup: "import",
  units: [{
    id: "importer-json-file.window",
    runtime: "window-main",
    scopeKind: "root",
    dependencies: defineRuntimeUnitDependencies([
      { capability: IMPORTER_REGISTRY_CAPABILITY, sourceRuntime: "window-main", reason: "需要注册 JSON 实现" },
    ]),
  }],
  i18n: jsonFileResources,
  setup(ctx) {
    ctx.capability(IMPORTER_REGISTRY_CAPABILITY).register(jsonFileImporter);
    return () => {
      // no-op
    };
  }
} satisfies PluginManifest & { setup: PluginSetup };

const { setup: jsonFileImporterSetup, ...jsonFileImporterPlugin } = jsonFileImporterPluginDefinition;
export { jsonFileImporterSetup, jsonFileImporterPlugin };
