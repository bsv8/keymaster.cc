// 页面侧 MSFile 代理缓存测试：验证短 TTL 只合并安全的 Stat 元数据，
// 会话 / 供应商世代变化立即丢弃旧结果。

import { describe, expect, it, vi } from "vitest";
import type { MsFileCoordinatorControl, MsFileStatResult } from "@keymaster/contracts";
import { MsFileServiceProxy } from "./msfileServiceProxy.js";

function makeStateEvent(sessionEpoch: string, supplierGeneration: number) {
  return {
    topic: "msfile.state" as const,
    sessionEpoch,
    status: "ready" as const,
    supplierGeneration,
    globalSettings: null,
    mediaBlockReadConcurrency: 1,
    globalSeedReadConcurrency: 1,
    globalBlockReadConcurrency: 1,
    globalStatConcurrency: 1,
    sellerSettings: { sellerEnabled: false, seedPriceSatoshis: "0", fullBlockPriceSatoshis: "0", quoteLifetimeSeconds: 300, maxConcurrentSales: 1, supportedArbiterPublicKeys: [] },
    sellerRuntimeStatus: "disabled" as const,
    pendingApprovals: [],
  };
}

describe("MsFileServiceProxy Stat cache（页面侧元数据短缓存）", () => {
  it("复用成功结果，并在会话或供应商世代变化后失效", async () => {
    let listener: ((event: unknown) => void) | undefined;
    const value: MsFileStatResult = {
      seedHashHex: "ab".repeat(32),
      sources: [{
        sourceId: `remote-proxy:${"02" + "11".repeat(32)}`,
        sourceKind: "remote-proxy",
        supplierPublicKeyHex: "02" + "11".repeat(32),
        status: "available",
        fileSizeBytes: "1",
        recommendedFilename: "fixture.bin",
        mediaType: "application/octet-stream",
      }],
    };
    const msfileData = vi.fn(async () => ({ status: "ok" as const, value, sessionEpoch: "epoch-1" }));
    const coordinator = {
      subscribeTopic: (_topic: string, next: (event: unknown) => void) => {
        listener = next;
        return () => undefined;
      },
      msfileData,
    } as unknown as MsFileCoordinatorControl;
    const proxy = new MsFileServiceProxy(coordinator);

    const first = await proxy.stat({ seedHashHex: value.seedHashHex });
    first.sources[0]!.status = "absent";
    const second = await proxy.stat({ seedHashHex: value.seedHashHex });
    expect(msfileData).toHaveBeenCalledTimes(1);
    expect(second.sources[0]!.status).toBe("available");

    listener!(makeStateEvent("epoch-1", 1));
    await proxy.stat({ seedHashHex: value.seedHashHex });
    expect(msfileData).toHaveBeenCalledTimes(2);

    listener!(makeStateEvent("epoch-2", 1));
    await proxy.stat({ seedHashHex: value.seedHashHex });
    expect(msfileData).toHaveBeenCalledTimes(3);

    proxy.dispose();
    vi.useRealTimers();
  });

  it("内容相同的状态事件只通知一次，变化才再次通知", () => {
    let listener: ((event: unknown) => void) | undefined;
    const coordinator = {
      subscribeTopic: (_topic: string, next: (event: unknown) => void) => {
        listener = next;
        return () => undefined;
      },
    } as unknown as MsFileCoordinatorControl;
    const proxy = new MsFileServiceProxy(coordinator);
    let notifications = 0;
    proxy.subscribe(() => { notifications += 1; });

    listener!(makeStateEvent("epoch-1", 1));
    expect(notifications).toBe(1);
    listener!(makeStateEvent("epoch-1", 1));
    expect(notifications).toBe(1);
    listener!(makeStateEvent("epoch-1", 2));
    expect(notifications).toBe(2);

    proxy.dispose();
  });

  it("资源每次通知后回读设置也不会形成无限循环（审查修复）", async () => {
    let listener: ((event: unknown) => void) | undefined;
    const globalSettings = { seedMaxPriceSatoshis: "0", blockMaxPriceSatoshis: "0" };
    const snapshot = {
      globalSettings,
      mediaBlockReadConcurrency: 1,
      globalSeedReadConcurrency: 1,
      globalBlockReadConcurrency: 1,
      globalStatConcurrency: 1,
      suppliers: [{ name: "builtin", supplierPublicKeyHex: "02" + "11".repeat(32), addresses: [], enabled: true }],
      supplierGeneration: 1,
      sellerSettings: { sellerEnabled: false, seedPriceSatoshis: "0", fullBlockPriceSatoshis: "0", quoteLifetimeSeconds: 300, maxConcurrentSales: 1, supportedArbiterPublicKeys: [] },
      sellerRuntimeStatus: "disabled" as const,
    };
    const msfileControl = vi.fn(async (control: { type: string }) => {
      if (control.type !== "settings.get") return { status: "ok" as const, value: null, sessionEpoch: "epoch-1" };
      // 模拟 Worker 读设置后广播：内容与上次相同。
      listener?.({ ...makeStateEvent("epoch-1", 1), status: "ready", globalSettings });
      return { status: "ok" as const, value: snapshot, sessionEpoch: "epoch-1" };
    });
    const coordinator = {
      subscribeTopic: (_topic: string, next: (event: unknown) => void) => {
        listener = next;
        return () => undefined;
      },
      msfileControl,
    } as unknown as MsFileCoordinatorControl;
    const proxy = new MsFileServiceProxy(coordinator);

    // 资源语义：通知触发一次新的 load；load 本身不自我链式回读。
    let reloads = 0;
    const reload = (): void => {
      reloads += 1;
      if (reloads > 50) return;
      void proxy.getSettingsSnapshot();
    };
    proxy.subscribe(reload);
    reload();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 第一次回读会看到与基线不同的事件并触发一次刷新；之后快照稳定，
    // 不得再形成 通知→回读→广播 的循环。
    expect(reloads).toBeLessThan(5);
    expect(msfileControl.mock.calls.length).toBeLessThan(5);
    proxy.dispose();
  });
});
