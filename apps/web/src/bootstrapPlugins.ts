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
//
// 硬切换 001：bootstrap 不再等价于"ordered = 全部一定装载"。
//   - registerAll 把每个 manifest 加入 host 已知集合；
//   - host 内部根据"全局启停配置（localStorage）+ manifest.meta.defaultEnabled"
//     决定每个 plugin 初始是否 enable。
//   - 因此旧的"按顺序 registerAll"在新模型下也保持兼容：core / settings / home 等
//     标记 defaultEnabled=true 的会自动装载，business 插件可通过配置 store 控制。

import { createPluginHost, type PluginHost } from "@keymaster/runtime";
import { assetsPlugin } from "@keymaster/plugin-assets";
import { backgroundPlugin } from "@keymaster/plugin-background";
import { collectiblesPlugin } from "@keymaster/plugin-collectibles";
import { collectibleTransferPlugin } from "@keymaster/plugin-collectible-transfer";
import { oneSatOrdinalsCollectiblePlugin } from "@keymaster/plugin-collectible-1satordinals";
import { contactsPlugin } from "@keymaster/plugin-contacts";
import { homePlugin } from "@keymaster/plugin-home";
import { hexImporterPlugin } from "@keymaster/plugin-importer-hex";
import { jsonFileImporterPlugin } from "@keymaster/plugin-importer-json-file";
import { wifImporterPlugin } from "@keymaster/plugin-importer-wif";
import { keyImportPlugin } from "@keymaster/plugin-key-import";
import { p2pkhPlugin } from "@keymaster/plugin-p2pkh";
import { pokerPlugin } from "@keymaster/plugin-poker";
import { protocolPlugin } from "@keymaster/plugin-protocol";
import { settingsPlugin } from "@keymaster/plugin-settings";
import { bsv21TokenPlugin } from "@keymaster/plugin-token-bsv21";
import { stasTokenPlugin } from "@keymaster/plugin-token-stas";
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

  // 硬切换 001 + 施工单 004：按"依赖先后保证 capability 顺序"的顺序
  // 加入已知集合。host.register 内部会按 config store 决定是否自动 enable。
  //
  // 关键顺序（施工单 004）：
  //   vault
  //   protocol
  //   home
  //   settings
  //   assets
  //   collectibles
  //   collectible-transfer
  //   key-import
  //   transfer
  //   contacts
  //   woc
  //   background
  //   p2pkh
  //   token / collectible 业务插件（依赖 p2pkh.service + woc.*）
  //   importers
  //
  // 设计缘由：
  //   - wocPlugin 必须在 p2pkhPlugin 之前装载（plugin-p2pkh 内部会拿
  //     woc.service；plugin-woc 自身在 manifest provide WOC capabilities）。
  //   - backgroundPlugin 也必须在 p2pkhPlugin 之前。
  //   - token / collectible 业务插件必须在 p2pkhPlugin 之后，因为它们
  //     直接依赖 p2pkh.service / woc.bsv21.service / woc.stas.service /
  //     woc.1satordinals.service；plugin-p2pkh 与 plugin-woc 是这些
  //     capability 的唯一提供方。
  const ordered = [
    vaultPlugin,
    protocolPlugin,
    homePlugin,
    settingsPlugin,
    assetsPlugin,
    collectiblesPlugin,
    collectibleTransferPlugin,
    keyImportPlugin,
    transferPlugin,
    contactsPlugin,
    wocPlugin,
    backgroundPlugin,
    p2pkhPlugin,
    bsv21TokenPlugin,
    stasTokenPlugin,
    oneSatOrdinalsCollectiblePlugin,
    pokerPlugin,
    wifImporterPlugin,
    hexImporterPlugin,
    jsonFileImporterPlugin
  ];

  await host.registerAll(ordered);
  return host;
}
