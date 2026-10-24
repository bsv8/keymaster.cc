import type { ProtocolSpendInput, ProtocolSpendPrepareInput, ProtocolSpendPreview, ProtocolSpendResult, ProtocolSpendService } from "./protocolSpend.js";

/** Internal wallet Window -> Worker DTO, NOT a Connect method or manager API. */
export type P2pkhProtocolCommand =
  | { type: "prepare" | "presign"; input: ProtocolSpendPrepareInput }
  | { type: "submit" | "release"; input: ProtocolSpendPreview }
  | { type: "release-submission"; input: Parameters<NonNullable<ProtocolSpendService["releasePreparedSubmission"]>>[0] }
  | { type: "funding-plan"; input: { ownerPublicKeyHex: string; network: "main" | "test"; amountSatoshis: number; feeRateSatoshisPerKb: number } };
export type P2pkhProtocolCommandResult =
  | { type: "prepare" | "presign"; value: ProtocolSpendPreview }
  | { type: "submit"; value: ProtocolSpendResult }
  | { type: "release" | "release-submission"; value: { released: true } }
  | { type: "funding-plan"; value: { selected: ProtocolSpendInput[]; totalInputSatoshis: number } };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Protocol RPC requires an object");
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 512): string {
  if (typeof value !== "string" || value.length > max) throw new TypeError("Invalid protocol RPC text");
  return value;
}
function hex(value: unknown, empty = false, max = 8_000_000): string {
  const result = text(value, max);
  if ((!empty && !result.length) || result.length % 2 || !/^[0-9a-f]*$/i.test(result)) throw new TypeError("Invalid protocol RPC hex");
  return result;
}
function number(value: unknown, positive = false): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (positive ? 1 : 0)) throw new TypeError("Invalid protocol RPC integer");
  return value;
}
function scope(value: unknown) {
  const row = record(value);
  if (!/^(02|03)[0-9a-f]{64}$/i.test(text(row.ownerPublicKeyHex))) throw new TypeError("Invalid protocol RPC owner");
  if (row.network !== "main" && row.network !== "test") throw new TypeError("Invalid protocol RPC network");
  return row;
}
function list(value: unknown, check: (item: unknown) => unknown, min = 0) {
  if (!Array.isArray(value) || value.length < min || value.length > 10000) throw new TypeError("Invalid protocol RPC array");
  value.forEach(check);
}
function input(value: unknown) {
  const row = record(value);
  if (hex(row.txid).length !== 64) throw new TypeError("Invalid protocol input txid");
  if (number(row.vout) > 0xffffffff) throw new TypeError("Invalid protocol input vout");
  number(row.value); text(row.address);
  if (row.lockingScriptHex !== undefined) hex(row.lockingScriptHex);
  if (row.previousTransactionHex !== undefined) hex(row.previousTransactionHex);
}
function outputs(value: unknown) {
  list(value, item => { const row = record(item); number(row.value); hex(row.scriptHex, true); if (row.label !== undefined) text(row.label); });
}
function prepare(value: unknown) {
  const row = scope(value);
  list(row.inputs, input, 1); outputs(row.outputs); number(row.feeRateSatoshisPerKb, true);
  if (row.requestingPluginId !== undefined) text(row.requestingPluginId);
  if (row.changeAddress !== undefined) text(row.changeAddress);
  if (row.protocolKind !== undefined && !["refund", "close", "fund", "state"].includes(String(row.protocolKind))) throw new TypeError("Invalid protocol kind");
  if (row.noChangeRule !== undefined) {
    const rule = record(row.noChangeRule); number(rule.maxMinerFeeSatoshis);
    if (rule.allowZeroValueOutputs !== undefined && typeof rule.allowZeroValueOutputs !== "boolean") throw new TypeError("Invalid protocol fee rule");
  }
}
function preview(value: unknown) {
  const row = scope(value);
  list(row.inputs, input, 1); outputs(row.outputs);
  number(row.changeSatoshis); number(row.estimatedFeeSatoshis); number(row.serializedSizeBytes, true);
  if (hex(row.txid, true).length !== 64 && row.txid !== "") throw new TypeError("Invalid protocol preview txid");
  hex(row.rawTxHex);
  for (const key of ["requestingPluginId", "previewId", "submissionId", "managerAllocationId", "changeAddress"]) if (row[key] !== undefined) text(row[key]);
  for (const key of ["protectedClaimIds", "inputClaimIds"]) if (row[key] !== undefined) list(row[key], item => text(item));
  if (row.utxoSeq !== undefined) number(row.utxoSeq);
  if (row.utxoBinding !== undefined) { const binding = record(row.utxoBinding); text(binding.resourceId); number(binding.seq); }
}
export function parseP2pkhProtocolCommand(value: unknown): P2pkhProtocolCommand {
  const row = record(value);
  switch (row.type) {
    case "prepare": case "presign": prepare(row.input); break;
    case "submit": case "release": preview(row.input); break;
    case "release-submission": { const body = scope(row.input); text(body.submissionId); if (hex(body.txid).length !== 64) throw new TypeError("Invalid protocol release txid"); break; }
    case "funding-plan": { const body = scope(row.input); number(body.amountSatoshis, true); number(body.feeRateSatoshisPerKb, true); break; }
    default: throw new TypeError("Unsupported protocol RPC command");
  }
  return structuredClone(row) as P2pkhProtocolCommand;
}
export function parseP2pkhProtocolCommandResult(value: unknown): P2pkhProtocolCommandResult {
  const row = record(value);
  switch (row.type) {
    case "prepare": case "presign": preview(row.value); break;
    case "submit": {
      const result = record(row.value);
      if (!["broadcast-pending-woc", "woc-observed-unconfirmed", "woc-confirmed", "woc-dropped", "rejected", "unknown", "provider-inconsistent"].includes(String(result.status))) throw new TypeError("Invalid protocol result status");
      if (hex(result.txid).length !== 64) throw new TypeError("Invalid protocol result txid");
      hex(result.rawTxHex);
      for (const key of ["submissionId", "canonicalTxid", "error", "droppedReason", "providerReturnedTxidRaw", "providerReturnedTxidNormalized", "txidIntegrity", "observation"]) if (result[key] !== undefined) text(result[key], 65536);
      if (result.inputClaimIds !== undefined) list(result.inputClaimIds, item => text(item));
      break;
    }
    case "release": case "release-submission": if (record(row.value).released !== true) throw new TypeError("Invalid protocol release result"); break;
    case "funding-plan": { const body = record(row.value); list(body.selected, input, 1); number(body.totalInputSatoshis, true); break; }
    default: throw new TypeError("Unsupported protocol RPC result");
  }
  return structuredClone(row) as P2pkhProtocolCommandResult;
}
