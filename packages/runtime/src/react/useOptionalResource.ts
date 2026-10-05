// packages/runtime/src/react/useOptionalResource.ts
// owner 会话回收期间仍可安全读取资源的选择器。
//
// 设计缘由：
//   - owner-scoped 插件的资源定义会随锁定/换 Key 被注销，而挂载中的组件可能
//     还要完成一次渲染；webloom 的 `store.ensure` 在定义缺失时直接抛错，
//     会把锁定变成页面崩溃。
//   - 这里把"定义缺失"降级为 null/fallback，让组件渲染失活占位；定义恢复
//     （解锁后重新注册）时由上层身份变化触发重挂载即可。

import { useCallback, useRef, useSyncExternalStore } from "react";
import type { ResourceSnapshot } from "webloom-framework";

/** `useOptionalResource` 需要的最小资源存储面。 */
export interface OptionalResourceStore {
  isActive?(): boolean;
  ensure<T = unknown>(definitionId: string, args: readonly string[]): ResourceSnapshot<T>;
  subscribe(definitionId: string, args: readonly string[], callback: () => void): () => void;
}

/** 与 webloom `useResource` 等价，但资源定义缺失时返回 null 而不是抛错。 */
export function useOptionalResource<T>(
  store: OptionalResourceStore,
  definitionId: string,
  args: readonly string[]
): ResourceSnapshot<T> | null {
  const getSnapshot = useCallback((): ResourceSnapshot<T> | null => {
    try {
      return store.ensure<T>(definitionId, args);
    } catch {
      return null;
    }
  }, [store, definitionId, ...args]);
  const subscribe = useCallback((callback: () => void) => {
    try {
      return store.subscribe(definitionId, args, callback);
    } catch {
      return () => undefined;
    }
  }, [store, definitionId, ...args]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * 与 webloom `useResourceSelector` 等价，但资源定义缺失时返回 fallback。
 *
 * 不缓存选择结果：这里读取的资源本来就是低频状态，避免复制框架内部
 * 的相等性缓存逻辑。
 */
export function useOptionalResourceSelector<T, S>(
  store: OptionalResourceStore,
  definitionId: string,
  args: readonly string[],
  selector: (snapshot: ResourceSnapshot<T>) => S,
  fallback: S
): S {
  const snapshot = useOptionalResource<T>(store, definitionId, args);
  return snapshot === null ? fallback : selector(snapshot);
}

/** 对受限资源视图使用严格读取；保留框架快照和订阅，不授予 Store 管理方法。 */
export function useResourceView<T>(store: OptionalResourceStore, definitionId: string, args: readonly string[]): ResourceSnapshot<T> {
  const inactive = useRef<ResourceSnapshot<T>>({ key: [definitionId, ...args], status: "blocked", revision: 0, data: undefined });
  const getSnapshot = useCallback(() => store.isActive?.() === false ? inactive.current : store.ensure<T>(definitionId, args), [store, definitionId, ...args]);
  const subscribe = useCallback((callback: () => void) => store.isActive?.() === false ? () => undefined : store.subscribe(definitionId, args, callback), [store, definitionId, ...args]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** 受限视图的选择器只需要快照/订阅，不要求取得 Store 管理面。 */
export function useResourceViewSelector<T, S>(store: OptionalResourceStore, definitionId: string, args: readonly string[], selector: (snapshot: ResourceSnapshot<T>) => S, equality: (left: S, right: S) => boolean = Object.is): S {
  const snapshot = useResourceView<T>(store, definitionId, args);
  const previous = useRef<{ value: S }>();
  const value = selector(snapshot);
  previous.current = { value: previous.current && equality(previous.current.value, value) ? previous.current.value : value };
  return previous.current.value;
}
