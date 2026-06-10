// apps/web/src/bootstrapPlugins.ts
// 装配插件：按依赖顺序注册。
// 设计缘由：apps/web 是装配层，只 import manifest，不 import 内部服务。
// 顺序（硬切换后）：
//   runtime 内置 -> vault -> home -> settings -> assets -> key-import -> transfer -> contacts -> woc -> background -> p2pkh -> importers。
// plugin-woc 必须早于 plugin-p2pkh；plugin-background 必须早于 plugin-p2pkh；
// plugin-transfer 必须早于 plugin-p2pkh（P2PKH 注册 Transfer Provider）。
//
// 硬切换 003：把 shell 自身 i18n 资源（apps/web 装配层）通过 initialI18nResources
// 注入；plugin 注册前可被 t() 命中。

import { createPluginHost, type PluginHost } from "@keymaster/runtime";
import { assetsPlugin } from "@keymaster/plugin-assets";
import { backgroundPlugin } from "@keymaster/plugin-background";
import { contactsPlugin } from "@keymaster/plugin-contacts";
import { homePlugin } from "@keymaster/plugin-home";
import { hexImporterPlugin } from "@keymaster/plugin-importer-hex";
import { jsonFileImporterPlugin } from "@keymaster/plugin-importer-json-file";
import { wifImporterPlugin } from "@keymaster/plugin-importer-wif";
import { keyImportPlugin } from "@keymaster/plugin-key-import";
import { p2pkhPlugin } from "@keymaster/plugin-p2pkh";
import { settingsPlugin } from "@keymaster/plugin-settings";
import { transferPlugin } from "@keymaster/plugin-transfer";
import { vaultPlugin } from "@keymaster/plugin-vault";
import { wocPlugin } from "@keymaster/plugin-woc";
import { SHELL_RESOURCES } from "./i18n/resources.js";

export async function bootstrapPlugins(): Promise<PluginHost> {
  // 装配层把缺 key warning 打开：开发期方便排查未翻译文案。
  // import.meta.env 是 Vite 注入的；通过 typeof 守卫避免 TS 在 node 环境下报错。
  const meta = import.meta as ImportMeta & { env?: { MODE?: string; DEV?: boolean } };
  const isProd = meta.env
    ? (typeof meta.env.MODE === "string" ? meta.env.MODE === "production" : meta.env.DEV === false)
    : false;
  const host = createPluginHost({
    initialI18nResources: [SHELL_RESOURCES],
    i18nDebug: !isProd
  });

  const ordered = [
    vaultPlugin,
    homePlugin,
    settingsPlugin,
    assetsPlugin,
    keyImportPlugin,
    transferPlugin,
    contactsPlugin,
    wocPlugin,
    backgroundPlugin,
    p2pkhPlugin,
    wifImporterPlugin,
    hexImporterPlugin,
    jsonFileImporterPlugin
  ];

  await host.registerAll(ordered);
  return host;
}
