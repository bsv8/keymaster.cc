import { describe, expect, it } from "vitest";
import type { MsFileMediaElementLike } from "../core/types.js";
import { createMsFileMediaSession } from "./session.js";

class FakeMediaElement extends EventTarget implements MsFileMediaElementLike {
  currentTime = 0;
  duration = 30;
  paused = true;
  ended = false;
  async play(): Promise<void> { this.paused = false; }
  pause(): void { this.paused = true; }
}

function input() {
  return {
    seedHashHex: "aa".repeat(32),
    supplierPublicKeyHex: `02${"11".repeat(32)}`,
    fileSizeBytes: 0n,
    declaredMediaType: "video/mp4",
    reader: {
      readSeed: async () => new Uint8Array(),
      readBlock: async () => new Uint8Array(),
    },
  };
}

describe("MsFileMediaSession Debug", () => {
  it("原生 seeking 只通知后端补缓存，不让后端重复写 currentTime", async () => {
    const session = createMsFileMediaSession(input());
    const element = new FakeMediaElement();
    const seekOptions: Array<{ elementTimeAlreadySet?: boolean } | undefined> = [];
    const backend = {
      start: async () => undefined,
      play: async () => undefined,
      pause: () => undefined,
      seek: async (_seconds: number, _signal: AbortSignal, options?: { elementTimeAlreadySet?: boolean }) => {
        seekOptions.push(options);
      },
      currentTime: () => element.currentTime,
      bufferedSeconds: () => 30,
      isEnded: () => false,
      dispose: async () => undefined,
    };

    await session.attach(element);
    Object.assign(session as unknown as Record<string, unknown>, { backend, phase: "paused" });
    element.currentTime = 1.997;
    element.dispatchEvent(new Event("seeking"));
    await Promise.resolve();

    expect(seekOptions).toEqual([{ elementTimeAlreadySet: true }]);
    // Chromium 对同一赋值重复派发 seeking 时，在 seeked 前必须去重。
    element.dispatchEvent(new Event("seeking"));
    await Promise.resolve();
    expect(seekOptions).toHaveLength(1);

    element.dispatchEvent(new Event("seeked"));
    await session.dispose();
  });

  it("默认开启且只记录脱敏的有界状态字段", async () => {
    const session = createMsFileMediaSession(input());
    const snapshot = session.snapshot();

    expect(snapshot.debug.enabled).toBe(true);
    expect(snapshot.debug.entries[0]).toMatchObject({
      sequence: 1,
      scope: "session",
      action: "created",
      details: {
        fileSizeBytes: 0,
        declaredMediaType: "video/mp4",
      },
    });
    expect(JSON.stringify(snapshot.debug.entries)).not.toContain("11".repeat(32));
    expect(JSON.stringify(snapshot.debug.entries)).not.toContain("aa".repeat(32));
    await session.dispose();
  });

  it("显式关闭时不产生诊断记录", async () => {
    const session = createMsFileMediaSession(input(), { debug: false });
    expect(session.snapshot().debug).toEqual({ enabled: false, entries: [] });
    await session.dispose();
  });
});
