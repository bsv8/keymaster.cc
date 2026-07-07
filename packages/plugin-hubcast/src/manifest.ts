// packages/plugin-hubcast/src/manifest.ts
// HubCast 广播服务 provider 插件 manifest（施工单 2026-07-06 001 硬切换）。
//
// 设计缘由：
//   - 本插件**只**是 HubCast 服务对应的 provider 适配层；
//   - 在 setup 阶段从 capability bus 拿 `broadcast.provider.registry`
//     （由 plugin-broadcast 在自己 setup 阶段 provide），调
//     `registry.register(createHubCastProvider())` 把自身注册为 provider；
//   - **不**注册路由 / 菜单 / 面包屑（plugin-hubcast 是 provider，不是
//     业务 / 管理页承载方）；
//   - **不**提供业务 broadcast service；业务层走 plugin-broadcast 的
//     `broadcast.core`；
//   - 依赖 `broadcast.provider.registry` 不存在 / 不可用时 fail-closed：
//     这是启动顺序契约——plugin-broadcast 必须在 plugin-hubcast 之前
//     装载；
//   - v1 **不**持久化 active provider id：装配层在合适时机调
//     `registry.setActive("hubcast")`；本插件自己不写持久化。

import type {
  BroadcastProviderRegistry,
  PluginManifest
} from "@keymaster/contracts";
import { BROADCAST_PROVIDER_REGISTRY_CAPABILITY } from "@keymaster/contracts";
import { createHubCastProvider, type HubCastProvider } from "./hubcastProvider.js";

/** plugin-hubcast 平台插件 id。 */
export const HUBCAST_PLUGIN_ID = "hubcast";

/**
 * plugin-hubcast manifest。
 *
 * 装载顺序（apps/web/src/bootstrapPlugins.ts）：
 *   vault → broadcast → hubcast → appmsg → hubmsg → ...
 *
 * plugin-broadcast 在 setup 阶段已经把 `broadcast.provider.registry` 挂
 * 到 capability bus；本插件在 setup 阶段 register 自身。
 */
export const hubcastPlatformPlugin: PluginManifest = {
  id: HUBCAST_PLUGIN_ID,
  name: "HubCast Provider",
  description:
    "HubCast 广播服务 provider 适配层：WSS 连接 + bind + publish / subscription.set / subscription.list + broadcast.received 推送，标准化输出 BroadcastMessage。",
  meta: {
    kind: "platform",
    defaultEnabled: true,
    canDisable: false
  },
  dependencies: [
    {
      capability: BROADCAST_PROVIDER_REGISTRY_CAPABILITY,
      reason:
        "plugin-broadcast 在 setup 阶段 provide broadcast.provider.registry；本插件 register 自身"
    }
  ],
  setup(ctx) {
    const registry = ctx.get<BroadcastProviderRegistry>(
      BROADCAST_PROVIDER_REGISTRY_CAPABILITY
    );
    const provider: HubCastProvider = createHubCastProvider({
      logger: {
        info: (input) => ctx.logger.info(input),
        warn: (input) => ctx.logger.warn(input),
        error: (input) => ctx.logger.error(input)
      }
    });
    ctx.logger.info({
      scope: "hubcast.provider",
      event: "hubcast.provider.register.begin",
      message: "",
      data: { providerId: provider.id }
    });
    registry.register(provider);
    ctx.logger.info({
      scope: "hubcast.provider",
      event: "hubcast.provider.register.done",
      message: "",
      data: { providerId: provider.id }
    });
    return () => {
      ctx.logger.info({
        scope: "hubcast.provider",
        event: "hubcast.provider.unregister.begin",
        message: "",
        data: { providerId: provider.id }
      });
      registry.unregister(provider.id);
      ctx.logger.info({
        scope: "hubcast.provider",
        event: "hubcast.provider.unregister.done",
        message: "",
        data: { providerId: provider.id }
      });
      // 异步 close；不阻塞 teardown 主流程。
      void provider.shutdown();
    };
  }
};