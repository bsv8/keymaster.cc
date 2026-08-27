// packages/plugin-msfile/src/frameCodec.test.ts
// KMMF-002 必测项：Header 上限、uvarint 溢出/非最短、attachment 截断、
// 额外字段、uint64 边界、错误 UTF-8、逐字节分片、毒化语义。

import { describe, expect, it } from "vitest";
import {
  DEFAULT_FRAME_LIMITS,
  FrameDecoder,
  RequestIdCounter,
  WireCodecError,
  cborArrayHeader,
  cborByteString,
  cborTextString,
  cborUint,
  decodeUvarint,
  encodeReadRequest,
  encodeStatRequest,
  encodeUvarint,
} from "./frameCodec.js";

const HASH_A = new Uint8Array(32).fill(0xaa);
const HASH_B = new Uint8Array(32).fill(0xbb);

function bytes(...parts: Array<number | Uint8Array>): Uint8Array {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === "number") out.push(part);
    else for (const b of part) out.push(b);
  }
  return Uint8Array.from(out);
}

function wrap(header: Uint8Array): Uint8Array {
  return bytes(encodeUvarint(header.length), header);
}

function statRequestHeader(requestId = 7n): Uint8Array {
  return bytes(cborArrayHeader(4), cborUint(1), cborUint(1), cborUint(requestId), cborByteString(HASH_A));
}

function readRequestHeader(requestId = 9n, maxPrice = 100n): Uint8Array {
  return bytes(
    cborArrayHeader(5),
    cborUint(1),
    cborUint(3),
    cborUint(requestId),
    cborByteString(HASH_B),
    cborUint(maxPrice)
  );
}

function readResponseHeader(requestId: bigint, contentLength: number): Uint8Array {
  return bytes(
    cborArrayHeader(5),
    cborUint(1),
    cborUint(4),
    cborUint(requestId),
    cborByteString(HASH_B),
    cborUint(BigInt(contentLength))
  );
}

function decodeAll(frames: Uint8Array[]): ReturnType<FrameDecoder["takeMessages"]> {
  const decoder = new FrameDecoder();
  decoder.push(bytes(...frames));
  return decoder.takeMessages();
}

describe("uvarint", () => {
  it("roundtrips values", () => {
    for (const value of [1n, 127n, 128n, 16383n, 16384n, 65535n, 65536n]) {
      const encoded = encodeUvarint(value);
      expect(encoded.length).toBeLessThanOrEqual(3);
      expect(decodeUvarint(encoded, 0)).toEqual({ value, bytesRead: encoded.length });
    }
  });

  it("rejects non-minimal encodings", () => {
    // 0x80 0x00 编码 0，非最短。
    expect(() => decodeUvarint(Uint8Array.of(0x80, 0x00), 0)).toThrow(WireCodecError);
    // 0x81 0x80 0x00 非最短。
    expect(() => decodeUvarint(Uint8Array.of(0x81, 0x80, 0x00), 0)).toThrow(WireCodecError);
  });

  it("rejects more than 3 bytes", () => {
    expect(() => decodeUvarint(Uint8Array.of(0xff, 0xff, 0xff, 0x7f), 0)).toThrow(WireCodecError);
  });

  it("returns undefined when incomplete", () => {
    expect(decodeUvarint(Uint8Array.of(0x80), 0)).toBeUndefined();
  });
});

describe("frame encoding", () => {
  it("encodes a stat request", () => {
    const frame = encodeStatRequest(41n, HASH_A);
    expect(frame[0]).toBe(statRequestHeader(41n).length); // 单字节 uvarint
    const messages = decodeAll([frame]);
    expect(messages).toEqual([{ kind: "stat-request", requestId: 41n, seedHash: HASH_A }]);
  });

  it("encodes a read request with uint64 boundary price", () => {
    const frame = encodeReadRequest(1n, HASH_B, 0xffffffffffffffffn);
    const messages = decodeAll([frame]);
    expect(messages[0]).toMatchObject({ kind: "read-request", requestId: 1n, maxPriceSatoshis: 0xffffffffffffffffn });
  });

  it("rejects price above uint64 and zero request ids", () => {
    expect(() => encodeReadRequest(1n, HASH_B, 0x10000000000000000n)).toThrow(WireCodecError);
    expect(() => encodeReadRequest(0n, HASH_B, 1n)).toThrow(WireCodecError);
    expect(() => encodeStatRequest(0n, HASH_A)).toThrow(WireCodecError);
  });

  it("rejects hashes that are not 32 bytes", () => {
    expect(() => encodeStatRequest(1n, HASH_A.subarray(0, 31))).toThrow(WireCodecError);
  });
});

describe("header schema enforcement", () => {
  it("rejects wrong wire_version", () => {
    const header = bytes(cborArrayHeader(4), cborUint(2), cborUint(1), cborUint(7n), cborByteString(HASH_A));
    expect(() => decodeAll([wrap(header)])).toThrow(/wire_version/);
  });

  it("rejects unknown wire_kind", () => {
    const header = bytes(cborArrayHeader(4), cborUint(1), cborUint(99), cborUint(7n), cborByteString(HASH_A));
    expect(() => decodeAll([wrap(header)])).toThrow(/wire_kind/);
  });

  it("rejects extra array elements", () => {
    const header = bytes(
      cborArrayHeader(5),
      cborUint(1),
      cborUint(1),
      cborUint(7n),
      cborByteString(HASH_A),
      cborUint(0)
    );
    expect(() => decodeAll([wrap(header)])).toThrow(/field count/);
  });

  it("rejects missing elements", () => {
    const header = bytes(cborArrayHeader(3), cborUint(1), cborUint(1), cborUint(7n));
    expect(() => decodeAll([wrap(header)])).toThrow(/field count/);
  });

  it("rejects map / tagged / float headers and indefinite arrays", () => {
    // major 5 = map
    const mapHeader = wrap(bytes(new Uint8Array([0xa1]), cborUint(1), cborUint(2)));
    expect(() => decodeAll([mapHeader])).toThrow(WireCodecError);
    // indefinite-length array 0x9f ... 0xff
    const indefinite = wrap(bytes(new Uint8Array([0x9f]), cborUint(1), cborUint(1), cborUint(7n), cborByteString(HASH_A), new Uint8Array([0xff])));
    expect(() => decodeAll([indefinite])).toThrow(WireCodecError);
  });

  it("rejects non-minimal CBOR integers", () => {
    // 0x18 0x07 是 7 的非最短编码。
    const header = bytes(cborArrayHeader(4), cborUint(1), cborUint(1), new Uint8Array([0x18, 0x07]), cborByteString(HASH_A));
    expect(() => decodeAll([wrap(header)])).toThrow(/non-minimal/);
  });

  it("rejects trailing bytes inside the declared header", () => {
    const header = statRequestHeader();
    const padded = bytes(header, cborUint(0));
    const framed = bytes(encodeUvarint(padded.length), padded);
    expect(() => decodeAll([framed])).toThrow(/trailing|unsupported|expected/i);
  });

  it("rejects zero request ids", () => {
    const header = statRequestHeader(0n);
    expect(() => decodeAll([wrap(header)])).toThrow(/must not be 0/);
  });

  it("rejects zero request ids in every response kind（审查修复）", () => {
    // StatResponse id=0
    const statZero = bytes(cborArrayHeader(4), cborUint(1), cborUint(2), cborUint(0), cborUint(2));
    expect(() => decodeAll([wrap(statZero)])).toThrow(/must not be 0/);
    // ReadResponse id=0
    const readZero = bytes(
      cborArrayHeader(5), cborUint(1), cborUint(4), cborUint(0), cborByteString(HASH_B), cborUint(0)
    );
    expect(() => decodeAll([wrap(readZero)])).toThrow(/must not be 0/);
    // ReadCancelled id=0
    const cancelZero = bytes(cborArrayHeader(5), cborUint(1), cborUint(5), cborUint(0), cborByteString(HASH_B), cborUint(1));
    expect(() => decodeAll([wrap(cancelZero)])).toThrow(/must not be 0/);
    // ErrorResponse id=0
    const errorZero = bytes(
      cborArrayHeader(7), cborUint(1), cborUint(255), cborUint(3), cborUint(0),
      cborTextString("bad_request"), cborTextString(""), cborUint(0)
    );
    expect(() => decodeAll([wrap(errorZero)])).toThrow(/must not be 0/);
  });

  it("rejects non-ASCII media_type（§6.3，审查修复）", () => {
    const header = bytes(
      cborArrayHeader(7), cborUint(1), cborUint(2), cborUint(5n), cborUint(1),
      cborTextString("a.bin"), cborUint(1n), cborTextString("video/mpé")
    );
    expect(() => decodeAll([wrap(header)])).toThrow(/ASCII/);
  });
});

describe("stat response schemas", () => {
  it("decodes available", () => {
    const header = bytes(
      cborArrayHeader(7), cborUint(1), cborUint(2), cborUint(5n), cborUint(1),
      cborTextString("movie.mp4"), cborUint(1048576n), cborTextString("video/mp4")
    );
    const messages = decodeAll([wrap(header)]);
    expect(messages).toEqual([{
      kind: "stat-response",
      requestId: 5n,
      payload: { status: 1, recommendedFilename: "movie.mp4", fileSizeBytes: 1048576n, mediaType: "video/mp4" },
    }]);
  });

  it("decodes absent", () => {
    const header = bytes(cborArrayHeader(4), cborUint(1), cborUint(2), cborUint(5n), cborUint(2));
    expect(decodeAll([wrap(header)])).toEqual([{ kind: "stat-response", requestId: 5n, payload: { status: 2 } }]);
  });

  it("decodes discovering and bounds retry_after_ms", () => {
    const ok = bytes(cborArrayHeader(5), cborUint(1), cborUint(2), cborUint(5n), cborUint(3), cborUint(1500));
    expect(decodeAll([wrap(ok)])).toEqual([{ kind: "stat-response", requestId: 5n, payload: { status: 3, retryAfterMs: 1500 } }]);
    const tooBig = bytes(cborArrayHeader(5), cborUint(1), cborUint(2), cborUint(5n), cborUint(3), cborUint(3600001));
    expect(() => decodeAll([wrap(tooBig)])).toThrow(/retry_after_ms/);
  });

  it("decodes quoted and rejects min > max prices", () => {
    const header = bytes(
      cborArrayHeader(11), cborUint(1), cborUint(2), cborUint(5n), cborUint(4),
      cborTextString("a.bin"), cborUint(4096n), cborTextString(""),
      cborUint(10n), cborUint(20n), cborUint(1n), cborUint(2n)
    );
    const messages = decodeAll([wrap(header)]);
    expect(messages[0]).toMatchObject({ kind: "stat-response", payload: { status: 4, minSeedPriceSatoshis: 10n, maxFullBlockPriceSatoshis: 2n } });

    const inverted = bytes(
      cborArrayHeader(11), cborUint(1), cborUint(2), cborUint(5n), cborUint(4),
      cborTextString("a.bin"), cborUint(4096n), cborTextString(""),
      cborUint(30n), cborUint(20n), cborUint(1n), cborUint(2n)
    );
    expect(() => decodeAll([wrap(inverted)])).toThrow(/minimum exceeds maximum/);
  });

  it("validates recommended_filename rules", () => {
    const base = (...nameBytes: Uint8Array[]) =>
      bytes(cborArrayHeader(7), cborUint(1), cborUint(2), cborUint(5n), cborUint(1), ...nameBytes, cborUint(1024n), cborTextString(""));
    // 路径分隔符与控制字符。
    expect(() => decodeAll([wrap(base(cborTextString("a/b.mp4")))])).toThrow(/forbidden|basename/);
    expect(() => decodeAll([wrap(base(cborTextString("a\\b.mp4")))])).toThrow(/forbidden/);
    expect(() => decodeAll([wrap(base(cborTextString("a\u0000b")))])).toThrow(/forbidden/);
    // 单个 "." / ".." 不是合法 basename。
    expect(() => decodeAll([wrap(base(cborTextString("..")))])).toThrow(/basename/);
    expect(() => decodeAll([wrap(base(cborTextString(".")))])).toThrow(/basename/);
    // 恰好 255 字节合法；256 字节拒绝。
    expect(() => decodeAll([wrap(base(cborTextString("f".repeat(255))))])).not.toThrow();
    expect(() => decodeAll([wrap(base(cborTextString("f".repeat(256))))])).toThrow(/255/);
  });

  it("rejects invalid UTF-8 in media_type", () => {
    const header = bytes(
      cborArrayHeader(7), cborUint(1), cborUint(2), cborUint(5n), cborUint(1),
      cborTextString("a.bin"), cborUint(1n), new Uint8Array([0x63, 0xff, 0xfe, 0xfd])
    );
    expect(() => decodeAll([wrap(header)])).toThrow(/UTF-8/);
  });});

describe("read response / cancelled / error schemas", () => {
  it("decodes read response with attachment", () => {
    const payload = Uint8Array.from([1, 2, 3, 4]);
    const frame = bytes(wrap(readResponseHeader(3n, payload.length)), payload);
    const messages = decodeAll([frame]);
    expect(messages).toEqual([{
      kind: "read-response",
      requestId: 3n,
      contentHash: HASH_B,
      contentLength: 4n,
      attachment: payload,
    }]);
  });

  it("decodes read-cancelled only when replaced_by is larger", () => {
    const good = bytes(cborArrayHeader(5), cborUint(1), cborUint(5), cborUint(200n), cborByteString(HASH_B), cborUint(201n));
    expect(decodeAll([wrap(good)])) .toEqual([{ kind: "read-cancelled", requestId: 200n, contentHash: HASH_B, replacedByRequestId: 201n }]);
    const bad = bytes(cborArrayHeader(5), cborUint(1), cborUint(5), cborUint(200n), cborByteString(HASH_B), cborUint(200n));
    expect(() => decodeAll([wrap(bad)])).toThrow(/larger/);
  });

  it("decodes error response and enforces code/message constraints", () => {
    const good = bytes(
      cborArrayHeader(7), cborUint(1), cborUint(255), cborUint(3), cborUint(200n),
      cborTextString("price_limit_exceeded"), cborTextString(""), cborUint(0)
    );
    expect(decodeAll([wrap(good)])).toEqual([{
      kind: "error-response",
      requestKind: 3,
      requestId: 200n,
      errorCode: "price_limit_exceeded",
      errorMessage: "",
      retryAfterMs: 0,
    }]);

    const upperCode = bytes(
      cborArrayHeader(7), cborUint(1), cborUint(255), cborUint(3), cborUint(200n),
      cborTextString("PRICE_LIMIT_EXCEEDED"), cborTextString(""), cborUint(0)
    );
    expect(() => decodeAll([wrap(upperCode)])).toThrow(/lower-case ascii/);

    const badKind = bytes(
      cborArrayHeader(7), cborUint(1), cborUint(255), cborUint(2), cborUint(200n),
      cborTextString("bad_request"), cborTextString(""), cborUint(0)
    );
    expect(() => decodeAll([wrap(badKind)])).toThrow(/request_kind/);

    const longMessage = bytes(
      cborArrayHeader(7), cborUint(1), cborUint(255), cborUint(3), cborUint(200n),
      cborTextString("internal_error"), cborTextString("x".repeat(1025)), cborUint(0)
    );
    expect(() => decodeAll([wrap(longMessage)])).toThrow(/1024/);

    const hugeRetry = bytes(
      cborArrayHeader(7), cborUint(1), cborUint(255), cborUint(3), cborUint(200n),
      cborTextString("rate_limited"), cborTextString(""), cborUint(3600001)
    );
    expect(() => decodeAll([wrap(hugeRetry)])).toThrow(/retry_after_ms/);
  });
});

describe("incremental decoding", () => {
  it("buffers partial frames and completes them later", () => {
    const decoder = new FrameDecoder();
    const fullFrame = encodeStatRequest(11n, HASH_A);
    decoder.push(fullFrame.subarray(0, 3));
    expect(decoder.takeMessages()).toEqual([]);
    decoder.push(fullFrame.subarray(3));
    expect(decoder.takeMessages()).toEqual([{ kind: "stat-request", requestId: 11n, seedHash: HASH_A }]);
  });

  it("decodes across single-byte pushes including attachments", () => {
    const decoder = new FrameDecoder();
    const payload = Uint8Array.from([9, 8, 7, 6, 5]);
    const frame = bytes(wrap(readResponseHeader(4n, payload.length)), payload);
    for (const byte of frame) decoder.push(Uint8Array.of(byte));
    expect(decoder.takeMessages()[0]).toMatchObject({ kind: "read-response", attachment: payload });
  });

  it("handles two adjacent frames without swallowing boundaries", () => {
    const f1 = encodeStatRequest(1n, HASH_A);
    const payload = Uint8Array.from([1]);
    const f2 = bytes(wrap(readResponseHeader(2n, 1)), payload);
    const messages = decodeAll([f1, f2]);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.kind).toBe("stat-request");
    expect((messages[1] as { attachment?: Uint8Array }).attachment).toEqual(payload);
  });

  it("keeps trailing bytes belonging to the next frame", () => {
    const decoder = new FrameDecoder();
    const f1 = encodeStatRequest(1n, HASH_A);
    const f2 = encodeStatRequest(2n, HASH_B);
    decoder.push(bytes(f1, f2.subarray(0, 4)));
    expect(decoder.takeMessages()).toHaveLength(1);
    decoder.push(f2.subarray(4));
    expect(decoder.takeMessages()).toHaveLength(1);
  });

  it("waits for truncated attachments instead of failing", () => {
    const decoder = new FrameDecoder();
    const payload = Uint8Array.from([1, 2, 3]);
    const frame = bytes(wrap(readResponseHeader(6n, 3)), payload.subarray(0, 2));
    decoder.push(frame);
    expect(decoder.takeMessages()).toEqual([]);
    decoder.push(Uint8Array.of(3));
    expect(decoder.takeMessages()[0]).toMatchObject({ kind: "read-response", attachment: payload });
  });

  it("accepts empty attachments (zero-length seed)", () => {
    const messages = decodeAll([wrap(readResponseHeader(8n, 0))]);
    expect(messages[0]).toMatchObject({ kind: "read-response", contentLength: 0n, attachment: new Uint8Array(0) });
  });
});

describe("limits and poisoning", () => {
  it("rejects header length above the limit", () => {
    const oversized = bytes(encodeUvarint(65537n), new Uint8Array(16));
    expect(() => decodeAll([oversized])).toThrow(/out of range/);
  });

  it("rejects zero header length", () => {
    expect(() => decodeAll([Uint8Array.of(0x00)])).toThrow(WireCodecError);
  });

  it("rejects attachments above the configured limit and poisons the decoder", () => {
    const decoder = new FrameDecoder({ maxHeaderBytes: 65536, maxAttachmentBytes: 4 });
    const frame = bytes(wrap(readResponseHeader(1n, 5)), Uint8Array.from([1, 2, 3, 4, 5]));
    expect(() => decoder.push(frame)).toThrow(/exceeds maximum size/);
    expect(decoder.failed).toBe(true);
    expect(() => decoder.push(Uint8Array.of(0))).toThrow(/exceeds maximum size/);
  });

  it("poisons the decoder after a framing violation", () => {
    const decoder = new FrameDecoder();
    expect(() => decoder.push(Uint8Array.of(0xff, 0xff, 0xff, 0xff))).toThrow(WireCodecError);
    expect(decoder.failed).toBe(true);
  });

  it("honors custom small header limits", () => {
    const decoder = new FrameDecoder({ maxHeaderBytes: 8, maxAttachmentBytes: 16 });
    const frame = encodeStatRequest(1n, HASH_A);
    expect(() => decoder.push(frame)).toThrow(/out of range/);
    void DEFAULT_FRAME_LIMITS;
  });
});

describe("request id counter", () => {
  it("increments monotonically from 1", () => {
    const counter = new RequestIdCounter();
    expect(counter.take()).toBe(1n);
    expect(counter.take()).toBe(2n);
    expect(counter.peek()).toBe(3n);
  });

  it("throws instead of wrapping around at 2^64-1", () => {
    const counter = new RequestIdCounter();
    // 直接把内部计数推到边界。
    (counter as unknown as { nextId: bigint }).nextId = 0xffffffffffffffffn;
    expect(counter.take()).toBe(0xffffffffffffffffn);
    expect(() => counter.take()).toThrow(/rebuild connection/);
  });
});
