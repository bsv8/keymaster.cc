import { expect, it } from "vitest";
import { createLifecycleScope } from "webloom-framework";
import { createMsFileWorkerService } from "./msfileWorkerService.js";
import { createUnavailableMsFileTransport } from "./msfileTransport.js";
import { createInMemoryMsFileRepositoryStores } from "./storage/inMemoryOwnerFileStore.testutil.js";
import { createMsFileWorkerBitfsService } from "./msfileWorkerBitfsService.js";

const owner = "03259a4417b4bbeac58c3894ae4c7ce02c72f6f5ff2a4dba0ec9503b5fbd1064e2";

it("projects the real local Worker service and fences BitFS calls after withdrawal", async () => {
  const scope = createLifecycleScope({ kind: "runtime-unit" });
  const local = await createMsFileWorkerService({ stores: createInMemoryMsFileRepositoryStores(owner),
    transport: createUnavailableMsFileTransport(), assertFresh: () => scope.assertActive(), notifyStateChange: () => {} });
  const calls: unknown[] = [];
  const view = createMsFileWorkerBitfsService(local, async control => { calls.push(control); return undefined; }, () => scope.assertActive());
  try {
    // A local implementation has prototype methods but no BitFS buyer methods.
    expect(Reflect.get(local, "publishBitfsDemand")).toBeUndefined();
    expect(view.status()).toBe(local.status());
    expect(typeof view.publishBitfsDemand).toBe("function");
    expect(typeof view.getBitfsDemand).toBe("function");
    expect(typeof view.startBitfsPurchase).toBe("function");
    expect(Object.getPrototypeOf(view)).toBeNull();
    expect(Object.isFrozen(view)).toBe(true);
    expect(Reflect.get(view, "dispose")).toBeUndefined();
    await view.cancelBitfsDemand!("ab".repeat(32));
    expect(calls).toEqual([{ type: "bitfs.demand.cancel", seedHashHex: "ab".repeat(32) }]);
    scope.revoke();
    expect(() => view.startBitfsPurchase!("ab".repeat(32), "session-1", "1")).toThrow();
    expect(calls).toHaveLength(1);
  } finally { local.dispose(); await scope.dispose(); }
});

it("rejects a late BitFS result and never accepts an absent snapshot as purchase success", async () => {
  const scope = createLifecycleScope({ kind: "runtime-unit" });
  const local = await createMsFileWorkerService({ stores: createInMemoryMsFileRepositoryStores(owner),
    transport: createUnavailableMsFileTransport(), assertFresh: () => scope.assertActive(), notifyStateChange: () => {} });
  let finish!: () => void;
  const pending = new Promise<undefined>(resolve => { finish = () => resolve(undefined); });
  const view = createMsFileWorkerBitfsService(local, () => pending, () => scope.assertActive());
  try {
    const result = view.cancelBitfsDemand!("ab".repeat(32));
    scope.revoke(); finish();
    await expect(result).rejects.toThrow();
    const active = createMsFileWorkerBitfsService(local, async () => undefined, () => {});
    await expect(active.publishBitfsDemand!("ab".repeat(32))).rejects.toThrow("no demand snapshot");
  } finally { local.dispose(); await scope.dispose(); }
});
