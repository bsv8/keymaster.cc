import { describe, expect, it } from "vitest";
import { createCoordinatorWorkerUnitRegistry } from "./workerUnitRuntime.js";

describe("Coordinator Worker unit runtime registry", () => {
  it("binds owner services to one instance and rejects stale cleanup", () => {
    const registry = createCoordinatorWorkerUnitRegistry();
    const first = registry.activate("msfile.coordinator-worker", {
      ownerPublicKeyHex: "a",
      sessionEpoch: "epoch-a",
    });
    expect(registry.ready(first.unitId, first.instanceId).state).toBe("ready");
    expect(registry.activate("msfile.coordinator-worker", {
      ownerPublicKeyHex: "a",
      sessionEpoch: "epoch-a",
    }).instanceId).toBe(first.instanceId);
    expect(() => registry.activate("msfile.coordinator-worker", {
      ownerPublicKeyHex: "b",
      sessionEpoch: "epoch-b",
    })).toThrow(/其它 owner/);
    expect(registry.stop(first.unitId, "old-instance")).toBe(false);
    expect(registry.get(first.unitId)?.instanceId).toBe(first.instanceId);
    expect(registry.stop(first.unitId, first.instanceId)).toBe(true);
  });

  it("requires owner identity for owner-session units and keeps root units unbound", () => {
    const registry = createCoordinatorWorkerUnitRegistry();
    expect(() => registry.activate("window-p2p.coordinator-worker")).toThrow(/缺少 owner\/session/);
    const root = registry.activate("vault.coordinator-worker");
    expect(root.ownerPublicKeyHex).toBeUndefined();
    expect(() => registry.activate("vault.coordinator-worker", { ownerPublicKeyHex: "a" })).toThrow(/不得绑定 owner/);
  });

  it("does not let a late failed/ready result mutate a new instance", () => {
    const registry = createCoordinatorWorkerUnitRegistry();
    const old = registry.activate("storage.coordinator-worker");
    expect(registry.stop(old.unitId, old.instanceId)).toBe(true);
    const next = registry.activate("storage.coordinator-worker");
    expect(registry.fail(old.unitId, old.instanceId, new Error("late"))).toBeUndefined();
    expect(() => registry.ready(old.unitId, old.instanceId)).toThrow(/身份已过期/);
    expect(registry.get(next.unitId)).toMatchObject({ instanceId: next.instanceId, state: "starting" });
  });
});
