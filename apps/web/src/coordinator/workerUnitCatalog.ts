// Coordinator Worker 领域运行单元目录。
//
// 这里登记的是已经真正由 SharedWorker 装配的领域单元，不是 24 个页面
// 产品的伪迁移清单。产品 id 表示用户启停对象，unitId 表示稳定的 Worker
// 运行单元，taskId 和最终 I/O 审计入口则把实际执行边界连接起来。

import type { FinalIoAuditOperation } from "./finalIoAudit.js";
import type { KeymasterScopeKind, PluginManifest, PluginStorageDeclaration } from "@keymaster/contracts";
import {
  BUILTIN_PLUGIN_PRODUCT_IDS,
  BUILTIN_PLUGIN_PRODUCT_ID_SET,
  getBuiltinPluginRuntimeUnits,
  SYSTEM_STORAGE_DECLARATIONS,
} from "@keymaster/contracts";

export interface CoordinatorWorkerUnitDescriptor {
  /** 用户可启停的产品标识。 */
  productId: string;
  /** 稳定的 Worker 运行单元标识，不是一次启动生成的实例标识。 */
  unitId: string;
  /** 执行环境；此目录只登记主 Coordinator Worker。 */
  runtime: "shared-worker";
  /** 运行单元的生命周期；领域任务随 owner 会话重建，管理外壳可跨 owner 存活。 */
  scopeKind: KeymasterScopeKind;
  /** 由该运行单元拥有的后台任务。 */
  taskIds: readonly string[];
  /**
   * 本单元可用所依赖的全部对象：产品 id 与其它单元 id 合并在一份清单里，
   * 统一按「是否可用」判定。原来的「产品级运行前置条件」不再是独立一层。
   */
  dependsOn: readonly string[];
  /** 由该运行单元拥有的 Worker 服务；服务单元可以没有周期任务。 */
  serviceIds?: readonly string[];
  /** 该真实 Worker 执行单元实际打开的中央命名存储声明。 */
  storageDeclarations: readonly PluginStorageDeclaration[];
  /** 与实际打开顺序对应的命名 purpose；禁止以“第一个声明”代替。 */
  storagePurposeIds: readonly string[];
  /** 任务进入最终 I/O lease 的审计入口；显式绑定 taskId，避免靠数组顺序猜测。 */
  finalIoAuditEntries: readonly {
    taskId: string;
    operation: FinalIoAuditOperation;
  }[];
}

/**
 * Worker 领域补充信息；产品、unit、execution 和 scopeKind 不在这里重复
 * 维护，统一从 contracts 的产品运行单元契约 materialize（物化）。
 */
interface CoordinatorWorkerUnitRuntimeDetails {
  /** 与 contracts 中稳定声明对应的运行单元标识。 */
  unitId: string;
  /** 由该运行单元拥有的后台任务。 */
  taskIds: readonly string[];
  /** 本单元可用所依赖的全部对象；产品 id 与单元 id 合并为一份。 */
  dependsOn: readonly string[];
  /** 由该运行单元拥有的 Worker 服务。 */
  serviceIds?: readonly string[];
  /** 由实际 Worker 实现打开的中央 purpose；声明对象由 contracts 目录解析。 */
  storagePurposes: readonly string[];
  /** 任务进入最终 I/O lease 的审计入口。 */
  finalIoAuditEntries: readonly {
    taskId: string;
    operation: FinalIoAuditOperation;
  }[];
}

/**
 * 当前已经迁移到 Coordinator Worker 的领域补充目录。
 *
 * `serviceIds` 不是 capability 别名，而是 Worker 运行时注册表中的稳定
 * 服务所有者标识；只有实际装配并激活的服务才会出现在运行快照中。
 */
const COORDINATOR_WORKER_UNIT_RUNTIME_DETAILS = [
  {
    unitId: "storage.coordinator-worker",
    taskIds: [],
    dependsOn: [],
    serviceIds: ["storage.runtime-controller"],
    storagePurposes: [],
    finalIoAuditEntries: [],
  },
  {
    unitId: "vault.coordinator-worker",
    taskIds: [],
    dependsOn: [],
    serviceIds: ["vault.keyspace", "vault.crypto"],
    storagePurposes: [],
    finalIoAuditEntries: [],
  },
  {
    unitId: "window-p2p.coordinator-worker",
    taskIds: [],
    dependsOn: [],
    serviceIds: ["window-p2p.executor-lease"],
    storagePurposes: [],
    finalIoAuditEntries: [],
  },
  {
    unitId: "msfile.coordinator-worker",
    taskIds: [],
    // 卖方需要收款运行时才能接单。这条依赖过去只藏在调用代码的一行 await
    // 里，任何声明位置都没有，因此预热中的竞态被当成永久配置错误。
    dependsOn: ["sat-subscription.coordinator-worker"],
    serviceIds: ["msfile.service"],
    // `<owner>/msfiles/` 文件根；`bitfs-journal` 保存不可逆协议证据；
    // App 覆盖额度按 publisher 惰性打开，不在此列举。
    storagePurposes: ["", "bitfs-journal"],
    finalIoAuditEntries: [],
  },
  {
    unitId: "sat-subscription.coordinator-worker",
    taskIds: [],
    dependsOn: [],
    serviceIds: ["sat-subscription.service", "channel.subscription-mux"],
    // `<owner>/sat-subscription/` 文件根；设置文件固定为 setting.json。
    storagePurposes: [""],
    finalIoAuditEntries: [],
  },
  {
    unitId: "contacts.coordinator-worker",
    taskIds: ["contacts.presence-probe"],
    dependsOn: ["background", "contacts"],
    serviceIds: ["contacts.service"],
    storagePurposes: ["address-book"],
    finalIoAuditEntries: [{ taskId: "contacts.presence-probe", operation: "contacts.presence-probe" }],
  },
  {
    unitId: "p2pkh.coordinator-worker",
    taskIds: ["p2pkh.transactions-sync", "p2pkh.utxo-snapshot"],
    dependsOn: ["background", "p2pkh"],
    serviceIds: ["p2pkh.provider-registry", "p2pkh.asset-service"],
    storagePurposes: [""],
    finalIoAuditEntries: [
      { taskId: "p2pkh.transactions-sync", operation: "p2pkh.sync" },
      { taskId: "p2pkh.utxo-snapshot", operation: "p2pkh.utxo-snapshot" },
    ],
  },
  {
    unitId: "token-bsv21.coordinator-worker",
    taskIds: ["token-bsv21.sync"],
    dependsOn: ["background", "p2pkh", "token-bsv21", "woc"],
    serviceIds: ["token-bsv21.service"],
    storagePurposes: ["token-state"],
    finalIoAuditEntries: [{ taskId: "token-bsv21.sync", operation: "token-bsv21.sync" }],
  },
  {
    unitId: "token-stas.coordinator-worker",
    taskIds: ["token-stas.sync"],
    dependsOn: ["background", "p2pkh", "token-stas", "woc"],
    serviceIds: ["token-stas.service"],
    storagePurposes: ["token-state"],
    finalIoAuditEntries: [{ taskId: "token-stas.sync", operation: "token-stas.sync" }],
  },
  {
    unitId: "collectible-1satordinals.coordinator-worker",
    taskIds: ["collectible-1satordinals.sync"],
    dependsOn: ["background", "p2pkh", "collectible-1satordinals", "woc"],
    serviceIds: ["collectible-1satordinals.service"],
    storagePurposes: [],
    finalIoAuditEntries: [{ taskId: "collectible-1satordinals.sync", operation: "collectible-1satordinals.sync" }],
  },
  {
    unitId: "woc.coordinator-worker",
    // 链高度同步读一次节点 `/chain/info` 就完成，没有本地写入；
    // 仍登记最终 I/O 审计入口，因为它和其它链上任务共用同一出口与配额。
    taskIds: ["chain.chain-height-sync"],
    dependsOn: ["background", "woc"],
    serviceIds: ["woc.service", "woc.bsv21", "woc.stas", "woc.1satordinals"],
    storagePurposes: [],
    finalIoAuditEntries: [{ taskId: "chain.chain-height-sync", operation: "chain.height-sync" }],
  },
] as const satisfies readonly CoordinatorWorkerUnitRuntimeDetails[];

/**
 * 从唯一产品运行单元契约生成 Coordinator Worker 目录。
 * 领域目录只补充 task/service/I/O 信息，不能自行改变产品归属或生命周期。
 */
export const COORDINATOR_WORKER_UNIT_CATALOG: readonly CoordinatorWorkerUnitDescriptor[] =
  COORDINATOR_WORKER_UNIT_RUNTIME_DETAILS.map((details) => {
    // 从所有内置产品声明中解析稳定 unitId，并在模块加载时 fail closed。
    const resolved = BUILTIN_PLUGIN_PRODUCT_IDS
      .flatMap((productId) => getBuiltinPluginRuntimeUnits(productId))
      .find((unit) => unit.unitId === details.unitId);
    if (!resolved || resolved.runtime !== "shared-worker") {
      throw new Error(`Worker 领域补充目录引用了未声明的 Coordinator unit: ${details.unitId}`);
    }
    return {
      productId: resolved.productId,
      unitId: resolved.unitId,
      runtime: resolved.runtime,
      scopeKind: resolved.scopeKind,
      taskIds: [...details.taskIds],
      storagePurposeIds: [...details.storagePurposes],
      storageDeclarations: details.storagePurposes.map((purposeId) => {
        const declaration = SYSTEM_STORAGE_DECLARATIONS[resolved.productId]?.find((candidate) => candidate.purposeId === purposeId);
        if (!declaration) {
          throw new Error(`Worker 领域补充目录引用了未声明的存储 purpose: ${resolved.productId}/${purposeId}`);
        }
        return { ...declaration };
      }),
      dependsOn: [...(details.dependsOn ?? [])],
      ...(details.serviceIds ? { serviceIds: [...details.serviceIds] } : {}),
      finalIoAuditEntries: [...details.finalIoAuditEntries],
    };
  });

function sameStorageDeclaration(left: PluginStorageDeclaration, right: PluginStorageDeclaration): boolean {
  return left.moduleId === right.moduleId
    && left.purposeId === right.purposeId
    && left.scope === right.scope
    && left.authority === right.authority
    && left.model === right.model
    && left.schemaVersion === right.schemaVersion;
}

function storageDeclarationsOfUnit(unit: {
  storage?: PluginStorageDeclaration;
  storages?: readonly PluginStorageDeclaration[];
}): PluginStorageDeclaration[] {
  return unit.storages ? [...unit.storages] : unit.storage ? [unit.storage] : [];
}

/** 返回任务对应的工作单元目录项；未知任务由测试注册入口或未来迁移使用。 */
export function getCoordinatorWorkerUnitForTask(taskId: string): CoordinatorWorkerUnitDescriptor | undefined {
  return COORDINATOR_WORKER_UNIT_CATALOG.find((unit) => unit.taskIds.some((candidate) => candidate === taskId));
}

/**
 * 返回任务依赖清单中的**产品**部分；调用方只能追加运行时选中的 Provider。
 *
 * 单元依赖不参与任务的产品意图判定：任务能否入队只看插件开关，单元是否可用
 * 由统一判定实现递归求值。
 */
export function getCoordinatorWorkerProductDependenciesForTask(taskId: string): readonly string[] {
  const dependsOn = getCoordinatorWorkerUnitForTask(taskId)?.dependsOn ?? [];
  return dependsOn.filter((dependency) => !isCoordinatorWorkerUnitId(dependency));
}

/** 依赖项是单元 id（非产品 id）时为真；以目录里真实登记的 unitId 为准。 */
export function isCoordinatorWorkerUnitId(dependency: string): boolean {
  return COORDINATOR_WORKER_UNIT_CATALOG.some((unit) => unit.unitId === dependency);
}

/** 返回单元的完整依赖清单（产品 id 与单元 id）。 */
export function getCoordinatorWorkerDependenciesForUnit(unitId: string): readonly string[] {
  return COORDINATOR_WORKER_UNIT_CATALOG.find((unit) => unit.unitId === unitId)?.dependsOn ?? [];
}

/** 在给定目录内判定依赖项是否为单元 id；目录可能不是内置目录本身。 */
function isCoordinatorWorkerUnitIdIn(
  catalog: readonly CoordinatorWorkerUnitDescriptor[],
  dependency: string,
): boolean {
  return catalog.some((unit) => unit.unitId === dependency);
}

/**
 * 依赖图必须无环。
 *
 * 判定沿依赖图递归求值；有环意味着可用性没有良定义的答案，因此启动期静态
 * 校验直接失败，不允许留到运行态再被发现。
 */
function validateCoordinatorUnitDependencyAcyclic(catalog: readonly CoordinatorWorkerUnitDescriptor[]): string[] {
  const errors: string[] = [];
  const dependenciesOf = new Map<string, string[]>();
  for (const unit of catalog) {
    dependenciesOf.set(
      unit.unitId,
      (unit.dependsOn ?? []).filter((dependency) => isCoordinatorWorkerUnitIdIn(catalog, dependency)),
    );
  }
  const settled = new Set<string>();
  const reported = new Set<string>();
  const visit = (unitId: string, path: readonly string[]): void => {
    if (settled.has(unitId)) return;
    if (path.includes(unitId)) {
      const cycle = [...path.slice(path.indexOf(unitId)), unitId];
      const key = [...cycle].sort().join("|");
      if (!reported.has(key)) {
        reported.add(key);
        errors.push(`单元依赖图有环: ${cycle.join(" -> ")}`);
      }
      return;
    }
    for (const dependency of dependenciesOf.get(unitId) ?? []) visit(dependency, [...path, unitId]);
    settled.add(unitId);
  };
  for (const unit of catalog) visit(unit.unitId, []);
  return errors;
}

/** 返回任务对应的最终 I/O 审计入口。 */
export function getCoordinatorWorkerAuditOperationForTask(taskId: string): FinalIoAuditOperation | undefined {
  for (const unit of COORDINATOR_WORKER_UNIT_CATALOG) {
    const entry = unit.finalIoAuditEntries.find((candidate) => candidate.taskId === taskId);
    if (entry) return entry.operation;
  }
  return undefined;
}

/**
 * 校验目录的唯一性和审计覆盖，避免新增任务时只补了运行代码却漏掉
 * 生命周期身份或不可逆 I/O 记录。
 */
export function validateCoordinatorWorkerUnitCatalog(
  catalog: readonly CoordinatorWorkerUnitDescriptor[] = COORDINATOR_WORKER_UNIT_CATALOG,
  manifests?: readonly PluginManifest[],
): string[] {
  const errors: string[] = [];
  const products = new Set<string>();
  const units = new Set<string>();
  const tasks = new Set<string>();
  const services = new Set<string>();

  for (const unit of catalog) {
    if (!BUILTIN_PLUGIN_PRODUCT_ID_SET.has(unit.productId)) {
      errors.push(`Worker 单元引用未知产品: ${unit.productId}`);
    }
    const declared = getBuiltinPluginRuntimeUnits(unit.productId).find((candidate) => candidate.unitId === unit.unitId);
    if (!declared) {
      errors.push(`Worker 单元未在产品运行单元契约中声明: ${unit.unitId}`);
    } else if (declared.runtime !== unit.runtime || declared.scopeKind !== unit.scopeKind) {
      errors.push(`Worker 单元与产品运行单元契约不一致: ${unit.unitId}`);
    }
    if (manifests) {
      const manifest = manifests.find((candidate) => candidate.id === unit.productId);
      const manifestUnit = manifest?.units?.find((candidate) => candidate.id === unit.unitId);
      if (!manifestUnit) {
        errors.push(`Worker 单元未在 manifest 中声明: ${unit.unitId}`);
      } else if (manifestUnit.runtime !== unit.runtime || manifestUnit.scopeKind !== unit.scopeKind) {
        errors.push(`Worker 单元与 manifest 描述不一致: ${unit.unitId}`);
      } else {
        const manifestDeclarations = storageDeclarationsOfUnit(manifestUnit);
        if (manifestDeclarations.length !== unit.storageDeclarations.length
          || manifestDeclarations.some((declaration, index) => {
            const expected = unit.storageDeclarations[index];
            return !expected || !sameStorageDeclaration(declaration, expected);
          })) {
          errors.push(`Worker 存储声明与 manifest 不一致: ${unit.unitId}`);
        }
      }
    }
    if (products.has(unit.productId)) errors.push(`重复 productId: ${unit.productId}`);
    products.add(unit.productId);
    if (units.has(unit.unitId)) errors.push(`重复 unitId: ${unit.unitId}`);
    units.add(unit.unitId);
    if (unit.runtime !== "shared-worker") errors.push(`Worker 单元 runtime 无效: ${unit.unitId}`);
    if (!["root", "storage", "owner-session"].includes(unit.scopeKind)) errors.push(`Worker 单元 scopeKind 无效: ${unit.unitId}`);
    if (new Set(unit.storagePurposeIds).size !== unit.storagePurposeIds.length) {
      errors.push(`重复 Worker 存储 purpose: ${unit.unitId}`);
    }
    if (unit.storagePurposeIds.length !== unit.storageDeclarations.length
      || unit.storagePurposeIds.some((purposeId, index) => unit.storageDeclarations[index]?.purposeId !== purposeId)) {
      errors.push(`Worker 存储 purpose 与声明不一致: ${unit.unitId}`);
    }
    const centralDeclarations = SYSTEM_STORAGE_DECLARATIONS[unit.productId] ?? [];
    for (const declaration of unit.storageDeclarations) {
      if (!centralDeclarations.some((candidate) => sameStorageDeclaration(candidate, declaration))) {
        errors.push(`Worker 单元引用未授权存储声明: ${unit.unitId}/${declaration.purposeId}`);
      }
    }
    const serviceIds = unit.serviceIds ?? [];
    if (unit.taskIds.length === 0 && serviceIds.length === 0) errors.push(`Worker 单元没有 taskId 或 serviceId: ${unit.unitId}`);
    if (unit.taskIds.length !== unit.finalIoAuditEntries.length) {
      errors.push(`任务和最终 I/O 审计数量不一致: ${unit.unitId}`);
    }
    for (const taskId of unit.taskIds) {
      if (tasks.has(taskId)) errors.push(`重复 taskId: ${taskId}`);
      tasks.add(taskId);
    }
    const dependsOn = unit.dependsOn ?? [];
    if (new Set(dependsOn).size !== dependsOn.length) {
      errors.push(`重复单元依赖: ${unit.unitId}`);
    }
    for (const dependency of dependsOn) {
      if (isCoordinatorWorkerUnitIdIn(catalog, dependency)) continue;
      if (!BUILTIN_PLUGIN_PRODUCT_ID_SET.has(dependency)) {
        errors.push(`单元引用未知依赖: ${unit.unitId} -> ${dependency}`);
      }
    }
    if (unit.taskIds.length > 0 && !dependsOn.includes(unit.productId)) {
      errors.push(`任务单元依赖必须包含自身产品: ${unit.unitId}`);
    }
    for (const serviceId of serviceIds) {
      if (services.has(serviceId)) errors.push(`重复 serviceId: ${serviceId}`);
      services.add(serviceId);
    }
    for (const entry of unit.finalIoAuditEntries) {
      if (!unit.taskIds.includes(entry.taskId)) errors.push(`审计入口引用了未知 taskId: ${entry.taskId}`);
      if (!entry.operation) errors.push(`缺少最终 I/O 审计 operation: ${unit.unitId}`);
    }
  }

  errors.push(...validateCoordinatorUnitDependencyAcyclic(catalog));

  if (manifests) {
    for (const manifest of manifests) {
      for (const unit of manifest.units ?? []) {
        if (unit.runtime !== "shared-worker") continue;
        if (!catalog.some((candidate) => candidate.productId === manifest.id && candidate.unitId === unit.id)) {
          errors.push(`manifest Worker 单元未进入 Worker 领域目录: ${unit.id}`);
        }
      }
    }
  }

  return errors;
}

/** 生产模块加载时立即阻止不完整的静态目录进入运行态。 */
export function assertCoordinatorWorkerUnitCatalog(): void {
  const errors = validateCoordinatorWorkerUnitCatalog();
  if (errors.length > 0) {
    throw new Error(`Coordinator Worker 单元目录无效: ${errors.join("；")}`);
  }
}
