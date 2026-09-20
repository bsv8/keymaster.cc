import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireCoordinatorAuthorityLock,
  COORDINATOR_AUTHORITY_LOCK_NAME,
} from "./coordinatorAuthorityLock.js";

describe("Keymaster Coordinator authority Web Lock", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("在没有原生 Navigator 时也对测试替身执行 fail-closed 排他", async () => {
    const first = await acquireCoordinatorAuthorityLock();
    await expect(acquireCoordinatorAuthorityLock()).rejects.toMatchObject({ code: "upgrade.authority_conflict" });
    await first.release();
    const second = await acquireCoordinatorAuthorityLock();
    await second.release();
  });

  it("使用固定 origin 级锁名，而不是 Worker URL 或 buildId", () => {
    expect(COORDINATOR_AUTHORITY_LOCK_NAME).toBe("keymaster.coordinator.authority:v1");
  });

  it("原生锁 request 同步失败时归类为不可用而不是泄漏异常", async () => {
    vi.stubGlobal("navigator", {
      locks: {
        request: vi.fn(() => { throw new Error("native locks unavailable"); }),
      },
    });

    await expect(acquireCoordinatorAuthorityLock()).rejects.toMatchObject({ code: "upgrade.authority_unavailable" });
  });

  it("原生锁冲突时不排队，直接返回冲突", async () => {
    vi.stubGlobal("navigator", {
      locks: {
        request: vi.fn(async (_name: string, _options: unknown, callback: (lock: null) => Promise<void>) => callback(null)),
      },
    });

    await expect(acquireCoordinatorAuthorityLock()).rejects.toMatchObject({ code: "upgrade.authority_conflict" });
  });
});
