// packages/plugin-token-bsv21/src/bsv21Sync.test.ts
// BSV-21 后台同步任务取消语义测试：
//   - 正常流程：replaceAll + emit data-changed。
//   - signal 在 listActiveKeyTokens 前 aborted：不 replaceAll、不 emit。
//   - signal 在 listActiveKeyTokens 后 aborted：不 replaceAll、不 emit。
//   - signal 在 replaceAll 后 aborted：不 emit。
//   - active key 在 replaceAll 后变化：不 emit（旧 key 任务不向新 key 发通知）。

import { describe, expect, it, vi } from "vitest";
import { createBsv21SyncTask } from "./bsv21Sync.js";
import type { Bsv21Db } from "./bsv21Db.js";
import type { Bsv21ServiceHandle } from "./bsv21Service.js";
import type { AssetDataNotifier, KeyspaceService, VaultService } from "@keymaster/contracts";

function fakeKeyspace(activePublicKeyHex?: string): KeyspaceService {
  let current = activePublicKeyHex;
  return {
    active: () => ({ activePublicKeyHex: current }),
    setActive(hex: string | undefined) { current = hex; }
  } as unknown as KeyspaceService & { setActive(h: string | undefined): void };
}

function fakeVault(): VaultService {
  return { status: () => "unlocked" } as unknown as VaultService;
}

function fakeDb(): Bsv21Db & { replaceAll: ReturnType<typeof vi.fn> } {
  return { replaceAll: vi.fn(async () => {}) } as unknown as Bsv21Db & { replaceAll: ReturnType<typeof vi.fn> };
}

function fakeService(tokens: Array<{ meta: { origin: string; symbol: string; issuer: string; decimals: number }; balance: { confirmed: number; unconfirmed: number }; address: string; network: "main" | "test" }>): Bsv21ServiceHandle {
  return {
    listActiveKeyTokens: vi.fn(async () => tokens),
    getToken: vi.fn(async () => null)
  };
}

function fakeNotifier(): AssetDataNotifier & { emit: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> } {
  return {
    emit: vi.fn(),
    subscribe: vi.fn(() => () => {})
  } as unknown as AssetDataNotifier & { emit: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> };
}

const SAMPLE_TOKENS = [{
  meta: { origin: "tok1", symbol: "T1", issuer: "", decimals: 0 },
  balance: { confirmed: 100, unconfirmed: 0 },
  address: "addr1",
  network: "main" as const
}];

describe("createBsv21SyncTask", () => {
  it("正常流程：replaceAll + emit data-changed", async () => {
    const db = fakeDb();
    const notifier = fakeNotifier();
    const ks = fakeKeyspace("pk1");
    const task = createBsv21SyncTask({
      db: db as unknown as Bsv21Db,
      service: fakeService(SAMPLE_TOKENS),
      keyspace: ks,
      vault: fakeVault(),
      assetDataNotifier: notifier
    });
    const ac = new AbortController();
    await task.run({ signal: ac.signal, reason: "test", reportProgress() {} });
    expect(db.replaceAll).toHaveBeenCalledTimes(1);
    expect(notifier.emit).toHaveBeenCalledTimes(1);
    expect(notifier.emit.mock.calls[0]![0].publicKeyHex).toBe("pk1");
  });

  it("signal 在 listActiveKeyTokens 前 aborted：不 replaceAll、不 emit", async () => {
    const db = fakeDb();
    const notifier = fakeNotifier();
    const ac = new AbortController();
    ac.abort();
    const task = createBsv21SyncTask({
      db: db as unknown as Bsv21Db,
      service: fakeService(SAMPLE_TOKENS),
      keyspace: fakeKeyspace("pk1"),
      vault: fakeVault(),
      assetDataNotifier: notifier
    });
    await task.run({ signal: ac.signal, reason: "test", reportProgress() {} });
    expect(db.replaceAll).not.toHaveBeenCalled();
    expect(notifier.emit).not.toHaveBeenCalled();
  });

  it("signal 在 listActiveKeyTokens 后 aborted：不 replaceAll、不 emit", async () => {
    const db = fakeDb();
    const notifier = fakeNotifier();
    const ac = new AbortController();
    const svc = fakeService(SAMPLE_TOKENS);
    (svc.listActiveKeyTokens as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      ac.abort();
      return SAMPLE_TOKENS;
    });
    const task = createBsv21SyncTask({
      db: db as unknown as Bsv21Db,
      service: svc,
      keyspace: fakeKeyspace("pk1"),
      vault: fakeVault(),
      assetDataNotifier: notifier
    });
    await task.run({ signal: ac.signal, reason: "test", reportProgress() {} });
    expect(db.replaceAll).not.toHaveBeenCalled();
    expect(notifier.emit).not.toHaveBeenCalled();
  });

  it("signal 在 replaceAll 后 aborted：不 emit", async () => {
    const db = fakeDb();
    const notifier = fakeNotifier();
    const ac = new AbortController();
    (db.replaceAll as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      ac.abort();
    });
    const task = createBsv21SyncTask({
      db: db as unknown as Bsv21Db,
      service: fakeService(SAMPLE_TOKENS),
      keyspace: fakeKeyspace("pk1"),
      vault: fakeVault(),
      assetDataNotifier: notifier
    });
    await task.run({ signal: ac.signal, reason: "test", reportProgress() {} });
    expect(db.replaceAll).toHaveBeenCalledTimes(1);
    expect(notifier.emit).not.toHaveBeenCalled();
  });

  it("active key 在 replaceAll 后变化：不 emit", async () => {
    const db = fakeDb();
    const notifier = fakeNotifier();
    let currentKey = "pk-old";
    const ks = {
      active: () => ({ activePublicKeyHex: currentKey })
    } as unknown as KeyspaceService;
    (db.replaceAll as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      // replaceAll 完成后 active key 切换
      currentKey = "pk-new";
    });
    const task = createBsv21SyncTask({
      db: db as unknown as Bsv21Db,
      service: fakeService(SAMPLE_TOKENS),
      keyspace: ks,
      vault: fakeVault(),
      assetDataNotifier: notifier
    });
    const ac = new AbortController();
    await task.run({ signal: ac.signal, reason: "test", reportProgress() {} });
    expect(db.replaceAll).toHaveBeenCalledTimes(1);
    expect(notifier.emit).not.toHaveBeenCalled();
  });

  it("无 active key 时直接返回，不调用 service", async () => {
    const db = fakeDb();
    const notifier = fakeNotifier();
    const svc = fakeService(SAMPLE_TOKENS);
    const task = createBsv21SyncTask({
      db: db as unknown as Bsv21Db,
      service: svc,
      keyspace: fakeKeyspace(undefined),
      vault: fakeVault(),
      assetDataNotifier: notifier
    });
    const ac = new AbortController();
    await task.run({ signal: ac.signal, reason: "test", reportProgress() {} });
    expect(svc.listActiveKeyTokens).not.toHaveBeenCalled();
    expect(db.replaceAll).not.toHaveBeenCalled();
    expect(notifier.emit).not.toHaveBeenCalled();
  });
});
