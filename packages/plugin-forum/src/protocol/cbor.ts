// Forum 业务签名的确定性 CBOR 编解码。
//
// 服务端没有用第三方 CBOR 库，而是手写了 RFC 8949 §4.2.1 的最短形式编码器
// （`internal/protocol/uint.go`）。这里逐条复刻，包括它对非规范编码的拒绝：
//   - 每个 head 与长度都用能容纳该值的最短形式；
//   - head 的实参是大端；
//   - 解码时用更宽的形式写 head 一律拒绝，而不是重新编码；
//   - 负整数、tag、map、simple/float、不定长、尾随字节全部拒绝。
//
// 业务签名数组是定长数组且只含整数、字节串、一个前置文本串，所以同一个值
// 只有一种字节拼写，签名因此不会有第二种「同值不同签名」。

import { ProtocolEncodingError } from "./bytes.js";

export const MAX_CBOR_ITEM_BYTES = 8 * 1024;
export const MAX_CBOR_DEPTH = 4;

export const CBOR_UINT = 0;
export const CBOR_NINT = 1;
export const CBOR_BYTES = 2;
export const CBOR_TEXT = 3;
export const CBOR_ARRAY = 4;

export type CborValue =
  | { readonly kind: typeof CBOR_UINT; readonly uint: bigint }
  | { readonly kind: typeof CBOR_BYTES; readonly bytes: Uint8Array }
  | { readonly kind: typeof CBOR_TEXT; readonly text: string }
  | { readonly kind: typeof CBOR_ARRAY; readonly items: readonly CborValue[] };

export function cborUint(value: bigint | number): CborValue {
  const asBigInt = typeof value === "number" ? BigInt(value) : value;
  if (asBigInt < 0n) throw new ProtocolEncodingError("cbor_uint_negative", "CBOR 无符号整数不接受负数");
  return { kind: CBOR_UINT, uint: asBigInt };
}

export function cborBytes(bytes: Uint8Array): CborValue {
  return { kind: CBOR_BYTES, bytes };
}

export function cborText(text: string): CborValue {
  return { kind: CBOR_TEXT, text };
}

export function cborArray(items: readonly CborValue[]): CborValue {
  return { kind: CBOR_ARRAY, items };
}

/** 编码一个值（数组内元素，或单个值）。 */
export function encodeCbor(value: CborValue): Uint8Array {
  const out: number[] = [];
  appendCborValue(out, value);
  return Uint8Array.from(out);
}

export function encodeCborArray(items: readonly CborValue[]): Uint8Array {
  return encodeCbor(cborArray(items));
}

function appendCborValue(out: number[], value: CborValue): void {
  switch (value.kind) {
    case CBOR_UINT:
      appendCborHead(out, CBOR_UINT, value.uint);
      return;
    case CBOR_BYTES:
      appendCborHead(out, CBOR_BYTES, BigInt(value.bytes.length));
      out.push(...value.bytes);
      return;
    case CBOR_TEXT: {
      const encoded = new TextEncoder().encode(value.text);
      appendCborHead(out, CBOR_TEXT, BigInt(encoded.length));
      out.push(...encoded);
      return;
    }
    case CBOR_ARRAY:
      appendCborHead(out, CBOR_ARRAY, BigInt(value.items.length));
      for (const item of value.items) appendCborValue(out, item);
      return;
    default:
      // CborValue 是封闭联合：走到这里说明编码器漏了一个分支，宁可失败。
      throw new ProtocolEncodingError("cbor_kind", "CBOR 类型没有编码");
  }
}

/** head 实参是大端；256 写成 0x19 0x01 0x00，而不是小端的 0x19 0x00 0x01。 */
function appendCborHead(out: number[], majorType: number, argument: bigint): void {
  const major = majorType << 5;
  if (argument < 24n) {
    out.push(major | Number(argument));
    return;
  }
  if (argument <= 0xffn) {
    out.push(major | 24, Number(argument));
    return;
  }
  if (argument <= 0xffffn) {
    out.push(major | 25, Number(argument >> 8n), Number(argument));
    return;
  }
  if (argument <= 0xffffffffn) {
    out.push(major | 26, Number((argument >> 24n) & 0xffn), Number((argument >> 16n) & 0xffn), Number((argument >> 8n) & 0xffn), Number(argument & 0xffn));
    return;
  }
  out.push(
    major | 27,
    Number((argument >> 56n) & 0xffn),
    Number((argument >> 48n) & 0xffn),
    Number((argument >> 40n) & 0xffn),
    Number((argument >> 32n) & 0xffn),
    Number((argument >> 24n) & 0xffn),
    Number((argument >> 16n) & 0xffn),
    Number((argument >> 8n) & 0xffn),
    Number(argument & 0xffn),
  );
}

/** 解码一个完整 CBOR 项；尾随字节、非规范 head、越界类型都拒绝。 */
export function decodeCbor(data: Uint8Array): CborValue {
  if (data.length === 0) throw new ProtocolEncodingError("cbor_empty", "CBOR 项至少需要一个字节");
  if (data.length > MAX_CBOR_ITEM_BYTES) {
    throw new ProtocolEncodingError("cbor_too_large", `CBOR 项 ${data.length} 字节超过 ${MAX_CBOR_ITEM_BYTES} 字节上限`);
  }
  const decoder = new CborDecoder(data);
  const value = decoder.readItem(0);
  if (decoder.offset !== data.length) {
    throw new ProtocolEncodingError("cbor_trailing", `${data.length - decoder.offset} 个字节尾随在 CBOR 项之后`);
  }
  return value;
}

class CborDecoder {
  offset = 0;

  constructor(private readonly data: Uint8Array) {}

  readItem(depth: number): CborValue {
    if (depth > MAX_CBOR_DEPTH) throw new ProtocolEncodingError("cbor_depth", `CBOR 嵌套深度超过 ${MAX_CBOR_DEPTH}`);
    const { majorType, argument } = this.readHead();
    if (majorType === CBOR_UINT) return { kind: CBOR_UINT, uint: argument };
    if (majorType === CBOR_NINT) throw new ProtocolEncodingError("cbor_nint", "CBOR 负整数不允许");
    if (majorType === CBOR_BYTES) return { kind: CBOR_BYTES, bytes: this.readBytes(Number(argument)) };
    if (majorType === CBOR_TEXT) {
      const raw = this.readBytes(Number(argument));
      return { kind: CBOR_TEXT, text: new TextDecoder("utf-8", { fatal: true }).decode(raw) };
    }
    if (majorType === CBOR_ARRAY) {
      const count = Number(argument);
      const items: CborValue[] = [];
      for (let index = 0; index < count; index += 1) items.push(this.readItem(depth + 1));
      return { kind: CBOR_ARRAY, items };
    }
    throw new ProtocolEncodingError("cbor_major", `CBOR major type ${majorType} 不允许`);
  }

  private readHead(): { majorType: number; argument: bigint } {
    const initial = this.readByte();
    const majorType = initial >> 5;
    const discr = initial & 0x1f;
    if (discr < 24) return { majorType, argument: BigInt(discr) };
    if (discr === 24) {
      const argument = BigInt(this.readByte());
      if (argument < 24n) throw new ProtocolEncodingError("cbor_non_canonical", `${argument} 必须使用立即数形式`);
      return { majorType, argument };
    }
    if (discr === 25) {
      const raw = this.readBytes(2);
      // CBOR head 是大端：第一个字节是最高位。
      const argument = (BigInt(raw[0] as number) << 8n) | BigInt(raw[1] as number);
      if (argument < 0x100n) throw new ProtocolEncodingError("cbor_non_canonical", `${argument} 不允许使用两字节形式`);
      return { majorType, argument };
    }
    if (discr === 26) {
      const raw = this.readBytes(4);
      let argument = 0n;
      for (const byte of raw) argument = (argument << 8n) | BigInt(byte);
      if (argument < 0x10000n) throw new ProtocolEncodingError("cbor_non_canonical", `${argument} 不允许使用四字节形式`);
      return { majorType, argument };
    }
    if (discr === 27) {
      const raw = this.readBytes(8);
      let argument = 0n;
      for (const byte of raw) argument = (argument << 8n) | BigInt(byte);
      if (argument < 0x100000000n) throw new ProtocolEncodingError("cbor_non_canonical", `${argument} 不允许使用八字节形式`);
      return { majorType, argument };
    }
    if (discr === 31) throw new ProtocolEncodingError("cbor_indefinite", "CBOR 不定长项不允许");
    throw new ProtocolEncodingError("cbor_simple", "CBOR simple 或浮点值不允许");
  }

  private readByte(): number {
    const byte = this.data[this.offset];
    if (byte === undefined) throw new ProtocolEncodingError("cbor_truncated", "CBOR 项被截断");
    this.offset += 1;
    return byte;
  }

  private readBytes(length: number): Uint8Array {
    if (length < 0 || this.offset + length > this.data.length) {
      throw new ProtocolEncodingError("cbor_truncated", "CBOR 内容被截断");
    }
    const slice = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }
}

/** 取定长数组的定长校验结果；业务对象都用它给出稳定的字段名。 */
export function requireArray(value: CborValue, length: number, label: string): readonly CborValue[] {
  if (value.kind !== CBOR_ARRAY) throw new ProtocolEncodingError("cbor_shape", `${label} 必须是数组`);
  if (value.items.length !== length) {
    throw new ProtocolEncodingError("cbor_arity", `${label} 必须是 ${length} 项数组，实际 ${value.items.length} 项`);
  }
  return value.items;
}

/** 取不定长数组（例如 forumSig 的 input 列表）。 */
export function requireArrayAny(value: CborValue, label: string): readonly CborValue[] {
  if (value.kind !== CBOR_ARRAY) throw new ProtocolEncodingError("cbor_shape", `${label} 必须是数组`);
  return value.items;
}

export function requireUint(value: CborValue, label: string): bigint {
  if (value.kind !== CBOR_UINT) throw new ProtocolEncodingError("cbor_shape", `${label} 必须是 CBOR 无符号整数`);
  return value.uint;
}

export function requireBytes(value: CborValue, label: string, length?: number): Uint8Array {
  if (value.kind !== CBOR_BYTES) throw new ProtocolEncodingError("cbor_shape", `${label} 必须是 CBOR 字节串`);
  if (length !== undefined && value.bytes.length !== length) {
    throw new ProtocolEncodingError("cbor_shape", `${label} 必须是 ${length} 字节，实际 ${value.bytes.length} 字节`);
  }
  return value.bytes;
}

export function requireText(value: CborValue, label: string): string {
  if (value.kind !== CBOR_TEXT) throw new ProtocolEncodingError("cbor_shape", `${label} 必须是 CBOR 文本串`);
  return value.text;
}