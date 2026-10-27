// 当前绑定钱包的可用余额投影。资金真值归 UTXO manager。
import { defineCapability } from "webloom-framework";
import type { BsvNetwork } from "./vault.js";
import type { P2pkhBalance } from "./balanceTypes.js";

/** 单一钱包身份的余额；网络是身份标签，不是查询选择器。 */
export interface GlobalBalanceSnapshot {
  /** 小写压缩公钥；空串表示没有可用的解锁身份。 */
  publicKeyHex: string;
  /** 身份不可用时缺省，绝不以 main 冒充已初始化网络。 */
  bsvNetwork?: BsvNetwork;
  /** 当前身份的 manager 可用投影，available=false 表示未知而非零。 */
  balance: P2pkhBalance;
  /** 本实例内容修订号，不是资金锁或链上版本。 */
  revision: number;
}

export interface BalanceBroadcaster {
  /** 同步读取当前投影副本；不联网、不选择网络、不占用资金。 */
  getSnapshot(): GlobalBalanceSnapshot;
  /** 只通知后续变化，不立即回调；返回幂等退订函数。 */
  subscribe(handler: (snapshot: GlobalBalanceSnapshot) => void): () => void;
}

export function emptyGlobalBalanceSnapshot(): GlobalBalanceSnapshot {
  return { publicKeyHex: "", balance: { total: 0, available: false }, revision: 0 };
}

export const BALANCE_BROADCAST_CAPABILITY = defineCapability<BalanceBroadcaster>({
  kind: "local", id: "balance.broadcast", version: "1",
});
