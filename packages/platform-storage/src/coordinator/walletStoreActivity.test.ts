import { expect, it, vi } from "vitest";
import type { WalletStore } from "@keymaster/contracts/storage-internal";
import { createWalletStoreActivity } from "./walletStoreActivity.js";
it("tracks concurrent aggregate I/O, drops secrets and releases counters on failure", async () => {
  const changed = vi.fn();
  let finish!: (value: undefined) => void;
  const source = { get: vi.fn(() => new Promise<undefined>(resolve => { finish = resolve; })), put: vi.fn(async () => { throw new Error("quota"); }) } as unknown as WalletStore;
  const tracker = createWalletStoreActivity(changed);
  const store = tracker.wrap(source);
  const reading = store.get("secret/path");
  const writing = store.put("secret/path", new Uint8Array([1, 2, 3]));
  expect(tracker.snapshot()).toEqual({ reads: 1, writes: 1 });
  await expect(writing).rejects.toThrow("quota");
  expect(tracker.snapshot()).toEqual({ reads: 1, writes: 0 });
  finish(undefined); await reading;
  expect(tracker.snapshot()).toEqual({ reads: 0, writes: 0 });
  expect(JSON.stringify(tracker.snapshot())).not.toContain("secret");
  expect(changed).toHaveBeenCalled();
});
