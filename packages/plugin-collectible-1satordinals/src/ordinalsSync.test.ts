// packages/plugin-collectible-1satordinals/src/ordinalsSync.test.ts
// 1Sat Ordinals 后台同步任务回归测试：
//   - 正常流程：service.sync + assetDataNotifier.emit；
//   - signal 在 run 前 aborted：不调用 service.sync、不 emit；
//   - active key 在 sync 后变化：不 emit；
//   - 无 active key 时直接返回。

import { describe, expect, it, vi } from "vitest";
import type { AssetDataNotifier, KeyspaceService, VaultService } from "@keymaster/contracts";
import { createOrdinalsSyncTask } from "./ordinalsSync.js";
import type { OrdinalsServiceHandle } from "./ordinalsService.js";

function fakeKeyspace(activePublicKeyHex?: string): KeyspaceService {
  let current = activePublicKeyHex;
  return {
    active: () => ({ activePublicKeyHex: current }),
    setActive(hex: string | undefined) { current = hex; }
  } as unknown as KeyspaceService & { setActive(hex: string | undefined): void };
}

function fakeVault(): VaultService {
  return { status: () => "unlocked" } as unknown as VaultService;
}

function fakeNotifier(): AssetDataNotifier & { emit: ReturnType<typeof vi.fn> } {
  return {
    emit: vi.fn(),
    subscribe: vi.fn(() => () => {})
  } as unknown as AssetDataNotifier & { emit: ReturnType<typeof vi.fn> };
}

function fakeService(): OrdinalsServiceHandle & { sync: ReturnType<typeof vi.fn> } {
  return {
    listActiveKeyCollectibles: vi.fn(async () => []),
    getOutpoint: vi.fn(async () => null),
    getOutpointContent: vi.fn(async () => null),
    getTransactionOutputScript: vi.fn(async () => new Uint8Array([0x76, 0xa9, 0x14, ...new Uint8Array(20), 0x88, 0xac])),
    sync: vi.fn(async () => {}),
    onChange: vi.fn(() => () => {}),
    dispose: vi.fn()
  };
}

describe("createOrdinalsSyncTask", () => {
  it("正常流程：service.sync + emit", async () => {
    const service = fakeService();
    const notifier = fakeNotifier();
    const task = createOrdinalsSyncTask({
      service,
      keyspace: fakeKeyspace("pk1"),
      vault: fakeVault(),
      assetDataNotifier: notifier
    });
    await task.run({ signal: new AbortController().signal, reason: "manual", reportProgress() {} });
    expect(service.sync).toHaveBeenCalledTimes(1);
    expect(notifier.emit).toHaveBeenCalledTimes(1);
    expect(notifier.emit.mock.calls[0]![0]).toMatchObject({
      providerId: "1satordinals",
      publicKeyHex: "pk1",
      kinds: ["holding"]
    });
  });

  it("signal 在 run 前 aborted：service.sync 仍会收到 aborted signal，但不 emit", async () => {
    const service = fakeService();
    const notifier = fakeNotifier();
    const ac = new AbortController();
    ac.abort();
    const task = createOrdinalsSyncTask({
      service,
      keyspace: fakeKeyspace("pk1"),
      vault: fakeVault(),
      assetDataNotifier: notifier
    });
    await task.run({ signal: ac.signal, reason: "manual", reportProgress() {} });
    expect(service.sync).toHaveBeenCalledTimes(1);
    expect(service.sync).toHaveBeenCalledWith(ac.signal);
    expect(notifier.emit).not.toHaveBeenCalled();
  });

  it("active key 在 sync 后变化：不 emit", async () => {
    const service = fakeService();
    const notifier = fakeNotifier();
    const ks = fakeKeyspace("pk-old") as KeyspaceService & { setActive(hex: string | undefined): void };
    (service.sync as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      ks.setActive("pk-new");
    });
    const task = createOrdinalsSyncTask({
      service,
      keyspace: ks,
      vault: fakeVault(),
      assetDataNotifier: notifier
    });
    await task.run({ signal: new AbortController().signal, reason: "manual", reportProgress() {} });
    expect(service.sync).toHaveBeenCalledTimes(1);
    expect(notifier.emit).not.toHaveBeenCalled();
  });

  it("无 active key 时直接返回", async () => {
    const service = fakeService();
    const notifier = fakeNotifier();
    const task = createOrdinalsSyncTask({
      service,
      keyspace: fakeKeyspace(undefined),
      vault: fakeVault(),
      assetDataNotifier: notifier
    });
    await task.run({ signal: new AbortController().signal, reason: "manual", reportProgress() {} });
    expect(service.sync).not.toHaveBeenCalled();
    expect(notifier.emit).not.toHaveBeenCalled();
  });
});
