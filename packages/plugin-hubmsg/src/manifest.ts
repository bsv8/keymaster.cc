// packages/plugin-hubmsg/src/manifest.ts
// HubMsg 消息服务 provider 插件 manifest（施工单 2026-07-04 001 硬切换）。
//
// 设计缘由：
//   - 本插件**只**是 HubMsg 服务对应的 provider 适配层；
//   - 在 setup 阶段从 capability bus 拿 `message.provider.registry`（由
//     plugin-appmsg 在自己 setup 阶段 provide），调
//     `registry.register(createHubMsgProvider())` 把自身注册为 provider；
//   - **不**注册路由 / 菜单 / 面包屑（plugin-hubmsg 是 provider，不是
//     业务 / 管理页承载方）；
//   - **不**提供业务 message service；业务层走 plugin-appmsg 的 endpoint
//     service；
//   - 依赖 `appmsg.endpoint.registry` 不存在 / 不可用时 fail-closed：这是
//     启动顺序契约——plugin-appmsg 必须在 plugin-hubmsg 之前装载。
//   - 持久化的 `activeProviderId` 在 plugin-appmsg 启动时从 localStorage
//     读出；如果值是 `"hubmsg"`，本 plugin 装载成功后 plugin-appmsg 会把
//     registry.setActive("hubmsg")；本 plugin 自己**不**写持久化。

import type {
  MessageProviderRegistry,
  PluginContext,
  PluginManifest
} from "@keymaster/contracts";
import { MESSAGE_PROVIDER_REGISTRY_CAPABILITY } from "@keymaster/contracts";
import { createHubMsgProvider, type HubMsgProvider } from "./hubmsgProvider.js";

/** plugin-hubmsg 平台插件 id。 */
export const HUBMSG_PLUGIN_ID = "hubmsg";

/**
 * plugin-hubmsg manifest。
 *
 * 装载顺序（apps/web/src/bootstrapPlugins.ts）：
 *   vault → appmsg → hubmsg → protocol → message
 *
 * plugin-appmsg 在 setup 阶段已经把 `message.provider.registry` 挂到
 * capability bus；本插件在 setup 阶段 register 自身。
 */
export const hubmsgPlatformPlugin: PluginManifest = {
  id: HUBMSG_PLUGIN_ID,
  name: "HubMsg Provider",
  description:
    "HubMsg 消息服务 provider 适配层：WSS 连接 + bind + send/list/get/online + message.received 推送，标准化输出 AppMsgMessage。",
  meta: {
    kind: "platform",
    startup: "optional",
    defaultEnabled: true,
    canDisable: false
  },
  dependencies: [
    {
      capability: MESSAGE_PROVIDER_REGISTRY_CAPABILITY,
      reason: "plugin-appmsg 在 setup 阶段 provide message.provider.registry；本插件 register 自身"
    }
  ],
  setup(ctx) {
    const registry = ctx.get<MessageProviderRegistry>(MESSAGE_PROVIDER_REGISTRY_CAPABILITY);
    const provider: HubMsgProvider = createHubMsgProvider({
      logger: {
        info: (input) => ctx.logger.info(input),
        warn: (input) => ctx.logger.warn(input),
        error: (input) => ctx.logger.error(input)
      }
    });
    ctx.logger.info({
      scope: "hubmsg.provider",
      event: "hubmsg.provider.register.begin",
      message: "",
      data: { providerId: provider.id }
    });
    registry.register(provider);
    ctx.logger.info({
      scope: "hubmsg.provider",
      event: "hubmsg.provider.register.done",
      message: "",
      data: { providerId: provider.id }
    });
    return () => {
      ctx.logger.info({
        scope: "hubmsg.provider",
        event: "hubmsg.provider.unregister.begin",
        message: "",
        data: { providerId: provider.id }
      });
      registry.unregister(provider.id);
      ctx.logger.info({
        scope: "hubmsg.provider",
        event: "hubmsg.provider.unregister.done",
        message: "",
        data: { providerId: provider.id }
      });
      // 异步 close；不阻塞 teardown 主流程。
      void provider.shutdown();
    };
  }
};
