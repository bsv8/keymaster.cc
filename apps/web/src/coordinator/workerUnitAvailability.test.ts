import { describe, expect, it } from "vitest";
import {
  COORDINATOR_TRANSPORT_UNIT_ID,
  describeUnitUnavailableForFramework,
  evaluateCoordinatorUnitAvailability,
  evaluateCoordinatorUnitConstructionPreconditions,
  evaluateCoordinatorUnitStartupPreconditions,
  isCoordinatorUnitAvailable,
  type CoordinatorUnitAvailabilityContext,
} from "./workerUnitAvailability.js";
import {
  COORDINATOR_WORKER_UNIT_CATALOG,
  type CoordinatorWorkerUnitDescriptor,
} from "./workerUnitCatalog.js";

const CATALOG: readonly CoordinatorWorkerUnitDescriptor[] = [
  {
    productId: "p2pkh",
    unitId: "p2pkh.coordinator-worker",
    runtime: "shared-worker",
    scopeKind: "owner-session",
    taskIds: ["p2pkh.transactions-sync"],
    // 两个依赖同时不满足时必须逐条列出，不允许只报第一个。
    dependsOn: ["woc.coordinator-worker", "token-stas.coordinator-worker"],
    serviceIds: ["p2pkh.provider-registry"],
    storageDeclarations: [],
    storagePurposeIds: [],
    finalIoAuditEntries: [{ taskId: "p2pkh.transactions-sync", operation: "p2pkh.sync" }],
  },
  {
    productId: "woc",
    unitId: "woc.coordinator-worker",
    runtime: "shared-worker",
    scopeKind: "root",
    taskIds: ["chain.chain-height-sync"],
    dependsOn: [],
    serviceIds: ["woc.service"],
    storageDeclarations: [],
    storagePurposeIds: [],
    finalIoAuditEntries: [{ taskId: "chain.chain-height-sync", operation: "chain.height-sync" }],
  },
  {
    productId: "token-stas",
    unitId: "token-stas.coordinator-worker",
    runtime: "shared-worker",
    scopeKind: "root",
    taskIds: ["token-stas.sync"],
    // 依赖链：token-stas 自己也要 woc，于是「依赖的依赖」可以逐层展开。
    dependsOn: ["woc.coordinator-worker"],
    serviceIds: ["token-stas.service"],
    storageDeclarations: [],
    storagePurposeIds: [],
    finalIoAuditEntries: [{ taskId: "token-stas.sync", operation: "token-stas.sync" }],
  },
  {
    productId: "msfile",
    unitId: "msfile.coordinator-worker",
    runtime: "shared-worker",
    scopeKind: "owner-session",
    taskIds: [],
    dependsOn: ["sat-subscription.coordinator-worker"],
    serviceIds: ["msfile.service"],
    storageDeclarations: [],
    storagePurposeIds: [],
    finalIoAuditEntries: [],
  },
  {
    productId: "sat-subscription",
    unitId: "sat-subscription.coordinator-worker",
    runtime: "shared-worker",
    scopeKind: "owner-session",
    taskIds: [],
    // 无服务依赖仍需 owner 会话与自身就绪。
    dependsOn: [],
    serviceIds: ["sat-subscription.service"],
    storageDeclarations: [],
    storagePurposeIds: [],
    finalIoAuditEntries: [],
  },
  {
    productId: "storage",
    unitId: "storage.coordinator-worker",
    runtime: "shared-worker",
    scopeKind: "storage",
    taskIds: [],
    dependsOn: [],
    serviceIds: ["storage.runtime-controller"],
    storageDeclarations: [],
    storagePurposeIds: [],
    finalIoAuditEntries: [],
  },
];

function context(overrides: Partial<CoordinatorUnitAvailabilityContext> = {}): CoordinatorUnitAvailabilityContext {
  return {
    isUnitReady: () => true,
    isStorageReady: () => true,
    isOwnerSessionAvailable: () => true,
    catalog: CATALOG,
    ...overrides,
  };
}

const reasons = (unitId: string, overrides: Partial<CoordinatorUnitAvailabilityContext> = {}) =>
  evaluateCoordinatorUnitAvailability(unitId, context(overrides)).reasons.map(({ code, dependencyId }) => [code, dependencyId]);

describe("单元可用性统一判定", () => {
  it("实际依赖、作用域及自身就绪时可用", () => {
    expect(evaluateCoordinatorUnitAvailability("p2pkh.coordinator-worker", context())).toMatchObject({
      state: "ready", reasons: [], dependsOn: ["woc.coordinator-worker", "token-stas.coordinator-worker"],
    });
  });
  it("自身未就绪只列自身原因", () => {
    expect(reasons("p2pkh.coordinator-worker", { isUnitReady: id => id !== "p2pkh.coordinator-worker" }))
      .toEqual([["unit-not-ready", "p2pkh.coordinator-worker"]]);
  });
  it("多个实际依赖未就绪时全部列出，并展开依赖链", () => {
    expect(reasons("p2pkh.coordinator-worker", { isUnitReady: () => false })).toEqual([
      ["unit-not-ready", "woc.coordinator-worker"],
      ["dependency-not-ready", "token-stas.coordinator-worker"],
      ["unit-not-ready", "woc.coordinator-worker"],
      ["unit-not-ready", "token-stas.coordinator-worker"],
      ["unit-not-ready", "p2pkh.coordinator-worker"],
    ]);
  });
  it("子单元只有自身未就绪时不重复列依赖关系", () => {
    expect(reasons("p2pkh.coordinator-worker", { isUnitReady: id => id !== "token-stas.coordinator-worker" }))
      .toEqual([["unit-not-ready", "token-stas.coordinator-worker"]]);
  });
  it("不存在的依赖声明即使运行态声称 ready 也不放行", () => {
    const catalog = CATALOG.map(unit => unit.unitId === "p2pkh.coordinator-worker"
      ? { ...unit, dependsOn: ["woc"] } : unit);
    expect(reasons("p2pkh.coordinator-worker", { catalog }))
      .toEqual([["unit-unknown", "woc"]]);
  });
  it("作用域分别核对 Storage 根和 owner 会话", () => {
    expect(reasons("storage.coordinator-worker", { isStorageReady: () => false }))
      .toEqual([["storage-root-unavailable", undefined]]);
    expect(reasons("sat-subscription.coordinator-worker", { isOwnerSessionAvailable: () => false }))
      .toEqual([["owner-session-unavailable", undefined]]);
  });
  it("无服务依赖的单元仍要求自身就绪", () => {
    expect(reasons("sat-subscription.coordinator-worker", { isUnitReady: () => false }))
      .toEqual([["unit-not-ready", "sat-subscription.coordinator-worker"]]);
  });
  it("未知单元不静默放行", () => {
    expect(reasons("unknown")).toEqual([["unit-unknown", "unknown"]]);
    expect(isCoordinatorUnitAvailable("unknown", context())).toBe(false);
  });
  it("传输层基础设施不受钱包作用域影响", () => {
    expect(evaluateCoordinatorUnitStartupPreconditions(COORDINATOR_TRANSPORT_UNIT_ID,
      context({ isStorageReady: () => false, isOwnerSessionAvailable: () => false }))).toMatchObject({ state: "ready" });
  });
  it("启动门不要求自身 ready，避免启动死锁", () => {
    expect(evaluateCoordinatorUnitStartupPreconditions("p2pkh.coordinator-worker",
      context({ isUnitReady: id => id !== "p2pkh.coordinator-worker" }))).toMatchObject({ state: "ready" });
  });
  it("启动门要求实际依赖，构造门保留依赖不可用时的诊断与业务设置路径", () => {
    const down = context({ isUnitReady: () => false });
    expect(evaluateCoordinatorUnitStartupPreconditions("p2pkh.coordinator-worker", down).state).toBe("failed");
    expect(evaluateCoordinatorUnitConstructionPreconditions("p2pkh.coordinator-worker", down))
      .toMatchObject({ state: "ready", reasons: [] });
    expect(evaluateCoordinatorUnitConstructionPreconditions("p2pkh.coordinator-worker",
      context({ isOwnerSessionAvailable: () => false })).state).toBe("failed");
  });
  it("坏目录的循环依赖不导致无限递归", () => {
    const catalog = CATALOG.map(unit => unit.unitId === "woc.coordinator-worker"
      ? { ...unit, dependsOn: ["p2pkh.coordinator-worker"] } : unit);
    expect(reasons("p2pkh.coordinator-worker", { catalog, isUnitReady: () => false }))
      .toContainEqual(["dependency-not-ready", "p2pkh.coordinator-worker"]);
  });
  it("原因文案使用稳定 i18n key 与真实 unitId", () => {
    expect(evaluateCoordinatorUnitAvailability("p2pkh.coordinator-worker",
      context({ isUnitReady: id => id !== "p2pkh.coordinator-worker" })).reasons[0]?.text).toEqual({
      key: "coordinator.unitUnavailable.unitNotReady",
      fallback: "Runtime unit has not finished starting", values: { unit: "p2pkh.coordinator-worker" },
    });
  });
  it("框架门保留逐条原因，可用时返回 undefined", () => {
    expect(describeUnitUnavailableForFramework(evaluateCoordinatorUnitAvailability("p2pkh.coordinator-worker",
      context({ isUnitReady: id => id !== "p2pkh.coordinator-worker" }))))
      .toBe("unit-not-ready:p2pkh.coordinator-worker");
    expect(describeUnitUnavailableForFramework(evaluateCoordinatorUnitAvailability("p2pkh.coordinator-worker", context())))
      .toBeUndefined();
  });
  it("内置目录仅含真实单元依赖且无产品/自身依赖", () => {
    const ids = new Set(COORDINATOR_WORKER_UNIT_CATALOG.map(unit => unit.unitId));
    for (const unit of COORDINATOR_WORKER_UNIT_CATALOG) {
      expect(unit.dependsOn).not.toContain(unit.productId);
      expect(unit.dependsOn).not.toContain(unit.unitId);
      for (const dependency of unit.dependsOn) expect(ids.has(dependency)).toBe(true);
    }
    expect(COORDINATOR_WORKER_UNIT_CATALOG.find(unit => unit.productId === "p2pkh")?.dependsOn)
      .toEqual(["storage.coordinator-worker", "woc.coordinator-worker", "vault.coordinator-worker"]);
  });
});
