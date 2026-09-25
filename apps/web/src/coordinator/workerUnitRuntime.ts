// Coordinator Worker 运行单元运行态注册表。
//
// 静态目录只回答“这个 unit 属于哪个产品、声明了哪些服务/任务”；本模块
// 记录“本次 Worker 当前实际激活的是哪个 instance”。两者必须同时存在，
// 否则静态 manifest 仍可能只是没有执行的迁移清单。

import type {
  CoordinatorWorkerUnitSnapshot,
  KeymasterScopeKind,
  SessionEpoch,
} from "@keymaster/contracts";
import {
  COORDINATOR_WORKER_UNIT_CATALOG,
  type CoordinatorWorkerUnitDescriptor,
} from "./workerUnitCatalog.js";

type OwnerIdentity = {
  ownerPublicKeyHex?: string;
  sessionEpoch?: SessionEpoch;
};

export interface CoordinatorWorkerUnitRegistry {
  /** 激活一个静态目录中已声明的 Worker 单元；重复传入同一身份时幂等。 */
  activate(unitId: string, identity?: OwnerIdentity & { instanceId?: string }): CoordinatorWorkerUnitSnapshot;
  /** 将正在初始化的单元标记为 ready；不存在或身份过期时拒绝。 */
  ready(unitId: string, instanceId: string): CoordinatorWorkerUnitSnapshot;
  /** 记录启动失败；旧实例不能覆盖后来已经激活的新实例。 */
  fail(unitId: string, instanceId: string, error: unknown): CoordinatorWorkerUnitSnapshot | undefined;
  /** 摘除指定实例；不允许旧清理误删新实例。 */
  stop(unitId: string, instanceId?: string): boolean;
  get(unitId: string): CoordinatorWorkerUnitSnapshot | undefined;
  snapshots(): CoordinatorWorkerUnitSnapshot[];
  /** 当前快照修订；每次实际状态/实例集合变化都会递增。 */
  revision(): number;
  /**
   * 订阅单元可用性变化；返回取消函数。
   *
   * `ready` 与 `failed` 双向都触发，不是只在变好时通知：消费方订阅后重判
   * 自身状态，重判必须幂等。任何环节不得用轮询、等待休眠或超时猜测代替订阅。
   */
  onChange(handler: () => void): () => void;
  /** 测试模拟 Worker 重启；生产代码不会调用。 */
  reset(): void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requiresOwner(scopeKind: KeymasterScopeKind): boolean {
  return scopeKind === "owner-session" || scopeKind === "connect-session";
}

function sameIdentity(
  current: CoordinatorWorkerUnitSnapshot,
  next: OwnerIdentity,
): boolean {
  return current.ownerPublicKeyHex === next.ownerPublicKeyHex
    && current.sessionEpoch === next.sessionEpoch;
}

function cloneSnapshot(snapshot: CoordinatorWorkerUnitSnapshot): CoordinatorWorkerUnitSnapshot {
  return {
    ...snapshot,
    serviceIds: [...snapshot.serviceIds],
    taskIds: [...snapshot.taskIds],
  };
}

export function createCoordinatorWorkerUnitRegistry(
  catalog: readonly CoordinatorWorkerUnitDescriptor[] = COORDINATOR_WORKER_UNIT_CATALOG,
): CoordinatorWorkerUnitRegistry {
  const byUnitId = new Map(catalog.map((unit) => [unit.unitId, unit]));
  const active = new Map<string, CoordinatorWorkerUnitSnapshot>();
  const subscribers = new Set<() => void>();
  let nextInstance = 0;
  let snapshotRevision = 0;

  function touch(): void {
    snapshotRevision += 1;
    for (const snapshot of active.values()) snapshot.snapshotRevision = snapshotRevision;
    // 订阅快照是观察面，不能让观察者异常破坏生命周期状态转换；因此每个
    // 订阅者单独捕获，不让一个坏订阅者掐断其余订阅者的通知。
    for (const handler of [...subscribers]) {
      try {
        handler();
      } catch {
        // 忽略单个订阅者的异常。
      }
    }
  }

  function descriptor(unitId: string): CoordinatorWorkerUnitDescriptor {
    const unit = byUnitId.get(unitId);
    if (!unit) throw new Error(`Coordinator Worker unit 未登记: ${unitId}`);
    return unit;
  }

  function validateIdentity(unit: CoordinatorWorkerUnitDescriptor, identity: OwnerIdentity): void {
    if (!requiresOwner(unit.scopeKind)) {
      if (identity.ownerPublicKeyHex !== undefined || identity.sessionEpoch !== undefined) {
        throw new Error(`非 owner-session Worker unit 不得绑定 owner 身份: ${unit.unitId}`);
      }
      return;
    }
    if (!identity.ownerPublicKeyHex || !identity.sessionEpoch) {
      throw new Error(`owner-session Worker unit 缺少 owner/session 身份: ${unit.unitId}`);
    }
  }

  return {
    activate(unitId, identity = {}) {
      const unit = descriptor(unitId);
      validateIdentity(unit, identity);
      const existing = active.get(unitId);
      if (existing) {
        if (!sameIdentity(existing, identity)) {
          throw new Error(`Coordinator Worker unit 已被其它 owner/session 占用: ${unitId}`);
        }
        return cloneSnapshot(existing);
      }
      const snapshot: CoordinatorWorkerUnitSnapshot = {
        productId: unit.productId,
        unitId: unit.unitId,
        runtime: unit.runtime,
        scopeKind: unit.scopeKind,
        instanceId: identity.instanceId ?? `coordinator-unit:${unitId}:${++nextInstance}`,
        // 单元一被激活就已经进入「不可用」这一档：还没就绪就是不能用。二值化
        // 之后消费者只会看到 ready/failed，未就绪的细节由 `reasons` 承担。
        state: "failed",
        dependsOn: [...unit.dependsOn],
        reasons: [],
        snapshotRevision,
        serviceIds: [...(unit.serviceIds ?? [])],
        taskIds: [...unit.taskIds],
        ...(identity.ownerPublicKeyHex ? { ownerPublicKeyHex: identity.ownerPublicKeyHex } : {}),
        ...(identity.sessionEpoch ? { sessionEpoch: identity.sessionEpoch } : {}),
      };
      active.set(unitId, snapshot);
      touch();
      return cloneSnapshot(snapshot);
    },

    ready(unitId, instanceId) {
      const current = active.get(unitId);
      if (!current || current.instanceId !== instanceId) {
        throw new Error(`Coordinator Worker unit ready 身份已过期: ${unitId}`);
      }
      // `failed` 不是终态：状态二值化之后「已激活但未就绪」与「启动失败」共用
      // 同一档，因此这里必须允许 failed → ready。作废旧启动由 instanceId 身份
      // 负责，不靠状态。
      if (current.state !== "ready" || current.error !== undefined) {
        current.state = "ready";
        current.error = undefined;
        touch();
      }
      return cloneSnapshot(current);
    },

    fail(unitId, instanceId, error) {
      const current = active.get(unitId);
      if (!current || current.instanceId !== instanceId) return undefined;
      const nextError = errorText(error);
      if (current.state !== "failed" || current.error !== nextError) {
        current.state = "failed";
        current.error = nextError;
        touch();
      }
      return cloneSnapshot(current);
    },

    stop(unitId, instanceId) {
      const current = active.get(unitId);
      if (!current) return false;
      if (instanceId !== undefined && current.instanceId !== instanceId) return false;
      active.delete(unitId);
      touch();
      return true;
    },

    get(unitId) {
      const current = active.get(unitId);
      return current ? cloneSnapshot(current) : undefined;
    },

    snapshots() {
      return [...active.values()].map(cloneSnapshot);
    },

    revision() {
      return snapshotRevision;
    },

    onChange(handler) {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },

    reset() {
      if (active.size === 0 && snapshotRevision === 0) return;
      active.clear();
      nextInstance = 0;
      touch();
    },
  };
}
