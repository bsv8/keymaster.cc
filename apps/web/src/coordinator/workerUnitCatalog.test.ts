import { describe, expect, it } from "vitest";
import {
  COORDINATOR_WORKER_UNIT_CATALOG,
  getCoordinatorWorkerAuditOperationForTask,
  getCoordinatorWorkerProductDependenciesForTask,
  getCoordinatorWorkerUnitForTask,
  validateCoordinatorWorkerUnitCatalog,
} from "./workerUnitCatalog.js";

describe("Coordinator Worker unit catalog", () => {
  it("keeps migrated product, unit, task and final-I/O identities aligned", () => {
    expect(validateCoordinatorWorkerUnitCatalog()).toEqual([]);
    expect(COORDINATOR_WORKER_UNIT_CATALOG).toHaveLength(11);
    expect(COORDINATOR_WORKER_UNIT_CATALOG.find((unit) => unit.unitId === "storage.coordinator-worker")).toMatchObject({
      productId: "storage",
      scopeKind: "storage",
      serviceIds: ["storage.runtime-controller"],
      taskIds: [],
    });
    expect(getCoordinatorWorkerUnitForTask("p2pkh.transactions-sync")).toMatchObject({
      productId: "p2pkh",
      unitId: "p2pkh.coordinator-worker",
      finalIoAuditEntries: [
        { taskId: "p2pkh.transactions-sync", operation: "p2pkh.sync" },
        { taskId: "p2pkh.utxo-snapshot", operation: "p2pkh.utxo-snapshot" },
      ],
    });
    expect(getCoordinatorWorkerAuditOperationForTask("p2pkh.transactions-sync")).toBe("p2pkh.sync");
    expect(getCoordinatorWorkerAuditOperationForTask("p2pkh.utxo-snapshot")).toBe("p2pkh.utxo-snapshot");
  });

  it("rejects duplicate product, unit and task identities", () => {
    const contactsUnit = COORDINATOR_WORKER_UNIT_CATALOG.find((unit) => unit.productId === "contacts")!;
    const duplicate = [
      ...COORDINATOR_WORKER_UNIT_CATALOG,
      {
        ...contactsUnit,
        productId: "p2pkh",
      },
    ];
    expect(validateCoordinatorWorkerUnitCatalog(duplicate)).toEqual([
      "Worker 单元未在产品运行单元契约中声明: contacts.coordinator-worker",
      "重复 productId: p2pkh",
      "重复 unitId: contacts.coordinator-worker",
      "Worker 单元引用未授权存储声明: contacts.coordinator-worker/address-book",
      "重复 taskId: contacts.presence-probe",
      "任务单元依赖必须包含自身产品: contacts.coordinator-worker",
      "重复 serviceId: contacts.service",
    ]);
  });

  it("rejects an unknown dependency id at startup instead of failing silently later", () => {
    const msfile = COORDINATOR_WORKER_UNIT_CATALOG.find((unit) => unit.unitId === "msfile.coordinator-worker")!;
    expect(validateCoordinatorWorkerUnitCatalog([
      ...COORDINATOR_WORKER_UNIT_CATALOG,
      { ...msfile, dependsOn: ["sat-subscription.coordinator-worker", "not-a-known-id"] },
    ])).toContain("单元引用未知依赖: msfile.coordinator-worker -> not-a-known-id");
  });

  it("rejects a cyclic unit dependency graph at startup", () => {
    // msfile → sat-subscription → msfile：可用性没有良定义的答案。
    const cyclic = COORDINATOR_WORKER_UNIT_CATALOG.map((unit) => {
      if (unit.unitId === "sat-subscription.coordinator-worker") return { ...unit, dependsOn: ["msfile.coordinator-worker"] };
      return unit;
    });
    expect(validateCoordinatorWorkerUnitCatalog(cyclic)).toEqual([
      "单元依赖图有环: msfile.coordinator-worker -> sat-subscription.coordinator-worker -> msfile.coordinator-worker",
    ]);
  });

  it("把产品依赖与单元依赖合并为一份清单，并保持任务产品依赖可单独取出", () => {
    const msfile = COORDINATOR_WORKER_UNIT_CATALOG.find((unit) => unit.unitId === "msfile.coordinator-worker")!;
    // 事故现场那条依赖过去只藏在调用代码的一行 await 里，现在有声明位置。
    expect(msfile.dependsOn).toEqual(["sat-subscription.coordinator-worker"]);
    // 单元依赖不参与任务的产品意图判定。
    expect(getCoordinatorWorkerProductDependenciesForTask("p2pkh.transactions-sync")).toEqual(["background", "p2pkh"]);
    expect(getCoordinatorWorkerProductDependenciesForTask("msfile-none")).toEqual([]);
  });
});
