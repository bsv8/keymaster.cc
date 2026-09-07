// Web Window 运行单元实现注册。
//
// contracts 的产品 / unit 描述只负责回答“有哪些单元以及在哪里运行”；本
// 文件把当前 Web 环境的可执行入口登记到 runtime registry。现有 manifest.setup
// 是历史兼容入口，先由这里集中转成 unit 实现；新插件应直接在环境装配层
// 提供实现，不再把 setup 放进 RuntimeUnitDescriptor。

import type { PluginManifest, RuntimeUnitImplementationRegistry } from "@keymaster/contracts";
import {
  createRuntimeUnitImplementationRegistry,
  type RuntimeUnitImplementation,
} from "@keymaster/runtime";

/**
 * 将旧 product-level setup 绑定到唯一 Window 单元。
 *
 * 这只是迁移适配器，不是第二份产品目录：unitId 直接读取 manifest 的静态
 * 声明，重复或缺失 Window 单元会在生产启动时失败。Worker 不会读取这里的
 * setup，也不会因为 Window 有实现而自动获得同名入口。
 */
export function createWebRuntimeUnitImplementationRegistry(
  manifests: readonly PluginManifest[],
): RuntimeUnitImplementationRegistry {
  const implementations: RuntimeUnitImplementation[] = [];
  for (const manifest of manifests) {
    if (typeof manifest.setup !== "function") continue;
    const declaredUnits = manifest.units ?? [];
    const windowUnits = declaredUnits.filter((unit) => unit.execution === "window");
    const windowUnit = declaredUnits.length === 0
      ? undefined
      : windowUnits.length === 1 ? windowUnits[0] : undefined;
    if (declaredUnits.length > 0 && !windowUnit) {
      throw new Error(`产品 ${manifest.id} 必须声明唯一 Window 运行单元后才能注册 Web 实现`);
    }
    implementations.push({
      pluginId: manifest.id,
      unitId: windowUnit?.id ?? manifest.id,
      setup: manifest.setup,
    });
  }
  return createRuntimeUnitImplementationRegistry(implementations);
}
