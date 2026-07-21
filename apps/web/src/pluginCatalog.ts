// Web 装配清单：这是应用选择安装哪些插件的唯一配置点。
//
// 新增或移除一个插件只需要在本文件增删一个 import 和一个条目；菜单、首页
// 空间、路由和它们的排序都由插件自身 manifest.business 声明，不在这里或
// shell 里维护。条目仍按 capability 依赖顺序排列，避免启动时出现暂缺 provider。

import type { PluginManifest } from "@keymaster/contracts";
import { appsPlugin } from "@keymaster/plugin-apps";
import { appmsgPlatformPlugin } from "@keymaster/plugin-appmsg";
import { broadcastPlatformPlugin } from "@keymaster/plugin-broadcast";
import { bsvPricePlugin } from "@keymaster/plugin-bsv-price";
import { hubcastPlatformPlugin } from "@keymaster/plugin-hubcast";
import { hubmsgPlatformPlugin } from "@keymaster/plugin-hubmsg";
import { messagePlatformPlugin } from "@keymaster/plugin-message";
import { webrtcPlugin } from "@keymaster/plugin-webrtc";
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

export const WEB_PLUGIN_CATALOG: readonly PluginManifest[] = [
  vaultPlugin,
  broadcastPlatformPlugin,
  hubcastPlatformPlugin,
  appmsgPlatformPlugin,
  hubmsgPlatformPlugin,
  protocolPlugin,
  webrtcPlugin,
  messagePlatformPlugin,
  settingsPlugin,
  assetsPlugin,
  collectiblesPlugin,
  collectibleTransferPlugin,
  keyImportPlugin,
  transferPlugin,
  contactsPlugin,
  homePlugin,
  wocPlugin,
  backgroundPlugin,
  p2pkhPlugin,
  bsv21TokenPlugin,
  stasTokenPlugin,
  oneSatOrdinalsCollectiblePlugin,
  pokerPlugin,
  wifImporterPlugin,
  hexImporterPlugin,
  jsonFileImporterPlugin,
  bsvPricePlugin,
  appsPlugin
];
