import { afterEach, describe, expect, it, vi } from "vitest";
import { MsFileMp4Transmuxer } from "./mediaTransmux.js";
import type { MsFileVodSource } from "../core/blockSource.js";

interface FakeWorkerMessage {
  type: string;
  requestId: string;
  probeRequestId?: string;
  chunkId?: string;
  start?: number;
  end?: number;
  bytes?: ArrayBuffer;
  done?: boolean;
}

class FakeWorker {
  static instances: FakeWorker[] = [];
  private activeRequestId = "";
  onmessage: ((event: MessageEvent<FakeWorkerMessage>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  readonly rangeResults: Array<{ requestId: string; bytes?: ArrayBuffer }> = [];
  readonly chunkAcks: string[] = [];
  terminated = false;

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(message: FakeWorkerMessage): void {
    if (message.type === "start") {
      this.activeRequestId = message.requestId;
      queueMicrotask(() => this.onmessage?.({ data: { type: "transmux-ready", requestId: message.requestId } } as MessageEvent<FakeWorkerMessage>));
      return;
    }
    if (message.type === "pump") {
      queueMicrotask(() => this.onmessage?.({
        data: {
          type: "range",
          requestId: "range-1",
          probeRequestId: message.requestId,
          start: 0,
          end: 4,
        },
      } as MessageEvent<FakeWorkerMessage>));
      return;
    }
    if (message.type === "range-result") {
      this.rangeResults.push({ requestId: message.requestId, bytes: message.bytes });
      queueMicrotask(() => this.onmessage?.({
        data: {
          type: "transmux-chunk",
          requestId: this.activeRequestId,
          chunkId: "chunk-1",
          bytes: new Uint8Array([1, 2, 3]).buffer,
        },
      } as MessageEvent<FakeWorkerMessage>));
      return;
    }
    if (message.type === "chunk-ack") {
      this.chunkAcks.push(message.chunkId ?? "");
      queueMicrotask(() => this.onmessage?.({ data: { type: "transmux-pump-done", requestId: this.activeRequestId, done: true } } as MessageEvent<FakeWorkerMessage>));
    }
  }

  terminate(): void {
    this.terminated = true;
  }
}

const originalWorker = globalThis.Worker;

afterEach(() => {
  globalThis.Worker = originalWorker;
  FakeWorker.instances.length = 0;
});

describe("MsFileMp4Transmuxer", () => {
  it("把 Worker 的 range 请求转回 BlockSource，并在 append 后发送 ack", async () => {
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    const readRange = vi.fn(async (start: number, end: number) => new Uint8Array([start, end, 9, 8]));
    const source = {
      fileSizeNumber: 4,
      maxCacheBytes: 2 * 256 * 1024,
      readRange,
    } as unknown as MsFileVodSource;
    const appended: number[][] = [];
    const controller = new AbortController();
    const transmuxer = new MsFileMp4Transmuxer(source, {
      append: async (bytes, signal) => {
        expect(signal.aborted).toBe(false);
        appended.push([...bytes]);
      },
    });

    await transmuxer.start(controller.signal);
    await expect(transmuxer.pump(15, controller.signal)).resolves.toBe(true);

    expect(readRange).toHaveBeenCalledWith(0, 4, controller.signal);
    expect(appended).toEqual([[1, 2, 3]]);
    expect(FakeWorker.instances[0]?.rangeResults).toHaveLength(1);
    expect(FakeWorker.instances[0]?.chunkAcks).toEqual(["chunk-1"]);
    await transmuxer.dispose();
    expect(FakeWorker.instances[0]?.terminated).toBe(true);
  });
});
