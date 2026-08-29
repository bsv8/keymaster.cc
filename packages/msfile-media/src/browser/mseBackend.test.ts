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
    if (start <= this.buffered.startSeconds && end >= this.buffered.endSeconds) {
      this.buffered.startSeconds = 0;
      this.buffered.endSeconds = 0;
    } else if (start <= this.buffered.startSeconds) {
      this.buffered.startSeconds = Math.min(end, this.buffered.endSeconds);
    }
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

interface FakeWorkerMessage {
  type: string;
  requestId: string;
  chunkId?: string;
  bytes?: ArrayBuffer;
  done?: boolean;
}

class FakeTransmuxWorker {
  static instances: FakeTransmuxWorker[] = [];
  onmessage: ((event: MessageEvent<FakeWorkerMessage>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  private requestId = "";
  terminated = false;

  constructor() { FakeTransmuxWorker.instances.push(this); }

  postMessage(message: FakeWorkerMessage): void {
    if (message.type === "start") {
      this.requestId = message.requestId;
      queueMicrotask(() => this.onmessage?.({
        data: { type: "transmux-ready", requestId: this.requestId },
      } as MessageEvent<FakeWorkerMessage>));
      return;
    }
    if (message.type === "pump") {
      queueMicrotask(() => this.onmessage?.({
        data: {
          type: "transmux-chunk",
          requestId: this.requestId,
          chunkId: "chunk-1",
          bytes: new Uint8Array([1, 2, 3]).buffer,
        },
      } as MessageEvent<FakeWorkerMessage>));
      return;
    }
    if (message.type === "chunk-ack") {
      queueMicrotask(() => this.onmessage?.({
        data: { type: "transmux-pump-done", requestId: this.requestId, done: false },
      } as MessageEvent<FakeWorkerMessage>));
    }
  }

  terminate(): void { this.terminated = true; }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeMediaSource.instance = undefined;
  FakeTransmuxWorker.instances.length = 0;
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

  it("往回跳到已回收时间时清空旧缓存并重建读取管线", async () => {
    vi.stubGlobal("MediaSource", FakeMediaSource);
    vi.stubGlobal("URL", {
      createObjectURL: () => "blob:msfile-test",
      revokeObjectURL: () => undefined,
    });
    let streamCount = 0;
    const source = {
      fileSizeNumber: 4,
      readStream: () => {
        streamCount += 1;
        const chunks = [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3]), new Uint8Array([4])];
        return new ReadableStream<Uint8Array>({
          pull(controller) {
            const chunk = chunks.shift();
            if (chunk) controller.enqueue(chunk);
            else controller.close();
          },
        });
      },
    } as unknown as MsFileVodSource;
    const element = new FakeMediaElement();
    const debugActions: string[] = [];
    const backend = new MsFileMseBackend(
      element as unknown as MsFileMediaElementLike,
      source,
      "video/mp4",
      60,
      undefined,
      { onDebug: (action) => debugActions.push(action) },
    );
    const controller = new AbortController();

    await backend.start(controller.signal);
    const buffer = FakeMediaSource.instance!.buffer.buffered;
    buffer.startSeconds = 45;
    buffer.endSeconds = 60;
    element.currentTime = 50;

    await expect(backend.seek(10, controller.signal)).resolves.toBeUndefined();
    expect(streamCount).toBe(2);
    expect(element.currentTime).toBe(10);
    expect(buffer.start(0)).toBe(0);
    expect(buffer.end(0)).toBeGreaterThanOrEqual(10);
    expect(debugActions).toContain("seek.begin");
    expect(debugActions).toContain("restart.begin");
    expect(debugActions).toContain("clear.remove");
    expect(debugActions).toContain("restart.done");
    expect(debugActions).toContain("seek.done");

    await backend.dispose();
  });

  it("progressive MP4 往回跳时终止旧 Worker 并重建转封装器", async () => {
    const NativeURL = globalThis.URL;
    class FakeURL extends NativeURL {
      static createObjectURL(): string { return "blob:msfile-test"; }
      static revokeObjectURL(): void { /* 测试替身无需释放 */ }
    }
    vi.stubGlobal("MediaSource", FakeMediaSource);
    vi.stubGlobal("URL", FakeURL);
    vi.stubGlobal("Worker", FakeTransmuxWorker);
    const source = {
      fileSizeNumber: 4,
      maxCacheBytes: 2 * 256 * 1024,
      readRange: async () => new Uint8Array([1, 2, 3, 4]),
    } as unknown as MsFileVodSource;
    const element = new FakeMediaElement();
    const debugActions: string[] = [];
    const backend = new MsFileMseBackend(
      element as unknown as MsFileMediaElementLike,
      source,
      "video/mp4",
      60,
      undefined,
      { transmuxProgressiveMp4: true, onDebug: (action) => debugActions.push(action) },
    );
    const controller = new AbortController();

    await backend.start(controller.signal);
    const firstWorker = FakeTransmuxWorker.instances[0]!;
    const buffer = FakeMediaSource.instance!.buffer.buffered;
    buffer.startSeconds = 45;
    buffer.endSeconds = 60;
    element.currentTime = 50;

    await expect(backend.seek(10, controller.signal)).resolves.toBeUndefined();
    expect(firstWorker.terminated).toBe(true);
    expect(FakeTransmuxWorker.instances).toHaveLength(2);
    expect(buffer.start(0)).toBe(0);
    expect(buffer.end(0)).toBeGreaterThanOrEqual(10);
    expect(debugActions).toContain("transmux.worker.created");
    expect(debugActions).toContain("restart.begin");
    expect(debugActions).toContain("seek.done");

    await backend.dispose();
  });
});
