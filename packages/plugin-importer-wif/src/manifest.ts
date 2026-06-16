// packages/plugin-importer-wif/src/manifest.ts
// 注册 WIF importer。
// 设计缘由：importer 插件不写 vault、不注册菜单/页面，只往 importer.registry 添加一个实现。
//
// 硬切换 003：WIF 短码字面量稳定，name 走 string（不再走 I18nText）；
// 但提供 i18n 资源覆盖 importer 名称/描述，方便设置/历史页展示。

import type { I18nPluginResources, ImporterRegistry, PluginManifest } from "@keymaster/contracts";
import { wifImporter } from "./wifImporter.js";

const wifResources: I18nPluginResources = {
  namespace: "importerWif",
  resources: {
    en: {
      "importerWif.name": "WIF",
      "importerWif.description": "Paste a BSV WIF private key (Base58Check encoded).",
      "importerWif.summary.compressed": "Compressed WIF",
      "importerWif.summary.uncompressed": "Uncompressed WIF"
    },
    "zh-CN": {
      "importerWif.name": "WIF",
      "importerWif.description": "粘贴 BSV WIF 私钥（Base58Check 编码）。",
      "importerWif.summary.compressed": "Compressed WIF",
      "importerWif.summary.uncompressed": "Uncompressed WIF"
    }
  }
};

export const wifImporterPlugin: PluginManifest = {
  id: "importer-wif",
  name: "WIF Importer",
  description: "支持 WIF 文本私钥导入。",
  meta: {
    kind: "business",
    defaultEnabled: true,
    canDisable: true,
    displayGroup: "import"
  },
  i18n: wifResources,
  dependencies: [{ capability: "importer.registry", reason: "需要注册 WIF 实现" }],
  setup(ctx) {
    const registry = ctx.get<ImporterRegistry>("importer.registry");
    registry.register(wifImporter);
    return () => {
      // host owner 回收时会 unregister importer；这里 no-op。
    };
  }
};
