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
    pendingApprovals: [],
  };
}

describe("MsFileServiceProxy Stat cache（页面侧元数据短缓存）", () => {
  it("复用成功结果，并在会话或供应商世代变化后失效", async () => {
    let listener: ((event: unknown) => void) | undefined;
    const value: MsFileStatResult = {
      seedHashHex: "ab".repeat(32),
      suppliers: [{
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
    first.suppliers[0]!.status = "absent";
    const second = await proxy.stat({ seedHashHex: value.seedHashHex });
    expect(msfileData).toHaveBeenCalledTimes(1);
    expect(second.suppliers[0]!.status).toBe("available");

    listener!(makeStateEvent("epoch-1", 1));
    await proxy.stat({ seedHashHex: value.seedHashHex });
    expect(msfileData).toHaveBeenCalledTimes(2);

    listener!(makeStateEvent("epoch-2", 1));
    await proxy.stat({ seedHashHex: value.seedHashHex });
    expect(msfileData).toHaveBeenCalledTimes(3);

    proxy.dispose();
    vi.useRealTimers();
  });
});
