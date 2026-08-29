import { describe, expect, it } from "vitest";
import { describeByteRange, parseSingleByteRange } from "./rangeParser.js";

describe("MSFile 原生 Range parser", () => {
  it("支持无 Range、固定、开放和 suffix Range", () => {
    expect(describeByteRange(100, undefined)).toMatchObject({
      status: 200,
      startByte: 0,
      endByteExclusive: 100,
      contentLength: 100,
    });
    expect(describeByteRange(100, "bytes=10-19")).toMatchObject({
      status: 206,
      startByte: 10,
      endByteExclusive: 20,
      contentLength: 10,
      contentRange: "bytes 10-19/100",
    });
    expect(describeByteRange(100, "bytes=90-")).toMatchObject({
      status: 206,
      startByte: 90,
      endByteExclusive: 100,
      contentLength: 10,
      contentRange: "bytes 90-99/100",
    });
    expect(describeByteRange(100, "bytes=-12")).toMatchObject({
      status: 206,
      startByte: 88,
      endByteExclusive: 100,
      contentLength: 12,
      contentRange: "bytes 88-99/100",
    });
    // RFC 7233 允许固定 Range 的 end 超出文件末尾时裁剪到 EOF。
    expect(parseSingleByteRange("bytes=95-999", 100)).toMatchObject({
      kind: "range",
      startByte: 95,
      endByteExclusive: 100,
    });
  });

  it("拒绝多 Range、倒序、越界和零 suffix", () => {
    for (const header of ["bytes=0-1,4-5", "bytes=9-2", "bytes=100-", "bytes=-0", "items=0-1"]) {
      expect(describeByteRange(100, header)).toMatchObject({
        status: 416,
        contentLength: 0,
        contentRange: "bytes */100",
      });
    }
    expect(describeByteRange(0, "bytes=0-1")).toMatchObject({
      status: 416,
      contentRange: "bytes */0",
    });
  });
});
