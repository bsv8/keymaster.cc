// Forum 列表分页状态机。
//
// 需求里对分页的约束是硬的，这里逐条对应到状态上：
//
//   1. 每个列表持有 forum / op / parent / pageGeneration / snapshot / cursor；
//      游标绑定这组坐标，不解析、不修改、不跨父节点复用；
//   2. 取消后结果不可交付：迟到响应必须被丢弃而不是写进当前视图；
//   3. 收到 SNAPSHOT_INVALIDATED 撤销该列表旧请求，重新读取第一页并**替换**
//      旧页集合；用户阅读位置可以保留，但旧游标不得续接到新视图；
//   4. INVALID_CURSOR 报错并清理该游标，不无限重试；
//   5. 连续失效时停止自动循环并提供刷新入口；
//   6. 严格保留服务端顺序，不按本地时间重新排序；
//   7. 确认节点按链位置排序、内存池节点位于其后；内存池顺序不解释为确认先后；
//   8. 末页（next_cursor 为 null）不表示未来不会出现新回复。
//
// pageGeneration 是这套纪律的核心：切父节点、切配置、切 owner 或重新读第一页
// 都会递增它，旧世代的在途响应因此无法交付给新视图。

import type { ForumListOperation, ForumListPage, ForumNodeView } from "@keymaster/contracts";

import { ForumBusinessError } from "./indexClient.js";

export interface ForumListKey {
  readonly configId: string;
  readonly operation: ForumListOperation;
  readonly parentTxid: string;
  readonly forumTxid: string;
}

/** 分页视图；`generation` 变化代表整组页被替换。 */
export interface ForumListView {
  readonly key: ForumListKey;
  readonly generation: number;
  readonly pages: readonly (readonly ForumNodeView[])[];
  readonly snapshotHeight: number | undefined;
  readonly mempoolRevision: number | undefined;
  /** 末页之后没有更多当前视图的内容；不代表未来不会有新回复。 */
  readonly exhausted: boolean;
  /** 尚未开始加载。 */
  readonly status: "idle" | "loading" | "ready" | "failed";
  readonly errorCode?: string;
  /** 需要用户手动刷新：连续视图失效时不再自动循环。 */
  readonly needsManualRefresh: boolean;
  /** 服务端游标的当前值；仅在当前世代内有意义。 */
  readonly cursor: string | undefined;
  /** 缓存标记：来自离线或旧快照，不能作为当前报价与付款的真值。 */
  readonly stale: boolean;
}

const EMPTY_VIEW_BASE = {
  pages: [],
  snapshotHeight: undefined,
  mempoolRevision: undefined,
  exhausted: false,
  cursor: undefined,
  stale: false,
} as const;

export interface ForumListStoreOptions {
  /** 连续 SNAPSHOT_INVALIDATED 达到该次数后停止自动刷新。 */
  readonly invalidationLimit?: number;
  now?(): number;
}

type Listener = () => void;

/**
 * 一个列表 = 一个坐标 + 一组页。
 *
 * 状态机本身不做网络：它接受 `load` 回调（由 index client 提供），只负责世代
 * 纪律、游标绑定与失效处理。这样规则可以被独立测试，不需要伪造传输层。
 */
export class ForumListStore {
  readonly #key: ForumListKey;
  readonly #loadPage: (input: { cursor: string | undefined; snapshotHeight: number | undefined; signal: AbortSignal }) => Promise<ForumListPage>;
  readonly #invalidationLimit: number;
  readonly #listeners = new Set<Listener>();

  #generation = 0;
  #pages: (readonly ForumNodeView[])[] = [];
  #cursor: string | undefined;
  #snapshotHeight: number | undefined;
  #mempoolRevision: number | undefined;
  #exhausted = false;
  #status: ForumListView["status"] = "idle";
  #errorCode: string | undefined;
  #needsManualRefresh = false;
  #invalidations = 0;
  #stale = false;
  #inFlight: AbortController | undefined;

  constructor(
    key: ForumListKey,
    loadPage: (input: { cursor: string | undefined; snapshotHeight: number | undefined; signal: AbortSignal }) => Promise<ForumListPage>,
    options: ForumListStoreOptions = {},
  ) {
    this.#key = key;
    this.#loadPage = loadPage;
    this.#invalidationLimit = options.invalidationLimit ?? 3;
  }

  get key(): ForumListKey {
    return this.#key;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  view(): ForumListView {
    return {
      key: this.#key,
      generation: this.#generation,
      pages: this.#pages,
      snapshotHeight: this.#snapshotHeight,
      mempoolRevision: this.#mempoolRevision,
      exhausted: this.#exhausted,
      status: this.#status,
      needsManualRefresh: this.#needsManualRefresh,
      cursor: this.#cursor,
      stale: this.#stale,
      ...(this.#errorCode === undefined ? {} : { errorCode: this.#errorCode }),
    };
  }

  /** 展开后的条目；顺序严格等于服务端顺序，本地不重排。 */
  items(): readonly ForumNodeView[] {
    return this.#pages.flat();
  }

  /**
   * 读第一页。
   *
   * 无论当前是否有页，都重新读取并**替换**整组页：这是视图失效和父节点切换
   * 之后唯一允许的恢复方式。
   */
  async reload(reason: "initial" | "manual" | "continue" | "parent-change" = "initial"): Promise<void> {
    this.#generation += 1;
    const generation = this.#generation;
    this.#inFlight?.abort();
    this.#inFlight = undefined;
    this.#pages = [];
    this.#cursor = undefined;
    this.#snapshotHeight = undefined;
    this.#mempoolRevision = undefined;
    this.#exhausted = false;
    this.#errorCode = undefined;
    // 只有用户的显式决定才重置失效预算；自动续接的补读不得让计数归零，
    // 否则连续失效永远达不到停止条件。
    if (reason !== "continue") {
      this.#invalidations = 0;
      this.#needsManualRefresh = false;
    }
    // 显式读取不自动续接：视图失效时只记录并让用户决定，避免一次用户动作递归消耗失效预算。
    await this.#run(generation, undefined, undefined, false);
  }

  /** 读下一页。末页返回 false，不发请求。 */
  async loadMore(): Promise<boolean> {
    if (this.#exhausted || this.#needsManualRefresh) return false;
    if (this.#status === "loading") return false;
    if (this.#pages.length === 0) {
      // 还没有任何页可续接：这是自动补读，不是用户的刷新决定。
      await this.reload("continue");
      return this.#pages.length > 0;
    }
    const generation = this.#generation;
    // 游标只在当前世代内有效：它绑定 forum/op/parent/pageGeneration。
    const cursor = this.#cursor;
    await this.#run(generation, cursor, this.#snapshotHeight, true);
    return this.#pages.length > 0;
  }

  /** 视图失效：撤销旧请求、重新读第一页、替换整组页。 */
  async invalidate(): Promise<void> {
    await this.#reloadAndInvalidateOnce();
  }

  /**
   * 记录一次服务端视图失效。
   *
   * 计数与「是否自动重试」是两件事：无论失效是被显式读取还是自动续接观察到，
   * 都要计数，否则连续失效永远达不到停止条件；达到上限就停在这里，不重试。
   */
  #noteInvalidation(): boolean {
    this.#invalidations += 1;
    if (this.#invalidations < this.#invalidationLimit) return true;
    // 连续失效时停止自动循环，并把刷新入口交给用户。
    this.#needsManualRefresh = true;
    this.#status = "failed";
    this.#errorCode = "SNAPSHOT_INVALIDATED";
    this.#generation += 1;
    this.#inFlight?.abort();
    this.#inFlight = undefined;
    this.#emit();
    return false;
  }

  async #reloadAndInvalidateOnce(): Promise<void> {
    this.#generation += 1;
    const generation = this.#generation;
    this.#inFlight?.abort();
    this.#inFlight = undefined;
    this.#pages = [];
    this.#cursor = undefined;
    this.#snapshotHeight = undefined;
    this.#mempoolRevision = undefined;
    this.#exhausted = false;
    this.#errorCode = undefined;
    await this.#run(generation, undefined, undefined, false);
  }

  /** 标记为缓存视图（离线或旧快照），禁止当作当前报价真值。 */
  markStale(stale: boolean): void {
    if (this.#stale === stale) return;
    this.#stale = stale;
    this.#emit();
  }

  dispose(): void {
    this.#inFlight?.abort();
    this.#inFlight = undefined;
    this.#listeners.clear();
  }

  async #run(
    generation: number,
    cursor: string | undefined,
    snapshotHeight: number | undefined,
    autoInvalidate: boolean,
  ): Promise<void> {
    const controller = new AbortController();
    this.#inFlight = controller;
    this.#status = "loading";
    this.#emit();
    try {
      const page = await this.#loadPage({ cursor, snapshotHeight, signal: controller.signal });
      // 世代变了说明父节点、配置或第一页已经换过，这次结果不得交付。
      if (generation !== this.#generation) return;
      // 同一列表不能混拼不同快照。
      if (this.#snapshotHeight !== undefined && page.snapshotHeight !== this.#snapshotHeight && cursor !== undefined) {
        // 服务端在同一游标下换了快照：这组页整体作废，而不是与新视图混拼。
        this.#pages = [];
        this.#cursor = undefined;
        this.#exhausted = false;
        this.#errorCode = "SNAPSHOT_INVALIDATED";
        this.#status = "failed";
        this.#generation += 1;
        this.#emit();
        return;
      }
      // 严格保留服务端顺序：直接追加，不按本地时间或高度重排。
      this.#pages = cursor === undefined ? [page.items] : [...this.#pages, page.items];
      this.#snapshotHeight = page.snapshotHeight;
      this.#mempoolRevision = page.mempoolRevision;
      this.#cursor = page.nextCursor ?? undefined;
      this.#exhausted = page.nextCursor === null;
      this.#status = "ready";
      this.#errorCode = undefined;
      // 成功读到一页就重置失效计数：连续失效的判断只针对连续发生的情况。
      this.#invalidations = 0;
    } catch (error) {
      if (generation !== this.#generation) return;
      if (controller.signal.aborted) return;
      if (error instanceof ForumBusinessError && error.isSnapshotInvalidated) {
        // 无论哪条路径观察到失效都要计数；只有自动续接路径才立刻重试。
        if (this.#noteInvalidation() && autoInvalidate) {
          await this.invalidate();
          return;
        }
        // 未自动重试：这一组页已经不可用，必须离开 loading 状态并带上原因，
        // 否则下一次「加载更多」会被 loading 挡住而永远静默失败。
        if (!this.#needsManualRefresh) {
          this.#status = "failed";
          this.#errorCode = error.code;
        }
        return;
      }
      if (error instanceof ForumBusinessError && error.isCursorInvalid) {
        // 清理该游标，不重试：同一个游标再发一次还是会被拒绝。
        this.#cursor = undefined;
        this.#pages = [];
        this.#errorCode = error.code;
        this.#status = "failed";
        this.#generation += 1;
        this.#emit();
        return;
      }
      this.#errorCode = error instanceof ForumBusinessError ? error.code : classify(error);
      this.#status = "failed";
    } finally {
      if (this.#inFlight === controller) this.#inFlight = undefined;
      if (generation === this.#generation) this.#emit();
    }
  }

  #emit(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // 订阅者异常不影响分页状态。
      }
    }
  }
}

function classify(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "cancelled";
  if (error instanceof Error && error.name === "ForumResultShapeError") return "result-shape";
  if (error instanceof Error && error.name === "ForumTransportError") return "transport";
  if (error instanceof Error && error.name === "ForumIdentityError") return "identity";
  return "transport";
}

/** 供上层检查：本次列表是否已经因为视图失效需要用户介入。 */
export function listNeedsManualRefresh(view: ForumListView): boolean {
  return view.needsManualRefresh;
}
