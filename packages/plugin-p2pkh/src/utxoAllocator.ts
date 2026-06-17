// packages/plugin-p2pkh/src/utxoAllocator.ts
// UTXO 选择（硬切换 001）：
//   - 输入集合 = 当前 WOC 未花费 UTXO - 本地 reservation；service 已
//     在传入前完成 reservation 过滤。
//   - 不再区分 confirmed / unconfirmed：所有未 reserved 的候选都可参与。
//   - 失败原因收敛为 no-utxos / insufficient / policy-denied。
// 设计缘由：让 transfer 页面只看到错误，不自己重新计算。

import type {
  P2pkhUtxo,
  UtxoAllocation,
  UtxoAllocationError,
  UtxoAllocationRequest
} from "./p2pkhContracts.js";

export type { UtxoAllocationError, UtxoAllocation, UtxoAllocationRequest, P2pkhUtxo } from "./p2pkhContracts.js";

export type AllocateOk = { ok: true; allocation: UtxoAllocation };
export type AllocateErr = { ok: false; error: UtxoAllocationError };
export type AllocateResult = AllocateOk | AllocateErr;

/** P2PKH 分配错误。抛错给 UI 显示。 */
export class P2pkhAllocationError extends Error {
  readonly info: UtxoAllocationError;
  constructor(info: UtxoAllocationError) {
    super(`P2PKH allocation failed: ${info.reason}`);
    this.info = info;
  }
}

export function allocateUtxos(
  utxos: P2pkhUtxo[],
  request: UtxoAllocationRequest
): AllocateResult {
  if (request.amountSatoshis <= 0) {
    return { ok: false, error: { required: request.amountSatoshis, available: 0, feeReserve: 0, reason: "policy-denied" } };
  }
  const feeReserve = request.feeReserveSatoshis ?? 0;
  // 硬切换 001：service 已按 reservation.state === "reserved" 过滤过；
  // 候选集合就是所有可花费的未花费 UTXO。allocator 不再关心 confirmed/unconfirmed。
  const candidates = utxos;
  const available = candidates.reduce((s, u) => s + u.value, 0);
  const required = request.amountSatoshis + feeReserve;
  if (candidates.length === 0) {
    return { ok: false, error: { required, available, feeReserve, reason: "no-utxos" } };
  }
  if (available < required) {
    return { ok: false, error: { required, available, feeReserve, reason: "insufficient" } };
  }

  const sorted = [...candidates].sort((a, b) => {
    if (request.strategy === "largest-first") return b.value - a.value;
    return a.value - b.value; // smallest-first default
  });

  const selected: P2pkhUtxo[] = [];
  let total = 0;
  for (const u of sorted) {
    selected.push(u);
    total += u.value;
    if (total >= required) break;
  }
  return {
    ok: true,
    allocation: {
      requestedSatoshis: request.amountSatoshis,
      feeReserveSatoshis: feeReserve,
      selected,
      totalInputSatoshis: total,
      changeSatoshis: total - required
    }
  };
}
