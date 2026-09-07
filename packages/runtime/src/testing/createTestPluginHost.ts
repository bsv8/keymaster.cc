// Runtime 测试夹具：把可执行 setup 显式登记到 implementation registry。
//
// 测试仍可以把 manifest + setup 写在一起，夹具会在交给生产 Adapter 前拆开；
// Adapter 本身不会读取清单中的测试 setup，因此测试不会重新引入生产兼容回退。

import type {
  PluginHost,
  CreatePluginHostOptions,
} from "../pluginHostContract.js";
import { createKeymasterPluginHost } from "../keymasterHostAdapter.js";
import type {
  PluginManifest,
  PluginSetup,
  RuntimeUnitImplementationRegistry,
} from "@keymaster/contracts";

/** 测试源码中的便捷形状；该字段不会进入生产 Adapter。 */
export type TestPluginManifest = PluginManifest & {
  setup?: PluginSetup;
};

export type TestPluginHost = Omit<PluginHost, "register" | "registerAll"> & {
  register(plugin: TestPluginManifest): Promise<void>;
  registerAll(plugins: readonly TestPluginManifest[]): Promise<void>;
};

/** 创建带显式测试实现注册表的 Keymaster Host。 */
export function createTestPluginHost(
  options: CreatePluginHostOptions = {},
): TestPluginHost {
  const setups = new Map<string, PluginSetup>();
  const suppliedRegistry = options.runtimeUnitImplementationRegistry;
  const runtimeUnitImplementationRegistry: RuntimeUnitImplementationRegistry = {
    get(pluginId, unitId) {
      return (suppliedRegistry?.get(pluginId, unitId) as PluginSetup | undefined)
        ?? setups.get(`${pluginId}:${unitId}`)
        ?? setups.get(pluginId);
    },
  };
  const host = createKeymasterPluginHost({
    ...options,
    runtimeUnitImplementationRegistry,
  });

  const stripAndRemember = (plugin: TestPluginManifest): PluginManifest => {
    if (plugin.setup) {
      const units = plugin.units ?? [];
      if (units.length === 0) setups.set(plugin.id, plugin.setup);
      for (const unit of units) setups.set(`${plugin.id}:${unit.id}`, plugin.setup);
    }
    const { setup: _setup, ...manifest } = plugin;
    return manifest;
  };

  return {
    ...host,
    register: (plugin) => host.register(stripAndRemember(plugin)),
    registerAll: (plugins) => host.registerAll(plugins.map(stripAndRemember)),
  };
}
