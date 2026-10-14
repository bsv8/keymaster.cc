/**
 * 新池到期高度只在开池时计算一次，再交由 go-bitfs 固定进退款模板。
 * 必须使用节点提供的真实链高度；不得用时钟推算，也不得越过时间戳解释阈值。
 */
export function deriveBitfsPoolRefundLockHeight(currentBlockHeight: number, refundDelayBlocks: number): number {
  if (!Number.isSafeInteger(currentBlockHeight) || currentBlockHeight <= 0) {
    throw new TypeError("BitFS 开池需要有效的当前区块高度");
  }
  if (!Number.isSafeInteger(refundDelayBlocks) || refundDelayBlocks <= 0) {
    throw new TypeError("BitFS 费用池退款等待区块数必须是正整数");
  }
  const lockHeight = currentBlockHeight + refundDelayBlocks;
  if (!Number.isSafeInteger(lockHeight) || lockHeight >= 500_000_000) {
    throw new TypeError("BitFS 费用池到期高度超出区块高度锁范围");
  }
  return lockHeight;
}

/** 卖方按预签时的链高度检查剩余窗口；等于下限可接受，低于下限拒绝。 */
export function assertBitfsSellerRefundWindow(lockHeight: number, currentBlockHeight: number, minRefundDelayBlocks: number): void {
  const earliestAcceptedHeight = deriveBitfsPoolRefundLockHeight(currentBlockHeight, minRefundDelayBlocks);
  if (!Number.isSafeInteger(lockHeight) || lockHeight >= 500_000_000 || lockHeight < earliestAcceptedHeight) {
    throw new Error("BitFS 买方费用池退款剩余区块数低于卖方下限，拒绝开池");
  }
}
