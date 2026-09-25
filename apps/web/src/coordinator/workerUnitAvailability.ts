// Coordinator Worker 单元可用性的**唯一**判定实现。
//
// 现行设计：docs/插件生命周期.md 的「单元可用性」一节。
//
// 判定规则：可用 = 插件开着 且 单元已就绪。读一个单元的「已就绪」就等于把
// 该单元这条 AND 整条求过值了：已就绪的含义即「我插件开着 + 我依赖的全可用 +
// 我已就绪」。递归通过依赖图自然完成，调用方不自己递归。
//
// 状态与诊断分离：状态字段只回答「能不能用」（二值 ready/failed），为什么不能
// 由 `reasons` 逐条承担。瞬时与永久在代码上没有区别——「还没好」和「永远不会
// 好」都是 `failed`，靠 reasons 解释，而不是靠不同的状态取值。
//
// 单一路径：框架门（`runtimeUnitAvailability`）、Worker 本地 `ensure*` 断言与
// 公开快照投影都从这里取值。框架内部状态到本判定结果的翻译也集中在本文件，
// 不散落到调用点。

import type {
  CoordinatorUnitAvailability,
  CoordinatorUnitUnavailableReason,
} from "@keymaster/contracts";
import {
  COORDINATOR_WORKER_UNIT_CATALOG,
  getCoordinatorWorkerDependenciesForUnit,
  type CoordinatorWorkerUnitDescriptor,
} from "./workerUnitCatalog.js";

/** 传输层单元标识；它是 Coordinator Host 的基础设施底座，不属于领域目录。 */
export const COORDINATOR_TRANSPORT_UNIT_ID = "keymaster.coordinator.transport";

/**
 * 判定所需的外部事实。
 *
 * 全部是无副作用读取函数：判定本身不得产生轮询、休眠或等待，也不得改写任何
 * 状态。变化由调用方订阅后重新求值。
 */
export interface CoordinatorUnitAvailabilityContext {
  /** 产品插件开关；未知产品必须返回 false。 */
  isProductEnabled(productId: string): boolean;
  /** 单元自身是否已就绪（WebLoom Host / 运行态注册表的当前状态）。 */
  isUnitReady(unitId: string): boolean;
  /** 中央 Storage 根是否已就绪。 */
  isStorageReady(): boolean;
  /** owner 会话是否可用（Vault 已解锁且有 active key）。 */
  isOwnerSessionAvailable(): boolean;
  /** 读取单元目录项；缺省读内置目录。 */
  catalog?: readonly CoordinatorWorkerUnitDescriptor[];
}

function descriptorOf(
  unitId: string,
  catalog: readonly CoordinatorWorkerUnitDescriptor[],
): CoordinatorWorkerUnitDescriptor | undefined {
  return catalog.find((unit) => unit.unitId === unitId);
}

type UnitUnavailableText = Exclude<CoordinatorUnitUnavailableReason["text"], string>;

/**
 * 原因文案。
 *
 * 兜底文案一律英文（与仓库默认语言一致），中文走 i18n 资源；`values` 用于
 * 插值，使 key 保持稳定可断言。
 */
export function describeUnitUnavailableReason(reason: CoordinatorUnitUnavailableReason): UnitUnavailableText {
  const dependency = reason.dependencyId ?? "";
  switch (reason.code) {
    case "plugin-disabled":
      return { key: "coordinator.unitUnavailable.pluginDisabled", fallback: `Plugin disabled: ${dependency}`, values: { product: dependency } };
    case "dependency-disabled":
      return { key: "coordinator.unitUnavailable.dependencyDisabled", fallback: `Required plugin disabled: ${dependency}`, values: { product: dependency } };
    case "dependency-not-ready":
      return { key: "coordinator.unitUnavailable.dependencyNotReady", fallback: `Required runtime unit is not ready: ${dependency}`, values: { unit: dependency } };
    case "storage-root-unavailable":
      return { key: "coordinator.unitUnavailable.storageRootUnavailable", fallback: "Storage root is not ready" };
    case "owner-session-unavailable":
      return { key: "coordinator.unitUnavailable.ownerSessionUnavailable", fallback: "Vault is not unlocked" };
    case "unit-not-ready":
      return { key: "coordinator.unitUnavailable.unitNotReady", fallback: "Runtime unit has not finished starting", values: { unit: dependency } };
    case "unit-unknown":
      return { key: "coordinator.unitUnavailable.unitUnknown", fallback: `Runtime unit is not registered: ${dependency}`, values: { unit: dependency } };
  }
}

function reason(
  code: CoordinatorUnitUnavailableReason["code"],
  dependencyId?: string,
): CoordinatorUnitUnavailableReason {
  const base = dependencyId === undefined ? { code } : { code, dependencyId };
  return { ...base, text: describeUnitUnavailableReason(base as CoordinatorUnitUnavailableReason) };
}

interface EvaluationOptions {
  /**
   * 求值到哪一层。
   *
   * 三层共用同一次实现，区别只在「求到哪」：
   * - `startup`：调度器问的「现在能不能起这个单元」——插件 + 作用域 + 声明依赖。
   * - `construction`：构造函数问的「现在能不能把运行对象建出来」——插件 + 作用域。
   *   依赖不参与：依赖是**使用**前置条件（例如卖方要收款运行时），不是**构造**
   *   前置条件。否则依赖一掉线，连「把用户开关关掉」都做不到。
   * - `availability`：`selfReady` 参与，得到「现在能不能用」。
   */
  layer: "startup" | "construction" | "availability";
}

function evaluate(
  unitId: string,
  context: CoordinatorUnitAvailabilityContext,
  options: EvaluationOptions,
  visiting: ReadonlySet<string>,
): CoordinatorUnitAvailability {
  const catalog = context.catalog ?? COORDINATOR_WORKER_UNIT_CATALOG;
  const unit = descriptorOf(unitId, catalog);
  if (!unit) {
    // 传输层单元是 Coordinator Host 的基础设施底座，刻意不在领域目录里：它没有
    // 声明也没有条件，因此恒可用。
    if (unitId === COORDINATOR_TRANSPORT_UNIT_ID) return { unitId, state: "ready", dependsOn: [], reasons: [] };
    return { unitId, state: "failed", dependsOn: [], reasons: [reason("unit-unknown", unitId)] };
  }
  const reasons: CoordinatorUnitUnavailableReason[] = [];
  if (!context.isProductEnabled(unit.productId)) {
    reasons.push(reason("plugin-disabled", unit.productId));
  }
  if (unit.scopeKind === "storage" && !context.isStorageReady()) {
    reasons.push(reason("storage-root-unavailable"));
  }
  if ((unit.scopeKind === "owner-session" || unit.scopeKind === "connect-session")
    && !context.isOwnerSessionAvailable()) {
    reasons.push(reason("owner-session-unavailable"));
  }
  for (const dependency of options.layer === "construction" ? [] : unit.dependsOn) {
    const dependencyUnit = descriptorOf(dependency, catalog);
    if (!dependencyUnit) {
      // 产品 id：只有插件开关这一个条件。没有依赖要等就是永远可用。
      if (!context.isProductEnabled(dependency)) reasons.push(reason("dependency-disabled", dependency));
      continue;
    }
    // 依赖链下钻。目录已静态校验无环，这里的守卫只是不让一个坏目录变成死循环。
    if (visiting.has(dependency)) {
      reasons.push(reason("dependency-not-ready", dependency));
      continue;
    }
    if (context.isUnitReady(dependency)) continue;
    // 下钻拿依赖自己的原因。若它给出的解释只有「我自己还没起来」这一条，那和
    // 「依赖 X 不可用」是同一句话，不重复列出同一个依赖两次；插件被停用、它
    // 自己的依赖不满足这类解释才值得和依赖关系一起呈现。
    const childReasons = evaluate(dependency, context, { layer: "availability" }, new Set([...visiting, dependency])).reasons;
    const explainsOnlyItself = childReasons.length === 1 && childReasons[0]?.code === "unit-not-ready";
    if (!explainsOnlyItself) reasons.push(reason("dependency-not-ready", dependency));
    reasons.push(...childReasons);
  }
  if (options.layer === "availability" && !context.isUnitReady(unitId)) {
    reasons.push(reason("unit-not-ready", unitId));
  }
  return { unitId, state: reasons.length === 0 ? "ready" : "failed", dependsOn: [...unit.dependsOn], reasons };
}

/**
 * 构造前置条件：不含「自身已就绪」，也不含声明依赖。
 *
 * `ensure*Runtime()` 用它。依赖是使用前置条件而不是构造前置条件：依赖暂时不可
 * 用时，运行对象仍然可以建起来（随后由能力自己如实报不可用并订阅变化），否则
 * 依赖一掉线，连「把用户开关关掉」这种必须永远可用的操作都做不到。
 */
export function evaluateCoordinatorUnitConstructionPreconditions(
  unitId: string,
  context: CoordinatorUnitAvailabilityContext,
): CoordinatorUnitAvailability {
  return evaluate(unitId, context, { layer: "construction" }, new Set([unitId]));
}

/**
 * 完整可用性：含「自身已就绪」这一项。公开快照与各能力自己的依赖门用它。
 */
export function evaluateCoordinatorUnitAvailability(
  unitId: string,
  context: CoordinatorUnitAvailabilityContext,
): CoordinatorUnitAvailability {
  return evaluate(unitId, context, { layer: "availability" }, new Set([unitId]));
}

/**
 * 启动前置条件：不含「自身已就绪」。框架门用它，避免「必须先就绪才能启动、
 * 启动才能就绪」的死锁。
 */
export function evaluateCoordinatorUnitStartupPreconditions(
  unitId: string,
  context: CoordinatorUnitAvailabilityContext,
): CoordinatorUnitAvailability {
  return evaluate(unitId, context, { layer: "startup" }, new Set([unitId]));
}

/**
 * 单元当前可用性；不在目录中的单元按不可用处理。
 */
export function isCoordinatorUnitAvailable(
  unitId: string,
  context: CoordinatorUnitAvailabilityContext,
): boolean {
  return evaluateCoordinatorUnitAvailability(unitId, context).state === "ready";
}

/**
 * 把不可用原因翻译成框架 `runtimeUnitAvailability` 需要的稳定字符串。
 *
 * 翻译必须集中在这里：框架内部有 `blocked` 状态而契约快照没有对应字段，翻译
 * 一旦散落，框架升级后就会错位。单条原因保持 `<code>[:<dependencyId>]` 的形状；
 * 多条原因逐条列出并用 `+` 连接，不允许只报第一个。
 */
export function describeUnitUnavailableForFramework(
  availability: CoordinatorUnitAvailability,
): string | undefined {
  if (availability.state === "ready") return undefined;
  // `failed` 必然带至少一条原因：evaluate 里状态就是由 reasons 是否为空决定的。
  // 末尾的 `|| "unit-unavailable"` 不是死分支而是兜底——空串在框架
  // `if (unavailable)` 里是 falsy，会把「不可用」误判成「可用」，必须 fail closed。
  return availability.reasons
    .map((item) => (item.dependencyId === undefined ? item.code : `${item.code}:${item.dependencyId}`))
    .join("+") || "unit-unavailable";
}

/** 判定不可用时抛出的错误；调用方据此区分「还没好」与真正的配置错误。 */
export class CoordinatorUnitUnavailableError extends Error {
  readonly unitId: string;
  readonly reasons: CoordinatorUnitUnavailableReason[];

  constructor(unitId: string, reasons: CoordinatorUnitUnavailableReason[]) {
    const summary = reasons
      .map((item) => (item.dependencyId === undefined ? item.code : `${item.code}:${item.dependencyId}`))
      .join("+");
    super(`Coordinator unit unavailable: ${unitId} (${summary})`);
    this.name = "CoordinatorUnitUnavailableError";
    this.unitId = unitId;
    this.reasons = reasons;
  }
}

export function isCoordinatorUnitUnavailableError(error: unknown): error is CoordinatorUnitUnavailableError {
  return error instanceof CoordinatorUnitUnavailableError;
}

export { getCoordinatorWorkerDependenciesForUnit };
