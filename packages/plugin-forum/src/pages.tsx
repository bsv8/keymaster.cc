// Forum 页面。
//
// 三条展示纪律直接体现在组件里：
//   - 三种回复价格分别展示，不合并成一个「价格」；
//   - 正文状态与索引失败分别显示，正文不可达时节点和回复结构照常渲染；
//   - 广播、链上、索引三套状态分开显示，查无节点时展示「等待发现」而不是
//     编造一个拒绝原因。

import { createElement, useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  FORUM_PAGE_SIZE_DEFAULT,
  FORUM_PAGE_SIZE_MAX,
  forumAmountToBigInt,
  type ForumConfig,
  type ForumListOperation,
  type ForumNodeView,
  type ForumPublishTask,
  type ForumReadingView,
  type ForumRootVerification,
} from "@keymaster/contracts";

import { createForumListBinding, forumListLoader, useForumListBinding, useForumListSnapshot } from "./forumListBinding.js";
import { ForumBusinessError } from "./domain/indexClient.js";
import { renderForumMarkdown, type ForumRenderNode } from "./markdown/markdown.js";
import { useForum } from "./ForumResourceContext.js";

export function ForumHomePage(): ReactNode {
  const { t } = useTranslation("forum");
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
    configs.map((config) => createElement(ForumConfigCard, { key: config.id, config, root: roots.get(config.id) })),
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
  const { t } = useTranslation("forum");
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

function ForumConfigCard(props: { readonly config: ForumConfig; readonly root: ForumRootVerification | undefined }): ReactNode {
  const { t } = useTranslation("forum");
  const { forum } = useForum();
  const [status, setStatus] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const verify = useCallback(async () => {
    setBusy(true);
    setStatus(undefined);
    try {
      await forum.verifyRoot(props.config.id);
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
  const { t } = useTranslation("forum");
  const { forum } = useForum();
  const [view, setView] = useState<ForumReadingView | undefined>();
  const [node, setNode] = useState<ForumNodeView | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [reading, setReading] = useState(false);

  // 先读节点：正文 hash、作者与三种价格都来自它。
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
    view === undefined ? null : createElement(ForumReadingBody, { view, onOpenAttachment: (hash) => void openAttachment(hash) }),
    node === undefined
      ? null
      : createElement(ForumReplyTree, { configId: props.configId, parentTxid: node.txid }),
    node === undefined || node.parentTxid === null
      ? null
      : createElement(
          "nav",
          { className: "forum-post-actions" },
          createElement("a", { className: "forum-link", href: forumPublishPath(node.parentTxid, node.txid) }, t("forum.reply.title")),
          createElement("a", { className: "forum-link", href: forumPublishPath(node.parentTxid, node.txid) }, t("forum.changetip.title")),
        ),
  );
}

/**
 * 回复树：按需展开。
 *
 * 只有用户点开时才请求，因此默认不会为整棵树触发正文获取；服务端顺序原样保留。
 */
function ForumReplyTree(props: { readonly configId: string; readonly parentTxid: string }): ReactNode {
  const { t } = useTranslation("forum");
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
            forumTxid: props.configId,
          },
          loader: forumListLoader(forum, props.configId, "list_replies", props.configId, props.parentTxid, FORUM_PAGE_SIZE_DEFAULT),
        }),
      [forum, props.configId, props.parentTxid],
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
    createElement("ul", { className: "forum-node-list" }, items.map((item) => createElement(ForumNodeRow, { key: item.txid, node: item }))),
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
  const { t } = useTranslation("forum");
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
    items.length === 0 && view.status !== "loading" ? createElement("p", { className: "forum-empty" }, "…") : null,
    // 严格保留服务端顺序：这里不做任何本地重排。
    createElement("ul", { className: "forum-node-list" }, items.map((item) => createElement(ForumNodeRow, { key: item.txid, node: item }))),
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
      : createElement("p", { className: "forum-status forum-status-error" }, t(`forum.error.${view.errorCode}`, view.errorCode)),
  );
}


function ForumNodeRow(props: { readonly node: ForumNodeView }): ReactNode {
  const { t } = useTranslation("forum");
  const { node } = props;
  return createElement(
    "li",
    { className: "forum-node-row" },
    createElement(ForumNodeHeader, { node }),
    createElement(
      "div",
      { className: "forum-node-actions" },
      // 进入节点：读正文、展开回复、发布回复或改价。
      createElement("a", { className: "forum-link", href: forumNodePath(node.parentTxid, node.txid) }, t("forum.read.open")),
      node.parentTxid === null
        ? null
        : createElement("a", { className: "forum-link", href: forumPublishPath(node.parentTxid, node.txid) }, t("forum.reply.title")),
    ),
    node.hasChildren && node.parentTxid !== null
      ? createElement("a", { className: "forum-hint", href: forumRepliesPath(node.parentTxid, node.txid) }, t("forum.list.replies"))
      : null,
  );
}

/**
 * 节点详情路径。
 *
 * 根节点没有父节点，用创世根 txid 作为它的父；非根节点用自己的 parent_txid。
 * 路径统一由这里生成，避免各处手写字符串导致某一处漏掉前缀。
 */
function forumNodePath(parentTxid: string | null, txid: string): string {
  return parentTxid === null ? `/forum/${txid}/post/${txid}` : `/forum/${parentTxid}/post/${txid}`;
}

function forumRepliesPath(parentTxid: string, txid: string): string {
  return `/forum/${parentTxid}/board/${txid}`;
}

function forumPublishPath(parentTxid: string, txid: string): string {
  return `/forum/${parentTxid}/publish/${txid}`;
}

function ForumNodeHeader(props: { readonly node: ForumNodeView }): ReactNode {
  const { t } = useTranslation("forum");
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

function ForumReadingBody(props: { readonly view: ForumReadingView; onOpenAttachment?(seedHashHex: string): void }): ReactNode {
  const { t } = useTranslation("forum");
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
              "li",
              { key: attachment.seedHashHex, className: "forum-attachment" },
              createElement("code", null, attachment.seedHashHex),
              createElement("span", { className: "forum-status" }, t(`forum.read.${contentStateKey(attachment.state)}`)),
              // 附件有独立的获取/重试入口；失败不阻塞正文。
              props.onOpenAttachment === undefined
                ? null
                : createElement("button", { type: "button", onClick: () => props.onOpenAttachment?.(attachment.seedHashHex) }, t("forum.read.open")),
            ),
          ),
        ),
  );
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
  const { t } = useTranslation("forum");
  const { forum } = useForum();
  const [kind, setKind] = useState<"reply" | "changetip">("reply");
  const [markdown, setMarkdown] = useState("");
  const [tipPrice, setTipPrice] = useState("0");
  const [task, setTask] = useState<ForumPublishTask | undefined>();
  const [budget, setBudget] = useState<ForumPublishTask["budget"]>();
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