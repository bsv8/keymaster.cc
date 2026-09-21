import { describe, expect, it } from "vitest";
import {
  COORDINATOR_WORKER_UNIT_CATALOG,
  getCoordinatorWorkerAuditOperationForTask,
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
      "任务产品依赖必须包含自身产品: contacts.coordinator-worker",
      "重复 serviceId: contacts.service",
    ]);
  });
});
