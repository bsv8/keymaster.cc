// 原生媒体 HTTP Range 契约的纯函数实现。
//
// 这里不读取网络，也不接触 Service Worker。所有字节区间都使用半开区间
// [startByte, endByteExclusive) 表示，只有生成 HTTP 头时才转换为闭区间。

export type MsFileRangeInvalidReason =
  | "invalid-header"
  | "multiple-ranges"
  | "invalid-number"
  | "zero-suffix"
  | "out-of-bounds"
  | "reversed";

export type MsFileRangeParseResult =
  | { kind: "none" }
  | {
      kind: "range";
      /** 请求起点，包含该字节。 */
      startByte: number;
      /** 请求终点，不包含该字节。 */
      endByteExclusive: number;
      /** HTTP Content-Range 使用的闭区间起点。 */
      startByteInclusive: number;
      /** HTTP Content-Range 使用的闭区间终点。 */
      endByteInclusive: number;
    }
  | { kind: "invalid"; reason: MsFileRangeInvalidReason };

export interface MsFileRangeResponseDescription {
  /** HTTP 状态码：无 Range 为 200、单 Range 为 206、非法 Range 为 416。 */
  status: 200 | 206 | 416;
  /** 文件总长度。 */
  totalBytes: number;
  /** 响应正文起点，包含该字节；416 没有正文时为空。 */
  startByte: number;
  /** 响应正文终点，不包含该字节。 */
  endByteExclusive: number;
  /** 精确响应正文长度。 */
  contentLength: number;
  /** 仅 206/416 使用的 Content-Range。 */
  contentRange?: string;
  /** 产生 416 的稳定原因，不能包含原始请求内容。 */
  invalidReason?: MsFileRangeInvalidReason;
}

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function safeTotal(totalBytes: number): boolean {
  return Number.isSafeInteger(totalBytes) && totalBytes >= 0;
}

function parseSafeInteger(value: string): number | undefined {
  if (!/^[0-9]+$/.test(value)) return undefined;
  try {
    const parsed = BigInt(value);
    if (parsed > MAX_SAFE_BIGINT) return undefined;
    return Number(parsed);
  } catch {
    return undefined;
  }
}

/**
 * 解析单个 bytes Range。
 *
 * 首版明确拒绝 multipart Range；缺少 Range 头和非法 Range 是两个不同状态，
 * 前者产生 200，后者必须由调用方产生 416。
 */
export function parseSingleByteRange(
  rangeHeader: string | null | undefined,
  totalBytes: number,
): MsFileRangeParseResult {
  if (!safeTotal(totalBytes)) return { kind: "invalid", reason: "invalid-number" };
  if (rangeHeader === undefined || rangeHeader === null) return { kind: "none" };

  const header = rangeHeader.trim();
  if (!header.startsWith("bytes=")) return { kind: "invalid", reason: "invalid-header" };
  const value = header.slice("bytes=".length);
  if (value.length === 0) return { kind: "invalid", reason: "invalid-header" };
  if (value.includes(",")) return { kind: "invalid", reason: "multiple-ranges" };

  const separator = value.indexOf("-");
  if (separator < 0 || separator !== value.lastIndexOf("-")) {
    return { kind: "invalid", reason: "invalid-header" };
  }
  const startText = value.slice(0, separator);
  const endText = value.slice(separator + 1);

  // suffix-byte-range-spec：bytes=-N。
  if (startText.length === 0) {
    const suffixLength = parseSafeInteger(endText);
    if (suffixLength === undefined) return { kind: "invalid", reason: "invalid-number" };
    if (suffixLength === 0) return { kind: "invalid", reason: "zero-suffix" };
    if (totalBytes === 0) return { kind: "invalid", reason: "out-of-bounds" };
    const startByte = suffixLength >= totalBytes ? 0 : totalBytes - suffixLength;
    return {
      kind: "range",
      startByte,
      endByteExclusive: totalBytes,
      startByteInclusive: startByte,
      endByteInclusive: totalBytes - 1,
    };
  }

  const startByte = parseSafeInteger(startText);
  if (startByte === undefined) return { kind: "invalid", reason: "invalid-number" };

  // bytes=N-：从 N 读取到文件末尾。
  if (endText.length === 0) {
    if (startByte >= totalBytes) return { kind: "invalid", reason: "out-of-bounds" };
    return {
      kind: "range",
      startByte,
      endByteExclusive: totalBytes,
      startByteInclusive: startByte,
      endByteInclusive: totalBytes - 1,
    };
  }

  const endByteInclusive = parseSafeInteger(endText);
  if (endByteInclusive === undefined) return { kind: "invalid", reason: "invalid-number" };
  if (endByteInclusive < startByte) return { kind: "invalid", reason: "reversed" };
  if (startByte >= totalBytes) return { kind: "invalid", reason: "out-of-bounds" };
  const clippedEndByteInclusive = Math.min(endByteInclusive, totalBytes - 1);
  return {
    kind: "range",
    startByte,
    endByteExclusive: clippedEndByteInclusive + 1,
    startByteInclusive: startByte,
    endByteInclusive: clippedEndByteInclusive,
  };
}

/** 把解析结果转换为 Range Host 需要的响应描述。 */
export function describeByteRange(
  totalBytes: number,
  rangeHeader: string | null | undefined,
): MsFileRangeResponseDescription {
  const parsed = parseSingleByteRange(rangeHeader, totalBytes);
  if (parsed.kind === "invalid") {
    return {
      status: 416,
      totalBytes,
      startByte: 0,
      endByteExclusive: 0,
      contentLength: 0,
      contentRange: `bytes */${String(totalBytes)}`,
      invalidReason: parsed.reason,
    };
  }
  if (parsed.kind === "none") {
    return {
      status: 200,
      totalBytes,
      startByte: 0,
      endByteExclusive: totalBytes,
      contentLength: totalBytes,
    };
  }
  return {
    status: 206,
    totalBytes,
    startByte: parsed.startByte,
    endByteExclusive: parsed.endByteExclusive,
    contentLength: parsed.endByteExclusive - parsed.startByte,
    contentRange: `bytes ${String(parsed.startByteInclusive)}-${String(parsed.endByteInclusive)}/${String(totalBytes)}`,
  };
}

