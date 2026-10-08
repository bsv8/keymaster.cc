import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha256";

import {
  HASH_BYTES,
  ProtocolEncodingError,
  bytesToBigInt,
  bytesToHex,
  hexToBytes,
  isCanonicalDer,
  isHashHex,
  isPublicKeyHex,
  parseDerSignature,
  parseHashHex,
  rawTxidToDisplay,
  validatePublicKey,
} from "./bytes.js";
import {
  CBOR_MAX_UINT64_VECTOR,
  CBOR_BOUNDARY_INTEGERS,
  CBOR_NON_CANONICAL_VECTORS,
  FORUM_INPUTS_VECTOR,
  FORUM_OBJECT_VECTOR,
  FORUM_SIGNATURE_VECTOR,
  MINIMAL_UINT_VECTORS,
} from "./vectors.js";

const hash = (input: Uint8Array): Uint8Array => sha256(input);

function filledHash(fill: number): Uint8Array {
  return new Uint8Array(HASH_BYTES).fill(fill);
}

/** 手写严格 DER，用来构造本模块必须拒绝的反例。 */
function encodeDer(r: bigint, s: bigint): Uint8Array {
  const integer = (value: bigint): number[] => {
    let hex = value.toString(16);
    if (hex.length % 2 !== 0) hex = `0${hex}`;
    const body = [...hexToBytes(hex)];
    if (body[0] !== undefined && body[0] >= 0x80) body.unshift(0x00);
    return [0x02, body.length, ...body];
  };
  const body = [...integer(r), ...integer(s)];
  return Uint8Array.from([0x30, body.length, ...body]);
}

describe("hash / hex 原语", () => {
  it("规范化 64 字符 hash 为小写显示顺序", () => {
    const hex = "ab".repeat(32);
    expect(parseHashHex(hex)).toHaveLength(HASH_BYTES);
    expect(bytesToHex(parseHashHex(hex))).toBe(hex);
    // 大写被接受并归一化，与服务端 bsv.ParseHash 一致。
    expect(bytesToHex(parseHashHex(hex.toUpperCase()))).toBe(hex);
    // 严格小写形态的判定是另一件事：客户端自己生成的字段必须满足它。
    expect(isHashHex(hex)).toBe(true);
    expect(isHashHex(hex.toUpperCase())).toBe(false);
    expect(() => parseHashHex(` ${hex}`)).toThrow(/空白/);
    expect(() => parseHashHex(hex.slice(0, 62))).toThrow(/64/);
    expect(() => parseHashHex("zz".repeat(32))).toThrow(/非十六进制/);
  });

  it("raw txid 与显示顺序互为反转，且这是唯一一次反转", () => {
    // 非对称填充才能看出反转；全同字节反转后与自身相同。
    const display = Uint8Array.from({ length: HASH_BYTES }, (_byte, index) => index);
    const raw = new Uint8Array(HASH_BYTES);
    for (let index = 0; index < HASH_BYTES; index += 1) raw[index] = display[HASH_BYTES - 1 - index] as number;
    expect(rawTxidToDisplay(raw)).toEqual(display);
    expect(rawTxidToDisplay(display)).not.toEqual(display);
    // 反转两次回到原值，说明没有在别处再翻转一次。
    expect(rawTxidToDisplay(rawTxidToDisplay(raw))).toEqual(raw);
  });

  it("hex 解码拒绝奇数长度与非 hex 字符", () => {
    expect(() => hexToBytes("abc")).toThrow(ProtocolEncodingError);
    expect(() => hexToBytes("abc")).toThrow(/偶数/);
    expect(() => hexToBytes("zz")).toThrow(/非十六进制/);
  });
});

describe("公钥校验", () => {
  it("拒绝长度错误、前缀错误与不在曲线上的点", () => {
    expect(() => validatePublicKey(new Uint8Array(32))).toThrow(/33/);
    expect(() => validatePublicKey(Uint8Array.from([0x04, ...new Uint8Array(32)]))).toThrow(/压缩 SEC1/);
    // x = 0 不在曲线上（y² = 7 在该域无解）。
    expect(() => validatePublicKey(Uint8Array.from([0x02, ...new Uint8Array(32)]))).toThrow(/曲线点/);
  });

  it("接受真实压缩公钥，并且只有 02/03 形态算合法 hex", () => {
    const publicKey = bytesToHex(secp256k1.getPublicKey(hexToBytes("11".repeat(32)), true));
    expect(isPublicKeyHex(publicKey)).toBe(true);
    expect(validatePublicKey(hexToBytes(publicKey))).toHaveLength(33);
    expect(isPublicKeyHex(`04${publicKey.slice(2)}`)).toBe(false);
  });
});

describe("严格 DER / low-S", () => {
  it("接受低位 S，拒绝高位 S", () => {
    const lowS = hexToBytes(FORUM_SIGNATURE_VECTOR);
    const parsed = parseDerSignature(lowS);
    expect(parsed.s * 2n < 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n).toBe(true);
    // n - s 让 S 落在高位半区；R 保持不变，只用来验证解析器的 low-S 规则。
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const highS = encodeDer(parsed.r, n - parsed.s);
    expect(isCanonicalDer(highS)).toBe(false);
    expect(() => parseDerSignature(highS)).toThrow(/low-S/);
  });

  it("拒绝畸形 DER：长度、tag、负数、多余前导零、尾随字节", () => {
    const good = hexToBytes(FORUM_SIGNATURE_VECTOR);
    expect(() => parseDerSignature(good.subarray(0, good.length - 1))).toThrow(ProtocolEncodingError);
    expect(() => parseDerSignature(good.subarray(0, 5))).toThrow(/长度/);
    expect(() => parseDerSignature(Uint8Array.from([...good.slice(0, 1), ...good.slice(2)]))).toThrow(ProtocolEncodingError);
    // 在 R 之前插入一个多余的前导零字节，长度字节同步 +1。
    const withLeadingZero = Uint8Array.from([0x30, good.length - 1, 0x02, good[3]! + 1, 0x00, ...good.slice(4)]);
    expect(() => parseDerSignature(withLeadingZero)).toThrow(ProtocolEncodingError);
    expect(() => parseDerSignature(Uint8Array.from([...good, 0x00]))).toThrow(ProtocolEncodingError);
    // 负数：把 R 的最高位置 1。
    const negative = Uint8Array.from(good);
    negative[4] = (negative[4] as number) | 0x80;
    expect(() => parseDerSignature(negative)).toThrow(/负数/);
  });

  it("DER 的 r/s 与大端解析一致", () => {
    const parsed = parseDerSignature(hexToBytes(FORUM_SIGNATURE_VECTOR));
    const good = hexToBytes(FORUM_SIGNATURE_VECTOR);
    expect(bytesToBigInt(good.subarray(4, 4 + (good[3] as number)))).toBe(parsed.r);
  });
});

describe("确定性 CBOR head（与服务端 internal/protocol/uint.go 对齐）", () => {
  it("uint64 边界在最短 head 形式下往返一致", async () => {
    const { cborUint, encodeCbor, decodeCbor, CBOR_UINT } = await import("./cbor.js");
    for (const value of CBOR_BOUNDARY_INTEGERS) {
      const encoded = encodeCbor(cborUint(value));
      const decoded = decodeCbor(encoded);
      expect(decoded.kind).toBe(CBOR_UINT);
      expect(decoded.kind === CBOR_UINT ? decoded.uint : undefined).toBe(value);
    }
  });

  it("uint64 最大值使用八字节 head", async () => {
    const { cborUint, encodeCbor } = await import("./cbor.js");
    expect(bytesToHex(encodeCbor(cborUint(0xffffffffffffffffn)))).toBe(CBOR_MAX_UINT64_VECTOR);
  });

  it("非最短 head 一律拒绝而不是被重新编码", async () => {
    const { decodeCbor } = await import("./cbor.js");
    for (const vector of CBOR_NON_CANONICAL_VECTORS) {
      expect(() => decodeCbor(hexToBytes(vector))).toThrow(ProtocolEncodingError);
    }
  });

  it("拒绝负整数、不定长、尾随字节、map 与 simple/float", async () => {
    const { decodeCbor } = await import("./cbor.js");
    expect(() => decodeCbor(hexToBytes("20"))).toThrow(/负整数/);
    expect(() => decodeCbor(hexToBytes("5f42010243030405ff"))).toThrow(/不定长/);
    expect(() => decodeCbor(hexToBytes("0000"))).toThrow(/尾随/);
    expect(() => decodeCbor(hexToBytes("a10101"))).toThrow(/major type/);
    expect(() => decodeCbor(hexToBytes("f4"))).toThrow(/major type/);
    expect(() => decodeCbor(hexToBytes(""))).toThrow(/至少/);
  });
});

describe("链上整数：最短无符号大端", () => {
  it("与 Go 的 EncodeMinimalUint 逐个对齐", async () => {
    const { encodeMinimalUint, parseMinimalUint } = await import("./script.js");
    for (const [value, hex] of MINIMAL_UINT_VECTORS) {
      expect(bytesToHex(encodeMinimalUint(value))).toBe(hex);
      expect(parseMinimalUint(hexToBytes(hex))).toBe(value);
    }
  });

  it("拒绝非最短形式与超长形式", async () => {
    const { parseMinimalUint } = await import("./script.js");
    expect(() => parseMinimalUint(hexToBytes("0000"))).toThrow(/零字节/);
    expect(() => parseMinimalUint(hexToBytes("000001"))).toThrow(/零字节/);
    expect(() => parseMinimalUint(hexToBytes("01000000000000000000"))).toThrow(/8 字节/);
    expect(() => parseMinimalUint(hexToBytes(""))).toThrow(/至少/);
  });
});

describe("创世 forumSig 黄金向量（TS ↔ Go 逐字节一致）", () => {
  it("CBOR 编码与服务端向量完全相同", async () => {
    const { encodeForumSignatureObject } = await import("./signatureObjects.js");
    const encoded = encodeForumSignatureObject({
      kind: "bsv8.forum.1",
      forumName: "bsv8 论坛",
      tipPrice: 4n,
      inputs: [{ txid: filledHash(0x01), vout: 0 }],
    });
    expect(bytesToHex(encoded)).toBe(FORUM_OBJECT_VECTOR);
  });

  it("八个边界 input 的 head 与服务端向量完全相同", async () => {
    const { encodeForumSignatureObject } = await import("./signatureObjects.js");
    const inputs = Array.from({ length: 8 }, (_unused, index) => ({
      txid: Uint8Array.from({ length: HASH_BYTES }, (_byte, offset) => index * 0x20 + offset),
      vout: [0, 23, 24, 255, 256, 65535, 65536, 0xffffffff][index] as number,
    }));
    expect(bytesToHex(encodeForumSignatureObject({ kind: "bsv8.forum.1", forumName: "v", tipPrice: 1n, inputs }))).toBe(
      FORUM_INPUTS_VECTOR,
    );
  });

  it("对同一对象签名，产出的 DER 与服务端 RFC 6979 向量相同", async () => {
    const { signForumSignatureObject } = await import("./signatureObjects.js");
    const signature = await signForumSignatureObject(
      {
        kind: "bsv8.forum.1",
        forumName: "bsv8 论坛",
        tipPrice: 4n,
        inputs: [{ txid: filledHash(0x01), vout: 0 }],
      },
      localSigningPort(hexToBytes("11".repeat(32))),
      hash,
    );
    expect(bytesToHex(signature)).toBe(FORUM_SIGNATURE_VECTOR);
  });

  it("解码自己编码的对象，并拒绝三项旧形式", async () => {
    const { decodeForumSignatureObject, encodeForumSignatureObject } = await import("./signatureObjects.js");
    const encoded = encodeForumSignatureObject({
      kind: "bsv8.forum.1",
      forumName: "bsv8 论坛",
      tipPrice: 4n,
      inputs: [{ txid: filledHash(0x01), vout: 0 }],
    });
    expect(decodeForumSignatureObject(encoded)).toEqual({
      kind: "bsv8.forum.1",
      forumName: "bsv8 论坛",
      tipPrice: 4n,
      inputs: [{ txid: filledHash(0x01), vout: 0 }],
    });
    // 旧三项形式没有 input 列表，必须被拒绝而不是兼容。
    const { cborArray, cborText, cborUint, encodeCborArray } = await import("./cbor.js");
    const legacy = encodeCborArray([cborText("bsv8.forum.1"), cborText("bsv8 论坛"), cborUint(4)]);
    expect(() => decodeForumSignatureObject(legacy)).toThrow(/4 项数组/);
    // 空 input 列表和重复 outpoint 都被拒绝。
    const empty = encodeCborArray([cborText("bsv8.forum.1"), cborText("x"), cborUint(1), cborArray([])]);
    expect(() => decodeForumSignatureObject(empty)).toThrow(/input/);
  });
});

/**
 * 只用于向量的本地签名端口；生产路径永远走 Vault Worker。
 *
 * @noble/curves v2 的 `sign` 即使给 `der: true` 也返回 64 字节 r‖s，所以 DER
 * 封装在这里做，顺便让本模块的严格 DER 规则成为测试的一部分。
 */
export function localSigningPort(privateKey: Uint8Array) {
  return {
    async signDigest(digest: Uint8Array): Promise<Uint8Array> {
      const raw = secp256k1.sign(digest, privateKey, { prehash: false, lowS: true });
      const r = bytesToBigInt(raw.subarray(0, 32));
      const s = bytesToBigInt(raw.subarray(32, 64));
      return encodeDer(r, s);
    },
    async verifyDigest(publicKey: Uint8Array, digest: Uint8Array, signature: Uint8Array): Promise<boolean> {
      try {
        const { r, s } = parseDerSignature(signature);
        return secp256k1.verify(
          Uint8Array.from([...bigIntToBytes(r, 32), ...bigIntToBytes(s, 32)]),
          digest,
          publicKey,
          { prehash: false, lowS: true },
        );
      } catch {
        return false;
      }
    },
  };
}

function bigIntToBytes(value: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let rest = value;
  for (let index = length - 1; index >= 0; index -= 1) {
    out[index] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}