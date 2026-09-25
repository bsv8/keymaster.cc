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
    dependsOn: ["woc", "background", "token-stas.coordinator-worker"],
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
    dependsOn: ["background", "woc"],
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
    dependsOn: ["woc", "token-stas"],
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
    // 无依赖的单元：恒可用（只看插件开关），不需要额外规则。
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
    isProductEnabled: () => true,
    isUnitReady: () => true,
    isStorageReady: () => true,
    isOwnerSessionAvailable: () => true,
    catalog: CATALOG,
    ...overrides,
  };
}

describe("单元可用性统一判定", () => {
  it("插件开 + 单元就绪 → ready，reasons 为空", () => {
    const result = evaluateCoordinatorUnitAvailability("p2pkh.coordinator-worker", context());
    expect(result).toMatchObject({ state: "ready", reasons: [] });
    expect(result.dependsOn).toEqual(["woc", "background", "token-stas.coordinator-worker"]);
  });

  it("插件开 + 单元未就绪 → failed，含 unit-not-ready 及对应 dependencyId", () => {
    const result = evaluateCoordinatorUnitAvailability(
      "p2pkh.coordinator-worker",
      context({ isUnitReady: (unitId) => unitId !== "p2pkh.coordinator-worker" }),
    );
    expect(result.state).toBe("failed");
    expect(result.reasons).toEqual([
      expect.objectContaining({ code: "unit-not-ready", dependencyId: "p2pkh.coordinator-worker" }),
    ]);
  });

  it("插件关 → failed，含 plugin-disabled", () => {
    const result = evaluateCoordinatorUnitAvailability(
      "p2pkh.coordinator-worker",
      context({ isProductEnabled: (productId) => productId !== "p2pkh" }),
    );
    expect(result.state).toBe("failed");
    expect(result.reasons).toEqual([
      expect.objectContaining({ code: "plugin-disabled", dependencyId: "p2pkh" }),
    ]);
  });

  it("多依赖部分不满足 → reasons 逐条列出全部不满足项", () => {
    const result = evaluateCoordinatorUnitAvailability("p2pkh.coordinator-worker", context({
      isProductEnabled: (productId) => productId !== "woc" && productId !== "background",
      isUnitReady: (unitId) => unitId !== "p2pkh.coordinator-worker",
    }));
    expect(result.state).toBe("failed");
    expect(result.reasons.map((item) => [item.code, item.dependencyId])).toEqual([
      ["dependency-disabled", "woc"],
      ["dependency-disabled", "background"],
      ["unit-not-ready", "p2pkh.coordinator-worker"],
    ]);
  });

  it("依赖链下钻：依赖的依赖不满足也逐层展开", () => {
    // p2pkh → token-stas(单元) → woc(产品)；woc 被停用时整条链都要能看到。
    const result = evaluateCoordinatorUnitAvailability("p2pkh.coordinator-worker", context({
      isProductEnabled: (productId) => productId !== "woc",
      isUnitReady: () => false,
    }));
    expect(result.reasons.map((item) => [item.code, item.dependencyId])).toEqual([
      ["dependency-disabled", "woc"],
      ["dependency-not-ready", "token-stas.coordinator-worker"],
      ["dependency-disabled", "woc"],
      ["unit-not-ready", "token-stas.coordinator-worker"],
      ["unit-not-ready", "p2pkh.coordinator-worker"],
    ]);
  });

  it("同一依赖不被列两次：子原因只有「自己还没起来」时不重复列依赖关系", () => {
    // p2pkh → token-stas(单元) → woc(产品)，但 woc 这次是好的。
    // token-stas 的解释只有「我自己还没起来」，与「依赖 token-stas 不可用」是同一件事，
    // 因此同一个依赖只出现一次。
    const result = evaluateCoordinatorUnitAvailability("p2pkh.coordinator-worker", context({
      isProductEnabled: () => true,
      isUnitReady: () => false,
    }));
    expect(result.reasons.map((item) => [item.code, item.dependencyId])).toEqual([
      ["unit-not-ready", "token-stas.coordinator-worker"],
      ["unit-not-ready", "p2pkh.coordinator-worker"],
    ]);
  });

  it("子依赖有自己的原因时，依赖关系与子原因都要列出", () => {
    // 与上一条相反：token-stas 不可用是因为 woc 被停用，这是「依赖 token-stas
    // 不可用」之外的新信息，必须一起呈现。p2pkh 自身已就绪，因此不列它自己的
    // unit-not-ready。
    const result = evaluateCoordinatorUnitAvailability("p2pkh.coordinator-worker", context({
      isProductEnabled: (productId) => productId !== "woc",
      isUnitReady: (unitId) => unitId !== "token-stas.coordinator-worker",
    }));
    expect(result.reasons.map((item) => [item.code, item.dependencyId])).toEqual([
      ["dependency-disabled", "woc"],
      ["dependency-not-ready", "token-stas.coordinator-worker"],
      ["dependency-disabled", "woc"],
      ["unit-not-ready", "token-stas.coordinator-worker"],
    ]);
  });

  it("无依赖的单元：插件开就恒可用（不需要特判）", () => {
    const result = evaluateCoordinatorUnitAvailability("sat-subscription.coordinator-worker", context());
    expect(result).toMatchObject({ state: "ready", dependsOn: [], reasons: [] });
  });

  it("无单元的产品：只看插件开关，不产生依赖原因", () => {
    const result = evaluateCoordinatorUnitAvailability("woc.coordinator-worker", context({
      isUnitReady: () => true,
    }));
    expect(result.state).toBe("ready");
    // 产品 id 依赖只判插件开关；woc 自身产品开着即通过。
    expect(result.reasons).toEqual([]);
  });

  it("scopeKind 前置条件：storage 根与 owner 会话各自独立成一条原因", () => {
    expect(evaluateCoordinatorUnitAvailability("storage.coordinator-worker", context({ isStorageReady: () => false })))
      .toMatchObject({ state: "failed", reasons: [expect.objectContaining({ code: "storage-root-unavailable" })] });
    expect(evaluateCoordinatorUnitAvailability("sat-subscription.coordinator-worker", context({ isOwnerSessionAvailable: () => false })))
      .toMatchObject({ state: "failed", reasons: [expect.objectContaining({ code: "owner-session-unavailable" })] });
  });

  it("未登记的单元 → unit-unknown，不静默放行", () => {
    expect(evaluateCoordinatorUnitAvailability("nope.coordinator-worker", context())).toMatchObject({
      state: "failed",
      reasons: [expect.objectContaining({ code: "unit-unknown", dependencyId: "nope.coordinator-worker" })],
    });
    expect(isCoordinatorUnitAvailable("nope.coordinator-worker", context())).toBe(false);
  });

  it("传输层单元恒可用：它是 Host 的基础设施底座，不在领域目录里", () => {
    expect(evaluateCoordinatorUnitAvailability(COORDINATOR_TRANSPORT_UNIT_ID, context())).toMatchObject({
      state: "ready",
      reasons: [],
    });
    expect(evaluateCoordinatorUnitStartupPreconditions(COORDINATOR_TRANSPORT_UNIT_ID, context())).toMatchObject({
      state: "ready",
    });
  });

  it("启动前置条件不含「自身已就绪」，避免必须先就绪才能启动的死锁", () => {
    const ready = (unitId: string) => unitId !== "p2pkh.coordinator-worker";
    const full = evaluateCoordinatorUnitAvailability("p2pkh.coordinator-worker", context({ isUnitReady: ready }));
    const preconditions = evaluateCoordinatorUnitStartupPreconditions("p2pkh.coordinator-worker", context({ isUnitReady: ready }));
    expect(full.reasons.map((item) => item.code)).toEqual(["unit-not-ready"]);
    expect(preconditions).toMatchObject({ state: "ready", reasons: [] });
  });

  it("构造前置条件不含声明依赖：依赖掉线时运行对象仍可建起来，否则开关都关不掉", () => {
    const down = context({
      isProductEnabled: (productId) => productId !== "woc",
      isUnitReady: (unitId) => unitId !== "p2pkh.coordinator-worker",
    });
    // 框架门（启动）：依赖不满足 → 单元被阻塞，不启动。
    expect(evaluateCoordinatorUnitStartupPreconditions("p2pkh.coordinator-worker", down).reasons.map((item) => item.code))
      .toEqual(["dependency-disabled"]);
    // 构造：依赖不参与，插件与作用域满足就能建。
    expect(evaluateCoordinatorUnitConstructionPreconditions("p2pkh.coordinator-worker", down))
      .toMatchObject({ state: "ready", reasons: [] });
    // 完整可用性：依赖与自身就绪都算进去。
    expect(evaluateCoordinatorUnitAvailability("p2pkh.coordinator-worker", down).reasons.map((item) => item.code))
      .toEqual(["dependency-disabled", "unit-not-ready"]);
  });

  it("构造前置条件仍然挡住插件关闭与作用域未就绪", () => {
    expect(evaluateCoordinatorUnitConstructionPreconditions("p2pkh.coordinator-worker", context({
      isProductEnabled: (productId) => productId !== "p2pkh",
    })).reasons.map((item) => item.code)).toEqual(["plugin-disabled"]);
    expect(evaluateCoordinatorUnitConstructionPreconditions("p2pkh.coordinator-worker", context({
      isOwnerSessionAvailable: () => false,
    })).reasons.map((item) => item.code)).toEqual(["owner-session-unavailable"]);
  });

  it("原因文案：fallback 一律英文，key 与 values 稳定可断言", () => {
    const [pluginOff] = evaluateCoordinatorUnitAvailability("p2pkh.coordinator-worker", context({
      isProductEnabled: (productId) => productId !== "p2pkh",
    })).reasons;
    expect(pluginOff!.text).toEqual({
      key: "coordinator.unitUnavailable.pluginDisabled",
      fallback: "Plugin disabled: p2pkh",
      values: { product: "p2pkh" },
    });
    const [dependency] = evaluateCoordinatorUnitAvailability("p2pkh.coordinator-worker", context({
      isProductEnabled: (productId) => productId !== "woc",
    })).reasons;
    expect(dependency!.text).toEqual({
      key: "coordinator.unitUnavailable.dependencyDisabled",
      fallback: "Required plugin disabled: woc",
      values: { product: "woc" },
    });
    const [notReady] = evaluateCoordinatorUnitAvailability("p2pkh.coordinator-worker", context({
      isUnitReady: (unitId) => unitId !== "p2pkh.coordinator-worker",
    })).reasons;
    expect(notReady!.text).toEqual({
      key: "coordinator.unitUnavailable.unitNotReady",
      fallback: "Runtime unit has not finished starting",
      values: { unit: "p2pkh.coordinator-worker" },
    });
  });

  it("框架门翻译集中在判定实现：单条保持 <code>[:<dependencyId>]，多条逐条列出", () => {
    expect(describeUnitUnavailableForFramework(
      evaluateCoordinatorUnitAvailability("p2pkh.coordinator-worker", context({ isProductEnabled: (id) => id !== "p2pkh" })),
    )).toBe("plugin-disabled:p2pkh");
    expect(describeUnitUnavailableForFramework(
      evaluateCoordinatorUnitAvailability("p2pkh.coordinator-worker", context({ isUnitReady: () => false })),
    )).toBe("unit-not-ready:token-stas.coordinator-worker+unit-not-ready:p2pkh.coordinator-worker");
    expect(describeUnitUnavailableForFramework(
      evaluateCoordinatorUnitAvailability("p2pkh.coordinator-worker", context()),
    )).toBeUndefined();
  });

  it("内置目录：msfile 对 sat-subscription 的隐式依赖已补录", () => {
    expect(COORDINATOR_WORKER_UNIT_CATALOG.find((unit) => unit.unitId === "msfile.coordinator-worker")?.dependsOn)
      .toEqual(["sat-subscription.coordinator-worker"]);
  });
});
