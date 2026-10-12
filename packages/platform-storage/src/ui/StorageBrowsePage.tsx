// 「设置 → 存储」页面：只读存储浏览器。
//
// 这个组件是页面侧唯一与浏览数据打交道的 React 组件。它本身不解析钱包数据：
// 格式判定、UTF-8 校验、K-V 解码与 1 MiB 上限都在 Worker 完成。它负责三件
// 只有页面才做得了的事：
//
//   1. 目录状态机：每个目录独立游标、已加载子项与完成状态。深目录会占满多页，
//      同一子目录在多页重复出现，所以「是否扫完」只看游标。
//   2. 竞态：快速切换用取消加请求序号。迟到响应既不能覆盖新选择，也不能在锁定
//      之后把旧内容重新画回来。
//   3. 只读：整个页面没有任何写调用；展开、选中与预览开关只存在于组件内存。
//
// 页面只有两个可见区域：文件树与文件内容，二者合成一个等高面板。目录列表已经
// 移除，目录内容通过展开树查看；「继续加载」入口移进树里，仍能发现未加载的对象。
// 面包屑跟随选中项：选中文件时显示可导航的父目录链加文件名，选中目录时显示目录
// 自身路径。内容区一直在：选中文件显示预览与属性，选中目录显示目录信息（路径、
// 已加载子项数与目录标记），未选中时给出引导。面板高度是固定比例（见 styles.css），
// 不做桌面/窄屏之外的尺寸计算。
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { StorageBrowsePreview } from "../runtime/storageBrowseTypes.js";
import { usePluginI18n as useI18n, usePluginLocale as useLocale } from "@keymaster/runtime";
import { useStoragePrivateBrowse } from "./StoragePrivateContext.js";
import { Button, PageHeader } from "@keymaster/ui";
import {
  applyBrowsePage,
  emptyDirectoryState,
  isSameNodeIdentity,
  type BrowseDirectoryState,
} from "./storageBrowseState.js";
import {
  BROWSE_ROOT_DIRECTORY,
  basename,
  breadcrumbSegments,
  directoryChain,
  displayDirectory,
  parentDirectory,
  type BrowseChildNode,
} from "./storageBrowseTree.js";
import { StorageBrowseTreeView } from "./StorageBrowseTreeView.js";
import { PreviewPane, type BrowsePreviewState } from "./StorageBrowsePreviewPane.js";
import { PropertiesPane } from "./StorageBrowsePropertiesPane.js";

/** 单次列举的页大小；与 Worker 默认一致，页面不放大。 */
const BROWSE_PAGE_LIMIT = 200;

/** 目录路径 → 它的加载状态。未列举过的目录不在表里。 */
type Directories = Readonly<Record<string, BrowseDirectoryState>>;

type DirectoryAction =
  | { type: "set"; directory: string; value: BrowseDirectoryState }
  | { type: "patch"; directory: string; patch: Partial<BrowseDirectoryState> }
  | { type: "reset" };

function directoriesReducer(state: Directories, action: DirectoryAction): Directories {
  if (action.type === "reset") return {};
  const current = state[action.directory] ?? emptyDirectoryState();
  return {
    ...state,
    [action.directory]: action.type === "set" ? action.value : { ...current, ...action.patch },
  };
}

function initialDirectories(): Directories {
  return {};
}

export function StorageBrowsePage() {
  const { t } = useI18n();
  const locale = useLocale();
  const service = useStoragePrivateBrowse();

  const [directories, dispatch] = useReducer(directoriesReducer, undefined, initialDirectories);
  const [selected, setSelected] = useState<BrowseChildNode | undefined>(undefined);
  const [preview, setPreview] = useState<BrowsePreviewState | undefined>(undefined);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [panel, setPanel] = useState<"preview" | "properties">("preview");
  const [wrapText, setWrapText] = useState(true);
  // 原文/源码/原始信封是「这份文件当前怎么看」，不是跨文件的用户偏好：换文件时回到
  // 默认视图，否则上一个文件切到原文之后，下一份会悄悄继承它。
  const [rawJson, setRawJson] = useState(false);
  const [markdownSource, setMarkdownSource] = useState(false);
  const [kvRaw, setKvRaw] = useState(false);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [refreshToken, setRefreshToken] = useState(0);

  // 回调里要读最新目录状态，但不希望它成为依赖：这两个 ref 是它们的读取通道。
  const directoriesRef = useRef(directories);
  directoriesRef.current = directories;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  // 每个目录一个取消器：切换目录只中止那一次列举，不影响已加载好的其它目录。
  const listControllers = useRef(new Map<string, AbortController>());
  const previewController = useRef<AbortController | undefined>(undefined);
  const previewSequence = useRef(0);
  // 刷新核对已经取回的最新预览；路径 → 结果。一次消费即失效，避免陈旧内容复活。
  const verifiedPreviews = useRef(new Map<string, StorageBrowsePreview>());
  // mounted 是「这个 effect 世代还活着吗」，不是「组件存在过吗」。初始值不能是
  // true：React StrictMode 会在开发环境挂载后立刻模拟一次 unmount/remount，
  // 那次 cleanup 把 mounted 置成 false，而此后没有任何东西把它置回 true。
  // 之后所有响应的守卫都因此恒假：请求被中止后不再重发，页面永远停在「加载中」，
  // 刷新页面也只是重走同一条路。effect 每次挂载都重新置 true，语义才成立。
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const controller of listControllers.current.values()) controller.abort();
      previewController.current?.abort();
    };
  }, []);

  const listDirectory = useCallback((directory: string, append: boolean) => {
    if (!service) return;
    listControllers.current.get(directory)?.abort();
    const controller = new AbortController();
    listControllers.current.set(directory, controller);
    // 重新列举时不能用旧游标：它绑定的是上一次扫描位置，会跳过或重复内容。
    const cursor = append ? directoriesRef.current[directory]?.cursor : undefined;
    dispatch({
      type: "patch",
      directory,
      patch: { loading: true, ...(append ? {} : { error: undefined, cursor: undefined }) },
    });
    void service
      .list({ prefix: directory, ...(cursor === undefined ? {} : { cursor }), limit: BROWSE_PAGE_LIMIT }, { signal: controller.signal })
      .then((page) => {
        if (!mounted.current) return;
        dispatch({
          type: "set",
          directory,
          value: applyBrowsePage(
            directoriesRef.current[directory] ?? emptyDirectoryState(),
            directory,
            { entries: page.entries, ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) },
            append,
          ),
        });
      })
      .catch((error: unknown) => {
        if (!mounted.current || controller.signal.aborted) return;
        dispatch({ type: "patch", directory, patch: { loading: false, error: browseErrorText(error, t) } });
      })
      .finally(() => {
        if (listControllers.current.get(directory) === controller) listControllers.current.delete(directory);
      });
  }, [service, t]);

  // 根目录是树的起点：进入页面与刷新后都从它重新开始；展开的其它目录由 refresh 负责。
  useEffect(() => {
    if (!service) return;
    listDirectory(BROWSE_ROOT_DIRECTORY, false);
  }, [service, listDirectory, refreshToken]);

  const loadPreview = useCallback((node: BrowseChildNode) => {
    if (!service) return;
    // 刷新核对时已经读到过这个文件的最新内容：直接用那份结果，既省掉一次重复读取，
    // 也保证用户点下「刷新」后立刻看到新内容。
    const verified = verifiedPreviews.current.get(node.path);
    if (verified) {
      verifiedPreviews.current.delete(node.path);
      previewController.current?.abort();
      previewController.current = undefined;
      previewSequence.current += 1;
      setPreview({ path: node.path, status: "ready", preview: verified });
      return;
    }
    previewController.current?.abort();
    const controller = new AbortController();
    previewController.current = controller;
    previewSequence.current += 1;
    const sequence = previewSequence.current;
    setPreview({ path: node.path, status: "loading" });
    void service
      .preview({ path: node.path, ...(node.revision === undefined ? {} : { ifRevision: node.revision }) }, { signal: controller.signal })
      .then((result) => {
        // 三重校验：组件仍在、序号仍是最新、选中项没被换掉。少任何一条，
        // 迟到的响应就会把上一个文件的内容画到当前选择上。
        if (!mounted.current || previewSequence.current !== sequence || selectedRef.current?.path !== node.path) return;
        setPreview({ path: node.path, status: "ready", preview: result });
      })
      .catch((error: unknown) => {
        if (!mounted.current || previewSequence.current !== sequence || controller.signal.aborted) return;
        setPreview({ path: node.path, status: "error", error: browseErrorText(error, t) });
      });
  }, [service, t]);

  useEffect(() => {
    // 目录也可以被选中（面包屑与树上的位置），但目录没有可预览的内容。
    if (!selected || selected.kind === "directory") {
      setPreview(undefined);
      return;
    }
    loadPreview(selected);
  }, [selected, loadPreview]);

  // 视图开关按文件生效：预览对象换了路径就回到默认视图。自动换行仍然是跨文件的
  // 用户偏好，因此不在这里重置。
  const previewPath = preview?.path;
  useEffect(() => {
    setRawJson(false);
    setMarkdownSource(false);
    setKvRaw(false);
  }, [previewPath]);

  const refresh = useCallback(() => {
    // 刷新保留选中项与展开状态，把已加载目录的缓存全部作废后逐个重新列举。
    // 根目录由上面的 effect 负责；其余已加载目录都是展开可见的，必须一并重取，
    // 否则它们会掉回「尚未加载」。
    const loaded = Object.keys(directoriesRef.current)
      .filter((directory) => directory !== BROWSE_ROOT_DIRECTORY);
    previewController.current?.abort();
    previewSequence.current += 1;
    verifiedPreviews.current.clear();
    setPreview(undefined);
    setNotice(undefined);
    dispatch({ type: "reset" });
    for (const directory of loaded) listDirectory(directory, false);
    setRefreshToken((token) => token + 1);
  }, [listDirectory]);

  /**
   * 当前目录重新列举后，决定选中项是保留、换新元数据还是清除。
   *
   * 刷新不是回到空白页，但也不能反过来把「这一页没列到」当成「文件已被删除」：
   * 深目录要翻好几页，同一路径的文件被更新后版本也会变。因此核对分两步：
   *
   *   1. 在已加载的子项里按「种类 + 完整路径」找同身份。找到就用新元数据替换旧节点，
   *      预览随后按新版本重新发出。
   *   2. 没找到时**不能**断言删除：直接向 Worker 核验这个路径是否仍可读。仍可读说明它
   *      只是还没被翻到（或已被更新），保留并采用返回的版本；只有确实读不到时才清除
   *      旧内容并提示。
   */
  const reconcileSelection = useCallback(
    async (listing: BrowseDirectoryState, previous: BrowseChildNode | undefined) => {
      if (!service || !previous || previous.kind !== "file") return;
      const sequence = previewSequence.current;
      const stale = (): boolean => !mounted.current || previewSequence.current !== sequence
        || selectedRef.current?.path !== previous.path;
      const same = listing.children.find((node) => isSameNodeIdentity(node, previous));
      if (same) {
        setSelected(same);
        return;
      }
      try {
        // 无条件读取这一条路径：这是唯一能证明「它还在」的权威事实，而不是「它没被列到」。
        const verified = await service.preview({ path: previous.path });
        if (stale()) return;
        verifiedPreviews.current.set(previous.path, verified);
        setSelected({
          ...previous,
          size: verified.totalSize,
          revision: verified.revision,
          lastModified: verified.lastModified,
        });
      } catch (error: unknown) {
        if (stale()) return;
        // 页面自己放弃的请求（切文件、手动刷新）静默退出：那是正常操作，不是失败。
        if (isBrowseCancel(error)) return;
        const code = browseErrorCode(error);
        // 只有「对象不存在」能断言删除。存储暂不可用、权限失败、传输失败都不证明文件
        // 没了：把选择清掉等于凭空告诉用户「你的文件被删了」。
        if (code === "storage_not_found") {
          setSelected(undefined);
          setPreview(undefined);
          setNotice(t("storage.browse.removed", { defaultValue: "The selected file no longer exists." }));
          return;
        }
        // 其它失败保留选中路径，并显示可重试的失败状态。锁定与句柄失效也不算删除，
        // 因此这里必须给出可见的说明，而不是当成取消悄悄跳过。
        setPreview({ path: previous.path, status: "error", error: browseErrorText(error, t) });
        setNotice(code === "storage_unavailable"
          ? t("storage.browse.unavailable", {
            defaultValue: "Storage browsing is not available. The wallet may be locked.",
          })
          : t("storage.browse.verifyFailed", {
            defaultValue: "The selected file could not be verified after refreshing; it may still exist.",
          }));
      }
    },
    [service, t],
  );

  // 刷新后以选中文件所在目录的列表为准做核对；没有选中项时以根目录为准。
  // ref 记录已经核对过的那一轮刷新，避免「加载更多」或重渲染重复核对一次。
  const reconciledToken = useRef(0);
  useEffect(() => {
    if (refreshToken === 0 || reconciledToken.current === refreshToken) return;
    const current = selectedRef.current;
    const parent = current ? parentDirectory(current.path) ?? BROWSE_ROOT_DIRECTORY : BROWSE_ROOT_DIRECTORY;
    const listing = directories[parent];
    if (!listing || listing.loading || listing.error !== undefined) return;
    reconciledToken.current = refreshToken;
    void reconcileSelection(listing, current);
  }, [directories, reconcileSelection, refreshToken]);

  /** 预览失败后的重试：重新读当前选中项，版本沿用列表元数据。 */
  const retryPreview = useCallback(() => {
    const current = selectedRef.current;
    if (current && current.kind === "file") loadPreview(current);
  }, [loadPreview]);

  const selectFile = useCallback((node: BrowseChildNode) => {
    setSelected(node);
    setPanel("preview");
  }, []);

  /**
   * 进入一个目录：选中它，并把整条父链展开、加载，让它在树里可见。
   *
   * 目录没有可展示的内容（内容区只在选中文件时出现），因此「进入目录」的结果就是
   * 树上的位置与跟随选中项的面包屑，而不是另一个列表。
   */
  const selectDirectory = useCallback((directory: string) => {
    setSelected({
      path: directory,
      name: directory === BROWSE_ROOT_DIRECTORY ? "" : basename(directory),
      kind: "directory",
    });
    const chain = directoryChain(directory);
    if (chain.length > 0) {
      setExpanded((current) => {
        const next = new Set(current);
        for (const path of chain) next.add(path);
        return next;
      });
    }
    // 展开一个尚未列举过的目录时立刻按该前缀加载：点进子目录不必等父目录扫完。
    for (const path of chain) {
      if (!directoriesRef.current[path]) listDirectory(path, false);
    }
  }, [listDirectory]);

  const toggleDirectory = useCallback((node: BrowseChildNode) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(node.path)) next.delete(node.path);
      else next.add(node.path);
      return next;
    });
    // 展开一个尚未列举过的目录时立刻按该前缀加载：点进子目录不必等父目录扫完。
    if (!directoriesRef.current[node.path]) listDirectory(node.path, false);
  }, [listDirectory]);

  /** 树里的存储分页入口：append=false 是失败后的重新列举。 */
  const loadMore = useCallback((directory: string, append: boolean) => {
    listDirectory(directory, append);
  }, [listDirectory]);

  const copyPath = useCallback(() => {
    const path = selectedRef.current?.path;
    if (path === undefined) return;
    const clipboard = navigator.clipboard;
    if (!clipboard) {
      setNotice(t("storage.browse.copyFailed", { defaultValue: "The path could not be copied." }));
      return;
    }
    // 根目录的内部路径是空串；复制与属性面板一样给出它的显示写法 `/`。
    void clipboard.writeText(displayDirectory(path)).then(
      () => setNotice(t("storage.browse.pathCopied", { defaultValue: "Path copied to the clipboard." })),
      () => setNotice(t("storage.browse.copyFailed", { defaultValue: "The path could not be copied." })),
    );
  }, [t]);

  const rootState = directories[BROWSE_ROOT_DIRECTORY] ?? emptyDirectoryState();
  // 文件属性里的目录标记来自它所在目录：标记路径由目录推导，刷新时随新元数据更新。
  const fileParentState = selected?.kind === "file"
    ? directories[parentDirectory(selected.path) ?? BROWSE_ROOT_DIRECTORY]
    : undefined;
  // 目录属性里的标记与子项数来自这个目录自己的加载状态。
  const selectedDirectoryState = selected?.kind === "directory" ? directories[selected.path] : undefined;

  if (!service) {
    return (
      <div className="storage-browse-page">
        <PageHeader title={t("storage.browse.title", { defaultValue: "Storage browser" })} />
        <p className="storage-browse__hint">
          {t("storage.browse.unavailable", {
            defaultValue: "Storage browsing is not available. The wallet may be locked.",
          })}
        </p>
      </div>
    );
  }

  return (
    <div className="storage-browse-page">
      <PageHeader
        title={t("storage.browse.title", { defaultValue: "Storage browser" })}
        description={t("storage.browse.description", {
          defaultValue: "Read-only view of the files this wallet stores in this browser.",
        })}
        actions={
          <Button size="sm" variant="secondary" onClick={refresh}>
            {t("storage.browse.refresh", { defaultValue: "Refresh" })}
          </Button>
        }
      />

      <nav className="storage-browse__crumbs" aria-label={t("storage.browse.crumbs.label", { defaultValue: "Current path" })}>
        <BrowseBreadcrumbs
          selected={selected}
          onNavigate={selectDirectory}
          translate={t}
        />
      </nav>

      {notice ? <p className="storage-browse__notice" role="status">{notice}</p> : null}

      <div className="storage-browse__layout">
        <aside className="storage-browse__tree-panel">
          <StorageBrowseTreeView
            rootState={rootState}
            expanded={expanded}
            selectedPath={selected?.path}
            childrenOf={(directory) => directories[directory]}
            onToggle={toggleDirectory}
            onSelectDirectory={selectDirectory}
            onSelectFile={selectFile}
            onLoadMore={loadMore}
            translate={t}
          />
        </aside>

        <section className="storage-browse__detail" aria-label={t("storage.browse.detail.label", { defaultValue: "File detail" })}>
          {selected?.kind === "file" ? (
            <>
              <div className="storage-browse__tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  className={"storage-browse__tab" + (panel === "preview" ? " is-active" : "")}
                  aria-selected={panel === "preview"}
                  onClick={() => setPanel("preview")}
                >
                  {t("storage.browse.tab.preview", { defaultValue: "Preview" })}
                </button>
                <button
                  type="button"
                  role="tab"
                  className={"storage-browse__tab" + (panel === "properties" ? " is-active" : "")}
                  aria-selected={panel === "properties"}
                  onClick={() => setPanel("properties")}
                >
                  {t("storage.browse.tab.properties", { defaultValue: "Properties" })}
                </button>
              </div>
              {panel === "preview" ? (
                <PreviewPane
                  state={preview}
                  locale={locale}
                  translate={t}
                  wrapText={wrapText}
                  onToggleWrap={() => setWrapText((value) => !value)}
                  rawJson={rawJson}
                  onToggleRawJson={() => setRawJson((value) => !value)}
                  markdownSource={markdownSource}
                  onToggleMarkdownSource={() => setMarkdownSource((value) => !value)}
                  kvRaw={kvRaw}
                  onToggleKvRaw={() => setKvRaw((value) => !value)}
                  onRetry={retryPreview}
                />
              ) : (
                <PropertiesPane
                  locale={locale}
                  translate={t}
                  selected={selected}
                  preview={preview?.status === "ready" ? preview.preview : undefined}
                  // 目录标记取所选文件所在目录的标记。
                  directoryMarker={fileParentState?.marker}
                  onCopyPath={copyPath}
                />
              )}
            </>
          ) : selected?.kind === "directory" ? (
            // 目录没有内容可预览，但内容区一直在：显示这个目录自己的信息与标记。
            <PropertiesPane
              locale={locale}
              translate={t}
              selected={selected}
              preview={undefined}
              directoryMarker={selectedDirectoryState?.marker}
              childCount={selectedDirectoryState?.children.length ?? 0}
              onCopyPath={copyPath}
            />
          ) : (
            <p className="storage-browse__hint">
              {t("storage.browse.detail.empty", { defaultValue: "Select a file or directory in the file tree." })}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

function BrowseBreadcrumbs(props: {
  selected: BrowseChildNode | undefined;
  onNavigate: (directory: string) => void;
  translate: (key: string, values?: Record<string, string | number>) => string;
}) {
  const segments = useMemo(() => breadcrumbSegments(props.selected), [props.selected]);
  const atRoot = segments.length === 0;
  return (
    <>
      <button
        type="button"
        className={"storage-browse__crumb" + (atRoot ? " is-current" : "")}
        aria-current={atRoot ? "location" : undefined}
        onClick={() => props.onNavigate(BROWSE_ROOT_DIRECTORY)}
      >
        {props.translate("storage.browse.crumb.root", { defaultValue: "/" })}
      </button>
      {segments.map((segment, index) => (
        <span key={segment.path} className="storage-browse__crumb-segment">
          {/* 根面包屑本身就是前导 `/`，第一段前不再重复分隔符。 */}
          {index > 0 ? <span className="storage-browse__crumb-sep" aria-hidden="true">/</span> : null}
          {segment.current ? (
            <span className="storage-browse__crumb is-current" aria-current="location">
              {segment.name}
            </span>
          ) : (
            <button type="button" className="storage-browse__crumb" onClick={() => props.onNavigate(segment.path)}>
              {segment.name}
            </button>
          )}
        </span>
      ))}
    </>
  );
}

/** 浏览错误的结构化码；非结构化错误返回 undefined。 */
function browseErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code as string | undefined
    : undefined;
}

/**
 * 这是一次「页面自己放弃」的请求吗。
 *
 * 只有真正的取消（AbortError / transport-error）算放弃。`storage_unavailable` 是
 * 存储暂不可用（锁定、句柄作废、Worker 重启），必须让用户看见，不能静默吞掉。
 */
function isBrowseCancel(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return true;
  return browseErrorCode(error) === "transport-error";
}

/**
 * 浏览错误统一成一句可读提示。
 *
 * 版本冲突与文件已删除在这里被翻译成「刷新」指引，而不是把 Wire 上的错误码直接
 * 甩给用户：这两种都是正常现象，页面能自己给出下一步。
 */
function browseErrorText(
  error: unknown,
  translate: (key: string, values?: Record<string, string | number>) => string,
): string {
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  switch (code) {
    case "storage_not_found":
      return translate("storage.browse.gone", { defaultValue: "This object no longer exists." });
    case "storage_conflict":
      return translate("storage.browse.changed", {
        defaultValue: "This object changed since it was listed. Refresh to read the current version.",
      });
    case "storage_unavailable":
      return translate("storage.browse.unavailable", {
        defaultValue: "Storage browsing is not available. The wallet may be locked.",
      });
    case "storage_forbidden":
      return translate("storage.browse.forbidden", { defaultValue: "This request is not permitted." });
    default:
      return error instanceof Error && error.message.length > 0
        ? error.message
        : translate("storage.browse.failed", { defaultValue: "The request failed." });
  }
}

/** 供测试断言：根目录与多级目录的显示写法。 */
export { displayDirectory };
