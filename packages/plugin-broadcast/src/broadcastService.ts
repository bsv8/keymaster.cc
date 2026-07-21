// packages/plugin-broadcast/src/broadcastService.ts
// 广播系统管理页 service（施工单 2026-07-08 001）。
//
// 设计缘由：
//   - 直接消费 `BroadcastCore`（不接触 wire / handle）；
//   - 提供管理页需要的查询 / 切换接口；
//   - **不**接触业务协议层（pricecast.bsv_price.v1 等）；
//   - **不**持久化订阅；订阅走 core 自身的 union。

import type {
  BroadcastCore,
  BroadcastCoreSnapshot,
  BroadcastProvider
} from "@keymaster/contracts";

/**
 * 广播系统管理页 service。
 *
 * 关键约束：
 *   - 全部接口同步走 core；不发起任何额外 IO；
 *   - `setActiveProvider` 不等待 rebind 完成（fire-and-forget）；
 *   - 内部订阅 `core.onStateChange`，让 UI 拿到同步刷新。
 */
export interface BroadcastService {
  /**
   * 当前完整 snapshot（同步）。
   */
  snapshot(): BroadcastCoreSnapshot;
  /**
   * 列出已注册 provider（同步）。
   */
  providers(): readonly BroadcastProvider[];
  /**
   * 切换 active provider。
   *
   * 语义与 `BroadcastCore.setActiveProviderId` 一致；本方法只是
   * service 层的薄包装（让管理页不直接持有 core 引用）。
   *
   * @param providerId `null` = 显式清空。
   */
  setActiveProvider(providerId: string | null): Promise<void>;
  /**
   * 订阅 core 状态变化。
   *
   * 每次核心 state / active provider / union 变化都触发；UI 据此调
   * `snapshot()` 刷新。
   */
  onBroadcastConnectionStateChanged(handler: () => void): () => void;
}

export function createBroadcastService(core: BroadcastCore): BroadcastService {
  // 服务表面"setActiveProvider"接口；core 实际只暴露 setActiveProviderId。
  // 这里直接落到 core.setActiveProviderId（core 已实现）。
  const coreWithOps = core as BroadcastCore & {
    setActiveProviderId(providerId: string | null): Promise<void>;
  };
  return {
    snapshot: () => core.inspect(),
    providers: () => core.providers().list(),
    setActiveProvider: (id) => coreWithOps.setActiveProviderId(id),
    onBroadcastConnectionStateChanged: (handler) => core.onConnectionStateChanged(handler)
  };
}
