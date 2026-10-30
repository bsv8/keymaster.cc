import type { AiRepository } from "./repository.js";
import { defaultSettings } from "./repository.js";
import { complete } from "./providers.js";
import { object, string, ToolRegistry } from "./tools.js";
import { message, type Artifact, type Conversation, type Json, type Selection, type Settings } from "./types.js";

export class AiRuntime {
  settings: Settings = defaultSettings();
  conversations: Conversation[] = [];
  selectedId: string | null = null;
  error = "";
  readonly failures = new Map<string, string>();
  ready = false;
  readonly tools = new ToolRegistry(() => this.settings.disabledTools, () => this.assertActive());
  private revision = 0;
  private listeners = new Set<() => void>();
  private running = new Map<string, AbortController>();
  private editing = new Set<string>();
  private disposed = false;
  private settingsQueue = Promise.resolve();
  settingsWrites = 0;
  constructor(private repo: AiRepository, private checkActive: () => void, private show: (conversationId: string, artifact: Artifact) => void, private closeResults: (conversationId?: string) => void) {
    this.tools.register({ id: "tools_refresh", source: "系统", description: "刷新当前动态工具清单，开始新会话或工具不可用时先调用。", parameters: object(), available: () => true, execute: async () => this.tools.enabled().map(tool => ({ name: tool.id, description: tool.description, source: tool.source, parameters: tool.parameters })) });
    this.tools.register({ id: "result_show", source: "系统", description: "展示单文件 HTML，整个钱包只复用一个结果 Tab，替换当前展示，可手工关闭；会话中的重新展示按钮可回看每次调用的 HTML。CSS/JS 必须内嵌，不允许外部资源、钱包 API 或加载时自动提交。桥：await window.keymasterAI.ready; await window.keymasterAI.submit({action:'选择',values:{...}})。反馈以 kind=ai_tab_feedback 用户消息回到本会话。提供 tabId 更新，省略则创建。", parameters: object({ title: string(120), html: string(1_000_000), tabId: string(100) }, ["title", "html"]), available: () => true, execute: async (args, context) => {
      const conversation = this.get(context.conversationId);
      const existing = args.tabId ? conversation.artifacts.find(item => item.id === args.tabId) : undefined;
      if (args.tabId && !existing) throw new Error("该 Tab 不属于本会话或不存在");
      const artifact: Artifact = { id: existing?.id ?? crypto.randomUUID(), title: args.title as string, html: args.html as string };
      const artifacts = existing ? conversation.artifacts.map(item => item.id === existing.id ? artifact : item) : [...conversation.artifacts, artifact];
      const next = { ...conversation, artifacts };
      await this.persist(next); context.signal.throwIfAborted(); this.show(conversation.id, artifact);
      return { tabId: artifact.id, status: "shown" };
    } });
  }
  assertActive() { if (this.disposed) throw new Error("AI 会话已失效"); this.checkActive(); }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.revision;
  changed = () => { this.revision++; for (const listener of this.listeners) listener(); };
  report(error: unknown) { if (this.disposed) return; this.error = error instanceof Error ? error.message : "AI 操作失败"; this.changed(); }
  async initialize() {
    const [settings, conversations] = await Promise.all([this.repo.settings(), this.repo.conversations()]);
    this.assertActive();
    // Never replay interrupted tools. Close dangling calls with explicit unknown/interrupted results.
    for (const conversation of conversations) {
      const repaired = this.repair(conversation);
      if (repaired !== conversation) await this.repo.saveConversation(repaired);
      this.assertActive();
      this.conversations.push(repaired);
    }
    this.settings = settings; this.selectedId = this.conversations[0]?.id ?? null;
    this.ready = true; this.changed();
  }
  private repair(conversation: Conversation) {
    const answered = new Set(conversation.messages.filter(m => m.role === "tool").map(m => m.callId));
    const missing = conversation.messages.flatMap(m => m.calls ?? []).filter(call => !answered.has(call.id));
    return missing.length ? { ...conversation, messages: [...conversation.messages, ...missing.map(call => ({ ...message("tool", JSON.stringify({ error: "执行被中断，结果未知；没有自动重试。请重新查询业务状态。" })), callId: call.id, name: call.name }))] } : conversation;
  }
  selected() { return this.conversations.find(item => item.id === this.selectedId); }
  get(id: string) { const item = this.conversations.find(item => item.id === id); if (!item) throw new Error("AI 会话不存在"); return item; }
  select(id: string) { this.assertActive(); this.get(id); this.selectedId = id; this.error = ""; this.changed(); }
  busy(id: string) { return this.running.has(id) || this.editing.has(id); }
  isRunning(id: string) { return this.running.has(id); }
  updateSettings(update: (settings: Settings) => Settings) {
    this.assertActive(); this.settingsWrites++; this.changed();
    const result = this.settingsQueue.then(async () => {
      this.assertActive();
      const next = update(this.settings);
      await this.repo.saveSettings(next); this.assertActive();
      this.settings = next;
      for (const [id, controller] of this.running) if (!next.providers.some(provider => provider.id === this.get(id).selection.providerId)) controller.abort();
      this.changed(); this.tools.changed();
    });
    const tracked = result.finally(() => { this.settingsWrites--; if (!this.disposed) this.changed(); });
    this.settingsQueue = tracked.catch(() => undefined);
    return tracked;
  }
  async create() {
    this.assertActive();
    const conversation: Conversation = { version: 1, id: crypto.randomUUID(), title: "新会话", createdAt: Date.now(), selection: { ...this.settings.defaults }, systemPrompt: this.settings.systemPrompt, messages: [], artifacts: [] };
    await this.repo.saveConversation(conversation); this.assertActive();
    this.conversations = [conversation, ...this.conversations]; this.selectedId = conversation.id; this.changed();
    return conversation;
  }
  async setSelection(id: string, selection: Selection) {
    this.assertActive();
    if (this.busy(id)) throw new Error("请先停止当前回复再切换模型");
    this.get(id); this.editing.add(id); this.changed();
    try {
      await this.updateSettings(settings => ({ ...settings, defaults: { ...selection } }));
      await this.persist({ ...this.get(id), selection: { ...selection } });
    } finally { this.editing.delete(id); if (!this.disposed) this.changed(); }
  }
  private async persist(conversation: Conversation) {
    this.assertActive(); await this.repo.saveConversation(conversation); this.assertActive();
    this.conversations = this.conversations.map(item => item.id === conversation.id ? conversation : item); this.changed();
  }
  async remove(id: string) {
    if (this.busy(id)) throw new Error("请先停止该会话");
    this.assertActive(); await this.repo.deleteConversation(id); this.assertActive();
    this.closeResults(id); this.conversations = this.conversations.filter(item => item.id !== id);
    if (this.selectedId === id) this.selectedId = this.conversations[0]?.id ?? null;
    this.changed();
  }
  openArtifact(id: string, artifact: Artifact) { this.assertActive(); this.show(id, artifact); }
  stop(id: string) { this.running.get(id)?.abort(); }
  async send(id: string, text: string, onAccepted?: () => void): Promise<void> {
    this.assertActive();
    const initial = this.get(id);
    const provider = this.settings.providers.find(item => item.id === initial.selection.providerId);
    if (!provider || !initial.selection.model) throw new Error("请配置供应商并选择模型");
    if (this.busy(id)) throw new Error("该会话正在处理，请稍后再提交");
    if (!text.trim()) return;
    const startedAt = performance.now();
    const controller = new AbortController(); this.running.set(id, controller); this.failures.delete(id); this.error = ""; this.changed();
    try {
      await this.persist({ ...initial, title: initial.messages.length ? initial.title : text.slice(0, 36), messages: [...initial.messages, message("user", text)] });
      onAccepted?.();
      for (let round = 0; round < 24; round++) {
        this.assertActive(); controller.signal.throwIfAborted();
        const answer = await complete(provider, this.get(id), this.tools.enabled(), controller.signal);
        this.assertActive(); controller.signal.throwIfAborted();
        const assistant = { ...message("assistant", answer.content), model: this.get(id).selection.model, durationMs: Math.round(performance.now() - startedAt), ...(answer.usage ? { usage: answer.usage } : {}), ...(answer.calls.length ? { calls: answer.calls } : {}), ...(answer.continuation ? { continuation: answer.continuation } : {}) };
        await this.persist({ ...this.get(id), messages: [...this.get(id).messages, assistant] });
        if (!answer.calls.length) return;
        for (const call of answer.calls) {
          let output: unknown;
          try { output = await this.tools.execute(call.name, call.arguments, { conversationId: id, signal: controller.signal }); }
          catch (error) { output = { error: error instanceof Error ? error.message : "工具执行失败" }; }
          this.assertActive();
          let content = JSON.stringify(output ?? null, (_key, value) => typeof value === "bigint" ? value.toString() : value);
          if (content.length > 200_000) content = JSON.stringify({ executed: true, resultOmitted: true, error: "工具已返回，但结果过大，未向模型完整发送。不要重试有副作用的操作；请查询状态，或缩小只读查询范围/使用分页。" });
          await this.persist({ ...this.get(id), messages: [...this.get(id).messages, { ...message("tool", content), callId: call.id, name: call.name }] });
        }
      }
      throw new Error("本轮工具调用较多，已暂停；请检查结果后再继续");
    } catch (error) {
      if (!this.disposed) {
        this.assertActive();
        const repaired = this.repair(this.get(id));
        if (repaired !== this.get(id)) await this.persist(repaired);
      }
      const failure = controller.signal.aborted ? new Error("AI 执行已停止；已提交的业务操作不因此回滚") : error;
      if (!this.disposed) this.failures.set(id, failure instanceof Error ? failure.message : "AI 执行失败");
      throw failure;
    } finally { this.running.delete(id); if (!this.disposed) this.changed(); }
  }
  async feedback(id: string, tabId: string, payload: { action: string; values: Record<string, Json> }) {
    this.assertActive();
    if (!this.get(id).artifacts.some(item => item.id === tabId)) throw new Error("结果 Tab 已失效");
    await new Promise<void>((resolve, reject) => {
      void this.send(id, JSON.stringify({ kind: "ai_tab_feedback", tabId, ...payload }), resolve).catch(error => { this.report(error); reject(error); });
    });
  }
  dispose() {
    if (this.disposed) return; this.disposed = true;
    for (const controller of this.running.values()) controller.abort();
    this.running.clear(); this.editing.clear(); this.failures.clear(); this.closeResults(); this.tools.dispose(); this.repo.dispose();
    this.settings = defaultSettings(); this.conversations = []; this.selectedId = null; this.listeners.clear();
  }
}
