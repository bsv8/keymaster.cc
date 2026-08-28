import { describe, expect, it } from "vitest";
import { MsFileMediaError } from "./errors.js";
import { MsFileFiniteTimelineSource, MsFileLiveTestSource } from "./timeline.js";

describe("MediaTimelineSource", () => {
  it("copies finite initialization and segment bytes, then closes", async () => {
    const initBytes = new Uint8Array([1, 2]);
    const segmentBytes = new Uint8Array([3, 4]);
    const source = new MsFileFiniteTimelineSource({
      initialization: { mimeType: "video/webm", data: initBytes },
      segments: [{ sequence: 0, timestampSeconds: 0, durationSeconds: 1, data: segmentBytes }],
    });

    const initialization = await source.initialization(new AbortController().signal);
    initialization.data![0] = 9;
    const segments = [];
    for await (const segment of source.segments(new AbortController().signal)) {
      segments.push(segment);
      segment.data[0] = 9;
    }
    expect(initBytes[0]).toBe(1);
    expect(segmentBytes[0]).toBe(3);
    expect(segments[0]?.data[0]).toBe(9);

    await source.close();
    await expect(source.initialization(new AbortController().signal)).rejects.toMatchObject({ code: "msfile_media_cancelled" });
    const afterClose = [];
    for await (const segment of source.segments(new AbortController().signal)) afterClose.push(segment);
    expect(afterClose).toHaveLength(0);
  });

  it("keeps a bounded rolling window and marks discontinuities", async () => {
    const source = new MsFileLiveTestSource({
      segmentBytes: 4,
      segmentDurationSeconds: 0.5,
      rollingWindowSegments: 3,
      discontinuityEvery: 3,
      maxSegments: 7,
    });
    const segments = [];
    for await (const segment of source.segments(new AbortController().signal)) segments.push(segment);
    expect(segments.map((segment) => segment.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(segments[3]?.discontinuity).toBe(true);
    expect(segments[6]?.discontinuity).toBe(true);
    expect(source.rollingWindow()).toHaveLength(3);
    expect(source.rollingWindow().map((segment) => segment.sequence)).toEqual([4, 5, 6]);
    await source.close();
    expect(source.rollingWindow()).toHaveLength(0);
  });

  it("stops an infinite source at an Abort fence", async () => {
    const source = new MsFileLiveTestSource({ segmentBytes: 1 });
    const controller = new AbortController();
    const iterator = source.segments(controller.signal)[Symbol.asyncIterator]();
    expect((await iterator.next()).done).toBe(false);
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ code: "msfile_media_cancelled" });
    await source.close();
  });

  it("rejects invalid live resource limits", () => {
    expect(() => new MsFileLiveTestSource({ segmentBytes: 0 })).toThrowError(new MsFileMediaError("msfile_media_configuration"));
    expect(() => new MsFileLiveTestSource({ rollingWindowSegments: 0 })).toThrowError(new MsFileMediaError("msfile_media_configuration"));
  });
});
