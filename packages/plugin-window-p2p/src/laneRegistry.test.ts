import { createInstanceRegistryService } from "@keymaster/runtime";
import { createFixtureHost } from "@keymaster/runtime/test-support";
import { WINDOW_P2P_EXECUTOR_CAPABILITY, type PluginContext, type WindowP2pExecutorLane, type WindowP2pExecutorLaneContext } from "@keymaster/contracts";
import { describe, expect, it, vi } from "vitest";
import { createWindowP2pLaneRegistry } from "./laneRegistry.js";

function lane(laneId: string) {
  return {
    laneId,
    start: vi.fn(),
    stop: vi.fn(),
    handle: vi.fn(async (operation: unknown) => ({ laneId, operation })),
    configure: vi.fn()
  };
}

describe("Window P2P lane registry", () => {
  it("attaches and dispatches multiple business lanes on one Host", async () => {
    const registry = createWindowP2pLaneRegistry();
    const msfile = lane("msfile");
    const sat = lane("sat-subscription");
    registry.register(msfile);
    registry.register(sat);
    const context = { host: { id: "single-host" }, ownerSessionEpoch: "epoch-1", emit: vi.fn() };

    await registry.attach(context);
    expect(msfile.start).toHaveBeenCalledWith(context);
    expect(sat.start).toHaveBeenCalledWith(context);
    await expect(registry.dispatch("sat-subscription", { type: "requestSsp" }, new AbortController().signal)).resolves.toEqual({
      laneId: "sat-subscription",
      operation: { type: "requestSsp" }
    });

    registry.configure({ version: 1 });
    expect(msfile.configure).toHaveBeenCalledWith({ version: 1 });
    expect(sat.configure).toHaveBeenCalledWith({ version: 1 });
    await registry.detach();
    expect(msfile.stop).toHaveBeenCalledTimes(1);
    expect(sat.stop).toHaveBeenCalledTimes(1);
  });

  it("replaces the old context before starting the next owner epoch", async () => {
    const registry = createWindowP2pLaneRegistry();
    const laneA = lane("a");
    registry.register(laneA);
    await registry.attach({ host: { id: "host-a" }, ownerSessionEpoch: "epoch-a", emit: vi.fn() });
    await registry.attach({ host: { id: "host-b" }, ownerSessionEpoch: "epoch-b", emit: vi.fn() });

    expect(laneA.stop).toHaveBeenCalledTimes(1);
    expect(laneA.start).toHaveBeenNthCalledWith(2, expect.objectContaining({ ownerSessionEpoch: "epoch-b" }));
  });

  it("replaces a stale lane with the same id when owner rebuilds race its teardown", async () => {
    const registry = createWindowP2pLaneRegistry();
    const context = { host: { id: "single-host" }, ownerSessionEpoch: "epoch-1", emit: vi.fn() };
    const stale = lane("sat-subscription");
    const offStale = registry.register(stale);
    const fresh = lane("sat-subscription");
    registry.register(fresh);

    // 旧实例立即停用；身份切换不会把新实例打成 error-disabled。
    expect(stale.stop).toHaveBeenCalledTimes(1);
    await registry.attach(context);
    expect(fresh.start).toHaveBeenCalledWith(context);
    await expect(registry.dispatch("sat-subscription", { type: "requestSsp" }, new AbortController().signal)).resolves.toEqual({
      laneId: "sat-subscription",
      operation: { type: "requestSsp" }
    });

    // 旧实例迟到的注销不能误删新 lane。
    offStale();
    await expect(registry.dispatch("sat-subscription", { type: "requestSsp" }, new AbortController().signal)).resolves.toEqual({
      laneId: "sat-subscription",
      operation: { type: "requestSsp" }
    });
  });

  it("rejects invalid lane ids", () => {
    const registry = createWindowP2pLaneRegistry();
    expect(() => registry.register({ ...lane(""), laneId: "" })).toThrow(/invalid/);
  });
});

it("keeps projected P2P lane identities independent across registration, stop and removal", async () => {
  const registry = createWindowP2pLaneRegistry();
  const cap = WINDOW_P2P_EXECUTOR_CAPABILITY;
  const service = createInstanceRegistryService({ register: registry.register.bind(registry) }, cap, {
    name: cap.id, registrations: [{ method: "register" }], cleanupMethods: ["stop"],
    projectRegistration(input) {
      const lane = input as WindowP2pExecutorLane;
      return { id: lane.laneId, laneId: lane.laneId, start: lane.start.bind(lane), stop: lane.stop.bind(lane), handle: lane.handle.bind(lane) };
    },
  });
  let context!: PluginContext;
  class Lane {
    constructor(readonly laneId: string) {}
    start() {} stop() {}
    async handle() { return this.laneId; }
  }
  const host = createFixtureHost({ runtime: "window-main", capabilities: [{ capability: cap, value: service }], runtimeUnitImplementationRegistry: { get: () => ctx => { context = ctx; } } });
  try {
    await host.register({ id: "lanes", name: "Lanes", units: [{ id: "lanes.window", runtime: "window-main", scopeKind: "root", dependencies: [{ capability: cap, sourceRuntime: "window-main" }] }] });
    const bound = context.capability(cap);
    const removeMsfile = bound.register(new Lane("msfile"));
    bound.register(new Lane("sat-subscription")); bound.register(new Lane("forum"));
    const laneContext = { host: {}, ownerSessionEpoch: "epoch", emit() {} } as WindowP2pExecutorLaneContext;
    await registry.attach(laneContext);
    for (const id of ["msfile", "sat-subscription", "forum"]) await expect(registry.dispatch(id, {}, new AbortController().signal)).resolves.toBe(id);
    // Host detach stops execution, but does not revoke live registrations.
    await registry.detach(); await registry.attach(laneContext);
    await expect(registry.dispatch("msfile", {}, new AbortController().signal)).resolves.toBe("msfile");
    removeMsfile();
    await expect(registry.dispatch("msfile", {}, new AbortController().signal)).rejects.toThrow("unavailable");
    await expect(registry.dispatch("sat-subscription", {}, new AbortController().signal)).resolves.toBe("sat-subscription");
    await expect(registry.dispatch("forum", {}, new AbortController().signal)).resolves.toBe("forum");
    await host.revoke("lanes", "test");
    await expect(registry.dispatch("forum", {}, new AbortController().signal)).rejects.toThrow();
  } finally { await host.dispose(); }
});
