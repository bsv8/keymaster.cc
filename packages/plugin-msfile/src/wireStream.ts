// packages/plugin-msfile/src/wireStream.ts
// Stat/Read 长驻 stream 的公共抽象：transport 只需提供字节读写原语。
//
// 设计缘由（wire 规范 §2）：
//   - 一条 stream 连续承载多个请求与响应，两方向可同时读写；
//   - 响应可乱序，用递增 request ID 关联；stale / 未知的响应 ID 直接淘汰；
//   - stream Reset / EOF 后所有未终结请求进入传输失败，由上层重建。

import { FrameDecoder, RequestIdCounter, WireCodecError, encodeReadRequest, encodeStatRequest, type WireMessage } from "./frameCodec.js";

/** transport 无关的双工字节流。libp2p stream 在 executor 内适配到此接口。 */
export interface WireDuplex {
  /** 写入必须逐 Frame 串行（调用方保证不交叉写入）。 */
  write(bytes: Uint8Array): Promise<void>;
  /** 返回 null 表示 EOF。 */
  readChunk(): Promise<Uint8Array | null>;
  close(): Promise<void>;
}

export class StreamClosedError extends Error {
  constructor(message = "msfile stream closed") {
    super(message);
    this.name = "StreamClosedError";
  }
}

interface StreamCallbacks {
  /** 收到一条完整消息。返回 false 表示调用方要求停止读循环。 */
  onMessage(message: WireMessage): boolean;
  /** 读循环因 EOF / Reset / 协议错误终止时回调一次。 */
  onFailure(error: Error): void;
}

/**
 * 启动后台读循环。Frame 解码毒化后以协议错误结束循环。
 * 返回 stop() 用于主动关闭。
 */
export function startReceiveLoop(duplex: WireDuplex, callbacks: StreamCallbacks): () => void {
  const decoder = new FrameDecoder();
  let stopped = false;
  let failureReported = false;

  const reportFailure = (error: Error) => {
    if (failureReported || stopped) return;
    failureReported = true;
    callbacks.onFailure(error);
  };

  void (async () => {
    try {
      while (!stopped) {
        const chunk = await duplex.readChunk();
        if (chunk === null) {
          reportFailure(new StreamClosedError("msfile stream reached EOF"));
          return;
        }
        decoder.push(chunk);
        for (const message of decoder.takeMessages()) {
          if (!callbacks.onMessage(message)) return;
        }
      }
    } catch (error) {
      reportFailure(error instanceof Error ? error : new Error(String(error)));
    }
  })();

  return () => {
    stopped = true;
  };
}

/** 共享的发送队列：同一方向只允许一个 writer。 */
export class FrameWriter {
  private tail: Promise<void> = Promise.resolve();
  private pendingBytes = 0;

  /**
   * maxQueueBytes 是单条 stream 的写队列硬上限。默认值足够容纳若干
   * 头部帧，但不会允许调用方因为远端背压而无限堆积请求。
   */
  constructor(private readonly duplex: WireDuplex, private readonly maxQueueBytes = 4 * 1024 * 1024) {}

  enqueue(bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength > this.maxQueueBytes || this.pendingBytes + bytes.byteLength > this.maxQueueBytes) {
      return Promise.reject(new Error("msfile stream writer queue limit exceeded"));
    }
    this.pendingBytes += bytes.byteLength;
    const next = this.tail.then(() => this.duplex.write(bytes));
    // 队列自身不中断：失败通过返回值暴露给当前调用方，后续请求自行失败重试。
    this.tail = next.catch(() => undefined).finally(() => {
      this.pendingBytes = Math.max(0, this.pendingBytes - bytes.byteLength);
    });
    return next;
  }

  get queuedBytes(): number {
    return this.pendingBytes;
  }
}

export function createRequestIdCounter(): RequestIdCounter {
  return new RequestIdCounter();
}

/** 把 WireCodecError 归一为传输失败语义（不是业务 absent）。 */
export function isProtocolLevelError(error: unknown): error is WireCodecError {
  return error instanceof WireCodecError;
}
