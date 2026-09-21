// packages/contracts/src/balance.ts
// 全局余额广播契约。
// 余额广播是 Worker UTXO 快照在窗口内的只读投影，不落盘，也不替代 UTXO 真值。

import { defineCapability } from "webloom-framework";
import type { BsvNetwork } from "./vault.js";
import type { P2pkhBalance } from "./balanceTypes.js";

/** 余额广播网络键：固定为 mainnet/testnet，避免把内部网络名暴露给消费方。 */
export type BalanceNetworkKey = "mainnet" | "testnet";

/** 内部网络到广播网络键的唯一映射。 */
export const BALANCE_NETWORK_KEYS: Record<BsvNetwork, BalanceNetworkKey> = {
  main: "mainnet",
  test: "testnet",
};

/** 全局余额快照；余额显示和转账参考值都只消费此形态。 */
export interface GlobalBalanceSnapshot {
  /** 快照归属 owner：小写压缩公钥 hex；空串表示无 active key。 */
  publicKeyHex: string;
  /** 生成快照时的 testnet 开关；消费方以此值为准。 */
  includeTestnet: boolean;
  /** 网络余额表；testnet 仅在 includeTestnet=true 时出现。 */
  balances: Partial<Record<BalanceNetworkKey, P2pkhBalance>>;
  /** 窗口内单调递增版本；只有快照内容变化时才递增。 */
  revision: number;
}

/** 窗口内单例余额广播能力；读取不会发起网络请求。 */
export interface BalanceBroadcaster {
  /** 同步读取最新余额快照。 */
  getSnapshot(): GlobalBalanceSnapshot;
  /** 订阅快照变更；返回取消订阅函数。 */
  subscribe(handler: (snapshot: GlobalBalanceSnapshot) => void): () => void;
}

/** 无 active key、锁屏或插件尚未准备好时使用的空快照。 */
export function emptyGlobalBalanceSnapshot(): GlobalBalanceSnapshot {
  return {
    publicKeyHex: "",
    includeTestnet: false,
    balances: {},
    revision: 0,
  };
}

/** 全局余额广播 capability。 */
export const BALANCE_BROADCAST_CAPABILITY = defineCapability<BalanceBroadcaster>({
  kind: "local",
  id: "balance.broadcast",
  version: "1",
});
