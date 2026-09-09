// packages/plugin-importer-wif/src/manifest.ts
// 注册 WIF importer。
// 设计缘由：importer 插件不写 vault、不注册菜单/页面，只往 importer.registry 添加一个实现。
//
// 硬切换 003：WIF 短码字面量稳定，name 走 string（不再走 I18nText）；
// 但提供 i18n 资源覆盖 importer 名称/描述，方便设置/历史页展示。

import type { I18nPluginResources, ImporterRegistry, PluginManifest, PluginSetup } from "@keymaster/contracts";
import { defineRuntimeUnitDependencies } from "@keymaster/contracts";
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

const wifImporterPluginDefinition = {
  id: "importer-wif",
  name: "WIF Importer",
  description: "支持 WIF 文本私钥导入。",
  meta: {
    kind: "business",
    startup: "optional",
    // 首次 Storage 初始化的导入向导也需要 WIF importer；该插件只依赖
    // Host 内置 importer.registry，不依赖尚未创建的 Vault。
    bootstrapStage: "storage-onboarding",
    defaultEnabled: true,
    canDisable: true,
    displayGroup: "import"
  },
  units: [{
    id: "importer-wif.window",
    runtime: "window-main",
    scopeKind: "root",
    dependencies: defineRuntimeUnitDependencies([
      { capability: "importer.registry", reason: "需要注册 WIF 实现" },
    ]),
  }],
  i18n: wifResources,
  setup(ctx) {
    const registry = ctx.get<ImporterRegistry>("importer.registry");
    registry.register(wifImporter);
    return () => {
      // host owner 回收时会 unregister importer；这里 no-op。
    };
  }
} satisfies PluginManifest & { setup: PluginSetup };

const { setup: wifImporterSetup, ...wifImporterPlugin } = wifImporterPluginDefinition;
export { wifImporterSetup, wifImporterPlugin };
