// 浏览页的「预览」面板：按 Worker 判定的 format 呈现内容。
//
// 这个组件只做展示。它不解析钱包数据，也没有任何写操作：格式判定、UTF-8 校验、
// K-V 解码和 1 MiB 截断都已经在 Worker 完成，这里拿到的 format 是可信结论。
// 唯一在这里发生的解析是「怎么把已知是 JSON / Markdown 的文本画出来」。
import { useMemo, useState } from "react";
import type { StorageBrowsePreview } from "@keymaster/contracts";
import { Button } from "@keymaster/ui";
import {
  buildJsonTree,
  jsonChildrenOf,
  jsonHiddenChildren,
  jsonTypeLabel,
  JSON_DEFAULT_EXPAND_DEPTH,
  JSON_MAX_CHILDREN,
  type BrowseJsonNode,
} from "./storageBrowseJson.js";
import { parseSafeMarkdown, type SafeMarkdownBlock, type SafeMarkdownInline } from "./storageBrowseMarkdown.js";
import { decodePreviewText } from "./storageBrowseText.js";

/** i18n 的最小形态：面板只需要 t(key, values)。 */
export type BrowseTranslate = (key: string, values?: Record<string, string | number>) => string;

export interface PreviewPaneProps {
  state: BrowsePreviewState | undefined;
  locale: string;
  translate: BrowseTranslate;
  wrapText: boolean;
  onToggleWrap: () => void;
  rawJson: boolean;
  onToggleRawJson: () => void;
  markdownSource: boolean;
  onToggleMarkdownSource: () => void;
  kvRaw: boolean;
  onToggleKvRaw: () => void;
  /** 失败状态下的重试入口；缺省时只显示说明。 */
  onRetry?: () => void;
}

/** 预览加载状态；path 用于让页面能区分「正在读」和「上一个文件的旧结果」。 */
export interface BrowsePreviewState {
  path: string;
  status: "loading" | "ready" | "error";
  preview?: StorageBrowsePreview;
  error?: string;
}

/** 渲染期的统一上下文：避免每个子组件都重复接收同一组开关。 */
interface PreviewContext {
  preview: StorageBrowsePreview;
  wrapText: boolean;
  rawJson: boolean;
  markdownSource: boolean;
  kvRaw: boolean;
  onToggleWrap: () => void;
  onToggleRawJson: () => void;
  onToggleMarkdownSource: () => void;
  onToggleKvRaw: () => void;
  translate: BrowseTranslate;
}

export function PreviewPane(props: PreviewPaneProps) {
  const { state, translate: t } = props;
  if (!state) {
    return <p className="storage-browse__hint">{t("storage.browse.noSelection", { defaultValue: "Select a file to preview it." })}</p>;
  }
  if (state.status === "loading") {
    return <p className="storage-browse__hint">{t("storage.browse.previewLoading", { defaultValue: "Loading preview…" })}</p>;
  }
  if (state.status === "error") {
    return (
      <div className="storage-browse__preview-error" role="alert">
        <p>{t("storage.browse.previewFailed", { defaultValue: "This file could not be read." })}</p>
        <pre className="storage-browse__raw">{state.error ?? ""}</pre>
        {/* 读失败不改变选中项，因此必须留一个重试入口：否则「暂时读不到」会变成
            「只能靠刷新整页」的死路。 */}
        {props.onRetry ? (
          <Button size="sm" variant="secondary" onClick={props.onRetry}>
            {t("storage.browse.retryPreview", { defaultValue: "Retry" })}
          </Button>
        ) : null}
      </div>
    );
  }
  const preview = state.preview;
  if (!preview) return null;
  return (
    <div className="storage-browse__preview">
      {preview.truncated ? (
        <p className="storage-browse__notice" role="status">
          {t("storage.browse.truncated", {
            defaultValue: "Showing the first {{shown}} of {{total}} bytes.",
            shown: String(preview.returnedSize),
            total: String(preview.totalSize),
          })}
        </p>
      ) : null}
      <PreviewBody
        preview={preview}
        wrapText={props.wrapText}
        rawJson={props.rawJson}
        markdownSource={props.markdownSource}
        kvRaw={props.kvRaw}
        onToggleWrap={props.onToggleWrap}
        onToggleRawJson={props.onToggleRawJson}
        onToggleMarkdownSource={props.onToggleMarkdownSource}
        onToggleKvRaw={props.onToggleKvRaw}
        translate={props.translate}
      />
    </div>
  );
}

function PreviewBody(props: PreviewContext) {
  const { preview, translate: t } = props;
  switch (preview.format) {
    case "empty":
      return <p className="storage-browse__hint">{t("storage.browse.emptyFile", { defaultValue: "Empty file" })}</p>;
    case "binary":
      return (
        <p className="storage-browse__hint">
          {t("storage.browse.unsupportedFormat", { defaultValue: "This format cannot be previewed." })}
        </p>
      );
    case "truncated":
      // 截断内容一律只给原文：半个 JSON、半个信封或半个 Markdown 都不是它自己。
      return <RawText bytes={preview.bytes} wrap={props.wrapText} />;
    case "json-broken":
      return (
        <>
          <p className="storage-browse__notice" role="status">
            {t("storage.browse.jsonBroken", { defaultValue: "This file is not valid JSON; showing the original text." })}
          </p>
          <RawText bytes={preview.bytes} wrap={props.wrapText} />
        </>
      );
    case "json":
      return <JsonBody {...props} text={decodeStrictText(preview.bytes, t)} />;
    case "markdown":
      return <MarkdownBody {...props} text={decodeStrictText(preview.bytes, t)} />;
    case "text":
      return (
        <>
          <SourceToggle
            active={props.wrapText}
            onToggle={props.onToggleWrap}
            label={t("storage.browse.toggleWrap", { defaultValue: "Wrap lines" })}
          />
          <RawText bytes={preview.bytes} wrap={props.wrapText} />
        </>
      );
    case "kv-value":
      return <KvBody {...props} />;
    case "kv-invalid":
      return <KvInvalidBody {...props} />;
    default:
      return <p className="storage-browse__hint">{t("storage.browse.unsupportedFormat", { defaultValue: "This format cannot be previewed." })}</p>;
  }
}

/** 严格解码；Worker 已判定为文本，失败说明是编码损坏。 */
function decodeStrictText(bytes: Uint8Array, t: BrowseTranslate): string {
  const decoded = decodePreviewText(bytes, false);
  if (decoded.ok) return decoded.text;
  return t("storage.browse.encodingUnsupported", { defaultValue: "This text uses an unsupported encoding." });
}

function SourceToggle(props: { active: boolean; onToggle: () => void; label: string }) {
  return (
    <Button size="sm" variant="ghost" onClick={props.onToggle} aria-pressed={props.active} className="storage-browse__toggle">
      {props.label}
    </Button>
  );
}

/** 原文视图；等宽字体保留换行，自动换行可切换。 */
function RawText(props: { bytes: Uint8Array; wrap: boolean }) {
  const decoded = decodePreviewText(props.bytes, true);
  if (!decoded.ok) return <p className="storage-browse__hint">—</p>;
  return (
    <pre className={"storage-browse__raw" + (props.wrap ? " storage-browse__raw--wrap" : "")}>
      {decoded.text}
    </pre>
  );
}

function JsonBody(props: PreviewContext & { text: string }) {
  const { translate: t } = props;
  // 两个 memo 都在任何提前返回之前求值：条件 hook 会在 rawJson 切换时抛
  // “Rendered fewer hooks than expected”，把一次切换变成整块面板崩溃。
  const parsed = useMemo(() => {
    try {
      return { ok: true as const, value: JSON.parse(props.text) as unknown };
    } catch {
      return { ok: false as const };
    }
  }, [props.text]);
  // 建树失败（极端数据）时回退只读原文：完整内容因此永远有入口，不会出现空白面板。
  const tree = useMemo(() => {
    if (!parsed.ok) return undefined;
    try {
      return buildJsonTree(parsed.value);
    } catch {
      return undefined;
    }
  }, [parsed]);
  // 原文切换是树视图与原文视图共用的工具栏，放在分支之外：放在原文分支里会让
  // 「切到原文」成为单向操作，用户再也回不到树。
  const toolbar = (
    <div className="storage-browse__json-actions">
      <Button size="sm" variant="ghost" onClick={props.onToggleRawJson} aria-pressed={props.rawJson}>
        {t("storage.browse.json.source", { defaultValue: "Original text" })}
      </Button>
    </div>
  );
  // Worker 已判定为完整 JSON；这里解析失败说明判定与实际内容不一致，退回原文而不是
  // 假装它是一个空对象。
  if (!parsed.ok) return <div className="storage-browse__json">{toolbar}<RawText bytes={props.preview.bytes} wrap={props.wrapText} /></div>;
  // 原文视图显示文件本来的文本：重新 stringify 会改变内容，深文档还会栈溢出。
  if (props.rawJson || !tree) return <div className="storage-browse__json">{toolbar}<JsonSource text={props.text} wrap={props.wrapText} /></div>;
  return (
    <div className="storage-browse__json">
      {toolbar}
      {/* 容器（含空容器）与标量必须分开：`{}` 与 `[]` 都不是标量，把它们交给标量视图
          会显示成 “null”。空容器走 JsonTreeView 的叶子分支，会如实显示 “object · 0”。 */}
      {tree.value !== undefined || tree.expandable
        ? <JsonTreeView node={tree} depth={0} translate={props.translate} />
        : <JsonScalarRoot node={tree} translate={props.translate} />}
    </div>
  );
}

/**
 * 顶层标量的呈现。
 *
 * 标量没有可折叠的成员，只显示「类型 + 值」；不出现空标签、空计数或箭头。
 */
function JsonScalarRoot(props: { node: BrowseJsonNode; translate: BrowseTranslate }) {
  return (
    <p className="storage-browse__json-leaf">
      <span className="storage-browse__json-summary">
        {props.translate("storage.browse.jsonScalar", { defaultValue: "{{type}}", type: jsonScalarTypeLabel(props.node.scalar) })}
      </span>
      <span className="storage-browse__json-scalar">{props.node.scalar}</span>
    </p>
  );
}

function jsonScalarTypeLabel(scalar: string | undefined): string {
  if (scalar === undefined || scalar === "null") return "null";
  if (scalar === "true" || scalar === "false") return "boolean";
  if (scalar === "undefined") return "undefined";
  return scalar.startsWith("\"") ? "string" : "number";
}

/**
 * JSON 树的有界渲染。
 *
 * 子节点不是预生成的：只有**展开**的容器才调用 `jsonChildrenOf` 生成下一层（一次
 * 一层，深度恒为 1），宽度按窗口给出，剩余成员由「更多成员」逐段生成。默认展开前
 * {@link JSON_DEFAULT_EXPAND_DEPTH} 层，更深的节点必须用户点开。
 *
 * 因此 DOM 规模只与用户实际展开的范围相关：10,000 层的 JSON 首屏仍然只有两层，展开
 * 一次多一层，不会 RangeError，也不会把栈吃光。
 */
function JsonTreeView(props: { node: BrowseJsonNode; depth: number; translate: BrowseTranslate }) {
  // 标量没有成员，也就没有展开状态可言。节点的 expandable 由内容决定、不会中途改变，
  // 因此这里的提前返回不会破坏任何实例的 hook 顺序。
  if (!props.node.expandable) {
    // 空容器也要说明它是什么：只显示一个空值会让 `{}` 看起来像缺内容。
    const emptyContainer = props.node.value !== undefined;
    return (
      <div className="storage-browse__json-leaf" style={{ paddingLeft: props.depth * 12 }}>
        <span className="storage-browse__json-label">{props.node.label}</span>
        {emptyContainer ? (
          <span className="storage-browse__json-summary">
            {props.translate("storage.browse.jsonCount", {
              defaultValue: "{{type}} · {{count}}",
              type: jsonTypeLabel(props.node.value),
              count: "0",
            })}
          </span>
        ) : (
          <span className="storage-browse__json-scalar">{props.node.scalar}</span>
        )}
      </div>
    );
  }
  // 用户的显式选择覆盖按深度的默认展开状态。
  const [override, setOverride] = useState<Readonly<Record<string, boolean>>>({});
  const [windowSizes, setWindowSizes] = useState<Readonly<Record<string, number>>>({});
  const isExpanded = override[props.node.key] ?? props.depth < JSON_DEFAULT_EXPAND_DEPTH;
  const windowSize = windowSizes[props.node.key] ?? JSON_MAX_CHILDREN;
  const children = useMemo(
    () => (isExpanded ? jsonChildrenOf(props.node, windowSize) : []),
    [isExpanded, props.node, windowSize],
  );
  const hidden = jsonHiddenChildren(props.node, children.length);
  return (
    <div className="storage-browse__json-node">
      <button
        type="button"
        className="storage-browse__json-toggle"
        style={{ paddingLeft: props.depth * 12 }}
        aria-expanded={isExpanded}
        onClick={() => setOverride((current) => ({ ...current, [props.node.key]: !isExpanded }))}
      >
        <span className="storage-browse__json-caret" aria-hidden="true">{isExpanded ? "▾" : "▸"}</span>
        {props.node.label ? <span className="storage-browse__json-label">{props.node.label}</span> : null}
        <span className="storage-browse__json-summary">
          {props.translate("storage.browse.jsonCount", {
            defaultValue: "{{type}} · {{count}}",
            type: props.node.size === undefined ? "" : jsonTypeLabel({ length: props.node.size }),
            count: String(props.node.size ?? 0),
          })}
        </span>
      </button>
      {isExpanded ? (
        <>
          {children.map((child) => <JsonTreeView key={child.key} node={child} depth={props.depth + 1} translate={props.translate} />)}
          {hidden > 0 ? (
            <div className="storage-browse__json-more" style={{ paddingLeft: (props.depth + 1) * 12 }}>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setWindowSizes((current) => ({ ...current, [props.node.key]: windowSize + JSON_MAX_CHILDREN }))}
              >
                {props.translate("storage.browse.jsonMore", {
                  defaultValue: "Show more members ({{hidden}} remaining)",
                  hidden: String(hidden),
                })}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function MarkdownBody(props: PreviewContext & { text: string }) {
  const document = useMemo(() => parseSafeMarkdown(props.text), [props.text]);
  return (
    <div className="storage-browse__markdown">
      <div className="storage-browse__markdown-actions">
        <Button
          size="sm"
          variant="ghost"
          onClick={props.onToggleMarkdownSource}
          aria-pressed={props.markdownSource}
        >
          {props.markdownSource
            ? props.translate("storage.browse.md.render", { defaultValue: "Rendered" })
            : props.translate("storage.browse.md.source", { defaultValue: "Source" })}
        </Button>
      </div>
      {props.markdownSource
        ? <pre className="storage-browse__raw storage-browse__raw--wrap">{props.text}</pre>
        : (
          <article className="storage-browse__markdown-body">
            {document.truncated ? (
              <p className="storage-browse__notice">
                {props.translate("storage.browse.md.capped", { defaultValue: "This document was truncated for display." })}
              </p>
            ) : null}
            {document.blocks.map((block, index) => (
              <MarkdownBlockView key={index} block={block} translate={props.translate} />
            ))}
          </article>
        )}
    </div>
  );
}

function MarkdownBlockView(props: { block: SafeMarkdownBlock; translate: BrowseTranslate }) {
  const { block } = props;
  switch (block.kind) {
    case "heading": {
      const Tag = ("h" + Math.min(block.level + 2, 6)) as "h3" | "h4" | "h5" | "h6";
      return <Tag><MarkdownInlines inlines={block.inlines} translate={props.translate} /></Tag>;
    }
    case "paragraph":
      return <p><MarkdownInlines inlines={block.inlines} translate={props.translate} /></p>;
    case "quote":
      return <blockquote><MarkdownInlines inlines={block.inlines} translate={props.translate} /></blockquote>;
    case "code":
      return <pre className="storage-browse__raw"><code>{block.text}</code></pre>;
    case "rule":
      return <hr />;
    case "list": {
      const items = block.items.map((item, index) => (
        <li key={index}><MarkdownInlines inlines={item} translate={props.translate} /></li>
      ));
      return block.ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
    }
    default:
      return null;
  }
}

/**
 * 行内 token 渲染。
 *
 * 这里只用普通 React 元素：没有 dangerouslySetInnerHTML，因此 Markdown 里的
 * HTML、脚本和 iframe 只可能以文本形式出现。链接的 href 在解析阶段就过滤过
 * 协议；图片永远只渲染占位文本，不产生任何网络请求。
 */
function MarkdownInlines(props: { inlines: readonly SafeMarkdownInline[]; translate: BrowseTranslate }) {
  return (
    <>
      {props.inlines.map((inline, index) => {
        switch (inline.kind) {
          case "text":
            return <span key={index}>{inline.value}</span>;
          case "code":
            return <code key={index}>{inline.value}</code>;
          case "strong":
            return <strong key={index}>{inline.value}</strong>;
          case "emphasis":
            return <em key={index}>{inline.value}</em>;
          case "image":
            return (
              <span key={index} className="storage-browse__md-image" title={inline.rawTarget}>
                {props.translate("storage.browse.md.image", { defaultValue: "[image: {{target}}]", target: inline.rawTarget })}
              </span>
            );
          case "link":
            // 没有安全 href 时只显示文本，不做任何跳转。
            return inline.href === undefined
              ? <span key={index} className="storage-browse__md-link-plain" title={inline.rawTarget}>{inline.value}</span>
              : <MarkdownExternalLink key={index} href={inline.href} label={inline.value} />;
          default:
            return null;
        }
      })}
    </>
  );
}

/**
 * 可点击的外部链接。
 *
 * 这里刻意不用 `<a href>`：预览文档里的目标是数据，不是本应用的路由，交给
 * AppLink 会把不可信输入送进导航器。因此改成普通按钮，只在用户主动点击时
 * 调 `window.open`，并显式带上 `noopener`，让新窗口拿不到本页的 opener。
 */
function MarkdownExternalLink(props: { href: string; label: string }) {
  return (
    <button
      type="button"
      role="link"
      className="storage-browse__md-link"
      title={props.href}
      onClick={() => {
        try {
          window.open(props.href, "_blank", "noopener,noreferrer");
        } catch {
          // 弹窗被拦截或浏览器拒绝打开：链接就保持不可用，不改写文档内容。
        }
      }}
    >
      {props.label}
    </button>
  );
}

/** K-V value：解码内容与原始信封可切换。 */
function KvBody(props: PreviewContext) {
  const { preview, translate: t } = props;
  const payload = preview.kvPayload;
  return (
    <div className="storage-browse__kv">
      <div className="storage-browse__kv-actions">
        <Button size="sm" variant="ghost" onClick={props.onToggleKvRaw} aria-pressed={props.kvRaw}>
          {props.kvRaw
            ? t("storage.browse.kv.decoded", { defaultValue: "Decoded" })
            : t("storage.browse.kv.raw", { defaultValue: "Raw object" })}
        </Button>
      </div>
      {props.kvRaw ? (
        <RawText bytes={preview.bytes} wrap={props.wrapText} />
      ) : payload?.json === true ? (
        <>
          <dl className="storage-browse__props">
            <dt>{t("storage.browse.kv.valueId", { defaultValue: "Value id" })}</dt>
            <dd>{payload.valueId}</dd>
            <dt>{t("storage.browse.kv.partition", { defaultValue: "Partition" })}</dt>
            <dd>{payload.partition}</dd>
            <dt>{t("storage.browse.kv.payload", { defaultValue: "Payload" })}</dt>
            <dd>{payload.payloadFingerprint}</dd>
          </dl>
          <JsonSource text={payload.jsonText ?? ""} wrap={props.wrapText} />
        </>
      ) : <RawText bytes={preview.bytes} wrap={props.wrapText} />}
    </div>
  );
}

/** K-V 信封被拒：说明原因并保留原始对象，不退化成一份看似正常的业务 JSON。 */
function KvInvalidBody(props: PreviewContext) {
  const { preview, translate: t } = props;
  const reason = kvErrorText(preview.kvError, t);
  return (
    <div className="storage-browse__kv">
      <p className="storage-browse__notice" role="status">{reason}</p>
      <RawText bytes={preview.bytes} wrap={props.wrapText} />
    </div>
  );
}

function kvErrorText(code: StorageBrowsePreview["kvError"], t: BrowseTranslate): string {
  switch (code) {
    case "envelope-invalid":
      return t("storage.browse.kv.envelopeInvalid", { defaultValue: "The key-value envelope is malformed." });
    case "version-unsupported":
      return t("storage.browse.kv.versionUnsupported", { defaultValue: "This key-value version is not supported." });
    case "hash-mismatch":
      return t("storage.browse.kv.hashMismatch", { defaultValue: "The key-value payload hash does not match." });
    case "payload-unsupported":
      return t("storage.browse.kv.payloadUnsupported", { defaultValue: "The key-value payload is binary and cannot be previewed." });
    default:
      return t("storage.browse.kv.invalid", { defaultValue: "This key-value object could not be decoded." });
  }
}

/** 纯文本源码视图。 */
function JsonSource(props: { text: string; wrap: boolean }) {
  return (
    <pre className={"storage-browse__raw" + (props.wrap ? " storage-browse__raw--wrap" : "")}>
      {props.text}
    </pre>
  );
}
