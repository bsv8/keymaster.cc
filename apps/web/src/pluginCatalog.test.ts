import { describe, expect, it } from "vitest";
import { getBuiltinPluginRuntimeUnits, validateBuiltinPluginRuntimeUnitCatalog } from "@keymaster/contracts";
import { WEB_PLUGIN_CATALOG } from "./pluginCatalog.js";

describe("Web plugin catalog runtime units", () => {
  it("静态产品运行单元目录覆盖全部 25 个产品", () => {
    expect(validateBuiltinPluginRuntimeUnitCatalog()).toEqual([]);
  });

  it("为全部产品提供静态声明的运行单元，并保留真实 Worker 单元", () => {
    expect(WEB_PLUGIN_CATALOG).toHaveLength(25);
    for (const manifest of WEB_PLUGIN_CATALOG) {
      const expected = getBuiltinPluginRuntimeUnits(manifest.id);
      expect(manifest.units).toHaveLength(expected.length);
      expect(manifest.units?.map(({ id, runtime, scopeKind }) => ({ id, runtime, scopeKind }))).toEqual(expected.map(({ unitId, runtime, scopeKind }) => ({ id: unitId, runtime, scopeKind })));
      expect(manifest.units?.[0]).toMatchObject({
        id: `${manifest.id}.window`,
        runtime: "window-main",
      });
    }
  });

  it("Worker 任务对应的产品同时声明 Window 与 Coordinator Worker 单元", () => {
    for (const productId of ["contacts", "p2pkh", "token-bsv21", "token-stas", "collectible-1satordinals"]) {
      expect(WEB_PLUGIN_CATALOG.find((manifest) => manifest.id === productId)?.units).toEqual(expect.arrayContaining([
        expect.objectContaining({ runtime: "window-main" }),
        expect.objectContaining({ runtime: "shared-worker", scopeKind: "owner-session" }),
      ]));
    }
  });

  it("所有显式运行单元自带依赖，产品级不再保留运行期 fallback", () => {
    for (const manifest of WEB_PLUGIN_CATALOG) {
      expect(manifest.storage).toBeUndefined();
      expect(manifest.config).toBeUndefined();
      for (const unit of manifest.units ?? []) {
        expect(unit.scopeKind).toBeDefined();
        for (const dependency of unit.dependencies ?? []) {
          expect(dependency.capability.version).toBeDefined();
          expect(dependency.sourceRuntime).toBeDefined();
        }
      }
    }
  });
});
