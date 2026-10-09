// Forum 页面。
//
// 三条展示纪律直接体现在组件里：
//   - 三种回复价格分别展示，不合并成一个「价格」；
//   - 正文状态与索引失败分别显示，正文不可达时节点和回复结构照常渲染；
//   - 广播、链上、索引三套状态分开显示，查无节点时展示「等待发现」而不是
//     编造一个拒绝原因。

import { createElement, useCallback, useEffect, useState, type ReactNode, type MouseEvent } from "react";
import { router, usePluginI18n } from "@keymaster/runtime";
import {
  FORUM_PAGE_SIZE_DEFAULT,
  FORUM_PAGE_SIZE_MAX,
  forumAmountToBigInt,
  type ForumAttachmentContent,
  type ForumConfig,
  type ForumContentState,
  type ForumListOperation,
  type ForumNodeView,
  type ForumPublicationReachability,
  type ForumPublishTask,
  type ForumReadingView,
  type ForumRootVerification,
} from "@keymaster/contracts";

import { createForumListBinding, forumListLoader, useForumListBinding, useForumListSnapshot } from "./forumListBinding.js";
import { ForumBusinessError } from "./domain/indexClient.js";
import { renderForumMarkdown, type ForumRenderNode } from "./markdown/markdown.js";
import { useForum } from "./ForumResourceContext.js";

/** Internal navigation keeps the owner session alive; ordinary href still
 * supports copying the address and opening a new tab with modifier keys. */
function internalForumLink(href: string, label: string, className = "forum-link"): ReactNode {
  return createElement("a", { href, className, onClick: (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); router.push(href);
  } }, label);
}

export function ForumHomePage(): ReactNode {
  const { t } = usePluginI18n();
  const { forum } = useForum();
  const [configs, setConfigs] = useState<readonly ForumConfig[]>([]);
  const [roots, setRoots] = useState<ReadonlyMap<string, ForumRootVerification>>(new Map());
  const [error, setError] = useState<string | undefined>();

  /** 配置保存成功后把它并入列表，用户不需要刷新页面。 */
  const onConfigSaved = useCallback((configId: string) => {
    void forum.getConfig(configId).then((value) => {
      if (value === undefined) return;
      setConfigs((prev) => (prev.some((item) => item.id === configId) ? prev : [...prev, value]));
    });
  }, [forum]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await forum.listConfigs();
        if (cancelled) return;
        setConfigs(list);
        const entries = await Promise.all(
          list.map(async (config) => [config.id, await forum.getRootVerification(config.id)] as const),
        );
        if (cancelled) return;
        setRoots(new Map(entries.filter((pair): pair is readonly [string, ForumRootVerification] => pair[1] !== undefined)));
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [forum]);

  return createForumShell(
    t("forum.page.title"),
    t("forum.page.subtitle"),
    error,
    createElement(ForumConfigForm, { onSaved: onConfigSaved }),
    configs.map((config) =>
      createElement(ForumConfigCard, {
        key: config.id,
        config,
        root: roots.get(config.id),
        // 验证成功后立刻更新首页持有的证据：浏览入口不必等刷新页面。
        onRootVerified: (root) => setRoots((prev) => new Map(prev).set(config.id, root)),
      }),
    ),
  );
}

/**
 * 新增论坛配置。
 *
 * 地址按 kind 分三种形态校验：HTTPS 是 URL，WSS/Direct 是完整 multiaddr。
 * 校验规则与装配时一致，所以配置保存成功就意味着能被拨号——不会等到第一次
 * 连接才发现地址形态不对。
 */
function ForumConfigForm(props: { onSaved(configId: string): void }): ReactNode {
  const { t } = usePluginI18n();
  const { forum } = useForum();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [forumTxid, setForumTxid] = useState("");
  const [forumKey, setForumKey] = useState("");
  const [network, setNetwork] = useState<"main" | "test">("main");
  const [endpointKind, setEndpointKind] = useState<"https" | "libp2p-wss" | "webrtc-direct">("https");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      const configId = slug(label) || randomSuffix();
      await forum.saveConfig({ id: configId, label, network, forumTxid, forumPublicKeyHex: forumKey, endpoints: [{ kind: endpointKind, url } as never] });
      props.onSaved(configId);
      setOpen(false);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }, [forum, label, network, forumTxid, forumKey, endpointKind, url, props]);

  if (!open) {
    return createElement("button", { type: "button", onClick: () => setOpen(true) }, t("forum.config.add"));
  }
  return createElement(
    "form",
    { className: "forum-config-form", onSubmit: (event: { preventDefault(): void }) => { event.preventDefault(); void submit(); } },
    createElement("h3", null, t("forum.config.add")),
    field(t("forum.config.label"), label, setLabel),
    field(t("forum.config.forumTxid"), forumTxid, setForumTxid),
    field(t("forum.config.forumKey"), forumKey, setForumKey),
    createElement("label", null, t("forum.config.network"),
      createElement("select", { value: network, onChange: (event: { target: { value: string } }) => setNetwork(event.target.value === "test" ? "test" : "main") },
        createElement("option", { value: "main" }, "main"),
        createElement("option", { value: "test" }, "test"),
      ),
    ),
    createElement("label", null, t("forum.config.endpoints"),
      createElement("select", { value: endpointKind, onChange: (event: { target: { value: string } }) => setEndpointKind(event.target.value as typeof endpointKind) },
        createElement("option", { value: "https" }, "https"),
        createElement("option", { value: "libp2p-wss" }, "libp2p-wss"),
        createElement("option", { value: "webrtc-direct" }, "webrtc-direct"),
      ),
    ),
    field(t("forum.config.endpoints"), url, setUrl),
    error === undefined ? null : createElement("p", { className: "forum-status forum-status-error" }, error),
    createElement("button", { type: "submit", disabled: busy || label === "" || forumTxid === "" || forumKey === "" || url === "" }, t("forum.config.add")),
  );
}

function field(label: string, value: string, onChange: (value: string) => void): ReactNode {
  return createElement("label", null, label, createElement("input", { value, onChange: (event: { target: { value: string } }) => onChange(event.target.value) }));
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^[^a-z0-9]+|[^a-z0-9]+$/gu, "").slice(0, 60);
}

function randomSuffix(): string {
  return `f${Date.now().toString(36)}`;
}

/**
 * 导出供渲染测试：配置卡片的行为（浏览入口是否出现、验证后是否更新）需要断言
 * DOM 与回调。
 */
export function ForumConfigCard(props: {
  readonly config: ForumConfig;
  readonly root: ForumRootVerification | undefined;
  /** 根验证成功后把新证据上报，让首页更新而不必刷新。 */
  readonly onRootVerified?: (root: ForumRootVerification) => void;
}): ReactNode {
  const { t } = usePluginI18n();
  const { forum } = useForum();
  const [status, setStatus] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const verify = useCallback(async () => {
    setBusy(true);
    setStatus(undefined);
    try {
      // 验证成功后把证据交回首页：否则浏览链接要等刷新页面才出现，
      // 「新增配置 → 验证 → 进入论坛」这条链路会断在最后一步。
      props.onRootVerified?.(await forum.verifyRoot(props.config.id));
      setStatus(t("forum.config.verified"));
    } catch (error) {
      // 根验证失败必须显示原因：没有信任锚就没有任何后续操作的依据。
      setStatus(describeError(error));
    } finally {
      setBusy(false);
    }
  }, [forum, props.config.id]);

  return createElement(
    "section",
    { className: "forum-config-card" },
    createElement("h3", null, props.config.label),
    createElement("dl", { className: "forum-config-fields" },
      createElement("dt", null, t("forum.config.forumTxid")),
      createElement("dd", null, props.config.forumTxid),
      createElement("dt", null, t("forum.config.forumKey")),
      createElement("dd", null, props.config.forumPublicKeyHex),
      createElement("dt", null, t("forum.config.network")),
      createElement("dd", null, props.config.network),
      createElement("dt", null, t("forum.config.endpoints")),
      createElement("dd", null, props.config.endpoints.map((endpoint) => `${endpoint.kind} ${endpoint.url}`).join("，")),
    ),
    createElement("p", { className: "forum-config-root" },
      props.root === undefined
        ? t("forum.config.unverified")
        : `${t("forum.config.verified")} · ${props.root.forumName} · ${props.root.tipPrice} sat · ${props.root.baseline}`,
    ),
    createElement("button", { type: "button", disabled: busy, onClick: () => void verify() }, t("forum.config.verifyRoot")),
    // 根未验证时不给浏览入口：没有信任锚就没有任何后续操作的依据，
    // 让用户点进去只会看到一个「配置不存在」的加载占位。
    props.root === undefined
      ? null
      : internalForumLink(forumBoardsPath(props.config.id), t("forum.config.browse")),
    status === undefined ? null : createElement("p", { className: "forum-status" }, status),
  );
}

export function ForumBoardPage(props: { readonly configId: string }): ReactNode {
  const { forum } = useForum();
  const [config, setConfig] = useState<ForumConfig | undefined>();
  useEffect(() => {
    let cancelled = false;
    void forum.getConfig(props.configId).then((value) => {
      if (!cancelled) setConfig(value);
    });
    return () => {
      cancelled = true;
    };
  }, [forum, props.configId]);
  if (config === undefined) return createElement("p", null, "…");
  return createElement(ForumListPage, { config, operation: "list_boards", parentTxid: config.forumTxid, title: "forum.list.boards" });
}

export function ForumPostsPage(props: { readonly configId: string; readonly boardTxid: string }): ReactNode {
  const { forum } = useForum();
  const [config, setConfig] = useState<ForumConfig | undefined>();
  useEffect(() => {
    let cancelled = false;
    void forum.getConfig(props.configId).then((value) => {
      if (!cancelled) setConfig(value);
    });
    return () => {
      cancelled = true;
    };
  }, [forum, props.configId]);
  if (config === undefined) return createElement("p", null, "…");
  return createElement(ForumListPage, { config, operation: "list_posts", parentTxid: props.boardTxid, title: "forum.list.posts" });
}

export function ForumPostPage(props: { readonly configId: string; readonly txid: string }): ReactNode {
  const { t } = usePluginI18n();
  const { forum } = useForum();
  const [view, setView] = useState<ForumReadingView | undefined>();
  const [node, setNode] = useState<ForumNodeView | undefined>();
  const [forumTxid, setForumTxid] = useState<string>("");
  const [error, setError] = useState<string | undefined>();
  const [reading, setReading] = useState(false);

  // 先读配置：回复树的创世根与分页绑定都需要它，不能拿 configId 顶替。
  useEffect(() => {
    let cancelled = false;
    void forum.getConfig(props.configId).then((value) => {
      if (!cancelled) setForumTxid(value?.forumTxid ?? "");
    });
    return () => {
      cancelled = true;
    };
  }, [forum, props.configId]);

  // 再读节点：正文 hash、作者与三种价格都来自它。
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    void (async () => {
      try {
        const detail = await forum.getNode(props.configId, props.txid, { signal: controller.signal });
        if (!cancelled) setNode(detail);
      } catch (cause) {
        if (!cancelled) setError(describeError(cause));
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [forum, props.configId, props.txid]);

  const seedHashHex = node?.replyMasterSeedHash ?? null;

  // 打开本地已有正文：不触发付费获取。
  useEffect(() => {
    if (seedHashHex === null) return;
    const controller = new AbortController();
    let cancelled = false;
    void forum
      .readContent(props.configId, seedHashHex, { signal: controller.signal })
      .then((reading) => {
        if (!cancelled) setView({ ...reading, node: reading.node.txid === "" ? (node as ForumNodeView) : reading.node });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [forum, props.configId, seedHashHex, node?.txid]);

  /** 明确的「阅读」动作：请求 MSFile 获取，再读已验证正文。 */
  const openRemote = useCallback(async () => {
    if (seedHashHex === null) return;
    setReading(true);
    setError(undefined);
    try {
      const reading = await forum.openAndFetch(props.configId, seedHashHex);
      setView({ ...reading, node: reading.node.txid === "" ? (node as ForumNodeView) : reading.node });
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setReading(false);
    }
  }, [forum, props.configId, seedHashHex, node]);

  /** 附件获取：附件失败不阻塞正文。 */
  const openAttachment = useCallback(
    async (seedHash: string) => {
      setError(undefined);
      try {
        const status = await forum.readAttachment(props.configId, seedHash);
        if (status.state !== "verified") {
          setError(`${t("forum.read.notFetched")} (${status.failureCode ?? "unknown"})`);
        }
      } catch (cause) {
        setError(describeError(cause));
      }
    },
    [forum, props.configId, t],
  );

  return createElement(
    "article",
    { className: "forum-post" },
    node === undefined ? null : createElement(ForumNodeHeader, { node }),
    seedHashHex === null
      ? null
      : view?.content.state === "verified"
        ? null
        : createElement(
            "button",
            { type: "button", disabled: reading, onClick: () => void openRemote() },
            reading ? t("forum.read.fetching") : t("forum.read.open"),
          ),
    error === undefined ? null : createElement("p", { className: "forum-status forum-status-error" }, error),
    view === undefined
      ? null
      : createElement(ForumReadingBody, {
          view,
          onOpenAttachment: (hash) => void openAttachment(hash),
          // 附件读取走同一个服务入口：字节的完整性由 MSFile 对账，Forum 不自己读存储。
          loadAttachment: (hash) => forum.readAttachmentContent(props.configId, hash),
        }),
    node === undefined
      ? null
      : createElement(ForumReplyTree, { configId: props.configId, forumTxid, parentTxid: node.txid }),
    // 发布入口针对**当前节点**：回复是回它，改价是改它。
    // 改价的作者校验由服务端执行（只有作者能改价），界面不自己编一个「你是作者」的结论。
    createElement(
      "nav",
      { className: "forum-post-actions" },
      internalForumLink(forumPublishPath(props.configId, props.txid), t("forum.reply.title")),
      internalForumLink(forumPublishPath(props.configId, props.txid), t("forum.changetip.title")),
    ),
  );
}

/**
 * 回复树：按需展开。
 *
 * 只有用户点开时才请求，因此默认不会为整棵树触发正文获取；服务端顺序原样保留。
 */
function ForumReplyTree(props: { readonly configId: string; readonly forumTxid: string; readonly parentTxid: string }): ReactNode {
  const { t } = usePluginI18n();
  const { forum } = useForum();
  const [open, setOpen] = useState(false);
  const binding = useForumListBinding(
    useCallback(
      () =>
        createForumListBinding({
          key: {
            configId: props.configId,
            operation: "list_replies",
            parentTxid: props.parentTxid,
            // 创世根来自配置而不是 configId：它参与分页坐标的绑定。
            forumTxid: props.forumTxid,
          },
          loader: forumListLoader(forum, props.configId, "list_replies", props.forumTxid, props.parentTxid, FORUM_PAGE_SIZE_DEFAULT),
        }),
      [forum, props.configId, props.forumTxid, props.parentTxid],
    ),
  );
  const { view, items } = useForumListSnapshot(binding);

  if (!open) {
    return createElement(
      "button",
      { type: "button", onClick: () => { setOpen(true); void binding.reload("manual"); } },
      t("forum.list.replies"),
    );
  }
  return createElement(
    "section",
    { className: "forum-replies" },
    createElement("h3", null, t("forum.list.replies")),
    createElement(
      "ul",
      { className: "forum-node-list" },
      items.map((item) =>
        createElement(ForumNodeRow, { key: item.txid, configId: props.configId, operation: "list_replies", node: item }),
      ),
    ),
    view.needsManualRefresh || view.status === "failed"
      ? createElement("button", { type: "button", onClick: () => void binding.reload("manual") }, t("forum.list.refresh"))
      : createElement("button", { type: "button", disabled: view.exhausted, onClick: () => void binding.loadMore() }, t("forum.list.loadMore")),
    view.exhausted ? createElement("p", { className: "forum-hint" }, t("forum.list.exhausted")) : null,
  );
}

function ForumListPage(props: {
  readonly config: ForumConfig;
  readonly operation: ForumListOperation;
  readonly parentTxid: string;
  readonly title: string;
}): ReactNode {
  const { t } = usePluginI18n();
  const { forum } = useForum();
  // binding 的身份就是这组坐标；换父节点或换配置都会得到新的 binding，
  // 因此旧游标不可能被续接到新视图上。
  const binding = useForumListBinding(
    useCallback(
      () =>
        createForumListBinding({
          key: {
            configId: props.config.id,
            operation: props.operation,
            parentTxid: props.parentTxid,
            forumTxid: props.config.forumTxid,
          },
          loader: forumListLoader(forum, props.config.id, props.operation, props.config.forumTxid, props.parentTxid, FORUM_PAGE_SIZE_DEFAULT),
        }),
      [forum, props.config, props.operation, props.parentTxid],
    ),
  );
  const { view, items } = useForumListSnapshot(binding);

  return createElement(
    "section",
    { className: "forum-list" },
    createElement("h2", null, t(props.title)),
    internalForumLink(forumPublishPath(props.config.id, props.parentTxid), t("forum.reply.submit")),
    items.length === 0 && view.status !== "loading" ? createElement("p", { className: "forum-empty" }, "…") : null,
    // 严格保留服务端顺序：这里不做任何本地重排。
    createElement(
      "ul",
      { className: "forum-node-list" },
      items.map((item) =>
        createElement(ForumNodeRow, { key: item.txid, configId: props.config.id, operation: props.operation, node: item }),
      ),
    ),
    view.needsManualRefresh || view.status === "failed"
      ? createElement("button", { type: "button", onClick: () => void binding.reload("manual") }, t("forum.list.refresh"))
      : createElement(
          "button",
          { type: "button", disabled: view.exhausted || view.status === "loading", onClick: () => void binding.loadMore() },
          t("forum.list.loadMore"),
        ),
    view.exhausted ? createElement("p", { className: "forum-hint" }, t("forum.list.exhausted")) : null,
    view.stale ? createElement("p", { className: "forum-hint" }, t("forum.list.stale")) : null,
    view.errorCode === undefined
      ? null
      : createElement("p", { className: "forum-status forum-status-error" }, t(`forum.error.${view.errorCode}`, { defaultValue: view.errorCode })),
  );
}


/**
 * 列表里的一行节点。
 *
 * `configId` 与当前列表操作必须显式传进来：路由里的第一个参数是**本地配置 ID**，
 * 不是交易 txid。用 txid 填进去会让 `getConfig` 按父交易 hash 查配置，结果通常是
 * 「配置不存在」或永远停在加载占位。
 */
function ForumNodeRow(props: {
  readonly configId: string;
  readonly operation: ForumListOperation;
  readonly node: ForumNodeView;
}): ReactNode {
  const { t } = usePluginI18n();
  const { configId, operation, node } = props;
  // 板块行的入口是板块帖子列表，不是板块自己的节点详情：板块本身没有正文。
  const openPath = operation === "list_boards" ? forumPostsPath(configId, node.txid) : forumPostPath(configId, node.txid);
  return createElement(
    "li",
    { className: "forum-node-row" },
    createElement(ForumNodeHeader, { node }),
    createElement(
      "div",
      { className: "forum-node-actions" },
      // 进入节点：读正文、展开回复。
      internalForumLink(openPath, t("forum.read.open")),
      // 发布回复针对**这个节点**，所以 publish 的目标参数是 node.txid 而不是它的父。
      internalForumLink(forumPublishPath(configId, node.txid), t("forum.reply.title")),
      // 回复树由帖子页承载；板块页则直接展开它的帖子列表。
      node.hasChildren && operation === "list_boards"
        ? internalForumLink(forumPostsPath(configId, node.txid), t("forum.list.posts"), "forum-hint")
        : null,
    ),
  );
}

/**
 * 路由路径。
 *
 * 第一段永远是本地 `configId`：`/forum/:configId/...` 的 `getConfig` 会按它查配置。
 * 交易 txid 只出现在后续的 `:txid` / `:boardTxid` 位置。
 */
/** 板块列表（论坛首页下的第一层）。 */
export function forumBoardsPath(configId: string): string {
  return `/forum/${encodeURIComponent(configId)}`;
}

export function forumPostsPath(configId: string, boardTxid: string): string {
  return `/forum/${encodeURIComponent(configId)}/board/${boardTxid}`;
}

export function forumPostPath(configId: string, txid: string): string {
  return `/forum/${encodeURIComponent(configId)}/post/${txid}`;
}

export function forumPublishPath(configId: string, txid: string): string {
  return `/forum/${encodeURIComponent(configId)}/publish/${txid}`;
}

function ForumNodeHeader(props: { readonly node: ForumNodeView }): ReactNode {
  const { t } = usePluginI18n();
  const { node } = props;
  return createElement(
    "header",
    { className: "forum-node-header" },
    createElement("code", { className: "forum-txid" }, node.txid),
    node.replyMasterSeedHash === null ? null : createElement("code", { className: "forum-seed-hash" }, node.replyMasterSeedHash),
    createElement(
      "ul",
      { className: "forum-prices" },
      // 三种价格含义不同，必须分别展示。
      createElement("li", null, `${t("forum.node.initialPrice")}: ${node.tipPrice} sat`),
      createElement("li", null, `${t("forum.node.confirmedPrice")}: ${node.confirmedTipPrice} sat`),
      createElement("li", null, `${t("forum.node.effectivePrice")}: ${node.effectiveTipPrice} sat`),
    ),
    createElement("p", { className: "forum-chain-status" }, `${t("forum.node.status")}: ${node.status}${node.blockHeight === null ? "" : ` @${node.blockHeight}`}`),
  );
}

/** 图片 MIME 白名单：只有这些类型才内联渲染，其余一律走下载出口。 */
const INLINE_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);

/**
 * MIME 规范化后判断是否可以内联渲染。
 *
 * 去掉参数（`image/png; charset=binary`）、去空白、转小写后查白名单：元数据里
 * 带的参数不应让一张正常 PNG 掉进下载分支。
 */
export function isInlineImageMime(mediaType: string | undefined): boolean {
  return INLINE_IMAGE_TYPES.has(normalizeMime(mediaType));
}

/** 取 `type/subtype`，去掉参数并规范大小写。 */
function normalizeMime(mediaType: string | undefined): string {
  return (mediaType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/** 导出供渲染测试：附件是否真的内联展示需要断言 DOM 结果。 */
export function ForumReadingBody(props: {
  readonly view: ForumReadingView;
  onOpenAttachment?(seedHashHex: string): void;
  /** 读取已验证附件字节；缺席时附件只显示状态，没有图片与下载出口。 */
  loadAttachment?(seedHashHex: string): Promise<ForumAttachmentContent | undefined>;
}): ReactNode {
  const { t } = usePluginI18n();
  const { view } = props;
  if (view.markdown === undefined) {
    // 正文不可达或校验失败时，节点与回复结构仍然展示。
    return createElement(
      "div",
      { className: "forum-content-unavailable" },
      createElement("p", { className: "forum-status" }, t(`forum.read.${contentStateKey(view.content.state)}`)),
      view.content.failureCode === undefined ? null : createElement("p", { className: "forum-hint" }, view.content.failureCode),
      view.oversize === undefined
        ? null
        : createElement("p", { className: "forum-hint" }, `${t("forum.read.oversize")} (${view.oversize.bytes} / ${view.oversize.limitBytes})`),
    );
  }
  return createElement(
    "div",
    { className: "forum-content" },
    view.offline ? createElement("p", { className: "forum-hint" }, t("forum.read.offline")) : null,
    createElement(ForumMarkdownNodes, { nodes: renderForumMarkdown(view.markdown) }),
    view.attachments.length === 0
      ? null
      : createElement(
          "ul",
          { className: "forum-attachments" },
          // 附件失败不阻塞正文：每个附件独立显示自己的状态。
          view.attachments.map((attachment) =>
            createElement(
              ForumAttachmentItem,
              {
                key: attachment.seedHashHex,
                state: attachment.state,
                seedHashHex: attachment.seedHashHex,
                loadAttachment: props.loadAttachment,
                onRetry: props.onOpenAttachment,
              },
            ),
          ),
        ),
  );
}

/**
 * 一个附件：状态 + 真实内容出口。
 *
 * 只有真的读到字节才给图片或下载按钮；读到之前就显示「未获取」。这是把
 * 「获取状态」升级成「实际可读」的落点，也是 F05 未完成部分的边界。
 */
function ForumAttachmentItem(props: {
  readonly state: ForumContentState;
  readonly seedHashHex: string;
  readonly loadAttachment?: (seedHashHex: string) => Promise<ForumAttachmentContent | undefined>;
  readonly onRetry?: (seedHashHex: string) => void;
}): ReactNode {
  const { t } = usePluginI18n();
  const [content, setContent] = useState<ForumAttachmentContent | undefined>();
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    if (props.loadAttachment === undefined) return;
    setBusy(true);
    try {
      setContent(await props.loadAttachment(props.seedHashHex));
    } catch {
      setContent(undefined);
    } finally {
      setBusy(false);
    }
  }, [props]);

  // 已验证的附件自动读一次：状态是 verified 就该能看见，而不是让用户再点一次。
  useEffect(() => {
    if (props.state !== "verified" || props.loadAttachment === undefined) return;
    void load();
  }, [props.state, props.loadAttachment, load]);

  // 直接查白名单。`mime === "image/"` 这种比较永远为假，会让所有正常图片都掉进
  // 下载分支——「内联展示」形同虚设。
  const inlineImage = content !== undefined && isInlineImageMime(content.mediaType);

  return createElement(
    "li",
    { className: "forum-attachment" },
    createElement("code", null, props.seedHashHex),
    createElement("span", { className: "forum-status" }, t(`forum.read.${contentStateKey(props.state)}`)),
    inlineImage
      ? createElement("img", { className: "forum-attachment-image", src: attachmentObjectUrl(content), alt: content?.fileName ?? props.seedHashHex })
      : content === undefined
        ? null
        // 非图片或不在白名单内的类型：只给下载出口，不内联渲染。
        : createElement("a", { className: "forum-link", href: attachmentObjectUrl(content), download: content?.fileName ?? undefined }, t("forum.read.download")),
    props.onRetry === undefined || props.state === "verified"
      ? null
      : createElement("button", { type: "button", disabled: busy, onClick: () => void load() }, t("forum.read.open")),
  );
}

/**
 * 把附件字节变成对象 URL。
 *
 * 只对已验证的字节生成；`URL.revokeObjectURL` 由组件卸载时回收，避免长期阅读
 * 同一页面时把每个附件的副本留在内存里。
 */
function attachmentObjectUrl(content: ForumAttachmentContent): string {
  const mime = normalizeMime(content.mediaType) || "application/octet-stream";
  const byteLength = content.bytes.byteLength;
  const key = `${content.seedHashHex}|${mime}|${byteLength}`;
  const holder = objectUrlCache.get(key);
  if (holder !== undefined) return holder.url;
  // 复制到一个自有 ArrayBuffer：Blob 只接受 ArrayBuffer-backed 的视图，而跨
  // Runtime 传过来的 Uint8Array 可能是 SharedArrayBuffer 视图。
  const buffer = new ArrayBuffer(byteLength);
  new Uint8Array(buffer).set(content.bytes);
  const url = URL.createObjectURL(new Blob([buffer], { type: mime }));
  cacheObjectUrl(content.seedHashHex, mime, byteLength, url);
  return url;
}

/**
 * 对象 URL 缓存。
 *
 * 键包含字节数与 MIME：同一个 hash 在不同会话里可能被重新编码或换来源，
 * 命中旧的 URL 会让界面显示上一份内容——那是「读到字节」之外的第二份真值。
 * 容量有界，超出时回收最早的条目，离开页面不会把这些副本留在内存里。
 */
const objectUrlCache = new Map<string, { url: string }>();
const OBJECT_URL_CACHE_LIMIT = 32;

function cacheObjectUrl(seedHashHex: string, mime: string, byteLength: number, url: string): void {
  const key = `${seedHashHex}|${mime}|${byteLength}`;
  while (objectUrlCache.size >= OBJECT_URL_CACHE_LIMIT) {
    const oldest = objectUrlCache.keys().next();
    if (oldest.done === true) break;
    const stale = objectUrlCache.get(oldest.value);
    if (stale !== undefined) URL.revokeObjectURL(stale.url);
    objectUrlCache.delete(oldest.value);
  }
  objectUrlCache.set(key, { url });
}

function contentStateKey(state: ForumReadingView["content"]["state"]): string {
  switch (state) {
    case "fetching":
      return "fetching";
    case "not-fetched":
      return "notFetched";
    case "unreachable":
      return "unreachable";
    case "partial":
      return "fetching";
    default:
      return "verificationFailed";
  }
}

function ForumMarkdownNodes(props: { readonly nodes: readonly ForumRenderNode[] }): ReactNode {
  const children = props.nodes.map((node, index) => renderNode(node, index));
  return createElement("div", { className: "forum-markdown" }, children);
}

function renderNode(node: ForumRenderNode, key: number): ReactNode {
  switch (node.kind) {
    case "heading": {
      const level = Math.min(6, Math.max(1, node.level ?? 1));
      return createElement(`h${level}`, { key }, node.text);
    }
    case "paragraph":
      return createElement("p", { key }, node.text);
    case "code":
      // 代码围栏内容原样输出，不解析其中的 Markdown。
      return createElement("pre", { key }, createElement("code", null, node.text));
    case "quote":
      return createElement("blockquote", { key }, node.text);
    case "list":
      return node.ordered === true
        ? createElement("ol", { key }, (node.items ?? []).map((item, index) => renderNode(item, index)))
        : createElement("ul", { key }, (node.items ?? []).map((item, index) => renderNode(item, index)));
    case "image":
      // 远程图片不自动请求；只给出 alt 与显式入口。
      return createElement(
        "span",
        { key, className: "forum-image-placeholder" },
        node.text === undefined || node.text === "" ? "🖼" : node.text,
        node.reference === undefined ? null : createElement("code", { className: "forum-hint" }, ` ${node.reference}`),
      );
    case "attachment":
      return createElement("span", { key, className: "forum-attachment" }, createElement("code", null, node.reference ?? node.seedHashHex));
    default:
      return node.href === undefined
        ? createElement("span", { key }, node.text)
        : // 外链由用户打开，不在应用内导航。
          createElement("a", { key, href: node.href, target: "_blank", rel: "noreferrer noopener" }, node.text);
  }
}

export function ForumPublishPage(props: { readonly configId: string; readonly targetTxid: string }): ReactNode {
  const { t } = usePluginI18n();
  const { forum } = useForum();
  const [kind, setKind] = useState<"reply" | "changetip">("reply");
  const [markdown, setMarkdown] = useState("");
  const [tipPrice, setTipPrice] = useState("0");
  const [task, setTask] = useState<ForumPublishTask | undefined>();
  const [budget, setBudget] = useState<ForumPublishTask["budget"]>();
  const [publication, setPublication] = useState<ForumPublicationReachability | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const step = useCallback(
    async (action: () => Promise<ForumPublishTask>) => {
      setBusy(true);
      setError(undefined);
      try {
        const next = await action();
        setTask(next);
      } catch (cause) {
        setError(describeError(cause));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  return createElement(
    "section",
    { className: "forum-publish" },
    createElement(
      "label",
      null,
      t("forum.publish.kind"),
      // kind 是显式选择的：回复会冻结正文，改价不会。
      createElement(
        "select",
        { value: kind, onChange: (event: { target: { value: string } }) => { setKind(event.target.value === "changetip" ? "changetip" : "reply"); setTask(undefined); } },
        createElement("option", { value: "reply" }, t("forum.reply.title")),
        createElement("option", { value: "changetip" }, t("forum.changetip.title")),
      ),
    ),
    createElement("h2", null, kind === "reply" ? t("forum.reply.title") : t("forum.changetip.title")),
    createElement(
      "label",
      null,
      t("forum.reply.tipPrice"),
      createElement("input", {
        value: tipPrice,
        inputMode: "numeric",
        onChange: (event: { target: { value: string } }) => setTipPrice(event.target.value),
      }),
    ),
    kind === "reply"
      ? createElement("textarea", {
          value: markdown,
          rows: 10,
          onChange: (event: { target: { value: string } }) => setMarkdown(event.target.value),
        })
      : null,
    createElement(
      "button",
      {
        type: "button",
        disabled: busy || forumAmountToBigInt(tipPrice) === undefined,
        onClick: () =>
          void step(async () => {
            // 先记录发布可达性：链上发布不依赖渠道，但「读者能不能取到」必须被记录，
            // 否则界面只能显示「已发布」而读者实际取不到。
            if (kind === "reply") {
              const prepared = await forum.preparePublishContent(props.configId, markdown);
              setPublication(prepared.publication);
            } else {
              setPublication(undefined);
            }
            const prepared = await forum.preparePublish({
              configId: props.configId,
              kind,
              targetTxid: props.targetTxid,
              tipPrice,
              ...(kind === "reply" ? { markdown } : {}),
            });
            return forum.quotePublish(prepared.taskId);
          }),
      },
      kind === "reply" ? t("forum.reply.submit") : t("forum.changetip.submit"),
    ),
    task === undefined
      ? null
      : createElement(
          "div",
          { className: "forum-task" },
          createElement("p", null, `phase: ${task.phase}`),
          createElement("p", null, `${t("forum.publish.broadcast")}: ${task.broadcastState}`),
          createElement("p", null, `${t("forum.publish.chain")}: ${task.chainObservation.state}`),
          createElement(
            "p",
            null,
            `${t("forum.publish.index")}: ${task.indexObservation.state}${
              task.indexObservation.eventAcceptanceQueryable ? "" : ` · ${t("forum.publish.changetipLimitation")}`
            }`,
          ),
          task.txid === undefined ? null : createElement("code", { className: "forum-txid" }, task.txid),
          // 可达性与广播/链上/索引是**第四套**状态：正文已上链不等于读者取得到。
          // 渠道缺失时明确提示，而不是让「已发布」掩盖它。
          publication === undefined
            ? null
            : createElement(
                "p",
                { className: publication.reachable ? "forum-publication" : "forum-status forum-status-error" },
                `${t("forum.publish.reachability")}: ${publication.reachable ? t("forum.publish.reachable") : t("forum.publish.unreachable")} · ${publication.detail}`,
              ),
          budget === undefined
            ? null
            : createElement(
                "ul",
                { className: "forum-fees" },
                budget.items.map((item) => createElement("li", { key: item.label }, `${item.label}: ${item.amountSatoshis} sat — ${item.detail}`)),
                createElement("li", { key: "total" }, `${t("forum.publish.total")}: ${budget.totalSatoshis} sat`),
              ),
          createElement("button", { type: "button", disabled: busy, onClick: () => void step(async () => {
            const confirmed = await forum.confirmBudget(task.taskId);
            setBudget(confirmed);
            return task;
          }) }, t("forum.publish.confirm")),
          createElement("button", { type: "button", disabled: busy || budget === undefined, onClick: () => void step(() => forum.buildAndSubmit(task.taskId)) }, t("forum.publish.submit")),
        ),
    error === undefined ? null : createElement("p", { className: "forum-status forum-status-error" }, error),
  );
}

/** 按稳定 code 展示服务端业务错误，不解析英文 message 作为控制流。 */
function describeError(error: unknown): string {
  if (error instanceof ForumBusinessError) return `${error.code}: ${error.message}`;
  if (error instanceof Error && "code" in error && typeof (error as { code?: unknown }).code === "string") {
    return `${String((error as { code: string }).code)}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function createForumShell(title: string, subtitle: string, error: string | undefined, ...children: ReactNode[]): ReactNode {
  return createElement(
    "div",
    { className: "forum-page" },
    createElement("header", { className: "forum-page-header" },
      createElement("h1", null, title),
      createElement("p", { className: "forum-hint" }, subtitle),
    ),
    error === undefined ? null : createElement("p", { className: "forum-status forum-status-error" }, error),
    ...children,
  );
}
