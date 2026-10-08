// 论坛列表的 React 绑定。
//
// 分页状态机（世代、游标、在途取消）属于领域状态而不是组件状态：它必须在页面
// 卸载、父节点切换与身份失效时继续被正确管理。把订阅放在这里而不是组件内部，
// 也让页面只做「读快照」，不再自己管理 store 的生命周期。
//
// `getSnapshot` 必须返回缓存引用：useSyncExternalStore 会在每次渲染比较，
// 每次都新建对象会造成无限重渲染。

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import type { ForumListOperation, ForumListPage, ForumNodeView, ForumService } from "@keymaster/contracts";

import { ForumListStore, type ForumListKey, type ForumListView } from "./domain/listStore.js";

export interface ForumListBinding {
  /** 当前视图快照；引用在状态不变时保持稳定。 */
  readonly snapshot: ForumListBindingSnapshot;
  subscribe(listener: () => void): () => void;
  reload(reason: "initial" | "manual" | "parent-change"): Promise<void>;
  loadMore(): Promise<boolean>;
  markStale(stale: boolean): void;
  dispose(): void;
}

export interface ForumListBindingSnapshot {
  readonly view: ForumListView;
  readonly items: readonly ForumNodeView[];
}

export interface ForumListLoaderInput {
  readonly cursor: string | undefined;
  readonly snapshotHeight: number | undefined;
  readonly signal: AbortSignal;
}

/**
 * 把一个分页坐标绑到一个 store 上。
 *
 * `loader` 由调用方提供，因此这个绑定不关心是 boards/posts/replies：父字段名
 * 与操作名的映射仍然只有 `buildListArgs` 一处。
 */
export function createForumListBinding(input: {
  key: ForumListKey;
  loader: (input: ForumListLoaderInput) => Promise<ForumListPage>;
}): ForumListBinding {
  const store = new ForumListStore(input.key, input.loader);
  const listeners = new Set<() => void>();
  let snapshot: ForumListBindingSnapshot = snapshotOf(store);
  const off = store.subscribe(() => {
    snapshot = snapshotOf(store);
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // 订阅者异常不影响分页状态。
      }
    }
  });
  return {
    get snapshot(): ForumListBindingSnapshot {
      return snapshot;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reload: (reason) => store.reload(reason),
    loadMore: () => store.loadMore(),
    markStale: (stale) => store.markStale(stale),
    dispose() {
      off();
      listeners.clear();
      store.dispose();
    },
  };
}

function snapshotOf(store: ForumListStore): ForumListBindingSnapshot {
  const view = store.view();
  return { view, items: store.items() };
}

/** 组件侧只读订阅；store 的创建、切换与释放都在 binding 里。 */
export function useForumListBinding(create: () => ForumListBinding): ForumListBinding {
  const ref = useRef<ForumListBinding | undefined>(undefined);
  const factory = useCallback(create, [create]);
  const binding = useMemo(() => {
    ref.current?.dispose();
    const created = factory();
    ref.current = created;
    return created;
  }, [factory]);
  useEffect(() => {
    void binding.reload("initial");
    return () => {
      binding.dispose();
      if (ref.current === binding) ref.current = undefined;
    };
  }, [binding]);
  return binding;
}

/** 订阅 binding 的快照。 */
export function useForumListSnapshot(binding: ForumListBinding): ForumListBindingSnapshot {
  const subscribe = useCallback((listener: () => void) => binding.subscribe(listener), [binding]);
  const getSnapshot = useCallback(() => binding.snapshot, [binding]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** 组装一个读取 Forum 列表的 binding 工厂。 */
export function forumListLoader(
  forum: ForumService,
  configId: string,
  operation: ForumListOperation,
  forumTxid: string,
  parentTxid: string,
  limit: number,
): (input: ForumListLoaderInput) => Promise<ForumListPage> {
  return async ({ cursor, snapshotHeight, signal }) => {
    const request = {
      configId,
      operation,
      forumTxid,
      parentTxid,
      limit,
      // 有游标时不再传 snapshot_height。
      ...(cursor === undefined ? {} : { cursor }),
      ...(cursor === undefined && snapshotHeight === undefined ? {} : { snapshotHeight }),
      signal,
    };
    if (operation === "list_boards") return forum.listBoards(request);
    if (operation === "list_posts") return forum.listPosts(request);
    return forum.listReplies(request);
  };
}