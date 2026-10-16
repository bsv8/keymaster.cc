/** 交易大小由实际输入数和输出脚本确定；P2PKH 解锁脚本按 SDK 的 108 字节上界预算。 */
function compactSizeLength(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Invalid transaction count");
  return value < 253 ? 1n : value <= 0xffff ? 3n : value <= 0xffff_ffff ? 5n : 9n;
}
export function estimateBitfsFundingFee(inputCount: number, outputScriptBytes: readonly number[], rate: number): bigint {
  if (inputCount < 1 || !Number.isSafeInteger(rate) || rate < 1) throw new TypeError("Invalid funding fee inputs");
  let bytes = 8n + compactSizeLength(inputCount) + compactSizeLength(outputScriptBytes.length) + BigInt(inputCount) * 149n;
  for (const length of outputScriptBytes) bytes += 8n + compactSizeLength(length) + BigInt(length);
  return (bytes * BigInt(rate) + 999n) / 1000n;
}
/** 输入逐个增加，每次重算费用，避免把手续费保护上限误当预计支出。 */
export function selectBitfsFundingInputs<T extends { txid: string; vout: number; valueSatoshis: string }>(
  candidates: readonly T[], amount: bigint, scripts: readonly number[], rate: number, maximumFee: number,
): { selected: T[]; feeSatoshis: bigint } | undefined {
  const sorted = [...candidates].sort((a, b) => BigInt(a.valueSatoshis) === BigInt(b.valueSatoshis)
    ? `${a.txid}:${a.vout}`.localeCompare(`${b.txid}:${b.vout}`) : BigInt(a.valueSatoshis) > BigInt(b.valueSatoshis) ? -1 : 1);
  const selected: T[] = [];
  let total = 0n;
  for (const item of sorted) {
    selected.push(item); total += BigInt(item.valueSatoshis);
    const feeSatoshis = estimateBitfsFundingFee(selected.length, scripts, rate);
    if (feeSatoshis > BigInt(maximumFee)) throw new Error("预计矿工费超过手续费保护上限");
    if (total >= amount + feeSatoshis) return { selected, feeSatoshis };
  }
  return undefined;
}
