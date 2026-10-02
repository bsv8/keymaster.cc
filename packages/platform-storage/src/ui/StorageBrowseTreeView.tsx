// 浏览页的左侧文件树。
//
// 树只消费已经折叠好的直接子项（storageBrowseTree.ts），自己不推断任何路径：
// 点展开箭头只展开/收起，点目录名切换当前目录，点文件选中并请求预览。展开按钮
// 与名称按钮是两个独立控件，键盘可以分别命中，焦点状态与选中状态因此可区分。
import { useState } from "react";
import type { BrowseChildNode } from "./storageBrowseTree.js";
import type { BrowseDirectoryState } from "./storageBrowseState.js";
import { abbreviateName } from "./storageBrowseText.js";
import { browseDisplayPage, BROWSE_DISPLAY_PAGE_SIZE } from "./storageBrowseDisplay.js";
import type { BrowseTranslate } from "./StorageBrowsePreviewPane.js";

/** 树事件的公共入参；展开状态与当前目录由页面持有，树保持无状态渲染。 */
export interface StorageBrowseTreeViewProps {
  /** 根目录（逻辑 `/`）的折叠结果。 */
  rootState: BrowseDirectoryState;
  /** 已展开的目录完整路径。 */
  expanded: ReadonlySet<string>;
  /** 当前目录；它的行高亮。 */
  currentDirectory: string;
  /** 当前选中的文件完整路径。 */
  selectedPath: string | undefined;
  /** 取出任意目录的折叠结果；未加载过的目录返回 undefined。 */
  childrenOf: (directory: string) => BrowseDirectoryState | undefined;
  onToggle: (node: BrowseChildNode) => void;
  onSelectDirectory: (directory: string) => void;
  onSelectFile: (node: BrowseChildNode) => void;
  translate: BrowseTranslate;
}

interface TreeRowProps extends StorageBrowseTreeViewProps {
  node: BrowseChildNode;
  depth: number;
}

export function StorageBrowseTreeView(props: StorageBrowseTreeViewProps) {
  const { translate: t } = props;
  if (props.rootState.children.length === 0) {
    return (
      <p className="storage-browse__hint">
        {props.rootState.loading
          ? t("storage.browse.loading", { defaultValue: "Loading…" })
          : props.rootState.error !== undefined
            ? t("storage.browse.loadFailed", { defaultValue: "This directory could not be listed." })
            : t("storage.browse.emptyDirectory", { defaultValue: "This directory is empty." })}
      </p>
    );
  }
  return (
    <ul
      className="storage-browse__tree"
      role="tree"
      aria-label={t("storage.browse.tree.label", { defaultValue: "Storage tree" })}
    >
      <TreeChildList {...props} node={undefined} depth={0} state={props.rootState} nested={false} />
    </ul>
  );
}

function TreeRow(props: TreeRowProps) {
  const { node, depth, translate: t } = props;
  const isExpanded = props.expanded.has(node.path);
  const childState = node.kind === "directory" && isExpanded ? props.childrenOf(node.path) : undefined;
  const className = "storage-browse__tree-row"
    + (props.currentDirectory === node.path ? " is-current" : "")
    + (props.selectedPath === node.path ? " is-selected" : "");
  return (
    <li className="storage-browse__tree-item" role="none">
      <div className={className} style={{ paddingLeft: depth * 14 }}>
        {node.kind === "directory" ? (
          <button
            type="button"
            className="storage-browse__tree-toggle"
            aria-expanded={isExpanded}
            aria-label={isExpanded
              ? t("storage.browse.tree.collapse", { defaultValue: "Collapse {{name}}", name: node.name })
              : t("storage.browse.tree.expand", { defaultValue: "Expand {{name}}", name: node.name })}
            onClick={() => props.onToggle(node)}
          >
            <span aria-hidden="true">{isExpanded ? "▾" : "▸"}</span>
          </button>
        ) : (
          <span className="storage-browse__tree-toggle" aria-hidden="true" />
        )}
        <button
          type="button"
          className="storage-browse__tree-label"
          title={node.path}
          onClick={() => node.kind === "directory"
            ? props.onSelectDirectory(node.path)
            : props.onSelectFile(node)}
        >
          <span className="storage-browse__tree-name">{abbreviateName(node.name)}</span>
        </button>
      </div>
      {node.kind === "directory" && isExpanded ? (
        <TreeChildren {...props} depth={depth + 1} state={childState} />
      ) : null}
    </li>
  );
}

function TreeChildren(props: TreeRowProps & { state: BrowseDirectoryState | undefined }) {
  const { state } = props;
  if (!state) {
    return (
      <p className="storage-browse__hint storage-browse__hint--nested">
        {props.translate("storage.browse.notLoaded", { defaultValue: "Not loaded yet." })}
      </p>
    );
  }
  if (state.children.length === 0) {
    return (
      <p className="storage-browse__hint storage-browse__hint--nested">
        {state.loading
          ? props.translate("storage.browse.loading", { defaultValue: "Loading…" })
          : state.error !== undefined
            ? props.translate("storage.browse.loadFailed", { defaultValue: "This directory could not be listed." })
            : props.translate("storage.browse.emptyDirectory", { defaultValue: "This directory is empty." })}
      </p>
    );
  }
  // 换目录即换一份窗口状态：key 用目录完整路径。子级列表必须自己带 <ul>：
  // 把它塞进父节点的 <li> 之外的位置会得到非法的 ul-in-ul，浏览器会重排节点。
  return <TreeChildList key={props.node.path} {...props} state={state} nested />;
}

/**
 * 一个目录的子项列表，带固定大小的展示分页。
 *
 * 树不能全量渲染已加载节点：一个大目录会把整棵树撑爆。但也不能用「一直放大同一个
 * 切片」的办法换取可达性——那等于把规模上限还给目录本身。因此翻页：任一时刻只渲染
 * 一页，每个已加载子项都能翻到。
 */
type TreeChildListProps = StorageBrowseTreeViewProps & {
  /** 所属节点；根列表没有，因此允许 undefined（也用作换目录时的 key）。 */
  node: BrowseChildNode | undefined;
  depth: number;
  state: BrowseDirectoryState;
  /** true 表示这是某个目录的子级，需要自带 <ul role="group">。 */
  nested: boolean;
};

function TreeChildList(props: TreeChildListProps) {
  const [page, setPage] = useState(0);
  const window = browseDisplayPage(props.state.children, page);
  // 每一行都是自己的节点，父节点只用来在 TreeRow 里回传事件。
  const { node: _owner, nested, ...treeProps } = props;
  const rows = window.visible.map((child) => (
    <TreeRow {...treeProps} key={child.kind + ":" + child.path} node={child} depth={props.depth} />
  ));
  const more = window.pageCount > 1 ? (
    <li className="storage-browse__tree-more" role="none">
      <span className="storage-browse__tree-page">
        {props.translate("storage.browse.renderWindow", {
          defaultValue: "Showing {{first}}–{{last}} of {{total}} loaded items.",
          first: String(window.firstIndex),
          last: String(window.lastIndex),
          total: String(window.total),
        })}
      </span>
      <button
        type="button"
        className="storage-browse__tree-toggle storage-browse__tree-more-button"
        disabled={!window.hasPrevious}
        onClick={() => setPage(window.page - 1)}
      >
        {props.translate("storage.browse.pagePrevious", { defaultValue: "Previous items" })}
      </button>
      <button
        type="button"
        className="storage-browse__tree-toggle storage-browse__tree-more-button"
        disabled={!window.hasNext}
        onClick={() => setPage(window.page + 1)}
      >
        {props.translate("storage.browse.pageNext", { defaultValue: "Next items" })}
      </button>
    </li>
  ) : null;
  // 根列表的外层 <ul role="tree"> 已经存在，行必须直接作为它的 <li> 子节点。
  return nested
    ? <ul className="storage-browse__tree-children" role="group">{rows}{more}</ul>
    : <>{rows}{more}</>;
}
