import { expect, it } from "vitest";
import { createWorkerP2pkhSettings } from "./workerSettings.js";
import { createMemoryOwnerFileStore } from "./storage/testSupport/memoryOwnerFileStore.js";

it("does not restore retired settings or write after a session changes during the repository read", async () => {
  const files = createMemoryOwnerFileStore();
  let resolveGet!: (object: Awaited<ReturnType<typeof files.get>>) => void;
  files.get = () => new Promise((resolve) => { resolveGet = resolve; });
  let sessionEpoch = "first";
  const projection = { p2pkhSettings: { includeTestnet: false }, p2pkhProviderConfigs: {} };
  const settings = createWorkerP2pkhSettings({
    storage: () => files,
    session: () => ({ sessionEpoch, activePublicKeyHex: "owner" }),
    projection, beforeWrite: () => undefined, clearSnapshots: () => undefined,
    reschedule: async () => undefined, taskSnapshots: () => [], publishSnapshot: () => undefined, woc: () => undefined,
  });
  const loading = settings.load("owner");
  settings.reset();
  sessionEpoch = "second";
  resolveGet({ path: "setting.json", bytes: new TextEncoder().encode('{"includeTestnet":true}'), revision: "1", lastModified: "today" });
  await loading;
  expect(projection.p2pkhSettings.includeTestnet).toBe(false);
  const writing = settings.write({ includeTestnet: true });
  sessionEpoch = "third";
  resolveGet(undefined);
  await expect(writing).rejects.toThrow("became stale");
  expect(files.__files.size).toBe(0);
});
