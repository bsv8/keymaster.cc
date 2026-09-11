// Web 装配入口清单：这是应用选择加载哪些插件实现的唯一入口点。
//
// 新增或移除一个插件只需要在本文件增删一个 import 和一个条目；菜单、首页
// 空间、路由和它们的排序都由插件自身 Window unit.business 声明，不在这里或
// shell 里维护。产品 / 运行单元的静态描述以 contracts/pluginProducts.ts 为
// 唯一来源，本文件只保存可执行 manifest 入口并做逐项契约校验；条目仍按
// capability 依赖顺序排列，避免启动时出现暂缺 provider。

import {
  assertBuiltinPluginRuntimeUnitCatalog,
  getBuiltinPluginRuntimeUnits,
} from "@keymaster/contracts";
import type { PluginManifest } from "@keymaster/contracts";
import {
  COORDINATOR_WORKER_UNIT_CATALOG,
  validateCoordinatorWorkerUnitCatalog,
} from "./coordinator/workerUnitCatalog.js";
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
import { storagePlatformPlugin } from "@keymaster/platform-storage";
import { settingsPlugin } from "@keymaster/plugin-settings";
import { bsv21TokenPlugin } from "@keymaster/plugin-token-bsv21";
import { stasTokenPlugin } from "@keymaster/plugin-token-stas";
import { vaultPlugin } from "@keymaster/plugin-vault";
import { wocPlugin } from "@keymaster/plugin-woc";

const WEB_PLUGIN_CATALOG_SOURCE: readonly PluginManifest[] = [
  storagePlatformPlugin,
  vaultPlugin,
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

/**
 * 应用目录的运行单元契约校验器。
 *
 * 这 25 个产品目前都由页面装配，不能继续让 Host 把“没有 units”解释成
 * 隐式历史实例。这里把每个产品明确落成一个 Window 运行单元；未来某个
 * 产品拆出 Coordinator Worker 单元时，必须在其 manifest 和 contracts 静态
 * 目录中同时声明；没有显式 units 的产品直接拒绝进入 Web 装配。
 */
assertBuiltinPluginRuntimeUnitCatalog();

export function materializeCatalogRuntimeUnit(manifest: PluginManifest): PluginManifest {
  const declarations = getBuiltinPluginRuntimeUnits(manifest.id);
  if (declarations.length === 0) throw new Error(`产品 ${manifest.id} 没有静态运行单元契约`);
  if (manifest.units && manifest.units.length > 0) {
    const actual = manifest.units.map(({ id, runtime, scopeKind }) => ({ id, runtime, scopeKind }));
    const expected = declarations.map(({ unitId, runtime, scopeKind }) => ({ id: unitId, runtime, scopeKind }));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`产品 ${manifest.id} 的 manifest 运行单元与静态契约不一致`);
    }
    const misplaced = [
      ["storage", manifest.storage],
      ["config", manifest.config],
    ] as const;
    if (misplaced.some(([, value]) => value !== undefined)) {
      throw new Error(`产品 ${manifest.id} 的运行期声明必须位于对应 runtime unit`);
    }
    for (const unit of manifest.units) {
      const provided = unit.provides ?? [];
      for (const capability of provided) {
        if (!capability.kind || !capability.id || !capability.version) {
          throw new Error(`产品 ${manifest.id} 的运行单元 ${unit.id} 缺少 capability 契约身份`);
        }
      }
      for (const dependency of unit.dependencies ?? []) {
        if (dependency.source !== "peer" && !dependency.sourceRuntime) {
          throw new Error(`产品 ${manifest.id} 的运行单元 ${unit.id} 存在不完整依赖契约`);
        }
      }
    }
    return manifest;
  }
  throw new Error(`产品 ${manifest.id} 的 manifest 必须显式声明运行单元`);
}

/** 生产 Web 装配清单；每个产品至少有一个显式声明的运行单元。 */
export const WEB_PLUGIN_CATALOG: readonly PluginManifest[] = WEB_PLUGIN_CATALOG_SOURCE.map(materializeCatalogRuntimeUnit);
const workerCatalogErrors = validateCoordinatorWorkerUnitCatalog(COORDINATOR_WORKER_UNIT_CATALOG, WEB_PLUGIN_CATALOG);
if (workerCatalogErrors.length > 0) {
  throw new Error(`Worker 运行单元目录与 manifest 不一致: ${workerCatalogErrors.join("；")}`);
}
