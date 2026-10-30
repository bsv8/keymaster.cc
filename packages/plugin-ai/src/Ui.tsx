import { useRef, useState, useSyncExternalStore, type ReactNode } from "react";
export { Conversations, SessionList } from "./Chat.js";
import { Button, Modal, PageHeader } from "@keymaster/ui";
import type { AiRuntime } from "./runtime.js";
import { DEFAULT_SYSTEM_PROMPT } from "./prompt.js";
import { PROVIDER_PRESETS } from "./providers.js";
import type { ApiFormat, Provider } from "./types.js";

function useAi(runtime: AiRuntime) { useSyncExternalStore(runtime.subscribe, runtime.snapshot, runtime.snapshot); return runtime; }
function failure(runtime: AiRuntime, operation: Promise<unknown>) { void operation.catch(error => runtime.report(error)); }
function presetFor(provider: Provider) {
  return PROVIDER_PRESETS.find(preset => preset.name === provider.name && preset.format === provider.format && preset.baseUrl === provider.baseUrl.replace(/\/$/, ""));
}
export function AiSettings({ runtime, onboarding = false }: { runtime: AiRuntime; onboarding?: boolean }) {
  useAi(runtime);
  const [provider, setProvider] = useState<Provider>(() => ({ id: crypto.randomUUID(), apiKey: "", ...PROVIDER_PRESETS[0]! }));
  const [providerChoice, setProviderChoice] = useState(PROVIDER_PRESETS[0]!.name);
  const editingProviderId = useRef(provider.id);
  editingProviderId.current = provider.id;
  const [prompt, setPrompt] = useState(runtime.settings.systemPrompt);
  const [busy, setBusy] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const isEditing = runtime.settings.providers.some(item => item.id === provider.id);
  function openAdd() {
    setProvider({ id: crypto.randomUUID(), apiKey: "", ...PROVIDER_PRESETS[0]! });
    setProviderChoice(PROVIDER_PRESETS[0]!.name);
    setEditorOpen(true);
  }
  function openEdit(item: Provider) {
    setProvider({ ...item });
    setProviderChoice(presetFor(item)?.name ?? "custom");
    setEditorOpen(true);
  }
  function closeEditor() {
    setEditorOpen(false);
    setProvider({ id: crypto.randomUUID(), apiKey: "", ...PROVIDER_PRESETS[0]! });
    setProviderChoice(PROVIDER_PRESETS[0]!.name);
  }
  async function save() {
    setBusy(true);
    try {
      const preset = PROVIDER_PRESETS.find(item => item.name === providerChoice);
      const configured = preset ? { ...provider, ...preset } : provider;
      const url = new URL(configured.baseUrl);
      if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("供应商必须使用 HTTPS（本机除外）");
      if (url.username || url.password || url.search || url.hash) throw new Error("地址不能含凭据、查询参数或片段");
      if (!configured.name.trim() || !configured.apiKey.trim()) throw new Error("请填写名称和密钥");
      await runtime.updateSettings(settings => ({ ...settings, providers: [...settings.providers.filter(item => item.id !== configured.id), { ...configured, name: configured.name.trim(), apiKey: configured.apiKey.trim(), baseUrl: configured.baseUrl.trim().replace(/\/$/, "") }], defaults: settings.defaults.providerId ? settings.defaults : { providerId: configured.id, model: "", reasoning: "" } }));
      setProvider({ id: crypto.randomUUID(), apiKey: "", ...PROVIDER_PRESETS[0]! });
      setProviderChoice(PROVIDER_PRESETS[0]!.name);
      setEditorOpen(false);
    } catch (error) { runtime.report(error); } finally { setBusy(false); }
  }
  async function removeProvider(id: string) {
    await runtime.updateSettings(settings => ({ ...settings, providers: settings.providers.filter(item => item.id !== id), defaults: settings.defaults.providerId === id ? { providerId: "", model: "", reasoning: "" } : settings.defaults }));
    if (editingProviderId.current === id) {
      setEditorOpen(false);
      setProvider({ id: crypto.randomUUID(), apiKey: "", ...PROVIDER_PRESETS[0]! });
      setProviderChoice(PROVIDER_PRESETS[0]!.name);
    }
  }
  const savePrompt = (text: string) => failure(runtime, runtime.updateSettings(settings => ({ ...settings, systemPrompt: text })));
  return <div className="ai-settings-page">
    <PageHeader
      title={onboarding ? "设置 AI（可跳过）" : "AI"}
      description="本地加密保存密钥与聊天记录，浏览器直连所选供应商。"
    />
    <div className="ai-settings">
      {runtime.error && <p className="ai-settings__feedback is-error" role="alert">{runtime.error}</p>}
      {runtime.settingsWrites > 0 && <p className="ai-settings__feedback" role="status">正在加密保存设置…</p>}
      <div className="ai-settings__callout">
        <p>隐私提示：聊天内容、页面提交内容及工具查询的钱包／BitFS 信息可能发送给所选 AI 供应商。请确认其隐私政策。密钥、聊天和结果仅在本地加密保存；浏览器直连供应商，不经过钱包代理。</p>
        <p>切换会话供应商后，下次发送会把整个会话上下文提交给新供应商。</p>
      </div>
      <section className="ai-settings__section" aria-labelledby="ai-supplier-title">
        <header className="ai-settings__section-header">
          <div>
            <h2 id="ai-supplier-title">供应商</h2>
            <p>固定供应商只需填写 API Key；定制供应商可配置调用格式和地址。实际可用性取决于跨域、密钥、模型及供应商策略，不支持跨域的服务不会自动代理。</p>
          </div>
          <div className="ai-settings__section-header-actions">
            <span className="ai-settings__count">{runtime.settings.providers.length}</span>
            <Button size="sm" onClick={openAdd}>添加</Button>
          </div>
        </header>
        {runtime.settings.providers.length === 0 ? (
          <p className="ai-settings__empty">暂无供应商，请点击右上添加。</p>
        ) : (
          <ul className="ai-settings__providers">
            {runtime.settings.providers.map(item => (
              <li key={item.id} className="ai-settings__provider-card">
                <div className="ai-settings__provider-header">
                  <div className="ai-settings__provider-identity">
                    <strong>{item.name}</strong>
                    {!presetFor(item) && <span className="ai-settings__badge">{item.format}</span>}
                  </div>
                  <div className="ai-settings__section-actions">
                    <Button variant="secondary" size="sm" onClick={() => openEdit(item)}>编辑</Button>
                    <Button variant="danger" size="sm" disabled={busy} onClick={() => failure(runtime, removeProvider(item.id))}>删除</Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        <Modal
          open={editorOpen}
          title={isEditing ? "编辑供应商" : "添加供应商"}
          onClose={closeEditor}
          closeButtonLabel="关闭"
          data-testid="ai-supplier-editor"
        >
          <form className="ai-settings__form ai-settings__supplier-editor" onSubmit={event => { event.preventDefault(); void save(); }}>
            <p className="ai-settings__hint">固定供应商只需填写 API Key；定制供应商需填写名称、调用格式和地址。</p>
            <div className="ai-settings__form-grid">
              <div className="ai-settings__field">
                <label htmlFor="ai-provider-choice">供应商</label>
                <select id="ai-provider-choice" aria-label="供应商" className="ai-settings__control" value={providerChoice} disabled={busy} onChange={event => {
                  const choice = event.target.value;
                  setProviderChoice(choice);
                  const preset = PROVIDER_PRESETS.find(item => item.name === choice);
                  setProvider(current => ({ ...current, ...(preset ?? { name: "", format: "completions" as const, baseUrl: "" }) }));
                }}>{PROVIDER_PRESETS.map(preset => <option key={preset.name} value={preset.name}>{preset.name}</option>)}<option value="custom">定制供应商</option></select>
              </div>
              {providerChoice === "custom" && <>
                <div className="ai-settings__field">
                  <label htmlFor="ai-provider-name">名称</label>
                  <input id="ai-provider-name" className="ai-settings__control" maxLength={200} value={provider.name} onChange={event => setProvider({ ...provider, name: event.target.value })} required />
                </div>
                <div className="ai-settings__field">
                  <label htmlFor="ai-provider-format">调用格式</label>
                  <select id="ai-provider-format" aria-label="调用格式" className="ai-settings__control" value={provider.format} onChange={event => setProvider({ ...provider, format: event.target.value as ApiFormat })}><option value="completions">OpenAI Chat Completions</option><option value="responses">OpenAI Responses</option><option value="messages">Anthropic Messages</option><option value="gemini">Gemini</option></select>
                </div>
                <div className="ai-settings__field is-wide">
                  <label htmlFor="ai-provider-baseurl">API 基础地址</label>
                  <input id="ai-provider-baseurl" className="ai-settings__control" type="url" maxLength={2000} value={provider.baseUrl} onChange={event => setProvider({ ...provider, baseUrl: event.target.value })} required />
                </div>
              </>}
              <div className="ai-settings__field">
                <label htmlFor="ai-provider-key">API Key</label>
                <input id="ai-provider-key" className="ai-settings__control" type="password" maxLength={10000} autoComplete="off" value={provider.apiKey} onChange={event => setProvider({ ...provider, apiKey: event.target.value })} required />
              </div>
            </div>
            <div className="ai-settings__section-actions">
              <Button type="submit" disabled={busy}>{isEditing ? "保存修改" : "添加供应商"}</Button>
            </div>
          </form>
        </Modal>
      </section>
      {!onboarding && <>
        <section className="ai-settings__section" aria-labelledby="ai-prompt-title">
          <header className="ai-settings__section-header">
            <div>
              <h2 id="ai-prompt-title">系统提示词</h2>
              <p>仅用于下一新会话。已有会话保留原提示词。</p>
            </div>
          </header>
          <div className="ai-settings__field is-wide">
            <label htmlFor="ai-system-prompt">系统提示词</label>
            <textarea id="ai-system-prompt" className="ai-settings__control" rows={12} maxLength={2000000} value={prompt} onChange={event => setPrompt(event.target.value)} />
          </div>
          <div className="ai-settings__section-actions">
            <Button onClick={() => savePrompt(prompt)}>保存提示词</Button>
            <Button variant="ghost" onClick={() => { setPrompt(DEFAULT_SYSTEM_PROMPT); savePrompt(DEFAULT_SYSTEM_PROMPT); }}>恢复默认提示词</Button>
          </div>
        </section>
        <section className="ai-settings__section" aria-labelledby="ai-tools-title">
          <header className="ai-settings__section-header">
            <div>
              <h2 id="ai-tools-title">工具开关</h2>
              <p>按工具分别启用；关闭后 AI 不再调用对应工具。tools_refresh 常开，用于刷新工具列表。</p>
            </div>
            <span className="ai-settings__count">{runtime.tools.all().length}</span>
          </header>
          <ul className="ai-settings__providers">
            {runtime.tools.all().map(tool => (
              <li key={tool.id} className="ai-settings__provider-card">
                <label className="ai-settings__checkbox">
                  <input type="checkbox" disabled={tool.id === "tools_refresh" || runtime.settingsWrites > 0} checked={!runtime.settings.disabledTools.includes(tool.id)} onChange={event => { const enabled = event.target.checked; failure(runtime, runtime.updateSettings(settings => ({ ...settings, disabledTools: enabled ? settings.disabledTools.filter(id => id !== tool.id) : [...new Set([...settings.disabledTools, tool.id])] }))); }} />
                  <span>{tool.id} · {tool.source} · {tool.available() ? "可用" : "离线"}<small>{tool.description}</small></span>
                </label>
              </li>
            ))}
          </ul>
        </section>
      </>}
      {onboarding && <div className="ai-settings__section-actions"><Button onClick={() => failure(runtime, runtime.updateSettings(settings => ({ ...settings, configured: true })))}>{runtime.settings.providers.length ? "完成并进入钱包" : "跳过，进入钱包"}</Button></div>}
    </div>
  </div>;
}
export function AiGate({ runtime, children }: { runtime: AiRuntime; children?: ReactNode }) { useAi(runtime); return runtime.settings.configured ? <>{children}</> : <AiSettings runtime={runtime} onboarding/>; }
export function SessionActions({ runtime }: { runtime: AiRuntime }) { useAi(runtime); return <button disabled={!runtime.ready} onClick={() => failure(runtime, runtime.create())}>＋新建</button>; }
