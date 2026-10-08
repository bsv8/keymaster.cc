// Forum 交易输出布局：reply / changetip / 创世声明的构造与解析。
//
// 输出位置是固定的，所以「哪个 vout 是什么」本身就是协议：
//
//   reply     vout 0  index_price 付款 payto_publickey
//             vout 1  固定 1 sat   kind、parent_txid、parent_publickey、
//                                  reply_masterseedhash、tip_price、operatorSig、
//                                  last_block_height、indexSig、clientpublickey
//             vout 2  父节点生效价 bsv8.tip.1 + parent + 父锁
//
//   changetip vout 0  index_price 付款
//             vout 1  固定 1 sat   kind、parent_txid、tip_price、
//                                  last_block_height、operatorSig、indexSig、
//                                  clientpublickey
//
// 注意：链上脚本里 last_block_height 位于 operatorSig 与 indexSig **之间**，
// 而它在 CBOR 签名数组里是**最后一项**。这个差异是协议的一部分，不是笔误。

import { ProtocolEncodingError, isCanonicalDer, validatePublicKey } from "./bytes.js";
import {
  DATA_OUTPUT_SATOSHIS,
  KIND_CHANGETIP,
  KIND_FORUM,
  KIND_REPLY,
  REQUIRED_OUTPUT_COUNT,
  VOUT_DATA,
  VOUT_INDEX_FEE,
  VOUT_TIP,
  buildDataScript,
  buildLockingScript,
  buildTipScript,
  dataFieldBytes,
  dataFieldHash,
  dataFieldKey,
  dataFieldSignature,
  dataFieldUint,
  encodeMinimalUint,
  parseDataOutput,
  parseLockingScript,
  parseTipOutput,
  requireFieldCount,
  type ParsedLockingScript,
  type TipOutput,
} from "./script.js";
import type { RawTransaction, TxOutput } from "./transaction.js";

export interface ForumInputOutpoint {
  /** 显示顺序。 */
  readonly txid: Uint8Array;
  readonly vout: number;
}

export interface IndexFeeOutput {
  readonly payToPublicKey: Uint8Array;
  readonly indexPrice: bigint;
}

/** vout 0 的索引费付款；收款公钥从锁定脚本自身恢复。 */
export function parseIndexFeeOutput(output: TxOutput): IndexFeeOutput {
  let lock: ParsedLockingScript;
  try {
    lock = parseLockingScript(output.lockingScript);
  } catch (error) {
    throw new ProtocolEncodingError("index_fee_lock", `vout ${VOUT_INDEX_FEE} 不是 <pubkey> OP_CHECKSIG 锁：${String(error)}`);
  }
  return { payToPublicKey: lock.publicKey, indexPrice: output.value };
}

export interface ReplyTransactionFields {
  readonly parentTxid: Uint8Array;
  readonly parentPublicKey: Uint8Array;
  readonly replyMasterSeedHash: Uint8Array;
  readonly tipPrice: bigint;
  readonly operatorSig: Uint8Array;
  readonly lastBlockHeight: bigint;
  readonly indexSig: Uint8Array;
  readonly clientPublicKey: Uint8Array;
  readonly payToPublicKey: Uint8Array;
  readonly indexPrice: bigint;
  readonly tip: TipOutput | undefined;
}

export interface ChangeTipTransactionFields {
  readonly parentTxid: Uint8Array;
  readonly tipPrice: bigint;
  readonly operatorSig: Uint8Array;
  readonly lastBlockHeight: bigint;
  readonly indexSig: Uint8Array;
  readonly clientPublicKey: Uint8Array;
  readonly payToPublicKey: Uint8Array;
  readonly indexPrice: bigint;
}

export interface GenesisTransactionFields {
  readonly forumName: string;
  readonly tipPrice: bigint;
  readonly forumSig: Uint8Array;
  readonly forumPublicKey: Uint8Array;
  readonly payToPublicKey: Uint8Array;
  readonly changeSatoshis: bigint;
  readonly inputs: readonly ForumInputOutpoint[];
}

/**
 * 构造 reply 的输出序列（2 或 3 个，没有找零）。
 *
 * 父价格为零时省略 vout 2；索引费为零仍保留 vout 0，因为固定输出位置不能因为
 * 金额为零而改变。
 */
export function buildReplyOutputs(input: {
  parentTxid: Uint8Array;
  parentPublicKey: Uint8Array;
  replyMasterSeedHash: Uint8Array;
  tipPrice: bigint;
  operatorSig: Uint8Array;
  lastBlockHeight: bigint;
  indexSig: Uint8Array;
  clientPublicKey: Uint8Array;
  payToPublicKey: Uint8Array;
  indexPrice: bigint;
  parentTipPrice: bigint;
}): readonly TxOutput[] {
  assertCanonicalDer(input.operatorSig, "operatorSig");
  assertCanonicalDer(input.indexSig, "indexSig");
  validatePublicKey(input.clientPublicKey);
  validatePublicKey(input.payToPublicKey);
  validatePublicKey(input.parentPublicKey);
  const dataScript = buildDataScript(input.clientPublicKey, KIND_REPLY, [
    input.parentTxid,
    input.parentPublicKey,
    input.replyMasterSeedHash,
    encodeMinimalUint(input.tipPrice),
    input.operatorSig,
    encodeMinimalUint(input.lastBlockHeight),
    input.indexSig,
  ]);
  const outputs: TxOutput[] = [
    { value: input.indexPrice, lockingScript: buildLockingScript(input.payToPublicKey) },
    { value: DATA_OUTPUT_SATOSHIS, lockingScript: dataScript },
  ];
  if (input.parentTipPrice > 0n) {
    outputs.push({
      value: input.parentTipPrice,
      lockingScript: buildTipScript(input.parentPublicKey, input.parentTxid),
    });
  }
  return outputs;
}

/** changetip 恰好两个输出：索引费 + 固定 1 sat 数据输出。 */
export function buildChangeTipOutputs(input: {
  parentTxid: Uint8Array;
  tipPrice: bigint;
  operatorSig: Uint8Array;
  lastBlockHeight: bigint;
  indexSig: Uint8Array;
  clientPublicKey: Uint8Array;
  payToPublicKey: Uint8Array;
  indexPrice: bigint;
}): readonly TxOutput[] {
  assertCanonicalDer(input.operatorSig, "operatorSig");
  assertCanonicalDer(input.indexSig, "indexSig");
  validatePublicKey(input.clientPublicKey);
  validatePublicKey(input.payToPublicKey);
  const dataScript = buildDataScript(input.clientPublicKey, KIND_CHANGETIP, [
    input.parentTxid,
    encodeMinimalUint(input.tipPrice),
    encodeMinimalUint(input.lastBlockHeight),
    input.operatorSig,
    input.indexSig,
  ]);
  return [
    { value: input.indexPrice, lockingScript: buildLockingScript(input.payToPublicKey) },
    { value: DATA_OUTPUT_SATOSHIS, lockingScript: dataScript },
  ];
}

/** 创世声明恰好两个输出：正数找零锁 + 固定 1 sat 数据输出。 */
export function buildGenesisOutputs(input: {
  forumName: string;
  tipPrice: bigint;
  forumSig: Uint8Array;
  forumPublicKey: Uint8Array;
  changeSatoshis: bigint;
}): readonly TxOutput[] {
  assertCanonicalDer(input.forumSig, "forumSig");
  validatePublicKey(input.forumPublicKey);
  if (input.changeSatoshis <= 0n) {
    throw new ProtocolEncodingError("genesis_change", `创世声明的找零输出必须是正数，实际 ${input.changeSatoshis}`);
  }
  const nameBytes = new TextEncoder().encode(input.forumName);
  if (nameBytes.length === 0 || nameBytes.length > 256) {
    throw new ProtocolEncodingError("genesis_name", "forum_name 必须是 1..256 字节");
  }
  const dataScript = buildDataScript(input.forumPublicKey, KIND_FORUM, [
    nameBytes,
    encodeMinimalUint(input.tipPrice),
    input.forumSig,
  ]);
  return [
    { value: input.changeSatoshis, lockingScript: buildLockingScript(input.forumPublicKey) },
    { value: DATA_OUTPUT_SATOSHIS, lockingScript: dataScript },
  ];
}

/** 从 kind 标记嗅探一个 1 sat 输出属于哪种协议交易。 */
export type CandidateKind = "reply" | "changetip" | "forum" | "unknown";

export function sniffDataOutput(output: TxOutput): CandidateKind {
  if (output.value !== DATA_OUTPUT_SATOSHIS) return "unknown";
  let kind: string;
  try {
    kind = parseDataOutput(output.lockingScript).kind;
  } catch {
    return "unknown";
  }
  if (kind === KIND_REPLY) return "reply";
  if (kind === KIND_CHANGETIP) return "changetip";
  if (kind === KIND_FORUM) return "forum";
  return "unknown";
}

export function parseReplyTransaction(tx: RawTransaction): ReplyTransactionFields {
  requireOutputCount(tx, "reply", REQUIRED_OUTPUT_COUNT);
  const fee = parseIndexFeeOutput(tx.outputs[VOUT_INDEX_FEE] as TxOutput);
  const data = parseDataOutput((tx.outputs[VOUT_DATA] as TxOutput).lockingScript);
  if (data.kind !== KIND_REPLY) {
    throw new ProtocolEncodingError("reply_kind", `vout ${VOUT_DATA} 的 kind 是 ${data.kind}，不是 ${KIND_REPLY}`);
  }
  requireFieldCount(data, 9);
  const parentTxid = dataFieldHash(data, 0, "parent_txid");
  const parentPublicKey = dataFieldKey(data, 1, "parent_publickey");
  const replyMasterSeedHash = dataFieldHash(data, 2, "reply_masterseedhash");
  const tipPrice = dataFieldUint(data, 3, "tip_price");
  const operatorSig = dataFieldSignature(data, 4, "operatorSig");
  const lastBlockHeight = dataFieldUint(data, 5, "last_block_height");
  const indexSig = dataFieldSignature(data, 6, "indexSig");
  const tipOutput = tx.outputs[VOUT_TIP];
  const tip = tipOutput === undefined ? undefined : parseTipOutput(tipOutput.lockingScript, tipOutput.value);
  return {
    parentTxid,
    parentPublicKey,
    replyMasterSeedHash,
    tipPrice,
    operatorSig,
    lastBlockHeight,
    indexSig,
    clientPublicKey: data.publicKey,
    payToPublicKey: fee.payToPublicKey,
    indexPrice: fee.indexPrice,
    tip,
  };
}

export function parseChangeTipTransaction(tx: RawTransaction): ChangeTipTransactionFields {
  // changetip 恰好两个输出，多一个就是协议违规。
  if (tx.outputs.length !== 2) {
    throw new ProtocolEncodingError("changetip_outputs", `changetip 必须是 2 个输出，实际 ${tx.outputs.length} 个`);
  }
  const fee = parseIndexFeeOutput(tx.outputs[VOUT_INDEX_FEE] as TxOutput);
  const data = parseDataOutput((tx.outputs[VOUT_DATA] as TxOutput).lockingScript);
  if (data.kind !== KIND_CHANGETIP) {
    throw new ProtocolEncodingError("changetip_kind", `vout ${VOUT_DATA} 的 kind 是 ${data.kind}，不是 ${KIND_CHANGETIP}`);
  }
  requireFieldCount(data, 7);
  return {
    parentTxid: dataFieldHash(data, 0, "parent_txid"),
    tipPrice: dataFieldUint(data, 1, "tip_price"),
    lastBlockHeight: dataFieldUint(data, 2, "last_block_height"),
    operatorSig: dataFieldSignature(data, 3, "operatorSig"),
    indexSig: dataFieldSignature(data, 4, "indexSig"),
    clientPublicKey: data.publicKey,
    payToPublicKey: fee.payToPublicKey,
    indexPrice: fee.indexPrice,
  };
}

export function parseGenesisTransaction(tx: RawTransaction, displayTxidOfInput: (inputIndex: number) => Uint8Array): GenesisTransactionFields {
  if (tx.outputs.length !== 2) {
    throw new ProtocolEncodingError("genesis_outputs", `创世声明必须是 2 个输出，实际 ${tx.outputs.length} 个`);
  }
  const fee = parseIndexFeeOutput(tx.outputs[VOUT_INDEX_FEE] as TxOutput);
  if (fee.indexPrice <= 0n) {
    throw new ProtocolEncodingError("genesis_change", `创世声明的找零输出不能为零，实际 ${fee.indexPrice}`);
  }
  const data = parseDataOutput((tx.outputs[VOUT_DATA] as TxOutput).lockingScript);
  if (data.kind !== KIND_FORUM) {
    throw new ProtocolEncodingError("genesis_kind", `vout ${VOUT_DATA} 的 kind 是 ${data.kind}，不是 ${KIND_FORUM}`);
  }
  requireFieldCount(data, 5);
  const inputs: ForumInputOutpoint[] = tx.inputs.map((_input, index) => ({ txid: displayTxidOfInput(index), vout: tx.inputs[index]!.previousVout }));
  return {
    forumName: new TextDecoder("utf-8", { fatal: true }).decode(dataFieldBytes(data, 0, "forum_name")),
    tipPrice: dataFieldUint(data, 1, "tip_price"),
    forumSig: dataFieldSignature(data, 2, "forumSig"),
    forumPublicKey: data.publicKey,
    payToPublicKey: fee.payToPublicKey,
    changeSatoshis: fee.indexPrice,
    inputs,
  };
}

function requireOutputCount(tx: RawTransaction, label: string, minimum: number): void {
  if (tx.outputs.length < minimum) {
    throw new ProtocolEncodingError("output_count", `${label} 至少需要 ${minimum} 个输出，实际 ${tx.outputs.length} 个`);
  }
}

function assertCanonicalDer(signature: Uint8Array, name: string): void {
  if (!isCanonicalDer(signature)) {
    throw new ProtocolEncodingError("signature_format", `${name} 不是严格 DER low-S 签名`);
  }
}