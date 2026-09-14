import { describe, expect, it, vi } from "vitest";
import { installSharedWorkerRetirement, type RetirableSharedWorkerApp } from "./sharedWorkerRetirement.js";

function fixture(ready: Promise<void>) {
  let peers = 1;
  let listener: ((event: { event: string }) => void) | undefined;
  const dispose = vi.fn(async () => undefined);
  const close = vi.fn();
  const app: RetirableSharedWorkerApp = {
    ready: () => ready,
    activePeers: () => Array.from({ length: peers }),
    subscribePeerLifecycle: (next) => {
      listener = next;
      return () => { listener = undefined; };
    },
    dispose,
  };
  return {
    app,
    dispose,
    close,
    scope: { close, setTimeout, clearTimeout },
    peerCount(value: number) { peers = value; },
    emit(event: string) { listener?.({ event }); },
  };
}

describe("Coordinator SharedWorker 退场", () => {
  it("最后一个页面关闭后排空 Runtime、释放锁并退出 Worker", async () => {
    vi.useFakeTimers();
    const test = fixture(Promise.resolve());
    installSharedWorkerRetirement(test.app, test.scope, { idleGraceMs: 250 });

    test.peerCount(0);
    test.emit("closed");
    await vi.advanceTimersByTimeAsync(250);

    expect(test.dispose).toHaveBeenCalledWith("Coordinator SharedWorker 空闲退场");
    expect(test.close).toHaveBeenCalledOnce();
  });

  it("宽限期内有新页面连接时取消空闲退场", async () => {
    vi.useFakeTimers();
    const test = fixture(Promise.resolve());
    installSharedWorkerRetirement(test.app, test.scope, { idleGraceMs: 250 });

    test.peerCount(0);
    test.emit("closed");
    test.peerCount(1);
    test.emit("active");
    await vi.advanceTimersByTimeAsync(250);

    expect(test.dispose).not.toHaveBeenCalled();
    expect(test.close).not.toHaveBeenCalled();
  });

  it("启动失败后退出 failed Worker，避免重试复用坏实例", async () => {
    vi.useFakeTimers();
    const test = fixture(Promise.reject(new Error("runtime lock conflict")));
    installSharedWorkerRetirement(test.app, test.scope, { failureGraceMs: 25 });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(25);

    expect(test.dispose).toHaveBeenCalledWith("Coordinator SharedWorker 启动失败退场");
    expect(test.close).toHaveBeenCalledOnce();
  });
});
