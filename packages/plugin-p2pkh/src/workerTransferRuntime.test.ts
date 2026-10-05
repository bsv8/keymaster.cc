import { beforeEach, expect, it, vi } from "vitest";
import { createWorkerTransferRuntime, type WorkerTransferDependencies } from "./workerTransferRuntime.js";

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("./p2pkhService.js", () => ({ createP2pkhService: mocks.create }));
vi.mock("./centralBroadcastService.js", () => ({ createCentralBroadcastService: () => ({}) }));

beforeEach(() => mocks.create.mockReset());
function fixture() {
  let epoch = "first";
  let finish!: () => void;
  const startup = new Promise<void>(resolve => { finish = resolve; });
  const service = { onVaultUnlocked: vi.fn(() => startup), onVaultLocked: vi.fn(), dispose: vi.fn() };
  mocks.create.mockReturnValue(service);
  const deps: WorkerTransferDependencies = {
    assertActive: () => undefined,
    session: () => ({ owner: "owner", epoch, unlocked: true }),
    loadSettings: async () => undefined,
    settings: () => ({ includeTestnet: false }),
    walletState: () => { throw new Error("unused"); },
    storage: () => { throw new Error("unused"); },
    crypto: async () => { throw new Error("unused"); },
    vaultStatus: () => "unlocked",
    snapshot: async () => { throw new Error("unused"); },
    broadcast: async () => { throw new Error("unused"); },
    subscribeUtxo: () => () => undefined,
    retryOptions: () => undefined,
  };
  // Candidate creation only captures these ports; the mocked service does not use them.
  deps.walletState = () => ({}) as ReturnType<typeof deps.walletState>;
  deps.storage = () => ({}) as ReturnType<typeof deps.storage>;
  return { runtime: createWorkerTransferRuntime(deps), service, finish, changeEpoch: () => { epoch = "second"; } };
}
it("disposes a late candidate when the same owner enters a new epoch", async () => {
  const f = fixture();
  const pending = f.runtime.ensure();
  await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
  f.runtime.release();
  f.changeEpoch();
  f.finish();
  await expect(pending).rejects.toThrow("became stale");
  expect(f.service.onVaultLocked).toHaveBeenCalledOnce();
  expect(f.service.dispose).toHaveBeenCalledOnce();
});
it("shares one candidate across concurrent lazy consumers", async () => {
  const f = fixture();
  const first = f.runtime.ensure();
  const second = f.runtime.ensure();
  await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
  f.finish();
  expect(await first).toBe(f.service);
  expect(await second).toBe(f.service);
  f.runtime.release();
  expect(f.service.dispose).toHaveBeenCalledOnce();
});
