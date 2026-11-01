import type { Command } from "keymaster-trade-scheduler";
import { blockPriceSatoshis } from "bitfs-protocol";

/** 把协议规定的尾块费用作为事实注入策略器，不在宿主另定价格策略。 */
export function schedulerTailPrice(fullBlockPrice: string, fileSize: string): string | undefined {
  const tail = BigInt(fileSize) % 262_144n;
  return tail === 0n ? undefined : blockPriceSatoshis(BigInt(fullBlockPrice), tail).toString(10);
}

/** 开池使用调度命令冻结的金额与计件预算，不重新按一个内容项报价。 */
export function schedulerOpeningBudget(command: Extract<Command, { type: "open" }>) {
  return {
    amount: BigInt(command.amount),
    arbitrationReserve: BigInt(command.reserve) - BigInt(command.quote.fees.settlement),
    arbitrationItemCount: Math.max(1, command.blockCapacity),
  };
}

/** 专款账本的 expectedOutputs 仅包含买方回款。
 * committed 已在交付时计入内容支出，closed.spent 只能再计剩余费用。
 * 真实开池金额不符或负费用均留作 unknown，不能伪造结清。 */
export function schedulerCloseAmounts(input: {
  amount: bigint; openingAmount: bigint; returned: bigint; committed: bigint;
}): { returned: string; spent: string } | undefined {
  const spent = input.openingAmount - input.returned - input.committed;
  if (input.amount !== input.openingAmount || input.returned < 0n || spent < 0n) return undefined;
  return { returned: input.returned.toString(10), spent: spent.toString(10) };
}
