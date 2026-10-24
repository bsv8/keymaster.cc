import { Transaction, UnlockingScript, LockingScript } from "@bsv/sdk";
import { MultisigPoolEngine, parseFundingOutput, type PoolPublicKeys } from "go-bitfs";

/** 用 SDK 的规范退款构造器估算池内结算矿工费。
 * 探针仅用于本地金额计算，不签名、不持久化、不广播；同一池最终只花费一次，
 * 正常关池和仲裁不能被当成两笔必付手续费相加。 */
export async function bitfsPoolSettlementFee(keys: PoolPublicKeys, feeRate: bigint): Promise<bigint> {
  if (feeRate < 1n || feeRate > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("费用池矿工费率无效");
  const engine = new MultisigPoolEngine(keys);
  const probeAmount = 1_000_000_000_000;
  const funding = new Transaction();
  funding.addInput({ sourceTXID: "01".repeat(32), sourceOutputIndex: 0, unlockingScript: new UnlockingScript(), sequence: 0xffffffff });
  funding.addOutput({ satoshis: probeAmount, lockingScript: LockingScript.fromHex(toHex(engine.lockingScript())) });
  const refund = await engine.buildOpeningState(Uint8Array.from(funding.toBinary()), probeAmount, 900_000, Number(feeRate));
  return BigInt(probeAmount) - parseFundingOutput(refund, 0).satoshis;
}

function toHex(bytes: Uint8Array): string { return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join(""); }

/**
 * 池内余量的内容预算分配。
 *
 * 中文说明：池里还剩的块按**剩余卖家数**均分（余数给最后一个卖家 ✓），每位
 * 卖家另付自己的开池 Seed 预算（已开好的 Seed 不重复付 ✓）。不默认限制为
 * “Seed 加一块”——那会把大文件的内容预算压到远低于实际需求 ✓。
 */
export function allocateBitfsRemainingContent(input: {
  remainingBlocks: number;
  remainingSellers: number;
  seedCompleted: boolean;
  seedPrice: bigint;
  blockPrice: bigint;
}): { assignedCount: number; seedBudget: bigint; blockBudget: bigint; contentBudget: bigint } {
  if (!Number.isSafeInteger(input.remainingBlocks) || input.remainingBlocks < 0) throw new Error("remaining blocks must be a non-negative integer");
  if (!Number.isSafeInteger(input.remainingSellers) || input.remainingSellers <= 0) throw new Error("remaining sellers must be a positive integer");
  if (input.seedPrice < 0n || input.blockPrice < 0n) throw new Error("prices must not be negative");
  const perSeller = Math.ceil(input.remainingBlocks / input.remainingSellers);
  const assignedCount = Math.min(input.remainingBlocks, perSeller);
  const seedBudget = input.seedCompleted ? 0n : input.seedPrice;
  const blockBudget = BigInt(assignedCount) * input.blockPrice;
  return { assignedCount, seedBudget, blockBudget, contentBudget: seedBudget + blockBudget };
}
