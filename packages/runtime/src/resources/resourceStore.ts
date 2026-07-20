/**
 * Runtime Resource Store 实现
 *
 * 设计缘由：Resource Store 是 React 读业务数据、订阅业务数据变更的唯一框架入口。
 * 实现 in-flight 去重、abort、revision、snapshot、selector subscription、
 * 相等判断、失效批处理、owner dispose。
 */

import type {
  ResourceContext,
  ResourceDefinition,
  ResourceKey,
  ResourceRegistry,
  ResourceSnapshot,
  ResourceStatus,
} from "@keymaster/contracts";
import { RESOURCE_OWNER } from "@keymaster/contracts";

/** 资源记录：包含快照、in-flight promise、AbortController 等 */
interface ResourceRecord<T = unknown> {
  snapshot: ResourceSnapshot<T>;
  inFlight: Promise<T> | null;
  abortController: AbortController | null;
  subscribers: Set<() => void>;
  invalidationScheduled: boolean;
  loadRevision: number;
  owner: string;
  providerUnsubscribe: (() => void) | null;
}

/** Resource Store 公共 API（供 React hooks 使用） */
export interface ResourceStoreApi {
  /** 确保资源已加载（或正在加载）并返回快照 */
  ensure<T>(definitionId: string, args: readonly string[]): ResourceSnapshot<T>;
  /** 订阅资源变更 */
  subscribe(
    definitionId: string,
    args: readonly string[],
    callback: () => void
  ): () => void;
  /** 读取资源快照（不触发加载） */
  read<T>(
    definitionId: string,
    args: readonly string[]
  ): ResourceSnapshot<T> | undefined;
  /** 使资源失效 */
  invalidate(definitionId: string, args: readonly string[]): void;
  /** 按 owner 处置所有资源记录 */
  disposeOwner(ownerId: string): void;
  /** capability 注入或撤销后刷新 runtime 绑定。 */
  refreshRuntimeBindings(): void;
}

/** 创建资源上下文 */
function createContext(
  ownerId: string,
  getCapability: <T>(id: string) => T | undefined,
  activePublicKeyHex: string | undefined
): ResourceContext {
  return {
    getCapability,
    activePublicKeyHex,
    ownerId,
  };
}

/** 生成记录键 */
function recordKey(definitionId: string, key: ResourceKey): string {
  return `${definitionId}::${key.join("::")}`;
}

/** 默认相等判断：Object.is */
function defaultEquals(a: unknown, b: unknown): boolean {
  return Object.is(a, b);
}

/** 创建 Resource Store */
export function createResourceStore(
  registry: ResourceRegistry,
  getCapability: <T>(id: string) => T | undefined,
  getActivePublicKeyHex: () => string | undefined,
): ResourceStoreApi {
  const records = new Map<string, ResourceRecord>();
  const microtaskQueue = new Map<string, { definitionId: string; args: readonly string[] }>();
  let microtaskScheduled = false;

  // 全局订阅者：当任何 record 变化时通知。
  // 设计缘由：active key 切换时新 record 尚无直接订阅者，
  // 但 useResourceSelector 需要知道新数据已加载完成。
  const globalSubscribers = new Set<() => void>();
  const activeContextSubscribers = new Set<() => void>();
  let activeKeyUnsubscribe: (() => void) | null = null;
  let boundKeyspace: any = null;
  let bindingReconcilePending = false;
  const activeRecords = new Set<ResourceRecord>();

  function handleActiveKeyChange(): void {
    const oldRecords = Array.from(activeRecords);
    activeRecords.clear();
    for (const record of oldRecords) {
      cleanupRecord(record);
      record.loadRevision++;
      record.inFlight = null;
      record.abortController = null;
      for (const [rk, current] of records) {
        if (current === record) records.delete(rk);
      }
    }
    notifyGlobalSubscribers();
    for (const sub of activeContextSubscribers) {
      try { sub(); } catch {}
    }
  }

  function bindKeyspace(): void {
    let keyspace: any;
    try {
      keyspace = getCapability<any>("keyspace.service");
    } catch {
      keyspace = undefined;
    }
    if (keyspace === boundKeyspace && activeKeyUnsubscribe) return;
    if (activeKeyUnsubscribe) activeKeyUnsubscribe();
    activeKeyUnsubscribe = null;
    boundKeyspace = keyspace ?? null;
    if (!keyspace?.onActiveChange) return;
    bindingReconcilePending = true;
    activeKeyUnsubscribe = keyspace.onActiveChange(() => {
      bindingReconcilePending = false;
      handleActiveKeyChange();
    });
    // Some keyspace implementations invoke the handler eagerly. Defer the
    // rebind so registration cannot delete the record currently being built.
    queueMicrotask(() => {
      if (bindingReconcilePending) {
        bindingReconcilePending = false;
        handleActiveKeyChange();
      }
    });
  }

  function ensureActiveKeySubscription(): void {
    if (!activeKeyUnsubscribe) bindKeyspace();
  }

  function refreshRuntimeBindings(): void { bindKeyspace(); }

  function notifyGlobalSubscribers(): void {
    for (const sub of globalSubscribers) {
      try { sub(); } catch {}
    }
  }

  /** 获取或创建资源记录 */
  function getOrCreateRecord<T>(
    definition: ResourceDefinition<T, any>,
    args: readonly string[]
  ): ResourceRecord<T> {
    const context = createContext(
      (definition as any)[RESOURCE_OWNER] || "__unowned__",
      getCapability,
      getActivePublicKeyHex()
    );
    const key = definition.key(args, context);
    const rk = recordKey(definition.id, key);

    let record = records.get(rk) as ResourceRecord<T> | undefined;
    if (!record) {
      record = {
        snapshot: {
          key,
          status: "pending",
          data: undefined,
          revision: 0,
        },
        inFlight: null,
        abortController: null,
        subscribers: new Set(),
        invalidationScheduled: false,
        loadRevision: 0,
        owner: context.ownerId,
        providerUnsubscribe: null,
      };
      records.set(rk, record);
      if (definition.scope === "active-key") {
        activeRecords.add(record);
        ensureActiveKeySubscription();
      }

      // 注册订阅
      if (definition.subscribe) {
        const unsubscribe = definition.subscribe(args, context, () => {
          scheduleInvalidation(definition.id, args);
        });
        record.providerUnsubscribe = unsubscribe;
      }
    }

    return record;
  }

  /** 加载资源 */
  function loadResource<T>(
    definition: ResourceDefinition<T, any>,
    args: readonly string[],
    record: ResourceRecord<T>
  ): void {
    // 取消旧的加载
    if (record.abortController) {
      record.abortController.abort();
    }

    const context = createContext(
      record.owner,
      getCapability,
      getActivePublicKeyHex()
    );
    const key = definition.key(args, context);
    const rk = recordKey(definition.id, key);

    // 检查 key 是否匹配（active key 切换）
    if (record.snapshot.key.join("::") !== key.join("::")) {
      // key 不匹配，清除旧记录
      cleanupRecord(record);
      records.delete(rk);
      return;
    }

    const abortController = new AbortController();
    const loadRevision = ++record.loadRevision;

    record.abortController = abortController;
    record.inFlight = definition.load(args, context, abortController.signal);

    // 更新状态为 pending（保留旧数据）
    if (record.snapshot.status !== "blocked") {
      record.snapshot = {
        ...record.snapshot,
        status: "pending",
        revision: record.snapshot.revision + 1,
      };
      notifySubscribers(record);
    }

    record.inFlight
      .then((data) => {
        // 检查是否已被取消或过期
        if (
          abortController.signal.aborted ||
          record.loadRevision !== loadRevision
        ) {
          return;
        }

        // 检查 key 是否仍然匹配
        if (record.snapshot.key.join("::") !== key.join("::")) {
          return;
        }

        // 检查 owner 是否仍然匹配
        if (record.owner !== context.ownerId) {
          return;
        }

        // 使用 equals 判断是否需要更新
        const equals = definition.equals || defaultEquals;
        const dataChanged = !equals(record.snapshot.data, data);

        if (dataChanged) {
          // 数据不同，发布新 snapshot
          record.snapshot = {
            key,
            status: "ready",
            data,
            revision: record.snapshot.revision + 1,
          };
          record.inFlight = null;
          record.abortController = null;
          notifySubscribers(record);
        } else {
          // 数据相同，只更新内部状态，不发布新 snapshot
          // 设计缘由：equals 判定数据语义未变时，订阅者已有正确数据，
          // 不应触发不必要的重渲染。revision 不变表示快照未变。
          record.snapshot = {
            ...record.snapshot,
            status: "ready",
          };
          record.inFlight = null;
          record.abortController = null;
          // 不通知订阅者：数据未变，状态从 pending 恢复到 ready
          // 对订阅者无感知差异
        }
      })
      .catch((error) => {
        // 检查是否已被取消或过期
        if (
          abortController.signal.aborted ||
          record.loadRevision !== loadRevision
        ) {
          return;
        }

        // blocked 状态不视为错误
        if (error instanceof Error && error.message === "blocked") {
          record.snapshot = {
            ...record.snapshot,
            status: "blocked",
            revision: record.snapshot.revision + 1,
          };
        } else {
          // 失败保留最后一个 data，状态为 stale 或 error
          const errorCode =
            error instanceof Error && "code" in error
              ? String((error as any).code)
              : "UNKNOWN";
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error";

          record.snapshot = {
            ...record.snapshot,
            status: record.snapshot.data ? "stale" : "error",
            error: { code: errorCode, message: errorMessage },
            revision: record.snapshot.revision + 1,
          };
        }

        record.inFlight = null;
        record.abortController = null;
        notifySubscribers(record);
      });
  }

  /** 清理资源记录 */
  function cleanupRecord(record: ResourceRecord): void {
    if (record.abortController) {
      record.abortController.abort();
    }
    if (record.providerUnsubscribe) {
      record.providerUnsubscribe();
    }
  }

  /** 通知订阅者 */
  function notifySubscribers(record: ResourceRecord): void {
    for (const subscriber of record.subscribers) {
      try {
        subscriber();
      } catch {
        // 忽略订阅者错误
      }
    }
  }

  /** 调度失效（microtask 合并） */
  function scheduleInvalidation(
    definitionId: string,
    args: readonly string[]
  ): void {
    const definition = registry.get(definitionId);
    if (!definition) return;

    if (definition.invalidation === "immediate") {
      // 立即失效
      invalidateNow(definitionId, args);
    } else {
      // microtask 合并
      const context = createContext(
        (definition as any)[RESOURCE_OWNER] ?? "__unowned__",
        getCapability,
        getActivePublicKeyHex()
      );
      const key = definition.key(args, context);
      const rk = recordKey(definitionId, key);

      if (!microtaskQueue.has(rk)) {
        microtaskQueue.set(rk, { definitionId, args });

        if (!microtaskScheduled) {
          microtaskScheduled = true;
          queueMicrotask(flushMicrotaskQueue);
        }
      }
    }
  }

  /** 刷新微任务队列 */
  function flushMicrotaskQueue(): void {
    const queue = Array.from(microtaskQueue.values());
    microtaskQueue.clear();
    microtaskScheduled = false;

    for (const { definitionId, args } of queue) {
      invalidateNow(definitionId, args);
    }
  }

  /** 立即失效 */
  function invalidateNow(definitionId: string, args: readonly string[]): void {
    const definition = registry.get(definitionId);
    if (!definition) return;

    const context = createContext(
      (definition as any)[RESOURCE_OWNER] ?? "__unowned__",
      getCapability,
      getActivePublicKeyHex()
    );
    const key = definition.key(args, context);
    const rk = recordKey(definitionId, key);
    const record = records.get(rk) as ResourceRecord | undefined;

    if (!record) return;

    // 标记失效并重新加载
    record.snapshot = {
      ...record.snapshot,
      status: "stale",
      revision: record.snapshot.revision + 1,
    };
    notifySubscribers(record);

    loadResource(definition, args, record);
  }

  return {
    ensure<T>(
      definitionId: string,
      args: readonly string[]
    ): ResourceSnapshot<T> {
      const definition = registry.get<T, readonly string[]>(definitionId);
      if (!definition) {
        throw new Error(`Resource definition "${definitionId}" not found`);
      }

      const record = getOrCreateRecord<T>(definition, args);

      // 如果没有 in-flight 且状态为 pending，开始加载
      if (!record.inFlight && record.snapshot.status === "pending") {
        loadResource(definition, args, record);
      }

      return record.snapshot;
    },

    subscribe(
      definitionId: string,
      args: readonly string[],
      callback: () => void
    ): () => void {
      const definition = registry.get(definitionId);
      if (!definition) {
        return () => {};
      }

      let record = getOrCreateRecord(definition as ResourceDefinition<any, any>, args);
      record.subscribers.add(callback);

      // Keep a hook subscribed to the record for the current active key. The
      // active context event rebinds it before React reads its new snapshot.
      let activeContextSubscription: (() => void) | null = null;
      if (definition.scope === "active-key") {
        activeContextSubscription = () => {
          record.subscribers.delete(callback);
          record = getOrCreateRecord(definition as ResourceDefinition<any, any>, args);
          record.subscribers.add(callback);
          callback();
        };
        activeContextSubscribers.add(activeContextSubscription);
      }

      return () => {
        if (activeContextSubscription) {
          activeContextSubscribers.delete(activeContextSubscription);
        }
        record.subscribers.delete(callback);

        // 最后一个订阅者取消时允许延迟 abort
        if (record.subscribers.size === 0 && record.abortController) {
          // 延迟 abort，给 StrictMode 双挂载一个机会
          setTimeout(() => {
            if (record.subscribers.size === 0 && record.abortController) {
              record.abortController.abort();
              record.abortController = null;
              record.inFlight = null;
            }
          }, 100);
        }
      };
    },

    read<T>(
      definitionId: string,
      args: readonly string[]
    ): ResourceSnapshot<T> | undefined {
      const definition = registry.get<T, readonly string[]>(definitionId);
      if (!definition) return undefined;

      const context = createContext(
        (definition as any)[RESOURCE_OWNER] ?? "__unowned__",
        getCapability,
        getActivePublicKeyHex()
      );
      const key = definition.key(args, context);
      const rk = recordKey(definitionId, key);
      const record = records.get(rk) as ResourceRecord<T> | undefined;

      return record?.snapshot;
    },

    invalidate(definitionId: string, args: readonly string[]): void {
      scheduleInvalidation(definitionId, args);
    },

    disposeOwner(ownerId: string): void {
      const toDelete: string[] = [];

      for (const [rk, record] of records) {
        if (record.owner === ownerId) {
          cleanupRecord(record);
          activeRecords.delete(record);
          toDelete.push(rk);
        }
      }
      if (activeRecords.size === 0 && activeContextSubscribers.size === 0 && activeKeyUnsubscribe) {
        activeKeyUnsubscribe();
        activeKeyUnsubscribe = null;
        boundKeyspace = null;
      }

      for (const rk of toDelete) {
        records.delete(rk);
      }
    },

    refreshRuntimeBindings,
  };
}
