// 浏览页的目录状态机（纯逻辑）。
//
// 页面组件里最容易写错的是「一页折叠后没有新增子项，但仍然有游标」这种状态：
// 只要把「本页新增数」当成「是否还有后续」，深目录就会在还剩文件时被判定为
// 扫完。完成与否只看游标，新增数只用来告诉用户这一页带来了什么。
import type { StorageBrowseEntry } from "../runtime/storageBrowseTypes.js";
import {
  foldDirectoryEntries,
  mergeDirectoryChildren,
  type BrowseChildNode,
  type BrowseDirectoryMarker,
} from "./storageBrowseTree.js";

/** 一个目录的加载状态。 */
export interface BrowseDirectoryState {
  /** 已加载的直接子项；跨页去重后按目录优先、名称排序。 */
  children: BrowseChildNode[];
  /** 该目录自己的 .dir 标记对象。 */
  marker?: BrowseDirectoryMarker;
  /** 下一页游标；undefined 表示这个前缀已经列举完毕。 */
  cursor?: string;
  /** 是否仍在加载。 */
  loading: boolean;
  /** 加载失败原因；与「空目录」严格区分。 */
  error?: string;
}

/** 尚未加载过的目录。 */
export function emptyDirectoryState(): BrowseDirectoryState {
  return { children: [], loading: false };
}

/**
 * 目录是否已经列举完毕。
 *
 * 只有「没有下一页游标」才算完。页数、字节数、对象数都不能替代它：一页 200 条
 * 里可能全是同一个深目录的重复前缀折叠结果。
 */
export function isDirectoryComplete(state: BrowseDirectoryState): boolean {
  return state.cursor === undefined;
}

/**
 * 两个节点是否指向同一个存储对象。
 *
 * 身份就是「种类 + 完整路径」，与大小、修改时间、版本无关。刷新后同一个路径被写过
 * 时版本会变，但文件仍是同一个：把版本也纳入身份会让每次更新都被误判成「文件已被
 * 删除」，用户看到的是内容还在、页面却说它没了。
 *
 * 返回 true 时调用方必须用**新的那条元数据**替换旧节点：版本变了，条件读取要跟着
 * 变，否则预览会一直撞版本冲突。
 */
export function isSameNodeIdentity(
  entry: BrowseChildNode,
  node: BrowseChildNode,
): boolean {
  return node.kind === "file"
    && entry.kind === "file"
    && entry.path === node.path;
}

export interface BrowsePageResult {
  entries: readonly StorageBrowseEntry[];
  nextCursor?: string;
}

/**
 * 把一页结果合并进目录状态。
 *
 * @param state 现有状态。
 * @param directory 当前目录的 RPC 前缀（根为空串）。
 * @param page 新的一页元数据。
 * @param append true 表示后续页，按已有子项合并；false 表示重新列举。
 */
export function applyBrowsePage(
  state: BrowseDirectoryState,
  directory: string,
  page: BrowsePageResult,
  append: boolean,
): BrowseDirectoryState {
  const folded = foldDirectoryEntries(directory, page.entries);
  const merged = append
    ? mergeDirectoryChildren(state.children, folded.children)
    : { children: folded.children, addedCount: folded.children.length };
  return {
    children: merged.children,
    // 标记可能只在第一页出现，因此已有的不会被新一页的缺失清掉。
    ...(state.marker === undefined && folded.marker === undefined ? {} : { marker: folded.marker ?? state.marker }),
    // 重新列举（append=false）时清掉旧游标：继续加载必须用新会话发出的游标。
    ...(page.nextCursor === undefined ? {} : { cursor: page.nextCursor }),
    loading: false,
  };
}
