import { expect, it } from "vitest";
import { createWorkerFundingRuntime, type WorkerFundingDependencies } from "./workerFundingRuntime.js";
import { createInMemoryOwnerFileStore, IN_MEMORY_OWNER_PUBKEY } from "../storage/inMemoryOwnerFileStore.testutil.js";

it("rejects protected-funds results from the previous session even when the same key is unlocked again", async () => {
  const store = createInMemoryOwnerFileStore();
  let resolveList!: (page: Awaited<ReturnType<typeof store.list>>) => void;
  store.list = () => new Promise((resolve) => { resolveList = resolve; });
  let sessionEpoch = "first";
  const unused = () => { throw new Error("unused port"); };
  const deps: WorkerFundingDependencies = {
    session: () => ({ vaultStatus: "unlocked", activePublicKeyHex: IN_MEMORY_OWNER_PUBKEY, sessionEpoch }),
    journalStore: () => store,
    executor: unused, ensureResources: unused, snapshots: () => undefined,
    readP2pkhSettings: unused, maxFeeSatoshis: unused, deriveAddress: unused, addressScript: unused, parseTransaction: unused,
  };
  const runtime = createWorkerFundingRuntime(deps);
  const oldLedger = runtime.currentLedger();
  const filtered = runtime.filterSnapshot(IN_MEMORY_OWNER_PUBKEY, "main", { available: true, state: "fresh", items: [], seq: 1 });
  sessionEpoch = "second";
  resolveList({ files: [] });
  await expect(filtered).rejects.toThrow("owner changed");
  expect(runtime.currentLedger()).not.toBe(oldLedger);
});
