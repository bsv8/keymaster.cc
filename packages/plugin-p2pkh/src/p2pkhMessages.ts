// packages/plugin-p2pkh/src/p2pkhMessages.ts
// P2PKH 消息类型常量（硬切换 001 阶段 5 留口）。
//
// 设计缘由：
//   - P2PKH 暂未 actor 化；本期不要求 P2PKH 走 messageBus.request。
//   - 本文件只放消息类型常量 + payload 形状，为未来 actor 化提供锚点。
//   - 业务插件仍直接调用 P2pkhService，不直接发 p2pkh.sync.* / transfer.* 消息。
//
// 阶段 5 边界（轻量接入）：
//   - BackgroundService 仍按原逻辑调度 recent-sync / history-backfill。
//   - p2pkh.transfer.broadcast 仍走 messageBus.publish 通知业务插件。
//   - 不在本阶段把 P2PKH 改为消息驱动。

/** P2PKH 业务事件类型（messageBus.publish 的 type 字段）。 */
export const P2PKH_MSG = {
  /** recent-sync 状态变更。 */
  SYNC: "p2pkh.sync",
  /** 资源层同步错误（不影响 task 整体状态）。 */
  RECENT_RESOURCE_ERROR: "p2pkh.recent.resource.error",
  /** history 翻页错误。 */
  RECENT_HISTORY_ERROR: "p2pkh.recent.history.error",
  /** backfill 错误。 */
  BACKFILL_ERROR: "p2pkh.backfill.error",
  /** backfill 用户触发。 */
  BACKFILL_REQUESTED: "p2pkh.backfill.requested",
  /** 资源地址派生完成。 */
  ADDRESS_DERIVED: "p2pkh.address.derived",
  /** rehydrate 失败。 */
  REHYDRATE_ERROR: "p2pkh.rehydrate.error",
  /** 转账广播完成。 */
  TRANSFER_BROADCAST: "p2pkh.transfer.broadcast"
} as const;

export type P2pkhMessageType = (typeof P2PKH_MSG)[keyof typeof P2PKH_MSG];
