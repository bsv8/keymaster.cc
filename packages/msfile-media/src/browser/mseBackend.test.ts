import { afterEach, describe, expect, it, vi } from "vitest";
import type { MsFileVodSource } from "../core/blockSource.js";
import type { MsFileMediaElementLike } from "../core/types.js";
import { MsFileMseBackend } from "./mseBackend.js";

class FakeTimeRanges implements TimeRanges {
  startSeconds = 0;
  endSeconds = 0;

  get length(): number { return this.endSeconds > this.startSeconds ? 1 : 0; }
  start(index: number): number {
    if (index !== 0 || this.length === 0) throw new DOMException("IndexSizeError");
    return this.startSeconds;
  }
  end(index: number): number {
    if (index !== 0 || this.length === 0) throw new DOMException("IndexSizeError");
    return this.endSeconds;
  }
}

class FakeSourceBuffer extends EventTarget {
  updating = false;
  mode: AppendMode = "segments";
  readonly buffered = new FakeTimeRanges();

  appendBuffer(): void {
    this.updating = true;
    this.buffered.endSeconds += 15;
    queueMicrotask(() => {
      this.updating = false;
      this.dispatchEvent(new Event("updateend"));
    });
  }

  remove(start: number, end: number): void {
    this.updating = true;
    if (start <= this.buffered.startSeconds) this.buffered.startSeconds = Math.min(end, this.buffered.endSeconds);
    queueMicrotask(() => {
      this.updating = false;
      this.dispatchEvent(new Event("updateend"));
    });
  }
}

class FakeMediaSource extends EventTarget {
  static instance: FakeMediaSource | undefined;
  static isTypeSupported(): boolean { return true; }

  readonly buffer = new FakeSourceBuffer();
  readyState: ReadyState = "closed";
  duration = 60;

  constructor() {
    super();
    FakeMediaSource.instance = this;
    queueMicrotask(() => {
      this.readyState = "open";
      this.dispatchEvent(new Event("sourceopen"));
    });
  }

  addSourceBuffer(): SourceBuffer { return this.buffer as unknown as SourceBuffer; }
  removeSourceBuffer(): void { /* 测试替身无需资源释放 */ }
  endOfStream(): void { this.readyState = "ended"; }
}

class FakeMediaElement extends EventTarget {
  currentTime = 0;
  paused = true;
  ended = false;
  src = "";
  srcObject: MediaProvider | null = null;

  get buffered(): TimeRanges {
    return FakeMediaSource.instance?.buffer.buffered ?? new FakeTimeRanges();
  }

  async play(): Promise<void> { this.paused = false; }
  pause(): void { this.paused = true; }
  load(): void { /* 测试替身无需加载 */ }
  removeAttribute(name: string): void { if (name === "src") this.src = ""; }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeMediaSource.instance = undefined;
});

describe("MsFileMseBackend", () => {
  it("暂停状态跳到未缓存时间时继续读取，且不再报 browser_capability", async () => {
    vi.stubGlobal("MediaSource", FakeMediaSource);
    vi.stubGlobal("URL", {
      createObjectURL: () => "blob:msfile-test",
      revokeObjectURL: () => undefined,
    });
    const chunks = [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])];
    const source = {
      fileSizeNumber: chunks.length,
      readStream: () => new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks.shift();
          if (chunk) controller.enqueue(chunk);
          else controller.close();
        },
      }),
    } as unknown as MsFileVodSource;
    const element = new FakeMediaElement();
    const backend = new MsFileMseBackend(
      element as unknown as MsFileMediaElementLike,
      source,
      "video/mp4",
      60,
    );
    const controller = new AbortController();

    await backend.start(controller.signal);
    expect(element.buffered.end(0)).toBe(15);
    await expect(backend.seek(25, controller.signal)).resolves.toBeUndefined();
    expect(element.currentTime).toBe(25);
    expect(element.buffered.end(0)).toBeGreaterThanOrEqual(25);

    await backend.dispose();
  });
});
