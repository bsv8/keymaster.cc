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
    // 状态二值化：已激活但未就绪表达为 failed；旧实例的迟到结果不得改写它。
    expect(registry.get(next.unitId)).toMatchObject({ instanceId: next.instanceId, state: "failed" });
  });

  it("lets a failed unit become ready again and publishes dependsOn from the catalog", () => {
    const registry = createCoordinatorWorkerUnitRegistry();
    const unit = registry.activate("msfile.coordinator-worker", {
      ownerPublicKeyHex: "a",
      sessionEpoch: "epoch-a",
    });
    // 事故现场那条隐式依赖现在有声明位置。
    expect(unit.dependsOn).toEqual(["sat-subscription.coordinator-worker"]);
    registry.fail(unit.unitId, unit.instanceId, new Error("transient"));
    expect(registry.get(unit.unitId)?.state).toBe("failed");
    // failed 不是终态：依赖变化后必须能自己变回 ready，不要求用户再操作一次。
    expect(registry.ready(unit.unitId, unit.instanceId).state).toBe("ready");
    expect(registry.get(unit.unitId)?.error).toBeUndefined();
  });

  it("notifies every subscriber on both ready and failed, and stops after unsubscribe", () => {
    const registry = createCoordinatorWorkerUnitRegistry();
    const seen: string[] = [];
    const offA = registry.onChange(() => seen.push("a"));
    registry.onChange(() => seen.push("b"));
    const unit = registry.activate("storage.coordinator-worker");
    registry.ready(unit.unitId, unit.instanceId);
    registry.fail(unit.unitId, unit.instanceId, new Error("nope"));
    expect(seen).toEqual(["a", "b", "a", "b", "a", "b"]);
    offA();
    registry.stop(unit.unitId, unit.instanceId);
    expect(seen).toEqual(["a", "b", "a", "b", "a", "b", "b"]);
  });

  it("keeps notifying the remaining subscribers when one throws", () => {
    const registry = createCoordinatorWorkerUnitRegistry();
    const seen: string[] = [];
    registry.onChange(() => { throw new Error("bad observer"); });
    registry.onChange(() => seen.push("ok"));
    expect(() => registry.activate("storage.coordinator-worker")).not.toThrow();
    expect(seen).toEqual(["ok"]);
  });
});
