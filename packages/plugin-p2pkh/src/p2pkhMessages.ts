// packages/plugin-p2pkh/src/p2pkhMessages.ts
// P2PKH UI/domain events. Confirmed synchronization is owned by the
// Coordinator task; these events only invalidate local consumers.

/** P2PKH 业务事件类型（messageBus.publish 的 type 字段）。 */
export const P2PKH_MSG = {
  /** 资源地址派生完成。 */
  ADDRESS_DERIVED: "p2pkh.address.derived",
  /** rehydrate 失败。 */
  REHYDRATE_ERROR: "p2pkh.rehydrate.error",
  /** 转账广播完成。 */
  TRANSFER_BROADCAST: "p2pkh.transfer.broadcast",
  /** 全局余额快照发生内容变化。payload 是 GlobalBalanceSnapshot。 */
  BALANCE_CHANGED: "p2pkh.balance.changed",
} as const;

export type P2pkhMessageType = (typeof P2PKH_MSG)[keyof typeof P2PKH_MSG];
