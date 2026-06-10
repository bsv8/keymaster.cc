// packages/plugin-importer-hex/src/manifest.ts
// 注册 HEX importer。
// 设计缘由：importer 插件不写 vault、不注册菜单/页面。

import type { I18nPluginResources, ImporterRegistry, PluginManifest } from "@keymaster/contracts";
import { hexImporter } from "./hexImporter.js";

const hexResources: I18nPluginResources = {
  namespace: "importerHex",
  resources: {
    en: {
      "importerHex.name": "Hex",
      "importerHex.description": "32-byte hex private key.",
      "importerHex.summary": "32-byte hex private key"
    },
    "zh-CN": {
      "importerHex.name": "Hex",
      "importerHex.description": "32 字节十六进制私钥。",
      "importerHex.summary": "32 字节十六进制私钥"
    }
  }
};

export const hexImporterPlugin: PluginManifest = {
  id: "importer-hex",
  name: "Hex Importer",
  description: "支持 32 字节 hex 私钥导入。",
  i18n: hexResources,
  dependencies: [{ capability: "importer.registry", reason: "需要注册 HEX 实现" }],
  setup(ctx) {
    ctx.get<ImporterRegistry>("importer.registry").register(hexImporter);
  }
};
