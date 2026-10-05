// The release chooses implementations; static contracts are generated from those manifests.
import { assertBuiltinPluginRuntimeUnitCatalog, getBuiltinPluginRuntimeUnits, type PluginManifest } from "@keymaster/contracts";
import { COORDINATOR_WORKER_UNIT_CATALOG, validateCoordinatorWorkerUnitCatalog } from "./coordinator/workerUnitCatalog.js";
import { WEB_PLUGIN_CATALOG_SOURCE } from "./pluginCatalogSource.js";

/**
 * 应用目录的运行单元契约校验器。
 *
 * 发行版产品目前都由页面装配，不能继续让 Host 把“没有 units”解释成
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
