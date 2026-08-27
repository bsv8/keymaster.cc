// 施工单 001 §3.4：transferable 队列逻辑测试（A08/A09 语义层）。
import { describe, expect, it } from "vitest";
import { TransferQueue, TransferQueueClosedError, TransferQueueOverflowError } from "./transferQueue.js";

function movingClone<T>(value: T, transfer: ArrayBuffer[]): T {
  return structuredClone(value, { transfer });
}

describe("TransferQueue", () => {
  it("A08: moves a 16 MiB buffer without retaining the original bytes", async () => {
    const queue = new TransferQueue({ maxItems: 8, maxTotalBytes: 17 * 1024 * 1024 }, movingClone);
    const seed = new Uint8Array(16 * 1024 * 1024);
    const pending = queue.enqueue({ id: "seed", bytes: seed.buffer });
    // transfer 后原 buffer 已 detach：没有隐式整包复制。
    expect(seed.byteLength).toBe(0);
    const drained = queue.drain();
    expect(drained?.id).toBe("seed");
    expect((await pending).bytes.byteLength).toBe(16 * 1024 * 1024);
    expect(queue.pendingByteLength).toBe(0);
    expect(queue.peakPendingByteLength).toBe(16 * 1024 * 1024);
  });

  it("A08: bounds four concurrent 256 KiB blocks by items and total bytes", async () => {
    const queue = new TransferQueue({ maxItems: 4, maxTotalBytes: 1024 * 1024 }, movingClone);
    for (let i = 0; i < 4; i += 1) {
      void queue.enqueue({ id: `block-${i}`, bytes: new ArrayBuffer(256 * 1024) }).catch(() => undefined);
    }
    expect(queue.pendingCount).toBe(4);
    expect(queue.pendingByteLength).toBe(1024 * 1024);

    const fifth = queue.enqueue({ id: "block-5", bytes: new ArrayBuffer(256 * 1024) });
    await expect(fifth).rejects.toBeInstanceOf(TransferQueueOverflowError);
    expect(queue.peakPendingByteLength).toBe(1024 * 1024);

    // 排空后单独验证字节上限（避免与条目上限耦合）。
    for (let i = 0; i < 4; i += 1) queue.drain();
    const oversized = queue.enqueue({ id: "huge", bytes: new ArrayBuffer(2 * 1024 * 1024) });
    await expect(oversized).rejects.toMatchObject({ kind: "bytes" });
  });

  it("A09: abort rejects only the target entry and frees its byte budget", async () => {
    const queue = new TransferQueue({ maxItems: 8, maxTotalBytes: 4096 }, movingClone);
    const first = queue.enqueue({ id: "a", bytes: new ArrayBuffer(1024) });
    const second = queue.enqueue({ id: "b", bytes: new ArrayBuffer(2048) });
    void second.catch(() => undefined);
    expect(queue.abort("a")).toBe(true);
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(queue.pendingByteLength).toBe(2048);
    expect(queue.abort("a")).toBe(false);
    expect(queue.drain()?.id).toBe("b");
  });

  it("A07: close fails every pending entry and poisons later enqueues", async () => {
    const queue = new TransferQueue({ maxItems: 8, maxTotalBytes: 4096 }, movingClone);
    const pending = [
      queue.enqueue({ id: "a", bytes: new ArrayBuffer(64) }),
      queue.enqueue({ id: "b", bytes: new ArrayBuffer(128) })
    ];
    queue.close("executor window disappeared");
    for (const promise of pending) {
      await expect(promise).rejects.toMatchObject({
        name: "TransferQueueClosedError",
        message: "executor window disappeared"
      });
    }
    await expect(queue.enqueue({ id: "c", bytes: new ArrayBuffer(16) })).rejects.toBeInstanceOf(TransferQueueClosedError);
    expect(queue.isClosed).toBe(true);
  });
});
