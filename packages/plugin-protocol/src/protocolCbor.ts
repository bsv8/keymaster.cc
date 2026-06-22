// packages/plugin-protocol/src/protocolCbor.ts
// Deterministic CBOR (RFC 8949 §4.2.1) 编码/解码。
//
// 设计缘由（施工单 001）：
//   - identityEnvelope / signedEnvelope / cipher 内层明文结构 都必须是
//     Deterministic CBOR；调用方拿到的 `*.bytes` 是最终真值字节。
//   - 业务层**不允许**直接调第三方 CBOR 库 API。所有 encode/decode
//     都必须走本文件。
//   - 不支持 indefinite-length items / map key 顺序 / 浮点；本协议
//     V1 只用：unsigned int / negative int / byte string / text string
//     / array / map / null / bool。这与需求文档（[v, id, aud, iat,
//     exp, ...] 数组）完全一致。
//   - 编码保证：所有数值走最短编码；map key 按 bytewise 字典序排序；
//     数组按插入顺序；结构都用 definite-length。
//
// 这里的实现刻意只覆盖协议需要的数据形态，不追求"通用 CBOR 库"。
// 多余的输入会被拒绝；这样 signature 投影、envelope 等关键真值的
// 编码与解码能完全受控。

const MT_UNSIGNED = 0;
const MT_NEGATIVE = 1;
const MT_BYTE_STRING = 2;
const MT_TEXT_STRING = 3;
const MT_ARRAY = 4;
const MT_MAP = 5;
const MT_SIMPLE = 7;

const SIMPLE_FALSE = 20;
const SIMPLE_TRUE = 21;
const SIMPLE_NULL = 22;

/** CBOR 编码输入。基础类型白名单：uint / int / string / bytes / array / map / null / bool。 */
export type CborValue =
  | number // 仅支持整数（0..2^53 安全整数）
  | string
  | Uint8Array
  | CborValue[]
  | CborMap
  | null
  | boolean;

export type CborMap = { [key: string]: CborValue };

/** 编码入口：返回 deterministic CBOR 字节。 */
export function cborEncode(value: CborValue): Uint8Array {
  const enc = new Encoder();
  enc.writeValue(value);
  return enc.toBytes();
}

/** 解码入口：仅支持本协议用到的子集。 */
export function cborDecode(bytes: Uint8Array): CborValue {
  const dec = new Decoder(bytes);
  return dec.readValue();
}

class Encoder {
  private chunks: Uint8Array[] = [];
  write(bytes: Uint8Array): void {
    this.chunks.push(bytes);
  }
  toBytes(): Uint8Array {
    let total = 0;
    for (const c of this.chunks) total += c.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
  writeValue(value: CborValue): void {
    if (value === null) {
      this.writeHead(MT_SIMPLE, SIMPLE_NULL);
      return;
    }
    if (value === true) {
      this.writeHead(MT_SIMPLE, SIMPLE_TRUE);
      return;
    }
    if (value === false) {
      this.writeHead(MT_SIMPLE, SIMPLE_FALSE);
      return;
    }
    if (typeof value === "number") {
      if (!Number.isInteger(value)) {
        throw new Error("CBOR: only integer numbers are supported");
      }
      // 协议不使用浮点；负数走 -1 - n 编码。
      if (value >= 0) {
        this.writeHead(MT_UNSIGNED, value);
      } else {
        this.writeHead(MT_NEGATIVE, -value - 1);
      }
      return;
    }
    if (typeof value === "string") {
      const bytes = new TextEncoder().encode(value);
      this.writeHead(MT_TEXT_STRING, bytes.length);
      this.write(bytes);
      return;
    }
    if (value instanceof Uint8Array) {
      this.writeHead(MT_BYTE_STRING, value.length);
      this.write(value);
      return;
    }
    if (Array.isArray(value)) {
      this.writeHead(MT_ARRAY, value.length);
      for (const item of value) this.writeValue(item);
      return;
    }
    if (typeof value === "object") {
      // map：key 排序（bytewise）。
      const entries: Array<{ key: string; keyBytes: Uint8Array; val: CborValue }> = [];
      for (const k of Object.keys(value)) {
        const v = (value as CborMap)[k];
        if (v === undefined) continue;
        entries.push({ key: k, keyBytes: new TextEncoder().encode(k), val: v });
      }
      entries.sort((a, b) => compareBytes(a.keyBytes, b.keyBytes));
      this.writeHead(MT_MAP, entries.length);
      for (const e of entries) {
        this.writeHead(MT_TEXT_STRING, e.keyBytes.length);
        this.write(e.keyBytes);
        this.writeValue(e.val);
      }
      return;
    }
    throw new Error("CBOR: unsupported value type");
  }

  private writeHead(majorType: number, arg: number): void {
    if (arg < 0) {
      throw new Error("CBOR: negative head argument");
    }
    const mt = majorType << 5;
    if (arg < 24) {
      this.write(new Uint8Array([mt | arg]));
    } else if (arg < 0x100) {
      this.write(new Uint8Array([mt | 24, arg]));
    } else if (arg < 0x10000) {
      this.write(new Uint8Array([mt | 25, (arg >> 8) & 0xff, arg & 0xff]));
    } else if (arg < 0x100000000) {
      this.write(new Uint8Array([mt | 26, (arg >> 24) & 0xff, (arg >> 16) & 0xff, (arg >> 8) & 0xff, arg & 0xff]));
    } else {
      // 协议不需要 >2^32 整数；超过则抛错避免 silent 截断。
      if (arg > Number.MAX_SAFE_INTEGER) {
        throw new Error("CBOR: integer too large for deterministic encoding");
      }
      this.write(new Uint8Array([
        mt | 27,
        (arg / 0x100000000) & 0xff,
        ((arg / 0x100000000) & 0xff00) >> 8,
        ((arg >>> 24) & 0xff),
        ((arg >>> 16) & 0xff),
        ((arg >>> 8) & 0xff),
        arg & 0xff
      ]));
    }
  }
}

class Decoder {
  private off = 0;
  constructor(private bytes: Uint8Array) {}
  private readByte(): number {
    if (this.off >= this.bytes.length) {
      throw new Error("CBOR: unexpected end of input");
    }
    return this.bytes[this.off++] as number;
  }
  private readBytes(n: number): Uint8Array {
    if (this.off + n > this.bytes.length) {
      throw new Error("CBOR: unexpected end of input");
    }
    const out = this.bytes.subarray(this.off, this.off + n);
    this.off += n;
    return out;
  }
  private readHead(majorType: number): number {
    const head = this.readByte();
    const mt = head >> 5;
    if (mt !== majorType) {
      throw new Error(`CBOR: expected major type ${majorType}, got ${mt}`);
    }
    const arg = head & 0x1f;
    if (arg < 24) return arg;
    if (arg === 24) return this.readByte();
    if (arg === 25) {
      const hi = this.readByte();
      const lo = this.readByte();
      return (hi << 8) | lo;
    }
    if (arg === 26) {
      const b1 = this.readByte();
      const b2 = this.readByte();
      const b3 = this.readByte();
      const b4 = this.readByte();
      return (b1 << 24) | (b2 << 16) | (b3 << 8) | b4;
    }
    if (arg === 27) {
      const b1 = this.readByte();
      const b2 = this.readByte();
      const b3 = this.readByte();
      const b4 = this.readByte();
      const b5 = this.readByte();
      const b6 = this.readByte();
      const b7 = this.readByte();
      const b8 = this.readByte();
      // bigint path; safely combine for safe integers.
      const hi = b1 * 0x1000000 + b2 * 0x10000 + b3 * 0x100 + b4;
      const lo = b5 * 0x1000000 + b6 * 0x10000 + b7 * 0x100 + b8;
      return hi * 0x100000000 + lo;
    }
    throw new Error("CBOR: indefinite-length not supported");
  }
  readValue(): CborValue {
    const head = this.readByte();
    const mt = head >> 5;
    const arg = head & 0x1f;
    if (mt === MT_SIMPLE) {
      if (arg === SIMPLE_FALSE) return false;
      if (arg === SIMPLE_TRUE) return true;
      if (arg === SIMPLE_NULL) return null;
      throw new Error("CBOR: unsupported simple value");
    }
    // For the other major types, fall back into the same logic but with
    // the head already consumed; we re-parse via readHead helpers.
    if (mt === MT_UNSIGNED) {
      const n = this.consumeArg(arg);
      return n;
    }
    if (mt === MT_NEGATIVE) {
      const n = this.consumeArg(arg);
      return -1 - n;
    }
    if (mt === MT_TEXT_STRING) {
      const n = this.consumeArg(arg);
      const bytes = this.readBytes(n);
      return new TextDecoder().decode(bytes);
    }
    if (mt === MT_BYTE_STRING) {
      const n = this.consumeArg(arg);
      return this.readBytes(n);
    }
    if (mt === MT_ARRAY) {
      const n = this.consumeArg(arg);
      const out: CborValue[] = new Array(n);
      for (let i = 0; i < n; i++) out[i] = this.readValue();
      return out;
    }
    if (mt === MT_MAP) {
      const n = this.consumeArg(arg);
      const out: CborMap = {};
      for (let i = 0; i < n; i++) {
        const k = this.readValue();
        if (typeof k !== "string") {
          throw new Error("CBOR: map key must be text string");
        }
        out[k] = this.readValue();
      }
      return out;
    }
    throw new Error("CBOR: unsupported major type");
  }
  private consumeArg(arg: number): number {
    if (arg < 24) return arg;
    if (arg === 24) return this.readByte();
    if (arg === 25) {
      return (this.readByte() << 8) | this.readByte();
    }
    if (arg === 26) {
      return (
        (this.readByte() << 24) |
        (this.readByte() << 16) |
        (this.readByte() << 8) |
        this.readByte()
      );
    }
    if (arg === 27) {
      return (
        this.readByte() * 0x100000000 +
        (this.readByte() << 24) +
        (this.readByte() << 16) +
        (this.readByte() << 8) +
        this.readByte()
      );
    }
    throw new Error("CBOR: indefinite-length not supported");
  }
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const diff = (a[i] as number) - (b[i] as number);
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}
