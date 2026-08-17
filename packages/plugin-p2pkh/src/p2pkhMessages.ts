// packages/plugin-p2pkh/src/p2pkhMessages.ts
// P2PKH UI/domain events. Confirmed synchronization is owned by the
// Coordinator task; these events only invalidate local consumers.

/** P2PKH 业务事件类型（messageBus.publish 的 type 字段）。 */
export const P2PKH_MSG = {
  /** Local service status changed. */
  SYNC: "p2pkh.sync",
  /** 资源地址派生完成。 */
  ADDRESS_DERIVED: "p2pkh.address.derived",
  /** rehydrate 失败。 */
  REHYDRATE_ERROR: "p2pkh.rehydrate.error",
  /** 转账广播完成。 */
  TRANSFER_BROADCAST: "p2pkh.transfer.broadcast",
  /**
   * 全局产品设置变更（硬切换 001）。
   * 设计缘由：跨标签页或非 settings 页面需要知道 includeTestnet 切换，
   * 跨 tab 链路交给 messageBus；settings 页同 tab 链路交给
   * `service.onGlobalSettingsChange` 订阅句柄。
   * payload: P2pkhGlobalSettings。
   */
  SETTINGS_CHANGED: "p2pkh.settings.changed"
} as const;

export type P2pkhMessageType = (typeof P2PKH_MSG)[keyof typeof P2PKH_MSG];
