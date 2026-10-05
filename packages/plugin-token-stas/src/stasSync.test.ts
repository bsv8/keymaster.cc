import { walletStateFixtureSnapshot } from "@keymaster/runtime/test-support";
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
import type { StasRepository } from "./storage/stasRepository.js";
import type { StasServiceHandle } from "./stasService.js";
import type { AssetDataNotifier, VaultWalletState, VaultService } from "@keymaster/contracts";

function fakeWalletState(activePublicKeyHex?: string): VaultWalletState {
  return {
    snapshot: () => walletStateFixtureSnapshot((() => ({ activePublicKeyHex }))())
  } as unknown as VaultWalletState;
}

function fakeVault(): VaultService {
  return { status: () => "unlocked" } as unknown as VaultService;
}

function fakeRepository(): StasRepository & { replaceAll: ReturnType<typeof vi.fn> } {
  return { replaceAll: vi.fn(async () => {}) } as unknown as StasRepository & { replaceAll: ReturnType<typeof vi.fn> };
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
    const stateRepository = fakeRepository();
    const notifier = fakeNotifier();
    const task = createStasSyncTask({
      stateRepository: stateRepository as unknown as StasRepository,
      service: fakeService(SAMPLE_TOKENS),
      walletState: fakeWalletState("pk1"),
      vault: fakeVault(),
      assetDataNotifier: notifier
    });
    const ac = new AbortController();
    await task.run({ signal: ac.signal, reason: "test", reportProgress() {} });
    expect(stateRepository.replaceAll).toHaveBeenCalledTimes(1);
    expect(notifier.emit).toHaveBeenCalledTimes(1);
    expect(notifier.emit.mock.calls[0]![0].publicKeyHex).toBe("pk1");
  });

  it("signal 在 listActiveKeyTokens 前 aborted：不 replaceAll、不 emit", async () => {
    const stateRepository = fakeRepository();
    const notifier = fakeNotifier();
    const ac = new AbortController();
    ac.abort();
    const task = createStasSyncTask({
      stateRepository: stateRepository as unknown as StasRepository,
      service: fakeService(SAMPLE_TOKENS),
      walletState: fakeWalletState("pk1"),
      vault: fakeVault(),
      assetDataNotifier: notifier
    });
    await task.run({ signal: ac.signal, reason: "test", reportProgress() {} });
    expect(stateRepository.replaceAll).not.toHaveBeenCalled();
    expect(notifier.emit).not.toHaveBeenCalled();
  });

  it("signal 在 listActiveKeyTokens 后 aborted：不 replaceAll、不 emit", async () => {
    const stateRepository = fakeRepository();
    const notifier = fakeNotifier();
    const ac = new AbortController();
    const svc = fakeService(SAMPLE_TOKENS);
    (svc.listActiveKeyTokens as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      ac.abort();
      return SAMPLE_TOKENS;
    });
    const task = createStasSyncTask({
      stateRepository: stateRepository as unknown as StasRepository,
      service: svc,
      walletState: fakeWalletState("pk1"),
      vault: fakeVault(),
      assetDataNotifier: notifier
    });
    await task.run({ signal: ac.signal, reason: "test", reportProgress() {} });
    expect(stateRepository.replaceAll).not.toHaveBeenCalled();
    expect(notifier.emit).not.toHaveBeenCalled();
  });

  it("signal 在 replaceAll 后 aborted：不 emit", async () => {
    const stateRepository = fakeRepository();
    const notifier = fakeNotifier();
    const ac = new AbortController();
    (stateRepository.replaceAll as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      ac.abort();
    });
    const task = createStasSyncTask({
      stateRepository: stateRepository as unknown as StasRepository,
      service: fakeService(SAMPLE_TOKENS),
      walletState: fakeWalletState("pk1"),
      vault: fakeVault(),
      assetDataNotifier: notifier
    });
    await task.run({ signal: ac.signal, reason: "test", reportProgress() {} });
    expect(stateRepository.replaceAll).toHaveBeenCalledTimes(1);
    expect(notifier.emit).not.toHaveBeenCalled();
  });

  it("active key 在 replaceAll 后变化：不 emit", async () => {
    const stateRepository = fakeRepository();
    const notifier = fakeNotifier();
    let currentKey = "pk-old";
    const ks = {
      snapshot: () => walletStateFixtureSnapshot((() => ({ activePublicKeyHex: currentKey }))())
    } as unknown as VaultWalletState;
    (stateRepository.replaceAll as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      currentKey = "pk-new";
    });
    const task = createStasSyncTask({
      stateRepository: stateRepository as unknown as StasRepository,
      service: fakeService(SAMPLE_TOKENS),
      walletState: ks,
      vault: fakeVault(),
      assetDataNotifier: notifier
    });
    const ac = new AbortController();
    await task.run({ signal: ac.signal, reason: "test", reportProgress() {} });
    expect(stateRepository.replaceAll).toHaveBeenCalledTimes(1);
    expect(notifier.emit).not.toHaveBeenCalled();
  });

  it("balance <= 0 的 token 被过滤，不写入 DB", async () => {
    const stateRepository = fakeRepository();
    const notifier = fakeNotifier();
    const tokens: FakeStasToken[] = [
      { entry: { symbol: "GOOD", balance: 10 }, address: "a1", network: "main" },
      { entry: { symbol: "ZERO", balance: 0 }, address: "a2", network: "main" },
      { entry: { symbol: "NEG", balance: -5 }, address: "a3", network: "main" }
    ];
    const task = createStasSyncTask({
      stateRepository: stateRepository as unknown as StasRepository,
      service: fakeService(tokens),
      walletState: fakeWalletState("pk1"),
      vault: fakeVault(),
      assetDataNotifier: notifier
    });
    const ac = new AbortController();
    await task.run({ signal: ac.signal, reason: "test", reportProgress() {} });
    expect(stateRepository.replaceAll).toHaveBeenCalledTimes(1);
    const written = (stateRepository.replaceAll as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(written).toHaveLength(1);
    expect(written[0].symbol).toBe("GOOD");
  });

  it("无 active key 时直接返回，不调用 service", async () => {
    const stateRepository = fakeRepository();
    const notifier = fakeNotifier();
    const svc = fakeService(SAMPLE_TOKENS);
    const task = createStasSyncTask({
      stateRepository: stateRepository as unknown as StasRepository,
      service: svc,
      walletState: fakeWalletState(undefined),
      vault: fakeVault(),
      assetDataNotifier: notifier
    });
    const ac = new AbortController();
    await task.run({ signal: ac.signal, reason: "test", reportProgress() {} });
    expect(svc.listActiveKeyTokens).not.toHaveBeenCalled();
    expect(stateRepository.replaceAll).not.toHaveBeenCalled();
    expect(notifier.emit).not.toHaveBeenCalled();
  });
});

it.each(["epoch", "run", "wallet"])("does not persist late STAS results when the same key has a different %s", async generation => {
  let session = walletStateFixtureSnapshot({ activePublicKeyHex: "pk1" });
  let finish!: (value: typeof SAMPLE_TOKENS) => void;
  const repository = fakeRepository(); const notifier = fakeNotifier();
  const task = createStasSyncTask({ stateRepository: repository, assetDataNotifier: notifier, vault: fakeVault(),
    walletState: { snapshot: () => session, subscribe: () => () => {} },
    service: { listActiveKeyTokens: () => new Promise(resolve => { finish = resolve; }) } as never });
  const pending = task.run({ signal: new AbortController().signal, reason: "test", reportProgress() {} });
  session = { ...session, ...(generation === "epoch" ? { sessionEpoch: "new-epoch" } : generation === "run" ? { runGeneration: "new-run" } : { walletGeneration: "new-wallet" }) };
  finish(SAMPLE_TOKENS); await pending;
  expect(repository.replaceAll).not.toHaveBeenCalled(); expect(notifier.emit).not.toHaveBeenCalled();
});
