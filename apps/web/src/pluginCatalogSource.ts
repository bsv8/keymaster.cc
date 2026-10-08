import { assetsPlugin, assetsSetup } from "@keymaster/plugin-assets";
import { collectiblesPlugin, collectiblesSetup } from "@keymaster/plugin-collectibles";
import { scanPlugin, scanSetup } from "@keymaster/plugin-scan";
// Web Window 运行单元实现注册。
//
// manifest 只保留可序列化的静态描述；可执行 setup 由当前执行环境显式注册。
// 这样 Window 不会因为清单漏绑而静默得到空 Host，也不会把 Worker 实现误当成本地实现。

import type {
  PluginManifest,
  PluginSetup,
  RuntimeUnitImplementationRegistry,
} from "@keymaster/contracts";
import { pagePlugin, pageSetup } from "@keymaster/plugin-page";
import { appsPlugin, appsSetup } from "@keymaster/plugin-apps";
import { bsvPricePlugin, bsvPriceSetup } from "@keymaster/plugin-bsv-price";
import {
  messagePlatformPlugin,
  messageSetup,
} from "@keymaster/plugin-message";
import { webrtcPlugin, webrtcSetup } from "@keymaster/plugin-webrtc";
import { backgroundPlugin, backgroundSetup } from "@keymaster/plugin-background";
import {
  oneSatOrdinalsCollectiblePlugin,
  oneSatOrdinalsCollectibleSetup,
} from "@keymaster/plugin-collectible-1satordinals";
import { contactsPlugin, contactsSetup } from "@keymaster/plugin-contacts";
import { msfilePlugin, msfileSetup } from "@keymaster/plugin-msfile";
import { forumPlugin, forumSetup } from "@keymaster/plugin-forum";
import { satSubscriptionPlugin, satSubscriptionSetup } from "@keymaster/plugin-sat-subscription";
import { windowP2pPlugin, windowP2pSetup } from "@keymaster/plugin-window-p2p";
import { p2pkhPlugin, p2pkhSetup } from "@keymaster/plugin-p2pkh";
import { protocolPlugin, protocolSetup } from "@keymaster/plugin-protocol";
import {
  storagePlatformPlugin,
  storagePlatformSetup,
} from "@keymaster/platform-storage";
import { bsv21TokenPlugin, bsv21TokenSetup } from "@keymaster/plugin-token-bsv21";
import { stasTokenPlugin, stasTokenSetup } from "@keymaster/plugin-token-stas";
import { vaultPlugin, vaultSetup } from "@keymaster/plugin-vault";
import { wocPlugin, wocSetup } from "@keymaster/plugin-woc";


/** Release choices and Window implementations share one assembly entry per product. */
export const WEB_PLUGIN_IMPLEMENTATIONS: readonly { manifest: PluginManifest; setup: PluginSetup }[] = [
  { manifest: pagePlugin, setup: pageSetup },
  { manifest: assetsPlugin, setup: assetsSetup },
  { manifest: collectiblesPlugin, setup: collectiblesSetup },
  { manifest: scanPlugin, setup: scanSetup },
  { manifest: storagePlatformPlugin, setup: storagePlatformSetup },
  { manifest: vaultPlugin, setup: vaultSetup },
  { manifest: windowP2pPlugin, setup: windowP2pSetup },
  { manifest: msfilePlugin, setup: msfileSetup },
  { manifest: forumPlugin, setup: forumSetup },
  { manifest: satSubscriptionPlugin, setup: satSubscriptionSetup },
  { manifest: protocolPlugin, setup: protocolSetup },
  { manifest: contactsPlugin, setup: contactsSetup },
  { manifest: webrtcPlugin, setup: webrtcSetup },
  { manifest: messagePlatformPlugin, setup: messageSetup },
  { manifest: backgroundPlugin, setup: backgroundSetup },
  { manifest: wocPlugin, setup: wocSetup },
  { manifest: p2pkhPlugin, setup: p2pkhSetup },
  { manifest: bsv21TokenPlugin, setup: bsv21TokenSetup },
  { manifest: stasTokenPlugin, setup: stasTokenSetup },
  { manifest: oneSatOrdinalsCollectiblePlugin, setup: oneSatOrdinalsCollectibleSetup },
  { manifest: bsvPricePlugin, setup: bsvPriceSetup },
  { manifest: appsPlugin, setup: appsSetup },
] as const;
export const WEB_PLUGIN_CATALOG_SOURCE: readonly PluginManifest[] = WEB_PLUGIN_IMPLEMENTATIONS.map(entry => entry.manifest);
