// Web Window 运行单元实现注册。
//
// manifest 只保留可序列化的静态描述；可执行 setup 由当前执行环境显式注册。
// 这样 Window 不会因为清单漏绑而静默得到空 Host，也不会把 Worker 实现误当成本地实现。

import type {
  PluginManifest,
  PluginSetup,
  RuntimeUnitImplementationRegistry,
} from "@keymaster/contracts";
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
import { homePlugin, homeSetup } from "@keymaster/plugin-home";
import { hexImporterPlugin, hexImporterSetup } from "@keymaster/plugin-importer-hex";
import {
  jsonFileImporterPlugin,
  jsonFileImporterSetup,
} from "@keymaster/plugin-importer-json-file";
import { wifImporterPlugin, wifImporterSetup } from "@keymaster/plugin-importer-wif";
import { keyImportPlugin, keyImportSetup } from "@keymaster/plugin-key-import";
import { msfilePlugin, msfileSetup } from "@keymaster/plugin-msfile";
import { satSubscriptionPlugin, satSubscriptionSetup } from "@keymaster/plugin-sat-subscription";
import { windowP2pPlugin, windowP2pSetup } from "@keymaster/plugin-window-p2p";
import { p2pkhPlugin, p2pkhSetup } from "@keymaster/plugin-p2pkh";
import { jungleBusPlugin, jungleBusSetup } from "@keymaster/plugin-junglebus";
import { pokerPlugin, pokerSetup } from "@keymaster/plugin-poker";
import { protocolPlugin, protocolSetup } from "@keymaster/plugin-protocol";
import {
  storagePlatformPlugin,
  storagePlatformSetup,
} from "@keymaster/platform-storage";
import { settingsPlugin, settingsSetup } from "@keymaster/plugin-settings";
import { bsv21TokenPlugin, bsv21TokenSetup } from "@keymaster/plugin-token-bsv21";
import { stasTokenPlugin, stasTokenSetup } from "@keymaster/plugin-token-stas";
import { vaultPlugin, vaultSetup } from "@keymaster/plugin-vault";
import { wocPlugin, wocSetup } from "@keymaster/plugin-woc";

/** Web Window 当前允许装配的产品实现；键值是静态 manifest 的稳定 id。 */
const WEB_WINDOW_SETUP_BY_PLUGIN_ID: ReadonlyMap<string, PluginSetup> = new Map([
  [appsPlugin.id, appsSetup],
  [bsvPricePlugin.id, bsvPriceSetup],
  [messagePlatformPlugin.id, messageSetup],
  [webrtcPlugin.id, webrtcSetup],
  [backgroundPlugin.id, backgroundSetup],
  [oneSatOrdinalsCollectiblePlugin.id, oneSatOrdinalsCollectibleSetup],
  [contactsPlugin.id, contactsSetup],
  [homePlugin.id, homeSetup],
  [hexImporterPlugin.id, hexImporterSetup],
  [jsonFileImporterPlugin.id, jsonFileImporterSetup],
  [wifImporterPlugin.id, wifImporterSetup],
  [keyImportPlugin.id, keyImportSetup],
  [msfilePlugin.id, msfileSetup],
  [satSubscriptionPlugin.id, satSubscriptionSetup],
  [windowP2pPlugin.id, windowP2pSetup],
  [p2pkhPlugin.id, p2pkhSetup],
  [jungleBusPlugin.id, jungleBusSetup],
  [pokerPlugin.id, pokerSetup],
  [protocolPlugin.id, protocolSetup],
  [storagePlatformPlugin.id, storagePlatformSetup],
  [settingsPlugin.id, settingsSetup],
  [bsv21TokenPlugin.id, bsv21TokenSetup],
  [stasTokenPlugin.id, stasTokenSetup],
  [vaultPlugin.id, vaultSetup],
  [wocPlugin.id, wocSetup],
]);

function windowUnitId(manifest: PluginManifest): string {
  const units = manifest.units ?? [];
  if (units.length === 0) return manifest.id;
  const windowUnits = units.filter((unit) => unit.execution === "window");
  if (windowUnits.length !== 1) {
    throw new Error(`产品 ${manifest.id} 必须声明唯一 Window 运行单元后才能注册 Web 实现`);
  }
  return windowUnits[0]!.id;
}

/** 创建 Web Window 的显式运行实现注册表。 */
export function createWebRuntimeUnitImplementationRegistry(
  manifests: readonly PluginManifest[],
): RuntimeUnitImplementationRegistry {
  const manifestById = new Map(manifests.map((manifest) => [manifest.id, manifest]));
  const unitIdByPluginId = new Map<string, string>();
  for (const manifest of manifests) {
    unitIdByPluginId.set(manifest.id, windowUnitId(manifest));
  }

  return {
    get(pluginId, unitId) {
      const manifest = manifestById.get(pluginId);
      if (!manifest || unitIdByPluginId.get(pluginId) !== unitId) return undefined;
      return WEB_WINDOW_SETUP_BY_PLUGIN_ID.get(pluginId);
    },
  };
}
