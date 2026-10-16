// 浏览页的文件树。
//
// 树是页面上唯一的目录导航：只消费已经折叠好的直接子项（storageBrowseTree.ts），
// 自己不推断任何路径。点展开箭头只展开/收起，点目录名进入目录（在页面侧选中它并
// 把整条链展开），点文件选中并请求预览。展开按钮与名称按钮是两个独立控件，键盘
// 可以分别命中，焦点状态与选中状态因此可区分。
//
// 目录列表移除后，树同时承担两类分页入口：每个目录仍有固定大小的展示分页（翻页
// 只换下标窗口），未扫完目录还有「继续加载」按钮，失败目录有「重试」。没有这两个
// 入口，深目录里未加载的对象就不可达了。
import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { BrowseChildNode } from "./storageBrowseTree.js";
import { BROWSE_ROOT_DIRECTORY } from "./storageBrowseTree.js";
import { isDirectoryComplete, type BrowseDirectoryState } from "./storageBrowseState.js";
import { abbreviateName } from "./storageBrowseText.js";
import { browseDisplayPage } from "./storageBrowseDisplay.js";
import type { BrowseTranslate } from "./StorageBrowsePreviewPane.js";

/** 树事件的公共入参；展开状态与选中项由页面持有，树保持无状态渲染。 */
export interface StorageBrowseTreeViewProps {
  /** 根目录（逻辑 `/`）的折叠结果。 */
  rootState: BrowseDirectoryState;
  /** 已展开的目录完整路径。 */
  expanded: ReadonlySet<string>;
  /** 当前选中的文件或目录完整路径。 */
  selectedPath: string | undefined;
  /** 取出任意目录的折叠结果；未加载过的目录返回 undefined。 */
  childrenOf: (directory: string) => BrowseDirectoryState | undefined;
  onToggle: (node: BrowseChildNode) => void;
  onSelectDirectory: (directory: string) => void;
  onSelectFile: (node: BrowseChildNode) => void;
  /** 已加载目录的存储分页入口：append=false 表示失败后重新列举。 */
  onLoadMore: (directory: string, append: boolean) => void;
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
      <DirectoryStatus
        className="storage-browse__tree-status"
        state={props.rootState}
        directory={BROWSE_ROOT_DIRECTORY}
        onLoadMore={props.onLoadMore}
        translate={t}
      />
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
            {/* 展开态只旋转同一枚 chevron：▸/▾ 两个字形的宽度与粗细由系统字体决定，
                放大后会随展开切换让行首左右跳动；SVG 盒尺寸固定，旋转不改变布局。 */}
            <ChevronRight className={`storage-browse__tree-caret${isExpanded ? " is-expanded" : ""}`}
              size={14} strokeWidth={2.5} aria-hidden="true" />
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
      <DirectoryStatus
        className="storage-browse__hint--nested"
        state={state}
        directory={props.node.path}
        onLoadMore={props.onLoadMore}
        translate={props.translate}
      />
    );
  }
  // 换目录即换一份窗口状态：key 用目录完整路径。子级列表必须自己带 <ul>：
  // 把它塞进父节点的 <li> 之外的位置会得到非法的 ul-in-ul，浏览器会重排节点。
  return <TreeChildList key={props.node.path} {...props} state={state} nested />;
}

/**
 * 空目录、加载中与加载失败的统一状态行。
 *
 * 目录列表移除后，失败重试必须留在树里：否则「暂时列不出来」只能靠刷新整页。
 */
function DirectoryStatus(props: {
  className: string;
  state: BrowseDirectoryState;
  directory: string;
  onLoadMore: (directory: string, append: boolean) => void;
  translate: BrowseTranslate;
}) {
  const t = props.translate;
  const failed = props.state.error !== undefined;
  return (
    <div className={"storage-browse__tree-status " + props.className}>
      <span className="storage-browse__hint">
        {failed
          ? t("storage.browse.loadFailed", { defaultValue: "This directory could not be listed." })
          : props.state.loading
            ? t("storage.browse.loading", { defaultValue: "Loading…" })
            : t("storage.browse.emptyDirectory", { defaultValue: "This directory is empty." })}
      </span>
      {failed ? (
        <button
          type="button"
          className="storage-browse__tree-more-button"
          onClick={() => props.onLoadMore(props.directory, false)}
        >
          {t("storage.browse.retry", { defaultValue: "Retry" })}
        </button>
      ) : null}
    </div>
  );
}

/**
 * 一个目录的子项列表，带固定大小的展示分页与存储分页入口。
 *
 * 树不能全量渲染已加载节点：一个大目录会把整棵树撑爆。但也不能用「一直放大同一个
 * 切片」的办法换取可达性——那等于把规模上限还给目录本身。因此翻页：任一时刻只渲染
 * 一页，每个已加载子项都能翻到。展示分页与存储分页互不依赖：前者只决定已发现项里
 * 显示哪一页，后者决定还能发现哪些对象。
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
  const { translate: t } = props;
  const directory = props.node?.path ?? BROWSE_ROOT_DIRECTORY;
  // 每一行都是自己的节点，父节点只用来在 TreeRow 里回传事件。
  const { node: _owner, nested, ...treeProps } = props;
  const rows = window.visible.map((child) => (
    <TreeRow {...treeProps} key={child.kind + ":" + child.path} node={child} depth={props.depth} />
  ));
  const more = window.pageCount > 1 ? (
    <li className="storage-browse__tree-more" role="none">
      <span className="storage-browse__tree-page">
        {t("storage.browse.renderWindow", {
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
        {t("storage.browse.pagePrevious", { defaultValue: "Previous items" })}
      </button>
      <button
        type="button"
        className="storage-browse__tree-toggle storage-browse__tree-more-button"
        disabled={!window.hasNext}
        onClick={() => setPage(window.page + 1)}
      >
        {t("storage.browse.pageNext", { defaultValue: "Next items" })}
      </button>
    </li>
  ) : null;
  const loadMore = props.state.error === undefined && !isDirectoryComplete(props.state) ? (
    <li className="storage-browse__tree-more" role="none">
      <button
        type="button"
        className="storage-browse__tree-toggle storage-browse__tree-more-button"
        disabled={props.state.loading}
        title={t("storage.browse.partialHint", {
          defaultValue: "More objects may exist under this prefix; browsing only reads metadata.",
        })}
        onClick={() => props.onLoadMore(directory, true)}
      >
        {props.state.loading
          ? t("storage.browse.loading", { defaultValue: "Loading…" })
          : t("storage.browse.loadMore", { defaultValue: "Load more" })}
      </button>
    </li>
  ) : null;
  // 部分已加载但列举中断：错误与重试必须和已有子项一起留在树里。
  const error = props.state.error !== undefined ? (
    <li className="storage-browse__tree-more" role="none">
      <span className="storage-browse__hint">
        {t("storage.browse.loadFailed", { defaultValue: "This directory could not be listed." })}
      </span>
      <button
        type="button"
        className="storage-browse__tree-toggle storage-browse__tree-more-button"
        onClick={() => props.onLoadMore(directory, false)}
      >
        {t("storage.browse.retry", { defaultValue: "Retry" })}
      </button>
    </li>
  ) : null;
  // 根列表的外层 <ul role="tree"> 已经存在，行必须直接作为它的 <li> 子节点。
  return nested
    ? <ul className="storage-browse__tree-children" role="group">{error}{rows}{more}{loadMore}</ul>
    : <>{error}{rows}{more}{loadMore}</>;
}
