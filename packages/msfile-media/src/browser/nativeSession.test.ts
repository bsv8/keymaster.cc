import { describe, expect, it } from "vitest";
import type { MsFileMediaElementLike } from "../core/types.js";
import { createMsFileNativeMediaSession } from "./nativeSession.js";

class FakeMediaElement extends EventTarget implements MsFileMediaElementLike {
  currentTime = 0;
  duration = 0;
  paused = true;
  ended = false;
  src = "";
  loadCalls = 0;
  playCalls = 0;
  async play(): Promise<void> { this.playCalls += 1; this.paused = false; }
  pause(): void { this.paused = true; }
  setAttribute(name: string, value: string): void { if (name === "src") this.src = value; }
  removeAttribute(name: string): void { if (name === "src") this.src = ""; }
  load(): void { this.loadCalls += 1; }
}

function input() {
  return {
    seedHashHex: "aa".repeat(32),
    supplierPublicKeyHex: `02${"11".repeat(32)}`,
    fileSizeBytes: 1n,
    declaredMediaType: "audio/mpeg",
    reader: {
      readSeed: async () => new Uint8Array(),
      readBlock: async () => new Uint8Array(),
    },
  };
}

describe("MsFileNativeMediaSession", () => {
  it("只安装原生 src，seeking 不触发第二次应用 seek", async () => {
    const session = createMsFileNativeMediaSession(input(), {
      ensureServiceWorker: async () => undefined,
      bindSession: async () => undefined,
    });
    const element = new FakeMediaElement();
    await session.attach(element);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(element.src).toMatch(/^\/__keymaster\/msfile-media\/[0-9a-f]{32}$/);
    expect(element.loadCalls).toBe(1);

    let currentTimeWrites = 0;
    let currentTime = 0;
    Object.defineProperty(element, "currentTime", {
      get: () => currentTime,
      set: (value: number) => { currentTimeWrites += 1; currentTime = value; },
      configurable: true,
    });
    await session.seek(12);
    element.dispatchEvent(new Event("seeking"));
    element.dispatchEvent(new Event("seeked"));
    expect(currentTimeWrites).toBe(1);
    expect(currentTime).toBe(12);
    await session.dispose();
    expect(element.src).toBe("");
  });

  it("原生 play 失败时返回稳定错误，不回退到 MSE", async () => {
    const session = createMsFileNativeMediaSession(input(), {
      ensureServiceWorker: async () => undefined,
      bindSession: async () => undefined,
    });
    const element = new FakeMediaElement();
    element.play = async () => { throw new DOMException("unsupported", "NotSupportedError"); };
    await session.attach(element);
    await expect(session.play()).rejects.toMatchObject({ code: "msfile_media_native_unsupported" });
    expect(session.snapshot().phase).toBe("failed");
    await session.dispose();
  });

  it("play/waiting 进入 buffering，只有 playing 事件进入 playing", async () => {
    const session = createMsFileNativeMediaSession(input(), {
      ensureServiceWorker: async () => undefined,
      bindSession: async () => undefined,
    });
    const element = new FakeMediaElement();
    await session.attach(element);

    await session.play();
    expect(session.snapshot().phase).toBe("buffering");

    element.dispatchEvent(new Event("waiting"));
    expect(session.snapshot().phase).toBe("buffering");
    element.dispatchEvent(new Event("playing"));
    expect(session.snapshot().phase).toBe("playing");
    await session.dispose();
  });

  it("Debug 保留原生 Range 上下文，并过滤高频媒体事件", async () => {
    const originalDocument = globalThis.document;
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { querySelector: () => ({ getAttribute: () => "test-build-003" }) },
    });
    try {
      const session = createMsFileNativeMediaSession(input(), {
        ensureServiceWorker: async () => undefined,
        bindSession: async () => undefined,
        mediaBlockReadConcurrency: 6,
        globalSeedReadConcurrency: 7,
        globalBlockReadConcurrency: 12,
        globalStatConcurrency: 5,
      });
      const element = new FakeMediaElement();
      await session.attach(element);
      element.dispatchEvent(new Event("timeupdate"));
      element.dispatchEvent(new Event("progress"));

      const entries = session.snapshot().debug.entries;
      const created = entries.find((entry) => entry.scope === "session" && entry.action === "created");
      expect(created?.details).toMatchObject({
        backend: "native-range",
        buildVersion: "test-build-003",
        serviceWorkerProtocolVersion: 1,
        mediaBlockReadConcurrency: 6,
        maxConcurrentReads: 6,
        globalSeedReadConcurrency: 7,
        globalBlockReadConcurrency: 12,
        globalStatConcurrency: 5,
      });
      expect(created?.details.serviceWorkerScriptUrl).toMatch(/\/msfile-media-sw\.js$/u);
      expect(entries.some((entry) => entry.scope === "media.native" && entry.details.event === "timeupdate")).toBe(false);
      expect(entries.some((entry) => entry.scope === "media.native" && entry.details.event === "progress")).toBe(false);
      await session.dispose();
    } finally {
      if (originalDocument === undefined) Reflect.deleteProperty(globalThis, "document");
      else Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
    }
  });
});
