import { Children, isValidElement, memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowDown, ArrowRight, Check, ChevronRight, Copy, Cpu, Lightbulb, LoaderCircle, Plus, Search, Square, Wrench, X } from "lucide-react";
import { router } from "@keymaster/runtime";
import type { AiRuntime } from "./runtime.js";
import { listModels } from "./providers.js";
import type { Conversation, Message, Model } from "./types.js";

function useAi(runtime: AiRuntime) { useSyncExternalStore(runtime.subscribe, runtime.snapshot, runtime.snapshot); }
function run(runtime: AiRuntime, operation: Promise<unknown>) { void operation.catch(error => runtime.report(error)); }
function time(at?: number) {
  if (at === undefined || !Number.isFinite(new Date(at).getTime())) return null;
  return <time dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()}>{new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}</time>;
}
function CopyButton({ value, label = "复制", onError }: { value: string; label?: string; onError(error: unknown): void }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  return <button type="button" className="ai-copy" aria-label={copied ? "已复制" : label} title={copied ? "已复制" : label} onClick={() => {
    void (async () => {
      if (!navigator.clipboard) throw new Error("浏览器不支持剪贴板，请手动选择并复制");
      await navigator.clipboard.writeText(value); setCopied(true); clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 1800);
    })().catch(onError);
  }}>{copied ? <Check size={12}/> : <Copy size={12}/>}<span>{copied ? "已复制" : label}</span></button>;
}
function Markdown({ text, runtime }: { text: string; runtime: AiRuntime }) {
  return <div className="ai-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{children}</a> : <span>{children}</span>,
    // Model output must not silently load third-party images/tracking URLs.
    img: ({ alt }) => <span className="ai-image-description">[图片{alt ? `：${alt}` : ""}]</span>,
    table: ({ children }) => <div className="ai-table-wrap"><table>{children}</table></div>,
    pre: ({ children }) => {
      const code = Children.toArray(children).find(isValidElement) as ReactElement<{ children?: ReactNode; className?: string }> | undefined;
      const value = String(code?.props.children ?? "").replace(/\n$/, "");
      const language = code?.props.className?.replace(/^language-/, "") ?? "代码";
      return <div className="ai-code-block"><header><span>{language}</span><CopyButton value={value} onError={error => runtime.report(error)}/></header><pre>{children}</pre></div>;
    },
  }}>{text}</ReactMarkdown></div>;
}
interface Turn { id: string; user?: Message; items: Message[] }
function turns(messages: Message[]): Turn[] {
  const result: Turn[] = [];
  for (const message of messages) {
    if (message.role === "user" || !result.length) result.push({ id: message.id, ...(message.role === "user" ? { user: message } : {}), items: [] });
    if (message.role !== "user") result[result.length - 1]!.items.push(message);
  }
  return result;
}
function TurnUsage({ items }: { items: Message[] }) {
  const assistants = items.filter(item => item.role === "assistant");
  const parts: string[] = [];
  for (const [key, label] of [["inputTokens", "in"], ["outputTokens", "out"], ["cacheReadTokens", "cache R"], ["cacheWriteTokens", "cache W"], ["costUsd", "USD"]] as const) {
    // Aggregate only when every response reports this field. Unknown is not zero.
    if (!assistants.length || !assistants.every(item => item.usage?.[key] !== undefined)) continue;
    const value = assistants.reduce((sum, item) => sum + item.usage![key]!, 0);
    parts.push(key === "costUsd" ? `$${value.toLocaleString("en-US", { maximumFractionDigits: 6 })}` : `${value.toLocaleString("en-US")} ${label}`);
  }
  return parts.length ? <span className="ai-usage">{parts.join(" · ")}</span> : null;
}
function ResultShow({ item, calls, runtime, conversationId }: { item: Message; calls: NonNullable<Message["calls"]>; runtime: AiRuntime; conversationId: string }) {
  const call = calls.find(call => call.id === item.callId);
  const output = JSON.parse(item.content);
  if (output?.status !== "shown" || !call) return <div className="ai-result-status" role="status">result_show · {output?.error ?? "结果不可用"}</div>;
  // The call arguments are the immutable snapshot, not the artifact's latest revision.
  const args = JSON.parse(call.arguments);
  return <button type="button" className="ai-result-reshow" onClick={() => {
    try { runtime.openArtifact(conversationId, { id: output.tabId, title: args.title, html: args.html }); }
    catch (error) { runtime.report(error); }
  }}><Wrench size={12}/><span>重新展示 · {args.title}</span></button>;
}
function Process({ items, durationMs, runtime, defaultExpanded = false }: { items: Message[]; durationMs?: number; runtime: AiRuntime; defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const calls = items.flatMap(item => item.calls ?? []);
  const answered = new Set(items.filter(item => item.role === "tool").map(item => item.callId));
  const messages = items.filter(item => item.role === "assistant").length;
  const summary = [messages ? `${messages} 条消息` : null, calls.length ? `${calls.length} 次工具调用` : null, durationMs !== undefined ? `耗时 ${durationMs < 1000 ? `${Math.round(durationMs)}ms` : `${(durationMs / 1000).toFixed(1).replace(/\.0$/, "")}s`}` : null].filter(Boolean).join(" · ");
  return <details className="ai-process" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}><summary aria-label={`过程详情 · ${summary}`}><ChevronRight size={12}/><span>{summary || `${items.length} 条过程记录`}</span></summary><div className="ai-process-body">
    {items.map(item => item.role === "tool" && item.name === "result_show" ? null : item.role === "tool" ? <details className="ai-tool-result" key={item.id}><summary><ChevronRight size={12}/><Wrench size={12}/><span>{item.name}</span></summary><div>{calls.find(call => call.id === item.callId) && <><small>参数</small><pre>{calls.find(call => call.id === item.callId)!.arguments}</pre></>}<small>结果</small><pre>{item.content}</pre></div></details> : item.content ? <div className="ai-process-message" key={item.id}><small>{item.model ?? "AI"}</small><Markdown text={item.content} runtime={runtime}/></div> : null)}
    {calls.filter(call => !answered.has(call.id)).map(call => call.name === "result_show" ? <div className="ai-result-status" role="status" key={call.id}>result_show · 等待结果</div> : <details className="ai-tool-result" key={call.id}><summary><ChevronRight size={12}/><Wrench size={12}/><span>{call.name} · 等待结果</span></summary><pre>{call.arguments}</pre></details>)}
  </div></details>;
}
const MessageTurn = memo(function MessageTurn({ turn, runtime, running, conversationId }: { turn: Turn; runtime: AiRuntime; running: boolean; conversationId: string }) {
  const last = turn.items[turn.items.length - 1];
  const answer = last?.role === "assistant" && !last.calls?.length ? last : undefined;
  const process = turn.items.filter(item => item !== answer);
  const calls = turn.items.flatMap(item => item.calls ?? []);
  const results = turn.items.filter(item => item.role === "tool" && item.name === "result_show");
  return <section className="ai-turn">
    {turn.user && <div className="ai-user-message"><div className="ai-user-bubble">{turn.user.content}</div><div className="ai-user-actions"><CopyButton value={turn.user.content} onError={error => runtime.report(error)}/>{time(turn.user.createdAt)}</div></div>}
    {process.length > 0 && <Process key={answer ? "answered" : "unanswered"} items={process} durationMs={answer?.durationMs} runtime={runtime} defaultExpanded={!answer}/>}
    {results.map(item => <ResultShow key={item.id} item={item} calls={calls} runtime={runtime} conversationId={conversationId}/>)}
    {answer && <article className="ai-answer">{answer.model && <div className="ai-model-label">{answer.model}</div>}<Markdown text={answer.content} runtime={runtime}/><footer><TurnUsage items={turn.items}/><div className="ai-answer-actions"><CopyButton value={answer.content} onError={error => runtime.report(error)}/>{time(answer.createdAt)}</div></footer></article>}
    {running && <div className="ai-running" role="status"><LoaderCircle size={13} className="ai-spin"/><span>正在处理…</span></div>}
  </section>;
});

function ModelControls({ runtime, conversation }: { runtime: AiRuntime; conversation: Conversation }) {
  const [menu, setMenu] = useState<"model" | "tools" | null>(null);
  const [draftProviderId, setDraftProviderId] = useState(conversation.selection.providerId);
  const [draftModel, setDraftModel] = useState(conversation.selection.model);
  const [catalogs, setCatalogs] = useState<Record<string, Model[]>>({});
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({ visibility: "hidden" });
  const modelTrigger = useRef<HTMLButtonElement>(null);
  const toolsTrigger = useRef<HTMLButtonElement>(null);
  const busy = runtime.busy(conversation.id);
  const running = runtime.isRunning(conversation.id);
  const selection = conversation.selection;
  useEffect(() => { if (running) setMenu(null); }, [running]);
  const provider = runtime.settings.providers.find(item => item.id === draftProviderId);
  const activeProvider = runtime.settings.providers.find(item => item.id === selection.providerId);
  useEffect(() => { setDraftProviderId(selection.providerId); setDraftModel(selection.model); }, [selection.providerId, selection.model]);
  useLayoutEffect(() => {
    if (!menu) return;
    const update = () => {
      const element = (menu === "model" ? modelTrigger : toolsTrigger).current;
      if (!element) return;
      const rect = element.getBoundingClientRect();
      const width = Math.min(menu === "model" ? 360 : 340, window.innerWidth - 16);
      const left = Math.max(8, Math.min(menu === "model" ? rect.left : rect.right - width, window.innerWidth - width - 8));
      const above = rect.top >= 150 || rect.top > window.innerHeight - rect.bottom;
      setMenuStyle({ position: "fixed", width, left, maxHeight: Math.max(80, Math.min(340, (above ? rect.top : window.innerHeight - rect.bottom) - 16)), ...(above ? { bottom: window.innerHeight - rect.top + 8, top: "auto" } : { top: rect.bottom + 8, bottom: "auto" }) });
    };
    update(); window.addEventListener("resize", update); window.addEventListener("scroll", update, true);
    const observer = new ResizeObserver(update); if (root.current) observer.observe(root.current);
    return () => { observer.disconnect(); window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); };
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const click = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node) && !popover.current?.contains(event.target as Node)) setMenu(null); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setMenu(null); (menu === "model" ? modelTrigger : toolsTrigger).current?.focus(); } };
    document.addEventListener("pointerdown", click); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", click); document.removeEventListener("keydown", key); };
  }, [menu]);
  useEffect(() => {
    if (menu !== "model" || !provider) return;
    const controller = new AbortController(); setLoading(true); setLoadError("");
    void listModels(provider, controller.signal).then(models => {
      runtime.assertActive(); if (!controller.signal.aborted) setCatalogs(current => ({ ...current, [provider.id]: models }));
    }).catch(error => { if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : "模型列表加载失败"); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [menu, provider, reload, runtime]);
  async function choose(model: string) {
    if (!provider || !model.trim()) return;
    try {
      await runtime.setSelection(conversation.id, { providerId: provider.id, model: model.trim(), reasoning: provider.id === selection.providerId && model.trim() === selection.model ? selection.reasoning : "" });
      setMenu(null); modelTrigger.current?.focus();
    } catch (error) { runtime.report(error); }
  }
  const models = catalogs[draftProviderId] ?? [];
  const matched = models.filter(model => model.id.toLowerCase().includes(draftModel.toLowerCase()));
  const reasoning = catalogs[selection.providerId]?.find(model => model.id === selection.model)?.reasoning ?? [];
  const toolList = runtime.tools.all();
  const enabled = runtime.tools.enabled().length;
  return <div className="ai-toolbar" ref={root}>
    <button ref={modelTrigger} type="button" className="ai-toolbar-model" title={activeProvider ? `${activeProvider.name} · ${selection.model || "选择模型"}` : "配置 AI 供应商"} aria-label="选择 AI 模型" aria-expanded={menu === "model"} disabled={busy} onClick={() => { setDraftProviderId(activeProvider?.id || runtime.settings.providers[0]?.id || ""); setDraftModel(activeProvider ? selection.model : ""); setMenu(menu === "model" ? null : "model"); }}><Cpu size={13}/><span>{selection.model || "选择模型"}</span></button>
    <div className="ai-toolbar-spacer"/>
    {!running && <><label className={`ai-reasoning${!reasoning.length && !selection.reasoning ? " is-unavailable" : ""}`} title={reasoning.length ? "思考深度" : "未取得该模型支持的思考档位，使用模型默认值"}><Lightbulb size={13}/><select aria-label="思考深度" disabled={busy || (!reasoning.length && !selection.reasoning)} value={selection.reasoning} onChange={event => run(runtime, runtime.setSelection(conversation.id, { ...selection, reasoning: event.target.value }))}><option value="">默认思考</option>{[...new Set([...reasoning, ...(selection.reasoning ? [selection.reasoning] : [])])].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
    <button ref={toolsTrigger} type="button" title="AI 工具开关" aria-label="AI 工具开关" aria-expanded={menu === "tools"} onClick={() => setMenu(menu === "tools" ? null : "tools")}><Wrench size={13}/><span>工具 {enabled}/{toolList.length}</span></button></>}
    {running && <button type="button" className="ai-toolbar-stop" onClick={() => runtime.stop(conversation.id)}><Square size={10} fill="currentColor"/><span>停止</span></button>}
    {menu === "model" && createPortal(<div ref={popover} style={menuStyle} className="ai-toolbar-popover ai-model-popover" role="dialog" aria-label="选择模型">
      <header><strong>选择模型</strong><button type="button" aria-label="关闭模型选择" onClick={() => setMenu(null)}><X size={14}/></button></header>
      {runtime.settings.providers.length ? <>
        <select aria-label="AI 供应商" value={draftProviderId} disabled={busy} onChange={event => { setDraftProviderId(event.target.value); setDraftModel(""); }}>{runtime.settings.providers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
        <div className="ai-model-search"><Search size={14}/><input aria-label="AI 模型" placeholder="搜索或输入模型名称" value={draftModel} maxLength={500} disabled={busy} onChange={event => setDraftModel(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void choose(draftModel); } }}/></div>
        {loading && <small role="status">正在加载模型…</small>}{loadError && <small className="ai-menu-error">{loadError}</small>}
        <div className="ai-model-options" role="listbox" aria-label="模型列表">{matched.map(model => <button type="button" role="option" aria-selected={model.id === selection.model && draftProviderId === selection.providerId} disabled={busy} key={model.id} onClick={() => void choose(model.id)}><span>{model.id}</span>{model.id === selection.model && draftProviderId === selection.providerId && <Check size={13}/>}</button>)}</div>
        <div className="ai-model-menu-actions"><button type="button" disabled={busy || loading} onClick={() => setReload(value => value + 1)}>刷新列表</button><button type="button" disabled={busy || !draftModel.trim()} onClick={() => void choose(draftModel)}>使用此模型</button></div>
      </> : <p>尚未配置 AI 供应商。</p>}
      <button type="button" className="ai-menu-settings" onClick={() => { setMenu(null); router.push("/settings/ai"); }}>AI 供应商设置</button>
    </div>, root.current?.closest(".workspace-shell") ?? document.body)}
    {menu === "tools" && createPortal(<div ref={popover} style={menuStyle} className="ai-toolbar-popover ai-tools-popover" role="dialog" aria-label="AI 工具设置"><header><strong>AI 工具</strong><button type="button" aria-label="关闭工具设置" onClick={() => setMenu(null)}><X size={14}/></button></header><div className="ai-tool-options">{toolList.map(tool => <label key={tool.id} title={tool.description}><input type="checkbox" checked={!runtime.settings.disabledTools.includes(tool.id)} disabled={runtime.settingsWrites > 0 || tool.id === "tools_refresh"} onChange={event => { const checked = event.target.checked; run(runtime, runtime.updateSettings(settings => ({ ...settings, disabledTools: checked ? settings.disabledTools.filter(id => id !== tool.id) : [...new Set([...settings.disabledTools, tool.id])] }))); }}/><span>{tool.id}<small>{tool.source} · {tool.available() ? "可用" : "离线"}</small></span></label>)}</div>{runtime.settingsWrites > 0 && <small role="status">正在加密保存…</small>}<button type="button" className="ai-menu-settings" onClick={() => { setMenu(null); router.push("/settings/ai"); }}>更多 AI 设置</button></div>, root.current?.closest(".workspace-shell") ?? document.body)}
  </div>;
}

export function SessionList({ runtime }: { runtime: AiRuntime }) {
  useAi(runtime); const [query, setQuery] = useState("");
  return <div className="ai-session-list"><label className="ai-session-search"><Search size={13}/><input aria-label="查询会话" placeholder="查询会话" value={query} onChange={event => setQuery(event.target.value)}/></label>{runtime.conversations.filter(item => item.title.toLowerCase().includes(query.toLowerCase())).map(item => <div className={`ai-session-row${runtime.selectedId === item.id ? " is-active" : ""}`} key={item.id}><button className="ai-session-select" onClick={() => runtime.select(item.id)} title={item.title}><span>{runtime.isRunning(item.id) && <LoaderCircle size={11} className="ai-spin"/>}{item.title}</span><small>{time(item.messages[item.messages.length - 1]?.createdAt ?? item.createdAt)}<span>{item.messages.filter(message => message.role !== "tool").length} 条消息</span></small></button><button className="ai-session-delete" disabled={runtime.busy(item.id)} aria-label={`删除会话 ${item.title}`} onClick={() => { if (window.confirm("删除该会话及保存的结果 HTML？")) run(runtime, runtime.remove(item.id)); }}><X size={13}/></button></div>)}</div>;
}
export function Conversations({ runtime }: { runtime: AiRuntime }) {
  useAi(runtime); const conversation = runtime.selected();
  return <div className="ai-chat">{runtime.error && <p className="ai-chat-error" role="alert">{runtime.error}</p>}{conversation ? <ConversationBody key={conversation.id} runtime={runtime} conversation={conversation}/> : <div className="ai-empty"><Cpu size={24}/><p>开始一个 AI 会话</p><button type="button" onClick={() => run(runtime, runtime.create())}><Plus size={14}/>新建会话</button></div>}</div>;
}
function ConversationBody({ runtime, conversation }: { runtime: AiRuntime; conversation: Conversation }) {
  const [text, setText] = useState("");
  const [jump, setJump] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const pinned = useRef(true);
  const composing = useRef(false);
  const compositionEndedAt = useRef(0);
  const available = runtime.settings.providers.some(item => item.id === conversation.selection.providerId);
  const busy = runtime.busy(conversation.id);
  const running = runtime.isRunning(conversation.id);
  useLayoutEffect(() => { if (pinned.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [conversation.messages.length, busy]);
  useLayoutEffect(() => { if (input.current) { input.current.style.height = "0px"; input.current.style.height = `${Math.min(200, Math.max(24, input.current.scrollHeight))}px`; } }, [text]);
  function send() { if (!busy && available && conversation.selection.model && text.trim()) run(runtime, runtime.send(conversation.id, text, () => setText(""))); }
  const grouped = useMemo(() => turns(conversation.messages), [conversation.messages]);
  return <><div className="ai-transcript-wrap"><div className="ai-messages" ref={scroll} role="log" aria-label="AI 会话消息" onScroll={() => { const element = scroll.current!; pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60; setJump(!pinned.current); }}>
    {!grouped.length && <div className="ai-start-hint">有什么可以帮你？</div>}
    {grouped.map((turn, index) => <MessageTurn key={turn.id} turn={turn} runtime={runtime} conversationId={conversation.id} running={running && index === grouped.length - 1}/>)}
  </div>{jump && <button type="button" className="ai-scroll-bottom" aria-label="回到最新消息" onClick={() => { pinned.current = true; scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: "smooth" }); setJump(false); }}><ArrowDown size={15}/></button>}</div>
  <div className="ai-input-shell">
    {!available && <p className="ai-unavailable">该会话的供应商未配置。<button type="button" onClick={() => router.push("/settings/ai")}>配置 AI</button></p>}
    <form className="ai-composer" onSubmit={event => { event.preventDefault(); send(); }}><textarea ref={input} aria-label="发送给 AI" rows={1} maxLength={2000000} placeholder={running ? "正在处理…" : "消息…"} value={text} onChange={event => setText(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; compositionEndedAt.current = Date.now(); }} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing && event.keyCode !== 229 && Date.now() - compositionEndedAt.current >= 100) { event.preventDefault(); send(); } }} disabled={!available || busy}/>{!running && <button className="ai-send" type="submit" disabled={busy || !available || !conversation.selection.model || !text.trim()}><ArrowRight size={15}/><span>发送</span></button>}</form>
    <ModelControls runtime={runtime} conversation={conversation}/>
  </div></>;
}
