// packages/plugin-p2pkh/src/utxoAllocator.ts
// UTXO 选择：默认只使用 confirmed UTXO；allowUnconfirmed 必须由调用方显式开启。
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

const DEFAULT_FEE_RESERVE = 1000;

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
  const feeReserve = request.feeReserveSatoshis ?? DEFAULT_FEE_RESERVE;
  const candidates = utxos.filter((u) =>
    request.allowUnconfirmed ? true : u.status === "confirmed"
  );
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
