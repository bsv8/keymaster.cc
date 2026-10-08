// Forum 需要的最小 BSV 交易序列化与解析。
//
// 与服务端 `internal/bsv/transaction.go` 逐条对齐：varint、拒绝尾随字节、
// 输入 prevout txid 用的是反向内部字节序、txid 是 raw 的双 SHA-256 再反转。
//
// 另外实现 BSV FORKID 输入签名摘要（`ForkIDSighash`）。摘要里的 scriptCode
// 必须是被花费输出的完整锁定脚本：P2PKH 是完整公钥哈希脚本，Forum 自有的
// data/tip 输出是带全部 OP_DROP 前缀的完整数据脚本。剥掉前缀再签，链上会拒绝。

import { HASH_BYTES, ProtocolEncodingError, concatBytes, displayToRawTxid, rawTxidToDisplay } from "./bytes.js";

export const MAX_TRANSACTION_BYTES = 1 << 20;
export const MAX_INPUTS = 100_000;
export const MAX_OUTPUTS = 100_000;

export const SIGHASH_TYPE_ALL = 0x01;
export const SIGHASH_FORK_ID = 0x40;
export const SIGHASH_ALL_FORK_ID = SIGHASH_TYPE_ALL | SIGHASH_FORK_ID;

export interface TxInput {
  /** 反向内部字节序。 */
  readonly previousTxid: Uint8Array;
  readonly previousVout: number;
  readonly scriptSig: Uint8Array;
  readonly sequence: number;
}

export interface TxOutput {
  readonly value: bigint;
  readonly lockingScript: Uint8Array;
}

export interface RawTransaction {
  readonly version: number;
  readonly inputs: readonly TxInput[];
  readonly outputs: readonly TxOutput[];
  readonly locktime: number;
  /** 计算 txid 所依据的精确序列化字节。 */
  readonly raw: Uint8Array;
  /** 显示顺序 txid。 */
  readonly txid: Uint8Array;
}

/** varint 编码；按 Bitcoin 的 0xfd/0xfe/0xff 分界。 */
export function appendVarInt(dst: Uint8Array, value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new ProtocolEncodingError("varint", `varint 需要非负安全整数，实际 ${value}`);
  if (value < 0xfd) return concatBytes(dst, Uint8Array.of(value));
  if (value <= 0xffff) return concatBytes(dst, Uint8Array.of(0xfd, value & 0xff, (value >> 8) & 0xff));
  if (value <= 0xffffffff) {
    return concatBytes(
      dst,
      Uint8Array.of(0xfe, value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff),
    );
  }
  const wide = BigInt(value);
  const out = new Uint8Array(9);
  out[0] = 0xff;
  for (let index = 0; index < 8; index += 1) out[8 - index] = Number((wide >> BigInt(index * 8)) & 0xffn);
  return concatBytes(dst, out);
}

function uint32LE(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function uint64LE(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  for (let index = 0; index < 8; index += 1) out[index] = Number((value >> BigInt(index * 8)) & 0xffn);
  return out;
}

export function serializeTransaction(tx: {
  version: number;
  inputs: readonly TxInput[];
  outputs: readonly TxOutput[];
  locktime: number;
}): Uint8Array {
  let out = uint32LE(tx.version);
  out = appendVarInt(out, tx.inputs.length);
  for (const input of tx.inputs) {
    if (input.previousTxid.length !== HASH_BYTES) {
      throw new ProtocolEncodingError("input_txid", `输入的 prevout txid 必须是 ${HASH_BYTES} 字节`);
    }
    out = concatBytes(out, input.previousTxid, uint32LE(input.previousVout));
    out = appendVarInt(out, input.scriptSig.length);
    out = concatBytes(out, input.scriptSig, uint32LE(input.sequence));
  }
  out = appendVarInt(out, tx.outputs.length);
  for (const output of tx.outputs) {
    out = concatBytes(out, uint64LE(output.value));
    out = appendVarInt(out, output.lockingScript.length);
    out = concatBytes(out, output.lockingScript);
  }
  return concatBytes(out, uint32LE(tx.locktime));
}

class ByteReader {
  offset = 0;

  constructor(private readonly data: Uint8Array) {}

  remaining(): number {
    return this.data.length - this.offset;
  }

  need(count: number): Uint8Array {
    if (count < 0 || this.offset + count > this.data.length) {
      throw new ProtocolEncodingError("tx_truncated", "raw 交易被截断");
    }
    const slice = this.data.subarray(this.offset, this.offset + count);
    this.offset += count;
    return slice;
  }

  uint32(): number {
    const raw = this.need(4);
    // 无符号读取：JS 的按位运算会走有符号 32 位，所以用乘法而不是 >>>。
    return raw[0]! + raw[1]! * 0x100 + raw[2]! * 0x10000 + raw[3]! * 0x1000000;
  }

  uint64(): bigint {
    // Bitcoin 的 64 位金额是小端；用乘法累加而不是按位运算，避免 JS 的
    // 32 位有符号整数把高位截掉。
    const raw = this.need(8);
    let value = 0n;
    let scale = 1n;
    for (const byte of raw) {
      value += BigInt(byte) * scale;
      scale <<= 8n;
    }
    return value;
  }

  varint(): number {
    const initial = this.need(1)[0]!;
    if (initial < 0xfd) return initial;
    if (initial === 0xfd) {
      const raw = this.need(2);
      return raw[0]! + raw[1]! * 0x100;
    }
    if (initial === 0xfe) {
      const raw = this.need(4);
      return raw[0]! + raw[1]! * 0x100 + raw[2]! * 0x10000 + raw[3]! * 0x1000000;
    }
    let value = 0n;
    for (const byte of this.need(8)) value = (value << 8n) | BigInt(byte);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ProtocolEncodingError("varint_range", "varint 超出安全整数");
    return Number(value);
  }
}

/** 解析 raw 交易；尾随字节拒绝，txid 由 raw 自身算出。 */
export function parseTransaction(raw: Uint8Array, sha256: (data: Uint8Array) => Uint8Array): RawTransaction {
  if (raw.length === 0) throw new ProtocolEncodingError("tx_empty", "raw 交易不能为空");
  if (raw.length > MAX_TRANSACTION_BYTES) {
    throw new ProtocolEncodingError("tx_too_large", `raw 交易 ${raw.length} 字节超过 ${MAX_TRANSACTION_BYTES} 字节上限`);
  }
  const reader = new ByteReader(raw);
  const version = reader.uint32();
  const inputCount = reader.varint();
  if (inputCount > MAX_INPUTS) throw new ProtocolEncodingError("tx_inputs", `交易不能有 ${inputCount} 个输入`);
  const inputs: TxInput[] = [];
  for (let index = 0; index < inputCount; index += 1) {
    const previousTxid = reader.need(HASH_BYTES).slice();
    const previousVout = reader.uint32();
    const scriptLength = reader.varint();
    const scriptSig = reader.need(scriptLength).slice();
    const sequence = reader.uint32();
    inputs.push({ previousTxid, previousVout, scriptSig, sequence });
  }
  const outputCount = reader.varint();
  if (outputCount > MAX_OUTPUTS) throw new ProtocolEncodingError("tx_outputs", `交易不能有 ${outputCount} 个输出`);
  const outputs: TxOutput[] = [];
  for (let index = 0; index < outputCount; index += 1) {
    const value = reader.uint64();
    const scriptLength = reader.varint();
    if (scriptLength > MAX_TRANSACTION_BYTES) throw new ProtocolEncodingError("tx_script", `锁定脚本 ${scriptLength} 字节超过上限`);
    outputs.push({ value, lockingScript: reader.need(scriptLength).slice() });
  }
  const locktime = reader.uint32();
  if (reader.remaining() !== 0) {
    throw new ProtocolEncodingError("tx_trailing", `raw 交易之后尾随 ${reader.remaining()} 个字节`);
  }
  return { version, inputs, outputs, locktime, raw: raw.slice(), txid: txidOfRaw(raw, sha256) };
}

/** raw 交易的显示顺序 txid：双 SHA-256 再反转。 */
export function txidOfRaw(raw: Uint8Array, sha256: (data: Uint8Array) => Uint8Array): Uint8Array {
  return rawTxidToDisplay(doubleSha256(raw, sha256));
}

export function doubleSha256(data: Uint8Array, sha256: (data: Uint8Array) => Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

/** 输入 outpoint 的显示顺序 txid。 */
export function inputOutpointTxid(input: TxInput): Uint8Array {
  return rawTxidToDisplay(input.previousTxid);
}

export function inputOutpointBytes(input: TxInput): Uint8Array {
  return displayToRawTxid(inputOutpointTxid(input));
}

/**
 * BSV FORKID 输入签名摘要。
 *
 * 覆盖 version、全部 prevout 摘要、sequence 摘要、全部输出摘要、被花费的
 * outpoint、scriptCode、金额、sequence、locktime 和四字节 hashType。
 */
export function forkIdSighash(
  tx: RawTransaction,
  inputIndex: number,
  prevoutScript: Uint8Array,
  prevoutValue: bigint,
  sha256: (data: Uint8Array) => Uint8Array,
  hashType: number = SIGHASH_ALL_FORK_ID,
): Uint8Array {
  if (inputIndex < 0 || inputIndex >= tx.inputs.length) {
    throw new ProtocolEncodingError("sighash_input", `交易只有 ${tx.inputs.length} 个输入，没有第 ${inputIndex} 个`);
  }
  if (prevoutScript.length === 0) {
    throw new ProtocolEncodingError("sighash_script", "sighash 需要被花费输出的脚本");
  }
  if (hashType !== SIGHASH_ALL_FORK_ID) {
    throw new ProtocolEncodingError("sighash_type", `只支持 SIGHASH_ALL|SIGHASH_FORKID（0x41），实际 0x${hashType.toString(16)}`);
  }
  const prevouts: number[] = [];
  const sequences: number[] = [];
  for (const input of tx.inputs) {
    if (input.previousTxid.length !== HASH_BYTES) {
      throw new ProtocolEncodingError("input_txid", `输入 prevout txid 必须是 ${HASH_BYTES} 字节`);
    }
    prevouts.push(...input.previousTxid, ...uint32LE(input.previousVout));
    sequences.push(...uint32LE(input.sequence));
  }
  const outputs: number[] = [];
  for (const output of tx.outputs) {
    outputs.push(...uint64LE(output.value));
    outputs.push(...appendVarInt(new Uint8Array(0), output.lockingScript.length), ...output.lockingScript);
  }
  const input = tx.inputs[inputIndex] as TxInput;
  // preimage 全程用 number[] 累积：字节数组在这里会被反复拼接，
  // 提前物化成 Uint8Array 只会多一次拷贝。
  const preimage: number[] = [...uint32LE(tx.version)];
  preimage.push(...doubleSha256(Uint8Array.from(prevouts), sha256));
  preimage.push(...doubleSha256(Uint8Array.from(sequences), sha256));
  preimage.push(...input.previousTxid, ...uint32LE(input.previousVout));
  preimage.push(...appendVarInt(new Uint8Array(0), prevoutScript.length), ...prevoutScript);
  preimage.push(...uint64LE(prevoutValue), ...uint32LE(input.sequence));
  preimage.push(...doubleSha256(Uint8Array.from(outputs), sha256));
  preimage.push(...uint32LE(tx.locktime), ...uint32LE(hashType));
  return doubleSha256(Uint8Array.from(preimage), sha256);
}

export function totalOutputValue(tx: RawTransaction): bigint {
  return tx.outputs.reduce((total, output) => total + output.value, 0n);
}