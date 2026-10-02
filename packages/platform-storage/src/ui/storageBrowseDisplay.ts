// 目录子项的展示分页（纯逻辑）。
//
// 浏览页面对「同时渲染多少行」和「一共能看到多少项」必须同时成立：DOM 规模要有界，
// 钱包里的每一个已加载子项又要都能被看到。
//
// 两种常见做法只能满足一半：
//   - 固定 `slice(0, N)`：第 N+1 项之后没有任何入口，剩余文件只能去别处找。
//   - 「显示更多」不断放大同一个从零开始的切片：可达性有了，但连续点到底之后会
//     一次性把全部行交给渲染，DOM 规模又退回与目录规模成正比。
//
// 因此这里用固定大小的展示分页：任一时刻只渲染一页，翻页只是换一个下标窗口，行数
// 恒定，加载多少就能翻多少。
//
// 页长与 Worker 的元数据页大小同量级（200）：这既是一次分页能带来的量，也是一屏
// 值得渲染的量。展示分页与存储分页互相独立——存储分页决定「哪些对象已被发现」，
// 展示分页只决定「已发现的里面当前显示哪一页」。

/** 展示分页的页长；与存储分页页大小同量级，但两者互不依赖。 */
export const BROWSE_DISPLAY_PAGE_SIZE = 200;

export interface BrowseDisplayPage<T> {
  /** 当前页的子项；保持既有顺序。 */
  visible: T[];
  /** 已加载的子项总数。 */
  total: number;
  /** 从 0 开始的当前页下标。 */
  page: number;
  /** 总页数；`total` 为 0 时是 1（空目录也有一页，只是空的）。 */
  pageCount: number;
  /** 是否存在下一页。 */
  hasNext: boolean;
  /** 是否存在上一页。 */
  hasPrevious: boolean;
  /** 当前页第一项在整体中的序号（1 起）；空页为 0。 */
  firstIndex: number;
  /** 当前页最后一项在整体中的序号（1 起）；空页为 0。 */
  lastIndex: number;
}

/** 合法页长：非正数、非整数一律退回默认页长，避免调用方算错就渲染出 0 行。 */
function resolvePageSize(pageSize: number): number {
  return Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : BROWSE_DISPLAY_PAGE_SIZE;
}

/**
 * 计算展示分页。
 *
 * @param items 已加载的子项（目录优先、名称稳定排序）。
 * @param page 从 0 开始的页下标；越界或非法时夹到最后一页。
 * @param pageSize 页长。
 */
export function browseDisplayPage<T>(
  items: readonly T[],
  page: number,
  pageSize: number = BROWSE_DISPLAY_PAGE_SIZE,
): BrowseDisplayPage<T> {
  const size = resolvePageSize(pageSize);
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const current = Number.isSafeInteger(page) && page > 0
    ? Math.min(page, pageCount - 1)
    : Number.isSafeInteger(page) && page < 0
      ? 0
      : 0;
  const start = current * size;
  const visible = items.slice(start, start + size);
  return {
    visible,
    total,
    page: current,
    pageCount,
    hasNext: current < pageCount - 1,
    hasPrevious: current > 0,
    firstIndex: visible.length === 0 ? 0 : start + 1,
    lastIndex: start + visible.length,
  };
}
