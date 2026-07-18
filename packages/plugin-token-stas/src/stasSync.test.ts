// packages/plugin-token-stas/src/stasSync.test.ts
// STAS 后台同步任务取消语义测试：
//   - 正常流程：replaceAll + emit data-changed。
//   - signal 在 listActiveKeyTokens 前 aborted：不 replaceAll、不 emit。
//   - signal 在 listActiveKeyTokens 后 aborted：不 replaceAll、不 emit。
//   - signal 在 replaceAll 后 aborted：不 emit。
//   - active key 在 replaceAll 后变化：不 emit（旧 key 任务不向新 key 发通知）。
//   - balance <= 0 的 token 被过滤。

import { describe, expect, it, vi } from "vitest";
import { createStasSyncTask } from "./stasSync.js";
import type { StasDb } from "./stasDb.js";
import type { StasServiceHandle } from "./stasService.js";
import type { AssetDataNotifier, KeyspaceService, VaultService } from "@keymaster/contracts";

function fakeKeyspace(activePublicKeyHex?: string): KeyspaceService {
  return {
    active: () => ({ activePublicKeyHex })
  } as unknown as KeyspaceService;
}

function fakeVault(): VaultService {
  return { status: () => "unlocked" } as unknown as VaultService;
}

function fakeDb(): StasDb & { replaceAll: ReturnType<typeof vi.fn> } {
  return { replaceAll: vi.fn(async () => {}) } as unknown as StasDb & { replaceAll: ReturnType<typeof vi.fn> };
}

interface FakeStasToken {
  entry: { symbol: string; balance: number; issuer?: string };
  address: string;
  network: "main" | "test";
}

function fakeService(tokens: FakeStasToken[]): StasServiceHandle {
  return {
    listActiveKeyTokens: vi.fn(async () => tokens)
  };
}

function fakeNotifier(): AssetDataNotifier & { emit: ReturnType<typeof vi.fn> } {
  return {
    emit: vi.fn(),
    subscribe: vi.fn(() => () => {})
  } as unknown as AssetDataNotifier & { emit: ReturnType<typeof vi.fn> };
}

const SAMPLE_TOKENS: FakeStasToken[] = [{
  entry: { symbol: "STAS1", balance: 50, issuer: "issuer1" },
  address: "addr1",
  network: "main"
}];

describe("createStasSyncTask", () => {
  it("正常流程：replaceAll + emit data-changed", async () => {
    const db = fakeDb();
    const notifier = fakeNotifier();
    const task = createStasSyncTask({
      db: db as unknown as StasDb,
      service: fakeService(SAMPLE_TOKENS),
      keyspace: fakeKeyspace("pk1"),
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
    const task = createStasSyncTask({
      db: db as unknown as StasDb,
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
    const task = createStasSyncTask({
      db: db as unknown as StasDb,
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
    const task = createStasSyncTask({
      db: db as unknown as StasDb,
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
      currentKey = "pk-new";
    });
    const task = createStasSyncTask({
      db: db as unknown as StasDb,
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

  it("balance <= 0 的 token 被过滤，不写入 DB", async () => {
    const db = fakeDb();
    const notifier = fakeNotifier();
    const tokens: FakeStasToken[] = [
      { entry: { symbol: "GOOD", balance: 10 }, address: "a1", network: "main" },
      { entry: { symbol: "ZERO", balance: 0 }, address: "a2", network: "main" },
      { entry: { symbol: "NEG", balance: -5 }, address: "a3", network: "main" }
    ];
    const task = createStasSyncTask({
      db: db as unknown as StasDb,
      service: fakeService(tokens),
      keyspace: fakeKeyspace("pk1"),
      vault: fakeVault(),
      assetDataNotifier: notifier
    });
    const ac = new AbortController();
    await task.run({ signal: ac.signal, reason: "test", reportProgress() {} });
    expect(db.replaceAll).toHaveBeenCalledTimes(1);
    const written = (db.replaceAll as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(written).toHaveLength(1);
    expect(written[0].symbol).toBe("GOOD");
  });

  it("无 active key 时直接返回，不调用 service", async () => {
    const db = fakeDb();
    const notifier = fakeNotifier();
    const svc = fakeService(SAMPLE_TOKENS);
    const task = createStasSyncTask({
      db: db as unknown as StasDb,
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
