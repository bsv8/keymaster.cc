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

  it("does not accept duplicate lane ids", () => {
    const registry = createWindowP2pLaneRegistry();
    registry.register(lane("sat-subscription"));
    expect(() => registry.register(lane("sat-subscription"))).toThrow(/already registered/);
  });
});
