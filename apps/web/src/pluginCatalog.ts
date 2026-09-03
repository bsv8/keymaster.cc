// Web 装配清单：这是应用选择安装哪些插件的唯一配置点。
//
// 新增或移除一个插件只需要在本文件增删一个 import 和一个条目；菜单、首页
// 空间、路由和它们的排序都由插件自身 manifest.business 声明，不在这里或
// shell 里维护。条目仍按 capability 依赖顺序排列，避免启动时出现暂缺 provider。

import type { PluginManifest } from "@keymaster/contracts";
import { appsPlugin } from "@keymaster/plugin-apps";
import { bsvPricePlugin } from "@keymaster/plugin-bsv-price";
import { messagePlatformPlugin } from "@keymaster/plugin-message";
import { webrtcPlugin } from "@keymaster/plugin-webrtc";
import { backgroundPlugin } from "@keymaster/plugin-background";
import { oneSatOrdinalsCollectiblePlugin } from "@keymaster/plugin-collectible-1satordinals";
import { contactsPlugin } from "@keymaster/plugin-contacts";
import { homePlugin } from "@keymaster/plugin-home";
import { hexImporterPlugin } from "@keymaster/plugin-importer-hex";
import { jsonFileImporterPlugin } from "@keymaster/plugin-importer-json-file";
import { wifImporterPlugin } from "@keymaster/plugin-importer-wif";
import { keyImportPlugin } from "@keymaster/plugin-key-import";
import { msfilePlugin } from "@keymaster/plugin-msfile";
import { satSubscriptionPlugin } from "@keymaster/plugin-sat-subscription";
import { windowP2pPlugin } from "@keymaster/plugin-window-p2p";
import { p2pkhPlugin } from "@keymaster/plugin-p2pkh";
import { jungleBusPlugin } from "@keymaster/plugin-junglebus";
import { pokerPlugin } from "@keymaster/plugin-poker";
import { protocolPlugin } from "@keymaster/plugin-protocol";
import { storagePlugin } from "@keymaster/plugin-storage";
import { settingsPlugin } from "@keymaster/plugin-settings";
import { bsv21TokenPlugin } from "@keymaster/plugin-token-bsv21";
import { stasTokenPlugin } from "@keymaster/plugin-token-stas";
import { vaultPlugin } from "@keymaster/plugin-vault";
import { wocPlugin } from "@keymaster/plugin-woc";

export const WEB_PLUGIN_CATALOG: readonly PluginManifest[] = [
  vaultPlugin,
  storagePlugin,
  windowP2pPlugin,
  msfilePlugin,
  satSubscriptionPlugin,
  protocolPlugin,
  contactsPlugin,
  webrtcPlugin,
  messagePlatformPlugin,
  settingsPlugin,
  keyImportPlugin,
  backgroundPlugin,
  homePlugin,
  wocPlugin,
  jungleBusPlugin,
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
