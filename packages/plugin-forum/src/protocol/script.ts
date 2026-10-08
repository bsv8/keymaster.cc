// Forum 链上脚本：最小 push、`<pubkey> OP_CHECKSIG` 锁、数据输出与 tip 输出。
//
// 与服务端 `internal/bsv/script.go` 和 `internal/protocol/layout.go` 对齐。
// 关键点：
//   - 数据输出是严格交替的 (push, 终止符) 对，最后一个终止符是 OP_CHECKSIG；
//   - 每个 push 都必须是最短编码，因为签名覆盖的就是这些字节；
//   - 链上整数是最短无符号大端字节串，零是单字节 0x00（不是 OP_0）。

import {
  HASH_BYTES,
  PUBLIC_KEY_BYTES,
  ProtocolEncodingError,
  bigIntToMinimalBytes,
  bytesToBigInt,
  concatBytes,
  isCanonicalDer,
  validatePublicKey,
} from "./bytes.js";

export const OP_FALSE = 0x00;
export const OP_PUSH_DATA_1 = 0x4c;
export const OP_PUSH_DATA_2 = 0x4d;
export const OP_PUSH_DATA_4 = 0x4e;
export const OP_DROP = 0x75;
export const OP_CHECKSIG = 0xac;
export const MAX_SCRIPT_ELEMENT = 8 * 1024;

export const KIND_FORUM = "bsv8.forum.1";
export const KIND_REPLY = "bsv8.reply.1";
export const KIND_CHANGETIP = "bsv8.changetip.1";
export const KIND_TIP = "bsv8.tip.1";

/** 数据输出固定 1 sat；固定金额也意味着无法用别的金额冒领数据输出。 */
export const DATA_OUTPUT_SATOSHIS = 1n;
export const VOUT_INDEX_FEE = 0;
export const VOUT_DATA = 1;
export const VOUT_TIP = 2;
export const REQUIRED_OUTPUT_COUNT = 2;
export const MAX_FORUM_NAME_BYTES = 256;

/** 最短无符号大端字节串；零写成单字节 0x00。 */
export function encodeMinimalUint(value: bigint): Uint8Array {
  return bigIntToMinimalBytes(value);
}

/**
 * 解析最短无符号大端字节串。
 *
 * 前导零或多项零都拒绝而不是归一化：同一个数的两种拼写会是两条不同的签名
 * 消息，所以非规范形式必须失败而不是被修好。
 */
export function parseMinimalUint(data: Uint8Array): bigint {
  if (data.length === 0) throw new ProtocolEncodingError("uint_empty", "uint64 至少需要一个字节");
  if (data[0] === 0x00) {
    if (data.length === 1) return 0n;
    throw new ProtocolEncodingError("uint_leading_zero", "多字节 uint64 不能以零字节开头");
  }
  if (data.length > 8) throw new ProtocolEncodingError("uint_too_long", `uint64 最多 8 字节，实际 ${data.length} 字节`);
  return bytesToBigInt(data);
}

/** 最短数据 push；空数据不是 push，调用方不得传空。 */
export function pushDataInto(dst: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length === 0) throw new ProtocolEncodingError("push_empty", "空数据没有最短 push 形式");
  const head = pushOpcodeFor(data.length);
  return concatBytes(dst, head, data);
}

function pushOpcodeFor(length: number): Uint8Array {
  if (length < OP_PUSH_DATA_1) return Uint8Array.of(length);
  if (length <= 0xff) return Uint8Array.of(OP_PUSH_DATA_1, length);
  if (length <= 0xffff) return Uint8Array.of(OP_PUSH_DATA_2, length & 0xff, (length >> 8) & 0xff);
  return Uint8Array.of(
    OP_PUSH_DATA_4,
    length & 0xff,
    (length >> 8) & 0xff,
    (length >> 16) & 0xff,
    (length >> 24) & 0xff,
  );
}

/** 最短形式判定：与 Go 的 `IsMinimalPushData` 一致。 */
export function isMinimalPushData(opcode: number, length: number): boolean {
  if (length === 0) return false;
  if (length < OP_PUSH_DATA_1) return opcode === length;
  if (length <= 0xff) return opcode === OP_PUSH_DATA_1;
  if (length <= 0xffff) return opcode === OP_PUSH_DATA_2;
  return opcode === OP_PUSH_DATA_4;
}

/** `<pubkey> OP_CHECKSIG` 锁。 */
export function buildLockingScript(publicKey: Uint8Array): Uint8Array {
  validatePublicKey(publicKey);
  return concatBytes(Uint8Array.of(PUBLIC_KEY_BYTES), publicKey, Uint8Array.of(OP_CHECKSIG));
}

export interface ScriptChunk {
  readonly isPush: boolean;
  readonly opcode: number;
  readonly data: Uint8Array;
}

/** 解析脚本为 chunk 序列；非 push 记为裸操作码。 */
export function parseScript(raw: Uint8Array): ScriptChunk[] {
  const chunks: ScriptChunk[] = [];
  let offset = 0;
  while (offset < raw.length) {
    const opcode = raw[offset] as number;
    offset += 1;
    if (opcode > OP_PUSH_DATA_4) {
      chunks.push({ isPush: false, opcode, data: new Uint8Array(0) });
      continue;
    }
    let length = opcode;
    if (opcode === OP_PUSH_DATA_1) {
      length = requireByte(raw, offset, "OP_PUSHDATA1");
      offset += 1;
    } else if (opcode === OP_PUSH_DATA_2) {
      length = (requireByte(raw, offset, "OP_PUSHDATA2") | (requireByte(raw, offset + 1, "OP_PUSHDATA2") << 8));
      offset += 2;
    } else if (opcode === OP_PUSH_DATA_4) {
      length =
        (requireByte(raw, offset, "OP_PUSHDATA4") |
          (requireByte(raw, offset + 1, "OP_PUSHDATA4") << 8) |
          (requireByte(raw, offset + 2, "OP_PUSHDATA4") << 16) |
          (requireByte(raw, offset + 3, "OP_PUSHDATA4") << 24)) >>> 0;
      offset += 4;
    }
    if (length > MAX_SCRIPT_ELEMENT) throw new ProtocolEncodingError("script_element", `脚本元素 ${length} 字节超过上限`);
    if (offset + length > raw.length) throw new ProtocolEncodingError("script_truncated", "脚本数据被截断");
    chunks.push({ isPush: true, opcode, data: raw.subarray(offset, offset + length) });
    offset += length;
  }
  return chunks;
}

function requireByte(raw: Uint8Array, offset: number, label: string): number {
  const byte = raw[offset];
  if (byte === undefined) throw new ProtocolEncodingError("script_truncated", `${label} 长度字节缺失`);
  return byte;
}

export interface ParsedLockingScript {
  readonly publicKey: Uint8Array;
}

/** 只接受裸 `<pubkey> OP_CHECKSIG` 锁。 */
export function parseLockingScript(raw: Uint8Array): ParsedLockingScript {
  const chunks = parseScript(raw);
  if (chunks.length !== 2) throw new ProtocolEncodingError("lock_shape", "锁定脚本必须是 <pubkey> OP_CHECKSIG 两段");
  const push = chunks[0];
  const terminator = chunks[1];
  if (push === undefined || terminator === undefined || !push.isPush || terminator.isPush || terminator.opcode !== OP_CHECKSIG) {
    throw new ProtocolEncodingError("lock_shape", "锁定脚本必须以 OP_CHECKSIG 结束");
  }
  if (!isMinimalPushData(push.opcode, push.data.length)) {
    throw new ProtocolEncodingError("lock_non_minimal", "锁定脚本的公钥 push 不是最短编码");
  }
  validatePublicKey(push.data);
  return { publicKey: push.data };
}

export interface DataOutput {
  readonly kind: string;
  /** kind 标记与作者锁之间的字段，按脚本顺序。 */
  readonly fields: readonly Uint8Array[];
  /** 作者公钥，也是 OP_CHECKSIG 前最后一个 push 的值。 */
  readonly publicKey: Uint8Array;
}

/**
 * 拆开数据输出：kind 标记、字段、作者锁。
 *
 * 形状是严格的：每个值 push 之后紧跟 OP_DROP，只有作者锁的值留在栈上并被
 * OP_CHECKSIG 消费，所以元素数必须是偶数且以 OP_CHECKSIG 结束。校验配对正是
 * 为了防止某个字段被读两次或被跳过。
 */
export function parseDataOutput(raw: Uint8Array): DataOutput {
  const chunks = parseScript(raw);
  if (chunks.length < 4 || chunks.length % 2 !== 0) {
    throw new ProtocolEncodingError("data_shape", `数据输出必须是成对的 push 与终止符并以 OP_CHECKSIG 结束，实际 ${chunks.length} 段`);
  }
  const pairs = chunks.length / 2;
  const values: Uint8Array[] = [];
  for (let index = 0; index < pairs; index += 1) {
    const push = chunks[index * 2] as ScriptChunk;
    const terminator = chunks[index * 2 + 1] as ScriptChunk;
    if (!push.isPush) throw new ProtocolEncodingError("data_shape", `数据输出第 ${index} 段不是数据 push`);
    if (!isMinimalPushData(push.opcode, push.data.length)) {
      throw new ProtocolEncodingError("data_non_minimal", `数据输出第 ${index} 段的 push 不是最短编码`);
    }
    if (index === pairs - 1) {
      if (terminator.isPush || terminator.opcode !== OP_CHECKSIG) {
        throw new ProtocolEncodingError("data_shape", "数据输出必须以 OP_CHECKSIG 结束");
      }
      if (push.data.length !== PUBLIC_KEY_BYTES) {
        throw new ProtocolEncodingError("data_key_length", `数据输出作者公钥必须是 ${PUBLIC_KEY_BYTES} 字节，实际 ${push.data.length} 字节`);
      }
      validatePublicKey(push.data);
    } else if (terminator.isPush || terminator.opcode !== OP_DROP) {
      throw new ProtocolEncodingError("data_shape", `数据输出第 ${index} 个字段之后必须是 OP_DROP`);
    }
    values.push(push.data);
  }
  const key = values[values.length - 1] as Uint8Array;
  const kindBytes = values[0] as Uint8Array;
  return {
    kind: new TextDecoder("utf-8", { fatal: true }).decode(kindBytes),
    fields: values.slice(1, values.length - 1),
    publicKey: key,
  };
}

/**
 * 构造数据输出脚本：kind 标记、每个字段 push + OP_DROP、作者锁。
 *
 * 字段顺序即脚本顺序，签名覆盖的是这些字节，所以顺序本身是协议的一部分。
 */
export function buildDataScript(authorPublicKey: Uint8Array, kind: string, fields: readonly Uint8Array[]): Uint8Array {
  validatePublicKey(authorPublicKey);
  let script = pushDataInto(new Uint8Array(0), new TextEncoder().encode(kind));
  script = concatBytes(script, Uint8Array.of(OP_DROP));
  for (const field of fields) {
    script = pushDataInto(script, field);
    script = concatBytes(script, Uint8Array.of(OP_DROP));
  }
  return concatBytes(script, buildLockingScript(authorPublicKey));
}

/** 数据输出字段总数校验（含 kind 标记与作者锁）。 */
export function requireFieldCount(data: DataOutput, count: number): void {
  if (data.fields.length + 2 !== count) {
    throw new ProtocolEncodingError("data_fields", `数据输出必须是 ${count} 个 push，实际 ${data.fields.length + 2} 个`);
  }
}

export interface TipOutput {
  readonly parentTxid: Uint8Array;
  readonly parentPublicKey: Uint8Array;
  readonly amount: bigint;
}

/** 解析 vout 2 的 tip 付款：`bsv8.tip.1` OP_DROP、parent_txid OP_DROP、父锁 OP_CHECKSIG。 */
export function parseTipOutput(lockingScript: Uint8Array, amount: bigint): TipOutput {
  const chunks = parseScript(lockingScript);
  if (chunks.length !== 6) {
    throw new ProtocolEncodingError("tip_shape", `tip 输出需要标记、parent txid 和公钥锁，实际 ${chunks.length} 段`);
  }
  for (let index = 0; index < 3; index += 1) {
    const push = chunks[index * 2] as ScriptChunk;
    const terminator = chunks[index * 2 + 1] as ScriptChunk;
    if (!push.isPush) throw new ProtocolEncodingError("tip_shape", `tip 输出第 ${index} 段不是数据 push`);
    if (!isMinimalPushData(push.opcode, push.data.length)) {
      throw new ProtocolEncodingError("tip_non_minimal", `tip 输出第 ${index} 段的 push 不是最短编码`);
    }
    if (index < 2) {
      if (terminator.isPush || terminator.opcode !== OP_DROP) {
        throw new ProtocolEncodingError("tip_shape", `tip 输出第 ${index} 段之后必须是 OP_DROP`);
      }
    } else if (terminator.isPush || terminator.opcode !== OP_CHECKSIG) {
      throw new ProtocolEncodingError("tip_shape", "tip 输出必须以 OP_CHECKSIG 结束");
    }
  }
  const marker = chunks[0] as ScriptChunk;
  if (new TextDecoder().decode(marker.data) !== KIND_TIP) {
    throw new ProtocolEncodingError("tip_marker", `tip 输出必须以 ${KIND_TIP} 开头`);
  }
  const parentTxid = chunks[2] as ScriptChunk;
  if (parentTxid.data.length !== HASH_BYTES) {
    throw new ProtocolEncodingError("tip_parent_length", `tip 输出的 parent txid 必须是 ${HASH_BYTES} 字节`);
  }
  const parentPublicKey = chunks[4] as ScriptChunk;
  if (parentPublicKey.data.length !== PUBLIC_KEY_BYTES) {
    throw new ProtocolEncodingError("tip_key_length", `tip 输出的公钥必须是 ${PUBLIC_KEY_BYTES} 字节`);
  }
  validatePublicKey(parentPublicKey.data);
  return { parentTxid: parentTxid.data, parentPublicKey: parentPublicKey.data, amount };
}

/** tip 输出脚本；父节点被重复点名，付款就无法只改数据输出而被改道。 */
export function buildTipScript(parentPublicKey: Uint8Array, parentTxid: Uint8Array): Uint8Array {
  if (parentTxid.length !== HASH_BYTES) {
    throw new ProtocolEncodingError("tip_parent_length", `parent txid 必须是 ${HASH_BYTES} 字节`);
  }
  return buildDataScript(parentPublicKey, KIND_TIP, [parentTxid]);
}

export function dataFieldBytes(data: DataOutput, index: number, name: string): Uint8Array {
  const field = data.fields[index];
  if (field === undefined) throw new ProtocolEncodingError("data_fields", `数据输出缺少字段 ${name}`);
  return field;
}

export function dataFieldHash(data: DataOutput, index: number, name: string): Uint8Array {
  const raw = dataFieldBytes(data, index, name);
  if (raw.length !== HASH_BYTES) {
    throw new ProtocolEncodingError("field_length", `${name} 必须是 ${HASH_BYTES} 字节，实际 ${raw.length} 字节`);
  }
  return raw;
}

export function dataFieldKey(data: DataOutput, index: number, name: string): Uint8Array {
  const raw = dataFieldBytes(data, index, name);
  if (raw.length !== PUBLIC_KEY_BYTES) {
    throw new ProtocolEncodingError("field_length", `${name} 必须是 ${PUBLIC_KEY_BYTES} 字节，实际 ${raw.length} 字节`);
  }
  validatePublicKey(raw);
  return raw;
}

export function dataFieldUint(data: DataOutput, index: number, name: string): bigint {
  return parseMinimalUint(dataFieldBytes(data, index, name));
}

export function dataFieldSignature(data: DataOutput, index: number, name: string): Uint8Array {
  const raw = dataFieldBytes(data, index, name);
  if (!isCanonicalDer(raw)) throw new ProtocolEncodingError("signature_format", `${name} 不是严格 DER low-S 签名`);
  return raw;
}