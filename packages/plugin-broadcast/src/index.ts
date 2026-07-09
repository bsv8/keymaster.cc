// packages/plugin-broadcast/src/index.ts
// 广播子系统平台插件入口（施工单 2026-07-06 001 硬切换）。
//
//   - 唯一对外入口：`broadcastPlatformPlugin`；
//   - 工厂：`BroadcastCoreImpl.create(...)` 给测试 / 高级场景使用；
//   - 不导出 wire 类型（`HubCastConnection` 等）：这些仅在 plugin-hubcast
//     内部使用；
//   - **不**导出 `appmsg` 相关类型——本插件与 appmsg 系统硬隔离。

export {
  broadcastPlatformPlugin,
  BROADCAST_PLUGIN_ID
} from "./manifest.js";
export {
  BroadcastCoreImpl,
  type BroadcastCoreConfig,
  type BroadcastSignerContext,
  type StorageLike
} from "./broadcastCore.js";
export {
  createReconnectCoordinator,
  type ReconnectLogger,
  type CreateReconnectCoordinatorInput
} from "./reconnectCoordinator.js";
export {
  createBroadcastService,
  type BroadcastService
} from "./broadcastService.js";
export { BroadcastPage } from "./BroadcastPage.js";
export type {
  BroadcastCore,
  BroadcastCoreOps,
  BroadcastProvider,
  BroadcastProviderHandle,
  BroadcastProviderOperations,
  BroadcastProviderRegistry,
  BroadcastProviderSigner,
  BroadcastMessage,
  BroadcastPublishInput,
  BroadcastSubscribeInput,
  BroadcastUnsubscribe,
  BroadcastCoreSnapshot,
  BroadcastCoreState,
  BroadcastConnectOutcome,
  ActiveBroadcastProviderSnapshot,
  BroadcastProviderHealth,
  ProviderPublishInput,
  ProviderReplaceSubscriptionsInput,
  ProviderListSubscriptionsResult,
  ProviderBroadcastEvent,
  HubCastEnvelopeV1,
  SignedHubCastEnvelopeV1
} from "@keymaster/contracts";