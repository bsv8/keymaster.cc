// packages/plugin-msfile/src/frameCodec.ts
// `/msfile/1.0.0` Frame codec（wire 真值：MSFile Proxy Wire Messages v1）。
//
// 设计缘由（施工单 KMMF-002）：
//   - frame = header_length_uvarint || header_cbor(deterministic fixed array) || raw attachment；
//   - uvarint 必须最短编码且最多 3 字节，值域 1..65536；
//   - CBOR 拒绝非最短整数、indefinite 长度、map/tag/浮点、错误分支长度与额外元素；
//   - decoder 先验证 Header 与长度上限再分配 attachment；attachment 截断是错误，
//     多出的字节属于下一 Frame；
//   - 任何 wire 违规都会毒化 decoder：调用方必须重建 stream/connection。

export const MSFILE_WIRE_VERSION = 1;

export const WIRE_KIND_STAT_REQUEST = 1;
export const WIRE_KIND_STAT_RESPONSE = 2;
export const WIRE_KIND_READ_REQUEST = 3;
export const WIRE_KIND_READ_RESPONSE = 4;
export const WIRE_KIND_READ_CANCELLED = 5;
export const WIRE_KIND_ERROR_RESPONSE = 255;

const UINT64_MAX = 0xffffffffffffffffn;
const MAX_UVARINT_BYTES = 3;
const MAX_RETRY_AFTER_MS = 3_600_000;
export const MAX_ERROR_CODE_ASCII_BYTES = 64;
export const MAX_ERROR_MESSAGE_UTF8_BYTES = 1024;

/** Frame / 内容硬上限（与 contracts 保持一致的本地副本，便于独立测试）。 */
export interface MsFileFrameLimits {
  maxHeaderBytes: number;
  maxAttachmentBytes: number;
}

export const DEFAULT_FRAME_LIMITS: MsFileFrameLimits = {
  maxHeaderBytes: 65536,
  maxAttachmentBytes: 16 * 1024 * 1024,
};

const utf8Encoder = new TextEncoder();

function encodeUtf8(text: string): Uint8Array {
  return utf8Encoder.encode(text);
}

/** 违反 wire 规范的解码失败。transport 层必须按协议错误处理，不是 absent。 */
export class WireCodecError extends Error {
  constructor(
    public readonly reason:
      | "framing"
      | "uvarint"
      | "cbor"
      | "schema"
      | "attachment-limit"
      | "utf8",
    message: string
  ) {
    super(message);
    this.name = "WireCodecError";
  }
}

/* ============== uvarint ============== */

export function encodeUvarint(value: number | bigint): Uint8Array {
  let v = typeof value === "bigint" ? value : BigInt(Math.trunc(value));
  if (v < 0n || v > UINT64_MAX) throw new WireCodecError("uvarint", "value out of range");
  const out: number[] = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return Uint8Array.from(out);
}

export interface DecodedUvarint {
  value: bigint;
  bytesRead: number;
}

/**
 * 从 buffer 的 offset 开始解码一个 uvarint。
 * 数据不足返回 undefined；超长 / 溢出 / 非最短编码抛 {@link WireCodecError}。
 */
export function decodeUvarint(buffer: Uint8Array, offset: number): DecodedUvarint | undefined {
  let value = 0n;
  let shift = 0n;
  for (let length = 0; length < MAX_UVARINT_BYTES; length += 1) {
    const index = offset + length;
    if (index >= buffer.length) return undefined;
    const byte = buffer[index]!;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      if (length > 0 && (byte & 0x7f) === 0) throw new WireCodecError("uvarint", "non-minimal uvarint encoding");
      if (value === 0n) throw new WireCodecError("uvarint", "zero header length");
      return { value, bytesRead: length + 1 };
    }
    shift += 7n;
  }
  throw new WireCodecError("uvarint", "uvarint exceeds maximum length");
}

/* ============== deterministic CBOR 编码 ============== */

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function cborHead(major: number, value: bigint): Uint8Array {
  if (value < 0n || value > UINT64_MAX) throw new WireCodecError("cbor", "integer out of uint64 range");
  const m = major << 5;
  const v = Number(value);
  if (value < 24n) return Uint8Array.of(m | v);
  if (value <= 0xffn) return Uint8Array.of(m | 24, v);
  if (value <= 0xffffn) return Uint8Array.of(m | 25, v >> 8, v & 0xff);
  if (value <= 0xffffffffn) {
    return Uint8Array.of(m | 26, v >>> 24, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
  }
  return Uint8Array.of(
    m | 27,
    Number((value >> 56n) & 0xffn),
    Number((value >> 48n) & 0xffn),
    Number((value >> 40n) & 0xffn),
    Number((value >> 32n) & 0xffn),
    Number((value >> 24n) & 0xffn),
    Number((value >> 16n) & 0xffn),
    Number((value >> 8n) & 0xffn),
    Number(value & 0xffn)
  );
}

export function cborUint(value: number | bigint): Uint8Array {
  return cborHead(0, typeof value === "bigint" ? value : BigInt(Math.trunc(value)));
}

export function cborByteString(bytes: Uint8Array): Uint8Array {
  return concatBytes([cborHead(2, BigInt(bytes.length)), bytes]);
}

export function cborTextString(text: string): Uint8Array {
  return concatBytes([cborHead(3, BigInt(encodeUtf8(text).length)), encodeUtf8(text)]);
}

export function cborArrayHeader(length: number): Uint8Array {
  return cborHead(4, BigInt(length));
}

/* ============== 消息模型 ============== */

export type StatResponsePayload =
  | { status: 1; recommendedFilename: string; fileSizeBytes: bigint; mediaType: string }
  | { status: 2 }
  | { status: 3; retryAfterMs: number }
  | {
      status: 4;
      recommendedFilename: string;
      fileSizeBytes: bigint;
      mediaType: string;
      minSeedPriceSatoshis: bigint;
      maxSeedPriceSatoshis: bigint;
      minFullBlockPriceSatoshis: bigint;
      maxFullBlockPriceSatoshis: bigint;
    };

export type WireMessage =
  | { kind: "stat-request"; requestId: bigint; seedHash: Uint8Array }
  | { kind: "stat-response"; requestId: bigint; payload: StatResponsePayload }
  | { kind: "read-request"; requestId: bigint; contentHash: Uint8Array; maxPriceSatoshis: bigint }
  | {
      kind: "read-response";
      requestId: bigint;
      contentHash: Uint8Array;
      /** attachment 的精确字节数；attachment 字段在 decoder 完成读取后填充。 */
      contentLength: bigint;
      attachment?: Uint8Array;
    }
  | { kind: "read-cancelled"; requestId: bigint; contentHash: Uint8Array; replacedByRequestId: bigint }
  | {
      kind: "error-response";
      requestKind: 1 | 3;
      requestId: bigint;
      errorCode: string;
      errorMessage: string;
      retryAfterMs: number;
    };

type ParsedHeader =
  | { type: "complete"; message: WireMessage }
  | { type: "needs-attachment"; message: Extract<WireMessage, { kind: "read-response" }>; attachmentLength: bigint };

/* ============== CBOR 解码子集 ============== */

interface CborValue {
  major: number;
  uint?: bigint;
  bytes?: Uint8Array;
  text?: string;
  items?: CborValue[];
}

class CborReader {
  private offset = 0;

  constructor(private readonly buffer: Uint8Array) {}

  get position(): number {
    return this.offset;
  }

  private take(length: number): Uint8Array {
    if (this.offset + length > this.buffer.length) {
      throw new WireCodecError("cbor", "unexpected end of header");
    }
    const slice = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  private readHead(): { major: number; argument: bigint; info: number } {
    const first = this.take(1)[0]!;
    const major = first >> 5;
    const info = first & 0x1f;
    if (info < 24) return { major, argument: BigInt(info), info };
    const byteLength = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : -1;
    if (byteLength < 0) throw new WireCodecError("cbor", "indefinite lengths and reserved additional info are rejected");
    const bytes = this.take(byteLength);
    let argument = 0n;
    for (const byte of bytes) argument = (argument << 8n) | BigInt(byte);
    // RFC 8949 §4.2.1 最短形式检查。
    const minimal =
      (info === 24 && argument >= 24n) ||
      (info === 25 && argument > 0xffn) ||
      (info === 26 && argument > 0xffffn) ||
      (info === 27 && argument > 0xffffffffn);
    if (!minimal) throw new WireCodecError("cbor", "non-minimal integer encoding");
    return { major, argument, info };
  }

  readItem(): CborValue {
    const head = this.readHead();
    switch (head.major) {
      case 0: {
        if (head.argument > UINT64_MAX) throw new WireCodecError("cbor", "integer exceeds uint64");
        return { major: 0, uint: head.argument };
      }
      case 2: {
        const bytes = this.take(Number(head.argument)).slice();
        return { major: 2, bytes };
      }
      case 3: {
        const bytes = this.take(Number(head.argument));
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          throw new WireCodecError("utf8", "invalid UTF-8 in text string");
        }
        return { major: 3, text, bytes: bytes.slice() };
      }
      case 4: {
        const items: CborValue[] = [];
        for (let i = 0; i < Number(head.argument); i += 1) items.push(this.readItem());
        return { major: 4, items };
      }
      default:
        throw new WireCodecError("cbor", `unsupported CBOR major type ${head.major}`);
    }
  }
}

function asUint(item: CborValue | undefined, what: string, max: bigint = UINT64_MAX): bigint {
  if (item?.major !== 0 || item.uint === undefined) throw new WireCodecError("schema", `${what} must be an unsigned integer`);
  if (item.uint > max) throw new WireCodecError("schema", `${what} out of range`);
  return item.uint;
}

function asBstr32(item: CborValue | undefined, what: string): Uint8Array {
  if (item?.major !== 2 || item.bytes === undefined || item.bytes.length !== 32) {
    throw new WireCodecError("schema", `${what} must be a 32-byte byte string`);
  }
  return item.bytes;
}

function asText(item: CborValue | undefined, what: string): { text: string; byteLength: number } {
  if (item?.major !== 3 || item.text === undefined) throw new WireCodecError("schema", `${what} must be a text string`);
  return { text: item.text, byteLength: item.bytes?.length ?? 0 };
}

/** §6.2 recommended_filename：单个 basename，禁止分隔符 / 控制字符 / `.`、`..`。 */
function decodeFilename(item: CborValue | undefined): string {
  const { text, byteLength } = asText(item, "recommended_filename");
  if (byteLength > 255) throw new WireCodecError("schema", "recommended_filename exceeds 255 bytes");
  if (text.includes("/") || text.includes("\\") || text.includes("\0") || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw new WireCodecError("schema", "recommended_filename contains forbidden characters");
  }
  if (text === "." || text === "..") throw new WireCodecError("schema", "recommended_filename must be a basename");
  return text;
}

/** §6.3 media_type：ASCII MIME 提示；控制字符与非 ASCII 一律拒绝。 */
function decodeMediaType(item: CborValue | undefined): string {
  const { text, byteLength } = asText(item, "media_type");
  if (byteLength > 255) throw new WireCodecError("schema", "media_type exceeds 255 bytes");
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) throw new WireCodecError("schema", "media_type must be printable ASCII without control characters");
  }
  return text;
}

function assertRequestId(id: bigint, what: string): void {
  if (id < 1n) throw new WireCodecError("schema", `${what} must not be 0`);
  if (id > UINT64_MAX) throw new WireCodecError("schema", `${what} exceeds uint64`);
}

function decodeHeader(headerBytes: Uint8Array): ParsedHeader {
  const reader = new CborReader(headerBytes);
  const top = reader.readItem();
  if (top.major !== 4 || !top.items) throw new WireCodecError("schema", "header must be a definite-length array");
  if (reader.position !== headerBytes.length) throw new WireCodecError("schema", "trailing bytes after header array");
  const items = top.items;
  if (items.length < 2) throw new WireCodecError("schema", "header array too short");
  const version = asUint(items[0], "wire_version", 0xffffffffffffffffn);
  if (version !== 1n) throw new WireCodecError("schema", "unsupported wire_version");
  const kind = asUint(items[1], "wire_kind", 255n);

  switch (Number(kind)) {
    case WIRE_KIND_STAT_REQUEST: {
      if (items.length !== 4) throw new WireCodecError("schema", "StatRequest field count mismatch");
      const requestId = asUint(items[2], "stat_request_id");
      assertRequestId(requestId, "stat_request_id");
      return { type: "complete", message: { kind: "stat-request", requestId, seedHash: asBstr32(items[3], "seed_hash") } };
    }
    case WIRE_KIND_STAT_RESPONSE: {
      if (items.length < 4) throw new WireCodecError("schema", "StatResponse field count mismatch");
      const requestId = asUint(items[2], "stat_request_id");
      assertRequestId(requestId, "stat_request_id");
      const status = asUint(items[3], "stat status", 4n);
      if (status === 1n) {
        if (items.length !== 7) throw new WireCodecError("schema", "available StatResponse field count mismatch");
        return {
          type: "complete",
          message: {
            kind: "stat-response",
            requestId,
            payload: {
              status: 1,
              recommendedFilename: decodeFilename(items[4]),
              fileSizeBytes: asUint(items[5], "file_size_bytes"),
              mediaType: decodeMediaType(items[6]),
            },
          },
        };
      }
      if (status === 2n) {
        if (items.length !== 4) throw new WireCodecError("schema", "absent StatResponse field count mismatch");
        return { type: "complete", message: { kind: "stat-response", requestId, payload: { status: 2 } } };
      }
      if (status === 3n) {
        if (items.length !== 5) throw new WireCodecError("schema", "discovering StatResponse field count mismatch");
        return {
          type: "complete",
          message: {
            kind: "stat-response",
            requestId,
            payload: { status: 3, retryAfterMs: Number(asUint(items[4], "retry_after_ms", BigInt(MAX_RETRY_AFTER_MS))) },
          },
        };
      }
      if (items.length !== 11) throw new WireCodecError("schema", "quoted StatResponse field count mismatch");
      const payload = {
        status: 4 as const,
        recommendedFilename: decodeFilename(items[4]),
        fileSizeBytes: asUint(items[5], "file_size_bytes"),
        mediaType: decodeMediaType(items[6]),
        minSeedPriceSatoshis: asUint(items[7], "min_seed_price_satoshis"),
        maxSeedPriceSatoshis: asUint(items[8], "max_seed_price_satoshis"),
        minFullBlockPriceSatoshis: asUint(items[9], "min_full_block_price_satoshis"),
        maxFullBlockPriceSatoshis: asUint(items[10], "max_full_block_price_satoshis"),
      };
      if (payload.minSeedPriceSatoshis > payload.maxSeedPriceSatoshis || payload.minFullBlockPriceSatoshis > payload.maxFullBlockPriceSatoshis) {
        throw new WireCodecError("schema", "price minimum exceeds maximum");
      }
      return { type: "complete", message: { kind: "stat-response", requestId, payload } };
    }
    case WIRE_KIND_READ_REQUEST: {
      if (items.length !== 5) throw new WireCodecError("schema", "ReadRequest field count mismatch");
      const requestId = asUint(items[2], "read_request_id");
      assertRequestId(requestId, "read_request_id");
      return {
        type: "complete",
        message: {
          kind: "read-request",
          requestId,
          contentHash: asBstr32(items[3], "content_hash"),
          maxPriceSatoshis: asUint(items[4], "max_price_satoshis"),
        },
      };
    }
    case WIRE_KIND_READ_RESPONSE: {
      if (items.length !== 5) throw new WireCodecError("schema", "ReadResponse field count mismatch");
      const requestId = asUint(items[2], "read_request_id");
      assertRequestId(requestId, "read_request_id");
      const contentHash = asBstr32(items[3], "content_hash");
      const contentLength = asUint(items[4], "content_length");
      return {
        type: "needs-attachment",
        message: { kind: "read-response", requestId, contentHash, contentLength },
        attachmentLength: contentLength,
      };
    }
    case WIRE_KIND_READ_CANCELLED: {
      if (items.length !== 5) throw new WireCodecError("schema", "ReadCancelled field count mismatch");
      const requestId = asUint(items[2], "read_request_id");
      assertRequestId(requestId, "read_request_id");
      const replacedByRequestId = asUint(items[4], "replaced_by_request_id");
      if (replacedByRequestId <= requestId) throw new WireCodecError("schema", "replaced_by_request_id must be larger");
      return {
        type: "complete",
        message: { kind: "read-cancelled", requestId, contentHash: asBstr32(items[3], "content_hash"), replacedByRequestId },
      };
    }
    case WIRE_KIND_ERROR_RESPONSE: {
      if (items.length !== 7) throw new WireCodecError("schema", "ErrorResponse field count mismatch");
      const requestKind = asUint(items[2], "request_kind", 3n);
      if (requestKind !== 1n && requestKind !== 3n) throw new WireCodecError("schema", "error request_kind must be 1 or 3");
      assertRequestId(asUint(items[3], "request_id"), "request_id");
      const errorCodeEntry = asText(items[4], "error_code");
      if (errorCodeEntry.byteLength < 1 || errorCodeEntry.byteLength > MAX_ERROR_CODE_ASCII_BYTES || !/^[a-z0-9_]+$/.test(errorCodeEntry.text)) {
        throw new WireCodecError("schema", "error_code must be lower-case ascii up to 64 bytes");
      }
      const errorMessageEntry = asText(items[5], "error_message");
      if (errorMessageEntry.byteLength > MAX_ERROR_MESSAGE_UTF8_BYTES) {
        throw new WireCodecError("schema", "error_message exceeds 1024 bytes");
      }
      return {
        type: "complete",
        message: {
          kind: "error-response",
          requestKind: requestKind === 1n ? 1 : 3,
          requestId: asUint(items[3], "request_id"),
          errorCode: errorCodeEntry.text,
          errorMessage: errorMessageEntry.text,
          retryAfterMs: Number(asUint(items[6], "retry_after_ms", BigInt(MAX_RETRY_AFTER_MS))),
        },
      };
    }
    default:
      throw new WireCodecError("schema", `unknown wire_kind ${Number(kind)}`);
  }
}

/* ============== 编码入口 ============== */

function assertHashBytes(bytes: Uint8Array, what: string): void {
  if (bytes.length !== 32) throw new WireCodecError("schema", `${what} must be exactly 32 bytes`);
}

function wrapFrame(header: Uint8Array, limits: MsFileFrameLimits): Uint8Array {
  if (header.length < 1 || header.length > limits.maxHeaderBytes) {
    throw new WireCodecError("framing", "header length out of range");
  }
  return concatBytes([encodeUvarint(header.length), header]);
}

export function encodeStatRequest(
  statRequestId: bigint,
  seedHash: Uint8Array,
  limits: MsFileFrameLimits = DEFAULT_FRAME_LIMITS
): Uint8Array {
  assertRequestId(statRequestId, "stat_request_id");
  assertHashBytes(seedHash, "seed_hash");
  return wrapFrame(
    concatBytes([
      cborArrayHeader(4),
      cborUint(MSFILE_WIRE_VERSION),
      cborUint(WIRE_KIND_STAT_REQUEST),
      cborUint(statRequestId),
      cborByteString(seedHash),
    ]),
    limits
  );
}

export function encodeReadRequest(
  readRequestId: bigint,
  contentHash: Uint8Array,
  maxPriceSatoshis: bigint,
  limits: MsFileFrameLimits = DEFAULT_FRAME_LIMITS
): Uint8Array {
  assertRequestId(readRequestId, "read_request_id");
  assertHashBytes(contentHash, "content_hash");
  if (maxPriceSatoshis < 0n || maxPriceSatoshis > UINT64_MAX) throw new WireCodecError("schema", "max_price_satoshis out of range");
  return wrapFrame(
    concatBytes([
      cborArrayHeader(5),
      cborUint(MSFILE_WIRE_VERSION),
      cborUint(WIRE_KIND_READ_REQUEST),
      cborUint(readRequestId),
      cborByteString(contentHash),
      cborUint(maxPriceSatoshis),
    ]),
    limits
  );
}

/* ============== 增量 Frame decoder ============== */

/** 有界分片缓冲。只在凑齐目标字节数时才做一次合并拷贝。 */
class ChunkBuffer {
  private chunks: Uint8Array[] = [];
  private _length = 0;

  get length(): number {
    return this._length;
  }

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this._length += chunk.length;
  }

  /** 前 maxBytes 字节的连续视图（不消费）。数据不足时返回较短视图。 */
  peek(maxBytes: number): Uint8Array {
    if (this.chunks.length === 1) return this.chunks[0]!.subarray(0, Math.min(this.chunks[0]!.length, maxBytes));
    const view = new Uint8Array(Math.min(this._length, maxBytes));
    let offset = 0;
    for (const chunk of this.chunks) {
      if (offset >= view.length) break;
      const take = Math.min(chunk.length, view.length - offset);
      view.set(take === chunk.length ? chunk : chunk.subarray(0, take), offset);
      offset += take;
    }
    return view;
  }

  /** 消费并返回恰好 target 字节；缓冲不足时返回 undefined 且不消费。 */
  read(target: number): Uint8Array | undefined {
    if (target === 0) return new Uint8Array(0);
    if (this._length < target) return undefined;
    const merged = new Uint8Array(target);
    let offset = 0;
    let remaining = target;
    while (remaining > 0) {
      const head = this.chunks[0]!;
      const take = Math.min(head.length, remaining);
      merged.set(take === head.length ? head : head.subarray(0, take), offset);
      if (take === head.length) {
        this.chunks.shift();
      } else {
        this.chunks[0] = head.subarray(take);
      }
      this._length -= take;
      offset += take;
      remaining -= take;
    }
    return merged;
  }
}

/**
 * 增量 Frame decoder。
 *
 * 用法：`push(chunk)` 接收任意 transport 分片；每次 push 后用
 * `takeMessages()` 取出已完整解码的消息。任何 {@link WireCodecError} 之后
 * decoder 进入 failed 状态，必须丢弃并重建（对应重建 stream/connection）。
 */
export class FrameDecoder {
  private buffer = new ChunkBuffer();
  private queue: WireMessage[] = [];
  private failure: WireCodecError | undefined;
  private phase:
    | { stage: "header-length" }
    | { stage: "header"; declared: number }
    | { stage: "attachment"; declared: number; message: Extract<WireMessage, { kind: "read-response" }> } = { stage: "header-length" };

  constructor(private readonly limits: MsFileFrameLimits = DEFAULT_FRAME_LIMITS) {}

  get failed(): boolean {
    return this.failure !== undefined;
  }

  get bufferedBytes(): number {
    return this.buffer.length;
  }

  push(chunk: Uint8Array): void {
    if (this.failure) throw this.failure;
    try {
      this.buffer.push(chunk);
      this.extract();
    } catch (error) {
      if (error instanceof WireCodecError) {
        this.failure = error;
      }
      throw error;
    }
  }

  takeMessages(): WireMessage[] {
    if (this.failure) throw this.failure;
    const messages = this.queue;
    this.queue = [];
    return messages;
  }

  private extract(): void {
    for (;;) {
      if (this.phase.stage === "header-length") {
        const view = this.buffer.peek(MAX_UVARINT_BYTES);
        if (view.length === 0) return;
        const decoded = decodeUvarint(view, 0);
        if (decoded === undefined) return;
        const declared = Number(decoded.value);
        if (declared < 1 || declared > this.limits.maxHeaderBytes) {
          throw new WireCodecError("framing", "header length out of range");
        }
        this.buffer.read(decoded.bytesRead);
        this.phase = { stage: "header", declared };
        continue;
      }
      if (this.phase.stage === "header") {
        const headerBytes = this.buffer.read(this.phase.declared);
        if (headerBytes === undefined) return;
        this.phase = { stage: "header-length" };
        const parsed = decodeHeader(headerBytes);
        if (parsed.type === "complete") {
          this.queue.push(parsed.message);
          continue;
        }
        if (parsed.attachmentLength > BigInt(this.limits.maxAttachmentBytes)) {
          throw new WireCodecError("attachment-limit", "attachment exceeds maximum size");
        }
        if (parsed.attachmentLength === 0n) {
          this.queue.push({ ...parsed.message, attachment: new Uint8Array(0) });
          continue;
        }
        this.phase = { stage: "attachment", declared: Number(parsed.attachmentLength), message: parsed.message };
        continue;
      }
      const attachment = this.buffer.read(this.phase.declared);
      if (attachment === undefined) return;
      const message = this.phase.message;
      this.phase = { stage: "header-length" };
      this.queue.push({ ...message, attachment });
    }
  }
}

/** 单调递增 request ID 计数器。达到 2^64-1 后必须重建 connection，禁止回绕。 */
export class RequestIdCounter {
  private nextId = 1n;

  take(): bigint {
    const id = this.nextId;
    if (id > UINT64_MAX) throw new WireCodecError("schema", "request id space exhausted; rebuild connection");
    this.nextId += 1n;
    return id;
  }

  peek(): bigint {
    return this.nextId;
  }
}
