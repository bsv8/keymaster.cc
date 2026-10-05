// 浏览页的目录折叠：把一页对象元数据折成该目录的直接子项。
//
// 这里只做纯函数，因此「跨页去重」「同名文件与目录并存」「.dir 折叠成目录」
// 这些最容易写错的规则可以被单独验证，不必经过 React 和 Worker。
//
// 两条必须保持的性质：
//   1. 一个逻辑对象只出现一次。底层索引与字节对象不是两份文件，Worker 已经
//      只返回 objects，页面不再做第二次去重。
//   2. 折叠出的目录不代表它已被扫描完成。跨页时同一个子目录会在多页重复出现，
//      所以节点身份是完整路径，合并后仍要靠 nextCursor 判断是否还有后续页。
import type { StorageBrowseEntry } from "../runtime/storageBrowseTypes.js";

/** 目录标记对象的内容类型；只有它才让一个对象成为目录。 */
export const BROWSE_DIRECTORY_CONTENT_TYPE = "application/x-directory";

/** 浏览树中的一个直接子项。 */
export interface BrowseChildNode {
  /** 完整逻辑路径；作为节点身份，长哈希也用它区分。 */
  path: string;
  /** 展示名：路径最后一段。 */
  name: string;
  kind: "directory" | "file";
  /** 文件节点才有：字节数。目录的字节数没有展示意义，因此不聚合。 */
  size?: number;
  /** 文件节点才有：最近修改时间。 */
  lastModified?: string;
  /** 文件节点才有：抽象版本，预览据此作条件读取。 */
  revision?: string;
  /** 文件节点才有：声明的内容类型。 */
  contentType?: string;
}

/** 判断一条元数据是否应按目录处理。 */
export function isDirectoryEntry(entry: StorageBrowseEntry): boolean {
  return entry.contentType === BROWSE_DIRECTORY_CONTENT_TYPE;
}

/** 逻辑根的 RPC 表示；显示时才是 `/`。 */
export const BROWSE_ROOT_DIRECTORY = "";

/** 展示用路径：根显示为 `/`，其余是原路径。 */
export function displayDirectory(directory: string): string {
  return directory === BROWSE_ROOT_DIRECTORY ? "/" : directory;
}

/** 目录前缀补尾斜杠；根返回 undefined，表示全钱包。 */
export function directoryChildPrefix(directory: string): string | undefined {
  return directory === BROWSE_ROOT_DIRECTORY ? undefined : `${directory}/`;
}

/** 直接子目录路径：a → a/b；根下的第一层保持原样。 */
export function joinDirectory(directory: string, name: string): string {
  return directory === BROWSE_ROOT_DIRECTORY ? name : `${directory}/${name}`;
}

/** 取路径最后一段。 */
export function basename(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
}

/** 取父目录；根没有父目录。 */
export function parentDirectory(path: string): string | undefined {
  const index = path.lastIndexOf("/");
  if (index < 0) return undefined;
  return path.slice(0, index);
}

/** 目录自身的标记对象路径，例如 apps/<name>/.dir。 */
export function directoryMarkerPath(directory: string): string {
  return `${directory}/.dir`;
}

/** 一个目录自己的 `.dir` 标记对象。 */
export interface BrowseDirectoryMarker {
  path: string;
  size: number;
  lastModified: string;
  revision: string;
  contentType?: string;
}

export interface BrowseDirectoryChildren {
  /** 直接子项；文件夹在前，各组按名称稳定排序。 */
  children: BrowseChildNode[];
  /** 该目录自己的 .dir 标记；没有标记时省略。 */
  marker?: BrowseDirectoryMarker;
}

/**
 * 把一页对象元数据折成直接子项。
 *
 * - 目录标记 `.dir` 不作为文件出现，而是变成同名目录节点的「存在证据」。
 *   这样 App 空目录能显示，而物理对象统计里仍然算着这个标记。
 * - 同一路径既有文件对象又有子目录时，两项都用完整路径作身份，用 kind 区分，
 *   不会互相覆盖。
 * - 深一层及更深的路径不直接产出节点，只用来确认中间目录存在；它们的内容
 *   要等用户点进去，再单独按前缀加载。
 */
export function foldDirectoryEntries(directory: string, entries: readonly StorageBrowseEntry[]): BrowseDirectoryChildren {
  const prefix = directoryChildPrefix(directory);
  const files = new Map<string, BrowseChildNode>();
  const directories = new Map<string, BrowseChildNode>();
  let marker: BrowseDirectoryMarker | undefined;

  for (const entry of entries) {
    const path = entry.path;
    if (prefix !== undefined && !path.startsWith(prefix)) continue;
    const relative = prefix === undefined ? path : path.slice(prefix.length);
    if (relative.length === 0) continue;
    const slash = relative.indexOf("/");

    if (slash < 0) {
      // 直接子项。目录标记在这一层折叠成目录，而不是作为文件展示。
      if (isDirectoryEntry(entry) && relative === ".dir") {
        marker = {
          path: entry.path,
          size: entry.size,
          lastModified: entry.lastModified,
          revision: entry.revision,
          ...(entry.contentType === undefined ? {} : { contentType: entry.contentType }),
        };
        continue;
      }
      if (isDirectoryEntry(entry)) {
        directories.set(relative, { path, name: relative, kind: "directory" });
        continue;
      }
      files.set(relative, {
        path,
        name: relative,
        kind: "file",
        size: entry.size,
        lastModified: entry.lastModified,
        revision: entry.revision,
        ...(entry.contentType === undefined ? {} : { contentType: entry.contentType }),
      });
      continue;
    }

    // 更深一层：只登记中间目录存在，不递归展开。
    const name = relative.slice(0, slash);
    directories.set(name, {
      path: joinDirectory(directory, name),
      name,
      kind: "directory",
    });
  }

  const children = [
    ...[...directories.values()].sort(compareBrowseNodes),
    ...[...files.values()].sort(compareBrowseNodes),
  ];
  return { children, ...(marker === undefined ? {} : { marker }) };
}

/** 排序：目录先于文件，同类按名称稳定排序。 */
function compareBrowseNodes(left: BrowseChildNode, right: BrowseChildNode): number {
  if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

/**
 * 把新一页合并进已有子项集合。
 *
 * 去重按「种类 + 完整路径」而不是展示名：同名文件与同名目录都要留下。返回的新
 * 节点数让页面能区分「这一页折叠后没有新增子项」和「目录已经扫完」——前者
 * 仍然可以继续加载。
 */
export function mergeDirectoryChildren(
  existing: readonly BrowseChildNode[],
  incoming: readonly BrowseChildNode[],
): { children: BrowseChildNode[]; addedCount: number } {
  const byKey = new Map<string, BrowseChildNode>();
  for (const node of existing) byKey.set(`${node.kind}:${node.path}`, node);
  let addedCount = 0;
  for (const node of incoming) {
    const key = `${node.kind}:${node.path}`;
    if (byKey.has(key)) continue;
    byKey.set(key, node);
    addedCount += 1;
  }
  const children = [...byKey.values()].sort(compareBrowseNodes);
  return { children, addedCount };
}
